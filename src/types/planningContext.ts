import type { EntityId } from "./common";
import type { EntitySummary, EvidenceSummary, LinkedEntitySummary } from "./entityContext";
import type { MissingEntityReference } from "./entityReference";
import type {
  Project,
  Review,
  ReviewOutlineSection,
  RouteCheckpoint,
  RouteCheckpointStatus,
  RouteNode,
  ResearchRoutine,
  RoutineCheckIn,
  RoutineFrequency,
  RoutineTargetType,
  TaskCheckpoint,
  TaskCheckpointStatus,
  Task,
  TaskStatus
} from "./planning";

export type ReviewContextScope = "project" | "route" | "task" | "mixed";

export interface PlanningTaskStats {
  total: number;
  completed: number;
  archived: number;
  unscheduled: number;
  blocked: number;
  delayed: number;
  open: number;
}

export interface ProjectCrossModuleSummary {
  experiments: EntitySummary[];
  experimentRuns: EntitySummary[];
  resultMetrics: EntitySummary[];
  fileRefs: EntitySummary[];
  literatures: EntitySummary[];
  resultItems: EntitySummary[];
  findings: EntitySummary[];
  outputCandidates: EntitySummary[];
  outputGaps: EntitySummary[];
  outputs: EntitySummary[];
  other: EntitySummary[];
}

/**
 * Safe, ephemeral project-member projection used by the single AI Context Builder.
 * It intentionally cannot represent entity bodies, file paths, or inferred relations.
 */
export type ProjectLevel4ObjectType =
  | "route"
  | "task"
  | "review"
  | "experiment"
  | "experimentRun"
  | "literature"
  | "resultItem"
  | "finding"
  | "outputCandidate"
  | "outputGap"
  | "researchOutput";

export interface ProjectLevel4RelationKey {
  relationType: string;
  targetType: ProjectLevel4ObjectType;
  targetId: EntityId;
}

export interface ProjectLevel4RelationIndexEntry {
  objectType: ProjectLevel4ObjectType;
  canonicalId: EntityId;
  projectId: EntityId;
  safeLabel: string;
  safeSummary?: string;
  status?: string;
  relationKeys: ProjectLevel4RelationKey[];
  membershipSource:
    | "direct_project_id"
    | "experiment_parent_and_run_project_id"
    | "primary_project_id";
  relationSource: "canonical_direct_fields" | "none";
}

export interface ProjectLevel4RelationIndexExclusion {
  objectType: ProjectLevel4ObjectType;
  reason:
    | "canonical_source_unavailable"
    | "ineligible_lifecycle"
    | "membership_mismatch"
    | "no_confirmed_project_membership";
  count: number;
}

export interface ProjectDetailContext {
  project: Project;
  projectSummary: EntitySummary;
  routeNodes: EntitySummary[];
  tasks: EntitySummary[];
  reviews: EntitySummary[];
  linkedEntities: LinkedEntitySummary[];
  crossModule: ProjectCrossModuleSummary;
  level4RelationIndex: ProjectLevel4RelationIndexEntry[];
  level4RelationIndexExclusions: ProjectLevel4RelationIndexExclusion[];
  taskStats: PlanningTaskStats;
  warnings: string[];
  missingReferences: MissingEntityReference[];
  partial: boolean;
}

export interface OutputGapTaskSummary {
  outputGap: EntitySummary;
  tasks: EntitySummary[];
  relationSummaries: LinkedEntitySummary[];
  relationSource: "entityLink" | "relatedTaskIdFallback" | "mixed" | "none";
  status?: string;
  priority?: string;
  warning?: string;
}

export interface RouteNodeOutputGapSummary {
  outputGapId: EntityId;
  title: string;
  status?: string;
  priority?: string;
  gapType?: string;
  severity?: string;
  sourceCandidateId?: EntityId;
  sourceFindingId?: EntityId;
  relationType?: string;
  linkedAt?: string;
  outputGap: EntitySummary;
  relationSummary?: LinkedEntitySummary;
}

export interface RouteNodeOutputGapSummaries {
  routeNodeId: EntityId;
  outputGaps: RouteNodeOutputGapSummary[];
}

