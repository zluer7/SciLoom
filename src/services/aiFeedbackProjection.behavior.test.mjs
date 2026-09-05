import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import ts from "typescript";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const root = resolve(import.meta.dirname, "../..");
const read = (file) => readFileSync(resolve(root, file), "utf8");
const globalPanel = "src/components/ai/GlobalAIChatPanel.tsx";
const settingsPanel = "src/components/settings/AIProviderSettingsPanel.tsx";
const ports = { language: "zh-CN" };
globalThis.c7TestPorts = ports;
const bundle = await build({
  stdin: {
    contents: `
      export * from './services/aiErrorService.ts';
      export * from './services/writeFeedbackDisplayService.ts';
      export * from './services/refreshEventService.ts';
      export * from './components/settings/AIProviderSettingsPanel.tsx';
    `,
    resolveDir: resolve(root, "src")
  },
  plugins: [{
    name: "isolated-settings-ports",
    setup(api) {
      api.onResolve({ filter: /\/aiProviderConfigurationClient$/u }, () => ({ path: "settings", namespace: "test-port" }));
      api.onResolve({ filter: /\/I18nProvider$/u }, () => ({ path: "i18n", namespace: "test-port" }));
      api.onLoad({ filter: /.*/u, namespace: "test-port" }, ({ path }) => ({ contents: path === "i18n"
        ? `const t = key => key; export function useI18n(){ return { language: globalThis.c7TestPorts.language, t }; }`
        : `export const getAIProviderConfigurationStatus = (...args) => globalThis.c7TestPorts.readStatus(...args);
           export const setAIProviderApiKey = (...args) => globalThis.c7TestPorts.setKey(...args);
           export const saveAIProviderActiveTuple = (...args) => globalThis.c7TestPorts.saveTuple(...args);
           export const clearAIProviderApiKey = (...args) => globalThis.c7TestPorts.clearKey(...args);`
      }));
    }
  }],
  bundle: true, write: false, platform: "node", format: "cjs", target: "es2022",
  external: ["react", "react/jsx-runtime"]
});
const module = { exports: {} };
new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const subject = module.exports;

function diagnostic(code = "unknown_error", patch = {}) {
  return { code, message: "C7_MESSAGE_SENTINEL", body: "C7_BODY_SENTINEL", stack: "C7_STACK_SENTINEL",
    stage: "C7_STAGE_SENTINEL", class: "C7_CLASS_SENTINEL", cause: "C7_CAUSE_SENTINEL",
    callAttemptId: "C7_ATTEMPT_SENTINEL", provider: "C7_PROVIDER_A_SENTINEL", configurationRevision: 12,
    apiKey: "C7_SYNTHETIC_CREDENTIAL_SENTINEL", ...patch };
}
function assertSafeCopy(projection) {
  const rendered = `${projection.title ?? ""} ${projection.message ?? projection}`;
  assert.doesNotMatch(rendered, /C7_[A-Z_]+_SENTINEL/u);
  assert.doesNotMatch(rendered, /DeepSeek/u);
  assert.ok(rendered.trim());
}

test("C7 provider attribution uses generic service copy, never a later active selection or raw fields", () => {
  for (const language of ["zh-CN", "en-US"]) {
    for (const code of ["missing_api_key", "invalid_provider_configuration", "auth_error", "quota_error", "rate_limited",
      "network_error", "transport_error", "timeout", "provider_error", "invalid_request", "invalid_response",
      "stream_protocol_error", "empty_choices", "empty_content", "stream_ended_early", "secure_store_unavailable",
      "settings_persistence_failed", "configuration_changed", "technical_capacity_or_safety_error", "duplicate_request",
      "attempt_identity_conflict", "retry_regenerate_not_latest", "retry_regenerate_not_eligible",
      "retry_regenerate_active_conflict", "retry_regenerate_prepare_failed", "retry_regenerate_projection_integrity_error",
      "material_prompt_assembly_failed", "call_attempt_execution_orphaned", "ai_durable_settlement_validation_failed", "unknown_error"]) {
      const input = diagnostic(code);
      const before = structuredClone(input);
      const first = subject.projectAIErrorForDisplay(input, language);
      ports.currentProvider = "C7_PROVIDER_B_SENTINEL";
      assert.deepEqual(subject.projectAIErrorForDisplay(input, language), first);
      assertSafeCopy(first);
      assert.deepEqual(input, before);
      const noIdentity = { code, message: input.message };
      assert.deepEqual(subject.projectAIErrorForDisplay(noIdentity, language), first);
      assert.deepEqual(subject.projectAIErrorForDisplay(JSON.stringify(input), language), first);
    }
    for (const input of [new Error("C7_MESSAGE_SENTINEL"), "C7_MESSAGE_SENTINEL", diagnostic("C7_CODE_SENTINEL")]) {
      assertSafeCopy(subject.projectAIErrorForDisplay(input, language));
    }
  }
});

