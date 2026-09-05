import type { EntityId, ISODateString } from "./common";
import type { OperationImpactSummary, OperationSource } from "./operationLog";
import type { RefreshKey, WriteFeedbackStatus } from "./writeFeedback";

export type RecycleEntityModule =
  | "planning"
  | "experiment"
  | "literature"
  | "output"
  | "outputConversion"
  | "review"
  | "global";

export type RestoreStatus =
  | "not_started"
  | "restored"
  | "permanently_deleted"
  | "blocked"
  | "unsupported";

export interface DeletedEntitySummary {
  recycleEntryId?: EntityId;
  entityType: string;
  entityId: EntityId;
  title: string;
  summary?: string;
  module: RecycleEntityModule;
  deletedAt: ISODateString;
  deletedBy?: OperationSource | string;
  operationLogId?: EntityId;
  canRestore: boolean;
  cannotRestoreReason?: string;
  knownImpactSummary?: OperationImpactSummary;
  restoreStatus: RestoreStatus;
  refreshKeys: RefreshKey[];
  createdByLifecycleActionId?: EntityId | null;
  terminalLifecycleActionId?: EntityId | null;
  revision?: number;
  lifecycleActionId?: EntityId;
  pendingLifecycleOperation?:
    | "review_soft_delete"
    | "review_restore"
    | "review_permanent_delete";
}

export interface RecycleEntry {
  id: EntityId;
  entityType: string;
  entityId: EntityId;
  title: string;
  summary?: string;
  module: RecycleEntityModule;
  entityDeletedAt: ISODateString;
  deletedBy: OperationSource | string;
  operationLogId?: EntityId;
  canRestore: boolean;
  cannotRestoreReason?: string;
  knownImpactSummary?: OperationImpactSummary;
  restoreStatus: RestoreStatus;
  refreshKeys: RefreshKey[];
  schemaVersion: number;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  deletedAt?: ISODateString | null;
  createdByLifecycleActionId?: EntityId | null;
  terminalLifecycleActionId?: EntityId | null;
  revision: number;
  terminalAt?: ISODateString | null;
}

export type RecycleEntryInput = Omit<
  RecycleEntry,
  | "id"
  | "createdAt"
  | "updatedAt"
  | "entityDeletedAt"
  | "deletedAt"
  | "restoreStatus"
  | "schemaVersion"
  | "refreshKeys"
  | "revision"
> & {
  id?: EntityId;
  deletedAt: ISODateString;
  restoreStatus?: RestoreStatus;
  refreshKeys?: RefreshKey[];
  schemaVersion?: number;
  createdAt?: ISODateString;
  updatedAt?: ISODateString;
  revision?: number;
};

export interface RecycleQuery {
  entityType?: string;
  entityId?: EntityId;
  module?: RecycleEntityModule | string;
  canRestore?: boolean;
  from?: ISODateString;
  to?: ISODateString;
  limit?: number;
}

export interface RestoreDeletedEntityInput {
  entityType: string;
  entityId: EntityId;
  confirmedByUser: boolean;
  operationLogId?: EntityId;
  recycleEntryId?: EntityId;
  lifecycleActionId?: EntityId;
  sourceDeleteActionId?: EntityId;
}

export interface PermanentlyDeleteEntityInput extends RestoreDeletedEntityInput {
  confirmationPhrase?: string;
}

export interface RecycleOperationResult {
  status: WriteFeedbackStatus;
  summary?: DeletedEntitySummary;
  reason?: string;
}