export interface RouteCheckpointProgressSummary {
  routeNodeId: EntityId;
  total: number;
  completed: number;
  active: number;
  blocked: number;
  abandoned: number;
  planned: number;
  completionRate: number;
  currentCheckpoint?: RouteCheckpoint;
  latestFeedback?: RouteCheckpoint;
  statusCounts: Record<RouteCheckpointStatus, number>;
}

export interface TaskCheckpointProgressSummary {
  taskId: EntityId;
  total: number;
  completed: number;
  active: number;
  blocked: number;
  abandoned: number;
  planned: number;
  effectiveTotal: number;
  completionRate: number;
  currentCheckpoint?: TaskCheckpoint;
  latestFeedback?: TaskCheckpoint;
  statusCounts: Record<TaskCheckpointStatus, number>;
}

export interface RoutineCurrentPeriodSummary {
  routineId: EntityId;
  projectId?: EntityId;
  title: string;
  frequency: RoutineFrequency;
  targetType: RoutineTargetType;
  targetCount?: number;
  targetDescription?: string;
  periodKey: string;
  periodStart: string;
  periodEnd: string;
  checkInCount: number;
  totalCount: number;
  completionRate: number;
  isCompleted: boolean;
  latestCheckIn?: RoutineCheckIn;
  routine: ResearchRoutine;
}

export interface ProjectRoutineSummary {
  projectId: EntityId;
  activeRoutineCount: number;
  currentPeriodRoutineCount: number;
  currentPeriodCompletedCount: number;
  currentPeriodCompletionRate: number;
  summaries: RoutineCurrentPeriodSummary[];
}

export interface RouteNodeTaskSummary {
  routeNodeId: EntityId;
  total: number;
  completed: number;
  active: number;
  blocked: number;
  delayed: number;
  cancelled: number;
  planned: number;
  archived: number;
  statusCounts: Record<TaskStatus, number>;
}

export interface OutputGapRouteNodeSummary {
  routeNodeId: EntityId;
  title: string;
  status?: string;
  relationType?: string;
  linkedAt?: string;
  routeNode: EntitySummary;
  relationSummary?: LinkedEntitySummary;
}

export interface OutputGapRouteNodeSummaries {
  outputGapId: EntityId;
  routeNodes: OutputGapRouteNodeSummary[];
}

export interface TaskDetailContext {
  task: Task;
  taskSummary: EntitySummary;
  project: EntitySummary | null;
  routeNode: EntitySummary | null;
  linkedEntities: LinkedEntitySummary[];
  backReferences: LinkedEntitySummary[];
  experiments: EntitySummary[];
  experimentRuns: EntitySummary[];
  resultMetrics: EntitySummary[];
  fileRefs: EntitySummary[];
  literatures: EntitySummary[];
  resultItems: EntitySummary[];
  findings: EntitySummary[];
  outputCandidates: EntitySummary[];
  outputGaps: OutputGapTaskSummary[];
  checkpointSummary?: TaskCheckpointProgressSummary;
  outputs: EntitySummary[];
  warnings: string[];
  missingReferences: MissingEntityReference[];
  partial: boolean;
}

export interface ReviewBasicContext {
  review: Review;
  scope: ReviewContextScope;
  period: {
    start?: string;
    end?: string;
    label?: string;
  };
  reviewSummary: EntitySummary;
  project: EntitySummary | null;
  routeNodes: EntitySummary[];
  tasks: EntitySummary[];
  experiments: EntitySummary[];
  outputs: EntitySummary[];
  targets: LinkedEntitySummary[];
  linkedEntities: LinkedEntitySummary[];
  outlineSections: ReviewOutlineSection[];
  warnings: string[];
  missingReferences: MissingEntityReference[];
  partial: boolean;
}

export interface TaskOutputGapSummaries {
  taskId: EntityId;
  outputGaps: OutputGapTaskSummary[];
}

export interface ResearchProgressSummary {
  completedTaskCount: number;
  experimentEvidenceCount: number;
  literatureEvidenceCount: number;
  findingCount: number;
  outputCandidateCount: number;
  unresolvedOutputGapCount: number;
  partiallyResolvedOutputGapCount: number;
  resolvedOutputGapCount: number;
}

