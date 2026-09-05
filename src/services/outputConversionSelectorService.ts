import { experimentRunService } from "./experimentRunService";
import { experimentService } from "./experimentService";
import { fileRefService } from "./fileRefService";
import { milestoneService } from "./milestoneService";
import { outputConversionService } from "./outputConversionService";
import { outputConversionRelationService } from "./outputConversionRelationService";
import { outputService } from "./outputService";
import { getPlanningData } from "./planningRepository";
import { resultMetricService } from "./resultMetricService";
import { taskService } from "./taskService";
import { getOutputCandidateEvidenceChain } from "./outputChainAggregationService";
import type { EntityId } from "../types";
import type { OutputChainDto, OutputChainNode } from "../types/outputChain";
import type {
  Experiment,
  ExperimentRun,
  FileRef,
  Milestone,
  ResearchTask,
  ResultMetric
} from "../types";
import type { Project } from "../types/planning";
import type {
  EvidenceChainNode,
  EvidenceChainDTO,
  EvidenceChainNodeDTO,
  Finding,
  FindingDetailDTO,
  OutputCandidate,
  OutputCandidateAIContextDTO,
  OutputCandidateDetailDTO,
  OutputConversionContextWarning,
  OutputConversionMissingReference,
  OutputConversionReferenceSummary,
  OutputConversionSummaryDTO,
  OutputGapFeedbackDTO,
  FormalOutputProvenanceDTO,
  OutputGap,
  ResultAsset,
  ResultAssetQuality,
  ResultItem,
  ResultItemType
} from "../types/outputConversion";
import {
  buildOutputCanonicalPresentationSummary,
  readOutputDirectCanonicalValue
} from "./outputCanonicalValueCoherenceService";

export type ResultAssetQueryOptions = {
  projectId?: EntityId;
  routeId?: EntityId;
  taskId?: EntityId;
  experimentId?: EntityId;
  experimentRunId?: EntityId;
  resultType?: ResultItemType;
  assetQuality?: ResultAssetQuality;
  tags?: string[];
  keyword?: string;
};

export type FindingQueryOptions = {
  projectId?: EntityId;
  routeId?: EntityId;
  taskId?: EntityId;
  experimentId?: EntityId;
  resultItemId?: EntityId;
  tags?: string[];
  keyword?: string;
};

export type OutputCandidateQueryOptions = {
  projectId?: EntityId;
  routeId?: EntityId;
  taskId?: EntityId;
  findingId?: EntityId;
  resultItemId?: EntityId;
  status?: OutputCandidate["status"];
  candidateType?: OutputCandidate["candidateType"];
  tags?: string[];
  keyword?: string;
};

export type OutputConversionOverviewOptions = {
  projectId?: EntityId;
};

export type ResultItemSourceContext = {
  resultItem: ResultItem;
  experiment?: Experiment | null;
  run?: ExperimentRun | null;
  metric?: ResultMetric | null;
  fileRef?: FileRef | null;
  project?: Project | null;
  route?: Milestone | null;
  task?: ResearchTask | null;
};

export type ResultAssetDetailContext = {
  asset: ResultAsset;
  sourceContext: ResultItemSourceContext;
  findings: Finding[];
  candidates: OutputCandidate[];
};

export type FindingDetailContext = {
  finding: Finding;
  resultItems: ResultItem[];
  assets: ResultAsset[];
  sourceContexts: ResultItemSourceContext[];
  candidates: OutputCandidate[];
};

export type OutputCandidateDetailContext = {
  candidate: OutputCandidate;
  findings: Finding[];
  resultItems: ResultItem[];
  assets: ResultAsset[];
  sourceContexts: ResultItemSourceContext[];
  gaps: OutputGap[];
  evidenceChain: EvidenceChainNode;
};

export type OutputConversionOverview = {
  resultItemCount: number;
  assetCount: number;
  findingCount: number;
  outputCandidateCount: number;
  outputGapCount: number;
  openGapCount: number;
  readyCandidateCount: number;
  convertedCandidateCount: number;
};

function createWarning(
  code: string,
  message: string,
  entityType?: string,
  entityId?: EntityId
): OutputConversionContextWarning {
  return { code, message, entityType, entityId };
}

function missingReference(
  sourceType: string,
  sourceId: EntityId,
  targetType: string,
  targetId: EntityId,
  relationType: string,
  reason: string
): OutputConversionMissingReference {
  return { sourceType, sourceId, targetType, targetId, relationType, reason };
}

