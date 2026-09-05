import {
  experimentRepositoryConfig,
  experimentRunRepositoryConfig
} from "../repositories/entityConfig";
import { createRepository } from "../repositories/repositoryFactory";
import type {
  Experiment,
  ExperimentRun,
  FileRef,
  ManuscriptBinding,
  Project
} from "../types";
import type {
  OwnerIdentity
} from "../types/manuscriptOperation";
import type {
  SharedManuscriptSession,
  SharedManuscriptSessionHandle,
  SharedSessionRevalidation,
  SharedTargetSnapshot
} from "../types/sharedManuscriptSession";
import {
  EXPERIMENT_RUN_RAW_ERROR_CODES,
  type ExperimentRunRawResolvedTarget,
  type ExperimentRunRawSafeError
} from "../types/experimentRunRawManuscript";
import { fileRefService } from "./fileRefService";
import {
  createExperimentRunManuscriptPermissionService
} from "./experimentRunManuscriptPermissionService";
import {
  createExperimentRunRawManuscriptResolver,
  type ExperimentRunRawManuscriptResolver
} from "./experimentRunRawManuscriptResolver";
import { managedRootConfigService } from "./managedRootConfigService";
import { manuscriptBindingService } from "./manuscriptBindingService";
import {
  sharedManuscriptIdentityResolver,
  sharedManuscriptSessionRuntime
} from "./sharedManuscriptSessionComposition";
import type { SharedManuscriptSessionRuntime } from "./sharedManuscriptSessionRuntime";
import { getProjectById } from "./planningService";

export interface ExperimentRunRawManuscriptServiceDependencies {
  loadRun(id: string): Promise<ExperimentRun | undefined | null>;
  loadDeletedRun(id: string): Promise<ExperimentRun | undefined | null>;
  loadParent(id: string): Promise<Experiment | undefined | null>;
  loadDeletedParent(id: string): Promise<Experiment | undefined | null>;
  loadProject?(id: string): Promise<Project | undefined | null>;
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
  runtime?: SharedManuscriptSessionRuntime;
}

const runRepository = createRepository<ExperimentRun>(experimentRunRepositoryConfig);
const parentRepository = createRepository<Experiment>(experimentRepositoryConfig);

