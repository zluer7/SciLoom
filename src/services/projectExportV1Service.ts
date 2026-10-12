import { entityLinkService } from "./entityLinkService";
import { experimentRunService } from "./experimentRunService";
import { experimentService } from "./experimentService";
import { saveTextFile, sanitizeFileName, type ExportResult } from "./exportService";
import { literatureService } from "./literatureService";
import { outputConversionRelationService } from "./outputConversionRelationService";
import { outputConversionService } from "./outputConversionService";
import { outputService } from "./outputService";
import { planningService } from "./planningService";
import {
  IMPORT_V1_OBJECT_TYPES,
  PROJECT_IMPORT_V1_SCHEMA,
  PROJECT_IMPORT_V1_VERSION,
  preflightProjectImportV1,
  type ImportV1ObjectType,
  type ImportV1RelationRecord,
  type ImportV1ReviewTargetType,
  type ImportV1StructuredSummary,
  type ProjectImportV1PreflightPlan,
  type ValidatedProjectImportV1Document
} from "./projectImportV1Authority";
import type { EntityLink, EntityType } from "../types/planning";
import type { OutputConversionRelation } from "../types/outputConversion";
import type { StructuredSummary } from "../types/outputStructuredSummary";

export const PROJECT_EXPORT_V1_COMPANION_VERSION = PROJECT_IMPORT_V1_VERSION;

const SUPPORTED_RELATIONSHIP_FAMILIES = [
  "projectContainment",
  "routeParent",
  "taskRoute",
  "experimentRunParent",
  "reviewTarget",
  "resultItemSource",
  "findingResultItem",
  "candidateFinding",
  "candidateResultItem",
  "gapCandidate",
  "researchOutputExperiment",
  "explicitEntityLink"
] as const;

export type ProjectExportV1RelationshipFamily =
  (typeof SUPPORTED_RELATIONSHIP_FAMILIES)[number];

type RelationshipInstanceCounts = Record<ProjectExportV1RelationshipFamily, number>;

export interface ProjectExportV1Dependencies {
  getProject: typeof planningService.getProjectById;
  queryRoutes: typeof planningService.queryRouteNodes;
  queryTasks: typeof planningService.queryTasks;
  queryReviews: typeof planningService.queryReviews;
  getExperimentsByProject: typeof experimentService.getExperimentsByProject;
  listExperimentRuns: typeof experimentRunService.listWritableExperimentRuns;
  queryLiteratures: typeof literatureService.queryLiteratures;
  listResultItems: typeof outputConversionService.listResultItems;
  listFindings: typeof outputConversionService.listFindings;
  listOutputCandidates: typeof outputConversionService.listOutputCandidates;
  listOutputGaps: typeof outputConversionService.listOutputGaps;
  listResearchOutputs: typeof outputService.listOutputs;
  queryEntityLinks: typeof entityLinkService.queryEntityLinks;
  queryOutputRelations: typeof outputConversionRelationService.queryOutputConversionRelations;
}

export interface ProjectExportV1ScopeSummary {
  supportedEntityTypeCount: number;
  exportedObjectCounts: Record<ImportV1ObjectType, number>;
  totalObjectCount: number;
  supportedRelationshipTypeCount: number;
  relationshipInstanceCounts: RelationshipInstanceCounts;
  totalRelationshipInstanceCount: number;
  omittedEntityCounts: {
    experimentRuns: number;
    resultItems: number;
    outputGaps: number;
  };
  omittedSourceFactCount: number;
  omittedSourceFacts: string[];
}

export interface PreparedProjectExportV1 {
  document: ValidatedProjectImportV1Document;
  serialized: string;
  defaultFileName: string;
  importPreflight: ProjectImportV1PreflightPlan;
  scope: ProjectExportV1ScopeSummary;
}

export interface SavePreparedProjectExportV1Dependencies {
  saveTextFile: (
    defaultFileName: string,
    contents: string,
    mimeType: string
  ) => Promise<ExportResult>;
}

