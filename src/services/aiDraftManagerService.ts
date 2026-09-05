import type {
  AIActionDraftApplyResult,
  AIActionDraftApplyStatus,
  AIActionDraftEntityRef,
  AIActionDraftFieldChange,
  AIActionDraftPayload,
  AIActionDraftRelationPreview,
  AIActionDraftTarget,
  AIActionDraftTargetEntityType,
  AIActionDraftTargetModule,
  AIActionDraftType,
  AIActionDraftUnion,
  AIActionDraftWritePreview,
  DraftInstanceId
} from "../types/aiDraft";
import type { AIParsedActionDraftBatch } from "./aiDraftParserService";

export interface AIActionDraftEditInput {
  title?: string;
  summary?: string;
  detail?: string;
  proposedPayload?: AIActionDraftPayload;
}

export interface AIActionDraftManagerSnapshot {
  batches: AIParsedActionDraftBatch[];
  drafts: AIActionDraftUnion[];
}

export interface AIActionDraftManager {
  addBatch(batch: AIParsedActionDraftBatch): AIParsedActionDraftBatch;
  replaceBatch(batch: AIParsedActionDraftBatch): AIParsedActionDraftBatch;
  listBatches(): AIParsedActionDraftBatch[];
  getBatch(batchId: string): AIParsedActionDraftBatch | undefined;
  listDrafts(batchId?: string): AIActionDraftUnion[];
  getDraft(draftInstanceId: DraftInstanceId): AIActionDraftUnion | undefined;
  updateDraft(draft: AIActionDraftUnion): AIActionDraftUnion;
  acceptDraft(draftInstanceId: DraftInstanceId, now?: string): AIActionDraftUnion | undefined;
  editDraft(draftInstanceId: DraftInstanceId, input: AIActionDraftEditInput, now?: string): AIActionDraftUnion | undefined;
  rejectDraft(draftInstanceId: DraftInstanceId, reason?: string, now?: string): AIActionDraftUnion | undefined;
  markDraftWritten(
    draftInstanceId: DraftInstanceId,
    applyResult?: Partial<AIActionDraftApplyResult>,
    now?: string
  ): AIActionDraftUnion | undefined;
  markDraftFailed(draftInstanceId: DraftInstanceId, errorMessage: string, now?: string): AIActionDraftUnion | undefined;
  snapshot(): AIActionDraftManagerSnapshot;
  clear(): void;
}

const MODULE_ORDER: Record<AIActionDraftTargetModule, number> = {
  project: 0,
  route: 1,
  task: 2,
  review: 3,
  output: 4,
  literature: 5,
  link: 6,
  planning: 7,
  experiment: 8,
  ai: 9,
  unknown: 10
};

const WRITE_ENABLED_DRAFT_CAPABILITIES = {
  task_create: "supported",
  review_candidate: "planned",
  output_gap_create: "planned",
  finding_create: "planned",
  output_candidate_create: "planned",
  entity_link_create: "planned"
} as const;

function nowIso(now?: string): string {
  return now ?? new Date().toISOString();
}

