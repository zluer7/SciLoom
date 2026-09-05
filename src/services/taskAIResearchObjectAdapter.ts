import { planningSelectorService } from "./planningSelectorService";
import { planningService } from "./planningService";
import type {
  AIContextItem,
  AIContextExcludedItem,
  AIContextLevel,
  AIContextMode,
  AIContextPriority,
  AIContextRequestableRef,
  AIContextSourceRef,
  AIResearchObjectDescriptor
} from "../types/aiContext";
import type { EntitySummary, EvidenceSummary } from "../types/entityContext";

export const TASK_CONTEXT_LEVEL_POLICY = Object.freeze({
  primary: 1 as AIContextLevel,
  directRelation: 2 as AIContextLevel,
  indirectRelation: 3 as AIContextLevel,
  projectBackground: 4 as AIContextLevel
});

const RECOGNIZED_TASK_RELATIONS = new Set([
  "belongs_to_project",
  "belongs_to_route",
  "task_scope",
  "needs_followup_task",
  "source_output_gap",
  "related_output_gap"
]);

function estimatedChars(...values: Array<string | undefined>): number {
  return values.reduce((total, value) => total + (value?.length ?? 0), 0);
}

function taskSourceRef(
  descriptor: AIResearchObjectDescriptor,
  mode: AIContextMode,
  field = "identity"
): AIContextSourceRef {
  return {
    ...descriptor.sourceRef,
    field,
    contextMode: mode,
    contextLevel: 1,
    contextRole: "primary",
    contextDisposition: "included"
  };
}

function relationSourceRef(
  module: AIContextSourceRef["module"],
  entityType: AIContextSourceRef["entityType"],
  entityId: string,
  label: string,
  mode: AIContextMode,
  relationHint: string
): AIContextSourceRef {
  return {
    module,
    entityType,
    entityId,
    label,
    field: "task-scoped relation summary",
    sourceKind: "derivedSummary",
    isUserAuthored: true,
    isAiGenerated: false,
    isVerified: false,
    contextMode: mode,
    contextLevel: 2,
    contextRole: "related",
    contextDisposition: "included",
    relationHint
  };
}

function statusSummary(summary: EntitySummary): string {
  return [summary.subtitle, summary.status ? `Status: ${summary.status}` : undefined]
    .filter(Boolean)
    .join(" | ");
}

function evidenceSummary(summary: EvidenceSummary): string {
  return [
    summary.contentSummary,
    summary.source?.status ? `Status: ${summary.source.status}` : undefined,
    summary.relationType ? `Relation: ${summary.relationType}` : undefined
  ].filter(Boolean).join(" | ");
}

function item(
  id: string,
  title: string,
  summary: string,
  module: AIContextItem["module"],
  entityType: AIContextItem["entityType"],
  sourceRef: AIContextSourceRef,
  level: AIContextLevel,
  priority: AIContextPriority,
  stableOrder: number,
  protectedFromContextBudget = false
): AIContextItem {
  return {
    id,
    title,
    summary: summary || title,
    module,
    entityType,
    sourceRefs: [sourceRef],
    priority,
    contextLevel: level,
    protectedFromContextBudget,
    stableOrder,
    charCount: estimatedChars(title, summary || title),
    sendable: true,
    truncated: false
  };
}

export class TaskResearchObjectResolutionError extends Error {
  constructor(
    public readonly code:
      | "TASK_NOT_FOUND"
      | "TASK_UNAVAILABLE"
      | "TASK_PROJECT_MISMATCH"
      | "TASK_CONTEXT_STALE"
      | "TASK_CONTEXT_PROJECT_MISMATCH",
    message: string
  ) {
    super(message);
    this.name = "TaskResearchObjectResolutionError";
  }
}

export async function resolveTaskResearchObjectDescriptor(
  taskId: string,
  expectedProjectId: string
): Promise<AIResearchObjectDescriptor> {
  const task = await planningService.getTaskById(taskId);
  if (!task) {
    throw new TaskResearchObjectResolutionError(
      "TASK_NOT_FOUND",
      `Selected Task is missing or no longer active: ${taskId}`
    );
  }
  if (task.status === "archived" || task.captureState === "archived" || Boolean(task.archivedAt)) {
    throw new TaskResearchObjectResolutionError(
      "TASK_UNAVAILABLE",
      `Selected Task is archived and unavailable for new AI context: ${taskId}`
    );
  }
  if (task.projectId !== expectedProjectId) {
    throw new TaskResearchObjectResolutionError(
      "TASK_PROJECT_MISMATCH",
      `Selected Task ${taskId} does not belong to Project ${expectedProjectId}.`
    );
  }

  return {
    objectType: "task",
    objectId: task.id,
    projectId: task.projectId,
    label: task.title,
    description: task.description,
    sourceRef: {
      module: "task",
      entityType: "task",
      entityId: task.id,
      label: task.title,
      field: "identity",
      sourceKind: "userAuthored",
      isUserAuthored: true,
      isAiGenerated: false,
      isVerified: true
    },
    safeMetadata: {
      status: task.status,
      priority: task.priority,
      routeNodeId: task.routeNodeId ?? null,
      updatedAt: task.updatedAt
    },
    ownerModule: "task",
    channel: "global_chat"
  };
}

