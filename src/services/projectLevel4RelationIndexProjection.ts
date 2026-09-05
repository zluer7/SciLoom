import type { ExperimentDetailContext } from "../types/experimentContext";
import type { Literature } from "../types/literature";
import type { ResearchOutput } from "../types/output";
import type { Finding, OutputCandidate, OutputGap, ResultItem } from "../types/outputConversion";
import type { Review, RouteNode, Task } from "../types/planning";
import type {
  ProjectLevel4ObjectType,
  ProjectLevel4RelationIndexEntry,
  ProjectLevel4RelationIndexExclusion,
  ProjectLevel4RelationKey
} from "../types/planningContext";

const OBJECT_ORDER: readonly ProjectLevel4ObjectType[] = Object.freeze([
  "route",
  "task",
  "review",
  "experiment",
  "experimentRun",
  "literature",
  "resultItem",
  "finding",
  "outputCandidate",
  "outputGap",
  "researchOutput"
]);

const OBJECT_RANK = new Map(OBJECT_ORDER.map((objectType, index) => [objectType, index]));
const MAX_SAFE_LABEL_CHARS = 160;
const MAX_SAFE_SUMMARY_CHARS = 120;
const MAX_RELATION_KEYS_PER_ITEM = 8;

export interface ProjectLevel4RelationIndexProjectionInput {
  projectId: string;
  routeNodes: RouteNode[];
  tasks: Task[];
  reviews: ProjectLevel4ReviewIdentity[];
  experimentContexts: ExperimentDetailContext[];
  literatures: Literature[];
  resultItems: ResultItem[];
  findings: Finding[];
  outputCandidates: OutputCandidate[];
  outputGaps: OutputGap[];
  outputs: ResearchOutput[];
}

export type ProjectLevel4ReviewIdentity = Pick<
  Review,
  "id" | "projectId" | "title" | "deletedAt"
> &
  Partial<Pick<Review, "reviewType" | "structuredLifecycleStatus">>;

export interface ProjectLevel4RelationIndexProjection {
  entries: ProjectLevel4RelationIndexEntry[];
  exclusions: ProjectLevel4RelationIndexExclusion[];
}

function redactSensitiveText(value: string): string {
  const patterns = [
    /[A-Za-z]:[\\/](?:[^\\/\s|]+[\\/]?)+/g,
    /\\\\[^\s|]+/g,
    /file:\/\/[^\s|]+/gi,
    /\/(?:Users|home|mnt|tmp|var)\/[^\s|]+/g,
    /\bsk-[A-Za-z0-9_-]{16,}\b/g,
    /\bBearer\s+[A-Za-z0-9._-]+\b/gi,
    /\b(?:api[_-]?key|token|secret)\s*[:=]\s*[^\s|]+/gi
  ];
  let next = value.replace(/\0/g, "").replace(/\s+/g, " ").trim();
  for (const pattern of patterns) next = next.replace(pattern, "[sensitive value omitted]");
  return next;
}

function boundedSafeText(value: string | null | undefined, maxChars: number): string | undefined {
  if (!value) return undefined;
  const safe = redactSensitiveText(value);
  if (!safe) return undefined;
  const chars = Array.from(safe);
  return chars.length <= maxChars ? safe : `${chars.slice(0, Math.max(0, maxChars - 1)).join("")}…`;
}

function relation(
  relationType: string,
  targetType: ProjectLevel4ObjectType,
  targetId: string | null | undefined
): ProjectLevel4RelationKey | null {
  const normalizedId = targetId?.trim();
  return normalizedId ? { relationType, targetType, targetId: normalizedId } : null;
}

