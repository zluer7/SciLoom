import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..", "..");
const storageValues = new Map();
globalThis.window = {
  localStorage: {
    getItem(key) {
      return storageValues.get(key) ?? null;
    },
    setItem(key, value) {
      storageValues.set(key, String(value));
    },
    removeItem(key) {
      storageValues.delete(key);
    },
    clear() {
      storageValues.clear();
    },
    key(index) {
      return [...storageValues.keys()][index] ?? null;
    },
    get length() {
      return storageValues.size;
    }
  },
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {}
};

const bundle = await build({
  stdin: {
    contents: `
      export * from "./services/aiConversationApplicationService.ts";
      export * from "./services/aiParseDraftService.ts";
      export * from "./services/aiStandardResultService.ts";
      export * from "./services/aiConstraintService.ts";
      export * from "./services/aiErrorService.ts";
      export {
        PLANNING_STORAGE_KEY,
        createEmptyPlanningData,
        normalizePlanningPersistenceData
      } from "./services/planningRepository.ts";
    `,
    resolveDir: resolve(root, "src"),
    sourcefile: "lp15-a3-r4-parse-mechanical-retry-harness.ts"
  },
  plugins: [{
    name: "tauri-invoke-stub",
    setup(api) {
      api.onResolve({ filter: /^@tauri-apps\/api\/core$/u }, () => ({
        path: "tauri-core",
        namespace: "stub"
      }));
      api.onLoad({ filter: /^tauri-core$/u, namespace: "stub" }, () => ({
        contents: 'export class Channel { constructor(onmessage){ this.onmessage = onmessage; } } export async function invoke(){ throw new Error("unexpected production invoke in R4 controlled test"); }'
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

const NOW = "2026-09-04T12:00:00.000Z";
const PROJECT_ID = "project-lp15-a3-r4";
const CONVERSATION_ID = "conversation-lp15-a3-r4";
const CHAT_ATTEMPT_ID = "attempt-lp15-a3-r4-chat";
const USER_MESSAGE_ID = "message-lp15-a3-r4-user";
const ASSISTANT_MESSAGE_ID = "message-lp15-a3-r4-assistant";

const planningSnapshot = subject.normalizePlanningPersistenceData({
  ...subject.createEmptyPlanningData(NOW),
  projects: [{
    id: PROJECT_ID,
    title: "LP15-A3-R4 Synthetic Project",
    description: "Task-owned controlled test scope.",
    tags: [],
    status: "active",
    priority: "medium",
    orderIndex: 0,
    source: "user",
    schemaVersion: 1,
    createdAt: NOW,
    updatedAt: NOW
  }]
});
storageValues.set(subject.PLANNING_STORAGE_KEY, JSON.stringify({
  envelopeVersion: 1,
  repositoryEpoch: "11111111-1111-4111-8111-111111111111",
  revision: "0",
  snapshot: planningSnapshot
}));

function contextPackage() {
  return {
    id: "context-lp15-a3-r4",
    version: "lp15-a3-r4-v1",
    createdAt: NOW,
    scope: { type: "project", id: PROJECT_ID, label: "LP15-A3-R4 Synthetic Project" },
    contextMode: "BRIEF",
    compositionPolicy: "DEFAULT",
    researchObjects: [],
    materialDecisions: [],
    approvedContextRequestContributions: [],
    requestableRefs: [],
    sections: [{
      id: "project",
      title: "Current Project",
      module: "project",
      priority: "critical",
      charCount: 120,
      budgetUsed: 120,
      truncated: false,
      sourceRefs: [],
      items: [{
        id: PROJECT_ID,
        title: "LP15-A3-R4 Synthetic Project",
        summary: "Minimal controlled retry fixture.",
        module: "project",
        entityType: "project",
        sourceRefs: [],
        priority: "critical",
        charCount: 120,
        sendable: true,
        truncated: false
      }]
    }],
    sourceRefs: [],
    warnings: [],
    excluded: [],
    reviewFingerprint: "review-lp15-a3-r4",
    budget: {
      maxChars: 15_000,
      reservedForUserQuestion: 0,
      reservedForSystemInstruction: 0,
      strategy: "balanced"
    },
    budgetSummary: {
      maxChars: 15_000,
      usedChars: 120,
      remainingChars: 14_880,
      truncatedSections: 0,
      truncatedItems: 0,
      excludedItems: 0,
      notes: []
    }
  };
}

function initialReadback() {
  const user = {
    id: USER_MESSAGE_ID,
    conversationId: CONVERSATION_ID,
    sequence: 1,
    role: "user",
    content: "请提出一个短期合成任务草稿。",
    messageKind: "text",
    createdAt: NOW
  };
  const assistant = {
    id: ASSISTANT_MESSAGE_ID,
    conversationId: CONVERSATION_ID,
    sequence: 2,
    role: "assistant",
    content: "建议创建一个短期校准任务，并保持为待确认草稿。",
    messageKind: "text",
    createdAt: NOW
  };
  const normalDescriptor = subject.resolveAIConstraintDescriptor("NORMAL_QA");
  return {
    conversation: {
      id: CONVERSATION_ID,
      stableKey: "global-ai-chat/lp15-a3-r4",
      createdAt: NOW,
      updatedAt: NOW
    },
    messages: [user, assistant],
    projectedMessages: [structuredClone(user), structuredClone(assistant)],
    callAttempts: [{
      id: CHAT_ATTEMPT_ID,
      requestId: CHAT_ATTEMPT_ID,
      conversationId: CONVERSATION_ID,
      sequence: 1,
      purpose: "chat_response",
      triggerMessageId: USER_MESSAGE_ID,
      resultMessageId: ASSISTANT_MESSAGE_ID,
      provider: "deepseek",
      model: "deepseek-v4-flash",
      status: "succeeded",
      contextPackageId: "context-chat-r4",
      contextPackageVersion: "1",
      contextSourceRefs: [subject.createAIConstraintSourceRef(normalDescriptor)],
      warnings: [],
      promptPackageId: "prompt-chat-r4",
      promptCreatedAt: NOW,
      responseTruncated: false,
      startedAt: NOW,
      settledAt: NOW,
      authorizedFileRefs: []
    }],
    contextRequests: [],
    standardResults: [],
    retryRegenerate: {
      latestTurnId: USER_MESSAGE_ID,
      effectiveAssistantMessageId: ASSISTANT_MESSAGE_ID,
      effectiveSourceAttemptId: CHAT_ATTEMPT_ID,
      latestAttemptId: CHAT_ATTEMPT_ID,
      latestAttemptStatus: "succeeded",
      retryEligible: false,
      regenerateEligible: true,
      attachmentReauthorizationRequired: false,
      activeConflict: false,
      safeIntegrityState: "ok"
    }
  };
}

async function invocationInput(requestId = "attempt-lp15-a3-r4-parse") {
  const readback = initialReadback();
  const context = contextPackage();
  const built = await subject.buildAIParseDraftPromptPackage({
    conversationId: CONVERSATION_ID,
    contextPackage: context,
    technicalCapacityChars: 45_000,
    readback,
    outputDetailPreference: "STANDARD"
  });
  assert.equal(
    built.promptPackage.warnings?.some((warning) => warning.severity === "error") ?? false,
    false
  );
  return {
    readback,
    input: {
      conversationId: CONVERSATION_ID,
      purpose: "parse_draft",
      requestId,
      triggerMessageId: built.source.triggerMessageId,
      triggerCallAttemptId: built.source.triggerCallAttemptId,
      promptText: built.promptPackage.finalPrompt,
      promptEnvelope: built.promptPackage.providerPromptEnvelope,
      authorizedFileRefIds: [],
      trace: subject.buildDurableAIInvocationTrace(
        context,
        {
          id: built.promptPackage.id,
          createdAt: built.promptPackage.createdAt
        },
        {
          sourceRefs: built.promptPackage.sourceRefs,
          warnings: built.promptPackage.warnings,
          budgetSummary: built.promptPackage.budgetSummary,
          parseDraftSource: built.source
        }
      )
    }
  };
}

function validOutcome(title = "R4 synthetic short-term task") {
  return JSON.stringify({
    outcome: "STANDARD_RESULT_BATCH",
    batch: {
      version: 1,
      results: [{
        category: "DATA_OPERATION",
        action: "CREATE",
        target: { projectId: PROJECT_ID, entityType: "task" },
        payload: {
          _labpod: {
            protocol: "labpod-standard-result-proposal-v1",
            originalOrdinal: 1,
            proposalRef: "r4-proposal-1"
          },
          title,
          description: "Controlled R4 suggestion only; never execute.",
          priority: "medium",
          status: "todo",
          taskType: "other",
          timeBucket: "this_week",
          tags: ["lp15-a3-r4"]
        }
      }]
    }
  });
}

function countInvalidOutcome() {
  return JSON.stringify({
    outcome: "STANDARD_RESULT_BATCH",
    batch: { version: 1, results: [] }
  });
}

function manuscriptEffectInvalidOutcome() {
  const decoded = JSON.parse(validOutcome());
  decoded.batch.results[0].payload.manuscriptEffects = [];
  return JSON.stringify(decoded);
}

function completedEvent(request, text) {
  return {
    requestId: request.requestId,
    callAttemptId: request.callAttemptId,
    conversationId: request.conversationId,
    triggerMessageId: request.triggerMessageId,
    eventKind: "completed",
    eventSequence: 1,
    text,
    provider: "deepseek",
    model: "deepseek-v4-flash",
    finishReason: "stop",
    truncated: false
  };
}

function failedEvent(request, code) {
  return {
    requestId: request.requestId,
    callAttemptId: request.callAttemptId,
    conversationId: request.conversationId,
    triggerMessageId: request.triggerMessageId,
    eventKind: code === "cancelled" ? "cancelled" : "failed",
    eventSequence: 1,
    errorCode: code,
    errorMessage: `controlled ${code}`,
    errorRetryable: code !== "auth_error",
    ...(code === "provider_error" ? { providerStatus: 503 } : {})
  };
}

function createControlledDependencies(initial, responseSpecs, options = {}) {
  let state = structuredClone(initial);
  let providerIndex = 0;
  let statusIndex = 0;
  const requests = [];
  const preparedInputs = [];
  const counters = {
    metadata: 0,
    prepare: 0,
    provider: 0,
    success: 0,
    failure: 0,
    cancel: 0
  };
  const statuses = options.configurationStatuses ?? [{
    provider: "deepseek",
    model: "deepseek-v4-flash",
    activeProvider: "deepseek",
    activeModel: "deepseek-v4-flash",
    hasExplicitActiveTuple: true,
    availablePresets: [],
    configurationRevision: 41,
    eligibility: "eligible",
    effectiveConfigured: true,
    configuredSource: "app_config",
    appOverrideConfigured: true,
    localConfigurationState: "valid",
    validationState: "unverified"
  }];

  function cloneState() {
    return structuredClone(state);
  }

  const repository = {
    async prepareCallAttempt(input) {
      counters.prepare += 1;
      preparedInputs.push(structuredClone(input));
      const existing = state.callAttempts.find((attempt) => attempt.requestId === input.requestId);
      if (existing) {
        return { providerInvocationAuthorized: false, readback: cloneState() };
      }
      state.callAttempts.push({
        id: input.attemptId,
        requestId: input.requestId,
        conversationId: input.conversationId,
        sequence: Math.max(...state.callAttempts.map((attempt) => attempt.sequence), 0) + 1,
        purpose: input.purpose,
        triggerMessageId: input.triggerMessageId,
        triggerCallAttemptId: input.triggerCallAttemptId,
        provider: input.provider,
        model: input.model,
        status: "started",
        contextPackageId: input.contextPackageId,
        contextPackageVersion: input.contextPackageVersion,
        contextSourceRefs: structuredClone(input.contextSourceRefs),
        warnings: structuredClone(input.warnings),
        budgetSummary: structuredClone(input.budgetSummary),
        promptPackageId: input.promptPackageId,
        promptCreatedAt: input.promptCreatedAt,
        startedAt: input.startedAt,
        authorizedFileRefs: []
      });
      state.conversation.updatedAt = input.startedAt;
      return { providerInvocationAuthorized: true, readback: cloneState() };
    },
    async prepareRetryRegenerateCallAttempt() {
      throw new Error("unexpected Retry/Regenerate preparation");
    },
    async prepareContextRequestFollowup() {
      throw new Error("unexpected Context Request continuation preparation");
    },
    async settleCallAttemptFailure(input) {
      counters.failure += 1;
      state.callAttempts = state.callAttempts.map((attempt) =>
        attempt.id === input.attemptId && attempt.status === "started"
          ? {
              ...attempt,
              status: "failed",
              errorCode: input.errorCode,
              errorMessage: input.errorMessage,
              errorRetryable: input.errorRetryable,
              providerStatus: input.providerStatus,
              settledAt: input.settledAt
            }
          : attempt
      );
      return cloneState();
    },
    async settleCallAttemptSuccess(input) {
      counters.success += 1;
      state.callAttempts = state.callAttempts.map((attempt) =>
        attempt.id === input.attemptId && attempt.status === "started"
          ? {
              ...attempt,
              status: "succeeded",
              provider: input.provider,
              model: input.model,
              responseTruncated: input.responseTruncated,
              usageInputTokens: input.usage?.inputTokens,
              usageOutputTokens: input.usage?.outputTokens,
              usageTotalTokens: input.usage?.totalTokens,
              settledAt: input.settledAt
            }
          : attempt
      );
      if (input.standardResultBatch) {
        state.standardResults.push(...input.standardResultBatch.results.map((result) => ({
          ...structuredClone(result),
          batchId: input.standardResultBatch.id,
          conversationId: CONVERSATION_ID,
          parseCallAttemptId: input.attemptId,
          disposition: "PENDING",
          createdAt: input.standardResultBatch.createdAt,
          updatedAt: input.standardResultBatch.createdAt
        })));
      }
      return cloneState();
    },
    async readConversation() {
      return cloneState();
    }
  };

  const dependencies = {
    repository,
    async getProviderConfigurationStatus() {
      counters.metadata += 1;
      const status = statuses[Math.min(statusIndex, statuses.length - 1)];
      statusIndex += 1;
      return structuredClone(status);
    },
    startProvider(request) {
      counters.provider += 1;
      requests.push(structuredClone(request));
      const spec = responseSpecs[providerIndex++];
      if (!spec) throw new Error("unexpected third Provider call");
      const terminal = spec.kind === "completed"
        ? completedEvent(request, spec.text)
        : failedEvent(request, spec.code);
      return {
        completion: Promise.resolve(terminal),
        async cancel() {
          counters.cancel += 1;
          return {
            requestId: request.requestId,
            callAttemptId: request.callAttemptId,
            status: "ACTIVE_REQUEST_NOT_FOUND"
          };
        }
      };
    },
    normalizeProviderError: subject.normalizeAIError,
    validatePromptText(prompt) {
      return prompt.trim()
        ? { ok: true, value: prompt.trim() }
        : { ok: false, error: { code: "invalid_prompt", message: "invalid", retryable: false } };
    },
    async awaitProviderAdmission() {},
    now: () => NOW
  };
  return {
    dependencies,
    counters,
    requests,
    preparedInputs,
    readState: cloneState
  };
}

function parseFailure(code) {
  return new subject.AIStandardResultContractError(code, `typed ${code}`);
}

test("typed allowlist is exact and every non-mechanical class is excluded without text matching", () => {
  for (const code of [
    "STANDARD_RESULT_COUNT_INVALID",
    "STANDARD_RESULT_MANUSCRIPT_EFFECT_INVALID"
  ]) {
    assert.deepEqual(subject.classifyAIParseMechanicalRetryFailure({
      purpose: "parse_draft",
      providerResponseCompleted: true,
      responseTruncated: false,
      parserError: parseFailure(code),
      acceptedStandardResultCount: 0,
      automaticRetryAlreadyUsed: false
    }), { eligible: true, code });
  }

  const excludedErrors = [
    { code: "invalid_response", message: "STANDARD_RESULT_COUNT_INVALID", retryable: true },
    { code: "network_error", message: "network", retryable: true },
    { code: "auth_error", message: "credential", retryable: false },
    { code: "cancelled", message: "cancelled", retryable: true },
    { code: "technical_capacity_or_safety_error", message: "capacity", retryable: false },
    { code: "material_not_authorized", message: "authorization", retryable: false },
    { code: "unknown_error", message: "unknown", retryable: true },
    new Error("STANDARD_RESULT_MANUSCRIPT_EFFECT_INVALID localized text only"),
    parseFailure("PARSE_OUTCOME_INVALID_JSON")
  ];
  for (const parserError of excludedErrors) {
    assert.deepEqual(subject.classifyAIParseMechanicalRetryFailure({
      purpose: "parse_draft",
      providerResponseCompleted: true,
      responseTruncated: false,
      parserError,
      acceptedStandardResultCount: 0,
      automaticRetryAlreadyUsed: false
    }), { eligible: false });
  }
  for (const overrides of [
    { purpose: "chat_response" },
    { providerResponseCompleted: false },
    { responseTruncated: true },
    { acceptedStandardResultCount: 1 },
    { automaticRetryAlreadyUsed: true }
  ]) {
    assert.deepEqual(subject.classifyAIParseMechanicalRetryFailure({
      purpose: "parse_draft",
      providerResponseCompleted: true,
      responseTruncated: false,
      parserError: parseFailure("STANDARD_RESULT_COUNT_INVALID"),
      acceptedStandardResultCount: 0,
      automaticRetryAlreadyUsed: false,
      ...overrides
    }), { eligible: false });
  }
});

test("a valid first Parse response settles once with no automatic retry", async () => {
  const prepared = await invocationInput("attempt-r4-first-valid");
  const controlled = createControlledDependencies(prepared.readback, [
    { kind: "completed", text: validOutcome("first-attempt-valid") }
  ]);
  let retryPrepared = 0;
  const run = subject.createDurableAIStreamingInvocationRunner(controlled.dependencies);
  const handle = await run({
    ...prepared.input,
    onParseMechanicalRetryPrepared() {
      retryPrepared += 1;
    }
  });
  const result = await handle.completion;
  assert.equal(controlled.counters.provider, 1);
  assert.equal(controlled.counters.failure, 0);
  assert.equal(controlled.counters.success, 1);
  assert.equal(retryPrepared, 0);
  assert.equal(result.callAttempt.id, "attempt-r4-first-valid");
  assert.equal(controlled.readState().standardResults.length, 1);
});

test("STANDARD_RESULT_COUNT_INVALID durably fails first, retries once, and settles one result", async () => {
  const prepared = await invocationInput("attempt-r4-count-first");
  const controlled = createControlledDependencies(prepared.readback, [
    { kind: "completed", text: countInvalidOutcome() },
    { kind: "completed", text: validOutcome("count-retry-success") }
  ]);
  const retryAttempts = [];
  const run = subject.createDurableAIStreamingInvocationRunner(controlled.dependencies);
  const handle = await run({
    ...prepared.input,
    onParseMechanicalRetryPrepared(callAttemptId) {
      retryAttempts.push(callAttemptId);
    }
  });
  const result = await handle.completion;
  const state = controlled.readState();
  assert.equal(controlled.counters.provider, 2);
  assert.equal(controlled.counters.prepare, 2);
  assert.equal(controlled.counters.failure, 1);
  assert.equal(controlled.counters.success, 1);
  assert.equal(state.callAttempts.filter((attempt) => attempt.status === "failed").length, 1);
  assert.equal(state.callAttempts.find((attempt) =>
    attempt.id === "attempt-r4-count-first").errorCode, "invalid_response");
  assert.equal(state.standardResults.length, 1);
  assert.equal(state.standardResults[0].parseCallAttemptId, result.callAttempt.id);
  assert.notEqual(result.callAttempt.id, "attempt-r4-count-first");
  assert.deepEqual(retryAttempts, [result.callAttempt.id]);
  assert.equal(controlled.preparedInputs[1].triggerCallAttemptId, "attempt-r4-count-first");

  const firstRequest = controlled.requests[0];
  const retryRequest = controlled.requests[1];
  assert.equal(firstRequest.expectedConfigurationRevision, 41);
  assert.equal(retryRequest.expectedConfigurationRevision, 41);
  assert.equal(firstRequest.responseFormat.type, "json_object");
  assert.deepEqual(retryRequest.responseFormat, firstRequest.responseFormat);
  assert.equal(retryRequest.conversationId, firstRequest.conversationId);
  assert.equal(retryRequest.triggerMessageId, firstRequest.triggerMessageId);
  const firstEnvelope = structuredClone(firstRequest.promptEnvelope);
  const retryEnvelope = structuredClone(retryRequest.promptEnvelope);
  const firstDirective = firstEnvelope.runScopedDirective;
  const retryDirective = retryEnvelope.runScopedDirective;
  delete firstEnvelope.runScopedDirective;
  delete retryEnvelope.runScopedDirective;
  assert.deepEqual(retryEnvelope, firstEnvelope);
  assert.ok(retryDirective.startsWith(firstDirective));
  assert.ok(retryDirective.includes(subject.AI_PARSE_MECHANICAL_RETRY_DIRECTIVE));
  assert.ok(retryDirective.includes("STANDARD_RESULT_COUNT_INVALID"));
  assert.equal(retryDirective.split(subject.AI_PARSE_MECHANICAL_RETRY_DIRECTIVE).length - 1, 1);
});

test("STANDARD_RESULT_MANUSCRIPT_EFFECT_INVALID may retry only once and the retry's real failure is terminal", async () => {
  const prepared = await invocationInput("attempt-r4-manuscript-first");
  const controlled = createControlledDependencies(prepared.readback, [
    { kind: "completed", text: manuscriptEffectInvalidOutcome() },
    { kind: "completed", text: manuscriptEffectInvalidOutcome() }
  ]);
  const run = subject.createDurableAIStreamingInvocationRunner(controlled.dependencies);
  const handle = await run(prepared.input);
  await assert.rejects(handle.completion, (error) => error.code === "invalid_response");
  const state = controlled.readState();
  assert.equal(controlled.counters.provider, 2);
  assert.equal(controlled.counters.failure, 2);
  assert.equal(controlled.counters.success, 0);
  assert.equal(state.callAttempts.filter((attempt) => attempt.status === "failed").length, 2);
  assert.equal(state.standardResults.length, 0);
  assert.ok(controlled.requests[1].promptEnvelope.runScopedDirective
    .includes("STANDARD_RESULT_MANUSCRIPT_EFFECT_INVALID"));
});

test("transport/network failure remains its own terminal class and never enters mechanical retry", async () => {
  const prepared = await invocationInput("attempt-r4-network");
  const controlled = createControlledDependencies(prepared.readback, [
    { kind: "failed", code: "network_error" }
  ]);
  let retryPrepared = 0;
  const run = subject.createDurableAIStreamingInvocationRunner(controlled.dependencies);
  const handle = await run({
    ...prepared.input,
    onParseMechanicalRetryPrepared() {
      retryPrepared += 1;
    }
  });
  await assert.rejects(handle.completion, (error) => error.code === "network_error");
  assert.equal(controlled.counters.provider, 1);
  assert.equal(controlled.counters.failure, 1);
  assert.equal(controlled.counters.success, 0);
  assert.equal(retryPrepared, 0);
  assert.equal(controlled.readState().standardResults.length, 0);
});

test("concurrent replay of one logical Parse identity shares one bounded retry and one settlement", async () => {
  const prepared = await invocationInput("attempt-r4-deduplicated");
  const controlled = createControlledDependencies(prepared.readback, [
    { kind: "completed", text: countInvalidOutcome() },
    { kind: "completed", text: validOutcome("deduplicated-retry-success") }
  ]);
  const run = subject.createDurableAIStreamingInvocationRunner(controlled.dependencies);
  const first = run(prepared.input);
  const second = run(prepared.input);
  assert.equal(first, second);
  const [firstHandle, secondHandle] = await Promise.all([first, second]);
  const [left, right] = await Promise.all([firstHandle.completion, secondHandle.completion]);
  assert.equal(left.callAttempt.id, right.callAttempt.id);
  assert.equal(controlled.counters.provider, 2);
  assert.equal(controlled.counters.failure, 1);
  assert.equal(controlled.counters.success, 1);
  assert.equal(controlled.readState().standardResults.length, 1);
});

test("Provider/model/configuration revision drift blocks the retry before preparation or transport", async () => {
  const prepared = await invocationInput("attempt-r4-configuration-drift");
  const baseStatus = {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    activeProvider: "deepseek",
    activeModel: "deepseek-v4-flash",
    hasExplicitActiveTuple: true,
    availablePresets: [],
    configurationRevision: 41,
    eligibility: "eligible",
    effectiveConfigured: true,
    configuredSource: "app_config",
    appOverrideConfigured: true,
    localConfigurationState: "valid",
    validationState: "unverified"
  };
  const controlled = createControlledDependencies(prepared.readback, [
    { kind: "completed", text: countInvalidOutcome() }
  ], {
    configurationStatuses: [baseStatus, { ...baseStatus, configurationRevision: 42 }]
  });
  const run = subject.createDurableAIStreamingInvocationRunner(controlled.dependencies);
  const handle = await run(prepared.input);
  await assert.rejects(handle.completion, (error) => error.code === "configuration_changed");
  assert.equal(controlled.counters.metadata, 2);
  assert.equal(controlled.counters.prepare, 1);
  assert.equal(controlled.counters.provider, 1);
  assert.equal(controlled.counters.failure, 1);
  assert.equal(controlled.readState().standardResults.length, 0);
});

test("cancellation is terminal and cannot trigger the mechanical retry branch", async () => {
  const prepared = await invocationInput("attempt-r4-cancelled");
  const controlled = createControlledDependencies(prepared.readback, []);
  controlled.dependencies.startProvider = (request) => {
    controlled.counters.provider += 1;
    controlled.requests.push(structuredClone(request));
    let resolveTerminal;
    const completion = new Promise((resolvePromise) => {
      resolveTerminal = resolvePromise;
    });
    return {
      completion,
      async cancel() {
        controlled.counters.cancel += 1;
        resolveTerminal(failedEvent(request, "cancelled"));
        return {
          requestId: request.requestId,
          callAttemptId: request.callAttemptId,
          status: "CANCEL_ACCEPTED"
        };
      }
    };
  };
  const run = subject.createDurableAIStreamingInvocationRunner(controlled.dependencies);
  const handle = await run(prepared.input);
  const cancellation = await handle.cancel();
  assert.equal(cancellation.status, "CANCEL_ACCEPTED");
  await assert.rejects(handle.completion, (error) => error.code === "cancelled");
  assert.equal(controlled.counters.provider, 1);
  assert.equal(controlled.counters.failure, 1);
  assert.equal(controlled.counters.success, 0);
  assert.equal(controlled.readState().standardResults.length, 0);
});

test("terminal feedback classification preserves retry attempt failure classes", () => {
  for (const code of [
    "invalid_response",
    "network_error",
    "auth_error",
    "cancelled",
    "technical_capacity_or_safety_error",
    "material_not_authorized",
    "provider_error",
    "unknown_error"
  ]) {
    const normalized = subject.normalizeAIError({
      code,
      message: `controlled ${code}`,
      retryable: code !== "auth_error"
    });
    assert.equal(normalized.code, code);
  }
});
