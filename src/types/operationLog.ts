import type { EntityId, ISODateString } from "./common";
import type { OperationImpactItem } from "./operationSafety";
import type {
  AffectedEntity,
  RefreshKey,
  WriteFeedbackStatus
} from "./writeFeedback";

export type OperationType =
  | "create"
  | "update"
  | "delete"
  | "archive"
  | "restore"
  | "permanently_delete"
  | "convert"
  | "ai_apply"
  | "link"
  | "unlink"
  | "status_change"
  | "settings_change"
  | "custom";

export type OperationSource =
  | "user"
  | "ai"
  | "ai_draft"
  | "ai_apply"
  | "conversion"
  | "system";

export type OperationModule =
  | "planning"
  | "experiment"
  | "literature"
  | "output"
  | "outputConversion"
  | "review"
  | "settings"
  | "ai"
  | "global";

export type OperationRiskLevel = "low" | "medium" | "high" | "critical";

export type OperationStatus = WriteFeedbackStatus;

export interface OperationTarget {
  entityType: string;
  entityId: EntityId;
  title?: string;
}

export interface OperationImpactSummary {
  affectedEntityCount: number;
  affectedItems: OperationImpactItem[];
  warnings: string[];
  blockingReasons: string[];
  deepScanPerformed: boolean;
}

export interface OperationConfirmationSummary {
  required: boolean;
  confirmedByUser: boolean;
  confirmedAt?: ISODateString;
  cancelledByUser?: boolean;
  confirmationId?: string;
  previewHash?: string;
  localFileSafetyAcknowledged?: boolean;
  metadataOnly?: boolean;
}

export interface OperationFeedbackSummary {
  status: WriteFeedbackStatus;
  message?: string;
  warnings: string[];
  errors: string[];
  skipped: string[];
  affectedEntities: AffectedEntity[];
  refreshKeys: RefreshKey[];
  details?: Record<string, unknown>;
}

export interface OperationLogEntry {
  id: EntityId;
  operationType: OperationType;
  source: OperationSource;
  module: OperationModule;
  status: OperationStatus;
  riskLevel: OperationRiskLevel;
  target: OperationTarget;
  summary: string;
  relatedEntities: AffectedEntity[];
  impactSummary?: OperationImpactSummary;
  confirmation?: OperationConfirmationSummary;
  feedback?: OperationFeedbackSummary;
  warnings: string[];
  errors: string[];
  skipped: string[];
  isRecoverable: boolean;
  recycleEntryId?: EntityId;
  actorId: string;
  actorLabel: string;
  refreshKeys: RefreshKey[];
  schemaVersion: number;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  deletedAt?: ISODateString | null;
  lifecycleActionId?: EntityId | null;
  effectType?: "review_lifecycle_operation_log" | null;
}

export type OperationLogInput = Omit<
  OperationLogEntry,
  | "id"
  | "createdAt"
  | "updatedAt"
  | "deletedAt"
  | "schemaVersion"
  | "refreshKeys"
  | "relatedEntities"
  | "warnings"
  | "errors"
  | "skipped"
  | "actorId"
  | "actorLabel"
> & {
  id?: EntityId;
  relatedEntities?: AffectedEntity[];
  warnings?: string[];
  errors?: string[];
  skipped?: string[];
  actorId?: string;
  actorLabel?: string;
  refreshKeys?: RefreshKey[];
  schemaVersion?: number;
  createdAt?: ISODateString;
  updatedAt?: ISODateString;
};

export interface OperationLogQuery {
  module?: OperationModule | string;
  source?: OperationSource | string;
  status?: OperationStatus;
  riskLevel?: OperationRiskLevel;
  operationType?: OperationType | string;
  entityType?: string;
  entityId?: EntityId;
  from?: ISODateString;
  to?: ISODateString;
  limit?: number;
}
