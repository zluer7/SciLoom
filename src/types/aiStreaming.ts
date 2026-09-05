import type { AIErrorCode, AIProvider } from "./ai";
import type { AIMaterialFreshnessReceipt, AIProviderPromptEnvelope } from "./aiContext";

export type AITextStreamEventKind =
  | "started"
  | "delta"
  | "completed"
  | "failed"
  | "cancelled";

export interface AITextStreamIdentity {
  requestId: string;
  conversationId: string;
  triggerMessageId: string;
  callAttemptId: string;
}

interface AITextStreamEventBase extends AITextStreamIdentity {
  eventSequence: number;
  eventKind: AITextStreamEventKind;
}

export interface AITextStreamStartedEvent extends AITextStreamEventBase {
  eventKind: "started";
  provider: AIProvider;
  model: string;
}

export interface AITextStreamDeltaEvent extends AITextStreamEventBase {
  eventKind: "delta";
  text: string;
}

export interface AITextStreamCompletedEvent extends AITextStreamEventBase {
  eventKind: "completed";
  text: string;
  provider: AIProvider;
  model: string;
  truncated?: boolean;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  finishReason: string;
}

export interface AITextStreamFailedEvent extends AITextStreamEventBase {
  eventKind: "failed";
  errorCode: AIErrorCode;
  errorMessage: string;
  errorRetryable: boolean;
  providerStatus?: number;
}

export interface AITextStreamCancelledEvent extends AITextStreamEventBase {
  eventKind: "cancelled";
  errorCode: "cancelled";
  errorMessage: string;
  errorRetryable: boolean;
}

export type AITextStreamEvent =
  | AITextStreamStartedEvent
  | AITextStreamDeltaEvent
  | AITextStreamCompletedEvent
  | AITextStreamFailedEvent
  | AITextStreamCancelledEvent;

export type AITextStreamTerminalEvent =
  | AITextStreamCompletedEvent
  | AITextStreamFailedEvent
  | AITextStreamCancelledEvent;

export interface AIProviderResponseFormat {
  type: "json_object";
}

export interface AITextStreamRequest extends AITextStreamIdentity {
  promptEnvelope: AIProviderPromptEnvelope;
  /** Local-only reviewed baselines consumed by Rust before Provider dispatch. */
  materialFreshnessReceipts: AIMaterialFreshnessReceipt[];
  expectedConfigurationRevision: number;
  /** Provider-native output shaping. Only canonical PARSE_DRAFT may set this. */
  responseFormat?: AIProviderResponseFormat;
}

export type CancelAITextStreamStatus =
  | "CANCEL_ACCEPTED"
  | "ALREADY_TERMINAL"
  | "ACTIVE_REQUEST_NOT_FOUND";

export interface CancelAITextStreamResponse {
  requestId: string;
  callAttemptId: string;
  status: CancelAITextStreamStatus;
}
