import type { Experiment, FileRef, ManuscriptBinding, Project } from "../types";
import type {
  SharedManuscriptSession,
  SharedManuscriptSessionHandle,
  SharedTargetSnapshot
} from "../types/sharedManuscriptSession";
import type { ManuscriptIdentityResolver } from "./manuscriptIdentityResolver";
import { experimentService } from "./experimentService";
import { fileRefService, getSafeManuscriptBasename } from "./fileRefService";
import { managedRootConfigService } from "./managedRootConfigService";
import {
  sharedManuscriptIdentityResolver,
  sharedManuscriptSessionRuntime
} from "./sharedManuscriptSessionComposition";
import type { SharedManuscriptSessionRuntime } from "./sharedManuscriptSessionRuntime";
import { manuscriptBindingService } from "./manuscriptBindingService";
import { getProjectById } from "./planningService";
import { deriveMountedManuscriptLifecycleDecision } from "./fileRefOwnerValidator";

export const EXPERIMENT_CURRENT_RAW_ERROR_CODES = {
  ownerNotFound: "EXPERIMENT_CURRENT_RAW_OWNER_NOT_FOUND",
  ownerDeleted: "EXPERIMENT_CURRENT_RAW_OWNER_DELETED",
  parentMissing: "EXPERIMENT_CURRENT_RAW_PARENT_MISSING",
  bindingMissing: "EXPERIMENT_CURRENT_RAW_BINDING_MISSING",
  bindingInvalid: "EXPERIMENT_CURRENT_RAW_BINDING_INVALID",
  currentMissing: "EXPERIMENT_CURRENT_RAW_CURRENT_MISSING",
  currentChanged: "EXPERIMENT_CURRENT_RAW_CURRENT_CHANGED",
  fileRefMissing: "EXPERIMENT_CURRENT_RAW_FILE_REF_MISSING",
  fileRefDeleted: "EXPERIMENT_CURRENT_RAW_FILE_REF_DELETED",
  fileRefInvalid: "EXPERIMENT_CURRENT_RAW_FILE_REF_INVALID",
  managedRootUnavailable: "EXPERIMENT_CURRENT_RAW_MANAGED_ROOT_UNAVAILABLE",
  sessionMissing: "EXPERIMENT_CURRENT_RAW_SESSION_MISSING"
} as const;

type CurrentRawErrorCode =
  (typeof EXPERIMENT_CURRENT_RAW_ERROR_CODES)[keyof typeof EXPERIMENT_CURRENT_RAW_ERROR_CODES];

export type ExperimentCurrentRawFailure = {
  status: "error";
  error: {
    code: CurrentRawErrorCode;
    retryable: false;
    recoveryRequired: false;
  };
};

export interface ExperimentCurrentRawDependencies {
  getExperiment(id: string): Promise<Experiment | undefined>;
  getDeletedExperiment(id: string): Promise<Experiment | undefined>;
  getProject(id: string): Promise<Project | undefined>;
  getBinding(
    ownerType: "experiment",
    ownerId: string,
    channel: "primary"
  ): Promise<ManuscriptBinding | undefined>;
  getFileRef(id: string): Promise<FileRef | undefined>;
  getDeletedFileRef(id: string): Promise<FileRef | undefined>;
  getManagedRoot(): ReturnType<typeof managedRootConfigService.getStatus>;
  identityResolver: ManuscriptIdentityResolver;
  runtime: SharedManuscriptSessionRuntime;
}

const defaultDependencies: ExperimentCurrentRawDependencies = {
  getExperiment: experimentService.getById,
  getDeletedExperiment: experimentService.getDeletedById,
  getProject: getProjectById,
  getBinding: manuscriptBindingService.getBindingByOwner,
  getFileRef: fileRefService.getById,
  getDeletedFileRef: fileRefService.getDeletedById,
  getManagedRoot: () => managedRootConfigService.getStatus(),
  identityResolver: sharedManuscriptIdentityResolver,
  runtime: sharedManuscriptSessionRuntime
};

function failure(code: CurrentRawErrorCode): ExperimentCurrentRawFailure {
  return {
    status: "error",
    error: { code, retryable: false, recoveryRequired: false }
  };
}

function validBinding(binding: ManuscriptBinding | undefined, experimentId: string) {
  return Boolean(
    binding &&
      !binding.deletedAt &&
      binding.ownerType === "experiment" &&
      binding.ownerId === experimentId &&
      binding.manuscriptChannel === "primary"
  );
}

function validFileRef(fileRef: FileRef, experimentId: string) {
  return (
    !fileRef.deletedAt &&
    fileRef.ownerType === "experiment" &&
    fileRef.ownerId === experimentId &&
    fileRef.manuscriptChannel === "primary" &&
    fileRef.resourceKind === "file" &&
    fileRef.fileRole === "manuscript" &&
    (fileRef.locationMode === "managed" ||
      fileRef.locationMode === "external") &&
    Boolean(fileRef.pathIdentityKey) &&
    Boolean(getSafeManuscriptBasename(fileRef.path))
  );
}

