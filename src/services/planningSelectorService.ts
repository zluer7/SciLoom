import { entityContextService } from "./entityContextService";
import { experimentRunService } from "./experimentRunService";
import { experimentService } from "./experimentService";
import { experimentSelectorService } from "./experimentSelectorService";
import { literatureSelectorService } from "./literatureSelectorService";
import { outputConversionSelectorService } from "./outputConversionSelectorService";
import { outputConversionService } from "./outputConversionService";
import { outputService } from "./outputService";
import { planningService, type ReviewFirstLayerIdentity } from "./planningService";
import { buildProjectLevel4RelationIndexProjection } from "./projectLevel4RelationIndexProjection";
import {
  buildReviewScopeSummary,
  classifyReviewTargetEvidence,
  createReviewEvidenceBase,
  createPeriodReviewScopeSummary,
  createReviewEvidenceContext
} from "./reviewEvidenceContextService";
import type { EntityId } from "../types";
import type { EntitySummary, EvidenceSummary, LinkedEntitySummary } from "../types/entityContext";
import type { MissingEntityReference } from "../types/entityReference";
import type {
  EntityType,
  Project,
  ResearchRoutine,
  Review,
  RoutineCheckIn,
  RoutineFrequency,
  RouteCheckpoint,
  RouteCheckpointStatus,
  TaskCheckpoint,
  TaskCheckpointStatus,
  Task,
  TaskStatus
} from "../types/planning";
import type {
  OutputGapClosureContext,
  OutputGapRouteNodeSummaries,
  OutputGapRouteNodeSummary,
  OutputGapTaskSummary,
  PlanningTaskStats,
  ProjectCrossModuleSummary,
  ProjectDetailContext,
  ProjectRoutineSummary,
  ProjectResearchContext,
  ResearchProgressSummary,
  ReviewAggregationContext,
  ReviewAggregationStats,
  ReviewBasicContext,
  ReviewContextScope,
  ReviewDerivedOutputEvidence,
  ReviewEvidenceBase,
  ReviewEvidenceLimitations,
  ReviewEvidenceScopeSensitivity,
  ReviewDirectTargetEvidence,
  ReviewExperimentEvidence,
  ReviewIndirectEvidence,
  ReviewLiteratureEvidence,
  ReviewOutputEvidence,
  ReviewPeriodEvidence,
  ReviewPeriodContext,
  ReviewPeriodContextOptions,
  ReviewPeriodStats,
  ReviewTaskEvidence,
  RouteNodeOutputGapSummaries,
  RouteNodeOutputGapSummary,
  RouteCheckpointProgressSummary,
  RouteNodeTaskSummary,
  RoutineCurrentPeriodSummary,
  TaskCheckpointProgressSummary,
  TaskDetailContext,
  TaskExecutionContext,
  TaskOutputGapSummaries
} from "../types/planningContext";
import type { OutputGap } from "../types/outputConversion";

const crossModuleTypes = new Set<EntityType>([
  "experiment",
  "experimentRun",
  "resultMetric",
  "fileRef",
  "literature",
  "resultItem",
  "finding",
  "outputCandidate",
  "outputGap",
  "output"
]);

function uniqueSummaries(summaries: EntitySummary[]): EntitySummary[] {
  const byKey = new Map<string, EntitySummary>();
  for (const summary of summaries) {
    byKey.set(`${summary.entityType}:${summary.entityId}`, summary);
  }
  return [...byKey.values()];
}

