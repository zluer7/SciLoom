import type { AITextStreamEvent, AITextStreamIdentity } from "../../types";

export type AIStreamingPresentationPhase =
  | "idle"
  | "starting"
  | "streaming"
  | "stop_requested"
  | "completed"
  | "failed"
  | "cancelled";

export type AIStreamingPresentationState = {
  generation: number;
  phase: AIStreamingPresentationPhase;
  identity?: AITextStreamIdentity;
  requestId?: string;
  nextSequence: number;
  partialText: string;
  terminal: boolean;
  protocolError?: string;
};

export const INITIAL_AI_STREAMING_PRESENTATION_STATE: AIStreamingPresentationState = {
  generation: 0,
  phase: "idle",
  nextSequence: 0,
  partialText: "",
  terminal: false
};

export function beginAIStreamingPresentation(
  generation: number,
  requestId: string
): AIStreamingPresentationState {
  return {
    generation,
    requestId,
    phase: "starting",
    nextSequence: 0,
    partialText: "",
    terminal: false
  };
}

function protocolFailure(
  state: AIStreamingPresentationState,
  message: string
): AIStreamingPresentationState {
  return {
    ...state,
    phase: "failed",
    partialText: "",
    terminal: true,
    protocolError: message
  };
}

function identityMatches(
  identity: AITextStreamIdentity,
  event: AITextStreamEvent
): boolean {
  return (
    identity.requestId === event.requestId &&
    identity.callAttemptId === event.callAttemptId &&
    identity.conversationId === event.conversationId &&
    identity.triggerMessageId === event.triggerMessageId
  );
}

export function reduceAIStreamingPresentation(
  state: AIStreamingPresentationState,
  generation: number,
  event: AITextStreamEvent,
  suppressPartialText = false
): AIStreamingPresentationState {
  if (state.generation !== generation) {
    return state;
  }
  if (state.terminal) {
    return state;
  }
  if (
    event.requestId !== state.requestId ||
    event.callAttemptId !== event.requestId ||
    event.eventSequence !== state.nextSequence
  ) {
    return protocolFailure(state, "identity_or_sequence_mismatch");
  }
  const isBoundedMaterialGateFailure =
    event.eventKind === "failed" && event.errorCode.startsWith("material_");
  if (!state.identity && event.eventKind !== "started" && !isBoundedMaterialGateFailure) {
    return protocolFailure(state, "missing_started_event");
  }
  if (state.identity && !identityMatches(state.identity, event)) {
    return protocolFailure(state, "identity_mismatch");
  }
  if (state.identity && event.eventKind === "started") {
    return protocolFailure(state, "duplicate_started_event");
  }

  const nextSequence = state.nextSequence + 1;
  if (event.eventKind === "started") {
    return {
      ...state,
      identity: {
        requestId: event.requestId,
        callAttemptId: event.callAttemptId,
        conversationId: event.conversationId,
        triggerMessageId: event.triggerMessageId
      },
      phase: "streaming",
      nextSequence
    };
  }
  if (event.eventKind === "delta") {
    return {
      ...state,
      partialText:
        state.phase === "stop_requested" || suppressPartialText
          ? ""
          : `${state.partialText}${event.text}`,
      nextSequence
    };
  }
  if (event.eventKind === "completed") {
    return {
      ...state,
      phase: "completed",
      partialText: suppressPartialText ? "" : event.text,
      nextSequence,
      terminal: true
    };
  }
  return {
    ...state,
    phase: event.eventKind,
    partialText: "",
    nextSequence,
    terminal: true
  };
}

export function requestAIStreamingStop(
  state: AIStreamingPresentationState,
  generation: number
): AIStreamingPresentationState {
  if (
    state.generation !== generation ||
    state.terminal ||
    (state.phase !== "starting" && state.phase !== "streaming")
  ) {
    return state;
  }
  return {
    ...state,
    phase: "stop_requested",
    partialText: ""
  };
}

export function failAIStreamingPresentation(
  state: AIStreamingPresentationState,
  generation: number
): AIStreamingPresentationState {
  if (state.generation !== generation || state.terminal) {
    return state;
  }
  return {
    ...state,
    phase: "failed",
    partialText: "",
    terminal: true
  };
}
