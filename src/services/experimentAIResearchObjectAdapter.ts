import type {
  AIContextExcludedItem,
  AIContextItem,
  AIContextLevel,
  AIContextMode,
  AIContextRequestableRef,
  AIContextSourceRef,
  AIResearchObjectDescriptor
} from "../types/aiContext";
import type { ExperimentDetailContext } from "../types/experimentContext";
import { createExperimentEditorContextSummaryDto } from "./experimentEditorContextSummaryService";
import { normalizeExperimentContextDisplayValue } from "./experimentStructuredSummaryProjection";
import { experimentService } from "./experimentService";
import { getExperimentDetailContext } from "./experimentSelectorService";

export class ExperimentResearchObjectResolutionError extends Error {
  constructor(
    readonly code:
      | "EXPERIMENT_NOT_FOUND"
      | "EXPERIMENT_UNAVAILABLE"
      | "EXPERIMENT_PROJECT_MISMATCH"
      | "EXPERIMENT_PROJECT_UNAVAILABLE"
      | "EXPERIMENT_CONTEXT_STALE"
      | "EXPERIMENT_CONTEXT_PROJECT_MISMATCH",
    message: string
  ) {
    super(message);
    this.name = "ExperimentResearchObjectResolutionError";
  }
}

const EXPERIMENT_FILE_REF_REQUEST_INDEX_LIMIT = 4;

function estimatedChars(...values: Array<string | undefined>): number {
  return values.reduce((total, value) => total + (value?.length ?? 0), 0);
}

function safeLabel(value: string | undefined, fallback: string): string {
  const cleaned = (value ?? "").replace(/[\0-\x1F\x7F]/gu, " ").trim();
  const parts = cleaned.split(/[\\/]/u).filter(Boolean);
  const leaf = parts[parts.length - 1]?.trim();
  return Array.from(leaf || fallback).slice(0, 160).join("");
}

function sourceRef(
  descriptor: AIResearchObjectDescriptor,
  mode: AIContextMode,
  field: string,
  level: AIContextLevel,
  role: AIContextSourceRef["contextRole"],
  disposition: AIContextSourceRef["contextDisposition"] = "included"
): AIContextSourceRef {
  return {
    ...descriptor.sourceRef,
    field,
    contextMode: mode,
    contextLevel: level,
    contextRole: role,
    contextDisposition: disposition
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
    field: "experiment-scoped direct relation identity",
    sourceKind: "derivedSummary",
    isUserAuthored: true,
    isAiGenerated: false,
    isVerified: true,
    contextMode: input.mode,
    contextLevel: 2,
    contextRole: "related",
    contextDisposition: "included",
    relationHint: `experiment_scope:experiment=${input.descriptor.objectId}`
  };
}

