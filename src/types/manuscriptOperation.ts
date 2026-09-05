export type ManuscriptOwnerType = string;
export type ManuscriptLocationMode = "managed" | "external";
export type ManuscriptPendingLocationMode = ManuscriptLocationMode | "pending";
export type ManuscriptNewline = "lf" | "crlf" | "mixed" | "none";
export type ManuscriptUniformNewline = "lf" | "crlf";
export type ManuscriptPhysicalRevision = string;
export type ManuscriptOperationType =
  | "open"
  | "save"
  | "close"
  | "discard"
  | "rekey";

export type ManuscriptPipelineOperation =
  | "independent-open"
  | "formal-switch-target";

export type ManuscriptPipelineStage =
  | "selection"
  | "workspace"
  | "read"
  | "lookup"
  | "registration"
  | "durable-identity"
  | "rekey"
  | "activation"
  | "preflight";

export type ManuscriptPipelineRecoverability =
  | "none"
  | "retry"
  | "reselect"
  | "resolve-conflict"
  | "restart-required";

export interface ManuscriptPipelineFailure {
  operation: ManuscriptPipelineOperation;
  stage: ManuscriptPipelineStage;
  errorCode: string;
  causeCode?: string;
  recoverability: ManuscriptPipelineRecoverability;
  operationId: string;
  requestToken?: string;
  safeDetails?: Record<string, string | number | boolean>;
}

export interface OwnerIdentity {
  ownerType: ManuscriptOwnerType;
  ownerId: string;
  channel: string;
}

interface FileIdentityBase {
  absolutePath: string;
  pathIdentity: string;
  fileName: string;
  resourceKind: "file";
  fileRole: "manuscript";
  fileType: "markdown";
  configuredRoot?: string;
}

export interface EphemeralFileIdentity extends FileIdentityBase {
  kind: "ephemeral";
  identityToken: string;
  locationMode: ManuscriptPendingLocationMode;
}

export interface DurableFileIdentity extends FileIdentityBase {
  kind: "durable";
  fileRefId: string;
  locationMode: ManuscriptLocationMode;
}

export type FileIdentity = EphemeralFileIdentity | DurableFileIdentity;

export interface RawManuscriptSnapshot {
  rawText: string;
  revision: ManuscriptPhysicalRevision;
  physicalIdentity?: string;
  encoding: "utf-8" | "utf-8-bom";
  newline: ManuscriptNewline;
  dominantNewline?: ManuscriptUniformNewline;
  byteLength: number;
}

export interface ManuscriptFileSelectionSnapshot {
  owner: OwnerIdentity;
  currentFile?: DurableFileIdentity;
  defaultFile?: DurableFileIdentity;
}

export interface ManuscriptFileIdentityRekeyInput {
  owner: OwnerIdentity;
  oldSessionKey: string;
  durableFile: DurableFileIdentity;
}

export type ManuscriptOperationRequest =
  | {
      operation: "open";
      operationId: string;
      owner: OwnerIdentity;
      file: FileIdentity;
      reload?: boolean;
    }
  | {
      operation: "save" | "discard";
      operationId: string;
      sessionKey: string;
    }
  | {
      operation: "close";
      operationId: string;
      sessionKey: string;
      decision?: "cancel" | "discard";
    }
  | ({
      operation: "rekey";
      operationId: string;
    } & ManuscriptFileIdentityRekeyInput);

export const MANUSCRIPT_OPERATION_ERROR_CODES = {
  invalidOwnerIdentity: "MANUSCRIPT_INVALID_OWNER_IDENTITY",
  invalidFileIdentity: "MANUSCRIPT_INVALID_FILE_IDENTITY",
  pathNotAbsolute: "MANUSCRIPT_PATH_NOT_ABSOLUTE",
  pathIdentityMismatch: "MANUSCRIPT_PATH_IDENTITY_MISMATCH",
  locationModeUnconfirmed: "MANUSCRIPT_LOCATION_MODE_UNCONFIRMED",
  fileNotFound: "MANUSCRIPT_FILE_NOT_FOUND",
  targetIsDirectory: "MANUSCRIPT_TARGET_IS_DIRECTORY",
  pathOutsideRoot: "MANUSCRIPT_PATH_OUTSIDE_ROOT",
  symlinkEscape: "MANUSCRIPT_SYMLINK_ESCAPE",
  extensionUnsupported: "MANUSCRIPT_EXTENSION_UNSUPPORTED",
  fileTooLarge: "MANUSCRIPT_FILE_TOO_LARGE",
  encodingUnsupported: "MANUSCRIPT_ENCODING_UNSUPPORTED",
  fileUnreadable: "MANUSCRIPT_FILE_UNREADABLE",
  permissionDenied: "MANUSCRIPT_PERMISSION_DENIED",
  revisionConflict: "MANUSCRIPT_REVISION_CONFLICT",
  temporaryWriteFailed: "MANUSCRIPT_TEMPORARY_WRITE_FAILED",
  atomicReplaceFailed: "MANUSCRIPT_ATOMIC_REPLACE_FAILED",
  atomicWriteFailed: "MANUSCRIPT_ATOMIC_WRITE_FAILED",
  readbackFailed: "MANUSCRIPT_READBACK_FAILED",
  verificationFailed: "MANUSCRIPT_VERIFICATION_FAILED",
  sessionNotFound: "MANUSCRIPT_SESSION_NOT_FOUND",
  sessionIdentityMismatch: "MANUSCRIPT_SESSION_IDENTITY_MISMATCH",
  dirtyReloadBlocked: "MANUSCRIPT_DIRTY_RELOAD_BLOCKED",
  operationInProgress: "MANUSCRIPT_OPERATION_IN_PROGRESS",
  requestStale: "MANUSCRIPT_REQUEST_STALE",
  dirtyCloseBlocked: "MANUSCRIPT_DIRTY_CLOSE_BLOCKED",
  rekeyConflict: "MANUSCRIPT_REKEY_CONFLICT",
  recoveryRequired: "MANUSCRIPT_RECOVERY_REQUIRED",
  operationFailed: "MANUSCRIPT_OPERATION_FAILED"
} as const;

