import { invoke } from "@tauri-apps/api/core";
import {
  operationLogRepositoryConfig,
  outputCandidateRepositoryConfig,
  outputGapRepositoryConfig,
  outputRepositoryConfig,
  recycleEntryRepositoryConfig,
  findingRepositoryConfig,
  resultItemRepositoryConfig
} from "../repositories/entityConfig";
import { resolveDataSourceMode } from "../repositories/dataSourceMode";
import { toSQLiteRecord } from "../repositories/sqliteRepository";
import type { EntityRepositoryConfig } from "../repositories/types";
import type { AuditableEntity, EntityId, ISODateString } from "../types/common";
import type { OperationLogEntry } from "../types/operationLog";
import type { OutputDeleteSafetyLayer } from "../types/outputDeleteSafety";
import type { RecycleEntry } from "../types/recycleBin";

const LOCAL_DATASET_VERSION = "empty-initial-dataset-v4";

const ownerConfigs: Record<OutputDeleteSafetyLayer, EntityRepositoryConfig<AuditableEntity>> = {
  resultItem: resultItemRepositoryConfig as EntityRepositoryConfig<AuditableEntity>,
  finding: findingRepositoryConfig as EntityRepositoryConfig<AuditableEntity>,
  outputCandidate: outputCandidateRepositoryConfig as EntityRepositoryConfig<AuditableEntity>,
  outputGap: outputGapRepositoryConfig as EntityRepositoryConfig<AuditableEntity>,
  researchOutput: outputRepositoryConfig as EntityRepositoryConfig<AuditableEntity>
};

const recycleEntityTypes: Record<OutputDeleteSafetyLayer, string> = {
  resultItem: "resultItem",
  finding: "finding",
  outputCandidate: "outputCandidate",
  outputGap: "outputGap",
  researchOutput: "output"
};

export interface OutputLifecycleTransactionResult {
  committed: boolean;
  ownerDeletedAt: ISODateString | null;
  operationLogId: EntityId;
  recycleEntryId: EntityId;
  recycleRestoreStatus: "not_started" | "restored";
  recycleCanRestore: boolean;
  durableReadbackConfirmed: boolean;
}

interface SoftDeleteInput {
  mode: "softDelete";
  layer: OutputDeleteSafetyLayer;
  ownerId: EntityId;
  occurredAt: ISODateString;
  operationLog: OperationLogEntry;
  recycleEntry: RecycleEntry;
}

interface RestoreInput {
  mode: "restore";
  layer: OutputDeleteSafetyLayer;
  ownerId: EntityId;
  occurredAt: ISODateString;
  operationLog: OperationLogEntry;
  recycleEntryId: EntityId;
}

type OutputLifecycleTransactionInput = SoftDeleteInput | RestoreInput;

function assertLocalStorage() {
  if (typeof window === "undefined" || !window.localStorage) {
    throw new Error("OUTPUT_LIFECYCLE_LOCAL_STORAGE_UNAVAILABLE");
  }
  return window.localStorage;
}

function readLocalDataset<T extends AuditableEntity>(
  storage: Pick<Storage, "getItem">,
  config: EntityRepositoryConfig<T>
) {
  const version = storage.getItem(`${config.storageKey}.datasetVersion`);
  if (version !== LOCAL_DATASET_VERSION) return config.seedData.map((item) => ({ ...item }));
  const stored = storage.getItem(config.storageKey);
  return stored ? JSON.parse(stored) as T[] : config.seedData.map((item) => ({ ...item }));
}

function writeLocalTransaction(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
  writes: Map<string, string>
) {
  const before = new Map<string, string | null>();
  for (const key of writes.keys()) before.set(key, storage.getItem(key));
  try {
    for (const [key, value] of writes) storage.setItem(key, value);
  } catch (cause) {
    try {
      for (const [key, value] of before) {
        if (value === null) storage.removeItem(key);
        else storage.setItem(key, value);
      }
    } catch (rollbackCause) {
      const causeMessage = cause instanceof Error ? cause.message : String(cause);
      const rollbackMessage = rollbackCause instanceof Error
        ? rollbackCause.message
        : String(rollbackCause);
      throw new Error(
        `OUTPUT_LIFECYCLE_LOCAL_TRANSACTION_ROLLBACK_FAILED: write=${causeMessage}; rollback=${rollbackMessage}`
      );
    }
    throw cause;
  }
}

