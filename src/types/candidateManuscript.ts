import type { EntityId } from "./common";
import type { FileRef, FileRefOwnerType } from "./experiment";
import type { ManuscriptSwitchEditorState, SwitchCurrentManuscriptResult } from "./manuscriptSwitch";
import type { ManuscriptChannel } from "./manuscriptChannel";

export type CandidateManuscriptSource = "user" | "ai";

interface StandardOperationCandidateAuthorizationBase {
  source: "DERIVED_FROM_STANDARD_OPERATION_CONFIRMATION";
  conversationId: string;
  parseCallAttemptId: string;
  parentResultId: string;
  effectResultId: string;
  authorizationId: string;
  confirmedPayloadFingerprint: string;
  ownerType: FileRefOwnerType;
  ownerId: EntityId;
  manuscriptChannel: ManuscriptChannel;
}

export type StandardOperationCandidateAuthorization =
  | StandardOperationCandidateAuthorizationBase & {
      parentAction: "CREATE";
      businessReceiptEntityId: EntityId;
      targetSnapshotFingerprint?: never;
    }
  | StandardOperationCandidateAuthorizationBase & {
      parentAction: "UPDATE";
      businessReceiptEntityId?: never;
      targetSnapshotFingerprint: string;
    };

export type CandidateManuscriptAuthorization =
  | {
      source: "EXPLICIT_USER_CONFIRMATION";
    }
  | {
      source: "DERIVED_FROM_QUICK_ANALYSIS_RUN_AUTHORIZATION";
      runId: string;
      conversationId: string;
      /** New simple Quick body-generation provenance. */
      bodyCallAttemptId: string;
      parseCallAttemptId?: never;
      sourceFileRefId: string;
      sourceDirectoryFileRefId: string;
    }
  | {
      /** Historical Standard Result Quick application provenance. */
      source: "DERIVED_FROM_QUICK_ANALYSIS_RUN_AUTHORIZATION";
      runId: string;
      conversationId: string;
      parseCallAttemptId: string;
      bodyCallAttemptId?: never;
      sourceFileRefId: string;
      sourceDirectoryFileRefId: string;
    }
  | StandardOperationCandidateAuthorization;

export interface CandidateManuscriptFrozenWorkspace {
  folderFileRefId: EntityId;
  directoryPathIdentityKey: string;
}

export const CANDIDATE_MANUSCRIPT_ERROR_CODES = {
  ownerNotFound: "CANDIDATE_OWNER_NOT_FOUND",
  ownerDeleted: "CANDIDATE_OWNER_DELETED",
  notConfirmed: "CANDIDATE_NOT_CONFIRMED",
  requestIdInvalid: "CANDIDATE_REQUEST_ID_INVALID",
  occurredAtInvalid: "CANDIDATE_OCCURRED_AT_INVALID",
  channelRequired: "CANDIDATE_CHANNEL_REQUIRED",
  channelUnsupported: "CANDIDATE_CHANNEL_UNSUPPORTED",
  sourceInvalid: "CANDIDATE_SOURCE_INVALID",
  defaultFolderMissing: "CANDIDATE_DEFAULT_FOLDER_MISSING",
  defaultFolderInvalid: "CANDIDATE_DEFAULT_FOLDER_INVALID",
  provisioningFailed: "CANDIDATE_PROVISIONING_FAILED",
  serializeFailed: "CANDIDATE_SERIALIZE_FAILED",
  pathInvalid: "CANDIDATE_PATH_INVALID",
  pathOutsideRoot: "CANDIDATE_PATH_OUTSIDE_ROOT",
  directoryCreateFailed: "CANDIDATE_DIRECTORY_CREATE_FAILED",
  fileCreateFailed: "CANDIDATE_FILE_CREATE_FAILED",
  fileConflict: "CANDIDATE_FILE_CONFLICT",
  contentConflict: "CANDIDATE_CONTENT_CONFLICT",
  filenameConflict: "CANDIDATE_FILENAME_CONFLICT",
  requestMetadataConflict: "CANDIDATE_REQUEST_METADATA_CONFLICT",
  incompleteState: "CANDIDATE_INCOMPLETE_STATE",
  idempotencyConflict: "CANDIDATE_IDEMPOTENCY_CONFLICT",
  fileRefFailed: "CANDIDATE_FILE_REF_FAILED",
  fileRefIdentityConflict: "CANDIDATE_FILE_REF_IDENTITY_CONFLICT",
  savePartial: "CANDIDATE_SAVE_PARTIAL",
  saveStale: "CANDIDATE_SAVE_STALE",
  setCurrentNotConfirmed: "CANDIDATE_SET_CURRENT_NOT_CONFIRMED",
  setCurrentInvalidTarget: "CANDIDATE_SET_CURRENT_INVALID_TARGET",
  setCurrentFailed: "CANDIDATE_SET_CURRENT_FAILED",
  setCurrentStale: "CANDIDATE_SET_CURRENT_STALE"
} as const;