function contextItem(input: {
  id: string;
  title: string;
  summary: string;
  module: AIContextItem["module"];
  entityType: AIContextItem["entityType"];
  sourceRef: AIContextSourceRef;
  level: AIContextLevel;
  stableOrder: number;
  protectedFromContextBudget?: boolean;
  metadata?: AIContextItem["metadata"];
}): AIContextItem {
  return {
    id: input.id,
    title: input.title,
    summary: input.summary || input.title,
    module: input.module,
    entityType: input.entityType,
    sourceRefs: [input.sourceRef],
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

function assertFreshDetail(
  detail: ExperimentDetailContext | null,
  descriptor: AIResearchObjectDescriptor
): ExperimentDetailContext {
  if (!detail || detail.experiment.id !== descriptor.objectId || detail.experiment.deletedAt) {
    throw new ExperimentResearchObjectResolutionError(
      "EXPERIMENT_CONTEXT_STALE",
      `Experiment context became stale before package finalization: ${descriptor.objectId}`
    );
  }
  if (
    detail.experiment.projectId !== descriptor.projectId ||
    !detail.project || detail.project.id !== descriptor.projectId
  ) {
    throw new ExperimentResearchObjectResolutionError(
      "EXPERIMENT_CONTEXT_PROJECT_MISMATCH",
      `Experiment ${descriptor.objectId} no longer resolves to Project ${descriptor.projectId}.`
    );
  }
  if (detail.experiment.status === "archived" || detail.project.status === "archived") {
    throw new ExperimentResearchObjectResolutionError(
      "EXPERIMENT_UNAVAILABLE",
      `Experiment ${descriptor.objectId} or its Project is no longer eligible for new AI context.`
    );
  }
  if (detail.experiment.updatedAt !== descriptor.safeMetadata?.updatedAt) {
    throw new ExperimentResearchObjectResolutionError(
      "EXPERIMENT_CONTEXT_STALE",
      `Experiment ${descriptor.objectId} changed before package finalization.`
    );
  }
  return detail;
}

export async function resolveExperimentResearchObjectDescriptor(
  experimentId: string,
  expectedProjectId: string
): Promise<AIResearchObjectDescriptor> {
  const experiment = await experimentService.getExperimentById(experimentId);
  if (!experiment) {
    throw new ExperimentResearchObjectResolutionError(
      "EXPERIMENT_NOT_FOUND",
      `Selected Experiment is missing or no longer active: ${experimentId}`
    );
  }
  if (experiment.deletedAt || experiment.status === "archived") {
    throw new ExperimentResearchObjectResolutionError(
      "EXPERIMENT_UNAVAILABLE",
      `Selected Experiment is unavailable for new AI context: ${experimentId}`
    );
  }
  if (experiment.projectId !== expectedProjectId) {
    throw new ExperimentResearchObjectResolutionError(
      "EXPERIMENT_PROJECT_MISMATCH",
      `Selected Experiment ${experimentId} does not belong to Project ${expectedProjectId}.`
    );
  }
  const detail = await getExperimentDetailContext(experiment.id);
  if (!detail?.project || detail.project.id !== experiment.projectId || detail.project.status === "archived") {
    throw new ExperimentResearchObjectResolutionError(
      "EXPERIMENT_PROJECT_UNAVAILABLE",
      `Selected Experiment ${experimentId} has no eligible canonical Project.`
    );
  }
  const descriptor: AIResearchObjectDescriptor = {
    objectType: "experiment",
    objectId: experiment.id,
    projectId: experiment.projectId,
    label: safeLabel(experiment.title, experiment.id),
    description: normalizeExperimentContextDisplayValue(experiment.purposeAndQuestion) ?? undefined,
    sourceRef: {
      module: "experiment",
      entityType: "experiment",
      entityId: experiment.id,
      label: safeLabel(experiment.title, experiment.id),
      field: "identity",
      sourceKind: "userAuthored",
      isUserAuthored: true,
      isAiGenerated: false,
      isVerified: true
    },
    safeMetadata: {
      status: experiment.status,
      rating: experiment.rating ?? null,
      routeId: experiment.routeId ?? null,
      taskId: experiment.taskId ?? null,
      updatedAt: experiment.updatedAt,
      schemaVersion: experiment.schemaVersion
    },
    ownerModule: "experiment",
    channel: "global_chat"
  };
  assertFreshDetail(detail, descriptor);
  return descriptor;
}

export async function listExperimentResearchObjectDescriptors(
  projectId: string
): Promise<AIResearchObjectDescriptor[]> {
  const experiments = (await experimentService.getExperimentsByProject(projectId))
    .filter((experiment) => !experiment.deletedAt && experiment.status !== "archived")
    .sort((left, right) => left.id.localeCompare(right.id));
  return Promise.all(experiments.map((experiment) => (
    resolveExperimentResearchObjectDescriptor(experiment.id, projectId)
  )));
}

export type ExperimentResearchObjectContextCandidates = {
  primary: AIContextItem;
  related: AIContextItem[];
  excluded: AIContextExcludedItem[];
  warnings: string[];
  requestableRefs: AIContextRequestableRef[];
};

export async function buildExperimentResearchObjectContextCandidates(
  descriptor: AIResearchObjectDescriptor,
  mode: AIContextMode,
  selectionOrder: number
): Promise<ExperimentResearchObjectContextCandidates> {
  const detail = assertFreshDetail(
    await getExperimentDetailContext(descriptor.objectId),
    descriptor
  );
  const dto = createExperimentEditorContextSummaryDto({
    experiment: detail.experiment,
    projectName: detail.project?.title,
    ratingLabel: (rating) => rating
  });
  const structuredValues = Object.entries(dto.structuredSummary)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && Boolean(entry[1]))
    .map(([key, value]) => `${key}: ${value}`);
  const minimumSummary = [
    `Status: ${detail.experiment.status}`,
    detail.experiment.rating ? `Rating: ${detail.experiment.rating}` : undefined
  ].filter(Boolean).join(" | ");
  const summary = mode !== "MINIMAL" && structuredValues.length > 0
    ? [minimumSummary, ...structuredValues].join(" | ")
    : minimumSummary;
  const primary = contextItem({
    id: `primary-experiment:${descriptor.objectId}`,
    title: descriptor.label,
    summary,
    module: "experiment",
    entityType: "experiment",
    sourceRef: sourceRef(
      descriptor,
      mode,
      mode !== "MINIMAL" ? "bounded structured Experiment summary" : "identity and status",
      1,
      "primary"
    ),
    level: 1,
    stableOrder: selectionOrder,
    protectedFromContextBudget: true,
    metadata: { status: detail.experiment.status, rating: detail.experiment.rating ?? null }
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
    ? relationCandidates.map((relation, index) => {
        const ref = relatedSourceRef({ descriptor, mode, ...relation });
        return contextItem({
          id: `experiment-related:${descriptor.objectId}:${relation.entityType}:${relation.entityId}`,
          title: relation.label,
          summary: relation.status ? `Status: ${relation.status}` : "Canonical direct relation identity.",
          module: relation.module,
          entityType: relation.entityType,
          sourceRef: ref,
          level: 2,
          stableOrder: selectionOrder * 100 + index,
          metadata: { status: relation.status ?? null }
        });
      })
    : [];
  const excluded: AIContextExcludedItem[] = mode !== "MINIMAL"
    ? []
    : relationCandidates.map((relation) => ({
        reason: "notSelected" as const,
        module: relation.module,
        entityType: relation.entityType,
        entityId: relation.entityId,
        label: `${relation.label}: direct Experiment relation excluded by ${mode}.`,
        sourceRefs: [{
          ...relatedSourceRef({ descriptor, mode, ...relation }),
          contextDisposition: "excluded" as const
        }]
      }));

  const fileRefs = [...detail.experimentFileRefs]
    .filter((fileRef) => !fileRef.deletedAt && fileRef.resourceKind === "file")
    .sort((left, right) => left.id.localeCompare(right.id));
  const requestableRefs: AIContextRequestableRef[] = fileRefs
    .slice(0, EXPERIMENT_FILE_REF_REQUEST_INDEX_LIMIT)
    .map((fileRef) => ({
      refKind: "FILE_REF",
      refId: fileRef.id,
      projectId: descriptor.projectId,
      label: safeLabel(fileRef.title || fileRef.path, fileRef.id),
      entityType: "fileRef",
      allowedContributionKinds: ["IDENTITY_METADATA", "BODY_CONTENT"]
    }));
  const warnings = fileRefs.length > EXPERIMENT_FILE_REF_REQUEST_INDEX_LIMIT
    ? [`${fileRefs.length - EXPERIMENT_FILE_REF_REQUEST_INDEX_LIMIT} additional Experiment FileRefs were omitted from the bounded Context Request index.`]
    : [];
  return { primary, related, excluded, warnings, requestableRefs };
}
