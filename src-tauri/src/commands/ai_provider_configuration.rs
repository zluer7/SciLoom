use super::ai::ai_error_json;
use serde::{Deserialize, Serialize, Serializer};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::State;

#[cfg(any(target_os = "macos", test))]
#[path = "macos_credential_store.rs"]
mod macos_credential_store;

const DEEPSEEK_API_KEY_ENVIRONMENT_VARIABLE: &str = "DEEPSEEK_API_KEY";
const ACTIVE_TUPLE_TARGET: &str = "SciLoom/local.labpod.desktop/ai/active-provider-model";
const MAX_SECRET_BYTES: usize = 2_048;
const ACTIVE_TUPLE_VERSION: u8 = 1;

pub(crate) const PROVIDER_DEEPSEEK: &str = "deepseek";
pub(crate) const PROVIDER_OPENAI: &str = "openai";
pub(crate) const PROVIDER_TENCENT_TOKENHUB: &str = "tencent_tokenhub";
pub(crate) const PROVIDER_KIMI: &str = "kimi";
pub(crate) const DEFAULT_DEEPSEEK_MODEL: &str = "deepseek-v4-flash";
pub(crate) const OPENAI_MODEL: &str = "gpt-5.4-mini";
pub(crate) const TOKENHUB_HY3_MODEL: &str = "hy3";
pub(crate) const TOKENHUB_GLM_5_1_MODEL: &str = "glm-5.1";
pub(crate) const TOKENHUB_GLM_5_3_FLASH_MODEL: &str = "glm-5.3-flash";
pub(crate) const TOKENHUB_MINIMAX_M3_MODEL: &str = "minimax-m3";
pub(crate) const TOKENHUB_MIMO_V2_5_PRO_MODEL: &str = "mimo-v2.5-pro";
pub(crate) const TOKENHUB_DEEPSEEK_V4_FLASH_MODEL: &str = "deepseek-v4-flash";
pub(crate) const TOKENHUB_KIMI_K3_MODEL: &str = "kimi-k3";
pub(crate) const KIMI_MODEL: &str = "kimi-k2.6";

const TOKENHUB_ENDPOINT: &str = "https://tokenhub.tencentmaas.com/v1/chat/completions";
const TOKENHUB_CREDENTIAL_TARGET: &str =
    "SciLoom/local.labpod.desktop/ai/tencent-tokenhub/api-key";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CanonicalAIProvider {
    Deepseek,
    Openai,
    TencentTokenhub,
    Kimi,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProviderThinkingField {
    TypeDisabled,
    Omit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ProviderPreset {
    provider: CanonicalAIProvider,
    id: &'static str,
    display_name: &'static str,
    model: &'static str,
    endpoint: &'static str,
    credential_target: &'static str,
    thinking_field: ProviderThinkingField,
    selectable: bool,
}

impl ProviderPreset {
    pub(crate) fn provider(self) -> CanonicalAIProvider {
        self.provider
    }

    pub(crate) fn id(self) -> &'static str {
        self.id
    }

    pub(crate) fn display_name(self) -> &'static str {
        self.display_name
    }

    pub(crate) fn model(self) -> &'static str {
        self.model
    }

    pub(crate) fn endpoint(self) -> &'static str {
        self.endpoint
    }

    pub(crate) fn thinking_field(self) -> ProviderThinkingField {
        self.thinking_field
    }

    fn is_selectable(self) -> bool {
        self.selectable
    }
}

const PROVIDER_PRESETS: [ProviderPreset; 10] = [
    ProviderPreset {
        provider: CanonicalAIProvider::Deepseek,
        id: PROVIDER_DEEPSEEK,
        display_name: "DeepSeek",
        model: DEFAULT_DEEPSEEK_MODEL,
        endpoint: "https://api.deepseek.com/chat/completions",
        credential_target: "SciLoom/local.labpod.desktop/ai/deepseek/api-key",
        thinking_field: ProviderThinkingField::TypeDisabled,
        selectable: true,
    },
    ProviderPreset {
        provider: CanonicalAIProvider::Openai,
        id: PROVIDER_OPENAI,
        display_name: "OpenAI",
        model: OPENAI_MODEL,
        endpoint: "https://api.openai.com/v1/chat/completions",
        credential_target: "SciLoom/local.labpod.desktop/ai/openai/api-key",
        thinking_field: ProviderThinkingField::Omit,
        selectable: true,
    },
    ProviderPreset {
        provider: CanonicalAIProvider::TencentTokenhub,
        id: PROVIDER_TENCENT_TOKENHUB,
        display_name: "Tencent TokenHub",
        model: TOKENHUB_HY3_MODEL,
        endpoint: TOKENHUB_ENDPOINT,
        credential_target: TOKENHUB_CREDENTIAL_TARGET,
        thinking_field: ProviderThinkingField::TypeDisabled,
        selectable: false,
    },
    ProviderPreset {
        provider: CanonicalAIProvider::TencentTokenhub,
        id: PROVIDER_TENCENT_TOKENHUB,
        display_name: "Tencent TokenHub",
        model: TOKENHUB_GLM_5_1_MODEL,
        endpoint: TOKENHUB_ENDPOINT,
        credential_target: TOKENHUB_CREDENTIAL_TARGET,
        thinking_field: ProviderThinkingField::TypeDisabled,
        selectable: true,
    },
    ProviderPreset {
        provider: CanonicalAIProvider::TencentTokenhub,
        id: PROVIDER_TENCENT_TOKENHUB,
        display_name: "Tencent TokenHub",
        model: TOKENHUB_GLM_5_3_FLASH_MODEL,
        endpoint: TOKENHUB_ENDPOINT,
        credential_target: TOKENHUB_CREDENTIAL_TARGET,
        thinking_field: ProviderThinkingField::Omit,
        selectable: false,
    },
    ProviderPreset {
        provider: CanonicalAIProvider::TencentTokenhub,
        id: PROVIDER_TENCENT_TOKENHUB,
        display_name: "Tencent TokenHub",
        model: TOKENHUB_MINIMAX_M3_MODEL,
        endpoint: TOKENHUB_ENDPOINT,
        credential_target: TOKENHUB_CREDENTIAL_TARGET,
        thinking_field: ProviderThinkingField::TypeDisabled,
        selectable: true,
    },
    ProviderPreset {
        provider: CanonicalAIProvider::TencentTokenhub,
        id: PROVIDER_TENCENT_TOKENHUB,
        display_name: "Tencent TokenHub",
        model: TOKENHUB_MIMO_V2_5_PRO_MODEL,
        endpoint: TOKENHUB_ENDPOINT,
        credential_target: TOKENHUB_CREDENTIAL_TARGET,
        thinking_field: ProviderThinkingField::Omit,
        selectable: true,
    },
    ProviderPreset {
        provider: CanonicalAIProvider::TencentTokenhub,
        id: PROVIDER_TENCENT_TOKENHUB,
        display_name: "Tencent TokenHub",
        model: TOKENHUB_DEEPSEEK_V4_FLASH_MODEL,
        endpoint: TOKENHUB_ENDPOINT,
        credential_target: TOKENHUB_CREDENTIAL_TARGET,
        thinking_field: ProviderThinkingField::TypeDisabled,
        selectable: true,
    },
    ProviderPreset {
        provider: CanonicalAIProvider::TencentTokenhub,
        id: PROVIDER_TENCENT_TOKENHUB,
        display_name: "Tencent TokenHub",
        model: TOKENHUB_KIMI_K3_MODEL,
        endpoint: TOKENHUB_ENDPOINT,
        credential_target: TOKENHUB_CREDENTIAL_TARGET,
        thinking_field: ProviderThinkingField::Omit,
        selectable: false,
    },
    ProviderPreset {
        provider: CanonicalAIProvider::Kimi,
        id: PROVIDER_KIMI,
        display_name: "Kimi",
        model: KIMI_MODEL,
        endpoint: "https://api.moonshot.cn/v1/chat/completions",
        credential_target: "SciLoom/local.labpod.desktop/ai/kimi/api-key",
        thinking_field: ProviderThinkingField::TypeDisabled,
        selectable: true,
    },
];