function normalizeRelations(
  values: Array<ProjectLevel4RelationKey | null>
): ProjectLevel4RelationKey[] {
  const unique = new Map<string, ProjectLevel4RelationKey>();
  for (const value of values) {
    if (!value) continue;
    unique.set(`${value.relationType}:${value.targetType}:${value.targetId}`, value);
  }
  return [...unique.values()]
    .sort((left, right) =>
      left.relationType.localeCompare(right.relationType) ||
      (OBJECT_RANK.get(left.targetType) ?? Number.MAX_SAFE_INTEGER) -
        (OBJECT_RANK.get(right.targetType) ?? Number.MAX_SAFE_INTEGER) ||
      left.targetId.localeCompare(right.targetId)
    )
    .slice(0, MAX_RELATION_KEYS_PER_ITEM);
}

function typedIdentity(entry: Pick<ProjectLevel4RelationIndexEntry, "objectType" | "canonicalId">) {
  return `${entry.objectType}:${entry.canonicalId}`;
}

function isCurrentRecord(record: { id?: string; deletedAt?: string | null }): boolean {
  return Boolean(record.id?.trim()) && !record.deletedAt;
}

function categoricalSummary(...values: Array<string | number | null | undefined>): string | undefined {
  return boundedSafeText(values.filter((value) => value !== null && value !== undefined && value !== "").join(" · "), MAX_SAFE_SUMMARY_CHARS);
}

