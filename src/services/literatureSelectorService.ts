import { experimentRunService } from "./experimentRunService";
import { experimentService } from "./experimentService";
import { fileRefService, summarizeFileRefPath } from "./fileRefService";
import { literatureService } from "./literatureService";
import { outputConversionService } from "./outputConversionService";
import { getOutputCandidateDetailDTO } from "./outputConversionSelectorService";
import { outputService } from "./outputService";
import { getPlanningData } from "./planningRepository";
import { resultMetricService } from "./resultMetricService";
import {
  literatureLinkToTargetReference,
  validateEntityReference
} from "./entityReferenceResolverService";
import {
  buildLiteratureMarkdownContextSummary,
  buildLiteratureReadContext,
  buildLiteratureStructuredSummaries
} from "./literatureFieldMappingService";
import { getLiteratureManuscriptStatus } from "./literatureManuscriptService";
import {
  literatureCurrentFilenameService,
  toLiteratureManuscriptStatusSummary
} from "./literatureCurrentFilenameService";
import { manuscriptBindingService } from "./manuscriptBindingService";
import { manuscriptProvisioningReadinessInspector } from "./manuscriptProvisioningReadinessInspector";
import type {
  EntityId,
  FileRef,
  Literature,
  LiteratureEvidenceRole,
  LiteratureLink,
  LiteratureLinkTargetType,
  LiteratureReadingStatus,
  LiteratureRelationType
} from "../types";
import type { MissingEntityReference } from "../types/entityReference";
import type {
  AiLiteratureContext,
  AiLiteratureContextOptions,
  LiteratureAiReadingStatsSummary,
  LiteratureDetailContext,
  LiteratureFileRefSummary,
  LiteratureLinkedTargetSummary,
  LiteratureLinkSummary,
  LiteratureReadingStats,
  LiteratureSupportGap,
  LiteratureWorkloadOverview,
  LiteratureWorkloadQuery,
  OutputCandidateLiteratureContext,
  ProjectLiteratureContext,
  RouteLiteratureContext,
  TaskLiteratureContext,
  ExperimentLiteratureContext
} from "../types/literatureContext";

type LiteratureModuleData = {
  literatures: Literature[];
  links: LiteratureLink[];
};

type ScopeQuery = {
  projectId?: EntityId;
  routeId?: EntityId;
  taskId?: EntityId;
};

function isDefined<T>(value: T | undefined | null): value is T {
  return value !== undefined && value !== null;
}