function referenceSummary(
  item: ResultItem | ResultAsset | Finding | OutputCandidate | OutputGap
): OutputConversionReferenceSummary {
  if ("resultType" in item) {
    return {
      id: item.id,
      title: item.title,
      summary: item.summary,
      type: item.resultType,
      status: item.isAsset ? "asset" : undefined
    };
  }
  if ("candidateType" in item) {
    return {
      id: item.id,
      title: item.title,
      summary: item.description,
      type: item.candidateType,
      status: item.status
    };
  }
  if ("gapType" in item) {
    return {
      id: item.id,
      title: item.title,
      summary: item.description,
      type: item.gapType,
      status: item.status
    };
  }
  return {
    id: item.id,
    title: item.title,
    summary: item.summary,
    type: item.findingType,
    status: item.status
  };
}

function evidenceNodeToDTO(node: EvidenceChainNode): EvidenceChainNodeDTO {
  return {
    id: node.id,
    nodeType: node.type,
    title: node.title,
    summary: node.description,
    relationType: node.relationType,
    children: node.children?.map(evidenceNodeToDTO)
  };
}

function flattenEvidenceNodes(node: EvidenceChainNodeDTO): EvidenceChainNodeDTO[] {
  return [node, ...(node.children ?? []).flatMap(flattenEvidenceNodes)];
}

function gapToFeedbackDTO(gap: OutputGap, candidateId: EntityId): OutputGapFeedbackDTO {
  const finalStatus = gap.status === "resolved" || gap.status === "abandoned";
  return {
    gapId: gap.id,
    candidateId,
    status: gap.status,
    priority: gap.priority,
    description: gap.description,
    relatedTaskId: gap.relatedTaskId,
    relatedRouteNodeId: gap.relatedRouteNodeId,
    canCreateTask: !finalStatus && !gap.relatedTaskId,
    canCreateRouteNode: !finalStatus && !gap.relatedRouteNodeId,
    canResolveFromTask: !finalStatus && Boolean(gap.relatedTaskId),
    requiresUserConfirmation: true,
    warnings: [],
    missingReferences: []
  };
}

type ReferenceData = {
  projects: Project[];
  routes: Milestone[];
  tasks: ResearchTask[];
};

function uniqueIds(ids: Array<EntityId | null | undefined>) {
  return [...new Set(ids.filter((id): id is EntityId => Boolean(id)))];
}

async function getFindingResultItemIds(findingId: EntityId) {
  const relations = await outputConversionRelationService.queryOutputConversionRelations({
    sourceType: "resultItem",
    targetType: "finding",
    targetId: findingId,
    relationType: "evidence_for"
  });
  return uniqueIds(relations.map((relation) => relation.sourceId));
}

async function getCandidateFindingIds(candidateId: EntityId) {
  const relations = await outputConversionRelationService.queryOutputConversionRelations({
    sourceType: "finding",
    targetType: "outputCandidate",
    targetId: candidateId,
    relationType: "supports"
  });
  return uniqueIds(relations.map((relation) => relation.sourceId));
}

async function getCandidateDirectResultItemIds(candidateId: EntityId) {
  const relations = await outputConversionRelationService.queryOutputConversionRelations({
    sourceType: "resultItem",
    targetType: "outputCandidate",
    targetId: candidateId,
    relationType: "uses"
  });
  return uniqueIds(relations.map((relation) => relation.sourceId));
}

async function getCandidateEvidenceIds(candidateId: EntityId) {
  const findingIds = await getCandidateFindingIds(candidateId);
  const findingResultItemIds = (
    await Promise.all(findingIds.map((findingId) => getFindingResultItemIds(findingId)))
  ).flat();
  const directResultItemIds = await getCandidateDirectResultItemIds(candidateId);
  return {
    findingIds,
    directResultItemIds,
    resultItemIds: uniqueIds([...directResultItemIds, ...findingResultItemIds])
  };
}

async function getGapCandidateId(gapId: EntityId) {
  const relation = (
    await outputConversionRelationService.queryOutputConversionRelations({
      sourceType: "outputGap",
      sourceId: gapId,
      targetType: "outputCandidate",
      relationType: "blocks"
    })
  )[0];
  return relation?.targetId ?? null;
}

async function getGapResolvedByResultItemId(gapId: EntityId) {
  const relation = (
    await outputConversionRelationService.queryOutputConversionRelations({
      sourceType: "resultItem",
      targetType: "outputGap",
      targetId: gapId,
      relationType: "resolves"
    })
  )[0];
  return relation?.sourceId ?? null;
}

async function getConvertedOutputId(candidateId: EntityId) {
  const relation = (
    await outputConversionRelationService.queryOutputConversionRelations({
      sourceType: "outputCandidate",
      sourceId: candidateId,
      targetType: "researchOutput",
      relationType: "converted_to"
    })
  )[0];
  return relation?.targetId ?? null;
}