export function createExperimentCurrentRawManuscriptService(
  dependencies: ExperimentCurrentRawDependencies = defaultDependencies
) {
  async function resolveCurrent(experimentId: string) {
    const experiment = await dependencies.getExperiment(experimentId);
    if (!experiment) {
      const deleted = await dependencies.getDeletedExperiment(experimentId);
      if (deleted) {
        const lifecycle = deriveMountedManuscriptLifecycleDecision({
          ownerType: "experiment",
          ownerId: experimentId,
          manuscriptChannel: "primary",
          ownerDeleted: true
        });
        if (!lifecycle.canRead) {
          return failure(EXPERIMENT_CURRENT_RAW_ERROR_CODES.ownerDeleted);
        }
      }
      return failure(
        EXPERIMENT_CURRENT_RAW_ERROR_CODES.ownerNotFound
      );
    }
    const lifecycle = deriveMountedManuscriptLifecycleDecision({
      ownerType: "experiment",
      ownerId: experimentId,
      manuscriptChannel: "primary",
      ownerDeleted: false
    });
    if (!lifecycle.canRead) {
      return failure(EXPERIMENT_CURRENT_RAW_ERROR_CODES.ownerDeleted);
    }
    if (!(await dependencies.getProject(experiment.projectId))) {
      return failure(EXPERIMENT_CURRENT_RAW_ERROR_CODES.parentMissing);
    }
    const binding = await dependencies.getBinding(
      "experiment",
      experimentId,
      "primary"
    );
    if (!binding) return failure(EXPERIMENT_CURRENT_RAW_ERROR_CODES.bindingMissing);
    if (!validBinding(binding, experimentId)) {
      return failure(EXPERIMENT_CURRENT_RAW_ERROR_CODES.bindingInvalid);
    }
    if (!binding.currentFileRefId) {
      return failure(EXPERIMENT_CURRENT_RAW_ERROR_CODES.currentMissing);
    }
    const fileRef = await dependencies.getFileRef(binding.currentFileRefId);
    if (!fileRef) {
      return failure(
        await dependencies.getDeletedFileRef(binding.currentFileRefId)
          ? EXPERIMENT_CURRENT_RAW_ERROR_CODES.fileRefDeleted
          : EXPERIMENT_CURRENT_RAW_ERROR_CODES.fileRefMissing
      );
    }
    if (!validFileRef(fileRef, experimentId)) {
      return failure(EXPERIMENT_CURRENT_RAW_ERROR_CODES.fileRefInvalid);
    }
    let configuredRoot: string | undefined;
    if (fileRef.locationMode === "managed") {
      const root = await dependencies.getManagedRoot();
      if (root.status !== "configured") {
        return failure(EXPERIMENT_CURRENT_RAW_ERROR_CODES.managedRootUnavailable);
      }
      configuredRoot = root.managedRoot;
    }
    try {
      const owner = dependencies.identityResolver.resolveOwner({
        ownerType: "experiment",
        ownerId: experimentId,
        channel: "primary"
      });
      const file = dependencies.identityResolver.resolveDurableFile({
        fileRefId: fileRef.id,
        absolutePath: fileRef.path,
        pathIdentity: fileRef.pathIdentityKey,
        fileName: getSafeManuscriptBasename(fileRef.path)!,
        locationMode: fileRef.locationMode,
        resourceKind: "file",
        fileRole: "manuscript",
        configuredRoot
      });
      const target: SharedTargetSnapshot = {
        file,
        expectedCurrentFileRefId: binding.currentFileRefId,
        bindingRevision: binding.updatedAt,
        lifecycleRevision: experiment.updatedAt,
        readOnly: false
      };
      return {
        status: "success" as const,
        owner,
        file,
        target,
        binding,
        fileRef
      };
    } catch {
      return failure(EXPERIMENT_CURRENT_RAW_ERROR_CODES.fileRefInvalid);
    }
  }

  async function assertCurrentSession(handle: SharedManuscriptSessionHandle) {
    const session = dependencies.runtime.getSession(handle);
    if (
      !session ||
      session.windowRole !== "current" ||
      session.owner.ownerType !== "experiment"
    ) {
      return failure(EXPERIMENT_CURRENT_RAW_ERROR_CODES.sessionMissing);
    }
    const resolved = await resolveCurrent(session.owner.ownerId);
    if (resolved.status !== "success") return resolved;
    if (
      session.file.kind !== "durable" ||
      session.file.fileRefId !== resolved.file.fileRefId ||
      session.targetSnapshot.expectedCurrentFileRefId !==
        resolved.binding.currentFileRefId ||
      session.targetSnapshot.bindingRevision !== resolved.binding.updatedAt
    ) {
      return failure(EXPERIMENT_CURRENT_RAW_ERROR_CODES.currentChanged);
    }
    return { status: "success" as const, session, resolved };
  }

  async function save(handle: SharedManuscriptSessionHandle) {
    const checked = await assertCurrentSession(handle);
    if (checked.status !== "success") return checked;
    return dependencies.runtime.save(handle, async () => {
      const current = await resolveCurrent(checked.session.owner.ownerId);
      if (
        current.status !== "success" ||
        current.file.fileRefId !== checked.resolved.file.fileRefId ||
        current.binding.updatedAt !== checked.resolved.binding.updatedAt
      ) {
        return {
          status: "current-changed" as const,
          causeCode: EXPERIMENT_CURRENT_RAW_ERROR_CODES.currentChanged
        };
      }
      return { status: "valid" as const, target: current.target };
    });
  }

  return Object.freeze({
    async resolveCurrentDescriptor(experimentId: string) {
      const resolved = await resolveCurrent(experimentId);
      return resolved.status === "success"
        ? {
            status: "success" as const,
            currentFileRefId: resolved.fileRef.id,
            fileName: resolved.file.fileName,
            locationMode: resolved.file.locationMode,
            displayLabel: resolved.fileRef.title || resolved.file.fileName
          }
        : resolved;
    },
    /** Metadata-only A6 preflight projection. It never opens a manuscript body. */
    async resolveQuickAnalysisSource(experimentId: string) {
      const resolved = await resolveCurrent(experimentId);
      if (resolved.status !== "success") return resolved;
      if (resolved.fileRef.locationMode !== "managed") {
        return failure(EXPERIMENT_CURRENT_RAW_ERROR_CODES.fileRefInvalid);
      }
      return {
        status: "success" as const,
        experimentId,
        projectId: (await dependencies.getExperiment(experimentId))!.projectId,
        sourceFileRef: { ...resolved.fileRef, customFields: resolved.fileRef.customFields.map((field) => ({ ...field })) },
        binding: { ...resolved.binding },
        sourceIdentity: {
          fileRefId: resolved.fileRef.id,
          pathIdentityKey: resolved.fileRef.pathIdentityKey,
          fileName: resolved.file.fileName,
          locationMode: resolved.file.locationMode as "managed"
        }
      };
    },
    async openCurrent(experimentId: string, consumerId?: string) {
      const resolved = await resolveCurrent(experimentId);
      if (resolved.status !== "success") return resolved;
      const opened = await dependencies.runtime.open({
        owner: resolved.owner,
        target: resolved.target,
        windowRole: "current",
        accessMode: "writable",
        consumerId
      });
      return opened.status === "success" && opened.data
        ? {
            ...opened,
            sessionKey: opened.data.handle,
            session: opened.data.session,
            fileName: resolved.file.fileName,
            fileRefId: resolved.file.fileRefId
          }
        : opened;
    },
    updateDraft(handle: SharedManuscriptSessionHandle, draftRawText: string) {
      if (dependencies.runtime.getSession(handle)?.windowRole !== "current") {
        return failure(EXPERIMENT_CURRENT_RAW_ERROR_CODES.sessionMissing);
      }
      const session = dependencies.runtime.updateDraft(handle, draftRawText);
      return session
        ? { status: "success" as const, session }
        : failure(EXPERIMENT_CURRENT_RAW_ERROR_CODES.sessionMissing);
    },
    save,
    async reload(
      handle: SharedManuscriptSessionHandle,
      decision?: "save" | "discard" | "cancel"
    ) {
      const checked = await assertCurrentSession(handle);
      if (checked.status !== "success") return checked;
      if (checked.session.dirty && !decision) {
        return { status: "decision-required" as const };
      }
      if (decision === "cancel") return { status: "canceled" as const };
      if (checked.session.dirty && decision === "save") {
        const saved = await save(handle);
        if (
          (saved.status !== "success" && saved.status !== "no-op") ||
          dependencies.runtime.getSession(handle)?.dirty
        ) {
          return saved;
        }
      }
      return dependencies.runtime.reload(
        handle,
        checked.session.dirty && decision === "discard" ? "discard" : undefined
      );
    },
    async requestClose(
      handle: SharedManuscriptSessionHandle,
      decision?: "discard" | "cancel"
    ) {
      const result = await dependencies.runtime.close(handle, decision);
      return result.status === "warning"
        ? { status: "decision-required" as const, session: result.data }
        : result;
    },
    async closeCleanOwnerFileSessions(
      experimentId: string,
      fileRefIds: readonly string[]
    ) {
      const requested = new Set(fileRefIds);
      const closed = await dependencies.runtime.closeCleanSessions((session) =>
        session.owner.ownerType === "experiment" &&
        session.owner.ownerId === experimentId &&
        session.owner.channel === "primary" &&
        session.file.kind === "durable" &&
        requested.has(session.file.fileRefId)
      );
      return closed
        ? { status: "success" as const }
        : failure(EXPERIMENT_CURRENT_RAW_ERROR_CODES.sessionMissing);
    },
    getSession(handle: SharedManuscriptSessionHandle):
      SharedManuscriptSession | undefined {
      const session = dependencies.runtime.getSession(handle);
      return session?.windowRole === "current" ? session : undefined;
    },
    cancel(handle: SharedManuscriptSessionHandle) {
      return dependencies.runtime.cancel(handle);
    }
  });
}

export const experimentCurrentRawManuscriptService =
  createExperimentCurrentRawManuscriptService();
