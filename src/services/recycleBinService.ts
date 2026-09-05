import {
  experimentRepositoryConfig,
  experimentRunRepositoryConfig,
  findingRepositoryConfig,
  literatureLinkRepositoryConfig,
  literatureRepositoryConfig,
  outputCandidateRepositoryConfig,
  outputGapRepositoryConfig,
  outputRepositoryConfig,
  recycleEntryRepositoryConfig,
  resultItemRepositoryConfig,
  resultMetricRepositoryConfig
} from "../repositories/entityConfig";
import { createRepository } from "../repositories/repositoryFactory";
import { fileRefRepository } from "../repositories/fileRefRepository";
import type { Repository } from "../repositories/types";
import type { AuditableEntity, EntityId } from "../types/common";
import type {
  DeletedEntitySummary,
  PermanentlyDeleteEntityInput,
  RecycleEntityModule,
  RecycleEntry,
  RecycleEntryInput,
  RecycleQuery,
  RestoreDeletedEntityInput
} from "../types/recycleBin";
import type { RefreshKey } from "../types/writeFeedback";
import {
  addWriteFeedbackWarning,
  createSkippedWriteFeedback,
  createSuccessWriteFeedback
} from "./writeFeedbackService";
import { publishWriteFeedbackRefresh } from "./refreshEventService";
import { createOperationLog } from "./operationLogService";
import { assertExperimentRunWritable } from "./experimentRunGuard";
import {
  restoreExperimentMetadata,
  restoreExperimentRunMetadata
} from "./experimentRunLifecycleService";
import { resolveMountedManuscriptLifecycleDecision } from "./fileRefOwnerValidator";
import { sharedManuscriptSessionRuntime } from "./sharedManuscriptSessionComposition";

const RECYCLE_ENTRY_SCHEMA_VERSION = 1;

type DeletedEntity = AuditableEntity & Record<string, unknown>;

interface RestoreAdapter {
  entityType: string;
  module: RecycleEntityModule;
  repository: Repository<DeletedEntity>;
  refreshKeys: RefreshKey[];
  title: (entity: DeletedEntity) => string;
  summary?: (entity: DeletedEntity) => string | undefined;
  assertWritable?: (entity: DeletedEntity) => Promise<void>;
  restore?: (entity: DeletedEntity) => Promise<{
    entity?: DeletedEntity;
    operationLogId?: EntityId;
    warnings?: string[];
  }>;
}

const recycleEntryRepository = createRepository<RecycleEntry>(recycleEntryRepositoryConfig);

function asDeletedEntityRepository<T extends AuditableEntity>(
  repository: Repository<T>
): Repository<DeletedEntity> {
  return repository as unknown as Repository<DeletedEntity>;
}

const experimentRestoreRepository = asDeletedEntityRepository(
  createRepository(experimentRepositoryConfig)
);
const experimentRunRestoreRepository = asDeletedEntityRepository(
  createRepository(experimentRunRepositoryConfig)
);
const literatureRestoreRepository = asDeletedEntityRepository(
  createRepository(literatureRepositoryConfig)
);