export interface ProjectFieldContractSummary {
  methodSummary?: string;
  expectedOutputs?: string;
}

export interface ProjectResearchContext {
  project: EntitySummary;
  projectFieldContract: ProjectFieldContractSummary;
  routeNodes: EntitySummary[];
  tasks: EntitySummary[];
  reviews: EntitySummary[];
  experiments: EvidenceSummary[];
  experimentRuns: EvidenceSummary[];
  literatures: EvidenceSummary[];
  resultItems: EvidenceSummary[];
  findings: EvidenceSummary[];
  outputCandidates: EvidenceSummary[];
  outputGaps: EvidenceSummary[];
  outputs: EvidenceSummary[];
  level4RelationIndex: ProjectLevel4RelationIndexEntry[];
  level4RelationIndexExclusions: ProjectLevel4RelationIndexExclusion[];
  taskStats: PlanningTaskStats;
  routineSummary?: ProjectRoutineSummary;
  researchProgressSummary: ResearchProgressSummary;
  linkedEntities: LinkedEntitySummary[];
  warnings: string[];
  missingReferences: MissingEntityReference[];
  partial: boolean;
}

export interface TaskExecutionContext {
  task: EntitySummary;
  project: EntitySummary | null;
  routeNode: EntitySummary | null;
  experiments: EvidenceSummary[];
  experimentRuns: EvidenceSummary[];
  resultMetrics: EvidenceSummary[];
  fileRefs: EvidenceSummary[];
  literatures: EvidenceSummary[];
  resultItems: EvidenceSummary[];
  findings: EvidenceSummary[];
  outputCandidates: EvidenceSummary[];
  outputGaps: EvidenceSummary[];
  outputs: EvidenceSummary[];
  sourceOutputGaps: EvidenceSummary[];
  partiallyResolvedOutputGaps: EvidenceSummary[];
  resolvedOutputGaps: EvidenceSummary[];
  checkpointSummary?: TaskCheckpointProgressSummary;
  linkedEntities: LinkedEntitySummary[];
  warnings: string[];
  missingReferences: MissingEntityReference[];
  partial: boolean;
}

export interface OutputGapClosureContext {
  outputGap: EntitySummary;
  status?: string;
  tasks: EntitySummary[];
  completedTasks: EntitySummary[];
  activeTasks: EntitySummary[];
  relationSummaries: LinkedEntitySummary[];
  relationSource: OutputGapTaskSummary["relationSource"];
  isResolved: boolean;
  isPartiallyResolved: boolean;
  isUnresolved: boolean;
  warnings: string[];
}

export interface ExistingReviewContentSummary {
  outlineSections: ReviewOutlineSection[];
}

export interface ReviewAggregationStats {
  relatedTaskCount: number;
  completedTaskCount: number;
  activeTaskCount: number;
  postponedTaskCount: number;
  experimentCount: number;
  literatureCount: number;
  resultItemCount: number;
  findingCount: number;
  outputCandidateCount: number;
  outputGapCount: number;
  unresolvedOutputGapCount: number;
  partiallyResolvedOutputGapCount: number;
  resolvedOutputGapCount: number;
  outputCount: number;
}

export type ReviewEvidenceSourceKind =
  | "scope_anchor"
  | "direct_target_evidence"
  | "period_evidence"
  | "indirect_cross_module_evidence"
  | "derived_output_evidence"
  | "existing_review_content"
  | "warning_only";

export type ReviewEvidenceRole =
  | "anchor"
  | "direct"
  | "supporting"
  | "contextual"
  | "derived"
  | "warning"
  | "missing";

export type ReviewEvidenceScopeSensitivity =
  | "scope_anchor"
  | "target_bound"
  | "period_bound"
  | "link_bound"
  | "derived_chain"
  | "project_summary"
  | "project_boundary"
  | "route_boundary"
  | "task_boundary"
  | "warning_only";

export type ReviewEvidenceCategory = "task" | "experiment" | "literature" | "output";

export interface ReviewScopeSummary {
  reviewId?: EntityId;
  projectId?: EntityId;
  scope: ReviewContextScope;
  period: {
    start?: string;
    end?: string;
    label?: string;
  };
  targetProjectIds: EntityId[];
  targetRouteNodeIds: EntityId[];
  targetTaskIds: EntityId[];
  hasExplicitTargets: boolean;
  hasPeriod: boolean;
}

