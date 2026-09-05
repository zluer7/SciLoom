import type { EntityId } from "../types";
import type { Experiment, ExperimentRun, FileRef, ResultMetric } from "../types/experiment";
import type { Literature } from "../types/literature";
import type {
  Finding,
  OutputCandidate,
  OutputGap,
  ResultItem
} from "../types/outputConversion";
import type { ResearchOutput } from "../types/output";
import type { Project, Review, RouteNode, Task } from "../types/planning";
import { experimentRunService } from "./experimentRunService";
import { experimentService } from "./experimentService";
import { fileRefService } from "./fileRefService";
import { literatureService } from "./literatureService";
import { outputConversionService } from "./outputConversionService";
import { outputService } from "./outputService";
import { getPlanningFirstLayerData } from "./planningRepository";
import { planningService, type ReviewTargetSummary } from "./planningService";
import { resultMetricService } from "./resultMetricService";

export type ReviewObjectSummaryType =
  | "project"
  | "routeNode"
  | "task"
  | "experiment"
  | "experimentRun"
  | "literature";

export type ReviewContextSourceBoundary =
  | "directProject"
  | "summarizesEntityLink"
  | "derivedFromObject"
  | "reviewPathMaterial"
  | "contextualEvidence"
  | "missingReference";

export type ReviewContextProvenanceSource =
  | "review.projectId"
  | "entityLink.summarizes"
  | "fileRef.reviewOwner"
  | "fileRef.experimentOwner"
  | "fileRef.experimentRunOwner"
  | "fileRef.literatureOwner"
  | "experiment.resultMetric"
  | "experimentRun.resultMetric"
  | "outputConversion"
  | "output"
  | "selectorDerived"
  | "missingReference";

export interface ReviewContextProvenance {
  sourceType: ReviewContextProvenanceSource;
  sourceId?: EntityId;
  relation?: string;
  confidence: "direct" | "derived" | "missing";
  note?: string;
}

export interface ReviewContextWarning {
  code:
    | "review_not_found"
    | "project_missing"
    | "missing_formal_target"
    | "cross_project_target"
    | "missing_run_parent_experiment"
    | "result_metric_missing_parent"
    | "file_ref_owner_missing"
    | "path_metadata_only"
    | "context_truncated";
  message: string;
  targetType?: string;
  targetId?: EntityId;
  provenance?: ReviewContextProvenance[];
}

export interface ReviewMissingReference {
  refType: string;
  refId: EntityId;
  source: string;
  message: string;
}

export interface ReviewPathMaterialSummary {
  fileRefId: EntityId;
  ownerType: string;
  ownerId: EntityId;
  title: string;
  fileType?: string;
  pathSummary: string;
  hasPath: boolean;
  note?: string;
  sourceBoundary: ReviewContextSourceBoundary;
  provenance: ReviewContextProvenance[];
}

export interface ReviewMetricSummary {
  metricId: EntityId;
  name: string;
  value?: unknown;
  unit?: string;
  description?: string;
  isKeyResult?: boolean;
  sourceBoundary: ReviewContextSourceBoundary;
  provenance: ReviewContextProvenance[];
}

export interface ReviewObjectSummary {
  targetType: ReviewObjectSummaryType;
  targetId: EntityId;
  title: string;
  status?: string;
  description?: string;
  projectId?: EntityId;
  routeNodeId?: EntityId;
  taskId?: EntityId;
  experimentId?: EntityId;
  missing: boolean;
  partial: boolean;
  sourceBoundary: ReviewContextSourceBoundary;
  provenance: ReviewContextProvenance[];
  parent?: Pick<ReviewObjectSummary, "targetType" | "targetId" | "title" | "missing">;
  childObjects?: Array<Pick<ReviewObjectSummary, "targetType" | "targetId" | "title" | "status" | "missing">>;
  metrics?: ReviewMetricSummary[];
  pathMaterials?: ReviewPathMaterialSummary[];
  warnings?: ReviewContextWarning[];
}

export interface ReviewDerivedEvidenceSummary {
  evidenceType: "outputGap" | "resultItem" | "finding" | "outputCandidate" | "researchOutput";
  evidenceId: EntityId;
  title: string;
  status?: string;
  projectId?: EntityId;
  sourceBoundary: ReviewContextSourceBoundary;
  provenance: ReviewContextProvenance[];
}

