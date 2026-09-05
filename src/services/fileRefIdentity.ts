import type {
  FileRefOwnerType,
  FileRefLocationMode,
  FileRefResourceKind,
  FileRefRole
} from "../types/experiment";
import type { EntityId } from "../types/common";
import type { ManuscriptChannel } from "../types/manuscriptChannel";

export const FILE_REF_CONTRACT_ERROR_CODES = {
  invalidResourceKind: "INVALID_FILE_REF_RESOURCE_KIND",
  invalidRole: "INVALID_FILE_REF_ROLE",
  invalidLocationMode: "INVALID_FILE_REF_LOCATION_MODE",
  ownerNotFound: "FILE_REF_OWNER_NOT_FOUND",
  ownerDeleted: "FILE_REF_OWNER_DELETED",
  identityConflict: "FILE_REF_IDENTITY_CONFLICT",
  crossOwnerManagedPathConflict: "FILE_REF_CROSS_OWNER_MANAGED_PATH_CONFLICT",
  deletedIdentity: "FILE_REF_DELETED_IDENTITY",
  pathIdentityInvalid: "PATH_IDENTITY_INVALID",
  readbackFailed: "FILE_REF_READBACK_FAILED",
  identityFieldImmutable: "FILE_REF_IDENTITY_FIELD_IMMUTABLE",
  bindingOwnerNotFound: "MANUSCRIPT_BINDING_OWNER_NOT_FOUND",
  bindingRefNotFound: "MANUSCRIPT_BINDING_REF_NOT_FOUND",
  bindingOwnerMismatch: "MANUSCRIPT_BINDING_OWNER_MISMATCH",
  invalidDefaultFolder: "MANUSCRIPT_BINDING_INVALID_DEFAULT_FOLDER",
  invalidDefaultManuscript: "MANUSCRIPT_BINDING_INVALID_DEFAULT_MANUSCRIPT",
  invalidCurrentManuscript: "MANUSCRIPT_BINDING_INVALID_CURRENT_MANUSCRIPT",
  inUseByBinding: "FILE_REF_IN_USE_BY_MANUSCRIPT_BINDING"
} as const;

export type FileRefContractErrorCode =
  (typeof FILE_REF_CONTRACT_ERROR_CODES)[keyof typeof FILE_REF_CONTRACT_ERROR_CODES];

export class FileRefContractError extends Error {
  readonly code: FileRefContractErrorCode;

  constructor(code: FileRefContractErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "FileRefContractError";
    this.code = code;
  }
}

export interface FileRefIdentityContractInput {
  resourceKind: FileRefResourceKind;
  fileRole: FileRefRole;
  locationMode: FileRefLocationMode;
}

export type ManuscriptBindingRefField =
  | "defaultFolderFileRefId"
  | "defaultManuscriptFileRefId"
  | "currentFileRefId";

export interface ManuscriptBindingOwnerRef {
  ownerType: FileRefOwnerType;
  ownerId: EntityId;
  manuscriptChannel: ManuscriptChannel;
}

export interface ManuscriptBindingFileRef extends ManuscriptBindingOwnerRef {
  id: EntityId;
  resourceKind: FileRefResourceKind;
  fileRole: FileRefRole;
  locationMode: FileRefLocationMode;
  manuscriptChannel: ManuscriptChannel;
  deletedAt?: string | null;
}

const FILE_REF_OWNER_TYPES: FileRefOwnerType[] = [
  "experiment",
  "experimentRun",
  "literature",
  "review",
  "resultItem",
  "finding",
  "outputCandidate",
  "outputGap",
  "researchOutput"
];

export function isFileRefOwnerType(value: string): value is FileRefOwnerType {
  return FILE_REF_OWNER_TYPES.includes(value as FileRefOwnerType);
}

export function assertFileRefOwnerRecord(
  ownerType: string,
  ownerId: EntityId,
  entity: { id: EntityId; deletedAt?: string | null } | undefined,
  requireActive = true
) {
  if (!isFileRefOwnerType(ownerType) || !ownerId?.trim() || !entity) {
    throw new FileRefContractError(
      FILE_REF_CONTRACT_ERROR_CODES.ownerNotFound,
      `FileRef owner not found: ${ownerType}/${ownerId}.`
    );
  }
  if (requireActive && entity.deletedAt) {
    throw new FileRefContractError(
      FILE_REF_CONTRACT_ERROR_CODES.ownerDeleted,
      `FileRef owner is deleted: ${ownerType}/${ownerId}.`
    );
  }
  return { ownerType, ownerId, entity };
}

export function createFileRefOwnerValidator(
  loadOwner: (
    ownerType: FileRefOwnerType,
    ownerId: EntityId
  ) => Promise<{ id: EntityId; deletedAt?: string | null } | undefined>
) {
  return async function validateOwner(
    ownerType: FileRefOwnerType | string,
    ownerId: EntityId,
    options: { requireActive?: boolean } = { requireActive: true }
  ) {
    if (!isFileRefOwnerType(ownerType)) {
      return assertFileRefOwnerRecord(ownerType, ownerId, undefined);
    }
    const entity = await loadOwner(ownerType, ownerId);
    return assertFileRefOwnerRecord(
      ownerType,
      ownerId,
      entity,
      options.requireActive !== false
    );
  };
}