export interface ReviewEvidenceBoundary {
  sourceKinds: ReviewEvidenceSourceKind[];
  scopeSensitivity: ReviewEvidenceScopeSensitivity[];
  sourceBoundary: string;
  excludesLocalFileBodies: boolean;
  excludesPdfFullText: boolean;
  excludesExperimentRawData: boolean;
  aggregationWiringDeferred: boolean;
}

export interface ReviewEvidenceLimitations {
  code:
    | "aggregation_wiring_deferred"
    | "period_membership_not_finalized"
    | "indirect_evidence_not_expanded"
    | "derived_chain_not_expanded"
    | "warning_only"
    | "missing_reference"
    | "scope_boundary_unclear";
  message: string;
  sourceKind?: ReviewEvidenceSourceKind;
}

export interface ReviewEvidenceBase {
  sourceKind: ReviewEvidenceSourceKind;
  role: ReviewEvidenceRole;
  scopeSensitivity: ReviewEvidenceScopeSensitivity[];
  sourceBoundary: string;
  evidence?: EvidenceSummary;
  entity?: EntitySummary;
  link?: LinkedEntitySummary;
  warnings: string[];
  missingReferences: MissingEntityReference[];
  partial: boolean;
}

export interface ReviewDirectTargetEvidence extends ReviewEvidenceBase {
  sourceKind: "scope_anchor" | "direct_target_evidence";
  role: "anchor" | "direct" | "warning" | "missing";
  targetType?: string;
  targetId?: EntityId;
}

export interface ReviewPeriodEvidence extends ReviewEvidenceBase {
  sourceKind: "period_evidence";
  period: {
    start?: string;
    end?: string;
    label?: string;
  };
}

export interface ReviewIndirectEvidence extends ReviewEvidenceBase {
  sourceKind: "indirect_cross_module_evidence";
  role: "supporting" | "contextual" | "warning" | "missing";
  relationType?: string;
}

export interface ReviewDerivedOutputEvidence extends ReviewEvidenceBase {
  sourceKind: "derived_output_evidence";
  role: "derived" | "supporting" | "warning" | "missing";
  derivedChainStage?:
    | "result_item"
    | "finding"
    | "output_candidate"
    | "output_gap"
    | "research_output";
}

export interface ReviewTaskEvidence extends ReviewEvidenceBase {
  category: "task";
}

export interface ReviewExperimentEvidence extends ReviewEvidenceBase {
  category: "experiment";
}

export interface ReviewLiteratureEvidence extends ReviewEvidenceBase {
  category: "literature";
}

export interface ReviewOutputEvidence extends ReviewEvidenceBase {
  category: "output";
}

export interface ReviewEvidenceStats {
  directTargetEvidenceCount: number;
  periodEvidenceCount: number;
  indirectEvidenceCount: number;
  derivedOutputEvidenceCount: number;
  existingReviewContentEvidenceCount: number;
  taskEvidenceCount: number;
  experimentEvidenceCount: number;
  literatureEvidenceCount: number;
  outputEvidenceCount: number;
  warningCount: number;
  missingReferenceCount: number;
  partialEvidenceCount: number;
}

export interface ReviewEvidenceContext {
  scopeSummary: ReviewScopeSummary;
  directTargetEvidence: ReviewDirectTargetEvidence[];
  periodEvidence: ReviewPeriodEvidence[];
  indirectEvidence: ReviewIndirectEvidence[];
  derivedOutputEvidence: ReviewDerivedOutputEvidence[];
  existingReviewContentEvidence: ReviewEvidenceBase[];
  taskEvidence: ReviewTaskEvidence[];
  experimentEvidence: ReviewExperimentEvidence[];
  literatureEvidence: ReviewLiteratureEvidence[];
  outputEvidence: ReviewOutputEvidence[];
  stats: ReviewEvidenceStats;
  boundary: ReviewEvidenceBoundary;
  warnings: string[];
  missingReferences: MissingEntityReference[];
  partial: boolean;
  partialReasons: string[];
  limitations: ReviewEvidenceLimitations[];
}

