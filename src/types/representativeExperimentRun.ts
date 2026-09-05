import type { EntityId, ISODateString } from "./common";

export const REPRESENTATIVE_RUN_ERROR_CODES = {
  experimentNotFound: "REPRESENTATIVE_EXPERIMENT_NOT_FOUND",
  experimentDeleted: "REPRESENTATIVE_EXPERIMENT_DELETED",
  runNotFound: "REPRESENTATIVE_RUN_NOT_FOUND",
  runDeleted: "REPRESENTATIVE_RUN_DELETED",
  parentMismatch: "REPRESENTATIVE_RUN_PARENT_MISMATCH",
  projectMismatch: "REPRESENTATIVE_RUN_PROJECT_MISMATCH",
  alreadySelected: "REPRESENTATIVE_RUN_ALREADY_SELECTED",
  relationNotFound: "REPRESENTATIVE_RUN_RELATION_NOT_FOUND",
  orderInvalid: "REPRESENTATIVE_RUN_ORDER_INVALID",
  duplicateOrderInput: "REPRESENTATIVE_RUN_DUPLICATE_ORDER_INPUT",
  nativeBackendRequired: "REPRESENTATIVE_RUN_NATIVE_BACKEND_REQUIRED"
} as const;

export interface RepresentativeRunRelation {
  id: EntityId;
  experimentId: EntityId;
  runId: EntityId;
  sortOrder: number;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export interface RepresentativeRunStructuredOutline {
  conditionSummary?: string | null;
  variableParameterSummary?: string | null;
  methodSummary?: string | null;
  resultSummary?: string | null;
  conclusion?: string | null;
  summaryOther?: string | null;
}

export interface RepresentativeRunAggregateItem {
  relationId: EntityId;
  runId: EntityId;
  displayTitle: string;
  rating?: string | null;
  sortOrder: number;
  structuredOutline: RepresentativeRunStructuredOutline;
}

export interface RepresentativeRunAggregate {
  experimentId: EntityId;
  representativeRunCount: number;
  representativeRuns: RepresentativeRunAggregateItem[];
}

export interface AddRepresentativeRunRepositoryInput {
  relationId: EntityId;
  experimentId: EntityId;
  runId: EntityId;
  occurredAt: ISODateString;
}

export interface RemoveRepresentativeRunRepositoryInput {
  experimentId: EntityId;
  runId: EntityId;
  occurredAt: ISODateString;
}

export interface SetRepresentativeRunOrderRepositoryInput {
  experimentId: EntityId;
  orderedRunIds: EntityId[];
  occurredAt: ISODateString;
}

export interface SetRepresentativeRunOrderResult {
  representativeRuns: RepresentativeRunRelation[];
  changed: boolean;
}

export type RepresentativeRelationOwnerType = "experiment" | "experimentRun";

export interface CleanupRepresentativeRunRelationsRepositoryInput {
  ownerType: RepresentativeRelationOwnerType;
  ownerId: EntityId;
  occurredAt: ISODateString;
}

export interface CleanupRepresentativeRunRelationsResult {
  removedCount: number;
  relationIds: EntityId[];
  experimentIds: EntityId[];
  runIds: EntityId[];
}

export interface ExperimentRepresentativeRunRepository {
  listRepresentativeRuns(experimentId: EntityId): Promise<RepresentativeRunRelation[]>;
  addRepresentativeRun(
    input: AddRepresentativeRunRepositoryInput
  ): Promise<RepresentativeRunRelation>;
  removeRepresentativeRun(
    input: RemoveRepresentativeRunRepositoryInput
  ): Promise<RepresentativeRunRelation>;
  setRepresentativeRunOrder(
    input: SetRepresentativeRunOrderRepositoryInput
  ): Promise<SetRepresentativeRunOrderResult>;
  getRepresentativeRunAggregate(experimentId: EntityId): Promise<RepresentativeRunAggregate>;
  cleanupRepresentativeRunRelations(
    input: CleanupRepresentativeRunRelationsRepositoryInput
  ): Promise<CleanupRepresentativeRunRelationsResult>;
}
