import type { EntityId } from "../types/common";
import type { CustomField } from "../types/experiment";
import type {
  ApplyOutputGapBackfillDraftInput,
  CreateOutputGapBackfillDraftInput,
  OutputGapBackfillApplyResult,
  OutputGapBackfillCandidate,
  OutputGapBackfillConfirmation,
  OutputGapBackfillDraft,
  OutputGapBackfillPreview,
  OutputGapBackfillProposedChange,
  OutputGapBackfillSource
} from "../types/outputGapBackfill";
import type { OutputGap } from "../types/outputConversion";
import type { Task } from "../types/planning";
import { entityLinkService } from "./entityLinkService";
import { outputConversionService } from "./outputConversionService";
import { planningService } from "./planningService";

type PreviewRegistryEntry = {
  previewHash: string;
  draftFingerprint: string;
};

const previewRegistry = new Map<string, PreviewRegistryEntry>();
const appliedBackfillResults = new Map<string, OutputGapBackfillApplyResult>();

function nowIso() {
  return new Date().toISOString();
}

function safeText(value: unknown, maxLength = 1000) {
  const text = String(value ?? "")
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s"'<>|]+/g, "[local path]")
    .replace(/file:\/\/\/?[^\s"'<>|]+/gi, "[local path]")
    .trim();
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 3))}...` : text;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)])
    );
  }
  return value;
}

function deterministicHash(value: unknown) {
  const text = JSON.stringify(stableValue(value));
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function isResolvableGap(gap: OutputGap) {
  return gap.status === "pending" || gap.status === "task_created" || gap.status === "route_feedback_created";
}

function canApplyCandidate(task: Task, gap: OutputGap) {
  return task.status === "done" && isResolvableGap(gap);
}

function candidateWarnings(task: Task, gap: OutputGap, count: number) {
  const warnings: string[] = [];
  if (task.status !== "done") {
    warnings.push("Task is not done; backfill apply will be blocked until completion.");
  }
  if (gap.status === "resolved") {
    warnings.push("OutputGap is already resolved.");
  }
  if (gap.status === "abandoned") {
    warnings.push("OutputGap is abandoned and cannot be resolved from Task.");
  }
  if (task.projectId !== gap.projectId) {
    warnings.push("Task and OutputGap belong to different projects.");
  }
  if (count > 1) {
    warnings.push("Multiple OutputGap candidates were found for this Task.");
  }
  return warnings;
}

function sourceFor(relatedTaskId: boolean, entityLink: boolean) {
  if (relatedTaskId && entityLink) return "both";
  if (entityLink) return "entityLink";
  return "relatedTaskId";
}

function sourceBoundaryFor(candidate: OutputGapBackfillCandidate): OutputGapBackfillSource[] {
  if (candidate.source === "both") {
    return ["relatedTaskId", "crossModuleEntityLink"];
  }
  return [candidate.source === "entityLink" ? "crossModuleEntityLink" : "relatedTaskId"];
}

async function getTaskOrThrow(taskId: EntityId) {
  const task = await planningService.getTaskById(taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }
  return task;
}

async function getOutputGapOrThrow(gapId: EntityId) {
  const gap = await outputConversionService.getOutputGapById(gapId);
  if (!gap) {
    throw new Error(`OutputGap not found: ${gapId}`);
  }
  return gap;
}

export async function findOutputGapBackfillCandidatesForTask(
  taskId: EntityId
): Promise<OutputGapBackfillCandidate[]> {
  const task = await planningService.getTaskById(taskId);
  if (!task) {
    return [];
  }

  const [gaps, targetLinks, sourceLinks] = await Promise.all([
    outputConversionService.listOutputGaps(),
    entityLinkService.queryLinksByTarget("task", task.id),
    entityLinkService.queryLinksBySource("task", task.id)
  ]);
  const linkedGapIds = new Set(
    [
      ...targetLinks
        .filter((link) => link.sourceType === "outputGap")
        .map((link) => link.sourceId),
      ...sourceLinks
        .filter((link) => link.targetType === "outputGap")
        .map((link) => link.targetId)
    ].filter(Boolean)
  );

  const matches = gaps.filter((gap) => gap.relatedTaskId === task.id || linkedGapIds.has(gap.id));
  return matches.map((gap) => {
    const byRelatedTaskId = gap.relatedTaskId === task.id;
    const byEntityLink = linkedGapIds.has(gap.id);
    return {
      taskId: task.id,
      gapId: gap.id,
      projectId: gap.projectId,
      source: sourceFor(byRelatedTaskId, byEntityLink),
      confidence: byRelatedTaskId && byEntityLink ? "high" : byEntityLink ? "medium" : "high",
      currentTaskStatus: task.status,
      currentGapStatus: gap.status,
      canApply: canApplyCandidate(task, gap),
      warnings: candidateWarnings(task, gap, matches.length)
    };
  });
}

function draftFingerprint(draft: OutputGapBackfillDraft) {
  return deterministicHash({
    id: draft.id,
    kind: draft.kind,
    taskId: draft.taskId,
    gapId: draft.gapId,
    projectId: draft.projectId,
    sourceGapStatus: draft.sourceGapStatus,
    sourceTaskStatus: draft.sourceTaskStatus,
    proposedGapStatus: draft.proposedGapStatus,
    proposedResolutionNote: draft.proposedResolutionNote,
    sourceBoundary: draft.sourceBoundary
  });
}

function draftId(input: { task: Task; gap: OutputGap; proposedResolutionNote?: string }) {
  return `output-gap-backfill:taskCompletionResolved:${input.task.id}:${input.gap.id}:${deterministicHash({
    taskUpdatedAt: input.task.updatedAt,
    gapUpdatedAt: input.gap.updatedAt,
    note: input.proposedResolutionNote
  })}`;
}

function proposedChanges(draft: OutputGapBackfillDraft): OutputGapBackfillProposedChange[] {
  return [
    {
      targetType: "task",
      operation: "verify",
      summary: `Verify Task ${draft.taskId} is completed.`
    },
    {
      targetType: "outputGap",
      operation: "update",
      summary: "Update OutputGap status to resolved and record resolution metadata."
    },
    {
      targetType: "entityLink",
      operation: "verify",
      summary: "Verify or ensure the cross-module OutputGap -> Task EntityLink."
    }
  ];
}

function calculatePreviewHash(
  draft: OutputGapBackfillDraft,
  changes: OutputGapBackfillProposedChange[]
) {
  return deterministicHash({
    draftFingerprint: draftFingerprint(draft),
    proposedChanges: changes
  });
}

async function assertTaskGapMatch(task: Task, gap: OutputGap) {
  if (task.projectId !== gap.projectId) {
    throw new Error("Task and OutputGap project mismatch.");
  }
  const links = await entityLinkService.queryLinksBetween(
    "outputGap",
    gap.id,
    "task",
    task.id,
    "needs_followup_task"
  );
  if (gap.relatedTaskId !== task.id && links.length === 0) {
    throw new Error("OutputGap is not linked to this Task.");
  }
}

export async function createTaskCompletionOutputGapBackfillDraft(
  input: CreateOutputGapBackfillDraftInput
): Promise<OutputGapBackfillDraft> {
  const task = await getTaskOrThrow(input.taskId);
  const candidates = await findOutputGapBackfillCandidatesForTask(input.taskId);
  const candidate = input.gapId
    ? candidates.find((item) => item.gapId === input.gapId)
    : candidates.length === 1
      ? candidates[0]
      : undefined;
  if (!candidate) {
    throw new Error(
      input.gapId
        ? `OutputGap candidate not found for Task: ${input.gapId}`
        : `Expected exactly one OutputGap candidate for Task ${input.taskId}; found ${candidates.length}.`
    );
  }

  const gap = await getOutputGapOrThrow(candidate.gapId);
  await assertTaskGapMatch(task, gap);
  if (task.status !== "done") {
    throw new Error("Task must be done before creating an OutputGap backfill draft.");
  }
  if (!isResolvableGap(gap)) {
    throw new Error(`OutputGap cannot be backfilled from Task in status: ${gap.status}`);
  }

  const timestamp = nowIso();
  const proposedResolutionNote =
    safeText(
      input.proposedResolutionNote ??
        task.resultNote ??
        `Resolved after Task completion: ${task.title}`,
      600
    ) || undefined;
  return {
    id: draftId({ task, gap, proposedResolutionNote }),
    kind: "taskCompletionResolved",
    status: "draft",
    taskId: task.id,
    gapId: gap.id,
    projectId: gap.projectId,
    sourceGapStatus: gap.status,
    sourceTaskStatus: task.status,
    proposedGapStatus: "resolved",
    proposedResolutionNote,
    warnings: [...candidate.warnings],
    sourceBoundary: ["planningTask", "outputGap", ...sourceBoundaryFor(candidate)],
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function previewTaskCompletionOutputGapBackfill(
  draft: OutputGapBackfillDraft
): OutputGapBackfillPreview {
  if (draft.kind !== "taskCompletionResolved" || draft.status !== "draft") {
    throw new Error("Only task completion backfill drafts can be previewed.");
  }
  const changes = proposedChanges(draft);
  const previewHash = calculatePreviewHash(draft, changes);
  previewRegistry.set(draft.id, {
    previewHash,
    draftFingerprint: draftFingerprint(draft)
  });
  return {
    draftId: draft.id,
    kind: draft.kind,
    taskId: draft.taskId,
    gapId: draft.gapId,
    projectId: draft.projectId,
    status: "previewed",
    previewTitle: "Resolve OutputGap from completed Task",
    previewBody: [
      ...changes.map((change) => `- ${change.summary}`),
      "- No Task, RouteNode, ResultItem, Finding, OutputCandidate, or ResearchOutput will be created.",
      "- No AI call or file content read will run."
    ].join("\n"),
    proposedChanges: changes,
    warnings: [...draft.warnings],
    sourceBoundary: [...draft.sourceBoundary],
    canApply: draft.sourceTaskStatus === "done",
    previewHash
  };
}

export function confirmOutputGapBackfillPreview(
  preview: OutputGapBackfillPreview
): OutputGapBackfillConfirmation {
  if (!preview.canApply) {
    throw new Error("OutputGap backfill preview cannot be confirmed.");
  }
  const registered = previewRegistry.get(preview.draftId);
  if (!registered || registered.previewHash !== preview.previewHash) {
    throw new Error("OutputGap backfill preview is missing or stale.");
  }
  return {
    draftId: preview.draftId,
    confirmedByUser: true,
    confirmedAt: nowIso(),
    previewHash: preview.previewHash
  };
}

function validateBackfillConfirmation({
  draft,
  confirmation
}: ApplyOutputGapBackfillDraftInput) {
  if (
    confirmation.confirmedByUser !== true ||
    confirmation.draftId !== draft.id ||
    !Number.isFinite(Date.parse(confirmation.confirmedAt))
  ) {
    throw new Error("A valid OutputGap backfill confirmation object is required.");
  }
  const registered = previewRegistry.get(draft.id);
  const expectedHash = calculatePreviewHash(draft, proposedChanges(draft));
  if (
    !registered ||
    registered.draftFingerprint !== draftFingerprint(draft) ||
    registered.previewHash !== expectedHash ||
    confirmation.previewHash !== expectedHash
  ) {
    throw new Error("OutputGap backfill previewHash mismatch or preview was not registered.");
  }
}

async function ensureBackfillEntityLink(gapId: EntityId, taskId: EntityId) {
  const link = await entityLinkService.ensureEntityLink({
    sourceType: "outputGap",
    sourceId: gapId,
    targetType: "task",
    targetId: taskId,
    relationType: "needs_followup_task",
    description: "OutputGap was resolved after the linked Task was completed."
  });
  return link.id;
}

function backfillCustomFields(gap: OutputGap, task: Task, draft: OutputGapBackfillDraft): CustomField[] {
  const fields = (gap.customFields ?? []).filter(
    (field) => !field.id.startsWith("output-gap-backfill-")
  );
  const timestamp = nowIso();
  return [
    ...fields,
    {
      id: "output-gap-backfill-kind",
      name: "backfillKind",
      value: draft.kind,
      valueType: "text",
      group: "outputGapBackfill"
    },
    {
      id: "output-gap-backfill-task-id",
      name: "backfillTaskId",
      value: task.id,
      valueType: "text",
      group: "outputGapBackfill"
    },
    {
      id: "output-gap-backfill-note",
      name: "resolutionNote",
      value: draft.proposedResolutionNote ?? "",
      valueType: "text",
      group: "outputGapBackfill"
    },
    {
      id: "output-gap-backfill-applied-at",
      name: "backfillAppliedAt",
      value: timestamp,
      valueType: "date",
      group: "outputGapBackfill"
    }
  ];
}

export async function applyTaskCompletionOutputGapBackfill(
  input: ApplyOutputGapBackfillDraftInput
): Promise<OutputGapBackfillApplyResult> {
  validateBackfillConfirmation(input);
  const existing = appliedBackfillResults.get(input.draft.id);
  if (existing) {
    return {
      ...existing,
      duplicate: true,
      warnings: [
        ...existing.warnings,
        "Duplicate backfill apply was ignored; existing result returned."
      ]
    };
  }

  const task = await getTaskOrThrow(input.draft.taskId);
  const gap = await getOutputGapOrThrow(input.draft.gapId);
  if (task.status !== "done") {
    throw new Error("Task must be done before OutputGap backfill apply.");
  }
  if (gap.status === "resolved") {
    throw new Error("OutputGap is already resolved.");
  }
  if (gap.status === "abandoned") {
    throw new Error("Abandoned OutputGap cannot be backfilled from Task.");
  }
  if (gap.status !== input.draft.sourceGapStatus || task.status !== input.draft.sourceTaskStatus) {
    throw new Error("Task or OutputGap changed after preview; create and confirm a new draft.");
  }
  await assertTaskGapMatch(task, gap);

  const verifiedEntityLinkIds = [await ensureBackfillEntityLink(gap.id, task.id)];
  const updatedGap = await outputConversionService.updateOutputGap(gap.id, {
    status: "resolved",
    relatedTaskId: task.id,
    resolvedAt: nowIso(),
    customFields: backfillCustomFields(gap, task, input.draft)
  });
  if (!updatedGap) {
    throw new Error("OutputGap backfill write failed.");
  }

  const result: OutputGapBackfillApplyResult = {
    draftId: input.draft.id,
    taskId: task.id,
    gapId: gap.id,
    applied: true,
    duplicate: false,
    alreadyResolved: false,
    updatedGapStatus: "resolved",
    updatedGapId: updatedGap.id,
    verifiedEntityLinkIds,
    warnings: [...input.draft.warnings],
    sourceBoundary: [
      ...new Set<OutputGapBackfillSource>([
        ...input.draft.sourceBoundary,
        "crossModuleEntityLink",
        "outputGapWriteback"
      ])
    ]
  };
  appliedBackfillResults.set(input.draft.id, result);
  return result;
}

export const outputGapBackfillService = {
  findOutputGapBackfillCandidatesForTask,
  createTaskCompletionOutputGapBackfillDraft,
  previewTaskCompletionOutputGapBackfill,
  confirmOutputGapBackfillPreview,
  applyTaskCompletionOutputGapBackfill
};

export type OutputGapBackfillService = typeof outputGapBackfillService;
