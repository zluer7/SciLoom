import type { EntityId } from "../types/common";
import type { FileRef, FileRefOwnerType, ManuscriptBinding, ManuscriptChannel } from "../types";
import {
  MANUSCRIPT_IO_ERROR_CODES,
  type ManuscriptIoErrorCode,
  type ReadManuscriptByFileRefResult,
  type ReadCurrentManuscriptResult,
  type SaveManuscriptByFileRefResult,
  type SaveCurrentManuscriptResult
} from "../types/manuscriptIo";
import { createPathIdentityKey } from "./fileRefIdentity";
import { fileRefService } from "./fileRefService";
import { validateFileRefOwner } from "./fileRefOwnerValidator";
import { isLikelyAbsoluteLocalPath } from "./localPathService";
import { managedRootConfigService } from "./managedRootConfigService";
import { manuscriptBindingService } from "./manuscriptBindingService";
import { nativeManuscriptIoService } from "./nativeManuscriptIoService";

const errorCodes = Object.values(MANUSCRIPT_IO_ERROR_CODES);

export interface ManuscriptIoDependencies {
  validateOwner(ownerType: string, ownerId: EntityId): ReturnType<typeof validateFileRefOwner>;
  getBinding(ownerType: FileRefOwnerType, ownerId: EntityId, manuscriptChannel?: ManuscriptChannel): Promise<ManuscriptBinding | undefined>;
  getFileRef(id: EntityId): Promise<FileRef | undefined>;
  getDeletedFileRef(id: EntityId): Promise<FileRef | undefined>;
  getRootStatus(): ReturnType<typeof managedRootConfigService.getStatus>;
  readNative: typeof nativeManuscriptIoService.readManuscriptFile;
  writeNative: typeof nativeManuscriptIoService.writeCurrentManuscriptFileAtomic;
}

const defaultDependencies: ManuscriptIoDependencies = {
  validateOwner: validateFileRefOwner,
  getBinding: manuscriptBindingService.getBindingByOwner,
  getFileRef: fileRefService.getById,
  getDeletedFileRef: fileRefService.getDeletedById,
  getRootStatus: () => managedRootConfigService.getStatus(),
  readNative: nativeManuscriptIoService.readManuscriptFile,
  writeNative: nativeManuscriptIoService.writeCurrentManuscriptFileAtomic
};

function errorCodeFromUnknown(error: unknown, fallback: ManuscriptIoErrorCode) {
  const message = error instanceof Error ? error.message : String(error);
  return errorCodes.find((code) => message.includes(code)) ?? fallback;
}

function ownerError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("OWNER_DELETED")
    ? MANUSCRIPT_IO_ERROR_CODES.ownerDeleted
    : MANUSCRIPT_IO_ERROR_CODES.ownerNotFound;
}

function errorResult(
  ownerType: FileRefOwnerType,
  ownerId: EntityId,
  code: ManuscriptIoErrorCode,
  message: string,
  requestToken?: number
) {
  return {
    status: "error" as const,
    ownerType,
    ownerId,
    error: { code, message },
    warnings: [],
    requestToken
  };
}

type ResolvedManuscript = {
  binding: ManuscriptBinding;
  fileRef: FileRef;
  configuredRoot?: string;
};

