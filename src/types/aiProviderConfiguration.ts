import type { AIProvider } from "./ai";

export type AIConfiguredState = boolean | "unknown";
export type AIProviderConfigurationEligibility = "eligible" | "blocked";
export type AIConfiguredSource =
  | "app_config"
  | "environment_fallback"
  | "none"
  | "unavailable";
export type AILocalConfigurationState =
  | "valid"
  | "invalid_shape"
  | "secure_store_unavailable";
export type AIProviderValidationState = "unverified";

export interface AIProviderPreset {
  provider: AIProvider;
  displayName: string;
  model: string;
}

export interface AIProviderConfigurationStatus {
  provider: AIProvider;
  model: string;
  activeProvider: AIProvider;
  activeModel: string;
  hasExplicitActiveTuple: boolean;
  availablePresets: AIProviderPreset[];
  configurationRevision: number;
  eligibility: AIProviderConfigurationEligibility;
  effectiveConfigured: AIConfiguredState;
  configuredSource: AIConfiguredSource;
  appOverrideConfigured: AIConfiguredState;
  localConfigurationState: AILocalConfigurationState;
  validationState: AIProviderValidationState;
}
