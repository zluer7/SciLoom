import type { Experiment, ExperimentRun, FileRef, ManuscriptBinding } from "../types";
import type { ManuscriptLocationMode } from "../types/manuscriptOperation";
import {
  buildExperimentRunWorkspacePath,
  buildExperimentWorkspacePath
} from "./experimentWorkspacePathService";
import { createPathIdentityKey } from "./fileRefIdentity";
import { fileRefService } from "./fileRefService";
import {
  experimentRunManuscriptPermissionService,
  type ExperimentRunManuscriptPermissionService
} from "./experimentRunManuscriptPermissionService";
import { isPathWithinDirectory } from "./managedPathService";
import { managedRootConfigService } from "./managedRootConfigService";
import { manuscriptBindingService } from "./manuscriptBindingService";
import { nativeFileService } from "./nativeFileService";

export type ExperimentRunPickerInitialDirectorySource =
  | "current-parent"
  | "default-folder"
  | "run-workspace"
  | "safe-default";

export interface ExperimentRunPickerWorkspaceIdentity {
  path: string;
  pathIdentityKey: string;
}

export interface ExperimentRunPickerWorkspaceResolution {
  initialDirectory?: string;
  initialDirectorySource: ExperimentRunPickerInitialDirectorySource;
  runWorkspace?: ExperimentRunPickerWorkspaceIdentity;
  classify(path: string): ManuscriptLocationMode;
}

type AllowedAccess = Extract<
  Awaited<ReturnType<ExperimentRunManuscriptPermissionService["evaluate"]>>,
  { status: "allowed" }
>;

export interface ExperimentRunPickerWorkspaceResolverDependencies {
  evaluate(runId: string): ReturnType<ExperimentRunManuscriptPermissionService["evaluate"]>;
  getBinding(
    ownerType: "experiment" | "experimentRun",
    ownerId: string,
    channel: "primary"
  ): Promise<ManuscriptBinding | undefined>;
  getFileRef(id: string): Promise<FileRef | undefined | null>;
  resolveCanonicalWorkspace(
    run: ExperimentRun,
    parent: Experiment
  ): Promise<ExperimentRunPickerWorkspaceIdentity | undefined>;
  validateDirectory(path: string): Promise<boolean>;
}

function projectWorkspaceFromRegisteredExperimentPath(projectId: string, path: string) {
  const identity = createPathIdentityKey(path);
  const match = identity.match(/^(.*)\/\d{4}-\d{2}\/\d{2}\/experiment\/[^/]+$/u);
  if (!match) return undefined;
  const absolutePath = match[1];
  return {
    projectId,
    folderName: absolutePath.slice(absolutePath.lastIndexOf("/") + 1),
    absolutePath,
    pathIdentityKey: absolutePath
  };
}

function validOwnerFile(
  fileRef: FileRef | undefined | null,
  runId: string,
  role: "manuscript" | "defaultFolder"
) {
  if (!fileRef || fileRef.deletedAt) return undefined;
  if (
    fileRef.ownerType !== "experimentRun" ||
    fileRef.ownerId !== runId ||
    fileRef.manuscriptChannel !== "primary" ||
    fileRef.fileRole !== role ||
    fileRef.resourceKind !== (role === "defaultFolder" ? "folder" : "file") ||
    (role === "defaultFolder" && fileRef.locationMode !== "managed")
  ) return undefined;
  try {
    return fileRef.pathIdentityKey === createPathIdentityKey(fileRef.path) ? fileRef : undefined;
  } catch {
    return undefined;
  }
}

function parentDirectory(path: string) {
  const normalized = path.trim().replace(/\\/gu, "/").replace(/\/+$/u, "");
  const separator = normalized.lastIndexOf("/");
  return separator > 0 ? normalized.slice(0, separator) : undefined;
}

