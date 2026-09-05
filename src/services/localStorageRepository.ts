import type {
  AuditableEntity,
  CreateEntityInput,
  EntityId,
  UpdateEntityInput
} from "../types/common";
import { createLocalStorageRepository } from "../repositories/localStorageRepository";

export type CrudService<T extends AuditableEntity> = {
  list: () => Promise<T[]>;
  getById: (id: EntityId) => Promise<T | undefined>;
  create: (input: CreateEntityInput<T>) => Promise<T>;
  update: (id: EntityId, input: UpdateEntityInput<T>) => Promise<T | undefined>;
  softDelete: (id: EntityId) => Promise<boolean>;
  remove: (id: EntityId) => Promise<boolean>;
};

export function createLocalStorageCrudService<T extends AuditableEntity>(
  storageKey: string,
  idPrefix: string,
  seedData: T[]
): CrudService<T> {
  return createLocalStorageRepository({
    entityName: idPrefix,
    idPrefix,
    storageKey,
    tableName: storageKey,
    seedData
  });
}
