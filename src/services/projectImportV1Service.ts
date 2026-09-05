import type { EntityType, ReviewOutlineSectionKey } from "../types/planning";
import { entityLinkService } from "./entityLinkService";
import { experimentRunService } from "./experimentRunService";
import { experimentService } from "./experimentService";
import { literatureService } from "./literatureService";
import { outputConversionService } from "./outputConversionService";
import { outputService } from "./outputService";
import { planningService } from "./planningService";
import {
  IMPORT_V1_OBJECT_TYPES,
  orderImportV1Routes,
  preflightProjectImportV1,
  projectImportV1Authority,
  type ImportV1ObjectType,
  type ImportV1RelationRecord,
  type ImportV1StructuredSummary,
  type ProjectImportV1InputIdentity,
  type ProjectImportV1PreflightPlan,
  type ProjectImportV1SkippedCounts
} from "./projectImportV1Authority";

export interface ProjectImportV1Dependencies {
  createProject: typeof planningService.createProject;
  getProjectById: typeof planningService.getProjectById;
  createRoute: typeof planningService.createRouteNode;
  getRouteById: typeof planningService.getRouteNodeById;
  createTask: typeof planningService.createTask;
  getTaskById: typeof planningService.getTaskById;
  createExperiment: typeof experimentService.createExperiment;
  getExperimentById: typeof experimentService.getExperimentById;
  createExperimentRun: typeof experimentRunService.createExperimentRun;
  getExperimentRunById: typeof experimentRunService.getRunById;
  createLiterature: typeof literatureService.createLiterature;
  getLiteratureById: typeof literatureService.getLiteratureById;
  createReview: typeof planningService.createReviewWithTargets;
  getReviewById: typeof planningService.getReviewById;
  createResultItem: typeof outputConversionService.createResultItem;
  getResultItemById: typeof outputConversionService.getResultItemById;
  createFinding: typeof outputConversionService.createFinding;
  getFindingById: typeof outputConversionService.getFindingById;
  createOutputCandidate: typeof outputConversionService.createOutputCandidate;
  getOutputCandidateById: typeof outputConversionService.getOutputCandidateById;
  createOutputGap: typeof outputConversionService.createOutputGap;
  getOutputGapById: typeof outputConversionService.getOutputGapById;
  createResearchOutput: typeof outputService.create;
  getResearchOutputById: typeof outputService.getById;
  createEntityLink: typeof entityLinkService.createEntityLink;
  queryLinksBetween: typeof entityLinkService.queryLinksBetween;
}

const productionDependencies: ProjectImportV1Dependencies = {
  createProject: planningService.createProject,
  getProjectById: planningService.getProjectById,
  createRoute: planningService.createRouteNode,
  getRouteById: planningService.getRouteNodeById,
  createTask: planningService.createTask,
  getTaskById: planningService.getTaskById,
  createExperiment: experimentService.createExperiment,
  getExperimentById: experimentService.getExperimentById,
  createExperimentRun: experimentRunService.createExperimentRun,
  getExperimentRunById: experimentRunService.getRunById,
  createLiterature: literatureService.createLiterature,
  getLiteratureById: literatureService.getLiteratureById,
  createReview: planningService.createReviewWithTargets,
  getReviewById: planningService.getReviewById,
  createResultItem: outputConversionService.createResultItem,
  getResultItemById: outputConversionService.getResultItemById,
  createFinding: outputConversionService.createFinding,
  getFindingById: outputConversionService.getFindingById,
  createOutputCandidate: outputConversionService.createOutputCandidate,
  getOutputCandidateById: outputConversionService.getOutputCandidateById,
  createOutputGap: outputConversionService.createOutputGap,
  getOutputGapById: outputConversionService.getOutputGapById,
  createResearchOutput: outputService.create,
  getResearchOutputById: outputService.getById,
  createEntityLink: entityLinkService.createEntityLink,
  queryLinksBetween: entityLinkService.queryLinksBetween
};

