import type { SharedManuscriptSession } from "../types/sharedManuscriptSession";
import { sharedManuscriptSessionRuntime } from "./sharedManuscriptSessionComposition";

export interface CanonicalFormalSwitchRuntimeOpenResult {
  readonly status: string;
  readonly sessionKey?: string;
  readonly session?: SharedManuscriptSession;
}

function sameOwnerChannel(
  session: SharedManuscriptSession,
  input: { ownerType: string; ownerId: string; channel: string }
) {
  return session.owner.ownerType === input.ownerType &&
    session.owner.ownerId === input.ownerId &&
    session.owner.channel === input.channel;
}

function writableConflict(session: SharedManuscriptSession) {
  return session.dirty ||
    session.recoveryRequired ||
    Boolean(session.activeOperation) ||
    session.saveStatus === "saving";
}

/**
 * The sole production Formal Switch Runtime/session convergence authority.
 * It releases only the prior current role and the exact target FileRef; other
 * independent owner sessions are outside the switch and remain untouched.
 */
export async function convergeCanonicalFormalSwitchRuntime(input: Readonly<{
  ownerType: string;
  ownerId: string;
  channel: string;
  targetFileRefId: string;
  consumerId: string;
  openCurrent(consumerId: string): Promise<CanonicalFormalSwitchRuntimeOpenResult>;
}>) {
  const relevant = (session: SharedManuscriptSession) =>
    sameOwnerChannel(session, input) &&
    (
      session.windowRole === "current" ||
      (session.file.kind === "durable" && session.file.fileRefId === input.targetFileRefId)
    );
  const before = sharedManuscriptSessionRuntime.listSessions().filter(relevant);
  if (before.some(writableConflict)) {
    throw new Error("FORMAL_SWITCH_RUNTIME_DIRTY_OR_BUSY_CONFLICT");
  }
  if (!(await sharedManuscriptSessionRuntime.closeCleanSessions(relevant))) {
    throw new Error("FORMAL_SWITCH_RUNTIME_EXACT_SESSION_RELEASE_FAILED");
  }
  const opened = await input.openCurrent(input.consumerId);
  if (
    opened.status !== "success" ||
    !opened.sessionKey ||
    !opened.session?.baseline ||
    opened.session.owner.ownerType !== input.ownerType ||
    opened.session.owner.ownerId !== input.ownerId ||
    opened.session.owner.channel !== input.channel ||
    opened.session.windowRole !== "current" ||
    opened.session.accessMode !== "writable" ||
    opened.session.file.kind !== "durable" ||
    opened.session.file.fileRefId !== input.targetFileRefId ||
    opened.session.dirty ||
    opened.session.recoveryRequired
  ) {
    throw new Error("FORMAL_SWITCH_RUNTIME_CANONICAL_CURRENT_OPEN_FAILED");
  }
  const uniqueSessions = new Map(
    sharedManuscriptSessionRuntime
      .listSessionConsumers()
      .filter(({ session }) =>
        sameOwnerChannel(session, input) &&
        session.file.kind === "durable" &&
        session.file.fileRefId === input.targetFileRefId &&
        session.accessMode === "writable"
      )
      .map(({ session }) => [session.sessionKey, session] as const)
  );
  if (
    uniqueSessions.size !== 1 ||
    [...uniqueSessions.values()][0]?.windowRole !== "current"
  ) {
    throw new Error("FORMAL_SWITCH_RUNTIME_DUPLICATE_WRITABLE_TARGET_SESSION");
  }
  return Object.freeze({
    sessionKey: opened.sessionKey,
    session: opened.session,
    authoritativePhysicalRevision: opened.session.baseline.revision,
    authoritativeRawByteLength: new TextEncoder().encode(
      opened.session.baseline.rawText
    ).byteLength
  });
}

export const canonicalFormalSwitchRuntimeConvergence = Object.freeze({
  converge: convergeCanonicalFormalSwitchRuntime
});
