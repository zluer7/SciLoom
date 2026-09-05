import type { AuditableEntity } from "../types/common";
import { resolveDataSourceMode } from "./dataSourceMode";
import { createLocalStorageRepository } from "./localStorageRepository";
import { createSQLiteRepository } from "./sqliteRepository";
import type { EntityRepositoryConfig, Repository } from "./types";

export function createRepository<T extends AuditableEntity>(
  config: EntityRepositoryConfig<T>
): Repository<T> {
  const fallbackRepository = createLocalStorageRepository(config);
  const sqliteRepository = createSQLiteRepository(config);

  function useSQLite() {
    return resolveDataSourceMode() === "sqlite";
  }

  function assertDedicatedExperimentLifecycle() {
    if (config.tableName === "experiments" || config.tableName === "experiment_runs") {
      throw new Error("Experiment/ExperimentRun lifecycle must use experimentRunLifecycleService.");
    }
  }

  return {
    async list() {
      if (!useSQLite()) {
        return fallbackRepository.list();
      }
      return sqliteRepository.list();
    },
    async getById(id) {
      if (!useSQLite()) {
        return fallbackRepository.getById(id);
      }
      return sqliteRepository.getById(id);
    },
    async create(input, options) {
      if (!useSQLite()) {
        return fallbackRepository.create(input, options);
      }
      return sqliteRepository.create(input, options);
    },
    async createIfAbsent(input, options) {
      if (!fallbackRepository.createIfAbsent || !sqliteRepository.createIfAbsent) {
        throw new Error("The configured repository lacks its bounded atomic create primitive.");
      }
      if (!useSQLite()) {
        return fallbackRepository.createIfAbsent(input, options);
      }
      return sqliteRepository.createIfAbsent(input, options);
    },
    async update(id, input) {
      if (!useSQLite()) {
        return fallbackRepository.update(id, input);
      }
      return sqliteRepository.update(id, input);
    },
    async updateWithExpectedUpdatedAt(id, input, options) {
      if (
        !fallbackRepository.updateWithExpectedUpdatedAt ||
        !sqliteRepository.updateWithExpectedUpdatedAt
      ) {
        throw new Error("The configured repository lacks its bounded atomic update primitive.");
      }
      if (!useSQLite()) {
        return fallbackRepository.updateWithExpectedUpdatedAt(id, input, options);
      }
      return sqliteRepository.updateWithExpectedUpdatedAt(id, input, options);
    },
    async softDelete(id) {
      assertDedicatedExperimentLifecycle();
      if (!useSQLite()) {
        return fallbackRepository.softDelete(id);
      }
      return sqliteRepository.softDelete(id);
    },
    async listDeleted() {
      if (!useSQLite()) {
        return fallbackRepository.listDeleted();
      }
      return sqliteRepository.listDeleted();
    },
    async getDeletedById(id) {
      if (!useSQLite()) {
        return fallbackRepository.getDeletedById(id);
      }
      return sqliteRepository.getDeletedById(id);
    },
    async restore(id) {
      assertDedicatedExperimentLifecycle();
      if (!useSQLite()) {
        return fallbackRepository.restore(id);
      }
      return sqliteRepository.restore(id);
    },
    async hardDelete(id) {
      assertDedicatedExperimentLifecycle();
      if (!useSQLite()) {
        return fallbackRepository.hardDelete(id);
      }
      return sqliteRepository.hardDelete(id);
    },
    async remove(id) {
      if (!useSQLite()) {
        return fallbackRepository.remove(id);
      }
      return sqliteRepository.remove(id);
    }
  };
}