const defaultDependencies: ExperimentRunRawManuscriptServiceDependencies = {
  loadRun: runRepository.getById,
  loadDeletedRun: runRepository.getDeletedById,
  loadParent: parentRepository.getById,
  loadDeletedParent: parentRepository.getDeletedById,
  loadProject: getProjectById,
  getBinding: manuscriptBindingService.getBindingByOwner,
  getFileRef: fileRefService.getById,
  getDeletedFileRef: fileRefService.getDeletedById,
  getManagedRoot: () => managedRootConfigService.getStatus(),
  runtime: sharedManuscriptSessionRuntime
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

function simpleResult(
  status:
    | "error"
    | "conflict"
    | "stale"
    | "permission-denied"
    | "decision-required"
    | "canceled",
  error?: ExperimentRunRawSafeError
) {
  return { status, error };
}

function targetSnapshot(target: ExperimentRunRawResolvedTarget): SharedTargetSnapshot {
  return {
    file: target.file,
    expectedCurrentFileRefId: target.descriptor.currentFileRefId,
    bindingRevision: target.descriptor.bindingIdentity === "current-resolved"
      ? [
          target.descriptor.currentFileRefId ?? "",
          target.descriptor.defaultFileRefId ?? ""
        ].join(":")
      : undefined,
    lifecycleRevision: [
      target.run.updatedAt,
      `parent:${target.parent.id}:${target.parent.updatedAt}`,
      target.descriptor.ownerDeleted ? "owner-deleted" : "owner-active",
      target.descriptor.parentDeleted ? "parent-deleted" : "parent-active"
    ].join(":"),
    readOnly: target.descriptor.readOnly
  };
}

export function createExperimentRunRawManuscriptService(
  dependencies: ExperimentRunRawManuscriptServiceDependencies = defaultDependencies
) {
  const runtime = dependencies.runtime ?? sharedManuscriptSessionRuntime;
  const permissionService = createExperimentRunManuscriptPermissionService({
    loadRun: dependencies.loadRun,
    loadDeletedRun: dependencies.loadDeletedRun,
    loadParent: dependencies.loadParent,
    loadDeletedParent: dependencies.loadDeletedParent,
    loadProject: dependencies.loadProject
  });
  const resolver = createExperimentRunRawManuscriptResolver({
    permissionService,
    getBinding: dependencies.getBinding,
    getFileRef: dependencies.getFileRef,
    getDeletedFileRef: dependencies.getDeletedFileRef,
    getManagedRoot: dependencies.getManagedRoot,
    identityResolver: sharedManuscriptIdentityResolver
  });

  function owner(runId: string): OwnerIdentity {
    return sharedManuscriptIdentityResolver.resolveOwner({
      ownerType: "experimentRun",
      ownerId: runId,
      channel: "primary"
    });
  }

  function session(handle: SharedManuscriptSessionHandle) {
    const value = runtime.getSession(handle);
    return value?.owner.ownerType === "experimentRun" ? value : undefined;
  }

  async function revalidate(
    value: SharedManuscriptSession
  ): Promise<SharedSessionRevalidation> {
    const access = await permissionService.evaluate(
      value.owner.ownerId,
      value.windowRole === "current" ? "save-current" : "save-independent"
    );
    if (access.status !== "allowed" || access.readOnly) {
      return {
        status: "read-only",
        causeCode: access.status === "allowed"
          ? access.ownerDeleted
            ? "RUN_DELETED"
            : access.parentDeleted
              ? "PARENT_DELETED"
              : "PROJECT_UNAVAILABLE"
          : access.error.causeCode ?? access.error.code
      };
    }
    const resolved = value.windowRole === "current"
      ? await resolver.resolveCurrent(value.owner.ownerId)
      : value.file.kind === "durable"
        ? await resolver.resolveIndependent(value.owner.ownerId, value.file.fileRefId)
        : undefined;
    if (!resolved || resolved.status !== "success") {
      return {
        status: value.windowRole === "current" ? "current-changed" : "target-changed",
        causeCode: resolved?.error.code ??
          EXPERIMENT_RUN_RAW_ERROR_CODES.fileRefInvalid
      };
    }
    if (
      value.file.kind !== "durable" ||
      resolved.target.file.fileRefId !== value.file.fileRefId ||
      resolved.target.file.pathIdentity !== value.file.pathIdentity
    ) {
      return {
        status: value.windowRole === "current" ? "current-changed" : "target-changed",
        causeCode: value.windowRole === "current"
          ? EXPERIMENT_RUN_RAW_ERROR_CODES.currentChanged
          : EXPERIMENT_RUN_RAW_ERROR_CODES.fileRefInvalid
      };
    }
    return { status: "valid", target: targetSnapshot(resolved.target) };
  }

  async function openResolved(
    resolved: { status: "success"; target: ExperimentRunRawResolvedTarget },
    consumerId?: string
  ) {
    const opened = await runtime.open({
      owner: owner(resolved.target.run.id),
      target: targetSnapshot(resolved.target),
      windowRole: resolved.target.descriptor.mode,
      accessMode: resolved.target.descriptor.readOnly ? "read-only" : "writable",
      consumerId
    });
    return opened.status === "success" && opened.data
      ? {
          ...opened,
          sessionKey: opened.data.handle,
          session: opened.data.session
        }
      : {
          status: opened.status === "conflict" ? "conflict" as const : "error" as const,
          error: opened.error
        };
  }

  async function save(
    handle: SharedManuscriptSessionHandle,
    options: { confirmedExternalWrite?: boolean } = {}
  ) {
    const current = session(handle);
    if (!current || current.file.kind !== "durable") {
      return simpleResult(
        "error",
        safeError(EXPERIMENT_RUN_RAW_ERROR_CODES.sessionMissing)
      );
    }
    if (current.accessMode === "read-only") {
      return simpleResult(
        "permission-denied",
        safeError(EXPERIMENT_RUN_RAW_ERROR_CODES.permissionDenied)
      );
    }
    if (
      current.file.locationMode === "external" &&
      options.confirmedExternalWrite
    ) {
      runtime.confirmExternalWrite(handle, current.sessionGeneration);
    }
    if (
      current.file.locationMode === "external" &&
      runtime.requiresExternalWriteConfirmation(handle)
    ) {
      const checked = await revalidate(current);
      if (checked.status !== "valid") {
        const blocked = await runtime.save(handle, async () => checked);
        return { ...blocked, sessionKey: handle, session: blocked.data };
      }
      return {
        status: "confirmation-required" as const,
        reason: "external-write" as const
      };
    }
    const saved = await runtime.save(handle, async () => revalidate(current));
    return { ...saved, sessionKey: handle, session: saved.data };
  }

  return Object.freeze({
    async openCurrent(runId: string, consumerId?: string) {
      const resolved = await resolver.resolveCurrent(runId);
      return resolved.status === "success"
        ? openResolved(resolved, consumerId)
        : { status: "error" as const, error: resolved.error };
    },
    async openIndependent(
      runId: string,
      fileRefId: string,
      consumerId?: string
    ) {
      const resolved = await resolver.resolveIndependent(runId, fileRefId);
      return resolved.status === "success"
        ? openResolved(resolved, consumerId)
        : { status: "error" as const, error: resolved.error };
    },
    updateDraft(handle: SharedManuscriptSessionHandle, draftRawText: string) {
      const current = session(handle);
      if (!current) {
        return simpleResult(
          "error",
          safeError(EXPERIMENT_RUN_RAW_ERROR_CODES.sessionMissing)
        );
      }
      const updated = runtime.updateDraft(handle, draftRawText);
      return updated
        ? { status: "success" as const, sessionKey: handle, session: updated }
        : simpleResult(
            current.accessMode === "read-only" ? "permission-denied" : "error",
            safeError(
              current.accessMode === "read-only"
                ? EXPERIMENT_RUN_RAW_ERROR_CODES.permissionDenied
                : EXPERIMENT_RUN_RAW_ERROR_CODES.sessionMissing
            )
          );
    },
    save,
    async replaceCurrent(handle: SharedManuscriptSessionHandle, nextRawText: string) {
      const updated = runtime.updateDraft(handle, nextRawText);
      if (!updated) {
        return simpleResult(
          "error",
          safeError(EXPERIMENT_RUN_RAW_ERROR_CODES.sessionMissing)
        );
      }
      const saved = await runtime.save(handle, async () => revalidate(updated));
      return { ...saved, sessionKey: handle, session: saved.data };
    },
    async activateCurrentFromIndependent(
      runId: string,
      handle: SharedManuscriptSessionHandle
    ) {
      const source = session(handle);
      if (
        !source ||
        source.windowRole !== "independent" ||
        source.owner.ownerId !== runId ||
        source.dirty
      ) {
        return simpleResult(
          "conflict",
          safeError(EXPERIMENT_RUN_RAW_ERROR_CODES.dirtyDecisionRequired)
        );
      }
      const closed = await runtime.close(handle);
      if (closed.status !== "success") {
        return { status: "error" as const, error: closed.error };
      }
      return this.openCurrent(runId);
    },
    async activateRecoveredCurrent(runId: string, targetFileRefId: string) {
      const candidate = runtime.listSessionConsumers().find(({ session: value }) =>
        value.owner.ownerType === "experimentRun" &&
        value.owner.ownerId === runId &&
        value.windowRole === "independent" &&
        value.file.kind === "durable" &&
        value.file.fileRefId === targetFileRefId
      );
      return candidate
        ? this.activateCurrentFromIndependent(runId, candidate.handle)
        : this.openCurrent(runId);
    },
    markRecoveryRequired() {
      return false;
    },
    async reload(
      handle: SharedManuscriptSessionHandle,
      decision?: "discard-and-reload" | "cancel"
    ) {
      const current = session(handle);
      if (!current) {
        return simpleResult(
          "error",
          safeError(EXPERIMENT_RUN_RAW_ERROR_CODES.sessionMissing)
        );
      }
      if (current.dirty && !decision) {
        return simpleResult(
          "decision-required",
          safeError(EXPERIMENT_RUN_RAW_ERROR_CODES.dirtyDecisionRequired)
        );
      }
      if (decision === "cancel") return simpleResult("canceled");
      const reloaded = await runtime.reload(
        handle,
        current.dirty && decision === "discard-and-reload" ? "discard" : undefined,
        async () => revalidate(current)
      );
      return { ...reloaded, sessionKey: handle, session: reloaded.data };
    },
    async close(
      handle: SharedManuscriptSessionHandle,
      decision?: "discard" | "cancel"
    ) {
      const current = session(handle);
      if (!current) {
        return simpleResult(
          "error",
          safeError(EXPERIMENT_RUN_RAW_ERROR_CODES.sessionMissing)
        );
      }
      const closed = await runtime.close(handle, decision);
      return closed.status === "warning"
        ? { status: "decision-required" as const, session: closed.data }
        : closed;
    },
    async dispose(handle: SharedManuscriptSessionHandle) {
      return (await runtime.close(handle, "discard")).status === "success";
    },
    getSession: session,
    listSessions() {
      return runtime.listSessionConsumers()
        .filter(({ session: value }) => value.owner.ownerType === "experimentRun")
        .map(({ handle, session: value }) => ({
          ...value,
          sessionKey: handle,
          consumerHandle: handle
        }));
    }
  });
}

export const experimentRunRawManuscriptService =
  createExperimentRunRawManuscriptService();

export type ExperimentRunRawManuscriptService =
  ReturnType<typeof createExperimentRunRawManuscriptService>;
