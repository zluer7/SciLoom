import { experimentRepositoryConfig } from "../repositories/entityConfig";
import { createRepository } from "../repositories/repositoryFactory";
import type {
  Experiment,
  FileRef,
  ManuscriptBinding,
  Project
} from "../types";
import type { EntityId } from "../types/common";
import type {
  ExperimentManuscriptProvisioningInspection,
  ExperimentManuscriptProvisioningIssue,
  ExperimentManuscriptProvisioningPreflightResult,
  ExperimentManuscriptProvisioningResult,
  ExperimentProvisioningRecoverability,
  ExperimentProvisioningStage
} from "../types/experimentProvisioning";
import { EXPERIMENT_PROVISIONING_ERROR_CODES } from "../types/experimentProvisioning";
import type { ExperimentWorkspacePathDescriptor } from "../types/experimentWorkspacePath";
import type {
  NativeProvisionExperimentManuscriptInput,
  NativeProvisionManagedEntryResult,
  ProvisionedMetadataState
} from "../types/provisioning";
import { PROVISIONING_ERROR_CODES } from "../types/provisioning";
import { buildExperimentWorkspacePath } from "./experimentWorkspacePathService";
import { createPathIdentityKey } from "./fileRefIdentity";
import { fileRefService } from "./fileRefService";
import { MANUSCRIPT_BLANK_INITIAL_CONTENT } from "./manuscriptBlankBody";
import { managedRootConfigService } from "./managedRootConfigService";
import { buildProjectFolderName } from "./managedPathService";
import { manuscriptBindingService } from "./manuscriptBindingService";
import { nativeProvisioningService } from "./nativeProvisioningService";
import { createOperationLog } from "./operationLogService";
import { getProjectById } from "./planningService";
import {
  type ValidatedPlanningAuthority,
  type ValidatedPlanningAuthorityHandle
} from "./planningOwnerAuthorityPort";
import { runWithProvisioningAuthority } from "./provisioningAuthorityGuard";
import {
  manuscriptProvisioningMainlineCoordinator,
  observedExperimentPrimarySteps
} from "./manuscriptProvisioningMainlineCoordinator";

export const EXPERIMENT_MANUSCRIPT_OWNER_TYPE = "experiment" as const;
export const EXPERIMENT_MANUSCRIPT_CHANNEL = "primary" as const;
export const EXPERIMENT_MANUSCRIPT_DEFAULT_FILE_NAME = "experiment.md" as const;
export const EXPERIMENT_CANONICAL_INITIAL_CONTENT_FIELD_ID =
  "labpod.experiment.canonical-initial-content.v1" as const;

type ProjectRecord = Pick<Project, "id" | "title" | "status" | "deletedAt">;

export interface ExperimentManuscriptProvisioningDependencies {
  loadExperiment(id: EntityId): Promise<Experiment | undefined>;
  loadProject(id: EntityId): Promise<ProjectRecord | undefined>;
  getRootStatus(): ReturnType<typeof managedRootConfigService.getStatus>;
  provisionFilesystem(
    input: NativeProvisionExperimentManuscriptInput
  ): Promise<NativeProvisionManagedEntryResult>;
  listFileRefs(ownerType: "experiment", ownerId: EntityId): Promise<FileRef[]>;
  registerFileRef: typeof fileRefService.registerFileRef;
  getBinding(
    ownerType: "experiment",
    ownerId: EntityId,
    channel: "primary"
  ): Promise<ManuscriptBinding | undefined>;
  getFileRefById(id: EntityId): Promise<FileRef | undefined>;
  validateBinding(binding: ManuscriptBinding): Promise<boolean>;
  upsertBindingDefaults: typeof manuscriptBindingService.upsertProvisionedDefaults;
  writeOperationLog(input: Parameters<typeof createOperationLog>[0]): Promise<unknown>;
  createOperationId?(): string;
}

const experimentRepository = createRepository(experimentRepositoryConfig);

const defaultDependencies: ExperimentManuscriptProvisioningDependencies = {
  async loadExperiment(id) {
    return (await experimentRepository.getById(id)) ??
      (await experimentRepository.getDeletedById(id));
  },
  async loadProject(id) {
    return getProjectById(id);
  },
  getRootStatus: () => managedRootConfigService.getStatus(),
  provisionFilesystem: (input) =>
    nativeProvisioningService.provisionExperimentManuscript(input),
  listFileRefs: (ownerType, ownerId) =>
    fileRefService.getFileRefsByOwnerIncludingDeleted(ownerType, ownerId),
  registerFileRef: (input, authorityPermit) =>
    fileRefService.registerFileRef(input, authorityPermit),
  getBinding: (ownerType, ownerId, channel) =>
    manuscriptBindingService.getBindingByOwner(ownerType, ownerId, channel),
  getFileRefById: (id) => fileRefService.getById(id),
  validateBinding: (binding) => manuscriptBindingService.validateBinding(binding),
  upsertBindingDefaults: (
    ownerType,
    ownerId,
    folderId,
    manuscriptId,
    channel,
    authorityPermit
  ) =>
    manuscriptBindingService.upsertProvisionedDefaults(
      ownerType,
      ownerId,
      folderId,
      manuscriptId,
      channel,
      authorityPermit
    ),
  async writeOperationLog(input) {
    await createOperationLog(input);
  },
  createOperationId: () => globalThis.crypto?.randomUUID?.() ??
    `experiment-provisioning-${Date.now()}-${Math.random().toString(16).slice(2)}`
};

function failedResult(
  ownerId: EntityId,
  code: string,
  message: string,
  step: string,
  operationId: string,
  causeCode: string,
  options: Partial<ExperimentManuscriptProvisioningResult> = {}
): ExperimentManuscriptProvisioningResult {
  return {
    status: "error",
    completionState: "failed",
    ownerType: EXPERIMENT_MANUSCRIPT_OWNER_TYPE,
    ownerId,
    channel: EXPERIMENT_MANUSCRIPT_CHANNEL,
    operationId,
    provisioningState: "failed",
    partialRecovery: false,
    readOnly: false,
    deleted: false,
    completedSteps: [],
    errors: [{ code, causeCode, message, step }],
    warnings: [],
    retryable: false,
    ...options
  };
}

function directParentIdentity(path: string) {
  const identity = createPathIdentityKey(path);
  return identity.slice(0, identity.lastIndexOf("/"));
}

function projectWorkspaceFromRegisteredExperimentPath(
  managedRoot: string,
  projectId: EntityId,
  path: string
) {
  const identity = createPathIdentityKey(path);
  const match = identity.match(/^(.*)\/\d{4}-\d{2}\/\d{2}\/experiment\/[^/]+$/u);
  if (!match) return undefined;
  const absolutePath = match[1];
  const folderName = absolutePath.slice(absolutePath.lastIndexOf("/") + 1);
  return {
    projectId,
    folderName,
    absolutePath,
    pathIdentityKey: absolutePath,
    managedRoot
  };
}

function isFormalFolder(fileRef: FileRef) {
  return !fileRef.deletedAt &&
    fileRef.resourceKind === "folder" &&
    fileRef.fileRole === "defaultFolder" &&
    fileRef.locationMode === "managed";
}

function isFormalManuscript(fileRef: FileRef) {
  return !fileRef.deletedAt &&
    fileRef.resourceKind === "file" &&
    fileRef.fileRole === "manuscript" &&
    fileRef.locationMode === "managed" &&
    fileRef.fileType === "markdown" &&
    fileRef.manuscriptChannel === EXPERIMENT_MANUSCRIPT_CHANNEL;
}

function metadataStateChanged(state?: ProvisionedMetadataState) {
  return state === "created";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown) {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return errorMessage(error).match(/^([A-Z][A-Z0-9_]+):/u)?.[1];
}