test("C7 responsibility and next actions follow typed facts, not arbitrary text or retry flags", () => {
  const show = (code, patch) => subject.projectAIErrorForDisplay(diagnostic(code, patch), "en-US");
  for (const code of ["missing_api_key", "invalid_provider_configuration"]) assert.match(show(code).message, /Settings/u);
  assert.match(show("auth_error").message, /API key.*account/u);
  assert.match(show("quota_error").message, /quota or billing/u);
  assert.match(show("rate_limited").message, /frequency.*later/u);
  for (const code of ["invalid_request", "invalid_response", "stream_protocol_error", "material_prompt_assembly_failed"]) {
    assert.match(show(code).message, /could not be processed/u);
    assert.doesNotMatch(show(code).message, /Settings|API key|your input|your model/u);
  }
  for (const code of ["network_error", "transport_error", "timeout", "provider_error", "empty_choices", "empty_content", "stream_ended_early"]) {
    assert.match(show(code).message, /try again later/u);
  }
  for (const code of ["unknown_error", "settings_persistence_failed", "call_attempt_execution_orphaned", "ai_durable_settlement_validation_failed"]) {
    const projected = show(code, { retryable: true });
    assert.match(projected.message, /could not be confirmed/u);
    assert.doesNotMatch(projected.message, /try again|retry/u);
  }
  const pre = diagnostic("ai_durable_persistence_failed", { phase: "pre_provider" });
  const post = diagnostic("ai_durable_persistence_failed", { phase: "post_provider" });
  assert.match(subject.projectAIErrorForDisplay(pre, "en-US").message, /not be started.*try again/u);
  assert.match(subject.projectAIErrorForDisplay(post, "en-US").message, /could not be confirmed.*before repeating/u);
  assertSafeCopy(subject.projectAIErrorForDisplay(post));
});

test("C7 display mapping preserves the existing non-rendered normalization and F18 gate outputs", () => {
  const input = diagnostic("auth_error", { status: 401, retryable: false });
  const before = subject.normalizeAIError(input);
  subject.projectAIErrorForDisplay(input);
  assert.deepEqual(subject.normalizeAIError(input), before);
  assert.equal(before.code, "auth_error");
  assert.equal(before.status, 401);
  assert.equal(before.retryable, false);
  // Existing durable diagnostic copy stays at its original owner, not in UI.
  assert.equal(before.title, "DeepSeek 认证失败");
  for (const code of ["material_source_changed_since_review", "material_not_authorized", "invalid_prompt",
    "retry_regenerate_attachment_reauthorization_required"]) {
    const legacy = subject.normalizeAIError(diagnostic(code));
    const projected = subject.projectAIErrorForDisplay(diagnostic(code));
    assert.deepEqual(projected, { code: legacy.code, title: legacy.title, message: legacy.message });
  }
});

// Execute actual current caller catch/function bodies through the repository's
// existing TypeScript harness pattern. Do not reproduce projection logic here.
function productionFunction(file, name, environment, catchOnly = false) {
  const ast = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(found, name);
  let source = found.getText(ast);
  if (catchOnly) {
    const clauses = [];
    function catches(node) {
      if (ts.isCatchClause(node) && node.variableDeclaration?.name.getText(ast) === "unknownError") clauses.push(node);
      ts.forEachChild(node, catches);
    }
    catches(found.body);
    assert.equal(clauses.length, 1, `${name}: exact outer catch`);
    source = `async function ${name}(unknownError) ${clauses[0].block.getText(ast)}`;
  }
  const code = ts.transpile(source, { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX });
  return new Function(...Object.keys(environment), `${code}; return ${name};`)(...Object.values(environment));
}
function callerEnvironment(overrides = {}) {
  const notices = [];
  const noop = () => {};
  const asyncNoop = async () => {};
  return {
    notices, language: "en-US", projectAIErrorForDisplay: subject.projectAIErrorForDisplay,
    generation: null, streamGenerationRef: { current: null }, conversationId: "c7-conversation",
    selectedConversationIdRef: { current: "c7-conversation" }, providerPhaseStarted: true,
    setStreamPresentation: noop, failAIStreamingPresentation: noop,
    isAIProviderConfigurationPreGateError: (error) => error.code === "missing_api_key",
    isAIAttachmentAuthorizationError: () => false, isAIOneShotLocalAttachmentError: () => false,
    isMaterialSourceFreshnessFailure: () => false,
    isAIDurablePersistenceError: (error) => ["ai_durable_persistence_failed", "ai_durable_settlement_validation_failed"].includes(error.code),
    isAIRetryRegeneratePrepareError: () => false,
    refreshProviderConfiguration: asyncNoop, refreshSelectedReadback: asyncNoop,
    refreshConversationSummaries: asyncNoop, setUserQuestion: noop, setConversationReadback: noop,
    setError: (value) => { if (value) notices.push(value); }, t: (key) => key,
    isAIParseDraftEligibilityError: () => false, isAIParseDraftSourceSnapshotError: () => false,
    setParseDraftTerminal: (value) => notices.push(value), requestId: "c7-request",
    AIContextRequestApprovalValidationError: class ValidationError extends Error {},
    isAIContextRequestPrepareError: () => false,
    ...overrides
  };
}

