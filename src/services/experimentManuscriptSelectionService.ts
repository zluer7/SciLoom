import { experimentRepositoryConfig } from "../repositories/entityConfig";
import { createRepository } from "../repositories/repositoryFactory";
import type {
  CreateFileRefInput,
  Experiment,
  FileRef,
  ManuscriptBinding
} from "../types";
import { createPathIdentityKey } from "./fileRefIdentity";
import { fileRefService } from "./fileRefService";
import { localMarkdownFileService } from "./localMarkdownFileService";
import { getManagedPathParent } from "./managedPathService";
import { manuscriptBindingService } from "./manuscriptBindingService";

export type ExperimentManuscriptSelectionPurpose = "open" | "switch";

export interface ExperimentManuscriptWorkspaceIdentity {
  folderFileRefId: string;
  path: string;
  pathIdentity: string;
}

export interface ExperimentManuscriptSelectionCandidate {
  experimentId: string;
  purpose: ExperimentManuscriptSelectionPurpose;
  requestToken: number;
  path: string;
  pathIdentity: string;
  fileName: string;
  locationMode: "managed" | "external";
  registeredFileRefId?: string;
  requiresExternalRegistrationConfirmation: boolean;
}

export type ExperimentManuscriptSelectionResult =
  | { status: "success"; candidate: ExperimentManuscriptSelectionCandidate }
  | { status: "canceled"; requestToken: number }
  | { status: "error"; code: string; message: string; requestToken: number };

export type ExperimentManuscriptRegistrationResult =
  | { status: "success"; fileRef: FileRef; created: boolean }
  | { status: "confirmation-required"; reason: "external-registration" }
  | { status: "error"; code: string; message: string };

export interface ExperimentManuscriptSelectionDependencies {
  getExperiment(id: string): Promise<Experiment | undefined>;
  getBinding(
    ownerType: "experiment",
    ownerId: string,
    channel: "primary"
  ): Promise<ManuscriptBinding | undefined>;
  getFileRef(id: string): Promise<FileRef | undefined>;
  listOwnerFileRefs(ownerType: "experiment", ownerId: string): Promise<FileRef[]>;
  selectMarkdown(
    title?: string,
    defaultPath?: string
  ): ReturnType<typeof localMarkdownFileService.selectMarkdownFile>;
  registerFileRef(input: CreateFileRefInput): ReturnType<typeof fileRefService.registerFileRef>;
}

const repository = createRepository<Experiment>(experimentRepositoryConfig);

const defaultDependencies: ExperimentManuscriptSelectionDependencies = {
  getExperiment: repository.getById,
  getBinding: manuscriptBindingService.getBindingByOwner,
  getFileRef: fileRefService.getById,
  listOwnerFileRefs: fileRefService.getFileRefsByOwner,
  selectMarkdown: localMarkdownFileService.selectMarkdownFile,
  registerFileRef: fileRefService.registerFileRef
};

function fileNameFromPath(path: string) {
  const parts = path.split(/[\\/]/u);
  return parts[parts.length - 1] || path;
}

function errorCode(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: message.match(/[A-Z][A-Z0-9_]+/u)?.[0] ?? fallback,
    message
  };
}

function isWorkspaceFolder(fileRef: FileRef | undefined, experimentId: string) {
  return Boolean(
    fileRef &&
      !fileRef.deletedAt &&
      fileRef.ownerType === "experiment" &&
      fileRef.ownerId === experimentId &&
      fileRef.manuscriptChannel === "primary" &&
      fileRef.resourceKind === "folder" &&
      fileRef.fileRole === "defaultFolder" &&
      fileRef.locationMode === "managed" &&
      fileRef.pathIdentityKey
  );
}

function isRegisteredManuscript(fileRef: FileRef, experimentId: string) {
  return !fileRef.deletedAt &&
    fileRef.ownerType === "experiment" &&
    fileRef.ownerId === experimentId &&
    fileRef.manuscriptChannel === "primary" &&
    fileRef.resourceKind === "file" &&
    fileRef.fileRole === "manuscript" &&
    (fileRef.locationMode === "managed" || fileRef.locationMode === "external");
}