function issueSummary(code: string, causeCode?: string) {
  if (code === PROVISIONING_ERROR_CODES.pathInvalid && causeCode === "PATH_TOO_LONG") {
    return "The configured manuscript root and Project workspace exceed the safe path budget. Adjust the formal root or Project naming policy.";
  }
  if (code === PROVISIONING_ERROR_CODES.rootMissing) {
    return "Configure the managed manuscript root before creating the Experiment workspace.";
  }
  if (code === PROVISIONING_ERROR_CODES.rootInvalid) {
    return "The configured managed manuscript root is invalid. Update it before retrying.";
  }
  if (code === EXPERIMENT_PROVISIONING_ERROR_CODES.rebuildRequired) {
    return "The Experiment manuscript metadata must be rebuilt before the workspace can be used.";
  }
  return "The Experiment manuscript workspace is incomplete. Review the issue and retry when it is eligible.";
}

function createIssue(
  ownerId: EntityId,
  code: string,
  stage: ExperimentProvisioningStage,
  retryable: boolean,
  completedSteps: string[],
  causeCode: string,
  operationId: string,
  metadataKind: ExperimentManuscriptProvisioningIssue["metadataKind"],
  recoverability: ExperimentProvisioningRecoverability = retryable ? "retry" : "none"
): ExperimentManuscriptProvisioningIssue {
  return {
    ownerId,
    stage,
    code,
    causeCode,
    operationId,
    metadataKind,
    recoverability,
    retryable,
    summary: issueSummary(code, causeCode),
    completedSteps,
    requestState: "idle"
  };
}

export function experimentProvisioningIssueFromResult(
  ownerId: EntityId,
  result: ExperimentManuscriptProvisioningResult
): ExperimentManuscriptProvisioningIssue {
  const error = result.errors[0];
  const stage: ExperimentProvisioningStage = error?.step === "owner"
    ? "owner"
    : error?.step === "workspace" || error?.step === "filesystem" || error?.step === "default-folder-file-ref"
      ? "workspace"
      : error?.step === "default-manuscript" || error?.step === "default-manuscript-file-ref"
        ? "default-manuscript"
        : error?.step === "binding"
          ? "binding"
          : error?.step === "current-manuscript"
            ? "current-manuscript"
            : "reconcile";
  return createIssue(
    ownerId,
    error?.code ?? "PROVISIONING_INCOMPLETE",
    stage,
    result.retryable,
    result.completedSteps,
    error?.causeCode ?? "PROVISIONING_RESULT_INCOMPLETE",
    result.operationId,
    stage === "owner"
      ? "owner"
      : stage === "workspace"
        ? "workspace"
        : stage === "default-manuscript"
          ? "default-manuscript"
          : stage === "binding"
            ? "binding"
            : stage === "current-manuscript"
              ? "current-manuscript"
              : "reconcile"
  );
}

function buildDescriptorForExperiment(
  experiment: Experiment,
  project: ProjectRecord,
  managedRoot: string,
  existingRefs: FileRef[] = [],
  binding?: ManuscriptBinding
) {
  const formalFolders = existingRefs.filter(isFormalFolder);
  const boundDefault = binding?.defaultManuscriptFileRefId
    ? existingRefs.find((fileRef) => fileRef.id === binding.defaultManuscriptFileRefId && isFormalManuscript(fileRef))
    : undefined;
  const registeredWorkspacePath = formalFolders.length === 1
    ? formalFolders[0].path
    : boundDefault
      ? directParentIdentity(boundDefault.path)
      : undefined;
  const registeredProjectWorkspace = registeredWorkspacePath
    ? projectWorkspaceFromRegisteredExperimentPath(
        managedRoot,
        project.id,
        registeredWorkspacePath
      )
    : undefined;
  const projectFolderName = buildProjectFolderName(project.id, project.title);
  const freshProjectWorkspacePath = createPathIdentityKey(
    `${managedRoot}/projects/${projectFolderName}`
  );
  return buildExperimentWorkspacePath({
    managedRoot,
    projectWorkspace: registeredProjectWorkspace ?? {
      projectId: project.id,
      folderName: projectFolderName,
      absolutePath: freshProjectWorkspacePath,
      pathIdentityKey: freshProjectWorkspacePath
    },
    experimentId: experiment.id,
    createdLocalDate: experiment.createdLocalDate,
    createdLocalTime: experiment.createdLocalTime,
    creationTitleIdentity: experiment.workspaceTitleIdentity
  });
}

