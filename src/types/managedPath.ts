import type { FileRefOwnerType } from "./experiment";

export const MANAGED_PATH_ERROR_CODES = {
  rootMissing: "MANAGED_ROOT_MISSING",
  rootInvalid: "MANAGED_ROOT_INVALID",
  rootNotAbsolute: "MANAGED_ROOT_NOT_ABSOLUTE",
  rootTooLong: "MANAGED_ROOT_TOO_LONG",
  unsupportedOwnerType: "UNSUPPORTED_MANAGED_PATH_OWNER_TYPE",
  invalidProjectId: "INVALID_PROJECT_ID",
  invalidOwnerId: "INVALID_OWNER_ID",
  invalidDate: "INVALID_DATE",
  invalidPathSegment: "INVALID_PATH_SEGMENT",
  pathTooLong: "PATH_TOO_LONG",
  pathOutsideRoot: "PATH_OUTSIDE_MANAGED_ROOT",
  pathDriveMismatch: "PATH_DRIVE_MISMATCH",
  pathUncShareMismatch: "PATH_UNC_SHARE_MISMATCH",
  pathIdentityInvalid: "PATH_IDENTITY_INVALID",
  projectWorkspaceIdentityInvalid: "PROJECT_WORKSPACE_IDENTITY_INVALID",
  projectWorkspaceOutsideRoot: "PROJECT_WORKSPACE_OUTSIDE_MANAGED_ROOT",
  parentExperimentIdentityMismatch: "PARENT_EXPERIMENT_IDENTITY_MISMATCH",
  parentExperimentPathInvalid: "PARENT_EXPERIMENT_PATH_INVALID",
  workspaceTitleIdentityImmutable: "WORKSPACE_TITLE_IDENTITY_IMMUTABLE"
} as const;

export type ManagedPathErrorCode =
  (typeof MANAGED_PATH_ERROR_CODES)[keyof typeof MANAGED_PATH_ERROR_CODES];

export class ManagedPathError extends Error {
  readonly code: ManagedPathErrorCode;

  constructor(code: ManagedPathErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "ManagedPathError";
    this.code = code;
  }
}

export type ManagedPathOwnerType = Exclude<FileRefOwnerType, "experiment" | "experimentRun">;

export interface ManagedRootSetting {
  id: "managed-root";
  configuredRoot: string;
  schemaVersion: 1;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

export type ManagedRootStatus =
  | {
      status: "unconfigured";
      configuredRoot: null;
      managedRoot: null;
      access: "unavailable";
      durableState: "NOT_CONFIGURED";
      readinessState: "UNAVAILABLE";
      errorCode: string;
    }
  | {
      status: "invalid";
      configuredRoot: string | null;
      managedRoot: null;
      access: "read-failed";
      durableState: "READ_FAILED";
      readinessState: "READ_FAILED";
      errorCode: string;
    }
  | {
      status: "configured";
      configuredRoot: string;
      managedRoot: string;
      access: "ready" | "unavailable" | "not-writable" | "invalid" | "read-failed";
      durableState: "CONFIGURED";
      readinessState: "READY" | "UNAVAILABLE" | "NOT_WRITABLE" | "INVALID_PATH" | "READ_FAILED";
      errorCode?: string;
      pathIdentityKey: string | null;
      physicalIdentityHash: string | null;
    };

export interface DateSegments {
  calendarDate: string;
  yearMonth: string;
  day: string;
}

interface ManagedEntryPathBaseInput {
  root: string;
  ownerType: ManagedPathOwnerType;
  ownerId: string;
  ownerTitle: string;
  createdAt: string;
  collectionFolder?: string;
}

export type ManagedEntryPathInput = ManagedEntryPathBaseInput & (
  | {
      projectId: string;
      projectTitle: string;
    }
  | {
      ownerType: "literature";
      projectId: null;
      projectTitle?: null;
    }
);

export interface ManagedEntryPathDescriptor extends DateSegments {
  rootPath: string;
  projectFolderName?: string;
  ownerTypeFolder: string;
  collectionFolder?: string;
  entryFolderName: string;
  relativePath: string;
  absolutePath: string;
  pathIdentityKey: string;
  warnings: string[];
}
