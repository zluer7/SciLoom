import type {
  Experiment,
  FileRef,
  ManuscriptBinding
} from "../types";
import type {
  DurableFileIdentity,
  ManuscriptLocationMode,
  OwnerIdentity
} from "../types/manuscriptOperation";
import type {
  SharedManuscriptSession,
  SharedManuscriptSessionHandle
} from "../types/sharedManuscriptSession";
import { experimentService } from "./experimentService";
import { fileRefService, getSafeManuscriptBasename } from "./fileRefService";
import {
  experimentManuscriptSelectionService,
  type ExperimentManuscriptSelectionCandidate
} from "./experimentManuscriptSelectionService";
import { managedRootConfigService } from "./managedRootConfigService";
import type { ManuscriptIdentityResolver } from "./manuscriptIdentityResolver";
import { manuscriptBindingService } from "./manuscriptBindingService";
import {
  sharedManuscriptIdentityResolver,
  sharedManuscriptSessionRuntime
} from "./sharedManuscriptSessionComposition";
import type { SharedManuscriptSessionRuntime } from "./sharedManuscriptSessionRuntime";
import { deriveMountedManuscriptLifecycleDecision } from "./fileRefOwnerValidator";

export const EXPERIMENT_INDEPENDENT_RAW_ERROR_CODES = {
  ownerUnavailable: "EXPERIMENT_INDEPENDENT_RAW_OWNER_UNAVAILABLE",
  workspaceInvalid: "EXPERIMENT_INDEPENDENT_RAW_WORKSPACE_INVALID",
  selectionFailed: "EXPERIMENT_INDEPENDENT_RAW_SELECTION_FAILED",
  managedRootUnavailable: "EXPERIMENT_INDEPENDENT_RAW_MANAGED_ROOT_UNAVAILABLE",
  identityInvalid: "EXPERIMENT_INDEPENDENT_RAW_IDENTITY_INVALID",
  registrationPendingMissing:
    "EXPERIMENT_INDEPENDENT_RAW_REGISTRATION_PENDING_MISSING",
  registrationStale: "EXPERIMENT_INDEPENDENT_RAW_REGISTRATION_STALE",
  registrationFailed: "EXPERIMENT_INDEPENDENT_RAW_REGISTRATION_FAILED",
  rekeyFailed: "EXPERIMENT_INDEPENDENT_RAW_REKEY_FAILED",
  sessionMissing: "EXPERIMENT_INDEPENDENT_RAW_SESSION_MISSING",
  sessionInvalid: "EXPERIMENT_INDEPENDENT_RAW_SESSION_INVALID"
} as const;

export interface ExperimentIndependentRawDependencies {
  getExperiment(id: string): Promise<Experiment | undefined>;
  getDeletedExperiment(id: string): Promise<Experiment | undefined>;
  getBinding(
    ownerType: "experiment",
    ownerId: string,
    channel: "primary"
  ): Promise<ManuscriptBinding | undefined>;
  getFileRef(id: string): Promise<FileRef | undefined | null>;
  listOwnerFileRefs(
    ownerType: "experiment",
    ownerId: string
  ): Promise<FileRef[]>;
  selectTarget(
    experimentId: string,
    purpose: "switch",
    requestToken: number
  ): ReturnType<typeof experimentManuscriptSelectionService.select>;
  registerTarget(
    candidate: ExperimentManuscriptSelectionCandidate,
    options: { confirmedExternalRegistration: true }
  ): ReturnType<typeof experimentManuscriptSelectionService.ensureRegistered>;
  getManagedRoot(): ReturnType<typeof managedRootConfigService.getStatus>;
  identityResolver: ManuscriptIdentityResolver;
  runtime: SharedManuscriptSessionRuntime;
  createPendingId(): string;
}

const defaultDependencies: ExperimentIndependentRawDependencies = {
  getExperiment: experimentService.getById,
  getDeletedExperiment: experimentService.getDeletedById,
  getBinding: manuscriptBindingService.getBindingByOwner,
  getFileRef: fileRefService.getById,
  listOwnerFileRefs: fileRefService.getFileRefsByOwnerIncludingDeleted,
  selectTarget: experimentManuscriptSelectionService.select,
  registerTarget: experimentManuscriptSelectionService.ensureRegistered,
  getManagedRoot: () => managedRootConfigService.getStatus(),
  identityResolver: sharedManuscriptIdentityResolver,
  runtime: sharedManuscriptSessionRuntime,
  createPendingId: () =>
    globalThis.crypto?.randomUUID?.() ??
    `experiment-independent-${Date.now()}-${Math.random().toString(16).slice(2)}`
};