pub(crate) fn provider_preset(provider: &str) -> Option<ProviderPreset> {
    PROVIDER_PRESETS
        .iter()
        .copied()
        .find(|preset| preset.is_selectable() && preset.id == provider)
}

pub(crate) fn provider_model_preset(provider: &str, model: &str) -> Option<ProviderPreset> {
    PROVIDER_PRESETS
        .iter()
        .copied()
        .find(|preset| preset.is_selectable() && preset.id == provider && preset.model == model)
}

#[cfg(test)]
pub(crate) fn implementation_attempt_preset(
    provider: &str,
    model: &str,
) -> Option<ProviderPreset> {
    PROVIDER_PRESETS
        .iter()
        .copied()
        .find(|preset| preset.id == provider && preset.model == model)
}

fn baseline_preset() -> ProviderPreset {
    provider_preset(PROVIDER_DEEPSEEK).expect("DeepSeek baseline preset")
}

enum AppSecretLookupOutcome {
    Present(Vec<u8>),
    Absent,
    Unavailable,
}

enum EnvironmentSecretLookupOutcome {
    Present(Vec<u8>),
    Absent,
    Invalid,
}

trait CredentialStore: Send + Sync {
    fn read(&self) -> AppSecretLookupOutcome;
    fn write(&self, value: &[u8]) -> Result<(), ()>;
    fn delete(&self) -> Result<(), ()>;
}

trait EnvironmentSecretReader: Send + Sync {
    fn read(&self) -> EnvironmentSecretLookupOutcome;
}

struct SecretValue(Vec<u8>);

impl SecretValue {
    fn from_untrusted(mut raw: Vec<u8>) -> Result<Self, ()> {
        let normalized = std::str::from_utf8(&raw)
            .ok()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .filter(|value| value.len() <= MAX_SECRET_BYTES)
            .filter(|value| !value.chars().any(char::is_control))
            .map(|value| value.as_bytes().to_vec());
        raw.fill(0);
        normalized.map(Self).ok_or(())
    }

    fn as_str(&self) -> &str {
        // Construction validates UTF-8 and the bytes are immutable afterwards.
        std::str::from_utf8(&self.0).expect("validated provider secret")
    }
}