export function createPathIdentityKey(input: string) {
  let value = input.trim().normalize("NFC");
  if (!value) {
    throw new FileRefContractError(
      FILE_REF_CONTRACT_ERROR_CODES.pathIdentityInvalid,
      "Path identity requires a non-empty path."
    );
  }
  if (/^file:/i.test(value)) {
    try {
      const url = new URL(value);
      const decodedPath = decodeURIComponent(url.pathname);
      value = url.hostname ? `//${url.hostname}${decodedPath}` : decodedPath;
      if (/^\/[a-zA-Z]:\//.test(value)) value = value.slice(1);
    } catch {
      value = value.replace(/^file:\/\/*/i, "");
    }
  }

  // Windows canonicalization commonly returns extended-length paths. They
  // identify the same file as their ordinary drive/UNC forms and must not
  // create a second FileRef identity.
  value = value
    .replace(/^\\\\\?\\UNC\\/iu, "\\\\")
    .replace(/^\\\\\?\\/u, "")
    .replace(/^\/\/\?\/UNC\//iu, "//")
    .replace(/^\/\/\?\//u, "");

  const unc = /^(?:\\\\|\/\/)/.test(value);
  try {
    value = decodeURIComponent(value);
  } catch {
    // Keep literal percent sequences stable when the input is not valid URI encoding.
  }
  value = value.normalize("NFC").replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (unc) value = `//${value.replace(/^\/+/, "")}`;

  const prefix = value.startsWith("//")
    ? "//"
    : /^[a-zA-Z]:\//.test(value)
      ? value.slice(0, 3)
      : value.startsWith("/")
        ? "/"
        : "";
  const body = prefix === "//"
    ? value.slice(2)
    : prefix.length === 3
      ? value.slice(3)
      : prefix === "/"
        ? value.slice(1)
        : value;
  const segments: string[] = [];
  for (const segment of body.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length > 0 && segments[segments.length - 1] !== "..") {
        segments.pop();
      } else if (!prefix) {
        segments.push(segment);
      }
      continue;
    }
    segments.push(segment);
  }

  value = prefix === "//"
    ? `//${segments.join("/")}`
    : prefix.length === 3
      ? `${prefix}${segments.join("/")}`
      : prefix === "/"
        ? `/${segments.join("/")}`
        : segments.join("/");
  if (value.length > 1 && !/^[a-zA-Z]:\/$/.test(value)) value = value.replace(/\/+$/, "");
  if (/^[a-zA-Z]:\//.test(value) || value.startsWith("//")) value = value.toLocaleLowerCase("en-US");
  if (!value) {
    throw new FileRefContractError(
      FILE_REF_CONTRACT_ERROR_CODES.pathIdentityInvalid,
      "Path identity normalization produced an empty path."
    );
  }
  return value.normalize("NFC");
}

export function validateFileRefIdentityContract(input: FileRefIdentityContractInput) {
  const errors: FileRefContractErrorCode[] = [];
  if (input.resourceKind !== "file" && input.resourceKind !== "folder") {
    errors.push(FILE_REF_CONTRACT_ERROR_CODES.invalidResourceKind);
  }
  if (
    input.fileRole !== "manuscript" &&
    input.fileRole !== "defaultFolder" &&
    input.fileRole !== "attachment"
  ) {
    errors.push(FILE_REF_CONTRACT_ERROR_CODES.invalidRole);
  }
  if (input.locationMode !== "managed" && input.locationMode !== "external") {
    errors.push(FILE_REF_CONTRACT_ERROR_CODES.invalidLocationMode);
  }
  if (input.fileRole === "manuscript" && input.resourceKind !== "file") {
    errors.push(FILE_REF_CONTRACT_ERROR_CODES.invalidResourceKind);
  }
  if (input.fileRole === "defaultFolder") {
    if (input.resourceKind !== "folder") {
      errors.push(FILE_REF_CONTRACT_ERROR_CODES.invalidRole);
    }
    if (input.locationMode !== "managed") {
      errors.push(FILE_REF_CONTRACT_ERROR_CODES.invalidRole);
    }
  }
  return [...new Set(errors)];
}

export function validateManuscriptBindingReference(
  field: ManuscriptBindingRefField,
  owner: ManuscriptBindingOwnerRef,
  fileRef: ManuscriptBindingFileRef | undefined
) {
  const errors: FileRefContractErrorCode[] = [];
  if (!fileRef || fileRef.deletedAt) {
    errors.push(FILE_REF_CONTRACT_ERROR_CODES.bindingRefNotFound);
    return errors;
  }
  if (fileRef.ownerType !== owner.ownerType || fileRef.ownerId !== owner.ownerId) {
    errors.push(FILE_REF_CONTRACT_ERROR_CODES.bindingOwnerMismatch);
  }
  if (
    field !== "defaultFolderFileRefId" &&
    (fileRef.manuscriptChannel ?? "primary") !== (owner.manuscriptChannel ?? "primary")
  ) {
    errors.push(FILE_REF_CONTRACT_ERROR_CODES.bindingOwnerMismatch);
  }
  if (
    field === "defaultFolderFileRefId" &&
    !(
      fileRef.resourceKind === "folder" &&
      fileRef.fileRole === "defaultFolder" &&
      fileRef.locationMode === "managed"
    )
  ) {
    errors.push(FILE_REF_CONTRACT_ERROR_CODES.invalidDefaultFolder);
  }
  if (
    field === "defaultManuscriptFileRefId" &&
    !(
      fileRef.resourceKind === "file" &&
      fileRef.fileRole === "manuscript" &&
      fileRef.locationMode === "managed"
    )
  ) {
    errors.push(FILE_REF_CONTRACT_ERROR_CODES.invalidDefaultManuscript);
  }
  if (
    field === "currentFileRefId" &&
    !(fileRef.resourceKind === "file" && fileRef.fileRole === "manuscript")
  ) {
    errors.push(FILE_REF_CONTRACT_ERROR_CODES.invalidCurrentManuscript);
  }
  return [...new Set(errors)];
}

export function assertFileRefIdentityContract(input: FileRefIdentityContractInput) {
  const [error] = validateFileRefIdentityContract(input);
  if (error) throw new FileRefContractError(error, "Invalid FileRef kind, role, and location combination.");
}