function sanitizeAiContextText(value: string, limit = 500) {
  const sanitized = value
    .replace(/[A-Za-z]:[\\/][^\s|)]+/g, "[local path redacted]")
    .replace(/\\\\[^\s|)]+/g, "[local path redacted]")
    .replace(/(^|[\s(])\/(?:Users|home|mnt|Volumes|var|tmp)\/[^\s)]+/g, "$1[local path redacted]")
    .trim();
  if (sanitized.length <= limit) return sanitized;
  return `${sanitized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function toPlainCountRecord<T extends string>(
  input: Partial<Record<T, number>>
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => typeof value === "number")
  ) as Record<string, number>;
}

function uniqueById<T extends { id: EntityId }>(items: T[]): T[] {
  const map = new Map<EntityId, T>();
  items.forEach((item) => {
    if (!map.has(item.id)) {
      map.set(item.id, item);
    }
  });
  return [...map.values()];
}

function indexById<T extends { id: EntityId }>(items: T[]) {
  return new Map(items.map((item) => [item.id, item] as const));
}

function sortByUpdatedAtDesc<T extends { updatedAt: string; createdAt?: string }>(items: T[]) {
  return [...items].sort((left, right) => {
    const updatedDiff = right.updatedAt.localeCompare(left.updatedAt);
    return updatedDiff || (right.createdAt ?? "").localeCompare(left.createdAt ?? "");
  });
}

export interface LiteratureDetailAuthorityAggregationCoordinator {
  run<T>(literatureId: EntityId, operation: () => Promise<T>): Promise<T>;
}

/**
 * Serializes authority-bearing Literature detail aggregates for one owner.
 *
 * The native authority registry intentionally rejects same-caller re-entry on
 * an already-held hierarchy key. React mount/refresh paths may request the same
 * Literature detail concurrently, so those requests must enter the authority
 * boundary in owner order. The coordinator retains no result data and does not
 * couple different owners.
 */
export function createLiteratureDetailAuthorityAggregationCoordinator(): LiteratureDetailAuthorityAggregationCoordinator {
  const ownerTails = new Map<EntityId, Promise<void>>();

  return Object.freeze({
    async run<T>(literatureId: EntityId, operation: () => Promise<T>): Promise<T> {
      const predecessor = ownerTails.get(literatureId) ?? Promise.resolve();
      let releaseTurn!: () => void;
      const turn = new Promise<void>((resolve) => {
        releaseTurn = resolve;
      });
      const tail = predecessor.then(() => turn);
      ownerTails.set(literatureId, tail);

      await predecessor;
      try {
        return await operation();
      } finally {
        releaseTurn();
        if (ownerTails.get(literatureId) === tail) {
          ownerTails.delete(literatureId);
        }
      }
    }
  });
}

const literatureDetailAuthorityAggregationCoordinator =
  createLiteratureDetailAuthorityAggregationCoordinator();

function fileRefToLiteratureSummary(fileRef: FileRef): LiteratureFileRefSummary {
  return {
    id: fileRef.id,
    title: fileRef.title,
    fileType: fileRef.fileType,
    description: fileRef.description,
    path: fileRef.path,
    pathSummary: summarizeFileRefPath(fileRef.path),
    resourceKind: fileRef.resourceKind,
    fileRole: fileRef.fileRole,
    locationMode: fileRef.locationMode,
    createdAt: fileRef.createdAt,
    updatedAt: fileRef.updatedAt,
    deleted: Boolean(fileRef.deletedAt)
  };
}

export async function getLiteratureFileRefSummaries(
  literatureId: EntityId
): Promise<LiteratureFileRefSummary[]> {
  const fileRefs = await fileRefService.getFileRefsByOwner("literature", literatureId);
  const outlineIdentity = await manuscriptBindingService.resolveIdentity({
    ownerType: "literature",
    ownerId: literatureId,
    manuscriptChannel: "literature_outline"
  });
  const notesIdentity = await manuscriptBindingService.resolveIdentity({
    ownerType: "literature",
    ownerId: literatureId,
    manuscriptChannel: "dedicated_notes"
  });
  const outlineFolderId = outlineIdentity.slots.defaultFolderFileRefId.fileRefId;
  const notesFolderId = notesIdentity.slots.defaultFolderFileRefId.fileRefId;
  const sharedFolderFileRefId =
    outlineIdentity.identityResolved &&
    notesIdentity.identityResolved &&
    outlineFolderId &&
    outlineFolderId === notesFolderId
      ? outlineFolderId
      : undefined;
  return fileRefs
    .filter(
      (fileRef) =>
        !fileRef.deletedAt &&
        (
          fileRef.fileRole === "attachment" ||
          (
            fileRef.fileRole === "defaultFolder" &&
            fileRef.id === sharedFolderFileRefId
          )
        )
    )
    .map(fileRefToLiteratureSummary)
    .sort((left, right) => {
      const leftDefault =
        left.id === sharedFolderFileRefId &&
        left.resourceKind === "folder" &&
        left.fileRole === "defaultFolder" &&
        left.locationMode === "managed";
      const rightDefault =
        right.id === sharedFolderFileRefId &&
        right.resourceKind === "folder" &&
        right.fileRole === "defaultFolder" &&
        right.locationMode === "managed";
      if (leftDefault !== rightDefault) return leftDefault ? -1 : 1;
      return right.updatedAt.localeCompare(left.updatedAt);
    });
}

function addCount<T extends string>(record: Partial<Record<T, number>>, key: T) {
  record[key] = (record[key] ?? 0) + 1;
}

function calculateReadingStats(
  literatures: Literature[] = [],
  scope: ScopeQuery & { literatureId?: EntityId } = {}
): LiteratureReadingStats {
  const readingStatusDistribution: Partial<Record<LiteratureReadingStatus, number>> = {};
  let intensiveReadCount = 0;
  let summarizedCount = 0;
  let reusedCount = 0;
  let discardedCount = 0;

  literatures.forEach((literature) => {
    const status = literature.readingStatus;
    addCount(readingStatusDistribution, status);
    if (status === "intensive_read") {
      intensiveReadCount += 1;
    }
    if (status === "summarized") {
      summarizedCount += 1;
    }
    if (status === "reused") {
      reusedCount += 1;
    }
    if (status === "discarded") {
      discardedCount += 1;
    }
  });

  return {
    ...scope,
    activityCount: 0,
    totalDurationMinutes: 0,
    averageDurationMinutes: 0,
    readingStatusDistribution,
    intensiveReadCount,
    summarizedCount,
    reusedCount,
    discardedCount
  };
}

export function buildAiReadingStatsSummary(
  stats: LiteratureReadingStats
): LiteratureAiReadingStatsSummary {
  return {
    totalActivities: stats.activityCount,
    totalDurationMinutes: stats.totalDurationMinutes,
    averageDurationMinutes: stats.averageDurationMinutes,
    lastReadingDate: stats.lastReadingDate,
    statusDistribution: toPlainCountRecord(stats.readingStatusDistribution),
    warnings: [
      "AI-ready readingStats is aggregate-only and no longer uses legacy row-level reading activity models."
    ],
    limitations: [
      "Legacy row-level reading activity schema has been removed.",
      "Only Literature readingStatus distribution is currently available."
    ]
  };
}

function countLiteratureStatuses(literatures: Literature[]) {
  return literatures.reduce<Partial<Record<LiteratureReadingStatus, number>>>((record, item) => {
    addCount(record, item.readingStatus);
    return record;
  }, {});
}

function groupByReadingStatus(literatures: Literature[]) {
  return literatures.reduce<Partial<Record<LiteratureReadingStatus, Literature[]>>>(
    (record, literature) => {
      record[literature.readingStatus] = [
        ...(record[literature.readingStatus] ?? []),
        literature
      ];
      return record;
    },
    {}
  );
}

function literaturesForLinks(
  links: LiteratureLink[],
  literatureById: Map<EntityId, Literature>
) {
  return uniqueById(links.map((link) => literatureById.get(link.literatureId)).filter(isDefined));
}

function groupByRelationType(
  literatures: Literature[],
  links: LiteratureLink[]
): Partial<Record<LiteratureRelationType, Literature[]>> {
  const literatureById = indexById(literatures);
  return links.reduce<Partial<Record<LiteratureRelationType, Literature[]>>>((record, link) => {
    const literature = literatureById.get(link.literatureId);
    if (!literature) {
      return record;
    }

    record[link.relationType] = uniqueById([...(record[link.relationType] ?? []), literature]);
    return record;
  }, {});
}

function groupByRole(
  literatures: Literature[],
  links: LiteratureLink[]
): Partial<Record<LiteratureEvidenceRole, Literature[]>> {
  const literatureById = indexById(literatures);
  return links.reduce<Partial<Record<LiteratureEvidenceRole, Literature[]>>>((record, link) => {
    if (!link.role) {
      return record;
    }

    const literature = literatureById.get(link.literatureId);
    if (!literature) {
      return record;
    }

    record[link.role] = uniqueById([...(record[link.role] ?? []), literature]);
    return record;
  }, {});
}

function selectByRelations(
  literatures: Literature[],
  links: LiteratureLink[],
  relationTypes: LiteratureRelationType[]
) {
  const relationSet = new Set(relationTypes);
  return literaturesForLinks(
    links.filter((link) => relationSet.has(link.relationType)),
    indexById(literatures)
  );
}

function selectByRolesOrRelations(
  literatures: Literature[],
  links: LiteratureLink[],
  roles: LiteratureEvidenceRole[],
  relationTypes: LiteratureRelationType[]
) {
  const roleSet = new Set(roles);
  const relationSet = new Set(relationTypes);
  return literaturesForLinks(
    links.filter(
      (link) =>
        (link.role !== undefined && roleSet.has(link.role)) ||
        relationSet.has(link.relationType)
    ),
    indexById(literatures)
  );
}

async function loadLiteratureModuleData(includeArchived = true): Promise<LiteratureModuleData> {
  const [literatures, links] = await Promise.all([
    literatureService.queryLiteratures({ includeArchived }),
    literatureService.queryLiteratureLinks()
  ]);

  return {
    literatures,
    links
  };
}

function unavailableTarget(
  targetType: LiteratureLinkTargetType,
  targetId: EntityId,
  missingReason = "Target object could not be resolved.",
  missingReference?: MissingEntityReference
): LiteratureLinkedTargetSummary {
  return {
    targetType,
    targetId,
    sourceAvailable: false,
    missingReason,
    missingReference
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

function warningForMissingReference(reference: MissingEntityReference) {
  const source =
    reference.sourceType && reference.sourceId
      ? `${reference.sourceType}:${reference.sourceId} -> `
      : "";
  return [
    `Missing literature link reference: ${source}${reference.targetType}:${reference.targetId}`,
    `reason=${reference.reason}`,
    reference.message
  ]
    .filter(Boolean)
    .join(" | ");
}

function readStateFromLinkSummaries(linkSummaries: LiteratureLinkSummary[]) {
  const missingReferences = uniqueMissingReferences(
    linkSummaries
      .map((summary) => summary.target.missingReference)
      .filter((reference): reference is MissingEntityReference => Boolean(reference))
  );

  return {
    warnings: missingReferences.map(warningForMissingReference),
    missingReferences,
    partial: missingReferences.length > 0
  };
}

async function resolvePlanningFallback(
  targetType: LiteratureLinkTargetType,
  targetId: EntityId
): Promise<LiteratureLinkedTargetSummary | undefined> {
  const data = await getPlanningData();

  if (targetType === "project") {
    const project = data.projects.find((item) => item.id === targetId);
    return project
      ? {
          targetType,
          targetId,
          title: project.title,
          subtitle: project.description,
          status: project.status,
          sourceAvailable: true
        }
      : undefined;
  }

  if (targetType === "route") {
    const route = data.routeNodes.find((item) => item.id === targetId);
    return route
      ? {
          targetType,
          targetId,
          title: route.title,
          subtitle: route.description,
          status: route.status,
          projectId: route.projectId,
          sourceAvailable: true
        }
      : undefined;
  }

  if (targetType === "task") {
    const task = data.tasks.find((item) => item.id === targetId);
    return task
      ? {
          targetType,
          targetId,
          title: task.title,
          subtitle: task.description,
          status: task.status,
          projectId: task.projectId,
          routeId: task.routeNodeId,
          sourceAvailable: true
        }
      : undefined;
  }

  if (targetType === "review") {
    const review = data.reviews.find((item) => item.id === targetId);
    return review
      ? {
          targetType,
          targetId,
          title: review.title,
          subtitle: review.outlineSections.find((section) => section.content.trim())?.content,
          projectId: review.projectId,
          sourceAvailable: true
        }
      : undefined;
  }

  return undefined;
}

async function resolveTargetSummaryFromServices(
  targetType: LiteratureLinkTargetType,
  targetId: EntityId
): Promise<LiteratureLinkedTargetSummary> {
  try {
    if (targetType === "project") {
      const data = await getPlanningData();
      const project = data.projects.find((item) => item.id === targetId && !item.deletedAt);
      if (project) {
        return {
          targetType,
          targetId,
          title: project.title,
          subtitle: project.description,
          status: project.status,
          sourceAvailable: true
        };
      }
    }

    if (targetType === "route" || targetType === "task") {
      const current = await resolvePlanningFallback(targetType, targetId);
      if (current) return current;
    }

    if (targetType === "experiment") {
      const experiment = await experimentService.getExperimentById(targetId);
      if (experiment) {
        return {
          targetType,
          targetId,
          title: experiment.title,
          subtitle: experiment.purposeAndQuestion,
          status: experiment.status,
          projectId: experiment.projectId,
          routeId: experiment.routeId,
          taskId: experiment.taskId,
          sourceAvailable: true
        };
      }
    }

    if (targetType === "experimentRun") {
      const run = await experimentRunService.getRunById(targetId);
      if (run) {
        return {
          targetType,
          targetId,
          title: run.title,
          subtitle: run.resultSummary,
          status: run.status,
          projectId: run.projectId,
          routeId: run.routeId,
          taskId: run.taskId,
          sourceAvailable: true
        };
      }
    }

    if (targetType === "resultMetric") {
      const metric = await resultMetricService.getById(targetId);
      if (metric) {
        return {
          targetType,
          targetId,
          title: metric.name,
          subtitle: `${metric.value}${metric.unit ? ` ${metric.unit}` : ""}`,
          projectId: null,
          sourceAvailable: true
        };
      }
    }

    if (targetType === "fileRef") {
      const fileRef = await fileRefService.getById(targetId);
      if (fileRef) {
        return {
          targetType,
          targetId,
          title: fileRef.title,
          subtitle: fileRef.path,
          projectId: null,
          sourceAvailable: true
        };
      }
    }

    if (targetType === "resultItem") {
      const resultItem = await outputConversionService.getResultItemById(targetId);
      if (resultItem) {
        return {
          targetType,
          targetId,
          title: resultItem.title,
          subtitle: resultItem.summary,
          projectId: resultItem.projectId,
          routeId: resultItem.routeId,
          taskId: resultItem.taskId,
          sourceAvailable: true
        };
      }
    }

    if (targetType === "finding") {
      const finding = await outputConversionService.getFindingById(targetId);
      if (finding) {
        return {
          targetType,
          targetId,
          title: finding.title,
          subtitle: finding.summary,
          status: finding.maturity,
          projectId: finding.projectId,
          routeId: finding.routeId,
          taskId: finding.taskId,
          sourceAvailable: true
        };
      }
    }

    if (targetType === "outputCandidate") {
      const candidate = await outputConversionService.getOutputCandidateById(targetId);
      if (candidate) {
        return {
          targetType,
          targetId,
          title: candidate.title,
          subtitle: candidate.description,
          status: candidate.status,
          projectId: candidate.projectId,
          routeId: candidate.routeId,
          taskId: candidate.taskId,
          sourceAvailable: true
        };
      }
    }

    if (targetType === "outputGap") {
      const gap = await outputConversionService.getOutputGapById(targetId);
      if (gap) {
        return {
          targetType,
          targetId,
          title: gap.title,
          subtitle: gap.description,
          status: gap.status,
          projectId: gap.projectId,
          sourceAvailable: true
        };
      }
    }

    if (targetType === "output") {
      const output = await outputService.getById(targetId);
      if (output) {
        return {
          targetType,
          targetId,
          title: output.outputName,
          subtitle: output.description,
          projectId: output.projectId,
          taskId: output.taskId,
          sourceAvailable: true
        };
      }
    }

    if (targetType === "aiContext" || targetType === "other") {
      return unavailableTarget(targetType, targetId, "Target type has no concrete resolver.");
    }

    const fallback = await resolvePlanningFallback(targetType, targetId);
    return fallback ?? unavailableTarget(targetType, targetId);
  } catch {
    return unavailableTarget(targetType, targetId);
  }
}

async function resolveTargetSummary(link: LiteratureLink): Promise<LiteratureLinkedTargetSummary> {
  const validation = await validateEntityReference(literatureLinkToTargetReference(link));
  if (!validation.valid) {
    return unavailableTarget(
      link.targetType,
      link.targetId,
      validation.resolution.message ?? "Target object could not be resolved.",
      validation.missingReference
    );
  }

  return resolveTargetSummaryFromServices(link.targetType, link.targetId);
}

async function buildLinkSummaries(
  links: LiteratureLink[],
  literatures: Literature[]
): Promise<LiteratureLinkSummary[]> {
  const literatureById = indexById(literatures);
  return Promise.all(
    links.map(async (link) => {
      const target = await resolveTargetSummary(link);
      return {
        linkId: link.id,
        literatureId: link.literatureId,
        literatureTitle: literatureById.get(link.literatureId)?.title,
        targetType: link.targetType,
        targetId: link.targetId,
        relationType: link.relationType,
        role: link.role,
        strength: link.strength,
        confidence: link.confidence,
        description: link.description,
        note: link.note,
        target
      };
    })
  );
}

function collectScopedLiteratureIds(data: LiteratureModuleData, scope: ScopeQuery) {
  const ids = new Set<EntityId>();

  data.literatures.forEach((literature) => {
    if (scope.projectId && literature.primaryProjectId === scope.projectId) {
      ids.add(literature.id);
    }
  });

  data.links.forEach((link) => {
    if (
      (scope.projectId &&
        ((link.targetType === "project" && link.targetId === scope.projectId) ||
          link.projectId === scope.projectId)) ||
      (scope.routeId && link.targetType === "route" && link.targetId === scope.routeId) ||
      (scope.taskId && link.targetType === "task" && link.targetId === scope.taskId)
    ) {
      ids.add(link.literatureId);
    }
  });

  return ids;
}

function selectScopedData(data: LiteratureModuleData, scope: ScopeQuery) {
  const literatureIds = collectScopedLiteratureIds(data, scope);
  const literatures = uniqueById(
    data.literatures.filter((literature) => literatureIds.has(literature.id))
  );
  const scopedIds = new Set(literatures.map((literature) => literature.id));
  const links = data.links.filter((link) => scopedIds.has(link.literatureId));

  return {
    literatures,
    links
  };
}

async function buildScopeCommon(data: LiteratureModuleData, scope: ScopeQuery) {
  const scoped = selectScopedData(data, scope);
  const linkSummaries = await buildLinkSummaries(scoped.links, scoped.literatures);
  const readingStats = calculateReadingStats(scoped.literatures, scope);
  const readState = readStateFromLinkSummaries(linkSummaries);

  return {
    literatures: scoped.literatures,
    links: scoped.links,
    linkSummaries,
    readingStats,
    groupedByRelationType: groupByRelationType(scoped.literatures, scoped.links),
    groupedByReadingStatus: groupByReadingStatus(scoped.literatures),
    ...readState
  };
}

async function collectExperimentTargetIds(experimentId: EntityId) {
  const runs = await experimentRunService.getRunsByExperiment(experimentId);
  const runIds = new Set(runs.map((run) => run.id));
  const [metricGroups, experimentFileRefs, runFileRefGroups, resultItems, findings] =
    await Promise.all([
      Promise.all(runs.map((run) => resultMetricService.getMetricsByRun(run.id))),
      fileRefService.getFileRefsByOwner("experiment", experimentId),
      Promise.all(runs.map((run) => fileRefService.getFileRefsByOwner("experimentRun", run.id))),
      outputConversionService.listResultItems(),
      outputConversionService.listFindings()
    ]);

  return {
    runIds,
    metricIds: new Set(metricGroups.flat().map((metric) => metric.id)),
    fileRefIds: new Set([...experimentFileRefs, ...runFileRefGroups.flat()].map((file) => file.id)),
    resultItemIds: new Set(
      resultItems
        .filter(
          (item) =>
            item.experimentId === experimentId ||
            (item.experimentRunId !== undefined &&
              item.experimentRunId !== null &&
              runIds.has(item.experimentRunId))
        )
        .map((item) => item.id)
    ),
    findingIds: new Set(
      findings.filter((finding) => finding.experimentId === experimentId).map((finding) => finding.id)
    )
  };
}

function linkMatchesExperiment(
  link: LiteratureLink,
  experimentId: EntityId,
  targetIds: Awaited<ReturnType<typeof collectExperimentTargetIds>>
) {
  return (
    (link.targetType === "experiment" && link.targetId === experimentId) ||
    (link.targetType === "experimentRun" && targetIds.runIds.has(link.targetId)) ||
    (link.targetType === "resultMetric" && targetIds.metricIds.has(link.targetId)) ||
    (link.targetType === "fileRef" && targetIds.fileRefIds.has(link.targetId)) ||
    (link.targetType === "resultItem" && targetIds.resultItemIds.has(link.targetId)) ||
    (link.targetType === "finding" && targetIds.findingIds.has(link.targetId))
  );
}

async function collectOutputCandidateTargetIds(outputCandidateId: EntityId) {
  const detail = await getOutputCandidateDetailDTO(outputCandidateId);
  const findingIds = new Set(detail?.linkedFindingSummaries.map((item) => item.id) ?? []);
  const resultItemIds = new Set([
    ...(detail?.linkedResultItemSummaries.map((item) => item.id) ?? []),
    ...(detail?.linkedAssetSummaries.map((item) => item.id) ?? [])
  ]);

  return {
    findingIds,
    resultItemIds
  };
}

function linkMatchesOutputCandidate(
  link: LiteratureLink,
  outputCandidateId: EntityId,
  targetIds: Awaited<ReturnType<typeof collectOutputCandidateTargetIds>>
) {
  return (
    (link.targetType === "outputCandidate" && link.targetId === outputCandidateId) ||
    (link.targetType === "finding" && targetIds.findingIds.has(link.targetId)) ||
    (link.targetType === "resultItem" && targetIds.resultItemIds.has(link.targetId))
  );
}

function buildOutputCandidateSupportGaps(
  outputCandidateId: EntityId,
  context: Pick<
    OutputCandidateLiteratureContext,
    | "relatedWorkSupport"
    | "methodSupport"
    | "experimentSupport"
    | "discussionSupport"
    | "literatures"
  >
): LiteratureSupportGap[] {
  const gaps: LiteratureSupportGap[] = [];
  const pushGap = (
    gapType: LiteratureSupportGap["gapType"],
    severity: LiteratureSupportGap["severity"],
    message: string,
    suggestedAction?: string
  ) => {
    gaps.push({
      id: `literature-gap-${outputCandidateId}-${gapType}`,
      targetType: "outputCandidate",
      targetId: outputCandidateId,
      gapType,
      severity,
      message,
      suggestedAction
    });
  };

  if (context.relatedWorkSupport.length === 0) {
    pushGap(
      "missing_related_work",
      "high",
      "Output candidate has no related-work literature support.",
      "Link confirmed related-work literature before drafting background sections."
    );
  }

  if (context.methodSupport.length === 0) {
    pushGap(
      "missing_method_reference",
      "medium",
      "Output candidate has no method-reference literature support.",
      "Link method or theory-support literature used by the proposed approach."
    );
  }

  if (context.experimentSupport.length === 0) {
    pushGap(
      "missing_experiment_evidence",
      "medium",
      "Output candidate has no experiment or comparison literature support.",
      "Link baseline, comparison, metric, or result-interpretation literature."
    );
  }

  if (context.discussionSupport.length === 0 && context.literatures.length === 0) {
    pushGap(
      "low_reading_context",
      "low",
      "Output candidate has little literature reading context available.",
      "Link discussion or interpretation literature before AI reuse."
    );
  }

  return gaps;
}

function buildContextSummary(
  literatures: Literature[],
  links: LiteratureLink[],
  readingStats: LiteratureReadingStats
) {
  const relationDistribution = links.reduce<Partial<Record<LiteratureRelationType, number>>>(
    (record, link) => {
      addCount(record, link.relationType);
      return record;
    },
    {}
  );
  const titles = literatures
    .slice(0, 5)
    .map((literature) => sanitizeAiContextText(literature.title, 180))
    .join("; ");

  return [
    `literatures=${literatures.length}`,
    `readingMinutes=${readingStats.totalDurationMinutes}`,
    `relations=${JSON.stringify(relationDistribution)}`,
    titles ? `sampleTitles=${titles}` : "sampleTitles=none"
  ].join(" | ");
}

function applyAiLimit<T>(items: T[], limit?: number) {
  return limit && limit > 0 ? items.slice(0, limit) : items;
}

async function loadLiteratureDetailContext(
  literatureId: EntityId
): Promise<LiteratureDetailContext | null> {
  const bundle = await literatureService.getLiteratureBundle(literatureId);
  if (!bundle) {
    return null;
  }

  const linkSummaries = await buildLinkSummaries(bundle.links, [bundle.literature]);
  const fileRefs = await getLiteratureFileRefSummaries(literatureId);
  const outlineCurrentFilename =
    await literatureCurrentFilenameService.getCurrentFilename(
      literatureId,
      "literature_outline"
    );
  const dedicatedNotesCurrentFilename =
    await literatureCurrentFilenameService.getCurrentFilename(
      literatureId,
      "dedicated_notes"
    );
  const provisioningReadiness =
    await manuscriptProvisioningReadinessInspector.inspectLiterature({
      ownerId: literatureId,
      requestedAt: new Date().toISOString()
    });
  const manuscriptStatus = toLiteratureManuscriptStatusSummary(outlineCurrentFilename);
  const readingStats = calculateReadingStats([bundle.literature], { literatureId });
  const readState = readStateFromLinkSummaries(linkSummaries);
  const structuredSummaries = buildLiteratureStructuredSummaries({
    literature: bundle.literature,
    linkSummaries
  });
  const markdownContextSummary = buildLiteratureMarkdownContextSummary({
    literature: bundle.literature,
    linkSummaries,
    fileRefs,
    manuscriptStatus
  });
  const readContext = buildLiteratureReadContext({
    literature: bundle.literature,
    linkSummaries,
    fileRefs,
    manuscriptStatus,
    warnings: readState.warnings,
    missingReferenceWarnings: readState.missingReferences.map(
      (reference) =>
        `Missing ${reference.targetType || "linked entity"} reference: ${reference.targetId}.`
    )
  });

  return {
    literature: bundle.literature,
    fileRefs,
    manuscriptStatus,
    currentFilenames: {
      literature_outline: outlineCurrentFilename,
      dedicated_notes: dedicatedNotesCurrentFilename
    },
    provisioningReadiness,
    ...structuredSummaries,
    markdownContextSummary,
    readContext,
    links: bundle.links,
    linkSummaries,
    readingStats,
    ...readState
  };
}

export function getLiteratureDetailContext(
  literatureId: EntityId
): Promise<LiteratureDetailContext | null> {
  return literatureDetailAuthorityAggregationCoordinator.run(
    literatureId,
    () => loadLiteratureDetailContext(literatureId)
  );
}

export async function getProjectLiteratureContext(
  projectId: EntityId
): Promise<ProjectLiteratureContext> {
  const data = await loadLiteratureModuleData(true);
  const common = await buildScopeCommon(data, { projectId });

  return {
    projectId,
    ...common,
    primaryProjectLiteratures: common.literatures.filter(
      (literature) => literature.primaryProjectId === projectId
    )
  };
}

export async function getRouteLiteratureContext(
  routeId: EntityId
): Promise<RouteLiteratureContext> {
  const data = await loadLiteratureModuleData(true);
  const common = await buildScopeCommon(data, { routeId });

  return {
    routeId,
    ...common
  };
}

export async function getTaskLiteratureContext(taskId: EntityId): Promise<TaskLiteratureContext> {
  const data = await loadLiteratureModuleData(true);
  const common = await buildScopeCommon(data, { taskId });

  return {
    taskId,
    ...common
  };
}

export async function getExperimentLiteratureContext(
  experimentId: EntityId
): Promise<ExperimentLiteratureContext> {
  const [data, targetIds] = await Promise.all([
    loadLiteratureModuleData(true),
    collectExperimentTargetIds(experimentId)
  ]);
  const links = data.links.filter((link) => linkMatchesExperiment(link, experimentId, targetIds));
  const literatureIds = new Set(links.map((link) => link.literatureId));
  const literatures = uniqueById(
    data.literatures.filter((literature) => literatureIds.has(literature.id))
  );
  const linkSummaries = await buildLinkSummaries(links, literatures);
  const readingStats = calculateReadingStats(literatures);
  const readState = readStateFromLinkSummaries(linkSummaries);

  return {
    experimentId,
    literatures,
    links,
    linkSummaries,
    readingStats,
    groupedByRelationType: groupByRelationType(literatures, links),
    baseline: selectByRelations(literatures, links, ["baseline"]),
    methodReferences: selectByRelations(literatures, links, [
      "method_reference",
      "theory_support"
    ]),
    parameterReferences: selectByRelations(literatures, links, ["parameter_reference"]),
    dataProcessingReferences: selectByRelations(literatures, links, [
      "data_processing_reference"
    ]),
    evaluationMetricReferences: selectByRelations(literatures, links, [
      "evaluation_metric_reference"
    ]),
    experimentComparisons: selectByRelations(literatures, links, ["experiment_comparison"]),
    resultInterpretations: selectByRelations(literatures, links, ["result_interpretation"]),
    ...readState
  };
}

export async function getOutputCandidateLiteratureContext(
  outputCandidateId: EntityId
): Promise<OutputCandidateLiteratureContext> {
  const [data, targetIds] = await Promise.all([
    loadLiteratureModuleData(true),
    collectOutputCandidateTargetIds(outputCandidateId)
  ]);
  const links = data.links.filter((link) =>
    linkMatchesOutputCandidate(link, outputCandidateId, targetIds)
  );
  const literatureIds = new Set(links.map((link) => link.literatureId));
  const literatures = uniqueById(
    data.literatures.filter((literature) => literatureIds.has(literature.id))
  );
  const linkSummaries = await buildLinkSummaries(links, literatures);
  const readingStats = calculateReadingStats(literatures);
  const readState = readStateFromLinkSummaries(linkSummaries);
  const baseContext = {
    outputCandidateId,
    literatures,
    links,
    linkSummaries,
    readingStats,
    groupedByRole: groupByRole(literatures, links),
    introductionSupport: selectByRolesOrRelations(
      literatures,
      links,
      ["introduction"],
      ["background_support", "problem_source"]
    ),
    relatedWorkSupport: selectByRolesOrRelations(
      literatures,
      links,
      ["related_work"],
      ["related_work", "core_related_work"]
    ),
    methodSupport: selectByRolesOrRelations(
      literatures,
      links,
      ["method"],
      ["method_reference", "theory_support"]
    ),
    experimentSupport: selectByRolesOrRelations(
      literatures,
      links,
      ["experiment"],
      [
        "baseline",
        "experiment_comparison",
        "evaluation_metric_reference",
        "result_interpretation"
      ]
    ),
    discussionSupport: selectByRolesOrRelations(
      literatures,
      links,
      ["discussion"],
      ["result_interpretation", "contradicts", "extends", "inspired_by"]
    ),
    patentBackgroundSupport: selectByRolesOrRelations(
      literatures,
      links,
      ["patent_background"],
      ["patent_background"]
    ),
    reportSupport: selectByRolesOrRelations(
      literatures,
      links,
      ["report_support"],
      ["writing_support"]
    ),
    ...readState
  };

  return {
    ...baseContext,
    supportGaps: buildOutputCandidateSupportGaps(outputCandidateId, baseContext)
  };
}

export async function getLiteratureWorkloadOverview(
  query: LiteratureWorkloadQuery = {}
): Promise<LiteratureWorkloadOverview> {
  const data = await loadLiteratureModuleData(query.includeArchived ?? false);
  const scopedLiteratureIds = collectScopedLiteratureIds(data, {
    projectId: query.projectId,
    routeId: query.routeId,
    taskId: query.taskId
  });
  const scopedLiteratures = data.literatures.filter((literature) => {
    if (!query.projectId && !query.routeId && !query.taskId) {
      return true;
    }
    return scopedLiteratureIds.has(literature.id);
  });
  const statsByLiterature = scopedLiteratures.map((literature) =>
    calculateReadingStats([literature], { literatureId: literature.id })
  );
  const totalStats = calculateReadingStats(scopedLiteratures, {
    projectId: query.projectId,
    routeId: query.routeId,
    taskId: query.taskId
  });

  return {
    query,
    literatureCount: scopedLiteratures.length,
    readLiteratureCount: scopedLiteratures.filter((literature) => literature.readingStatus !== "unread")
      .length,
    totalReadingActivityCount: totalStats.activityCount,
    totalDurationMinutes: totalStats.totalDurationMinutes,
    readingStatusDistribution: countLiteratureStatuses(scopedLiteratures),
    intensiveReadCount: scopedLiteratures.filter(
      (literature) => literature.readingStatus === "intensive_read"
    ).length,
    summarizedCount: scopedLiteratures.filter((literature) => literature.readingStatus === "summarized")
      .length,
    reusedCount: scopedLiteratures.filter((literature) => literature.readingStatus === "reused")
      .length,
    discardedCount: scopedLiteratures.filter(
      (literature) => literature.readingStatus === "discarded"
    ).length,
    readingStatsByLiterature: [...statsByLiterature].sort((left, right) => {
      const dateDiff = (right.lastReadingDate ?? "").localeCompare(left.lastReadingDate ?? "");
      return dateDiff || right.activityCount - left.activityCount;
    })
  };
}

async function getAiSourceData(options: AiLiteratureContextOptions) {
  if (options.literatureId) {
    const context = await getLiteratureDetailContext(options.literatureId);
    return context
      ? {
          literatures: [context.literature],
          links: context.links,
          linkSummaries: context.linkSummaries,
          warnings: context.warnings,
          missingReferences: context.missingReferences,
          partial: context.partial
        }
      : undefined;
  }

  if (options.outputCandidateId) {
    const context = await getOutputCandidateLiteratureContext(options.outputCandidateId);
    return {
      literatures: context.literatures,
      links: context.links,
      linkSummaries: context.linkSummaries,
      warnings: context.warnings,
      missingReferences: context.missingReferences,
      partial: context.partial
    };
  }

  if (options.experimentId) {
    const context = await getExperimentLiteratureContext(options.experimentId);
    return {
      literatures: context.literatures,
      links: context.links,
      linkSummaries: context.linkSummaries,
      warnings: context.warnings,
      missingReferences: context.missingReferences,
      partial: context.partial
    };
  }

  if (options.taskId) {
    const context = await getTaskLiteratureContext(options.taskId);
    return {
      literatures: context.literatures,
      links: context.links,
      linkSummaries: context.linkSummaries,
      warnings: context.warnings,
      missingReferences: context.missingReferences,
      partial: context.partial
    };
  }

  if (options.routeId) {
    const context = await getRouteLiteratureContext(options.routeId);
    return {
      literatures: context.literatures,
      links: context.links,
      linkSummaries: context.linkSummaries,
      warnings: context.warnings,
      missingReferences: context.missingReferences,
      partial: context.partial
    };
  }

  if (options.projectId) {
    const context = await getProjectLiteratureContext(options.projectId);
    return {
      literatures: context.literatures,
      links: context.links,
      linkSummaries: context.linkSummaries,
      warnings: context.warnings,
      missingReferences: context.missingReferences,
      partial: context.partial
    };
  }

  const data = await loadLiteratureModuleData(options.includeArchived ?? false);
  const linkSummaries = await buildLinkSummaries(data.links, data.literatures);
  const readState = readStateFromLinkSummaries(linkSummaries);
  return {
    literatures: data.literatures,
    links: data.links,
    linkSummaries,
    ...readState
  };
}

export async function getAiLiteratureContext(
  options: AiLiteratureContextOptions = {}
): Promise<AiLiteratureContext> {
  const source = await getAiSourceData(options);
  if (!source) {
    return {
      options,
      literatures: [],
      links: [],
      linkSummaries: [],
      readingStats: buildAiReadingStatsSummary(calculateReadingStats([])),
      contextSummary: "literatures=0 | readingMinutes=0 | relations={}",
      provenance: [],
      warnings: ["Literature AI context source was not found."],
      missingReferences: [],
      partial: true,
      limitations: [
        "No source context was available.",
        "PDF, local file bodies, full paths, and full Markdown are not included."
      ]
    };
  }

  const effectiveLimit =
    options.limit && options.limit > 0 ? Math.min(Math.floor(options.limit), 20) : 10;
  const rawLiteratures = applyAiLimit(
    source.literatures,
    effectiveLimit
  );
  const scopedIds = new Set(rawLiteratures.map((literature) => literature.id));
  const rawLinks = source.links.filter((link) => scopedIds.has(link.literatureId));
  const rawLinkSummaries = source.linkSummaries.filter((summary) =>
    scopedIds.has(summary.literatureId)
  );
  const rawReadingStats = calculateReadingStats(rawLiteratures);
  const readingStats = buildAiReadingStatsSummary(rawReadingStats);
  const literatures = await Promise.all(
    rawLiteratures.map(async (literature) => {
      const literatureLinkSummaries = rawLinkSummaries.filter(
        (summary) => summary.literatureId === literature.id
      );
      const literatureMissingReferences = source.missingReferences.filter(
        (reference) => reference.sourceId === literature.id
      );
      const manuscriptStatus = await getLiteratureManuscriptStatus(literature.id);
      return buildLiteratureReadContext({
        literature,
        linkSummaries: literatureLinkSummaries,
        fileRefs: await getLiteratureFileRefSummaries(literature.id),
        manuscriptStatus,
        missingReferenceWarnings: literatureMissingReferences.map(
          (reference) =>
            `Missing ${reference.targetType || "linked entity"} reference: ${reference.targetId}.`
        )
      });
    })
  );
  const links = literatures
    .flatMap((literature) => literature.knowledgeDeposit.linkedObjects.all)
    .slice(0, 20);
  const warnings = [
    ...source.warnings,
    ...literatures.flatMap((literature) => literature.warnings)
  ];
  const limitations = [
    ...literatures.flatMap((literature) => literature.limitations),
    "AI-ready literature context contains whitelisted summaries only.",
    `Literature collection is limited to ${effectiveLimit} items.`
  ];

  return {
    options,
    literatures,
    links,
    linkSummaries: links,
    readingStats,
    contextSummary: buildContextSummary(
      rawLiteratures,
      rawLinks,
      rawReadingStats
    ),
    provenance: literatures.flatMap((literature) => literature.provenance),
    warnings: [...new Set(warnings.map((warning) => sanitizeAiContextText(warning)))],
    missingReferences: source.missingReferences,
    partial:
      source.partial ||
      literatures.some((literature) => literature.partial) ||
      warnings.length > 0,
    limitations: [...new Set(limitations)]
  };
}

export const literatureSelectorService = {
  getLiteratureFileRefSummaries,
  getLiteratureDetailContext,
  getProjectLiteratureContext,
  getRouteLiteratureContext,
  getTaskLiteratureContext,
  getExperimentLiteratureContext,
  getOutputCandidateLiteratureContext,
  getLiteratureWorkloadOverview,
  buildAiReadingStatsSummary,
  getAiLiteratureContext
};

export type LiteratureSelectorService = typeof literatureSelectorService;
