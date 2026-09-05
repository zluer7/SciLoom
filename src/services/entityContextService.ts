import { experimentRunService } from "./experimentRunService";
import { experimentService } from "./experimentService";
import { fileRefService } from "./fileRefService";
import { literatureService } from "./literatureService";
import { outputConversionService } from "./outputConversionService";
import { outputService } from "./outputService";
import { getPlanningData } from "./planningRepository";
import { planningService } from "./planningService";
import { resultMetricService } from "./resultMetricService";
import { entityLinkService } from "./entityLinkService";
import type { EntityId } from "../types";
import type {
  EntityCrossModuleContext,
  EntityContextSourceModule,
  EntitySummary,
  EvidenceSummary,
  LinkedEntitySummary,
  TargetSummary
} from "../types/entityContext";
import type { MissingEntityReference, MissingEntityReferenceReason } from "../types/entityReference";
import type { LiteratureLinkTargetType } from "../types/literature";
import type { EntityLink, EntityType, PlanningData, RelationType } from "../types/planning";

type SummaryRecord = {
  title?: string;
  name?: string;
  outputName?: string;
  description?: string;
  summary?: string;
  status?: string;
  readingStatus?: string;
  tags?: string[];
  createdAt?: string;
  updatedAt?: string;
};

const evidenceRelationTypes = new Set<string>([
  "supports",
  "supported_by",
  "evidence_for",
  "derived_from",
  "references",
  "cites",
  "requires",
  "supplements",
  "generates_finding",
  "supports_output",
  "needs_followup_task",
  "background_support",
  "core_related_work",
  "method_reference",
  "theory_support",
  "problem_source",
  "baseline",
  "parameter_reference",
  "data_processing_reference",
  "evaluation_metric_reference",
  "experiment_comparison",
  "result_interpretation",
  "writing_support",
  "patent_background"
]);

function sourceModuleForType(entityType: EntityType): EntityContextSourceModule {
  switch (entityType) {
    case "researchDirection":
    case "project":
    case "route":
    case "routeNode":
    case "task":
    case "review":
    case "experimentSummary":
    case "aiContext":
      return "planning";
    case "experiment":
    case "experimentRun":
    case "resultMetric":
    case "fileRef":
      return "experiment";
    case "literature":
    case "literatureLink":
      return "literature";
    case "resultItem":
    case "finding":
    case "outputCandidate":
    case "outputGap":
      return "outputConversion";
    case "output":
      return "output";
    default:
      return "unknown";
  }
}

function missingSummary(
  entityType: EntityType,
  entityId: EntityId,
  missingReason = "Target entity was not found."
): EntitySummary {
  return {
    entityType,
    entityId,
    title: `${entityType}:${entityId}`,
    sourceModule: sourceModuleForType(entityType),
    sourceAvailable: false,
    missingReason
  };
}

function reasonForMissingSummary(summary: EntitySummary): MissingEntityReferenceReason {
  return summary.missingReason?.includes("No read-only summary resolver")
    ? "unsupported_target_type"
    : "target_not_found";
}

