import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..", "..");
const bundle = await build({
  stdin: {
    contents: 'export * from "./services/aiConversationApplicationService.ts"; export * from "./services/aiConstraintService.ts";',
    resolveDir: resolve(root, "src"),
    sourcefile: "lp13-a1-b1-ai-application-service-harness.ts"
  },
  plugins: [{
    name: "tauri-invoke-stub",
    setup(api) {
      api.onResolve({ filter: /^@tauri-apps\/api\/core$/u }, () => ({
        path: "tauri-core",
        namespace: "stub"
      }));
      api.onLoad({ filter: /^tauri-core$/u, namespace: "stub" }, () => ({
        contents: 'export class Channel { constructor(onmessage){ this.onmessage = onmessage; } } export async function invoke(){ throw new Error("unexpected production invoke in deterministic service test"); }'
      }));
    }
  }],
  bundle: true,
  loader: { ".md": "text" },
  write: false,
  format: "cjs",
  platform: "node",
  target: "es2022"
});
const harness = { exports: {} };
new Function("require", "module", "exports", bundle.outputFiles[0].text)(
  createRequire(import.meta.url),
  harness,
  harness.exports
);
const subject = harness.exports;

test("prepared first turn without an effective Assistant result is a valid empty projection", () => {
  const readback = {
    conversation: {
      id: "conversation-prepared", stableKey: "global-ai-chat/prepared",
      createdAt: "2026-08-14T12:00:00.000Z", updatedAt: "2026-08-14T12:00:00.000Z"
    },
    messages: [{
      id: "message-user-prepared", conversationId: "conversation-prepared", sequence: 1,
      role: "user", content: "question", createdAt: "2026-08-14T12:00:00.000Z"
    }],
    projectedMessages: [],
    callAttempts: [],
    retryRegenerate: {
      latestTurnId: "message-user-prepared", latestAttemptId: "attempt-prepared",
      latestAttemptStatus: "started", retryEligible: false, regenerateEligible: false,
      attachmentReauthorizationRequired: false, activeConflict: true, safeIntegrityState: "ok"
    }
  };
  assert.equal(subject.effectiveDurableResultFromReadback(readback), null);
  assert.throws(
    () => subject.effectiveDurableResultFromReadback({
      ...readback,
      retryRegenerate: {
        ...readback.retryRegenerate,
        effectiveAssistantMessageId: "message-assistant-without-source"
      }
    }),
    (error) => subject.isAIDurablePersistenceError(error) && error.phase === "post_provider"
  );
});

const contextPackage = {
  id: "context-1",
  version: "1",
  createdAt: "2026-08-13T12:00:00.000Z",
  scope: { type: "project", id: "project-1", label: "Project 1" },
  sections: [],
  sourceRefs: [],
  warnings: []
};

function normalConstraintSourceRef() {
  const descriptor = subject.resolveAIConstraintDescriptor("NORMAL_QA");
  return subject.createAIConstraintSourceRef(descriptor);
}

function invocationInput(requestId = "request-1") {
  return {
    conversationId: "ai-conversation-global-current-v1",
    purpose: "chat_response",
    requestId,
    promptText: "safe prompt",
    userMessageContent: "question",
    trace: {
      contextPackage,
      prompt: {
        id: `prompt-${requestId}`,
        createdAt: "2026-08-13T12:00:00.000Z"
      },
      sourceRefs: [normalConstraintSourceRef()],
      warnings: []
    }
  };
}

function successReadback(input, response) {
  const conversation = {
    id: "ai-conversation-global-current-v1",
    stableKey: "global-ai-chat/current/v1",
    createdAt: "2026-08-13T12:00:00.000Z",
    updatedAt: "2026-08-13T12:00:02.000Z"
  };
  const userMessage = {
    id: `ai-message-user-${input.requestId}`,
    conversationId: conversation.id,
    sequence: 1,
    role: "user",
    content: input.userMessageContent,
    createdAt: "2026-08-13T12:00:00.000Z"
  };
  const assistantMessage = {
    id: `ai-message-assistant-${input.requestId}`,
    conversationId: conversation.id,
    sequence: 2,
    role: "assistant",
    content: response.text,
    createdAt: "2026-08-13T12:00:01.000Z"
  };
  const attempt = {
    id: `ai-call-attempt-${input.requestId}`,
    requestId: input.requestId,
    conversationId: conversation.id,
    sequence: 1,
    purpose: input.purpose,
    triggerMessageId: userMessage.id,
    resultMessageId: assistantMessage.id,
    provider: response.provider,
    model: response.model,
    status: "succeeded",
    contextPackageId: input.trace.contextPackage.id,
    contextPackageVersion: input.trace.contextPackage.version,
    contextSourceRefs: input.trace.sourceRefs,
    warnings: input.trace.warnings,
    promptPackageId: input.trace.prompt.id,
    promptCreatedAt: input.trace.prompt.createdAt,
    startedAt: "2026-08-13T12:00:00.000Z",
    settledAt: "2026-08-13T12:00:02.000Z"
  };
  return { conversation, messages: [userMessage, assistantMessage], callAttempts: [attempt] };
}

