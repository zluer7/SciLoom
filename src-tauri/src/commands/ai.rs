use super::ai_provider_configuration::{
    ProviderConfigurationService, ProviderPreset, ProviderThinkingField,
};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::State;

const PROMPT_MAX_CHARS: usize = 45_000;
pub(crate) const OUTPUT_MAX_CHARS: usize = 12000;
const ERROR_SUMMARY_MAX_CHARS: usize = 300;
pub(crate) const RESPONSE_MAX_BYTES: usize = 1_000_000;
const REQUEST_TIMEOUT_SECS: u64 = 30;
const CONNECT_TIMEOUT_SECS: u64 = 10;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AITextResponse {
    pub text: String,
    pub provider: String,
    pub model: String,
    pub truncated: Option<bool>,
    pub usage: Option<AIUsage>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AIUsage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
}

#[derive(Debug, Serialize)]
struct ChatCompletionsRequest {
    model: String,
    messages: Vec<ChatMessage>,
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    stream_options: Option<ChatStreamOptions>,
    #[serde(skip_serializing_if = "Option::is_none")]
    response_format: Option<ChatResponseFormat>,
    #[serde(skip_serializing_if = "Option::is_none")]
    thinking: Option<ChatThinking>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ChatResponseFormat {
    #[serde(rename = "type")]
    kind: ChatResponseFormatType,
}

impl ChatResponseFormat {
    pub(crate) fn json_object() -> Self {
        Self {
            kind: ChatResponseFormatType::JsonObject,
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum ChatResponseFormatType {
    JsonObject,
}

#[derive(Debug, Serialize)]
struct ChatStreamOptions {
    include_usage: bool,
}

#[derive(Debug, Serialize)]
struct ChatThinking {
    #[serde(rename = "type")]
    kind: String,
}

#[derive(Debug, Serialize)]
struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Debug, Deserialize)]
struct ChatCompletionsResponse {
    choices: Vec<ChatChoice>,
    usage: Option<ChatUsage>,
}

#[derive(Debug, Deserialize)]
struct ChatChoice {
    message: Option<ChatAssistantMessage>,
}

#[derive(Debug, Deserialize)]
struct ChatAssistantMessage {
    content: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ChatUsage {
    prompt_tokens: Option<u64>,
    completion_tokens: Option<u64>,
    total_tokens: Option<u64>,
}

fn truncate_to_chars(value: &str, max_chars: usize) -> (String, bool) {
    if value.chars().count() <= max_chars {
        return (value.to_string(), false);
    }

    (value.chars().take(max_chars).collect(), true)
}

pub(crate) fn ai_error_json(
    code: &str,
    message: &str,
    retryable: bool,
    status: Option<u16>,
) -> String {
    let (safe_message, _) = truncate_to_chars(message, ERROR_SUMMARY_MAX_CHARS);
    let mut error = serde_json::json!({
        "code": code,
        "message": safe_message,
        "retryable": retryable
    });

    if let Some(status) = status {
        error["status"] = serde_json::json!(status);
    }

    error.to_string()
}

fn validate_prompt_structure(prompt: &str) -> Result<String, String> {
    let trimmed_prompt = prompt.trim();

    if trimmed_prompt.is_empty() {
        return Err(ai_error_json(
            "invalid_prompt",
            "请输入要发送给 AI 的问题。",
            false,
            None,
        ));
    }

    Ok(trimmed_prompt.to_string())
}

pub(crate) fn validate_parse_provider_prompt(prompt: &str) -> Result<String, String> {
    validate_prompt_structure(prompt)
}

pub(crate) fn validate_prompt(prompt: &str) -> Result<String, String> {
    let trimmed_prompt = validate_prompt_structure(prompt)?;

    if trimmed_prompt.chars().count() > PROMPT_MAX_CHARS {
        return Err(ai_error_json(
            "invalid_prompt",
            &format!("输入内容过长，请控制在 {PROMPT_MAX_CHARS} 个字符以内。"),
            false,
            None,
        ));
    }

    Ok(trimmed_prompt)
}

fn provider_thinking_field(preset: ProviderPreset) -> Option<ChatThinking> {
    match preset.thinking_field() {
        ProviderThinkingField::TypeDisabled => Some(ChatThinking {
            kind: "disabled".to_string(),
        }),
        ProviderThinkingField::Omit => None,
    }
}

fn build_chat_request(prompt: &str, preset: ProviderPreset) -> ChatCompletionsRequest {
    ChatCompletionsRequest {
        model: preset.model().to_string(),
        messages: vec![ChatMessage {
            role: "user".to_string(),
            content: prompt.to_string(),
        }],
        stream: false,
        stream_options: None,
        response_format: None,
        thinking: provider_thinking_field(preset),
    }
}

pub(crate) fn build_stream_chat_request(
    prompt: &str,
    preset: ProviderPreset,
    response_format: Option<ChatResponseFormat>,
) -> serde_json::Value {
    serde_json::to_value(ChatCompletionsRequest {
        model: preset.model().to_string(),
        messages: vec![ChatMessage {
            role: "user".to_string(),
            content: prompt.to_string(),
        }],
        stream: true,
        stream_options: Some(ChatStreamOptions {
            include_usage: true,
        }),
        response_format,
        thinking: provider_thinking_field(preset),
    })
    .expect("canonical provider stream request must remain serializable")
}

const PROVIDER_ERROR_BODY_MAX_BYTES: usize = 16 * 1024;

#[cfg(test)]
fn http_status_error(provider_display_name: &str, status: u16) -> String {
    http_status_error_with_body(provider_display_name, status, &[])
}

pub(crate) async fn read_bounded_provider_error_body(mut response: reqwest::Response) -> Vec<u8> {
    let mut body = Vec::new();
    while body.len() < PROVIDER_ERROR_BODY_MAX_BYTES {
        let chunk = match response.chunk().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) | Err(_) => break,
        };
        let remaining = PROVIDER_ERROR_BODY_MAX_BYTES - body.len();
        body.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
    }
    body
}

fn safe_provider_error_token(value: Option<&serde_json::Value>) -> Option<String> {
    let token = match value? {
        serde_json::Value::String(value) => value.trim().to_string(),
        serde_json::Value::Number(value) => value.to_string(),
        _ => return None,
    };
    if token.is_empty()
        || token.len() > 80
        || !token
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._-[]".contains(character))
    {
        return None;
    }
    Some(token)
}

fn provider_error_diagnostic(body: &[u8]) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(body).ok()?;
    let error = value.get("error")?.as_object()?;
    let mut parts = Vec::new();
    if let Some(code) = safe_provider_error_token(error.get("code")) {
        parts.push(format!("code={code}"));
    }
    if let Some(parameter) = safe_provider_error_token(error.get("param")) {
        parts.push(format!("param={parameter}"));
    }
    (!parts.is_empty()).then(|| format!("（Provider {}）", parts.join(", ")))
}

