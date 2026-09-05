import type {
  AIContextExcludedItem,
  AIContextItem,
  AIContextLevel,
  AIContextMode,
  AIContextRequestableRef,
  AIContextSourceRef,
  AIExperimentRunParentRelation,
  AIResearchObjectDescriptor
} from "../types/aiContext";
import type { ExperimentRunContext } from "../types/experimentContext";
import { assertExperimentRunRelationOwnership } from "./experimentRunBusinessRules";
import {
  getControlledExperimentRunAccess,
  listControlledActiveExperimentRuns
} from "./experimentRunGuard";
import { experimentService } from "./experimentService";
import { getExperimentRunContext } from "./experimentSelectorService";
import { normalizeExperimentContextDisplayValue } from "./experimentStructuredSummaryProjection";

export type ExperimentRunResearchObjectResolutionErrorCode =
  | "EXPERIMENT_RUN_NOT_FOUND"
  | "EXPERIMENT_RUN_UNAVAILABLE"
  | "EXPERIMENT_RUN_PARENT_NOT_FOUND"
  | "EXPERIMENT_RUN_PARENT_UNAVAILABLE"
  | "EXPERIMENT_RUN_PARENT_MISMATCH"
  | "EXPERIMENT_RUN_PROJECT_MISMATCH"
  | "EXPERIMENT_RUN_PROJECT_UNAVAILABLE"
  | "EXPERIMENT_RUN_RELATION_INVALID"
  | "EXPERIMENT_RUN_CONTEXT_STALE";

export class ExperimentRunResearchObjectResolutionError extends Error {
  constructor(
    readonly code: ExperimentRunResearchObjectResolutionErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ExperimentRunResearchObjectResolutionError";
  }
}

const EXPERIMENT_RUN_FILE_REF_REQUEST_INDEX_LIMIT = 4;

function estimatedChars(...values: Array<string | undefined>): number {
  return values.reduce((total, value) => total + (value?.length ?? 0), 0);
}

function safeLabel(value: string | undefined, fallback: string): string {
  const cleaned = (value ?? "").replace(/[\0-\x1F\x7F]/gu, " ").trim();
  const parts = cleaned.split(/[\\/]/u).filter(Boolean);
  const leaf = parts[parts.length - 1]?.trim();
  return Array.from(leaf || fallback).slice(0, 160).join("");
}

