import type {
  SharedManuscriptSession,
  SharedManuscriptSessionHandle
} from "../types/sharedManuscriptSession";
import { sharedManuscriptSessionRuntime } from "./sharedManuscriptSessionComposition";

export type SharedEditorLifecycleDecision = "save" | "discard" | "cancel";

export type SharedEditorLifecycleTrigger =
  | "top-close"
  | "footer-cancel"
  | "escape"
  | "backdrop"
  | "route-change"
  | "project-change"
  | "owner-change"
  | "channel-change"
  | "open-current"
  | "open-independent"
  | "reload"
  | "switch-manuscript"
  | "save-as-continue"
  | "native-window-close"
  | "application-exit";

export type SharedEditorLifecycleContinuationIntent =
  | "CLOSE_EDITOR"
  | "CLOSE_WINDOW"
  | "APP_EXIT"
  | "ROUTE_CHANGE"
  | "PROJECT_CHANGE"
  | "OWNER_CHANGE"
  | "CHANNEL_CHANGE"
  | "OPEN_CURRENT"
  | "OPEN_INDEPENDENT"
  | "RELOAD"
  | "SWITCH_MANUSCRIPT"
  | "SAVE_AS_CONTINUE";

export type SharedEditorLifecyclePhase =
  | "CLEAN"
  | "DIRTY"
  | "CLOSE_REQUESTED"
  | "AWAITING_DECISION"
  | "SAVING"
  | "DISCARDING"
  | "CANCELLED"
  | "CLOSED"
  | "FAILED";

export type SharedEditorLifecycleSurface = "editor" | "application";

export interface SharedEditorLifecycleIdentity {
  ownerType: string;
  ownerId: string;
  channel: string;
  windowRole: "current" | "independent";
  fileRefId: string;
  sessionKey: string;
  sessionGeneration: number;
}

export interface SharedEditorLifecycleParticipant {
  participantId: string;
  handle: SharedManuscriptSessionHandle;
  presentationEpoch: number;
  operationBlocked?(): boolean;
  readSession(): SharedManuscriptSession | undefined;
  save(): Promise<unknown>;
  discard(): Promise<unknown>;
}

export interface SharedEditorLifecycleRequestSnapshot {
  requestToken: string;
  requestGeneration: number;
  participantId: string;
  presentationEpoch: number;
  identity: SharedEditorLifecycleIdentity;
  trigger: SharedEditorLifecycleTrigger;
  continuationIntent: SharedEditorLifecycleContinuationIntent;
  surface: SharedEditorLifecycleSurface;
  phase: SharedEditorLifecyclePhase;
  queuePosition: number;
  queueLength: number;
  error?: string;
}

export interface SharedEditorLifecycleSnapshot {
  revision: number;
  activeParticipantId?: string;
  request?: SharedEditorLifecycleRequestSnapshot;
  exitSequenceActive: boolean;
  finalClosePermitArmed: boolean;
}

export type SharedEditorLifecycleRequestResult =
  | { status: "continued" }
  | { status: "decision-required"; request: SharedEditorLifecycleRequestSnapshot }
  | { status: "busy"; request: SharedEditorLifecycleRequestSnapshot }
  | { status: "operation-blocked"; error: "MANUSCRIPT_EDITOR_OPERATION_ACTIVE" }
  | { status: "stale" | "unavailable" | "failed"; error?: string };

type SettledDecision = Exclude<SharedEditorLifecycleDecision, "cancel">;
type Continuation = (decision?: SettledDecision) => void | Promise<void>;

interface InternalRequest {
  snapshot: SharedEditorLifecycleRequestSnapshot;
  continuation: Continuation;
  sequenceId?: string;
}

interface ExitSequence {
  id: string;
  trigger: SharedEditorLifecycleTrigger;
  continuationIntent: SharedEditorLifecycleContinuationIntent;
  surface: SharedEditorLifecycleSurface;
  identities: SharedEditorLifecycleIdentity[];
  cursor: number;
  continuation: Continuation;
}

export interface SharedEditorLifecycleControllerDependencies {
  listSessions(): SharedManuscriptSession[];
  createId?(): string;
}

