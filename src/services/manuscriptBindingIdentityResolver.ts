import { manuscriptBindingRepository } from "../repositories/manuscriptBindingRepository";
import type {
  BindingFileRefIdentityMetadata,
  EntityId,
  FileRefOwnerType,
  ManuscriptBinding,
  ManuscriptBindingIdentityErrorCode,
  ManuscriptBindingIdentityResult,
  ManuscriptBindingSlot,
  ManuscriptBindingSlotResolution,
  ManuscriptChannel
} from "../types";
import { MANUSCRIPT_BINDING_IDENTITY_ERROR_CODES } from "../types";
import { assertValidManuscriptChannelForOwner } from "../types/manuscriptChannel";

const PROVENANCE = Object.freeze({
  binding: "sqlite.manuscript_bindings" as const,
  fileRefs: "sqlite.file_refs.metadata" as const,
  readMode: "authoritative-read-only" as const,
  availability: "not-checked" as const,
  fallback: "none" as const
});

const SLOT_ORDER: ManuscriptBindingSlot[] = [
  "defaultFolderFileRefId",
  "defaultManuscriptFileRefId",
  "currentFileRefId"
];

export interface ManuscriptBindingIdentityResolverDependencies {
  readIdentityRecords: typeof manuscriptBindingRepository.readIdentityRecords;
}

export interface ResolveManuscriptBindingIdentityInput {
  ownerType: FileRefOwnerType;
  ownerId: EntityId;
  manuscriptChannel?: ManuscriptChannel;
}

function emptySlots(): Record<ManuscriptBindingSlot, ManuscriptBindingSlotResolution> {
  return {
    defaultFolderFileRefId: {
      slot: "defaultFolderFileRefId",
      fileRefId: null,
      status: "missing",
      errors: []
    },
    defaultManuscriptFileRefId: {
      slot: "defaultManuscriptFileRefId",
      fileRefId: null,
      status: "missing",
      errors: []
    },
    currentFileRefId: {
      slot: "currentFileRefId",
      fileRefId: null,
      status: "missing",
      errors: []
    }
  };
}

function validateSlot(
  binding: ManuscriptBinding,
  slot: ManuscriptBindingSlot,
  fileRefId: EntityId | null,
  fileRef: BindingFileRefIdentityMetadata | undefined
): ManuscriptBindingSlotResolution {
  const errors: ManuscriptBindingIdentityErrorCode[] = [];
  if (!fileRefId) {
    errors.push(MANUSCRIPT_BINDING_IDENTITY_ERROR_CODES.requiredSlotMissing);
    return { slot, fileRefId: null, status: "missing", errors };
  }
  if (!fileRef) {
    errors.push(MANUSCRIPT_BINDING_IDENTITY_ERROR_CODES.fileRefNotFound);
    return { slot, fileRefId, status: "metadata-not-found", errors };
  }
  if (fileRef.deletedAt) {
    errors.push(MANUSCRIPT_BINDING_IDENTITY_ERROR_CODES.fileRefDeleted);
    return { slot, fileRefId, fileRef, status: "metadata-deleted", errors };
  }
  if (fileRef.ownerType !== binding.ownerType || fileRef.ownerId !== binding.ownerId) {
    errors.push(MANUSCRIPT_BINDING_IDENTITY_ERROR_CODES.ownerMismatch);
  }
  if (slot !== "defaultFolderFileRefId" && fileRef.manuscriptChannel !== binding.manuscriptChannel) {
    errors.push(MANUSCRIPT_BINDING_IDENTITY_ERROR_CODES.channelMismatch);
  }
  if (slot === "defaultFolderFileRefId") {
    if (fileRef.resourceKind !== "folder") {
      errors.push(MANUSCRIPT_BINDING_IDENTITY_ERROR_CODES.resourceKindMismatch);
    }
    if (fileRef.fileRole !== "defaultFolder") {
      errors.push(MANUSCRIPT_BINDING_IDENTITY_ERROR_CODES.fileRoleMismatch);
    }
    if (fileRef.locationMode !== "managed") {
      errors.push(MANUSCRIPT_BINDING_IDENTITY_ERROR_CODES.locationModeMismatch);
    }
  } else {
    if (fileRef.resourceKind !== "file") {
      errors.push(MANUSCRIPT_BINDING_IDENTITY_ERROR_CODES.resourceKindMismatch);
    }
    if (fileRef.fileRole !== "manuscript") {
      errors.push(MANUSCRIPT_BINDING_IDENTITY_ERROR_CODES.fileRoleMismatch);
    }
    if (
      slot === "defaultManuscriptFileRefId" &&
      fileRef.locationMode !== "managed"
    ) {
      errors.push(MANUSCRIPT_BINDING_IDENTITY_ERROR_CODES.locationModeMismatch);
    }
    if (
      slot === "currentFileRefId" &&
      fileRef.locationMode !== "managed" &&
      fileRef.locationMode !== "external"
    ) {
      errors.push(MANUSCRIPT_BINDING_IDENTITY_ERROR_CODES.locationModeMismatch);
    }
  }
  return {
    slot,
    fileRefId,
    fileRef,
    status: errors.length === 0 ? "resolved" : "invalid",
    errors: [...new Set(errors)]
  };
}

