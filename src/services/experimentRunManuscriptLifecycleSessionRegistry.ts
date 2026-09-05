import type { SharedManuscriptSession } from "../types/sharedManuscriptSession";
import {
  EXPERIMENT_RUN_LIFECYCLE_ERROR_CODES as CODES,
  type ExperimentRunLifecycleErrorCode,
  type ExperimentRunLifecycleSessionSummary
} from "../types/experimentRunLifecycle";
import { sharedManuscriptSessionRuntime } from "./sharedManuscriptSessionComposition";
import type { SharedManuscriptSessionRuntime } from "./sharedManuscriptSessionRuntime";

function summary(session: SharedManuscriptSession) {
  const causeCode = session.error?.causeCode;
  return {
    sessionKey: session.sessionKey,
    fileRefId: session.file.kind === "durable" ? session.file.fileRefId : undefined,
    mode: session.windowRole,
    dirty: session.dirty,
    loading: session.loadStatus === "loading",
    saving: session.saveStatus === "saving",
    reloading: session.activeOperation?.kind === "reload",
    conflict: session.saveStatus === "conflict",
    writeAppliedUnverified:
      session.recoveryRequired && session.recovery?.writeApplied !== false,
    recovery: session.recoveryRequired,
    closed: false,
    disposed: false,
    ownerDeleted: causeCode === "RUN_DELETED",
    parentDeleted: causeCode === "PARENT_DELETED",
    readOnly: session.accessMode === "read-only"
  };
}

export function getExperimentRunRawLifecycleSessionBlock(
  sessions: ExperimentRunLifecycleSessionSummary[]
): ExperimentRunLifecycleErrorCode | undefined {
  if (sessions.some((session) => session.dirty)) return CODES.sessionDirty;
  if (sessions.some(
    (session) => session.loadStatus === "loading" || session.saveStatus === "saving"
  )) return CODES.sessionSaving;
  if (sessions.some(
    (session) => session.conflict || session.saveStatus === "conflict"
  )) return CODES.sessionConflict;
  if (sessions.some(
    (session) => session.writeAppliedUnverified || session.recovery
  )) return CODES.sessionRecoveryRequired;
  if (sessions.some((session) => !session.closed && !session.disposed)) {
    return CODES.sessionActive;
  }
  return undefined;
}

export function createExperimentRunManuscriptLifecycleSessionRegistry(
  runtime: SharedManuscriptSessionRuntime = sharedManuscriptSessionRuntime
) {
  const runSessions = () => runtime.listSessions()
    .filter((session) => session.owner.ownerType === "experimentRun");

  return Object.freeze({
    listOwnerSessions(ownerId: string) {
      return runSessions()
        .filter((session) => session.owner.ownerId === ownerId)
        .map(summary);
    },
    listFileSessions(fileRefId: string) {
      return runSessions()
        .filter((session) =>
          session.file.kind === "durable" && session.file.fileRefId === fileRefId
        )
        .map(summary);
    },
    listAllSessions() {
      return runSessions().map(summary);
    },
    async setOwnerDeleted(ownerId: string, deleted: boolean) {
      if (!deleted) {
        const closed = await runtime.closeCleanSessions(
          (session) =>
            session.owner.ownerType === "experimentRun" &&
            session.owner.ownerId === ownerId
        );
        if (!closed) throw new Error(CODES.sessionDirty);
        return 0;
      }
      return runtime.transitionToReadOnlySessions(
        (session) =>
          session.owner.ownerType === "experimentRun" &&
          session.owner.ownerId === ownerId,
        "RUN_DELETED"
      );
    },
    async setParentDeleted(experimentId: string, deleted: boolean) {
      if (!deleted) {
        const closed = await runtime.closeCleanSessions(
          (session) =>
            session.owner.ownerType === "experimentRun" &&
            session.targetSnapshot.lifecycleRevision?.includes(
              `parent:${experimentId}:`
            ) === true
        );
        if (!closed) throw new Error(CODES.sessionDirty);
        return 0;
      }
      return runtime.transitionToReadOnlySessions(
        (session) =>
          session.owner.ownerType === "experimentRun" &&
          session.targetSnapshot.lifecycleRevision?.includes(
            `parent:${experimentId}:`
          ) === true,
        "PARENT_DELETED"
      );
    },
    async close(sessionKey: string) {
      return (await runtime.close(sessionKey)).status === "success";
    },
    async dispose(sessionKey: string) {
      return (await runtime.close(sessionKey, "discard")).status === "success";
    },
    disposeOwner(ownerId: string) {
      return runtime.closeCleanSessions((session) =>
        session.owner.ownerType === "experimentRun" &&
        session.owner.ownerId === ownerId
      );
    }
  });
}

export const experimentRunManuscriptLifecycleSessionRegistry =
  createExperimentRunManuscriptLifecycleSessionRegistry();

export type ExperimentRunManuscriptLifecycleSessionRegistry =
  ReturnType<typeof createExperimentRunManuscriptLifecycleSessionRegistry>;