export function createExperimentManuscriptSelectionService(
  dependencies: ExperimentManuscriptSelectionDependencies = defaultDependencies
) {
  const registrationByCandidate = new Map<string, Promise<ExperimentManuscriptRegistrationResult>>();

  async function resolveWorkspace(
    experimentId: string
  ): Promise<ExperimentManuscriptWorkspaceIdentity> {
    const experiment = await dependencies.getExperiment(experimentId);
    if (!experiment || experiment.deletedAt) {
      throw new Error("EXPERIMENT_MANUSCRIPT_OWNER_UNAVAILABLE");
    }
    const binding = await dependencies.getBinding("experiment", experimentId, "primary");
    if (
      !binding ||
      binding.ownerType !== "experiment" ||
      binding.ownerId !== experimentId ||
      binding.manuscriptChannel !== "primary" ||
      !binding.defaultFolderFileRefId
    ) {
      throw new Error("EXPERIMENT_MANUSCRIPT_BINDING_INVALID");
    }
    const folder = await dependencies.getFileRef(binding.defaultFolderFileRefId);
    if (!isWorkspaceFolder(folder, experimentId)) {
      throw new Error("EXPERIMENT_MANUSCRIPT_WORKSPACE_INVALID");
    }
    return {
      folderFileRefId: folder!.id,
      path: folder!.path,
      pathIdentity: folder!.pathIdentityKey
    };
  }

  async function select(
    experimentId: string,
    purpose: ExperimentManuscriptSelectionPurpose,
    requestToken: number
  ): Promise<ExperimentManuscriptSelectionResult> {
    let workspace: ExperimentManuscriptWorkspaceIdentity;
    try {
      workspace = await resolveWorkspace(experimentId);
    } catch (cause) {
      const failure = errorCode(cause, "EXPERIMENT_MANUSCRIPT_WORKSPACE_INVALID");
      return { status: "error", ...failure, requestToken };
    }
    const selected = await dependencies.selectMarkdown(
      purpose === "open" ? "Open Experiment manuscript" : "Switch Experiment manuscript",
      workspace.path
    );
    if (!selected.ok) {
      return selected.errorCode === "canceled"
        ? { status: "canceled", requestToken }
        : {
            status: "error",
            code: "EXPERIMENT_MANUSCRIPT_SELECTION_FAILED",
            message: selected.errorCode,
            requestToken
          };
    }
    const pathIdentity = createPathIdentityKey(selected.path);
    const locationMode =
      createPathIdentityKey(getManagedPathParent(selected.path)) === workspace.pathIdentity
        ? "managed"
        : "external";
    const registered = (await dependencies.listOwnerFileRefs("experiment", experimentId)).find(
      (fileRef) =>
        fileRef.pathIdentityKey === pathIdentity && isRegisteredManuscript(fileRef, experimentId)
    );
    return {
      status: "success",
      candidate: {
        experimentId,
        purpose,
        requestToken,
        path: selected.path,
        pathIdentity,
        fileName: selected.fileName || fileNameFromPath(selected.path),
        locationMode,
        registeredFileRefId: registered?.id,
        requiresExternalRegistrationConfirmation: locationMode === "external" && !registered
      }
    };
  }

  async function registerCandidate(
    candidate: ExperimentManuscriptSelectionCandidate
  ): Promise<ExperimentManuscriptRegistrationResult> {
    try {
      const workspace = await resolveWorkspace(candidate.experimentId);
      const currentLocationMode =
        createPathIdentityKey(getManagedPathParent(candidate.path)) === workspace.pathIdentity
          ? "managed"
          : "external";
      if (
        createPathIdentityKey(candidate.path) !== candidate.pathIdentity ||
        currentLocationMode !== candidate.locationMode
      ) {
        return {
          status: "error",
          code: "EXPERIMENT_MANUSCRIPT_SELECTION_STALE",
          message: "The selected Experiment manuscript identity changed before registration."
        };
      }
      const existing = (await dependencies.listOwnerFileRefs("experiment", candidate.experimentId)).find(
        (fileRef) =>
          fileRef.pathIdentityKey === candidate.pathIdentity &&
          isRegisteredManuscript(fileRef, candidate.experimentId)
      );
      if (existing) return { status: "success", fileRef: existing, created: false };
      const ensured = await dependencies.registerFileRef({
        ownerType: "experiment",
        ownerId: candidate.experimentId,
        manuscriptChannel: "primary",
        resourceKind: "file",
        fileRole: "manuscript",
        locationMode: candidate.locationMode,
        fileType: "markdown",
        path: candidate.path,
        pathIdentityKey: candidate.pathIdentity,
        title: candidate.fileName,
        source: candidate.locationMode === "external" ? "imported" : "user"
      });
      return {
        status: "success",
        fileRef: ensured.fileRef,
        created: ensured.state !== "reused"
      };
    } catch (cause) {
      const failure = errorCode(cause, "EXPERIMENT_MANUSCRIPT_REGISTRATION_FAILED");
      return { status: "error", ...failure };
    }
  }

  async function ensureRegistered(
    candidate: ExperimentManuscriptSelectionCandidate,
    options: { confirmedExternalRegistration?: boolean } = {}
  ): Promise<ExperimentManuscriptRegistrationResult> {
    if (
      candidate.requiresExternalRegistrationConfirmation &&
      !options.confirmedExternalRegistration
    ) {
      return { status: "confirmation-required", reason: "external-registration" };
    }
    const key = [candidate.experimentId, candidate.pathIdentity, candidate.requestToken].join(":");
    const inFlight = registrationByCandidate.get(key);
    if (inFlight) return await inFlight;
    const operation = registerCandidate(candidate);
    registrationByCandidate.set(key, operation);
    try {
      return await operation;
    } finally {
      registrationByCandidate.delete(key);
    }
  }

  return { resolveWorkspace, select, ensureRegistered };
}

export const experimentManuscriptSelectionService =
  createExperimentManuscriptSelectionService();
