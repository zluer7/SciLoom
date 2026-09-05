import type { StructuredSummary } from "../types/outputStructuredSummary";
import type {
  Finding,
  OutputCandidate,
  OutputGap,
  ResultItem
} from "../types/outputConversion";
import type { ResearchOutput } from "../types/output";
import type {
  OutputConversionBundlePayload,
  OutputExportChainNodeSummary,
  OutputExportChainSummary,
  OutputExportEntityBasics,
  OutputExportFileRef,
  OutputExportLayer,
  OutputExportPayload,
  OutputExportRelationSummary,
  OutputExportRequest,
  OutputExportRequestWithoutFormat,
  OutputExportSafetyPolicy
} from "../types/outputExportBundle";
import type { OutputChainDto } from "../types/outputChain";
import type {
  OutputEntity,
  OutputEntityDetailDto,
  OutputFileRefSummary,
  OutputRelationSummary
} from "../types/outputSelector";
import {
  getFindingEvidenceChain,
  getOutputCandidateEvidenceChain,
  getOutputGapImpactChain,
  getResearchOutputSourceChain
} from "./outputChainAggregationService";
import { getOutputEntityDetail } from "./outputFiveLayerSelectorService";

type ExportCrossModuleLink = {
  type: "task" | "routeNode" | "sourceReference";
  id: string;
  label: string;
};

const OUTPUT_EXPORT_SCHEMA_VERSION = "lp8-7-b.v1" as const;
const SUMMARY_LIMIT = 420;

const SAFETY_POLICY: OutputExportSafetyPolicy = {
  noFullLocalPath: true,
  noFileBodyRead: true,
  pathSummaryOnly: true,
  noFileSystemWrite: true,
  noAiCall: true,
  noAutoWriteBackInstruction: true,
  activeOnlyByDefault: true
};

const SAFETY_NOTICE = [
  "This payload is an in-memory export DTO; SciLoom does not create files from this service.",
  "Referenced files are represented by pathSummary only; file bodies are not read or uploaded.",
  "The payload contains no AI call result and no business-data operation instruction."
];

const BASE_OMITTED_FIELDS = [
  "completeLocalPathFields",
  "fileBodyContent",
  "fileBinaryContent",
  "repositoryRawRow",
  "debugPayload",
  "operationInstructionFields",
  "recycleSnapshotPayload",
  "operationLogPayload",
  "softRemovedEntityContent"
];

const SUPPORTED_LAYERS: OutputExportLayer[] = [
  "resultItem",
  "finding",
  "outputCandidate",
  "outputGap",
  "researchOutput"
];

