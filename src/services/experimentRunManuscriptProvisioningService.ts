import type { Experiment, ExperimentRun, FileRef, ManuscriptBinding } from "../types";
import type { EntityId } from "../types/common";
import type { ExperimentManuscriptProvisioningResult } from "../types/experimentProvisioning";
import type { ExperimentRunManuscriptProvisioningResult } from "../types/experimentRunProvisioning";
import type {
  NativeProvisionExperimentRunManuscriptInput,
  NativeProvisionManagedEntryResult,
  ProvisionedMetadataState
} from "../types/provisioning";
import { PROVISIONING_ERROR_CODES } from "../types/provisioning";
import { ensureExperimentManuscriptProvisioned } from "./experimentManuscriptProvisioningService";
import { assertExperimentRunWritable } from "./experimentRunGuard";
import {
  buildExperimentRunWorkspacePath,
  buildExperimentWorkspacePath
} from "./experimentWorkspacePathService";
import { createPathIdentityKey } from "./fileRefIdentity";
import { fileRefService } from "./fileRefService";
import { MANUSCRIPT_BLANK_INITIAL_CONTENT } from "./manuscriptBlankBody";
import { managedRootConfigService } from "./managedRootConfigService";
import { manuscriptBindingService } from "./manuscriptBindingService";
import { nativeProvisioningService } from "./nativeProvisioningService";
import { createOperationLog } from "./operationLogService";
import type { ValidatedPlanningAuthorityHandle } from "./planningOwnerAuthorityPort";
import { runWithProvisioningAuthority } from "./provisioningAuthorityGuard";
import {
  manuscriptProvisioningMainlineCoordinator,
  observedExperimentPrimarySteps
} from "./manuscriptProvisioningMainlineCoordinator";

export const EXPERIMENT_RUN_MANUSCRIPT_OWNER_TYPE = "experimentRun" as const;
export const EXPERIMENT_RUN_MANUSCRIPT_CHANNEL = "primary" as const;
export const EXPERIMENT_RUN_MANUSCRIPT_DEFAULT_FILE_NAME = "experiment-run.md" as const;

type WritableRunAccess = {
  run: ExperimentRun;
  parent: Experiment;
  readOnly: false;
  parentDeleted: false;
};

export interface ExperimentRunManuscriptProvisioningDependencies {
  assertRunWritable(runId: EntityId): Promise<WritableRunAccess>;
  ensureParentExperiment(experimentId: EntityId): Promise<ExperimentManuscriptProvisioningResult>;
  getRootStatus(): ReturnType<typeof managedRootConfigService.getStatus>;
  provisionFilesystem(
    input: NativeProvisionExperimentRunManuscriptInput
  ): Promise<NativeProvisionManagedEntryResult>;
  listFileRefs(ownerType: "experimentRun", ownerId: EntityId): Promise<FileRef[]>;
  registerFileRef(
    input: Parameters<typeof fileRefService.registerFileRef>[0],
    authorityPermit?: ValidatedPlanningAuthorityHandle
  ): ReturnType<typeof fileRefService.registerFileRef>;
  getBinding(
    ownerType: "experimentRun",
    ownerId: EntityId,
    channel: "primary"
  ): Promise<ManuscriptBinding | undefined>;
  getFileRefById(id: EntityId): Promise<FileRef | undefined>;
  validateBinding(binding: ManuscriptBinding): Promise<boolean>;
  upsertBindingDefaults(
    ownerType: "experimentRun",
    ownerId: EntityId,
    folderId: EntityId,
    manuscriptId: EntityId,
    channel: "primary",
    authorityPermit?: ValidatedPlanningAuthorityHandle
  ): ReturnType<typeof manuscriptBindingService.upsertProvisionedDefaults>;
  writeOperationLog(input: Parameters<typeof createOperationLog>[0]): Promise<unknown>;
}

const defaultDependencies: ExperimentRunManuscriptProvisioningDependencies = {
  assertRunWritable: async (runId) => {
    const access = await assertExperimentRunWritable(runId);
    return {
      run: access.run,
      parent: access.parent,
      readOnly: false,
      parentDeleted: false
    };
  },
  ensureParentExperiment: (experimentId) =>
    ensureExperimentManuscriptProvisioned(experimentId),
  getRootStatus: () => managedRootConfigService.getStatus(),
  provisionFilesystem: (input) =>
    nativeProvisioningService.provisionExperimentRunManuscript(input),
  listFileRefs: (ownerType, ownerId) =>
    fileRefService.getFileRefsByOwnerIncludingDeleted(ownerType, ownerId),
  registerFileRef: (input, authorityPermit) => fileRefService.registerFileRef(input, authorityPermit),
  getBinding: (ownerType, ownerId, channel) =>
    manuscriptBindingService.getBindingByOwner(ownerType, ownerId, channel),
  getFileRefById: (id) => fileRefService.getById(id),
  validateBinding: (binding) => manuscriptBindingService.validateBinding(binding),
  upsertBindingDefaults: (ownerType, ownerId, folderId, manuscriptId, channel, authorityPermit) =>
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
  }
};


