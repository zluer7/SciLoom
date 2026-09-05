import {
  MANUSCRIPT_OPERATION_ERROR_CODES,
  type DurableFileIdentity,
  type EphemeralFileIdentity,
  type FileIdentity,
  type ManuscriptLocationMode,
  type ManuscriptOperationErrorCode,
  type ManuscriptPendingLocationMode,
  type OwnerIdentity
} from "../types/manuscriptOperation";
import { createPathIdentityKey } from "./fileRefIdentity";
import {
  getPathDisplayName,
  isLikelyAbsoluteLocalPath,
  normalizePathInput
} from "./localPathService";

export class ManuscriptIdentityError extends Error {
  readonly code: ManuscriptOperationErrorCode;

  constructor(code: ManuscriptOperationErrorCode) {
    super(code);
    this.name = "ManuscriptIdentityError";
    this.code = code;
  }
}

export interface EphemeralFileIdentityInput {
  absolutePath: string;
  locationMode: ManuscriptPendingLocationMode;
  configuredRoot?: string;
  identityToken?: string;
}

export interface DurableFileIdentityInput {
  fileRefId: string;
  absolutePath: string;
  pathIdentity: string;
  fileName: string;
  locationMode: ManuscriptLocationMode;
  resourceKind: "file";
  fileRole: "manuscript";
  configuredRoot?: string;
}

function requireText(value: string | undefined, code: ManuscriptOperationErrorCode) {
  const normalized = value?.trim().normalize("NFC");
  if (!normalized) throw new ManuscriptIdentityError(code);
  return normalized;
}

function hashIdentity(value: string) {
  const bytes = new TextEncoder().encode(value);
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function assertMarkdownFileName(fileName: string) {
  if (!/\.md$/i.test(fileName) && !/\.markdown$/i.test(fileName)) {
    throw new ManuscriptIdentityError(
      MANUSCRIPT_OPERATION_ERROR_CODES.extensionUnsupported
    );
  }
}

function resolveAbsolutePath(input: string) {
  const absolutePath = normalizePathInput(
    requireText(input, MANUSCRIPT_OPERATION_ERROR_CODES.invalidFileIdentity)
  );
  if (!isLikelyAbsoluteLocalPath(absolutePath)) {
    throw new ManuscriptIdentityError(
      MANUSCRIPT_OPERATION_ERROR_CODES.pathNotAbsolute
    );
  }
  return absolutePath;
}

function sameOwner(left: OwnerIdentity, right: OwnerIdentity) {
  return left.ownerType === right.ownerType &&
    left.ownerId === right.ownerId &&
    left.channel === right.channel;
}

export function createManuscriptIdentityResolver() {
  function resolveOwner(input: OwnerIdentity): OwnerIdentity {
    return Object.freeze({
      ownerType: requireText(
        input.ownerType,
        MANUSCRIPT_OPERATION_ERROR_CODES.invalidOwnerIdentity
      ),
      ownerId: requireText(
        input.ownerId,
        MANUSCRIPT_OPERATION_ERROR_CODES.invalidOwnerIdentity
      ),
      channel: requireText(
        input.channel,
        MANUSCRIPT_OPERATION_ERROR_CODES.invalidOwnerIdentity
      ) as OwnerIdentity["channel"]
    });
  }

  function resolveEphemeralFile(
    input: EphemeralFileIdentityInput
  ): EphemeralFileIdentity {
    const absolutePath = resolveAbsolutePath(input.absolutePath);
    const pathIdentity = createPathIdentityKey(absolutePath);
    const fileName = getPathDisplayName(absolutePath).normalize("NFC");
    assertMarkdownFileName(fileName);
    if (
      input.locationMode !== "managed" &&
      input.locationMode !== "external" &&
      input.locationMode !== "pending"
    ) {
      throw new ManuscriptIdentityError(
        MANUSCRIPT_OPERATION_ERROR_CODES.invalidFileIdentity
      );
    }
    const identityToken = input.identityToken === undefined
      ? hashIdentity(`${input.locationMode}\u0000${pathIdentity}`)
      : requireText(
          input.identityToken,
          MANUSCRIPT_OPERATION_ERROR_CODES.invalidFileIdentity
        );
    return Object.freeze({
      kind: "ephemeral",
      identityToken,
      absolutePath,
      pathIdentity,
      fileName,
      locationMode: input.locationMode,
      resourceKind: "file",
      fileRole: "manuscript",
      fileType: "markdown",
      configuredRoot: input.configuredRoot?.trim() || undefined
    });
  }

  function resolveDurableFile(
    input: DurableFileIdentityInput
  ): DurableFileIdentity {
    const absolutePath = resolveAbsolutePath(input.absolutePath);
    const pathIdentity = createPathIdentityKey(absolutePath);
    if (pathIdentity !== createPathIdentityKey(input.pathIdentity)) {
      throw new ManuscriptIdentityError(
        MANUSCRIPT_OPERATION_ERROR_CODES.pathIdentityMismatch
      );
    }
    const fileName = requireText(
      input.fileName,
      MANUSCRIPT_OPERATION_ERROR_CODES.invalidFileIdentity
    );
    if (fileName.normalize("NFC") !== getPathDisplayName(absolutePath).normalize("NFC")) {
      throw new ManuscriptIdentityError(
        MANUSCRIPT_OPERATION_ERROR_CODES.pathIdentityMismatch
      );
    }
    assertMarkdownFileName(fileName);
    if (
      input.resourceKind !== "file" ||
      input.fileRole !== "manuscript" ||
      (input.locationMode !== "managed" && input.locationMode !== "external")
    ) {
      throw new ManuscriptIdentityError(
        MANUSCRIPT_OPERATION_ERROR_CODES.invalidFileIdentity
      );
    }
    return Object.freeze({
      kind: "durable",
      fileRefId: requireText(
        input.fileRefId,
        MANUSCRIPT_OPERATION_ERROR_CODES.invalidFileIdentity
      ),
      absolutePath,
      pathIdentity,
      fileName,
      locationMode: input.locationMode,
      resourceKind: "file",
      fileRole: "manuscript",
      fileType: "markdown",
      configuredRoot: input.configuredRoot?.trim() || undefined
    });
  }

  function assertFile(file: FileIdentity): FileIdentity {
    if (file.kind === "durable") {
      return resolveDurableFile(file);
    }
    const resolved = resolveEphemeralFile(file);
    if (
      resolved.pathIdentity !== file.pathIdentity ||
      resolved.fileName !== file.fileName.normalize("NFC")
    ) {
      throw new ManuscriptIdentityError(
        MANUSCRIPT_OPERATION_ERROR_CODES.pathIdentityMismatch
      );
    }
    if (
      file.resourceKind !== "file" ||
      file.fileRole !== "manuscript" ||
      file.fileType !== "markdown"
    ) {
      throw new ManuscriptIdentityError(
        MANUSCRIPT_OPERATION_ERROR_CODES.invalidFileIdentity
      );
    }
    return resolved;
  }

  function isSamePhysicalFile(left: FileIdentity, right: FileIdentity) {
    return left.pathIdentity === right.pathIdentity;
  }

  return {
    resolveOwner,
    resolveEphemeralFile,
    resolveDurableFile,
    assertFile,
    isSamePhysicalFile,
    isSameOwner: sameOwner
  };
}

export type ManuscriptIdentityResolver = ReturnType<
  typeof createManuscriptIdentityResolver
>;

export const manuscriptIdentityResolver = createManuscriptIdentityResolver();