test("C7 every modified Global Chat failure branch executes the safe current mapper", async () => {
  const cases = [
    ["handleSend", diagnostic("ai_durable_persistence_failed", { phase: "post_provider" }), {}],
    ["handleSend", diagnostic("missing_api_key"), { providerPhaseStarted: false }],
    ["handleSend", diagnostic("network_error"), {}],
    ["handleRetryRegenerate", diagnostic("retry_regenerate_prepare_failed"), { isAIRetryRegeneratePrepareError: () => true }],
    ["handleRetryRegenerate", diagnostic("ai_durable_settlement_validation_failed"), {}],
    ["handleRetryRegenerate", diagnostic("invalid_request"), {}],
    ["handleContinueParseDraft", new Error("C7_MESSAGE_SENTINEL"), {}],
    ["handleApproveContextRequest", diagnostic("timeout"), {}],
    ["handleStop", diagnostic("unknown_error"), {}]
  ];
  for (const [name, error, overrides] of cases) {
    const environment = callerEnvironment(overrides);
    const before = structuredClone(error);
    await productionFunction(globalPanel, name, environment, true)(error);
    assert.equal(environment.notices.length, 1, name);
    assertSafeCopy(environment.notices[0]);
    assert.deepEqual(error, before);
  }
  for (const error of [diagnostic("provider_error"), diagnostic("ai_durable_persistence_failed", { phase: "post_provider" })]) {
    const environment = callerEnvironment();
    await assert.rejects(productionFunction(globalPanel, "handleGenerateActionDraftText", environment, true)(error), (thrown) => {
      assert.equal(thrown.message, subject.projectAIErrorForDisplay(error, "en-US").message);
      assertSafeCopy({ message: thrown.message });
      return true;
    });
  }
});

test("C7 stop/cancel and incidental Parse failure remain visible without altering payloads or confirmation wiring", async () => {
  for (const name of ["handleSend", "handleRetryRegenerate"]) {
    const environment = callerEnvironment();
    await productionFunction(globalPanel, name, environment, true)(diagnostic("cancelled"));
    assert.deepEqual(environment.notices, [{ title: "aiStoppedTitle", message: "aiStoppedMessage" }]);
  }
  const source = read(globalPanel);
  assert.match(source, /onConfirmResult=\{handleConfirmStandardResult\}/u);
  assert.match(source, /onContinueResult=\{handleContinueStandardResult\}/u);
  assert.match(source, /message: unknownError\.message[\s\S]*setError\(null\)/u); // F22 explicit eligibility branch retained.
  assert.match(source, /responseText=\{result\?\.text\}/u);
});

