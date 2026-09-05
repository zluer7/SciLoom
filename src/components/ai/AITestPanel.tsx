import { useState } from "react";
import type { AITextResponse } from "../../types";
import { runAIText } from "../../services/aiClient";
import { getAIProviderConfigurationStatus } from "../../services/aiProviderConfigurationClient";
import type { AIDisplayError } from "../../services/aiErrorService";
import { normalizeAIError } from "../../services/aiErrorService";
import { saveAIRun } from "../../services/aiRunService";
import { AIResultBox } from "./AIResultBox";

export function AITestPanel() {
  const [prompt, setPrompt] = useState("");
  const [result, setResult] = useState<AITextResponse | null>(null);
  const [error, setError] = useState<AIDisplayError | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  async function handleRun() {
    setIsRunning(true);
    setError(null);
    setResult(null);

    try {
      const configuration = await getAIProviderConfigurationStatus();
      if (configuration.eligibility !== "eligible") {
        throw new Error("AI provider configuration is not eligible.");
      }
      const response = await runAIText(prompt, configuration.configurationRevision);
      setResult(response);
      saveAIRun({
        provider: response.provider,
        model: response.model,
        prompt: prompt.trim(),
        outputText: response.text,
        status: "success",
        truncated: response.truncated
      });
    } catch (unknownError) {
      const displayError = normalizeAIError(unknownError);
      setError(displayError);
      saveAIRun({
        provider: "deepseek",
        model: "unknown",
        prompt: prompt.trim(),
        outputText: "",
        status: "failed",
        errorCode: displayError.code,
        errorMessage: displayError.message
      });
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <section className="ai-test-panel chart-panel" aria-label="AI 测试面板">
      <div className="ai-test-panel__header page-header">
        <h1>AI 测试面板</h1>
        <p>仅用于验证 DeepSeek 最小调用链路。AI 输出仅供参考，请用户自行判断。</p>
      </div>

      <label className="module-form">
        Prompt
        <textarea
          className="ai-test-panel__textarea"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="请输入要发送给 AI 的问题..."
          disabled={isRunning}
          rows={8}
        />
      </label>

      <div className="ai-test-panel__actions button-row">
        <button type="button" onClick={handleRun} disabled={isRunning}>
          {isRunning ? "调用中..." : "发送测试"}
        </button>
      </div>

      <AIResultBox result={result} error={error} isLoading={isRunning} />
    </section>
  );
}