pub(crate) fn http_status_error_with_body(
    provider_display_name: &str,
    status: u16,
    body: &[u8],
) -> String {
    let diagnostic = provider_error_diagnostic(body).unwrap_or_default();
    match status {
        400 | 422 => ai_error_json(
            "invalid_request",
            &format!("AI 请求参数无效。{diagnostic}"),
            false,
            Some(status),
        ),
        401 | 403 => ai_error_json(
            "auth_error",
            &format!("{provider_display_name} 认证或权限校验失败。{diagnostic}"),
            false,
            Some(status),
        ),
        402 => ai_error_json(
            "quota_error",
            &format!("{provider_display_name} 账户余额或额度不足。{diagnostic}"),
            false,
            Some(status),
        ),
        429 => ai_error_json(
            "rate_limited",
            "AI 请求过于频繁，请稍后重试。",
            true,
            Some(status),
        ),
        500..=599 => ai_error_json(
            "provider_error",
            &format!("{provider_display_name} 服务暂时不可用，请稍后重试。{diagnostic}"),
            true,
            Some(status),
        ),
        _ => ai_error_json(
            "provider_error",
            &format!("{provider_display_name} 返回了异常状态。{diagnostic}"),
            false,
            Some(status),
        ),
    }
}

pub(crate) fn request_error(provider_display_name: &str, error: &reqwest::Error) -> String {
    if error.is_timeout() {
        return ai_error_json("timeout", "AI 请求超时，请稍后重试。", true, None);
    }

    ai_error_json(
        "network_error",
        &format!("无法连接 {provider_display_name}，请检查网络后重试。"),
        true,
        None,
    )
}

pub(crate) fn build_ai_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .connect_timeout(Duration::from_secs(CONNECT_TIMEOUT_SECS))
        .build()
        .map_err(|_| ai_error_json("unknown_error", "AI 请求初始化失败。", false, None))
}

