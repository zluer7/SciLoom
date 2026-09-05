import type { EntityId, ISODateString } from "./common";
import type {
  FileRefLocationMode,
  FileRefOwnerType,
  FileRefResourceKind,
  FileRefRole
} from "./experiment";
import type { ManuscriptBinding } from "./manuscriptBinding";
import type { ManuscriptChannel } from "./manuscriptChannel";

export const MANUSCRIPT_BINDING_IDENTITY_ERROR_CODES = {
  bindingNotFound: "MANUSCRIPT_BINDING_NOT_FOUND",
  bindingDeleted: "MANUSCRIPT_BINDING_DELETED",
  requiredSlotMissing: "MANUSCRIPT_BINDING_REQUIRED_SLOT_MISSING",
  fileRefNotFound: "MANUSCRIPT_BINDING_FILE_REF_NOT_FOUND",
  fileRefDeleted: "MANUSCRIPT_BINDING_FILE_REF_DELETED",
  ownerMismatch: "MANUSCRIPT_BINDING_OWNER_MISMATCH",
  channelMismatch: "MANUSCRIPT_BINDING_CHANNEL_MISMATCH",
  resourceKindMismatch: "MANUSCRIPT_BINDING_RESOURCE_KIND_MISMATCH",
  fileRoleMismatch: "MANUSCRIPT_BINDING_FILE_ROLE_MISMATCH",
  locationModeMismatch: "MANUSCRIPT_BINDING_LOCATION_MODE_MISMATCH",
  ownerScopeUnknown: "MANUSCRIPT_BINDING_OWNER_SCOPE_UNKNOWN",
  persistenceFailure: "MANUSCRIPT_BINDING_READ_FAILED",
  readbackFailure: "MANUSCRIPT_BINDING_READBACK_FAILED",
  staleExpectedState: "MANUSCRIPT_BINDING_STALE_EXPECTED_STATE",
  transactionFailure: "MANUSCRIPT_BINDING_TRANSACTION_FAILED"
} as const;

export type ManuscriptBindingIdentityErrorCode =
  (typeof MANUSCRIPT_BINDING_IDENTITY_ERROR_CODES)[keyof typeof MANUSCRIPT_BINDING_IDENTITY_ERROR_CODES];

export type ManuscriptBindingSlot =
  | "defaultFolderFileRefId"
  | "defaultManuscriptFileRefId"
  | "currentFileRefId";

export type ManuscriptOwnerLifecycleStatus = "active" | "deleted" | "unknown";

export interface ManuscriptOwnerLifecycleScope {
  status: ManuscriptOwnerLifecycleStatus;
  source: string;
  verifiedAt?: ISODateString;
}

export interface ManuscriptBindingIdentityKey {
  ownerType: FileRefOwnerType;
  ownerId: EntityId;
  manuscriptChannel: ManuscriptChannel;
}

export interface BindingFileRefIdentityMetadata {
  id: EntityId;
  ownerType: FileRefOwnerType;
  ownerId: EntityId;
  manuscriptChannel: ManuscriptChannel;
  resourceKind: FileRefResourceKind;
  fileRole: FileRefRole;
  locationMode: FileRefLocationMode;
  deletedAt?: ISODateString | null;
}

export interface ManuscriptBindingSlotResolution {
  slot: ManuscriptBindingSlot;
  fileRefId: EntityId | null;
  fileRef?: BindingFileRefIdentityMetadata;
  status: "resolved" | "missing" | "metadata-not-found" | "metadata-deleted" | "invalid";
  errors: ManuscriptBindingIdentityErrorCode[];
}

export interface ManuscriptBindingIdentityProvenance {
  binding: "sqlite.manuscript_bindings";
  fileRefs: "sqlite.file_refs.metadata";
  readMode: "authoritative-read-only";
  availability: "not-checked";
  fallback: "none";
}

interface ManuscriptBindingIdentityResultBase {
  key: ManuscriptBindingIdentityKey;
  ownerScope: ManuscriptOwnerLifecycleScope;
  binding?: ManuscriptBinding;
  slots: Record<ManuscriptBindingSlot, ManuscriptBindingSlotResolution>;
  provenance: ManuscriptBindingIdentityProvenance;
  warnings: ManuscriptBindingIdentityErrorCode[];
  errors: ManuscriptBindingIdentityErrorCode[];
}

export type ManuscriptBindingIdentityResult =
  | (ManuscriptBindingIdentityResultBase & {
      status: "resolved";
      identityResolved: true;
      binding: ManuscriptBinding;
      errors: [];
    })
  | (ManuscriptBindingIdentityResultBase & {
      status: "not-found" | "invalid" | "error";
      identityResolved: false;
    });

export interface ExpectedManuscriptBindingState {
  exists: boolean;
  updatedAt?: ISODateString;
  defaultFolderFileRefId: EntityId | null;
  defaultManuscriptFileRefId: EntityId | null;
  currentFileRefId: EntityId | null;
}

export type ManuscriptBindingWriteOperation =
  | "ensure"
  | "upsertDefaults"
  | "setDefaultFolder"
  | "setDefaultManuscript"
  | "setCurrent"
  | "clearDefaultFolder"
  | "clearDefaultManuscript"
  | "clearCurrent"
  | "remove";

export interface WriteManuscriptBindingInput extends ManuscriptBindingIdentityKey {
  operation: ManuscriptBindingWriteOperation;
  bindingId?: EntityId;
  fileRefId?: EntityId;
  defaultFolderFileRefId?: EntityId;
  defaultManuscriptFileRefId?: EntityId;
  expected: ExpectedManuscriptBindingState;
  occurredAt: ISODateString;
}

export interface WriteManuscriptBindingRepositoryResult {
  changed: boolean;
  binding?: ManuscriptBinding;
}
