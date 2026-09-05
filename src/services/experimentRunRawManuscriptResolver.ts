import type { FileRef, ManuscriptBinding } from "../types";
import type { DurableFileIdentity } from "../types/manuscriptOperation";
import {
  EXPERIMENT_RUN_RAW_ERROR_CODES,
  type ExperimentRunRawResolvedTarget,
  type ExperimentRunRawSafeError
} from "../types/experimentRunRawManuscript";
import { createPathIdentityKey } from "./fileRefIdentity";
import { fileRefService, getSafeManuscriptBasename } from "./fileRefService";
import {
  createManuscriptIdentityResolver,
  type ManuscriptIdentityResolver
} from "./manuscriptIdentityResolver";
import { managedRootConfigService } from "./managedRootConfigService";
import { manuscriptBindingService } from "./manuscriptBindingService";
import {
  experimentRunManuscriptPermissionService,
  type ExperimentRunManuscriptPermissionService
} from "./experimentRunManuscriptPermissionService";

export interface ExperimentRunRawManuscriptResolverDependencies {
  permissionService: ExperimentRunManuscriptPermissionService;
  getBinding(
    ownerType: "experimentRun",
    ownerId: string,
    channel: "primary"
  ): Promise<ManuscriptBinding | undefined | null>;
  getFileRef(id: string): Promise<FileRef | undefined | null>;
  getDeletedFileRef(id: string): Promise<FileRef | undefined | null>;
  getManagedRoot(): Promise<
    Awaited<ReturnType<typeof managedRootConfigService.getStatus>>
  > | ReturnType<typeof managedRootConfigService.getStatus>;
  identityResolver?: ManuscriptIdentityResolver;
}

const defaultDependencies: ExperimentRunRawManuscriptResolverDependencies = {
  permissionService: experimentRunManuscriptPermissionService,
  getBinding: manuscriptBindingService.getBindingByOwner,
  getFileRef: fileRefService.getById,
  getDeletedFileRef: fileRefService.getDeletedById,
  getManagedRoot: () => managedRootConfigService.getStatus(),
  identityResolver: createManuscriptIdentityResolver()
};

function safeError(
  code: ExperimentRunRawSafeError["code"],
  causeCode?: string
): ExperimentRunRawSafeError {
  return {
    code,
    causeCode,
    retryable: false,
    writeApplied: false,
    verificationFailed: false
  };
}

function failure(code: ExperimentRunRawSafeError["code"], causeCode?: string) {
  return { status: "error" as const, error: safeError(code, causeCode) };
}

function validBinding(binding: ManuscriptBinding | undefined | null, runId: string) {
  return Boolean(
    binding && !binding.deletedAt &&
    binding.ownerType === "experimentRun" &&
    binding.ownerId === runId &&
    binding.manuscriptChannel === "primary"
  );
}

function validateFileRef(fileRef: FileRef, runId: string) {
  let pathIdentity = "";
  try {
    pathIdentity = createPathIdentityKey(fileRef.path);
  } catch {
    return false;
  }
  return !fileRef.deletedAt &&
    fileRef.ownerType === "experimentRun" &&
    fileRef.ownerId === runId &&
    fileRef.manuscriptChannel === "primary" &&
    fileRef.resourceKind === "file" &&
    fileRef.fileRole === "manuscript" &&
    (fileRef.locationMode === "managed" || fileRef.locationMode === "external") &&
    pathIdentity === fileRef.pathIdentityKey &&
    Boolean(getSafeManuscriptBasename(fileRef.path));
}

