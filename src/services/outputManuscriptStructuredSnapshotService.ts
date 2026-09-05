import {
  findingRepositoryConfig,
  outputCandidateRepositoryConfig,
  outputGapRepositoryConfig,
  outputRepositoryConfig,
  resultItemRepositoryConfig
} from "../repositories/entityConfig";
import { createRepository } from "../repositories/repositoryFactory";
import type {
  Finding,
  OutputCandidate,
  OutputGap,
  OutputManuscriptOwnerType,
  OutputManuscriptRelationSummary,
  OutputManuscriptSourceSummary,
  OutputManuscriptStructuredSnapshot,
  ResearchOutput,
  ResultItem
} from "../types";
import type { EntityId } from "../types/common";
import type { OutputConversionRelation, OutputSourceSummary } from "../types/outputConversion";
import { normalizeStructuredSummary } from "../types/outputStructuredSummary";
import { getOutputManuscriptStaticDescriptor } from "./outputManuscriptDescriptorService";
import { queryOutputConversionRelations } from "./outputConversionRelationService";
import { getOutputGapFeedbackSummary } from "./outputGapFeedbackSelectorService";
import { normalizeResearchOutputOwnerAlias } from "./outputResearchOutputAliasAdapter";
import { getOutputSourceSummary } from "./outputSourceSelectorService";
import { getPlanningFirstLayerData } from "./planningRepository";
import { readOutputDirectCanonicalValue } from "./outputCanonicalValueCoherenceService";

type OwnerEntity = ResultItem | Finding | OutputCandidate | OutputGap | ResearchOutput;
type ProjectSummary = { id: EntityId; title: string; deletedAt?: string | null };

const repositories = {
  resultItem: createRepository<ResultItem>(resultItemRepositoryConfig),
  finding: createRepository<Finding>(findingRepositoryConfig),
  outputCandidate: createRepository<OutputCandidate>(outputCandidateRepositoryConfig),
  outputGap: createRepository<OutputGap>(outputGapRepositoryConfig),
  researchOutput: createRepository<ResearchOutput>(outputRepositoryConfig)
};

async function loadOwner(ownerType: OutputManuscriptOwnerType, ownerId: EntityId) {
  const repository = repositories[ownerType];
  return (await repository.getById(ownerId)) ?? (await repository.getDeletedById(ownerId));
}

async function loadProject(projectId: EntityId) {
  return (await getPlanningFirstLayerData()).projects.find((project) => project.id === projectId);
}

async function loadRelations(ownerType: OutputManuscriptOwnerType, ownerId: EntityId) {
  const [incoming, outgoing] = await Promise.all([
    queryOutputConversionRelations({ targetType: ownerType, targetId: ownerId }),
    queryOutputConversionRelations({ sourceType: ownerType, sourceId: ownerId })
  ]);
  return { incoming, outgoing };
}

export interface OutputManuscriptStructuredSnapshotDependencies {
  loadOwner(ownerType: OutputManuscriptOwnerType, ownerId: EntityId): Promise<OwnerEntity | undefined>;
  loadProject(projectId: EntityId): Promise<ProjectSummary | undefined>;
  loadRelations(ownerType: OutputManuscriptOwnerType, ownerId: EntityId): Promise<{
    incoming: OutputConversionRelation[];
    outgoing: OutputConversionRelation[];
  }>;
  loadSources(ownerType: OutputManuscriptOwnerType, ownerId: EntityId): Promise<OutputSourceSummary>;
  loadGapFeedback(outputGapId: EntityId): Promise<Awaited<ReturnType<typeof getOutputGapFeedbackSummary>>>;
}

const defaultDependencies: OutputManuscriptStructuredSnapshotDependencies = {
  loadOwner,
  loadProject,
  loadRelations,
  loadSources: getOutputSourceSummary,
  loadGapFeedback: getOutputGapFeedbackSummary
};

const SECTION_ORDER = Object.freeze([
  "identity",
  "summary",
  "layer",
  "relations",
  "sources",
  "provenance",
  "warnings"
] as const);

function relationSummaries(input: {
  incoming: OutputConversionRelation[];
  outgoing: OutputConversionRelation[];
}): OutputManuscriptRelationSummary[] {
  return [
    ...input.incoming.map((relation) => ({
      direction: "incoming" as const,
      relationType: relation.relationType,
      counterpartType: relation.sourceType,
      counterpartId: relation.sourceId,
      note: relation.note ?? undefined
    })),
    ...input.outgoing.map((relation) => ({
      direction: "outgoing" as const,
      relationType: relation.relationType,
      counterpartType: relation.targetType,
      counterpartId: relation.targetId,
      note: relation.note ?? undefined
    }))
  ].sort((left, right) =>
    left.direction.localeCompare(right.direction, "en") ||
    left.relationType.localeCompare(right.relationType, "en") ||
    left.counterpartType.localeCompare(right.counterpartType, "en") ||
    left.counterpartId.localeCompare(right.counterpartId, "en")
  );
}

function sourceSummaries(input: OutputSourceSummary): OutputManuscriptSourceSummary[] {
  return input.cards.map((card) => ({
    sourceType: card.sourceType,
    sourceId: card.sourceId ?? undefined,
    title: card.sourceTitle,
    summary: card.sourceSummarySnapshot ?? undefined,
    relationType: card.relationType,
    status: card.sourceStatus
  })).sort((left, right) =>
    left.sourceType.localeCompare(right.sourceType, "en") ||
    (left.sourceId ?? "").localeCompare(right.sourceId ?? "", "en") ||
    left.title.localeCompare(right.title, "en")
  );
}

function displayTitle(ownerType: OutputManuscriptOwnerType, owner: OwnerEntity) {
  return ownerType === "researchOutput"
    ? (owner as ResearchOutput).outputName
    : (owner as Exclude<OwnerEntity, ResearchOutput>).title;
}