function errorCode(error: unknown): ManuscriptBindingIdentityErrorCode {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes(MANUSCRIPT_BINDING_IDENTITY_ERROR_CODES.staleExpectedState)) {
    return MANUSCRIPT_BINDING_IDENTITY_ERROR_CODES.staleExpectedState;
  }
  if (message.includes("READBACK")) {
    return MANUSCRIPT_BINDING_IDENTITY_ERROR_CODES.readbackFailure;
  }
  return MANUSCRIPT_BINDING_IDENTITY_ERROR_CODES.persistenceFailure;
}

export function createManuscriptBindingIdentityResolver(
  dependencies: ManuscriptBindingIdentityResolverDependencies = manuscriptBindingRepository
) {
  return async function resolveManuscriptBindingIdentity(
    input: ResolveManuscriptBindingIdentityInput
  ): Promise<ManuscriptBindingIdentityResult> {
    const manuscriptChannel = assertValidManuscriptChannelForOwner(
      input.ownerType,
      input.manuscriptChannel
    );
    const key = {
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      manuscriptChannel
    };
    const resolvedOwnerScope = {
      status: "unknown" as const,
      source: "not-provided"
    };
    const warnings = [MANUSCRIPT_BINDING_IDENTITY_ERROR_CODES.ownerScopeUnknown];
    try {
      const records = await dependencies.readIdentityRecords(
        input.ownerType,
        input.ownerId,
        manuscriptChannel
      );
      const binding = records.binding;
      if (!binding) {
        return {
          status: "not-found",
          identityResolved: false,
          key,
          ownerScope: resolvedOwnerScope,
          slots: emptySlots(),
          provenance: PROVENANCE,
          warnings,
          errors: [MANUSCRIPT_BINDING_IDENTITY_ERROR_CODES.bindingNotFound]
        };
      }
      if (binding.deletedAt) {
        return {
          status: "invalid",
          identityResolved: false,
          key,
          ownerScope: resolvedOwnerScope,
          binding,
          slots: emptySlots(),
          provenance: PROVENANCE,
          warnings,
          errors: [MANUSCRIPT_BINDING_IDENTITY_ERROR_CODES.bindingDeleted]
        };
      }
      const refs = new Map(records.fileRefs.map((fileRef) => [fileRef.id, fileRef]));
      const slots = SLOT_ORDER.reduce<Record<ManuscriptBindingSlot, ManuscriptBindingSlotResolution>>(
        (result, slot) => {
          const fileRefId = binding[slot] ?? null;
          result[slot] = validateSlot(
            binding,
            slot,
            fileRefId,
            fileRefId ? refs.get(fileRefId) : undefined
          );
          return result;
        },
        emptySlots()
      );
      const errors = [...new Set(SLOT_ORDER.flatMap((slot) => slots[slot].errors))];
      if (errors.length > 0) {
        return {
          status: "invalid",
          identityResolved: false,
          key,
          ownerScope: resolvedOwnerScope,
          binding,
          slots,
          provenance: PROVENANCE,
          warnings,
          errors
        };
      }
      return {
        status: "resolved",
        identityResolved: true,
        key,
        ownerScope: resolvedOwnerScope,
        binding,
        slots,
        provenance: PROVENANCE,
        warnings,
        errors: []
      };
    } catch (error) {
      return {
        status: "error",
        identityResolved: false,
        key,
        ownerScope: resolvedOwnerScope,
        slots: emptySlots(),
        provenance: PROVENANCE,
        warnings,
        errors: [errorCode(error)]
      };
    }
  };
}

export const resolveManuscriptBindingIdentity =
  createManuscriptBindingIdentityResolver();

export const manuscriptBindingIdentityResolver = {
  resolve: resolveManuscriptBindingIdentity
};