function missingReferenceForSummary(
  summary: EntitySummary,
  source?: EntitySummary,
  relationType?: RelationType | string
): MissingEntityReference {
  return {
    sourceType: source?.entityType,
    sourceId: source?.entityId,
    targetType: summary.entityType,
    targetId: summary.entityId,
    relationType: relationType ? String(relationType) : undefined,
    reason: reasonForMissingSummary(summary),
    message: summary.missingReason
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

function summaryTagsForEntity(entityType: EntityType, record: SummaryRecord) {
  if (entityType === "fileRef") {
    return undefined;
  }
  return record.tags ?? [];
}

function warningForMissingReference(reference: MissingEntityReference) {
  const source =
    reference.sourceType && reference.sourceId
      ? `${reference.sourceType}:${reference.sourceId} -> `
      : "";
  return [
    `Missing reference: ${source}${reference.targetType}:${reference.targetId}`,
    `reason=${reference.reason}`,
    reference.message
  ]
    .filter(Boolean)
    .join(" | ");
}

function missingReferencesForLinks(links: LinkedEntitySummary[]) {
  return links.flatMap((link) => {
    const references: MissingEntityReference[] = [];
    if (!link.source.sourceAvailable) {
      references.push(missingReferenceForSummary(link.source, link.target, link.relationType));
    }
    if (!link.target.sourceAvailable) {
      references.push(missingReferenceForSummary(link.target, link.source, link.relationType));
    }
    return references;
  });
}

function summaryFromRecord(
  entityType: EntityType,
  entityId: EntityId,
  record: SummaryRecord | undefined,
  fallbackTitle?: string
): EntitySummary {
  if (!record) {
    return missingSummary(entityType, entityId);
  }

  return {
    entityType,
    entityId,
    title: record.title ?? record.name ?? record.outputName ?? fallbackTitle ?? `${entityType}:${entityId}`,
    subtitle: record.summary ?? record.description,
    status: record.status ?? record.readingStatus,
    tags: summaryTagsForEntity(entityType, record),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    sourceModule: sourceModuleForType(entityType),
    sourceAvailable: true
  };
}

function literatureTargetTypeToEntityType(targetType: LiteratureLinkTargetType): EntityType {
  switch (targetType) {
    case "route":
      return "route";
    case "task":
      return "task";
    case "experiment":
      return "experiment";
    case "experimentRun":
      return "experimentRun";
    case "resultMetric":
      return "resultMetric";
    case "fileRef":
      return "fileRef";
    case "resultItem":
      return "resultItem";
    case "finding":
      return "finding";
    case "outputCandidate":
      return "outputCandidate";
    case "outputGap":
      return "outputGap";
    case "output":
      return "output";
    case "review":
      return "review";
    case "aiContext":
      return "aiContext";
    case "project":
      return "project";
    case "other":
    default:
      return "other";
  }
}

function entityTypeToLiteratureTargetType(
  entityType: EntityType
): LiteratureLinkTargetType | undefined {
  switch (entityType) {
    case "project":
      return "project";
    case "route":
    case "routeNode":
      return "route";
    case "task":
      return "task";
    case "experiment":
      return "experiment";
    case "experimentRun":
      return "experimentRun";
    case "resultMetric":
      return "resultMetric";
    case "fileRef":
      return "fileRef";
    case "resultItem":
      return "resultItem";
    case "finding":
      return "finding";
    case "outputCandidate":
      return "outputCandidate";
    case "outputGap":
      return "outputGap";
    case "output":
      return "output";
    case "review":
      return "review";
    case "aiContext":
      return "aiContext";
    case "other":
      return "other";
    default:
      return undefined;
  }
}

async function getLiteratureLinkTargetSummary(entityId: EntityId) {
  const links = await literatureService.queryLiteratureLinks({});
  const link = links.find((item) => item.id === entityId);
  return summaryFromRecord("literatureLink", entityId, link, `Literature link ${entityId}`);
}

async function getPlanningDataSummary(
  entityType: EntityType,
  entityId: EntityId,
  selector: (data: PlanningData) => SummaryRecord | undefined,
  fallbackTitle?: string
) {
  const data = await getPlanningData();
  return summaryFromRecord(entityType, entityId, selector(data), fallbackTitle);
}

export async function getEntityTargetSummary(
  entityType: EntityType,
  entityId: EntityId
): Promise<TargetSummary> {
  switch (entityType) {
    case "researchDirection":
      return getPlanningDataSummary(entityType, entityId, (data) =>
        data.researchDirections.find((direction) => direction.id === entityId)
      );
    case "project":
      return summaryFromRecord(entityType, entityId, await planningService.getProjectById(entityId));
    case "route":
    case "routeNode":
      return summaryFromRecord(
        entityType,
        entityId,
        await planningService.getRouteNodeById(entityId)
      );
    case "task":
      return summaryFromRecord(entityType, entityId, await planningService.getTaskById(entityId));
    case "review":
      return summaryFromRecord(entityType, entityId, await planningService.getReviewById(entityId));
    case "experiment":
      return summaryFromRecord(
        entityType,
        entityId,
        await experimentService.getExperimentById(entityId)
      );
    case "experimentRun":
      return summaryFromRecord(
        entityType,
        entityId,
        await experimentRunService.getRunById(entityId)
      );
    case "resultMetric":
      return summaryFromRecord(
        entityType,
        entityId,
        await resultMetricService.getById(entityId)
      );
    case "fileRef":
      return summaryFromRecord(entityType, entityId, await fileRefService.getById(entityId));
    case "output": {
      return summaryFromRecord(entityType, entityId, await outputService.getById(entityId));
    }
    case "resultItem":
      return summaryFromRecord(
        entityType,
        entityId,
        await outputConversionService.getResultItemById(entityId)
      );
    case "finding":
      return summaryFromRecord(
        entityType,
        entityId,
        await outputConversionService.getFindingById(entityId)
      );
    case "outputCandidate":
      return summaryFromRecord(
        entityType,
        entityId,
        await outputConversionService.getOutputCandidateById(entityId)
      );
    case "outputGap":
      return summaryFromRecord(
        entityType,
        entityId,
        await outputConversionService.getOutputGapById(entityId)
      );
    case "literature":
      return summaryFromRecord(
        entityType,
        entityId,
        await literatureService.getLiteratureById(entityId)
      );
    case "literatureLink":
      return getLiteratureLinkTargetSummary(entityId);
    case "experimentSummary":
      return getPlanningDataSummary(entityType, entityId, (data) =>
        data.experimentSummaries.find((experimentSummary) => experimentSummary.id === entityId)
      );
    case "aiContext":
    case "other":
    default:
      return missingSummary(
        entityType,
        entityId,
        "No read-only summary resolver is available for this entity type yet."
      );
  }
}

async function summarizeEntityLink(link: EntityLink): Promise<LinkedEntitySummary> {
  const [source, target] = await Promise.all([
    getEntityTargetSummary(link.sourceType, link.sourceId),
    getEntityTargetSummary(link.targetType, link.targetId)
  ]);

  return {
    linkId: link.id,
    source,
    target,
    relationType: link.relationType,
    description: link.description,
    linkSource: "entityLink",
    createdAt: link.createdAt,
    updatedAt: link.updatedAt
  };
}

async function getOutgoingLiteratureLinkSummaries(
  entityType: EntityType,
  entityId: EntityId
): Promise<LinkedEntitySummary[]> {
  if (entityType !== "literature") {
    return [];
  }

  const links = await literatureService.queryLiteratureLinks({ literatureId: entityId });
  const literatureSummary = await getEntityTargetSummary("literature", entityId);

  return Promise.all(
    links.map(async (link) => ({
      linkId: link.id,
      source: literatureSummary,
      target: await getEntityTargetSummary(
        literatureTargetTypeToEntityType(link.targetType),
        link.targetId
      ),
      relationType: link.relationType,
      description: link.description,
      note: link.note,
      confidence: link.confidence,
      evidenceRole: link.role,
      linkSource: "literatureLink" as const,
      createdAt: link.createdAt,
      updatedAt: link.updatedAt
    }))
  );
}

async function getIncomingLiteratureLinkSummaries(
  entityType: EntityType,
  entityId: EntityId
): Promise<LinkedEntitySummary[]> {
  const targetType = entityTypeToLiteratureTargetType(entityType);
  if (!targetType) {
    return [];
  }

  const links = await literatureService.getLinksByTarget(targetType, entityId);
  const targetSummary = await getEntityTargetSummary(entityType, entityId);

  return Promise.all(
    links.map(async (link) => ({
      linkId: link.id,
      source: await getEntityTargetSummary("literature", link.literatureId),
      target: targetSummary,
      relationType: link.relationType,
      description: link.description,
      note: link.note,
      confidence: link.confidence,
      evidenceRole: link.role,
      linkSource: "literatureLink" as const,
      createdAt: link.createdAt,
      updatedAt: link.updatedAt
    }))
  );
}

function linkedSummaryToEvidenceSummary(
  linkedSummary: LinkedEntitySummary,
  baseType: EntityType,
  baseId: EntityId
): EvidenceSummary {
  const sourceIsBase =
    linkedSummary.source.entityType === baseType && linkedSummary.source.entityId === baseId;
  const evidence = sourceIsBase ? linkedSummary.target : linkedSummary.source;

  return {
    evidenceType: evidence.entityType,
    evidenceId: evidence.entityId,
    title: evidence.title,
    contentSummary: evidence.subtitle,
    relationType: linkedSummary.relationType,
    evidenceRole: linkedSummary.evidenceRole,
    confidence: linkedSummary.confidence,
    sourceModule: evidence.sourceModule,
    source: evidence
  };
}

export async function getLinkedEntitySummaries(
  entityType: EntityType,
  entityId: EntityId
): Promise<LinkedEntitySummary[]> {
  const [entityLinks, literatureLinks] = await Promise.all([
    entityLinkService.queryLinksBySource(entityType, entityId),
    getOutgoingLiteratureLinkSummaries(entityType, entityId)
  ]);
  const entityLinkSummaries = await Promise.all(entityLinks.map(summarizeEntityLink));
  return [...entityLinkSummaries, ...literatureLinks];
}

export async function getBackReferenceSummaries(
  entityType: EntityType,
  entityId: EntityId
): Promise<LinkedEntitySummary[]> {
  const [entityLinks, literatureLinks] = await Promise.all([
    entityLinkService.queryLinksByTarget(entityType, entityId),
    getIncomingLiteratureLinkSummaries(entityType, entityId)
  ]);
  const entityLinkSummaries = await Promise.all(entityLinks.map(summarizeEntityLink));
  return [...entityLinkSummaries, ...literatureLinks];
}

export async function getEvidenceSummariesForEntity(
  entityType: EntityType,
  entityId: EntityId
): Promise<EvidenceSummary[]> {
  const [outgoingLinks, incomingLinks] = await Promise.all([
    getLinkedEntitySummaries(entityType, entityId),
    getBackReferenceSummaries(entityType, entityId)
  ]);

  return [...outgoingLinks, ...incomingLinks]
    .filter(
      (link) =>
        link.linkSource === "literatureLink" || evidenceRelationTypes.has(String(link.relationType))
    )
    .map((link) => linkedSummaryToEvidenceSummary(link, entityType, entityId));
}

export async function getEntityCrossModuleContext(
  entityType: EntityType,
  entityId: EntityId
): Promise<EntityCrossModuleContext> {
  const [entity, outgoingLinks, incomingLinks, evidenceSummaries] = await Promise.all([
    getEntityTargetSummary(entityType, entityId),
    getLinkedEntitySummaries(entityType, entityId),
    getBackReferenceSummaries(entityType, entityId),
    getEvidenceSummariesForEntity(entityType, entityId)
  ]);
  const missingReferences = uniqueMissingReferences([
    ...(entity.sourceAvailable ? [] : [missingReferenceForSummary(entity)]),
    ...missingReferencesForLinks(outgoingLinks),
    ...missingReferencesForLinks(incomingLinks)
  ]);
  const warnings = missingReferences.map(warningForMissingReference);

  return {
    entity,
    outgoingLinks,
    incomingLinks,
    linkedEntities: outgoingLinks,
    backReferences: incomingLinks,
    evidenceSummaries,
    warnings,
    missingReferences,
    partial: missingReferences.length > 0
  };
}

export const entityContextService = {
  getEntityTargetSummary,
  getLinkedEntitySummaries,
  getBackReferenceSummaries,
  getEvidenceSummariesForEntity,
  getEntityCrossModuleContext
};

export type EntityContextService = typeof entityContextService;