const status = {
  provider: "deepseek", model: "fixture-model", activeProvider: "deepseek", activeModel: "fixture-model",
  appOverrideConfigured: true, effectiveConfigured: true,
  availablePresets: [
    { provider: "deepseek", model: "fixture-model", displayName: "DeepSeek" },
    { provider: "openai", model: "fixture-model-b", displayName: "OpenAI" }
  ]
};
function renderedText(node) {
  if (typeof node === "string") return node;
  if (!node) return "";
  return (Array.isArray(node) ? node : node.children ?? []).map(renderedText).join(" ");
}
test("C7 actual Settings save/clear failure has one localized alert; success, cancel and provider labels remain", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = { confirm: () => true };
  try {
    for (const language of ["zh-CN", "en-US"]) {
      ports.language = language;
      ports.readStatus = async () => status;
      ports.setKey = async () => { throw new Error("unexpected credential call"); };
      ports.saveTuple = async () => { throw diagnostic("invalid_request"); };
      ports.clearKey = async () => { throw diagnostic("settings_persistence_failed"); };
      let renderer;
      await act(async () => { renderer = TestRenderer.create(React.createElement(subject.AIProviderSettingsPanel)); });
      const options = renderer.root.findAllByType("option").map((node) => node.children.join(""));
      assert.ok(options.includes("DeepSeek"));
      assert.ok(options.includes("OpenAI"));
      await act(async () => { await renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
      let alerts = renderer.root.findAllByProps({ role: "alert" });
      assert.equal(alerts.length, 1);
      assert.equal(alerts[0].children.join(""), subject.projectAIErrorForDisplay(diagnostic("invalid_request"), language).message);
      assertSafeCopy({ message: alerts[0].children.join("") });
      const clear = () => renderer.root.findAllByType("button").find((node) => node.children.join("") === (language === "zh-CN" ? "清除" : "Clear"));
      await act(async () => { clear().props.onClick(); });
      alerts = renderer.root.findAllByProps({ role: "alert" });
      assert.equal(alerts.length, 1);
      assert.equal(alerts[0].children.join(""), subject.projectAIErrorForDisplay(diagnostic("settings_persistence_failed"), language).message);
      ports.saveTuple = async () => status;
      ports.clearKey = async () => status;
      await act(async () => { await renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
      assert.equal(renderer.root.findAllByProps({ role: "alert" }).length, 0);
      assert.equal(renderer.root.findAllByProps({ role: "status" }).length, 1);
      assert.match(renderedText(renderer.toJSON()), language === "zh-CN" ? /已保存当前 Provider 与模型/u : /active Provider and model were saved/u);
      await act(async () => { clear().props.onClick(); });
      assert.equal(renderer.root.findAllByProps({ role: "status" })[0].children.join(""), "aiProviderClearSucceeded");
      globalThis.window.confirm = () => false;
      ports.clearKey = async () => { throw new Error("cancel must not call clear"); };
      await act(async () => { clear().props.onClick(); });
      assert.equal(renderer.root.findAllByProps({ role: "alert" }).length, 0);
      globalThis.window.confirm = () => true;
      await act(async () => renderer.unmount());
    }
  } finally { globalThis.window = previousWindow; }
});

test("C7 sink admission evidence: returning to chat can unmount either execution panel before settlement", () => {
  let workspace = "operations";
  const completeWorkspaceClose = productionFunction(globalPanel, "completeWorkspaceClose", {
    activeWorkspace: workspace, setWorkspaceDiscardWarningOpen() {}, setContextEditorDirty() {},
    setParseDraftTerminal() {}, setParseDraftEligibilityNotice() {}, setActiveWorkspace: (next) => { workspace = next; }
  });
  const requestClose = productionFunction(globalPanel, "requestWorkspaceClose", {
    contextEditorDirty: false, setWorkspaceDiscardWarningOpen() {}, completeWorkspaceClose
  });
  requestClose();
  assert.equal(workspace, "chat");
  const source = read(globalPanel);
  assert.match(source, /activeWorkspace === "operations" \? \([\s\S]*<AIParseDraftPanel[\s\S]*<AIActionDraftPanel/u);
  const actionSource = read("src/components/ai/AIActionDraftPanel.tsx");
  assert.match(actionSource, /managerRef = useRef\(createAIActionDraftManager\(\)\)/u);
  assert.match(actionSource, /if \(!mayPresentResult\) return/u);
  assert.match(actionSource, /managerRef\.current\.clear\(\)[\s\S]*\}, \[mountedContextKey\]\)/u);
  const application = read("src/services/actionDraftConfirmApplicationService.ts");
  assert.match(application, /dependencies\.publishFeedback\(result\);\s*return result/u);
  const refresh = read("src/services/refreshEventService.ts");
  assert.doesNotMatch(refresh, /sourceDraftId|mountedSelectionSnapshot/u);
});

test("C7 unproven Action Draft owner retains the existing page fallback and independent reload warning", () => {
  const scope = { classification: "action-local", page: "c7-sink-proof" };
  subject.clearWriteFeedback({ page: scope.page });
  const event = {
    id: "c7-event", source: "ai.apply", operation: "aiDraft.applyAIActionDraft",
    reason: "aiDraft.applyAIActionDraft", keys: ["aiContext.changed"],
    affectedEntities: [], affectedScopes: [], writeFeedbackStatus: "error", errors: ["synthetic apply failure"],
    warnings: [], skipped: [], createdAt: "2026-09-04T00:00:00Z"
  };
  let reloads = 0;
  const subscriber = subject.subscribeRefreshEvents((published) => {
    if (subject.hasAnyRefreshKey(published, ["aiContext.changed"])) {
      subject.pushRefreshEventFeedback(published, scope);
      reloads += 1;
    }
  });
  subject.publishRefreshEvent(event);
  assert.equal(reloads, 1);
  assert.equal(subject.getWriteFeedbackEntries().filter((entry) => entry.scope.page === scope.page).length, 1);
  subject.pushReloadErrorFeedback(new Error("synthetic independent reload failure"), event, scope.page, scope);
  assert.ok(subject.getWriteFeedbackEntries().some((entry) => entry.source === "reloadError" && entry.severity === "warning"));
  subject.publishRefreshEvent({ ...event, id: "c7-unlisted-event", source: "service.write", operation: "unlisted.operation" });
  assert.ok(subject.getWriteFeedbackEntries().some((entry) => entry.operation === "unlisted.operation"));
  subscriber.unsubscribe();
  subject.clearWriteFeedback({ page: scope.page });
});