function referenceKey(reference: OutputConversionMissingReference) {
  return [
    reference.sourceType,
    reference.sourceId,
    reference.targetType,
    reference.targetId,
    reference.relationType,
    reference.reason
  ].join(":");
}

function uniqueMissingReferences(
  references: OutputConversionMissingReference[]
): OutputConversionMissingReference[] {
  const byKey = new Map<string, OutputConversionMissingReference>();
  for (const reference of references) {
    byKey.set(referenceKey(reference), reference);
  }
  return [...byKey.values()];
}

function includesAllTags(itemTags: string[], queryTags?: string[]) {
  if (!queryTags || queryTags.length === 0) {
    return true;
  }

  const normalized = new Set(itemTags.map((tag) => tag.toLowerCase()));
  return queryTags.every((tag) => normalized.has(tag.toLowerCase()));
}

function textMatches(fields: unknown[], keyword?: string) {
  const normalized = keyword?.trim().toLowerCase();
  if (!normalized) {
    return true;
  }

  return fields.some((field) =>
    field === undefined || field === null
      ? false
      : String(field).toLowerCase().includes(normalized)
  );
}

function isResultAsset(item: ResultItem): item is ResultAsset {
  return item.isAsset === true;
}

async function loadReferenceData(): Promise<ReferenceData> {
  const [planningData, routes, tasks] = await Promise.all([
    getPlanningData(),
    milestoneService.listMilestones(),
    taskService.listTasks()
  ]);
  const projects = planningData.projects.filter((project) => !project.deletedAt);

  return { projects, routes, tasks };
}

function resolveProject(projects: Project[], projectId?: EntityId | null) {
  return projectId ? projects.find((project) => project.id === projectId) ?? null : null;
}

function resolveTask(tasks: ResearchTask[], taskId?: EntityId | null) {
  return taskId ? tasks.find((task) => task.id === taskId) ?? null : null;
}

function resolveRoute(
  routes: Milestone[],
  routeId?: EntityId | null,
  task?: ResearchTask | null
) {
  const actualRouteId = routeId ?? task?.milestoneId;
  return actualRouteId ? routes.find((route) => route.id === actualRouteId) ?? null : null;
}

async function resolveResultItemSourceContext(
  resultItem: ResultItem,
  referenceData?: ReferenceData
): Promise<ResultItemSourceContext> {
  const refs = referenceData ?? (await loadReferenceData());
  let experiment: Experiment | null = null;
  let run: ExperimentRun | null = null;
  let metric: ResultMetric | null = null;
  let fileRef: FileRef | null = null;

  if (resultItem.sourceType === "experiment") {
    experiment = (await experimentService.getExperimentById(resultItem.sourceId)) ?? null;
  }

  if (resultItem.sourceType === "experimentRun") {
    run = (await experimentRunService.getRunById(resultItem.sourceId)) ?? null;
    experiment = run
      ? (await experimentService.getExperimentById(run.experimentId)) ?? null
      : null;
  }

  if (resultItem.sourceType === "resultMetric") {
    metric = (await resultMetricService.getById(resultItem.sourceId)) ?? null;
    run = metric ? (await experimentRunService.getRunById(metric.runId)) ?? null : null;
    experiment = metric?.experimentId
      ? (await experimentService.getExperimentById(metric.experimentId)) ?? null
      : run
        ? (await experimentService.getExperimentById(run.experimentId)) ?? null
        : null;
  }

  if (resultItem.sourceType === "fileRef") {
    fileRef = (await fileRefService.getById(resultItem.sourceId)) ?? null;
    run =
      fileRef?.ownerType === "experimentRun"
        ? (await experimentRunService.getRunById(fileRef.ownerId)) ?? null
        : null;
    experiment = fileRef?.ownerType === "experiment"
        ? (await experimentService.getExperimentById(fileRef.ownerId)) ?? null
        : run
          ? (await experimentService.getExperimentById(run.experimentId)) ?? null
          : null;
  }

  if (!experiment && resultItem.experimentId) {
    experiment = (await experimentService.getExperimentById(resultItem.experimentId)) ?? null;
  }

  if (!run && resultItem.experimentRunId) {
    run = (await experimentRunService.getRunById(resultItem.experimentRunId)) ?? null;
  }

  if (!fileRef && resultItem.fileRefId) {
    fileRef = (await fileRefService.getById(resultItem.fileRefId)) ?? null;
  }

  const task = resolveTask(refs.tasks, resultItem.taskId ?? run?.taskId ?? experiment?.taskId);
  const project = resolveProject(
    refs.projects,
    resultItem.projectId ?? run?.projectId ?? experiment?.projectId
  );
  const route = resolveRoute(
    refs.routes,
    resultItem.routeId ?? run?.routeId ?? experiment?.routeId,
    task
  );

  return {
    resultItem,
    experiment,
    run,
    metric,
    fileRef,
    project,
    route,
    task
  };
}

