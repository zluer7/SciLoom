import type { FileRefPathSummary } from "../types/experiment";
import type {
  Finding,
  OutputCandidate,
  OutputConversionRelation,
  OutputGap,
  ResultItem
} from "../types/outputConversion";
import type { ResearchOutput } from "../types/output";
import type {
  OutputEntity,
  OutputEntityByLayer,
  OutputEntityDetailDto,
  OutputEntityDetailOptions,
  OutputEntityDetailQuery,
  OutputEntityLayer,
  FileAwareOutputEntityLayer,
  OutputEntityListFilters,
  OutputEntityListItemDto,
  OutputEntityListQuery,
  OutputFileRefSummary,
  OutputRelationSummary,
  OutputSelectorBoundary,
  OutputSelectorSource
} from "../types/outputSelector";
import { fileRefService } from "./fileRefService";
import { manuscriptBindingService } from "./manuscriptBindingService";
import { outputConversionRelationService } from "./outputConversionRelationService";
import { outputConversionService } from "./outputConversionService";
import { outputService } from "./outputService";
import {
  buildOutputCanonicalPresentationSummary,
  readOutputDirectCanonicalValue
} from "./outputCanonicalValueCoherenceService";

const CHAIN_BOUNDARY_WARNING = "Chain aggregation is deferred to LP8-4-B.";

function createBoundary(
  sources: OutputSelectorSource[],
  warnings: string[] = [],
  missing = false,
  partial = false
): OutputSelectorBoundary {
  return {
    missing,
    partial,
    sourceBoundary: [...new Set(sources)],
    warnings: [...new Set(warnings)]
  };
}

function titleOf(layer: OutputEntityLayer, entity: OutputEntity) {
  return layer === "researchOutput"
    ? (entity as ResearchOutput).outputName
    : (entity as ResultItem | Finding | OutputCandidate | OutputGap).title;
}

function isArchived(layer: OutputEntityLayer, entity: OutputEntity) {
  return layer === "researchOutput" && entity.status === "archived";
}

function statusMatches(entity: OutputEntity, status?: string | string[]) {
  if (!status) {
    return true;
  }
  const statuses = Array.isArray(status) ? status : [status];
  return statuses.includes(entity.status);
}