export interface ProjectImportV1CreatedIdentity {
  type: ImportV1ObjectType;
  ref: string;
  id: string;
  label: string;
}

export interface ProjectImportV1FailureLocation {
  type: ImportV1ObjectType | "relation" | "preflight" | "execution";
  ref?: string;
  message: string;
}

export interface ProjectImportV1ExecutionOutcome {
  status: "success" | "partial" | "failed" | "canceled";
  project?: { id: string; ref: string; title: string };
  createdCounts: Record<ImportV1ObjectType, number>;
  createdRelationCount: number;
  created: ProjectImportV1CreatedIdentity[];
  failedAt?: ProjectImportV1FailureLocation;
  skippedCounts: ProjectImportV1SkippedCounts;
  warnings: string[];
}

export interface ExecuteProjectImportV1Options {
  confirmed: boolean;
  selectedMode?: ProjectImportV1InputIdentity["selectedMode"];
  effectiveMode?: ProjectImportV1InputIdentity["effectiveMode"];
}

interface EntityReadback {
  id: string;
  title?: string;
  outputName?: string;
  projectId?: string;
  primaryProjectId?: string | null;
}

const ENTITY_TYPE_MAP: Record<ImportV1ObjectType, EntityType> = {
  project: "project",
  route: "routeNode",
  task: "task",
  experiment: "experiment",
  experimentRun: "experimentRun",
  literature: "literature",
  review: "review",
  resultItem: "resultItem",
  finding: "finding",
  outputCandidate: "outputCandidate",
  outputGap: "outputGap",
  researchOutput: "output"
};

function emptyCounts(): Record<ImportV1ObjectType, number> {
  return Object.fromEntries(IMPORT_V1_OBJECT_TYPES.map((type) => [type, 0])) as Record<
    ImportV1ObjectType,
    number
  >;
}