function stringMetadata(
  descriptor: AIResearchObjectDescriptor,
  key: string
): string | undefined {
  const value = descriptor.safeMetadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function sourceRef(input: {
  descriptor: AIResearchObjectDescriptor;
  mode: AIContextMode;
  field: string;
  level: AIContextLevel;
  role: AIContextSourceRef["contextRole"];
  disposition?: AIContextSourceRef["contextDisposition"];
}): AIContextSourceRef {
  return {
    ...input.descriptor.sourceRef,
    field: input.field,
    contextMode: input.mode,
    contextLevel: input.level,
    contextRole: input.role,
    contextDisposition: input.disposition ?? "included"
  };
}

function relationTupleSourceRef(
  descriptor: AIResearchObjectDescriptor,
  mode: AIContextMode,
  selectionOrder: number,
  disposition: AIContextSourceRef["contextDisposition"] = "included"
): AIContextSourceRef {
  const parentExperimentId = stringMetadata(descriptor, "parentExperimentId") ?? "";
  return {
    module: "experiment",
    entityType: "experimentRun",
    entityId: descriptor.objectId,
    label: descriptor.label,
    field: "canonical ExperimentRun parent relation",
    sourceKind: "linkedReference",
    isUserAuthored: true,
    isAiGenerated: false,
    isVerified: true,
    contextMode: mode,
    contextLevel: 1,
    contextRole: "related",
    contextDisposition: disposition,
    relationHint: `experiment_run_parent:run=${descriptor.objectId};experiment=${parentExperimentId};project=${descriptor.projectId};order=${selectionOrder}`,
    runParentExperimentId: parentExperimentId,
    runInheritedProjectId: descriptor.projectId,
    runSelectionOrder: selectionOrder
  };
}

function parentProvenanceSourceRef(
  descriptor: AIResearchObjectDescriptor,
  mode: AIContextMode,
  selectionOrder: number,
  disposition: AIContextSourceRef["contextDisposition"] = "included"
): AIContextSourceRef {
  const parentExperimentId = stringMetadata(descriptor, "parentExperimentId") ?? "";
  return {
    module: "experiment",
    entityType: "experiment",
    entityId: parentExperimentId,
    label: stringMetadata(descriptor, "parentExperimentLabel") ?? parentExperimentId,
    field: "bounded ExperimentRun parent provenance",
    sourceKind: "linkedReference",
    isUserAuthored: true,
    isAiGenerated: false,
    isVerified: true,
    contextMode: mode,
    contextLevel: 2,
    contextRole: "related",
    contextDisposition: disposition,
    relationHint: `parent_provenance_for_run:${descriptor.objectId}`,
    runParentExperimentId: parentExperimentId,
    runInheritedProjectId: descriptor.projectId,
    runSelectionOrder: selectionOrder
  };
}

function relatedSourceRef(input: {
  descriptor: AIResearchObjectDescriptor;
  mode: AIContextMode;
  module: "route" | "task";
  entityType: "routeNode" | "task";
  entityId: string;
  label: string;
}): AIContextSourceRef {
  return {
    module: input.module,
    entityType: input.entityType,
    entityId: input.entityId,
    label: input.label,
    field: "ExperimentRun-scoped canonical direct relation identity",
    sourceKind: "derivedSummary",
    isUserAuthored: true,
    isAiGenerated: false,
    isVerified: true,
    contextMode: input.mode,
    contextLevel: 2,
    contextRole: "related",
    contextDisposition: "included",
    relationHint: `experiment_run_scope:run=${input.descriptor.objectId}`
  };
}

function contextItem(input: {
  id: string;
  title: string;
  summary: string;
  entityType: AIContextItem["entityType"];
  sourceRefs: AIContextSourceRef[];
  level: AIContextLevel;
  stableOrder: number;
  protectedFromContextBudget?: boolean;
  metadata?: AIContextItem["metadata"];
}): AIContextItem {
  return {
    id: input.id,
    title: input.title,
    summary: input.summary || input.title,
    module: "experiment",
    entityType: input.entityType,
    sourceRefs: input.sourceRefs,
    priority: input.level === 1 ? "critical" : "high",
    contextLevel: input.level,
    protectedFromContextBudget: input.protectedFromContextBudget,
    stableOrder: input.stableOrder,
    charCount: estimatedChars(input.title, input.summary || input.title),
    sendable: true,
    truncated: false,
    metadata: input.metadata
  };
}

function mapGuardFailure(error: unknown, runId: string): never {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "";
  if (code === "EXPERIMENT_RUN_NOT_FOUND") {
    throw new ExperimentRunResearchObjectResolutionError(
      "EXPERIMENT_RUN_NOT_FOUND",
      `Selected ExperimentRun is missing: ${runId}`
    );
  }
  if (code === "EXPERIMENT_RUN_PARENT_NOT_FOUND") {
    throw new ExperimentRunResearchObjectResolutionError(
      "EXPERIMENT_RUN_PARENT_NOT_FOUND",
      `Selected ExperimentRun has no canonical parent Experiment: ${runId}`
    );
  }
  if (code === "EXPERIMENT_RUN_PROJECT_MISMATCH") {
    throw new ExperimentRunResearchObjectResolutionError(
      "EXPERIMENT_RUN_PROJECT_MISMATCH",
      `ExperimentRun Project integrity does not match its parent Experiment: ${runId}`
    );
  }
  throw new ExperimentRunResearchObjectResolutionError(
    "EXPERIMENT_RUN_UNAVAILABLE",
    `Selected ExperimentRun is unavailable for new AI context: ${runId}`
  );
}

function assertCanonicalRelations(
  detail: ExperimentRunContext,
  expectedProjectId: string
): void {
  if (detail.run.routeId && !detail.route) {
    throw new ExperimentRunResearchObjectResolutionError(
      "EXPERIMENT_RUN_RELATION_INVALID",
      `ExperimentRun ${detail.run.id} references an unavailable Route.`
    );
  }
  if (detail.run.taskId && !detail.task) {
    throw new ExperimentRunResearchObjectResolutionError(
      "EXPERIMENT_RUN_RELATION_INVALID",
      `ExperimentRun ${detail.run.id} references an unavailable Task.`
    );
  }
  try {
    assertExperimentRunRelationOwnership(
      expectedProjectId,
      detail.route ?? undefined,
      detail.task ?? undefined
    );
  } catch (error) {
    throw new ExperimentRunResearchObjectResolutionError(
      "EXPERIMENT_RUN_RELATION_INVALID",
      error instanceof Error ? error.message : "ExperimentRun relation ownership is invalid."
    );
  }
}

function assertFreshDetail(
  detail: ExperimentRunContext | null,
  descriptor: AIResearchObjectDescriptor
): ExperimentRunContext {
  const parentExperimentId = stringMetadata(descriptor, "parentExperimentId");
  if (!detail || detail.run.id !== descriptor.objectId || detail.run.deletedAt) {
    throw new ExperimentRunResearchObjectResolutionError(
      "EXPERIMENT_RUN_CONTEXT_STALE",
      `ExperimentRun context became stale before package finalization: ${descriptor.objectId}`
    );
  }
  if (!parentExperimentId || detail.run.experimentId !== parentExperimentId || detail.experiment.id !== parentExperimentId) {
    throw new ExperimentRunResearchObjectResolutionError(
      "EXPERIMENT_RUN_PARENT_MISMATCH",
      `ExperimentRun ${descriptor.objectId} no longer resolves to its frozen canonical parent.`
    );
  }
  if (
    detail.run.projectId !== descriptor.projectId ||
    detail.experiment.projectId !== descriptor.projectId ||
    !detail.project || detail.project.id !== descriptor.projectId
  ) {
    throw new ExperimentRunResearchObjectResolutionError(
      "EXPERIMENT_RUN_PROJECT_MISMATCH",
      `ExperimentRun ${descriptor.objectId} no longer resolves to Project ${descriptor.projectId}.`
    );
  }
  if (detail.experiment.status === "archived" || detail.project.status === "archived") {
    throw new ExperimentRunResearchObjectResolutionError(
      "EXPERIMENT_RUN_PARENT_UNAVAILABLE",
      `ExperimentRun ${descriptor.objectId} has an archived parent Experiment or Project.`
    );
  }
  if (
    detail.run.updatedAt !== stringMetadata(descriptor, "runUpdatedAt") ||
    detail.experiment.updatedAt !== stringMetadata(descriptor, "parentExperimentUpdatedAt")
  ) {
    throw new ExperimentRunResearchObjectResolutionError(
      "EXPERIMENT_RUN_CONTEXT_STALE",
      `ExperimentRun ${descriptor.objectId} or its parent changed before package finalization.`
    );
  }
  assertCanonicalRelations(detail, descriptor.projectId);
  return detail;
}

export async function resolveExperimentRunResearchObjectDescriptor(
  runId: string,
  expectedProjectId: string
): Promise<AIResearchObjectDescriptor> {
  const normalizedRunId = runId.trim();
  const normalizedProjectId = expectedProjectId.trim();
  if (!normalizedRunId) {
    throw new ExperimentRunResearchObjectResolutionError(
      "EXPERIMENT_RUN_NOT_FOUND",
      "ExperimentRun identity is required."
    );
  }
  let access: Awaited<ReturnType<typeof getControlledExperimentRunAccess>>;
  try {
    access = await getControlledExperimentRunAccess(normalizedRunId);
  } catch (error) {
    return mapGuardFailure(error, normalizedRunId);
  }
  if (access.readOnly || access.ownerDeleted) {
    throw new ExperimentRunResearchObjectResolutionError(
      "EXPERIMENT_RUN_UNAVAILABLE",
      `Selected ExperimentRun is deleted or read-only: ${normalizedRunId}`
    );
  }
  if (access.parentDeleted) {
    throw new ExperimentRunResearchObjectResolutionError(
      "EXPERIMENT_RUN_PARENT_UNAVAILABLE",
      `Selected ExperimentRun parent is deleted: ${access.run.experimentId}`
    );
  }
  const parent = await experimentService.getExperimentById(access.run.experimentId);
  if (!parent) {
    throw new ExperimentRunResearchObjectResolutionError(
      "EXPERIMENT_RUN_PARENT_NOT_FOUND",
      `Selected ExperimentRun parent Experiment is missing: ${access.run.experimentId}`
    );
  }
  if (parent.id !== access.parent.id || parent.id !== access.run.experimentId) {
    throw new ExperimentRunResearchObjectResolutionError(
      "EXPERIMENT_RUN_PARENT_MISMATCH",
      `Selected ExperimentRun parent identity is inconsistent: ${normalizedRunId}`
    );
  }
  if (parent.status === "archived") {
    throw new ExperimentRunResearchObjectResolutionError(
      "EXPERIMENT_RUN_PARENT_UNAVAILABLE",
      `Selected ExperimentRun parent Experiment is archived: ${parent.id}`
    );
  }
  if (
    access.run.projectId !== parent.projectId ||
    access.parent.projectId !== parent.projectId ||
    parent.projectId !== normalizedProjectId
  ) {
    throw new ExperimentRunResearchObjectResolutionError(
      "EXPERIMENT_RUN_PROJECT_MISMATCH",
      `Selected ExperimentRun ${normalizedRunId} does not belong to Project ${normalizedProjectId}.`
    );
  }
  const detail = await getExperimentRunContext(normalizedRunId);
  if (!detail?.project || detail.project.id !== parent.projectId || detail.project.status === "archived") {
    throw new ExperimentRunResearchObjectResolutionError(
      "EXPERIMENT_RUN_PROJECT_UNAVAILABLE",
      `Selected ExperimentRun ${normalizedRunId} has no eligible canonical Project.`
    );
  }
  assertCanonicalRelations(detail, parent.projectId);
  const descriptor: AIResearchObjectDescriptor = {
    objectType: "experimentRun",
    objectId: access.run.id,
    projectId: parent.projectId,
    label: safeLabel(access.run.title || access.run.runLabel, access.run.id),
    description: normalizeExperimentContextDisplayValue(access.run.resultSummary) ?? undefined,
    sourceRef: {
      module: "experiment",
      entityType: "experimentRun",
      entityId: access.run.id,
      label: safeLabel(access.run.title || access.run.runLabel, access.run.id),
      field: "identity",
      sourceKind: "userAuthored",
      isUserAuthored: true,
      isAiGenerated: false,
      isVerified: true
    },
    safeMetadata: {
      status: access.run.status,
      rating: access.run.rating ?? null,
      parentExperimentId: parent.id,
      parentExperimentLabel: safeLabel(parent.title, parent.id),
      parentExperimentStatus: parent.status,
      parentExperimentUpdatedAt: parent.updatedAt,
      routeId: access.run.routeId ?? null,
      taskId: access.run.taskId ?? null,
      runUpdatedAt: access.run.updatedAt,
      schemaVersion: access.run.schemaVersion
    },
    ownerModule: "experiment",
    channel: "global_chat"
  };
  assertFreshDetail(detail, descriptor);
  return descriptor;
}

export async function listExperimentRunResearchObjectDescriptors(
  projectId: string
): Promise<AIResearchObjectDescriptor[]> {
  const access = (await listControlledActiveExperimentRuns())
    .filter((item) => item.run.projectId === projectId)
    .sort((left, right) => left.run.id.localeCompare(right.run.id));
  return Promise.all(access.map((item) =>
    resolveExperimentRunResearchObjectDescriptor(item.run.id, projectId)));
}

export type ExperimentRunResearchObjectContextCandidates = {
  primary: AIContextItem;
  related: AIContextItem[];
  parentProvenance: AIContextItem;
  parentRelation: AIExperimentRunParentRelation;
  excluded: AIContextExcludedItem[];
  warnings: string[];
  requestableRefs: AIContextRequestableRef[];
};

export async function buildExperimentRunResearchObjectContextCandidates(
  descriptor: AIResearchObjectDescriptor,
  mode: AIContextMode,
  selectionOrder: number
): Promise<ExperimentRunResearchObjectContextCandidates> {
  const detail = assertFreshDetail(await getExperimentRunContext(descriptor.objectId), descriptor);
  const parentExperimentId = detail.experiment.id;
  const parentRelation: AIExperimentRunParentRelation = {
    runId: detail.run.id,
    parentExperimentId,
    projectId: detail.experiment.projectId,
    selectionOrder
  };
  const minimumSummary = [
    `Status: ${detail.run.status}`,
    detail.run.rating ? `Rating: ${detail.run.rating}` : undefined,
    `Parent Experiment: ${parentExperimentId}`,
    `Project: ${detail.experiment.projectId}`
  ].filter(Boolean).join(" | ");
  const structuredValues = [
    ["conditionSummary", detail.run.conditionSummary],
    ["variableParameterSummary", detail.run.variableParameterSummary],
    ["methodSummary", detail.run.methodSummary],
    ["resultSummary", detail.run.resultSummary],
    ["conclusion", detail.run.conclusion],
    ["summaryOther", detail.run.summaryOther]
  ].flatMap(([key, value]) => {
    const normalized = normalizeExperimentContextDisplayValue(value);
    return normalized ? [`${key}: ${normalized}`] : [];
  });
  const summary = mode !== "MINIMAL" && structuredValues.length > 0
    ? [minimumSummary, ...structuredValues].join(" | ")
    : minimumSummary;
  const primary = contextItem({
    id: `primary-experiment-run:${descriptor.objectId}`,
    title: descriptor.label,
    summary,
    entityType: "experimentRun",
    sourceRefs: [
      sourceRef({
        descriptor,
        mode,
        field: mode !== "MINIMAL"
          ? "bounded structured ExperimentRun summary"
          : "identity, status, and canonical parent tuple",
        level: 1,
        role: "primary"
      }),
      relationTupleSourceRef(descriptor, mode, selectionOrder)
    ],
    level: 1,
    stableOrder: selectionOrder,
    protectedFromContextBudget: true,
    metadata: {
      status: detail.run.status,
      rating: detail.run.rating ?? null,
      parentExperimentId,
      inheritedProjectId: detail.experiment.projectId,
      selectionOrder
    }
  });
  const parentProvenance = contextItem({
    id: `experiment-run-parent-provenance:${parentExperimentId}`,
    title: safeLabel(detail.experiment.title, parentExperimentId),
    summary: `Parent Experiment provenance | Status: ${detail.experiment.status} | Project: ${detail.experiment.projectId}`,
    entityType: "experiment",
    sourceRefs: [parentProvenanceSourceRef(descriptor, mode, selectionOrder)],
    level: 2,
    stableOrder: selectionOrder,
    metadata: {
      status: detail.experiment.status,
      inheritedProjectId: detail.experiment.projectId,
      parentExperimentUpdatedAt: detail.experiment.updatedAt
    }
  });
  const relationCandidates = [
    ...(detail.route ? [{
      module: "route" as const,
      entityType: "routeNode" as const,
      entityId: detail.route.id,
      label: detail.route.title,
      status: detail.route.status
    }] : []),
    ...(detail.task ? [{
      module: "task" as const,
      entityType: "task" as const,
      entityId: detail.task.id,
      label: detail.task.title,
      status: detail.task.status
    }] : [])
  ].sort((left, right) => left.entityType.localeCompare(right.entityType) || left.entityId.localeCompare(right.entityId));
  const related = mode !== "MINIMAL"
    ? relationCandidates.map((relation, index) => contextItem({
        id: `experiment-run-related:${descriptor.objectId}:${relation.entityType}:${relation.entityId}`,
        title: relation.label,
        summary: relation.status ? `Status: ${relation.status}` : "Canonical direct relation identity.",
        entityType: relation.entityType,
        sourceRefs: [relatedSourceRef({ descriptor, mode, ...relation })],
        level: 2,
        stableOrder: selectionOrder * 100 + index,
        metadata: { status: relation.status ?? null }
      }))
    : [];
  const excluded: AIContextExcludedItem[] = mode !== "MINIMAL"
    ? []
    : [
        {
          reason: "notSelected" as const,
          module: "experiment" as const,
          entityType: "experiment" as const,
          entityId: parentExperimentId,
          label: `${detail.experiment.title}: bounded parent metadata excluded by ${mode}; canonical relation tuple remains included.`,
          sourceRefs: [parentProvenanceSourceRef(descriptor, mode, selectionOrder, "excluded")]
        },
        ...relationCandidates.map((relation) => ({
          reason: "notSelected" as const,
          module: relation.module,
          entityType: relation.entityType,
          entityId: relation.entityId,
          label: `${relation.label}: direct ExperimentRun relation excluded by ${mode}.`,
          sourceRefs: [{
            ...relatedSourceRef({ descriptor, mode, ...relation }),
            contextDisposition: "excluded" as const
          }]
        }))
      ];
  const fileRefs = detail.fileRefs
    .filter((fileRef) => !fileRef.deletedAt && fileRef.resourceKind === "file")
    .sort((left, right) => left.id.localeCompare(right.id));
  const requestableRefs = fileRefs.slice(0, EXPERIMENT_RUN_FILE_REF_REQUEST_INDEX_LIMIT).map((fileRef) => ({
    refKind: "FILE_REF" as const,
    refId: fileRef.id,
    projectId: descriptor.projectId,
    label: safeLabel(fileRef.title || fileRef.path, fileRef.id),
    entityType: "fileRef" as const,
    allowedContributionKinds: ["IDENTITY_METADATA" as const, "BODY_CONTENT" as const]
  }));
  const warnings = fileRefs.length > EXPERIMENT_RUN_FILE_REF_REQUEST_INDEX_LIMIT
    ? [`${fileRefs.length - EXPERIMENT_RUN_FILE_REF_REQUEST_INDEX_LIMIT} additional ExperimentRun FileRefs were omitted from the bounded Context Request index.`]
    : [];
  return { primary, related, parentProvenance, parentRelation, excluded, warnings, requestableRefs };
}

export type ExperimentRunCurrentAvailability = {
  status: "available" | "currently_unavailable";
  warning?: string;
};

/** Optional passive-readback check. Frozen receipt truth is returned independently of this result. */
export async function readExperimentRunCurrentAvailability(
  relation: AIExperimentRunParentRelation
): Promise<ExperimentRunCurrentAvailability> {
  try {
    const access = await getControlledExperimentRunAccess(relation.runId);
    const parent = await experimentService.getExperimentById(relation.parentExperimentId);
    if (
      access.readOnly || access.ownerDeleted || access.parentDeleted || !parent ||
      access.run.experimentId !== relation.parentExperimentId ||
      access.run.projectId !== relation.projectId || parent.projectId !== relation.projectId ||
      parent.status === "archived"
    ) {
      return {
        status: "currently_unavailable",
        warning: "Current ExperimentRun or parent Experiment is unavailable; frozen durable provenance remains authoritative for this historical attempt."
      };
    }
    return { status: "available" };
  } catch {
    return {
      status: "currently_unavailable",
      warning: "Current ExperimentRun or parent Experiment is unavailable; frozen durable provenance remains authoritative for this historical attempt."
    };
  }
}

export function readExperimentRunParentRelations(
  sourceRefs: readonly AIContextSourceRef[]
): AIExperimentRunParentRelation[] {
  const relations = sourceRefs.flatMap((sourceRef) => {
    if (
      sourceRef.field !== "canonical ExperimentRun parent relation" ||
      sourceRef.entityType !== "experimentRun" || !sourceRef.entityId ||
      !sourceRef.runParentExperimentId || !sourceRef.runInheritedProjectId ||
      !Number.isSafeInteger(sourceRef.runSelectionOrder) || (sourceRef.runSelectionOrder ?? -1) < 0
    ) return [];
    return [{
      runId: sourceRef.entityId,
      parentExperimentId: sourceRef.runParentExperimentId,
      projectId: sourceRef.runInheritedProjectId,
      selectionOrder: sourceRef.runSelectionOrder as number
    }];
  });
  const unique = new Map<string, AIExperimentRunParentRelation>();
  for (const relation of relations.sort((left, right) =>
    left.selectionOrder - right.selectionOrder || left.runId.localeCompare(right.runId))) {
    const prior = unique.get(relation.runId);
    if (
      prior && (
        prior.parentExperimentId !== relation.parentExperimentId ||
        prior.projectId !== relation.projectId ||
        prior.selectionOrder !== relation.selectionOrder
      )
    ) {
      throw new Error(`ExperimentRun ${relation.runId} has contradictory canonical parent relation tuples.`);
    }
    if (!prior) unique.set(relation.runId, relation);
  }
  return [...unique.values()];
}