const restoreAdapters: RestoreAdapter[] = [
  {
    entityType: "experiment",
    module: "experiment",
    repository: experimentRestoreRepository,
    refreshKeys: ["experiment.changed"],
    title: titleFrom("title", "experimentName"),
    restore: async (entity) => {
      const result = await restoreExperimentMetadata(entity.id);
      if (result.status === "error") {
        throw new Error(`${result.error.code}: ${result.error.message}`);
      }
      return {
        entity: await experimentRestoreRepository.getById(entity.id),
        operationLogId: result.operationLogId,
        warnings: result.warnings
      };
    }
  },
  {
    entityType: "experimentRun",
    module: "experiment",
    repository: experimentRunRestoreRepository,
    refreshKeys: ["experimentRun.changed", "experiment.changed"],
    title: titleFrom("title", "runLabel"),
    restore: async (entity) => {
      const result = await restoreExperimentRunMetadata(entity.id);
      if (result.status === "error") {
        throw new Error(`${result.error.code}: ${result.error.message}`);
      }
      return {
        entity: await experimentRunRestoreRepository.getById(entity.id),
        operationLogId: result.operationLogId,
        warnings: result.warnings
      };
    }
  },
  {
    entityType: "resultMetric",
    module: "experiment",
    repository: asDeletedEntityRepository(createRepository(resultMetricRepositoryConfig)),
    refreshKeys: ["resultMetric.changed", "experiment.changed"],
    title: titleFrom("name", "title"),
    assertWritable: async (entity) => {
      if (typeof entity.runId === "string") {
        await assertExperimentRunWritable(entity.runId);
      }
    }
  },
  {
    entityType: "fileRef",
    module: "experiment",
    repository: asDeletedEntityRepository(fileRefRepository),
    refreshKeys: ["fileRef.changed", "experiment.changed"],
    title: titleFrom("title", "path"),
    assertWritable: async (entity) => {
      if (entity.ownerType === "experimentRun" && typeof entity.ownerId === "string") {
        await assertExperimentRunWritable(entity.ownerId);
      }
    }
  },
  {
    entityType: "literature",
    module: "literature",
    repository: literatureRestoreRepository,
    refreshKeys: ["literature.changed"],
    title: titleFrom("title"),
    restore: async (entity) => {
      const decisions = await Promise.all([
        resolveMountedManuscriptLifecycleDecision({
          ownerType: "literature",
          ownerId: entity.id,
          manuscriptChannel: "literature_outline"
        }),
        resolveMountedManuscriptLifecycleDecision({
          ownerType: "literature",
          ownerId: entity.id,
          manuscriptChannel: "dedicated_notes"
        })
      ]);
      if (decisions.some((decision) => !decision.canRestore)) {
        throw new Error("LITERATURE_MANUSCRIPT_LIFECYCLE_RESTORE_DENIED");
      }
      const closed = await sharedManuscriptSessionRuntime.closeCleanSessions(
        (session) =>
          session.owner.ownerType === "literature" &&
          session.owner.ownerId === entity.id
      );
      if (!closed) {
        throw new Error("LITERATURE_MANUSCRIPT_SESSION_DIRTY");
      }
      const restored = await literatureRestoreRepository.restore(entity.id);
      if (!restored) return {};
      return { entity: restored };
    }
  },
  {
    entityType: "literatureLink",
    module: "literature",
    repository: asDeletedEntityRepository(createRepository(literatureLinkRepositoryConfig)),
    refreshKeys: ["literatureLink.changed", "literature.changed"],
    title: titleFrom("description", "targetType", "targetId")
  },
  {
    entityType: "resultItem",
    module: "outputConversion",
    repository: asDeletedEntityRepository(createRepository(resultItemRepositoryConfig)),
    refreshKeys: ["output.resultItem.changed"],
    title: titleFrom("title")
  },
  {
    entityType: "finding",
    module: "outputConversion",
    repository: asDeletedEntityRepository(createRepository(findingRepositoryConfig)),
    refreshKeys: ["output.finding.changed"],
    title: titleFrom("title")
  },
  {
    entityType: "outputCandidate",
    module: "outputConversion",
    repository: asDeletedEntityRepository(createRepository(outputCandidateRepositoryConfig)),
    refreshKeys: ["output.candidate.changed"],
    title: titleFrom("title")
  },
  {
    entityType: "outputGap",
    module: "outputConversion",
    repository: asDeletedEntityRepository(createRepository(outputGapRepositoryConfig)),
    refreshKeys: ["output.gap.changed"],
    title: titleFrom("title")
  },
  {
    entityType: "output",
    module: "output",
    repository: asDeletedEntityRepository(createRepository(outputRepositoryConfig)),
    refreshKeys: ["output.researchOutput.changed"],
    title: titleFrom("outputName", "title")
  }
];

const adapterByEntityType = new Map(
  restoreAdapters.map((adapter) => [adapter.entityType, adapter])
);

const OUTPUT_DELETE_SAFETY_ENTITY_TYPES = new Set([
  "resultItem",
  "finding",
  "outputCandidate",
  "outputGap",
  "output"
]);

