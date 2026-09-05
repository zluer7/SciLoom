import type { EntityId } from "../types/common";
import type {
  ApplyOutputGapFeedbackDraftInput,
  CreateOutputGapFeedbackDraftInput,
  OutputGapFeedbackApplyResult,
  OutputGapFeedbackConfirmation,
  OutputGapFeedbackDraft,
  OutputGapFeedbackKind,
  OutputGapFeedbackPreview,
  OutputGapFeedbackProposedChange,
  OutputGapFeedbackProposedPayload,
  OutputGapFeedbackSource,
  OutputGapRouteFeedbackDraftPayload,
  OutputGapTaskDraftPayload
} from "../types/outputGapConfirmation";
import type { OutputGap } from "../types/outputConversion";
import type { RouteNodeType, TaskType } from "../types/planning";
import { entityLinkService } from "./entityLinkService";
import { outputConversionService } from "./outputConversionService";
import { getOutputGapDetail } from "./outputFiveLayerSelectorService";
import { planningService } from "./planningService";

type PreviewRegistryEntry = {
  previewHash: string;
  draftFingerprint: string;
};

const previewRegistry = new Map<string, PreviewRegistryEntry>();
const appliedDraftResults = new Map<string, OutputGapFeedbackApplyResult>();

function nowIso() {
  return new Date().toISOString();
}

