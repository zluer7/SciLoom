import type { EntityId } from "./common";

export type DangerousOperationKind =
  | "delete"
  | "archive"
  | "restore"
  | "detach"
  | "convert"
  | "close"
  | "resolve"
  | "custom";

export type DangerousOperationRiskLevel = "low" | "medium" | "high" | "critical";

export type OperationImpactSeverity = "info" | "warning" | "blocking";

export interface OperationImpactItem {
  entityType: string;
  entityId?: EntityId;
  title: string;
  description?: string;
  severity: OperationImpactSeverity;
}

export interface OperationImpactTarget {
  type: string;
  id?: EntityId;
  title: string;
}

export interface OperationImpactPreview {
  operationId: string;
  operation: DangerousOperationKind;
  target: OperationImpactTarget;
  summary: string;
  riskLevel: DangerousOperationRiskLevel;
  executionKind: "soft-delete" | "archive" | "detach" | "status-change" | "other";
  isRecoverable: boolean;
  hasRestoreEntry: boolean;
  requiresUserConfirmation: boolean;
  canProceed: boolean;
  affectedEntityCount: number;
  affectedItems: OperationImpactItem[];
  warnings: string[];
  blockingReasons: string[];
  deepScanPerformed: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
}

export interface CreateOperationImpactPreviewInput
  extends Omit<
    OperationImpactPreview,
    "affectedEntityCount" | "affectedItems" | "warnings" | "blockingReasons"
  > {
  affectedItems?: OperationImpactItem[];
  warnings?: string[];
  blockingReasons?: string[];
}