export function createExperimentRunRawManuscriptResolver(
  dependencies: ExperimentRunRawManuscriptResolverDependencies = defaultDependencies
) {
  const identityResolver = dependencies.identityResolver ??
    createManuscriptIdentityResolver();

  async function resolveFile(
    runId: string,
    fileRefId: string,
    access: Extract<
      Awaited<ReturnType<ExperimentRunManuscriptPermissionService["evaluate"]>>,
      { status: "allowed" }
    >,
    mode: "current" | "independent",
    binding?: ManuscriptBinding
  ) {
    const fileRef = await dependencies.getFileRef(fileRefId);
    if (!fileRef) {
      return failure(
        await dependencies.getDeletedFileRef(fileRefId)
          ? EXPERIMENT_RUN_RAW_ERROR_CODES.fileRefDeleted
          : EXPERIMENT_RUN_RAW_ERROR_CODES.fileRefMissing
      );
    }
    if (fileRef.ownerType !== "experimentRun" || fileRef.ownerId !== runId) {
      return failure(EXPERIMENT_RUN_RAW_ERROR_CODES.fileRefOwnerMismatch);
    }
    if (!validateFileRef(fileRef, runId)) {
      return failure(EXPERIMENT_RUN_RAW_ERROR_CODES.fileRefInvalid);
    }
    let configuredRoot: string | undefined;
    if (fileRef.locationMode === "managed") {
      const root = await dependencies.getManagedRoot();
      if (root.status !== "configured") {
        return failure(EXPERIMENT_RUN_RAW_ERROR_CODES.managedRootUnavailable);
      }
      configuredRoot = root.managedRoot;
    }
    let file: DurableFileIdentity;
    try {
      file = identityResolver.resolveDurableFile({
        fileRefId: fileRef.id,
        absolutePath: fileRef.path,
        pathIdentity: fileRef.pathIdentityKey,
        fileName: getSafeManuscriptBasename(fileRef.path)!,
        locationMode: fileRef.locationMode,
        resourceKind: "file",
        fileRole: "manuscript",
        configuredRoot
      });
    } catch {
      return failure(EXPERIMENT_RUN_RAW_ERROR_CODES.pathInvalid);
    }
    const target: ExperimentRunRawResolvedTarget = {
      run: access.run,
      parent: access.parent,
      file,
      descriptor: {
        ownerType: "experimentRun",
        ownerId: runId,
        projectId: access.run.projectId,
        experimentId: access.run.experimentId,
        channel: "primary",
        mode,
        fileRefId: fileRef.id,
        role: "manuscript",
        locationMode: fileRef.locationMode,
        pathIdentityKey: fileRef.pathIdentityKey,
        fileName: file.fileName,
        currentFileRefId: mode === "current"
          ? binding?.currentFileRefId ?? undefined
          : undefined,
        defaultFileRefId: mode === "current"
          ? binding?.defaultManuscriptFileRefId ?? undefined
          : undefined,
        bindingIdentity: mode === "current"
          ? "current-resolved"
          : "not-read-independent",
        ownerDeleted: access.ownerDeleted,
        parentDeleted: access.parentDeleted,
        readOnly: access.readOnly
      }
    };
    return { status: "success" as const, target };
  }

  async function resolveCurrent(runId: string) {
    const access = await dependencies.permissionService.evaluate(runId, "read-current");
    if (access.status !== "allowed") return { status: "error" as const, error: access.error };
    const binding = await dependencies.getBinding("experimentRun", runId, "primary");
    if (!binding) return failure(EXPERIMENT_RUN_RAW_ERROR_CODES.bindingMissing);
    if (!validBinding(binding, runId)) {
      return failure(EXPERIMENT_RUN_RAW_ERROR_CODES.bindingInvalid);
    }
    if (!binding.currentFileRefId) {
      return failure(EXPERIMENT_RUN_RAW_ERROR_CODES.currentMissing);
    }
    return resolveFile(runId, binding.currentFileRefId, access, "current", binding);
  }

  async function resolveIndependent(runId: string, fileRefId: string) {
    const access = await dependencies.permissionService.evaluate(runId, "read-independent");
    if (access.status !== "allowed") return { status: "error" as const, error: access.error };
    return resolveFile(runId, fileRefId, access, "independent");
  }

  return Object.freeze({ resolveCurrent, resolveIndependent });
}

export const experimentRunRawManuscriptResolver =
  createExperimentRunRawManuscriptResolver();

export type ExperimentRunRawManuscriptResolver =
  ReturnType<typeof createExperimentRunRawManuscriptResolver>;
