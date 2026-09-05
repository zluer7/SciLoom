import type { AIErrorCode, AIErrorInfo } from "../types";

export interface AIDisplayError {
  code: AIErrorCode;
  title: string;
  message: string;
  suggestion: string;
  retryable: boolean;
  status?: number;
}

const ERROR_TEXT_MAX_CHARS = 300;

const AI_ERROR_CODES: AIErrorCode[] = [
  "invalid_prompt",
  "missing_api_key",
  "invalid_provider_configuration",
  "secure_store_unavailable",
  "settings_persistence_failed",
  "configuration_changed",
  "network_error",
  "timeout",
  "auth_error",
  "quota_error",
  "rate_limited",
  "invalid_request",
  "provider_error",
  "invalid_response",
  "empty_choices",
  "empty_content",
  "transport_error",
  "stream_protocol_error",
  "stream_ended_early",
  "technical_capacity_or_safety_error",
  "duplicate_request",
  "material_not_authorized",
  "material_attempt_not_active",
  "material_attempt_already_owned_or_replayed",
  "material_unavailable",
  "material_type_unsupported",
  "material_too_large",
  "material_encoding_unsupported",
  "material_read_failed",
  "material_source_changed_since_review",
  "material_budget_exceeded",
  "material_prompt_assembly_failed",
  "retry_regenerate_not_latest",
  "retry_regenerate_not_eligible",
  "retry_regenerate_active_conflict",
  "retry_regenerate_attachment_reauthorization_required",
  "retry_regenerate_prepare_failed",
  "attempt_identity_conflict",
  "retry_regenerate_projection_integrity_error",
  "call_attempt_execution_orphaned",
  "ai_durable_settlement_validation_failed",
  "cancelled",
  "unknown_error"
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAIErrorCode(value: unknown): value is AIErrorCode {
  return AI_ERROR_CODES.includes(value as AIErrorCode);
}

function hasSensitiveErrorText(value: string): boolean {
  return /api[_ -]?key\s*[=:]|authorization|bearer\s+|headers?|raw[_ -]?(request|response)|stack|backtrace|[a-z]:\\|\/users\/|database dump|localstorage dump/i.test(
    value
  );
}

export function truncateErrorMessage(value: string, maxChars = ERROR_TEXT_MAX_CHARS): string {
  return Array.from(value).slice(0, maxChars).join("");
}

function safeText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmedValue = value.trim();
  if (!trimmedValue || hasSensitiveErrorText(trimmedValue)) {
    return undefined;
  }

  return truncateErrorMessage(trimmedValue);
}

function safeStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isAIDisplayError(error: unknown): error is AIDisplayError {
  if (!isRecord(error)) {
    return false;
  }

  return (
    isAIErrorCode(error.code) &&
    typeof error.title === "string" &&
    typeof error.message === "string" &&
    typeof error.suggestion === "string" &&
    typeof error.retryable === "boolean"
  );
}

export function parseAIErrorPayload(error: unknown): Partial<AIErrorInfo> | null {
  if (!error) {
    return null;
  }

  if (isAIDisplayError(error)) {
    return {
      code: error.code,
      message: safeText(error.message),
      status: error.status,
      retryable: error.retryable
    };
  }

  if (isRecord(error)) {
    const code = isAIErrorCode(error.code) ? error.code : undefined;
    const message = safeText(error.message);

    if (code || message) {
      return {
        code,
        message,
        status: safeStatus(error.status),
        retryable: typeof error.retryable === "boolean" ? error.retryable : undefined
      };
    }
  }

  if (typeof error === "string") {
    try {
      const parsed = JSON.parse(error);
      if (isRecord(parsed)) {
        const code = isAIErrorCode(parsed.code) ? parsed.code : undefined;
        const message = safeText(parsed.message);

        if (code || message) {
          return {
            code,
            message,
            status: safeStatus(parsed.status),
            retryable: typeof parsed.retryable === "boolean" ? parsed.retryable : undefined
          };
        }
      }
    } catch {
      return {
        code: "unknown_error",
        message: safeText(error)
      };
    }

    return {
      code: "unknown_error",
      message: safeText(error)
    };
  }

  if (error instanceof Error) {
    return {
      code: "unknown_error",
      message: safeText(error.message)
    };
  }

  return null;
}

