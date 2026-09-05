import type {
  AuditableEntity,
  CreateEntityInput,
  EntityId,
  UpdateEntityInput
} from "../types/common";
import type { EntityRepositoryConfig, Repository } from "./types";
import { createRepositoryEntityId } from "./entityId";
import {
  assertCreatedLocalTimeNotPatched,
  assertCreatedLocalTimeRecord
} from "../services/experimentCreatedLocalTime";
import {
  assertFrozenWorkspaceTitleIdentity,
  assertWorkspaceTitleIdentityNotPatched
} from "../services/experimentWorkspacePathService";

const DATASET_VERSION = "empty-initial-dataset-v4";

function hasLocalStorage() {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function clone<T>(items: T[]): T[] {
  return items.map((item) => ({ ...item }));
}

export function createLocalStorageRepository<T extends AuditableEntity>(
  config: EntityRepositoryConfig<T>
): Repository<T> {
  let memoryData = clone(config.seedData);
  const versionKey = `${config.storageKey}.datasetVersion`;

  function validateReadItems(items: T[]) {
    if (config.tableName === "experiments" || config.tableName === "experiment_runs") {
      for (const item of items) {
        assertCreatedLocalTimeRecord(
          item as T & Record<string, unknown>,
          config.tableName === "experiments" ? "Experiment" : "ExperimentRun"
        );
        assertFrozenWorkspaceTitleIdentity(
          (item as T & Record<string, unknown>).workspaceTitleIdentity,
          config.tableName === "experiments" ? "experiment" : "experimentRun"
        );
      }
    }
    return items;
  }

  function readAll(): T[] {
    if (!hasLocalStorage()) {
      return validateReadItems(clone(memoryData));
    }

    if (window.localStorage.getItem(versionKey) !== DATASET_VERSION) {
      window.localStorage.setItem(config.storageKey, JSON.stringify(config.seedData));
      window.localStorage.setItem(versionKey, DATASET_VERSION);
      return validateReadItems(clone(config.seedData));
    }

    const stored = window.localStorage.getItem(config.storageKey);
    if (!stored) {
      window.localStorage.setItem(config.storageKey, JSON.stringify(config.seedData));
      return validateReadItems(clone(config.seedData));
    }

    return validateReadItems(JSON.parse(stored) as T[]);
  }

  function writeAll(items: T[]) {
    if (!hasLocalStorage()) {
      memoryData = clone(items);
      return;
    }

    window.localStorage.setItem(config.storageKey, JSON.stringify(items));
  }

  async function softDelete(id: EntityId) {
    let removed = false;
    const timestamp = new Date().toISOString();
    const items = readAll().map((item) => {
      if (item.id !== id || item.deletedAt) {
        return item;
      }

      removed = true;
      return {
        ...item,
        deletedAt: timestamp,
        updatedAt: timestamp
      };
    });

    writeAll(items);
    return removed;
  }

  return {
    async list() {
      return readAll().filter((item) => !item.deletedAt);
    },

    async getById(id) {
      return readAll().find((item) => item.id === id && !item.deletedAt);
    },

    async create(input: CreateEntityInput<T>, options = {}) {
      if (
        (config.tableName === "experiments" || config.tableName === "experiment_runs") &&
        !options.createdAt
      ) {
        throw new Error("Experiment creation must provide the service-owned createdAt instant.");
      }
      const timestamp = options.createdAt ?? new Date().toISOString();
      const item = {
        ...input,
        id: options.id ?? createRepositoryEntityId(config.idPrefix),
        createdAt: timestamp,
        updatedAt: timestamp,
        deletedAt: null
      } as T;
      if (config.tableName === "experiments" || config.tableName === "experiment_runs") {
        assertCreatedLocalTimeRecord(
          item as T & Record<string, unknown>,
          config.tableName === "experiments" ? "Experiment" : "ExperimentRun"
        );
        assertFrozenWorkspaceTitleIdentity(
          (item as T & Record<string, unknown>).workspaceTitleIdentity,
          config.tableName === "experiments" ? "experiment" : "experimentRun"
        );
      }
      writeAll([...readAll(), item]);
      return item;
    },

    async createIfAbsent(input: CreateEntityInput<T>, options) {
      if (config.tableName !== "literatures") {
        throw new Error("Atomic create-if-absent is bounded to Literature creation.");
      }
      const items = readAll();
      const existing = items.find((item) => item.id === options.id);
      if (existing) return { created: false, entity: existing };
      const timestamp = options.createdAt ?? new Date().toISOString();
      const item = {
        ...input,
        id: options.id,
        createdAt: timestamp,
        updatedAt: timestamp,
        deletedAt: null
      } as T;
      writeAll([...items, item]);
      return { created: true, entity: item };
    },

    async update(id, input: UpdateEntityInput<T>) {
      return this.updateWithExpectedUpdatedAt?.(id, input, {});
    },

    async updateWithExpectedUpdatedAt(id, input: UpdateEntityInput<T>, options) {
      if (
        options.expectedUpdatedAt &&
        config.tableName !== "experiment_runs" &&
        config.tableName !== "literatures"
      ) {
        throw new Error("Atomic updatedAt guards are bounded to ExperimentRun and Literature updates.");
      }
      if (options.nextUpdatedAt && !options.expectedUpdatedAt) {
        throw new Error("A service-owned next updatedAt token requires one exact expected token.");
      }
      if (
        options.nextUpdatedAt &&
        options.expectedUpdatedAt &&
        options.nextUpdatedAt <= options.expectedUpdatedAt
      ) {
        throw new Error("The service-owned next updatedAt token must be strictly newer.");
      }
      if (config.tableName === "experiments" || config.tableName === "experiment_runs") {
        assertCreatedLocalTimeNotPatched(
          input as UpdateEntityInput<T> & Record<string, unknown>,
          config.tableName === "experiments" ? "Experiment" : "ExperimentRun"
        );
        assertWorkspaceTitleIdentityNotPatched(
          input as UpdateEntityInput<T> & Record<string, unknown>,
          config.tableName === "experiments" ? "Experiment" : "ExperimentRun"
        );
      }
      if (
        config.tableName === "experiment_runs" &&
        (Object.prototype.hasOwnProperty.call(input, "experimentId") ||
          Object.prototype.hasOwnProperty.call(input, "projectId"))
      ) {
        throw new Error("ExperimentRun parent and project are immutable in ordinary repository updates.");
      }
      let updatedItem: T | undefined;
      const items = readAll().map((item) => {
        if (item.id !== id || item.deletedAt) {
          return item;
        }
        if (options.expectedUpdatedAt && item.updatedAt !== options.expectedUpdatedAt) {
          return item;
        }

        const currentInstant = new Date().toISOString();
        const priorInstant = options.expectedUpdatedAt ?? item.updatedAt;
        const strictlyNewerInstant = options.nextUpdatedAt ?? (currentInstant > priorInstant
          ? currentInstant
          : new Date(new Date(priorInstant).getTime() + 1).toISOString());
        updatedItem = {
          ...item,
          ...input,
          id: item.id,
          createdAt: item.createdAt,
          updatedAt: strictlyNewerInstant
        };
        return updatedItem;
      });

      writeAll(items);
      return updatedItem;
    },

    async listDeleted() {
      return readAll().filter((item) => Boolean(item.deletedAt));
    },

    async getDeletedById(id) {
      return readAll().find((item) => item.id === id && Boolean(item.deletedAt));
    },

    async restore(id) {
      let restoredItem: T | undefined;
      const items = readAll().map((item) => {
        if (item.id !== id || !item.deletedAt) {
          return item;
        }

        restoredItem = {
          ...item,
          deletedAt: null,
          updatedAt: new Date().toISOString()
        };
        return restoredItem;
      });

      writeAll(items);
      return restoredItem;
    },

    async hardDelete(id) {
      const before = readAll();
      const after = before.filter((item) => item.id !== id);
      writeAll(after);
      return after.length !== before.length;
    },

    softDelete,
    remove: softDelete
  };
}
