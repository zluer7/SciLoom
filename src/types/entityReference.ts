import type { EntityId } from "./common";

export type EntityReferenceStatus =
  | "valid"
  | "missing"
  | "unsupported_type"
  | "invalid_id"
  | "type_mismatch"
  | "error";

export type EntityReferenceOrigin =
  | "entityLink"
  | "literatureLink"
  | "context"
  | "ai"
  | "manual"
  | "system";

export type EntityReferenceModule =
  | "planning"
  | "experiment"
  | "literature"
  | "outputConversion"
  | "output";

export interface EntityReference {
  targetType: string;
  targetId: EntityId;
  sourceType?: string;
  sourceId?: EntityId;
  relationType?: string;
  origin?: EntityReferenceOrigin;
}

export interface ResolvedEntitySummary {
  id: EntityId;
  type: string;
  module: EntityReferenceModule;
  title?: string;
  label: string;
  status?: string;
}

export interface EntityReferenceResolution {
  reference: EntityReference;
  status: EntityReferenceStatus;
  exists: boolean;
  supported: boolean;
  resolved?: ResolvedEntitySummary;
  warningCode?: string;
  message?: string;
}

export type MissingEntityReferenceReason =
  | "target_not_found"
  | "unsupported_target_type"
  | "invalid_target_id"
  | "resolver_error"
  | "type_mismatch";

export interface MissingEntityReference {
  sourceType?: string;
  sourceId?: EntityId;
  targetType: string;
  targetId: EntityId;
  relationType?: string;
  reason: MissingEntityReferenceReason;
  message?: string;
}

export interface EntityReferenceValidationResult {
  valid: boolean;
  resolution: EntityReferenceResolution;
  missingReference?: MissingEntityReference;
  warnings: string[];
}

export interface EntityReferenceTypeRegistryEntry {
  targetType: string;
  module: EntityReferenceModule;
  canonicalType?: string;
  aliases?: string[];
  description?: string;
}

export type LinkWriteValidationIssueCode =
  | "invalid_source"
  | "invalid_target"
  | "unsupported_source_type"
  | "unsupported_target_type"
  | "invalid_relation_type"
  | "duplicate_link"
  | "write_failed";

export interface LinkWriteValidationIssue {
  code: LinkWriteValidationIssueCode;
  message: string;
  sourceType?: string;
  sourceId?: EntityId;
  targetType?: string;
  targetId?: EntityId;
  relationType?: string;
}

export interface LinkWriteResult<TLink = unknown> {
  ok: boolean;
  link?: TLink;
  existing?: TLink;
  skipped?: boolean;
  issues: LinkWriteValidationIssue[];
}