function ownerStatus(owner: OwnerEntity) {
  return "status" in owner ? String(owner.status ?? "") : "";
}

function ownerTypeValue(ownerType: OutputManuscriptOwnerType, owner: OwnerEntity) {
  switch (ownerType) {
    case "resultItem": return (owner as ResultItem).resultType;
    case "finding": return (owner as Finding).findingType ?? "finding";
    case "outputCandidate": return (owner as OutputCandidate).candidateType;
    case "outputGap": return (owner as OutputGap).gapType;
    case "researchOutput": return (owner as ResearchOutput).outputType;
  }
}

export function createOutputManuscriptStructuredSnapshotService(
  dependencies: OutputManuscriptStructuredSnapshotDependencies = defaultDependencies
) {
  return {
    async get(
      ownerType: OutputManuscriptOwnerType,
      ownerId: EntityId,
      currentFilename?: string
    ): Promise<OutputManuscriptStructuredSnapshot> {
      const descriptor = getOutputManuscriptStaticDescriptor(ownerType);
      const owner = await dependencies.loadOwner(ownerType, ownerId);
      if (!owner) throw new Error(`OUTPUT_MANUSCRIPT_FILE_OWNER_NOT_FOUND: ${ownerType}/${ownerId}.`);
      if (owner.deletedAt) throw new Error(`OUTPUT_MANUSCRIPT_FILE_OWNER_DELETED: ${ownerType}/${ownerId}.`);
      const project = await dependencies.loadProject(owner.projectId);
      if (!project || project.deletedAt) {
        throw new Error(`OUTPUT_MANUSCRIPT_PROJECT_NOT_ACTIVE: ${owner.projectId}.`);
      }
      const [relations, sources, gapFeedback] = await Promise.all([
        dependencies.loadRelations(ownerType, ownerId),
        dependencies.loadSources(ownerType, ownerId),
        ownerType === "outputGap" ? dependencies.loadGapFeedback(ownerId) : Promise.resolve(null)
      ]);
      const warnings = [
        ...(sources.hasMissingSources ? ["OUTPUT_MANUSCRIPT_SOURCE_MISSING"] : []),
        ...(gapFeedback?.warnings ?? [])
      ];
      const base = {
        ownerType,
        ownerId,
        channel: "primary" as const,
        projectId: owner.projectId,
        projectTitle: project.title,
        entityKind: descriptor.entityKind,
        displayTitle: displayTitle(ownerType, owner),
        briefDescription: readOutputDirectCanonicalValue(ownerType, owner),
        status: ownerStatus(owner),
        type: ownerTypeValue(ownerType, owner),
        createdAt: owner.createdAt,
        updatedAt: owner.updatedAt,
        tags: "tags" in owner ? [...(owner.tags ?? [])] : [],
        currentFilename,
        structuredSummary: normalizeStructuredSummary(ownerType, owner.structuredSummary),
        relations: relationSummaries(relations),
        sources: sourceSummaries(sources),
        provenance: [
          `owner:${ownerType}`,
          ...sourceSummaries(sources).map((source) => `source:${source.sourceType}:${source.status}`)
        ],
        warnings,
        sectionOrder: SECTION_ORDER
      };
      switch (ownerType) {
        case "resultItem": {
          const item = owner as ResultItem;
          return { ...base, ownerType, layer: {
            resultType: item.resultType,
            sourceType: item.sourceType,
            sourceId: item.sourceId,
            value: item.value === undefined ? undefined : typeof item.value === "string" ? item.value : JSON.stringify(item.value),
            unit: item.unit,
            isAsset: item.isAsset === true,
            assetQuality: item.assetQuality,
            experimentId: item.experimentId ?? undefined,
            experimentRunId: item.experimentRunId ?? undefined,
            resultMetricId: item.sourceType === "resultMetric" ? item.sourceId : undefined,
            pathSummary: item.fileRefId ? "linked file reference" : undefined
          } };
        }
        case "finding": {
          const finding = owner as Finding;
          return { ...base, ownerType, layer: {
            findingType: finding.findingType,
            confidence: finding.confidence,
            maturity: finding.maturity
          } };
        }
        case "outputCandidate": {
          const candidate = owner as OutputCandidate;
          return { ...base, ownerType, layer: {
            businessEntity: "OutputCandidate",
            candidateType: candidate.candidateType,
            maturity: candidate.maturity,
            priority: candidate.priority
          } };
        }
        case "outputGap": {
          const gap = owner as OutputGap;
          return { ...base, ownerType, layer: {
            gapType: gap.gapType,
            priority: gap.priority,
            resolvedAt: gap.resolvedAt ?? undefined,
            relatedTaskId: gap.relatedTaskId ?? undefined,
            relatedRouteNodeId: gap.relatedRouteNodeId ?? undefined,
            feedbackSummary: gapFeedback
              ? `${gapFeedback.counts.total} feedback target(s), ${gapFeedback.counts.pendingFeedbackCards} pending card(s)`
              : undefined
          } };
        }
        case "researchOutput": {
          const output = owner as ResearchOutput;
          return { ...base, ownerType, layer: {
            canonicalOwnerType: normalizeResearchOutputOwnerAlias(ownerType),
            outputType: output.outputType,
            description: output.description,
            usableForPaper: output.usableForPaper,
            sourceOutputCandidateId: output.provenance?.sourceCandidateId ?? undefined,
            taskId: output.taskId,
            experimentId: output.experimentId
          } };
        }
      }
    }
  };
}

export const outputManuscriptStructuredSnapshotService =
  createOutputManuscriptStructuredSnapshotService();

export { normalizeResearchOutputOwnerAlias } from "./outputResearchOutputAliasAdapter";