export function buildProjectLevel4RelationIndexProjection(
  input: ProjectLevel4RelationIndexProjectionInput
): ProjectLevel4RelationIndexProjection {
  const entries: ProjectLevel4RelationIndexEntry[] = [];
  const exclusionCounts = new Map<string, ProjectLevel4RelationIndexExclusion>();

  const exclude = (
    objectType: ProjectLevel4ObjectType,
    reason: ProjectLevel4RelationIndexExclusion["reason"]
  ) => {
    const key = `${objectType}:${reason}`;
    const current = exclusionCounts.get(key);
    exclusionCounts.set(key, { objectType, reason, count: (current?.count ?? 0) + 1 });
  };

  const add = (entry: ProjectLevel4RelationIndexEntry) => {
    if (entry.projectId !== input.projectId) {
      exclude(entry.objectType, "membership_mismatch");
      return;
    }
    const safeLabel = boundedSafeText(entry.safeLabel, MAX_SAFE_LABEL_CHARS);
    if (!entry.canonicalId.trim() || !safeLabel) {
      exclude(entry.objectType, "canonical_source_unavailable");
      return;
    }
    entries.push({
      ...entry,
      canonicalId: entry.canonicalId.trim(),
      safeLabel,
      safeSummary: boundedSafeText(entry.safeSummary, MAX_SAFE_SUMMARY_CHARS),
      relationKeys: normalizeRelations(entry.relationKeys)
    });
  };

  for (const item of input.routeNodes) {
    if (!isCurrentRecord(item)) continue;
    add({
      objectType: "route",
      canonicalId: item.id,
      projectId: item.projectId,
      safeLabel: item.title,
      safeSummary: categoricalSummary(item.nodeType),
      status: item.status,
      relationKeys: normalizeRelations([relation("parent", "route", item.parentNodeId)]),
      membershipSource: "direct_project_id",
      relationSource: item.parentNodeId ? "canonical_direct_fields" : "none"
    });
  }
  for (const item of input.tasks) {
    if (!isCurrentRecord(item)) continue;
    add({
      objectType: "task",
      canonicalId: item.id,
      projectId: item.projectId,
      safeLabel: item.title,
      safeSummary: categoricalSummary(item.taskType),
      status: item.status,
      relationKeys: normalizeRelations([relation("route", "route", item.routeNodeId)]),
      membershipSource: "direct_project_id",
      relationSource: item.routeNodeId ? "canonical_direct_fields" : "none"
    });
  }
  for (const item of input.reviews) {
    if (!isCurrentRecord(item)) continue;
    add({
      objectType: "review",
      canonicalId: item.id,
      projectId: item.projectId,
      safeLabel: item.title,
      safeSummary: categoricalSummary(item.reviewType),
      status: item.structuredLifecycleStatus,
      relationKeys: [],
      membershipSource: "direct_project_id",
      relationSource: "none"
    });
  }
  for (const context of input.experimentContexts) {
    const experiment = context.experiment;
    if (!isCurrentRecord(experiment)) continue;
    if (experiment.status === "archived") {
      exclude("experiment", "ineligible_lifecycle");
      for (const run of context.runs) {
        if (isCurrentRecord(run)) exclude("experimentRun", "ineligible_lifecycle");
      }
      continue;
    }
    add({
      objectType: "experiment",
      canonicalId: experiment.id,
      projectId: experiment.projectId,
      safeLabel: experiment.title,
      safeSummary: categoricalSummary(experiment.rating),
      status: experiment.status,
      relationKeys: normalizeRelations([
        relation("route", "route", experiment.routeId),
        relation("task", "task", experiment.taskId)
      ]),
      membershipSource: "direct_project_id",
      relationSource: experiment.routeId || experiment.taskId ? "canonical_direct_fields" : "none"
    });
    for (const run of context.runs) {
      if (!isCurrentRecord(run)) continue;
      if (
        experiment.projectId !== input.projectId ||
        run.projectId !== input.projectId ||
        run.experimentId !== experiment.id
      ) {
        exclude("experimentRun", "membership_mismatch");
        continue;
      }
      add({
        objectType: "experimentRun",
        canonicalId: run.id,
        projectId: run.projectId,
        safeLabel: run.title,
        safeSummary: categoricalSummary(run.runLabel),
        status: run.status,
        relationKeys: normalizeRelations([
          relation("parent", "experiment", run.experimentId),
          relation("route", "route", run.routeId),
          relation("task", "task", run.taskId)
        ]),
        membershipSource: "experiment_parent_and_run_project_id",
        relationSource: "canonical_direct_fields"
      });
    }
  }
  for (const item of input.literatures) {
    if (!isCurrentRecord(item)) continue;
    if (item.isArchived) {
      exclude("literature", "ineligible_lifecycle");
      continue;
    }
    if (item.primaryProjectId !== input.projectId) {
      exclude("literature", "no_confirmed_project_membership");
      continue;
    }
    add({
      objectType: "literature",
      canonicalId: item.id,
      projectId: item.primaryProjectId,
      safeLabel: item.title,
      safeSummary: categoricalSummary(item.publicationType, item.year, item.venue),
      status: item.readingStatus,
      relationKeys: [],
      membershipSource: "primary_project_id",
      relationSource: "none"
    });
  }
  for (const item of input.resultItems) {
    if (!isCurrentRecord(item)) continue;
    const sourceRelation = item.sourceType === "experiment"
      ? relation("source", "experiment", item.sourceId)
      : item.sourceType === "experimentRun"
        ? relation("source", "experimentRun", item.sourceId)
        : item.sourceType === "task"
          ? relation("source", "task", item.sourceId)
          : item.sourceType === "review"
            ? relation("source", "review", item.sourceId)
            : item.sourceType === "literature"
              ? relation("source", "literature", item.sourceId)
              : null;
    const relations = normalizeRelations([
      relation("route", "route", item.routeId),
      relation("task", "task", item.taskId),
      relation("experiment", "experiment", item.experimentId),
      relation("experiment_run", "experimentRun", item.experimentRunId),
      sourceRelation
    ]);
    add({
      objectType: "resultItem",
      canonicalId: item.id,
      projectId: item.projectId,
      safeLabel: item.title,
      safeSummary: categoricalSummary(item.resultType),
      status: item.status,
      relationKeys: relations,
      membershipSource: "direct_project_id",
      relationSource: relations.length ? "canonical_direct_fields" : "none"
    });
  }
  for (const item of input.findings) {
    if (!isCurrentRecord(item)) continue;
    const relations = normalizeRelations([
      relation("route", "route", item.routeId),
      relation("task", "task", item.taskId),
      relation("experiment", "experiment", item.experimentId)
    ]);
    add({
      objectType: "finding",
      canonicalId: item.id,
      projectId: item.projectId,
      safeLabel: item.title,
      safeSummary: categoricalSummary(item.findingType),
      status: item.status,
      relationKeys: relations,
      membershipSource: "direct_project_id",
      relationSource: relations.length ? "canonical_direct_fields" : "none"
    });
  }
  for (const item of input.outputCandidates) {
    if (!isCurrentRecord(item)) continue;
    const relations = normalizeRelations([
      relation("route", "route", item.routeId),
      relation("task", "task", item.taskId)
    ]);
    add({
      objectType: "outputCandidate",
      canonicalId: item.id,
      projectId: item.projectId,
      safeLabel: item.title,
      safeSummary: categoricalSummary(item.candidateType),
      status: item.status,
      relationKeys: relations,
      membershipSource: "direct_project_id",
      relationSource: relations.length ? "canonical_direct_fields" : "none"
    });
  }
  for (const item of input.outputGaps) {
    if (!isCurrentRecord(item)) continue;
    const relations = normalizeRelations([
      relation("route", "route", item.relatedRouteNodeId),
      relation("task", "task", item.relatedTaskId)
    ]);
    add({
      objectType: "outputGap",
      canonicalId: item.id,
      projectId: item.projectId,
      safeLabel: item.title,
      safeSummary: categoricalSummary(item.gapType),
      status: item.status,
      relationKeys: relations,
      membershipSource: "direct_project_id",
      relationSource: relations.length ? "canonical_direct_fields" : "none"
    });
  }
  for (const item of input.outputs) {
    if (!isCurrentRecord(item)) continue;
    const provenance = item.provenance;
    const relations = normalizeRelations([
      relation("task", "task", item.taskId),
      relation("experiment", "experiment", item.experimentId),
      relation("source_candidate", "outputCandidate", provenance?.sourceCandidateId),
      ...(provenance?.linkedFindingIds ?? []).map((id) => relation("supporting_finding", "finding", id)),
      ...(provenance?.linkedResultItemIds ?? []).map((id) => relation("supporting_result", "resultItem", id)),
      ...(provenance?.outputGapIds ?? []).map((id) => relation("addresses_gap", "outputGap", id))
    ]);
    add({
      objectType: "researchOutput",
      canonicalId: item.id,
      projectId: item.projectId,
      safeLabel: item.outputName,
      safeSummary: categoricalSummary(item.outputType),
      status: item.status,
      relationKeys: relations,
      membershipSource: "direct_project_id",
      relationSource: relations.length ? "canonical_direct_fields" : "none"
    });
  }

  const deduplicated = new Map<string, ProjectLevel4RelationIndexEntry>();
  for (const entry of entries.sort((left, right) =>
    (OBJECT_RANK.get(left.objectType) ?? Number.MAX_SAFE_INTEGER) -
      (OBJECT_RANK.get(right.objectType) ?? Number.MAX_SAFE_INTEGER) ||
    left.canonicalId.localeCompare(right.canonicalId)
  )) {
    if (!deduplicated.has(typedIdentity(entry))) deduplicated.set(typedIdentity(entry), entry);
  }

  return {
    entries: [...deduplicated.values()],
    exclusions: [...exclusionCounts.values()].sort((left, right) =>
      (OBJECT_RANK.get(left.objectType) ?? Number.MAX_SAFE_INTEGER) -
        (OBJECT_RANK.get(right.objectType) ?? Number.MAX_SAFE_INTEGER) ||
      left.reason.localeCompare(right.reason)
    )
  };
}

export const PROJECT_LEVEL4_RELATION_INDEX_POLICY = Object.freeze({
  objectOrder: OBJECT_ORDER,
  maxSafeLabelChars: MAX_SAFE_LABEL_CHARS,
  maxSafeSummaryChars: MAX_SAFE_SUMMARY_CHARS,
  maxRelationKeysPerItem: MAX_RELATION_KEYS_PER_ITEM
});