impl Drop for SecretValue {
    fn drop(&mut self) {
        self.0.fill(0);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConfiguredState {
    Yes,
    No,
    Unknown,
}

impl Serialize for ConfiguredState {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            Self::Yes => serializer.serialize_bool(true),
            Self::No => serializer.serialize_bool(false),
            Self::Unknown => serializer.serialize_str("unknown"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderConfigurationEligibility {
    Eligible,
    Blocked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConfiguredSource {
    AppConfig,
    EnvironmentFallback,
    None,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalConfigurationState {
    Valid,
    InvalidShape,
    SecureStoreUnavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderValidationState {
    Unverified,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderPresetStatus {
    pub provider: String,
    pub display_name: String,
    pub model: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfigurationStatus {
    pub provider: String,
    pub model: String,
    pub active_provider: String,
    pub active_model: String,
    pub has_explicit_active_tuple: bool,
    pub available_presets: Vec<ProviderPresetStatus>,
    pub configuration_revision: u64,
    pub eligibility: ProviderConfigurationEligibility,
    effective_configured: ConfiguredState,
    pub configured_source: ConfiguredSource,
    app_override_configured: ConfiguredState,
    pub local_configuration_state: LocalConfigurationState,
    pub validation_state: ProviderValidationState,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedActiveTuple {
    version: u8,
    provider: String,
    model: String,
}

impl PersistedActiveTuple {
    fn from_preset(preset: ProviderPreset) -> Self {
        Self {
            version: ACTIVE_TUPLE_VERSION,
            provider: preset.id().to_string(),
            model: preset.model().to_string(),
        }
    }

    fn into_preset(self) -> Result<ProviderPreset, String> {
        if self.version != ACTIVE_TUPLE_VERSION {
            return Err(invalid_active_tuple_error());
        }
        provider_model_preset(&self.provider, &self.model).ok_or_else(invalid_active_tuple_error)
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum ResolvedSecretSource {
    AppConfig,
    EnvironmentFallback,
}

pub(crate) struct ProviderConfigurationSnapshot {
    preset: ProviderPreset,
    configuration_revision: u64,
    source: ResolvedSecretSource,
    secret: SecretValue,
}

impl ProviderConfigurationSnapshot {
    pub(crate) fn provider(&self) -> &str {
        self.preset.id()
    }

    pub(crate) fn model(&self) -> &str {
        self.preset.model()
    }

    pub(crate) fn preset(&self) -> ProviderPreset {
        self.preset
    }

    pub(crate) fn configuration_revision(&self) -> u64 {
        self.configuration_revision
    }

    pub(crate) fn secret(&self) -> &str {
        self.secret.as_str()
    }

    pub(crate) fn source(&self) -> ResolvedSecretSource {
        self.source
    }
}

struct ProviderConfigurationGeneration {
    revision: u64,
}

pub struct ProviderConfigurationService {
    generation: Mutex<ProviderConfigurationGeneration>,
    active_tuple_store: Arc<dyn CredentialStore>,
    credential_stores: HashMap<CanonicalAIProvider, Arc<dyn CredentialStore>>,
    environment_reader: Arc<dyn EnvironmentSecretReader>,
}

impl Default for ProviderConfigurationService {
    fn default() -> Self {
        Self::production()
    }
}

impl ProviderConfigurationService {
    fn production() -> Self {
        let store = |target: &str| -> Arc<dyn CredentialStore> {
            #[cfg(target_os = "windows")]
            {
                Arc::new(WindowsCredentialStore::new(target.to_string()))
            }
            #[cfg(target_os = "macos")]
            {
                Arc::new(macos_credential_store::MacCredentialStore::new(
                    target.to_string(),
                ))
            }
            #[cfg(not(any(target_os = "windows", target_os = "macos")))]
            {
                let _ = target;
                Arc::new(UnavailableCredentialStore)
            }
        };
        let mut credential_stores = HashMap::new();
        for preset in PROVIDER_PRESETS {
            credential_stores
                .entry(preset.provider())
                .or_insert_with(|| store(preset.credential_target));
        }
        Self::new(
            store(ACTIVE_TUPLE_TARGET),
            credential_stores,
            Arc::new(SystemEnvironmentSecretReader),
        )
    }

    fn new(
        active_tuple_store: Arc<dyn CredentialStore>,
        credential_stores: HashMap<CanonicalAIProvider, Arc<dyn CredentialStore>>,
        environment_reader: Arc<dyn EnvironmentSecretReader>,
    ) -> Self {
        Self {
            generation: Mutex::new(ProviderConfigurationGeneration { revision: 1 }),
            active_tuple_store,
            credential_stores,
            environment_reader,
        }
    }

    fn generation(&self) -> MutexGuard<'_, ProviderConfigurationGeneration> {
        self.generation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn read_active_preset(&self) -> Result<(ProviderPreset, bool), String> {
        match self.active_tuple_store.read() {
            AppSecretLookupOutcome::Absent => Ok((baseline_preset(), false)),
            AppSecretLookupOutcome::Unavailable => Err(ai_error_json(
                "secure_store_unavailable",
                "The active AI provider selection could not be read from the operating system store.",
                true,
                None,
            )),
            AppSecretLookupOutcome::Present(mut raw) => {
                let parsed = serde_json::from_slice::<PersistedActiveTuple>(&raw)
                    .map_err(|_| invalid_active_tuple_error())
                    .and_then(PersistedActiveTuple::into_preset);
                raw.fill(0);
                parsed.map(|preset| (preset, true))
            }
        }
    }

    fn credential_store(&self, provider: CanonicalAIProvider) -> &Arc<dyn CredentialStore> {
        self.credential_stores
            .get(&provider)
            .expect("every canonical provider owns one credential slot")
    }

    fn credential_status(
        &self,
        preset: ProviderPreset,
    ) -> (
        ProviderConfigurationEligibility,
        ConfiguredState,
        ConfiguredSource,
        ConfiguredState,
        LocalConfigurationState,
    ) {
        match self.credential_store(preset.provider()).read() {
            AppSecretLookupOutcome::Unavailable => (
                ProviderConfigurationEligibility::Blocked,
                ConfiguredState::Unknown,
                ConfiguredSource::Unavailable,
                ConfiguredState::Unknown,
                LocalConfigurationState::SecureStoreUnavailable,
            ),
            AppSecretLookupOutcome::Present(raw) => match SecretValue::from_untrusted(raw) {
                Ok(secret) => {
                    drop(secret);
                    (
                        ProviderConfigurationEligibility::Eligible,
                        ConfiguredState::Yes,
                        ConfiguredSource::AppConfig,
                        ConfiguredState::Yes,
                        LocalConfigurationState::Valid,
                    )
                }
                Err(()) => (
                    ProviderConfigurationEligibility::Blocked,
                    ConfiguredState::No,
                    ConfiguredSource::AppConfig,
                    ConfiguredState::Yes,
                    LocalConfigurationState::InvalidShape,
                ),
            },
            AppSecretLookupOutcome::Absent
                if preset.provider() == CanonicalAIProvider::Deepseek =>
            {
                match self.environment_reader.read() {
                    EnvironmentSecretLookupOutcome::Present(raw) => {
                        match SecretValue::from_untrusted(raw) {
                            Ok(secret) => {
                                drop(secret);
                                (
                                    ProviderConfigurationEligibility::Eligible,
                                    ConfiguredState::Yes,
                                    ConfiguredSource::EnvironmentFallback,
                                    ConfiguredState::No,
                                    LocalConfigurationState::Valid,
                                )
                            }
                            Err(()) => (
                                ProviderConfigurationEligibility::Blocked,
                                ConfiguredState::No,
                                ConfiguredSource::EnvironmentFallback,
                                ConfiguredState::No,
                                LocalConfigurationState::InvalidShape,
                            ),
                        }
                    }
                    EnvironmentSecretLookupOutcome::Absent => (
                        ProviderConfigurationEligibility::Blocked,
                        ConfiguredState::No,
                        ConfiguredSource::None,
                        ConfiguredState::No,
                        LocalConfigurationState::Valid,
                    ),
                    EnvironmentSecretLookupOutcome::Invalid => (
                        ProviderConfigurationEligibility::Blocked,
                        ConfiguredState::No,
                        ConfiguredSource::EnvironmentFallback,
                        ConfiguredState::No,
                        LocalConfigurationState::InvalidShape,
                    ),
                }
            }
            AppSecretLookupOutcome::Absent => (
                ProviderConfigurationEligibility::Blocked,
                ConfiguredState::No,
                ConfiguredSource::None,
                ConfiguredState::No,
                LocalConfigurationState::Valid,
            ),
        }
    }

    fn status_locked(
        &self,
        revision: u64,
        selected_provider: Option<&str>,
    ) -> Result<ProviderConfigurationStatus, String> {
        let (active, has_explicit_active_tuple) = self.read_active_preset()?;
        let selected = match selected_provider {
            Some(provider) => provider_preset(provider).ok_or_else(invalid_active_tuple_error)?,
            None => active,
        };
        let (
            eligibility,
            effective_configured,
            configured_source,
            app_override_configured,
            local_configuration_state,
        ) = self.credential_status(selected);
        Ok(ProviderConfigurationStatus {
            provider: selected.id().to_string(),
            model: selected.model().to_string(),
            active_provider: active.id().to_string(),
            active_model: active.model().to_string(),
            has_explicit_active_tuple,
            available_presets: PROVIDER_PRESETS
                .iter()
                .filter(|preset| preset.is_selectable())
                .map(|preset| ProviderPresetStatus {
                    provider: preset.id().to_string(),
                    display_name: preset.display_name().to_string(),
                    model: preset.model().to_string(),
                })
                .collect(),
            configuration_revision: revision,
            eligibility,
            effective_configured,
            configured_source,
            app_override_configured,
            local_configuration_state,
            validation_state: ProviderValidationState::Unverified,
        })
    }

    pub fn status(
        &self,
        selected_provider: Option<&str>,
    ) -> Result<ProviderConfigurationStatus, String> {
        let generation = self.generation();
        self.status_locked(generation.revision, selected_provider)
    }

    pub fn save_active_tuple(
        &self,
        provider: String,
        model: String,
    ) -> Result<ProviderConfigurationStatus, String> {
        let preset = provider_model_preset(provider.trim(), model.trim())
            .ok_or_else(invalid_active_tuple_error)?;
        let serialized = serde_json::to_vec(&PersistedActiveTuple::from_preset(preset))
            .map_err(|_| active_tuple_persistence_error())?;
        let mut generation = self.generation();
        let previous = self.active_tuple_store.read();
        if matches!(&previous, AppSecretLookupOutcome::Unavailable) {
            return Err(active_tuple_persistence_error());
        }
        self.active_tuple_store
            .write(&serialized)
            .map_err(|()| active_tuple_persistence_error())?;
        generation.revision = generation.revision.saturating_add(1);
        let verified = self.read_active_preset();
        if !matches!(verified, Ok((readback, true)) if readback == preset) {
            restore_store_value(&self.active_tuple_store, previous);
            return Err(active_tuple_persistence_error());
        }
        self.status_locked(generation.revision, Some(preset.id()))
    }

    pub fn clear_active_tuple(&self) -> Result<ProviderConfigurationStatus, String> {
        let mut generation = self.generation();
        let previous = self.active_tuple_store.read();
        if matches!(&previous, AppSecretLookupOutcome::Unavailable) {
            return Err(active_tuple_persistence_error());
        }
        self.active_tuple_store
            .delete()
            .map_err(|()| active_tuple_persistence_error())?;
        generation.revision = generation.revision.saturating_add(1);
        if !matches!(
            self.active_tuple_store.read(),
            AppSecretLookupOutcome::Absent
        ) {
            restore_store_value(&self.active_tuple_store, previous);
            return Err(active_tuple_persistence_error());
        }
        self.status_locked(generation.revision, None)
    }

    pub fn set_api_key(
        &self,
        provider: String,
        api_key: String,
    ) -> Result<ProviderConfigurationStatus, String> {
        let preset = provider_preset(provider.trim()).ok_or_else(invalid_active_tuple_error)?;
        let raw = api_key.into_bytes();
        let secret = SecretValue::from_untrusted(raw).map_err(|()| {
            ai_error_json(
                "invalid_provider_configuration",
                "The API key must be nonblank, contain no control characters, and be at most 2048 bytes.",
                false,
                None,
            )
        })?;
        let mut generation = self.generation();
        self.credential_store(preset.provider())
            .write(&secret.0)
            .map_err(|()| {
                ai_error_json(
                    "settings_persistence_failed",
                    "The API key could not be saved to the operating system credential store.",
                    false,
                    None,
                )
            })?;
        generation.revision = generation.revision.saturating_add(1);
        let status = self.status_locked(generation.revision, Some(preset.id()))?;
        if status.eligibility != ProviderConfigurationEligibility::Eligible
            || status.configured_source != ConfiguredSource::AppConfig
            || status.local_configuration_state != LocalConfigurationState::Valid
        {
            return Err(ai_error_json(
                "settings_persistence_failed",
                "The API key write could not be verified by authoritative secure readback.",
                false,
                None,
            ));
        }
        Ok(status)
    }

    pub fn clear_api_key(&self, provider: String) -> Result<ProviderConfigurationStatus, String> {
        let preset = provider_preset(provider.trim()).ok_or_else(invalid_active_tuple_error)?;
        let mut generation = self.generation();
        self.credential_store(preset.provider())
            .delete()
            .map_err(|()| {
                ai_error_json(
                    "settings_persistence_failed",
                    "The application API key override could not be cleared.",
                    false,
                    None,
                )
            })?;
        generation.revision = generation.revision.saturating_add(1);
        let status = self.status_locked(generation.revision, Some(preset.id()))?;
        if status.local_configuration_state != LocalConfigurationState::Valid
            || status.app_override_configured != ConfiguredState::No
        {
            return Err(ai_error_json(
                "settings_persistence_failed",
                "The API key clear could not be verified by authoritative secure readback.",
                false,
                None,
            ));
        }
        Ok(status)
    }

    pub(crate) fn resolve_snapshot(
        &self,
        expected_configuration_revision: u64,
    ) -> Result<ProviderConfigurationSnapshot, String> {
        let generation = self.generation();
        if generation.revision != expected_configuration_revision {
            return Err(ai_error_json(
                "configuration_changed",
                "AI provider configuration changed before network start. Retry the invocation.",
                true,
                None,
            ));
        }

        let (preset, _) = self.read_active_preset()?;
        let (source, secret) = match self.credential_store(preset.provider()).read() {
            AppSecretLookupOutcome::Unavailable => {
                return Err(ai_error_json(
                    "secure_store_unavailable",
                    "The operating system credential store is unavailable. No environment fallback was attempted.",
                    true,
                    None,
                ));
            }
            AppSecretLookupOutcome::Present(raw) => (
                ResolvedSecretSource::AppConfig,
                SecretValue::from_untrusted(raw).map_err(|()| {
                    ai_error_json(
                        "invalid_provider_configuration",
                        "The application API key has an invalid local shape.",
                        false,
                        None,
                    )
                })?,
            ),
            AppSecretLookupOutcome::Absent
                if preset.provider() == CanonicalAIProvider::Deepseek =>
            {
                match self.environment_reader.read() {
                    EnvironmentSecretLookupOutcome::Present(raw) => (
                        ResolvedSecretSource::EnvironmentFallback,
                        SecretValue::from_untrusted(raw).map_err(|()| {
                            ai_error_json(
                                "invalid_provider_configuration",
                                "The environment API key has an invalid local shape.",
                                false,
                                None,
                            )
                        })?,
                    ),
                    EnvironmentSecretLookupOutcome::Absent => {
                        return Err(ai_error_json(
                        "missing_api_key",
                        "No API key is configured for the selected AI provider. Open Settings to add one.",
                        false,
                        None,
                    ));
                    }
                    EnvironmentSecretLookupOutcome::Invalid => {
                        return Err(ai_error_json(
                            "invalid_provider_configuration",
                            "The environment API key has an invalid local shape.",
                            false,
                            None,
                        ));
                    }
                }
            }
            AppSecretLookupOutcome::Absent => {
                return Err(ai_error_json(
                    "missing_api_key",
                    "No API key is configured for the selected AI provider. Open Settings to add one.",
                    false,
                    None,
                ));
            }
        };

        Ok(ProviderConfigurationSnapshot {
            preset,
            configuration_revision: generation.revision,
            source,
            secret,
        })
    }

    #[cfg(test)]
    pub(crate) fn test_configured() -> Self {
        let active = Arc::new(MemoryCredentialStore::absent());
        let stores = test_credential_stores(Some(CanonicalAIProvider::Deepseek));
        Self::new(
            active,
            stores,
            Arc::new(FakeEnvironmentSecretReader::absent()),
        )
    }
}

fn invalid_active_tuple_error() -> String {
    ai_error_json(
        "invalid_provider_configuration",
        "The active AI provider/model selection is not a canonical curated preset.",
        false,
        None,
    )
}

fn active_tuple_persistence_error() -> String {
    ai_error_json(
        "settings_persistence_failed",
        "The active AI provider/model selection could not be saved and read back safely.",
        false,
        None,
    )
}

fn restore_store_value(store: &Arc<dyn CredentialStore>, previous: AppSecretLookupOutcome) {
    match previous {
        AppSecretLookupOutcome::Present(mut value) => {
            let _ = store.write(&value);
            value.fill(0);
        }
        AppSecretLookupOutcome::Absent => {
            let _ = store.delete();
        }
        AppSecretLookupOutcome::Unavailable => {}
    }
}

struct SystemEnvironmentSecretReader;

impl EnvironmentSecretReader for SystemEnvironmentSecretReader {
    fn read(&self) -> EnvironmentSecretLookupOutcome {
        match std::env::var(DEEPSEEK_API_KEY_ENVIRONMENT_VARIABLE) {
            Ok(value) if value.trim().is_empty() => EnvironmentSecretLookupOutcome::Absent,
            Ok(value) => EnvironmentSecretLookupOutcome::Present(value.into_bytes()),
            Err(std::env::VarError::NotPresent) => EnvironmentSecretLookupOutcome::Absent,
            Err(std::env::VarError::NotUnicode(_)) => EnvironmentSecretLookupOutcome::Invalid,
        }
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
struct UnavailableCredentialStore;

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
impl CredentialStore for UnavailableCredentialStore {
    fn read(&self) -> AppSecretLookupOutcome {
        AppSecretLookupOutcome::Unavailable
    }

    fn write(&self, _value: &[u8]) -> Result<(), ()> {
        Err(())
    }

    fn delete(&self) -> Result<(), ()> {
        Err(())
    }
}

#[cfg(target_os = "windows")]
struct WindowsCredentialStore {
    target: String,
}

#[cfg(target_os = "windows")]
impl WindowsCredentialStore {
    fn new(target: String) -> Self {
        Self { target }
    }

    fn target_wide(&self) -> Vec<u16> {
        self.target
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect()
    }

    fn is_not_found(error: &windows::core::Error) -> bool {
        use windows::Win32::Foundation::ERROR_NOT_FOUND;
        error.code() == windows::core::HRESULT::from_win32(ERROR_NOT_FOUND.0)
    }
}

#[cfg(target_os = "windows")]
impl CredentialStore for WindowsCredentialStore {
    fn read(&self) -> AppSecretLookupOutcome {
        use std::ffi::c_void;
        use std::ptr;
        use windows::core::PCWSTR;
        use windows::Win32::Security::Credentials::{
            CredFree, CredReadW, CREDENTIALW, CRED_TYPE_GENERIC,
        };

        let target = self.target_wide();
        let mut credential: *mut CREDENTIALW = ptr::null_mut();
        let read = unsafe {
            CredReadW(
                PCWSTR(target.as_ptr()),
                CRED_TYPE_GENERIC,
                None,
                &mut credential,
            )
        };
        if let Err(error) = read {
            return if Self::is_not_found(&error) {
                AppSecretLookupOutcome::Absent
            } else {
                AppSecretLookupOutcome::Unavailable
            };
        }
        if credential.is_null() {
            return AppSecretLookupOutcome::Unavailable;
        }
        let value = unsafe {
            let credential_ref = &*credential;
            let size = credential_ref.CredentialBlobSize as usize;
            let value = if size == 0 {
                Vec::new()
            } else if credential_ref.CredentialBlob.is_null() || size > 2_560 {
                vec![0; MAX_SECRET_BYTES + 1]
            } else {
                std::slice::from_raw_parts(credential_ref.CredentialBlob, size).to_vec()
            };
            CredFree(credential.cast::<c_void>());
            value
        };
        AppSecretLookupOutcome::Present(value)
    }

    fn write(&self, value: &[u8]) -> Result<(), ()> {
        use windows::core::PWSTR;
        use windows::Win32::Security::Credentials::{
            CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
        };

        let mut target = self.target_wide();
        let mut secret_copy = value.to_vec();
        let mut credential = CREDENTIALW::default();
        credential.Type = CRED_TYPE_GENERIC;
        credential.TargetName = PWSTR(target.as_mut_ptr());
        credential.CredentialBlobSize = secret_copy.len() as u32;
        credential.CredentialBlob = secret_copy.as_mut_ptr();
        credential.Persist = CRED_PERSIST_LOCAL_MACHINE;
        let result = unsafe { CredWriteW(&credential, 0) }.map_err(|_| ());
        secret_copy.fill(0);
        result
    }

    fn delete(&self) -> Result<(), ()> {
        use windows::core::PCWSTR;
        use windows::Win32::Security::Credentials::{CredDeleteW, CRED_TYPE_GENERIC};

        let target = self.target_wide();
        match unsafe { CredDeleteW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, None) } {
            Ok(()) => Ok(()),
            Err(error) if Self::is_not_found(&error) => Ok(()),
            Err(_) => Err(()),
        }
    }
}

#[tauri::command]
pub fn get_ai_provider_configuration_status(
    state: State<'_, ProviderConfigurationService>,
    provider: Option<String>,
) -> Result<ProviderConfigurationStatus, String> {
    state.status(provider.as_deref())
}

#[tauri::command(rename_all = "camelCase")]
pub fn save_ai_provider_active_tuple(
    state: State<'_, ProviderConfigurationService>,
    provider: String,
    model: String,
) -> Result<ProviderConfigurationStatus, String> {
    state.save_active_tuple(provider, model)
}

#[tauri::command]
pub fn clear_ai_provider_active_tuple(
    state: State<'_, ProviderConfigurationService>,
) -> Result<ProviderConfigurationStatus, String> {
    state.clear_active_tuple()
}

#[tauri::command(rename_all = "camelCase")]
pub fn set_ai_provider_api_key(
    state: State<'_, ProviderConfigurationService>,
    provider: String,
    api_key: String,
) -> Result<ProviderConfigurationStatus, String> {
    state.set_api_key(provider, api_key)
}

#[tauri::command(rename_all = "camelCase")]
pub fn clear_ai_provider_api_key(
    state: State<'_, ProviderConfigurationService>,
    provider: String,
) -> Result<ProviderConfigurationStatus, String> {
    state.clear_api_key(provider)
}

#[cfg(test)]
struct MemoryCredentialStore {
    value: Mutex<Option<Vec<u8>>>,
    read_unavailable: std::sync::atomic::AtomicBool,
    fail_read_after_write: std::sync::atomic::AtomicBool,
    fail_read_after_delete: std::sync::atomic::AtomicBool,
}

#[cfg(test)]
impl MemoryCredentialStore {
    fn absent() -> Self {
        Self {
            value: Mutex::new(None),
            read_unavailable: std::sync::atomic::AtomicBool::new(false),
            fail_read_after_write: std::sync::atomic::AtomicBool::new(false),
            fail_read_after_delete: std::sync::atomic::AtomicBool::new(false),
        }
    }

    fn with_value(value: Vec<u8>) -> Self {
        Self {
            value: Mutex::new(Some(value)),
            ..Self::absent()
        }
    }
}

#[cfg(test)]
impl CredentialStore for MemoryCredentialStore {
    fn read(&self) -> AppSecretLookupOutcome {
        if self
            .read_unavailable
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            return AppSecretLookupOutcome::Unavailable;
        }
        self.value
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
            .map(AppSecretLookupOutcome::Present)
            .unwrap_or(AppSecretLookupOutcome::Absent)
    }

    fn write(&self, value: &[u8]) -> Result<(), ()> {
        *self
            .value
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(value.to_vec());
        if self
            .fail_read_after_write
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            self.read_unavailable
                .store(true, std::sync::atomic::Ordering::SeqCst);
        }
        Ok(())
    }

    fn delete(&self) -> Result<(), ()> {
        *self
            .value
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        if self
            .fail_read_after_delete
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            self.read_unavailable
                .store(true, std::sync::atomic::Ordering::SeqCst);
        }
        Ok(())
    }
}

#[cfg(test)]
fn test_credential_stores(
    configured_provider: Option<CanonicalAIProvider>,
) -> HashMap<CanonicalAIProvider, Arc<dyn CredentialStore>> {
    let mut stores = HashMap::new();
    for preset in PROVIDER_PRESETS {
        stores.entry(preset.provider()).or_insert_with(|| {
            let store: Arc<dyn CredentialStore> = if configured_provider == Some(preset.provider())
            {
                Arc::new(MemoryCredentialStore::with_value(
                    ["deterministic", "test", "credential"]
                        .join("-")
                        .into_bytes(),
                ))
            } else {
                Arc::new(MemoryCredentialStore::absent())
            };
            store
        });
    }
    stores
}

#[cfg(test)]
struct FakeEnvironmentSecretReader {
    value: Mutex<EnvironmentSecretLookupOutcome>,
    reads: std::sync::atomic::AtomicUsize,
}

#[cfg(test)]
impl FakeEnvironmentSecretReader {
    fn absent() -> Self {
        Self {
            value: Mutex::new(EnvironmentSecretLookupOutcome::Absent),
            reads: std::sync::atomic::AtomicUsize::new(0),
        }
    }

    fn present(value: Vec<u8>) -> Self {
        Self {
            value: Mutex::new(EnvironmentSecretLookupOutcome::Present(value)),
            reads: std::sync::atomic::AtomicUsize::new(0),
        }
    }
}

#[cfg(test)]
impl EnvironmentSecretReader for FakeEnvironmentSecretReader {
    fn read(&self) -> EnvironmentSecretLookupOutcome {
        self.reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let value = self
            .value
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match &*value {
            EnvironmentSecretLookupOutcome::Present(value) => {
                EnvironmentSecretLookupOutcome::Present(value.clone())
            }
            EnvironmentSecretLookupOutcome::Absent => EnvironmentSecretLookupOutcome::Absent,
            EnvironmentSecretLookupOutcome::Invalid => EnvironmentSecretLookupOutcome::Invalid,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;

    fn memory_stores(
        configured: &[CanonicalAIProvider],
    ) -> (
        HashMap<CanonicalAIProvider, Arc<dyn CredentialStore>>,
        HashMap<CanonicalAIProvider, Arc<MemoryCredentialStore>>,
    ) {
        let mut stores = HashMap::new();
        let mut handles = HashMap::new();
        for preset in PROVIDER_PRESETS {
            if stores.contains_key(&preset.provider()) {
                continue;
            }
            let store = Arc::new(if configured.contains(&preset.provider()) {
                MemoryCredentialStore::with_value(
                    ["deterministic", preset.id(), "credential"]
                        .join("-")
                        .into_bytes(),
                )
            } else {
                MemoryCredentialStore::absent()
            });
            stores.insert(preset.provider(), store.clone() as Arc<dyn CredentialStore>);
            handles.insert(preset.provider(), store);
        }
        (stores, handles)
    }

    fn service_with(
        active: Arc<MemoryCredentialStore>,
        configured: &[CanonicalAIProvider],
        environment: Arc<FakeEnvironmentSecretReader>,
    ) -> (
        ProviderConfigurationService,
        HashMap<CanonicalAIProvider, Arc<MemoryCredentialStore>>,
    ) {
        let (stores, handles) = memory_stores(configured);
        (
            ProviderConfigurationService::new(active, stores, environment),
            handles,
        )
    }

    fn ipc_url() -> tauri::Url {
        if cfg!(any(windows, target_os = "android")) {
            "http://tauri.localhost"
        } else {
            "tauri://localhost"
        }
        .parse()
        .expect("IPC URL")
    }

    fn configuration_ipc_request(
        command: &str,
        body: serde_json::Value,
    ) -> tauri::webview::InvokeRequest {
        tauri::webview::InvokeRequest {
            cmd: command.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: ipc_url(),
            body: tauri::ipc::InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.to_string(),
        }
    }

    fn error_code(error: &str) -> String {
        serde_json::from_str::<serde_json::Value>(error).unwrap()["code"]
            .as_str()
            .unwrap()
            .to_string()
    }

    fn expect_error<T>(result: Result<T, String>) -> String {
        match result {
            Err(error) => error,
            Ok(_) => panic!("expected a safe provider configuration error"),
        }
    }

    fn assert_exact_preset(
        provider: &str,
        model: &str,
        endpoint: &str,
        credential_target: &str,
        thinking_field: ProviderThinkingField,
    ) {
        let preset =
            implementation_attempt_preset(provider, model).expect("canonical exact preset");
        assert_eq!(preset.id(), provider);
        assert_eq!(preset.model(), model);
        assert_eq!(preset.endpoint(), endpoint);
        assert_eq!(preset.credential_target, credential_target);
        assert_eq!(preset.thinking_field(), thinking_field);
    }

    #[test]
    fn deepseek_preset_preserves_the_frozen_baseline() {
        assert_exact_preset(
            PROVIDER_DEEPSEEK,
            DEFAULT_DEEPSEEK_MODEL,
            "https://api.deepseek.com/chat/completions",
            "SciLoom/local.labpod.desktop/ai/deepseek/api-key",
            ProviderThinkingField::TypeDisabled,
        );
    }

    #[test]
    fn openai_preset_is_exact_and_provider_scoped() {
        assert_exact_preset(
            PROVIDER_OPENAI,
            OPENAI_MODEL,
            "https://api.openai.com/v1/chat/completions",
            "SciLoom/local.labpod.desktop/ai/openai/api-key",
            ProviderThinkingField::Omit,
        );
    }

    #[test]
    fn tencent_tokenhub_presets_are_exact_and_share_one_provider_credential_owner() {
        for (model, thinking_field) in [
            (TOKENHUB_HY3_MODEL, ProviderThinkingField::TypeDisabled),
            (TOKENHUB_GLM_5_1_MODEL, ProviderThinkingField::TypeDisabled),
            (TOKENHUB_GLM_5_3_FLASH_MODEL, ProviderThinkingField::Omit),
            (
                TOKENHUB_MINIMAX_M3_MODEL,
                ProviderThinkingField::TypeDisabled,
            ),
            (TOKENHUB_MIMO_V2_5_PRO_MODEL, ProviderThinkingField::Omit),
            (
                TOKENHUB_DEEPSEEK_V4_FLASH_MODEL,
                ProviderThinkingField::TypeDisabled,
            ),
            (TOKENHUB_KIMI_K3_MODEL, ProviderThinkingField::Omit),
        ] {
            assert_exact_preset(
                PROVIDER_TENCENT_TOKENHUB,
                model,
                TOKENHUB_ENDPOINT,
                TOKENHUB_CREDENTIAL_TARGET,
                thinking_field,
            );
        }
        for model in [
            TOKENHUB_GLM_5_1_MODEL,
            TOKENHUB_MINIMAX_M3_MODEL,
            TOKENHUB_MIMO_V2_5_PRO_MODEL,
            TOKENHUB_DEEPSEEK_V4_FLASH_MODEL,
        ] {
            assert!(provider_model_preset(PROVIDER_TENCENT_TOKENHUB, model).is_some());
        }
        for model in [
            TOKENHUB_HY3_MODEL,
            TOKENHUB_GLM_5_3_FLASH_MODEL,
            TOKENHUB_KIMI_K3_MODEL,
        ] {
            assert!(provider_model_preset(PROVIDER_TENCENT_TOKENHUB, model).is_none());
        }
        assert_eq!(
            provider_preset(PROVIDER_TENCENT_TOKENHUB)
                .expect("final accepted TokenHub projection")
                .model(),
            TOKENHUB_GLM_5_1_MODEL
        );
        assert!(provider_model_preset(PROVIDER_TENCENT_TOKENHUB, "unknown-model").is_none());
        assert!(provider_model_preset(PROVIDER_DEEPSEEK, TOKENHUB_GLM_5_1_MODEL).is_none());
    }

    #[test]
    fn kimi_preset_is_exact_and_provider_scoped() {
        assert_exact_preset(
            PROVIDER_KIMI,
            KIMI_MODEL,
            "https://api.moonshot.cn/v1/chat/completions",
            "SciLoom/local.labpod.desktop/ai/kimi/api-key",
            ProviderThinkingField::TypeDisabled,
        );
    }

    #[test]
    fn legacy_absence_save_restart_and_clear_use_one_active_tuple_authority() {
        let active = Arc::new(MemoryCredentialStore::absent());
        let env = Arc::new(FakeEnvironmentSecretReader::present(
            ["deterministic", "environment", "credential"]
                .join("-")
                .into_bytes(),
        ));
        let (service, credentials) = service_with(active.clone(), &[], env.clone());

        let initial = service.status(None).unwrap();
        assert_eq!(initial.configuration_revision, 1);
        assert_eq!(initial.active_provider, PROVIDER_DEEPSEEK);
        assert_eq!(initial.active_model, DEFAULT_DEEPSEEK_MODEL);
        assert!(!initial.has_explicit_active_tuple);
        assert_eq!(initial.available_presets.len(), 7);
        assert_eq!(
            initial.configured_source,
            ConfiguredSource::EnvironmentFallback
        );

        let saved = service
            .save_active_tuple(PROVIDER_OPENAI.into(), OPENAI_MODEL.into())
            .unwrap();
        assert_eq!(saved.configuration_revision, 2);
        assert_eq!(saved.active_provider, PROVIDER_OPENAI);
        assert_eq!(saved.active_model, OPENAI_MODEL);
        assert!(saved.has_explicit_active_tuple);
        assert_eq!(saved.effective_configured, ConfiguredState::No);

        let restarted = ProviderConfigurationService::new(
            active,
            {
                let mut stores = HashMap::new();
                for (provider, store) in credentials {
                    stores.insert(provider, store as Arc<dyn CredentialStore>);
                }
                stores
            },
            env,
        );
        let restart_status = restarted.status(None).unwrap();
        assert_eq!(restart_status.configuration_revision, 1);
        assert_eq!(restart_status.active_provider, PROVIDER_OPENAI);
        assert!(restart_status.has_explicit_active_tuple);

        let restored = restarted.clear_active_tuple().unwrap();
        assert_eq!(restored.active_provider, PROVIDER_DEEPSEEK);
        assert!(!restored.has_explicit_active_tuple);
    }

    #[test]
    fn selected_provider_credential_lookup_never_falls_back_across_providers() {
        let active = Arc::new(MemoryCredentialStore::absent());
        let env = Arc::new(FakeEnvironmentSecretReader::present(
            ["deepseek", "environment", "credential"]
                .join("-")
                .into_bytes(),
        ));
        let (service, handles) = service_with(active, &[], env.clone());

        let openai = service.status(Some(PROVIDER_OPENAI)).unwrap();
        assert_eq!(openai.configured_source, ConfiguredSource::None);
        assert_eq!(openai.effective_configured, ConfiguredState::No);
        assert_eq!(env.reads.load(Ordering::SeqCst), 0);

        service
            .set_api_key(
                PROVIDER_OPENAI.into(),
                ["openai", "deterministic", "credential"].join("-"),
            )
            .unwrap();
        service
            .save_active_tuple(PROVIDER_OPENAI.into(), OPENAI_MODEL.into())
            .unwrap();
        let snapshot = service.resolve_snapshot(3).unwrap();
        assert_eq!(snapshot.provider(), PROVIDER_OPENAI);
        assert_eq!(snapshot.model(), OPENAI_MODEL);
        assert!(matches!(snapshot.source(), ResolvedSecretSource::AppConfig));
        assert_eq!(env.reads.load(Ordering::SeqCst), 0);

        service.clear_api_key(PROVIDER_OPENAI.into()).unwrap();
        assert_eq!(
            error_code(&expect_error(service.resolve_snapshot(4))),
            "missing_api_key"
        );
        assert_eq!(env.reads.load(Ordering::SeqCst), 0);
        assert!(matches!(
            handles[&CanonicalAIProvider::Deepseek].read(),
            AppSecretLookupOutcome::Absent
        ));
    }

    #[test]
    fn invalid_cross_provider_model_and_revision_mismatch_fail_closed() {
        let (service, _) = service_with(
            Arc::new(MemoryCredentialStore::absent()),
            &[CanonicalAIProvider::Deepseek],
            Arc::new(FakeEnvironmentSecretReader::absent()),
        );
        assert_eq!(
            error_code(&expect_error(service.save_active_tuple(
                PROVIDER_OPENAI.into(),
                DEFAULT_DEEPSEEK_MODEL.into(),
            ))),
            "invalid_provider_configuration"
        );
        assert!(!service.status(None).unwrap().has_explicit_active_tuple);
        assert_eq!(
            error_code(&expect_error(service.save_active_tuple(
                PROVIDER_TENCENT_TOKENHUB.into(),
                "unknown-model".into(),
            ))),
            "invalid_provider_configuration"
        );
        assert_eq!(
            error_code(&expect_error(service.resolve_snapshot(2))),
            "configuration_changed"
        );
    }

    #[test]
    fn frozen_snapshot_is_immutable_and_old_revision_never_switches_provider() {
        let (service, _) = service_with(
            Arc::new(MemoryCredentialStore::absent()),
            &[CanonicalAIProvider::Deepseek, CanonicalAIProvider::Openai],
            Arc::new(FakeEnvironmentSecretReader::absent()),
        );
        let frozen = service.resolve_snapshot(1).unwrap();
        service
            .save_active_tuple(PROVIDER_OPENAI.into(), OPENAI_MODEL.into())
            .unwrap();
        assert_eq!(frozen.provider(), PROVIDER_DEEPSEEK);
        assert_eq!(frozen.model(), DEFAULT_DEEPSEEK_MODEL);
        assert_eq!(
            error_code(&expect_error(service.resolve_snapshot(1))),
            "configuration_changed"
        );
        let current = service.resolve_snapshot(2).unwrap();
        assert_eq!(current.provider(), PROVIDER_OPENAI);
        assert_eq!(current.model(), OPENAI_MODEL);
    }

    #[test]
    fn final_tokenhub_acceptance_projection_saves_accepted_models_and_rejects_cross_provider_models(
    ) {
        let (service, _) = service_with(
            Arc::new(MemoryCredentialStore::absent()),
            &[
                CanonicalAIProvider::Deepseek,
                CanonicalAIProvider::TencentTokenhub,
            ],
            Arc::new(FakeEnvironmentSecretReader::absent()),
        );
        let saved = service
            .save_active_tuple(
                PROVIDER_TENCENT_TOKENHUB.into(),
                TOKENHUB_DEEPSEEK_V4_FLASH_MODEL.into(),
            )
            .unwrap();
        assert_eq!(saved.active_provider, PROVIDER_TENCENT_TOKENHUB);
        assert_eq!(saved.active_model, TOKENHUB_DEEPSEEK_V4_FLASH_MODEL);
        assert!(saved.has_explicit_active_tuple);
        assert_eq!(saved.effective_configured, ConfiguredState::Yes);

        let snapshot = service.resolve_snapshot(2).unwrap();
        assert_eq!(snapshot.provider(), PROVIDER_TENCENT_TOKENHUB);
        assert_eq!(snapshot.model(), TOKENHUB_DEEPSEEK_V4_FLASH_MODEL);
        assert_eq!(
            error_code(&expect_error(service.save_active_tuple(
                PROVIDER_DEEPSEEK.into(),
                TOKENHUB_GLM_5_1_MODEL.into(),
            ))),
            "invalid_provider_configuration"
        );
    }

    #[test]
    fn persisted_accepted_tokenhub_tuple_restarts_with_the_exact_model() {
        let active = Arc::new(MemoryCredentialStore::with_value(
            serde_json::to_vec(&PersistedActiveTuple::from_preset(
                implementation_attempt_preset(PROVIDER_TENCENT_TOKENHUB, TOKENHUB_GLM_5_1_MODEL)
                    .unwrap(),
            ))
            .unwrap(),
        ));
        let (service, _) = service_with(
            active,
            &[CanonicalAIProvider::TencentTokenhub],
            Arc::new(FakeEnvironmentSecretReader::absent()),
        );
        let status = service.status(None).unwrap();
        assert_eq!(status.active_provider, PROVIDER_TENCENT_TOKENHUB);
        assert_eq!(status.active_model, TOKENHUB_GLM_5_1_MODEL);
        assert!(status.has_explicit_active_tuple);
        let snapshot = service.resolve_snapshot(1).unwrap();
        assert_eq!(snapshot.provider(), PROVIDER_TENCENT_TOKENHUB);
        assert_eq!(snapshot.model(), TOKENHUB_GLM_5_1_MODEL);
    }

    #[test]
    fn persisted_pruned_tokenhub_tuple_fails_closed_without_fallback() {
        let active = Arc::new(MemoryCredentialStore::with_value(
            serde_json::to_vec(&PersistedActiveTuple::from_preset(
                implementation_attempt_preset(PROVIDER_TENCENT_TOKENHUB, TOKENHUB_HY3_MODEL)
                    .unwrap(),
            ))
            .unwrap(),
        ));
        let (service, _) = service_with(
            active,
            &[CanonicalAIProvider::TencentTokenhub],
            Arc::new(FakeEnvironmentSecretReader::absent()),
        );
        assert_eq!(
            error_code(&expect_error(service.status(None))),
            "invalid_provider_configuration"
        );
        assert_eq!(
            error_code(&expect_error(service.resolve_snapshot(1))),
            "invalid_provider_configuration"
        );
    }

    #[test]
    fn failed_active_tuple_verification_restores_the_previous_bytes() {
        let active = Arc::new(MemoryCredentialStore::absent());
        active
            .write(
                &serde_json::to_vec(&PersistedActiveTuple::from_preset(baseline_preset())).unwrap(),
            )
            .unwrap();
        let (service, _) = service_with(
            active.clone(),
            &[CanonicalAIProvider::Deepseek],
            Arc::new(FakeEnvironmentSecretReader::absent()),
        );
        active.fail_read_after_write.store(true, Ordering::SeqCst);
        assert_eq!(
            error_code(&expect_error(
                service.save_active_tuple(PROVIDER_OPENAI.into(), OPENAI_MODEL.into(),)
            )),
            "settings_persistence_failed"
        );
        active.fail_read_after_write.store(false, Ordering::SeqCst);
        active.read_unavailable.store(false, Ordering::SeqCst);
        let status = service.status(None).unwrap();
        assert_eq!(status.active_provider, PROVIDER_DEEPSEEK);
        assert!(status.has_explicit_active_tuple);
    }

    #[test]
    fn failed_active_tuple_clear_verification_restores_the_previous_bytes() {
        let active = Arc::new(MemoryCredentialStore::with_value(
            serde_json::to_vec(&PersistedActiveTuple::from_preset(
                provider_preset(PROVIDER_OPENAI).unwrap(),
            ))
            .unwrap(),
        ));
        let (service, _) = service_with(
            active.clone(),
            &[],
            Arc::new(FakeEnvironmentSecretReader::absent()),
        );
        active.fail_read_after_delete.store(true, Ordering::SeqCst);
        assert_eq!(
            error_code(&expect_error(service.clear_active_tuple())),
            "settings_persistence_failed"
        );
        active.fail_read_after_delete.store(false, Ordering::SeqCst);
        active.read_unavailable.store(false, Ordering::SeqCst);
        let status = service.status(None).unwrap();
        assert_eq!(status.active_provider, PROVIDER_OPENAI);
        assert!(status.has_explicit_active_tuple);
    }

    #[test]
    fn real_tauri_configuration_ipc_round_trip_returns_only_safe_status() {
        let active = Arc::new(MemoryCredentialStore::absent());
        let (service, handles) =
            service_with(active, &[], Arc::new(FakeEnvironmentSecretReader::absent()));
        let app = tauri::test::mock_builder()
            .manage(service)
            .invoke_handler(tauri::generate_handler![
                get_ai_provider_configuration_status,
                save_ai_provider_active_tuple,
                clear_ai_provider_active_tuple,
                set_ai_provider_api_key,
                clear_ai_provider_api_key
            ])
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("mock WebView");

        let initial = tauri::test::get_ipc_response(
            &window,
            configuration_ipc_request(
                "get_ai_provider_configuration_status",
                serde_json::json!({}),
            ),
        )
        .expect("initial status IPC response")
        .deserialize::<serde_json::Value>()
        .expect("initial status JSON");
        assert_eq!(initial["configurationRevision"], 1);
        assert_eq!(initial["effectiveConfigured"], false);
        assert_eq!(initial["activeProvider"], PROVIDER_DEEPSEEK);
        assert_eq!(initial["hasExplicitActiveTuple"], false);
        assert_eq!(initial["availablePresets"].as_array().unwrap().len(), 7);

        let selected = tauri::test::get_ipc_response(
            &window,
            configuration_ipc_request(
                "save_ai_provider_active_tuple",
                serde_json::json!({ "provider": PROVIDER_OPENAI, "model": OPENAI_MODEL }),
            ),
        )
        .expect("active tuple save IPC response")
        .deserialize::<serde_json::Value>()
        .expect("active tuple JSON");
        assert_eq!(selected["configurationRevision"], 2);
        assert_eq!(selected["activeProvider"], PROVIDER_OPENAI);
        assert_eq!(selected["effectiveConfigured"], false);

        let transient_test_value = format!("deterministic-{}-value", uuid::Uuid::new_v4());
        let saved = tauri::test::get_ipc_response(
            &window,
            configuration_ipc_request(
                "set_ai_provider_api_key",
                serde_json::json!({
                    "provider": PROVIDER_OPENAI,
                    "apiKey": transient_test_value.clone()
                }),
            ),
        )
        .expect("save IPC response")
        .deserialize::<serde_json::Value>()
        .expect("saved status JSON");
        assert_eq!(saved["configurationRevision"], 3);
        assert_eq!(saved["configuredSource"], "app_config");
        assert_eq!(saved["effectiveConfigured"], true);
        assert!(!serde_json::to_string(&saved)
            .unwrap()
            .contains(&transient_test_value));

        let reread = tauri::test::get_ipc_response(
            &window,
            configuration_ipc_request(
                "get_ai_provider_configuration_status",
                serde_json::json!({ "provider": PROVIDER_OPENAI }),
            ),
        )
        .expect("reread status IPC response")
        .deserialize::<serde_json::Value>()
        .expect("reread status JSON");
        assert_eq!(reread["configurationRevision"], 3);
        assert_eq!(reread["configuredSource"], "app_config");
        assert!(!serde_json::to_string(&reread)
            .unwrap()
            .contains(&transient_test_value));

        let cleared = tauri::test::get_ipc_response(
            &window,
            configuration_ipc_request(
                "clear_ai_provider_api_key",
                serde_json::json!({ "provider": PROVIDER_OPENAI }),
            ),
        )
        .expect("clear IPC response")
        .deserialize::<serde_json::Value>()
        .expect("cleared status JSON");
        assert_eq!(cleared["configurationRevision"], 4);
        assert_eq!(cleared["configuredSource"], "none");
        assert_eq!(cleared["effectiveConfigured"], false);
        assert!(matches!(
            handles[&CanonicalAIProvider::Openai].read(),
            AppSecretLookupOutcome::Absent
        ));

        let restored = tauri::test::get_ipc_response(
            &window,
            configuration_ipc_request("clear_ai_provider_active_tuple", serde_json::json!({})),
        )
        .expect("active tuple restore IPC response")
        .deserialize::<serde_json::Value>()
        .expect("restored status JSON");
        assert_eq!(restored["activeProvider"], PROVIDER_DEEPSEEK);
        assert_eq!(restored["hasExplicitActiveTuple"], false);
    }
}