function resultItemMatchesOptions(item: ResultItem, options: ResultAssetQueryOptions) {
  return (
    item.isAsset === true &&
    (!options.projectId || item.projectId === options.projectId) &&
    (!options.routeId || item.routeId === options.routeId) &&
    (!options.taskId || item.taskId === options.taskId) &&
    (!options.experimentId || item.experimentId === options.experimentId) &&
    (!options.experimentRunId || item.experimentRunId === options.experimentRunId) &&
    (!options.resultType || item.resultType === options.resultType) &&
    (!options.assetQuality || item.assetQuality === options.assetQuality) &&
    includesAllTags(item.tags, options.tags) &&
    textMatches(
      [
        item.title,
        item.summary,
        item.assetReason,
        item.resultType,
        item.sourceType,
        ...item.tags
      ],
      options.keyword
    )
  );
}

function findingMatchesOptions(finding: Finding, options: FindingQueryOptions) {
  return (
    (!options.projectId || finding.projectId === options.projectId) &&
    (!options.routeId || finding.routeId === options.routeId) &&
    (!options.taskId || finding.taskId === options.taskId) &&
    (!options.experimentId || finding.experimentId === options.experimentId) &&
    includesAllTags(finding.tags, options.tags) &&
    textMatches(
      [
        finding.title,
        finding.summary,
        finding.findingType,
        finding.confidence,
        finding.status,
        finding.maturity,
        ...finding.tags
      ],
      options.keyword
    )
  );
}

function candidateMatchesOptions(candidate: OutputCandidate, options: OutputCandidateQueryOptions) {
  return (
    (!options.projectId || candidate.projectId === options.projectId) &&
    (!options.routeId || candidate.routeId === options.routeId) &&
    (!options.taskId || candidate.taskId === options.taskId) &&
    (!options.status || candidate.status === options.status) &&
    (!options.candidateType || candidate.candidateType === options.candidateType) &&
    includesAllTags(candidate.tags, options.tags) &&
    textMatches(
      [
        candidate.title,
        candidate.description,
        candidate.candidateType,
        candidate.status,
        candidate.maturity,
        candidate.priority,
        ...candidate.tags
      ],
      options.keyword
    )
  );
}

export async function queryResultAssets(
  options: ResultAssetQueryOptions = {}
): Promise<ResultAsset[]> {
  const resultItems = await outputConversionService.listResultItems();
  return resultItems.filter((item): item is ResultAsset => resultItemMatchesOptions(item, options));
}

export async function getFindingsByResultItem(resultItemId: EntityId) {
  const relations = await outputConversionRelationService.queryOutputConversionRelations({
    sourceType: "resultItem",
    sourceId: resultItemId,
    targetType: "finding",
    relationType: "evidence_for"
  });
  const findings = await Promise.all(
    relations.map((relation) => outputConversionService.getFindingById(relation.targetId))
  );
  return findings.filter((finding): finding is Finding => Boolean(finding));
}

export async function getCandidatesByFinding(findingId: EntityId) {
  const relations = await outputConversionRelationService.queryOutputConversionRelations({
    sourceType: "finding",
    sourceId: findingId,
    targetType: "outputCandidate",
    relationType: "supports"
  });
  const candidates = await Promise.all(
    relations.map((relation) => outputConversionService.getOutputCandidateById(relation.targetId))
  );
  return candidates.filter((candidate): candidate is OutputCandidate => Boolean(candidate));
}

async function getCandidatesByResultItem(resultItemId: EntityId) {
  const relations = await outputConversionRelationService.queryOutputConversionRelations({
    sourceType: "resultItem",
    sourceId: resultItemId,
    targetType: "outputCandidate",
    relationType: "uses"
  });
  const candidates = await Promise.all(
    relations.map((relation) => outputConversionService.getOutputCandidateById(relation.targetId))
  );
  return candidates.filter((candidate): candidate is OutputCandidate => Boolean(candidate));
}

export async function getGapsByCandidate(candidateId: EntityId) {
  return outputConversionService.queryGapsByCandidate(candidateId);
}

