export type EntityId = string;

export type ISODateString = string;

export type Priority = "low" | "medium" | "high" | "critical";

export type WorkStatus =
  | "not_started"
  | "planned"
  | "in_progress"
  | "blocked"
  | "completed"
  | "archived";

export type AuditableEntity = {
  id: EntityId;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  deletedAt?: ISODateString | null;
};

export type CreateEntityInput<T extends AuditableEntity> = Omit<
  T,
  "id" | "createdAt" | "updatedAt" | "deletedAt"
>;

export type UpdateEntityInput<T extends AuditableEntity> = Partial<
  Omit<T, "id" | "createdAt" | "updatedAt">
>;