export function createExperimentManuscriptProvisioningService(
  dependencies: ExperimentManuscriptProvisioningDependencies = defaultDependencies
) {
  const ownerScopedInFlight = new Map<
    EntityId,
    Promise<ExperimentManuscriptProvisioningResult>
  >();

  function nextOperationId() {
    return dependencies.createOperationId?.() ??
      `experiment-provisioning-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  async function preflightExperimentManuscriptProvisioningCandidate(
    experiment: Experiment,
    existingRefs: FileRef[] = [],
    existingBinding?: ManuscriptBinding,
    operationId = nextOperationId()
  ): Promise<ExperimentManuscriptProvisioningPreflightResult> {
    if (experiment.deletedAt || experiment.status === "archived") {
      return {
        status: "blocked",
        ownerId: experiment.id,
        retryable: false,
        issue: createIssue(
          experiment.id,
          PROVISIONING_ERROR_CODES.ownerDeleted,
          "owner",
          false,
          [],
          experiment.deletedAt ? "EXPERIMENT_DELETED" : "EXPERIMENT_ARCHIVED",
          operationId,
          "owner"
        )
      };
    }
    const project = await dependencies.loadProject(experiment.projectId);
    if (!project || project.deletedAt || project.status === "archived") {
      return {
        status: "blocked",
        ownerId: experiment.id,
        retryable: false,
        issue: createIssue(
          experiment.id,
          PROVISIONING_ERROR_CODES.projectNotFound,
          "owner",
          false,
          ["owner"],
          "PROJECT_MISSING_OR_INACTIVE",
          operationId,
          "owner"
        )
      };
    }
    const rootStatus = await dependencies.getRootStatus();
    if (rootStatus.status !== "configured") {
      const code = rootStatus.status === "unconfigured"
        ? PROVISIONING_ERROR_CODES.rootMissing
        : PROVISIONING_ERROR_CODES.rootInvalid;
      return {
        status: "blocked",
        ownerId: experiment.id,
        retryable: false,
        issue: createIssue(
          experiment.id,
          code,
          "workspace",
          false,
          ["owner"],
          rootStatus.status === "unconfigured" ? "MANAGED_ROOT_UNCONFIGURED" : "MANAGED_ROOT_INVALID",
          operationId,
          "workspace"
        )
      };
    }
    try {
      return {
        status: "ready",
        ownerId: experiment.id,
        retryable: true,
        descriptor: buildDescriptorForExperiment(
          experiment,
          project,
          rootStatus.managedRoot,
          existingRefs,
          existingBinding
        )
      };
    } catch (error) {
      const causeCode = errorCode(error);
      return {
        status: "blocked",
        ownerId: experiment.id,
        retryable: false,
        issue: createIssue(
          experiment.id,
          PROVISIONING_ERROR_CODES.pathInvalid,
          "workspace",
          false,
          ["owner"],
          causeCode ?? "WORKSPACE_DESCRIPTOR_INVALID",
          operationId,
          "workspace"
        )
      };
    }
  }

  async function preflightExperimentManuscriptProvisioning(
    experimentId: EntityId
  ): Promise<ExperimentManuscriptProvisioningPreflightResult> {
    const operationId = nextOperationId();
    const experiment = await dependencies.loadExperiment(experimentId);
    if (!experiment) {
      return {
        status: "blocked",
        ownerId: experimentId,
        retryable: false,
        issue: createIssue(
          experimentId,
          EXPERIMENT_PROVISIONING_ERROR_CODES.ownerMissing,
          "owner",
          false,
          [],
          "EXPERIMENT_NOT_FOUND",
          operationId,
          "owner"
        )
      };
    }
    let existingRefs: FileRef[];
    let existingBinding: ManuscriptBinding | undefined;
    try {
      [existingRefs, existingBinding] = await Promise.all([
        dependencies.listFileRefs(EXPERIMENT_MANUSCRIPT_OWNER_TYPE, experimentId),
        dependencies.getBinding(
          EXPERIMENT_MANUSCRIPT_OWNER_TYPE,
          experimentId,
          EXPERIMENT_MANUSCRIPT_CHANNEL
        )
      ]);
    } catch (error) {
      return {
        status: "blocked",
        ownerId: experimentId,
        retryable: false,
        issue: createIssue(
          experimentId,
          EXPERIMENT_PROVISIONING_ERROR_CODES.reconcileFailed,
          "existing-metadata",
          false,
          ["owner"],
          errorCode(error) ?? "EXPERIMENT_METADATA_READ_FAILED",
          operationId,
          "reconcile"
        )
      };
    }
    return preflightExperimentManuscriptProvisioningCandidate(
      experiment,
      existingRefs,
      existingBinding,
      operationId
    );
  }

  async function inspectExperimentManuscriptProvisioning(
    experimentId: EntityId
  ): Promise<ExperimentManuscriptProvisioningInspection> {
    const preflight = await preflightExperimentManuscriptProvisioning(experimentId);
    if (preflight.status === "blocked") {
      return { status: "incomplete", ownerId: experimentId, issue: preflight.issue };
    }
    try {
      const [refs, binding] = await Promise.all([
        dependencies.listFileRefs(EXPERIMENT_MANUSCRIPT_OWNER_TYPE, experimentId),
        dependencies.getBinding(
          EXPERIMENT_MANUSCRIPT_OWNER_TYPE,
          experimentId,
          EXPERIMENT_MANUSCRIPT_CHANNEL
        )
      ]);
      const folders = refs.filter(isFormalFolder);
      const completedSteps = ["owner"];
      if (folders.length > 1) {
        return {
          status: "incomplete",
          ownerId: experimentId,
          descriptor: preflight.descriptor,
          issue: createIssue(
            experimentId,
            EXPERIMENT_PROVISIONING_ERROR_CODES.workspaceDuplicate,
            "workspace",
            false,
            completedSteps,
            `ACTIVE_CANONICAL_WORKSPACE_COUNT_${folders.length}`,
            nextOperationId(),
            "workspace",
            "rebuild-metadata"
          )
        };
      }
      const folder = folders[0];
      if (!folder) {
        return {
          status: "incomplete",
          ownerId: experimentId,
          descriptor: preflight.descriptor,
          issue: createIssue(
            experimentId,
            EXPERIMENT_PROVISIONING_ERROR_CODES.workspaceMissing,
            "workspace",
            true,
            completedSteps,
            "CANONICAL_WORKSPACE_FILE_REF_MISSING",
            nextOperationId(),
            "workspace"
          )
        };
      }
      if (
        folder.ownerType !== EXPERIMENT_MANUSCRIPT_OWNER_TYPE ||
        folder.ownerId !== experimentId ||
        folder.manuscriptChannel !== EXPERIMENT_MANUSCRIPT_CHANNEL
      ) {
        return {
          status: "incomplete",
          ownerId: experimentId,
          descriptor: preflight.descriptor,
          issue: createIssue(
            experimentId,
            EXPERIMENT_PROVISIONING_ERROR_CODES.ownerChannelMismatch,
            "workspace",
            false,
            completedSteps,
            "WORKSPACE_OWNER_CHANNEL_MISMATCH",
            nextOperationId(),
            "workspace",
            "rebuild-metadata"
          )
        };
      }
      if (
        folder.pathIdentityKey !== preflight.descriptor.pathIdentityKey ||
        createPathIdentityKey(folder.path) !== preflight.descriptor.pathIdentityKey
      ) {
        return {
          status: "incomplete",
          ownerId: experimentId,
          descriptor: preflight.descriptor,
          issue: createIssue(
            experimentId,
            EXPERIMENT_PROVISIONING_ERROR_CODES.workspaceIdentityMismatch,
            "workspace",
            false,
            completedSteps,
            "WORKSPACE_PATH_IDENTITY_MISMATCH",
            nextOperationId(),
            "workspace",
            "rebuild-metadata"
          )
        };
      }
      completedSteps.push("workspace");
      if (!binding) {
        return {
          status: "incomplete",
          ownerId: experimentId,
          descriptor: preflight.descriptor,
          issue: createIssue(
            experimentId,
            EXPERIMENT_PROVISIONING_ERROR_CODES.bindingMissing,
            "binding",
            true,
            completedSteps,
            "PRIMARY_BINDING_MISSING",
            nextOperationId(),
            "binding"
          )
        };
      }
      if (
        binding.ownerType !== EXPERIMENT_MANUSCRIPT_OWNER_TYPE ||
        binding.ownerId !== experimentId ||
        binding.manuscriptChannel !== EXPERIMENT_MANUSCRIPT_CHANNEL
      ) {
        return {
          status: "incomplete",
          ownerId: experimentId,
          descriptor: preflight.descriptor,
          issue: createIssue(
            experimentId,
            EXPERIMENT_PROVISIONING_ERROR_CODES.ownerChannelMismatch,
            "binding",
            false,
            completedSteps,
            "BINDING_OWNER_CHANNEL_MISMATCH",
            nextOperationId(),
            "binding",
            "rebuild-metadata"
          )
        };
      }
      if (binding.defaultFolderFileRefId !== folder.id) {
        return {
          status: "incomplete",
          ownerId: experimentId,
          descriptor: preflight.descriptor,
          issue: createIssue(
            experimentId,
            EXPERIMENT_PROVISIONING_ERROR_CODES.bindingDefaultInvalid,
            "binding",
            !binding.defaultFolderFileRefId,
            completedSteps,
            binding.defaultFolderFileRefId
              ? "BINDING_DEFAULT_FOLDER_MISMATCH"
              : "BINDING_DEFAULT_FOLDER_MISSING",
            nextOperationId(),
            "binding",
            binding.defaultFolderFileRefId ? "rebuild-metadata" : "retry"
          )
        };
      }
      completedSteps.push("binding");
      if (!binding.defaultManuscriptFileRefId) {
        return {
          status: "incomplete",
          ownerId: experimentId,
          descriptor: preflight.descriptor,
          issue: createIssue(
            experimentId,
            EXPERIMENT_PROVISIONING_ERROR_CODES.defaultFileMissing,
            "default-manuscript",
            true,
            completedSteps,
            "BINDING_DEFAULT_MANUSCRIPT_MISSING",
            nextOperationId(),
            "default-manuscript"
          )
        };
      }
      const defaultRef = refs.find((fileRef) => fileRef.id === binding.defaultManuscriptFileRefId);
      if (!defaultRef || defaultRef.deletedAt) {
        return {
          status: "incomplete",
          ownerId: experimentId,
          descriptor: preflight.descriptor,
          issue: createIssue(
            experimentId,
            EXPERIMENT_PROVISIONING_ERROR_CODES.defaultFileMissing,
            "default-manuscript",
            false,
            completedSteps,
            defaultRef?.deletedAt ? "DEFAULT_FILE_REF_SOFT_DELETED" : "DEFAULT_FILE_REF_NOT_FOUND",
            nextOperationId(),
            "default-manuscript",
            "rebuild-metadata"
          )
        };
      }
      if (!isFormalManuscript(defaultRef)) {
        return {
          status: "incomplete",
          ownerId: experimentId,
          descriptor: preflight.descriptor,
          issue: createIssue(
            experimentId,
            defaultRef.ownerType !== EXPERIMENT_MANUSCRIPT_OWNER_TYPE ||
              defaultRef.ownerId !== experimentId ||
              defaultRef.manuscriptChannel !== EXPERIMENT_MANUSCRIPT_CHANNEL
              ? EXPERIMENT_PROVISIONING_ERROR_CODES.ownerChannelMismatch
              : defaultRef.locationMode !== "managed"
                ? EXPERIMENT_PROVISIONING_ERROR_CODES.locationMismatch
                : EXPERIMENT_PROVISIONING_ERROR_CODES.fileRoleMismatch,
            "default-manuscript",
            false,
            completedSteps,
            "DEFAULT_FILE_REF_CONTRACT_MISMATCH",
            nextOperationId(),
            "default-manuscript",
            "rebuild-metadata"
          )
        };
      }
      if (
        defaultRef.pathIdentityKey !== preflight.descriptor.defaultFilePath ||
        createPathIdentityKey(defaultRef.path) !== preflight.descriptor.defaultFilePath
      ) {
        return {
          status: "incomplete",
          ownerId: experimentId,
          descriptor: preflight.descriptor,
          issue: createIssue(
            experimentId,
            EXPERIMENT_PROVISIONING_ERROR_CODES.defaultIdentityMismatch,
            "default-manuscript",
            false,
            completedSteps,
            "DEFAULT_PATH_IDENTITY_MISMATCH",
            nextOperationId(),
            "default-manuscript",
            "rebuild-metadata"
          )
        };
      }
      completedSteps.push("default-manuscript");
      if (!binding.currentFileRefId) {
        return {
          status: "incomplete",
          ownerId: experimentId,
          descriptor: preflight.descriptor,
          issue: createIssue(
            experimentId,
            EXPERIMENT_PROVISIONING_ERROR_CODES.bindingCurrentInvalid,
            "current-manuscript",
            true,
            completedSteps,
            "BINDING_CURRENT_MISSING",
            nextOperationId(),
            "current-manuscript"
          )
        };
      }
      const current = refs.find((fileRef) => fileRef.id === binding.currentFileRefId);
      if (!current || current.deletedAt) {
        return {
          status: "incomplete",
          ownerId: experimentId,
          descriptor: preflight.descriptor,
          issue: createIssue(
            experimentId,
            EXPERIMENT_PROVISIONING_ERROR_CODES.bindingCurrentInvalid,
            "current-manuscript",
            false,
            completedSteps,
            current?.deletedAt ? "CURRENT_FILE_REF_SOFT_DELETED" : "CURRENT_FILE_REF_NOT_FOUND",
            nextOperationId(),
            "current-manuscript",
            "rebuild-metadata"
          )
        };
      }
      if (
        current.ownerType !== EXPERIMENT_MANUSCRIPT_OWNER_TYPE ||
        current.ownerId !== experimentId ||
        current.manuscriptChannel !== EXPERIMENT_MANUSCRIPT_CHANNEL
      ) {
        return {
          status: "incomplete",
          ownerId: experimentId,
          descriptor: preflight.descriptor,
          issue: createIssue(
            experimentId,
            EXPERIMENT_PROVISIONING_ERROR_CODES.ownerChannelMismatch,
            "current-manuscript",
            false,
            completedSteps,
            "CURRENT_OWNER_CHANNEL_MISMATCH",
            nextOperationId(),
            "current-manuscript",
            "rebuild-metadata"
          )
        };
      }
      if (
        current.resourceKind !== "file" ||
        current.fileRole !== "manuscript" ||
        current.fileType !== "markdown"
      ) {
        return {
          status: "incomplete",
          ownerId: experimentId,
          descriptor: preflight.descriptor,
          issue: createIssue(
            experimentId,
            EXPERIMENT_PROVISIONING_ERROR_CODES.fileRoleMismatch,
            "current-manuscript",
            false,
            completedSteps,
            "CURRENT_FILE_REF_CONTRACT_MISMATCH",
            nextOperationId(),
            "current-manuscript",
            "rebuild-metadata"
          )
        };
      }
      if (current.locationMode !== "managed" && current.locationMode !== "external") {
        return {
          status: "incomplete",
          ownerId: experimentId,
          descriptor: preflight.descriptor,
          issue: createIssue(
            experimentId,
            EXPERIMENT_PROVISIONING_ERROR_CODES.locationMismatch,
            "current-manuscript",
            false,
            completedSteps,
            "CURRENT_LOCATION_MODE_INVALID",
            nextOperationId(),
            "current-manuscript",
            "rebuild-metadata"
          )
        };
      }
      await dependencies.validateBinding(binding);
      return { status: "complete", ownerId: experimentId, descriptor: preflight.descriptor };
    } catch (error) {
      return {
        status: "incomplete",
        ownerId: experimentId,
        descriptor: preflight.descriptor,
        issue: createIssue(
          experimentId,
          EXPERIMENT_PROVISIONING_ERROR_CODES.reconcileFailed,
          "reconcile",
          false,
          ["owner"],
          errorCode(error) ?? "BINDING_VALIDATION_FAILED",
          nextOperationId(),
          "reconcile",
          "rebuild-metadata"
        )
      };
    }
  }

  async function audit(result: ExperimentManuscriptProvisioningResult) {
    const meaningful = result.status !== "skipped";
    if (!meaningful) return result;
    const recovered = result.completionState === "complete" && result.partialRecovery;
    const summary = result.completionState === "failed"
      ? `Experiment manuscript provisioning failed at ${result.errors[0]?.step ?? "unknown"}.`
      : result.completionState === "partial"
        ? `Experiment manuscript provisioning is partial at ${result.errors[0]?.step ?? "unknown"}.`
        : recovered
          ? "Experiment manuscript provisioning recovered the formal identity."
          : "Experiment manuscript provisioning completed for the formal identity.";
    try {
      await dependencies.writeOperationLog({
        operationType: result.completionState === "complete" ? "create" : "custom",
        source: "system",
        module: "experiment",
        status: result.status,
        riskLevel: result.completionState === "complete" ? "low" : "medium",
        target: {
          entityType: EXPERIMENT_MANUSCRIPT_OWNER_TYPE,
          entityId: result.ownerId,
          title: "Experiment manuscript provisioning"
        },
        summary,
        relatedEntities: [
          ...(result.defaultFolderFileRefId
            ? [{ type: "fileRef", id: result.defaultFolderFileRefId, relation: "linked" }]
            : []),
          ...(result.defaultManuscriptFileRefId
            ? [{ type: "fileRef", id: result.defaultManuscriptFileRefId, relation: "linked" }]
            : [])
        ],
        warnings: result.warnings,
        errors: result.errors.map((error) => `${error.code}: ${error.message}`),
        skipped: [],
        isRecoverable: result.retryable,
        refreshKeys: ["operationLog.changed", "fileRef.changed"]
      });
    } catch (error) {
      return {
        ...result,
        warnings: [...result.warnings, `Operation log write failed: ${errorMessage(error)}`]
      };
    }
    return result;
  }

  async function executeExperimentManuscriptProvisioning(
    experimentId: EntityId,
    preflightDescriptor?: ExperimentWorkspacePathDescriptor,
    authorityPermit?: ValidatedPlanningAuthorityHandle,
    validatedAuthority?: ValidatedPlanningAuthority,
    durableOperationId?: string
  ): Promise<ExperimentManuscriptProvisioningResult> {
    const operationId = durableOperationId ?? nextOperationId();
    const experiment = await dependencies.loadExperiment(experimentId);
    if (!experiment) {
      return audit(failedResult(
        experimentId,
        EXPERIMENT_PROVISIONING_ERROR_CODES.ownerMissing,
        `Experiment not found: ${experimentId}.`,
        "owner",
        operationId,
        "EXPERIMENT_NOT_FOUND"
      ));
    }
    if (experiment.deletedAt || experiment.status === "archived") {
      return audit(failedResult(
        experimentId,
        PROVISIONING_ERROR_CODES.ownerDeleted,
        `Experiment is deleted or inactive: ${experimentId}.`,
        "owner",
        operationId,
        experiment.deletedAt ? "EXPERIMENT_DELETED" : "EXPERIMENT_ARCHIVED",
        { deleted: Boolean(experiment.deletedAt), readOnly: true }
      ));
    }

    const project = validatedAuthority
      ? {
          id: experiment.projectId,
          title: validatedAuthority.projectTitle ?? "",
          status: "active" as const
        }
      : await dependencies.loadProject(experiment.projectId);
    if (!project || project.deletedAt || project.status === "archived") {
      return audit(failedResult(
        experimentId,
        PROVISIONING_ERROR_CODES.projectNotFound,
        `Active Project not found: ${experiment.projectId}.`,
        "owner",
        operationId,
        "PROJECT_MISSING_OR_INACTIVE"
      ));
    }

    const rootStatus = await dependencies.getRootStatus();
    if (rootStatus.status !== "configured") {
      return audit(failedResult(
        experimentId,
        rootStatus.status === "unconfigured"
          ? PROVISIONING_ERROR_CODES.rootMissing
          : PROVISIONING_ERROR_CODES.rootInvalid,
        rootStatus.status === "unconfigured"
          ? "Managed root is not configured."
          : "Managed root is invalid.",
        "workspace",
        operationId,
        rootStatus.status === "unconfigured" ? "MANAGED_ROOT_UNCONFIGURED" : "MANAGED_ROOT_INVALID"
      ));
    }

    let existingRefs: FileRef[];
    let existingBinding: ManuscriptBinding | undefined;
    try {
      [existingRefs, existingBinding] = await Promise.all([
        dependencies.listFileRefs(EXPERIMENT_MANUSCRIPT_OWNER_TYPE, experimentId),
        dependencies.getBinding(
          EXPERIMENT_MANUSCRIPT_OWNER_TYPE,
          experimentId,
          EXPERIMENT_MANUSCRIPT_CHANNEL
        )
      ]);
    } catch (error) {
      return audit(failedResult(
        experimentId,
        EXPERIMENT_PROVISIONING_ERROR_CODES.reconcileFailed,
        errorMessage(error),
        "existing-metadata",
        operationId,
        errorCode(error) ?? "EXPERIMENT_METADATA_READ_FAILED"
      ));
    }

    const formalFolders = existingRefs.filter(isFormalFolder);
    const formalManuscripts = existingRefs.filter(isFormalManuscript);
    let descriptor: ExperimentWorkspacePathDescriptor;
    try {
      if (preflightDescriptor) {
        if (
          preflightDescriptor.ownerId !== experiment.id ||
          preflightDescriptor.projectId !== project.id ||
          createPathIdentityKey(preflightDescriptor.managedRoot) !==
            createPathIdentityKey(rootStatus.managedRoot) ||
          preflightDescriptor.createdLocalDate !== experiment.createdLocalDate ||
          preflightDescriptor.createdLocalTime !== experiment.createdLocalTime ||
          preflightDescriptor.creationTitleIdentity !== experiment.workspaceTitleIdentity
        ) {
          throw new Error("PREFLIGHT_DESCRIPTOR_STALE: Experiment provisioning facts changed after preflight.");
        }
        descriptor = preflightDescriptor;
      } else {
        descriptor = buildDescriptorForExperiment(
          experiment,
          project,
          rootStatus.managedRoot,
          existingRefs,
          existingBinding
        );
      }
    } catch (error) {
      return audit(failedResult(
        experimentId,
        PROVISIONING_ERROR_CODES.pathInvalid,
        errorMessage(error),
        "workspace",
        operationId,
        errorCode(error) ?? "WORKSPACE_DESCRIPTOR_INVALID"
      ));
    }

    if (formalFolders.length > 1) {
      return audit(failedResult(
        experimentId,
        EXPERIMENT_PROVISIONING_ERROR_CODES.workspaceDuplicate,
        "Multiple active canonical Experiment workspace FileRefs exist.",
        "workspace",
        operationId,
        `ACTIVE_CANONICAL_WORKSPACE_COUNT_${formalFolders.length}`,
        {
          provisioningState: "rebuild-required",
          workspacePathIdentity: descriptor.pathIdentityKey,
          defaultFilePath: descriptor.defaultFilePath,
          pathBudget: descriptor.pathBudget
        }
      ));
    }

    const existingFolder = formalFolders[0];
    if (existingFolder && (
      existingFolder.pathIdentityKey !== descriptor.pathIdentityKey ||
      createPathIdentityKey(existingFolder.path) !== descriptor.pathIdentityKey ||
      existingFolder.fileType !== "folder"
    )) {
      return audit(failedResult(
        experimentId,
        EXPERIMENT_PROVISIONING_ERROR_CODES.workspaceIdentityMismatch,
        "The active Experiment workspace FileRef does not match the canonical workspace identity.",
        "workspace",
        operationId,
        "WORKSPACE_PATH_IDENTITY_MISMATCH",
        {
          provisioningState: "rebuild-required",
          workspacePathIdentity: descriptor.pathIdentityKey,
          defaultFilePath: descriptor.defaultFilePath,
          pathBudget: descriptor.pathBudget
        }
      ));
    }
    if (existingBinding && (
      existingBinding.ownerType !== EXPERIMENT_MANUSCRIPT_OWNER_TYPE ||
      existingBinding.ownerId !== experimentId ||
      existingBinding.manuscriptChannel !== EXPERIMENT_MANUSCRIPT_CHANNEL
    )) {
      return audit(failedResult(
        experimentId,
        EXPERIMENT_PROVISIONING_ERROR_CODES.ownerChannelMismatch,
        "The primary Experiment Binding has an invalid owner or channel.",
        "binding",
        operationId,
        "BINDING_OWNER_CHANNEL_MISMATCH",
        { provisioningState: "rebuild-required" }
      ));
    }
    if (
      existingBinding?.defaultFolderFileRefId &&
      (!existingFolder || existingBinding.defaultFolderFileRefId !== existingFolder.id)
    ) {
      return audit(failedResult(
        experimentId,
        EXPERIMENT_PROVISIONING_ERROR_CODES.bindingDefaultInvalid,
        "The primary Binding default workspace does not match the canonical workspace.",
        "binding",
        operationId,
        "BINDING_DEFAULT_FOLDER_MISMATCH",
        { provisioningState: "rebuild-required" }
      ));
    }

    const boundDefault = existingBinding?.defaultManuscriptFileRefId
      ? existingRefs.find((fileRef) => fileRef.id === existingBinding.defaultManuscriptFileRefId)
      : undefined;
    if (existingBinding?.defaultManuscriptFileRefId && (!boundDefault || boundDefault.deletedAt)) {
      return audit(failedResult(
        experimentId,
        EXPERIMENT_PROVISIONING_ERROR_CODES.bindingDefaultInvalid,
        "The primary Binding default manuscript is missing or inactive.",
        "default-manuscript",
        operationId,
        boundDefault?.deletedAt ? "DEFAULT_FILE_REF_SOFT_DELETED" : "DEFAULT_FILE_REF_NOT_FOUND",
        { provisioningState: "rebuild-required" }
      ));
    }
    if (boundDefault && !isFormalManuscript(boundDefault)) {
      return audit(failedResult(
        experimentId,
        boundDefault.ownerType !== EXPERIMENT_MANUSCRIPT_OWNER_TYPE ||
          boundDefault.ownerId !== experimentId ||
          boundDefault.manuscriptChannel !== EXPERIMENT_MANUSCRIPT_CHANNEL
          ? EXPERIMENT_PROVISIONING_ERROR_CODES.ownerChannelMismatch
          : boundDefault.locationMode !== "managed"
            ? EXPERIMENT_PROVISIONING_ERROR_CODES.locationMismatch
            : EXPERIMENT_PROVISIONING_ERROR_CODES.fileRoleMismatch,
        "The primary Binding default manuscript does not satisfy the canonical FileRef contract.",
        "default-manuscript",
        operationId,
        "DEFAULT_FILE_REF_CONTRACT_MISMATCH",
        { provisioningState: "rebuild-required" }
      ));
    }
    if (boundDefault && (
      boundDefault.pathIdentityKey !== descriptor.defaultFilePath ||
      createPathIdentityKey(boundDefault.path) !== descriptor.defaultFilePath ||
      directParentIdentity(boundDefault.path) !== descriptor.pathIdentityKey
    )) {
      return audit(failedResult(
        experimentId,
        EXPERIMENT_PROVISIONING_ERROR_CODES.defaultIdentityMismatch,
        "The primary Binding default manuscript does not match the canonical default identity.",
        "default-manuscript",
        operationId,
        "DEFAULT_PATH_IDENTITY_MISMATCH",
        { provisioningState: "rebuild-required" }
      ));
    }

    const boundCurrent = existingBinding?.currentFileRefId
      ? existingRefs.find((fileRef) => fileRef.id === existingBinding.currentFileRefId)
      : undefined;
    if (existingBinding?.currentFileRefId && (!boundCurrent || boundCurrent.deletedAt)) {
      return audit(failedResult(
        experimentId,
        EXPERIMENT_PROVISIONING_ERROR_CODES.bindingCurrentInvalid,
        "The primary Binding current manuscript is missing, inactive, or has an invalid role.",
        "current-manuscript",
        operationId,
        boundCurrent?.deletedAt ? "CURRENT_FILE_REF_SOFT_DELETED" : "CURRENT_FILE_REF_NOT_FOUND",
        { provisioningState: "rebuild-required" }
      ));
    }
    if (boundCurrent && (
      boundCurrent.ownerType !== EXPERIMENT_MANUSCRIPT_OWNER_TYPE ||
      boundCurrent.ownerId !== experimentId ||
      boundCurrent.manuscriptChannel !== EXPERIMENT_MANUSCRIPT_CHANNEL
    )) {
      return audit(failedResult(
        experimentId,
        EXPERIMENT_PROVISIONING_ERROR_CODES.ownerChannelMismatch,
        "The primary Binding current manuscript belongs to another owner or channel.",
        "current-manuscript",
        operationId,
        "CURRENT_OWNER_CHANNEL_MISMATCH",
        { provisioningState: "rebuild-required" }
      ));
    }
    if (boundCurrent && (
      boundCurrent.resourceKind !== "file" ||
      boundCurrent.fileRole !== "manuscript" ||
      boundCurrent.fileType !== "markdown"
    )) {
      return audit(failedResult(
        experimentId,
        EXPERIMENT_PROVISIONING_ERROR_CODES.fileRoleMismatch,
        "The primary Binding current reference does not satisfy the manuscript FileRef contract.",
        "current-manuscript",
        operationId,
        "CURRENT_FILE_REF_CONTRACT_MISMATCH",
        { provisioningState: "rebuild-required" }
      ));
    }
    if (boundCurrent && boundCurrent.locationMode !== "managed" && boundCurrent.locationMode !== "external") {
      return audit(failedResult(
        experimentId,
        EXPERIMENT_PROVISIONING_ERROR_CODES.locationMismatch,
        "The primary Binding current manuscript has an invalid location mode.",
        "current-manuscript",
        operationId,
        "CURRENT_LOCATION_MODE_INVALID",
        { provisioningState: "rebuild-required" }
      ));
    }
    if (existingBinding) {
      try {
        await dependencies.validateBinding(existingBinding);
      } catch (error) {
        return audit(failedResult(
          experimentId,
          EXPERIMENT_PROVISIONING_ERROR_CODES.reconcileFailed,
          errorMessage(error),
          "reconcile",
          operationId,
          errorCode(error) ?? "BINDING_VALIDATION_FAILED",
          { provisioningState: "rebuild-required" }
        ));
      }
    }

    const canonicalDefaultCandidates = formalManuscripts.filter(
      (fileRef) => fileRef.pathIdentityKey === descriptor.defaultFilePath &&
        createPathIdentityKey(fileRef.path) === descriptor.defaultFilePath
    );
    if (canonicalDefaultCandidates.length > 1) {
      return audit(failedResult(
        experimentId,
        EXPERIMENT_PROVISIONING_ERROR_CODES.defaultIdentityMismatch,
        "Multiple active FileRefs claim the canonical default manuscript identity.",
        "default-manuscript",
        operationId,
        `ACTIVE_CANONICAL_DEFAULT_COUNT_${canonicalDefaultCandidates.length}`,
        { provisioningState: "rebuild-required" }
      ));
    }
    const existingManuscript = boundDefault ?? canonicalDefaultCandidates[0];
    const bindingHasMissingDefaults = Boolean(existingBinding) && (
      !existingBinding?.defaultFolderFileRefId ||
      !existingBinding?.defaultManuscriptFileRefId ||
      !existingBinding?.currentFileRefId
    );

    const canonicalInitialContent = MANUSCRIPT_BLANK_INITIAL_CONTENT;
    let native: NativeProvisionManagedEntryResult;
    try {
      native = await dependencies.provisionFilesystem({
        configuredRoot: descriptor.managedRoot,
        projectWorkspace: descriptor.projectWorkspace.absolutePath,
        targetWorkspace: descriptor.absolutePath,
        defaultFilePath: descriptor.defaultFilePath,
        initialContent: canonicalInitialContent
      });
    } catch (error) {
      return audit(failedResult(
        experimentId,
        PROVISIONING_ERROR_CODES.directoryCreateFailed,
        errorMessage(error),
        "filesystem",
        operationId,
        errorCode(error) ?? "PROVISIONING_FILESYSTEM_CALL_FAILED",
        {
          status: "partial",
          completionState: "partial",
          workspacePathIdentity: descriptor.pathIdentityKey,
          defaultFilePath: descriptor.defaultFilePath,
          stableCode: descriptor.stableCode,
          pathBudget: descriptor.pathBudget,
          effectOutcomeUnknown: true,
          retryable: true,
          completedSteps: []
        }
      ));
    }
    const physicalDirectoryState = native.createdDirectory ? "created" as const :
      native.reusedDirectory ? "reused" as const : undefined;
    const physicalFileState = native.createdBody ? "created" as const :
      native.reusedBody ? "reused" as const : undefined;
    const physicalSteps = [
      ...(physicalDirectoryState ? ["workspace"] : []),
      ...(physicalFileState ? ["default-manuscript-file"] : [])
    ];
    if (
      native.status === "error" ||
      native.status === "partial" ||
      createPathIdentityKey(native.directoryPath) !== descriptor.pathIdentityKey ||
      createPathIdentityKey(native.bodyPath) !== descriptor.defaultFilePath
    ) {
      return audit(failedResult(
        experimentId,
        native.errorCode ?? PROVISIONING_ERROR_CODES.pathInvalid,
        native.errorMessage ?? "Rust provisioning returned an inconsistent C-1 identity.",
        "filesystem",
        operationId,
        native.errorCode ?? "PROVISIONING_NATIVE_IDENTITY_MISMATCH",
        {
          status: native.status === "partial" || existingFolder || existingManuscript || existingBinding
            ? "partial"
            : "error",
          completionState: native.status === "partial" || existingFolder || existingManuscript || existingBinding
            ? "partial"
            : "failed",
          workspacePathIdentity: descriptor.pathIdentityKey,
          defaultFilePath: descriptor.defaultFilePath,
          stableCode: descriptor.stableCode,
          pathBudget: descriptor.pathBudget,
          physicalDirectoryState,
          physicalFileState,
          completedSteps: physicalSteps,
          retryable: native.retryable
        }
      ));
    }

    const completedSteps = [...physicalSteps];
    let folderResult: { fileRef: FileRef; state: ProvisionedMetadataState };
    try {
      folderResult = await dependencies.registerFileRef({
        ownerType: EXPERIMENT_MANUSCRIPT_OWNER_TYPE,
        ownerId: experimentId,
        manuscriptChannel: EXPERIMENT_MANUSCRIPT_CHANNEL,
        resourceKind: "folder",
        fileRole: "defaultFolder",
        locationMode: "managed",
        fileType: "folder",
        path: descriptor.absolutePath,
        title: experiment.title,
        source: "system"
      }, authorityPermit);
      completedSteps.push("default-folder-file-ref");
    } catch (error) {
      return audit(failedResult(
        experimentId,
        PROVISIONING_ERROR_CODES.defaultFolderFileRefFailed,
        errorMessage(error),
        "default-folder-file-ref",
        operationId,
        errorCode(error) ?? "DEFAULT_FOLDER_FILE_REF_ENSURE_FAILED",
        {
          status: "partial",
          completionState: "partial",
          workspacePathIdentity: descriptor.pathIdentityKey,
          defaultFilePath: descriptor.defaultFilePath,
          stableCode: descriptor.stableCode,
          pathBudget: descriptor.pathBudget,
          physicalDirectoryState,
          physicalFileState,
          completedSteps,
          retryable: true
        }
      ));
    }

    let manuscriptResult: { fileRef: FileRef; state: ProvisionedMetadataState };
    try {
      manuscriptResult = await dependencies.registerFileRef({
        ownerType: EXPERIMENT_MANUSCRIPT_OWNER_TYPE,
        ownerId: experimentId,
        manuscriptChannel: EXPERIMENT_MANUSCRIPT_CHANNEL,
        resourceKind: "file",
        fileRole: "manuscript",
        locationMode: "managed",
        fileType: "markdown",
        path: descriptor.defaultFilePath,
        title: EXPERIMENT_MANUSCRIPT_DEFAULT_FILE_NAME,
        source: "system",
        customFields: [{
          id: EXPERIMENT_CANONICAL_INITIAL_CONTENT_FIELD_ID,
          name: EXPERIMENT_CANONICAL_INITIAL_CONTENT_FIELD_ID,
          value: canonicalInitialContent,
          valueType: "text"
        }]
      }, authorityPermit);
      completedSteps.push("default-manuscript-file-ref");
    } catch (error) {
      return audit(failedResult(
        experimentId,
        PROVISIONING_ERROR_CODES.defaultManuscriptFileRefFailed,
        errorMessage(error),
        "default-manuscript-file-ref",
        operationId,
        errorCode(error) ?? "DEFAULT_MANUSCRIPT_FILE_REF_ENSURE_FAILED",
        {
          status: "partial",
          completionState: "partial",
          workspacePathIdentity: descriptor.pathIdentityKey,
          defaultFilePath: descriptor.defaultFilePath,
          stableCode: descriptor.stableCode,
          pathBudget: descriptor.pathBudget,
          defaultFolderFileRefId: folderResult.fileRef.id,
          folderFileRefState: folderResult.state,
          physicalDirectoryState,
          physicalFileState,
          completedSteps,
          retryable: true
        }
      ));
    }

    const bindingFeedback = await dependencies.upsertBindingDefaults(
      EXPERIMENT_MANUSCRIPT_OWNER_TYPE,
      experimentId,
      folderResult.fileRef.id,
      manuscriptResult.fileRef.id,
      EXPERIMENT_MANUSCRIPT_CHANNEL,
      authorityPermit
    );
    if (bindingFeedback.status === "error" || !bindingFeedback.data) {
      return audit(failedResult(
        experimentId,
        PROVISIONING_ERROR_CODES.bindingFailed,
        bindingFeedback.errors.join("; ") || "Primary binding provisioning failed.",
        "binding",
        operationId,
        "PRIMARY_BINDING_UPSERT_FAILED",
        {
          status: "partial",
          completionState: "partial",
          workspacePathIdentity: descriptor.pathIdentityKey,
          defaultFilePath: descriptor.defaultFilePath,
          stableCode: descriptor.stableCode,
          pathBudget: descriptor.pathBudget,
          defaultFolderFileRefId: folderResult.fileRef.id,
          defaultManuscriptFileRefId: manuscriptResult.fileRef.id,
          folderFileRefState: folderResult.state,
          manuscriptFileRefState: manuscriptResult.state,
          physicalDirectoryState,
          physicalFileState,
          completedSteps,
          retryable: true
        }
      ));
    }
    completedSteps.push("binding");

    const binding = bindingFeedback.data;
    try {
      await dependencies.validateBinding(binding);
      const current = binding.currentFileRefId
        ? await dependencies.getFileRefById(binding.currentFileRefId)
        : undefined;
      if (
        folderResult.fileRef.deletedAt ||
        manuscriptResult.fileRef.deletedAt ||
        folderResult.fileRef.ownerType !== EXPERIMENT_MANUSCRIPT_OWNER_TYPE ||
        folderResult.fileRef.ownerId !== experimentId ||
        folderResult.fileRef.pathIdentityKey !== descriptor.pathIdentityKey ||
        manuscriptResult.fileRef.ownerType !== EXPERIMENT_MANUSCRIPT_OWNER_TYPE ||
        manuscriptResult.fileRef.ownerId !== experimentId ||
        manuscriptResult.fileRef.pathIdentityKey !== descriptor.defaultFilePath ||
        binding.ownerType !== EXPERIMENT_MANUSCRIPT_OWNER_TYPE ||
        binding.ownerId !== experimentId ||
        binding.manuscriptChannel !== EXPERIMENT_MANUSCRIPT_CHANNEL ||
        binding.defaultFolderFileRefId !== folderResult.fileRef.id ||
        binding.defaultManuscriptFileRefId !== manuscriptResult.fileRef.id ||
        !binding.currentFileRefId ||
        !current ||
        current.ownerType !== EXPERIMENT_MANUSCRIPT_OWNER_TYPE ||
        current.ownerId !== experimentId ||
        current.fileRole !== "manuscript" ||
        current.resourceKind !== "file" ||
        current.manuscriptChannel !== EXPERIMENT_MANUSCRIPT_CHANNEL
      ) {
        throw new Error("Provisioned FileRef/Binding identity is inconsistent.");
      }
    } catch (error) {
      return audit(failedResult(
        experimentId,
        EXPERIMENT_PROVISIONING_ERROR_CODES.reconcileFailed,
        errorMessage(error),
        "reconcile",
        operationId,
        errorCode(error) ?? "POST_ENSURE_CONTRACT_MISMATCH",
        {
          status: "partial",
          completionState: "partial",
          workspacePathIdentity: descriptor.pathIdentityKey,
          defaultFilePath: descriptor.defaultFilePath,
          stableCode: descriptor.stableCode,
          pathBudget: descriptor.pathBudget,
          defaultFolderFileRefId: folderResult.fileRef.id,
          defaultManuscriptFileRefId: manuscriptResult.fileRef.id,
          bindingId: binding.id,
          defaultFileRefId: binding.defaultManuscriptFileRefId ?? undefined,
          currentFileRefId: binding.currentFileRefId ?? undefined,
          physicalDirectoryState,
          physicalFileState,
          completedSteps,
          retryable: false
        }
      ));
    }

    const bindingChanged = bindingFeedback.status === "success";
    const changed = native.createdBody ||
      metadataStateChanged(folderResult.state) ||
      metadataStateChanged(manuscriptResult.state) ||
      bindingChanged;
    const partialRecovery = (
      (native.reusedDirectory || native.reusedBody) &&
        (!existingFolder || !existingManuscript || !existingBinding || bindingHasMissingDefaults)
    ) || (
      (native.createdDirectory || native.createdBody) &&
        Boolean(existingFolder || existingManuscript || existingBinding)
    );
    return audit({
      status: changed ? "success" : "skipped",
      completionState: "complete",
      ownerType: EXPERIMENT_MANUSCRIPT_OWNER_TYPE,
      ownerId: experimentId,
      channel: EXPERIMENT_MANUSCRIPT_CHANNEL,
      operationId,
      provisioningState: "ready",
      workspacePathIdentity: descriptor.pathIdentityKey,
      defaultFilePath: descriptor.defaultFilePath,
      stableCode: descriptor.stableCode,
      pathBudget: descriptor.pathBudget,
      defaultFolderFileRefId: folderResult.fileRef.id,
      defaultManuscriptFileRefId: manuscriptResult.fileRef.id,
      bindingId: binding.id,
      defaultFileRefId: binding.defaultManuscriptFileRefId ?? undefined,
      currentFileRefId: binding.currentFileRefId ?? undefined,
      folderFileRefState: folderResult.state,
      manuscriptFileRefState: manuscriptResult.state,
      bindingState: existingBinding || bindingFeedback.status === "skipped" ? "reused" : "created",
      defaultState: existingBinding?.defaultManuscriptFileRefId ? "preserved" : "initialized",
      currentState: existingBinding?.currentFileRefId ? "preserved" : "initialized",
      physicalDirectoryState,
      physicalFileState,
      partialRecovery,
      readOnly: false,
      deleted: false,
      completedSteps,
      errors: [],
      warnings: bindingFeedback.warnings,
      retryable: false
    });
  }

  function ensureExperimentManuscriptProvisioned(
    experimentId: EntityId,
    preflightDescriptor?: ExperimentWorkspacePathDescriptor,
    authorityPermit?: ValidatedPlanningAuthorityHandle,
    validatedAuthority?: ValidatedPlanningAuthority,
    durableOperationId?: string
  ): Promise<ExperimentManuscriptProvisioningResult> {
    const active = ownerScopedInFlight.get(experimentId);
    if (active) {
      return active;
    }
    const operation = executeExperimentManuscriptProvisioning(
      experimentId,
      preflightDescriptor,
      authorityPermit,
      validatedAuthority,
      durableOperationId
    );
    ownerScopedInFlight.set(experimentId, operation);
    const release = () => {
      if (ownerScopedInFlight.get(experimentId) === operation) {
        ownerScopedInFlight.delete(experimentId);
      }
    };
    void operation.then(release, release);
    return operation;
  }

  return {
    preflightExperimentManuscriptProvisioningCandidate,
    preflightExperimentManuscriptProvisioning,
    inspectExperimentManuscriptProvisioning,
    ensureExperimentManuscriptProvisioned
  };
}

const experimentManuscriptProvisioningCore =
  createExperimentManuscriptProvisioningService();

export const experimentManuscriptProvisioningService = {
  ...experimentManuscriptProvisioningCore,
  async ensureExperimentManuscriptProvisioned(
    experimentId: EntityId,
    preflightDescriptor?: ExperimentWorkspacePathDescriptor
  ) {
    const experiment = (await experimentRepository.getById(experimentId)) ??
      (await experimentRepository.getDeletedById(experimentId));
    if (!experiment) {
      return failedResult(
        experimentId,
        "EXPERIMENT_NOT_FOUND",
        `Experiment not found: ${experimentId}`,
        "owner-validation",
        `experiment-admission-${Date.now()}`,
        "OWNER_NOT_FOUND"
      );
    }
    try {
      const preflight = preflightDescriptor
        ? { status: "ready" as const, descriptor: preflightDescriptor }
        : await experimentManuscriptProvisioningCore
          .preflightExperimentManuscriptProvisioning(experimentId);
      if (preflight.status !== "ready") {
        return failedResult(
          experimentId,
          preflight.issue.code ?? "EXPERIMENT_PROVISIONING_PREFLIGHT_FAILED",
          preflight.issue.summary ?? "Experiment provisioning preflight failed.",
          "preflight",
          `experiment-preflight-${Date.now()}`,
          preflight.issue.causeCode ?? preflight.issue.code ?? "PREFLIGHT_FAILED",
          {
            retryable: preflight.issue.retryable,
            readOnly: preflight.issue.code === PROVISIONING_ERROR_CODES.ownerDeleted,
            deleted: preflight.issue.causeCode === "EXPERIMENT_DELETED"
          }
        );
      }
      return await runWithProvisioningAuthority({
        request: {
          intent: "provisioningWrite",
          requestId: `experiment-provisioning-${experimentId}`,
          projectId: experiment.projectId,
          ownerType: EXPERIMENT_MANUSCRIPT_OWNER_TYPE,
          ownerId: experimentId,
          scope: EXPERIMENT_MANUSCRIPT_CHANNEL
        },
        write: async (permit, authority) => {
          const identity = {
            ownerType: EXPERIMENT_MANUSCRIPT_OWNER_TYPE,
            ownerId: experimentId,
            scope: "primary" as const,
            manuscriptChannel: EXPERIMENT_MANUSCRIPT_CHANNEL,
            expectedDirectoryPath: preflight.descriptor.absolutePath,
            expectedManuscripts: [{
              manuscriptChannel: EXPERIMENT_MANUSCRIPT_CHANNEL,
              path: preflight.descriptor.defaultFilePath
            }]
          };
          const operation = await manuscriptProvisioningMainlineCoordinator.begin(identity, permit);
          const result = await experimentManuscriptProvisioningCore.ensureExperimentManuscriptProvisioned(
            experimentId,
            preflight.descriptor,
            permit,
            authority,
            operation.operationId
          );
          const effectReady = result.completionState === "complete";
          let terminal;
          try {
            terminal = await manuscriptProvisioningMainlineCoordinator.finish(
              identity,
              operation.operationId,
              effectReady,
              result.errors[0]?.code,
              observedExperimentPrimarySteps(result),
              permit,
              result.effectOutcomeUnknown === true
            );
          } catch (finishError) {
            return {
              ...result,
              status: "partial" as const,
              completionState: "partial" as const,
              operationId: operation.operationId,
              durableRootOperationId: operation.rootOperationId,
              durableReady: false,
              retryable: false,
              warnings: [
                ...result.warnings,
                `Experiment manuscript terminal confirmation is unavailable; automatic retry is disabled: ${errorMessage(finishError)}`
              ]
            };
          }
          return {
            ...result,
            status: terminal.ready
              ? result.status
              : terminal.operationStatus === "terminal-failed"
                ? result.status
                : "partial" as const,
            completionState: terminal.ready
              ? result.completionState
              : terminal.operationStatus === "terminal-failed"
                ? result.completionState
                : "partial" as const,
            operationId: terminal.operationId,
            durableRootOperationId: terminal.rootOperationId,
            durableReady: terminal.ready,
            retryable: terminal.ready ? result.retryable : terminal.nextAction === "retry"
          };
        }
      });
    } catch (error) {
      const message = errorMessage(error);
      return failedResult(
        experimentId,
        errorCode(error) ?? "EXPERIMENT_PROVISIONING_AUTHORITY_UNAVAILABLE",
        message,
        "mainline-admission",
        `experiment-authority-${Date.now()}`,
        errorCode(error) ?? "AUTHORITY_UNAVAILABLE"
      );
    }
  }
};

export const ensureExperimentManuscriptProvisioned = (
  experimentId: EntityId,
  preflightDescriptor?: ExperimentWorkspacePathDescriptor
) => experimentManuscriptProvisioningService.ensureExperimentManuscriptProvisioned(
  experimentId,
  preflightDescriptor
);

export const recoverExperimentManuscriptProvisioning = (experimentId: EntityId) =>
  experimentManuscriptProvisioningService.ensureExperimentManuscriptProvisioned(experimentId);

export const preflightExperimentManuscriptProvisioningCandidate = (experiment: Experiment) =>
  experimentManuscriptProvisioningService.preflightExperimentManuscriptProvisioningCandidate(experiment);

export const preflightExperimentManuscriptProvisioning = (experimentId: EntityId) =>
  experimentManuscriptProvisioningService.preflightExperimentManuscriptProvisioning(experimentId);

export const inspectExperimentManuscriptProvisioning = (experimentId: EntityId) =>
  experimentManuscriptProvisioningService.inspectExperimentManuscriptProvisioning(experimentId);