export async function getResultAssetDetail(
  resultItemId: EntityId
): Promise<ResultAssetDetailContext | null> {
  const resultItem = await outputConversionService.getResultItemById(resultItemId);
  if (!resultItem || !isResultAsset(resultItem)) {
    return null;
  }

  const [sourceContext, findings, directCandidates] = await Promise.all([
    resolveResultItemSourceContext(resultItem),
    getFindingsByResultItem(resultItem.id),
    getCandidatesByResultItem(resultItem.id)
  ]);
  const findingCandidates = (
    await Promise.all(findings.map((finding) => getCandidatesByFinding(finding.id)))
  ).flat();
  const candidateMap = new Map(
    [...directCandidates, ...findingCandidates].map((candidate) => [candidate.id, candidate])
  );

  return {
    asset: resultItem,
    sourceContext,
    findings,
    candidates: [...candidateMap.values()]
  };
}

export async function queryFindings(options: FindingQueryOptions = {}) {
  const findings = await outputConversionService.listFindings();
  const relationFilteredIds = options.resultItemId
    ? new Set((await getFindingsByResultItem(options.resultItemId)).map((finding) => finding.id))
    : null;
  return findings.filter(
    (finding) =>
      findingMatchesOptions(finding, options) &&
      (!relationFilteredIds || relationFilteredIds.has(finding.id))
  );
}

export async function getFindingDetailContext(
  findingId: EntityId
): Promise<FindingDetailContext | null> {
  const finding = await outputConversionService.getFindingById(findingId);
  if (!finding) {
    return null;
  }

  const resultItemIds = await getFindingResultItemIds(finding.id);
  const resultItems = (
    await Promise.all(resultItemIds.map((id) => outputConversionService.getResultItemById(id)))
  ).filter((item): item is ResultItem => Boolean(item));
  const referenceData = await loadReferenceData();
  const [sourceContexts, candidates] = await Promise.all([
    Promise.all(resultItems.map((item) => resolveResultItemSourceContext(item, referenceData))),
    getCandidatesByFinding(finding.id)
  ]);

  return {
    finding,
    resultItems,
    assets: resultItems.filter(isResultAsset),
    sourceContexts,
    candidates
  };
}

export async function getFindingDetailDTO(
  findingId: EntityId
): Promise<FindingDetailDTO | null> {
  const context = await getFindingDetailContext(findingId);
  if (!context) {
    return null;
  }

  const linkedResultIds = new Set(await getFindingResultItemIds(context.finding.id));
  const returnedResultIds = new Set(context.resultItems.map((item) => item.id));
  const missingReferences = [...linkedResultIds]
    .filter((id) => !returnedResultIds.has(id))
    .map((id) =>
      missingReference(
        "finding",
        context.finding.id,
        "resultItem",
        id,
        "evidence_for",
        "Linked result item was not found."
      )
    );
  const warnings = missingReferences.length
    ? [
        createWarning(
          "missing_linked_result_item",
          "Some linked result items were not found.",
          "finding",
          context.finding.id
        )
      ]
    : [];

  return {
    id: context.finding.id,
    title: context.finding.title,
    summary: context.finding.summary,
    findingType: context.finding.findingType,
    status: context.finding.status,
    structuredSummary: buildOutputCanonicalPresentationSummary(
      "finding",
      readOutputDirectCanonicalValue("finding", context.finding),
      context.finding.structuredSummary
    ),
    linkedResultItemSummaries: context.resultItems.filter((item) => !item.isAsset).map(referenceSummary),
    linkedAssetSummaries: context.assets.map(referenceSummary),
    linkedCandidateIds: context.candidates.map((candidate) => candidate.id),
    warnings,
    missingReferences,
    partial: warnings.length > 0 || missingReferences.length > 0
  };
}

export async function queryOutputCandidates(options: OutputCandidateQueryOptions = {}) {
  const candidates = await outputConversionService.listOutputCandidates();
  const byFinding = options.findingId
    ? new Set((await getCandidatesByFinding(options.findingId)).map((candidate) => candidate.id))
    : null;
  const byResultItem = options.resultItemId
    ? new Set(
        (await getCandidatesByResultItem(options.resultItemId)).map((candidate) => candidate.id)
      )
    : null;
  return candidates.filter(
    (candidate) =>
      candidateMatchesOptions(candidate, options) &&
      (!byFinding || byFinding.has(candidate.id)) &&
      (!byResultItem || byResultItem.has(candidate.id))
  );
}