function redactPathLikeText(value: string) {
  return value
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s"'<>|]+/g, "[local path]")
    .replace(/file:\/\/\/?[^\s"'<>|]+/gi, "[local path]");
}

function preview(value: string, maxLength = 180) {
  const normalized = redactPathLikeText(value).replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function canonicalPresentationSummary(layer: OutputEntityLayer, entity: OutputEntity) {
  return buildOutputCanonicalPresentationSummary(
    layer,
    readOutputDirectCanonicalValue(layer, entity),
    entity.structuredSummary
  );
}

function structuredSummaryPreview(layer: OutputEntityLayer, entity: OutputEntity) {
  return preview(
    canonicalPresentationSummary(layer, entity)
      .map((section) => [section.label ?? section.key, section.value].filter(Boolean).join(": "))
      .filter(Boolean)
      .join(" | ")
  );
}

function keywordMatches(entity: OutputEntity, keyword?: string) {
  const normalized = keyword?.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  const values: unknown[] = [
    titleOf(
      "outputName" in entity ? "researchOutput" : entityKindFromShape(entity),
      entity
    ),
    entity.status,
    ...entity.structuredSummary.flatMap((section) => [
      section.key,
      section.label,
      section.value
    ])
  ];
  if ("description" in entity) values.push(entity.description);
  if ("summary" in entity) values.push(entity.summary);
  if ("tags" in entity) values.push(...entity.tags);
  return values.some(
    (value) => value !== undefined && value !== null && String(value).toLowerCase().includes(normalized)
  );
}

function entityKindFromShape(
  entity: Exclude<OutputEntity, ResearchOutput>
): Exclude<OutputEntityLayer, "researchOutput"> {
  if ("resultType" in entity) return "resultItem";
  if ("findingType" in entity || "confidence" in entity) return "finding";
  if ("candidateType" in entity) return "outputCandidate";
  return "outputGap";
}

function stableSort(entities: OutputEntity[]) {
  return [...entities].sort(
    (left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) ||
      right.createdAt.localeCompare(left.createdAt) ||
      left.id.localeCompare(right.id)
  );
}

async function listLayerEntities(
  layer: OutputEntityLayer,
  includeDeleted: boolean
): Promise<OutputEntity[]> {
  let active: OutputEntity[];
  let deleted: OutputEntity[] = [];
  switch (layer) {
    case "resultItem":
      active = await outputConversionService.listResultItems();
      if (includeDeleted) deleted = await outputConversionService.listDeletedResultItems();
      break;
    case "finding":
      active = await outputConversionService.listFindings();
      if (includeDeleted) deleted = await outputConversionService.listDeletedFindings();
      break;
    case "outputCandidate":
      active = await outputConversionService.listOutputCandidates();
      if (includeDeleted) deleted = await outputConversionService.listDeletedOutputCandidates();
      break;
    case "outputGap":
      active = await outputConversionService.listOutputGaps();
      if (includeDeleted) deleted = await outputConversionService.listDeletedOutputGaps();
      break;
    case "researchOutput":
      active = await outputService.listOutputs();
      if (includeDeleted) deleted = await outputService.listDeletedOutputs();
      break;
  }
  return [...active, ...deleted];
}

async function getLayerEntity(
  layer: OutputEntityLayer,
  id: string,
  includeDeleted = false
): Promise<OutputEntity | undefined> {
  let active: OutputEntity | undefined;
  switch (layer) {
    case "resultItem":
      active = await outputConversionService.getResultItemById(id);
      return (
        active ??
        (includeDeleted
          ? await outputConversionService.getDeletedResultItemById(id)
          : undefined)
      );
    case "finding":
      active = await outputConversionService.getFindingById(id);
      return (
        active ??
        (includeDeleted ? await outputConversionService.getDeletedFindingById(id) : undefined)
      );
    case "outputCandidate":
      active = await outputConversionService.getOutputCandidateById(id);
      return (
        active ??
        (includeDeleted
          ? await outputConversionService.getDeletedOutputCandidateById(id)
          : undefined)
      );
    case "outputGap":
      active = await outputConversionService.getOutputGapById(id);
      return (
        active ??
        (includeDeleted ? await outputConversionService.getDeletedOutputGapById(id) : undefined)
      );
    case "researchOutput":
      active = await outputService.getById(id);
      return active ?? (includeDeleted ? await outputService.getDeletedById(id) : undefined);
  }
}

function toOutputFileRefSummary(summary: FileRefPathSummary): OutputFileRefSummary {
  return {
    id: summary.id,
    ownerType: summary.ownerType,
    ownerId: summary.ownerId,
    fileName: summary.fileName,
    extension: summary.extension,
    fileKind: summary.fileKind,
    mimeType: summary.mimeType,
    sizeBytes: summary.sizeBytes,
    pathSummary: summary.pathSummary,
    availabilityStatus: summary.availabilityStatus,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt
  };
}

async function loadFileRefSummaries(layer: OutputEntityLayer, entity: OutputEntity) {
  const warnings: string[] = [];
  const summaries = new Map<string, OutputFileRefSummary>();
  try {
    const owned = await fileRefService.getFileRefPathSummariesByOwner(layer, entity.id);
    for (const item of owned) {
      summaries.set(item.id, toOutputFileRefSummary(item));
    }
    if (layer === "resultItem") {
      const fileRefId = (entity as ResultItem).fileRefId;
      if (fileRefId && !summaries.has(fileRefId)) {
        const fileRef = await fileRefService.getById(fileRefId);
        if (fileRef) {
          summaries.set(fileRef.id, toOutputFileRefSummary(fileRefService.buildFileRefPathSummary(fileRef)));
        } else {
          warnings.push(`FileRef metadata missing for resultItem/${entity.id}.`);
        }
      }
    }
  } catch (error) {
    const message = redactPathLikeText(error instanceof Error ? error.message : String(error));
    warnings.push(`FileRef metadata summary unavailable: ${message}`);
  }
  return { fileRefs: [...summaries.values()], warnings };
}

function relationCountsFor(
  layer: OutputEntityLayer,
  id: string,
  relations: OutputConversionRelation[]
) {
  const counts: Record<string, number> = {};
  for (const relation of relations) {
    if (
      (relation.sourceType === layer && relation.sourceId === id) ||
      (relation.targetType === layer && relation.targetId === id)
    ) {
      counts[relation.relationType] = (counts[relation.relationType] ?? 0) + 1;
    }
  }
  return counts;
}

async function relationSummariesFor(layer: OutputEntityLayer, id: string) {
  let outgoing: OutputConversionRelation[];
  let incoming: OutputConversionRelation[];
  try {
    [outgoing, incoming] = await Promise.all([
      outputConversionRelationService.queryOutputConversionRelations({
        sourceType: layer,
        sourceId: id
      }),
      outputConversionRelationService.queryOutputConversionRelations({
        targetType: layer,
        targetId: id
      })
    ]);
  } catch (error) {
    const message = redactPathLikeText(error instanceof Error ? error.message : String(error));
    return {
      relationSummary: [],
      warnings: [`Relation summary unavailable: ${message}`]
    };
  }
  const relations = [
    ...outgoing.map((relation) => ({ relation, direction: "outgoing" as const })),
    ...incoming.map((relation) => ({ relation, direction: "incoming" as const }))
  ];
  const warnings: string[] = [];
  const summaries = await Promise.all(
    relations.map(async ({ relation, direction }): Promise<OutputRelationSummary> => {
      const counterpartType =
        direction === "outgoing" ? relation.targetType : relation.sourceType;
      const counterpartId = direction === "outgoing" ? relation.targetId : relation.sourceId;
      let counterpart: OutputEntity | undefined;
      try {
        counterpart = await getLayerEntity(counterpartType, counterpartId);
      } catch (error) {
        const message = redactPathLikeText(error instanceof Error ? error.message : String(error));
        warnings.push(
          `Relation target lookup failed for ${counterpartType}/${counterpartId}: ${message}`
        );
      }
      if (!counterpart) {
        warnings.push(
          `Relation target missing for ${relation.relationType}: ${counterpartType}/${counterpartId}.`
        );
      }
      return {
        id: relation.id,
        relationType: relation.relationType,
        sourceType: relation.sourceType,
        sourceId: relation.sourceId,
        targetType: relation.targetType,
        targetId: relation.targetId,
        direction,
        targetMissing: !counterpart,
        targetTitle: counterpart ? titleOf(counterpartType, counterpart) : undefined
      };
    })
  );
  return { relationSummary: summaries, warnings };
}

async function toListItem(
  layer: OutputEntityLayer,
  entity: OutputEntity,
  relations: OutputConversionRelation[],
  relationWarnings: string[]
): Promise<OutputEntityListItemDto> {
  const { fileRefs, warnings: fileRefWarnings } = await loadFileRefSummaries(layer, entity);
  const warnings = [...relationWarnings, ...fileRefWarnings];
  const sources: OutputSelectorSource[] = [
    "entity",
    "structuredSummary",
    "outputConversionRelations",
    "fileRefSummary"
  ];
  const base = {
    layer,
    id: entity.id,
    projectId: entity.projectId,
    title: titleOf(layer, entity),
    status: entity.status,
    structuredSummaryPreview: structuredSummaryPreview(layer, entity),
    relationCounts: relationCountsFor(layer, entity.id, relations),
    fileRefCount: fileRefs.length,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
    deletedAt: entity.deletedAt ?? undefined,
    boundary: createBoundary(sources, warnings, false, warnings.length > 0)
  };
  return { ...base, layer: layer as FileAwareOutputEntityLayer } as OutputEntityListItemDto;
}

export async function listOutputEntities(
  query: OutputEntityListQuery
): Promise<OutputEntityListItemDto[]> {
  if (!query.projectId?.trim()) {
    throw new Error("listOutputEntities requires projectId.");
  }
  const entities = await listLayerEntities(query.layer, query.includeDeleted === true);
  let relations: OutputConversionRelation[] = [];
  const relationWarnings: string[] = [];
  try {
    relations = await outputConversionRelationService.queryOutputConversionRelations();
  } catch (error) {
    const message = redactPathLikeText(error instanceof Error ? error.message : String(error));
    relationWarnings.push(`Relation counts unavailable: ${message}`);
  }
  const filtered = stableSort(entities).filter(
    (entity) =>
      entity.projectId === query.projectId &&
      statusMatches(entity, query.status) &&
      (query.includeArchived === true || !isArchived(query.layer, entity)) &&
      keywordMatches(entity, query.keyword)
  );
  const offset = Math.max(0, query.offset ?? 0);
  const limit =
    query.limit === undefined ? filtered.length : Math.max(0, Math.floor(query.limit));
  return Promise.all(
    filtered
      .slice(offset, offset + limit)
      .map((entity) => toListItem(query.layer, entity, relations, relationWarnings))
  );
}

export async function getOutputEntityDetail(
  query: OutputEntityDetailQuery
): Promise<OutputEntityDetailDto> {
  const entity = await getLayerEntity(query.layer, query.id, query.includeDeleted === true);
  if (!entity) {
    const missingBase = {
      layer: query.layer,
      id: query.id,
      entity: null,
      structuredSummary: [],
      relationSummary: [],
      fileRefs: [],
      boundary: createBoundary([], ["Output entity was not found."], true, false)
    };
    return {
      ...missingBase,
      manuscript: {
        identityResolved: false,
        identityStatus: "not-found",
        availabilityStatus: "not-checked",
        warnings: ["Output entity was not found."]
      }
    } as OutputEntityDetailDto;
  }

  const [{ relationSummary, warnings: relationWarnings }, fileRefResult] = await Promise.all([
    relationSummariesFor(query.layer, entity.id),
    loadFileRefSummaries(query.layer, entity)
  ]);
  const warnings = [
    ...relationWarnings,
    ...fileRefResult.warnings,
    CHAIN_BOUNDARY_WARNING
  ];
  const sources: OutputSelectorSource[] = [
    "entity",
    "structuredSummary",
    "outputConversionRelations",
    "fileRefSummary"
  ];
  sources.push("manuscriptBinding");
  if (query.layer === "researchOutput") sources.push("researchOutput");
  if (
    query.layer === "outputGap" &&
    ((entity as OutputGap).relatedTaskId || (entity as OutputGap).relatedRouteNodeId)
  ) {
    sources.push("planningFeedbackReference");
    warnings.push("Cross-module planning feedback references are not expanded.");
  }
  const partial =
    relationSummary.some((relation) => relation.targetMissing) ||
    fileRefResult.warnings.length > 0;
  const base = {
    layer: query.layer,
    id: entity.id,
    projectId: entity.projectId,
    entity,
    status: entity.status,
    structuredSummary: canonicalPresentationSummary(query.layer, entity),
    relationSummary,
    fileRefs: fileRefResult.fileRefs,
    boundary: createBoundary(sources, warnings, false, partial)
  };
  const identity = await manuscriptBindingService.resolveIdentity({
    ownerType: query.layer,
    ownerId: entity.id,
    manuscriptChannel: "primary"
  });
  const currentFileRefId = identity.slots.currentFileRefId.fileRefId;
  const defaultFolderFileRefId = identity.slots.defaultFolderFileRefId.fileRefId;
  const current = currentFileRefId
    ? fileRefResult.fileRefs.find((fileRef) => fileRef.id === currentFileRefId)
    : undefined;
  const workspace = defaultFolderFileRefId
    ? fileRefResult.fileRefs.find((fileRef) => fileRef.id === defaultFolderFileRefId)
    : undefined;
  return {
    ...base,
    manuscript: {
      identityResolved: identity.identityResolved,
      identityStatus: identity.status,
      availabilityStatus: "not-checked",
      currentFilename: current?.fileName,
      workspaceSummary: workspace?.pathSummary,
      warnings: [
        ...identity.errors,
        ...(currentFileRefId && !current
          ? ["Current manuscript display metadata is unavailable."]
          : [])
      ]
    }
  } as OutputEntityDetailDto;
}

export function listResultItems(filters: OutputEntityListFilters) {
  return listOutputEntities({ ...filters, layer: "resultItem" });
}

export function listFindings(filters: OutputEntityListFilters) {
  return listOutputEntities({ ...filters, layer: "finding" });
}

export function listOutputCandidates(filters: OutputEntityListFilters) {
  return listOutputEntities({ ...filters, layer: "outputCandidate" });
}

export function listOutputGaps(filters: OutputEntityListFilters) {
  return listOutputEntities({ ...filters, layer: "outputGap" });
}

export function listResearchOutputs(filters: OutputEntityListFilters) {
  return listOutputEntities({ ...filters, layer: "researchOutput" });
}

export async function getResultItemDetail(
  id: string,
  options: OutputEntityDetailOptions = {}
): Promise<OutputEntityDetailDto<OutputEntityByLayer["resultItem"]>> {
  return getOutputEntityDetail({ layer: "resultItem", id, ...options }) as Promise<
    OutputEntityDetailDto<OutputEntityByLayer["resultItem"]>
  >;
}

export async function getFindingDetail(
  id: string,
  options: OutputEntityDetailOptions = {}
): Promise<OutputEntityDetailDto<OutputEntityByLayer["finding"]>> {
  return getOutputEntityDetail({ layer: "finding", id, ...options }) as Promise<
    OutputEntityDetailDto<OutputEntityByLayer["finding"]>
  >;
}

export async function getOutputCandidateDetail(
  id: string,
  options: OutputEntityDetailOptions = {}
): Promise<OutputEntityDetailDto<OutputEntityByLayer["outputCandidate"]>> {
  return getOutputEntityDetail({ layer: "outputCandidate", id, ...options }) as Promise<
    OutputEntityDetailDto<OutputEntityByLayer["outputCandidate"]>
  >;
}

export async function getOutputGapDetail(
  id: string,
  options: OutputEntityDetailOptions = {}
): Promise<OutputEntityDetailDto<OutputEntityByLayer["outputGap"]>> {
  return getOutputEntityDetail({ layer: "outputGap", id, ...options }) as Promise<
    OutputEntityDetailDto<OutputEntityByLayer["outputGap"]>
  >;
}

export async function getResearchOutputDetail(
  id: string,
  options: OutputEntityDetailOptions = {}
): Promise<OutputEntityDetailDto<OutputEntityByLayer["researchOutput"]>> {
  return getOutputEntityDetail({ layer: "researchOutput", id, ...options }) as Promise<
    OutputEntityDetailDto<OutputEntityByLayer["researchOutput"]>
  >;
}

export const outputFiveLayerSelectorService = {
  listOutputEntities,
  getOutputEntityDetail,
  listResultItems,
  listFindings,
  listOutputCandidates,
  listOutputGaps,
  listResearchOutputs,
  getResultItemDetail,
  getFindingDetail,
  getOutputCandidateDetail,
  getOutputGapDetail,
  getResearchOutputDetail
};

export type OutputFiveLayerSelectorService = typeof outputFiveLayerSelectorService;