export type ManuscriptOperationErrorCode =
  (typeof MANUSCRIPT_OPERATION_ERROR_CODES)[keyof typeof MANUSCRIPT_OPERATION_ERROR_CODES];

export type ManuscriptWriteApplied = true | false | "unknown";

export interface ManuscriptOperationError {
  code: ManuscriptOperationErrorCode;
  category: "identity" | "file" | "session" | "operation";
  retryable: boolean;
  writeApplied: ManuscriptWriteApplied;
  recoveryRequired: boolean;
  causeCode?: string;
}

export interface ManuscriptConflict {
  code: ManuscriptOperationErrorCode;
  retryable: boolean;
  sessionKey?: string;
}

export interface ManuscriptRecoveryState {
  required: boolean;
  writeApplied: ManuscriptWriteApplied;
  causeCode?: string;
}

export type ManuscriptOperationOutcome =
  | "success"
  | "info"
  | "warning"
  | "error"
  | "canceled"
  | "no-op"
  | "conflict"
  | "recovery-required"
  | "write-applied-readback-failed"
  | "stale";

export interface ManuscriptOperationResult<T = undefined> {
  operation: ManuscriptOperationType;
  status: ManuscriptOperationOutcome;
  operationId: string;
  data?: T;
  error?: ManuscriptOperationError;
  cleanup?: {
    consumerCleanupState: "released" | "unresolved";
    sessionCleanupState:
      | "released"
      | "retained-by-other-consumer"
      | "unresolved";
    admissionCleanupState:
      | "released"
      | "legitimately-retained"
      | "unresolved";
  };
}

export type ManuscriptFeedbackSeverity =
  | "success"
  | "info"
  | "warning"
  | "error";

export interface ManuscriptOperationFeedback {
  severity: ManuscriptFeedbackSeverity;
  titleKey: string;
  messageKey: string;
  retryable: boolean;
  recoveryRequired: boolean;
}

export interface RawManuscriptReadInput {
  file: FileIdentity;
}

export interface RawManuscriptSaveInput {
  file: FileIdentity;
  baseline: RawManuscriptSnapshot;
  draftRawText: string;
}

export interface RawManuscriptSaveSuccess {
  snapshot: RawManuscriptSnapshot;
  savedRawText: string;
  writeApplied: boolean;
}

export interface NativeRawManuscriptReadInput {
  filePath: string;
  expectedPathIdentity: string;
  expectedFileName: string;
  locationMode: ManuscriptLocationMode;
  configuredRoot?: string;
}

export interface NativeRawManuscriptSaveInput extends NativeRawManuscriptReadInput {
  expectedRevision: ManuscriptPhysicalRevision;
  content: string;
}

export type NativeRawManuscriptFileResult =
  | {
      status: "success";
      content: string;
      fileName: string;
      pathIdentity: string;
      physicalIdentity?: string;
      revision: ManuscriptPhysicalRevision;
      byteLength: number;
      lineEnding: ManuscriptNewline;
      encoding: "utf-8";
      writeApplied?: boolean;
      recoveryRequired?: boolean;
    }
  | {
      status: "error";
      errorCode: string;
      errorMessage?: string;
      writeApplied?: ManuscriptWriteApplied;
      recoveryRequired?: boolean;
    };

export interface RawManuscriptNativePort {
  read(input: NativeRawManuscriptReadInput): Promise<NativeRawManuscriptFileResult>;
  save(input: NativeRawManuscriptSaveInput): Promise<NativeRawManuscriptFileResult>;
}

export interface RawManuscriptGateway {
  read(
    input: RawManuscriptReadInput
  ): Promise<ManuscriptOperationResult<RawManuscriptSnapshot>>;
  save(
    input: RawManuscriptSaveInput
  ): Promise<ManuscriptOperationResult<RawManuscriptSaveSuccess>>;
}

export interface ManuscriptSwitchExecutionInput {
  owner: OwnerIdentity;
  sourceSessionKey?: string;
  targetFile: FileIdentity;
}

export interface ManuscriptSwitchExecutionPort {
  execute(
    input: ManuscriptSwitchExecutionInput
  ): Promise<ManuscriptOperationResult<{ targetSessionKey: string }>>;
}
