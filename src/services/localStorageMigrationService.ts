import { invoke } from "@tauri-apps/api/core";
import {
  experimentRunRepositoryConfig,
  experimentRepositoryConfig,
  fileRefRepositoryConfig,
  milestoneRepositoryConfig,
  outputRepositoryConfig,
  resultMetricRepositoryConfig,
  taskRepositoryConfig
} from "../repositories/entityConfig";
import { toSQLiteRecord } from "../repositories/sqliteRepository";
import type { AuditableEntity } from "../types";

type MigrationEntityResult = {
  entityName: string;
  total: number;
  migrated: number;
  failed: number;
  errors: string[];
};

export type LocalStorageMigrationResult = {
  status: "success" | "blocked" | "skipped" | "unsupported";
  message: string;
  sqliteRecordCount: number;
  localStorageRecordCount: number;
  entities: MigrationEntityResult[];
};

const migrationConfigs = [
  milestoneRepositoryConfig,
  taskRepositoryConfig,
  experimentRepositoryConfig,
  experimentRunRepositoryConfig,
  resultMetricRepositoryConfig,
  fileRefRepositoryConfig,
  outputRepositoryConfig
];

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function readLocalStorageRecords<T extends AuditableEntity>(storageKey: string): T[] {
  if (typeof window === "undefined" || !window.localStorage) {
    return [];
  }

  const stored = window.localStorage.getItem(storageKey);
  if (!stored) {
    return [];
  }

  const parsed = JSON.parse(stored);
  if (!Array.isArray(parsed)) {
    throw new Error(`${storageKey} is not a valid array payload.`);
  }

  return parsed as T[];
}

async function countSQLiteRecords() {
  const counts = await Promise.all(
    migrationConfigs.map((config) =>
      invoke<number>("db_count_records", { tableName: config.tableName })
    )
  );

  return counts.reduce((sum, count) => sum + count, 0);
}

function countLocalStorageRecords() {
  return migrationConfigs.reduce((sum, config) => {
    return sum + readLocalStorageRecords(config.storageKey).length;
  }, 0);
}

export const localStorageMigrationService = {
  async inspect() {
    const localStorageRecordCount = countLocalStorageRecords();
    const sqliteRecordCount = isTauriRuntime() ? await countSQLiteRecords() : 0;

    return {
      isDesktopRuntime: isTauriRuntime(),
      hasLocalStorageData: localStorageRecordCount > 0,
      sqliteIsEmpty: sqliteRecordCount === 0,
      sqliteRecordCount,
      localStorageRecordCount
    };
  },

  async migrateToSQLite(): Promise<LocalStorageMigrationResult> {
    if (!isTauriRuntime()) {
      return {
        status: "unsupported",
        message: "Migration is available only in the Tauri desktop app.",
        sqliteRecordCount: 0,
        localStorageRecordCount: countLocalStorageRecords(),
        entities: []
      };
    }

    const sqliteRecordCount = await countSQLiteRecords();
    const localStorageRecordCount = countLocalStorageRecords();

    if (localStorageRecordCount === 0) {
      return {
        status: "skipped",
        message: "No SciLoom localStorage records were found.",
        sqliteRecordCount,
        localStorageRecordCount,
        entities: []
      };
    }

    if (sqliteRecordCount > 0) {
      return {
        status: "blocked",
        message: "SQLite already contains data. Migration did not run to avoid overwriting records.",
        sqliteRecordCount,
        localStorageRecordCount,
        entities: []
      };
    }

    const entities: MigrationEntityResult[] = [];

    for (const config of migrationConfigs) {
      const records = readLocalStorageRecords(config.storageKey);
      const result: MigrationEntityResult = {
        entityName: config.entityName,
        total: records.length,
        migrated: 0,
        failed: 0,
        errors: []
      };

      for (const record of records) {
        try {
          await invoke("db_save_record", {
            tableName: config.tableName,
            record: toSQLiteRecord(config.tableName, record)
          });
          result.migrated += 1;
        } catch (error) {
          result.failed += 1;
          result.errors.push(
            `${record.id}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }

      entities.push(result);
    }

    const failed = entities.reduce((sum, entity) => sum + entity.failed, 0);

    return {
      status: failed > 0 ? "blocked" : "success",
      message:
        failed > 0
          ? "Migration completed with failures. localStorage data was left untouched."
          : "Migration completed successfully. localStorage data was left untouched.",
      sqliteRecordCount: await countSQLiteRecords(),
      localStorageRecordCount,
      entities
    };
  }
};