function failedResult(
  ownerId: EntityId,
  code: string,
  message: string,
  step: string,
  options: Partial<ExperimentRunManuscriptProvisioningResult> = {}
): ExperimentRunManuscriptProvisioningResult {
  return {
    status: "error",
    completionState: "failed",
    ownerType: EXPERIMENT_RUN_MANUSCRIPT_OWNER_TYPE,
    ownerId,
    channel: EXPERIMENT_RUN_MANUSCRIPT_CHANNEL,
    partialRecovery: false,
    writable: false,
    readOnly: false,
    deleted: false,
    completedSteps: [],
    errors: [{ code, message, step }],
    warnings: [],
    retryable: false,
    ...options
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function stableErrorCode(error: unknown, fallback: string) {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return fallback;
}

function directParentIdentity(path: string) {
  const identity = createPathIdentityKey(path);
  return identity.slice(0, identity.lastIndexOf("/"));
}

function projectWorkspaceFromRegisteredExperimentPath(
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
    pathIdentityKey: absolutePath
  };
}

function isFormalFolder(fileRef: FileRef) {
  return fileRef.resourceKind === "folder" &&
    fileRef.fileRole === "defaultFolder" &&
    fileRef.locationMode === "managed";
}

function isFormalManuscript(fileRef: FileRef) {
  return fileRef.resourceKind === "file" &&
    fileRef.fileRole === "manuscript" &&
    fileRef.locationMode === "managed" &&
    fileRef.manuscriptChannel === EXPERIMENT_RUN_MANUSCRIPT_CHANNEL;
}

function metadataStateChanged(state?: ProvisionedMetadataState) {
  return state === "created";
}

export function createExperimentRunManuscriptProvisioningService(
  dependencies: ExperimentRunManuscriptProvisioningDependencies = defaultDependencies
) {
  async function audit(result: ExperimentRunManuscriptProvisioningResult) {
    if (result.status === "skipped") return result;
    const recovered = result.completionState === "complete" && result.partialRecovery;
    const summary = result.completionState === "failed"
      ? `ExperimentRun manuscript provisioning failed at ${result.errors[0]?.step ?? "unknown"}.`
      : result.completionState === "partial"
        ? `ExperimentRun manuscript provisioning is partial at ${result.errors[0]?.step ?? "unknown"}.`
        : recovered
          ? "ExperimentRun manuscript provisioning recovered the formal identity."
          : "ExperimentRun manuscript provisioning completed for the formal identity.";
    try {
      await dependencies.writeOperationLog({
        operationType: result.completionState === "complete" ? "create" : "custom",
        source: "system",
        module: "experiment",
        status: result.status,
        riskLevel: result.completionState === "complete" ? "low" : "medium",
        target: {
          entityType: EXPERIMENT_RUN_MANUSCRIPT_OWNER_TYPE,
          entityId: result.ownerId,
          title: "ExperimentRun manuscript provisioning"
        },
        summary,
        relatedEntities: [
          ...(result.parentExperimentId
            ? [{ type: "experiment", id: result.parentExperimentId, relation: "parent" }]
            : []),
          ...(result.defaultFolderFileRefId
            ? [{ type: "fileRef", id: result.defaultFolderFileRefId, relation: "linked" }]
            : []),
          ...(result.defaultManuscriptFileRefId
            ? [{ type: "fileRef", id: result.defaultManuscriptFileRefId, relation: "linked" }]
            : [])
        ],
        warnings: result.warnings,
        errors: result.errors.map((error) => `${error.code} at ${error.step}`),
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

  async function ensureExperimentRunManuscriptProvisioned(
    runId: EntityId,
    authorityPermit?: ValidatedPlanningAuthorityHandle,
    prevalidatedParentProvisioning?: ExperimentManuscriptProvisioningResult
  ): Promise<ExperimentRunManuscriptProvisioningResult> {
    let access: WritableRunAccess;
    try {
      access = await dependencies.assertRunWritable(runId);
    } catch (error) {
      const code = stableErrorCode(error, PROVISIONING_ERROR_CODES.ownerNotFound);
      return failedResult(runId, code, errorMessage(error), "run-write-guard", {
        readOnly: code === "EXPERIMENT_RUN_PARENT_DELETED" || code === "EXPERIMENT_RUN_DELETED",
        deleted: code === "EXPERIMENT_RUN_DELETED"
      });
    }
    const { run, parent } = access;

    let parentProvisioning: ExperimentManuscriptProvisioningResult;
    try {
      parentProvisioning = prevalidatedParentProvisioning ??
        await dependencies.ensureParentExperiment(parent.id);
    } catch (error) {
      return audit(failedResult(
        runId,
        PROVISIONING_ERROR_CODES.metadataConflict,
        errorMessage(error),
        "parent-provisioning",
        { parentExperimentId: parent.id, writable: true }
      ));
    }
    if (
      parentProvisioning.completionState !== "complete" ||
      !parentProvisioning.workspacePathIdentity ||
      !parentProvisioning.defaultFolderFileRefId
    ) {
      const parentError = parentProvisioning.errors[0];
      return audit(failedResult(
        runId,
        parentError?.code ?? PROVISIONING_ERROR_CODES.metadataConflict,
        parentError?.message ?? "Parent Experiment provisioning is incomplete.",
        "parent-provisioning",
        { parentExperimentId: parent.id, writable: true, retryable: parentProvisioning.retryable }
      ));
    }

    let rootStatus: Awaited<ReturnType<typeof dependencies.getRootStatus>>;
    try {
      rootStatus = await dependencies.getRootStatus();
    } catch (error) {
      return audit(failedResult(
        runId,
        PROVISIONING_ERROR_CODES.rootInvalid,
        errorMessage(error),
        "root-validation",
        { parentExperimentId: parent.id, writable: true, retryable: true }
      ));
    }
    if (rootStatus.status !== "configured") {
      return audit(failedResult(
        runId,
        rootStatus.status === "unconfigured"
          ? PROVISIONING_ERROR_CODES.rootMissing
          : PROVISIONING_ERROR_CODES.rootInvalid,
        rootStatus.status === "unconfigured"
          ? "Managed root is not configured."
          : "Managed root is invalid.",
        "root-validation",
        { parentExperimentId: parent.id, writable: true }
      ));
    }

    let parentFolder: FileRef | undefined;
    try {
      parentFolder = await dependencies.getFileRefById(
        parentProvisioning.defaultFolderFileRefId
      );
    } catch (error) {
      return audit(failedResult(
        runId,
        PROVISIONING_ERROR_CODES.metadataConflict,
        errorMessage(error),
        "parent-workspace-identity",
        {
          parentExperimentId: parent.id,
          parentWorkspacePathIdentity: parentProvisioning.workspacePathIdentity,
          writable: true,
          retryable: true
        }
      ));
    }
    if (
      !parentFolder ||
      parentFolder.deletedAt ||
      parentFolder.ownerType !== "experiment" ||
      parentFolder.ownerId !== parent.id ||
      parentFolder.manuscriptChannel !== "primary" ||
      !isFormalFolder(parentFolder) ||
      createPathIdentityKey(parentFolder.path) !== parentProvisioning.workspacePathIdentity ||
      parentFolder.pathIdentityKey !== parentProvisioning.workspacePathIdentity
    ) {
      return audit(failedResult(
        runId,
        PROVISIONING_ERROR_CODES.metadataConflict,
        "Parent Experiment default folder identity is missing or inconsistent.",
        "parent-workspace-identity",
        {
          parentExperimentId: parent.id,
          parentWorkspacePathIdentity: parentProvisioning.workspacePathIdentity,
          writable: true
        }
      ));
    }

    let descriptor;
    try {
      const projectWorkspace = projectWorkspaceFromRegisteredExperimentPath(
        parent.projectId,
        parentFolder.path
      );
      if (!projectWorkspace) {
        throw new Error("Parent Experiment workspace is not a formal C-1 identity.");
      }
      const parentDescriptor = buildExperimentWorkspacePath({
        managedRoot: rootStatus.managedRoot,
        projectWorkspace,
        experimentId: parent.id,
        createdLocalDate: parent.createdLocalDate,
        createdLocalTime: parent.createdLocalTime,
        creationTitleIdentity: parent.workspaceTitleIdentity
      });
      if (
        parentDescriptor.pathIdentityKey !== parentProvisioning.workspacePathIdentity ||
        parentDescriptor.pathIdentityKey !== parentFolder.pathIdentityKey
      ) {
        throw new Error("Parent Experiment descriptor does not match its registered identity.");
      }
      descriptor = buildExperimentRunWorkspacePath({
        managedRoot: rootStatus.managedRoot,
        projectWorkspace,
        parentExperimentId: parent.id,
        parentExperimentWorkspace: parentDescriptor,
        runId: run.id,
        createdLocalDate: run.createdLocalDate,
        createdLocalTime: run.createdLocalTime,
        creationTitleIdentity: run.workspaceTitleIdentity
      });
    } catch (error) {
      return audit(failedResult(
        runId,
        PROVISIONING_ERROR_CODES.pathInvalid,
        errorMessage(error),
        "descriptor",
        {
          parentExperimentId: parent.id,
          parentWorkspacePathIdentity: parentProvisioning.workspacePathIdentity,
          writable: true
        }
      ));
    }

    let existingRefs: FileRef[];
    let existingBinding: ManuscriptBinding | undefined;
    try {
      [existingRefs, existingBinding] = await Promise.all([
        dependencies.listFileRefs(EXPERIMENT_RUN_MANUSCRIPT_OWNER_TYPE, runId),
        dependencies.getBinding(
          EXPERIMENT_RUN_MANUSCRIPT_OWNER_TYPE,
          runId,
          EXPERIMENT_RUN_MANUSCRIPT_CHANNEL
        )
      ]);
    } catch (error) {
      return audit(failedResult(
        runId,
        PROVISIONING_ERROR_CODES.metadataConflict,
        errorMessage(error),
        "existing-binding-validation",
        {
          parentExperimentId: parent.id,
          parentWorkspacePathIdentity: parentProvisioning.workspacePathIdentity,
          workspacePathIdentity: descriptor.pathIdentityKey,
          defaultFilePath: descriptor.defaultFilePath,
          writable: true
        }
      ));
    }

    const formalFolders = existingRefs.filter(isFormalFolder);
    const formalManuscripts = existingRefs.filter(isFormalManuscript);
    const canonicalDefaultCandidates = formalManuscripts.filter(
      (fileRef) => fileRef.pathIdentityKey === descriptor.defaultFilePath &&
        createPathIdentityKey(fileRef.path) === descriptor.defaultFilePath
    );
    const folderIdentityValid = formalFolders.length <= 1 && formalFolders.every(
      (fileRef) => fileRef.ownerType === EXPERIMENT_RUN_MANUSCRIPT_OWNER_TYPE &&
        fileRef.ownerId === runId &&
        fileRef.pathIdentityKey === descriptor.pathIdentityKey &&
        createPathIdentityKey(fileRef.path) === descriptor.pathIdentityKey &&
        fileRef.fileType === "folder"
    );
    const manuscriptIdentityValid = canonicalDefaultCandidates.length <= 1 && canonicalDefaultCandidates.every(
      (fileRef) => fileRef.ownerType === EXPERIMENT_RUN_MANUSCRIPT_OWNER_TYPE &&
        fileRef.ownerId === runId &&
        fileRef.pathIdentityKey === descriptor.defaultFilePath &&
        createPathIdentityKey(fileRef.path) === descriptor.defaultFilePath &&
        fileRef.fileType === "markdown" &&
        directParentIdentity(fileRef.path) === descriptor.pathIdentityKey
    );
    if (!folderIdentityValid || !manuscriptIdentityValid) {
      return audit(failedResult(
        runId,
        PROVISIONING_ERROR_CODES.metadataConflict,
        "ExperimentRun managed default FileRef identity conflicts with the C-1 descriptor.",
        "existing-metadata",
        {
          parentExperimentId: parent.id,
          parentWorkspacePathIdentity: parentProvisioning.workspacePathIdentity,
          workspacePathIdentity: descriptor.pathIdentityKey,
          defaultFilePath: descriptor.defaultFilePath,
          writable: true
        }
      ));
    }

    if (existingBinding && (
      existingBinding.ownerType !== EXPERIMENT_RUN_MANUSCRIPT_OWNER_TYPE ||
      existingBinding.ownerId !== runId ||
      existingBinding.manuscriptChannel !== EXPERIMENT_RUN_MANUSCRIPT_CHANNEL
    )) {
      return audit(failedResult(
        runId,
        PROVISIONING_ERROR_CODES.metadataConflict,
        "ExperimentRun primary Binding owner or channel is inconsistent.",
        "existing-binding-validation",
        {
          parentExperimentId: parent.id,
          parentWorkspacePathIdentity: parentProvisioning.workspacePathIdentity,
          workspacePathIdentity: descriptor.pathIdentityKey,
          defaultFilePath: descriptor.defaultFilePath,
          writable: true
        }
      ));
    }

    const existingFolder = formalFolders[0];
    const boundFolder = existingBinding?.defaultFolderFileRefId
      ? existingRefs.find((fileRef) => fileRef.id === existingBinding.defaultFolderFileRefId)
      : undefined;
    if (existingBinding?.defaultFolderFileRefId && (
      !boundFolder ||
      !isFormalFolder(boundFolder) ||
      boundFolder.ownerType !== EXPERIMENT_RUN_MANUSCRIPT_OWNER_TYPE ||
      boundFolder.ownerId !== runId ||
      boundFolder.manuscriptChannel !== EXPERIMENT_RUN_MANUSCRIPT_CHANNEL ||
      boundFolder.fileType !== "folder" ||
      boundFolder.pathIdentityKey !== descriptor.pathIdentityKey ||
      createPathIdentityKey(boundFolder.path) !== descriptor.pathIdentityKey
    )) {
      return audit(failedResult(
        runId,
        PROVISIONING_ERROR_CODES.metadataConflict,
        "ExperimentRun Binding default folder does not match the canonical identity.",
        "existing-binding-default",
        {
          parentExperimentId: parent.id,
          parentWorkspacePathIdentity: parentProvisioning.workspacePathIdentity,
          workspacePathIdentity: descriptor.pathIdentityKey,
          defaultFilePath: descriptor.defaultFilePath,
          writable: true
        }
      ));
    }
    const boundDefault = existingBinding?.defaultManuscriptFileRefId
      ? existingRefs.find((fileRef) => fileRef.id === existingBinding.defaultManuscriptFileRefId)
      : undefined;
    if (existingBinding?.defaultManuscriptFileRefId && !boundDefault) {
      return audit(failedResult(
        runId,
        PROVISIONING_ERROR_CODES.metadataConflict,
        "ExperimentRun Binding default manuscript is missing.",
        "existing-binding-default",
        {
          parentExperimentId: parent.id,
          parentWorkspacePathIdentity: parentProvisioning.workspacePathIdentity,
          workspacePathIdentity: descriptor.pathIdentityKey,
          defaultFilePath: descriptor.defaultFilePath,
          writable: true
        }
      ));
    }
    if (boundDefault && (
      !isFormalManuscript(boundDefault) ||
      boundDefault.pathIdentityKey !== descriptor.defaultFilePath ||
      createPathIdentityKey(boundDefault.path) !== descriptor.defaultFilePath ||
      directParentIdentity(boundDefault.path) !== descriptor.pathIdentityKey
    )) {
      return audit(failedResult(
        runId,
        PROVISIONING_ERROR_CODES.metadataConflict,
        "ExperimentRun Binding default manuscript does not match the canonical identity.",
        "existing-binding-default",
        {
          parentExperimentId: parent.id,
          parentWorkspacePathIdentity: parentProvisioning.workspacePathIdentity,
          workspacePathIdentity: descriptor.pathIdentityKey,
          defaultFilePath: descriptor.defaultFilePath,
          writable: true
        }
      ));
    }
    const boundCurrent = existingBinding?.currentFileRefId
      ? existingRefs.find((fileRef) => fileRef.id === existingBinding.currentFileRefId)
      : undefined;
    if (existingBinding?.currentFileRefId && !boundCurrent) {
      return audit(failedResult(
        runId,
        PROVISIONING_ERROR_CODES.metadataConflict,
        "ExperimentRun Binding current manuscript is missing.",
        "existing-binding-current",
        {
          parentExperimentId: parent.id,
          parentWorkspacePathIdentity: parentProvisioning.workspacePathIdentity,
          workspacePathIdentity: descriptor.pathIdentityKey,
          defaultFilePath: descriptor.defaultFilePath,
          writable: true
        }
      ));
    }
    if (boundCurrent && (
      boundCurrent.ownerType !== EXPERIMENT_RUN_MANUSCRIPT_OWNER_TYPE ||
      boundCurrent.ownerId !== runId ||
      boundCurrent.manuscriptChannel !== EXPERIMENT_RUN_MANUSCRIPT_CHANNEL ||
      boundCurrent.resourceKind !== "file" ||
      boundCurrent.fileRole !== "manuscript" ||
      boundCurrent.fileType !== "markdown" ||
      (boundCurrent.locationMode !== "managed" && boundCurrent.locationMode !== "external") ||
      (boundCurrent.deletedAt && boundCurrent.id !== boundDefault?.id)
    )) {
      return audit(failedResult(
        runId,
        PROVISIONING_ERROR_CODES.metadataConflict,
        "ExperimentRun Binding current manuscript is invalid or inactive.",
        "existing-binding-current",
        {
          parentExperimentId: parent.id,
          parentWorkspacePathIdentity: parentProvisioning.workspacePathIdentity,
          workspacePathIdentity: descriptor.pathIdentityKey,
          defaultFilePath: descriptor.defaultFilePath,
          writable: true
        }
      ));
    }
    const existingManuscript = boundDefault ?? canonicalDefaultCandidates[0];
    const bindingHasMissingDefaults = Boolean(existingBinding) && (
      !existingBinding?.defaultFolderFileRefId ||
      !existingBinding?.defaultManuscriptFileRefId ||
      !existingBinding?.currentFileRefId
    );

    let native: NativeProvisionManagedEntryResult;
    try {
      native = await dependencies.provisionFilesystem({
        configuredRoot: descriptor.managedRoot,
        projectWorkspace: descriptor.projectWorkspace.absolutePath,
        parentExperimentWorkspace: parentFolder.path,
        targetWorkspace: descriptor.absolutePath,
        defaultFilePath: descriptor.defaultFilePath,
        initialContent: MANUSCRIPT_BLANK_INITIAL_CONTENT
      });
    } catch (error) {
      return audit(failedResult(
        runId,
        PROVISIONING_ERROR_CODES.directoryCreateFailed,
        errorMessage(error),
        "filesystem",
        {
          status: "partial",
          completionState: "partial",
          parentExperimentId: parent.id,
          parentWorkspacePathIdentity: parentProvisioning.workspacePathIdentity,
          workspacePathIdentity: descriptor.pathIdentityKey,
          defaultFilePath: descriptor.defaultFilePath,
          stableCode: descriptor.stableCode,
          effectOutcomeUnknown: true,
          writable: true,
          retryable: true
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
      const partial = native.status === "partial" || Boolean(
        existingFolder || existingManuscript || existingBinding
      );
      return audit(failedResult(
        runId,
        native.errorCode ?? PROVISIONING_ERROR_CODES.pathInvalid,
        native.errorMessage ?? "Rust provisioning returned an inconsistent C-1 Run identity.",
        "filesystem",
        {
          status: partial ? "partial" : "error",
          completionState: partial ? "partial" : "failed",
          parentExperimentId: parent.id,
          parentWorkspacePathIdentity: parentProvisioning.workspacePathIdentity,
          workspacePathIdentity: descriptor.pathIdentityKey,
          defaultFilePath: descriptor.defaultFilePath,
          stableCode: descriptor.stableCode,
          physicalDirectoryState,
          physicalFileState,
          completedSteps: physicalSteps,
          writable: true,
          retryable: native.retryable
        }
      ));
    }

    const completedSteps = [...physicalSteps];
    let folderResult: { fileRef: FileRef; state: ProvisionedMetadataState };
    try {
      folderResult = await dependencies.registerFileRef({
        ownerType: EXPERIMENT_RUN_MANUSCRIPT_OWNER_TYPE,
        ownerId: runId,
        manuscriptChannel: EXPERIMENT_RUN_MANUSCRIPT_CHANNEL,
        resourceKind: "folder",
        fileRole: "defaultFolder",
        locationMode: "managed",
        fileType: "folder",
        path: descriptor.absolutePath,
        title: run.title,
        source: "system"
      }, authorityPermit);
      const folderReadback = await dependencies.getFileRefById(folderResult.fileRef.id);
      if (
        !folderReadback ||
        folderReadback.deletedAt ||
        folderReadback.ownerType !== EXPERIMENT_RUN_MANUSCRIPT_OWNER_TYPE ||
        folderReadback.ownerId !== runId ||
        folderReadback.manuscriptChannel !== EXPERIMENT_RUN_MANUSCRIPT_CHANNEL ||
        !isFormalFolder(folderReadback) ||
        folderReadback.fileType !== "folder" ||
        folderReadback.pathIdentityKey !== descriptor.pathIdentityKey ||
        createPathIdentityKey(folderReadback.path) !== descriptor.pathIdentityKey
      ) {
        throw new Error("ExperimentRun default folder FileRef readback is inconsistent.");
      }
      folderResult = { ...folderResult, fileRef: folderReadback };
      completedSteps.push("default-folder-file-ref");
    } catch (error) {
      return audit(failedResult(
        runId,
        PROVISIONING_ERROR_CODES.defaultFolderFileRefFailed,
        errorMessage(error),
        "default-folder-file-ref",
        {
          status: "partial",
          completionState: "partial",
          parentExperimentId: parent.id,
          parentWorkspacePathIdentity: parentProvisioning.workspacePathIdentity,
          workspacePathIdentity: descriptor.pathIdentityKey,
          defaultFilePath: descriptor.defaultFilePath,
          stableCode: descriptor.stableCode,
          physicalDirectoryState,
          physicalFileState,
          completedSteps,
          writable: true,
          retryable: true
        }
      ));
    }

    let manuscriptResult: { fileRef: FileRef; state: ProvisionedMetadataState };
    try {
      manuscriptResult = await dependencies.registerFileRef({
        ownerType: EXPERIMENT_RUN_MANUSCRIPT_OWNER_TYPE,
        ownerId: runId,
        manuscriptChannel: EXPERIMENT_RUN_MANUSCRIPT_CHANNEL,
        resourceKind: "file",
        fileRole: "manuscript",
        locationMode: "managed",
        fileType: "markdown",
        path: descriptor.defaultFilePath,
        title: EXPERIMENT_RUN_MANUSCRIPT_DEFAULT_FILE_NAME,
        source: "system"
      }, authorityPermit);
      const manuscriptReadback = await dependencies.getFileRefById(manuscriptResult.fileRef.id);
      if (
        !manuscriptReadback ||
        manuscriptReadback.deletedAt ||
        manuscriptReadback.ownerType !== EXPERIMENT_RUN_MANUSCRIPT_OWNER_TYPE ||
        manuscriptReadback.ownerId !== runId ||
        manuscriptReadback.manuscriptChannel !== EXPERIMENT_RUN_MANUSCRIPT_CHANNEL ||
        !isFormalManuscript(manuscriptReadback) ||
        manuscriptReadback.fileType !== "markdown" ||
        manuscriptReadback.pathIdentityKey !== descriptor.defaultFilePath ||
        createPathIdentityKey(manuscriptReadback.path) !== descriptor.defaultFilePath ||
        directParentIdentity(manuscriptReadback.path) !== descriptor.pathIdentityKey
      ) {
        throw new Error("ExperimentRun default manuscript FileRef readback is inconsistent.");
      }
      manuscriptResult = { ...manuscriptResult, fileRef: manuscriptReadback };
      completedSteps.push("default-manuscript-file-ref");
    } catch (error) {
      return audit(failedResult(
        runId,
        PROVISIONING_ERROR_CODES.defaultManuscriptFileRefFailed,
        errorMessage(error),
        "default-manuscript-file-ref",
        {
          status: "partial",
          completionState: "partial",
          parentExperimentId: parent.id,
          parentWorkspacePathIdentity: parentProvisioning.workspacePathIdentity,
          workspacePathIdentity: descriptor.pathIdentityKey,
          defaultFilePath: descriptor.defaultFilePath,
          stableCode: descriptor.stableCode,
          defaultFolderFileRefId: folderResult.fileRef.id,
          folderFileRefState: folderResult.state,
          physicalDirectoryState,
          physicalFileState,
          completedSteps,
          writable: true,
          retryable: true
        }
      ));
    }

    let bindingFeedback: Awaited<ReturnType<typeof dependencies.upsertBindingDefaults>>;
    try {
      bindingFeedback = await dependencies.upsertBindingDefaults(
        EXPERIMENT_RUN_MANUSCRIPT_OWNER_TYPE,
        runId,
        folderResult.fileRef.id,
        manuscriptResult.fileRef.id,
        EXPERIMENT_RUN_MANUSCRIPT_CHANNEL,
        authorityPermit
      );
    } catch (error) {
      return audit(failedResult(
        runId,
        PROVISIONING_ERROR_CODES.bindingFailed,
        errorMessage(error),
        "binding",
        {
          status: "partial",
          completionState: "partial",
          parentExperimentId: parent.id,
          parentWorkspacePathIdentity: parentProvisioning.workspacePathIdentity,
          workspacePathIdentity: descriptor.pathIdentityKey,
          defaultFilePath: descriptor.defaultFilePath,
          stableCode: descriptor.stableCode,
          defaultFolderFileRefId: folderResult.fileRef.id,
          defaultManuscriptFileRefId: manuscriptResult.fileRef.id,
          folderFileRefState: folderResult.state,
          manuscriptFileRefState: manuscriptResult.state,
          physicalDirectoryState,
          physicalFileState,
          completedSteps,
          writable: true,
          retryable: true
        }
      ));
    }
    if (bindingFeedback.status === "error" || !bindingFeedback.data) {
      return audit(failedResult(
        runId,
        PROVISIONING_ERROR_CODES.bindingFailed,
        bindingFeedback.errors.join("; ") || "ExperimentRun primary binding provisioning failed.",
        "binding",
        {
          status: "partial",
          completionState: "partial",
          parentExperimentId: parent.id,
          parentWorkspacePathIdentity: parentProvisioning.workspacePathIdentity,
          workspacePathIdentity: descriptor.pathIdentityKey,
          defaultFilePath: descriptor.defaultFilePath,
          stableCode: descriptor.stableCode,
          defaultFolderFileRefId: folderResult.fileRef.id,
          defaultManuscriptFileRefId: manuscriptResult.fileRef.id,
          folderFileRefState: folderResult.state,
          manuscriptFileRefState: manuscriptResult.state,
          physicalDirectoryState,
          physicalFileState,
          completedSteps,
          writable: true,
          retryable: true
        }
      ));
    }
    completedSteps.push("binding");

    let binding: ManuscriptBinding | undefined;
    try {
      const bindingReadback = await dependencies.getBinding(
        EXPERIMENT_RUN_MANUSCRIPT_OWNER_TYPE,
        runId,
        EXPERIMENT_RUN_MANUSCRIPT_CHANNEL
      );
      if (!bindingReadback || bindingReadback.id !== bindingFeedback.data.id) {
        throw new Error("ExperimentRun primary Binding readback is missing or inconsistent.");
      }
      binding = bindingReadback;
      await dependencies.validateBinding(binding);
      const current = binding.currentFileRefId
        ? await dependencies.getFileRefById(binding.currentFileRefId)
        : undefined;
      if (
        folderResult.fileRef.deletedAt ||
        manuscriptResult.fileRef.deletedAt ||
        folderResult.fileRef.ownerType !== EXPERIMENT_RUN_MANUSCRIPT_OWNER_TYPE ||
        folderResult.fileRef.ownerId !== runId ||
        folderResult.fileRef.pathIdentityKey !== descriptor.pathIdentityKey ||
        manuscriptResult.fileRef.ownerType !== EXPERIMENT_RUN_MANUSCRIPT_OWNER_TYPE ||
        manuscriptResult.fileRef.ownerId !== runId ||
        manuscriptResult.fileRef.pathIdentityKey !== descriptor.defaultFilePath ||
        binding.ownerType !== EXPERIMENT_RUN_MANUSCRIPT_OWNER_TYPE ||
        binding.ownerId !== runId ||
        binding.manuscriptChannel !== EXPERIMENT_RUN_MANUSCRIPT_CHANNEL ||
        binding.defaultFolderFileRefId !== folderResult.fileRef.id ||
        binding.defaultManuscriptFileRefId !== manuscriptResult.fileRef.id ||
        !binding.currentFileRefId ||
        (!existingBinding?.currentFileRefId &&
          binding.currentFileRefId !== manuscriptResult.fileRef.id) ||
        !current ||
        current.ownerType !== EXPERIMENT_RUN_MANUSCRIPT_OWNER_TYPE ||
        current.ownerId !== runId ||
        current.fileRole !== "manuscript" ||
        current.resourceKind !== "file" ||
        current.manuscriptChannel !== EXPERIMENT_RUN_MANUSCRIPT_CHANNEL
      ) {
        throw new Error("Provisioned ExperimentRun FileRef/Binding identity is inconsistent.");
      }
    } catch (error) {
      return audit(failedResult(
        runId,
        PROVISIONING_ERROR_CODES.metadataConflict,
        errorMessage(error),
        "consistency-validation",
        {
          status: "partial",
          completionState: "partial",
          parentExperimentId: parent.id,
          parentWorkspacePathIdentity: parentProvisioning.workspacePathIdentity,
          workspacePathIdentity: descriptor.pathIdentityKey,
          defaultFilePath: descriptor.defaultFilePath,
          stableCode: descriptor.stableCode,
          defaultFolderFileRefId: folderResult.fileRef.id,
          defaultManuscriptFileRefId: manuscriptResult.fileRef.id,
          bindingId: binding?.id,
          defaultFileRefId: binding?.defaultManuscriptFileRefId ?? undefined,
          currentFileRefId: binding?.currentFileRefId ?? undefined,
          physicalDirectoryState,
          physicalFileState,
          completedSteps,
          writable: true,
          retryable: true
        }
      ));
    }
    if (!binding) {
      return audit(failedResult(
        runId,
        PROVISIONING_ERROR_CODES.metadataConflict,
        "ExperimentRun primary Binding readback is missing.",
        "consistency-validation",
        {
          status: "partial",
          completionState: "partial",
          parentExperimentId: parent.id,
          parentWorkspacePathIdentity: parentProvisioning.workspacePathIdentity,
          workspacePathIdentity: descriptor.pathIdentityKey,
          defaultFilePath: descriptor.defaultFilePath,
          stableCode: descriptor.stableCode,
          defaultFolderFileRefId: folderResult.fileRef.id,
          defaultManuscriptFileRefId: manuscriptResult.fileRef.id,
          physicalDirectoryState,
          physicalFileState,
          completedSteps,
          writable: true,
          retryable: true
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
      ownerType: EXPERIMENT_RUN_MANUSCRIPT_OWNER_TYPE,
      ownerId: runId,
      channel: EXPERIMENT_RUN_MANUSCRIPT_CHANNEL,
      parentExperimentId: parent.id,
      parentWorkspacePathIdentity: parentProvisioning.workspacePathIdentity,
      workspacePathIdentity: descriptor.pathIdentityKey,
      defaultFilePath: descriptor.defaultFilePath,
      stableCode: descriptor.stableCode,
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
      writable: true,
      readOnly: false,
      deleted: false,
      completedSteps,
      errors: [],
      warnings: bindingFeedback.warnings,
      retryable: false
    });
  }

  async function prepareExperimentRunManuscriptOpen(runId: EntityId) {
    return ensureExperimentRunManuscriptProvisioned(runId);
  }

  return {
    ensureExperimentRunManuscriptProvisioned,
    prepareExperimentRunManuscriptOpen
  };
}

const experimentRunManuscriptProvisioningCore =
  createExperimentRunManuscriptProvisioningService();

export const experimentRunManuscriptProvisioningService = {
  async ensureExperimentRunManuscriptProvisioned(runId: EntityId) {
    let access: WritableRunAccess;
    try {
      access = await defaultDependencies.assertRunWritable(runId);
    } catch (error) {
      const code = stableErrorCode(error, PROVISIONING_ERROR_CODES.ownerNotFound);
      return failedResult(runId, code, errorMessage(error), "run-write-guard", {
        readOnly: code === "EXPERIMENT_RUN_PARENT_DELETED" || code === "EXPERIMENT_RUN_DELETED",
        deleted: code === "EXPERIMENT_RUN_DELETED"
      });
    }
    let parentProvisioning: ExperimentManuscriptProvisioningResult;
    try {
      parentProvisioning = await defaultDependencies.ensureParentExperiment(access.parent.id);
    } catch (error) {
      return failedResult(
        runId,
        stableErrorCode(error, PROVISIONING_ERROR_CODES.metadataConflict),
        errorMessage(error),
        "parent-provisioning",
        { parentExperimentId: access.parent.id, writable: true, retryable: true }
      );
    }
    if (
      parentProvisioning.completionState !== "complete" ||
      !parentProvisioning.workspacePathIdentity ||
      !parentProvisioning.defaultFolderFileRefId
    ) {
      const parentError = parentProvisioning.errors[0];
      return failedResult(
        runId,
        parentError?.code ?? PROVISIONING_ERROR_CODES.metadataConflict,
        parentError?.message ?? "Parent Experiment provisioning is incomplete.",
        "parent-provisioning",
        {
          parentExperimentId: access.parent.id,
          writable: true,
          retryable: parentProvisioning.retryable
        }
      );
    }
    try {
      return await runWithProvisioningAuthority({
        request: {
          intent: "provisioningWrite",
          requestId: `experiment-run-provisioning-${runId}`,
          projectId: access.parent.projectId,
          ownerType: EXPERIMENT_RUN_MANUSCRIPT_OWNER_TYPE,
          ownerId: runId,
          scope: EXPERIMENT_RUN_MANUSCRIPT_CHANNEL
        },
        write: async (permit) => {
          const rootStatus = await defaultDependencies.getRootStatus();
          if (rootStatus.status !== "configured") {
            throw new Error("ExperimentRun canonical managed root is unavailable.");
          }
          const parentFolder = await defaultDependencies.getFileRefById(
            parentProvisioning.defaultFolderFileRefId!
          );
          if (!parentFolder) {
            throw new Error("ExperimentRun parent workspace FileRef is unavailable.");
          }
          const projectWorkspace = projectWorkspaceFromRegisteredExperimentPath(
            access.parent.projectId,
            parentFolder.path
          );
          if (!projectWorkspace) {
            throw new Error("ExperimentRun parent workspace is not a formal C-1 identity.");
          }
          const parentDescriptor = buildExperimentWorkspacePath({
            managedRoot: rootStatus.managedRoot,
            projectWorkspace,
            experimentId: access.parent.id,
            createdLocalDate: access.parent.createdLocalDate,
            createdLocalTime: access.parent.createdLocalTime,
            creationTitleIdentity: access.parent.workspaceTitleIdentity
          });
          const descriptor = buildExperimentRunWorkspacePath({
            managedRoot: rootStatus.managedRoot,
            projectWorkspace,
            parentExperimentId: access.parent.id,
            parentExperimentWorkspace: parentDescriptor,
            runId: access.run.id,
            createdLocalDate: access.run.createdLocalDate,
            createdLocalTime: access.run.createdLocalTime,
            creationTitleIdentity: access.run.workspaceTitleIdentity
          });
          const identity = {
            ownerType: EXPERIMENT_RUN_MANUSCRIPT_OWNER_TYPE,
            ownerId: runId,
            scope: "primary" as const,
            manuscriptChannel: EXPERIMENT_RUN_MANUSCRIPT_CHANNEL,
            expectedDirectoryPath: descriptor.absolutePath,
            expectedManuscripts: [{
              manuscriptChannel: EXPERIMENT_RUN_MANUSCRIPT_CHANNEL,
              path: descriptor.defaultFilePath
            }],
            parentSharedIdentity: parentProvisioning.workspacePathIdentity
          };
          const operation = await manuscriptProvisioningMainlineCoordinator.begin(identity, permit);
          const result = await experimentRunManuscriptProvisioningCore
            .ensureExperimentRunManuscriptProvisioned(runId, permit, parentProvisioning);
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
                `ExperimentRun manuscript terminal confirmation is unavailable; automatic retry is disabled: ${errorMessage(finishError)}`
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
      return failedResult(
        runId,
        stableErrorCode(error, "EXPERIMENT_RUN_PROVISIONING_MAINLINE_FAILED"),
        errorMessage(error),
        "mainline-admission",
        {
        parentExperimentId: access.parent.id,
        writable: true,
        retryable: true
        }
      );
    }
  },
  prepareExperimentRunManuscriptOpen(runId: EntityId) {
    return this.ensureExperimentRunManuscriptProvisioned(runId);
  }
};

export const ensureExperimentRunManuscriptProvisioned = (runId: EntityId) =>
  experimentRunManuscriptProvisioningService.ensureExperimentRunManuscriptProvisioned(runId);

export const prepareExperimentRunManuscriptOpen = (runId: EntityId) =>
  experimentRunManuscriptProvisioningService.prepareExperimentRunManuscriptOpen(runId);
