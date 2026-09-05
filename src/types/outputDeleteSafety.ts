import type { EntityId, ISODateString } from "./common";

export type OutputDeleteSafetyLayer =
  | "resultItem"
  | "finding"
  | "outputCandidate"
  | "outputGap"
  | "researchOutput";

export type OutputDeleteSafetyMode =
  | "softDelete"
  | "restore"
  | "permanentDelete";

export interface OutputDeleteAffectedCounts {
  internalRelations: number;
  downstreamEntities: number;
  upstreamSources: number;
  entityLinks: number;
  fileRefs: number;
  manuscriptBindings: number;
  manuscripts: number;
  manuscriptCandidates: number;
  attachments: number;
  feedbackCards: number;
  structuredSummaries: number;
}

export interface OutputDeleteAffectedItem {
  type: string;
  id: EntityId;
  title?: string;
  relation?: string;
  action: "softDelete" | "detach" | "keepMetadata" | "metadataOnly" | "blocked";
  summary: string;
}

export interface OutputDeleteImpactPreview {
  layer: OutputDeleteSafetyLayer;
  id: EntityId;
  title: string;
  mode: OutputDeleteSafetyMode;
  recycleBinId?: EntityId;
  canDelete: boolean;
  severity: "low" | "medium" | "high" | "blocked";
  affectedCounts: OutputDeleteAffectedCounts;
  affectedItems: OutputDeleteAffectedItem[];
  fileRefWarnings: string[];
  localFileSafetyNotice: string;
  warnings: string[];
  previewHash: string;
}

export interface OutputDeleteConfirmation {
  layer: OutputDeleteSafetyLayer;
  id: EntityId;
  mode: OutputDeleteSafetyMode;
  confirmedByUser: true;
  confirmedAt: ISODateString;
  previewHash: string;
  recycleBinId?: EntityId;
  localFileSafetyAcknowledged: true;
}

export interface OutputDeleteRefreshHints {
  refreshLists: boolean;
  refreshDetail: boolean;
  refreshChains: boolean;
  refreshRelations: boolean;
  refreshFileRefs: boolean;
  refreshRecycleBin: boolean;
}

export interface OutputDeleteSafetyResult {
  ok: boolean;
  status: "success" | "skipped" | "partial";
  operation: OutputDeleteSafetyMode;
  layer: OutputDeleteSafetyLayer;
  id: EntityId;
  title: string;
  operationLogId?: EntityId;
  recycleBinId?: EntityId;
  refreshHints: OutputDeleteRefreshHints;
  warnings: string[];
  skipped: string[];
  retryable?: boolean;
}

export interface PreviewOutputDeleteInput {
  layer: OutputDeleteSafetyLayer;
  id: EntityId;
  mode?: OutputDeleteSafetyMode;
  recycleBinId?: EntityId;
}

export interface ExecuteOutputDeleteInput {
  confirmation: OutputDeleteConfirmation;
}