function uniqueEvidenceSummaries(summaries: EvidenceSummary[]): EvidenceSummary[] {
  const byKey = new Map<string, EvidenceSummary>();
  for (const summary of summaries) {
    byKey.set(`${summary.evidenceType}:${summary.evidenceId}`, summary);
  }
  return [...byKey.values()];
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function readStringCustomField(
  customFields: Record<string, unknown> | undefined,
  key: string
) {
  const value = customFields?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function buildProjectFieldContractSummary(project: Project) {
  return {
    methodSummary: readStringCustomField(project.customFields, "methodSummary") || undefined,
    expectedOutputs: readStringCustomField(project.customFields, "expectedOutputs") || undefined
  };
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
  for (const reference of references) {
    byKey.set(missingReferenceKey(reference), reference);
  }
  return [...byKey.values()];
}

function summaryToEvidence(
  summary: EntitySummary,
  relationType?: string,
  contentSummary?: string
): EvidenceSummary {
  return {
    evidenceType: summary.entityType,
    evidenceId: summary.entityId,
    title: summary.title,
    contentSummary: contentSummary ?? summary.subtitle,
    relationType,
    sourceModule: summary.sourceModule,
    source: summary
  };
}

function summariesToEvidence(
  summaries: EntitySummary[],
  relationType?: string
): EvidenceSummary[] {
  return uniqueEvidenceSummaries(
    summaries.map((summary) => summaryToEvidence(summary, relationType))
  );
}

function outputGapSummaryToEvidence(summary: OutputGapTaskSummary): EvidenceSummary {
  return summaryToEvidence(
    summary.outputGap,
    summary.relationSummaries[0]?.relationType ?? "needs_followup_task"
  );
}

function outputGapSummariesToEvidence(summaries: OutputGapTaskSummary[]): EvidenceSummary[] {
  return uniqueEvidenceSummaries(summaries.map(outputGapSummaryToEvidence));
}

function isEvidenceSummary(summary: EntitySummary | EvidenceSummary): summary is EvidenceSummary {
  return "evidenceType" in summary;
}

function outputGapStatus(summary: EntitySummary | EvidenceSummary): string | undefined {
  return isEvidenceSummary(summary) ? summary.source?.status : summary.status;
}

function isResolvedOutputGap(summary: EntitySummary | EvidenceSummary): boolean {
  return outputGapStatus(summary) === "resolved";
}

function isPartiallyResolvedOutputGap(summary: EntitySummary | EvidenceSummary): boolean {
  const status = outputGapStatus(summary);
  return status === "task_created" || status === "route_feedback_created";
}

function isUnresolvedOutputGap(summary: EntitySummary | EvidenceSummary): boolean {
  const status = outputGapStatus(summary);
  return status !== "resolved" && status !== "task_created" && status !== "route_feedback_created" && status !== "abandoned";
}

function hasDateRange(options: Pick<ReviewPeriodContextOptions, "startDate" | "endDate">) {
  return Boolean(options.startDate || options.endDate);
}

function dateInRange(
  value: string | undefined,
  options: Pick<ReviewPeriodContextOptions, "startDate" | "endDate">
) {
  if (!hasDateRange(options)) {
    return true;
  }
  if (!value) {
    return false;
  }

  const date = value.slice(0, 10);
  return (!options.startDate || date >= options.startDate) && (!options.endDate || date <= options.endDate);
}

function summaryInPeriod(summary: EntitySummary, options: ReviewPeriodContextOptions) {
  return dateInRange(summary.updatedAt, options) || dateInRange(summary.createdAt, options);
}

function taskInPeriod(task: Task, options: ReviewPeriodContextOptions) {
  return (
    dateInRange(task.completedAt, options) ||
    dateInRange(task.updatedAt, options) ||
    dateInRange(task.createdAt, options)
  );
}

function reviewInPeriod(
  review: { periodStart?: string; periodEnd?: string; updatedAt?: string; createdAt?: string },
  options: ReviewPeriodContextOptions
) {
  return (
    dateInRange(review.periodStart, options) ||
    dateInRange(review.periodEnd, options) ||
    dateInRange(review.updatedAt, options) ||
    dateInRange(review.createdAt, options)
  );
}

function reviewPeriodOptions(review: Review): ReviewPeriodContextOptions {
  return {
    projectId: review.projectId,
    startDate: review.periodStart,
    endDate: review.periodEnd,
    includeArchived: true
  };
}

function reviewPeriod(review: Review) {
  return {
    start: review.periodStart,
    end: review.periodEnd,
    label: review.periodLabel
  };
}

function deriveReviewContextScope(targets: LinkedEntitySummary[]): ReviewContextScope {
  const hasRoutes = targets.some((target) => target.target.entityType === "routeNode");
  const hasTasks = targets.some((target) => target.target.entityType === "task");
  if (hasRoutes && hasTasks) return "mixed";
  if (hasTasks) return "task";
  if (hasRoutes) return "route";
  return "project";
}

function evidenceInPeriod(summary: EvidenceSummary, options: ReviewPeriodContextOptions) {
  return summary.source ? summaryInPeriod(summary.source, options) : !hasDateRange(options);
}

function counterpartForLink(
  link: LinkedEntitySummary,
  baseType: EntityType,
  baseId: EntityId
): EntitySummary {
  const sourceIsBase = link.source.entityType === baseType && link.source.entityId === baseId;
  return sourceIsBase ? link.target : link.source;
}

function collectCounterpartSummaries(
  links: LinkedEntitySummary[],
  baseType: EntityType,
  baseId: EntityId
): EntitySummary[] {
  return uniqueSummaries(links.map((link) => counterpartForLink(link, baseType, baseId)));
}

function filterSummariesByType(summaries: EntitySummary[], entityType: EntityType) {
  return summaries.filter((summary) => summary.entityType === entityType);
}

function filterEvidenceByType(summaries: EvidenceSummary[], entityType: EntityType) {
  return summaries.filter((summary) => summary.evidenceType === entityType);
}

function targetSummariesByType(targets: LinkedEntitySummary[], entityType: EntityType) {
  return uniqueSummaries(
    targets
      .map((target) => target.target)
      .filter((summary) => summary.entityType === entityType)
  );
}

function uniqueTargetLinks(links: LinkedEntitySummary[]) {
  const byKey = new Map<string, LinkedEntitySummary>();
  for (const link of links) {
    const key = `${link.target.entityType}:${link.target.entityId}:${link.relationType}`;
    if (!byKey.has(key)) {
      byKey.set(key, link);
    }
  }
  return [...byKey.values()];
}

function reviewTargetLinks(
  reviewSummary: EntitySummary,
  linkedEntities: LinkedEntitySummary[],
  project: EntitySummary | null
) {
  const entityLinkTargets = linkedEntities.filter(
    (link) =>
      link.source.entityType === "review" &&
      link.source.entityId === reviewSummary.entityId &&
      link.relationType === "summarizes" &&
      (link.target.entityType === "routeNode" ||
        link.target.entityType === "task" ||
        link.target.entityType === "experiment" ||
        link.target.entityType === "experimentRun" ||
        link.target.entityType === "literature")
  );
  const rawFallbackTargets: Array<LinkedEntitySummary | undefined> = [
    project
      ? {
          source: reviewSummary,
          target: project,
          relationType: "summarizes",
          linkSource: "fallbackField" as const,
          description: "Review.projectId formal project target."
        }
      : undefined,
  ];
  const fallbackTargets = rawFallbackTargets.filter(
    (target): target is LinkedEntitySummary => Boolean(target)
  );

  return uniqueTargetLinks([...entityLinkTargets, ...fallbackTargets]);
}

async function summarizeIds(entityType: EntityType, ids: EntityId[]) {
  return Promise.all(ids.map((id) => entityContextService.getEntityTargetSummary(entityType, id)));
}

function summarizeReviewFirstLayerIdentity(review: ReviewFirstLayerIdentity): EntitySummary {
  return {
    entityType: "review",
    entityId: review.id,
    title: review.title,
    subtitle: review.description,
    tags: review.tags,
    createdAt: review.createdAt,
    updatedAt: review.updatedAt,
    sourceModule: "planning",
    sourceAvailable: true
  };
}

function buildTaskStats(tasks: Task[]): PlanningTaskStats {
  const archivedTasks = tasks.filter(
    (task) => task.status === "archived" || task.captureState === "archived" || Boolean(task.archivedAt)
  );
  const completedTasks = tasks.filter((task) => task.status === "done");
  const unscheduledTasks = tasks.filter(
    (task) =>
      task.timeBucket === "none" ||
      task.captureState === "unscheduled" ||
      (!task.dueDate && !task.scheduledDate)
  );

  return {
    total: tasks.length,
    completed: completedTasks.length,
    archived: archivedTasks.length,
    unscheduled: unscheduledTasks.length,
    blocked: tasks.filter((task) => task.status === "blocked").length,
    delayed: tasks.filter((task) => task.status === "delayed").length,
    open: tasks.filter(
      (task) =>
        task.status !== "done" &&
        task.status !== "cancelled" &&
        task.status !== "archived" &&
        task.captureState !== "archived"
    ).length
  };
}

function buildProjectCrossModuleSummary(
  direct: Partial<ProjectCrossModuleSummary>,
  linkedSummaries: EntitySummary[]
): ProjectCrossModuleSummary {
  const knownSummaries = new Set<string>();
  const pick = (entityType: EntityType, directSummaries: EntitySummary[] = []) => {
    const summaries = uniqueSummaries([
      ...directSummaries,
      ...filterSummariesByType(linkedSummaries, entityType)
    ]);
    summaries.forEach((summary) => knownSummaries.add(`${summary.entityType}:${summary.entityId}`));
    return summaries;
  };

  const crossModule: ProjectCrossModuleSummary = {
    experiments: pick("experiment", direct.experiments),
    experimentRuns: pick("experimentRun", direct.experimentRuns),
    resultMetrics: pick("resultMetric", direct.resultMetrics),
    fileRefs: pick("fileRef", direct.fileRefs),
    literatures: pick("literature", direct.literatures),
    resultItems: pick("resultItem", direct.resultItems),
    findings: pick("finding", direct.findings),
    outputCandidates: pick("outputCandidate", direct.outputCandidates),
    outputGaps: pick("outputGap", direct.outputGaps),
    outputs: pick("output", direct.outputs),
    other: []
  };

  crossModule.other = linkedSummaries.filter(
    (summary) =>
      !crossModuleTypes.has(summary.entityType) &&
      !knownSummaries.has(`${summary.entityType}:${summary.entityId}`)
  );

  return crossModule;
}

function buildResearchProgressSummary(
  taskStats: PlanningTaskStats,
  experiments: EvidenceSummary[],
  literatures: EvidenceSummary[],
  findings: EvidenceSummary[],
  outputCandidates: EvidenceSummary[],
  outputGaps: EvidenceSummary[]
): ResearchProgressSummary {
  return {
    completedTaskCount: taskStats.completed,
    experimentEvidenceCount: experiments.length,
    literatureEvidenceCount: literatures.length,
    findingCount: findings.length,
    outputCandidateCount: outputCandidates.length,
    unresolvedOutputGapCount: outputGaps.filter(isUnresolvedOutputGap).length,
    partiallyResolvedOutputGapCount: outputGaps.filter(isPartiallyResolvedOutputGap).length,
    resolvedOutputGapCount: outputGaps.filter(isResolvedOutputGap).length
  };
}

function buildReviewAggregationStats(
  context: Pick<
    ReviewAggregationContext,
    | "relatedTasks"
    | "completedTasks"
    | "activeTasks"
    | "postponedTasks"
    | "experiments"
    | "literatures"
    | "resultItems"
    | "findings"
    | "outputCandidates"
    | "outputGaps"
    | "outputs"
  >
): ReviewAggregationStats {
  return {
    relatedTaskCount: context.relatedTasks.length,
    completedTaskCount: context.completedTasks.length,
    activeTaskCount: context.activeTasks.length,
    postponedTaskCount: context.postponedTasks.length,
    experimentCount: context.experiments.length,
    literatureCount: context.literatures.length,
    resultItemCount: context.resultItems.length,
    findingCount: context.findings.length,
    outputCandidateCount: context.outputCandidates.length,
    outputGapCount: context.outputGaps.length,
    unresolvedOutputGapCount: context.outputGaps.filter(isUnresolvedOutputGap).length,
    partiallyResolvedOutputGapCount: context.outputGaps.filter(isPartiallyResolvedOutputGap).length,
    resolvedOutputGapCount: context.outputGaps.filter(isResolvedOutputGap).length,
    outputCount: context.outputs.length
  };
}

function reviewEvidenceSensitivity(evidence: EvidenceSummary): ReviewEvidenceScopeSensitivity[] {
  const sensitivities: ReviewEvidenceScopeSensitivity[] = ["link_bound"];
  if (evidence.relationType === "project_scope") {
    sensitivities.push("project_summary");
  }
  if (evidence.relationType === "task_scope" || evidence.relationType === "review_target") {
    sensitivities.push("target_bound", "task_boundary");
  }
  if (evidence.relationType === "review_related" || evidence.relationType === "linked_to") {
    sensitivities.push("target_bound");
  }
  return uniqueStrings(sensitivities) as ReviewEvidenceScopeSensitivity[];
}

function createReviewIndirectEvidence(
  evidence: EvidenceSummary,
  sourceBoundary: string
): ReviewIndirectEvidence {
  const base = createReviewEvidenceBase({
    sourceKind: "indirect_cross_module_evidence",
    role: "supporting",
    scopeSensitivity: reviewEvidenceSensitivity(evidence),
    sourceBoundary,
    evidence,
    partial: evidence.relationType === "project_scope"
  });

  return {
    ...base,
    sourceKind: "indirect_cross_module_evidence",
    role: "supporting",
    relationType: evidence.relationType
  };
}

function createReviewExperimentEvidence(evidence: EvidenceSummary): ReviewExperimentEvidence {
  return {
    ...createReviewIndirectEvidence(evidence, "Experiment evidence is contextual to the Review through task, link, or project scope."),
    category: "experiment"
  };
}

function createReviewLiteratureEvidence(evidence: EvidenceSummary): ReviewLiteratureEvidence {
  return {
    ...createReviewIndirectEvidence(evidence, "Literature evidence is contextual to the Review through task, link, or project scope."),
    category: "literature"
  };
}

function derivedOutputStage(
  evidence: EvidenceSummary
): ReviewDerivedOutputEvidence["derivedChainStage"] {
  if (evidence.evidenceType === "resultItem") return "result_item";
  if (evidence.evidenceType === "finding") return "finding";
  if (evidence.evidenceType === "outputCandidate") return "output_candidate";
  if (evidence.evidenceType === "outputGap") return "output_gap";
  if (evidence.evidenceType === "output" || evidence.evidenceType === "researchOutput") {
    return "research_output";
  }
  return undefined;
}

function createReviewDerivedOutputEvidence(evidence: EvidenceSummary): ReviewDerivedOutputEvidence {
  const base = createReviewEvidenceBase({
    sourceKind: "derived_output_evidence",
    role: "derived",
    scopeSensitivity: uniqueStrings([
      ...reviewEvidenceSensitivity(evidence),
      "derived_chain"
    ]) as ReviewEvidenceScopeSensitivity[],
    sourceBoundary:
      "Output evidence is derived from ResultItem / Finding / OutputCandidate / OutputGap / ResearchOutput chain summaries.",
    evidence,
    partial: evidence.relationType === "project_scope"
  });

  return {
    ...base,
    sourceKind: "derived_output_evidence",
    role: "derived",
    derivedChainStage: derivedOutputStage(evidence)
  };
}

function createReviewOutputEvidence(evidence: EvidenceSummary): ReviewOutputEvidence {
  return {
    ...createReviewDerivedOutputEvidence(evidence),
    category: "output"
  };
}

function createReviewTaskEvidence(
  task: EntitySummary,
  directTaskIds: Set<EntityId>
): ReviewTaskEvidence {
  const isDirect = directTaskIds.has(task.entityId);
  const sourceKind = isDirect ? "direct_target_evidence" : "indirect_cross_module_evidence";
  const base = createReviewEvidenceBase({
    sourceKind,
    role: isDirect ? "direct" : "contextual",
    scopeSensitivity: isDirect
      ? ["target_bound", "task_boundary"]
      : ["target_bound", "task_boundary", "link_bound"],
    sourceBoundary: isDirect
      ? "Task is an explicit Review target."
      : "Task is included through Review scope, route, period, or project aggregation.",
    entity: task,
    partial: !isDirect
  });

  return {
    ...base,
    sourceKind,
    role: isDirect ? "direct" : "contextual",
    category: "task"
  };
}

function createExistingReviewContentEvidence(
  review: EntitySummary,
  hasExistingContent: boolean
): ReviewEvidenceBase[] {
  if (!hasExistingContent) {
    return [];
  }

  return [
    createReviewEvidenceBase({
      sourceKind: "existing_review_content",
      role: "contextual",
      scopeSensitivity: ["scope_anchor"],
      sourceBoundary: "Existing user-entered Review content is included as prior Review context.",
      entity: review
    })
  ];
}

function createReviewPeriodEvidence(
  period: ReviewAggregationContext["period"]
): ReviewPeriodEvidence[] {
  if (!period.start || !period.end) {
    return [];
  }

  const base = createReviewEvidenceBase({
    sourceKind: "period_evidence",
    role: "contextual",
    scopeSensitivity: ["period_bound"],
    sourceBoundary:
      "Review period fields constrain inferred task scope; UI-8-4 does not run period-wide evidence aggregation.",
    warnings: [
      "Single Review aggregation records period boundary only; period-wide evidence closure remains UI-8-5."
    ],
    partial: true
  });

  return [
    {
      ...base,
      sourceKind: "period_evidence",
      period
    }
  ];
}

function reviewPeriodFromOptions(options: ReviewPeriodContextOptions) {
  return {
    start: options.startDate,
    end: options.endDate
  };
}

function createPeriodScopeBoundaryEvidence(
  summary: EntitySummary,
  boundary: "project" | "routeNode"
): ReviewDirectTargetEvidence {
  const missingReferences: MissingEntityReference[] = summary.sourceAvailable
    ? []
    : [
        {
          targetType: boundary,
          targetId: summary.entityId,
          reason: "target_not_found",
          message: summary.missingReason
        }
      ];

  return {
    ...createReviewEvidenceBase({
      sourceKind: "scope_anchor",
      role: summary.sourceAvailable ? "anchor" : "missing",
      scopeSensitivity:
        boundary === "project"
          ? ["scope_anchor", "project_boundary"]
          : ["scope_anchor", "route_boundary"],
      sourceBoundary:
        boundary === "project"
          ? "Project filter is the period Review aggregation boundary, not direct evidence."
          : "RouteNode filter narrows period Review aggregation; cross-module summaries may still be project-level.",
      entity: summary,
      warnings: summary.sourceAvailable
        ? []
        : [`Review period scope boundary is missing: ${boundary}:${summary.entityId}.`],
      missingReferences,
      partial: !summary.sourceAvailable
    }),
    sourceKind: "scope_anchor",
    role: summary.sourceAvailable ? "anchor" : "missing",
    targetType: boundary,
    targetId: summary.entityId
  };
}

function createPeriodEntityEvidence(
  entity: EntitySummary,
  options: ReviewPeriodContextOptions,
  sourceBoundary: string,
  extraSensitivity: ReviewEvidenceScopeSensitivity[] = []
): ReviewPeriodEvidence {
  return {
    ...createReviewEvidenceBase({
      sourceKind: "period_evidence",
      role: "contextual",
      scopeSensitivity: uniqueStrings([
        "period_bound",
        ...extraSensitivity
      ]) as ReviewEvidenceScopeSensitivity[],
      sourceBoundary,
      entity
    }),
    sourceKind: "period_evidence",
    period: reviewPeriodFromOptions(options)
  };
}

function createPeriodSummaryEvidence(
  evidence: EvidenceSummary,
  options: ReviewPeriodContextOptions,
  sourceBoundary: string,
  partial: boolean
): ReviewPeriodEvidence {
  return {
    ...createReviewEvidenceBase({
      sourceKind: "period_evidence",
      role: "supporting",
      scopeSensitivity: uniqueStrings([
        "period_bound",
        ...reviewEvidenceSensitivity(evidence)
      ]) as ReviewEvidenceScopeSensitivity[],
      sourceBoundary,
      evidence,
      partial
    }),
    sourceKind: "period_evidence",
    period: reviewPeriodFromOptions(options)
  };
}

function createPeriodTaskEvidence(task: EntitySummary): ReviewTaskEvidence {
  return {
    ...createReviewEvidenceBase({
      sourceKind: "period_evidence",
      role: "contextual",
      scopeSensitivity: ["period_bound", "task_boundary"],
      sourceBoundary: "Task is included because it matches the period Review task filter.",
      entity: task
    }),
    sourceKind: "period_evidence",
    role: "contextual",
    category: "task"
  };
}

function markPeriodEvidencePartial<T extends ReviewEvidenceBase>(
  evidence: T,
  partial: boolean
): T {
  return partial ? { ...evidence, partial: true } : evidence;
}

function linkedCounterpartEvidence(
  links: LinkedEntitySummary[],
  baseType: EntityType,
  baseId: EntityId,
  entityType: EntityType
) {
  return summariesToEvidence(
    filterSummariesByType(collectCounterpartSummaries(links, baseType, baseId), entityType),
    "linked_to"
  );
}

export async function getProjectDetailContext(
  projectId: EntityId
): Promise<ProjectDetailContext | null> {
  const project = await planningService.getProjectById(projectId);
  if (!project) {
    return null;
  }

  const [routeNodes, tasks, reviews, projectEntityContext] = await Promise.all([
    planningService.queryRouteNodes({ projectId }),
    planningService.queryTasks({ projectId }),
    planningService.queryReviewFirstLayerIdentities({ projectId }),
    entityContextService.getEntityCrossModuleContext("project", projectId)
  ]);

  const [
    projectSummary,
    routeNodeSummaries,
    taskSummaries,
    reviewSummaries,
    experimentContexts,
    literatureContext,
    outputContext,
    resultItems,
    outputGaps,
    outputs
  ] = await Promise.all([
    entityContextService.getEntityTargetSummary("project", projectId),
    summarizeIds("routeNode", routeNodes.map((routeNode) => routeNode.id)),
    summarizeIds("task", tasks.map((task) => task.id)),
    reviews.map(summarizeReviewFirstLayerIdentity),
    experimentSelectorService.getExperimentsByProjectContext(projectId),
    literatureSelectorService.getProjectLiteratureContext(projectId),
    outputConversionSelectorService.getOutputConversionProjectContext(projectId),
    outputConversionService.listResultItems().then((items) =>
      items.filter((item) => item.projectId === projectId)
    ),
    outputConversionService.listOutputGaps().then((gaps) =>
      gaps.filter((gap) => gap.projectId === projectId)
    ),
    outputService.listOutputs().then((items) => items.filter((output) => output.projectId === projectId))
  ]);

  const [
    directExperimentSummaries,
    directExperimentRunSummaries,
    directResultMetricSummaries,
    directFileRefSummaries,
    directLiteratureSummaries,
    directResultItemSummaries,
    directFindingSummaries,
    directOutputCandidateSummaries,
    directOutputGapSummaries,
    directOutputSummaries
  ] = await Promise.all([
    summarizeIds(
      "experiment",
      experimentContexts.map((context) => context.experiment.id)
    ),
    summarizeIds(
      "experimentRun",
      experimentContexts.flatMap((context) => context.runs.map((run) => run.id))
    ),
    summarizeIds(
      "resultMetric",
      experimentContexts.flatMap((context) =>
        Object.values(context.metricsByRunId)
          .flat()
          .map((metric) => metric.id)
      )
    ),
    summarizeIds(
      "fileRef",
      experimentContexts.flatMap((context) => context.relatedFileRefs.map((fileRef) => fileRef.id))
    ),
    summarizeIds(
      "literature",
      literatureContext.literatures.map((literature) => literature.id)
    ),
    summarizeIds("resultItem", resultItems.map((item) => item.id)),
    summarizeIds("finding", outputContext.findings.map((finding) => finding.id)),
    summarizeIds(
      "outputCandidate",
      outputContext.candidates.map((candidate) => candidate.id)
    ),
    summarizeIds("outputGap", outputGaps.map((gap) => gap.id)),
    summarizeIds("output", outputs.map((output) => output.id))
  ]);
  const allProjectLinks = [
    ...projectEntityContext.outgoingLinks,
    ...projectEntityContext.incomingLinks
  ];
  const linkedSummaries = collectCounterpartSummaries(allProjectLinks, "project", projectId);
  const level4Projection = buildProjectLevel4RelationIndexProjection({
    projectId,
    routeNodes,
    tasks,
    reviews,
    experimentContexts,
    literatures: literatureContext.literatures,
    resultItems,
    findings: outputContext.findings,
    outputCandidates: outputContext.candidates,
    outputGaps,
    outputs
  });

  return {
    project,
    projectSummary,
    routeNodes: routeNodeSummaries,
    tasks: taskSummaries,
    reviews: reviewSummaries,
    linkedEntities: allProjectLinks,
    crossModule: buildProjectCrossModuleSummary(
      {
        experiments: directExperimentSummaries,
        experimentRuns: directExperimentRunSummaries,
        resultMetrics: directResultMetricSummaries,
        fileRefs: directFileRefSummaries,
        literatures: directLiteratureSummaries,
        resultItems: directResultItemSummaries,
        findings: directFindingSummaries,
        outputCandidates: directOutputCandidateSummaries,
        outputGaps: directOutputGapSummaries,
        outputs: directOutputSummaries
      },
      linkedSummaries
    ),
    level4RelationIndex: level4Projection.entries,
    level4RelationIndexExclusions: level4Projection.exclusions,
    taskStats: buildTaskStats(tasks),
    warnings: uniqueStrings([...projectEntityContext.warnings, ...literatureContext.warnings]),
    missingReferences: uniqueMissingReferences([
      ...projectEntityContext.missingReferences,
      ...literatureContext.missingReferences
    ]),
    partial: projectEntityContext.partial || literatureContext.partial
  };
}

export async function getProjectOverviewContext(projectId: EntityId) {
  const [
    reviews,
    experiments,
    experimentRuns,
    literatureContext,
    resultItems,
    findings,
    outputCandidates,
    outputGaps,
    outputs,
    projectEntityContext
  ] = await Promise.all([
    planningService.queryReviewFirstLayerIdentities({ projectId }),
    experimentService.getExperimentsByProject(projectId),
    experimentRunService.listWritableExperimentRuns(),
    literatureSelectorService.getProjectLiteratureContext(projectId),
    outputConversionService.listResultItems(),
    outputConversionService.listFindings(),
    outputConversionService.listOutputCandidates(),
    outputConversionService.listOutputGaps(),
    outputService.listOutputs(),
    entityContextService.getEntityCrossModuleContext("project", projectId)
  ]);
  const experimentIds = new Set(experiments.map((experiment) => experiment.id));
  const linkedSummaries = collectCounterpartSummaries(
    [...projectEntityContext.outgoingLinks, ...projectEntityContext.incomingLinks],
    "project",
    projectId
  );
  const countUnique = (directIds: string[], linkedType: EntityType) => new Set([
    ...directIds,
    ...linkedSummaries
      .filter((summary) => summary.entityType === linkedType)
      .map((summary) => summary.entityId)
  ]).size;
  const missingReferences = uniqueMissingReferences([
    ...projectEntityContext.missingReferences,
    ...literatureContext.missingReferences
  ]);
  const warnings = uniqueStrings([
    ...projectEntityContext.warnings,
    ...literatureContext.warnings
  ]);

  return {
    reviews: reviews.map(summarizeReviewFirstLayerIdentity),
    experimentEvidenceCount:
      countUnique(experiments.map((experiment) => experiment.id), "experiment") +
      countUnique(
        experimentRuns
          .filter((run) => experimentIds.has(run.experimentId))
          .map((run) => run.id),
        "experimentRun"
      ),
    literatureEvidenceCount: countUnique(
      literatureContext.literatures.map((literature) => literature.id),
      "literature"
    ),
    outputEvidenceCount:
      countUnique(
        resultItems.filter((item) => item.projectId === projectId).map((item) => item.id),
        "resultItem"
      ) +
      countUnique(
        findings.filter((finding) => finding.projectId === projectId).map((finding) => finding.id),
        "finding"
      ) +
      countUnique(
        outputCandidates
          .filter((candidate) => candidate.projectId === projectId)
          .map((candidate) => candidate.id),
        "outputCandidate"
      ) +
      countUnique(
        outputs.filter((output) => output.projectId === projectId).map((output) => output.id),
        "output"
      ),
    outputGapCount: countUnique(
      outputGaps.filter((gap) => gap.projectId === projectId).map((gap) => gap.id),
      "outputGap"
    ),
    warnings,
    missingReferenceCount: missingReferences.length,
    partial: projectEntityContext.partial || literatureContext.partial,
    generatedAt: new Date().toISOString()
  };
}

export async function getOutputGapTaskSummary(
  outputGapId: EntityId
): Promise<OutputGapTaskSummary | null> {
  const outputGap = await outputConversionService.getOutputGapById(outputGapId);
  if (!outputGap) {
    return null;
  }

  const [outputGapSummary, outgoingLinks, incomingLinks] = await Promise.all([
    entityContextService.getEntityTargetSummary("outputGap", outputGapId),
    entityContextService.getLinkedEntitySummaries("outputGap", outputGapId),
    entityContextService.getBackReferenceSummaries("outputGap", outputGapId)
  ]);
  const relationSummaries = [...outgoingLinks, ...incomingLinks].filter((link) => {
    const counterpart = counterpartForLink(link, "outputGap", outputGapId);
    return counterpart.entityType === "task";
  });
  const entityLinkTasks = relationSummaries.map((link) =>
    counterpartForLink(link, "outputGap", outputGapId)
  );
  const fallbackTask =
    outputGap.relatedTaskId && entityLinkTasks.length === 0
      ? await entityContextService.getEntityTargetSummary("task", outputGap.relatedTaskId)
      : undefined;
  const fallbackRelation: LinkedEntitySummary | undefined = fallbackTask
    ? {
        source: outputGapSummary,
        target: fallbackTask,
        relationType: "needs_followup_task",
        linkSource: "fallbackField",
        description: "OutputGap.relatedTaskId fallback relation."
      }
    : undefined;

  return {
    outputGap: outputGapSummary,
    tasks: uniqueSummaries([...entityLinkTasks, ...(fallbackTask ? [fallbackTask] : [])]),
    relationSummaries: fallbackRelation
      ? [...relationSummaries, fallbackRelation]
      : relationSummaries,
    relationSource:
      relationSummaries.length > 0 && fallbackTask
        ? "mixed"
        : relationSummaries.length > 0
          ? "entityLink"
          : fallbackTask
            ? "relatedTaskIdFallback"
            : "none",
    status: outputGap.status,
    priority: outputGap.priority,
    warning:
      relationSummaries.length === 0 && outputGap.relatedTaskId
        ? "No EntityLink found; relatedTaskId was used as a read-only fallback."
        : undefined
  };
}

export async function getTaskOutputGapSummaries(
  taskId: EntityId
): Promise<TaskOutputGapSummaries> {
  const [outgoingLinks, incomingLinks, outputGaps] = await Promise.all([
    entityContextService.getLinkedEntitySummaries("task", taskId),
    entityContextService.getBackReferenceSummaries("task", taskId),
    outputConversionService.listOutputGaps()
  ]);
  const linkedGapIds = uniqueSummaries(
    [...outgoingLinks, ...incomingLinks]
      .map((link) => counterpartForLink(link, "task", taskId))
      .filter((summary) => summary.entityType === "outputGap")
  ).map((summary) => summary.entityId);
  const fallbackGapIds = outputGaps
    .filter((gap) => gap.relatedTaskId === taskId && !linkedGapIds.includes(gap.id))
    .map((gap) => gap.id);
  const summaries = (
    await Promise.all(
      [...linkedGapIds, ...fallbackGapIds].map((outputGapId) =>
        getOutputGapTaskSummary(outputGapId)
      )
    )
  ).filter((summary): summary is OutputGapTaskSummary => Boolean(summary));

  return {
    taskId,
    outputGaps: summaries
  };
}

function uniqueLinkSummaries(links: LinkedEntitySummary[]) {
  const byKey = new Map<string, LinkedEntitySummary>();
  for (const link of links) {
    const key =
      link.linkId ??
      `${link.source.entityType}:${link.source.entityId}:${link.target.entityType}:${link.target.entityId}:${link.relationType}`;
    byKey.set(key, link);
  }
  return [...byKey.values()];
}

function outputGapCustomFieldText(gap: OutputGap, names: string[]) {
  const field = (gap.customFields ?? []).find(
    (item) => names.includes(item.id) || names.includes(item.name)
  );
  return typeof field?.value === "string" ? field.value : undefined;
}

function toRouteNodeOutputGapSummary(
  link: LinkedEntitySummary,
  routeNodeId: EntityId,
  gapById: Map<EntityId, OutputGap>,
  gapCandidateIds: Map<EntityId, EntityId | null>
): RouteNodeOutputGapSummary {
  const outputGapSummary = counterpartForLink(link, "routeNode", routeNodeId);
  const gap = gapById.get(outputGapSummary.entityId);

  return {
    outputGapId: outputGapSummary.entityId,
    title: gap?.title ?? outputGapSummary.title,
    status: gap?.status ?? outputGapSummary.status,
    priority: gap?.priority,
    gapType: gap?.gapType,
    severity: gap ? outputGapCustomFieldText(gap, ["severity", "outputGapSeverity"]) : undefined,
    sourceCandidateId: gapCandidateIds.get(outputGapSummary.entityId) ?? undefined,
    sourceFindingId: gap
      ? outputGapCustomFieldText(gap, ["sourceFindingId", "findingId"])
      : undefined,
    relationType: String(link.relationType),
    linkedAt: link.createdAt,
    outputGap: outputGapSummary,
    relationSummary: link
  };
}

function toRouteNodeOutputGapFallbackSummary(
  gap: OutputGap,
  sourceCandidateId?: EntityId | null
): RouteNodeOutputGapSummary {
  return {
    outputGapId: gap.id,
    title: gap.title,
    status: gap.status,
    priority: gap.priority,
    gapType: gap.gapType,
    severity: outputGapCustomFieldText(gap, ["severity", "outputGapSeverity"]),
    sourceCandidateId: sourceCandidateId ?? undefined,
    sourceFindingId: outputGapCustomFieldText(gap, ["sourceFindingId", "findingId"]),
    relationType: "relatedRouteNodeIdFallback",
    linkedAt: gap.updatedAt,
    outputGap: {
      entityType: "outputGap",
      entityId: gap.id,
      title: gap.title,
      subtitle: gap.description,
      status: gap.status,
      createdAt: gap.createdAt,
      updatedAt: gap.updatedAt,
      sourceModule: "outputConversion",
      sourceAvailable: true
    }
  };
}

function toOutputGapRouteNodeSummary(
  link: LinkedEntitySummary,
  outputGapId: EntityId
): OutputGapRouteNodeSummary {
  const routeNodeSummary = counterpartForLink(link, "outputGap", outputGapId);

  return {
    routeNodeId: routeNodeSummary.entityId,
    title: routeNodeSummary.title,
    status: routeNodeSummary.status,
    relationType: String(link.relationType),
    linkedAt: link.createdAt,
    routeNode: routeNodeSummary,
    relationSummary: link
  };
}

export async function getRouteNodeOutputGapSummaries(
  routeNodeId: EntityId
): Promise<RouteNodeOutputGapSummaries> {
  const [outgoingLinks, incomingLinks, outputGaps] = await Promise.all([
    entityContextService.getLinkedEntitySummaries("routeNode", routeNodeId),
    entityContextService.getBackReferenceSummaries("routeNode", routeNodeId),
    outputConversionService.listOutputGaps()
  ]);
  const gapById = new Map(outputGaps.map((gap) => [gap.id, gap]));
  const relationSummaries = uniqueLinkSummaries(
    [...outgoingLinks, ...incomingLinks].filter((link) => {
      const counterpart = counterpartForLink(link, "routeNode", routeNodeId);
      return counterpart.entityType === "outputGap";
    })
  );
  const linkedGapIds = relationSummaries.map(
    (link) => counterpartForLink(link, "routeNode", routeNodeId).entityId
  );
  const fallbackGaps = outputGaps.filter(
    (gap) => gap.relatedRouteNodeId === routeNodeId && !linkedGapIds.includes(gap.id)
  );
  const gapCandidateIds = new Map(
    await Promise.all(
      [...relationSummaries.map((link) => counterpartForLink(link, "routeNode", routeNodeId).entityId), ...fallbackGaps.map((gap) => gap.id)].map(
        async (gapId) => [gapId, await outputConversionService.getOutputCandidateIdByGapId(gapId)] as const
      )
    )
  );

  return {
    routeNodeId,
    outputGaps: [
      ...relationSummaries.map((link) =>
        toRouteNodeOutputGapSummary(link, routeNodeId, gapById, gapCandidateIds)
      ),
      ...fallbackGaps.map((gap) =>
        toRouteNodeOutputGapFallbackSummary(gap, gapCandidateIds.get(gap.id))
      )
    ]
  };
}

function emptyRouteCheckpointStatusCounts(): Record<RouteCheckpointStatus, number> {
  return {
    completed: 0,
    active: 0,
    blocked: 0,
    abandoned: 0,
    planned: 0
  };
}

function routeCheckpointSortValue(checkpoint: RouteCheckpoint) {
  return [
    checkpoint.orderIndex.toString().padStart(8, "0"),
    checkpoint.dueDate ?? "",
    checkpoint.updatedAt,
    checkpoint.createdAt,
    checkpoint.title
  ].join("|");
}

function latestByRouteCheckpointUpdate(checkpoints: RouteCheckpoint[]) {
  return [...checkpoints].sort(
    (left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) ||
      right.createdAt.localeCompare(left.createdAt) ||
      right.title.localeCompare(left.title)
  )[0];
}

function currentRouteCheckpoint(checkpoints: RouteCheckpoint[]) {
  const byStatus = (status: RouteCheckpointStatus) =>
    [...checkpoints]
      .filter((checkpoint) => checkpoint.status === status)
      .sort((left, right) => routeCheckpointSortValue(right).localeCompare(routeCheckpointSortValue(left)))[0];
  const latestByStatus = (status: RouteCheckpointStatus) =>
    latestByRouteCheckpointUpdate(checkpoints.filter((checkpoint) => checkpoint.status === status));

  return (
    byStatus("active") ??
    byStatus("blocked") ??
    latestByStatus("planned") ??
    latestByStatus("completed")
  );
}

function buildRouteCheckpointProgressSummary(
  routeNodeId: EntityId,
  checkpoints: RouteCheckpoint[]
): RouteCheckpointProgressSummary {
  const statusCounts = emptyRouteCheckpointStatusCounts();
  for (const checkpoint of checkpoints) {
    statusCounts[checkpoint.status] += 1;
  }

  const total = checkpoints.length;
  const effectiveTotal = total - statusCounts.abandoned;
  const completionRate =
    effectiveTotal > 0 ? Math.round((statusCounts.completed / effectiveTotal) * 100) : 0;

  return {
    routeNodeId,
    total,
    completed: statusCounts.completed,
    active: statusCounts.active,
    blocked: statusCounts.blocked,
    abandoned: statusCounts.abandoned,
    planned: statusCounts.planned,
    completionRate,
    currentCheckpoint: currentRouteCheckpoint(checkpoints),
    latestFeedback: latestByRouteCheckpointUpdate(
      checkpoints.filter((checkpoint) => checkpoint.feedback?.trim())
    ),
    statusCounts
  };
}

export async function getRouteCheckpointProgressSummary(
  routeNodeId: EntityId
): Promise<RouteCheckpointProgressSummary> {
  const checkpoints = await planningService.queryRouteCheckpointsByRouteNode(routeNodeId);
  return buildRouteCheckpointProgressSummary(routeNodeId, checkpoints);
}

export async function getRouteCheckpointProgressSummaries(
  routeNodeIds: EntityId[]
): Promise<Record<EntityId, RouteCheckpointProgressSummary>> {
  const uniqueRouteNodeIds = [...new Set(routeNodeIds.filter(Boolean))];
  const checkpointsByRouteNodeId =
    await planningService.queryRouteCheckpointsByRouteNodes(uniqueRouteNodeIds);

  return Object.fromEntries(
    uniqueRouteNodeIds.map((routeNodeId) => [
      routeNodeId,
      buildRouteCheckpointProgressSummary(routeNodeId, checkpointsByRouteNodeId[routeNodeId] ?? [])
    ])
  );
}

function emptyTaskCheckpointStatusCounts(): Record<TaskCheckpointStatus, number> {
  return {
    completed: 0,
    active: 0,
    blocked: 0,
    abandoned: 0,
    planned: 0
  };
}

function taskCheckpointSortValue(checkpoint: TaskCheckpoint) {
  return [
    checkpoint.orderIndex.toString().padStart(8, "0"),
    checkpoint.dueDate ?? "",
    checkpoint.updatedAt,
    checkpoint.createdAt,
    checkpoint.title
  ].join("|");
}

function latestByTaskCheckpointUpdate(checkpoints: TaskCheckpoint[]) {
  return [...checkpoints].sort(
    (left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) ||
      right.createdAt.localeCompare(left.createdAt) ||
      right.title.localeCompare(left.title)
  )[0];
}

function currentTaskCheckpoint(checkpoints: TaskCheckpoint[]) {
  const byStatus = (status: TaskCheckpointStatus) =>
    [...checkpoints]
      .filter((checkpoint) => checkpoint.status === status)
      .sort((left, right) => taskCheckpointSortValue(right).localeCompare(taskCheckpointSortValue(left)))[0];
  const latestByStatus = (status: TaskCheckpointStatus) =>
    latestByTaskCheckpointUpdate(checkpoints.filter((checkpoint) => checkpoint.status === status));

  return (
    byStatus("active") ??
    byStatus("blocked") ??
    latestByStatus("planned") ??
    latestByStatus("completed")
  );
}

function buildTaskCheckpointProgressSummary(
  taskId: EntityId,
  checkpoints: TaskCheckpoint[]
): TaskCheckpointProgressSummary {
  const statusCounts = emptyTaskCheckpointStatusCounts();
  for (const checkpoint of checkpoints) {
    statusCounts[checkpoint.status] += 1;
  }

  const total = checkpoints.length;
  const effectiveTotal = total - statusCounts.abandoned;
  const completionRate = effectiveTotal > 0 ? statusCounts.completed / effectiveTotal : 0;

  return {
    taskId,
    total,
    completed: statusCounts.completed,
    active: statusCounts.active,
    blocked: statusCounts.blocked,
    abandoned: statusCounts.abandoned,
    planned: statusCounts.planned,
    effectiveTotal,
    completionRate,
    currentCheckpoint: currentTaskCheckpoint(checkpoints),
    latestFeedback: latestByTaskCheckpointUpdate(
      checkpoints.filter((checkpoint) => checkpoint.feedback?.trim())
    ),
    statusCounts
  };
}

export async function getTaskCheckpointProgressSummary(
  taskId: EntityId
): Promise<TaskCheckpointProgressSummary> {
  const checkpoints = await planningService.queryTaskCheckpointsByTask(taskId);
  return buildTaskCheckpointProgressSummary(taskId, checkpoints);
}

export async function getTaskCheckpointProgressSummaries(
  taskIds: EntityId[]
): Promise<Record<EntityId, TaskCheckpointProgressSummary>> {
  const uniqueTaskIds = [...new Set(taskIds.filter(Boolean))];
  const checkpointsByTaskId = await planningService.queryTaskCheckpointsByTasks(uniqueTaskIds);

  return Object.fromEntries(
    uniqueTaskIds.map((taskId) => [
      taskId,
      buildTaskCheckpointProgressSummary(taskId, checkpointsByTaskId[taskId] ?? [])
    ])
  );
}

function pad2(value: number) {
  return value.toString().padStart(2, "0");
}

function toLocalDateKey(date: Date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function routinePeriodBounds(value: string | Date, frequency: RoutineFrequency) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid routine period date: ${String(value)}.`);
  }

  if (frequency === "daily") {
    const key = toLocalDateKey(date);
    return { periodStart: key, periodEnd: key };
  }

  if (frequency === "monthly") {
    const start = new Date(date.getFullYear(), date.getMonth(), 1);
    const end = new Date(date.getFullYear(), date.getMonth() + 1, 0);
    return {
      periodStart: toLocalDateKey(start),
      periodEnd: toLocalDateKey(end)
    };
  }

  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = start.getDay() || 7;
  start.setDate(start.getDate() - day + 1);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return {
    periodStart: toLocalDateKey(start),
    periodEnd: toLocalDateKey(end)
  };
}

function routineAppliesOn(routine: ResearchRoutine, referenceDate: string | Date) {
  const date = referenceDate instanceof Date ? toLocalDateKey(referenceDate) : referenceDate.slice(0, 10);
  return (!routine.startDate || routine.startDate.slice(0, 10) <= date) &&
    (!routine.endDate || routine.endDate.slice(0, 10) >= date);
}

function latestRoutineCheckIn(checkIns: RoutineCheckIn[]) {
  return [...checkIns].sort(
    (left, right) =>
      right.checkedAt.localeCompare(left.checkedAt) ||
      right.updatedAt.localeCompare(left.updatedAt) ||
      right.createdAt.localeCompare(left.createdAt)
  )[0];
}

function buildRoutineCurrentPeriodSummary(
  routine: ResearchRoutine,
  checkIns: RoutineCheckIn[],
  referenceDate: string | Date
): RoutineCurrentPeriodSummary {
  const periodKey = planningService.getRoutinePeriodKey(referenceDate, routine.frequency);
  const currentPeriodCheckIns = checkIns.filter((checkIn) => checkIn.periodKey === periodKey);
  const totalCount = currentPeriodCheckIns.reduce(
    (sum, checkIn) => sum + Math.max(1, Math.floor(checkIn.count ?? 1)),
    0
  );
  const targetCount = Math.max(1, Math.floor(routine.targetCount ?? 1));
  const completionRate =
    routine.targetType === "count"
      ? Math.min(totalCount / targetCount, 1)
      : currentPeriodCheckIns.length > 0
        ? 1
        : 0;
  const isCompleted =
    routine.targetType === "count"
      ? totalCount >= targetCount
      : currentPeriodCheckIns.length > 0;
  const { periodStart, periodEnd } = routinePeriodBounds(referenceDate, routine.frequency);

  return {
    routineId: routine.id,
    projectId: routine.projectId,
    title: routine.title,
    frequency: routine.frequency,
    targetType: routine.targetType,
    targetCount: routine.targetCount,
    targetDescription: routine.targetDescription,
    periodKey,
    periodStart,
    periodEnd,
    checkInCount: currentPeriodCheckIns.length,
    totalCount,
    completionRate,
    isCompleted,
    latestCheckIn: latestRoutineCheckIn(currentPeriodCheckIns),
    routine
  };
}

export async function getRoutineCurrentPeriodSummary(
  routineId: EntityId,
  referenceDate: string | Date = new Date()
): Promise<RoutineCurrentPeriodSummary | null> {
  const routine = await planningService.getResearchRoutineById(routineId);
  if (!routine) {
    return null;
  }

  const checkIns = await planningService.queryRoutineCheckInsByRoutine(routineId);
  return buildRoutineCurrentPeriodSummary(routine, checkIns, referenceDate);
}

export async function getRoutineCurrentPeriodSummaries(
  routineIds: EntityId[],
  referenceDate: string | Date = new Date()
): Promise<Record<EntityId, RoutineCurrentPeriodSummary>> {
  const uniqueRoutineIds = [...new Set(routineIds.filter(Boolean))];
  const routines = (
    await Promise.all(uniqueRoutineIds.map((routineId) => planningService.getResearchRoutineById(routineId)))
  ).filter((routine): routine is ResearchRoutine => Boolean(routine));
  const checkInsByRoutineId =
    await planningService.queryRoutineCheckInsByRoutines(routines.map((routine) => routine.id));

  return Object.fromEntries(
    routines.map((routine) => [
      routine.id,
      buildRoutineCurrentPeriodSummary(routine, checkInsByRoutineId[routine.id] ?? [], referenceDate)
    ])
  );
}

export async function getProjectRoutineSummary(
  projectId: EntityId,
  referenceDate: string | Date = new Date()
): Promise<ProjectRoutineSummary> {
  const routines = await planningService.queryResearchRoutines({
    projectId,
    includeGlobal: true,
    isActive: true
  });
  const activeRoutines = routines.filter((routine) => routineAppliesOn(routine, referenceDate));
  const checkInsByRoutineId =
    await planningService.queryRoutineCheckInsByRoutines(activeRoutines.map((routine) => routine.id));
  const summaries = activeRoutines.map((routine) =>
    buildRoutineCurrentPeriodSummary(routine, checkInsByRoutineId[routine.id] ?? [], referenceDate)
  );
  const currentPeriodCompletedCount = summaries.filter((summary) => summary.isCompleted).length;

  return {
    projectId,
    activeRoutineCount: activeRoutines.length,
    currentPeriodRoutineCount: summaries.length,
    currentPeriodCompletedCount,
    currentPeriodCompletionRate:
      summaries.length > 0 ? currentPeriodCompletedCount / summaries.length : 0,
    summaries
  };
}

function emptyTaskStatusCounts(): Record<TaskStatus, number> {
  return {
    todo: 0,
    doing: 0,
    done: 0,
    delayed: 0,
    blocked: 0,
    cancelled: 0,
    archived: 0
  };
}

function buildRouteNodeTaskSummary(routeNodeId: EntityId, tasks: Task[]): RouteNodeTaskSummary {
  const statusCounts = emptyTaskStatusCounts();
  for (const task of tasks) {
    statusCounts[task.status] += 1;
  }

  return {
    routeNodeId,
    total: tasks.length,
    completed: statusCounts.done,
    active: statusCounts.doing,
    blocked: statusCounts.blocked,
    delayed: statusCounts.delayed,
    cancelled: statusCounts.cancelled,
    planned: statusCounts.todo,
    archived: statusCounts.archived,
    statusCounts
  };
}

export async function getRouteNodeTaskSummary(
  routeNodeId: EntityId
): Promise<RouteNodeTaskSummary> {
  const tasks = await planningService.queryTasks({ routeNodeId, includeArchived: true });
  return buildRouteNodeTaskSummary(routeNodeId, tasks);
}

export async function getRouteNodeTaskSummaries(
  routeNodeIds: EntityId[]
): Promise<Record<EntityId, RouteNodeTaskSummary>> {
  const uniqueRouteNodeIds = [...new Set(routeNodeIds.filter(Boolean))];
  const routeNodeIdSet = new Set(uniqueRouteNodeIds);
  const tasks = await planningService.queryTasks({ includeArchived: true });
  return Object.fromEntries(
    uniqueRouteNodeIds.map((routeNodeId) => [
      routeNodeId,
      buildRouteNodeTaskSummary(
        routeNodeId,
        tasks.filter((task) => task.routeNodeId && routeNodeIdSet.has(task.routeNodeId) && task.routeNodeId === routeNodeId)
      )
    ])
  );
}

export async function getOutputGapRouteNodeSummaries(
  outputGapId: EntityId
): Promise<OutputGapRouteNodeSummaries | null> {
  const outputGap = await outputConversionService.getOutputGapById(outputGapId);
  if (!outputGap) {
    return null;
  }

  const [outgoingLinks, incomingLinks] = await Promise.all([
    entityContextService.getLinkedEntitySummaries("outputGap", outputGapId),
    entityContextService.getBackReferenceSummaries("outputGap", outputGapId)
  ]);
  const relationSummaries = uniqueLinkSummaries(
    [...outgoingLinks, ...incomingLinks].filter((link) => {
      const counterpart = counterpartForLink(link, "outputGap", outputGapId);
      return counterpart.entityType === "routeNode";
    })
  );
  const linkedRouteNodeIds = relationSummaries.map(
    (link) => counterpartForLink(link, "outputGap", outputGapId).entityId
  );
  const fallbackRouteNode =
    outputGap.relatedRouteNodeId && !linkedRouteNodeIds.includes(outputGap.relatedRouteNodeId)
      ? await entityContextService.getEntityTargetSummary("routeNode", outputGap.relatedRouteNodeId)
      : null;

  return {
    outputGapId,
    routeNodes: [
      ...relationSummaries.map((link) =>
        toOutputGapRouteNodeSummary(link, outputGapId)
      ),
      ...(fallbackRouteNode
        ? [
            {
              routeNodeId: fallbackRouteNode.entityId,
              title: fallbackRouteNode.title,
              status: fallbackRouteNode.status,
              relationType: "relatedRouteNodeIdFallback",
              linkedAt: outputGap.updatedAt,
              routeNode: fallbackRouteNode
            }
          ]
        : [])
    ]
  };
}

export async function getOutputGapClosureContext(
  outputGapId: EntityId
): Promise<OutputGapClosureContext | null> {
  const summary = await getOutputGapTaskSummary(outputGapId);
  if (!summary) {
    return null;
  }

  const taskEntities = (
    await Promise.all(summary.tasks.map((task) => planningService.getTaskById(task.entityId)))
  ).filter((task): task is Task => Boolean(task));
  const completedTaskIds = new Set(
    taskEntities.filter((task) => task.status === "done").map((task) => task.id)
  );
  const activeTaskIds = new Set(
    taskEntities
      .filter(
        (task) =>
          task.status !== "done" &&
          task.status !== "cancelled" &&
          task.status !== "archived"
      )
      .map((task) => task.id)
  );

  return {
    outputGap: summary.outputGap,
    status: summary.status,
    tasks: summary.tasks,
    completedTasks: summary.tasks.filter((task) => completedTaskIds.has(task.entityId)),
    activeTasks: summary.tasks.filter((task) => activeTaskIds.has(task.entityId)),
    relationSummaries: summary.relationSummaries,
    relationSource: summary.relationSource,
    isResolved: summary.status === "resolved",
    isPartiallyResolved:
      summary.status === "task_created" || summary.status === "route_feedback_created",
    isUnresolved:
      summary.status !== "resolved" &&
      summary.status !== "task_created" &&
      summary.status !== "route_feedback_created" &&
      summary.status !== "abandoned",
    warnings: uniqueStrings([summary.warning])
  };
}

export async function getTaskDetailContext(taskId: EntityId): Promise<TaskDetailContext | null> {
  const task = await planningService.getTaskById(taskId);
  if (!task) {
    return null;
  }

  const [taskSummary, taskEntityContext, projectSummary, routeNodeSummary, checkpointSummary] = await Promise.all([
    entityContextService.getEntityTargetSummary("task", taskId),
    entityContextService.getEntityCrossModuleContext("task", taskId),
    entityContextService.getEntityTargetSummary("project", task.projectId),
    task.routeNodeId
      ? entityContextService.getEntityTargetSummary("routeNode", task.routeNodeId)
      : Promise.resolve(null),
    getTaskCheckpointProgressSummary(taskId)
  ]);
  const [experimentContexts, literatureContext, resultItems, findings, candidates, outputs, gaps] =
    await Promise.all([
      experimentSelectorService.getExperimentsByTaskContext(taskId),
      literatureSelectorService.getTaskLiteratureContext(taskId),
      outputConversionService.listResultItems().then((items) =>
        items.filter((item) => item.taskId === taskId)
      ),
      outputConversionSelectorService.queryFindings({ taskId }),
      outputConversionSelectorService.queryOutputCandidates({ taskId }),
      outputService.listOutputs().then((items) => items.filter((output) => output.taskId === taskId)),
      getTaskOutputGapSummaries(taskId)
    ]);
  const allTaskLinks = [...taskEntityContext.outgoingLinks, ...taskEntityContext.incomingLinks];
  const linkedSummaries = collectCounterpartSummaries(allTaskLinks, "task", taskId);
  const directExperimentSummaries = await summarizeIds(
    "experiment",
    experimentContexts.map((context) => context.experiment.id)
  );
  const directExperimentRunSummaries = await summarizeIds(
    "experimentRun",
    experimentContexts.flatMap((context) => context.runs.map((run) => run.id))
  );
  const directResultMetricSummaries = await summarizeIds(
    "resultMetric",
    experimentContexts.flatMap((context) =>
      Object.values(context.metricsByRunId)
        .flat()
        .map((metric) => metric.id)
    )
  );
  const directFileRefSummaries = await summarizeIds(
    "fileRef",
    experimentContexts.flatMap((context) => context.relatedFileRefs.map((fileRef) => fileRef.id))
  );
  const directLiteratureSummaries = await summarizeIds(
    "literature",
    literatureContext.literatures.map((literature) => literature.id)
  );
  const directResultItemSummaries = await summarizeIds(
    "resultItem",
    resultItems.map((item) => item.id)
  );
  const directFindingSummaries = await summarizeIds(
    "finding",
    findings.map((finding) => finding.id)
  );
  const directOutputCandidateSummaries = await summarizeIds(
    "outputCandidate",
    candidates.map((candidate) => candidate.id)
  );
  const directOutputSummaries = await summarizeIds(
    "output",
    outputs.map((output) => output.id)
  );

  return {
    task,
    taskSummary,
    project: projectSummary.sourceAvailable ? projectSummary : null,
    routeNode: routeNodeSummary?.sourceAvailable ? routeNodeSummary : null,
    linkedEntities: taskEntityContext.outgoingLinks,
    backReferences: taskEntityContext.incomingLinks,
    experiments: uniqueSummaries([
      ...directExperimentSummaries,
      ...filterSummariesByType(linkedSummaries, "experiment")
    ]),
    experimentRuns: uniqueSummaries([
      ...directExperimentRunSummaries,
      ...filterSummariesByType(linkedSummaries, "experimentRun")
    ]),
    resultMetrics: uniqueSummaries([
      ...directResultMetricSummaries,
      ...filterSummariesByType(linkedSummaries, "resultMetric")
    ]),
    fileRefs: uniqueSummaries([
      ...directFileRefSummaries,
      ...filterSummariesByType(linkedSummaries, "fileRef")
    ]),
    literatures: uniqueSummaries([
      ...directLiteratureSummaries,
      ...filterSummariesByType(linkedSummaries, "literature")
    ]),
    resultItems: uniqueSummaries([
      ...directResultItemSummaries,
      ...filterSummariesByType(linkedSummaries, "resultItem")
    ]),
    findings: uniqueSummaries([
      ...directFindingSummaries,
      ...filterSummariesByType(linkedSummaries, "finding")
    ]),
    outputCandidates: uniqueSummaries([
      ...directOutputCandidateSummaries,
      ...filterSummariesByType(linkedSummaries, "outputCandidate")
    ]),
    outputGaps: gaps.outputGaps,
    checkpointSummary,
    outputs: uniqueSummaries([
      ...directOutputSummaries,
      ...filterSummariesByType(linkedSummaries, "output")
    ]),
    warnings: uniqueStrings([...taskEntityContext.warnings, ...literatureContext.warnings]),
    missingReferences: uniqueMissingReferences([
      ...taskEntityContext.missingReferences,
      ...literatureContext.missingReferences
    ]),
    partial: taskEntityContext.partial || literatureContext.partial
  };
}

export async function getReviewBasicContext(
  reviewId: EntityId
): Promise<ReviewBasicContext | null> {
  const review = await planningService.getReviewById(reviewId);
  if (!review) {
    return null;
  }

  const [
    reviewSummary,
    projectSummary,
    reviewEntityContext
  ] = await Promise.all([
      entityContextService.getEntityTargetSummary("review", reviewId),
      entityContextService.getEntityTargetSummary("project", review.projectId),
      entityContextService.getEntityCrossModuleContext("review", reviewId)
    ]);
  const linkedEntities = [...reviewEntityContext.outgoingLinks, ...reviewEntityContext.incomingLinks];
  const targets = reviewTargetLinks(
    reviewSummary,
    linkedEntities,
    projectSummary.sourceAvailable ? projectSummary : null
  );
  const targetRouteNodes = targetSummariesByType(targets, "routeNode");
  const targetTasks = targetSummariesByType(targets, "task");
  const targetExperiments = uniqueSummaries([
    ...targetSummariesByType(targets, "experiment"),
    ...targetSummariesByType(targets, "experimentSummary")
  ]);

  return {
    review,
    scope: deriveReviewContextScope(targets),
    period: reviewPeriod(review),
    reviewSummary,
    project: projectSummary.sourceAvailable ? projectSummary : null,
    routeNodes: uniqueSummaries([
      ...targetRouteNodes,
      ...filterSummariesByType(
        collectCounterpartSummaries(
          linkedEntities,
          "review",
          reviewId
        ),
        "routeNode"
      )
    ]),
    tasks: uniqueSummaries([
      ...targetTasks,
      ...filterSummariesByType(
        collectCounterpartSummaries(
          linkedEntities,
          "review",
          reviewId
        ),
        "task"
      )
    ]),
    experiments: targetExperiments,
    outputs: [],
    targets,
    linkedEntities,
    outlineSections: review.outlineSections,
    warnings: reviewEntityContext.warnings,
    missingReferences: reviewEntityContext.missingReferences,
    partial: reviewEntityContext.partial
  };
}

export async function getProjectResearchContext(
  projectId: EntityId
): Promise<ProjectResearchContext | null> {
  const [detail, routineSummary] = await Promise.all([
    getProjectDetailContext(projectId),
    getProjectRoutineSummary(projectId)
  ]);
  if (!detail) {
    return null;
  }

  const experiments = summariesToEvidence(detail.crossModule.experiments, "project_scope");
  const experimentRuns = summariesToEvidence(detail.crossModule.experimentRuns, "project_scope");
  const literatures = summariesToEvidence(detail.crossModule.literatures, "project_scope");
  const resultItems = summariesToEvidence(detail.crossModule.resultItems, "project_scope");
  const findings = summariesToEvidence(detail.crossModule.findings, "project_scope");
  const outputCandidates = summariesToEvidence(
    detail.crossModule.outputCandidates,
    "project_scope"
  );
  const outputGaps = summariesToEvidence(detail.crossModule.outputGaps, "project_scope");
  const outputs = summariesToEvidence(detail.crossModule.outputs, "project_scope");
  return {
    project: detail.projectSummary,
    projectFieldContract: buildProjectFieldContractSummary(detail.project),
    routeNodes: detail.routeNodes,
    tasks: detail.tasks,
    reviews: detail.reviews,
    experiments,
    experimentRuns,
    literatures,
    resultItems,
    findings,
    outputCandidates,
    outputGaps,
    outputs,
    level4RelationIndex: detail.level4RelationIndex,
    level4RelationIndexExclusions: detail.level4RelationIndexExclusions,
    taskStats: detail.taskStats,
    routineSummary,
    researchProgressSummary: buildResearchProgressSummary(
      detail.taskStats,
      experiments,
      literatures,
      findings,
      outputCandidates,
      outputGaps
    ),
    linkedEntities: detail.linkedEntities,
    warnings: detail.warnings,
    missingReferences: detail.missingReferences,
    partial: detail.partial
  };
}

export async function getTaskExecutionContext(
  taskId: EntityId
): Promise<TaskExecutionContext | null> {
  const detail = await getTaskDetailContext(taskId);
  if (!detail) {
    return null;
  }

  const outputGaps = outputGapSummariesToEvidence(detail.outputGaps);
  const outputGapWarnings = detail.outputGaps.map((gap) => gap.warning);

  return {
    task: detail.taskSummary,
    project: detail.project,
    routeNode: detail.routeNode,
    experiments: summariesToEvidence(detail.experiments, "task_scope"),
    experimentRuns: summariesToEvidence(detail.experimentRuns, "task_scope"),
    resultMetrics: summariesToEvidence(detail.resultMetrics, "task_scope"),
    fileRefs: summariesToEvidence(detail.fileRefs, "task_scope"),
    literatures: summariesToEvidence(detail.literatures, "task_scope"),
    resultItems: summariesToEvidence(detail.resultItems, "task_scope"),
    findings: summariesToEvidence(detail.findings, "task_scope"),
    outputCandidates: summariesToEvidence(detail.outputCandidates, "task_scope"),
    outputGaps,
    outputs: summariesToEvidence(detail.outputs, "task_scope"),
    sourceOutputGaps: outputGaps,
    partiallyResolvedOutputGaps: uniqueEvidenceSummaries(
      detail.outputGaps
        .filter((gap) => gap.status === "task_created" || gap.status === "route_feedback_created")
        .map(outputGapSummaryToEvidence)
    ),
    resolvedOutputGaps: uniqueEvidenceSummaries(
      detail.outputGaps
        .filter((gap) => gap.status === "resolved")
        .map(outputGapSummaryToEvidence)
    ),
    checkpointSummary: detail.checkpointSummary,
    linkedEntities: [...detail.linkedEntities, ...detail.backReferences],
    warnings: uniqueStrings([...detail.warnings, ...outputGapWarnings]),
    missingReferences: detail.missingReferences,
    partial: detail.partial
  };
}

export async function getReviewAggregationContext(
  reviewId: EntityId
): Promise<ReviewAggregationContext | null> {
  const basic = await getReviewBasicContext(reviewId);
  if (!basic) {
    return null;
  }

  const [projectDetail, projectTasks, projectResearch] = await Promise.all([
    getProjectDetailContext(basic.review.projectId),
    planningService.queryTasks({
      projectId: basic.review.projectId,
      includeArchived: true
    }),
    getProjectResearchContext(basic.review.projectId)
  ]);
  const periodOptions = reviewPeriodOptions(basic.review);
  const hasPeriod = hasDateRange(periodOptions);
  const targetRouteNodeIds = targetSummariesByType(basic.targets, "routeNode").map(
    (target) => target.entityId
  );
  const targetTaskIds = targetSummariesByType(basic.targets, "task").map(
    (target) => target.entityId
  );
  const routeNodeIds = new Set(targetRouteNodeIds);
  const explicitTaskIds = new Set(targetTaskIds);
  const periodScopedProjectTasks = hasPeriod
    ? projectTasks.filter((task) => taskInPeriod(task, periodOptions))
    : projectTasks;
  const scopedProjectTasks = periodScopedProjectTasks.filter(
    (task) =>
      routeNodeIds.size === 0 ||
      (task.routeNodeId !== undefined && routeNodeIds.has(task.routeNodeId))
  );
  const aggregationTaskIds =
    explicitTaskIds.size > 0
      ? [...explicitTaskIds]
      : scopedProjectTasks.map((task) => task.id);
  const aggregationTaskIdSet = new Set(aggregationTaskIds);
  const relatedTaskEntities = projectTasks.filter((task) => aggregationTaskIdSet.has(task.id));
  const [relatedTaskSummaries, taskExecutionContexts] = await Promise.all([
    summarizeIds("task", aggregationTaskIds),
    Promise.all(aggregationTaskIds.map((taskId) => getTaskExecutionContext(taskId)))
  ]);
  const taskContexts = taskExecutionContexts.filter(
    (context): context is TaskExecutionContext => Boolean(context)
  );
  const completedTasks = relatedTaskEntities.filter((task) => task.status === "done");
  const postponedTasks = relatedTaskEntities.filter((task) => task.status === "delayed");
  const activeTasks = relatedTaskEntities.filter(
    (task) =>
      task.status !== "done" &&
      task.status !== "cancelled" &&
      task.status !== "archived" &&
      task.status !== "delayed"
  );
  const [completedTaskSummaries, activeTaskSummaries, postponedTaskSummaries] =
    await Promise.all([
      summarizeIds("task", completedTasks.map((task) => task.id)),
      summarizeIds("task", activeTasks.map((task) => task.id)),
      summarizeIds("task", postponedTasks.map((task) => task.id))
    ]);
  const linkedExperiments = uniqueEvidenceSummaries([
    ...linkedCounterpartEvidence(basic.linkedEntities, "review", reviewId, "experiment"),
    ...linkedCounterpartEvidence(basic.linkedEntities, "review", reviewId, "experimentSummary")
  ]);
  const experiments = uniqueEvidenceSummaries([
    ...summariesToEvidence(basic.experiments, "review_related"),
    ...linkedExperiments,
    ...taskContexts.flatMap((context) => context.experiments),
    ...(basic.scope === "project" ? projectResearch?.experiments ?? [] : []),
    ...summariesToEvidence(
      filterSummariesByType(collectCounterpartSummaries(basic.linkedEntities, "review", reviewId), "experiment"),
      "review_target"
    )
  ]);
  const literatures = uniqueEvidenceSummaries([
    ...linkedCounterpartEvidence(basic.linkedEntities, "review", reviewId, "literature"),
    ...taskContexts.flatMap((context) => context.literatures),
    ...(basic.scope === "project" ? projectResearch?.literatures ?? [] : [])
  ]);
  const resultItems = uniqueEvidenceSummaries([
    ...linkedCounterpartEvidence(basic.linkedEntities, "review", reviewId, "resultItem"),
    ...taskContexts.flatMap((context) => context.resultItems),
    ...(basic.scope === "project" ? projectResearch?.resultItems ?? [] : [])
  ]);
  const findings = uniqueEvidenceSummaries([
    ...linkedCounterpartEvidence(basic.linkedEntities, "review", reviewId, "finding"),
    ...taskContexts.flatMap((context) => context.findings),
    ...(basic.scope === "project" ? projectResearch?.findings ?? [] : [])
  ]);
  const outputCandidates = uniqueEvidenceSummaries([
    ...linkedCounterpartEvidence(basic.linkedEntities, "review", reviewId, "outputCandidate"),
    ...taskContexts.flatMap((context) => context.outputCandidates),
    ...(basic.scope === "project" ? projectResearch?.outputCandidates ?? [] : [])
  ]);
  const outputGaps = uniqueEvidenceSummaries([
    ...linkedCounterpartEvidence(basic.linkedEntities, "review", reviewId, "outputGap"),
    ...taskContexts.flatMap((context) => context.outputGaps),
    ...(basic.scope === "project" ? projectResearch?.outputGaps ?? [] : [])
  ]);
  const outputs = uniqueEvidenceSummaries([
    ...summariesToEvidence(basic.outputs, "review_related"),
    ...linkedCounterpartEvidence(basic.linkedEntities, "review", reviewId, "output"),
    ...taskContexts.flatMap((context) => context.outputs),
    ...(basic.scope === "project" ? projectResearch?.outputs ?? [] : [])
  ]);
  const warnings = [
    ...basic.warnings,
    ...(explicitTaskIds.size === 0
      ? [
          "Review has no explicit task targets; project or route scoped tasks were used for read-only aggregation."
        ]
      : []),
    ...(hasPeriod
      ? [
          "Review aggregation applied periodStart / periodEnd to inferred task scope; explicit task targets are kept even if outside the period."
        ]
      : []),
    ...(projectDetail ? projectDetail.warnings : ["ProjectDetailContext could not be resolved."]),
    ...(projectResearch?.warnings ?? []),
    ...taskContexts.flatMap((context) => context.warnings)
  ];
  const missingReferences = uniqueMissingReferences([
    ...basic.missingReferences,
    ...(projectDetail?.missingReferences ?? []),
    ...(projectResearch?.missingReferences ?? []),
    ...taskContexts.flatMap((context) => context.missingReferences)
  ]);
  const pendingTaskSummaries = uniqueSummaries([...activeTaskSummaries, ...postponedTaskSummaries]);
  const partialContext = {
    relatedTasks: uniqueSummaries([...basic.tasks, ...relatedTaskSummaries]),
    completedTasks: completedTaskSummaries,
    pendingTasks: pendingTaskSummaries,
    activeTasks: activeTaskSummaries,
    postponedTasks: postponedTaskSummaries,
    experiments,
    literatures,
    resultItems,
    findings,
    outputCandidates,
    outputGaps,
    outputs
  };
  const normalizedWarnings = uniqueStrings(warnings);
  const aggregationPartial =
    missingReferences.length > 0 ||
    normalizedWarnings.length > 0 ||
    basic.partial ||
    Boolean(projectDetail?.partial) ||
    Boolean(projectResearch?.partial) ||
    taskContexts.some((context) => context.partial);
  const hasExistingContent = basic.outlineSections.some((section) => section.content.trim());
  const taskEvidence = partialContext.relatedTasks.map((task) =>
    createReviewTaskEvidence(task, explicitTaskIds)
  );
  const experimentEvidence = experiments.map(createReviewExperimentEvidence);
  const literatureEvidence = literatures.map(createReviewLiteratureEvidence);
  const derivedOutputEvidence = [
    ...resultItems,
    ...findings,
    ...outputCandidates,
    ...outputGaps,
    ...outputs
  ].map(createReviewDerivedOutputEvidence);
  const outputEvidence = [
    ...resultItems,
    ...findings,
    ...outputCandidates,
    ...outputGaps,
    ...outputs
  ].map(createReviewOutputEvidence);
  const indirectEvidence = [
    ...taskEvidence.filter(
      (item): item is ReviewTaskEvidence & { sourceKind: "indirect_cross_module_evidence" } =>
        item.sourceKind === "indirect_cross_module_evidence"
    ),
    ...experimentEvidence,
    ...literatureEvidence
  ].map((item) => ({
    ...item,
    sourceKind: "indirect_cross_module_evidence" as const,
    role:
      item.role === "warning" || item.role === "missing" ? item.role : ("contextual" as const),
    relationType: item.evidence?.relationType
  }));
  const partialReasons = uniqueStrings([
    aggregationPartial ? "upstream_warning_or_partial_context" : undefined,
    missingReferences.length > 0 ? "missing_reference" : undefined,
    hasPeriod ? "period_membership_not_finalized" : undefined,
    explicitTaskIds.size === 0 ? "inferred_task_scope" : undefined,
    basic.scope === "project" ? "project_level_contextual_evidence" : undefined
  ]);
  const limitations: ReviewEvidenceLimitations[] = [
    ...(missingReferences.length > 0
      ? [
          {
            code: "missing_reference" as const,
            message:
              "Some linked Review evidence references are missing or unsupported; evidenceContext keeps them as partial."
          }
        ]
      : []),
    ...(hasPeriod
      ? [
          {
            code: "period_membership_not_finalized" as const,
            message:
              "Single Review aggregation records the period boundary and applies it to inferred tasks only; period-wide evidence closure remains UI-8-5.",
            sourceKind: "period_evidence" as const
          }
        ]
      : []),
    ...(basic.scope === "project"
      ? [
          {
            code: "indirect_evidence_not_expanded" as const,
            message:
              "Project-overview Review evidence can include project-level contextual summaries that are not direct Review targets.",
            sourceKind: "indirect_cross_module_evidence" as const
          }
        ]
      : []),
    ...(derivedOutputEvidence.some((item) => item.partial)
      ? [
          {
            code: "derived_chain_not_expanded" as const,
            message:
              "Derived output evidence is represented as chain-stage summaries; UI-8-4 does not expand full output provenance chains.",
            sourceKind: "derived_output_evidence" as const
          }
        ]
      : [])
  ];
  const evidenceContext = createReviewEvidenceContext({
    scopeSummary: buildReviewScopeSummary(basic.review, basic.targets),
    directTargetEvidence: classifyReviewTargetEvidence(basic.targets),
    periodEvidence: createReviewPeriodEvidence(basic.period),
    indirectEvidence,
    derivedOutputEvidence,
    existingReviewContentEvidence: createExistingReviewContentEvidence(
      basic.reviewSummary,
      hasExistingContent
    ),
    taskEvidence,
    experimentEvidence,
    literatureEvidence,
    outputEvidence,
    warnings: normalizedWarnings,
    missingReferences,
    partial:
      aggregationPartial ||
      partialReasons.length > 0 ||
      taskEvidence.some((item) => item.partial) ||
      experimentEvidence.some((item) => item.partial) ||
      literatureEvidence.some((item) => item.partial) ||
      derivedOutputEvidence.some((item) => item.partial),
    partialReasons,
    limitations
  });

  return {
    review: basic.reviewSummary,
    scope: basic.scope,
    period: basic.period,
    targets: basic.targets,
    project: basic.project,
    routeNodes: uniqueSummaries([
      ...basic.routeNodes,
      ...targetSummariesByType(basic.targets, "routeNode")
    ]),
    ...partialContext,
    existingReviewContent: {
      outlineSections: basic.outlineSections
    },
    aggregationStats: buildReviewAggregationStats(partialContext),
    routineSummary: projectResearch?.routineSummary,
    linkedEntities: basic.linkedEntities,
    evidenceContext,
    warnings: normalizedWarnings,
    missingReferences,
    partial: aggregationPartial || evidenceContext.partial
  };
}

export async function getReviewPeriodContext(
  options: ReviewPeriodContextOptions = {}
): Promise<ReviewPeriodContext> {
  const routeNode = options.routeNodeId
    ? await planningService.getRouteNodeById(options.routeNodeId)
    : undefined;
  const projectId = options.projectId ?? routeNode?.projectId;
  const [projectSummary, routeNodeSummary, reviews, tasks, projectResearch] = await Promise.all([
    projectId
      ? entityContextService.getEntityTargetSummary("project", projectId)
      : Promise.resolve(null),
    options.routeNodeId
      ? entityContextService.getEntityTargetSummary("routeNode", options.routeNodeId)
      : Promise.resolve(null),
    planningService.queryReviews({
      projectId,
      includeArchived: options.includeArchived
    }),
    planningService.queryTasks({
      projectId,
      includeArchived: options.includeArchived
    }),
    projectId ? getProjectResearchContext(projectId) : Promise.resolve(null)
  ]);
  const reviewTargetPairs = await Promise.all(
    reviews.map(async (review) => [review.id, await planningService.queryReviewTargets(review.id)] as const)
  );
  const reviewTargetsById = new Map(reviewTargetPairs);
  const scopedReviews = reviews.filter(
    (review) =>
      (!options.routeNodeId ||
        reviewTargetsById
          .get(review.id)
          ?.some(
            (target) =>
              target.targetType === "routeNode" && target.targetId === options.routeNodeId
          )) &&
      reviewInPeriod(review, options)
  );
  const scopedTasks = tasks.filter(
    (task) =>
      (!options.routeNodeId || task.routeNodeId === options.routeNodeId) &&
      taskInPeriod(task, options)
  );
  const completedTasks = scopedTasks.filter((task) => task.status === "done");
  const [reviewSummaries, taskSummaries, completedTaskSummaries] = await Promise.all([
    summarizeIds("review", scopedReviews.map((review) => review.id)),
    summarizeIds("task", scopedTasks.map((task) => task.id)),
    summarizeIds("task", completedTasks.map((task) => task.id))
  ]);
  const filterPeriodEvidence = (summaries: EvidenceSummary[]) =>
    uniqueEvidenceSummaries(summaries.filter((summary) => evidenceInPeriod(summary, options)));
  const experiments = filterPeriodEvidence(projectResearch?.experiments ?? []);
  const experimentRuns = filterPeriodEvidence(projectResearch?.experimentRuns ?? []);
  const literatures = filterPeriodEvidence(projectResearch?.literatures ?? []);
  const resultItems = filterPeriodEvidence(projectResearch?.resultItems ?? []);
  const findings = filterPeriodEvidence(projectResearch?.findings ?? []);
  const outputCandidates = filterPeriodEvidence(projectResearch?.outputCandidates ?? []);
  const outputGaps = filterPeriodEvidence(projectResearch?.outputGaps ?? []);
  const outputs = filterPeriodEvidence(projectResearch?.outputs ?? []);
  const stats: ReviewPeriodStats = {
    reviewCount: reviewSummaries.length,
    taskCount: taskSummaries.length,
    completedTaskCount: completedTaskSummaries.length,
    experimentCount: experiments.length,
    literatureCount: literatures.length,
    findingCount: findings.length,
    outputCandidateCount: outputCandidates.length,
    outputGapCount: outputGaps.length,
    unresolvedOutputGapCount: outputGaps.filter(isUnresolvedOutputGap).length,
    partiallyResolvedOutputGapCount: outputGaps.filter(isPartiallyResolvedOutputGap).length,
    resolvedOutputGapCount: outputGaps.filter(isResolvedOutputGap).length,
    outputCount: outputs.length
  };
  const boundaryMissingReferences = uniqueMissingReferences([
    ...(projectSummary && !projectSummary.sourceAvailable
      ? [
          {
            targetType: "project",
            targetId: projectSummary.entityId,
            reason: "target_not_found" as const,
            message: projectSummary.missingReason
          }
        ]
      : []),
    ...(routeNodeSummary && !routeNodeSummary.sourceAvailable
      ? [
          {
            targetType: "routeNode",
            targetId: routeNodeSummary.entityId,
            reason: "target_not_found" as const,
            message: routeNodeSummary.missingReason
          }
        ]
      : [])
  ]);
  const missingReferences = uniqueMissingReferences([
    ...(projectResearch?.missingReferences ?? []),
    ...boundaryMissingReferences
  ]);
  const routeUsesProjectLevelCrossModuleSummary = Boolean(options.routeNodeId && projectResearch);
  const periodMembershipPartial = !hasDateRange(options);
  const projectLevelEvidence = [
    ...experiments,
    ...experimentRuns,
    ...literatures,
    ...resultItems,
    ...findings,
    ...outputCandidates,
    ...outputGaps,
    ...outputs
  ];
  const hasProjectLevelEvidence = projectLevelEvidence.length > 0;
  const normalizedWarnings = uniqueStrings([
    ...(projectResearch?.warnings ?? []),
    !projectId ? "ReviewPeriodContext has no projectId; cross-module evidence is unavailable." : undefined,
    projectSummary && !projectSummary.sourceAvailable
      ? `ReviewPeriodContext project boundary is missing: ${projectSummary.entityId}.`
      : undefined,
    routeNodeSummary && !routeNodeSummary.sourceAvailable
      ? `ReviewPeriodContext routeNode boundary is missing: ${routeNodeSummary.entityId}.`
      : undefined,
    options.routeNodeId
      ? "Route-node period context filters planning tasks and reviews by routeNodeId; cross-module evidence currently uses project-level summaries."
      : undefined,
    hasDateRange(options)
      ? "Period filtering uses available createdAt, updatedAt, completedAt, periodStart and periodEnd fields; module-specific readingDate or runDate support can be refined later."
      : "ReviewPeriodContext has no explicit date range; period evidence represents the available project or route scope rather than a closed period."
  ]);
  const topLevelPartial =
    missingReferences.length > 0 ||
    Boolean(projectResearch?.partial) ||
    routeUsesProjectLevelCrossModuleSummary ||
    periodMembershipPartial;
  const directTargetEvidence: ReviewDirectTargetEvidence[] = [
    ...(projectSummary ? [createPeriodScopeBoundaryEvidence(projectSummary, "project")] : []),
    ...(routeNodeSummary ? [createPeriodScopeBoundaryEvidence(routeNodeSummary, "routeNode")] : [])
  ];
  const periodEvidence: ReviewPeriodEvidence[] = [
    ...reviewSummaries.map((summary) =>
      createPeriodEntityEvidence(
        summary,
        options,
        "Review is included because it matches the period Review aggregation filters."
      )
    ),
    ...taskSummaries.map((summary) =>
      createPeriodEntityEvidence(
        summary,
        options,
        "Task is included because it matches the period Review aggregation filters.",
        ["task_boundary"]
      )
    ),
    ...experiments.map((evidence) =>
      createPeriodSummaryEvidence(
        evidence,
        options,
        "Experiment evidence is included because its available summary dates match the period filter.",
        evidence.relationType === "project_scope" || routeUsesProjectLevelCrossModuleSummary
      )
    ),
    ...experimentRuns.map((evidence) =>
      createPeriodSummaryEvidence(
        evidence,
        options,
        "Experiment run evidence is included because its available summary dates match the period filter.",
        evidence.relationType === "project_scope" || routeUsesProjectLevelCrossModuleSummary
      )
    ),
    ...literatures.map((evidence) =>
      createPeriodSummaryEvidence(
        evidence,
        options,
        "Literature evidence is included because its available summary dates match the period filter.",
        evidence.relationType === "project_scope" || routeUsesProjectLevelCrossModuleSummary
      )
    ),
    ...resultItems.map((evidence) =>
      createPeriodSummaryEvidence(
        evidence,
        options,
        "ResultItem evidence is included because its available summary dates match the period filter.",
        true
      )
    ),
    ...findings.map((evidence) =>
      createPeriodSummaryEvidence(
        evidence,
        options,
        "Finding evidence is included because its available summary dates match the period filter.",
        true
      )
    ),
    ...outputCandidates.map((evidence) =>
      createPeriodSummaryEvidence(
        evidence,
        options,
        "OutputCandidate evidence is included because its available summary dates match the period filter.",
        true
      )
    ),
    ...outputGaps.map((evidence) =>
      createPeriodSummaryEvidence(
        evidence,
        options,
        "OutputGap evidence is included because its available summary dates match the period filter.",
        true
      )
    ),
    ...outputs.map((evidence) =>
      createPeriodSummaryEvidence(
        evidence,
        options,
        "ResearchOutput evidence is included because its available summary dates match the period filter.",
        true
      )
    )
  ];
  const taskEvidence = taskSummaries.map(createPeriodTaskEvidence);
  const experimentEvidence = [...experiments, ...experimentRuns].map((evidence) =>
    markPeriodEvidencePartial(
      createReviewExperimentEvidence(evidence),
      routeUsesProjectLevelCrossModuleSummary
    )
  );
  const literatureEvidence = literatures.map((evidence) =>
    markPeriodEvidencePartial(
      createReviewLiteratureEvidence(evidence),
      routeUsesProjectLevelCrossModuleSummary
    )
  );
  const derivedOutputEvidence = [
    ...resultItems,
    ...findings,
    ...outputCandidates,
    ...outputGaps,
    ...outputs
  ].map((evidence) =>
    markPeriodEvidencePartial(
      createReviewDerivedOutputEvidence(evidence),
      routeUsesProjectLevelCrossModuleSummary || evidence.relationType === "project_scope"
    )
  );
  const outputEvidence = [
    ...resultItems,
    ...findings,
    ...outputCandidates,
    ...outputGaps,
    ...outputs
  ].map((evidence) =>
    markPeriodEvidencePartial(
      createReviewOutputEvidence(evidence),
      routeUsesProjectLevelCrossModuleSummary || evidence.relationType === "project_scope"
    )
  );
  const indirectEvidence = [...experimentEvidence, ...literatureEvidence].map((item) => ({
    ...item,
    sourceKind: "indirect_cross_module_evidence" as const,
    role:
      item.role === "warning" || item.role === "missing" ? item.role : ("supporting" as const),
    relationType: item.evidence?.relationType
  }));
  const partialReasons = uniqueStrings([
    topLevelPartial ? "upstream_warning_or_partial_context" : undefined,
    missingReferences.length > 0 ? "missing_reference" : undefined,
    periodMembershipPartial ? "period_membership_not_finalized" : undefined,
    routeUsesProjectLevelCrossModuleSummary ? "route_scope_uses_project_level_summary" : undefined,
    hasProjectLevelEvidence ? "project_level_contextual_evidence" : undefined,
    derivedOutputEvidence.length > 0 ? "derived_output_summary_only" : undefined
  ]);
  const limitations: ReviewEvidenceLimitations[] = [
    ...(missingReferences.length > 0
      ? [
          {
            code: "missing_reference" as const,
            message:
              "ReviewPeriodContext inherited missing or unsupported references; evidenceContext keeps the period aggregation partial."
          }
        ]
      : []),
    ...(periodMembershipPartial
      ? [
          {
            code: "period_membership_not_finalized" as const,
            message:
              "No explicit startDate / endDate was supplied, so period evidence is scoped by available project or route records rather than a closed date range.",
            sourceKind: "period_evidence" as const
          }
        ]
      : []),
    ...(hasDateRange(options)
      ? [
          {
            code: "period_membership_not_finalized" as const,
            message:
              "Period membership is based on available createdAt, updatedAt, completedAt, periodStart and periodEnd fields; module-specific date fields can be refined later.",
            sourceKind: "period_evidence" as const
          }
        ]
      : []),
    ...(routeUsesProjectLevelCrossModuleSummary
      ? [
          {
            code: "indirect_evidence_not_expanded" as const,
            message:
              "Route-node period context route-filters planning tasks and reviews, but cross-module evidence still comes from project-level summaries and is therefore partial.",
            sourceKind: "indirect_cross_module_evidence" as const
          }
        ]
      : []),
    ...(hasProjectLevelEvidence
      ? [
          {
            code: "indirect_evidence_not_expanded" as const,
            message:
              "Cross-module period evidence is consumed from existing project research summaries instead of new module-specific period queries.",
            sourceKind: "indirect_cross_module_evidence" as const
          }
        ]
      : []),
    ...(derivedOutputEvidence.length > 0
      ? [
          {
            code: "derived_chain_not_expanded" as const,
            message:
              "Derived output period evidence is represented as ResultItem / Finding / OutputCandidate / OutputGap / ResearchOutput summaries, not as full provenance expansion.",
            sourceKind: "derived_output_evidence" as const
          }
        ]
      : [])
  ];
  const evidenceContext = createReviewEvidenceContext({
    scopeSummary: createPeriodReviewScopeSummary({
      projectId,
      routeNodeId: options.routeNodeId,
      startDate: options.startDate,
      endDate: options.endDate
    }),
    directTargetEvidence,
    periodEvidence,
    indirectEvidence,
    derivedOutputEvidence,
    taskEvidence,
    experimentEvidence,
    literatureEvidence,
    outputEvidence,
    warnings: normalizedWarnings,
    missingReferences,
    partial:
      topLevelPartial ||
      partialReasons.length > 0 ||
      directTargetEvidence.some((item) => item.partial) ||
      periodEvidence.some((item) => item.partial) ||
      indirectEvidence.some((item) => item.partial) ||
      derivedOutputEvidence.some((item) => item.partial),
    partialReasons,
    limitations
  });

  return {
    options,
    project: projectSummary?.sourceAvailable ? projectSummary : null,
    routeNode: routeNodeSummary?.sourceAvailable ? routeNodeSummary : null,
    reviews: reviewSummaries,
    tasks: taskSummaries,
    completedTasks: completedTaskSummaries,
    experiments,
    experimentRuns,
    literatures,
    resultItems,
    findings,
    outputCandidates,
    outputGaps,
    outputs,
    stats,
    evidenceContext,
    warnings: normalizedWarnings,
    missingReferences,
    partial: topLevelPartial || evidenceContext.partial
  };
}

export const planningSelectorService = {
  getProjectDetailContext,
  getProjectOverviewContext,
  getTaskDetailContext,
  getReviewBasicContext,
  getOutputGapTaskSummary,
  getTaskOutputGapSummaries,
  getRouteNodeOutputGapSummaries,
  getRouteCheckpointProgressSummary,
  getRouteCheckpointProgressSummaries,
  getTaskCheckpointProgressSummary,
  getTaskCheckpointProgressSummaries,
  getRoutineCurrentPeriodSummary,
  getRoutineCurrentPeriodSummaries,
  getProjectRoutineSummary,
  getRouteNodeTaskSummary,
  getRouteNodeTaskSummaries,
  getOutputGapRouteNodeSummaries,
  getOutputGapClosureContext,
  getProjectResearchContext,
  getTaskExecutionContext,
  getReviewAggregationContext,
  getReviewPeriodContext
};

export type PlanningSelectorService = typeof planningSelectorService;
