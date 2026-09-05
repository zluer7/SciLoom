use super::ai::{
    ai_error_json, build_ai_http_client, build_stream_chat_request, http_status_error_with_body,
    read_bounded_provider_error_body, request_error, validate_parse_provider_prompt,
    validate_prompt, AIUsage, ChatResponseFormat, OUTPUT_MAX_CHARS, RESPONSE_MAX_BYTES,
};
use super::ai_provider_configuration::{
    ProviderConfigurationService, ProviderConfigurationSnapshot,
};
#[cfg(test)]
use super::ai_provider_configuration::{DEFAULT_DEEPSEEK_MODEL, PROVIDER_DEEPSEEK};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::future::{poll_fn, Future};
use std::sync::{Arc, Mutex, MutexGuard};
use std::task::Poll;
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::watch;

const TERMINAL_REQUEST_CACHE_LIMIT: usize = 256;
const CANCELLED_ERROR_CODE: &str = "cancelled";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AITextStreamRequest {
    pub prompt_envelope: crate::authorized_material::ProviderPromptEnvelope,
    #[serde(default)]
    pub material_freshness_receipts: Vec<crate::authorized_material::MaterialFreshnessReceipt>,
    pub expected_configuration_revision: u64,
    #[serde(default)]
    response_format: Option<ChatResponseFormat>,
    pub request_id: String,
    pub conversation_id: String,
    pub trigger_message_id: String,
    pub call_attempt_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AITextStreamEventKind {
    Started,
    Delta,
    Completed,
    Failed,
    Cancelled,
}

#[cfg(test)]
impl AITextStreamEventKind {
    fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AITextStreamEvent {
    pub request_id: String,
    pub conversation_id: String,
    pub trigger_message_id: String,
    pub call_attempt_id: String,
    pub event_sequence: u64,
    pub event_kind: AITextStreamEventKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<AIUsage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finish_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_retryable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_status: Option<u16>,
}

#[derive(Debug, Clone)]
struct StreamIdentity {
    request_id: String,
    conversation_id: String,
    trigger_message_id: String,
    call_attempt_id: String,
}

impl StreamIdentity {
    fn from_request(request: &AITextStreamRequest) -> Result<Self, String> {
        let require = |value: &str, field: &str| {
            if value.trim().is_empty() {
                Err(ai_error_json(
                    "invalid_request",
                    &format!("{field} is required for AI streaming."),
                    false,
                    None,
                ))
            } else {
                Ok(value.trim().to_string())
            }
        };

        let request_id = require(&request.request_id, "requestId")?;
        let call_attempt_id = require(&request.call_attempt_id, "callAttemptId")?;
        if request_id != call_attempt_id {
            return Err(ai_error_json(
                "invalid_request",
                "requestId must equal the canonical durable callAttemptId.",
                false,
                None,
            ));
        }

        Ok(Self {
            request_id,
            conversation_id: require(&request.conversation_id, "conversationId")?,
            trigger_message_id: require(&request.trigger_message_id, "triggerMessageId")?,
            call_attempt_id,
        })
    }

    fn event(&self, event_sequence: u64, event_kind: AITextStreamEventKind) -> AITextStreamEvent {
        AITextStreamEvent {
            request_id: self.request_id.clone(),
            conversation_id: self.conversation_id.clone(),
            trigger_message_id: self.trigger_message_id.clone(),
            call_attempt_id: self.call_attempt_id.clone(),
            event_sequence,
            event_kind,
            text: None,
            provider: None,
            model: None,
            truncated: None,
            usage: None,
            finish_reason: None,
            error_code: None,
            error_message: None,
            error_retryable: None,
            provider_status: None,
        }
    }
}

trait StreamEventSink: Send + Sync {
    fn send(&self, event: AITextStreamEvent) -> Result<(), ()>;
}

struct ChannelEventSink(Channel<AITextStreamEvent>);

impl StreamEventSink for ChannelEventSink {
    fn send(&self, event: AITextStreamEvent) -> Result<(), ()> {
        self.0.send(event).map_err(|_| ())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TerminalDecision {
    Won,
    AlreadyTerminal,
}

struct StreamLifecycle {
    next_sequence: u64,
    started: bool,
    terminal: Option<AITextStreamEventKind>,
    delivery_failed: bool,
    aggregate: String,
    aggregate_chars: usize,
    truncated: bool,
    provider: String,
    model: String,
    usage: Option<AIUsage>,
    finish_reason: Option<String>,
}

impl StreamLifecycle {
    fn new(provider: String, model: String) -> Self {
        Self {
            next_sequence: 0,
            started: false,
            terminal: None,
            delivery_failed: false,
            aggregate: String::new(),
            aggregate_chars: 0,
            truncated: false,
            provider,
            model,
            usage: None,
            finish_reason: None,
        }
    }
}

struct StreamCoordinator {
    identity: StreamIdentity,
    sink: Arc<dyn StreamEventSink>,
    lifecycle: Mutex<StreamLifecycle>,
}

impl StreamCoordinator {
    fn new(
        identity: StreamIdentity,
        sink: Arc<dyn StreamEventSink>,
        provider: String,
        model: String,
    ) -> Self {
        Self {
            identity,
            sink,
            lifecycle: Mutex::new(StreamLifecycle::new(provider, model)),
        }
    }

    fn lifecycle(&self) -> MutexGuard<'_, StreamLifecycle> {
        self.lifecycle
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn send_locked(
        &self,
        lifecycle: &mut StreamLifecycle,
        mut event: AITextStreamEvent,
    ) -> Result<(), String> {
        event.event_sequence = lifecycle.next_sequence;
        lifecycle.next_sequence += 1;
        if self.sink.send(event).is_err() {
            lifecycle.delivery_failed = true;
            if lifecycle.terminal.is_none() {
                lifecycle.terminal = Some(AITextStreamEventKind::Failed);
            }
            return Err(ai_error_json(
                "transport_error",
                "The AI stream channel closed before terminal delivery.",
                true,
                None,
            ));
        }
        Ok(())
    }

    fn started(&self) -> Result<(), String> {
        let mut lifecycle = self.lifecycle();
        if lifecycle.started {
            return Err(ai_error_json(
                "stream_protocol_error",
                "The AI stream was started more than once.",
                false,
                None,
            ));
        }
        lifecycle.started = true;
        let mut event = self
            .identity
            .event(lifecycle.next_sequence, AITextStreamEventKind::Started);
        event.provider = Some(lifecycle.provider.clone());
        event.model = Some(lifecycle.model.clone());
        self.send_locked(&mut lifecycle, event)
    }

    fn observe_metadata(
        &self,
        model: Option<String>,
        usage: Option<AIUsage>,
        finish_reason: Option<String>,
    ) {
        let mut lifecycle = self.lifecycle();
        if lifecycle.terminal.is_some() {
            return;
        }
        // Provider-returned aliases never replace the actual request provenance.
        let _ = model;
        if usage.is_some() {
            lifecycle.usage = usage;
        }
        if finish_reason.is_some() {
            lifecycle.finish_reason = finish_reason;
        }
    }

    fn delta(&self, delta: &str) -> Result<(), String> {
        if delta.is_empty() {
            return Ok(());
        }
        let mut lifecycle = self.lifecycle();
        if lifecycle.terminal.is_some() {
            return Ok(());
        }
        let remaining = OUTPUT_MAX_CHARS.saturating_sub(lifecycle.aggregate_chars);
        let incoming_chars = delta.chars().count();
        let accepted = delta.chars().take(remaining).collect::<String>();
        if incoming_chars > remaining {
            lifecycle.truncated = true;
        }
        if accepted.is_empty() {
            return Ok(());
        }
        lifecycle.aggregate_chars += accepted.chars().count();
        lifecycle.aggregate.push_str(&accepted);
        let mut event = self
            .identity
            .event(lifecycle.next_sequence, AITextStreamEventKind::Delta);
        event.text = Some(accepted);
        self.send_locked(&mut lifecycle, event)
    }

    fn complete(&self) -> Result<TerminalDecision, String> {
        let mut lifecycle = self.lifecycle();
        if lifecycle.terminal.is_some() {
            return Ok(TerminalDecision::AlreadyTerminal);
        }
        lifecycle.terminal = Some(AITextStreamEventKind::Completed);
        let mut event = self
            .identity
            .event(lifecycle.next_sequence, AITextStreamEventKind::Completed);
        event.text = Some(lifecycle.aggregate.clone());
        event.provider = Some(lifecycle.provider.clone());
        event.model = Some(lifecycle.model.clone());
        event.truncated = lifecycle.truncated.then_some(true);
        event.usage = lifecycle.usage.clone();
        event.finish_reason = lifecycle.finish_reason.clone();
        self.send_locked(&mut lifecycle, event)?;
        Ok(TerminalDecision::Won)
    }

    fn fail(&self, error: &str) -> Result<TerminalDecision, String> {
        let mut lifecycle = self.lifecycle();
        if lifecycle.terminal.is_some() {
            return Ok(TerminalDecision::AlreadyTerminal);
        }
        lifecycle.terminal = Some(AITextStreamEventKind::Failed);
        let safe_error = SafeAIError::parse(error);
        let mut event = self
            .identity
            .event(lifecycle.next_sequence, AITextStreamEventKind::Failed);
        event.error_code = Some(safe_error.code);
        event.error_message = Some(safe_error.message);
        event.error_retryable = Some(safe_error.retryable);
        event.provider_status = safe_error.status;
        self.send_locked(&mut lifecycle, event)?;
        Ok(TerminalDecision::Won)
    }

    fn cancel(&self) -> Result<TerminalDecision, String> {
        let mut lifecycle = self.lifecycle();
        if lifecycle.terminal.is_some() {
            return Ok(TerminalDecision::AlreadyTerminal);
        }
        lifecycle.terminal = Some(AITextStreamEventKind::Cancelled);
        let mut event = self
            .identity
            .event(lifecycle.next_sequence, AITextStreamEventKind::Cancelled);
        event.error_code = Some(CANCELLED_ERROR_CODE.to_string());
        event.error_message = Some("The AI request was cancelled by the user.".to_string());
        event.error_retryable = Some(true);
        self.send_locked(&mut lifecycle, event)?;
        Ok(TerminalDecision::Won)
    }

    fn terminal_kind(&self) -> Option<AITextStreamEventKind> {
        self.lifecycle().terminal
    }

    fn delivery_error(&self) -> Option<String> {
        self.lifecycle().delivery_failed.then(|| {
            ai_error_json(
                "transport_error",
                "The AI stream channel closed before terminal delivery.",
                true,
                None,
            )
        })
    }

    #[cfg(test)]
    fn aggregate(&self) -> String {
        self.lifecycle().aggregate.clone()
    }
}

#[derive(Debug, Deserialize)]
struct SafeAIError {
    code: String,
    message: String,
    retryable: bool,
    status: Option<u16>,
}

impl SafeAIError {
    fn parse(error: &str) -> Self {
        serde_json::from_str(error).unwrap_or_else(|_| Self {
            code: "unknown_error".to_string(),
            message: "The AI stream failed.".to_string(),
            retryable: false,
            status: None,
        })
    }
}

struct ActiveStream {
    cancel: watch::Sender<bool>,
    coordinator: Arc<StreamCoordinator>,
}

#[derive(Default)]
struct StreamRegistry {
    active: HashMap<String, ActiveStream>,
    terminal_order: VecDeque<String>,
    terminal_ids: HashSet<String>,
}

impl StreamRegistry {
    fn remember_terminal(&mut self, request_id: String) {
        if !self.terminal_ids.insert(request_id.clone()) {
            return;
        }
        self.terminal_order.push_back(request_id);
        while self.terminal_order.len() > TERMINAL_REQUEST_CACHE_LIMIT {
            if let Some(expired) = self.terminal_order.pop_front() {
                self.terminal_ids.remove(&expired);
            }
        }
    }
}

#[derive(Default)]
pub struct AIStreamingState {
    registry: Mutex<StreamRegistry>,
    #[cfg(test)]
    test_provider_fixture: Mutex<Option<TestProviderFixture>>,
    #[cfg(test)]
    observed_test_provider_prompts: Mutex<Vec<String>>,
}

impl AIStreamingState {
    fn registry(&self) -> MutexGuard<'_, StreamRegistry> {
        self.registry
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn cleanup(&self, request_id: &str, coordinator: &Arc<StreamCoordinator>) {
        let mut registry = self.registry();
        let should_remove = registry
            .active
            .get(request_id)
            .is_some_and(|active| Arc::ptr_eq(&active.coordinator, coordinator));
        if should_remove {
            registry.active.remove(request_id);
        }
        if coordinator.terminal_kind().is_some() {
            registry.remember_terminal(request_id.to_string());
        }
    }

    #[cfg(test)]
    fn active_count(&self) -> usize {
        self.registry().active.len()
    }

    #[cfg(test)]
    fn install_test_provider_fixture(&self, fixture: TestProviderFixture) {
        *self
            .test_provider_fixture
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(fixture);
    }

    #[cfg(test)]
    fn take_test_provider_fixture(&self) -> Option<TestProviderFixture> {
        self.test_provider_fixture
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
    }

    #[cfg(test)]
    fn record_test_provider_prompt(&self, prompt: &str) {
        self.observed_test_provider_prompts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(prompt.to_string());
    }

    #[cfg(test)]
    fn observed_test_provider_prompts(&self) -> Vec<String> {
        self.observed_test_provider_prompts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }
}

#[cfg(test)]
#[derive(Clone)]
struct TestProviderFixture {
    required_prompt_fragment: Option<String>,
    chunks: Vec<Vec<u8>>,
    delay_after_chunk: std::time::Duration,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CancelAITextStreamStatus {
    CancelAccepted,
    AlreadyTerminal,
    ActiveRequestNotFound,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelAITextStreamResponse {
    pub request_id: String,
    pub call_attempt_id: String,
    pub status: CancelAITextStreamStatus,
}

#[derive(Debug, Deserialize)]
struct ChatCompletionsStreamChunk {
    model: Option<String>,
    #[serde(default)]
    choices: Vec<ChatCompletionsStreamChoice>,
    usage: Option<ChatCompletionsStreamUsage>,
}

#[derive(Debug, Deserialize)]
struct ChatCompletionsStreamChoice {
    delta: Option<ChatCompletionsStreamDelta>,
    finish_reason: Option<String>,
    usage: Option<ChatCompletionsStreamUsage>,
}

#[derive(Debug, Deserialize)]
struct ChatCompletionsStreamDelta {
    content: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct ChatCompletionsStreamUsage {
    prompt_tokens: Option<u64>,
    completion_tokens: Option<u64>,
    total_tokens: Option<u64>,
}

impl From<ChatCompletionsStreamUsage> for AIUsage {
    fn from(usage: ChatCompletionsStreamUsage) -> Self {
        Self {
            input_tokens: usage.prompt_tokens,
            output_tokens: usage.completion_tokens,
            total_tokens: usage.total_tokens,
        }
    }
}

#[derive(Debug, PartialEq)]
enum ParsedSseFrame {
    Chunk(ParsedStreamChunk),
    Done,
}

#[derive(Debug, PartialEq)]
struct ParsedStreamChunk {
    delta: Option<String>,
    model: Option<String>,
    usage: Option<AIUsage>,
    finish_reason: Option<String>,
}

#[derive(Default)]
struct ChatCompletionsSseParser {
    pending: Vec<u8>,
    data_lines: Vec<Vec<u8>>,
}

impl ChatCompletionsSseParser {
    fn push(&mut self, bytes: &[u8]) -> Result<Vec<ParsedSseFrame>, String> {
        self.pending.extend_from_slice(bytes);
        let mut frames = Vec::new();
        while let Some(newline) = self.pending.iter().position(|byte| *byte == b'\n') {
            let mut line = self.pending.drain(..=newline).collect::<Vec<_>>();
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            self.consume_line(line, &mut frames)?;
        }
        Ok(frames)
    }

    fn finish(mut self) -> Result<Vec<ParsedSseFrame>, String> {
        let mut frames = Vec::new();
        if !self.pending.is_empty() {
            let line = std::mem::take(&mut self.pending);
            self.consume_line(line, &mut frames)?;
        }
        if !self.data_lines.is_empty() {
            self.flush_frame(&mut frames)?;
        }
        Ok(frames)
    }

    fn consume_line(
        &mut self,
        line: Vec<u8>,
        frames: &mut Vec<ParsedSseFrame>,
    ) -> Result<(), String> {
        if line.is_empty() {
            return self.flush_frame(frames);
        }
        if line.first() == Some(&b':') {
            return Ok(());
        }
        if let Some(value) = line.strip_prefix(b"data:") {
            self.data_lines
                .push(value.strip_prefix(b" ").unwrap_or(value).to_vec());
        }
        Ok(())
    }

    fn flush_frame(&mut self, frames: &mut Vec<ParsedSseFrame>) -> Result<(), String> {
        if self.data_lines.is_empty() {
            return Ok(());
        }
        let joined =
            self.data_lines
                .drain(..)
                .enumerate()
                .fold(Vec::new(), |mut bytes, (index, line)| {
                    if index > 0 {
                        bytes.push(b'\n');
                    }
                    bytes.extend(line);
                    bytes
                });
        let data = std::str::from_utf8(&joined).map_err(|_| invalid_stream_response())?;
        if data.trim() == "[DONE]" {
            frames.push(ParsedSseFrame::Done);
            return Ok(());
        }
        if data.trim().is_empty() {
            return Ok(());
        }
        let chunk: ChatCompletionsStreamChunk =
            serde_json::from_str(data).map_err(|_| invalid_stream_response())?;
        let choice = chunk.choices.first();
        let usage = chunk
            .usage
            .or_else(|| choice.and_then(|value| value.usage.clone()));
        frames.push(ParsedSseFrame::Chunk(ParsedStreamChunk {
            delta: choice
                .and_then(|value| value.delta.as_ref())
                .and_then(|value| value.content.clone()),
            model: chunk.model,
            usage: usage.map(Into::into),
            finish_reason: choice.and_then(|value| value.finish_reason.clone()),
        }));
        Ok(())
    }
}

fn invalid_stream_response() -> String {
    ai_error_json(
        "invalid_response",
        "The AI provider returned an invalid streaming response.",
        false,
        None,
    )
}

fn early_stream_end() -> String {
    ai_error_json(
        "stream_ended_early",
        "The AI provider stream ended before its terminal marker.",
        true,
        None,
    )
}

fn empty_stream_content() -> String {
    ai_error_json(
        "empty_content",
        "The AI provider returned empty content.",
        false,
        None,
    )
}

fn process_frames(
    coordinator: &StreamCoordinator,
    frames: Vec<ParsedSseFrame>,
) -> Result<bool, String> {
    for frame in frames {
        match frame {
            ParsedSseFrame::Done => return Ok(true),
            ParsedSseFrame::Chunk(chunk) => {
                coordinator.observe_metadata(chunk.model, chunk.usage, chunk.finish_reason);
                if let Some(delta) = chunk.delta {
                    coordinator.delta(&delta)?;
                }
            }
        }
    }
    Ok(false)
}

async fn execute_provider_stream(
    prompt: String,
    parse_dynamic_budget_admitted: bool,
    snapshot: ProviderConfigurationSnapshot,
    response_format: Option<ChatResponseFormat>,
    coordinator: Arc<StreamCoordinator>,
) -> Result<(), String> {
    let prompt = if parse_dynamic_budget_admitted {
        validate_parse_provider_prompt(&prompt)?
    } else {
        validate_prompt(&prompt)?
    };
    let client = build_ai_http_client()?;
    let preset = snapshot.preset();
    let response = client
        .post(preset.endpoint())
        .bearer_auth(snapshot.secret())
        .json(&build_stream_chat_request(&prompt, preset, response_format))
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
        return Err(invalid_stream_response());
    }

    let mut response = response;
    let mut parser = ChatCompletionsSseParser::default();
    let mut response_bytes = 0usize;
    let mut saw_done = false;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| request_error(preset.display_name(), &error))?
    {
        response_bytes = response_bytes.saturating_add(chunk.len());
        if response_bytes > RESPONSE_MAX_BYTES {
            return Err(invalid_stream_response());
        }
        if process_frames(&coordinator, parser.push(&chunk)?)? {
            saw_done = true;
            break;
        }
    }
    if !saw_done && process_frames(&coordinator, parser.finish()?)? {
        saw_done = true;
    }
    if !saw_done {
        return Err(early_stream_end());
    }

    let (finish_reason, aggregate_empty) = {
        let lifecycle = coordinator.lifecycle();
        (
            lifecycle.finish_reason.clone(),
            lifecycle.aggregate.trim().is_empty(),
        )
    };
    let finish_reason = finish_reason.ok_or_else(invalid_stream_response)?;
    match finish_reason.as_str() {
        "stop" => {}
        "length" => coordinator.lifecycle().truncated = true,
        _ => return Err(invalid_stream_response()),
    }
    if aggregate_empty {
        return Err(empty_stream_content());
    }
    Ok(())
}

#[cfg(test)]
async fn execute_test_provider_fixture(
    prompt: String,
    parse_dynamic_budget_admitted: bool,
    coordinator: Arc<StreamCoordinator>,
    fixture: TestProviderFixture,
) -> Result<(), String> {
    if parse_dynamic_budget_admitted {
        validate_parse_provider_prompt(&prompt)?;
    } else {
        validate_prompt(&prompt)?;
    }
    if fixture
        .required_prompt_fragment
        .as_ref()
        .is_some_and(|required| !prompt.contains(required))
    {
        return Err(ai_error_json(
            "provider_error",
            "The deterministic provider did not observe its required material evidence.",
            false,
            None,
        ));
    }
    let mut parser = ChatCompletionsSseParser::default();
    let mut response_bytes = 0usize;
    let mut saw_done = false;
    for chunk in fixture.chunks {
        response_bytes = response_bytes.saturating_add(chunk.len());
        if response_bytes > RESPONSE_MAX_BYTES {
            return Err(invalid_stream_response());
        }
        if process_frames(&coordinator, parser.push(&chunk)?)? {
            saw_done = true;
            break;
        }
        if !fixture.delay_after_chunk.is_zero() {
            tokio::time::sleep(fixture.delay_after_chunk).await;
        }
    }
    if !saw_done && process_frames(&coordinator, parser.finish()?)? {
        saw_done = true;
    }
    if !saw_done {
        return Err(early_stream_end());
    }
    let (finish_reason, aggregate_empty) = {
        let lifecycle = coordinator.lifecycle();
        (
            lifecycle.finish_reason.clone(),
            lifecycle.aggregate.trim().is_empty(),
        )
    };
    let finish_reason = finish_reason.ok_or_else(invalid_stream_response)?;
    match finish_reason.as_str() {
        "stop" => {}
        "length" => coordinator.lifecycle().truncated = true,
        _ => return Err(invalid_stream_response()),
    }
    if aggregate_empty {
        return Err(empty_stream_content());
    }
    Ok(())
}

async fn execute_selected_provider_stream(
    _state: &AIStreamingState,
    prompt: String,
    parse_dynamic_budget_admitted: bool,
    snapshot: ProviderConfigurationSnapshot,
    response_format: Option<ChatResponseFormat>,
    coordinator: Arc<StreamCoordinator>,
) -> Result<(), String> {
    #[cfg(test)]
    if let Some(fixture) = _state.take_test_provider_fixture() {
        _state.record_test_provider_prompt(&prompt);
        drop(snapshot);
        return execute_test_provider_fixture(
            prompt,
            parse_dynamic_budget_admitted,
            coordinator,
            fixture,
        )
        .await;
    }
    execute_provider_stream(
        prompt,
        parse_dynamic_budget_admitted,
        snapshot,
        response_format,
        coordinator,
    )
    .await
}

fn resolve_provider_response_format(
    constraint_category: &str,
    requested: Option<ChatResponseFormat>,
) -> Result<Option<ChatResponseFormat>, String> {
    match (constraint_category, requested) {
        ("PARSE_DRAFT", Some(format)) if format == ChatResponseFormat::json_object() => {
            Ok(Some(format))
        }
        ("PARSE_DRAFT", None) => Err(ai_error_json(
            "invalid_request",
            "PARSE_DRAFT requires provider-native json_object response format.",
            false,
            None,
        )),
        ("PARSE_DRAFT", Some(_)) => Err(ai_error_json(
            "invalid_request",
            "PARSE_DRAFT requested an unsupported provider response format.",
            false,
            None,
        )),
        (_, Some(_)) => Err(ai_error_json(
            "invalid_request",
            "Provider-native json_object response format is restricted to PARSE_DRAFT.",
            false,
            None,
        )),
        (_, None) => Ok(None),
    }
}

fn duplicate_request_error() -> String {
    ai_error_json(
        "material_attempt_already_owned_or_replayed",
        "This canonical AI call attempt has already been started.",
        false,
        None,
    )
}

#[tauri::command(rename_all = "camelCase")]
pub async fn stream_ai_text(
    state: State<'_, AIStreamingState>,
    material_runtime: State<'_, crate::authorized_material::AuthorizedMaterialRuntime>,
    provider_configuration: State<'_, ProviderConfigurationService>,
    request: AITextStreamRequest,
    on_event: Channel<AITextStreamEvent>,
) -> Result<(), String> {
    let identity = StreamIdentity::from_request(&request)?;
    let request_id = identity.request_id.clone();
    let snapshot =
        provider_configuration.resolve_snapshot(request.expected_configuration_revision)?;
    debug_assert_eq!(
        snapshot.configuration_revision(),
        request.expected_configuration_revision
    );
    let coordinator = Arc::new(StreamCoordinator::new(
        identity,
        Arc::new(ChannelEventSink(on_event)),
        snapshot.provider().to_string(),
        snapshot.model().to_string(),
    ));
    let (cancel, mut cancelled) = watch::channel(false);
    {
        let mut registry = state.registry();
        if registry.active.contains_key(&request_id) || registry.terminal_ids.contains(&request_id)
        {
            return Err(duplicate_request_error());
        }
        registry.active.insert(
            request_id.clone(),
            ActiveStream {
                cancel,
                coordinator: coordinator.clone(),
            },
        );
    }

    let finalized = match crate::authorized_material::finalize_provider_prompt(
        &material_runtime,
        &request.call_attempt_id,
        &request.conversation_id,
        &request.trigger_message_id,
        &request.material_freshness_receipts,
        &request.prompt_envelope,
    ) {
        Ok(finalized) => finalized,
        Err(error) => {
            let _ = coordinator.fail(&error);
            state.cleanup(&request_id, &coordinator);
            if let Some(delivery_error) = coordinator.delivery_error() {
                return Err(delivery_error);
            }
            return Ok(());
        }
    };

    let response_format = match resolve_provider_response_format(
        &request.prompt_envelope.constraint_descriptor.category,
        request.response_format,
    ) {
        Ok(response_format) => response_format,
        Err(error) => {
            let _ = coordinator.fail(&error);
            state.cleanup(&request_id, &coordinator);
            if let Some(delivery_error) = coordinator.delivery_error() {
                return Err(delivery_error);
            }
            return Ok(());
        }
    };

    if let Err(error) = coordinator.started() {
        state.cleanup(&request_id, &coordinator);
        return Err(error);
    }

    let mut provider = Box::pin(execute_selected_provider_stream(
        &state,
        finalized.prompt,
        request.prompt_envelope.constraint_descriptor.category == "PARSE_DRAFT",
        snapshot,
        response_format,
        coordinator.clone(),
    ));
    let mut cancellation = Box::pin(cancelled.changed());
    let provider_result = poll_fn(|context| {
        if let Poll::Ready(changed) = cancellation.as_mut().poll(context) {
            return Poll::Ready(if changed.is_ok() {
                None
            } else {
                Some(Err(ai_error_json(
                    "transport_error",
                    "The AI cancellation authority closed unexpectedly.",
                    true,
                    None,
                )))
            });
        }
        if let Poll::Ready(result) = provider.as_mut().poll(context) {
            return Poll::Ready(Some(result));
        }
        Poll::Pending
    })
    .await;

    if let Some(result) = provider_result {
        match result {
            Ok(()) => {
                let _ = coordinator.complete();
            }
            Err(error) => {
                let _ = coordinator.fail(&error);
            }
        }
    }
    state.cleanup(&request_id, &coordinator);
    if let Some(error) = coordinator.delivery_error() {
        return Err(error);
    }
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub fn cancel_ai_text_stream(
    state: State<'_, AIStreamingState>,
    request_id: String,
    call_attempt_id: String,
) -> Result<CancelAITextStreamResponse, String> {
    let request_id = request_id.trim().to_string();
    let call_attempt_id = call_attempt_id.trim().to_string();
    if request_id.is_empty() || call_attempt_id.is_empty() || request_id != call_attempt_id {
        return Err(ai_error_json(
            "invalid_request",
            "Cancellation requires matching requestId and canonical callAttemptId.",
            false,
            None,
        ));
    }

    let active = {
        let registry = state.registry();
        registry
            .active
            .get(&request_id)
            .map(|active| (active.cancel.clone(), active.coordinator.clone()))
    };
    let status = if let Some((cancel, coordinator)) = active {
        match coordinator.cancel() {
            Err(error) => {
                // A closed frontend channel must not keep provider work alive.
                let _ = cancel.send(true);
                return Err(error);
            }
            Ok(TerminalDecision::Won) => {
                let _ = cancel.send(true);
                CancelAITextStreamStatus::CancelAccepted
            }
            Ok(TerminalDecision::AlreadyTerminal) => CancelAITextStreamStatus::AlreadyTerminal,
        }
    } else if state.registry().terminal_ids.contains(&request_id) {
        CancelAITextStreamStatus::AlreadyTerminal
    } else {
        CancelAITextStreamStatus::ActiveRequestNotFound
    };

    Ok(CancelAITextStreamResponse {
        request_id,
        call_attempt_id,
        status,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct RecordingSink {
        events: Mutex<Vec<AITextStreamEvent>>,
        fail_at: Option<usize>,
    }

    impl StreamEventSink for RecordingSink {
        fn send(&self, event: AITextStreamEvent) -> Result<(), ()> {
            let mut events = self
                .events
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if self.fail_at == Some(events.len()) {
                return Err(());
            }
            events.push(event);
            Ok(())
        }
    }

    fn identity() -> StreamIdentity {
        StreamIdentity {
            request_id: "attempt-1".to_string(),
            conversation_id: "conversation-1".to_string(),
            trigger_message_id: "message-1".to_string(),
            call_attempt_id: "attempt-1".to_string(),
        }
    }

    fn prompt_envelope(user_question: &str) -> crate::authorized_material::ProviderPromptEnvelope {
        crate::authorized_material::ProviderPromptEnvelope {
            constraint_descriptor: crate::authorized_material::ProviderConstraintDescriptor {
                category: "NORMAL_QA".to_string(),
                lifecycle: "ACTIVE".to_string(),
                constraint_ref: "labpod.ai.constraint.normal_qa".to_string(),
                constraint_version: 16,
                shared_invariant_ref: "labpod.ai.constraint.shared_invariant".to_string(),
                shared_invariant_version: 2,
                bounded_policy_refs: vec![
                    "labpod.ai.policy.normal_qa.presentation".to_string(),
                ],
                executable_bounded_policies: Vec::new(),
            },
            constraint_segments: vec![
                crate::authorized_material::ProviderConstraintSemanticSegment {
                    kind: "shared_invariant".to_string(),
                    category: None,
                    contract_ref: "labpod.ai.constraint.shared_invariant".to_string(),
                    version: 2,
                    bounded_policy_refs: Vec::new(),
                    text: "canonical shared invariant".to_string(),
                },
                crate::authorized_material::ProviderConstraintSemanticSegment {
                    kind: "category_policy".to_string(),
                    category: Some("NORMAL_QA".to_string()),
                    contract_ref: "labpod.ai.constraint.normal_qa".to_string(),
                    version: 16,
                    bounded_policy_refs: vec![
                        "labpod.ai.policy.normal_qa.presentation".to_string(),
                    ],
                    text: "canonical normal QA policy".to_string(),
                },
            ],
            research_context: "context".to_string(),
            run_scoped_directive: None,
            conversation_history: Vec::new(),
            user_question: user_question.to_string(),
            output_detail_preference: "STANDARD".to_string(),
            quick_analysis_context_capability: None,
            context_request_followup_state: None,
            current_call_authorized_material_refs: Vec::new(),
            one_shot_local_attachment: None,
            context_request_response_contract: None,
            standard_result_response_contract: None,
            parse_dynamic_context_budget: None,
            final_prompt_hard_budget:
                crate::authorized_material::PROVIDER_PROMPT_TECHNICAL_MAX_CHARACTERS,
        }
    }

    fn constraint_source_refs() -> serde_json::Value {
        serde_json::json!([{
            "module": "ai",
            "entityType": "system",
            "entityId": "labpod.ai.constraint.normal_qa",
            "field": "constraintDescriptor",
            "sourceKind": "systemGenerated",
            "constraintCategory": "NORMAL_QA",
            "constraintLifecycle": "ACTIVE",
            "constraintRef": "labpod.ai.constraint.normal_qa",
            "constraintVersion": 16,
            "sharedInvariantRef": "labpod.ai.constraint.shared_invariant",
            "sharedInvariantVersion": 2,
            "boundedPolicyRefs": ["labpod.ai.policy.normal_qa.presentation"]
        }])
    }

    fn temporary_directory(label: &str) -> std::path::PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("labpod-b7-{label}-{nonce}"));
        std::fs::create_dir_all(&directory).expect("create IPC fixture directory");
        directory
    }

    fn unique_request_id(label: &str) -> String {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        format!("{label}-{nonce}")
    }

    fn coordinator() -> (Arc<StreamCoordinator>, Arc<RecordingSink>) {
        let sink = Arc::new(RecordingSink::default());
        (
            Arc::new(StreamCoordinator::new(
                identity(),
                sink.clone(),
                PROVIDER_DEEPSEEK.to_string(),
                DEFAULT_DEEPSEEK_MODEL.to_string(),
            )),
            sink,
        )
    }

    fn event_kinds(sink: &RecordingSink) -> Vec<AITextStreamEventKind> {
        sink.events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .map(|event| event.event_kind)
            .collect()
    }

    fn chunks_for(bytes: &[&[u8]]) -> Vec<ParsedSseFrame> {
        let mut parser = ChatCompletionsSseParser::default();
        let mut frames = Vec::new();
        for bytes in bytes {
            frames.extend(parser.push(bytes).unwrap());
        }
        frames.extend(parser.finish().unwrap());
        frames
    }

    #[test]
    fn native_json_response_format_is_exactly_parse_draft_only() {
        let native = ChatResponseFormat::json_object();
        assert_eq!(
            resolve_provider_response_format("PARSE_DRAFT", Some(native)).unwrap(),
            Some(native)
        );
        assert!(resolve_provider_response_format("PARSE_DRAFT", None).is_err());
        assert_eq!(
            resolve_provider_response_format("NORMAL_QA", None).unwrap(),
            None
        );
        assert!(resolve_provider_response_format("NORMAL_QA", Some(native)).is_err());
        assert!(resolve_provider_response_format("CONTEXT_REQUEST", Some(native)).is_err());
    }

    #[test]
    fn parser_handles_fragmented_utf8_combined_frames_and_usage_only_chunk() {
        let payload = concat!(
            "data: {\"model\":\"deepseek-v4-flash\",\"choices\":[{\"delta\":{\"content\":\"你\"},\"finish_reason\":null}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"好\"},\"finish_reason\":\"stop\"}]}\n\n",
            "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":3,\"total_tokens\":5}}\n\n",
            "data: [DONE]\n\n"
        );
        let bytes = payload.as_bytes();
        let split_inside_utf8 = payload.find('你').unwrap() + 1;
        let frames = chunks_for(&[
            &bytes[..split_inside_utf8],
            &bytes[split_inside_utf8..split_inside_utf8 + 5],
            &bytes[split_inside_utf8 + 5..],
        ]);

        assert_eq!(frames.len(), 4);
        assert!(matches!(frames[3], ParsedSseFrame::Done));
        let ParsedSseFrame::Chunk(usage) = &frames[2] else {
            panic!("expected usage chunk");
        };
        assert_eq!(usage.usage.as_ref().unwrap().total_tokens, Some(5));
    }

    #[test]
    fn parser_normalizes_kimi_choice_scoped_usage_without_a_business_branch() {
        let frames = chunks_for(&[
            concat!(
                "data: {\"model\":\"kimi-k2.6\",\"choices\":[{\"delta\":",
                "{\"content\":\"ok\"},\"finish_reason\":\"stop\",\"usage\":",
                "{\"prompt_tokens\":4,\"completion_tokens\":2,\"total_tokens\":6}}]}\n\n"
            )
            .as_bytes(),
            b"data: [DONE]\n\n",
        ]);
        let ParsedSseFrame::Chunk(chunk) = &frames[0] else {
            panic!("expected normalized Kimi chunk");
        };
        assert_eq!(chunk.model.as_deref(), Some("kimi-k2.6"));
        assert_eq!(chunk.delta.as_deref(), Some("ok"));
        assert_eq!(chunk.finish_reason.as_deref(), Some("stop"));
        assert_eq!(chunk.usage.as_ref().unwrap().total_tokens, Some(6));
        assert!(matches!(frames[1], ParsedSseFrame::Done));
    }

    #[test]
    fn parser_rejects_malformed_json_and_invalid_utf8() {
        let mut malformed = ChatCompletionsSseParser::default();
        assert!(malformed.push(b"data: nope\n\n").is_err());
        let mut invalid_utf8 = ChatCompletionsSseParser::default();
        assert!(invalid_utf8.push(b"data: \xff\n\n").is_err());
    }

    #[test]
    fn lifecycle_orders_identity_and_exactly_one_success_terminal() {
        let (coordinator, sink) = coordinator();
        coordinator.started().unwrap();
        coordinator.delta("one").unwrap();
        coordinator.delta(" two").unwrap();
        coordinator.observe_metadata(
            Some("model-x".to_string()),
            Some(AIUsage {
                input_tokens: Some(1),
                output_tokens: Some(2),
                total_tokens: Some(3),
            }),
            Some("stop".to_string()),
        );
        assert_eq!(coordinator.complete().unwrap(), TerminalDecision::Won);
        assert_eq!(
            coordinator.fail(&invalid_stream_response()).unwrap(),
            TerminalDecision::AlreadyTerminal
        );

        let events = sink
            .events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        assert_eq!(events.len(), 4, "unexpected IPC stream events: {events:#?}");
        for (sequence, event) in events.iter().enumerate() {
            assert_eq!(event.event_sequence, sequence as u64);
            assert_eq!(event.request_id, "attempt-1");
            assert_eq!(event.call_attempt_id, "attempt-1");
            assert_eq!(event.conversation_id, "conversation-1");
            assert_eq!(event.trigger_message_id, "message-1");
        }
        let terminal = events.last().unwrap();
        assert_eq!(terminal.event_kind, AITextStreamEventKind::Completed);
        assert_eq!(terminal.text.as_deref(), Some("one two"));
        assert_eq!(terminal.provider.as_deref(), Some(PROVIDER_DEEPSEEK));
        assert_eq!(terminal.model.as_deref(), Some(DEFAULT_DEEPSEEK_MODEL));
        assert_eq!(terminal.usage.as_ref().unwrap().total_tokens, Some(3));
    }

    #[test]
    fn cancellation_wins_and_suppresses_late_delta_and_completion() {
        let (coordinator, sink) = coordinator();
        coordinator.started().unwrap();
        coordinator.delta("partial").unwrap();
        assert_eq!(coordinator.cancel().unwrap(), TerminalDecision::Won);
        coordinator.delta(" late").unwrap();
        assert_eq!(
            coordinator.complete().unwrap(),
            TerminalDecision::AlreadyTerminal
        );
        assert_eq!(
            event_kinds(&sink),
            vec![
                AITextStreamEventKind::Started,
                AITextStreamEventKind::Delta,
                AITextStreamEventKind::Cancelled,
            ]
        );
        assert_eq!(coordinator.aggregate(), "partial");
    }

    #[test]
    fn cancellation_before_first_delta_is_terminal_and_completion_can_win_the_inverse_race() {
        let (cancel_first, cancel_sink) = coordinator();
        cancel_first.started().unwrap();
        assert_eq!(cancel_first.cancel().unwrap(), TerminalDecision::Won);
        cancel_first.delta("late").unwrap();
        assert_eq!(
            event_kinds(&cancel_sink),
            vec![
                AITextStreamEventKind::Started,
                AITextStreamEventKind::Cancelled,
            ]
        );

        let (complete_first, complete_sink) = coordinator();
        complete_first.started().unwrap();
        complete_first.delta("answer").unwrap();
        complete_first.observe_metadata(None, None, Some("stop".to_string()));
        assert_eq!(complete_first.complete().unwrap(), TerminalDecision::Won);
        assert_eq!(
            complete_first.cancel().unwrap(),
            TerminalDecision::AlreadyTerminal
        );
        assert_eq!(
            event_kinds(&complete_sink),
            vec![
                AITextStreamEventKind::Started,
                AITextStreamEventKind::Delta,
                AITextStreamEventKind::Completed,
            ]
        );
    }

    #[test]
    fn provider_failure_wins_and_suppresses_late_completion() {
        let (coordinator, sink) = coordinator();
        coordinator.started().unwrap();
        let error = ai_error_json("network_error", "safe", true, None);
        assert_eq!(coordinator.fail(&error).unwrap(), TerminalDecision::Won);
        assert_eq!(
            coordinator.complete().unwrap(),
            TerminalDecision::AlreadyTerminal
        );
        let events = sink
            .events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        assert_eq!(
            events.last().unwrap().error_code.as_deref(),
            Some("network_error")
        );
        assert!(!serde_json::to_string(&*events)
            .unwrap()
            .contains("DEEPSEEK_API_KEY"));
    }

    #[test]
    fn output_limit_preserves_unicode_and_marks_terminal_truncated() {
        let (coordinator, sink) = coordinator();
        coordinator.started().unwrap();
        coordinator
            .delta(&"界".repeat(OUTPUT_MAX_CHARS + 3))
            .unwrap();
        coordinator.observe_metadata(None, None, Some("stop".to_string()));
        coordinator.complete().unwrap();
        let events = sink
            .events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let terminal = events.last().unwrap();
        assert_eq!(
            terminal.text.as_ref().unwrap().chars().count(),
            OUTPUT_MAX_CHARS
        );
        assert_eq!(terminal.truncated, Some(true));
    }

    #[test]
    fn channel_failure_becomes_transport_error_and_terminal_decision() {
        let sink = Arc::new(RecordingSink {
            events: Mutex::new(Vec::new()),
            fail_at: Some(1),
        });
        let coordinator = StreamCoordinator::new(
            identity(),
            sink,
            PROVIDER_DEEPSEEK.to_string(),
            DEFAULT_DEEPSEEK_MODEL.to_string(),
        );
        coordinator.started().unwrap();
        let error = coordinator.delta("cannot deliver").unwrap_err();
        assert_eq!(SafeAIError::parse(&error).code, "transport_error");
        assert_eq!(
            coordinator.terminal_kind(),
            Some(AITextStreamEventKind::Failed)
        );
    }

    #[test]
    fn registry_cleanup_is_identity_scoped_and_bounded() {
        let state = AIStreamingState::default();
        let (coordinator, _) = coordinator();
        let (cancel, _) = watch::channel(false);
        state.registry().active.insert(
            "attempt-1".to_string(),
            ActiveStream {
                cancel,
                coordinator: coordinator.clone(),
            },
        );
        coordinator.started().unwrap();
        coordinator.cancel().unwrap();
        state.cleanup("attempt-1", &coordinator);
        assert_eq!(state.active_count(), 0);
        assert!(state.registry().terminal_ids.contains("attempt-1"));

        let mut registry = state.registry();
        for index in 0..TERMINAL_REQUEST_CACHE_LIMIT + 5 {
            registry.remember_terminal(format!("terminal-{index}"));
        }
        assert_eq!(registry.terminal_ids.len(), TERMINAL_REQUEST_CACHE_LIMIT);
    }

    #[test]
    fn identity_rejects_a_second_transient_request_identifier() {
        let request = AITextStreamRequest {
            prompt_envelope: prompt_envelope("hello"),
            material_freshness_receipts: Vec::new(),
            expected_configuration_revision: 1,
            response_format: None,
            request_id: "transient".to_string(),
            conversation_id: "conversation".to_string(),
            trigger_message_id: "message".to_string(),
            call_attempt_id: "durable".to_string(),
        };
        let error = StreamIdentity::from_request(&request).unwrap_err();
        assert_eq!(SafeAIError::parse(&error).code, "invalid_request");
    }

    #[test]
    fn terminal_kind_helper_is_exhaustive() {
        assert!(!AITextStreamEventKind::Started.is_terminal());
        assert!(!AITextStreamEventKind::Delta.is_terminal());
        assert!(AITextStreamEventKind::Completed.is_terminal());
        assert!(AITextStreamEventKind::Failed.is_terminal());
        assert!(AITextStreamEventKind::Cancelled.is_terminal());
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

    fn stream_ipc_request(
        request_id: &str,
        channel_id: u32,
        material_freshness_receipts: Vec<crate::authorized_material::MaterialFreshnessReceipt>,
    ) -> tauri::webview::InvokeRequest {
        stream_ipc_request_for_identity(
            request_id,
            "conversation-ipc",
            &format!("message-{request_id}"),
            channel_id,
            material_freshness_receipts,
        )
    }

    fn stream_ipc_request_for_identity(
        request_id: &str,
        conversation_id: &str,
        trigger_message_id: &str,
        channel_id: u32,
        material_freshness_receipts: Vec<crate::authorized_material::MaterialFreshnessReceipt>,
    ) -> tauri::webview::InvokeRequest {
        let current_call_authorized_material_refs = material_freshness_receipts
            .iter()
            .enumerate()
            .map(|(index, receipt)| {
                serde_json::json!({
                    "ordinal": index + 1,
                    "refId": receipt.file_ref_id
                })
            })
            .collect::<Vec<_>>();
        tauri::webview::InvokeRequest {
            cmd: "stream_ai_text".into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: ipc_url(),
            body: tauri::ipc::InvokeBody::Json(serde_json::json!({
                "request": {
                    "promptEnvelope": {
                        "constraintDescriptor": {
                            "category": "NORMAL_QA",
                            "lifecycle": "ACTIVE",
                            "constraintRef": "labpod.ai.constraint.normal_qa",
                            "constraintVersion": 16,
                            "sharedInvariantRef": "labpod.ai.constraint.shared_invariant",
                            "sharedInvariantVersion": 2,
                            "boundedPolicyRefs": ["labpod.ai.policy.normal_qa.presentation"]
                        },
                        "constraintSegments": [
                            {
                                "kind": "shared_invariant",
                                "ref": "labpod.ai.constraint.shared_invariant",
                                "version": 2,
                                "text": "canonical shared invariant"
                            },
                            {
                                "kind": "category_policy",
                                "category": "NORMAL_QA",
                                "ref": "labpod.ai.constraint.normal_qa",
                                "version": 16,
                                "boundedPolicyRefs": ["labpod.ai.policy.normal_qa.presentation"],
                                "text": "canonical normal QA policy"
                            }
                        ],
                        "researchContext": "context",
                        "conversationHistory": [],
                        "userQuestion": "deterministic fixture prompt",
                        "outputDetailPreference": "STANDARD",
                        "currentCallAuthorizedMaterialRefs": current_call_authorized_material_refs,
                        "finalPromptHardBudget": 45000
                    },
                    "materialFreshnessReceipts": material_freshness_receipts,
                    "expectedConfigurationRevision": 1,
                    "requestId": request_id,
                    "conversationId": conversation_id,
                    "triggerMessageId": trigger_message_id,
                    "callAttemptId": request_id
                },
                "onEvent": format!("__CHANNEL__:{channel_id}")
            })),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.to_string(),
        }
    }

    fn seed_stream_attempt(
        database_path: &std::path::Path,
        request_id: &str,
        material_path: Option<&std::path::Path>,
    ) {
        seed_stream_attempt_with_frontend_prompt(
            database_path,
            request_id,
            material_path,
            None,
            "deterministic fixture prompt",
            constraint_source_refs(),
        );
    }

    fn current_stream_receipts(
        request_id: &str,
        material_path: &std::path::Path,
    ) -> Vec<crate::authorized_material::MaterialFreshnessReceipt> {
        vec![
            crate::authorized_material::inspect_material_freshness_receipt(
                material_path,
                &format!("file-{request_id}"),
            )
            .expect("current stream test receipt"),
        ]
    }

    fn seed_stream_attempt_with_frontend_prompt(
        database_path: &std::path::Path,
        request_id: &str,
        material_path: Option<&std::path::Path>,
        material_file_ref_id: Option<&str>,
        user_question: &str,
        context_source_refs: serde_json::Value,
    ) {
        use crate::db::ai_durable_foundation::{
            create_ai_conversation_in_connection, prepare_ai_call_attempt_in_connection,
            CreateAIConversationInput, NewAIMessageInput, PrepareAICallAttemptInput,
        };
        use serde_json::json;

        crate::db::initialize_test_database_at(database_path)
            .expect("initialize IPC test database");
        let mut connection = rusqlite::Connection::open(database_path).expect("open IPC test DB");
        create_ai_conversation_in_connection(
            &connection,
            &CreateAIConversationInput {
                id: "conversation-ipc".to_string(),
                stable_key: "global-ai-chat/ipc-tests".to_string(),
                created_at: "2026-08-14T00:00:00Z".to_string(),
            },
        )
        .expect("canonical IPC conversation");
        let authorized_file_ref_ids = material_path
            .map(|path| {
                let file_ref_id = material_file_ref_id
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("file-{request_id}"));
                connection
                    .execute(
                        "INSERT INTO file_refs(
                           id,owner_type,owner_id,resource_kind,file_role,location_mode,
                           file_type,path,path_identity_key,title,description,schema_version,
                           source,custom_fields,created_at,updated_at,deleted_at
                         ) VALUES (
                           ?1,'Experiment','ipc-owner','file','attachment','external',
                           'text/plain',?2,?2,?3,NULL,2,'user','[]',
                           '2026-08-14T00:00:00Z','2026-08-14T00:00:00Z',NULL
                         )
                         ON CONFLICT(id) DO UPDATE SET
                           path=excluded.path,path_identity_key=excluded.path_identity_key,
                           title=excluded.title,deleted_at=NULL",
                        rusqlite::params![
                            file_ref_id,
                            path.to_string_lossy(),
                            path.file_name().unwrap().to_string_lossy()
                        ],
                    )
                    .expect("canonical IPC FileRef");
                vec![file_ref_id]
            })
            .unwrap_or_default();
        prepare_ai_call_attempt_in_connection(
            &mut connection,
            &PrepareAICallAttemptInput {
                conversation_id: "conversation-ipc".to_string(),
                attempt_id: request_id.to_string(),
                request_id: request_id.to_string(),
                purpose: "chat_response".to_string(),
                user_message: Some(NewAIMessageInput {
                    id: format!("message-{request_id}"),
                    content: user_question.to_string(),
                    created_at: "2026-08-14T00:00:01Z".to_string(),
                }),
                trigger_message_id: None,
                trigger_call_attempt_id: None,
                provider: PROVIDER_DEEPSEEK.to_string(),
                model: DEFAULT_DEEPSEEK_MODEL.to_string(),
                context_package_id: format!("context-{request_id}"),
                context_package_version: "1".to_string(),
                context_source_refs,
                warnings: json!([]),
                budget_summary: None,
                prompt_package_id: format!("prompt-{request_id}"),
                prompt_created_at: "2026-08-14T00:00:01Z".to_string(),
                started_at: "2026-08-14T00:00:01Z".to_string(),
                authorized_file_ref_ids,
            },
        )
        .expect("canonical IPC CallAttempt");
    }

    fn frontend_envelope_ipc_request(
        request_id: &str,
        channel_id: u32,
        prompt_envelope: serde_json::Value,
        material_freshness_receipts: Vec<crate::authorized_material::MaterialFreshnessReceipt>,
    ) -> tauri::webview::InvokeRequest {
        tauri::webview::InvokeRequest {
            cmd: "stream_ai_text".into(),
            callback: tauri::ipc::CallbackFn(80),
            error: tauri::ipc::CallbackFn(81),
            url: ipc_url(),
            body: tauri::ipc::InvokeBody::Json(serde_json::json!({
                "request": {
                    "promptEnvelope": prompt_envelope,
                    "materialFreshnessReceipts": material_freshness_receipts,
                    "expectedConfigurationRevision": 1,
                    "requestId": request_id,
                    "conversationId": "conversation-ipc",
                    "triggerMessageId": format!("message-{request_id}"),
                    "callAttemptId": request_id
                },
                "onEvent": format!("__CHANNEL__:{channel_id}")
            })),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.to_string(),
        }
    }

    fn cancel_ipc_request(request_id: &str) -> tauri::webview::InvokeRequest {
        tauri::webview::InvokeRequest {
            cmd: "cancel_ai_text_stream".into(),
            callback: tauri::ipc::CallbackFn(2),
            error: tauri::ipc::CallbackFn(3),
            url: ipc_url(),
            body: tauri::ipc::InvokeBody::Json(serde_json::json!({
                "requestId": request_id,
                "callAttemptId": request_id
            })),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.to_string(),
        }
    }

    fn successful_fixture(delay_after_chunk: std::time::Duration) -> TestProviderFixture {
        TestProviderFixture {
            required_prompt_fragment: None,
            chunks: vec![
                br#"data: {"model":"deepseek-v4-flash","choices":[{"delta":{"content":"fixture "},"finish_reason":null}]}

"#
                .to_vec(),
                br#"data: {"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}

data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}

data: [DONE]

"#
                .to_vec(),
            ],
            delay_after_chunk,
        }
    }

    fn material_aware_fixture(required_prompt_fragment: &str) -> TestProviderFixture {
        TestProviderFixture {
            required_prompt_fragment: Some(required_prompt_fragment.to_string()),
            chunks: vec![
                br#"data: {"model":"deepseek-v4-flash","choices":[{"delta":{"content":"material "},"finish_reason":null}]}

"#
                .to_vec(),
                br#"data: {"choices":[{"delta":{"content":"evidence observed"},"finish_reason":"stop"}]}

data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}

data: [DONE]

"#
                .to_vec(),
            ],
            delay_after_chunk: std::time::Duration::ZERO,
        }
    }

    #[test]
    fn real_tauri_ipc_channel_runs_the_exact_stream_command_with_production_parser() {
        use tauri::Manager;

        let request_id = unique_request_id("ipc-success");
        let material_directory = temporary_directory("ipc-provider-seam");
        let database_path = material_directory.join("labpod.sqlite3");
        let material_path = material_directory.join("provider-seam.md");
        let material_sentinel = "B7 real relation-reader-finalizer-provider evidence";
        std::fs::write(&material_path, material_sentinel).expect("IPC material");
        seed_stream_attempt(&database_path, &request_id, Some(&material_path));
        let state = AIStreamingState::default();
        state.install_test_provider_fixture(material_aware_fixture(material_sentinel));
        let events = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
        let captured = events.clone();
        let app = tauri::test::mock_builder()
            .channel_interceptor(move |_webview, _callback, _index, body| {
                captured
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .push(body.clone().deserialize().expect("channel event JSON"));
                true
            })
            .manage(state)
            .manage(crate::authorized_material::AuthorizedMaterialRuntime::new(
                database_path,
            ))
            .manage(ProviderConfigurationService::test_configured())
            .invoke_handler(tauri::generate_handler![
                stream_ai_text,
                cancel_ai_text_stream
            ])
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("mock WebView");

        tauri::test::get_ipc_response(
            &window,
            stream_ipc_request(
                &request_id,
                42,
                current_stream_receipts(&request_id, &material_path),
            ),
        )
        .expect("stream command response")
        .deserialize::<()>()
        .expect("unit response");

        let events = events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        assert_eq!(events.len(), 4, "unexpected real IPC stream events: {events:#?}");
        assert_eq!(events[0]["eventKind"], "started");
        assert_eq!(events[1]["eventKind"], "delta");
        assert_eq!(events[2]["eventKind"], "delta");
        assert_eq!(events[3]["eventKind"], "completed");
        assert_eq!(events[3]["text"], "material evidence observed");
        assert_eq!(events[3]["usage"]["totalTokens"], 5);
        for (sequence, event) in events.iter().enumerate() {
            assert_eq!(event["eventSequence"], sequence as u64);
            assert_eq!(event["requestId"], request_id);
            assert_eq!(event["callAttemptId"], request_id);
        }
        assert_eq!(app.state::<AIStreamingState>().active_count(), 0);
        let provider_prompts = app
            .state::<AIStreamingState>()
            .observed_test_provider_prompts();
        assert_eq!(provider_prompts.len(), 1);
        assert!(provider_prompts[0].contains(material_sentinel));
        assert!(provider_prompts[0].contains("USER_SUPPLIED_RESEARCH_MATERIAL"));
        assert!(provider_prompts[0].contains(&format!("file-{request_id}")));
        assert!(!provider_prompts[0].contains(&material_directory.to_string_lossy().to_string()));

        let already_terminal =
            tauri::test::get_ipc_response(&window, cancel_ipc_request(&request_id))
                .expect("already-terminal cancel response")
                .deserialize::<serde_json::Value>()
                .expect("already-terminal JSON");
        assert_eq!(already_terminal["status"], "ALREADY_TERMINAL");
        let not_found =
            tauri::test::get_ipc_response(&window, cancel_ipc_request("ipc-never-active"))
                .expect("not-found cancel response")
                .deserialize::<serde_json::Value>()
                .expect("not-found JSON");
        assert_eq!(not_found["status"], "ACTIVE_REQUEST_NOT_FOUND");
        std::fs::remove_dir_all(material_directory).expect("remove IPC material fixture");
    }

    #[test]
    fn lp13_d1_a4_changed_reviewed_source_fails_before_provider_start() {
        use tauri::Manager;

        let request_id = unique_request_id("a4-stale-provider-boundary");
        let fixture_directory = temporary_directory("a4-stale-provider-boundary");
        let database_path = fixture_directory.join("labpod.sqlite3");
        let material_path = fixture_directory.join("reviewed-source.md");
        std::fs::write(&material_path, "reviewed source").expect("A4 reviewed source");
        seed_stream_attempt(&database_path, &request_id, Some(&material_path));
        let reviewed_receipts = current_stream_receipts(&request_id, &material_path);
        std::fs::write(&material_path, "changed! source").expect("A4 post-review change");

        let state = AIStreamingState::default();
        state.install_test_provider_fixture(successful_fixture(std::time::Duration::ZERO));
        let events = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
        let captured = events.clone();
        let app = tauri::test::mock_builder()
            .channel_interceptor(move |_webview, _callback, _index, body| {
                captured
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .push(body.clone().deserialize().expect("A4 channel event JSON"));
                true
            })
            .manage(state)
            .manage(crate::authorized_material::AuthorizedMaterialRuntime::new(
                database_path,
            ))
            .manage(ProviderConfigurationService::test_configured())
            .invoke_handler(tauri::generate_handler![stream_ai_text])
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("A4 mock app");
        let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("A4 mock WebView");

        tauri::test::get_ipc_response(
            &window,
            stream_ipc_request(&request_id, 49, reviewed_receipts),
        )
        .expect("A4 stream command response")
        .deserialize::<()>()
        .expect("A4 unit response");

        let events = events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["eventKind"], "failed");
        assert_eq!(
            events[0]["errorCode"],
            "material_source_changed_since_review"
        );
        assert_eq!(events[0]["eventSequence"], 0);
        assert_eq!(
            app.state::<AIStreamingState>()
                .observed_test_provider_prompts()
                .len(),
            0
        );
        assert_eq!(app.state::<AIStreamingState>().active_count(), 0);
        drop(events);

        let mut readback_connection =
            rusqlite::Connection::open(fixture_directory.join("labpod.sqlite3"))
                .expect("open A4 durable readback database");
        let readback =
            crate::db::ai_durable_foundation::settle_ai_call_attempt_failure_in_connection(
                &mut readback_connection,
                &crate::db::ai_durable_foundation::SettleAICallAttemptFailureInput {
                    attempt_id: request_id.clone(),
                    error_code: "material_source_changed_since_review".to_string(),
                    error_message: Some(
                        "The reviewed source changed before final read.".to_string(),
                    ),
                    error_retryable: false,
                    provider_status: None,
                    settled_at: "2026-08-18T00:00:00Z".to_string(),
                },
            )
            .expect("settle exact A4 failed attempt through the canonical failure path");
        assert_eq!(readback.conversation.id, "conversation-ipc");
        assert_eq!(
            readback.messages.len(),
            1,
            "no assistant result may be fabricated"
        );
        assert_eq!(readback.call_attempts.len(), 1);
        let failed_attempt = &readback.call_attempts[0];
        assert_eq!(failed_attempt.id, request_id);
        assert_eq!(failed_attempt.conversation_id, "conversation-ipc");
        assert_eq!(failed_attempt.status, "failed");
        assert_eq!(
            failed_attempt.error_code.as_deref(),
            Some("material_source_changed_since_review")
        );
        assert_eq!(failed_attempt.authorized_file_refs.len(), 1);
        assert_eq!(
            failed_attempt.authorized_file_refs[0].file_ref_id,
            format!("file-{}", failed_attempt.id)
        );
        drop(readback_connection);
        drop(window);
        drop(app);
        std::fs::remove_dir_all(fixture_directory).expect("remove A4 boundary fixture");
    }

    #[derive(Debug, serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct A6FrontendRustFixture {
        prompt_envelope: serde_json::Value,
        context_source_refs: serde_json::Value,
        expect_provider_started: bool,
        required_material_fragment: String,
        material_prompt_reservation_characters: usize,
        body_raw_bytes: usize,
        body_characters: usize,
        reviewed_research_context_characters: usize,
        effective_research_context_characters: usize,
        frontend_envelope_without_material_characters: usize,
    }

    #[test]
    #[ignore = "invoked by the LP13-C1-A6 frontend-to-Rust integrated contract test"]
    fn lp13_c1_a6_frontend_envelope_reaches_provider_once_or_fails_closed() {
        use tauri::Manager;

        let fixture_path = std::env::var("LP13_A6_FRONTEND_ENVELOPE_PATH")
            .expect("frontend envelope fixture path");
        let material_path = std::path::PathBuf::from(
            std::env::var("LP13_A6_MATERIAL_PATH").expect("material fixture path"),
        );
        let fixture: A6FrontendRustFixture = serde_json::from_slice(
            &std::fs::read(fixture_path).expect("frontend envelope fixture"),
        )
        .expect("frontend envelope fixture JSON");
        let envelope: crate::authorized_material::ProviderPromptEnvelope =
            serde_json::from_value(fixture.prompt_envelope.clone())
                .expect("Rust consumes the frontend Provider envelope shape");
        let material_bytes = std::fs::read(&material_path).expect("integrated material");
        let material_text =
            std::str::from_utf8(&material_bytes).expect("UTF-8 integrated material");
        assert_eq!(material_bytes.len(), fixture.body_raw_bytes);
        assert_eq!(material_text.chars().count(), fixture.body_characters);
        assert_eq!(
            crate::authorized_material::estimate_material_prompt_reservation_characters(
                &material_path,
            )
            .expect("canonical Rust reservation"),
            fixture.material_prompt_reservation_characters,
        );
        assert_eq!(
            envelope.research_context.chars().count(),
            fixture.effective_research_context_characters,
        );
        assert_eq!(
            fixture.effective_research_context_characters,
            fixture.reviewed_research_context_characters,
        );
        let provider_prompt_before_material = crate::authorized_material::compose_prompt(
            &envelope,
            &envelope.conversation_history,
            None,
        );
        assert!(provider_prompt_before_material
            .contains("## Current-call Authorized Material Contract"));
        assert!(provider_prompt_before_material
            .contains("file-ref-7a7a6615-8bf3-4fcb-9ccc-4510893daa9e"));
        assert_eq!(
            provider_prompt_before_material.chars().count(),
            fixture.frontend_envelope_without_material_characters,
        );
        assert!(provider_prompt_before_material.chars().count() <= envelope.final_prompt_hard_budget);

        let request_id = unique_request_id("a6-frontend-rust");
        let fixture_directory = temporary_directory("a6-frontend-rust");
        let database_path = fixture_directory.join("labpod.sqlite3");
        seed_stream_attempt_with_frontend_prompt(
            &database_path,
            &request_id,
            Some(&material_path),
            Some("file-ref-7a7a6615-8bf3-4fcb-9ccc-4510893daa9e"),
            &envelope.user_question,
            fixture.context_source_refs,
        );
        let reviewed_receipt = crate::authorized_material::inspect_material_freshness_receipt(
            &material_path,
            "file-ref-7a7a6615-8bf3-4fcb-9ccc-4510893daa9e",
        )
        .expect("A6 current test receipt");
        let state = AIStreamingState::default();
        state.install_test_provider_fixture(if fixture.expect_provider_started {
            material_aware_fixture(&fixture.required_material_fragment)
        } else {
            successful_fixture(std::time::Duration::ZERO)
        });
        let events = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
        let captured = events.clone();
        let app = tauri::test::mock_builder()
            .channel_interceptor(move |_webview, _callback, _index, body| {
                captured
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .push(body.clone().deserialize().expect("A6 channel event JSON"));
                true
            })
            .manage(state)
            .manage(crate::authorized_material::AuthorizedMaterialRuntime::new(
                database_path,
            ))
            .manage(ProviderConfigurationService::test_configured())
            .invoke_handler(tauri::generate_handler![stream_ai_text])
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("A6 mock app");
        let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("A6 mock WebView");
        tauri::test::get_ipc_response(
            &window,
            frontend_envelope_ipc_request(
                &request_id,
                82,
                fixture.prompt_envelope,
                vec![reviewed_receipt],
            ),
        )
        .expect("A6 stream command response")
        .deserialize::<()>()
        .expect("A6 unit response");

        let events = events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let provider_prompts = app
            .state::<AIStreamingState>()
            .observed_test_provider_prompts();
        if fixture.expect_provider_started {
            assert_eq!(provider_prompts.len(), 1);
            assert_eq!(events.first().unwrap()["eventKind"], "started");
            assert_eq!(events.last().unwrap()["eventKind"], "completed");
            assert!(provider_prompts[0].contains(&fixture.required_material_fragment));
            assert!(provider_prompts[0].contains("Current-call Authorized Material Contract"));
            assert!(provider_prompts[0].contains("USER_SUPPLIED_RESEARCH_MATERIAL"));
            assert!(provider_prompts[0].contains(&envelope.user_question));
            assert!(provider_prompts[0].contains("## Shared Invariant"));
            assert!(provider_prompts[0].chars().count() <= envelope.final_prompt_hard_budget);
        } else {
            assert_eq!(provider_prompts.len(), 0);
            assert_eq!(events.len(), 1);
            assert_eq!(events[0]["eventKind"], "failed");
            assert_eq!(events[0]["errorCode"], "material_budget_exceeded");
        }
        drop(events);
        drop(window);
        drop(app);
        std::fs::remove_dir_all(fixture_directory).expect("remove A6 integrated DB fixture");
    }

    #[test]
    fn b8_real_tauri_ipc_regenerate_crosses_prepare_stream_settlement_and_restart_readback() {
        use crate::db::ai_durable_foundation::{
            create_ai_conversation_in_connection, prepare_ai_call_attempt_in_connection,
            prepare_ai_retry_regenerate_attempt_in_connection, read_ai_conversation_in_connection,
            settle_ai_call_attempt_success_in_connection, AIChatAttemptActionIntent, AIUsageInput,
            CreateAIConversationInput, NewAIMessageInput, PrepareAICallAttemptInput,
            PrepareAIRetryRegenerateAttemptInput, SettleAICallAttemptSuccessInput,
        };
        use serde_json::json;
        use tauri::Manager;

        let request_id = unique_request_id("ipc-b8-regenerate");
        let fixture_directory = temporary_directory("ipc-b8-regenerate");
        let database_path = fixture_directory.join("labpod.sqlite3");
        let conversation_id = "conversation-ipc-b8";
        let trigger_message_id = "message-ipc-b8-user";
        let original_attempt_id = "attempt-ipc-b8-original";
        let original_assistant_id = "message-ipc-b8-assistant-original";
        let regenerated_assistant_id = "message-ipc-b8-assistant-regenerated";

        crate::db::initialize_test_database_at(&database_path)
            .expect("initialize B8 IPC database");
        let mut connection =
            rusqlite::Connection::open(&database_path).expect("open B8 IPC database");
        create_ai_conversation_in_connection(
            &connection,
            &CreateAIConversationInput {
                id: conversation_id.to_string(),
                stable_key: "global-ai-chat/ipc-b8".to_string(),
                created_at: "2026-08-14T12:00:00Z".to_string(),
            },
        )
        .expect("canonical B8 IPC conversation");
        prepare_ai_call_attempt_in_connection(
            &mut connection,
            &PrepareAICallAttemptInput {
                conversation_id: conversation_id.to_string(),
                attempt_id: original_attempt_id.to_string(),
                request_id: original_attempt_id.to_string(),
                purpose: "chat_response".to_string(),
                user_message: Some(NewAIMessageInput {
                    id: trigger_message_id.to_string(),
                    content: "deterministic fixture prompt".to_string(),
                    created_at: "2026-08-14T12:00:01Z".to_string(),
                }),
                trigger_message_id: None,
                trigger_call_attempt_id: None,
                provider: PROVIDER_DEEPSEEK.to_string(),
                model: DEFAULT_DEEPSEEK_MODEL.to_string(),
                context_package_id: "context-ipc-b8-original".to_string(),
                context_package_version: "1".to_string(),
                context_source_refs: constraint_source_refs(),
                warnings: json!([]),
                budget_summary: None,
                prompt_package_id: "prompt-ipc-b8-original".to_string(),
                prompt_created_at: "2026-08-14T12:00:01Z".to_string(),
                started_at: "2026-08-14T12:00:01Z".to_string(),
                authorized_file_ref_ids: Vec::new(),
            },
        )
        .expect("original canonical B8 IPC attempt");
        settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &SettleAICallAttemptSuccessInput {
                attempt_id: original_attempt_id.to_string(),
                provider: PROVIDER_DEEPSEEK.to_string(),
                model: DEFAULT_DEEPSEEK_MODEL.to_string(),
                response_truncated: Some(false),
                usage: Some(AIUsageInput {
                    input_tokens: Some(1),
                    output_tokens: Some(2),
                    total_tokens: Some(3),
                }),
                assistant_message: Some(NewAIMessageInput {
                    id: original_assistant_id.to_string(),
                    content: "old durable answer".to_string(),
                    created_at: "2026-08-14T12:00:02Z".to_string(),
                }),
                context_request: None,
                standard_result_batch: None,
                settled_at: "2026-08-14T12:00:02Z".to_string(),
            },
        )
        .expect("original canonical B8 IPC settlement");
        drop(connection);

        let state = AIStreamingState::default();
        state.install_test_provider_fixture(successful_fixture(std::time::Duration::ZERO));
        let events = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
        let captured = events.clone();
        let app = tauri::test::mock_builder()
            .channel_interceptor(move |_webview, _callback, _index, body| {
                captured
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .push(body.clone().deserialize().expect("B8 channel event JSON"));
                true
            })
            .manage(state)
            .manage(crate::authorized_material::AuthorizedMaterialRuntime::new(
                database_path.clone(),
            ))
            .manage(ProviderConfigurationService::test_configured())
            .invoke_handler(tauri::generate_handler![
                stream_ai_text,
                cancel_ai_text_stream
            ])
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("B8 mock app");
        let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("B8 mock WebView");

        let regenerate_input = PrepareAIRetryRegenerateAttemptInput {
            conversation_id: conversation_id.to_string(),
            attempt_id: request_id.clone(),
            request_id: request_id.clone(),
            action_intent: AIChatAttemptActionIntent::Regenerate,
            trigger_message_id: trigger_message_id.to_string(),
            expected_source_attempt_id: original_attempt_id.to_string(),
            expected_effective_message_id: Some(original_assistant_id.to_string()),
            provider: PROVIDER_DEEPSEEK.to_string(),
            model: DEFAULT_DEEPSEEK_MODEL.to_string(),
            context_package_id: "context-ipc-b8-regenerate".to_string(),
            context_package_version: "1".to_string(),
            context_source_refs: constraint_source_refs(),
            warnings: json!([]),
            budget_summary: Some(json!({ "maxChars": 15000, "usedChars": 32 })),
            prompt_package_id: "prompt-ipc-b8-regenerate".to_string(),
            prompt_created_at: "2026-08-14T12:00:03Z".to_string(),
            started_at: "2026-08-14T12:00:03Z".to_string(),
        };
        let mut connection =
            rusqlite::Connection::open(&database_path).expect("reopen B8 prepare database");
        let prepared =
            prepare_ai_retry_regenerate_attempt_in_connection(&mut connection, &regenerate_input)
                .expect("B8 attempt-only prepare");
        assert!(prepared.provider_invocation_authorized);
        assert_eq!(prepared.readback.messages.len(), 2);
        assert_eq!(prepared.readback.projected_messages.len(), 2);
        assert_eq!(prepared.readback.projected_messages[1].id, original_assistant_id);
        assert_eq!(prepared.readback.call_attempts.len(), 2);
        assert!(prepared.readback.call_attempts[1].authorized_file_refs.is_empty());

        let matching_replay =
            prepare_ai_retry_regenerate_attempt_in_connection(&mut connection, &regenerate_input)
                .expect("matching B8 prepare replay");
        assert!(matching_replay.provider_invocation_authorized);
        assert_eq!(
            matching_replay.readback.call_attempts.len(),
            2,
            "matching prepare replay must create no additional row"
        );
        drop(connection);

        tauri::test::get_ipc_response(
            &window,
            stream_ipc_request_for_identity(
                &request_id,
                conversation_id,
                trigger_message_id,
                46,
                Vec::new(),
            ),
        )
        .expect("B8 stream command response")
        .deserialize::<()>()
        .expect("B8 stream unit response");
        let terminal = {
            let events = events
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            assert_eq!(events.len(), 4, "unexpected B8 stream events: {events:#?}");
            assert_eq!(events[0]["eventKind"], "started");
            assert_eq!(events[3]["eventKind"], "completed");
            assert_eq!(events[3]["text"], "fixture answer");
            events[3].clone()
        };
        let provider_prompts = app
            .state::<AIStreamingState>()
            .observed_test_provider_prompts();
        assert_eq!(provider_prompts.len(), 1);
        assert_eq!(
            provider_prompts[0]
                .matches("deterministic fixture prompt")
                .count(),
            1,
            "the canonical trigger must occur once as current input"
        );
        assert!(!provider_prompts[0].contains("old durable answer"));
        assert!(!provider_prompts[0].contains("USER_SUPPLIED_RESEARCH_MATERIAL"));

        app.state::<AIStreamingState>()
            .install_test_provider_fixture(successful_fixture(std::time::Duration::ZERO));
        let duplicate_error = tauri::test::get_ipc_response(
            &window,
            stream_ipc_request_for_identity(
                &request_id,
                conversation_id,
                trigger_message_id,
                47,
                Vec::new(),
            ),
        )
        .expect_err("B7 start ownership must reject the duplicate B8 stream");
        assert!(
            format!("{duplicate_error:?}").contains("material_attempt_already_owned_or_replayed")
        );
        assert_eq!(
            app.state::<AIStreamingState>()
                .observed_test_provider_prompts()
                .len(),
            1,
            "matching prepare replay plus duplicate stream must still invoke one provider"
        );

        let mut connection =
            rusqlite::Connection::open(&database_path).expect("reopen B8 settlement database");
        let settled = settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &SettleAICallAttemptSuccessInput {
                attempt_id: request_id.clone(),
                provider: terminal["provider"].as_str().unwrap().to_string(),
                model: terminal["model"].as_str().unwrap().to_string(),
                response_truncated: terminal["truncated"].as_bool(),
                usage: Some(AIUsageInput {
                    input_tokens: terminal["usage"]["inputTokens"].as_i64(),
                    output_tokens: terminal["usage"]["outputTokens"].as_i64(),
                    total_tokens: terminal["usage"]["totalTokens"].as_i64(),
                }),
                assistant_message: Some(NewAIMessageInput {
                    id: regenerated_assistant_id.to_string(),
                    content: terminal["text"].as_str().unwrap().to_string(),
                    created_at: "2026-08-14T12:00:04Z".to_string(),
                }),
                context_request: None,
                standard_result_batch: None,
                settled_at: "2026-08-14T12:00:04Z".to_string(),
            },
        )
        .expect("B8 production settlement");
        assert_eq!(settled.messages.len(), 3);
        assert_eq!(settled.projected_messages.len(), 2);
        assert_eq!(settled.projected_messages[0].id, trigger_message_id);
        assert_eq!(settled.projected_messages[1].id, regenerated_assistant_id);
        assert_eq!(
            settled.retry_regenerate.effective_source_attempt_id.as_deref(),
            Some(request_id.as_str())
        );
        assert!(
            settled.messages.iter().any(|message| message.id == original_assistant_id),
            "the superseded assistant Message must remain durable"
        );

        let terminal_replay =
            prepare_ai_retry_regenerate_attempt_in_connection(&mut connection, &regenerate_input)
                .expect("terminal B8 prepare replay");
        assert!(!terminal_replay.provider_invocation_authorized);
        assert_eq!(terminal_replay.readback.call_attempts.len(), 2);

        let mut conflicting_input = regenerate_input;
        conflicting_input.trigger_message_id = "message-ipc-b8-other".to_string();
        let conflict_error =
            prepare_ai_retry_regenerate_attempt_in_connection(&mut connection, &conflicting_input)
                .expect_err("same proposed ID with a different trigger must fail closed");
        assert!(conflict_error.contains("attempt_identity_conflict"));
        drop(connection);

        drop(window);
        drop(app);

        let restart_connection =
            rusqlite::Connection::open(&database_path).expect("restart B8 IPC database readback");
        let restart_readback =
            read_ai_conversation_in_connection(&restart_connection, conversation_id)
                .expect("restart authoritative readback");
        assert_eq!(restart_readback.projected_messages[1].id, regenerated_assistant_id);
        assert_eq!(restart_readback.call_attempts.len(), 2);
        drop(restart_connection);

        let restart_state = AIStreamingState::default();
        restart_state.install_test_provider_fixture(successful_fixture(std::time::Duration::ZERO));
        let restart_events = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
        let restart_captured = restart_events.clone();
        let restarted_app = tauri::test::mock_builder()
            .channel_interceptor(move |_webview, _callback, _index, body| {
                restart_captured
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .push(body.clone().deserialize().expect("restart channel event JSON"));
                true
            })
            .manage(restart_state)
            .manage(crate::authorized_material::AuthorizedMaterialRuntime::new(
                database_path,
            ))
            .manage(ProviderConfigurationService::test_configured())
            .invoke_handler(tauri::generate_handler![
                stream_ai_text,
                cancel_ai_text_stream
            ])
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("restarted B8 mock app");
        let restarted_window =
            tauri::WebviewWindowBuilder::new(&restarted_app, "main", Default::default())
                .build()
                .expect("restarted B8 mock WebView");
        tauri::test::get_ipc_response(
            &restarted_window,
            stream_ipc_request_for_identity(
                &request_id,
                conversation_id,
                trigger_message_id,
                48,
                Vec::new(),
            ),
        )
        .expect("terminal replay is reported through the canonical failed event")
        .deserialize::<()>()
        .expect("terminal replay stream unit response");
        let restart_events = restart_events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        assert_eq!(restart_events.len(), 1);
        assert_eq!(restart_events[0]["eventKind"], "failed");
        assert_eq!(
            restarted_app
                .state::<AIStreamingState>()
                .observed_test_provider_prompts()
                .len(),
            0,
            "a terminal replay after registry restart must not reach the provider"
        );
        drop(restart_events);
        drop(restarted_window);
        drop(restarted_app);
        std::fs::remove_dir_all(fixture_directory).expect("remove isolated B8 IPC fixture");
    }

    #[test]
    fn real_tauri_material_gate_failure_emits_only_failed_and_starts_no_provider() {
        use tauri::Manager;

        let request_id = unique_request_id("ipc-material-gate");
        let material_directory = temporary_directory("ipc-material-gate");
        let database_path = material_directory.join("labpod.sqlite3");
        let material_path = material_directory.join("unsupported.pdf");
        std::fs::write(&material_path, "must never reach provider")
            .expect("unsupported material fixture");
        seed_stream_attempt(&database_path, &request_id, Some(&material_path));
        let state = AIStreamingState::default();
        state.install_test_provider_fixture(successful_fixture(std::time::Duration::ZERO));
        let events = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
        let captured = events.clone();
        let app = tauri::test::mock_builder()
            .channel_interceptor(move |_webview, _callback, _index, body| {
                captured
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .push(body.clone().deserialize().expect("channel event JSON"));
                true
            })
            .manage(state)
            .manage(crate::authorized_material::AuthorizedMaterialRuntime::new(
                database_path,
            ))
            .manage(ProviderConfigurationService::test_configured())
            .invoke_handler(tauri::generate_handler![
                stream_ai_text,
                cancel_ai_text_stream
            ])
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("mock WebView");

        tauri::test::get_ipc_response(
            &window,
            stream_ipc_request(
                &request_id,
                45,
                current_stream_receipts(&request_id, &material_path),
            ),
        )
        .expect("material gate command response")
        .deserialize::<()>()
        .expect("unit response");

        let events = events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["eventSequence"], 0);
        assert_eq!(events[0]["eventKind"], "failed");
        assert_eq!(events[0]["errorCode"], "material_type_unsupported");
        assert_eq!(
            app.state::<AIStreamingState>()
                .observed_test_provider_prompts()
                .len(),
            0
        );
        assert_eq!(app.state::<AIStreamingState>().active_count(), 0);
        std::fs::remove_dir_all(material_directory).expect("remove gate fixture");
    }

    #[test]
    fn real_tauri_cancel_ipc_wins_during_fixture_stream_and_suppresses_completion() {
        use std::sync::mpsc;
        use tauri::Manager;

        let request_id = unique_request_id("ipc-cancel");
        let database_directory = temporary_directory("ipc-cancel");
        let database_path = database_directory.join("labpod.sqlite3");
        let material_path = database_directory.join("single-start.txt");
        std::fs::write(&material_path, "single-start material sentinel")
            .expect("single-start material");
        seed_stream_attempt(&database_path, &request_id, Some(&material_path));
        let reviewed_receipts = current_stream_receipts(&request_id, &material_path);
        let state = AIStreamingState::default();
        state.install_test_provider_fixture(successful_fixture(std::time::Duration::from_secs(5)));
        let events = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
        let captured = events.clone();
        let (event_sender, event_receiver) = mpsc::channel::<serde_json::Value>();
        let app = tauri::test::mock_builder()
            .channel_interceptor(move |_webview, _callback, _index, body| {
                let event: serde_json::Value =
                    body.clone().deserialize().expect("channel event JSON");
                captured
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .push(event.clone());
                let _ = event_sender.send(event);
                true
            })
            .manage(state)
            .manage(crate::authorized_material::AuthorizedMaterialRuntime::new(
                database_path,
            ))
            .manage(ProviderConfigurationService::test_configured())
            .invoke_handler(tauri::generate_handler![
                stream_ai_text,
                cancel_ai_text_stream
            ])
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("mock WebView");
        let stream_window = window.clone();
        let stream_request_id = request_id.clone();
        let stream_reviewed_receipts = reviewed_receipts.clone();
        let stream_thread = std::thread::spawn(move || {
            tauri::test::get_ipc_response(
                &stream_window,
                stream_ipc_request(&stream_request_id, 43, stream_reviewed_receipts),
            )
        });

        loop {
            let event = event_receiver
                .recv_timeout(std::time::Duration::from_secs(2))
                .expect("started/delta event before cancel");
            if event["eventKind"] == "delta" {
                break;
            }
        }
        app.state::<AIStreamingState>()
            .install_test_provider_fixture(successful_fixture(std::time::Duration::ZERO));
        std::fs::remove_file(&material_path).expect("remove material before duplicate start");
        let duplicate_error = tauri::test::get_ipc_response(
            &window,
            stream_ipc_request(&request_id, 44, reviewed_receipts),
        )
        .expect_err("same CallAttempt must lose the backend start claim");
        let duplicate_debug = format!("{duplicate_error:?}");
        assert!(
            duplicate_debug.contains("material_attempt_already_owned_or_replayed"),
            "unexpected duplicate-start error: {duplicate_debug}"
        );
        assert_eq!(
            app.state::<AIStreamingState>()
                .observed_test_provider_prompts()
                .len(),
            1,
            "duplicate caller must not reach the provider"
        );
        let cancel_response =
            tauri::test::get_ipc_response(&window, cancel_ipc_request(&request_id))
                .expect("cancel IPC response")
                .deserialize::<serde_json::Value>()
                .expect("cancel JSON");
        assert_eq!(cancel_response["status"], "CANCEL_ACCEPTED");
        stream_thread
            .join()
            .expect("stream IPC thread")
            .expect("stream IPC response after cancel")
            .deserialize::<()>()
            .expect("unit response");

        let events = events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let kinds = events
            .iter()
            .map(|event| event["eventKind"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(kinds, vec!["started", "delta", "cancelled"]);
        assert_eq!(events.last().unwrap()["errorCode"], CANCELLED_ERROR_CODE);
        assert_eq!(app.state::<AIStreamingState>().active_count(), 0);
        std::fs::remove_dir_all(database_directory).expect("remove cancel IPC fixture");
    }
}