function legacyEvidenceTree(chain: OutputChainDto): EvidenceChainNode | null {
  const byId = new Map(chain.nodes.map((node) => [node.id, node]));
  const adjacency = new Map<
    string,
    Array<{ nodeId: string; relationType: string }>
  >();
  const connect = (from: string, to: string, relationType: string) => {
    const entries = adjacency.get(from) ?? [];
    entries.push({ nodeId: to, relationType });
    adjacency.set(from, entries);
  };
  for (const edge of chain.edges) {
    connect(edge.sourceNodeId, edge.targetNodeId, edge.relationType);
    connect(edge.targetNodeId, edge.sourceNodeId, edge.relationType);
  }
  const build = (
    node: OutputChainNode,
    relationType: string | undefined,
    path: Set<string>
  ): EvidenceChainNode => {
    const nextPath = new Set(path);
    nextPath.add(node.id);
    const children = (adjacency.get(node.id) ?? [])
      .filter((entry) => !nextPath.has(entry.nodeId))
      .map((entry) => {
        const child = byId.get(entry.nodeId);
        return child ? build(child, entry.relationType, nextPath) : null;
      })
      .filter((child): child is EvidenceChainNode => Boolean(child));
    return {
      id: node.entityId ?? node.id,
      type: node.type as EvidenceChainNode["type"],
      title: node.label,
      description: node.summary,
      relationType,
      children: children.length > 0 ? children : undefined
    };
  };
  const root = byId.get(chain.root.id);
  return root ? build(root, undefined, new Set()) : null;
}

export async function getCandidateEvidenceChain(
  candidateId: EntityId
): Promise<EvidenceChainNode | null> {
  const chain = await getOutputCandidateEvidenceChain(candidateId);
  return chain.boundary.missing ? null : legacyEvidenceTree(chain);
}

export async function getCandidateEvidenceChainDTO(
  candidateId: EntityId
): Promise<EvidenceChainDTO | null> {
  const chain = await getOutputCandidateEvidenceChain(candidateId);
  if (chain.boundary.missing) {
    return null;
  }
  const evidenceChain = legacyEvidenceTree(chain);
  if (!evidenceChain) {
    return null;
  }

  const rootNode = evidenceNodeToDTO(evidenceChain);
  const warnings = chain.boundary.warnings.map((message, index) =>
    createWarning(
      `output_chain_${index + 1}`,
      message,
      "outputCandidate",
      candidateId
    )
  );
  const missingReferences = chain.nodes
    .filter((node) => node.missing)
    .map((node) =>
      missingReference(
        "outputCandidate",
        candidateId,
        node.type,
        node.entityId ?? node.id,
        "chain",
        "Chain relation target was not found."
      )
    );
  return {
    candidateId,
    rootNode,
    nodes: flattenEvidenceNodes(rootNode),
    warnings,
    missingReferences,
    partial: chain.boundary.partial
  };
}

export async function getOutputCandidateDetailContext(
  candidateId: EntityId
): Promise<OutputCandidateDetailContext | null> {
  const candidate = await outputConversionService.getOutputCandidateById(candidateId);
  if (!candidate) {
    return null;
  }

  const candidateEvidenceIds = await getCandidateEvidenceIds(candidate.id);
  const findings = (
    await Promise.all(candidateEvidenceIds.findingIds.map((id) => outputConversionService.getFindingById(id)))
  ).filter((finding): finding is Finding => Boolean(finding));
  const resultItemIds = candidateEvidenceIds.resultItemIds;
  const resultItems = (
    await Promise.all(resultItemIds.map((id) => outputConversionService.getResultItemById(id)))
  ).filter((item): item is ResultItem => Boolean(item));
  const referenceData = await loadReferenceData();
  const [sourceContexts, gaps, evidenceChain] = await Promise.all([
    Promise.all(resultItems.map((item) => resolveResultItemSourceContext(item, referenceData))),
    getGapsByCandidate(candidate.id),
    getCandidateEvidenceChain(candidate.id)
  ]);

  return {
    candidate,
    findings,
    resultItems,
    assets: resultItems.filter(isResultAsset),
    sourceContexts,
    gaps,
    evidenceChain: evidenceChain ?? {
      id: candidate.id,
      type: "outputCandidate",
      title: candidate.title,
      description: candidate.description,
      children: []
    }
  };
}