async function resolveBinding(
  dependencies: ManuscriptIoDependencies,
  ownerType: FileRefOwnerType,
  ownerId: EntityId,
  manuscriptChannel: ManuscriptChannel = "primary"
) {
  try {
    await dependencies.validateOwner(ownerType, ownerId);
  } catch (error) {
    const code = ownerError(error);
    throw new Error(`${code}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const binding = await dependencies.getBinding(ownerType, ownerId, manuscriptChannel);
  if (!binding) {
    throw new Error(`${MANUSCRIPT_IO_ERROR_CODES.bindingNotFound}: Manuscript binding was not found.`);
  }
  if (binding.ownerType !== ownerType || binding.ownerId !== ownerId) {
    throw new Error(`${MANUSCRIPT_IO_ERROR_CODES.fileRefOwnerMismatch}: Manuscript binding owner does not match.`);
  }
  if (binding.manuscriptChannel !== manuscriptChannel) {
    throw new Error(`${MANUSCRIPT_IO_ERROR_CODES.fileRefChannelMismatch}: Manuscript binding channel does not match.`);
  }
  return binding;
}

async function resolveFileRef(
  dependencies: ManuscriptIoDependencies,
  ownerType: FileRefOwnerType,
  ownerId: EntityId,
  binding: ManuscriptBinding,
  fileRefId: EntityId
): Promise<ResolvedManuscript> {
  const fileRef = await dependencies.getFileRef(fileRefId);
  if (!fileRef) {
    const deleted = await dependencies.getDeletedFileRef(fileRefId);
    if (deleted) {
      throw new Error(`${MANUSCRIPT_IO_ERROR_CODES.fileRefDeleted}: Manuscript FileRef is deleted.`);
    }
    throw new Error(`${MANUSCRIPT_IO_ERROR_CODES.fileRefNotFound}: Manuscript FileRef was not found.`);
  }
  if (fileRef.deletedAt) {
    throw new Error(`${MANUSCRIPT_IO_ERROR_CODES.fileRefDeleted}: Current FileRef is deleted.`);
  }
  if (fileRef.ownerType !== ownerType || fileRef.ownerId !== ownerId) {
    throw new Error(`${MANUSCRIPT_IO_ERROR_CODES.fileRefOwnerMismatch}: Current FileRef owner does not match.`);
  }
  if (fileRef.manuscriptChannel !== binding.manuscriptChannel) {
    throw new Error(`${MANUSCRIPT_IO_ERROR_CODES.fileRefChannelMismatch}: Manuscript channel does not match.`);
  }
  if (fileRef.resourceKind !== "file") {
    throw new Error(`${MANUSCRIPT_IO_ERROR_CODES.fileRefInvalidKind}: Current FileRef is not a file.`);
  }
  if (fileRef.fileRole !== "manuscript") {
    throw new Error(`${MANUSCRIPT_IO_ERROR_CODES.fileRefInvalidRole}: Current FileRef is not a manuscript.`);
  }
  if (!fileRef.path.trim() || !isLikelyAbsoluteLocalPath(fileRef.path)) {
    throw new Error(`${MANUSCRIPT_IO_ERROR_CODES.pathInvalid}: Manuscript path must be absolute.`);
  }
  try {
    if (createPathIdentityKey(fileRef.path) !== fileRef.pathIdentityKey) {
      throw new Error("identity mismatch");
    }
  } catch {
    throw new Error(`${MANUSCRIPT_IO_ERROR_CODES.pathInvalid}: Manuscript path identity is invalid.`);
  }
  if (!/\.(?:md|markdown)$/iu.test(fileRef.path)) {
    throw new Error(`${MANUSCRIPT_IO_ERROR_CODES.extensionUnsupported}: Markdown extension is required.`);
  }

  let configuredRoot: string | undefined;
  if (fileRef.locationMode === "managed") {
    const rootStatus = await dependencies.getRootStatus();
    if (rootStatus.status !== "configured") {
      throw new Error(`${MANUSCRIPT_IO_ERROR_CODES.pathOutsideRoot}: Managed root is unavailable.`);
    }
    configuredRoot = rootStatus.managedRoot;
  }
  return { binding, fileRef, configuredRoot };
}

async function resolveCurrent(
  dependencies: ManuscriptIoDependencies,
  ownerType: FileRefOwnerType,
  ownerId: EntityId,
  manuscriptChannel: ManuscriptChannel = "primary"
): Promise<ResolvedManuscript> {
  const binding = await resolveBinding(dependencies, ownerType, ownerId, manuscriptChannel);
  if (!binding.currentFileRefId) {
    throw new Error(`${MANUSCRIPT_IO_ERROR_CODES.currentNotSet}: Current manuscript is not set.`);
  }
  return resolveFileRef(
    dependencies,
    ownerType,
    ownerId,
    binding,
    binding.currentFileRefId
  );
}

export function createManuscriptIoService(
  dependencies: ManuscriptIoDependencies = defaultDependencies
) {
  return {
    async readCurrentManuscript(
      ownerType: FileRefOwnerType,
      ownerId: EntityId,
      options: { requestToken?: number; manuscriptChannel?: ManuscriptChannel } = {}
    ): Promise<ReadCurrentManuscriptResult> {
      let current: ResolvedManuscript;
      try {
        current = await resolveCurrent(dependencies, ownerType, ownerId, options.manuscriptChannel);
      } catch (error) {
        const code = errorCodeFromUnknown(error, MANUSCRIPT_IO_ERROR_CODES.readFailed);
        return errorResult(ownerType, ownerId, code, error instanceof Error ? error.message : String(error), options.requestToken);
      }
      try {
        const result = await dependencies.readNative({
          filePath: current.fileRef.path,
          locationMode: current.fileRef.locationMode,
          configuredRoot: current.configuredRoot
        });
        return {
          status: "success",
          ownerType,
          ownerId,
          bindingId: current.binding.id,
          fileRefId: current.fileRef.id,
          path: result.path,
          locationMode: current.fileRef.locationMode,
          source: current.fileRef.source,
          content: result.content,
          sizeBytes: result.sizeBytes,
          encoding: result.encoding,
          warnings: [],
          requestToken: options.requestToken
        };
      } catch (error) {
        const code = errorCodeFromUnknown(error, MANUSCRIPT_IO_ERROR_CODES.readFailed);
        return errorResult(ownerType, ownerId, code, error instanceof Error ? error.message : String(error), options.requestToken);
      }
    },

    async readManuscriptByFileRef(
      ownerType: FileRefOwnerType,
      ownerId: EntityId,
      fileRefId: EntityId,
      options: { requestToken?: number; manuscriptChannel?: ManuscriptChannel } = {}
    ): Promise<ReadManuscriptByFileRefResult> {
      let target: ResolvedManuscript;
      try {
        const binding = await resolveBinding(dependencies, ownerType, ownerId, options.manuscriptChannel);
        target = await resolveFileRef(
          dependencies,
          ownerType,
          ownerId,
          binding,
          fileRefId
        );
      } catch (error) {
        const code = errorCodeFromUnknown(error, MANUSCRIPT_IO_ERROR_CODES.readFailed);
        return errorResult(
          ownerType,
          ownerId,
          code,
          error instanceof Error ? error.message : String(error),
          options.requestToken
        );
      }
      try {
        const result = await dependencies.readNative({
          filePath: target.fileRef.path,
          locationMode: target.fileRef.locationMode,
          configuredRoot: target.configuredRoot
        });
        return {
          status: "success",
          ownerType,
          ownerId,
          bindingId: target.binding.id,
          fileRefId: target.fileRef.id,
          path: result.path,
          locationMode: target.fileRef.locationMode,
          source: target.fileRef.source,
          content: result.content,
          sizeBytes: result.sizeBytes,
          encoding: result.encoding,
          warnings: [],
          requestToken: options.requestToken
        };
      } catch (error) {
        const code = errorCodeFromUnknown(error, MANUSCRIPT_IO_ERROR_CODES.readFailed);
        return errorResult(
          ownerType,
          ownerId,
          code,
          error instanceof Error ? error.message : String(error),
          options.requestToken
        );
      }
    },

    async saveCurrentManuscript(
      ownerType: FileRefOwnerType,
      ownerId: EntityId,
      content: string,
      options: {
        requestToken?: number;
        manuscriptChannel?: ManuscriptChannel;
        expectedCurrentFileRefId?: EntityId;
      } = {}
    ): Promise<SaveCurrentManuscriptResult> {
      let current: ResolvedManuscript;
      try {
        current = await resolveCurrent(dependencies, ownerType, ownerId, options.manuscriptChannel);
      } catch (error) {
        const code = errorCodeFromUnknown(error, MANUSCRIPT_IO_ERROR_CODES.writeFailed);
        return errorResult(ownerType, ownerId, code, error instanceof Error ? error.message : String(error), options.requestToken);
      }
      if (
        options.expectedCurrentFileRefId &&
        current.fileRef.id !== options.expectedCurrentFileRefId
      ) {
        return errorResult(
          ownerType,
          ownerId,
          MANUSCRIPT_IO_ERROR_CODES.staleRequest,
          "Current manuscript changed after it was loaded.",
          options.requestToken
        );
      }
      try {
        const result = await dependencies.writeNative({
          filePath: current.fileRef.path,
          content,
          locationMode: current.fileRef.locationMode,
          configuredRoot: current.configuredRoot
        });
        return {
          status: "success",
          ownerType,
          ownerId,
          bindingId: current.binding.id,
          fileRefId: current.fileRef.id,
          path: result.path,
          locationMode: current.fileRef.locationMode,
          bytesWritten: result.bytesWritten,
          encoding: result.encoding,
          warnings: [],
          requestToken: options.requestToken
        };
      } catch (error) {
        const code = errorCodeFromUnknown(error, MANUSCRIPT_IO_ERROR_CODES.writeFailed);
        return errorResult(ownerType, ownerId, code, error instanceof Error ? error.message : String(error), options.requestToken);
      }
    },

    async saveManuscriptByFileRef(
      ownerType: FileRefOwnerType,
      ownerId: EntityId,
      fileRefId: EntityId,
      content: string,
      options: { requestToken?: number; confirmedExternalWrite?: boolean; manuscriptChannel?: ManuscriptChannel } = {}
    ): Promise<SaveManuscriptByFileRefResult> {
      let target: ResolvedManuscript;
      try {
        const binding = await resolveBinding(dependencies, ownerType, ownerId, options.manuscriptChannel);
        target = await resolveFileRef(dependencies, ownerType, ownerId, binding, fileRefId);
      } catch (error) {
        const code = errorCodeFromUnknown(error, MANUSCRIPT_IO_ERROR_CODES.writeFailed);
        return errorResult(
          ownerType,
          ownerId,
          code,
          error instanceof Error ? error.message : String(error),
          options.requestToken
        );
      }
      if (target.fileRef.locationMode === "external" && options.confirmedExternalWrite !== true) {
        return errorResult(
          ownerType,
          ownerId,
          MANUSCRIPT_IO_ERROR_CODES.externalWriteNotConfirmed,
          "Writing an external manuscript requires explicit user confirmation.",
          options.requestToken
        );
      }
      try {
        const result = await dependencies.writeNative({
          filePath: target.fileRef.path,
          content,
          locationMode: target.fileRef.locationMode,
          configuredRoot: target.configuredRoot
        });
        return {
          status: "success",
          ownerType,
          ownerId,
          bindingId: target.binding.id,
          fileRefId: target.fileRef.id,
          path: result.path,
          locationMode: target.fileRef.locationMode,
          bytesWritten: result.bytesWritten,
          encoding: result.encoding,
          warnings: [],
          requestToken: options.requestToken
        };
      } catch (error) {
        const code = errorCodeFromUnknown(error, MANUSCRIPT_IO_ERROR_CODES.writeFailed);
        return errorResult(
          ownerType,
          ownerId,
          code,
          error instanceof Error ? error.message : String(error),
          options.requestToken
        );
      }
    }
  };
}

export const manuscriptIoService = createManuscriptIoService();
