import { operationLogRepositoryConfig } from "../repositories/entityConfig";
import { createRepository } from "../repositories/repositoryFactory";
import type {
  OperationFeedbackSummary,
  OperationImpactSummary,
  OperationLogEntry,
  OperationLogInput,
  OperationLogQuery
} from "../types/operationLog";
import type { OperationImpactPreview } from "../types/operationSafety";
import type { WriteFeedbackResult } from "../types/writeFeedback";
import type { RefreshKey } from "../types/writeFeedback";
import {
  addWriteFeedbackWarning,
  createSuccessWriteFeedback,
  createWriteFeedbackResult
} from "./writeFeedbackService";
import { publishWriteFeedbackRefresh } from "./refreshEventService";

const OPERATION_LOG_SCHEMA_VERSION = 1;

const operationLogRepository = createRepository<OperationLogEntry>(
  operationLogRepositoryConfig
);

function createId(prefix: string) {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function firstMessage(feedback: WriteFeedbackResult) {
  return feedback.messages.find((message) => message.message)?.message;
}

export function summarizeImpactPreviewForOperationLog(
  preview?: OperationImpactPreview
): OperationImpactSummary | undefined {
  if (!preview) {
    return undefined;
  }

  return {
    affectedEntityCount: preview.affectedEntityCount,
    affectedItems: preview.affectedItems,
    warnings: preview.warnings,
    blockingReasons: preview.blockingReasons,
    deepScanPerformed: preview.deepScanPerformed
  };
}

export function summarizeFeedbackForOperationLog(
  feedback: WriteFeedbackResult
): OperationFeedbackSummary {
  return {
    status: feedback.status,
    message: firstMessage(feedback),
    warnings: feedback.warnings,
    errors: feedback.errors,
    skipped: feedback.skipped,
    affectedEntities: feedback.affectedEntities,
    refreshKeys: feedback.refreshKeys
  };
}

export function createOperationLogEntry(input: OperationLogInput): OperationLogEntry {
  const timestamp = input.createdAt ?? new Date().toISOString();
  return {
    ...input,
    id: input.id ?? createId("operation-log"),
    relatedEntities: input.relatedEntities ?? [],
    warnings: input.warnings ?? input.feedback?.warnings ?? [],
    errors: input.errors ?? input.feedback?.errors ?? [],
    skipped: input.skipped ?? input.feedback?.skipped ?? [],
    actorId: input.actorId ?? "local_user",
    actorLabel: input.actorLabel ?? "Local user",
    refreshKeys: [
      ...new Set<RefreshKey>([...(input.refreshKeys ?? []), "operationLog.changed"])
    ],
    schemaVersion: input.schemaVersion ?? OPERATION_LOG_SCHEMA_VERSION,
    createdAt: timestamp,
    updatedAt: input.updatedAt ?? timestamp,
    deletedAt: null
  };
}

function matchesQuery(entry: OperationLogEntry, query: OperationLogQuery = {}) {
  if (query.module && entry.module !== query.module) return false;
  if (query.source && entry.source !== query.source) return false;
  if (query.status && entry.status !== query.status) return false;
  if (query.riskLevel && entry.riskLevel !== query.riskLevel) return false;
  if (query.operationType && entry.operationType !== query.operationType) return false;
  if (query.entityType && entry.target.entityType !== query.entityType) return false;
  if (query.entityId && entry.target.entityId !== query.entityId) return false;
  if (query.from && entry.createdAt < query.from) return false;
  if (query.to && entry.createdAt > query.to) return false;
  return true;
}

export async function listOperationLogs(
  query: OperationLogQuery = {}
): Promise<OperationLogEntry[]> {
  const logs = await operationLogRepository.list();
  const filtered = logs
    .filter((entry) => matchesQuery(entry, query))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return typeof query.limit === "number" ? filtered.slice(0, query.limit) : filtered;
}

export async function getOperationLog(id: string) {
  return operationLogRepository.getById(id);
}

export async function createOperationLog(
  input: OperationLogInput
): Promise<WriteFeedbackResult<OperationLogEntry>> {
  const entry = createOperationLogEntry(input);
  const {
    id: _id,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    deletedAt: _deletedAt,
    ...createInput
  } = entry;
  const created = await operationLogRepository.create(createInput, {
    id: entry.id,
    createdAt: entry.createdAt
  });
  const feedback = createSuccessWriteFeedback<OperationLogEntry>({
    operation: "operationLog.create",
    data: created,
    affectedEntities: [
      {
        type: "operationLog",
        id: created.id,
        relation: "created",
        label: created.summary
      }
    ],
    refreshKeys: ["operationLog.changed"],
    messages: [
      {
        severity: "success",
        message: "Operation log recorded."
      }
    ]
  });
  publishWriteFeedbackRefresh(feedback, {
    source: "service.write",
    reason: "operation log changed"
  });
  return feedback;
}

export async function updateOperationLog(
  id: string,
  input: Partial<OperationLogInput>
) {
  const updated = await operationLogRepository.update(id, input);
  if (!updated) {
    throw new Error("OPERATION_LOG_NOT_FOUND");
  }
  return updated;
}

export async function appendOperationLogFromFeedback<T>(
  feedback: WriteFeedbackResult<T>,
  input: Omit<OperationLogInput, "status" | "feedback">
): Promise<WriteFeedbackResult<T>> {
  try {
    await createOperationLog({
      ...input,
      status: feedback.status,
      feedback: summarizeFeedbackForOperationLog(feedback),
      warnings: feedback.warnings,
      errors: feedback.errors,
      skipped: feedback.skipped
    });
    return feedback;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return addWriteFeedbackWarning(
      feedback,
      `Operation log write failed: ${message}`,
      "operation_log_write_failed"
    );
  }
}

export function createOperationLogWriteFailureFeedback(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return createWriteFeedbackResult({
    status: "partial",
    operation: "operationLog.create",
    warnings: [`Operation log write failed: ${message}`],
    messages: [
      {
        severity: "warning",
        code: "operation_log_write_failed",
        message: `Operation log write failed: ${message}`
      }
    ],
    refreshKeys: []
  });
}

export const operationLogService = {
  listOperationLogs,
  getOperationLog,
  createOperationLog,
  updateOperationLog,
  appendOperationLogFromFeedback,
  createOperationLogEntry,
  summarizeImpactPreviewForOperationLog,
  summarizeFeedbackForOperationLog
};