function payloadRecord(draft: AIActionDraftUnion): Record<string, unknown> {
  return draft.proposedPayload as Record<string, unknown>;
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function missingWriteRequiredField(draft: AIActionDraftUnion): string | undefined {
  if (draft.draftType !== "task_create") return undefined;
  const payload = payloadRecord(draft);
  if (!textValue(payload.projectId)) return "projectId";
  if (!textValue(payload.title)) return "title";
  return undefined;
}

function isWriteEnabledDraft(draft: AIActionDraftUnion): boolean {
  return (
    WRITE_ENABLED_DRAFT_CAPABILITIES[
      draft.draftType as keyof typeof WRITE_ENABLED_DRAFT_CAPABILITIES
    ] === draft.capability
  );
}

function summarizeValue(value: unknown): string {
  if (value === undefined || value === null) return "Not provided";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "Empty list";
  if (typeof value === "object") return "Structured value";
  return String(value);
}

function entityRef(
  module: AIActionDraftTargetModule,
  entityType: AIActionDraftTargetEntityType,
  entityId?: string,
  label?: string
): AIActionDraftEntityRef {
  return { module, entityType, entityId, label };
}

function previewTarget(draft: AIActionDraftUnion): AIActionDraftTarget {
  return (
    draft.target ?? {
      module: draft.targetModule,
      entityType: draft.targetEntityType,
      entityId: draft.targetEntityId,
      label: draft.title
    }
  );
}

function targetLabel(draft: AIActionDraftUnion): string {
  const target = previewTarget(draft);
  return target.label ?? draft.title ?? `${target.module}/${target.entityType}`;
}

function operationForDraft(draftType: AIActionDraftType): "create" | "append" | "update" | "link" | "none" {
  if (
    draftType === "task_create" ||
    draftType === "output_gap_create" ||
    draftType === "finding_create" ||
    draftType === "output_candidate_create" ||
    draftType === "formal_output_create" ||
    draftType === "finding_verified_create"
  ) {
    return "create";
  }
  if (draftType === "review_candidate") return "create";
  if (draftType === "entity_link_create" || draftType === "literature_link_create" || draftType === "bulk_link_create") {
    return "link";
  }
  if (draftType.endsWith("_update") || draftType === "output_gap_close" || draftType === "task_update" || draftType === "route_update") {
    return "update";
  }
  return "none";
}

function labelForField(field: string): string {
  const labels: Record<string, string> = {
    projectId: "Project",
    routeNodeId: "Route node",
    taskId: "Task",
    reviewId: "Review",
    title: "Title",
    description: "Description",
    summary: "Summary",
    detail: "Detail",
    priority: "Priority",
    status: "Status",
    taskType: "Task type",
    scheduledDate: "Scheduled date",
    dueDate: "Due date",
    tags: "Tags",
    sourceId: "Source",
    targetId: "Target",
    relationType: "Relation type",
    literatureId: "Literature"
  };
  return labels[field] ?? field;
}

function createFieldChanges(draft: AIActionDraftUnion): AIActionDraftFieldChange[] {
  const operation = operationForDraft(draft.draftType);
  const skipped = new Set(["sourceRefs", "reason", "deferredReason"]);
  return Object.entries(payloadRecord(draft))
    .filter(([field, value]) => !skipped.has(field) && value !== undefined)
    .map(([field, value]) => ({
      field,
      label: labelForField(field),
      currentValueSummary: operation === "create" || operation === "link" ? undefined : "Existing value will be reread before write-back.",
      proposedValueSummary: summarizeValue(value),
      operation
    }));
}

function relationPreview(draft: AIActionDraftUnion): AIActionDraftRelationPreview[] {
  const payload = payloadRecord(draft);
  if (draft.draftType === "entity_link_create") {
    return [
      {
        source: entityRef("unknown", String(payload.sourceType ?? "unknown") as AIActionDraftTargetEntityType, textValue(payload.sourceId)),
        target: entityRef("unknown", String(payload.targetType ?? "unknown") as AIActionDraftTargetEntityType, textValue(payload.targetId)),
        relationType: textValue(payload.relationType),
        summary: "EntityLink suggestion only; it is not created in AI-D2."
      }
    ];
  }
  if (draft.draftType === "literature_link_create") {
    return [
      {
        source: entityRef("literature", "literature", textValue(payload.literatureId), "Literature"),
        target: entityRef("unknown", String(payload.targetType ?? "unknown") as AIActionDraftTargetEntityType, textValue(payload.targetId)),
        relationType: textValue(payload.relationType),
        summary: "LiteratureLink suggestion only; it is not created in AI-D2."
      }
    ];
  }
  return [];
}

function willCreateForDraft(draft: AIActionDraftUnion): AIActionDraftEntityRef[] {
  const operation = operationForDraft(draft.draftType);
  if (operation !== "create") return [];
  return [entityRef(draft.targetModule, draft.targetEntityType, undefined, draft.title)];
}

function willUpdateForDraft(draft: AIActionDraftUnion): AIActionDraftEntityRef[] {
  const operation = operationForDraft(draft.draftType);
  if (operation !== "append" && operation !== "update") return [];
  return [entityRef(draft.targetModule, draft.targetEntityType, draft.targetEntityId, targetLabel(draft))];
}

function previewWarnings(draft: AIActionDraftUnion): string[] {
  const warnings = [
    "Generating this local preview does not call business services.",
    "No repository, SQLite, localStorage, schema, or EntityLink write is performed by the preview.",
    "Write-back must be explicitly confirmed by the user and routed through an allowed service."
  ];
  if (draft.capability === "planned" && !isWriteEnabledDraft(draft)) {
    warnings.push("This draft type is planned for a later AI-D stage and is not write-back enabled yet.");
  }
  if (draft.capability === "deferred") {
    warnings.push("This draft type is deferred and cannot be written by the current AI-D flow.");
  }
  if (draft.capability === "prohibited") {
    warnings.push("This draft type is prohibited for automatic execution.");
  }
  if (draft.sourceRefs.length === 0) {
    warnings.push("No sourceRefs were parsed; provenance must be reviewed before any future write-back.");
  }
  return warnings;
}

export function generateAIActionDraftWritePreview(draft: AIActionDraftUnion): AIActionDraftWritePreview {
  const operation = operationForDraft(draft.draftType);
  const actionLabel =
    operation === "create"
      ? `Create ${draft.targetEntityType}`
      : operation === "append"
        ? `Append to ${draft.targetEntityType}`
        : operation === "link"
          ? "Create relationship"
          : operation === "update"
            ? `Update ${draft.targetEntityType}`
            : "No write-back action";

  return {
    actionLabel,
    targetLabel: targetLabel(draft),
    target: previewTarget(draft),
    fieldChanges: createFieldChanges(draft),
    linkedEntities: relationPreview(draft),
    impactSummary:
      isWriteEnabledDraft(draft)
        ? "Local preview is ready; actual write-back still requires explicit user confirmation."
        : "Local preview only; this draft type is not write-back enabled.",
    willCreate: willCreateForDraft(draft),
    willUpdate: willUpdateForDraft(draft),
    willNotModify: [
      "Existing SciLoom business data",
      "Repository and selector state",
      "SQLite schema and persisted records",
      "localStorage or files",
      "EntityLink or LiteratureLink records",
      "Task completion status and OutputGap closure state"
    ],
    warnings: previewWarnings(draft),
    requiresUserConfirmation: true
  };
}

export function sortAIActionDrafts(drafts: AIActionDraftUnion[]): AIActionDraftUnion[] {
  return [...drafts].sort((left, right) => {
    const handledDiff = Number(left.handled) - Number(right.handled);
    if (handledDiff !== 0) return handledDiff;
    const moduleDiff = MODULE_ORDER[left.targetModule] - MODULE_ORDER[right.targetModule];
    if (moduleDiff !== 0) return moduleDiff;
    return left.createdAt.localeCompare(right.createdAt);
  });
}

export function acceptAIActionDraft(draft: AIActionDraftUnion, now?: string): AIActionDraftUnion {
  const updatedAt = nowIso(now);
  const writePreview = generateAIActionDraftWritePreview(draft);
  if (draft.capability === "deferred" || draft.capability === "prohibited") {
    return {
      ...draft,
      writePreview,
      result: {
        ...draft.result,
        reviewStatus: "pending",
        applyStatus: "none",
        message: "This draft cannot be accepted for write-back in AI-D2.",
        updatedAt
      },
      updatedAt
    } as AIActionDraftUnion;
  }
  const missingField = missingWriteRequiredField(draft);
  if (missingField) {
    return {
      ...draft,
      writePreview,
      handled: false,
      result: {
        ...draft.result,
        reviewStatus: "pending",
        applyStatus: "none",
        message: `This draft is missing required field ${missingField} and cannot enter a write-ready state.`,
        updatedAt
      },
      updatedAt
    } as AIActionDraftUnion;
  }

  return {
    ...draft,
    writePreview,
    handled: false,
    result: {
      ...draft.result,
      reviewStatus: "accepted",
      applyStatus: isWriteEnabledDraft(draft) ? "ready" : "none",
      message:
        isWriteEnabledDraft(draft)
          ? "Accepted locally. The executor must still require explicit user confirmation before service write-back."
          : "Accepted locally for review only; write-back is not enabled for this draft type.",
      updatedAt
    },
    updatedAt
  } as AIActionDraftUnion;
}

export function editAIActionDraft(
  draft: AIActionDraftUnion,
  input: AIActionDraftEditInput,
  now?: string
): AIActionDraftUnion {
  const updatedAt = nowIso(now);
  return {
    ...draft,
    title: input.title ?? draft.title,
    summary: input.summary ?? draft.summary,
    detail: input.detail ?? draft.detail,
    proposedPayload: input.proposedPayload ?? draft.proposedPayload,
    writePreview: undefined,
    handled: false,
    result: {
      ...draft.result,
      reviewStatus: "edited",
      applyStatus: "none",
      message: "Draft edited locally. Preview should be regenerated before any future write-back.",
      updatedAt
    },
    updatedAt
  } as AIActionDraftUnion;
}

export function rejectAIActionDraft(
  draft: AIActionDraftUnion,
  reason?: string,
  now?: string
): AIActionDraftUnion {
  const updatedAt = nowIso(now);
  return {
    ...draft,
    handled: true,
    result: {
      ...draft.result,
      reviewStatus: "rejected",
      applyStatus: "none",
      message: reason?.trim() || "Draft rejected by user.",
      updatedAt
    },
    updatedAt
  } as AIActionDraftUnion;
}

export function markAIActionDraftWritten(
  draft: AIActionDraftUnion,
  applyResult: Partial<AIActionDraftApplyResult> = {},
  now?: string
): AIActionDraftUnion {
  const updatedAt = nowIso(now);
  const missingField = missingWriteRequiredField(draft);
  if (!isWriteEnabledDraft(draft) || draft.result.reviewStatus !== "accepted" || missingField) {
    const reason =
      !isWriteEnabledDraft(draft)
        ? "This draft type is not write-back enabled."
        : draft.result.reviewStatus !== "accepted"
          ? "This draft has not been accepted for write-back."
          : `This draft is missing required field ${missingField}.`;
    return {
      ...draft,
      handled: false,
      result: {
        ...draft.result,
        applyStatus: "none",
        message: `${reason} A written result was not recorded.`,
        updatedAt
      },
      updatedAt
    } as AIActionDraftUnion;
  }
  const resultStatus: AIActionDraftApplyStatus = applyResult.result ?? "written";
  return {
    ...draft,
    handled: resultStatus === "written",
    result: {
      ...draft.result,
      reviewStatus: "accepted",
      applyStatus: resultStatus,
      message: applyResult.message ?? "Draft write result recorded locally.",
      applyResult: {
        success: applyResult.success ?? resultStatus === "written",
        result: resultStatus,
        message: applyResult.message,
        createdEntity: applyResult.createdEntity,
        updatedEntity: applyResult.updatedEntity,
        linkedEntities: applyResult.linkedEntities,
        errorCode: applyResult.errorCode,
        errorMessage: applyResult.errorMessage,
        partialSuccess: applyResult.partialSuccess,
        sourceDraftId: draft.draftInstanceId,
        appliedAt: applyResult.appliedAt ?? updatedAt
      },
      updatedAt
    },
    updatedAt
  } as AIActionDraftUnion;
}

export function markAIActionDraftFailed(
  draft: AIActionDraftUnion,
  errorMessage: string,
  now?: string
): AIActionDraftUnion {
  const updatedAt = nowIso(now);
  return {
    ...draft,
    handled: false,
    result: {
      ...draft.result,
      reviewStatus: "accepted",
      applyStatus: "failed",
      message: errorMessage,
      applyResult: {
        success: false,
        result: "failed",
        errorMessage,
        sourceDraftId: draft.draftInstanceId,
        appliedAt: updatedAt
      },
      updatedAt
    },
    updatedAt
  } as AIActionDraftUnion;
}

function replaceDraftInBatch(
  batch: AIParsedActionDraftBatch,
  draft: AIActionDraftUnion
): AIParsedActionDraftBatch {
  return {
    ...batch,
    drafts: batch.drafts.map((item) => (
      item.draftInstanceId === draft.draftInstanceId ? draft : item
    ))
  };
}

export function createAIActionDraftManager(
  initialBatches: AIParsedActionDraftBatch[] = []
): AIActionDraftManager {
  const batches = new Map<string, AIParsedActionDraftBatch>();
  for (const batch of initialBatches) {
    batches.set(batch.id, { ...batch, drafts: sortAIActionDrafts(batch.drafts) });
  }

  function listBatches(): AIParsedActionDraftBatch[] {
    return [...batches.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  function updateDraft(draft: AIActionDraftUnion): AIActionDraftUnion {
    if (!draft.batchId) return draft;
    const batch = batches.get(draft.batchId);
    if (!batch) return draft;
    batches.set(draft.batchId, replaceDraftInBatch(batch, draft));
    return draft;
  }

  function getDraft(draftInstanceId: DraftInstanceId): AIActionDraftUnion | undefined {
    return listBatches()
      .flatMap((batch) => batch.drafts)
      .find((draft) => draft.draftInstanceId === draftInstanceId);
  }

  return {
    addBatch(batch) {
      const sorted = { ...batch, drafts: sortAIActionDrafts(batch.drafts) };
      batches.set(sorted.id, sorted);
      return sorted;
    },
    replaceBatch(batch) {
      const sorted = { ...batch, drafts: sortAIActionDrafts(batch.drafts) };
      batches.set(sorted.id, sorted);
      return sorted;
    },
    listBatches,
    getBatch(batchId) {
      return batches.get(batchId);
    },
    listDrafts(batchId) {
      const source = batchId ? batches.get(batchId)?.drafts ?? [] : listBatches().flatMap((batch) => batch.drafts);
      return sortAIActionDrafts(source);
    },
    getDraft,
    updateDraft,
    acceptDraft(draftInstanceId, now) {
      const draft = getDraft(draftInstanceId);
      return draft ? updateDraft(acceptAIActionDraft(draft, now)) : undefined;
    },
    editDraft(draftInstanceId, input, now) {
      const draft = getDraft(draftInstanceId);
      return draft ? updateDraft(editAIActionDraft(draft, input, now)) : undefined;
    },
    rejectDraft(draftInstanceId, reason, now) {
      const draft = getDraft(draftInstanceId);
      return draft ? updateDraft(rejectAIActionDraft(draft, reason, now)) : undefined;
    },
    markDraftWritten(draftInstanceId, applyResult, now) {
      const draft = getDraft(draftInstanceId);
      return draft ? updateDraft(markAIActionDraftWritten(draft, applyResult, now)) : undefined;
    },
    markDraftFailed(draftInstanceId, errorMessage, now) {
      const draft = getDraft(draftInstanceId);
      return draft ? updateDraft(markAIActionDraftFailed(draft, errorMessage, now)) : undefined;
    },
    snapshot() {
      const batchList = listBatches();
      return {
        batches: batchList,
        drafts: sortAIActionDrafts(batchList.flatMap((batch) => batch.drafts))
      };
    },
    clear() {
      batches.clear();
    }
  };
}