const productionDependencies: ProjectExportV1Dependencies = {
  getProject: planningService.getProjectById,
  queryRoutes: planningService.queryRouteNodes,
  queryTasks: planningService.queryTasks,
  queryReviews: planningService.queryReviews,
  getExperimentsByProject: experimentService.getExperimentsByProject,
  listExperimentRuns: experimentRunService.listWritableExperimentRuns,
  queryLiteratures: literatureService.queryLiteratures,
  listResultItems: outputConversionService.listResultItems,
  listFindings: outputConversionService.listFindings,
  listOutputCandidates: outputConversionService.listOutputCandidates,
  listOutputGaps: outputConversionService.listOutputGaps,
  listResearchOutputs: outputService.listOutputs,
  queryEntityLinks: entityLinkService.queryEntityLinks,
  queryOutputRelations: outputConversionRelationService.queryOutputConversionRelations
};

const productionSaveDependencies: SavePreparedProjectExportV1Dependencies = {
  saveTextFile
};

const ENTITY_LINK_TYPE_TO_IMPORT_TYPE: Partial<Record<EntityType, ImportV1ObjectType>> = {
  project: "project",
  routeNode: "route",
  task: "task",
  experiment: "experiment",
  experimentRun: "experimentRun",
  literature: "literature",
  review: "review",
  resultItem: "resultItem",
  finding: "finding",
  outputCandidate: "outputCandidate",
  outputGap: "outputGap",
  output: "researchOutput"
};

const RESULT_SOURCE_TYPE_TO_IMPORT_TYPE = {
  experiment: "experiment",
  experimentRun: "experimentRun",
  review: "review",
  literature: "literature"
} as const;

function emptyRelationshipCounts(): RelationshipInstanceCounts {
  return Object.fromEntries(
    SUPPORTED_RELATIONSHIP_FAMILIES.map((family) => [family, 0])
  ) as RelationshipInstanceCounts;
}

function defined<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null)
  ) as T;
}

function sortedById<T extends { id: string }>(items: T[]) {
  return [...items].sort((left, right) => left.id.localeCompare(right.id));
}

function structuredSummary(summary: StructuredSummary): ImportV1StructuredSummary | undefined {
  if (!Array.isArray(summary)) return undefined;
  return Object.fromEntries(summary.map((section) => [section.key, String(section.value ?? "")]));
}

function refKey(type: ImportV1ObjectType, id: string) {
  return `${type}\u0000${id}`;
}

function isReviewTargetType(type: ImportV1ObjectType): type is ImportV1ReviewTargetType {
  return ["route", "task", "experiment", "experimentRun", "literature"].includes(type);
}

function relationKey(relation: ImportV1RelationRecord) {
  return [
    relation.source.type,
    relation.source.ref,
    relation.relationType,
    relation.target.type,
    relation.target.ref,
    relation.description ?? ""
  ].join("\u0000");
}

function mapExplicitRelations(
  links: EntityLink[],
  refs: Map<string, string>
): { relations: ImportV1RelationRecord[]; omitted: number } {
  const relations: ImportV1RelationRecord[] = [];
  let omitted = 0;
  for (const link of links) {
    const sourceType = ENTITY_LINK_TYPE_TO_IMPORT_TYPE[link.sourceType];
    const targetType = ENTITY_LINK_TYPE_TO_IMPORT_TYPE[link.targetType];
    if (link.sourceType === "review" && link.relationType === "summarizes") {
      continue;
    }
    const sourceRef = sourceType ? refs.get(refKey(sourceType, link.sourceId)) : undefined;
    const targetRef = targetType ? refs.get(refKey(targetType, link.targetId)) : undefined;
    if (!sourceRef && !targetRef) {
      continue;
    }
    if (!sourceType || !targetType || !sourceRef || !targetRef) {
      omitted += 1;
      continue;
    }
    relations.push(defined({
      source: { type: sourceType, ref: sourceRef },
      target: { type: targetType, ref: targetRef },
      relationType: link.relationType,
      description: link.description
    }));
  }
  return {
    relations: relations.sort((left, right) => relationKey(left).localeCompare(relationKey(right))),
    omitted
  };
}

