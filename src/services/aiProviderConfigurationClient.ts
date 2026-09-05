import { invoke } from "@tauri-apps/api/core";
import type { AIErrorInfo, AIProvider, AIProviderConfigurationStatus } from "../types";

const MAX_API_KEY_BYTES = 2_048;

function invalidConfiguration(message: string): AIErrorInfo {
  return {
    code: "invalid_provider_configuration",
    message,
    retryable: false
  };
}

export function validateAIProviderApiKey(apiKey: string): string {
  const normalized = apiKey.trim();
  if (!normalized) {
    throw invalidConfiguration("The API key cannot be blank.");
  }
  if (/\p{Cc}/u.test(normalized)) {
    throw invalidConfiguration("The API key cannot contain control characters.");
  }
  if (new TextEncoder().encode(normalized).byteLength > MAX_API_KEY_BYTES) {
    throw invalidConfiguration("The API key must be at most 2048 bytes.");
  }
  return normalized;
}

export function getAIProviderConfigurationStatus(
  provider?: AIProvider
): Promise<AIProviderConfigurationStatus> {
  return invoke<AIProviderConfigurationStatus>("get_ai_provider_configuration_status", {
    provider: provider ?? null
  });
}

export function saveAIProviderActiveTuple(
  provider: AIProvider,
  model: string
): Promise<AIProviderConfigurationStatus> {
  return invoke<AIProviderConfigurationStatus>("save_ai_provider_active_tuple", {
    provider,
    model
  });
}

export function clearAIProviderActiveTuple(): Promise<AIProviderConfigurationStatus> {
  return invoke<AIProviderConfigurationStatus>("clear_ai_provider_active_tuple");
}

export function setAIProviderApiKey(
  provider: AIProvider,
  apiKey: string
): Promise<AIProviderConfigurationStatus> {
  const normalized = validateAIProviderApiKey(apiKey);
  return invoke<AIProviderConfigurationStatus>("set_ai_provider_api_key", {
    provider,
    apiKey: normalized
  });
}

export function clearAIProviderApiKey(
  provider: AIProvider
): Promise<AIProviderConfigurationStatus> {
  return invoke<AIProviderConfigurationStatus>("clear_ai_provider_api_key", { provider });
}
