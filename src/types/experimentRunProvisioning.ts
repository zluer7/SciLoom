import type { EntityId } from "./common";
import type { ProvisionedMetadataState, ProvisioningErrorCode } from "./provisioning";

export type ExperimentRunManuscriptProvisioningCompletionState =
  | "complete"
  | "partial"
  | "failed";

export type ExperimentRunProvisioningResourceState = "created" | "reused";

export interface ExperimentRunManuscriptProvisioningError {
  code: ProvisioningErrorCode | string;
  message: string;
  step: string;
}

export interface ExperimentRunManuscriptProvisioningResult {
  status: "success" | "skipped" | "partial" | "error";
  completionState: ExperimentRunManuscriptProvisioningCompletionState;
  ownerType: "experimentRun";
  ownerId: EntityId;
  channel: "primary";
  parentExperimentId?: EntityId;
  parentWorkspacePathIdentity?: string;
  workspacePathIdentity?: string;
  defaultFilePath?: string;
  stableCode?: string;
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
  physicalDirectoryState?: ExperimentRunProvisioningResourceState;
  physicalFileState?: ExperimentRunProvisioningResourceState;
  partialRecovery: boolean;
  writable: boolean;
  readOnly: boolean;
  deleted: boolean;
  completedSteps: string[];
  errors: ExperimentRunManuscriptProvisioningError[];
  warnings: string[];
  retryable: boolean;
  effectOutcomeUnknown?: boolean;
  operationId?: string;
  durableRootOperationId?: string;
  durableReady?: boolean;
}