async function buildFormalOutputProvenanceDTO(
  candidate: OutputCandidate,
  gaps: OutputGap[]
): Promise<FormalOutputProvenanceDTO> {
  const outputId = await getConvertedOutputId(candidate.id);
  const output = outputId ? (await outputService.getById(outputId)) ?? null : null;
  const evidenceIds = await getCandidateEvidenceIds(candidate.id);
  const resultItems = (
    await Promise.all(
      evidenceIds.resultItemIds.map((id) => outputConversionService.getResultItemById(id))
    )
  ).filter((item): item is ResultItem => Boolean(item));
  const warnings =
    outputId && !output
      ? [
          createWarning(
            "missing_formal_output",
            "Candidate converted_to relation points to a formal output that was not found.",
            "outputCandidate",
            candidate.id
          )
        ]
      : [];

  return {
    outputId: output?.id ?? outputId ?? null,
    outputName: output?.outputName ?? null,
    outputType: output?.outputType ?? null,
    sourceCandidateId: output?.provenance?.sourceCandidateId ?? candidate.id,
    sourceCandidateTitle: output?.provenance?.sourceCandidateTitle ?? candidate.title,
    sourceCandidateType: output?.provenance?.sourceCandidateType ?? candidate.candidateType,
    convertedAt: output?.provenance?.convertedAt ?? null,
    confirmedByUser: output?.provenance?.confirmedByUser,
    evidenceSummary: output?.provenance?.evidenceSummary ?? null,
    linkedFindingIds: evidenceIds.findingIds,
    linkedResultItemIds: evidenceIds.resultItemIds,
    linkedAssetIds: resultItems.filter((item) => item.isAsset).map((item) => item.id),
    outputGapIds: gaps.map((gap) => gap.id),
    warnings
  };
}

export async function getOutputCandidateDetailDTO(
  candidateId: EntityId
): Promise<OutputCandidateDetailDTO | null> {
  const context = await getOutputCandidateDetailContext(candidateId);
  if (!context) {
    return null;
  }

  const evidenceChain = await getCandidateEvidenceChainDTO(candidateId);
  const fallbackRoot = evidenceNodeToDTO(context.evidenceChain);
  const evidenceChainDTO = evidenceChain ?? {
    candidateId,
    rootNode: fallbackRoot,
    nodes: flattenEvidenceNodes(fallbackRoot),
    warnings: [createWarning("partial_evidence_chain", "Evidence chain fallback was generated.", "outputCandidate", candidateId)],
    missingReferences: [],
    partial: true
  };
  const evidenceIds = await getCandidateEvidenceIds(context.candidate.id);
  const findingIds = new Set(evidenceIds.findingIds);
  const returnedFindingIds = new Set(context.findings.map((finding) => finding.id));
  const resultIds = new Set(evidenceIds.directResultItemIds);
  const returnedResultIds = new Set(context.resultItems.map((item) => item.id));
  const missingReferences: OutputConversionMissingReference[] = [
    ...[...findingIds]
      .filter((id) => !returnedFindingIds.has(id))
      .map((id) =>
        missingReference("outputCandidate", context.candidate.id, "finding", id, "supports", "Linked finding was not found.")
      ),
    ...[...resultIds]
      .filter((id) => !returnedResultIds.has(id))
      .map((id) =>
        missingReference("outputCandidate", context.candidate.id, "resultItem", id, "uses", "Linked result item was not found.")
      )
  ];
  const formalOutputProvenance = await buildFormalOutputProvenanceDTO(context.candidate, context.gaps);
  const warnings: OutputConversionContextWarning[] = [
    ...formalOutputProvenance.warnings,
    ...(missingReferences.length
      ? [
          createWarning(
            "missing_candidate_references",
            "Some candidate references were not found.",
            "outputCandidate",
            context.candidate.id
          )
        ]
      : [])
  ];
  const combinedWarnings = [...warnings, ...evidenceChainDTO.warnings];
  const combinedMissingReferences = uniqueMissingReferences([
    ...missingReferences,
    ...evidenceChainDTO.missingReferences
  ]);

  return {
    id: context.candidate.id,
    title: context.candidate.title,
    candidateType: context.candidate.candidateType,
    status: context.candidate.status,
    formalOutputId: formalOutputProvenance.outputId ?? null,
    projectId: context.candidate.projectId,
    taskId: context.candidate.taskId,
    summary: context.candidate.description,
    structuredSummary: buildOutputCanonicalPresentationSummary(
      "outputCandidate",
      readOutputDirectCanonicalValue("outputCandidate", context.candidate),
      context.candidate.structuredSummary
    ),
    linkedFindingSummaries: context.findings.map(referenceSummary),
    linkedResultItemSummaries: context.resultItems.filter((item) => !item.isAsset).map(referenceSummary),
    linkedAssetSummaries: context.assets.map(referenceSummary),
    evidenceChain: evidenceChainDTO,
    openGapSummaries: context.gaps
      .filter((gap) => !["resolved", "abandoned"].includes(gap.status))
      .map((gap) => gapToFeedbackDTO(gap, context.candidate.id)),
    formalOutputProvenance,
    warnings: combinedWarnings,
    missingReferences: combinedMissingReferences,
    partial:
      combinedWarnings.length > 0 ||
      combinedMissingReferences.length > 0 ||
      formalOutputProvenance.warnings.length > 0 ||
      evidenceChainDTO.partial,
    updatedAt: context.candidate.updatedAt
  };
}