function labelOf(entity: EntityReadback) {
  return entity.title ?? entity.outputName ?? entity.id;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function structuredSummary(
  type: "resultItem" | "finding" | "outputCandidate" | "outputGap" | "researchOutput",
  input?: ImportV1StructuredSummary
) {
  if (!input) return undefined;
  return projectImportV1Authority.structuredSummaryKeys[type].map((key, index) => ({
    key,
    value: input[key] ?? "",
    order: index + 2
  }));
}

function reviewTargetType(type: "route" | "task" | "experiment" | "experimentRun" | "literature") {
  return type === "route" ? "routeNode" as const : type;
}

let executionActive = false;

export async function executeProjectImportV1(
  preflightPlan: ProjectImportV1PreflightPlan,
  options: ExecuteProjectImportV1Options,
  dependencies: ProjectImportV1Dependencies = productionDependencies
): Promise<ProjectImportV1ExecutionOutcome> {
  const createdCounts = emptyCounts();
  const created: ProjectImportV1CreatedIdentity[] = [];
  const outcomeBase = {
    createdCounts,
    createdRelationCount: 0,
    created,
    skippedCounts: { ...preflightPlan.preview.skippedCounts },
    warnings: preflightPlan.warnings.map((warning) => `${warning.path}: ${warning.message}`)
  };

  if (options.confirmed !== true) {
    return { status: "canceled", ...outcomeBase };
  }
  if (executionActive) {
    return {
      status: "failed",
      ...outcomeBase,
      failedAt: {
        type: "execution",
        message: "Another Project Import v1 execution is already active in this session."
      }
    };
  }
  if (
    (options.selectedMode !== undefined &&
      options.selectedMode !== preflightPlan.inputIdentity.selectedMode) ||
    (options.effectiveMode !== undefined &&
      options.effectiveMode !== preflightPlan.inputIdentity.effectiveMode)
  ) {
    return {
      status: "failed",
      ...outcomeBase,
      failedAt: {
        type: "preflight",
        message: "The data-source mode changed after preflight; select the file again before importing."
      }
    };
  }

  executionActive = true;
  const document = preflightPlan.document;
  const realIds = new Map<string, { type: ImportV1ObjectType; id: string }>();
  let project: ProjectImportV1ExecutionOutcome["project"];
  let current: ProjectImportV1FailureLocation = { type: "execution", message: "Import execution started." };
  let createdRelationCount = 0;

  function realId(ref: string, expectedType: ImportV1ObjectType) {
    const resolved = realIds.get(ref);
    if (!resolved || resolved.type !== expectedType) {
      throw new Error(`Temporary ref ${ref} is not mapped to a created ${expectedType}.`);
    }
    return resolved.id;
  }

  function remember(type: ImportV1ObjectType, ref: string, entity: EntityReadback) {
    realIds.set(ref, { type, id: entity.id });
    createdCounts[type] += 1;
    created.push({ type, ref, id: entity.id, label: labelOf(entity) });
  }

  async function createAndReadback<T extends EntityReadback>(
    type: ImportV1ObjectType,
    ref: string,
    create: () => Promise<T>,
    read: (id: string) => Promise<T | undefined>,
    verify?: (readback: T) => void
  ) {
    current = { type, ref, message: `${type} canonical CREATE failed.` };
    const entity = await create();
    remember(type, ref, entity);
    current = { type, ref, message: `${type} authoritative readback failed.` };
    const readback = await read(entity.id);
    if (!readback || readback.id !== entity.id) {
      throw new Error(`${type} ${ref} was created but canonical readback did not return the created identity.`);
    }
    verify?.(readback);
    return readback;
  }

  try {
    const projectRecord = document.project;
    const projectReadback = await createAndReadback(
      "project",
      projectRecord.ref,
      () => dependencies.createProject({
        title: projectRecord.title,
        description: projectRecord.description,
        background: projectRecord.background,
        customFields: projectRecord.background === undefined
          ? undefined
          : { significance: projectRecord.background },
        objective: projectRecord.objective,
        scope: projectRecord.scope,
        researchQuestion: projectRecord.researchQuestion,
        status: projectRecord.status,
        priority: projectRecord.priority,
        startDate: projectRecord.startDate,
        targetDate: projectRecord.targetDate,
        tags: projectRecord.tags,
        source: "imported"
      }),
      dependencies.getProjectById,
      (readback) => {
        if (readback.title !== projectRecord.title) {
          throw new Error("Project canonical readback title differs from the confirmed import preview.");
        }
      }
    );
    project = {
      id: projectReadback.id,
      ref: projectRecord.ref,
      title: projectReadback.title
    };
    const projectId = projectReadback.id;

    const orderedRoutes = orderImportV1Routes(document.objects.routes);
    if (!orderedRoutes) throw new Error("Route dependency order could not be resolved after preflight.");
    for (const route of orderedRoutes) {
      await createAndReadback(
        "route",
        route.ref,
        () => dependencies.createRoute({
          projectId,
          parentNodeId: route.parentRef ? realId(route.parentRef, "route") : undefined,
          title: route.title,
          description: route.description,
          objective: route.objective,
          expectedOutput: route.expectedOutput,
          nodeType: route.nodeType,
          status: route.status,
          startDate: route.startDate,
          endDate: route.endDate,
          timeLabel: route.timeLabel,
          timePrecision: route.timePrecision,
          showInGantt: route.showInGantt,
          captureState: route.captureState,
          resultNote: route.resultNote,
          tags: route.tags,
          source: "imported"
        }),
        dependencies.getRouteById,
        (readback) => {
          if (readback.projectId !== projectId) throw new Error("Route canonical readback project mismatch.");
        }
      );
    }

    for (const task of document.objects.tasks) {
      await createAndReadback(
        "task",
        task.ref,
        () => dependencies.createTask({
          projectId,
          routeNodeId: task.routeRef ? realId(task.routeRef, "route") : undefined,
          title: task.title,
          description: task.description,
          taskType: task.taskType,
          status: task.status,
          priority: task.priority,
          dueDate: task.dueDate,
          scheduledDate: task.scheduledDate,
          timeLabel: task.timeLabel,
          timeBucket: task.timeBucket,
          timePrecision: task.timePrecision,
          captureState: task.captureState,
          acceptanceCriteria: task.acceptanceCriteria,
          resultNote: task.resultNote,
          blockedReason: task.blockedReason,
          tags: task.tags,
          source: "imported"
        }),
        dependencies.getTaskById,
        (readback) => {
          if (readback.projectId !== projectId) throw new Error("Task canonical readback project mismatch.");
        }
      );
    }

    for (const experiment of document.objects.experiments) {
      await createAndReadback(
        "experiment",
        experiment.ref,
        () => dependencies.createExperiment({
          projectId,
          routeId: null,
          taskId: null,
          title: experiment.title,
          purposeAndQuestion: experiment.purposeAndQuestion,
          conditionSummary: experiment.conditionSummary,
          methodSummary: experiment.methodSummary,
          resultSummary: experiment.resultSummary,
          conclusionAndNextSteps: experiment.conclusionAndNextSteps,
          other: experiment.other,
          status: experiment.status,
          rating: experiment.rating,
          usableForPaper: experiment.usableForPaper,
          usableForReport: experiment.usableForReport,
          usableForPatent: experiment.usableForPatent,
          tags: experiment.tags,
          source: "imported"
        }),
        dependencies.getExperimentById,
        (readback) => {
          if (readback.projectId !== projectId) throw new Error("Experiment canonical readback project mismatch.");
        }
      );
    }

    for (const run of document.objects.experimentRuns) {
      await createAndReadback(
        "experimentRun",
        run.ref,
        () => dependencies.createExperimentRun({
          experimentId: realId(run.experimentRef, "experiment"),
          title: run.title,
          runLabel: run.runLabel,
          status: run.status,
          startedAt: run.startedAt,
          completedAt: run.completedAt,
          conditionSummary: run.conditionSummary,
          variableParameterSummary: run.variableParameterSummary,
          methodSummary: run.methodSummary,
          resultSummary: run.resultSummary,
          conclusion: run.conclusion,
          summaryOther: run.summaryOther,
          rating: run.rating,
          tags: run.tags,
          source: "imported"
        }),
        dependencies.getExperimentRunById,
        (readback) => {
          if (readback.projectId !== projectId) throw new Error("ExperimentRun canonical readback project mismatch.");
        }
      );
    }

    for (const literature of document.objects.literature) {
      current = { type: "literature", ref: literature.ref, message: "Literature canonical CREATE failed." };
      const result = await dependencies.createLiterature({
        title: literature.title,
        authors: literature.authors,
        year: literature.year,
        venue: literature.venue,
        publicationType: literature.publicationType,
        abstract: literature.abstract,
        keywords: literature.keywords,
        doi: literature.doi,
        url: literature.url,
        readingStatus: literature.readingStatus,
        importance: literature.importance,
        primaryProjectId: projectId,
        tags: literature.tags,
        source: "imported"
      });
      if (!result.literature) {
        throw new Error(result.errors.join("; ") || "Literature canonical CREATE returned no entity.");
      }
      remember("literature", literature.ref, result.literature);
      current = { type: "literature", ref: literature.ref, message: "Literature authoritative readback failed." };
      const readback = await dependencies.getLiteratureById(result.literature.id);
      if (!readback || readback.primaryProjectId !== projectId) {
        throw new Error("Literature canonical readback project mismatch.");
      }
      if (result.status !== "success" && result.status !== "skipped") {
        throw new Error(`Literature was created, but canonical Provisioning ended ${result.status}: ${result.errors.join("; ")}`);
      }
    }

    for (const review of document.objects.reviews) {
      let reviewCreateResult: Awaited<ReturnType<ProjectImportV1Dependencies["createReview"]>> | undefined;
      const readback = await createAndReadback(
        "review",
        review.ref,
        async () => {
          reviewCreateResult = await dependencies.createReview({
            projectId,
            title: review.title,
            description: review.description,
            reviewType: review.reviewType,
            periodStart: review.periodStart,
            periodEnd: review.periodEnd,
            periodLabel: review.periodLabel,
            outlineSections: review.outlineSections?.map((section) => ({
              key: section.key as ReviewOutlineSectionKey,
              content: section.content
            })),
            targets: review.targets?.map((target) => ({
              targetType: reviewTargetType(target.type),
              targetId: realId(target.ref, target.type),
              relationType: "summarizes" as const,
              description: target.description
            })),
            tags: review.tags,
            source: "imported"
          });
          return reviewCreateResult;
        },
        dependencies.getReviewById,
        (canonical) => {
          if (canonical.projectId !== projectId) throw new Error("Review canonical readback project mismatch.");
        }
      );
      const provisioning = reviewCreateResult?.provisioning;
      if (!provisioning || provisioning.completionState !== "complete") {
        throw new Error(`Review was created, but canonical Provisioning is ${provisioning?.completionState ?? "unknown"}.`);
      }
    }

    for (const item of document.objects.resultItems) {
      const sourceId = realId(item.source.ref, item.source.type);
      await createAndReadback(
        "resultItem",
        item.ref,
        () => dependencies.createResultItem({
          projectId,
          sourceType: item.source.type,
          sourceId,
          title: item.title,
          resultType: item.resultType,
          routeId: null,
          taskId: null,
          experimentId: item.experimentRef ? realId(item.experimentRef, "experiment") : item.source.type === "experiment" ? sourceId : null,
          experimentRunId: item.experimentRunRef ? realId(item.experimentRunRef, "experimentRun") : item.source.type === "experimentRun" ? sourceId : null,
          status: item.status,
          structuredSummary: structuredSummary("resultItem", item.structuredSummary),
          summary: item.summary,
          value: item.value,
          unit: item.unit,
          tags: item.tags,
          isAsset: item.isAsset,
          assetReason: item.assetReason,
          assetQuality: item.assetQuality,
          usableFor: item.usableFor
        }),
        dependencies.getResultItemById,
        (readback) => {
          if (readback.projectId !== projectId) throw new Error("ResultItem canonical readback project mismatch.");
        }
      );
    }

    for (const finding of document.objects.findings) {
      await createAndReadback(
        "finding",
        finding.ref,
        () => dependencies.createFinding({
          projectId,
          title: finding.title,
          routeId: null,
          taskId: null,
          experimentId: finding.experimentRef ? realId(finding.experimentRef, "experiment") : null,
          summary: finding.summary,
          status: finding.status,
          structuredSummary: structuredSummary("finding", finding.structuredSummary),
          findingType: finding.findingType,
          confidence: finding.confidence,
          maturity: finding.maturity,
          tags: finding.tags,
          resultItemIds: finding.resultItemRefs?.map((ref) => realId(ref, "resultItem"))
        }),
        dependencies.getFindingById,
        (readback) => {
          if (readback.projectId !== projectId) throw new Error("Finding canonical readback project mismatch.");
        }
      );
    }

    for (const candidate of document.objects.outputCandidates) {
      await createAndReadback(
        "outputCandidate",
        candidate.ref,
        () => dependencies.createOutputCandidate({
          projectId,
          title: candidate.title,
          candidateType: candidate.candidateType,
          routeId: null,
          taskId: null,
          description: candidate.description,
          status: candidate.status,
          structuredSummary: structuredSummary("outputCandidate", candidate.structuredSummary),
          maturity: candidate.maturity,
          priority: candidate.priority,
          tags: candidate.tags,
          findingIds: candidate.findingRefs?.map((ref) => realId(ref, "finding")),
          resultItemIds: candidate.resultItemRefs?.map((ref) => realId(ref, "resultItem"))
        }),
        dependencies.getOutputCandidateById,
        (readback) => {
          if (readback.projectId !== projectId) throw new Error("OutputCandidate canonical readback project mismatch.");
        }
      );
    }

    for (const gap of document.objects.outputGaps) {
      await createAndReadback(
        "outputGap",
        gap.ref,
        () => dependencies.createOutputGap({
          projectId,
          title: gap.title,
          gapType: gap.gapType,
          outputCandidateId: realId(gap.outputCandidateRef, "outputCandidate"),
          confirmedByUser: true,
          description: gap.description,
          status: gap.status,
          structuredSummary: structuredSummary("outputGap", gap.structuredSummary),
          priority: gap.priority,
          relatedTaskId: null,
          relatedRouteNodeId: null
        }),
        dependencies.getOutputGapById,
        (readback) => {
          if (readback.projectId !== projectId) throw new Error("OutputGap canonical readback project mismatch.");
        }
      );
    }

    for (const output of document.objects.researchOutputs) {
      await createAndReadback(
        "researchOutput",
        output.ref,
        () => dependencies.createResearchOutput({
          projectId,
          outputName: output.outputName,
          outputType: output.outputType,
          status: output.status,
          structuredSummary: structuredSummary("researchOutput", output.structuredSummary),
          usableForPaper: output.usableForPaper ?? false,
          description: output.description ?? "",
          experimentId: output.experimentRef ? realId(output.experimentRef, "experiment") : undefined
        }),
        dependencies.getResearchOutputById,
        (readback) => {
          if (readback.projectId !== projectId) throw new Error("ResearchOutput canonical readback project mismatch.");
        }
      );
    }

    async function createRelation(relation: ImportV1RelationRecord) {
      const sourceId = realId(relation.source.ref, relation.source.type);
      const targetId = realId(relation.target.ref, relation.target.type);
      current = {
        type: "relation",
        ref: `${relation.source.ref}>${relation.target.ref}`,
        message: "Canonical EntityLink CREATE failed."
      };
      await dependencies.createEntityLink({
        sourceType: ENTITY_TYPE_MAP[relation.source.type],
        sourceId,
        targetType: ENTITY_TYPE_MAP[relation.target.type],
        targetId,
        relationType: relation.relationType,
        description: relation.description
      });
      const readback = await dependencies.queryLinksBetween(
        ENTITY_TYPE_MAP[relation.source.type],
        sourceId,
        ENTITY_TYPE_MAP[relation.target.type],
        targetId,
        relation.relationType
      );
      if (readback.length !== 1) {
        throw new Error("Canonical EntityLink readback did not return exactly one created relation.");
      }
      createdRelationCount += 1;
    }

    for (const relation of document.relations) await createRelation(relation);

    return {
      status: "success",
      project,
      createdCounts,
      createdRelationCount,
      created,
      skippedCounts: { ...preflightPlan.preview.skippedCounts },
      warnings: [...outcomeBase.warnings]
    };
  } catch (error) {
    const knownPostWrite = error as {
      experiment?: EntityReadback;
      run?: EntityReadback;
    };
    if (current.type === "experiment" && knownPostWrite.experiment && !realIds.has(current.ref ?? "")) {
      remember("experiment", current.ref!, knownPostWrite.experiment);
    }
    if (current.type === "experimentRun" && knownPostWrite.run && !realIds.has(current.ref ?? "")) {
      remember("experimentRun", current.ref!, knownPostWrite.run);
    }
    const message = errorMessage(error);
    return {
      status: created.length > 0 ? "partial" : "failed",
      project,
      createdCounts,
      createdRelationCount,
      created,
      skippedCounts: { ...preflightPlan.preview.skippedCounts },
      failedAt: { ...current, message },
      warnings: created.length > 0
        ? [...outcomeBase.warnings,
            "Import stopped immediately after the unexpected canonical service failure.",
            "Already-created business objects were preserved; do not blindly retry the same file."
          ]
        : [...outcomeBase.warnings]
    };
  } finally {
    executionActive = false;
  }
}

export const projectImportV1Service = {
  preflight: preflightProjectImportV1,
  execute: executeProjectImportV1
} as const;