fn parse_chat_completions_response(
    body: &[u8],
    actual_provider: &str,
    actual_model: &str,
    provider_display_name: &str,
) -> Result<AITextResponse, String> {
    let response: ChatCompletionsResponse = serde_json::from_slice(body).map_err(|_| {
        ai_error_json(
            "invalid_response",
            &format!("{provider_display_name} 返回了无法解析的响应。"),
            false,
            None,
        )
    })?;

    let choice = response.choices.first().ok_or_else(|| {
        ai_error_json(
            "empty_choices",
            &format!("{provider_display_name} 未返回可用结果。"),
            false,
            None,
        )
    })?;
    let message = choice.message.as_ref().ok_or_else(|| {
        ai_error_json(
            "invalid_response",
            &format!("{provider_display_name} 响应缺少消息内容。"),
            false,
            None,
        )
    })?;
    let content = message.content.as_ref().ok_or_else(|| {
        ai_error_json(
            "empty_content",
            &format!("{provider_display_name} 返回了空内容。"),
            false,
            None,
        )
    })?;

    if content.trim().is_empty() {
        return Err(ai_error_json(
            "empty_content",
            &format!("{provider_display_name} 返回了空内容。"),
            false,
            None,
        ));
    }

    let (text, truncated) = truncate_to_chars(content, OUTPUT_MAX_CHARS);
    let usage = response.usage.map(|usage| AIUsage {
        input_tokens: usage.prompt_tokens,
        output_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens,
    });

    Ok(AITextResponse {
        text,
        provider: actual_provider.to_string(),
        model: actual_model.to_string(),
        truncated: truncated.then_some(true),
        usage,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub async fn run_ai_text(
    provider_configuration: State<'_, ProviderConfigurationService>,
    prompt: String,
    expected_configuration_revision: u64,
) -> Result<AITextResponse, String> {
    let prompt = validate_prompt(&prompt)?;
    let client = build_ai_http_client()?;
    let snapshot = provider_configuration.resolve_snapshot(expected_configuration_revision)?;
    let _selected_secret_source = snapshot.source();
    let preset = snapshot.preset();
    let response = client
        .post(preset.endpoint())
        .bearer_auth(snapshot.secret())
        .json(&build_chat_request(&prompt, preset))
        .send()
        .await
        .map_err(|error| request_error(preset.display_name(), &error))?;
    let status = response.status();

    if !status.is_success() {
        let body = read_bounded_provider_error_body(response).await;
        return Err(http_status_error_with_body(
            preset.display_name(),
            status.as_u16(),
            &body,
        ));
    }

    if response
        .content_length()
        .is_some_and(|length| length > RESPONSE_MAX_BYTES as u64)
    {
        return Err(ai_error_json(
            "invalid_response",
            &format!("{} 响应超过允许大小。", preset.display_name()),
            false,
            None,
        ));
    }

    let body = response
        .bytes()
        .await
        .map_err(|error| request_error(preset.display_name(), &error))?;
    if body.len() > RESPONSE_MAX_BYTES {
        return Err(ai_error_json(
            "invalid_response",
            &format!("{} 响应超过允许大小。", preset.display_name()),
            false,
            None,
        ));
    }

    parse_chat_completions_response(
        &body,
        snapshot.provider(),
        snapshot.model(),
        preset.display_name(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::ai_provider_configuration::{
        implementation_attempt_preset, provider_preset, DEFAULT_DEEPSEEK_MODEL, KIMI_MODEL,
        OPENAI_MODEL, PROVIDER_DEEPSEEK, PROVIDER_KIMI, PROVIDER_OPENAI,
        PROVIDER_TENCENT_TOKENHUB, TOKENHUB_DEEPSEEK_V4_FLASH_MODEL,
        TOKENHUB_GLM_5_1_MODEL, TOKENHUB_GLM_5_3_FLASH_MODEL, TOKENHUB_HY3_MODEL,
        TOKENHUB_KIMI_K3_MODEL, TOKENHUB_MINIMAX_M3_MODEL, TOKENHUB_MIMO_V2_5_PRO_MODEL,
    };

    fn error_code(error: &str) -> String {
        serde_json::from_str::<serde_json::Value>(error).unwrap()["code"]
            .as_str()
            .unwrap()
            .to_string()
    }

    fn parse(body: &[u8]) -> Result<AITextResponse, String> {
        parse_chat_completions_response(body, PROVIDER_DEEPSEEK, DEFAULT_DEEPSEEK_MODEL, "DeepSeek")
    }

    #[test]
    fn validate_prompt_trims_valid_input() {
        assert_eq!(validate_prompt("  hello  ").unwrap(), "hello");
    }

    #[test]
    fn validate_prompt_rejects_empty_and_over_limit_input() {
        assert_eq!(
            error_code(&validate_prompt("   ").unwrap_err()),
            "invalid_prompt"
        );
        assert_eq!(
            error_code(&validate_prompt(&"😀".repeat(45_001)).unwrap_err()),
            "invalid_prompt"
        );
        assert!(validate_prompt(&"😀".repeat(45_000)).is_ok());
    }

    #[test]
    fn lp15_a3_r1_parse_provider_validation_uses_envelope_dynamic_budget_admission() {
        let admitted_parse_prompt = "P".repeat(PROMPT_MAX_CHARS + 1);
        assert!(validate_prompt(&admitted_parse_prompt).is_err());
        assert!(validate_parse_provider_prompt(&admitted_parse_prompt).is_ok());
        assert_eq!(
            error_code(&validate_parse_provider_prompt("   ").unwrap_err()),
            "invalid_prompt"
        );
    }

    #[test]
    fn truncate_to_chars_preserves_unicode_boundaries() {
        assert_eq!(truncate_to_chars("a😀b", 2), ("a😀".to_string(), true));
        assert_eq!(truncate_to_chars("a😀", 2), ("a😀".to_string(), false));
    }

    #[test]
    fn ai_error_json_contains_only_safe_structured_fields() {
        let error = ai_error_json("timeout", "请求超时。", true, Some(504));
        let value: serde_json::Value = serde_json::from_str(&error).unwrap();

        assert_eq!(value["code"], "timeout");
        assert_eq!(value["message"], "请求超时。");
        assert_eq!(value["retryable"], true);
        assert_eq!(value["status"], 504);
        assert_eq!(value.as_object().unwrap().len(), 4);
    }

    #[test]
    fn http_status_mapping_uses_stable_error_codes() {
        assert_eq!(error_code(&http_status_error("OpenAI", 401)), "auth_error");
        assert_eq!(error_code(&http_status_error("Kimi", 402)), "quota_error");
        assert_eq!(error_code(&http_status_error("Kimi", 429)), "rate_limited");
        assert_eq!(
            error_code(&http_status_error("DeepSeek", 422)),
            "invalid_request"
        );
        assert_eq!(
            error_code(&http_status_error("Tencent TokenHub", 503)),
            "provider_error"
        );
    }

    #[test]
    fn http_status_mapping_exposes_only_bounded_provider_code_and_parameter() {
        let body = br#"{"error":{"code":"invalid_parameter","param":"stream_options","message":"provider detail is not projected"}}"#;
        let error = http_status_error_with_body("Tencent TokenHub", 400, body);
        let value: serde_json::Value = serde_json::from_str(&error).unwrap();
        assert_eq!(value["code"], "invalid_request");
        assert_eq!(
            value["message"],
            "AI 请求参数无效。（Provider code=invalid_parameter, param=stream_options）"
        );
        assert!(!value["message"]
            .as_str()
            .unwrap()
            .contains("provider detail"));

        let unsafe_body =
            br#"{"error":{"code":"invalid parameter with spaces","param":"<request>"}}"#;
        let unsafe_error = http_status_error_with_body("Tencent TokenHub", 400, unsafe_body);
        let unsafe_value: serde_json::Value = serde_json::from_str(&unsafe_error).unwrap();
        assert_eq!(unsafe_value["message"], "AI 请求参数无效。");
    }

    #[test]
    fn request_body_contains_only_minimal_provider_fields() {
        let value = serde_json::to_value(build_chat_request(
            "hello",
            provider_preset(PROVIDER_DEEPSEEK).unwrap(),
        ))
        .unwrap();
        let object = value.as_object().unwrap();

        assert_eq!(object.len(), 4);
        assert_eq!(object["model"], DEFAULT_DEEPSEEK_MODEL);
        assert_eq!(object["stream"], false);
        assert_eq!(object["thinking"]["type"], "disabled");
        assert_eq!(object["messages"].as_array().unwrap().len(), 1);
        assert_eq!(object["messages"][0]["role"], "user");
        assert_eq!(object["messages"][0]["content"], "hello");
    }

    #[test]
    fn streaming_request_serializes_native_json_only_when_selected() {
        let normal =
            build_stream_chat_request("hello", provider_preset(PROVIDER_DEEPSEEK).unwrap(), None);
        assert!(normal.get("response_format").is_none());

        let parse = build_stream_chat_request(
            "return JSON",
            provider_preset(PROVIDER_DEEPSEEK).unwrap(),
            Some(ChatResponseFormat::json_object()),
        );
        assert_eq!(parse["response_format"]["type"], "json_object");
        assert_eq!(parse["stream"], true);
        assert_eq!(parse["thinking"]["type"], "disabled");
    }

    #[test]
    fn response_parser_returns_text_model_usage_and_truncation() {
        let content = "界".repeat(12001);
        let body = serde_json::json!({
            "model": "deepseek-v4-flash",
            "choices": [{ "message": { "content": content } }],
            "usage": {
                "prompt_tokens": 3,
                "completion_tokens": 4,
                "total_tokens": 7
            }
        })
        .to_string();

        let response = parse_chat_completions_response(
            body.as_bytes(),
            PROVIDER_DEEPSEEK,
            DEFAULT_DEEPSEEK_MODEL,
            "DeepSeek",
        )
        .unwrap();
        assert_eq!(response.text.chars().count(), 12000);
        assert_eq!(response.provider, "deepseek");
        assert_eq!(response.model, "deepseek-v4-flash");
        assert_eq!(response.truncated, Some(true));
        assert_eq!(response.usage.unwrap().total_tokens, Some(7));
    }

    #[test]
    fn response_parser_distinguishes_invalid_empty_choices_and_empty_content() {
        assert_eq!(
            error_code(&parse(b"not-json").unwrap_err()),
            "invalid_response"
        );
        assert_eq!(
            error_code(&parse(br#"{"choices":[]}"#).unwrap_err()),
            "empty_choices"
        );
        assert_eq!(
            error_code(&parse(br#"{"choices":[{"message":{"content":"  "}}]}"#).unwrap_err()),
            "empty_content"
        );
    }

    fn assert_exact_provider_requests(provider: &str, model: &str, expects_thinking: bool) {
        let preset = implementation_attempt_preset(provider, model).unwrap();
        let non_stream = serde_json::to_value(build_chat_request("hello", preset)).unwrap();
        let normal_stream = build_stream_chat_request("hello", preset, None);
        let parse_stream = build_stream_chat_request(
            "return JSON",
            preset,
            Some(ChatResponseFormat::json_object()),
        );
        for request in [&non_stream, &normal_stream, &parse_stream] {
            assert_eq!(request["model"], model);
            assert_eq!(request["messages"][0]["role"], "user");
            assert_eq!(request.get("thinking").is_some(), expects_thinking);
        }
        assert_eq!(non_stream["stream"], false);
        assert_eq!(normal_stream["stream"], true);
        assert!(normal_stream.get("response_format").is_none());
        assert_eq!(parse_stream["response_format"]["type"], "json_object");
    }

    #[test]
    fn deepseek_builds_exact_nonstream_natural_stream_and_parse_stream_requests() {
        assert_exact_provider_requests(PROVIDER_DEEPSEEK, DEFAULT_DEEPSEEK_MODEL, true);
    }

    #[test]
    fn openai_builds_exact_nonstream_natural_stream_and_parse_stream_requests() {
        assert_exact_provider_requests(PROVIDER_OPENAI, OPENAI_MODEL, false);
    }

    #[test]
    fn tencent_tokenhub_builds_each_exact_models_bounded_request_policy() {
        for (model, expects_thinking) in [
            (TOKENHUB_HY3_MODEL, true),
            (TOKENHUB_GLM_5_1_MODEL, true),
            (TOKENHUB_GLM_5_3_FLASH_MODEL, false),
            (TOKENHUB_MINIMAX_M3_MODEL, true),
            (TOKENHUB_MIMO_V2_5_PRO_MODEL, false),
            (TOKENHUB_DEEPSEEK_V4_FLASH_MODEL, true),
            (TOKENHUB_KIMI_K3_MODEL, false),
        ] {
            assert_exact_provider_requests(PROVIDER_TENCENT_TOKENHUB, model, expects_thinking);
        }
    }

    #[test]
    fn kimi_builds_exact_nonstream_natural_stream_and_parse_stream_requests() {
        assert_exact_provider_requests(PROVIDER_KIMI, KIMI_MODEL, true);
    }
}