function defaultId() {
  return globalThis.crypto?.randomUUID?.() ??
    `editor-lifecycle-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function identityFromSession(
  session: SharedManuscriptSession
): SharedEditorLifecycleIdentity {
  return Object.freeze({
    ownerType: session.logicalIdentity.ownerType,
    ownerId: session.logicalIdentity.ownerId,
    channel: session.logicalIdentity.channel,
    windowRole: session.logicalIdentity.windowRole,
    fileRefId: session.logicalIdentity.fileRefId,
    sessionKey: session.sessionKey,
    sessionGeneration: session.sessionGeneration
  });
}

function sameIdentity(
  left: SharedEditorLifecycleIdentity,
  right: SharedEditorLifecycleIdentity
) {
  return left.ownerType === right.ownerType &&
    left.ownerId === right.ownerId &&
    left.channel === right.channel &&
    left.windowRole === right.windowRole &&
    left.fileRefId === right.fileRefId &&
    left.sessionKey === right.sessionKey &&
    left.sessionGeneration === right.sessionGeneration;
}

function stableIdentityKey(identity: SharedEditorLifecycleIdentity) {
  return [
    identity.ownerType,
    identity.ownerId,
    identity.channel,
    identity.windowRole,
    identity.fileRefId,
    identity.sessionKey,
    String(identity.sessionGeneration)
  ].map((value) => encodeURIComponent(value)).join(":");
}

function cloneRequest(
  request: SharedEditorLifecycleRequestSnapshot
): SharedEditorLifecycleRequestSnapshot {
  return structuredClone(request);
}

export function createSharedEditorLifecycleController(
  dependencies: SharedEditorLifecycleControllerDependencies
) {
  const createId = dependencies.createId ?? defaultId;
  const participants = new Map<string, SharedEditorLifecycleParticipant>();
  const listeners = new Set<() => void>();
  let activeParticipantId: string | undefined;
  let activeRequest: InternalRequest | undefined;
  let exitSequence: ExitSequence | undefined;
  let revision = 0;
  let requestGeneration = 0;
  let resolvingToken: string | undefined;
  let finalClosePermitArmed = false;
  let publicSnapshot: SharedEditorLifecycleSnapshot = Object.freeze({
    revision,
    exitSequenceActive: false,
    finalClosePermitArmed: false
  });

  function publish() {
    revision += 1;
    publicSnapshot = Object.freeze({
      revision,
      activeParticipantId,
      request: activeRequest ? cloneRequest(activeRequest.snapshot) : undefined,
      exitSequenceActive: Boolean(exitSequence),
      finalClosePermitArmed
    });
    for (const listener of listeners) listener();
  }

  function participantCurrent(
    participant: SharedEditorLifecycleParticipant,
    identity?: SharedEditorLifecycleIdentity
  ) {
    const session = participant.readSession();
    if (!session) return undefined;
    const currentIdentity = identityFromSession(session);
    if (identity && !sameIdentity(identity, currentIdentity)) return undefined;
    return { session, identity: currentIdentity };
  }

  function findParticipant(identity: SharedEditorLifecycleIdentity) {
    const preferred = activeParticipantId
      ? participants.get(activeParticipantId)
      : undefined;
    if (preferred && participantCurrent(preferred, identity)) return preferred;
    return [...participants.values()]
      .sort((left, right) => left.participantId.localeCompare(right.participantId))
      .find((participant) => Boolean(participantCurrent(participant, identity)));
  }

  function requestIsCurrent(request: InternalRequest) {
    if (activeRequest?.snapshot.requestToken !== request.snapshot.requestToken) {
      return false;
    }
    const participant = participants.get(request.snapshot.participantId);
    return Boolean(
      participant &&
      participant.presentationEpoch === request.snapshot.presentationEpoch &&
      participantCurrent(participant, request.snapshot.identity)
    );
  }

  function clearRequest(phase?: SharedEditorLifecyclePhase) {
    if (activeRequest && phase) activeRequest.snapshot.phase = phase;
    activeRequest = undefined;
    resolvingToken = undefined;
  }

  async function continueRequest(
    request: InternalRequest,
    decision: SettledDecision
  ) {
    if (!requestIsCurrent(request)) {
      clearRequest();
      exitSequence = undefined;
      publish();
      return { status: "stale" as const };
    }
    const sequenceId = request.sequenceId;
    if (sequenceId) {
      clearRequest("CLOSED");
      publish();
      return advanceExitSequence(sequenceId);
    }
    clearRequest("CLOSED");
    publish();
    await request.continuation(decision);
    return { status: "continued" as const };
  }

  function createRequest(input: {
    participant: SharedEditorLifecycleParticipant;
    identity: SharedEditorLifecycleIdentity;
    trigger: SharedEditorLifecycleTrigger;
    continuationIntent: SharedEditorLifecycleContinuationIntent;
    surface: SharedEditorLifecycleSurface;
    continuation: Continuation;
    sequenceId?: string;
    queuePosition?: number;
    queueLength?: number;
  }) {
    requestGeneration += 1;
    const snapshot: SharedEditorLifecycleRequestSnapshot = {
      requestToken: createId(),
      requestGeneration,
      participantId: input.participant.participantId,
      presentationEpoch: input.participant.presentationEpoch,
      identity: input.identity,
      trigger: input.trigger,
      continuationIntent: input.continuationIntent,
      surface: input.surface,
      phase: "AWAITING_DECISION",
      queuePosition: input.queuePosition ?? 1,
      queueLength: input.queueLength ?? 1
    };
    activeRequest = {
      snapshot,
      continuation: input.continuation,
      sequenceId: input.sequenceId
    };
    publish();
    return cloneRequest(snapshot);
  }

  async function requestParticipant(input: {
    participantId: string;
    trigger: SharedEditorLifecycleTrigger;
    continuationIntent: SharedEditorLifecycleContinuationIntent;
    surface?: SharedEditorLifecycleSurface;
    continuation: Continuation;
  }): Promise<SharedEditorLifecycleRequestResult> {
    const participant = participants.get(input.participantId);
    const current = participant ? participantCurrent(participant) : undefined;
    if (!participant || !current) return { status: "unavailable" };
    if (participant.operationBlocked?.()) {
      return {
        status: "operation-blocked",
        error: "MANUSCRIPT_EDITOR_OPERATION_ACTIVE"
      };
    }
    if (activeRequest) {
      return {
        status: "busy",
        request: cloneRequest(activeRequest.snapshot)
      };
    }
    if (!current.session.dirty) {
      await input.continuation();
      return { status: "continued" };
    }
    const request = createRequest({
      participant,
      identity: current.identity,
      trigger: input.trigger,
      continuationIntent: input.continuationIntent,
      surface: input.surface ?? "editor",
      continuation: input.continuation
    });
    return { status: "decision-required", request };
  }

  function currentDirtyIdentities() {
    const seen = new Set<string>();
    const participantSessions = [...participants.values()]
      .map((participant) => participantCurrent(participant)?.session)
      .filter((session): session is SharedManuscriptSession => Boolean(session));
    return [...dependencies.listSessions(), ...participantSessions]
      .filter((session) => session.dirty)
      .map(identityFromSession)
      .filter((identity) => {
        const key = stableIdentityKey(identity);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  function stableExitIdentities() {
    const identities = currentDirtyIdentities();
    const activeParticipant = activeParticipantId
      ? participants.get(activeParticipantId)
      : undefined;
    const activeIdentity = activeParticipant
      ? participantCurrent(activeParticipant)?.identity
      : undefined;
    return identities.sort((left, right) => {
      if (activeIdentity && sameIdentity(left, activeIdentity)) return -1;
      if (activeIdentity && sameIdentity(right, activeIdentity)) return 1;
      return stableIdentityKey(left).localeCompare(stableIdentityKey(right));
    });
  }

  async function advanceExitSequence(
    sequenceId: string
  ): Promise<SharedEditorLifecycleRequestResult> {
    const sequence = exitSequence;
    if (!sequence || sequence.id !== sequenceId) return { status: "stale" };
    while (sequence.cursor < sequence.identities.length) {
      const identity = sequence.identities[sequence.cursor];
      const live = dependencies.listSessions().find((session) =>
        sameIdentity(identity, identityFromSession(session))
      ) ?? [...participants.values()]
        .map((participant) => participantCurrent(participant)?.session)
        .find((session) => Boolean(
          session && sameIdentity(identity, identityFromSession(session))
        ));
      if (!live || !live.dirty) {
        sequence.cursor += 1;
        continue;
      }
      const participant = findParticipant(identity);
      if (!participant) {
        exitSequence = undefined;
        publish();
        return {
          status: "unavailable",
          error: "DIRTY_SESSION_PRESENTATION_UNAVAILABLE"
        };
      }
      const request = createRequest({
        participant,
        identity,
        trigger: sequence.trigger,
        continuationIntent: sequence.continuationIntent,
        surface: sequence.surface,
        continuation: sequence.continuation,
        sequenceId: sequence.id,
        queuePosition: sequence.cursor + 1,
        queueLength: sequence.identities.length
      });
      sequence.cursor += 1;
      return { status: "decision-required", request };
    }
    const continuation = sequence.continuation;
    exitSequence = undefined;
    publish();
    await continuation();
    return { status: "continued" };
  }

  async function requestSequence(input: {
    trigger: SharedEditorLifecycleTrigger;
    continuationIntent: SharedEditorLifecycleContinuationIntent;
    surface?: SharedEditorLifecycleSurface;
    continuation: Continuation;
  }): Promise<SharedEditorLifecycleRequestResult> {
    if ([...participants.values()].some((participant) => participant.operationBlocked?.())) {
      return {
        status: "operation-blocked",
        error: "MANUSCRIPT_EDITOR_OPERATION_ACTIVE"
      };
    }
    if (activeRequest || exitSequence) {
      return activeRequest
        ? { status: "busy", request: cloneRequest(activeRequest.snapshot) }
        : { status: "failed", error: "LIFECYCLE_SEQUENCE_BUSY" };
    }
    const identities = stableExitIdentities();
    if (identities.length === 0) {
      await input.continuation();
      return { status: "continued" };
    }
    const sequence: ExitSequence = {
      id: createId(),
      trigger: input.trigger,
      continuationIntent: input.continuationIntent,
      surface: input.surface ?? "application",
      identities,
      cursor: 0,
      continuation: input.continuation
    };
    exitSequence = sequence;
    publish();
    return advanceExitSequence(sequence.id);
  }

  async function resolve(
    requestToken: string,
    decision: SharedEditorLifecycleDecision
  ): Promise<SharedEditorLifecycleRequestResult> {
    const request = activeRequest;
    if (
      !request ||
      request.snapshot.requestToken !== requestToken ||
      resolvingToken
    ) {
      return { status: "stale" };
    }
    if (!requestIsCurrent(request)) {
      clearRequest();
      exitSequence = undefined;
      publish();
      return { status: "stale" };
    }
    if (decision === "cancel") {
      request.snapshot.phase = "CANCELLED";
      clearRequest();
      exitSequence = undefined;
      publish();
      return { status: "continued" };
    }

    const participant = participants.get(request.snapshot.participantId)!;
    resolvingToken = requestToken;
    request.snapshot.phase = decision === "save" ? "SAVING" : "DISCARDING";
    request.snapshot.error = undefined;
    publish();
    try {
      if (decision === "save") await participant.save();
      else await participant.discard();
      if (!requestIsCurrent(request)) {
        clearRequest();
        exitSequence = undefined;
        publish();
        return { status: "stale" };
      }
      const current = participantCurrent(participant, request.snapshot.identity);
      if (!current || current.session.dirty) {
        request.snapshot.phase = "FAILED";
        request.snapshot.error = decision === "save"
          ? "MANUSCRIPT_SAVE_DID_NOT_CLEAR_DIRTY"
          : "MANUSCRIPT_DISCARD_DID_NOT_CLEAR_DIRTY";
        resolvingToken = undefined;
        publish();
        return { status: "failed", error: request.snapshot.error };
      }
      resolvingToken = undefined;
      return continueRequest(request, decision);
    } catch (cause) {
      if (!requestIsCurrent(request)) {
        clearRequest();
        exitSequence = undefined;
        publish();
        return { status: "stale" };
      }
      request.snapshot.phase = "FAILED";
      request.snapshot.error = cause instanceof Error
        ? cause.message
        : "MANUSCRIPT_LIFECYCLE_OPERATION_FAILED";
      resolvingToken = undefined;
      publish();
      return { status: "failed", error: request.snapshot.error };
    }
  }

  return Object.freeze({
    register(participant: SharedEditorLifecycleParticipant) {
      const current = participantCurrent(participant);
      if (!current) throw new Error("MANUSCRIPT_LIFECYCLE_SESSION_UNAVAILABLE");
      participants.set(participant.participantId, participant);
      publish();
      return () => {
        if (participants.get(participant.participantId) !== participant) return;
        participants.delete(participant.participantId);
        if (activeParticipantId === participant.participantId) {
          activeParticipantId = undefined;
        }
        if (activeRequest?.snapshot.participantId === participant.participantId) {
          clearRequest();
          exitSequence = undefined;
        }
        publish();
      };
    },
    markActive(participantId: string) {
      if (!participants.has(participantId)) return false;
      activeParticipantId = participantId;
      publish();
      return true;
    },
    requestParticipant,
    requestSequence,
    resolve,
    cancelActiveRequest() {
      if (!activeRequest && !exitSequence) return false;
      clearRequest();
      exitSequence = undefined;
      publish();
      return true;
    },
    armFinalClosePermit() {
      finalClosePermitArmed = true;
      publish();
    },
    consumeFinalClosePermit() {
      if (!finalClosePermitArmed) return false;
      finalClosePermitArmed = false;
      publish();
      return true;
    },
    hasDirtySessions() {
      return currentDirtyIdentities().length > 0;
    },
    listRegisteredParticipants() {
      return [...participants.values()].map((participant) => ({
        participantId: participant.participantId,
        presentationEpoch: participant.presentationEpoch,
        session: participant.readSession()
      }));
    },
    getSnapshot() {
      return publicSnapshot;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  });
}

export const sharedEditorLifecycleController =
  createSharedEditorLifecycleController({
    listSessions: () => sharedManuscriptSessionRuntime.listSessions()
  });

export type SharedEditorLifecycleController = ReturnType<
  typeof createSharedEditorLifecycleController
>;
