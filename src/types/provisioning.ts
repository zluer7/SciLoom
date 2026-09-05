import type { EntityId } from "./common";
import type { FileRef, FileRefOwnerType } from "./experiment";
import type { ManuscriptBinding } from "./manuscriptBinding";
import type { ManuscriptChannel } from "./manuscriptChannel";
import type { EntitySource } from "./planning";
import type { WriteFeedbackStatus } from "./writeFeedback";

export const PROVISIONING_ERROR_CODES = {
  ownerNotFound: "PROVISIONING_OWNER_NOT_FOUND",
  ownerDeleted: "PROVISIONING_OWNER_DELETED",
  projectNotFound: "PROVISIONING_PROJECT_NOT_FOUND",
  projectMissing: "PROVISIONING_PROJECT_MISSING",
  channelInvalid: "PROVISIONING_MANUSCRIPT_CHANNEL_INVALID",
  rootMissing: "PROVISIONING_ROOT_MISSING",
  rootInvalid: "PROVISIONING_ROOT_INVALID",
  pathInvalid: "PROVISIONING_PATH_INVALID",
  pathOutsideRoot: "PROVISIONING_PATH_OUTSIDE_ROOT",
  directoryConflict: "PROVISIONING_DIRECTORY_CONFLICT",
  directoryCreateFailed: "PROVISIONING_DIRECTORY_CREATE_FAILED",
  bodyConflict: "PROVISIONING_BODY_CONFLICT",
  bodyMissingRepairRequired: "PROVISIONING_BODY_MISSING_REPAIR_REQUIRED",
  bodyCreateFailed: "PROVISIONING_BODY_CREATE_FAILED",
  bodyReadbackFailed: "PROVISIONING_BODY_READBACK_FAILED",
  bodyEncodingUnsupported: "PROVISIONING_BODY_ENCODING_UNSUPPORTED",
  defaultFolderFileRefFailed: "PROVISIONING_DEFAULT_FOLDER_FILE_REF_FAILED",
  defaultManuscriptFileRefFailed: "PROVISIONING_DEFAULT_MANUSCRIPT_FILE_REF_FAILED",
  bindingFailed: "PROVISIONING_BINDING_FAILED",
  metadataConflict: "PROVISIONING_METADATA_CONFLICT",
  partial: "PROVISIONING_PARTIAL"
} as const;

export type ProvisioningErrorCode =
  (typeof PROVISIONING_ERROR_CODES)[keyof typeof PROVISIONING_ERROR_CODES];

export class ProvisioningError extends Error {
  readonly code: ProvisioningErrorCode;

  constructor(code: ProvisioningErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "ProvisioningError";
    this.code = code;
  }
}

interface ProvisionManagedOwnerBaseInput {
  ownerType: FileRefOwnerType;
  ownerId: EntityId;
  ownerTitle: string;
  createdAt: string;
  source?: EntitySource;
  manuscriptChannel: ManuscriptChannel;
  manuscriptFileName: string;
  manuscriptDisplayName?: string;
  collectionFolder?: string;
  initialContent?: string;
}

export type ProvisionManagedOwnerInput = ProvisionManagedOwnerBaseInput & (
  | {
      projectId: EntityId;
      projectTitle: string;
    }
  | {
      ownerType: "literature";
      projectId: null;
      projectTitle?: null;
    }
);

export interface NativeProvisionManagedEntryInput {
  ownerType: FileRefOwnerType;
  manuscriptChannel: ManuscriptChannel;
  configuredRoot: string;
  targetDirectory: string;
  bodyPath: string;
  initialContent: string;
  allowCreateBody: boolean;
}

export interface NativeProvisionManagedEntryResult {
  status: "success" | "skipped" | "partial" | "error";
  directoryPath: string;
  bodyPath: string;
  createdDirectory: boolean;
  createdBody: boolean;
  reusedDirectory: boolean;
  reusedBody: boolean;
  retryable: boolean;
  errorCode?: ProvisioningErrorCode | string | null;
  errorMessage?: string | null;
}

export interface NativeProvisionExperimentManuscriptInput {
  configuredRoot: string;
  projectWorkspace: string;
  targetWorkspace: string;
  defaultFilePath: string;
  initialContent: string;
}

export interface NativeProvisionExperimentRunManuscriptInput {
  configuredRoot: string;
  projectWorkspace: string;
  parentExperimentWorkspace: string;
  targetWorkspace: string;
  defaultFilePath: string;
  initialContent: string;
}

export type ProvisionedMetadataState = "created" | "reused";

export interface ProvisionManagedOwnerResult {
  status: WriteFeedbackStatus;
  ownerType: FileRefOwnerType;
  ownerId: EntityId;
  rootPath?: string;
  relativeFolderPath?: string;
  absoluteFolderPath?: string;
  bodyPath?: string;
  defaultFolderFileRef?: FileRef;
  defaultManuscriptFileRef?: FileRef;
  binding?: ManuscriptBinding;
  folderFileRefState?: ProvisionedMetadataState;
  manuscriptFileRefState?: ProvisionedMetadataState;
  bindingState?: "created" | "reused";
  currentState?: "initialized" | "preserved";
  createdFolder: boolean;
  createdBody: boolean;
  reusedFolder: boolean;
  reusedBody: boolean;
  warnings: string[];
  errors: Array<{ code: ProvisioningErrorCode | string; message: string; step: string }>;
  completedSteps: string[];
  failedStep?: string;
  retryable: boolean;
  effectOutcomeUnknown?: boolean;
  durableOperationId?: string;
  durableRootOperationId?: string;
  durableReady?: boolean;
}

export type ReviewProvisioningCompletionState = "complete" | "partial" | "failed";

export type ReviewProvisioningStepState =
  | "created"
  | "reused"
  | "skipped"
  | "missing"
  | "failed";

export interface ReviewManuscriptProvisioningResult extends ProvisionManagedOwnerResult {
  completionState: ReviewProvisioningCompletionState;
  steps: {
    reviewRecord: ReviewProvisioningStepState;
    workspace: ReviewProvisioningStepState;
    defaultFile: ReviewProvisioningStepState;
    folderFileRef: ReviewProvisioningStepState;
    manuscriptFileRef: ReviewProvisioningStepState;
    binding: ReviewProvisioningStepState;
    current: ReviewProvisioningStepState;
  };
  physicalFilePresent: boolean;
  metadataGap: boolean;
}