function failure(code: string, causeCode?: string) {
  return {
    status: "error" as const,
    error: {
      code,
      errorCode: code,
      causeCode,
      retryable: false,
      writeApplied: false as const,
      recoveryRequired: false
    }
  };
}

function isRegisteredManuscript(
  fileRef: FileRef,
  experimentId: string,
  pathIdentity: string,
  locationMode: ManuscriptLocationMode
) {
  return !fileRef.deletedAt &&
    fileRef.ownerType === "experiment" &&
    fileRef.ownerId === experimentId &&
    fileRef.manuscriptChannel === "primary" &&
    fileRef.resourceKind === "file" &&
    fileRef.fileRole === "manuscript" &&
    fileRef.locationMode === locationMode &&
    fileRef.pathIdentityKey === pathIdentity &&
    Boolean(getSafeManuscriptBasename(fileRef.path));
}

export function createExperimentIndependentRawManuscriptService(
  dependencies: ExperimentIndependentRawDependencies = defaultDependencies
) {
  const pendingTargets = new Map<string, ExperimentManuscriptSelectionCandidate>();
  const owner = (experimentId: string): OwnerIdentity =>
    dependencies.identityResolver.resolveOwner({
      ownerType: "experiment",
      ownerId: experimentId,
      channel: "primary"
    });

  async function evaluateAccess(experimentId: string) {
    try {
      const experiment = await dependencies.getExperiment(experimentId);
      const deleted = experiment
        ? undefined
        : await dependencies.getDeletedExperiment(experimentId);
      if (!experiment && !deleted) {
        return {
          status: "error" as const,
          error: {
            code: EXPERIMENT_INDEPENDENT_RAW_ERROR_CODES.ownerUnavailable,
            causeCode: "EXPERIMENT_NOT_FOUND"
          }
        };
      }
      const lifecycle = deriveMountedManuscriptLifecycleDecision({
        ownerType: "experiment",
        ownerId: experimentId,
        manuscriptChannel: "primary",
        ownerDeleted: Boolean(deleted)
      });
      if (lifecycle.canOpenIndependent) {
        return { status: "allowed" as const, readOnly: lifecycle.readOnly };
      }
      return {
        status: "error" as const,
        error: {
          code: EXPERIMENT_INDEPENDENT_RAW_ERROR_CODES.ownerUnavailable,
          causeCode: lifecycle.reasonCode === "OWNER_DELETED"
            ? "EXPERIMENT_DELETED"
            : "EXPERIMENT_NOT_FOUND"
        }
      };
    } catch {
      return {
        status: "error" as const,
        error: {
          code: EXPERIMENT_INDEPENDENT_RAW_ERROR_CODES.ownerUnavailable,
          causeCode: "EXPERIMENT_LOOKUP_FAILED"
        }
      };
    }
  }

  function durableFile(
    fileRef: FileRef,
    configuredRoot?: string
  ): DurableFileIdentity {
    return dependencies.identityResolver.resolveDurableFile({
      fileRefId: fileRef.id,
      absolutePath: fileRef.path,
      pathIdentity: fileRef.pathIdentityKey,
      fileName: getSafeManuscriptBasename(fileRef.path)!,
      locationMode: fileRef.locationMode as ManuscriptLocationMode,
      resourceKind: "file",
      fileRole: "manuscript",
      configuredRoot
    });
  }

  async function validateDurableSession(session: SharedManuscriptSession) {
    if (
      session.windowRole !== "independent" ||
      session.owner.ownerType !== "experiment" ||
      session.owner.channel !== "primary" ||
      session.file.kind !== "durable"
    ) {
      return failure(EXPERIMENT_INDEPENDENT_RAW_ERROR_CODES.sessionInvalid);
    }
    const access = await evaluateAccess(session.owner.ownerId);
    if (access.status !== "allowed") return failure(
      access.error.code,
      access.error.causeCode
    );
    const fileRef = await dependencies.getFileRef(session.file.fileRefId);
    if (
      !fileRef ||
      !isRegisteredManuscript(
        fileRef,
        session.owner.ownerId,
        session.file.pathIdentity,
        session.file.locationMode
      )
    ) {
      return failure(EXPERIMENT_INDEPENDENT_RAW_ERROR_CODES.sessionInvalid);
    }
    return { status: "success" as const, fileRef };
  }

  async function saveSession(
    sessionKey: SharedManuscriptSessionHandle,
    options: { confirmedExternalWrite?: boolean } = {}
  ) {
    const session = dependencies.runtime.getSession(sessionKey);
    if (!session) return failure(EXPERIMENT_INDEPENDENT_RAW_ERROR_CODES.sessionMissing);
    const validated = await validateDurableSession(session);
    if (validated.status !== "success") return validated;
    if (
      session.file.locationMode === "external" &&
      options.confirmedExternalWrite
    ) {
      dependencies.runtime.confirmExternalWrite(
        sessionKey,
        session.sessionGeneration
      );
    }
    if (
      session.file.locationMode === "external" &&
      dependencies.runtime.requiresExternalWriteConfirmation(sessionKey)
    ) {
      return { status: "confirmation-required" as const, reason: "external-write" as const };
    }
    return dependencies.runtime.save(sessionKey, async () => {
      const current = dependencies.runtime.getSession(sessionKey);
      if (!current) {
        return {
          status: "target-changed" as const,
          causeCode: EXPERIMENT_INDEPENDENT_RAW_ERROR_CODES.sessionMissing
        };
      }
      const checked = await validateDurableSession(current);
      if (checked.status !== "success") {
        return {
          status: "target-changed" as const,
          causeCode: checked.error.code
        };
      }
      return {
        status: "valid" as const,
        target: {
          ...current.targetSnapshot,
          file: current.file,
          readOnly: false
        }
      };
    });
  }

  return Object.freeze({
    async openRegistered(
      experimentId: string,
      fileRefId: string,
      consumerId?: string
    ) {
      const access = await evaluateAccess(experimentId);
      if (access.status !== "allowed") return failure(access.error.code, access.error.causeCode);
      const fileRef = await dependencies.getFileRef(fileRefId);
      if (!fileRef || !isRegisteredManuscript(
        fileRef,
        experimentId,
        fileRef.pathIdentityKey,
        fileRef.locationMode as ManuscriptLocationMode
      )) return failure(EXPERIMENT_INDEPENDENT_RAW_ERROR_CODES.sessionInvalid);
      const candidates = (await dependencies.listOwnerFileRefs("experiment", experimentId))
        .filter((candidate) =>
          isRegisteredManuscript(
            candidate,
            experimentId,
            fileRef.pathIdentityKey,
            fileRef.locationMode as ManuscriptLocationMode
          )
        );
      const authoritative = await dependencies.getFileRef(fileRef.id);
      if (candidates.length !== 1 || authoritative?.id !== fileRef.id) {
        return failure(EXPERIMENT_INDEPENDENT_RAW_ERROR_CODES.sessionInvalid);
      }
      const root = fileRef.locationMode === "managed"
        ? await dependencies.getManagedRoot()
        : { status: "not-configured" as const };
      if (fileRef.locationMode === "managed" && root.status !== "configured") {
        return failure(EXPERIMENT_INDEPENDENT_RAW_ERROR_CODES.managedRootUnavailable);
      }
      const file = durableFile(
        fileRef,
        root.status === "configured" ? root.managedRoot : undefined
      );
      const opened = await dependencies.runtime.open({
        owner: owner(experimentId),
        target: {
          file,
          readOnly: false
        },
        windowRole: "independent",
        accessMode: "writable",
        consumerId
      });
      return opened.status === "success" && opened.data
        ? {
            status: "success" as const,
            sessionKey: opened.data.handle,
            session: opened.data.session,
            fileName: opened.data.session.file.fileName,
            fileRefId
          }
        : {
            status: opened.status === "conflict"
              ? "conflict" as const
              : "error" as const,
            error: opened.error
          };
    },
    async selectAndOpen(experimentId: string, requestGeneration: number) {
      const selected = await dependencies.selectTarget(
        experimentId,
        "switch",
        requestGeneration
      );
      if (selected.status !== "success") return selected;
      if (selected.candidate.registeredFileRefId) {
        const binding = await dependencies.getBinding(
          "experiment",
          experimentId,
          "primary"
        );
        if (
          binding?.currentFileRefId === selected.candidate.registeredFileRefId
        ) {
          return {
            status: "no-op" as const,
            reason: "current-file" as const,
            fileName: selected.candidate.fileName
          };
        }
        return this.openRegistered(
          experimentId,
          selected.candidate.registeredFileRefId,
          `experiment:${experimentId}:formal-switch-target`
        );
      }
      const pendingId = dependencies.createPendingId();
      pendingTargets.set(pendingId, selected.candidate);
      return {
        status: "registration-required" as const,
        pendingId,
        fileName: selected.candidate.fileName,
        locationMode: selected.candidate.locationMode
      };
    },
    async confirmRegistration(pendingId: string) {
      const candidate = pendingTargets.get(pendingId);
      pendingTargets.delete(pendingId);
      if (!candidate) {
        return failure(
          EXPERIMENT_INDEPENDENT_RAW_ERROR_CODES.registrationPendingMissing
        );
      }
      const registered = await dependencies.registerTarget(
        candidate,
        { confirmedExternalRegistration: true }
      );
      if (registered.status !== "success") {
        return failure(
          EXPERIMENT_INDEPENDENT_RAW_ERROR_CODES.registrationFailed,
          "code" in registered ? registered.code : undefined
        );
      }
      const binding = await dependencies.getBinding(
        "experiment",
        candidate.experimentId,
        "primary"
      );
      if (binding?.currentFileRefId === registered.fileRef.id) {
        return {
          status: "no-op" as const,
          reason: "current-file" as const,
          fileName: candidate.fileName
        };
      }
      return this.openRegistered(
        candidate.experimentId,
        registered.fileRef.id,
        `experiment:${candidate.experimentId}:formal-switch-target`
      );
    },
    cancelRegistration(pendingId: string) {
      return pendingTargets.delete(pendingId);
    },
    cancelOwner(experimentId: string) {
      for (const [pendingId, candidate] of pendingTargets) {
        if (candidate.experimentId === experimentId) pendingTargets.delete(pendingId);
      }
    },
    hasPendingOwner(experimentId: string) {
      return [...pendingTargets.values()].some(
        (candidate) => candidate.experimentId === experimentId
      );
    },
    updateDraft(sessionKey: SharedManuscriptSessionHandle, draftRawText: string) {
      const session = dependencies.runtime.getSession(sessionKey);
      if (session?.windowRole !== "independent") {
        return failure(EXPERIMENT_INDEPENDENT_RAW_ERROR_CODES.sessionInvalid);
      }
      const updated = dependencies.runtime.updateDraft(sessionKey, draftRawText);
      return updated
        ? { status: "success" as const, session: updated }
        : failure(EXPERIMENT_INDEPENDENT_RAW_ERROR_CODES.sessionMissing);
    },
    save: saveSession,
    async reload(
      sessionKey: SharedManuscriptSessionHandle,
      decision?: "save" | "discard" | "cancel",
      options: { confirmedExternalWrite?: boolean } = {}
    ) {
      const session = dependencies.runtime.getSession(sessionKey);
      if (!session) return failure(EXPERIMENT_INDEPENDENT_RAW_ERROR_CODES.sessionMissing);
      const validated = await validateDurableSession(session);
      if (validated.status !== "success") return validated;
      if (session.dirty && !decision) return { status: "decision-required" as const };
      if (decision === "cancel") return { status: "canceled" as const };
      if (session.dirty && decision === "save") {
        const saved = await saveSession(sessionKey, options);
        if (saved.status !== "success" && saved.status !== "no-op") return saved;
      } else if (session.dirty && decision === "discard") {
        // Shared Core discard performs an authoritative T1 Gateway reread.
      }
      return dependencies.runtime.reload(
        sessionKey,
        session.dirty && decision === "discard" ? "discard" : undefined
      );
    },
    async requestClose(
      sessionKey: SharedManuscriptSessionHandle,
      decision?: "discard" | "cancel"
    ) {
      const session = dependencies.runtime.getSession(sessionKey);
      if (session?.windowRole !== "independent") {
        return failure(EXPERIMENT_INDEPENDENT_RAW_ERROR_CODES.sessionInvalid);
      }
      const result = await dependencies.runtime.close(sessionKey, decision);
      return result.status === "warning"
        ? { status: "decision-required" as const, session: result.data }
        : result;
    },
    getSession(sessionKey: SharedManuscriptSessionHandle) {
      const session = dependencies.runtime.getSession(sessionKey);
      return session?.windowRole === "independent" ? session : undefined;
    },
    cancel(sessionKey: SharedManuscriptSessionHandle) {
      const session = dependencies.runtime.getSession(sessionKey);
      if (session?.windowRole !== "independent") return false;
      return dependencies.runtime.cancel(sessionKey);
    }
  });
}

export const experimentIndependentRawManuscriptService =
  createExperimentIndependentRawManuscriptService();

export type ExperimentIndependentRawManuscriptService = ReturnType<
  typeof createExperimentIndependentRawManuscriptService
>;