function dependencies(overrides = {}) {
  const counters = {
    metadata: 0,
    prepare: 0,
    provider: 0,
    success: 0,
    failure: 0
  };
  const response = {
    text: "durable answer",
    provider: "deepseek",
    model: "deepseek-v4-flash"
  };
  let currentInput;
  let preparedReadback;
  const defaults = {
    repository: {
      async prepareCallAttempt(input) {
        counters.prepare += 1;
        currentInput = input;
        const conversation = {
          id: "ai-conversation-global-current-v1",
          stableKey: "global-ai-chat/current/v1",
          createdAt: input.startedAt,
          updatedAt: input.startedAt
        };
        const userMessage = {
          id: input.userMessage.id,
          conversationId: conversation.id,
          sequence: 1,
          role: "user",
          content: input.userMessage.content,
          createdAt: input.userMessage.createdAt
        };
        const attempt = {
          id: input.attemptId,
          requestId: input.requestId,
          conversationId: conversation.id,
          sequence: 1,
          purpose: input.purpose,
          triggerMessageId: userMessage.id,
          provider: input.provider,
          model: input.model,
          status: "started",
          contextPackageId: input.contextPackageId,
          contextPackageVersion: input.contextPackageVersion,
          contextSourceRefs: input.contextSourceRefs,
          warnings: input.warnings,
          promptPackageId: input.promptPackageId,
          promptCreatedAt: input.promptCreatedAt,
          startedAt: input.startedAt
        };
        preparedReadback = {
          conversation,
          messages: [userMessage],
          callAttempts: [attempt]
        };
        return {
          providerInvocationAuthorized: true,
          readback: preparedReadback
        };
      },
      async settleCallAttemptSuccess(settlement) {
        counters.success += 1;
        const input = invocationInput(currentInput.requestId);
        const readback = successReadback(input, response);
        return {
          ...readback,
          messages: readback.messages.map((message) => message.role === "assistant"
            ? { ...message, createdAt: settlement.assistantMessage.createdAt }
            : message),
          callAttempts: readback.callAttempts.map((attempt) => ({
            ...attempt,
            provider: settlement.provider,
            model: settlement.model,
            responseTruncated: settlement.responseTruncated,
            usageInputTokens: settlement.usage?.inputTokens,
            usageOutputTokens: settlement.usage?.outputTokens,
            usageTotalTokens: settlement.usage?.totalTokens,
            settledAt: settlement.settledAt
          }))
        };
      },
      async settleCallAttemptFailure(input) {
        counters.failure += 1;
        return {
          ...preparedReadback,
          callAttempts: preparedReadback.callAttempts.map((attempt) => ({
            ...attempt,
            status: "failed",
            errorCode: input.errorCode,
            errorMessage: input.errorMessage,
            errorRetryable: input.errorRetryable,
            providerStatus: input.providerStatus,
            settledAt: input.settledAt
          }))
        };
      },
      async readConversation() {
        return preparedReadback;
      }
    },
    async getProviderConfigurationStatus() {
      counters.metadata += 1;
      return {
        provider: "deepseek",
        model: "deepseek-v4-flash",
        configurationRevision: 17,
        eligibility: "eligible",
        effectiveConfigured: true,
        configuredSource: "app_config",
        appOverrideConfigured: true,
        localConfigurationState: "valid",
        validationState: "unverified"
      };
    },
    async runProvider(_prompt, expectedConfigurationRevision) {
      counters.provider += 1;
      assert.equal(expectedConfigurationRevision, 17);
      return response;
    },
    normalizeProviderError() {
      return {
        code: "timeout",
        title: "timeout",
        message: "safe timeout",
        suggestion: "retry",
        retryable: true
      };
    },
    validatePromptText(prompt) {
      return prompt.trim()
        ? { ok: true, value: prompt.trim() }
        : {
            ok: false,
            error: { code: "invalid_prompt", message: "invalid", retryable: false }
          };
    },
    async awaitProviderAdmission() {},
    now: () => "2026-08-13T12:00:00.000Z"
  };
  const configured = {
    ...defaults,
    ...overrides,
    repository: { ...defaults.repository, ...(overrides.repository ?? {}) }
  };
  return { configured, counters, response };
}

test("context/prompt validation failure creates no attempt and invokes no provider", async () => {
  const { configured, counters } = dependencies({
    validatePromptText() {
      return {
        ok: false,
        error: { code: "invalid_prompt", message: "invalid", retryable: false }
      };
    }
  });
  const run = subject.createDurableAIInvocationRunner(configured);
  await assert.rejects(run(invocationInput()), (error) => error.code === "invalid_prompt");
  assert.deepEqual(counters, { metadata: 0, prepare: 0, provider: 0, success: 0, failure: 0 });
});

