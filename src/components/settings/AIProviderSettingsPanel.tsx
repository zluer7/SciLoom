import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import {
  clearAIProviderApiKey,
  getAIProviderConfigurationStatus,
  saveAIProviderActiveTuple,
  setAIProviderApiKey
} from "../../services/aiProviderConfigurationClient";
import { projectAIErrorForDisplay } from "../../services/aiErrorService";
import type { AIProvider, AIProviderConfigurationStatus, AIProviderPreset } from "../../types";

type SafeFeedback = { kind: "success" | "error"; message: string };

export function AIProviderSettingsPanel() {
  const { language, t } = useI18n();
  const zh = language === "zh-CN";
  const [status, setStatus] = useState<AIProviderConfigurationStatus | null>(null);
  const [presets, setPresets] = useState<AIProviderPreset[]>([]);
  const [draftProvider, setDraftProvider] = useState<AIProvider | null>(null);
  const [draftModel, setDraftModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [feedback, setFeedback] = useState<SafeFeedback | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const mountedRef = useRef(true);
  const mutationInFlightRef = useRef(false);
  const statusReadSequenceRef = useRef(0);

  function projectStatus(nextStatus: AIProviderConfigurationStatus, preserveDraft = false) {
    setStatus(nextStatus);
    setPresets(nextStatus.availablePresets);
    if (!preserveDraft) {
      setDraftProvider(nextStatus.provider);
      setDraftModel(nextStatus.model);
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    setIsLoading(true);
    const readSequence = ++statusReadSequenceRef.current;
    getAIProviderConfigurationStatus()
      .then((nextStatus) => {
        if (mountedRef.current && readSequence === statusReadSequenceRef.current) {
          projectStatus(nextStatus);
        }
      })
      .catch(() => {
        if (mountedRef.current) {
          setFeedback({ kind: "error", message: t("aiProviderStatusLoadFailed") });
        }
      })
      .finally(() => {
        if (mountedRef.current) setIsLoading(false);
      });
    return () => {
      mountedRef.current = false;
      mutationInFlightRef.current = false;
      statusReadSequenceRef.current += 1;
      setApiKey("");
    };
  }, [t]);

  async function handleProviderChange(provider: AIProvider) {
    if (mutationInFlightRef.current) return;
    const preset = presets.find((candidate) => candidate.provider === provider);
    if (!preset) return;
    setDraftProvider(provider);
    setDraftModel(preset.model);
    setApiKey("");
    setFeedback(null);
    setIsLoading(true);
    const readSequence = ++statusReadSequenceRef.current;
    try {
      const nextStatus = await getAIProviderConfigurationStatus(provider);
      if (!mountedRef.current || readSequence !== statusReadSequenceRef.current) return;
      projectStatus(nextStatus, true);
    } catch {
      if (mountedRef.current && readSequence === statusReadSequenceRef.current) {
        setFeedback({ kind: "error", message: t("aiProviderStatusLoadFailed") });
      }
    } finally {
      if (mountedRef.current && readSequence === statusReadSequenceRef.current) {
        setIsLoading(false);
      }
    }
  }

  function handleModelChange(model: string) {
    if (mutationInFlightRef.current || !draftProvider) return;
    if (!presets.some((preset) => preset.provider === draftProvider && preset.model === model)) {
      return;
    }
    setDraftModel(model);
    setFeedback(null);
  }

  async function handleSave(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutationInFlightRef.current) return;
    if (!draftProvider || !draftModel) return;
    mutationInFlightRef.current = true;
    let submittedApiKey = apiKey;
    setApiKey("");
    setIsSaving(true);
    setFeedback(null);
    try {
      if (submittedApiKey.trim()) {
        await setAIProviderApiKey(draftProvider, submittedApiKey);
      }
      const nextStatus = await saveAIProviderActiveTuple(draftProvider, draftModel);
      if (!mountedRef.current) return;
      projectStatus(nextStatus);
      setFeedback({
        kind: "success",
        message: submittedApiKey.trim()
          ? (zh ? "API Key 已保存；当前状态：已配置。" : "API key saved; current status: Configured.")
          : (zh ? "已保存当前 Provider 与模型。" : "The active Provider and model were saved.")
      });
    } catch (error) {
      if (!mountedRef.current) return;
      setFeedback({ kind: "error", message: projectAIErrorForDisplay(error, language).message });
    } finally {
      submittedApiKey = "";
      mutationInFlightRef.current = false;
      if (mountedRef.current) setIsSaving(false);
    }
  }

  async function handleClear() {
    if (
      mutationInFlightRef.current ||
      !draftProvider ||
      !window.confirm(t("aiProviderClearConfirm"))
    ) {
      return;
    }
    mutationInFlightRef.current = true;
    setApiKey("");
    setIsClearing(true);
    setFeedback(null);
    try {
      const nextStatus = await clearAIProviderApiKey(draftProvider);
      if (!mountedRef.current) return;
      projectStatus(nextStatus, true);
      setFeedback({ kind: "success", message: t("aiProviderClearSucceeded") });
    } catch (error) {
      if (!mountedRef.current) return;
      setFeedback({ kind: "error", message: projectAIErrorForDisplay(error, language).message });
    } finally {
      mutationInFlightRef.current = false;
      if (mountedRef.current) setIsClearing(false);
    }
  }

  const isMutating = isSaving || isClearing;
  const providerPresets = presets.filter(
    (preset, index) => presets.findIndex((candidate) => candidate.provider === preset.provider) === index
  );
  const modelPresets = draftProvider
    ? presets.filter((preset) => preset.provider === draftProvider)
    : [];

  return (
    <div className="settings-panel ai-provider-settings">
      {draftProvider && draftModel && presets.length > 0 ? (
        <div className="ai-provider-settings__selectors">
          <label className="ai-provider-settings__selector">
            <span>{zh ? "服务提供方" : "Provider"}</span>
            <select
              aria-label={zh ? "服务提供方" : "Provider"}
              data-testid="ai-provider-selector"
              disabled={isMutating}
              onChange={(event) => {
                void handleProviderChange(event.target.value as AIProvider);
              }}
              value={draftProvider}
            >
              {providerPresets.map((preset) => (
                <option key={preset.provider} value={preset.provider}>{preset.displayName}</option>
              ))}
            </select>
          </label>
          <label className="ai-provider-settings__selector">
            <span>{zh ? "模型" : "Model"}</span>
            <select
              aria-label={zh ? "模型" : "Model"}
              data-testid="ai-model-selector"
              disabled={isMutating || modelPresets.length <= 1}
              onChange={(event) => {
                handleModelChange(event.target.value);
              }}
              value={draftModel}
            >
              {modelPresets.map((preset) => (
                <option key={`${preset.provider}:${preset.model}`} value={preset.model}>
                  {preset.model}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}
      <form autoComplete="off" className="ai-provider-settings__form" onSubmit={handleSave}>
        <label className="ai-provider-settings__key-label" htmlFor="ai-provider-api-key">
          API Key
        </label>
        <input
          autoComplete="new-password"
          disabled={isMutating}
          id="ai-provider-api-key"
          maxLength={2048}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={zh ? "输入 API Key" : "Enter API Key"}
          spellCheck={false}
          type="password"
          value={apiKey}
        />
        <div className="ai-provider-settings__actions">
          <button
            className="primary-button"
            disabled={isMutating || !draftProvider || !draftModel}
            type="submit"
          >
            {isSaving ? t("aiProviderSavingKey") : (zh ? "保存" : "Save")}
          </button>
          {status?.appOverrideConfigured === true ? (
            <button
              className="secondary-button"
              disabled={isMutating}
              onClick={() => { void handleClear(); }}
              type="button"
            >
              {isClearing ? t("aiProviderClearingOverride") : (zh ? "清除" : "Clear")}
            </button>
          ) : null}
        </div>
      </form>
      {feedback ? (
        <p
          className={`ai-provider-settings__feedback is-${feedback.kind}`}
          role={feedback.kind === "error" ? "alert" : "status"}
        >
          {feedback.message}
        </p>
      ) : null}

      {isLoading ? <p className="ai-provider-settings__notice">{t("aiProviderStatusLoading")}</p> : null}
      {status ? (
        <>
          <p className="ai-provider-settings__notice" data-provider-credential-status={status.effectiveConfigured === true ? "configured" : "unconfigured"}>
            {status.effectiveConfigured === true
              ? (zh ? "API Key：已配置" : "API Key: Configured")
              : (zh ? "API Key：未配置" : "API Key: Not configured")}
          </p>
          <details className="settings-technical-details">
            <summary>{zh ? "详细信息" : "Details"}</summary>
            <div className="settings-technical-details__body">
              <p className="ai-provider-settings__notice">
                {zh
                  ? `当前启用：${status.activeProvider} / ${status.activeModel}`
                  : `Active: ${status.activeProvider} / ${status.activeModel}`}
              </p>
              <p className="ai-provider-settings__notice">
                {zh
                  ? "AI 功能无法使用时，请检查所选 Provider 的 API Key 后重新保存"
                  : "If AI features are unavailable, check the selected Provider API Key and save it again"}
              </p>
            </div>
          </details>
        </>
      ) : null}

      <p className="settings-section-explanation">
        {zh
          ? "配置 AI 模型和 API Key，保存后将用于 SciLoom 的 AI 功能"
          : "Configure the AI model and API Key; saved settings are used by SciLoom AI features"}
      </p>
    </div>
  );
}
