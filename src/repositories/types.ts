import type {
  AuditableEntity,
  CreateEntityInput,
  EntityId,
  UpdateEntityInput
} from "../types/common";

export type CreationAuditOptions = {
  createdAt?: string;
  id?: EntityId;
};

/**
 * Bounded optimistic-write input. `expectedUpdatedAt` is currently consumed only
 * by the canonical ExperimentRun and Literature update paths; repositories reject
 * it elsewhere.
 */
export type RepositoryUpdateOptions = {
  expectedUpdatedAt?: string;
  /**
   * Service-owned token selected before an atomic write. It is currently used
   * only by the bounded Literature Standard Result recovery contract.
   */
  nextUpdatedAt?: string;
};

export type RepositoryCreateIfAbsentResult<T extends AuditableEntity> = {
  created: boolean;
  entity: T;
};

export type Repository<T extends AuditableEntity> = {
  list: () => Promise<T[]>;
  getById: (id: EntityId) => Promise<T | undefined>;
  create: (input: CreateEntityInput<T>, options?: CreationAuditOptions) => Promise<T>;
  /** Bounded atomic create primitive; current production use is Literature-only. */
  createIfAbsent?: (
    input: CreateEntityInput<T>,
    options: CreationAuditOptions & { id: EntityId }
  ) => Promise<RepositoryCreateIfAbsentResult<T>>;
  update: (id: EntityId, input: UpdateEntityInput<T>) => Promise<T | undefined>;
  updateWithExpectedUpdatedAt?: (
    id: EntityId,
    input: UpdateEntityInput<T>,
    options: RepositoryUpdateOptions
  ) => Promise<T | undefined>;
  softDelete: (id: EntityId) => Promise<boolean>;
  listDeleted: () => Promise<T[]>;
  getDeletedById: (id: EntityId) => Promise<T | undefined>;
  restore: (id: EntityId) => Promise<T | undefined>;
  hardDelete: (id: EntityId) => Promise<boolean>;
  remove: (id: EntityId) => Promise<boolean>;
};

export type EntityRepositoryConfig<T extends AuditableEntity> = {
  entityName: string;
  idPrefix: string;
  storageKey: string;
  tableName: string;
  seedData: T[];
};