function getDisplayTemplate(code: AIErrorCode): AIDisplayError {
  switch (code) {
    case "invalid_prompt":
      return {
        code,
        title: "输入内容无效",
        message: "请输入要发送给 AI 的问题，或缩短过长的输入。",
        suggestion: "检查输入框内容，确保不为空且不超过 45000 个字符。",
        retryable: false
      };
    case "missing_api_key":
      return {
        code,
        title: "未配置 DeepSeek API Key",
        message: "当前没有可用的 DeepSeek API Key，Provider 调用尚未开始。",
        suggestion: "请打开设置中的 AI Provider 区域并显式保存应用凭据；环境变量仅作为兼容回退。",
        retryable: false
      };
    case "network_error":
      return {
        code,
        title: "网络连接失败",
        message: "无法连接 DeepSeek 服务。",
        suggestion: "请检查网络连接、代理设置或防火墙限制后重试。",
        retryable: true
      };
    case "timeout":
      return {
        code,
        title: "请求超时",
        message: "AI 请求超过等待时间。",
        suggestion: "请稍后重试，或缩短 prompt 内容。",
        retryable: true
      };
    case "auth_error":
      return {
        code,
        title: "DeepSeek 认证失败",
        message: "DeepSeek API Key 可能无效、已过期或没有访问权限。",
        suggestion: "请检查 DeepSeek API Key 是否正确，并确认账号权限可用。",
        retryable: false
      };
    case "quota_error":
      return {
        code,
        title: "DeepSeek 额度不足",
        message: "当前 DeepSeek 账号可能余额不足或配额不可用。",
        suggestion: "请检查 DeepSeek 控制台的余额、配额或计费状态。",
        retryable: false
      };
    case "rate_limited":
      return {
        code,
        title: "请求过于频繁",
        message: "DeepSeek 当前限制了请求频率。",
        suggestion: "请稍后再试，或降低测试请求频率。",
        retryable: true
      };
    case "invalid_request":
      return {
        code,
        title: "请求参数异常",
        message: "DeepSeek 返回请求参数错误。",
        suggestion: "请检查模型 ID、thinking 参数或请求格式；如问题持续，请复核 DeepSeek 官方文档。",
        retryable: false
      };
    case "provider_error":
      return {
        code,
        title: "DeepSeek 服务异常",
        message: "DeepSeek 服务端返回异常。",
        suggestion: "请稍后重试；如持续失败，请检查 DeepSeek 服务状态或模型可用性。",
        retryable: true
      };
    case "invalid_response":
      return {
        code,
        title: "模型响应格式异常",
        message: "返回内容无法被 SciLoom 正确解析。",
        suggestion: "请稍后重试；如持续出现，需要检查 DeepSeek 响应格式是否发生变化。",
        retryable: true
      };
    case "empty_choices":
      return {
        code,
        title: "模型未返回候选结果",
        message: "DeepSeek 返回了空的 choices。",
        suggestion: "请稍后重试，或调整输入内容。",
        retryable: true
      };
    case "empty_content":
      return {
        code,
        title: "模型返回内容为空",
        message: "DeepSeek 返回了响应，但没有可展示文本。",
        suggestion: "请重新输入更明确的问题后再试。",
        retryable: true
      };
    case "transport_error":
      return {
        code,
        title: "流式连接中断",
        message: "AI 流式连接在终态确认前中断。",
        suggestion: "请稍后重试；本次部分文本不会保存为正式回答。",
        retryable: true
      };
    case "stream_protocol_error":
      return {
        code,
        title: "流式事件顺序异常",
        message: "AI 流式事件未通过身份或顺序校验。",
        suggestion: "请重试；如持续出现，需要检查 Tauri 流式协议。",
        retryable: true
      };
    case "stream_ended_early":
      return {
        code,
        title: "模型响应提前结束",
        message: "DeepSeek 流在完整终态标记前结束。",
        suggestion: "请稍后重试；本次部分文本不会保存为正式回答。",
        retryable: true
      };
    case "call_attempt_execution_orphaned":
      return {
        code,
        title: "AI 执行已中断",
        message: "先前运行环境在该调用写入可靠终态前结束，Provider 最终结果无法确认。",
        suggestion: "如仍需分析，请由用户显式发起一次新的运行；系统不会自动重放旧调用。",
        retryable: true
      };
    case "duplicate_request":
      return {
        code,
        title: "重复的 AI 请求",
        message: "同一个 durable 调用身份不能再次启动。",
        suggestion: "请等待当前调用结束，或创建新的请求。",
        retryable: false
      };
    case "technical_capacity_or_safety_error":
      return {
        code,
        title: "请求超过适用安全预算",
        message: "请求超过前后端共享的适用安全预算；Parse Draft 的 45,000 字符预算仅统计软件动态上下文，SciLoom 未静默删除用户输入、授权材料、固定规则或科研上下文。",
        suggestion: "Parse Draft 请缩小自动携带的 Context、会话历史或动态对象索引；其它调用请缩小当前输入范围后重新 Review。系统不会自动换模型、重试或产生正式写入。",
        retryable: false
      };
    case "material_not_authorized":
    case "material_attempt_not_active":
    case "material_attempt_already_owned_or_replayed":
    case "material_unavailable":
    case "material_type_unsupported":
    case "material_too_large":
    case "material_encoding_unsupported":
    case "material_read_failed":
    case "material_budget_exceeded":
      return {
        code,
        title: "授权材料未能安全读取",
        message: "所选材料未通过本次调用的后端读取与预算校验，Provider 尚未启动。",
        suggestion: "请刷新附件列表，确认文件仍可用、格式为 UTF-8 .txt/.md 且满足大小限制后重新发送。",
        retryable: code !== "material_attempt_already_owned_or_replayed"
      };
    case "material_prompt_assembly_failed":
      return {
        code,
        title: "AI 请求装配未通过",
        message: "本次调用的后端 Prompt 或 typed contract 装配校验未通过，Provider 尚未启动。",
        suggestion: "请刷新后重试；如问题持续，请检查当前前后端 Prompt/contract 版本是否一致。",
        retryable: true
      };
    case "material_source_changed_since_review":
      return {
        code,
        title: "材料 Review 已失效",
        message: "所选材料在 Review 后发生变化，本次调用已在 Provider 启动前停止。",
        suggestion: "请重新构建并 Review 当前材料范围，再显式确认发送。旧 receipt 与旧授权不会复用。",
        retryable: false
      };
    case "retry_regenerate_attachment_reauthorization_required":
      return {
        code,
        title: "附件需要重新授权",
        message: "该请求使用过本地材料。附件授权仅对原调用有效；请重新选择材料并重新发送。",
        suggestion: "重新选择需要的 FileRef，检查当前问题后以普通 Send 创建一次新的显式授权调用。",
        retryable: false
      };
    case "retry_regenerate_not_latest":
    case "retry_regenerate_not_eligible":
    case "retry_regenerate_active_conflict":
    case "retry_regenerate_prepare_failed":
    case "attempt_identity_conflict":
    case "retry_regenerate_projection_integrity_error":
      return {
        code,
        title: "Retry / Regenerate 已安全阻止",
        message: "当前对话状态或调用身份已变化，本次操作未启动 Provider。",
        suggestion: "刷新当前对话并仅从最新可用的失败或有效回答操作。",
        retryable: false
      };
    case "invalid_provider_configuration":
      return {
        code,
        title: "AI Provider 配置无效",
        message: "本地 AI Provider 配置未通过安全形态校验。",
        suggestion: "请打开设置并重新保存有效的 API Key。",
        retryable: false
      };
    case "secure_store_unavailable":
      return {
        code,
        title: "安全凭据存储不可用",
        message: "操作系统凭据存储当前不可用；为避免错误回退，本次不会调用 Provider。",
        suggestion: "请检查当前 Windows 登录会话后重试。",
        retryable: true
      };
    case "settings_persistence_failed":
      return {
        code,
        title: "AI 设置保存失败",
        message: "API Key 变更未能通过操作系统凭据存储的权威回读。",
        suggestion: "本次未报告成功；请检查系统凭据存储后重新提交。",
        retryable: true
      };
    case "configuration_changed":
      return {
        code,
        title: "AI 配置已变化",
        message: "AI 配置在 durable pre-gate 与网络启动之间发生变化，本次调用已在联网前终止。",
        suggestion: "请使用最新配置重新发送。",
        retryable: true
      };
    case "cancelled":
      return {
        code,
        title: "已停止生成",
        message: "本次 AI 生成已由用户停止。",
        suggestion: "部分文本未写入 durable 对话；可以修改问题后重新发送。",
        retryable: true
      };
    case "ai_durable_settlement_validation_failed":
      return {
        code,
        title: "AI durable 结果提交失败",
        message: "Provider 已返回，但结果未通过本地 durable settlement；系统已安全回滚并记录可诊断原因。",
        suggestion: "无需自动重试；请依据当前记录的 settlement stage、class 和 cause 定位本地数据链。",
        retryable: false
      };
    case "unknown_error":
    default:
      return {
        code: "unknown_error",
        title: "AI 调用失败",
        message: "发生未知错误。",
        suggestion: "请稍后重试；如问题持续，请检查 API Key、网络和控制台日志。",
        retryable: true
      };
  }
}

