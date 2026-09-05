import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  AIErrorInfo,
  AITextResponse,
  AITextStreamEvent,
  AITextStreamRequest,
  AITextStreamTerminalEvent,
  CancelAITextStreamResponse
} from "../types";
import { AI_PROVIDER_PROMPT_TECHNICAL_MAX_CHARS } from "./aiPromptBudgetService";
import {
  toAIProviderTransportPromptEnvelope,
  type AIProviderTransportPromptEnvelope
} from "./aiParseDynamicContextBudgetService";
import {
  assertAIProviderAdmissionReady,
  awaitAIProviderAdmission
} from "./aiCallAttemptLifecycleService";

export const AI_TEXT_TECHNICAL_MAX_CHARS = AI_PROVIDER_PROMPT_TECHNICAL_MAX_CHARS;

export function validatePrompt(
  prompt: string,
  options: { enforceLegacyTotalCharacterGuard?: boolean } = {}
): { ok: true; value: string } | { ok: false; error: AIErrorInfo } {
  const trimmedPrompt = prompt.trim();

  if (!trimmedPrompt) {
    return {
      ok: false,
      error: {
        code: "invalid_prompt",
        message: "请输入要发送给 AI 的问题。",
        retryable: false
      }
    };
  }

  if (
    options.enforceLegacyTotalCharacterGuard !== false &&
    Array.from(trimmedPrompt).length > AI_TEXT_TECHNICAL_MAX_CHARS
  ) {
    return {
      ok: false,
      error: {
        code: "technical_capacity_or_safety_error",
        message: `完整请求超过 ${AI_TEXT_TECHNICAL_MAX_CHARS} 字符的底层绝对安全保护；未静默删除任何输入。`,
        retryable: false
      }
    };
  }

  return {
    ok: true,
    value: trimmedPrompt
  };
}

export async function runAIText(
  prompt: string,
  expectedConfigurationRevision: number
): Promise<AITextResponse> {
  await awaitAIProviderAdmission();
  const validation = validatePrompt(prompt);

  if (!validation.ok) {
    throw validation.error;
  }

  return invoke<AITextResponse>("run_ai_text", {
    prompt: validation.value,
    expectedConfigurationRevision
  });
}

function streamProtocolError(message: string): AIErrorInfo {
  return {
    code: "stream_protocol_error",
    message,
    retryable: true
  };
}

function streamTransportError(): AIErrorInfo {
  return {
    code: "transport_error",
    message: "The AI stream closed before a verified terminal event.",
    retryable: true
  };
}

export function isAITextStreamTerminalEvent(
  event: AITextStreamEvent
): event is AITextStreamTerminalEvent {
  return (
    event.eventKind === "completed" ||
    event.eventKind === "failed" ||
    event.eventKind === "cancelled"
  );
}

export function createAITextStreamEventFence(identity: AITextStreamRequest) {
  let nextSequence = 0;
  let started = false;
  let terminal = false;

  return {
    accept(event: AITextStreamEvent): AITextStreamEvent {
      if (
        event.requestId !== identity.requestId ||
        event.callAttemptId !== identity.callAttemptId ||
        event.conversationId !== identity.conversationId ||
        event.triggerMessageId !== identity.triggerMessageId
      ) {
        throw streamProtocolError("AI stream event identity mismatch.");
      }
      if (identity.requestId !== identity.callAttemptId) {
        throw streamProtocolError(
          "The stream request identity must equal the canonical durable call attempt identity."
        );
      }
      if (!Number.isInteger(event.eventSequence) || event.eventSequence !== nextSequence) {
        throw streamProtocolError("AI stream event sequence mismatch.");
      }
      if (terminal) {
        throw streamProtocolError("AI stream emitted an event after its terminal event.");
      }
      const isBoundedMaterialGateFailure =
        event.eventKind === "failed" && (
          event.errorCode.startsWith("material_") ||
          event.errorCode === "technical_capacity_or_safety_error"
        );
      if (!started && event.eventKind !== "started" && !isBoundedMaterialGateFailure) {
        throw streamProtocolError("AI stream did not begin with a started event.");
      }
      if (started && event.eventKind === "started") {
        throw streamProtocolError("AI stream emitted more than one started event.");
      }
      if (event.eventKind === "delta" && typeof event.text !== "string") {
        throw streamProtocolError("AI stream delta is missing text.");
      }
      if (
        event.eventKind === "completed" &&
        (typeof event.text !== "string" || !event.text.trim())
      ) {
        throw streamProtocolError("AI stream completion is missing its terminal aggregate.");
      }
      if (
        (event.eventKind === "failed" || event.eventKind === "cancelled") &&
        (!event.errorCode || !event.errorMessage)
      ) {
        throw streamProtocolError("AI stream failure terminal is incomplete.");
      }
      if (event.eventKind === "cancelled" && event.errorCode !== "cancelled") {
        throw streamProtocolError("AI stream cancellation code is not canonical.");
      }

      nextSequence += 1;
      started ||= event.eventKind === "started";
      terminal = isAITextStreamTerminalEvent(event);
      return event;
    }
  };
}

export type AITextStreamTransport = {
  completion: Promise<AITextStreamTerminalEvent>;
  cancel: () => Promise<CancelAITextStreamResponse>;
};

type AITextStreamIPCRequest = Omit<AITextStreamRequest, "promptEnvelope"> & {
  promptEnvelope: AIProviderTransportPromptEnvelope;
};

function toAITextStreamIPCRequest(request: AITextStreamRequest): AITextStreamIPCRequest {
  return {
    ...request,
    promptEnvelope: toAIProviderTransportPromptEnvelope(request.promptEnvelope)
  };
}

export function startAITextStream(
  request: AITextStreamRequest,
  onEvent?: (event: AITextStreamEvent) => void
): AITextStreamTransport {
  assertAIProviderAdmissionReady();
  const fence = createAITextStreamEventFence(request);
  let settled = false;
  let resolveTerminal!: (event: AITextStreamTerminalEvent) => void;
  let rejectTerminal!: (error: unknown) => void;
  const completion = new Promise<AITextStreamTerminalEvent>((resolve, reject) => {
    resolveTerminal = resolve;
    rejectTerminal = reject;
  });
  const cancel = () => cancelAITextStream(request.requestId, request.callAttemptId);
  const channel = new Channel<AITextStreamEvent>((event) => {
    if (settled) {
      return;
    }
    try {
      const accepted = fence.accept(event);
      try {
        onEvent?.(accepted);
      } catch {
        // Presentation callbacks do not own provider or durable settlement.
      }
      if (isAITextStreamTerminalEvent(accepted)) {
        settled = true;
        resolveTerminal(accepted);
      }
    } catch (error) {
      settled = true;
      rejectTerminal(error);
      void cancel().catch(() => undefined);
    }
  });

  void invoke<void>("stream_ai_text", {
    // Context review keeps entityType as frontend metadata. The canonical Rust
    // Provider DTO is an explicit allowlist and must never receive that field.
    request: toAITextStreamIPCRequest(request),
    onEvent: channel
  }).then(
    () => {
      if (!settled) {
        settled = true;
        rejectTerminal(streamTransportError());
      }
    },
    (error) => {
      if (!settled) {
        settled = true;
        rejectTerminal(error);
      }
    }
  );

  return { completion, cancel };
}

export function cancelAITextStream(
  requestId: string,
  callAttemptId: string
): Promise<CancelAITextStreamResponse> {
  return invoke<CancelAITextStreamResponse>("cancel_ai_text_stream", {
    requestId,
    callAttemptId
  });
}