function createId(prefix: string) {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function titleFrom(...fields: string[]) {
  return (entity: DeletedEntity) => {
    for (const field of fields) {
      const value = entity[field];
      if (typeof value === "string" && value.trim()) {
        return value;
      }
    }
    return entity.id;
  };
}

function summaryFrom(entity: DeletedEntity) {
  for (const field of ["summary", "description", "conclusion", "resultSummary"]) {
    const value = entity[field];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function defaultRecycleRefreshKeys(keys: RefreshKey[] = []) {
  return [...new Set<RefreshKey>([...keys, "recycleBin.changed"])];
}

export function createDeletedEntitySummary(
  input: Omit<DeletedEntitySummary, "refreshKeys"> & { refreshKeys?: RefreshKey[] }
): DeletedEntitySummary {
  return {
    ...input,
    refreshKeys: defaultRecycleRefreshKeys(input.refreshKeys)
  };
}

export function createRecycleEntry(input: RecycleEntryInput): RecycleEntry {
  const timestamp = input.createdAt ?? new Date().toISOString();
  return {
    ...input,
    id: input.id ?? createId("recycle-entry"),
    entityDeletedAt: input.deletedAt,
    restoreStatus: input.restoreStatus ?? "not_started",
    refreshKeys: defaultRecycleRefreshKeys(input.refreshKeys),
    schemaVersion: input.schemaVersion ?? RECYCLE_ENTRY_SCHEMA_VERSION,
    createdAt: timestamp,
    updatedAt: input.updatedAt ?? timestamp,
    deletedAt: null,
    revision: input.revision ?? 0
  };
}

function recycleEntryToSummary(entry: RecycleEntry): DeletedEntitySummary {
  return createDeletedEntitySummary({
    recycleEntryId: entry.id,
    entityType: entry.entityType,
    entityId: entry.entityId,
    title: entry.title,
    summary: entry.summary,
    module: entry.module,
    deletedAt: entry.entityDeletedAt,
    deletedBy: entry.deletedBy,
    operationLogId: entry.operationLogId,
    canRestore: entry.canRestore,
    cannotRestoreReason: entry.cannotRestoreReason,
    knownImpactSummary: entry.knownImpactSummary,
    restoreStatus: entry.restoreStatus,
    refreshKeys: entry.refreshKeys,
    createdByLifecycleActionId: entry.createdByLifecycleActionId,
    terminalLifecycleActionId: entry.terminalLifecycleActionId,
    revision: entry.revision
  });
}

function deletedEntityToSummary(adapter: RestoreAdapter, entity: DeletedEntity) {
  return createDeletedEntitySummary({
    entityType: adapter.entityType,
    entityId: entity.id,
    title: adapter.title(entity),
    summary: adapter.summary?.(entity) ?? summaryFrom(entity),
    module: adapter.module,
    deletedAt: entity.deletedAt ?? entity.updatedAt,
    canRestore: true,
    restoreStatus: "not_started",
    refreshKeys: adapter.refreshKeys
  });
}

function matchesRecycleQuery(item: DeletedEntitySummary, query: RecycleQuery = {}) {
  if (query.entityType && item.entityType !== query.entityType) return false;
  if (query.entityId && item.entityId !== query.entityId) return false;
  if (query.module && item.module !== query.module) return false;
  if (typeof query.canRestore === "boolean" && item.canRestore !== query.canRestore) {
    return false;
  }
  if (query.from && item.deletedAt < query.from) return false;
  if (query.to && item.deletedAt > query.to) return false;
  return true;
}

export async function recordRecycleEntry(input: RecycleEntryInput) {
  const entry = createRecycleEntry(input);
  const {
    id: _id,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    deletedAt: _deletedAt,
    ...createInput
  } = entry;
  return recycleEntryRepository.create(createInput);
}

export async function getRecycleEntry(id: EntityId) {
  return recycleEntryRepository.getById(id);
}

export async function getLatestRecycleEntryForEntity(
  entityType: string,
  entityId: EntityId
) {
  const entries = await recycleEntryRepository.list();
  return entries
    .filter((entry) => entry.entityType === entityType && entry.entityId === entityId)
    .sort((left, right) => right.entityDeletedAt.localeCompare(left.entityDeletedAt))[0];
}

export async function updateRecycleEntry(
  id: EntityId,
  patch: Partial<
    Pick<
      RecycleEntry,
      "canRestore" | "cannotRestoreReason" | "restoreStatus" | "operationLogId" | "summary"
    >
  >
) {
  return recycleEntryRepository.update(id, patch);
}

export async function updateLatestRecycleEntryForEntity(
  entityType: string,
  entityId: EntityId,
  patch: Partial<
    Pick<
      RecycleEntry,
      "canRestore" | "cannotRestoreReason" | "restoreStatus" | "operationLogId" | "summary"
    >
  >
) {
  const latest = await getLatestRecycleEntryForEntity(entityType, entityId);
  if (!latest) {
    return undefined;
  }
  return recycleEntryRepository.update(latest.id, patch);
}

export async function listRecycleEntries(query: RecycleQuery = {}) {
  const entries = await recycleEntryRepository.list();
  return entries
    .map(recycleEntryToSummary)
    .filter((entry) => matchesRecycleQuery(entry, query))
    .sort((left, right) => right.deletedAt.localeCompare(left.deletedAt));
}

export async function listRecentlyDeleted(query: RecycleQuery = {}) {
  const recycleSummaries = await listRecycleEntries(query);
  const byEntity = new Map<string, DeletedEntitySummary>();
  for (const summary of recycleSummaries) {
    const key = `${summary.entityType}:${summary.entityId}`;
    if (!byEntity.has(key)) {
      byEntity.set(key, summary);
    }
  }

  for (const adapter of restoreAdapters) {
    const deletedEntities = await adapter.repository.listDeleted();
    for (const entity of deletedEntities) {
      const summary = deletedEntityToSummary(adapter, entity);
      const key = `${summary.entityType}:${summary.entityId}`;
      if (!byEntity.has(key) && matchesRecycleQuery(summary, query)) {
        byEntity.set(key, summary);
      }
    }
  }

  const items = [...byEntity.values()].sort((left, right) =>
    right.deletedAt.localeCompare(left.deletedAt)
  );
  return typeof query.limit === "number" ? items.slice(0, query.limit) : items;
}

export async function getDeletedEntitySummary(entityType: string, entityId: EntityId) {
  return (
    await listRecentlyDeleted({
      entityType,
      entityId,
      limit: 1
    })
  )[0];
}

function unsupportedSummary(entityType: string, entityId: EntityId, reason: string) {
  return createDeletedEntitySummary({
    entityType,
    entityId,
    title: entityId,
    module: "global",
    deletedAt: new Date().toISOString(),
    canRestore: false,
    cannotRestoreReason: reason,
    restoreStatus: "unsupported",
    refreshKeys: []
  });
}

export async function restoreDeletedEntity(input: RestoreDeletedEntityInput) {
  if (input.confirmedByUser !== true) {
    return createSkippedWriteFeedback<DeletedEntitySummary>({
      operation: "recycleBin.restore",
      data: unsupportedSummary(
        input.entityType,
        input.entityId,
        "Restore requires explicit user confirmation."
      ),
      skipped: ["restore_requires_user_confirmation"],
      refreshKeys: defaultRecycleRefreshKeys()
    });
  }

  if (OUTPUT_DELETE_SAFETY_ENTITY_TYPES.has(input.entityType)) {
    return createSkippedWriteFeedback<DeletedEntitySummary>({
      operation: "recycleBin.restore",
      data: unsupportedSummary(
        input.entityType,
        input.entityId,
        "Output five-layer restore requires the LP8-6-C preview-hash confirmation contract."
      ),
      skipped: ["output_delete_safety_confirmation_required"],
      refreshKeys: defaultRecycleRefreshKeys()
    });
  }

  const adapter = adapterByEntityType.get(input.entityType);
  if (!adapter) {
    return createSkippedWriteFeedback<DeletedEntitySummary>({
      operation: "recycleBin.restore",
      data: unsupportedSummary(
        input.entityType,
        input.entityId,
        "This entity type is not supported by LP1-4 restore."
      ),
      skipped: ["restore_entity_type_unsupported"],
      refreshKeys: defaultRecycleRefreshKeys()
    });
  }

  if (input.recycleEntryId) {
    const exactEntry = await getRecycleEntry(input.recycleEntryId);
    if (
      !exactEntry ||
      exactEntry.entityType !== input.entityType ||
      exactEntry.entityId !== input.entityId ||
      !exactEntry.canRestore
    ) {
      return createSkippedWriteFeedback<DeletedEntitySummary>({
        operation: "recycleBin.restore",
        data: unsupportedSummary(
          input.entityType,
          input.entityId,
          "The selected recycle entry no longer authorizes this exact restore target."
        ),
        skipped: ["recycle_entry_identity_or_state_mismatch"],
        refreshKeys: defaultRecycleRefreshKeys(adapter.refreshKeys)
      });
    }
  }

  const existingDeleted = await adapter.repository.getDeletedById(input.entityId);
  if (!existingDeleted) {
    return createSkippedWriteFeedback<DeletedEntitySummary>({
      operation: "recycleBin.restore",
      data: createDeletedEntitySummary({
        entityType: adapter.entityType,
        entityId: input.entityId,
        title: input.entityId,
        module: adapter.module,
        deletedAt: new Date().toISOString(),
        canRestore: false,
        cannotRestoreReason: "Entity does not exist or is not currently deleted.",
        restoreStatus: "blocked",
        refreshKeys: adapter.refreshKeys
      }),
      skipped: ["deleted_entity_not_found"],
      refreshKeys: defaultRecycleRefreshKeys()
    });
  }

  await adapter.assertWritable?.(existingDeleted);
  const restoreOutcome = adapter.restore
    ? await adapter.restore(existingDeleted)
    : { entity: await adapter.repository.restore(input.entityId) };
  const restored = restoreOutcome.entity;
  if (!restored) {
    return createSkippedWriteFeedback<DeletedEntitySummary>({
      operation: "recycleBin.restore",
      data: deletedEntityToSummary(adapter, existingDeleted),
      skipped: ["restore_failed"],
      refreshKeys: defaultRecycleRefreshKeys(adapter.refreshKeys)
    });
  }

  const authoritativeRestored = await adapter.repository.getById(input.entityId);
  if (!authoritativeRestored || authoritativeRestored.deletedAt) {
    throw new Error("RESTORE_AUTHORITATIVE_READBACK_FAILED");
  }

  const summary = createDeletedEntitySummary({
    ...deletedEntityToSummary(adapter, authoritativeRestored),
    deletedAt: existingDeleted.deletedAt ?? authoritativeRestored.updatedAt,
    restoreStatus: "restored",
    canRestore: false,
    cannotRestoreReason: "Entity has already been restored.",
    refreshKeys: adapter.refreshKeys
  });
  let feedback = createSuccessWriteFeedback<DeletedEntitySummary>({
    operation: "recycleBin.restore",
    data: summary,
    affectedEntities: [
      {
        type: adapter.entityType,
        id: authoritativeRestored.id,
        relation: "updated",
        label: summary.title
      }
    ],
    refreshKeys: defaultRecycleRefreshKeys(adapter.refreshKeys),
    messages: [
      {
        severity: "success",
        message: `${summary.title} restored.`
      }
    ]
  });
  for (const warning of restoreOutcome.warnings ?? []) {
    feedback = addWriteFeedbackWarning(feedback, warning, "RESTORE_LIFECYCLE_COMPANION_WARNING");
  }
  try {
    if (input.recycleEntryId) {
      await updateRecycleEntry(input.recycleEntryId, {
        canRestore: false,
        cannotRestoreReason: "Entity has already been restored.",
        restoreStatus: "restored"
      });
    } else {
      await updateLatestRecycleEntryForEntity(adapter.entityType, authoritativeRestored.id, {
        canRestore: false,
        cannotRestoreReason: "Entity has already been restored.",
        restoreStatus: "restored"
      });
    }
  } catch {
    feedback = addWriteFeedbackWarning(
      feedback,
      "The entity was restored and verified, but its recycle entry status could not be updated.",
      "RECYCLE_ENTRY_UPDATE_FAILED_AFTER_RESTORE"
    );
  }
  if (!restoreOutcome.operationLogId) {
    try {
      await createOperationLog({
        operationType: "restore",
        source: "user",
        module: adapter.module === "outputConversion" ? "outputConversion" : adapter.module,
        status: feedback.status,
        riskLevel: "high",
        target: {
          entityType: adapter.entityType,
          entityId: authoritativeRestored.id,
          title: summary.title
        },
        summary: `${summary.title} restored from recycle bin.`,
        feedback: {
          status: feedback.status,
          warnings: feedback.warnings,
          errors: feedback.errors,
          skipped: feedback.skipped,
          affectedEntities: feedback.affectedEntities,
          refreshKeys: feedback.refreshKeys
        },
        isRecoverable: false
      });
    } catch {
      feedback = addWriteFeedbackWarning(
        feedback,
        "The entity was restored and verified, but the companion operation log could not be recorded.",
        "OPERATION_LOG_FAILED_AFTER_RESTORE"
      );
    }
  }
  publishWriteFeedbackRefresh(feedback, {
    source: "service.write",
    reason: "deleted entity restored with authoritative readback"
  });
  return feedback;
}

export async function permanentlyDeleteEntity(input: PermanentlyDeleteEntityInput) {
  if (input.confirmedByUser !== true) {
    return createSkippedWriteFeedback<DeletedEntitySummary>({
      operation: "recycleBin.permanentlyDelete",
      data: unsupportedSummary(
        input.entityType,
        input.entityId,
        "Permanent delete requires explicit user confirmation."
      ),
      skipped: ["permanent_delete_requires_user_confirmation"],
      refreshKeys: defaultRecycleRefreshKeys()
    });
  }

  if (OUTPUT_DELETE_SAFETY_ENTITY_TYPES.has(input.entityType)) {
    return createSkippedWriteFeedback<DeletedEntitySummary>({
      operation: "recycleBin.permanentlyDelete",
      data: unsupportedSummary(
        input.entityType,
        input.entityId,
        "Output five-layer permanent delete requires the LP8-6-C preview-hash confirmation contract."
      ),
      skipped: ["output_delete_safety_confirmation_required"],
      refreshKeys: defaultRecycleRefreshKeys()
    });
  }

  const adapter = adapterByEntityType.get(input.entityType);
  if (!adapter) {
    return createSkippedWriteFeedback<DeletedEntitySummary>({
      operation: "recycleBin.permanentlyDelete",
      data: unsupportedSummary(
        input.entityType,
        input.entityId,
        "This entity type is not supported by LP1-4 permanent delete."
      ),
      skipped: ["permanent_delete_entity_type_unsupported"],
      refreshKeys: defaultRecycleRefreshKeys()
    });
  }

  const deleted = await adapter.repository.getDeletedById(input.entityId);
  if (!deleted) {
    return createSkippedWriteFeedback<DeletedEntitySummary>({
      operation: "recycleBin.permanentlyDelete",
      data: unsupportedSummary(
        input.entityType,
        input.entityId,
        "Entity does not exist or is not currently deleted."
      ),
      skipped: ["deleted_entity_not_found"],
      refreshKeys: defaultRecycleRefreshKeys()
    });
  }

  await adapter.assertWritable?.(deleted);
  const removed = await adapter.repository.hardDelete(input.entityId);
  if (!removed) {
    return createSkippedWriteFeedback<DeletedEntitySummary>({
      operation: "recycleBin.permanentlyDelete",
      data: deletedEntityToSummary(adapter, deleted),
      skipped: ["permanent_delete_failed"],
      refreshKeys: defaultRecycleRefreshKeys(adapter.refreshKeys)
    });
  }

  const summary = createDeletedEntitySummary({
    ...deletedEntityToSummary(adapter, deleted),
    canRestore: false,
    cannotRestoreReason: "Entity metadata has been permanently deleted from SciLoom.",
    restoreStatus: "permanently_deleted",
    refreshKeys: adapter.refreshKeys
  });
  const feedback = createSuccessWriteFeedback<DeletedEntitySummary>({
    operation: "recycleBin.permanentlyDelete",
    data: summary,
    affectedEntities: [
      {
        type: adapter.entityType,
        id: input.entityId,
        relation: "deleted",
        label: summary.title
      }
    ],
    refreshKeys: defaultRecycleRefreshKeys(adapter.refreshKeys),
    warnings: [
      "Only SciLoom structured metadata was deleted. Local files referenced by paths were not touched."
    ],
    messages: [
      {
        severity: "success",
        message: `${summary.title} permanently deleted from SciLoom metadata.`
      }
    ]
  });
  publishWriteFeedbackRefresh(feedback, {
    source: "service.write",
    reason: "deleted entity permanently deleted"
  });
  return feedback;
}

export const recycleBinService = {
  createDeletedEntitySummary,
  createRecycleEntry,
  recordRecycleEntry,
  getRecycleEntry,
  updateRecycleEntry,
  updateLatestRecycleEntryForEntity,
  listRecycleEntries,
  listRecentlyDeleted,
  getDeletedEntitySummary,
  restoreDeletedEntity,
  permanentlyDeleteEntity
};