export function normalizeAIError(error: unknown): AIDisplayError {
  const parsed = parseAIErrorPayload(error);
  const code = isAIErrorCode(parsed?.code) ? parsed.code : "unknown_error";
  const template = getDisplayTemplate(code);
  const message =
    code === "unknown_error" && parsed?.message
      ? truncateErrorMessage(parsed.message)
      : template.message;

  return {
    ...template,
    message,
    suggestion: truncateErrorMessage(template.suggestion),
    retryable:
      typeof parsed?.retryable === "boolean" ? parsed.retryable : template.retryable,
    status: parsed?.status
  };
}

/**
 * UI-only projection. normalizeAIError also supplies durable call-attempt
 * diagnostics, so its code/message/status/retry contract must remain unchanged.
 * Neither the active provider selection nor arbitrary diagnostic text is an
 * authoritative source for ordinary user copy.
 */
export function projectAIErrorForDisplay(
  error: unknown,
  language: "zh-CN" | "en-US" = "zh-CN"
): Pick<AIDisplayError, "code" | "title" | "message"> {
  const normalized = normalizeAIError(error);
  const copy = (title: string, message: string, enTitle: string, enMessage: string) => ({
    code: normalized.code,
    title: language === "en-US" ? enTitle : title,
    message: language === "en-US" ? enMessage : message
  });
  // This existing application error is outside the provider error-code union.
  // Its phase is structured evidence; its message/cause are diagnostics only.
  if (isRecord(error) && error.code === "ai_durable_persistence_failed") {
    return error.phase === "pre_provider"
      ? copy("AI 请求未发送", "暂时无法开始本次请求，请稍后重试。",
        "AI request not sent", "The request could not be started. Please try again later.")
      : copy("AI 结果无法确认", "本次结果状态无法确认。请重新打开当前对话核对结果，不要直接重复执行。",
        "AI result unconfirmed", "The result could not be confirmed. Reopen the conversation and check it before repeating any operation.");
  }
  switch (normalized.code) {
    case "missing_api_key":
      return copy("AI 服务尚未配置", "请在设置中为所选 AI 服务保存 API Key。",
        "AI service not configured", "Save an API key for the selected AI service in Settings.");
    case "invalid_provider_configuration":
      return copy("AI 服务配置不可用", "请在设置中检查所选服务、模型和 API Key。",
        "AI configuration unavailable", "Check the selected service, model and API key in Settings.");
    case "auth_error":
      return copy("AI 服务访问未获授权", "请检查 API Key 是否有效，以及当前账号是否有访问权限。",
        "AI service access denied", "Check whether the API key is valid and the account has access.");
    case "quota_error":
      return copy("AI 服务额度不可用", "请检查当前 AI 服务账号的额度或计费状态。",
        "AI service quota unavailable", "Check the quota or billing status of your AI service account.");
    case "rate_limited":
      return copy("AI 请求过于频繁", "AI 服务暂时限制了请求频率，请稍后再试。",
        "AI request rate limited", "The AI service is limiting request frequency. Please try again later.");
    case "network_error":
    case "transport_error":
      return copy("AI 连接未完成", "本次 AI 请求未完成。请检查网络连接后稍后重试。",
        "AI connection incomplete", "The AI request did not complete. Check your connection and try again later.");
    case "timeout":
    case "provider_error":
      return copy("AI 服务暂时不可用", "本次 AI 请求未完成，请稍后重试。",
        "AI service temporarily unavailable", "The AI request did not complete. Please try again later.");
    case "invalid_request":
    case "invalid_response":
    case "stream_protocol_error":
    case "material_prompt_assembly_failed":
      return copy("AI 请求无法正常处理", "本次请求或返回结果未能正常处理，未获得可用结果。",
        "AI request could not be processed", "The request or response could not be processed and no usable result was obtained.");
    case "empty_choices":
    case "empty_content":
    case "stream_ended_early":
      return copy("未获得可用的 AI 结果", "本次未获得完整可用的结果，请稍后重试。",
        "No usable AI result", "No complete, usable result was received. Please try again later.");
    case "secure_store_unavailable":
      return copy("AI 凭据暂时不可用", "暂时无法安全读取或更改 AI 凭据。请稍后重新打开设置检查当前状态。",
        "AI credentials temporarily unavailable", "AI credentials could not be accessed safely. Reopen Settings later to check their current status.");
    case "settings_persistence_failed":
      return copy("AI 设置更改未确认", "无法确认本次设置更改的结果。请重新打开设置检查当前状态，再决定是否操作。",
        "AI settings change unconfirmed", "The settings change could not be confirmed. Reopen Settings and check the current status before making another change.");
    case "configuration_changed":
      return copy("AI 配置已变化", "本次请求尚未发送，请确认当前配置后重新发送。",
        "AI configuration changed", "The request was not sent. Review the current configuration before sending again.");
    case "technical_capacity_or_safety_error":
      return copy("本次 AI 请求未开始", "当前处理范围超过可用限制。请缩小所选上下文范围，重新审阅后再发送。",
        "AI request not started", "The selected scope exceeds the available limit. Reduce the selected context, review it, then send again.");
    case "duplicate_request":
      return copy("本次 AI 请求未开始", "请先查看已有请求的记录，确认当前状态后再操作。",
        "AI request not started", "Check the existing request's records and current state before another operation.");
    case "retry_regenerate_not_latest":
    case "retry_regenerate_not_eligible":
    case "retry_regenerate_active_conflict":
    case "retry_regenerate_prepare_failed":
    case "attempt_identity_conflict":
    case "retry_regenerate_projection_integrity_error":
      return copy("当前对话状态已变化", "本次请求未开始。请重新打开当前对话，核对最新记录及可用操作。",
        "Conversation state changed", "The request was not started. Reopen the conversation and review its latest records and available actions.");
    case "call_attempt_execution_orphaned":
    case "ai_durable_settlement_validation_failed":
      return copy("AI 结果无法确认", "本次结果状态无法确认。请重新打开当前对话核对结果，不要直接重复执行。",
        "AI result unconfirmed", "The result could not be confirmed. Reopen the conversation and check it before repeating any operation.");
    case "cancelled":
      return copy("已停止生成", "本次 AI 生成已停止。",
        "Generation stopped", "This AI generation was stopped.");
    case "invalid_prompt":
    case "material_not_authorized":
    case "material_attempt_not_active":
    case "material_attempt_already_owned_or_replayed":
    case "material_unavailable":
    case "material_type_unsupported":
    case "material_too_large":
    case "material_encoding_unsupported":
    case "material_read_failed":
    case "material_source_changed_since_review":
    case "material_budget_exceeded":
    case "retry_regenerate_attachment_reauthorization_required":
      // F18 authorization/input gates are not a C7 copy/workflow change.
      return { code: normalized.code, title: normalized.title, message: normalized.message };
    default:
      return copy("AI 操作未完成", "本次操作未完成，无法确认结果。请先检查当前状态。",
        "AI operation incomplete", "The operation did not complete and its result could not be confirmed. Check the current state first.");
  }
}

export function toAIErrorMessage(error: unknown): string {
  return normalizeAIError(error).message;
}

export function toAIErrorCode(error: unknown): AIErrorCode {
  return normalizeAIError(error).code;
}