export type ReviewAiContextKind = "review_aggregation" | "review_period";

export interface ReviewAiEvidenceLine {
  sourceKind: ReviewEvidenceSourceKind;
  role: ReviewEvidenceRole;
  title: string;
  entityType?: string;
  entityId?: EntityId;
  relationType?: string;
  summary?: string;
  sourceBoundary: string;
  scopeSensitivity: ReviewEvidenceScopeSensitivity[];
  warnings: string[];
  missingReferences: MissingEntityReference[];
  partial: boolean;
}

export interface ReviewAiContext {
  kind: ReviewAiContextKind;
  title: string;
  scopeSummary: ReviewScopeSummary;
  evidenceBoundary: ReviewEvidenceBoundary;
  evidenceStats: ReviewEvidenceStats;
  directTargetEvidence: ReviewAiEvidenceLine[];
  periodEvidence: ReviewAiEvidenceLine[];
  indirectCrossModuleEvidence: ReviewAiEvidenceLine[];
  derivedOutputEvidence: ReviewAiEvidenceLine[];
  existingReviewContentEvidence: ReviewAiEvidenceLine[];
  taskEvidence: ReviewAiEvidenceLine[];
  experimentEvidence: ReviewAiEvidenceLine[];
  literatureEvidence: ReviewAiEvidenceLine[];
  outputEvidence: ReviewAiEvidenceLine[];
  warnings: string[];
  missingReferences: MissingEntityReference[];
  partial: boolean;
  partialReasons: string[];
  limitations: ReviewEvidenceLimitations[];
  aiUsageNotes: string[];
  promptSections: string[];
  sourceContextMissing: boolean;
}

export interface ReviewAggregationContext {
  review: EntitySummary;
  scope: ReviewContextScope;
  period: {
    start?: string;
    end?: string;
    label?: string;
  };
  targets: LinkedEntitySummary[];
  project: EntitySummary | null;
  routeNodes: EntitySummary[];
  relatedTasks: EntitySummary[];
  completedTasks: EntitySummary[];
  pendingTasks: EntitySummary[];
  activeTasks: EntitySummary[];
  postponedTasks: EntitySummary[];
  experiments: EvidenceSummary[];
  literatures: EvidenceSummary[];
  resultItems: EvidenceSummary[];
  findings: EvidenceSummary[];
  outputCandidates: EvidenceSummary[];
  outputGaps: EvidenceSummary[];
  outputs: EvidenceSummary[];
  existingReviewContent: ExistingReviewContentSummary;
  aggregationStats: ReviewAggregationStats;
  routineSummary?: ProjectRoutineSummary;
  linkedEntities: LinkedEntitySummary[];
  evidenceContext?: ReviewEvidenceContext;
  warnings: string[];
  missingReferences: MissingEntityReference[];
  partial: boolean;
}

export interface ReviewPeriodContextOptions {
  projectId?: EntityId;
  routeNodeId?: EntityId;
  startDate?: string;
  endDate?: string;
  includeArchived?: boolean;
}

export interface ReviewPeriodStats {
  reviewCount: number;
  taskCount: number;
  completedTaskCount: number;
  experimentCount: number;
  literatureCount: number;
  findingCount: number;
  outputCandidateCount: number;
  outputGapCount: number;
  unresolvedOutputGapCount: number;
  partiallyResolvedOutputGapCount: number;
  resolvedOutputGapCount: number;
  outputCount: number;
}

export interface ReviewPeriodContext {
  options: ReviewPeriodContextOptions;
  project: EntitySummary | null;
  routeNode: EntitySummary | null;
  reviews: EntitySummary[];
  tasks: EntitySummary[];
  completedTasks: EntitySummary[];
  experiments: EvidenceSummary[];
  experimentRuns: EvidenceSummary[];
  literatures: EvidenceSummary[];
  resultItems: EvidenceSummary[];
  findings: EvidenceSummary[];
  outputCandidates: EvidenceSummary[];
  outputGaps: EvidenceSummary[];
  outputs: EvidenceSummary[];
  stats: ReviewPeriodStats;
  evidenceContext?: ReviewEvidenceContext;
  warnings: string[];
  missingReferences: MissingEntityReference[];
  partial: boolean;
}
