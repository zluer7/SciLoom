import { useState } from "react";
import type { AITextResponse } from "../../types";
import type { AIDisplayError } from "../../services/aiErrorService";

interface AIResultBoxProps {
  result: AITextResponse | null;
  error?: AIDisplayError | null;
  isLoading?: boolean;
}

function formatUsage(result: AITextResponse): string[] {
  const usage = result.usage;

  if (!usage) {
    return [];
  }

  return [
    usage.inputTokens !== undefined ? `输入 tokens：${usage.inputTokens}` : "",
    usage.outputTokens !== undefined ? `输出 tokens：${usage.outputTokens}` : "",
    usage.totalTokens !== undefined ? `总 tokens：${usage.totalTokens}` : ""
  ].filter(Boolean);
}

export function AIResultBox({ result, error, isLoading }: AIResultBoxProps) {
  const [copyMessage, setCopyMessage] = useState("");

  async function handleCopy() {
    if (!result?.text) {
      return;
    }

    try {
      await navigator.clipboard.writeText(result.text);
      setCopyMessage("已复制结果");
    } catch {
      setCopyMessage("复制失败");
    }
  }

  if (isLoading) {
    return (
      <section className="ai-result-box data-card" aria-live="polite">
        <h2>AI 返回结果</h2>
        <p>AI 调用中...</p>
      </section>
    );
  }

  if (error) {
    return (
      <section className="ai-result-box ai-result-box--error data-card" aria-live="polite">
        <h2>{error.title}</h2>
        <div className="ai-result-box__error-details">
          <p>原因：{error.message}</p>
          <p>建议：{error.suggestion}</p>
          {error.status ? <p>状态码：{error.status}</p> : null}
          <p>{error.retryable ? "可以稍后重试。" : "需要先修改配置或输入后再试。"}</p>
        </div>
      </section>
    );
  }

  if (!result) {
    return (
      <section className="ai-result-box data-card" aria-live="polite">
        <h2>AI 返回结果</h2>
        <p>暂无 AI 返回结果。</p>
      </section>
    );
  }

  const usageItems = formatUsage(result);

  return (
    <section className="ai-result-box data-card" aria-live="polite">
      <div className="ai-result-box__header card-heading">
        <div>
          <h2>AI 返回结果</h2>
          <p>AI 输出仅供参考，请用户自行判断。</p>
        </div>
        <button type="button" className="secondary-button" onClick={handleCopy}>
          复制结果
        </button>
      </div>

      <div className="ai-result-box__meta meta-row">
        <span>供应商：{result.provider}</span>
        <span>模型：{result.model}</span>
        {result.truncated ? <span>输出已截断</span> : null}
      </div>

      <pre className="ai-result-box__content literature-ai-summary">{result.text}</pre>

      {usageItems.length > 0 ? (
        <div className="ai-result-box__meta meta-row">
          {usageItems.map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
      ) : null}

      {copyMessage ? <p className="export-result">{copyMessage}</p> : null}
    </section>
  );
}