export interface ReviewDetailContext {
  review: Review;
  projectSummary?: ReviewObjectSummary;
  directTargets: ReviewObjectSummary[];
  pathMaterialSummaries: ReviewPathMaterialSummary[];
  derivedEvidence: ReviewDerivedEvidenceSummary[];
  warnings: ReviewContextWarning[];
  missing: ReviewMissingReference[];
  partial: boolean;
  completeness: {
    hasReview: boolean;
    hasProject: boolean;
    hasFormalTargets: boolean;
    hasMissingTargets: boolean;
    hasPathMaterialWarnings: boolean;
    hasDerivedEvidence: boolean;
  };
  sourceBoundary: "metadata_and_structured_context_only";
  manuscriptSummary: {
    manuscriptFileCount: number;
    attachmentCount: number;
    hasManagedWorkspace: boolean;
    outlineSectionCount: number;
  };
}

export interface BuildReviewDetailContextInput {
  review: Review;
  targetSummaries?: ReviewTargetSummary[];
  projects?: Project[];
  routeNodes?: RouteNode[];
  tasks?: Task[];
  experiments?: Experiment[];
  experimentRuns?: ExperimentRun[];
  literatures?: Literature[];
  metrics?: ResultMetric[];
  fileRefs?: FileRef[];
  outputGaps?: OutputGap[];
  resultItems?: ResultItem[];
  findings?: Finding[];
  outputCandidates?: OutputCandidate[];
  outputs?: ResearchOutput[];
}

const FORMAL_TARGET_TYPES = new Set<ReviewObjectSummaryType>([
  "project",
  "routeNode",
  "task",
  "experiment",
  "experimentRun",
  "literature"
]);