export type CandidateManuscriptErrorCode =
  (typeof CANDIDATE_MANUSCRIPT_ERROR_CODES)[keyof typeof CANDIDATE_MANUSCRIPT_ERROR_CODES];

export interface SaveCandidateManuscriptInput {
  ownerType: FileRefOwnerType;
  ownerId: EntityId;
  manuscriptChannel?: ManuscriptChannel;
  requestId: string;
  occurredAt: string;
  candidateTitle?: string;
  source: CandidateManuscriptSource;
  confirmedByUser?: boolean;
  authorization?: CandidateManuscriptAuthorization;
  frozenWorkspace?: CandidateManuscriptFrozenWorkspace;
  metaSnapshot: string;
  outline: string;
  body: string;
  requestToken: number;
}

export interface NativeCreateCandidateManuscriptInput {
  configuredRoot: string;
  workspaceDirectory: string;
  layout: "workspaceRoot";
  ownerType: FileRefOwnerType;
  manuscriptChannel: ManuscriptChannel;
  source: CandidateManuscriptSource;
  occurredAt: string;
  requestId: string;
  expectedFileName: string;
  content: string;
}

export interface NativeCreateCandidateManuscriptResult {
  status: "success" | "skipped" | "partial" | "error";
  fileName: string;
  path: string;
  createdDirectories: boolean;
  createdFile: boolean;
  reusedFile: boolean;
  bytesWritten: number;
  encoding: "utf-8";
  retryable: boolean;
  errorCode?: CandidateManuscriptErrorCode | string | null;
  errorMessage?: string | null;
}

export interface CandidateManuscriptSaveError {
  code: CandidateManuscriptErrorCode | string;
  message: string;
  step: string;
}

export interface SaveCandidateManuscriptResult {
  status: "success" | "skipped" | "partial" | "conflict" | "error";
  ownerType: FileRefOwnerType;
  ownerId: EntityId;
  manuscriptChannel?: ManuscriptChannel;
  requestId: string;
  occurredAt: string;
  requestShortId?: string;
  fileName?: string;
  pathSummary?: string;
  fileRefId?: EntityId;
  fileRef?: FileRef;
  path?: string;
  pathIdentityKey?: string;
  source: CandidateManuscriptSource;
  authorizationSource?: CandidateManuscriptAuthorization["source"];
  frozenWorkspace?: CandidateManuscriptFrozenWorkspace;
  createdFile: boolean;
  reusedFile: boolean;
  createdFileRef: boolean;
  contentSizeBytes: number;
  parseStatus?: "valid" | "valid-empty";
  warnings: string[];
  errors: CandidateManuscriptSaveError[];
  completedSteps: string[];
  failedStep?: string;
  retryable: boolean;
  requestToken: number;
  currentChanged: false;
}

export interface LiteratureCandidateSaveInput
  extends Omit<SaveCandidateManuscriptInput, "ownerType" | "manuscriptChannel"> {
  ownerType: "literature";
  manuscriptChannel: Extract<ManuscriptChannel, "literature_outline" | "dedicated_notes">;
}

export interface ReviewCandidateSaveInput
  extends Omit<SaveCandidateManuscriptInput, "ownerType" | "manuscriptChannel"> {
  ownerType: "review";
  manuscriptChannel: "primary";
}

export interface ExperimentCandidateSaveInput
  extends Omit<SaveCandidateManuscriptInput, "ownerType" | "manuscriptChannel"> {
  ownerType: "experiment";
  manuscriptChannel: "primary";
}

export interface SetCandidateAsCurrentInput {
  ownerType: FileRefOwnerType;
  ownerId: EntityId;
  manuscriptChannel?: ManuscriptChannel;
  candidateFileRefId: EntityId;
  confirmedByUser: boolean;
  currentEditorState: ManuscriptSwitchEditorState;
  dirtyDecision?: "save" | "discard" | "cancel";
  confirmedDiscardUnsavedChanges?: boolean;
  requestToken: number;
}

export type SetCandidateAsCurrentResult =
  | {
      status: "success" | "skipped";
      switchResult: SwitchCurrentManuscriptResult;
      requestToken: number;
    }
  | {
      status: "error";
      error: { code: CandidateManuscriptErrorCode; message: string };
      requestToken: number;
    };
