import type { EntityId } from "./common";
import type {
  ExperimentWorkspacePathBudget,
  ExperimentWorkspacePathDescriptor
} from "./experimentWorkspacePath";
import type { ProvisionedMetadataState, ProvisioningErrorCode } from "./provisioning";

export const EXPERIMENT_PROVISIONING_ERROR_CODES = {
  ownerMissing: "EXPERIMENT_PROVISIONING_OWNER_MISSING",
  workspaceMissing: "EXPERIMENT_PROVISIONING_WORKSPACE_MISSING",
  workspaceDuplicate: "EXPERIMENT_PROVISIONING_WORKSPACE_DUPLICATE",
  workspaceIdentityMismatch: "EXPERIMENT_PROVISIONING_WORKSPACE_IDENTITY_MISMATCH",
  defaultFileMissing: "EXPERIMENT_PROVISIONING_DEFAULT_FILE_MISSING",
  defaultIdentityMismatch: "EXPERIMENT_PROVISIONING_DEFAULT_IDENTITY_MISMATCH",
  bindingMissing: "EXPERIMENT_PROVISIONING_BINDING_MISSING",
  bindingDuplicate: "EXPERIMENT_PROVISIONING_BINDING_DUPLICATE",
  bindingDefaultInvalid: "EXPERIMENT_PROVISIONING_BINDING_DEFAULT_INVALID",
  bindingCurrentInvalid: "EXPERIMENT_PROVISIONING_BINDING_CURRENT_INVALID",
  ownerChannelMismatch: "EXPERIMENT_PROVISIONING_OWNER_CHANNEL_MISMATCH",
  fileRoleMismatch: "EXPERIMENT_PROVISIONING_FILE_ROLE_MISMATCH",
  locationMismatch: "EXPERIMENT_PROVISIONING_LOCATION_MISMATCH",
  canonicalPathMismatch: "EXPERIMENT_PROVISIONING_CANONICAL_PATH_MISMATCH",
  rebuildRequired: "EXPERIMENT_PROVISIONING_REBUILD_REQUIRED",
  reconcileFailed: "EXPERIMENT_PROVISIONING_RECONCILE_FAILED"
} as const;

export type ExperimentProvisioningErrorCode =
  (typeof EXPERIMENT_PROVISIONING_ERROR_CODES)[keyof typeof EXPERIMENT_PROVISIONING_ERROR_CODES];

export type ExperimentProvisioningStage =
  | "owner"
  | "workspace"
  | "existing-metadata"
  | "default-manuscript"
  | "binding"
  | "current-manuscript"
  | "reconcile"
  | "ready";

export type ExperimentProvisioningState =
  | "idle"
  | "checking"
  | "fresh-create"
  | "ensure-workspace"
  | "ensure-default-file"
  | "ensure-binding"
  | "validating-existing"
  | "ready"
  | "rebuild-required"
  | "failed";

export type ExperimentProvisioningRecoverability =
  | "none"
  | "retry"
  | "rebuild-metadata";

export type ExperimentManuscriptProvisioningCompletionState =
  | "complete"
  | "partial"
  | "failed";

export type ExperimentProvisioningResourceState = "created" | "reused";

export interface ExperimentManuscriptProvisioningError {
  code: ProvisioningErrorCode | string;
  causeCode?: string;
  message: string;
  step: string;
}

export interface ExperimentManuscriptProvisioningIssue {
  ownerId: EntityId;
  stage: ExperimentProvisioningStage;
  code: ExperimentProvisioningErrorCode | ProvisioningErrorCode | string;
  causeCode?: string;
  operationId: string;
  metadataKind: "owner" | "workspace" | "default-manuscript" | "binding" | "current-manuscript" | "reconcile";
  recoverability: ExperimentProvisioningRecoverability;
  retryable: boolean;
  summary: string;
  completedSteps: string[];
  requestState: "idle" | "retrying";
}

export type ExperimentManuscriptProvisioningPreflightResult =
  | {
      status: "ready";
      ownerId: EntityId;
      retryable: true;
      descriptor: ExperimentWorkspacePathDescriptor;
      issue?: undefined;
    }
  | {
      status: "blocked";
      ownerId: EntityId;
      retryable: false;
      descriptor?: undefined;
      issue: ExperimentManuscriptProvisioningIssue;
    };

export type ExperimentManuscriptProvisioningInspection =
  | {
      status: "complete";
      ownerId: EntityId;
      descriptor: ExperimentWorkspacePathDescriptor;
      issue?: undefined;
    }
  | {
      status: "incomplete";
      ownerId: EntityId;
      descriptor?: ExperimentWorkspacePathDescriptor;
      issue: ExperimentManuscriptProvisioningIssue;
    };

export interface ExperimentManuscriptProvisioningResult {
  status: "success" | "skipped" | "partial" | "error";
  completionState: ExperimentManuscriptProvisioningCompletionState;
  ownerType: "experiment";
  ownerId: EntityId;
  channel: "primary";
  operationId: string;
  provisioningState: ExperimentProvisioningState;
  workspacePathIdentity?: string;
  defaultFilePath?: string;
  stableCode?: string;
  pathBudget?: ExperimentWorkspacePathBudget;
  defaultFolderFileRefId?: EntityId;
  defaultManuscriptFileRefId?: EntityId;
  bindingId?: EntityId;
  defaultFileRefId?: EntityId;
  currentFileRefId?: EntityId;
  folderFileRefState?: ProvisionedMetadataState;
  manuscriptFileRefState?: ProvisionedMetadataState;
  bindingState?: "created" | "reused";
  defaultState?: "initialized" | "preserved";
  currentState?: "initialized" | "preserved";
  physicalDirectoryState?: ExperimentProvisioningResourceState;
  physicalFileState?: ExperimentProvisioningResourceState;
  partialRecovery: boolean;
  readOnly: boolean;
  deleted: boolean;
  completedSteps: string[];
  errors: ExperimentManuscriptProvisioningError[];
  warnings: string[];
  retryable: boolean;
  effectOutcomeUnknown?: boolean;
  durableRootOperationId?: string;
  durableReady?: boolean;
}
