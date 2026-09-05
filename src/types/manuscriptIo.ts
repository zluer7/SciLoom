import type { EntityId } from "./common";
import type { FileRef, FileRefLocationMode, FileRefOwnerType } from "./experiment";
import type { EntitySource } from "./planning";

export const MANUSCRIPT_IO_ERROR_CODES = {
  ownerNotFound: "MANUSCRIPT_OWNER_NOT_FOUND",
  ownerDeleted: "MANUSCRIPT_OWNER_DELETED",
  bindingNotFound: "MANUSCRIPT_BINDING_NOT_FOUND",
  currentNotSet: "MANUSCRIPT_CURRENT_NOT_SET",
  fileRefNotFound: "MANUSCRIPT_FILE_REF_NOT_FOUND",
  fileRefDeleted: "MANUSCRIPT_FILE_REF_DELETED",
  fileRefOwnerMismatch: "MANUSCRIPT_FILE_REF_OWNER_MISMATCH",
  fileRefChannelMismatch: "MANUSCRIPT_FILE_REF_CHANNEL_MISMATCH",
  fileRefInvalidRole: "MANUSCRIPT_FILE_REF_INVALID_ROLE",
  fileRefInvalidKind: "MANUSCRIPT_FILE_REF_INVALID_KIND",
  pathInvalid: "MANUSCRIPT_PATH_INVALID",
  pathOutsideRoot: "MANUSCRIPT_PATH_OUTSIDE_ROOT",
  fileNotFound: "MANUSCRIPT_FILE_NOT_FOUND",
  pathIsDirectory: "MANUSCRIPT_PATH_IS_DIRECTORY",
  symlinkNotAllowed: "MANUSCRIPT_SYMLINK_NOT_ALLOWED",
  extensionUnsupported: "MANUSCRIPT_EXTENSION_UNSUPPORTED",
  fileTooLarge: "MANUSCRIPT_FILE_TOO_LARGE",
  encodingInvalid: "MANUSCRIPT_ENCODING_INVALID",
  readFailed: "MANUSCRIPT_READ_FAILED",
  writeFailed: "MANUSCRIPT_WRITE_FAILED",
  atomicReplaceFailed: "MANUSCRIPT_ATOMIC_REPLACE_FAILED",
  externalWriteNotConfirmed: "EXTERNAL_MANUSCRIPT_WRITE_NOT_CONFIRMED",
  externalSelectionCanceled: "EXTERNAL_MANUSCRIPT_SELECTION_CANCELED",
  externalIdentityConflict: "EXTERNAL_MANUSCRIPT_IDENTITY_CONFLICT",
  externalRegistrationFailed: "EXTERNAL_MANUSCRIPT_REGISTRATION_FAILED",
  staleRequest: "STALE_MANUSCRIPT_REQUEST"
} as const;

export type ManuscriptIoErrorCode =
  (typeof MANUSCRIPT_IO_ERROR_CODES)[keyof typeof MANUSCRIPT_IO_ERROR_CODES];

export interface ManuscriptIoError {
  code: ManuscriptIoErrorCode;
  message: string;
}

export interface NativeReadManuscriptInput {
  filePath: string;
  locationMode: FileRefLocationMode;
  configuredRoot?: string;
}

export interface NativeReadManuscriptResult {
  content: string;
  fileName: string;
  path: string;
  sizeBytes: number;
  encoding: "utf-8";
}

export interface NativeWriteManuscriptInput extends NativeReadManuscriptInput {
  content: string;
}

export interface NativeWriteManuscriptResult {
  path: string;
  bytesWritten: number;
  encoding: "utf-8";
}

export type ReadManuscriptResult =
  | {
      status: "success";
      ownerType: FileRefOwnerType;
      ownerId: EntityId;
      bindingId: EntityId;
      fileRefId: EntityId;
      path: string;
      locationMode: FileRefLocationMode;
      source: EntitySource;
      content: string;
      sizeBytes: number;
      encoding: "utf-8";
      warnings: string[];
      requestToken?: number;
    }
  | {
      status: "error";
      ownerType: FileRefOwnerType;
      ownerId: EntityId;
      error: ManuscriptIoError;
      warnings: string[];
      requestToken?: number;
    };

export type ReadCurrentManuscriptResult = ReadManuscriptResult;
export type ReadManuscriptByFileRefResult = ReadManuscriptResult;

export type SaveCurrentManuscriptResult =
  | {
      status: "success";
      ownerType: FileRefOwnerType;
      ownerId: EntityId;
      bindingId: EntityId;
      fileRefId: EntityId;
      path: string;
      locationMode: FileRefLocationMode;
      bytesWritten: number;
      encoding: "utf-8";
      warnings: string[];
      requestToken?: number;
    }
  | {
      status: "error";
      ownerType: FileRefOwnerType;
      ownerId: EntityId;
      error: ManuscriptIoError;
      warnings: string[];
      requestToken?: number;
    };

export type SaveManuscriptByFileRefResult = SaveCurrentManuscriptResult;

export type ExternalManuscriptRegistrationResult =
  | {
      status: "success" | "skipped";
      ownerType: FileRefOwnerType;
      ownerId: EntityId;
      registeredFileRef: FileRef;
  fileRefState: "created" | "reused";
      content: string;
      sizeBytes: number;
      encoding: "utf-8";
      path: string;
      warnings: string[];
      requestToken?: number;
    }
  | {
      status: "canceled" | "error";
      ownerType: FileRefOwnerType;
      ownerId: EntityId;
      error: ManuscriptIoError;
      warnings: string[];
      requestToken?: number;
    };