export async function buildOutputCandidateAIContextDTO(
  candidateId: EntityId
): Promise<OutputCandidateAIContextDTO | null> {
  const detail = await getOutputCandidateDetailDTO(candidateId);
  if (!detail) {
    return null;
  }

  return {
    candidate: {
      id: detail.id,
      title: detail.title,
      candidateType: detail.candidateType,
      status: detail.status,
      formalOutputId: detail.formalOutputId,
      summary: detail.summary,
      structuredSummary: detail.structuredSummary
    },
    findings: detail.linkedFindingSummaries,
    resultItems: detail.linkedResultItemSummaries,
    assets: detail.linkedAssetSummaries,
    evidenceChainSummary: detail.evidenceChain,
    openOutputGaps: detail.openGapSummaries,
    formalOutputProvenance: detail.formalOutputProvenance,
    warnings: detail.warnings,
    missingReferences: detail.missingReferences,
    partial: detail.partial
  };
}

export async function queryOutputConversionOverview(
  options: OutputConversionOverviewOptions = {}
): Promise<OutputConversionOverview> {
  const [resultItems, findings, candidates, gaps] = await Promise.all([
    outputConversionService.listResultItems(),
    outputConversionService.listFindings(),
    outputConversionService.listOutputCandidates(),
    outputConversionService.listOutputGaps()
  ]);
  const projectMatches = <T extends { projectId: EntityId }>(item: T) =>
    !options.projectId || item.projectId === options.projectId;
  const scopedResultItems = resultItems.filter(projectMatches);
  const scopedCandidates = candidates.filter(projectMatches);
  const scopedGaps = gaps.filter(projectMatches);

  return {
    resultItemCount: scopedResultItems.length,
    assetCount: scopedResultItems.filter((item) => item.isAsset).length,
    findingCount: findings.filter(projectMatches).length,
    outputCandidateCount: scopedCandidates.length,
    outputGapCount: scopedGaps.length,
    openGapCount: scopedGaps.filter((gap) => gap.status === "pending").length,
    readyCandidateCount: scopedCandidates.filter((candidate) => candidate.status === "ready_for_formal").length,
    convertedCandidateCount: scopedCandidates.filter(
      (candidate) => candidate.status === "converted"
    ).length
  };
}

export async function getOutputConversionSummaryDTO(
  options: OutputConversionOverviewOptions = {}
): Promise<OutputConversionSummaryDTO> {
  const [overview, assets, candidates] = await Promise.all([
    queryOutputConversionOverview(options),
    queryResultAssets(options),
    queryOutputCandidates(options)
  ]);
  const candidateDetails = (
    await Promise.all(candidates.map((candidate) => getOutputCandidateDetailDTO(candidate.id)))
  ).filter((detail): detail is OutputCandidateDetailDTO => Boolean(detail));
  const warnings = candidateDetails.flatMap((detail) => detail.warnings);
  const missingReferences = uniqueMissingReferences(
    candidateDetails.flatMap((detail) => detail.missingReferences)
  );

  return {
    projectId: options.projectId,
    ...overview,
    candidateSummaries: candidates.map(referenceSummary),
    assetSummaries: assets.map(referenceSummary),
    warnings,
    missingReferences,
    partial:
      warnings.length > 0 ||
      missingReferences.length > 0 ||
      candidateDetails.some((detail) => detail.partial)
  };
}

export async function getOutputConversionProjectContext(projectId: EntityId) {
  const [assets, findings, candidates, overview] = await Promise.all([
    queryResultAssets({ projectId }),
    queryFindings({ projectId }),
    queryOutputCandidates({ projectId }),
    queryOutputConversionOverview({ projectId })
  ]);

  return {
    projectId,
    assets,
    findings,
    candidates,
    overview
  };
}

export const outputConversionSelectorService = {
  queryResultAssets,
  getResultAssetDetail,
  queryFindings,
  getFindingDetailContext,
  queryOutputCandidates,
  getOutputCandidateDetailContext,
  getFindingDetailDTO,
  getOutputCandidateDetailDTO,
  getCandidateEvidenceChainDTO,
  buildOutputCandidateAIContextDTO,
  getCandidateEvidenceChain,
  getFindingsByResultItem,
  getCandidatesByFinding,
  getGapsByCandidate,
  getOutputConversionProjectContext,
  queryOutputConversionOverview,
  getOutputConversionSummaryDTO
};