test("missing configuration blocks Chat and Action Draft before durable preparation", async () => {
  const { configured, counters } = dependencies({
    async getProviderConfigurationStatus() {
      counters.metadata += 1;
      return {
        provider: "deepseek",
        model: "deepseek-v4-flash",
        configurationRevision: 17,
        eligibility: "blocked",
        effectiveConfigured: false,
        configuredSource: "none",
        appOverrideConfigured: false,
        localConfigurationState: "valid",
        validationState: "unverified"
      };
    }
  });
  const run = subject.createDurableAIInvocationRunner(configured);
  await assert.rejects(
    run(invocationInput("missing-chat")),
    (error) => error instanceof subject.AIProviderConfigurationPreGateError &&
      error.code === "missing_api_key"
  );
  const actionDraftInput = {
    ...invocationInput("missing-action-draft"),
    purpose: "action_draft_generation",
    triggerMessageId: "assistant-message",
    triggerCallAttemptId: "ordinary-attempt"
  };
  delete actionDraftInput.userMessageContent;
  actionDraftInput.trace = { ...actionDraftInput.trace, sourceRefs: [] };
  await assert.rejects(
    run(actionDraftInput),
    (error) => error instanceof subject.AIProviderConfigurationPreGateError &&
      error.code === "missing_api_key"
  );
  assert.equal(counters.metadata, 2);
  assert.equal(counters.prepare, 0);
  assert.equal(counters.provider, 0);
  assert.equal(counters.success, 0);
  assert.equal(counters.failure, 0);
});

test("pre-provider persistence failure prevents provider invocation", async () => {
  const { configured, counters } = dependencies({
    repository: {
      async prepareCallAttempt() {
        counters.prepare += 1;
        throw new Error("injected pre-provider failure");
      }
    }
  });
  const run = subject.createDurableAIInvocationRunner(configured);
  await assert.rejects(
    run(invocationInput()),
    (error) => error instanceof subject.AIDurablePersistenceError && error.phase === "pre_provider"
  );
  assert.equal(counters.provider, 0);
  assert.equal(counters.success, 0);
  assert.equal(counters.failure, 0);
});

test("provider auth rejection has one attempt, durable failure, no fallback retry, and no fake success", async () => {
  const providerError = { code: "auth_error", message: "safe authentication rejection" };
  const { configured, counters } = dependencies({
    async runProvider() {
      counters.provider += 1;
      throw providerError;
    }
  });
  const run = subject.createDurableAIInvocationRunner(configured);
  await assert.rejects(run(invocationInput()), (error) => error === providerError);
  assert.equal(counters.provider, 1);
  assert.equal(counters.failure, 1);
  assert.equal(counters.success, 0);
});

test("post-provider settlement failure is visible and invokes fail-closed terminalization", async () => {
  const { configured, counters } = dependencies({
    repository: {
      async settleCallAttemptSuccess() {
        counters.success += 1;
        throw new Error("injected post-provider failure");
      }
    }
  });
  const run = subject.createDurableAIInvocationRunner(configured);
  await assert.rejects(
    run(invocationInput()),
    (error) => error instanceof subject.AIDurablePersistenceError && error.phase === "post_provider"
  );
  assert.equal(counters.provider, 1);
  assert.equal(counters.success, 1);
  assert.equal(counters.failure, 1);
});

test("successful UI result is reconstructed from authoritative settlement readback", async () => {
  const { configured, counters, response } = dependencies();
  const run = subject.createDurableAIInvocationRunner(configured);
  const result = await run(invocationInput());
  assert.equal(counters.provider, 1);
  assert.equal(counters.success, 1);
  assert.equal(result.response.text, response.text);
  assert.equal(result.resultMessage.content, response.text);
  assert.equal(result.callAttempt.status, "succeeded");
  assert.equal(result.response, result.response);
});

test("one explicit request identity deduplicates concurrent adapters", async () => {
  let releaseProvider;
  const providerGate = new Promise((resolvePromise) => {
    releaseProvider = resolvePromise;
  });
  const { configured, counters, response } = dependencies({
    async runProvider() {
      counters.provider += 1;
      await providerGate;
      return response;
    }
  });
  const run = subject.createDurableAIInvocationRunner(configured);
  const input = invocationInput("request-deduplicated");
  const first = run(input);
  const second = run(input);
  assert.equal(first, second);
  releaseProvider();
  const [left, right] = await Promise.all([first, second]);
  assert.equal(left.callAttempt.id, right.callAttempt.id);
  assert.equal(counters.prepare, 1);
  assert.equal(counters.provider, 1);
  assert.equal(counters.success, 1);
});
