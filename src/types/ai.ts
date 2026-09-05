export type AIProvider = "deepseek" | "openai" | "tencent_tokenhub" | "kimi";

export type AIErrorCode =
  | "invalid_prompt"
  | "missing_api_key"
  | "invalid_provider_configuration"
  | "secure_store_unavailable"
  | "settings_persistence_failed"
  | "configuration_changed"
  | "network_error"
  | "timeout"
  | "auth_error"
  | "quota_error"
  | "rate_limited"
  | "invalid_request"
  | "provider_error"
  | "invalid_response"
  | "empty_choices"
  | "empty_content"
  | "transport_error"
  | "stream_protocol_error"
  | "stream_ended_early"
  | "technical_capacity_or_safety_error"
  | "duplicate_request"
  | "material_not_authorized"
  | "material_attempt_not_active"
  | "material_attempt_already_owned_or_replayed"
  | "material_unavailable"
  | "material_type_unsupported"
  | "material_too_large"
  | "material_encoding_unsupported"
  | "material_read_failed"
  | "material_source_changed_since_review"
  | "material_budget_exceeded"
  | "material_prompt_assembly_failed"
  | "retry_regenerate_not_latest"
  | "retry_regenerate_not_eligible"
  | "retry_regenerate_active_conflict"
  | "retry_regenerate_attachment_reauthorization_required"
  | "retry_regenerate_prepare_failed"
  | "attempt_identity_conflict"
  | "retry_regenerate_projection_integrity_error"
  | "call_attempt_execution_orphaned"
  | "ai_durable_settlement_validation_failed"
  | "cancelled"
  | "unknown_error";

export interface AISettings {
  provider: AIProvider;
  baseUrl: string;
  model: string;
  hasApiKey?: boolean;
}

export interface AITextRequest {
  prompt: string;
}

export interface AITextResponse {
  text: string;
  provider: AIProvider;
  model: string;
  truncated?: boolean;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}

export interface AIErrorInfo {
  code: AIErrorCode;
  message: string;
  status?: number;
  retryable?: boolean;
}

export type AIRunStatus = "success" | "failed";

export interface AIRun {
  id: string;
  provider: AIProvider;
  model: string;
  prompt: string;
  outputText: string;
  status: AIRunStatus;
  errorCode?: AIErrorCode;
  errorMessage?: string;
  truncated?: boolean;
  createdAt: string;
}

export interface AIRunCreateInput {
  provider: AIProvider;
  model: string;
  prompt: string;
  outputText?: string;
  status: AIRunStatus;
  errorCode?: AIErrorCode;
  errorMessage?: string;
  truncated?: boolean;
}
