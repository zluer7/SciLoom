import type { Experiment, ExperimentRun } from "./experiment";
import type {
  DurableFileIdentity,
  ManuscriptOperationError
} from "./manuscriptOperation";

type ExperimentRunManuscriptWindowRole = "current" | "independent";

export const EXPERIMENT_RUN_RAW_ERROR_CODES = {
  ownerMissing: "RUN_RAW_OWNER_MISSING",
  parentMissing: "RUN_RAW_PARENT_MISSING",
  projectUnavailable: "RUN_RAW_PROJECT_UNAVAILABLE",
  ownerMismatch: "RUN_RAW_OWNER_MISMATCH",
  bindingMissing: "RUN_RAW_BINDING_MISSING",
  bindingInvalid: "RUN_RAW_BINDING_INVALID",
  currentMissing: "RUN_RAW_CURRENT_MISSING",
  currentChanged: "RUN_RAW_CURRENT_CHANGED",
  fileRefMissing: "RUN_RAW_FILE_REF_MISSING",
  fileRefDeleted: "RUN_RAW_FILE_REF_DELETED",
  fileRefOwnerMismatch: "RUN_RAW_FILE_REF_OWNER_MISMATCH",
  fileRefInvalid: "RUN_RAW_FILE_REF_INVALID",
  pathInvalid: "RUN_RAW_PATH_INVALID",
  managedRootUnavailable: "RUN_RAW_MANAGED_ROOT_UNAVAILABLE",
  sessionMissing: "RUN_RAW_SESSION_MISSING",
  permissionDenied: "RUN_RAW_SAVE_PERMISSION_DENIED",
  dirtyDecisionRequired: "RUN_RAW_RELOAD_DIRTY_DECISION_REQUIRED",
  operationInProgress: "RUN_RAW_OPERATION_IN_PROGRESS",
  requestStale: "RUN_RAW_REQUEST_STALE",
  selectionFailed: "RUN_RAW_SELECTION_FAILED",
  workspaceInvalid: "RUN_RAW_WORKSPACE_INVALID",
  workspaceResolutionFailed: "RUN_OPEN_WORKSPACE_RESOLUTION_FAILED",
  runWorkspaceMissing: "RUN_OPEN_RUN_WORKSPACE_MISSING",
  crossOwnerManagedPathConflict: "RUN_OPEN_CROSS_OWNER_MANAGED_PATH_CONFLICT",
  registrationFailed: "RUN_RAW_REGISTRATION_FAILED",
  readbackInvalid: "RUN_RAW_FILE_REF_READBACK_INVALID",
  registrationStale: "RUN_RAW_REGISTRATION_STALE",
  duplicateSessionConflict: "RUN_RAW_DUPLICATE_SESSION_CONFLICT",
  ephemeralSaveDenied: "RUN_RAW_EPHEMERAL_SAVE_DENIED"
} as const;

export type ExperimentRunRawErrorCode =
  (typeof EXPERIMENT_RUN_RAW_ERROR_CODES)[keyof typeof EXPERIMENT_RUN_RAW_ERROR_CODES];

export interface ExperimentRunRawSafeError {
  code: ExperimentRunRawErrorCode | ManuscriptOperationError["code"];
  causeCode?: string;
  retryable: boolean;
  writeApplied: boolean | "unknown";
  verificationFailed: boolean;
}

export interface ExperimentRunRawDescriptorBase {
  ownerType: "experimentRun";
  ownerId: string;
  projectId: string;
  experimentId: string;
  channel: "primary";
  mode: ExperimentRunManuscriptWindowRole;
  fileRefId: string;
  role: "manuscript";
  locationMode: "managed" | "external";
  pathIdentityKey: string;
  fileName: string;
  currentFileRefId?: string;
  defaultFileRefId?: string;
  bindingIdentity: "current-resolved" | "not-read-independent";
  ownerDeleted: boolean;
  parentDeleted: boolean;
  readOnly: boolean;
}

export interface ExperimentRunRawResolvedTarget {
  run: ExperimentRun;
  parent: Experiment;
  descriptor: ExperimentRunRawDescriptorBase;
  file: DurableFileIdentity;
}