export async function listTaskResearchObjectDescriptors(
  projectId: string
): Promise<AIResearchObjectDescriptor[]> {
  const tasks = await planningService.queryTasks({ projectId });
  return Promise.all(tasks.map((task) => resolveTaskResearchObjectDescriptor(task.id, projectId)));
}

export type TaskResearchObjectContextCandidates = {
  primary: AIContextItem;
  related: AIContextItem[];
  excluded: AIContextExcludedItem[];
  warnings: string[];
  requestableRefs: AIContextRequestableRef[];
};

const TASK_FILE_REF_REQUEST_INDEX_LIMIT = 10;

function safeRequestableLabel(value: string, fallback: string): string {
  const cleaned = value.replace(/[\0-\x1F\x7F]/gu, " ").trim();
  const parts = cleaned.split(/[\\/]/u).filter(Boolean);
  const leaf = parts[parts.length - 1]?.trim();
  return Array.from(leaf || fallback).slice(0, 160).join("");
}

export async function buildTaskResearchObjectContextCandidates(
  descriptor: AIResearchObjectDescriptor,
  mode: AIContextMode,
  selectionOrder: number
): Promise<TaskResearchObjectContextCandidates> {
  const execution = await planningSelectorService.getTaskExecutionContext(descriptor.objectId);
  if (
    !execution || execution.task.entityId !== descriptor.objectId ||
    execution.task.sourceAvailable === false
  ) {
    throw new TaskResearchObjectResolutionError(
      "TASK_CONTEXT_STALE",
      `Task context became stale before package finalization: ${descriptor.objectId}`
    );
  }
  if (!execution.project || execution.project.entityId !== descriptor.projectId) {
    throw new TaskResearchObjectResolutionError(
      "TASK_CONTEXT_PROJECT_MISMATCH",
      `Task ${descriptor.objectId} no longer resolves to Project ${descriptor.projectId}.`
    );
  }

  const minimumSummary = execution.task.status
    ? `Status: ${execution.task.status}`
    : "Selected Task identity.";
  const primarySummary = mode !== "MINIMAL"
    ? statusSummary(execution.task) || minimumSummary
    : minimumSummary;
  const primary = item(
    `primary-task:${descriptor.objectId}`,
    descriptor.label,
    primarySummary,
    "task",
    "task",
    taskSourceRef(descriptor, mode, mode !== "MINIMAL" ? "bounded task summary" : "identity"),
    1,
    "critical",
    selectionOrder,
    true
  );

  const related: AIContextItem[] = [];
  const excluded: AIContextExcludedItem[] = [];
  const warnings = [...execution.warnings].sort();
  const requestableRefs: AIContextRequestableRef[] = [...execution.fileRefs]
    .filter((summary) => summary.source?.sourceAvailable !== false)
    .sort((left, right) => left.evidenceId.localeCompare(right.evidenceId))
    .slice(0, TASK_FILE_REF_REQUEST_INDEX_LIMIT)
    .map((summary) => ({
      refKind: "FILE_REF",
      refId: summary.evidenceId,
      projectId: descriptor.projectId,
      label: safeRequestableLabel(summary.title, summary.evidenceId),
      entityType: "fileRef",
      allowedContributionKinds: ["IDENTITY_METADATA", "BODY_CONTENT"]
    }));
  if (execution.fileRefs.length > TASK_FILE_REF_REQUEST_INDEX_LIMIT) {
    warnings.push(
      `${execution.fileRefs.length - TASK_FILE_REF_REQUEST_INDEX_LIMIT} additional Task FileRefs were omitted from the bounded Context Request index.`
    );
  }
  const orderedOutputGaps = [...execution.outputGaps].sort((left, right) =>
    (left.relationType ?? "needs_followup_task").localeCompare(
      right.relationType ?? "needs_followup_task"
    ) || left.evidenceId.localeCompare(right.evidenceId)
  );

  if (mode === "MINIMAL") {
    excluded.push({
      reason: "notSelected",
      module: "task",
      entityType: "task",
      entityId: descriptor.objectId,
      label: `${descriptor.label}: bounded Task payload excluded by ${mode}.`,
      sourceRefs: [{
        ...taskSourceRef(descriptor, mode, "bounded task payload"),
        contextDisposition: "excluded"
      }]
    });
    if (execution.routeNode) {
      const routeRef = relationSourceRef(
        "route",
        "routeNode",
        execution.routeNode.entityId,
        execution.routeNode.title,
        mode,
        `belongs_to_route:task=${descriptor.objectId}`
      );
      excluded.push({
        reason: "notSelected",
        module: "route",
        entityType: "routeNode",
        entityId: execution.routeNode.entityId,
        label: `${execution.routeNode.title}: direct Task relation excluded by ${mode}.`,
        sourceRefs: [{ ...routeRef, contextDisposition: "excluded" }]
      });
    }
    for (const gap of orderedOutputGaps.slice(0, 3)) {
      const relationType = gap.relationType || "needs_followup_task";
      const gapRef = relationSourceRef(
        "outputConversion",
        "outputGap",
        gap.evidenceId,
        gap.title,
        mode,
        `${relationType}:task=${descriptor.objectId}`
      );
      const recognized = isRecognizedTaskRelationType(relationType);
      excluded.push({
        reason: recognized ? "notSelected" : "unsupported",
        module: "outputConversion",
        entityType: "outputGap",
        entityId: gap.evidenceId,
        label: recognized
          ? `${gap.title}: direct Task relation excluded by ${mode}.`
          : `${gap.title}: unsupported Task relation ${relationType}`,
        sourceRefs: [{ ...gapRef, contextDisposition: "excluded" }]
      });
      if (!recognized) {
        warnings.push(`Unsupported Task relation ${relationType} for ${gap.title} was excluded.`);
      }
    }
    if (orderedOutputGaps.length > 3) {
      excluded.push({
        reason: "notSelected",
        module: "outputConversion",
        entityType: "outputGap",
        label: `${orderedOutputGaps.length - 3} additional Task output-gap relations were excluded by the bounded direct-relation policy.`,
        sourceRefs: []
      });
    }
    return { primary, related, excluded, warnings, requestableRefs };
  }

  let relatedOrder = selectionOrder * 100;
  if (execution.routeNode) {
    const routeRef = relationSourceRef(
      "route",
      "routeNode",
      execution.routeNode.entityId,
      execution.routeNode.title,
      mode,
      `belongs_to_route:task=${descriptor.objectId}`
    );
    related.push(item(
      `task-route:${descriptor.objectId}:${execution.routeNode.entityId}`,
      execution.routeNode.title,
      statusSummary(execution.routeNode),
      "route",
      "routeNode",
      routeRef,
      2,
      "high",
      relatedOrder++
    ));
  }

  for (const gap of orderedOutputGaps.slice(0, 3)) {
    const relationType = gap.relationType || "needs_followup_task";
    const gapRef = relationSourceRef(
      "outputConversion",
      "outputGap",
      gap.evidenceId,
      gap.title,
      mode,
      `${relationType}:task=${descriptor.objectId}`
    );
    if (!isRecognizedTaskRelationType(relationType)) {
      excluded.push({
        reason: "unsupported",
        module: "outputConversion",
        entityType: "outputGap",
        entityId: gap.evidenceId,
        label: `${gap.title}: unsupported Task relation ${relationType}`,
        sourceRefs: [{ ...gapRef, contextDisposition: "excluded" }]
      });
      warnings.push(`Unsupported Task relation ${relationType} for ${gap.title} was excluded.`);
      continue;
    }
    related.push(item(
      `task-output-gap:${descriptor.objectId}:${gap.evidenceId}`,
      gap.title,
      evidenceSummary(gap),
      "outputConversion",
      "outputGap",
      gapRef,
      2,
      "high",
      relatedOrder++
    ));
  }

  if (orderedOutputGaps.length > 3) {
    excluded.push({
      reason: "notSelected",
      module: "outputConversion",
      entityType: "outputGap",
      label: `${orderedOutputGaps.length - 3} additional Task output-gap relations were excluded by the bounded direct-relation policy.`,
      sourceRefs: []
    });
  }

  return { primary, related, excluded, warnings, requestableRefs };
}

export function isRecognizedTaskRelationType(relationType: string): boolean {
  return RECOGNIZED_TASK_RELATIONS.has(relationType);
}

export function orderTaskContextCandidates(items: AIContextItem[]): AIContextItem[] {
  return [...items].sort((left, right) =>
    (left.contextLevel ?? 4) - (right.contextLevel ?? 4) ||
    (left.stableOrder ?? Number.MAX_SAFE_INTEGER) - (right.stableOrder ?? Number.MAX_SAFE_INTEGER) ||
    left.entityType.localeCompare(right.entityType) ||
    left.id.localeCompare(right.id)
  );
}
