import type { EntityId } from "../types/common";
import type { ResearchOutput } from "../types/output";
import type {
  OutputChainBoundary,
  OutputChainDto,
  OutputChainEdge,
  OutputChainKind,
  OutputChainNode,
  OutputChainNodeType,
  OutputChainOptions,
  OutputChainQuery,
  OutputChainSource
} from "../types/outputChain";
import type { OutputGap, ResultItem } from "../types/outputConversion";
import type {
  OutputEntity,
  OutputEntityDetailDto,
  OutputEntityLayer,
  OutputFileRefSummary,
  OutputRelationSummary
} from "../types/outputSelector";
import { getOutputEntityDetail } from "./outputFiveLayerSelectorService";

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_NODES = 50;

type NormalizedOptions = Required<OutputChainOptions>;

type AggregationState = {
  kind: OutputChainKind;
  options: NormalizedOptions;
  nodes: Map<string, OutputChainNode>;
  edges: Map<string, OutputChainEdge>;
  details: Map<string, OutputEntityDetailDto>;
  visited: Set<string>;
  activePath: Set<string>;
  expandedRelationIds: Set<string>;
  boundary: OutputChainBoundary;
  depth: number;
};

type CrossModuleReference = {
  type: Exclude<
    OutputChainNodeType,
    OutputEntityLayer | "fileRef" | "provenanceSnapshot"
  >;
  id: EntityId;
  label: string;
  relationType: "source_ref" | "planning_feedback";
};

function normalizeOptions(options: OutputChainOptions = {}): NormalizedOptions {
  return {
    maxDepth: Math.max(0, Math.floor(options.maxDepth ?? DEFAULT_MAX_DEPTH)),
    maxNodes: Math.max(1, Math.floor(options.maxNodes ?? DEFAULT_MAX_NODES)),
    includeFileRefs: options.includeFileRefs ?? true,
    includeCrossModuleRefs: options.includeCrossModuleRefs ?? true,
    includeProvenanceSnapshot: options.includeProvenanceSnapshot ?? true
  };
}

function createBoundary(): OutputChainBoundary {
  return {
    missing: false,
    partial: false,
    truncated: false,
    cycleDetected: false,
    depthLimitReached: false,
    nodeLimitReached: false,
    sourceBoundary: [],
    warnings: []
  };
}

function rootLayer(kind: OutputChainKind): OutputEntityLayer {
  switch (kind) {
    case "findingEvidence":
      return "finding";
    case "candidateEvidence":
      return "outputCandidate";
    case "outputGapImpact":
      return "outputGap";
    case "researchOutputSource":
      return "researchOutput";
  }
}

function entityNodeId(layer: OutputEntityLayer, id: EntityId) {
  return `${layer}:${id}`;
}

function auxiliaryNodeId(type: OutputChainNodeType, id: EntityId) {
  return `${type}:${id}`;
}