function commitLocalStorage(
  input: OutputLifecycleTransactionInput
): OutputLifecycleTransactionResult {
  const storage = assertLocalStorage();
  const ownerConfig = ownerConfigs[input.layer];
  const owners = readLocalDataset(storage, ownerConfig);
  const logs = readLocalDataset(storage, operationLogRepositoryConfig);
  const recycleEntries = readLocalDataset(storage, recycleEntryRepositoryConfig);
  let committed = false;
  let ownerDeletedAt: ISODateString | null = null;
  let recycleEntryId: EntityId;
  let recycleRestoreStatus: "not_started" | "restored";
  let recycleCanRestore: boolean;

  const nextOwners = owners.map((owner) => {
    if (owner.id !== input.ownerId) return owner;
    if (input.mode === "softDelete") {
      if (owner.deletedAt) return owner;
      committed = true;
      ownerDeletedAt = input.occurredAt;
      return { ...owner, updatedAt: input.occurredAt, deletedAt: input.occurredAt };
    }
    if (!owner.deletedAt) return owner;
    committed = true;
    return { ...owner, updatedAt: input.occurredAt, deletedAt: null };
  });
  if (!committed) {
    throw new Error(
      input.mode === "softDelete"
        ? "OUTPUT_LIFECYCLE_OWNER_NOT_ACTIVE"
        : "OUTPUT_LIFECYCLE_OWNER_NOT_DELETED"
    );
  }

  let nextRecycleEntries: RecycleEntry[];
  if (input.mode === "softDelete") {
    recycleEntryId = input.recycleEntry.id;
    recycleRestoreStatus = "not_started";
    recycleCanRestore = true;
    if (
      input.recycleEntry.entityType !== recycleEntityTypes[input.layer] ||
      input.recycleEntry.entityId !== input.ownerId ||
      input.recycleEntry.operationLogId !== input.operationLog.id
    ) {
      throw new Error("OUTPUT_LIFECYCLE_RECYCLE_IDENTITY_MISMATCH");
    }
    nextRecycleEntries = [...recycleEntries, input.recycleEntry];
  } else {
    recycleEntryId = input.recycleEntryId;
    recycleRestoreStatus = "restored";
    recycleCanRestore = false;
    let exactEntryFound = false;
    nextRecycleEntries = recycleEntries.map((entry) => {
      if (entry.id !== input.recycleEntryId) return entry;
      if (
        entry.entityType !== recycleEntityTypes[input.layer] ||
        entry.entityId !== input.ownerId ||
        !entry.canRestore ||
        entry.restoreStatus !== "not_started" ||
        entry.deletedAt
      ) {
        throw new Error("OUTPUT_LIFECYCLE_RECYCLE_IDENTITY_OR_STATE_MISMATCH");
      }
      exactEntryFound = true;
      return {
        ...entry,
        canRestore: false,
        cannotRestoreReason: "Entity metadata has already been restored.",
        restoreStatus: "restored",
        operationLogId: input.operationLog.id,
        revision: (entry.revision ?? 0) + 1,
        updatedAt: input.occurredAt
      };
    });
    if (!exactEntryFound) {
      throw new Error("OUTPUT_LIFECYCLE_RECYCLE_IDENTITY_OR_STATE_MISMATCH");
    }
  }

  const writes = new Map<string, string>([
    [ownerConfig.storageKey, JSON.stringify(nextOwners)],
    [`${ownerConfig.storageKey}.datasetVersion`, LOCAL_DATASET_VERSION],
    [operationLogRepositoryConfig.storageKey, JSON.stringify([...logs, input.operationLog])],
    [`${operationLogRepositoryConfig.storageKey}.datasetVersion`, LOCAL_DATASET_VERSION],
    [recycleEntryRepositoryConfig.storageKey, JSON.stringify(nextRecycleEntries)],
    [`${recycleEntryRepositoryConfig.storageKey}.datasetVersion`, LOCAL_DATASET_VERSION]
  ]);
  writeLocalTransaction(storage, writes);

  const ownerReadback = readLocalDataset(storage, ownerConfig).find(
    (owner) => owner.id === input.ownerId
  );
  const logReadback = readLocalDataset(storage, operationLogRepositoryConfig).find(
    (entry) => entry.id === input.operationLog.id
  );
  const recycleReadback = readLocalDataset(storage, recycleEntryRepositoryConfig).find(
    (entry) => entry.id === recycleEntryId
  );
  const expectedDeleted = input.mode === "softDelete";
  const readbackConfirmed = Boolean(
    ownerReadback &&
      Boolean(ownerReadback.deletedAt) === expectedDeleted &&
      logReadback &&
      recycleReadback &&
      recycleReadback.restoreStatus === recycleRestoreStatus &&
      recycleReadback.canRestore === recycleCanRestore
  );
  if (!readbackConfirmed) throw new Error("OUTPUT_LIFECYCLE_LOCAL_READBACK_FAILED");

  return {
    committed: true,
    ownerDeletedAt: ownerReadback?.deletedAt ?? null,
    operationLogId: input.operationLog.id,
    recycleEntryId,
    recycleRestoreStatus,
    recycleCanRestore,
    durableReadbackConfirmed: true
  };
}

async function commitSQLite(
  input: OutputLifecycleTransactionInput
): Promise<OutputLifecycleTransactionResult> {
  return invoke<OutputLifecycleTransactionResult>("commit_output_lifecycle_transaction", {
    input: {
      mode: input.mode,
      ownerType: input.layer,
      ownerId: input.ownerId,
      occurredAt: input.occurredAt,
      operationLogRecord: toSQLiteRecord("operation_logs", input.operationLog),
      recycleEntryRecord: input.mode === "softDelete"
        ? toSQLiteRecord("recycle_entries", input.recycleEntry)
        : undefined,
      recycleEntryId: input.mode === "restore" ? input.recycleEntryId : undefined
    }
  });
}

export async function commitOutputLifecycleTransaction(
  input: OutputLifecycleTransactionInput
) {
  return resolveDataSourceMode() === "sqlite"
    ? commitSQLite(input)
    : commitLocalStorage(input);
}

export const outputLifecycleTransactionService = {
  commitOutputLifecycleTransaction
};