function redactPathLikeText(value: string) {
  return value
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s"'<>|]+/g, "[local path]")
    .replace(/file:\/\/\/?[^\s"'<>|]+/gi, "[local path]");
}

function safeText(value: unknown, maxLength = 1200) {
  const normalized = redactPathLikeText(String(value ?? "")).trim();
  if (!normalized) return "";
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 1)}…`
    : normalized;
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

function stableSerialize(value: unknown) {
  return JSON.stringify(stableValue(value));
}

function deterministicHash(value: unknown) {
  const text = stableSerialize(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function taskTypeForGap(gap: OutputGap): TaskType {
  switch (gap.gapType) {
    case "literature":
      return "reading";
    case "experiment":
      return "experiment";
    case "code":
      return "coding";
    case "writing":
      return "writing";
    case "analysis":
    case "data":
    case "validation":
    case "figure":
    case "theory":
      return "analysis";
    default:
      return "other";
  }
}

function routeNodeTypeForGap(gap: OutputGap): RouteNodeType {
  switch (gap.gapType) {
    case "literature":
      return "literature";
    case "experiment":
    case "validation":
    case "data":
      return "experiment";
    case "code":
      return "algorithm";
    case "writing":
      return "writing";
    case "figure":
      return "output";
    case "analysis":
    case "theory":
      return "analysis";
    default:
      return "other";
  }
}

function sourceCandidateId(gap: OutputGap, relations: Awaited<ReturnType<typeof getOutputGapDetail>>["relationSummary"]) {
  return relations.find(
    (relation) =>
      relation.relationType === "blocks" &&
      relation.sourceType === "outputGap" &&
      relation.sourceId === gap.id &&
      relation.targetType === "outputCandidate"
  )?.targetId;
}

function taskPayload(
  gap: OutputGap,
  candidateId: EntityId | undefined,
  input: CreateOutputGapFeedbackDraftInput
): OutputGapTaskDraftPayload {
  return {
    title: safeText(input.title ?? `补齐成果缺口：${gap.title}`, 240),
    description: safeText(
      input.description ??
        gap.description ??
        `由成果缺口 ${gap.id} 生成${candidateId ? `，用于补齐成果候选 ${candidateId}` : ""}。`
    ),
    taskType: taskTypeForGap(gap),
    status: "todo",
    priority: input.priority ?? gap.priority ?? "medium",
    dueDate: input.dueDate,
    routeNodeId: input.routeNodeId,
    timeBucket: "none",
    captureState: "pending",
    orderIndex: 0,
    customFields: {
      sourceOutputGapId: gap.id,
      ...(candidateId ? { sourceOutputCandidateId: candidateId } : {}),
      ...(input.note ? { sourceOutputGapNote: safeText(input.note, 500) } : {})
    }
  };
}

function routePayload(
  gap: OutputGap,
  candidateId: EntityId | undefined,
  input: CreateOutputGapFeedbackDraftInput
): OutputGapRouteFeedbackDraftPayload {
  return {
    title: safeText(input.title ?? `Resolve output gap: ${gap.title}`, 240),
    description: safeText(
      input.description ??
        [
          `Created from OutputGap ${gap.id}.`,
          candidateId ? `OutputCandidate: ${candidateId}.` : undefined,
          `Gap type: ${gap.gapType}.`,
          gap.description,
          input.note
        ]
          .filter(Boolean)
          .join("\n")
    ),
    nodeType: routeNodeTypeForGap(gap),
    status: "planned",
    parentNodeId: input.parentNodeId,
    orderIndex: 0,
    captureState: "pending",
    customFields: {
      sourceOutputGapId: gap.id,
      sourceOutputGapType: gap.gapType,
      ...(candidateId ? { sourceOutputCandidateId: candidateId } : {}),
      ...(input.note ? { sourceOutputGapNote: safeText(input.note, 500) } : {})
    }
  };
}

function draftIdentity(input: {
  gapId: EntityId;
  kind: OutputGapFeedbackKind;
  projectId: EntityId;
  sourceGapStatus: string;
  sourceGapUpdatedAt: string;
  proposedPayload: OutputGapFeedbackProposedPayload;
}) {
  return `output-gap-feedback:${input.kind}:${input.gapId}:${deterministicHash(input)}`;
}

function draftFingerprint(draft: OutputGapFeedbackDraft) {
  return deterministicHash({
    id: draft.id,
    gapId: draft.gapId,
    kind: draft.kind,
    projectId: draft.projectId,
    sourceGapStatus: draft.sourceGapStatus,
    sourceGapUpdatedAt: draft.sourceGapUpdatedAt,
    proposedPayload: draft.proposedPayload,
    sourceBoundary: draft.sourceBoundary
  });
}

function proposedChanges(draft: OutputGapFeedbackDraft): OutputGapFeedbackProposedChange[] {
  const planningType = draft.kind === "task" ? "task" : "routeNode";
  const status = draft.kind === "task" ? "task_created" : "route_feedback_created";
  const reference = draft.kind === "task" ? "relatedTaskId" : "relatedRouteNodeId";
  return [
    {
      targetType: planningType,
      operation: "create",
      summary: `Create ${planningType} "${safeText(draft.title, 240)}".`
    },
    {
      targetType: "entityLink",
      operation: "link",
      summary: `Create the cross-module OutputGap -> ${planningType} link.`
    },
    {
      targetType: "outputGap",
      operation: "update",
      summary: `Set ${reference} and update OutputGap status to ${status}; do not resolve the gap.`
    }
  ];
}

function calculatePreviewHash(
  draft: OutputGapFeedbackDraft,
  changes: OutputGapFeedbackProposedChange[]
) {
  return deterministicHash({
    draftFingerprint: draftFingerprint(draft),
    proposedChanges: changes
  });
}

function closedGap(gap: OutputGap) {
  return gap.status === "resolved" || gap.status === "abandoned";
}

export async function createOutputGapFeedbackDraft(
  input: CreateOutputGapFeedbackDraftInput
): Promise<OutputGapFeedbackDraft> {
  const detail = await getOutputGapDetail(input.gapId);
  if (!detail.entity || detail.boundary.missing) {
    throw new Error(`OutputGap not found: ${input.gapId}`);
  }
  const gap = detail.entity;
  if (closedGap(gap)) {
    throw new Error(`Closed OutputGap cannot create planning feedback: ${gap.status}`);
  }
  const candidateId = sourceCandidateId(gap, detail.relationSummary);
  const proposedPayload =
    input.kind === "task"
      ? taskPayload(gap, candidateId, input)
      : routePayload(gap, candidateId, input);
  const identity = {
    gapId: gap.id,
    kind: input.kind,
    projectId: gap.projectId,
    sourceGapStatus: gap.status,
    sourceGapUpdatedAt: gap.updatedAt,
    proposedPayload
  };
  const timestamp = nowIso();
  return {
    id: draftIdentity(identity),
    ...identity,
    status: "draft",
    title: proposedPayload.title,
    summary: proposedPayload.description,
    warnings: [...detail.boundary.warnings],
    sourceBoundary: ["outputGapDetail", "outputConversionRelations"],
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function createTaskDraftFromOutputGap(
  gapId: EntityId,
  input: Omit<CreateOutputGapFeedbackDraftInput, "gapId" | "kind"> = {}
) {
  return createOutputGapFeedbackDraft({ ...input, gapId, kind: "task" });
}

export function createRouteFeedbackDraftFromOutputGap(
  gapId: EntityId,
  input: Omit<CreateOutputGapFeedbackDraftInput, "gapId" | "kind"> = {}
) {
  return createOutputGapFeedbackDraft({ ...input, gapId, kind: "routeFeedback" });
}

export function previewOutputGapFeedbackDraft(
  draft: OutputGapFeedbackDraft
): OutputGapFeedbackPreview {
  if (draft.status !== "draft") {
    throw new Error(`Only draft feedback can be previewed: ${draft.status}`);
  }
  const changes = proposedChanges(draft);
  const previewHash = calculatePreviewHash(draft, changes);
  previewRegistry.set(draft.id, {
    previewHash,
    draftFingerprint: draftFingerprint(draft)
  });
  return {
    draftId: draft.id,
    gapId: draft.gapId,
    kind: draft.kind,
    projectId: draft.projectId,
    status: "previewed",
    previewTitle:
      draft.kind === "task"
        ? "Create Task from OutputGap"
        : "Create Route feedback from OutputGap",
    previewBody: [
      ...changes.map((change) => `- ${change.summary}`),
      "- OutputGap will not be resolved.",
      "- No Task will be completed.",
      "- No file content will be read."
    ].join("\n"),
    proposedChanges: changes,
    warnings: [...draft.warnings],
    sourceBoundary: [...draft.sourceBoundary],
    canApply: true,
    previewHash
  };
}

export function previewTaskDraftFromOutputGap(draft: OutputGapFeedbackDraft) {
  if (draft.kind !== "task") {
    throw new Error("Task preview requires a task feedback draft.");
  }
  return previewOutputGapFeedbackDraft(draft);
}

export function previewRouteFeedbackDraftFromOutputGap(draft: OutputGapFeedbackDraft) {
  if (draft.kind !== "routeFeedback") {
    throw new Error("Route preview requires a routeFeedback draft.");
  }
  return previewOutputGapFeedbackDraft(draft);
}

export function confirmOutputGapFeedbackPreview(
  preview: OutputGapFeedbackPreview
): OutputGapFeedbackConfirmation {
  if (!preview.canApply) {
    throw new Error("OutputGap feedback preview cannot be confirmed.");
  }
  const registered = previewRegistry.get(preview.draftId);
  if (!registered || registered.previewHash !== preview.previewHash) {
    throw new Error("OutputGap feedback preview is missing or stale.");
  }
  return {
    draftId: preview.draftId,
    confirmedByUser: true,
    confirmedAt: nowIso(),
    previewHash: preview.previewHash
  };
}

function validateConfirmation({
  draft,
  confirmation
}: ApplyOutputGapFeedbackDraftInput) {
  if (
    confirmation.confirmedByUser !== true ||
    confirmation.draftId !== draft.id ||
    !Number.isFinite(Date.parse(confirmation.confirmedAt))
  ) {
    throw new Error("A valid OutputGap feedback confirmation object is required.");
  }
  const registered = previewRegistry.get(draft.id);
  const expectedHash = calculatePreviewHash(draft, proposedChanges(draft));
  if (
    !registered ||
    registered.draftFingerprint !== draftFingerprint(draft) ||
    registered.previewHash !== expectedHash ||
    confirmation.previewHash !== expectedHash
  ) {
    throw new Error("OutputGap feedback previewHash mismatch or preview was not registered.");
  }
}

async function rejectExistingFeedback(gap: OutputGap, kind: OutputGapFeedbackKind) {
  const directId =
    kind === "task" ? gap.relatedTaskId : gap.relatedRouteNodeId;
  if (directId) {
    throw new Error(
      `OutputGap already has ${kind === "task" ? "relatedTaskId" : "relatedRouteNodeId"}: ${directId}`
    );
  }
  const links = await entityLinkService.queryLinksBySource("outputGap", gap.id);
  const targetType = kind === "task" ? "task" : "routeNode";
  if (links.some((link) => link.targetType === targetType)) {
    throw new Error(`OutputGap already has a ${targetType} EntityLink.`);
  }
}

async function applyTask(
  draft: OutputGapFeedbackDraft,
  gap: OutputGap
): Promise<OutputGapFeedbackApplyResult> {
  const payload = draft.proposedPayload as OutputGapTaskDraftPayload;
  const warnings: string[] = [];
  const sourceBoundary: OutputGapFeedbackSource[] = [
    ...draft.sourceBoundary,
    "planningTask"
  ];
  const task = await planningService.createTask({
    projectId: gap.projectId,
    title: payload.title,
    description: payload.description,
    taskType: payload.taskType,
    status: payload.status,
    priority: payload.priority,
    dueDate: payload.dueDate,
    routeNodeId: payload.routeNodeId,
    timeBucket: payload.timeBucket,
    captureState: payload.captureState,
    orderIndex: payload.orderIndex,
    customFields: payload.customFields
  });
  let linkId: EntityId | undefined;
  try {
    const link = await entityLinkService.ensureEntityLink({
      sourceType: "outputGap",
      sourceId: gap.id,
      targetType: "task",
      targetId: task.id,
      relationType: "needs_followup_task",
      description: "OutputGap generated a follow-up Task."
    });
    linkId = link.id;
    sourceBoundary.push("crossModuleEntityLink");
  } catch (error) {
    warnings.push(
      `Task was created, but EntityLink write failed: ${safeText(
        error instanceof Error ? error.message : error,
        300
      )}`
    );
  }
  let updatedGap: OutputGap | undefined;
  try {
    updatedGap = await outputConversionService.updateOutputGap(gap.id, {
      relatedTaskId: task.id,
      status: "task_created"
    });
  } catch (error) {
    warnings.push(
      `Task was created, but OutputGap task write-back failed: ${safeText(
        error instanceof Error ? error.message : error,
        300
      )}`
    );
  }
  sourceBoundary.push("outputGapWriteback");
  if (!updatedGap) {
    warnings.push("Task was created, but OutputGap task write-back failed.");
  }
  return {
    draftId: draft.id,
    gapId: gap.id,
    kind: "task",
    applied: Boolean(updatedGap && linkId),
    duplicate: false,
    createdTaskId: task.id,
    updatedGapStatus: updatedGap?.status,
    createdEntityLinkIds: linkId ? [linkId] : [],
    warnings,
    sourceBoundary
  };
}

async function applyRouteFeedback(
  draft: OutputGapFeedbackDraft,
  gap: OutputGap
): Promise<OutputGapFeedbackApplyResult> {
  const payload = draft.proposedPayload as OutputGapRouteFeedbackDraftPayload;
  const warnings: string[] = [];
  const sourceBoundary: OutputGapFeedbackSource[] = [
    ...draft.sourceBoundary,
    "planningRouteNode"
  ];
  const routeNode = await planningService.createRouteNode({
    projectId: gap.projectId,
    title: payload.title,
    description: payload.description,
    nodeType: payload.nodeType,
    status: payload.status,
    parentNodeId: payload.parentNodeId,
    orderIndex: payload.orderIndex,
    captureState: payload.captureState,
    customFields: payload.customFields
  });
  let linkId: EntityId | undefined;
  try {
    const link = await entityLinkService.ensureEntityLink({
      sourceType: "outputGap",
      sourceId: gap.id,
      targetType: "routeNode",
      targetId: routeNode.id,
      relationType: "produces",
      description: "OutputGap generated a RouteNode."
    });
    linkId = link.id;
    sourceBoundary.push("crossModuleEntityLink");
  } catch (error) {
    warnings.push(
      `RouteNode was created, but EntityLink write failed: ${safeText(
        error instanceof Error ? error.message : error,
        300
      )}`
    );
  }
  let updatedGap: OutputGap | undefined;
  try {
    updatedGap = await outputConversionService.updateOutputGap(gap.id, {
      relatedRouteNodeId: routeNode.id,
      status: "route_feedback_created"
    });
  } catch (error) {
    warnings.push(
      `RouteNode was created, but OutputGap route write-back failed: ${safeText(
        error instanceof Error ? error.message : error,
        300
      )}`
    );
  }
  sourceBoundary.push("outputGapWriteback");
  if (!updatedGap) {
    warnings.push("RouteNode was created, but OutputGap route write-back failed.");
  }
  return {
    draftId: draft.id,
    gapId: gap.id,
    kind: "routeFeedback",
    applied: Boolean(updatedGap && linkId),
    duplicate: false,
    createdRouteNodeId: routeNode.id,
    updatedGapStatus: updatedGap?.status,
    createdEntityLinkIds: linkId ? [linkId] : [],
    warnings,
    sourceBoundary
  };
}

export async function applyOutputGapFeedbackDraft(
  input: ApplyOutputGapFeedbackDraftInput
): Promise<OutputGapFeedbackApplyResult> {
  validateConfirmation(input);
  const existingResult = appliedDraftResults.get(input.draft.id);
  if (existingResult) {
    return {
      ...existingResult,
      duplicate: true,
      warnings: [
        ...existingResult.warnings,
        "Duplicate apply was ignored; the existing apply result was returned."
      ]
    };
  }
  const detail = await getOutputGapDetail(input.draft.gapId);
  if (!detail.entity || detail.boundary.missing) {
    throw new Error(`OutputGap not found: ${input.draft.gapId}`);
  }
  const gap = detail.entity;
  if (
    gap.projectId !== input.draft.projectId ||
    gap.status !== input.draft.sourceGapStatus ||
    gap.updatedAt !== input.draft.sourceGapUpdatedAt
  ) {
    throw new Error("OutputGap changed after preview; create and confirm a new draft.");
  }
  if (closedGap(gap)) {
    throw new Error(`Closed OutputGap cannot apply planning feedback: ${gap.status}`);
  }
  await rejectExistingFeedback(gap, input.draft.kind);
  const result =
    input.draft.kind === "task"
      ? await applyTask(input.draft, gap)
      : await applyRouteFeedback(input.draft, gap);
  appliedDraftResults.set(input.draft.id, result);
  return result;
}

export function applyTaskDraftFromOutputGap(input: ApplyOutputGapFeedbackDraftInput) {
  if (input.draft.kind !== "task") {
    throw new Error("Task apply requires a task feedback draft.");
  }
  return applyOutputGapFeedbackDraft(input);
}

export function applyRouteFeedbackDraftFromOutputGap(
  input: ApplyOutputGapFeedbackDraftInput
) {
  if (input.draft.kind !== "routeFeedback") {
    throw new Error("Route apply requires a routeFeedback draft.");
  }
  return applyOutputGapFeedbackDraft(input);
}

export const outputGapConfirmationService = {
  createOutputGapFeedbackDraft,
  createTaskDraftFromOutputGap,
  createRouteFeedbackDraftFromOutputGap,
  previewOutputGapFeedbackDraft,
  previewTaskDraftFromOutputGap,
  previewRouteFeedbackDraftFromOutputGap,
  confirmOutputGapFeedbackPreview,
  applyOutputGapFeedbackDraft,
  applyTaskDraftFromOutputGap,
  applyRouteFeedbackDraftFromOutputGap
};

export type OutputGapConfirmationService = typeof outputGapConfirmationService;