function isFormalTargetType(value: string): value is ReviewObjectSummaryType {
  return FORMAL_TARGET_TYPES.has(value as ReviewObjectSummaryType);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function titleOf(item: unknown, fallback: string) {
  if (item && typeof item === "object") {
    const record = item as Record<string, unknown>;
    return text(record.title) ?? text(record.name) ?? text(record.label) ?? fallback;
  }
  return fallback;
}

function statusOf(item: unknown) {
  if (!item || typeof item !== "object") {
    return undefined;
  }
  const record = item as Record<string, unknown>;
  return text(record.status) ?? text(record.readingStatus) ?? text(record.progressStatus);
}

function descriptionOf(item: unknown) {
  if (!item || typeof item !== "object") {
    return undefined;
  }
  const record = item as Record<string, unknown>;
  return text(record.description) ?? text(record.summary) ?? text(record.purpose) ?? text(record.resultSummary);
}

function projectIdOf(targetType: ReviewObjectSummaryType, item: unknown) {
  if (!item || typeof item !== "object") {
    return undefined;
  }
  const record = item as Record<string, unknown>;
  if (targetType === "literature") {
    return text(record.primaryProjectId);
  }
  return text(record.projectId);
}

function hasDeletedAt(item: unknown) {
  return Boolean(item && typeof item === "object" && text((item as Record<string, unknown>).deletedAt));
}

function firstById<T extends { id: EntityId }>(items: T[], id?: EntityId | null) {
  return id ? items.find((item) => item.id === id && !hasDeletedAt(item)) : undefined;
}

function warning(
  code: ReviewContextWarning["code"],
  message: string,
  targetType?: string,
  targetId?: EntityId,
  provenance?: ReviewContextProvenance[]
): ReviewContextWarning {
  return { code, message, targetType, targetId, provenance };
}

function missing(refType: string, refId: EntityId, source: string, message: string): ReviewMissingReference {
  return { refType, refId, source, message };
}

function toPathMaterialSummary(
  fileRef: FileRef,
  sourceBoundary: ReviewContextSourceBoundary,
  sourceType: ReviewContextProvenanceSource
): ReviewPathMaterialSummary {
  const pathSummary = summarizePathForContext(fileRef.path);
  return {
    fileRefId: fileRef.id,
    ownerType: fileRef.ownerType,
    ownerId: fileRef.ownerId,
    title: fileRef.title || pathSummary || fileRef.id,
    fileType: fileRef.fileType,
    pathSummary,
    hasPath: Boolean(fileRef.path),
    note: fileRef.description,
    sourceBoundary,
    provenance: [
      {
        sourceType,
        sourceId: fileRef.id,
        relation: "metadataOnlyPathReference",
        confidence: "direct",
        note: "Path material summary excludes full absolute path and file body."
      }
    ]
  };
}

function summarizePathForContext(path?: string | null) {
  if (!path) {
    return "";
  }
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : normalized;
}

function metricSummary(
  metric: ResultMetric,
  sourceType: "experiment.resultMetric" | "experimentRun.resultMetric"
): ReviewMetricSummary {
  return {
    metricId: metric.id,
    name: metric.name,
    value: metric.value,
    unit: metric.unit,
    description: metric.description,
    sourceBoundary: "derivedFromObject",
    provenance: [
      {
        sourceType,
        sourceId: metric.id,
        relation: "structuredMetric",
        confidence: "derived"
      }
    ]
  };
}

function makeObjectSummary(input: {
  targetType: ReviewObjectSummaryType;
  targetId: EntityId;
  item?: unknown;
  sourceBoundary: ReviewContextSourceBoundary;
  provenance: ReviewContextProvenance[];
  missing?: boolean;
  partial?: boolean;
}): ReviewObjectSummary {
  return {
    targetType: input.targetType,
    targetId: input.targetId,
    title: titleOf(input.item, `${input.targetType}:${input.targetId}`),
    status: statusOf(input.item),
    description: descriptionOf(input.item),
    projectId: projectIdOf(input.targetType, input.item),
    routeNodeId: text((input.item as Record<string, unknown> | undefined)?.routeNodeId ?? (input.item as Record<string, unknown> | undefined)?.routeId),
    taskId: text((input.item as Record<string, unknown> | undefined)?.taskId),
    experimentId: text((input.item as Record<string, unknown> | undefined)?.experimentId),
    missing: input.missing ?? !input.item,
    partial: input.partial ?? !input.item,
    sourceBoundary: input.sourceBoundary,
    provenance: input.provenance,
    warnings: []
  };
}

function addWarning(target: { warnings: ReviewContextWarning[] }, item: ReviewContextWarning) {
  target.warnings.push(item);
}

function ownFileRefs(fileRefs: FileRef[], ownerType: string, ownerId: EntityId) {
  return fileRefs.filter((fileRef) => fileRef.ownerType === ownerType && fileRef.ownerId === ownerId && !hasDeletedAt(fileRef));
}

function derivedEvidenceForProject(input: BuildReviewDetailContextInput): ReviewDerivedEvidenceSummary[] {
  const projectId = input.review.projectId;
  const matchesProject = (item: { projectId?: EntityId }) => item.projectId === projectId;
  const evidence: ReviewDerivedEvidenceSummary[] = [];

  for (const item of (input.outputGaps ?? []).filter(matchesProject)) {
    evidence.push({
      evidenceType: "outputGap",
      evidenceId: item.id,
      title: item.title,
      status: item.status,
      projectId: item.projectId,
      sourceBoundary: "contextualEvidence",
      provenance: [{ sourceType: "outputConversion", sourceId: item.id, confidence: "derived" }]
    });
  }
  for (const item of (input.resultItems ?? []).filter(matchesProject)) {
    evidence.push({
      evidenceType: "resultItem",
      evidenceId: item.id,
      title: item.title,
      status: item.isAsset ? "asset" : undefined,
      projectId: item.projectId,
      sourceBoundary: "contextualEvidence",
      provenance: [{ sourceType: "outputConversion", sourceId: item.id, confidence: "derived" }]
    });
  }
  for (const item of (input.findings ?? []).filter(matchesProject)) {
    evidence.push({
      evidenceType: "finding",
      evidenceId: item.id,
      title: item.title,
      status: item.maturity,
      projectId: item.projectId,
      sourceBoundary: "contextualEvidence",
      provenance: [{ sourceType: "outputConversion", sourceId: item.id, confidence: "derived" }]
    });
  }
  for (const item of (input.outputCandidates ?? []).filter(matchesProject)) {
    evidence.push({
      evidenceType: "outputCandidate",
      evidenceId: item.id,
      title: item.title,
      status: item.status,
      projectId: item.projectId,
      sourceBoundary: "contextualEvidence",
      provenance: [{ sourceType: "outputConversion", sourceId: item.id, confidence: "derived" }]
    });
  }
  for (const item of (input.outputs ?? []).filter(matchesProject)) {
    evidence.push({
      evidenceType: "researchOutput",
      evidenceId: item.id,
      title: item.outputName,
      status: item.outputType,
      projectId: item.projectId,
      sourceBoundary: "contextualEvidence",
      provenance: [{ sourceType: "output", sourceId: item.id, confidence: "derived" }]
    });
  }
  return evidence;
}

export function buildReviewDetailContextFromData(input: BuildReviewDetailContextInput): ReviewDetailContext {
  const projects = input.projects ?? [];
  const routeNodes = input.routeNodes ?? [];
  const tasks = input.tasks ?? [];
  const experiments = input.experiments ?? [];
  const experimentRuns = input.experimentRuns ?? [];
  const literatures = input.literatures ?? [];
  const metrics = input.metrics ?? [];
  const fileRefs = input.fileRefs ?? [];
  const warnings: ReviewContextWarning[] = [];
  const missingRefs: ReviewMissingReference[] = [];
  const directTargets: ReviewObjectSummary[] = [];

  const project = firstById(projects, input.review.projectId);
  const projectSummary = makeObjectSummary({
    targetType: "project",
    targetId: input.review.projectId,
    item: project,
    sourceBoundary: project ? "directProject" : "missingReference",
    provenance: [{ sourceType: "review.projectId", sourceId: input.review.id, relation: "ownsReview", confidence: project ? "direct" : "missing" }]
  });
  if (!project) {
    const item = warning("project_missing", `Review project is missing: ${input.review.projectId}`, "project", input.review.projectId, projectSummary.provenance);
    projectSummary.warnings?.push(item);
    addWarning({ warnings }, item);
    missingRefs.push(missing("project", input.review.projectId, "review.projectId", item.message));
  }
  directTargets.push(projectSummary);

  const targetSummaries = (input.targetSummaries ?? []).filter((target) => target.targetType !== "project");
  for (const target of targetSummaries) {
    if (!isFormalTargetType(target.targetType)) {
      continue;
    }
    let item: Project | RouteNode | Task | Experiment | ExperimentRun | Literature | undefined;
    if (target.targetType === "routeNode") item = firstById(routeNodes, target.targetId);
    if (target.targetType === "task") item = firstById(tasks, target.targetId);
    if (target.targetType === "experiment") item = firstById(experiments, target.targetId);
    if (target.targetType === "experimentRun") item = firstById(experimentRuns, target.targetId);
    if (target.targetType === "literature") item = firstById(literatures, target.targetId);

    const provenance: ReviewContextProvenance[] = [
      {
        sourceType: item && !target.missing ? "entityLink.summarizes" : "missingReference",
        sourceId: target.linkId,
        relation: "summarizes",
        confidence: item && !target.missing ? "direct" : "missing"
      }
    ];
    const summary = makeObjectSummary({
      targetType: target.targetType,
      targetId: target.targetId,
      item,
      sourceBoundary: item && !target.missing ? "summarizesEntityLink" : "missingReference",
      provenance,
      missing: target.missing || !item,
      partial: target.missing || !item
    });

    if (summary.missing) {
      const itemWarning = warning(
        "missing_formal_target",
        `Review formal target is missing: ${target.targetType}/${target.targetId}`,
        target.targetType,
        target.targetId,
        provenance
      );
      summary.warnings?.push(itemWarning);
      addWarning({ warnings }, itemWarning);
      missingRefs.push(missing(target.targetType, target.targetId, "entityLink.summarizes", itemWarning.message));
    }

    const targetProjectId = summary.projectId;
    if (targetProjectId && targetProjectId !== input.review.projectId) {
      const itemWarning = warning(
        "cross_project_target",
        `Target project differs from review project: ${target.targetType}/${target.targetId}`,
        target.targetType,
        target.targetId,
        provenance
      );
      summary.partial = true;
      summary.warnings?.push(itemWarning);
      addWarning({ warnings }, itemWarning);
    }

    directTargets.push(summary);
  }

  const summaryByKey = new Map(directTargets.map((item) => [`${item.targetType}:${item.targetId}`, item]));
  for (const summary of directTargets) {
    if (summary.targetType === "experiment") {
      const runs = experimentRuns.filter((run) => run.experimentId === summary.targetId && !hasDeletedAt(run));
      summary.childObjects = runs.map((run) => ({
        targetType: "experimentRun",
        targetId: run.id,
        title: run.title,
        status: run.status,
        missing: false
      }));
      const experimentMetrics = metrics.filter((metric) => metric.experimentId === summary.targetId && !hasDeletedAt(metric));
      summary.metrics = experimentMetrics
        .filter((metric) => !metric.runId || Boolean(firstById(experimentRuns, metric.runId)))
        .map((metric) => metricSummary(metric, "experiment.resultMetric"));
      summary.pathMaterials = ownFileRefs(fileRefs, "experiment", summary.targetId).map((fileRef) =>
        toPathMaterialSummary(fileRef, "derivedFromObject", "fileRef.experimentOwner")
      );
    }
    if (summary.targetType === "experimentRun") {
      const run = firstById(experimentRuns, summary.targetId);
      const parent = firstById(experiments, run?.experimentId);
      if (parent) {
        summary.parent = { targetType: "experiment", targetId: parent.id, title: parent.title, missing: false };
      } else if (run?.experimentId) {
        const itemWarning = warning(
          "missing_run_parent_experiment",
          `ExperimentRun parent experiment is missing: ${run.experimentId}`,
          "experimentRun",
          summary.targetId,
          summary.provenance
        );
        summary.partial = true;
        summary.warnings?.push(itemWarning);
        addWarning({ warnings }, itemWarning);
        missingRefs.push(missing("experiment", run.experimentId, "experimentRun.experimentId", itemWarning.message));
      }
      summary.metrics = metrics
        .filter((metric) => metric.runId === summary.targetId && !hasDeletedAt(metric))
        .map((metric) => metricSummary(metric, "experimentRun.resultMetric"));
      summary.pathMaterials = ownFileRefs(fileRefs, "experimentRun", summary.targetId).map((fileRef) =>
        toPathMaterialSummary(fileRef, "derivedFromObject", "fileRef.experimentRunOwner")
      );
    }
    if (summary.targetType === "literature") {
      summary.pathMaterials = ownFileRefs(fileRefs, "literature", summary.targetId).map((fileRef) =>
        toPathMaterialSummary(fileRef, "derivedFromObject", "fileRef.literatureOwner")
      );
    }
  }

  for (const metric of metrics) {
    if (metric.runId && !firstById(experimentRuns, metric.runId)) {
      const itemWarning = warning(
        "result_metric_missing_parent",
        `ResultMetric parent run is missing: ${metric.runId}`,
        "resultMetric",
        metric.id,
        [{ sourceType: "experimentRun.resultMetric", sourceId: metric.id, relation: "structuredMetric", confidence: "missing" }]
      );
      addWarning({ warnings }, itemWarning);
      missingRefs.push(missing("experimentRun", metric.runId, "resultMetric.runId", itemWarning.message));
    } else if (metric.experimentId && !firstById(experiments, metric.experimentId)) {
      const itemWarning = warning(
        "result_metric_missing_parent",
        `ResultMetric parent experiment is missing: ${metric.experimentId}`,
        "resultMetric",
        metric.id,
        [{ sourceType: "experiment.resultMetric", sourceId: metric.id, relation: "structuredMetric", confidence: "missing" }]
      );
      addWarning({ warnings }, itemWarning);
      missingRefs.push(missing("experiment", metric.experimentId, "resultMetric.experimentId", itemWarning.message));
    }
  }

  const pathMaterialSummaries = ownFileRefs(fileRefs, "review", input.review.id).map((fileRef) =>
    toPathMaterialSummary(fileRef, "reviewPathMaterial", "fileRef.reviewOwner")
  );
  const nestedPathMaterials = directTargets.flatMap((item) => item.pathMaterials ?? []);
  if (pathMaterialSummaries.length > 0 || nestedPathMaterials.length > 0) {
    addWarning(
      { warnings },
      warning(
        "path_metadata_only",
        "FileRef path materials expose path summaries only; file bodies and full absolute paths are not read.",
        "fileRef",
        undefined,
        [{ sourceType: "selectorDerived", relation: "pathSafetyBoundary", confidence: "derived" }]
      )
    );
  }

  for (const fileRef of fileRefs.filter((fileRef) => fileRef.ownerType !== "review" && !hasDeletedAt(fileRef))) {
    if (fileRef.ownerType === "experiment" && !firstById(experiments, fileRef.ownerId)) {
      const itemWarning = warning("file_ref_owner_missing", `FileRef owner is missing: experiment/${fileRef.ownerId}`, "fileRef", fileRef.id);
      addWarning({ warnings }, itemWarning);
      missingRefs.push(missing("experiment", fileRef.ownerId, "fileRef.ownerId", itemWarning.message));
    }
    if (fileRef.ownerType === "experimentRun" && !firstById(experimentRuns, fileRef.ownerId)) {
      const itemWarning = warning("file_ref_owner_missing", `FileRef owner is missing: experimentRun/${fileRef.ownerId}`, "fileRef", fileRef.id);
      addWarning({ warnings }, itemWarning);
      missingRefs.push(missing("experimentRun", fileRef.ownerId, "fileRef.ownerId", itemWarning.message));
    }
    if (fileRef.ownerType === "literature" && !firstById(literatures, fileRef.ownerId)) {
      const itemWarning = warning("file_ref_owner_missing", `FileRef owner is missing: literature/${fileRef.ownerId}`, "fileRef", fileRef.id);
      addWarning({ warnings }, itemWarning);
      missingRefs.push(missing("literature", fileRef.ownerId, "fileRef.ownerId", itemWarning.message));
    }
  }

  const derivedEvidence = derivedEvidenceForProject(input);
  const partial = warnings.length > 0 || directTargets.some((item) => item.partial);
  return {
    review: input.review,
    projectSummary,
    directTargets,
    pathMaterialSummaries,
    derivedEvidence,
    warnings,
    missing: missingRefs,
    partial,
    completeness: {
      hasReview: true,
      hasProject: Boolean(project),
      hasFormalTargets: directTargets.length > 0,
      hasMissingTargets: missingRefs.length > 0,
      hasPathMaterialWarnings: warnings.some((item) => item.code === "path_metadata_only"),
      hasDerivedEvidence: derivedEvidence.length > 0
    },
    sourceBoundary: "metadata_and_structured_context_only",
    manuscriptSummary: {
      manuscriptFileCount: fileRefs.filter((item) => item.ownerType === "review" && item.ownerId === input.review.id && item.fileRole === "manuscript" && !item.deletedAt).length,
      attachmentCount: fileRefs.filter((item) => item.ownerType === "review" && item.ownerId === input.review.id && item.fileRole === "attachment" && !item.deletedAt).length,
      hasManagedWorkspace: fileRefs.some((item) => item.ownerType === "review" && item.ownerId === input.review.id && item.fileRole === "defaultFolder" && item.locationMode === "managed" && !item.deletedAt),
      outlineSectionCount: input.review.outlineSections?.length ?? 0
    }
  };
}

export async function getReviewDetailContext(reviewId: EntityId): Promise<ReviewDetailContext | undefined> {
  const review = await planningService.getReviewById(reviewId);
  if (!review) {
    return undefined;
  }
  const planningData = await getPlanningFirstLayerData();
  const [
    targetSummaries,
    experiments,
    experimentRuns,
    literatures,
    metrics,
    fileRefs,
    outputGaps,
    resultItems,
    findings,
    outputCandidates,
    outputs
  ] = await Promise.all([
    planningService.queryReviewTargets(reviewId),
    experimentService.getExperiments(),
    experimentRunService.list(),
    literatureService.queryLiteratures({ includeArchived: true }),
    resultMetricService.list(),
    fileRefService.list(),
    outputConversionService.listOutputGaps(),
    outputConversionService.listResultItems(),
    outputConversionService.listFindings(),
    outputConversionService.listOutputCandidates(),
    outputService.listOutputs()
  ]);

  return buildReviewDetailContextFromData({
    review,
    targetSummaries,
    projects: planningData.projects,
    routeNodes: planningData.routeNodes,
    tasks: planningData.tasks,
    experiments,
    experimentRuns,
    literatures,
    metrics,
    fileRefs,
    outputGaps,
    resultItems,
    findings,
    outputCandidates,
    outputs
  });
}

export async function queryReviewObjectSummaries(reviewId: EntityId): Promise<ReviewObjectSummary[]> {
  const context = await getReviewDetailContext(reviewId);
  return context?.directTargets ?? [];
}