function relationTargetIds(
  relations: OutputConversionRelation[],
  sourceType: OutputConversionRelation["sourceType"],
  targetType: OutputConversionRelation["targetType"],
  sourceId: string,
  relationType: OutputConversionRelation["relationType"]
) {
  return relations
    .filter((relation) =>
      relation.sourceType === sourceType &&
      relation.targetType === targetType &&
      relation.sourceId === sourceId &&
      relation.relationType === relationType
    )
    .map((relation) => relation.targetId)
    .sort((left, right) => left.localeCompare(right));
}

function relationIds(
  relations: OutputConversionRelation[],
  sourceType: OutputConversionRelation["sourceType"],
  targetType: OutputConversionRelation["targetType"],
  targetId: string,
  relationType: OutputConversionRelation["relationType"]
) {
  return relations
    .filter((relation) =>
      relation.sourceType === sourceType &&
      relation.targetType === targetType &&
      relation.targetId === targetId &&
      relation.relationType === relationType
    )
    .map((relation) => relation.sourceId)
    .sort((left, right) => left.localeCompare(right));
}

export async function prepareProjectExportV1(
  projectId: string,
  dependencies: ProjectExportV1Dependencies = productionDependencies
): Promise<PreparedProjectExportV1> {
  const normalizedProjectId = projectId.trim();
  if (!normalizedProjectId) {
    throw new Error("Select one Project before preparing an Import v1-compatible export.");
  }

  const project = await dependencies.getProject(normalizedProjectId);
  if (!project) {
    throw new Error("The selected Project is unavailable or deleted.");
  }

  const [
    routes,
    tasks,
    experiments,
    allRuns,
    literature,
    reviews,
    allResultItems,
    allFindings,
    allCandidates,
    allGaps,
    allResearchOutputs,
    entityLinks,
    outputRelations
  ] = await Promise.all([
    dependencies.queryRoutes({ projectId: project.id, includeArchived: true }),
    dependencies.queryTasks({ projectId: project.id, includeArchived: true }),
    dependencies.getExperimentsByProject(project.id),
    dependencies.listExperimentRuns(),
    dependencies.queryLiteratures({ primaryProjectId: project.id, includeArchived: true }),
    dependencies.queryReviews({ projectId: project.id, includeArchived: true }),
    dependencies.listResultItems(),
    dependencies.listFindings(),
    dependencies.listOutputCandidates(),
    dependencies.listOutputGaps(),
    dependencies.listResearchOutputs(),
    dependencies.queryEntityLinks(),
    dependencies.queryOutputRelations({ projectId: project.id })
  ]);

  // Planning queries already return the canonical semantic order. Preserve it
  // because route/task array order is user-visible exchange meaning.
  const orderedRoutes = [...routes];
  const orderedTasks = [...tasks];
  const sortedExperiments = sortedById(experiments);
  const experimentIds = new Set(sortedExperiments.map((experiment) => experiment.id));
  const experimentRuns = sortedById(allRuns.filter(
    (run) => run.projectId === project.id && experimentIds.has(run.experimentId)
  ));
  const resultItemsInProject = sortedById(allResultItems.filter((item) => item.projectId === project.id));
  const findings = sortedById(allFindings.filter((item) => item.projectId === project.id));
  const outputCandidates = sortedById(allCandidates.filter((item) => item.projectId === project.id));
  const outputGapsInProject = sortedById(allGaps.filter((item) => item.projectId === project.id));
  const researchOutputs = sortedById(allResearchOutputs.filter((item) => item.projectId === project.id));
  const sortedLiterature = sortedById(literature);
  const sortedReviews = sortedById(reviews);

  const refs = new Map<string, string>();
  function register(type: ImportV1ObjectType, id: string, index: number) {
    const ref = `${type}_${index + 1}`;
    refs.set(refKey(type, id), ref);
    return ref;
  }
  register("project", project.id, 0);
  orderedRoutes.forEach((item, index) => register("route", item.id, index));
  orderedTasks.forEach((item, index) => register("task", item.id, index));
  sortedExperiments.forEach((item, index) => register("experiment", item.id, index));
  experimentRuns.forEach((item, index) => register("experimentRun", item.id, index));
  sortedLiterature.forEach((item, index) => register("literature", item.id, index));
  sortedReviews.forEach((item, index) => register("review", item.id, index));

  const supportedResultItems = resultItemsInProject.filter((item) => {
    const sourceType = RESULT_SOURCE_TYPE_TO_IMPORT_TYPE[
      item.sourceType as keyof typeof RESULT_SOURCE_TYPE_TO_IMPORT_TYPE
    ];
    return Boolean(sourceType && refs.has(refKey(sourceType, item.sourceId)));
  });
  supportedResultItems.forEach((item, index) => register("resultItem", item.id, index));
  findings.forEach((item, index) => register("finding", item.id, index));
  outputCandidates.forEach((item, index) => register("outputCandidate", item.id, index));

  const selectedGapCandidateByGap = new Map<string, string>();
  const supportedGaps = outputGapsInProject.filter((gap) => {
    const candidateId = relationTargetIds(
      outputRelations,
      "outputGap",
      "outputCandidate",
      gap.id,
      "blocks"
    )[0];
    if (!candidateId || !refs.has(refKey("outputCandidate", candidateId))) return false;
    selectedGapCandidateByGap.set(gap.id, candidateId);
    return true;
  });
  supportedGaps.forEach((item, index) => register("outputGap", item.id, index));
  researchOutputs.forEach((item, index) => register("researchOutput", item.id, index));

  const relationshipCounts = emptyRelationshipCounts();
  const nonProjectObjectCount =
    orderedRoutes.length + orderedTasks.length + sortedExperiments.length + experimentRuns.length +
    sortedLiterature.length + sortedReviews.length + supportedResultItems.length + findings.length +
    outputCandidates.length + supportedGaps.length + researchOutputs.length;
  relationshipCounts.projectContainment = nonProjectObjectCount;

  const reviewTargetsByReview = new Map<string, EntityLink[]>();
  for (const link of entityLinks) {
    if (link.sourceType === "review" && link.relationType === "summarizes") {
      const current = reviewTargetsByReview.get(link.sourceId) ?? [];
      current.push(link);
      reviewTargetsByReview.set(link.sourceId, current);
    }
  }

  const document: ValidatedProjectImportV1Document = {
    schema: PROJECT_IMPORT_V1_SCHEMA,
    version: PROJECT_IMPORT_V1_VERSION,
    project: defined({
      ref: refs.get(refKey("project", project.id))!,
      title: project.title,
      description: project.description,
      background: project.background,
      objective: project.objective,
      scope: project.scope,
      researchQuestion: project.researchQuestion,
      status: project.status,
      priority: project.priority,
      startDate: project.startDate,
      targetDate: project.targetDate,
      tags: project.tags
    }),
    objects: {
      routes: orderedRoutes.map((route) => {
        const parentRef = route.parentNodeId
          ? refs.get(refKey("route", route.parentNodeId))
          : undefined;
        if (parentRef) relationshipCounts.routeParent += 1;
        return defined({
          ref: refs.get(refKey("route", route.id))!,
          title: route.title,
          parentRef,
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
          tags: route.tags
        });
      }),
      tasks: orderedTasks.map((task) => {
        const routeRef = task.routeNodeId
          ? refs.get(refKey("route", task.routeNodeId))
          : undefined;
        if (routeRef) relationshipCounts.taskRoute += 1;
        return defined({
          ref: refs.get(refKey("task", task.id))!,
          title: task.title,
          routeRef,
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
          tags: task.tags
        });
      }),
      experiments: sortedExperiments.map((experiment) => defined({
        ref: refs.get(refKey("experiment", experiment.id))!,
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
        tags: experiment.tags
      })),
      experimentRuns: experimentRuns.map((run) => {
        const experimentRef = refs.get(refKey("experiment", run.experimentId));
        if (!experimentRef) {
          throw new Error(`ExperimentRun ${run.id} has no in-scope parent Experiment.`);
        }
        relationshipCounts.experimentRunParent += 1;
        return defined({
          ref: refs.get(refKey("experimentRun", run.id))!,
          experimentRef,
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
          tags: run.tags
        });
      }),
      literature: sortedLiterature.map((item) => defined({
        ref: refs.get(refKey("literature", item.id))!,
        title: item.title,
        authors: item.authors,
        year: item.year,
        venue: item.venue,
        publicationType: item.publicationType,
        abstract: item.abstract,
        keywords: item.keywords,
        doi: item.doi,
        url: item.url,
        readingStatus: item.readingStatus,
        importance: item.importance,
        tags: item.tags
      })),
      reviews: sortedReviews.map((review) => {
        const targets = (reviewTargetsByReview.get(review.id) ?? [])
          .map((link) => {
            const type = ENTITY_LINK_TYPE_TO_IMPORT_TYPE[link.targetType];
            if (!type || !isReviewTargetType(type)) {
              return undefined;
            }
            const ref = refs.get(refKey(type, link.targetId));
            return ref ? defined({ type, ref, description: link.description }) : undefined;
          })
          .filter((target): target is NonNullable<typeof target> => Boolean(target))
          .sort((left, right) => `${left.type}:${left.ref}`.localeCompare(`${right.type}:${right.ref}`));
        relationshipCounts.reviewTarget += targets.length;
        return defined({
          ref: refs.get(refKey("review", review.id))!,
          title: review.title,
          description: review.description,
          reviewType: review.reviewType,
          periodStart: review.periodStart,
          periodEnd: review.periodEnd,
          periodLabel: review.periodLabel,
          outlineSections: review.outlineSections,
          targets,
          tags: review.tags
        });
      }),
      resultItems: supportedResultItems.map((item) => {
        const sourceType = RESULT_SOURCE_TYPE_TO_IMPORT_TYPE[
          item.sourceType as keyof typeof RESULT_SOURCE_TYPE_TO_IMPORT_TYPE
        ];
        const sourceRef = sourceType ? refs.get(refKey(sourceType, item.sourceId)) : undefined;
        if (!sourceType || !sourceRef) {
          throw new Error(`ResultItem ${item.id} has no Import v1-compatible in-scope source.`);
        }
        relationshipCounts.resultItemSource += 1;
        const value = ["string", "number", "boolean"].includes(typeof item.value)
          ? item.value as string | number | boolean
          : undefined;
        return defined({
          ref: refs.get(refKey("resultItem", item.id))!,
          title: item.title,
          resultType: item.resultType,
          source: { type: sourceType, ref: sourceRef },
          experimentRef: item.experimentId
            ? refs.get(refKey("experiment", item.experimentId))
            : undefined,
          experimentRunRef: item.experimentRunId
            ? refs.get(refKey("experimentRun", item.experimentRunId))
            : undefined,
          status: item.status,
          structuredSummary: structuredSummary(item.structuredSummary),
          summary: item.summary,
          value,
          unit: item.unit,
          tags: item.tags,
          isAsset: item.isAsset,
          assetReason: item.assetReason,
          assetQuality: item.assetQuality,
          usableFor: item.usableFor
        });
      }),
      findings: findings.map((finding) => {
        const resultItemRefs = relationIds(
          outputRelations,
          "resultItem",
          "finding",
          finding.id,
          "evidence_for"
        ).flatMap((id) => refs.get(refKey("resultItem", id)) ?? []);
        relationshipCounts.findingResultItem += resultItemRefs.length;
        return defined({
          ref: refs.get(refKey("finding", finding.id))!,
          title: finding.title,
          experimentRef: finding.experimentId
            ? refs.get(refKey("experiment", finding.experimentId))
            : undefined,
          summary: finding.summary,
          status: finding.status,
          structuredSummary: structuredSummary(finding.structuredSummary),
          findingType: finding.findingType,
          confidence: finding.confidence,
          maturity: finding.maturity,
          tags: finding.tags,
          resultItemRefs
        });
      }),
      outputCandidates: outputCandidates.map((candidate) => {
        const findingRefs = relationIds(
          outputRelations,
          "finding",
          "outputCandidate",
          candidate.id,
          "supports"
        ).flatMap((id) => refs.get(refKey("finding", id)) ?? []);
        const resultItemRefs = relationIds(
          outputRelations,
          "resultItem",
          "outputCandidate",
          candidate.id,
          "uses"
        ).flatMap((id) => refs.get(refKey("resultItem", id)) ?? []);
        relationshipCounts.candidateFinding += findingRefs.length;
        relationshipCounts.candidateResultItem += resultItemRefs.length;
        return defined({
          ref: refs.get(refKey("outputCandidate", candidate.id))!,
          title: candidate.title,
          candidateType: candidate.candidateType,
          description: candidate.description,
          status: candidate.status,
          structuredSummary: structuredSummary(candidate.structuredSummary),
          maturity: candidate.maturity,
          priority: candidate.priority,
          tags: candidate.tags,
          findingRefs,
          resultItemRefs
        });
      }),
      outputGaps: supportedGaps.map((gap) => {
        const candidateId = selectedGapCandidateByGap.get(gap.id);
        const outputCandidateRef = candidateId
          ? refs.get(refKey("outputCandidate", candidateId))
          : undefined;
        if (!outputCandidateRef) {
          throw new Error(`OutputGap ${gap.id} has no Import v1-compatible OutputCandidate.`);
        }
        relationshipCounts.gapCandidate += 1;
        return defined({
          ref: refs.get(refKey("outputGap", gap.id))!,
          title: gap.title,
          gapType: gap.gapType,
          outputCandidateRef,
          description: gap.description,
          status: gap.status,
          structuredSummary: structuredSummary(gap.structuredSummary),
          priority: gap.priority
        });
      }),
      researchOutputs: researchOutputs.map((output) => {
        const experimentRef = output.experimentId
          ? refs.get(refKey("experiment", output.experimentId))
          : undefined;
        if (experimentRef) relationshipCounts.researchOutputExperiment += 1;
        return defined({
          ref: refs.get(refKey("researchOutput", output.id))!,
          outputName: output.outputName,
          outputType: output.outputType,
          status: output.status,
          structuredSummary: structuredSummary(output.structuredSummary),
          usableForPaper: output.usableForPaper,
          description: output.description,
          experimentRef
        });
      })
    },
    relations: []
  };

  const explicit = mapExplicitRelations(entityLinks, refs);
  document.relations = explicit.relations;
  relationshipCounts.explicitEntityLink = explicit.relations.length;

  const serialized = `${JSON.stringify(document, null, 2)}\n`;
  const importPreflight = preflightProjectImportV1(serialized);
  if (!importPreflight.ok) {
    throw new Error(
      `The selected Project cannot be represented as a valid Import v1 payload: ${importPreflight.issues
        .map((issue) => `${issue.code} ${issue.path}: ${issue.message}`)
        .join("; ")}`
    );
  }

  const exportedObjectCounts = { ...importPreflight.preview.objectCounts };
  const totalRelationshipInstanceCount = Object.values(relationshipCounts)
    .reduce((total, count) => total + count, 0);
  const unsupportedOutputRelations = outputRelations.filter((relation) => {
    if (relation.sourceType === "resultItem" && relation.targetType === "finding" && relation.relationType === "evidence_for") {
      return !refs.has(refKey("resultItem", relation.sourceId)) || !refs.has(refKey("finding", relation.targetId));
    }
    if (relation.sourceType === "finding" && relation.targetType === "outputCandidate" && relation.relationType === "supports") {
      return !refs.has(refKey("finding", relation.sourceId)) || !refs.has(refKey("outputCandidate", relation.targetId));
    }
    if (relation.sourceType === "resultItem" && relation.targetType === "outputCandidate" && relation.relationType === "uses") {
      return !refs.has(refKey("resultItem", relation.sourceId)) || !refs.has(refKey("outputCandidate", relation.targetId));
    }
    if (relation.sourceType === "outputGap" && relation.targetType === "outputCandidate" && relation.relationType === "blocks") {
      return selectedGapCandidateByGap.get(relation.sourceId) !== relation.targetId;
    }
    return true;
  }).length;
  const unsupportedReviewTargets = entityLinks.filter((link) => {
    if (link.sourceType !== "review" || link.relationType !== "summarizes") return false;
    if (!refs.has(refKey("review", link.sourceId))) return false;
    const targetType = ENTITY_LINK_TYPE_TO_IMPORT_TYPE[link.targetType];
    return !targetType || !isReviewTargetType(targetType) || !refs.has(refKey(targetType, link.targetId));
  }).length;
  const unsupportedResultItems = resultItemsInProject.length - supportedResultItems.length;
  const unsupportedGaps = outputGapsInProject.length - supportedGaps.length;
  const unsupportedExperimentRuns = allRuns.filter((run) => run.projectId === project.id).length -
    experimentRuns.length;
  const structuredValueOmissions = supportedResultItems.filter(
    (item) => item.value !== undefined && !["string", "number", "boolean"].includes(typeof item.value)
  ).length;
  const omittedSourceFactCount =
    explicit.omitted + unsupportedOutputRelations + unsupportedReviewTargets +
    unsupportedExperimentRuns + unsupportedResultItems +
    unsupportedGaps + structuredValueOmissions;

  return {
    document,
    serialized,
    defaultFileName: `sciloom-project-${sanitizeFileName(project.title)}-import-v1.json`,
    importPreflight,
    scope: {
      supportedEntityTypeCount: IMPORT_V1_OBJECT_TYPES.length,
      exportedObjectCounts,
      totalObjectCount: importPreflight.preview.totalObjectCount,
      supportedRelationshipTypeCount: SUPPORTED_RELATIONSHIP_FAMILIES.length,
      relationshipInstanceCounts: relationshipCounts,
      totalRelationshipInstanceCount,
      omittedEntityCounts: {
        experimentRuns: unsupportedExperimentRuns,
        resultItems: unsupportedResultItems,
        outputGaps: unsupportedGaps
      },
      omittedSourceFactCount,
      omittedSourceFacts: [
        "Service-owned IDs, timestamps, schema metadata, OperationLog/Recovery facts, secrets, and runtime state",
        "FileRef identities, manuscript/file bodies, attachments, PDFs, images, raw data, and machine-specific paths",
        "Experiment route/task placement and other source relationships that Project Import v1 does not accept",
        "Literature external IDs and local file locations",
        "Output conversion relations outside Import v1 finding/result/candidate/gap reference fields",
        "Cross-Project or unsupported EntityLink endpoints"
      ]
    }
  };
}

export async function savePreparedProjectExportV1(
  prepared: PreparedProjectExportV1,
  dependencies: SavePreparedProjectExportV1Dependencies = productionSaveDependencies
) {
  return dependencies.saveTextFile(
    prepared.defaultFileName,
    prepared.serialized,
    "application/json"
  );
}

export const projectExportV1Service = {
  prepare: prepareProjectExportV1,
  savePrepared: savePreparedProjectExportV1
} as const;