function sanitizePathLikeText(value: string) {
  return value
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s"'<>|]+/g, "[local path omitted]")
    .replace(/file:\/\/\/?[^\s"'<>|]+/gi, "[local path omitted]")
    .replace(/\/(?:Users|home|mnt|tmp|var)\/[^\s"'<>|]+/g, "[local path omitted]");
}

function safeText(value: unknown, maxLength = SUMMARY_LIMIT) {
  if (value === undefined || value === null) {
    return undefined;
  }
  const normalized = sanitizePathLikeText(String(value)).replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 1)}...`
    : normalized;
}

function safeMarkdown(value: unknown, maxLength = 20_000) {
  if (value === undefined || value === null) {
    return undefined;
  }
  const normalized = sanitizePathLikeText(String(value)).trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 1)}...`
    : normalized;
}

function sanitizeWarnings(warnings: string[]) {
  return [...new Set(warnings.map((warning) => safeText(warning, 360)).filter(Boolean))] as string[];
}

function sanitizeStructuredSummary(summary: StructuredSummary): StructuredSummary {
  return summary.map((section) => ({
    key: section.key,
    label: safeText(section.label, 120),
    value: safeMarkdown(section.value, 2_000) ?? "",
    order: section.order
  }));
}

function titleOf(layer: OutputExportLayer, entity: OutputEntity) {
  return layer === "researchOutput"
    ? (entity as ResearchOutput).outputName
    : (entity as ResultItem | Finding | OutputCandidate | OutputGap).title;
}

function pickEntityBasics(
  layer: OutputExportLayer,
  detail: OutputEntityDetailDto,
  entity: OutputEntity
): OutputExportEntityBasics {
  const title = titleOf(layer, entity);
  const base: OutputExportEntityBasics = {
    id: entity.id,
    layer,
    title: safeText(title, 220) ?? title,
    status: entity.status,
    projectId: detail.projectId,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt
  };

  switch (layer) {
    case "resultItem": {
      const resultItem = entity as ResultItem;
      return {
        id: base.id,
        layer: base.layer,
        title: base.title,
        status: base.status,
        projectId: base.projectId,
        createdAt: base.createdAt,
        updatedAt: base.updatedAt,
        type: resultItem.resultType,
        category: resultItem.sourceType,
        isAssetView: resultItem.isAsset === true,
        sourceSummary: safeText(`${resultItem.sourceType}:${resultItem.sourceId}`, 220)
      };
    }
    case "finding": {
      const finding = entity as Finding;
      return {
        id: base.id,
        layer: base.layer,
        title: base.title,
        status: base.status,
        projectId: base.projectId,
        createdAt: base.createdAt,
        updatedAt: base.updatedAt,
        type: finding.findingType,
        category: finding.confidence
      };
    }
    case "outputCandidate": {
      const candidate = entity as OutputCandidate;
      return {
        id: base.id,
        layer: base.layer,
        title: base.title,
        status: base.status,
        projectId: base.projectId,
        createdAt: base.createdAt,
        updatedAt: base.updatedAt,
        type: candidate.candidateType,
        category: candidate.priority ?? candidate.maturity
      };
    }
    case "outputGap": {
      const gap = entity as OutputGap;
      return {
        id: base.id,
        layer: base.layer,
        title: base.title,
        status: base.status,
        projectId: base.projectId,
        createdAt: base.createdAt,
        updatedAt: base.updatedAt,
        type: gap.gapType,
        category: gap.priority
      };
    }
    case "researchOutput": {
      const output = entity as ResearchOutput;
      return {
        id: base.id,
        layer: base.layer,
        title: base.title,
        status: base.status,
        projectId: base.projectId,
        createdAt: base.createdAt,
        updatedAt: base.updatedAt,
        type: output.outputType,
        category: output.usableForPaper ? "paper_material" : undefined
      };
    }
  }
}

function mapFileRefForExport(fileRef: OutputFileRefSummary): OutputExportFileRef {
  return {
    id: fileRef.id,
    ownerType: fileRef.ownerType,
    ownerId: fileRef.ownerId,
    fileName: safeText(fileRef.fileName, 220),
    extension: safeText(fileRef.extension, 40),
    fileKind: safeText(fileRef.fileKind, 80),
    mimeType: safeText(fileRef.mimeType, 120),
    sizeBytes: fileRef.sizeBytes,
    pathSummary: safeText(fileRef.pathSummary, 260) ?? "Path metadata summary unavailable",
    availabilityStatus: "not_verified"
  };
}

function mapRelationsForExport(
  relations: OutputRelationSummary[]
): OutputExportRelationSummary[] {
  return relations.map((relation) => ({
    id: relation.id,
    relationType: relation.relationType,
    direction: relation.direction,
    sourceType: relation.sourceType,
    sourceId: relation.sourceId,
    targetType: relation.targetType,
    targetId: relation.targetId,
    targetTitle: safeText(relation.targetTitle, 220),
    targetMissing: relation.targetMissing
  }));
}

function structuredSummaryMarkdown(summary: StructuredSummary) {
  if (summary.length === 0) {
    return "- No structured summary";
  }
  return summary
    .map((section) => {
      const label = safeText(section.label ?? section.key, 120) ?? section.key;
      const value = safeMarkdown(section.value, 2_000) ?? "unset";
      return `- ${label}: ${value}`;
    })
    .join("\n");
}

function markdownList(items: string[], emptyText = "No records") {
  const visibleItems = items.filter((item) => item.trim().length > 0);
  return visibleItems.length > 0
    ? visibleItems.map((item) => `- ${item}`).join("\n")
    : `- ${emptyText}`;
}

function mapChainForExport(chain: OutputChainDto): OutputExportChainSummary {
  const nodes: OutputExportChainNodeSummary[] = chain.nodes.map((node) => ({
    id: node.id,
    type: node.type,
    entityId: node.entityId,
    title: safeText(node.label, 220) ?? node.id,
    status: node.status,
    layer: node.layer,
    shortSummary: safeText(node.summary, SUMMARY_LIMIT),
    fileRefs: node.fileRefs?.map(mapFileRefForExport),
    missing: node.missing,
    partial: node.partial
  }));
  return {
    kind: chain.kind,
    root: {
      type: chain.root.type,
      id: chain.root.id
    },
    nodes,
    edges: chain.edges.map((edge) => ({
      id: edge.id,
      relationType: edge.relationType,
      sourceNodeId: edge.sourceNodeId,
      targetNodeId: edge.targetNodeId,
      direction: edge.direction
    })),
    boundary: {
      missing: chain.boundary.missing,
      partial: chain.boundary.partial,
      truncated: chain.boundary.truncated,
      cycleDetected: chain.boundary.cycleDetected,
      depthLimitReached: chain.boundary.depthLimitReached,
      nodeLimitReached: chain.boundary.nodeLimitReached,
      sourceBoundary: Array.from(chain.boundary.sourceBoundary),
      warnings: sanitizeWarnings(chain.boundary.warnings)
    },
    truncated: chain.boundary.truncated
  };
}

async function selectEvidenceChain(
  layer: OutputExportLayer,
  id: string,
  includeFileRefs: boolean,
  warnings: string[]
) {
  try {
    if (layer === "finding") {
      return mapChainForExport(
        await getFindingEvidenceChain(id, {
          includeFileRefs,
          includeCrossModuleRefs: true,
          includeProvenanceSnapshot: true
        })
      );
    }
    if (layer === "outputCandidate") {
      return mapChainForExport(
        await getOutputCandidateEvidenceChain(id, {
          includeFileRefs,
          includeCrossModuleRefs: true,
          includeProvenanceSnapshot: true
        })
      );
    }
  } catch (error) {
    warnings.push(`Evidence chain unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  return undefined;
}

async function selectSourceChain(
  layer: OutputExportLayer,
  id: string,
  includeFileRefs: boolean,
  warnings: string[]
) {
  try {
    if (layer === "outputGap") {
      return mapChainForExport(
        await getOutputGapImpactChain(id, {
          includeFileRefs,
          includeCrossModuleRefs: true,
          includeProvenanceSnapshot: true
        })
      );
    }
    if (layer === "researchOutput") {
      return mapChainForExport(
        await getResearchOutputSourceChain(id, {
          includeFileRefs,
          includeCrossModuleRefs: true,
          includeProvenanceSnapshot: true
        })
      );
    }
    if (layer === "outputCandidate") {
      return mapChainForExport(
        await getOutputCandidateEvidenceChain(id, {
          includeFileRefs,
          includeCrossModuleRefs: true,
          includeProvenanceSnapshot: true
        })
      );
    }
  } catch (error) {
    warnings.push(`Source chain unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  return undefined;
}

export function buildEvidenceChainExport(chain: OutputChainDto) {
  return mapChainForExport(chain);
}

export function buildSourceChainExport(chain: OutputChainDto) {
  return mapChainForExport(chain);
}

function isExportCrossModuleLink(
  item: ExportCrossModuleLink | undefined
): item is ExportCrossModuleLink {
  return Boolean(item);
}

function crossModuleLinksForExport(layer: OutputExportLayer, entity: OutputEntity) {
  if (layer === "resultItem") {
    const resultItem = entity as ResultItem;
    const links: Array<ExportCrossModuleLink | undefined> = [
      resultItem.sourceId && resultItem.sourceType !== "fileRef"
        ? {
            type: "sourceReference" as const,
            id: resultItem.sourceId,
            label: `${resultItem.sourceType} reference ${resultItem.sourceId}`
          }
        : undefined,
      resultItem.taskId
        ? {
            type: "task" as const,
            id: resultItem.taskId,
            label: `Task source reference ${resultItem.taskId}`
          }
        : undefined,
      resultItem.routeId
        ? {
            type: "routeNode" as const,
            id: resultItem.routeId,
            label: `Route source reference ${resultItem.routeId}`
          }
        : undefined
    ];
    return links.filter(isExportCrossModuleLink);
  }
  if (layer !== "outputGap") {
    return undefined;
  }
  const gap = entity as OutputGap;
  const links: Array<ExportCrossModuleLink | undefined> = [
    gap.relatedTaskId
      ? {
          type: "task" as const,
          id: gap.relatedTaskId,
          label: `Task feedback reference ${gap.relatedTaskId}`
        }
      : undefined,
    gap.relatedRouteNodeId
      ? {
          type: "routeNode" as const,
          id: gap.relatedRouteNodeId,
          label: `Route feedback reference ${gap.relatedRouteNodeId}`
        }
      : undefined
  ];
  return links.filter(isExportCrossModuleLink);
}

function missingBundle(request: OutputExportRequest, warnings: string[]): OutputConversionBundlePayload {
  const title = `${request.layer} ${request.id}`;
  return {
    bundleKind: "output_conversion_bundle",
    root: {
      id: request.id,
      layer: request.layer,
      title
    },
    safetyNotice: SAFETY_NOTICE,
    omittedFields: BASE_OMITTED_FIELDS,
    warnings: sanitizeWarnings([
      ...warnings,
      "Output entity was not found in the active export view."
    ])
  };
}

async function buildBundlePayload(
  request: OutputExportRequest
): Promise<OutputConversionBundlePayload> {
  const { layer, id } = request;
  const warnings: string[] = [];
  const detail = await getOutputEntityDetail({ layer, id, includeDeleted: false });
  for (const warning of detail.boundary.warnings) {
    warnings.push(warning);
  }
  if (detail.boundary.missing || !detail.entity) {
    return missingBundle(request, warnings);
  }

  const includeStructuredSummary = request.includeStructuredSummary !== false;
  const includeFileRefs = request.includeFileRefs !== false;
  const includeRelations = request.includeRelations !== false;
  const root = pickEntityBasics(layer, detail, detail.entity);
  const structuredSummary = includeStructuredSummary
    ? sanitizeStructuredSummary(detail.structuredSummary)
    : undefined;
  const evidenceChain =
    request.includeEvidenceChain === true
      ? await selectEvidenceChain(layer, id, includeFileRefs, warnings)
      : undefined;
  const sourceChain =
    request.includeSourceChain === true
      ? await selectSourceChain(layer, id, includeFileRefs, warnings)
      : undefined;
  const chainWarnings = [
    evidenceChain?.boundary.warnings,
    sourceChain?.boundary.warnings
  ]
    .flat()
    .filter((warning): warning is string => Boolean(warning));
  for (const warning of chainWarnings) {
    warnings.push(warning);
  }

  return {
    bundleKind: "output_conversion_bundle",
    root,
    structuredSummary,
    evidenceChain,
    sourceChain,
    fileRefSummaries: includeFileRefs ? detail.fileRefs.map(mapFileRefForExport) : undefined,
    relations: includeRelations ? mapRelationsForExport(detail.relationSummary) : undefined,
    crossModuleLinks: crossModuleLinksForExport(layer, detail.entity),
    safetyNotice: SAFETY_NOTICE,
    omittedFields: BASE_OMITTED_FIELDS,
    warnings: sanitizeWarnings(warnings)
  };
}

function chainMarkdown(title: string, chain?: OutputExportChainSummary) {
  if (!chain) {
    return [`## ${title}`, "", "- No chain included"].join("\n");
  }
  const nodes = chain.nodes.map((node) => {
    const status = node.status ? ` (${node.status})` : "";
    const summary = node.shortSummary ? ` - ${node.shortSummary}` : "";
    return `${node.type}: ${node.title}${status}${summary}`;
  });
  const edges = chain.edges.map(
    (edge) => `${edge.sourceNodeId} -> ${edge.targetNodeId} [${edge.relationType}]`
  );
  return [
    `## ${title}`,
    "",
    `- Kind: ${chain.kind}`,
    `- Truncated: ${chain.truncated ? "yes" : "no"}`,
    "",
    "### Nodes",
    "",
    markdownList(nodes),
    "",
    "### Edges",
    "",
    markdownList(edges)
  ].join("\n");
}

function fileRefsMarkdown(fileRefs?: OutputExportFileRef[]) {
  return markdownList(
    (fileRefs ?? []).map((fileRef) => {
      const parts = [
        fileRef.fileName ?? fileRef.id,
        fileRef.fileKind,
        fileRef.mimeType,
        fileRef.sizeBytes === undefined ? undefined : `${fileRef.sizeBytes} bytes`,
        fileRef.pathSummary
      ].filter(Boolean);
      return parts.join(" | ");
    }),
    "No file references"
  );
}

function relationsMarkdown(relations?: OutputExportRelationSummary[]) {
  return markdownList(
    (relations ?? []).map(
      (relation) =>
        `${relation.direction}: ${relation.sourceType}:${relation.sourceId} ${relation.relationType} ${relation.targetType}:${relation.targetId}${relation.targetTitle ? ` (${relation.targetTitle})` : ""}`
    ),
    "No relations"
  );
}

function bundleToMarkdown(bundle: OutputConversionBundlePayload) {
  const root = bundle.root;
  const basic = [
    `- Layer: ${root.layer}`,
    `- ID: ${root.id}`,
    `- Status: ${root.status ?? "unset"}`,
    `- Type: ${root.type ?? "unset"}`,
    `- Category: ${root.category ?? "unset"}`,
    `- Project ID: ${root.projectId ?? "unset"}`
  ];
  return [
    `# ${root.title}`,
    "",
    "## Basic",
    "",
    basic.join("\n"),
    "",
    "## Structured Summary",
    "",
    structuredSummaryMarkdown(bundle.structuredSummary ?? []),
    "",
    "## Manuscript",
    "",
    "Current manuscript BODY is excluded; export contains structured data and file metadata only.",
    "",
    chainMarkdown("Evidence Chain", bundle.evidenceChain),
    "",
    chainMarkdown("Source Chain", bundle.sourceChain),
    "",
    "## File References",
    "",
    fileRefsMarkdown(bundle.fileRefSummaries),
    "",
    "## Relations",
    "",
    relationsMarkdown(bundle.relations),
    "",
    "## Safety Notice",
    "",
    markdownList(bundle.safetyNotice),
    "",
    "## Warnings",
    "",
    markdownList(bundle.warnings, "No warnings")
  ].join("\n");
}

function buildPayload(
  request: OutputExportRequest,
  bundle: OutputConversionBundlePayload,
  markdown?: string
): OutputExportPayload {
  return {
    schemaVersion: OUTPUT_EXPORT_SCHEMA_VERSION,
    exportKind: "output_conversion_export",
    exportFormat: request.format ?? "bundle",
    generatedAt: new Date().toISOString(),
    layer: request.layer,
    id: request.id,
    title: bundle.root.title,
    status: bundle.root.status,
    markdown,
    bundle: request.format === "markdown" ? undefined : bundle,
    safetyPolicy: SAFETY_POLICY,
    omittedFields: bundle.omittedFields,
    warnings: bundle.warnings
  };
}

export async function exportOutputEntity(
  request: OutputExportRequest
): Promise<OutputExportPayload> {
  const { layer } = request;
  if (!SUPPORTED_LAYERS.includes(layer)) {
    throw new Error(`Unsupported output export layer: ${String(layer)}.`);
  }
  const commonRequest = {
    id: request.id,
    format: request.format ?? "bundle",
    includeEvidenceChain: request.includeEvidenceChain,
    includeSourceChain: request.includeSourceChain,
    includeStructuredSummary: request.includeStructuredSummary,
    includeFileRefs: request.includeFileRefs,
    includeRelations: request.includeRelations,
    includeDeleted: false as const
  };
  const normalizedRequest: OutputExportRequest = { ...commonRequest, layer: request.layer };
  const bundle = await buildBundlePayload(normalizedRequest);
  if (normalizedRequest.format === "markdown") {
    return buildPayload(normalizedRequest, bundle, bundleToMarkdown(bundle));
  }
  return buildPayload(normalizedRequest, bundle);
}

export async function exportOutputEntityAsMarkdown(
  request: OutputExportRequestWithoutFormat
) {
  const commonRequest = {
    id: request.id,
    includeEvidenceChain: request.includeEvidenceChain,
    includeSourceChain: request.includeSourceChain,
    includeStructuredSummary: request.includeStructuredSummary,
    includeFileRefs: request.includeFileRefs,
    includeRelations: request.includeRelations,
    includeDeleted: false,
    format: "markdown"
  } as const;
  const payload = await exportOutputEntity({ ...commonRequest, layer: request.layer });
  return payload.markdown ?? "";
}

export async function exportOutputConversionBundle(
  request: OutputExportRequestWithoutFormat
) {
  const commonRequest = {
    id: request.id,
    includeEvidenceChain: request.includeEvidenceChain,
    includeSourceChain: request.includeSourceChain,
    includeStructuredSummary: request.includeStructuredSummary,
    includeFileRefs: request.includeFileRefs,
    includeRelations: request.includeRelations,
    includeDeleted: false,
    format: "bundle"
  } as const;
  const payload = await exportOutputEntity({ ...commonRequest, layer: request.layer });
  return payload.bundle ?? missingBundle(request, payload.warnings);
}

export const outputExportBundleService = {
  exportOutputEntity,
  exportOutputEntityAsMarkdown,
  exportOutputConversionBundle,
  buildEvidenceChainExport,
  buildSourceChainExport
};

export type OutputExportBundleService = typeof outputExportBundleService;