function redactPathLikeText(value: string) {
  return value
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s"'<>|]+/g, "[local path]")
    .replace(/file:\/\/\/?[^\s"'<>|]+/gi, "[local path]");
}

function safeText(value: unknown, maxLength = 240) {
  if (value === undefined || value === null) {
    return undefined;
  }
  const normalized = redactPathLikeText(String(value)).replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 1)}…`
    : normalized;
}

function addSource(state: AggregationState, source: OutputChainSource) {
  if (!state.boundary.sourceBoundary.includes(source)) {
    state.boundary.sourceBoundary.push(source);
  }
}

function addWarning(state: AggregationState, warning: string) {
  const safeWarning = safeText(warning, 320);
  if (safeWarning && !state.boundary.warnings.includes(safeWarning)) {
    state.boundary.warnings.push(safeWarning);
  }
}

function markDepthLimit(state: AggregationState) {
  state.boundary.partial = true;
  state.boundary.truncated = true;
  state.boundary.depthLimitReached = true;
  addSource(state, "depthLimitedChain");
  addWarning(state, `Chain expansion stopped at maxDepth=${state.options.maxDepth}.`);
}

function markNodeLimit(state: AggregationState) {
  state.boundary.partial = true;
  state.boundary.truncated = true;
  state.boundary.nodeLimitReached = true;
  addSource(state, "nodeLimitedChain");
  addWarning(state, `Chain expansion stopped at maxNodes=${state.options.maxNodes}.`);
}

function markCycle(state: AggregationState, nodeId: string) {
  state.boundary.partial = true;
  state.boundary.truncated = true;
  state.boundary.cycleDetected = true;
  addSource(state, "cycleGuard");
  addWarning(state, `Cycle guard stopped repeated expansion at ${nodeId}.`);
}

function titleOf(layer: OutputEntityLayer, entity: OutputEntity) {
  return layer === "researchOutput"
    ? (entity as ResearchOutput).outputName
    : (entity as Exclude<OutputEntity, ResearchOutput>).title;
}

function summaryOf(entity: OutputEntity) {
  const structured = entity.structuredSummary
    .map((section) => section.value)
    .filter(Boolean)
    .join(" | ");
  if (structured) {
    return safeText(structured);
  }
  if ("summary" in entity && entity.summary) {
    return safeText(entity.summary);
  }
  if ("description" in entity && entity.description) {
    return safeText(entity.description);
  }
  return undefined;
}

function toEntityNode(
  layer: OutputEntityLayer,
  detail: OutputEntityDetailDto,
  includeFileRefs: boolean
): OutputChainNode {
  if (!detail.entity) {
    return {
      id: entityNodeId(layer, detail.id),
      type: layer,
      entityId: detail.id,
      label: `Missing ${layer} ${detail.id}`,
      layer,
      missing: true,
      partial: true
    };
  }
  return {
    id: entityNodeId(layer, detail.entity.id),
    type: layer,
    entityId: detail.entity.id,
    label: safeText(titleOf(layer, detail.entity), 160) ?? `${layer} ${detail.entity.id}`,
    status: detail.status,
    layer,
    summary: summaryOf(detail.entity),
    fileRefs: includeFileRefs ? detail.fileRefs : undefined,
    partial: detail.boundary.partial
  };
}

async function getDetail(
  state: AggregationState,
  layer: OutputEntityLayer,
  id: EntityId
) {
  const key = entityNodeId(layer, id);
  const cached = state.details.get(key);
  if (cached) {
    return cached;
  }
  const detail = await getOutputEntityDetail({ layer, id });
  state.details.set(key, detail);
  addSource(state, "detailSelector");
  addSource(state, "entity");
  addSource(state, "outputConversionRelations");
  for (const warning of detail.boundary.warnings) {
    if (!warning.includes("LP8-4-B")) {
      addWarning(state, `${layer}/${id}: ${warning}`);
    }
  }
  if (detail.boundary.partial) {
    state.boundary.partial = true;
  }
  return detail;
}

function ensureNodeCapacity(state: AggregationState, nodeId: string) {
  if (state.nodes.has(nodeId)) {
    return true;
  }
  if (state.nodes.size >= state.options.maxNodes) {
    markNodeLimit(state);
    return false;
  }
  return true;
}

async function ensureEntityNode(
  state: AggregationState,
  layer: OutputEntityLayer,
  id: EntityId,
  depth: number
) {
  const nodeId = entityNodeId(layer, id);
  if (!ensureNodeCapacity(state, nodeId)) {
    return null;
  }
  let detail: OutputEntityDetailDto;
  try {
    detail = await getDetail(state, layer, id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    detail = {
      layer,
      id,
      entity: null,
      structuredSummary: [],
      manuscript: {
        identityResolved: false,
        identityStatus: "not-found",
        availabilityStatus: "not-checked",
        warnings: ["missing_output_entity"]
      },
      relationSummary: [],
      fileRefs: [],
      boundary: {
        missing: true,
        partial: true,
        sourceBoundary: [],
        warnings: [`Detail selector failed: ${safeText(message, 240) ?? "unknown error"}`]
      }
    };
    state.details.set(nodeId, detail);
    addWarning(state, `${layer}/${id}: detail selector failed.`);
  }
  if (!state.nodes.has(nodeId)) {
    state.nodes.set(nodeId, toEntityNode(layer, detail, state.options.includeFileRefs));
  }
  state.depth = Math.max(state.depth, depth);
  if (detail.boundary.missing) {
    state.boundary.partial = true;
  }
  if (state.options.includeFileRefs && detail.fileRefs.length > 0) {
    addSource(state, "fileRefSummary");
  }
  return { nodeId, detail };
}

function counterpart(
  layer: OutputEntityLayer,
  id: EntityId,
  relation: OutputRelationSummary
) {
  if (relation.sourceType === layer && relation.sourceId === id) {
    return {
      layer: relation.targetType,
      id: relation.targetId,
      currentIsSource: true
    };
  }
  return {
    layer: relation.sourceType,
    id: relation.sourceId,
    currentIsSource: false
  };
}

function shouldTraverseRelation(
  kind: OutputChainKind,
  layer: OutputEntityLayer,
  id: EntityId,
  relation: OutputRelationSummary
) {
  const currentIsSource = relation.sourceType === layer && relation.sourceId === id;
  const currentIsTarget = relation.targetType === layer && relation.targetId === id;
  if (!currentIsSource && !currentIsTarget) {
    return false;
  }
  switch (layer) {
    case "finding":
      return (
        (relation.relationType === "evidence_for" && currentIsTarget) ||
        (["extends", "contradicts"].includes(relation.relationType) &&
          relation.sourceType === "finding" &&
          relation.targetType === "finding")
      );
    case "outputCandidate":
      return (
        (relation.relationType === "supports" && currentIsTarget) ||
        (relation.relationType === "uses" && currentIsTarget) ||
        (relation.relationType === "converted_to" &&
          currentIsSource &&
          kind === "candidateEvidence") ||
        (["extends", "contradicts"].includes(relation.relationType) &&
          relation.sourceType === "outputCandidate" &&
          relation.targetType === "outputCandidate")
      );
    case "outputGap":
      return (
        (relation.relationType === "blocks" && currentIsSource) ||
        (relation.relationType === "resolves" && currentIsTarget)
      );
    case "researchOutput":
      return relation.relationType === "converted_to" && currentIsTarget;
    case "resultItem":
      return false;
  }
}

function relationEdge(relation: OutputRelationSummary): OutputChainEdge {
  return {
    id: `relation:${relation.id}`,
    relationType: relation.relationType,
    sourceNodeId: entityNodeId(relation.sourceType, relation.sourceId),
    targetNodeId: entityNodeId(relation.targetType, relation.targetId),
    sourceType: relation.sourceType,
    sourceId: relation.sourceId,
    targetType: relation.targetType,
    targetId: relation.targetId,
    direction: relation.direction === "outgoing" ? "forward" : "backward"
  };
}

function sourceTypeToNodeType(
  sourceType: ResultItem["sourceType"]
): CrossModuleReference["type"] {
  switch (sourceType) {
    case "experiment":
    case "experimentRun":
    case "resultMetric":
    case "task":
    case "literature":
    case "review":
      return sourceType;
    default:
      return "boundary";
  }
}

function crossModuleReferences(
  layer: OutputEntityLayer,
  entity: OutputEntity
): CrossModuleReference[] {
  const refs = new Map<string, CrossModuleReference>();
  const add = (reference: CrossModuleReference) => {
    refs.set(`${reference.type}:${reference.id}:${reference.relationType}`, reference);
  };
  if (layer === "resultItem") {
    const resultItem = entity as ResultItem;
    if (resultItem.sourceId && resultItem.sourceType !== "fileRef") {
      const type = sourceTypeToNodeType(resultItem.sourceType);
      add({
        type,
        id: resultItem.sourceId,
        label: `${resultItem.sourceType} reference ${resultItem.sourceId}`,
        relationType: "source_ref"
      });
    }
    if (resultItem.experimentId) {
      add({
        type: "experiment",
        id: resultItem.experimentId,
        label: `Experiment reference ${resultItem.experimentId}`,
        relationType: "source_ref"
      });
    }
    if (resultItem.experimentRunId) {
      add({
        type: "experimentRun",
        id: resultItem.experimentRunId,
        label: `Experiment run reference ${resultItem.experimentRunId}`,
        relationType: "source_ref"
      });
    }
    if (resultItem.taskId) {
      add({
        type: "task",
        id: resultItem.taskId,
        label: `Task reference ${resultItem.taskId}`,
        relationType: "source_ref"
      });
    }
    if (resultItem.routeId) {
      add({
        type: "routeNode",
        id: resultItem.routeId,
        label: `Route reference ${resultItem.routeId}`,
        relationType: "source_ref"
      });
    }
  }
  if (layer === "outputGap") {
    const gap = entity as OutputGap;
    if (gap.relatedTaskId) {
      add({
        type: "task",
        id: gap.relatedTaskId,
        label: `Task feedback reference ${gap.relatedTaskId}`,
        relationType: "planning_feedback"
      });
    }
    if (gap.relatedRouteNodeId) {
      add({
        type: "routeNode",
        id: gap.relatedRouteNodeId,
        label: `Route feedback reference ${gap.relatedRouteNodeId}`,
        relationType: "planning_feedback"
      });
    }
  }
  return [...refs.values()];
}

function hasExpandableBoundaryData(
  state: AggregationState,
  layer: OutputEntityLayer,
  detail: OutputEntityDetailDto
) {
  if (
    detail.relationSummary.some((relation) =>
      shouldTraverseRelation(state.kind, layer, detail.id, relation)
    )
  ) {
    return true;
  }
  if (state.options.includeFileRefs && detail.fileRefs.length > 0) {
    return true;
  }
  if (
    state.options.includeCrossModuleRefs &&
    detail.entity &&
    crossModuleReferences(layer, detail.entity).length > 0
  ) {
    return true;
  }
  return (
    state.options.includeProvenanceSnapshot &&
    layer === "researchOutput" &&
    Boolean((detail.entity as ResearchOutput | null)?.provenance)
  );
}

function addAuxiliaryNode(
  state: AggregationState,
  node: OutputChainNode,
  depth: number
) {
  if (!ensureNodeCapacity(state, node.id)) {
    return false;
  }
  if (!state.nodes.has(node.id)) {
    state.nodes.set(node.id, node);
  }
  state.depth = Math.max(state.depth, depth);
  return true;
}

function addFileRefNodes(
  state: AggregationState,
  ownerNodeId: string,
  fileRefs: OutputFileRefSummary[],
  depth: number
) {
  for (const fileRef of fileRefs) {
    const nodeId = auxiliaryNodeId("fileRef", fileRef.id);
    if (
      !addAuxiliaryNode(
        state,
        {
          id: nodeId,
          type: "fileRef",
          entityId: fileRef.id,
          label: safeText(fileRef.fileName, 160) ?? `FileRef ${fileRef.id}`,
          summary: fileRef.pathSummary,
          fileRefs: [fileRef]
        },
        depth
      )
    ) {
      return;
    }
    const edgeId = `file-ref:${ownerNodeId}:${fileRef.id}`;
    if (!state.edges.has(edgeId)) {
      state.edges.set(edgeId, {
        id: edgeId,
        relationType: "file_ref",
        sourceNodeId: ownerNodeId,
        targetNodeId: nodeId,
        targetType: "fileRef",
        targetId: fileRef.id,
        direction: "crossModule"
      });
    }
  }
}

function addCrossModuleNodes(
  state: AggregationState,
  ownerNodeId: string,
  references: CrossModuleReference[],
  depth: number
) {
  if (references.length === 0) {
    return;
  }
  addSource(state, "crossModuleReference");
  for (const reference of references) {
    const nodeId = auxiliaryNodeId(reference.type, reference.id);
    if (
      !addAuxiliaryNode(
        state,
        {
          id: nodeId,
          type: reference.type,
          entityId: reference.id,
          label: safeText(reference.label, 180) ?? `${reference.type} ${reference.id}`,
          partial: false
        },
        depth
      )
    ) {
      return;
    }
    const edgeId = `cross:${ownerNodeId}:${reference.type}:${reference.id}:${reference.relationType}`;
    if (!state.edges.has(edgeId)) {
      state.edges.set(edgeId, {
        id: edgeId,
        relationType: reference.relationType,
        sourceNodeId: ownerNodeId,
        targetNodeId: nodeId,
        targetType: reference.type,
        targetId: reference.id,
        direction: "crossModule"
      });
    }
  }
}

function addProvenanceSnapshot(
  state: AggregationState,
  ownerNodeId: string,
  output: ResearchOutput,
  depth: number
) {
  const provenance = output.provenance;
  if (!provenance) {
    return;
  }
  addSource(state, "provenanceSnapshot");
  const nodeId = auxiliaryNodeId("provenanceSnapshot", output.id);
  const summary = [
    `sourceType=${provenance.sourceType}`,
    provenance.sourceCandidateTitle
      ? `sourceCandidateTitle=${provenance.sourceCandidateTitle}`
      : undefined,
    provenance.sourceCandidateType
      ? `sourceCandidateType=${provenance.sourceCandidateType}`
      : undefined,
    provenance.convertedAt ? `convertedAt=${provenance.convertedAt}` : undefined,
    provenance.confirmedByUser === undefined
      ? undefined
      : `confirmedByUser=${provenance.confirmedByUser}`,
    provenance.evidenceSummary,
    provenance.note
  ]
    .filter(Boolean)
    .join(" | ");
  if (
    !addAuxiliaryNode(
      state,
      {
        id: nodeId,
        type: "provenanceSnapshot",
        entityId: output.id,
        label: `Conversion snapshot for ${safeText(output.outputName, 120) ?? output.id}`,
        summary: safeText(summary)
      },
      depth
    )
  ) {
    return;
  }
  const edgeId = `snapshot:${ownerNodeId}:${output.id}`;
  if (!state.edges.has(edgeId)) {
    state.edges.set(edgeId, {
      id: edgeId,
      relationType: "snapshot",
      sourceNodeId: ownerNodeId,
      targetNodeId: nodeId,
      targetType: "provenanceSnapshot",
      targetId: output.id,
      direction: "snapshot"
    });
  }
}

async function expandEntity(
  state: AggregationState,
  layer: OutputEntityLayer,
  id: EntityId,
  depth: number
): Promise<void> {
  const key = entityNodeId(layer, id);
  const ensured = await ensureEntityNode(state, layer, id, depth);
  if (!ensured) {
    return;
  }
  const { nodeId, detail } = ensured;
  if (state.activePath.has(key)) {
    markCycle(state, nodeId);
    return;
  }
  if (state.visited.has(key) || detail.boundary.missing || !detail.entity) {
    return;
  }
  state.visited.add(key);
  state.activePath.add(key);

  if (depth >= state.options.maxDepth) {
    if (hasExpandableBoundaryData(state, layer, detail)) {
      markDepthLimit(state);
    }
    state.activePath.delete(key);
    return;
  }

  const childDepth = depth + 1;
  if (state.options.includeFileRefs && detail.fileRefs.length > 0) {
    addSource(state, "fileRefSummary");
    addFileRefNodes(state, nodeId, detail.fileRefs, childDepth);
  }
  if (state.options.includeCrossModuleRefs) {
    addCrossModuleNodes(
      state,
      nodeId,
      crossModuleReferences(layer, detail.entity),
      childDepth
    );
  }
  if (
    state.options.includeProvenanceSnapshot &&
    layer === "researchOutput"
  ) {
    addProvenanceSnapshot(
      state,
      nodeId,
      detail.entity as ResearchOutput,
      childDepth
    );
  }

  for (const relation of detail.relationSummary) {
    if (!shouldTraverseRelation(state.kind, layer, id, relation)) {
      continue;
    }
    const edgeId = `relation:${relation.id}`;
    if (state.expandedRelationIds.has(relation.id)) {
      continue;
    }
    state.expandedRelationIds.add(relation.id);
    const next = counterpart(layer, id, relation);
    const nextNodeId = entityNodeId(next.layer, next.id);
    const nextEnsured = await ensureEntityNode(state, next.layer, next.id, childDepth);
    if (!nextEnsured) {
      break;
    }
    if (!state.edges.has(edgeId)) {
      state.edges.set(edgeId, relationEdge(relation));
    }
    if (relation.targetMissing || nextEnsured.detail.boundary.missing) {
      state.boundary.partial = true;
      addWarning(
        state,
        `Relation target missing for ${relation.relationType}: ${next.layer}/${next.id}.`
      );
      continue;
    }
    if (state.activePath.has(nextNodeId)) {
      markCycle(state, nextNodeId);
      continue;
    }
    await expandEntity(state, next.layer, next.id, childDepth);
    if (state.boundary.nodeLimitReached) {
      break;
    }
  }

  state.activePath.delete(key);
}

function emptyChain(
  kind: OutputChainKind,
  rootId: EntityId,
  options: NormalizedOptions
): OutputChainDto {
  const layer = rootLayer(kind);
  return {
    kind,
    root: {
      type: layer,
      id: entityNodeId(layer, rootId)
    },
    nodes: [],
    edges: [],
    depth: 0,
    maxDepth: options.maxDepth,
    maxNodes: options.maxNodes,
    boundary: createBoundary()
  };
}

export async function getOutputChain(query: OutputChainQuery): Promise<OutputChainDto> {
  const options = normalizeOptions(query.options);
  const result = emptyChain(query.kind, query.rootId, options);
  const state: AggregationState = {
    kind: query.kind,
    options,
    nodes: new Map(),
    edges: new Map(),
    details: new Map(),
    visited: new Set(),
    activePath: new Set(),
    expandedRelationIds: new Set(),
    boundary: result.boundary,
    depth: 0
  };
  const layer = rootLayer(query.kind);
  await expandEntity(state, layer, query.rootId, 0);
  const rootDetail = state.details.get(entityNodeId(layer, query.rootId));
  if (!rootDetail || rootDetail.boundary.missing) {
    state.boundary.missing = true;
    state.boundary.partial = false;
    addWarning(state, `${layer}/${query.rootId} was not found.`);
  }
  return {
    ...result,
    nodes: [...state.nodes.values()],
    edges: [...state.edges.values()],
    depth: state.depth,
    boundary: state.boundary
  };
}

export function getFindingEvidenceChain(
  findingId: EntityId,
  options: OutputChainOptions = {}
) {
  return getOutputChain({
    kind: "findingEvidence",
    rootId: findingId,
    options
  });
}

export function getOutputCandidateEvidenceChain(
  candidateId: EntityId,
  options: OutputChainOptions = {}
) {
  return getOutputChain({
    kind: "candidateEvidence",
    rootId: candidateId,
    options
  });
}

export function getOutputGapImpactChain(
  gapId: EntityId,
  options: OutputChainOptions = {}
) {
  return getOutputChain({
    kind: "outputGapImpact",
    rootId: gapId,
    options
  });
}

export function getResearchOutputSourceChain(
  outputId: EntityId,
  options: OutputChainOptions = {}
) {
  return getOutputChain({
    kind: "researchOutputSource",
    rootId: outputId,
    options
  });
}

export const outputChainAggregationService = {
  getOutputChain,
  getFindingEvidenceChain,
  getOutputCandidateEvidenceChain,
  getOutputGapImpactChain,
  getResearchOutputSourceChain
};

export type OutputChainAggregationService = typeof outputChainAggregationService;