async function defaultCanonicalWorkspace(
  run: ExperimentRun,
  parent: Experiment
): Promise<ExperimentRunPickerWorkspaceIdentity | undefined> {
  const [root, parentBinding] = await Promise.all([
    managedRootConfigService.getStatus(),
    manuscriptBindingService.getBindingByOwner("experiment", parent.id, "primary")
  ]);
  if (root.status !== "configured" || !parentBinding?.defaultFolderFileRefId) return undefined;
  const parentFolder = await fileRefService.getById(parentBinding.defaultFolderFileRefId);
  if (
    !parentFolder ||
    parentFolder.deletedAt ||
    parentFolder.ownerType !== "experiment" ||
    parentFolder.ownerId !== parent.id ||
    parentFolder.manuscriptChannel !== "primary" ||
    parentFolder.resourceKind !== "folder" ||
    parentFolder.fileRole !== "defaultFolder" ||
    parentFolder.locationMode !== "managed" ||
    parentFolder.pathIdentityKey !== createPathIdentityKey(parentFolder.path)
  ) return undefined;
  const projectWorkspace = projectWorkspaceFromRegisteredExperimentPath(
    parent.projectId,
    parentFolder.path
  );
  if (!projectWorkspace) return undefined;
  const parentDescriptor = buildExperimentWorkspacePath({
    managedRoot: root.managedRoot,
    projectWorkspace,
    experimentId: parent.id,
    createdLocalDate: parent.createdLocalDate,
    createdLocalTime: parent.createdLocalTime,
    creationTitleIdentity: parent.workspaceTitleIdentity
  });
  if (parentDescriptor.pathIdentityKey !== parentFolder.pathIdentityKey) return undefined;
  const descriptor = buildExperimentRunWorkspacePath({
    managedRoot: root.managedRoot,
    projectWorkspace,
    parentExperimentId: parent.id,
    parentExperimentWorkspace: parentDescriptor,
    runId: run.id,
    createdLocalDate: run.createdLocalDate,
    createdLocalTime: run.createdLocalTime,
    creationTitleIdentity: run.workspaceTitleIdentity
  });
  return { path: descriptor.absolutePath, pathIdentityKey: descriptor.pathIdentityKey };
}

const defaultDependencies: ExperimentRunPickerWorkspaceResolverDependencies = {
  evaluate: (runId) => experimentRunManuscriptPermissionService.evaluate(runId, "read-independent"),
  getBinding: manuscriptBindingService.getBindingByOwner,
  getFileRef: fileRefService.getById,
  resolveCanonicalWorkspace: defaultCanonicalWorkspace,
  async validateDirectory(path) {
    try {
      await nativeFileService.validateExistingFolder(path);
      return true;
    } catch {
      return false;
    }
  }
};

export function createExperimentRunPickerWorkspaceResolver(
  dependencies: ExperimentRunPickerWorkspaceResolverDependencies = defaultDependencies
) {
  return Object.freeze({
    async resolve(runId: string): Promise<ExperimentRunPickerWorkspaceResolution> {
      const access = await dependencies.evaluate(runId) as AllowedAccess | { status: "denied" };
      if (access.status !== "allowed") throw new Error("RUN_OPEN_WORKSPACE_RESOLUTION_FAILED");
      const [binding, runWorkspace] = await Promise.all([
        dependencies.getBinding("experimentRun", runId, "primary"),
        dependencies.resolveCanonicalWorkspace(access.run, access.parent).catch(() => undefined)
      ]);
      const classify = (path: string): ManuscriptLocationMode =>
        runWorkspace && isPathWithinDirectory(runWorkspace.path, path) ? "managed" : "external";

      if (binding?.currentFileRefId) {
        const current = validOwnerFile(
          await dependencies.getFileRef(binding.currentFileRefId),
          runId,
          "manuscript"
        );
        const directory = current ? parentDirectory(current.path) : undefined;
        if (directory && await dependencies.validateDirectory(directory)) {
          return { initialDirectory: directory, initialDirectorySource: "current-parent", runWorkspace, classify };
        }
      }
      if (binding?.defaultFolderFileRefId) {
        const folder = validOwnerFile(
          await dependencies.getFileRef(binding.defaultFolderFileRefId),
          runId,
          "defaultFolder"
        );
        if (folder && await dependencies.validateDirectory(folder.path)) {
          return { initialDirectory: folder.path, initialDirectorySource: "default-folder", runWorkspace, classify };
        }
      }
      if (runWorkspace && await dependencies.validateDirectory(runWorkspace.path)) {
        return {
          initialDirectory: runWorkspace.path,
          initialDirectorySource: "run-workspace",
          runWorkspace,
          classify
        };
      }
      return { initialDirectorySource: "safe-default", runWorkspace, classify };
    }
  });
}

export const experimentRunPickerWorkspaceResolver =
  createExperimentRunPickerWorkspaceResolver();

export type ExperimentRunPickerWorkspaceResolver = ReturnType<
  typeof createExperimentRunPickerWorkspaceResolver
>;
