import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { build } from "esbuild";
import ts from "typescript";

const root = resolve(import.meta.dirname, "../..");
const bundle = await build({
  stdin: { contents: `export * from './services/manuscriptFormalSwitchPresentation.ts'; export * from './services/writeFeedbackDisplayService.ts'; export { nonPlanningUi } from './i18n/nonPlanningI18n.ts';`, resolveDir: resolve(root, "src") },
  bundle: true, write: false, format: "cjs", platform: "node", target: "es2022"
});
const module = { exports: {} };
new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const subject = module.exports;
const ui = (text) => text;
const scope = { classification: "action-local", page: "c502-fixture" };
const read = (file) => readFileSync(resolve(root, file), "utf8");
const paths = {
  experiment: "src/pages/Experiments/useExperimentManuscriptEditor.ts",
  run: "src/pages/Experiments/useExperimentRunManuscriptEditor.ts",
  literature: "src/pages/Literature/useLiteratureManuscriptEditor.ts",
  review: "src/pages/Reviews/useReviewManuscriptEditor.ts",
  outputs: "src/pages/Outputs/useOutputsManuscriptEditor.ts",
  outputsPage: "src/pages/Outputs/OutputsPage.tsx"
};

// Execute the current production function body, not a copied implementation.
// Dependencies are isolated ports; setters and rereads are observable callbacks.
function productionFunction(file, name, environment) {
  const ast = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(found, `${file}:${name}`);
  const code = ts.transpile(found.getText(ast), { target: ts.ScriptTarget.ES2022 });
  return new Function(...Object.keys(environment), `${code}; return ${name};`)(...Object.values(environment));
}

function reset() { subject.clearWriteFeedback({ page: scope.page }); }
function pageFeedback(severity, title, operation) { subject.pushPageFeedback({ severity, title, operation, scope }); }
function visible() { return subject.getWriteFeedbackEntries().filter((entry) => entry.formalCrudTerminalPresentation !== "suppress"); }
function diagnostic(patch = {}) {
  return { status: "error", error: { code: "UNKNOWN_SENTINEL", errorCode: "UNKNOWN_SENTINEL",
    causeCode: "CAUSE_SENTINEL", message: "ARBITRARY_MESSAGE_SENTINEL", operationId: "PRIVATE_ID_SENTINEL",
    stage: "DIAGNOSTIC_STAGE_SENTINEL", provenance: { frontendProvenance: "FRONTEND_SENTINEL", rustProvenance: "RUST_SENTINEL", schemaProvenance: "SCHEMA_SENTINEL" },
    diagnosticDetails: { binding: "BINDING_SENTINEL", fileRef: "FILEREF_SENTINEL", stack: "STACK_SENTINEL" }, ...patch } };
}

test("C502 structured failure summaries preserve diagnostic truth and capability-limited actions", () => {
  for (const [result, category, action] of [
    [diagnostic(), "UNEXPECTED_OR_UNKNOWN", "none"],
    [diagnostic({ causeCode: "FORMAL_SWITCH_TOKEN_STALE" }), "STALE_OR_CHANGED", "reload"],
    [diagnostic({ causeCode: "EXPERIMENT_FORMAL_SWITCH_CURRENT_RUNTIME_SESSION_UNAVAILABLE" }), "SESSION_UNAVAILABLE", "reopen"],
    [diagnostic({ causeCode: "FORMAL_SWITCH_RESOURCE_BUSY" }), "IN_PROGRESS", "wait"],
    [diagnostic({ recoverability: "resolve-conflict" }), "CONFLICT", "none"],
    [diagnostic({ recoveryRequired: true }), "RECOVERY_REQUIRED", "none"],
    [diagnostic({ sideEffectSummary: { databaseCommitted: true } }), "INCOMPLETE_REFRESH", "none"]
  ]) {
    const original = structuredClone(result);
    const projected = subject.projectFormalSwitchFailure(result, ui, { reload: true, reopen: true, wait: true });
    assert.equal(projected.category, category);
    assert.equal(projected.action, action);
    for (const sentinel of ["ARBITRARY_MESSAGE_SENTINEL", "PRIVATE_ID_SENTINEL", "DIAGNOSTIC_STAGE_SENTINEL", "FRONTEND_SENTINEL", "RUST_SENTINEL", "SCHEMA_SENTINEL", "BINDING_SENTINEL", "FILEREF_SENTINEL", "STACK_SENTINEL"]) {
      assert.equal(JSON.stringify(projected).includes(sentinel), false);
    }
    assert.deepEqual(result, original);
    for (const capability of [{}, { reload: true, reopen: true, wait: true }]) {
      assert.deepEqual(subject.projectFormalSwitchFailure(result, (source) => subject.nonPlanningUi("en-US", source), capability),
        subject.projectFormalSwitchFailure(result, undefined, capability));
      assert.deepEqual(subject.projectFormalSwitchFailure(result, (source) => subject.nonPlanningUi("zh-CN", source), capability),
        subject.projectFormalSwitchFailure(result, ui, capability));
    }
  }
  assert.equal(subject.projectFormalSwitchFailure(diagnostic({ causeCode: "FORMAL_SWITCH_TOKEN_STALE" })).action, "none");
  assert.equal(subject.projectFormalSwitchFailure(diagnostic({ recoverability: "retry" })).action, "none");
});

test("C502 all five family terminal projections are silent, retain same-action replacement and default retention", () => {
  for (const [operation, severity] of [
    ["experiment.manuscript.switch", "success"], ["experiment.manuscript.switchNoOp", "info"],
    ["experiment.manuscript.switchCanceled", "info"], ["experiment.manuscript.switchConfirmCanceled", "info"],
    ["experiment.manuscript.externalRegistrationCanceled", "info"],
    ["experimentRun.manuscript.formalSwitch", "success"], ["experimentRun.manuscript.formalSwitchNoop", "info"],
    ["literature.manuscript.switch", "success"], ["literature.manuscript.switch", "info"],
    ["review.manuscript.setCurrent", "success"], ["output.markdown.switch", "success"]
  ]) {
    reset(); pageFeedback("error", "old error", operation); pageFeedback(severity, "settled", operation);
    assert.equal(visible().length, 0, operation);
    for (const retained of ["error", "warning", "partial", "skipped"]) {
      assert.equal(subject.isSilentFormalSwitchFeedback(operation, retained), false);
    }
  }
  reset(); pageFeedback("success", "retain", "manuscript.futureOperation");
  assert.equal(visible().length, 1);
});

function editorEnvironment(family, mounted = true) {
  const state = { local: null, independent: null, calls: [] };
  const env = { ...subject, mainOpen: mounted, independentOpen: mounted, mainSessionKey: "old", independentSessionKey: "target",
    currentActionRequestCounter: { current: 1 }, independentActionRequestCounter: { current: 1 },
    input: { experimentId: "fixture", runId: "fixture", ui, onFeedback: pageFeedback },
    setCurrentActionResult: (value) => { state.local = value; }, setIndependentActionResult: (value) => { state.independent = value; },
    feedback: pageFeedback, clearActionResult: () => { state.local = null; }, clearActionResults: () => { state.local = null; state.independent = null; }
  };
  const name = family === "experiment" ? "showActionResult" : "showResult";
  env[name] = productionFunction(paths[family], name, env);
  return { env, state, show: env[name] };
}

test("C502 current editor is the sole ordinary failure sink, with page fallback only when closed; Recovery actions are excluded", () => {
  for (const family of ["experiment", "run"]) {
    for (const mounted of [true, false]) {
      reset();
      const { state, show } = editorEnvironment(family, mounted);
      const operation = family === "experiment" ? "experiment.manuscript.switchConfirm" : "experimentRun.manuscript.formalSwitchFailed";
      show("error", "switch", subject.projectFormalSwitchFailure(diagnostic(), ui).summary, operation);
      assert.equal(Number(Boolean(state.local)) + visible().length, 1);
      assert.equal(Boolean(state.local), mounted);
      const success = family === "experiment" ? "experiment.manuscript.switch" : "experimentRun.manuscript.formalSwitch";
      reset(); show("success", "switch", "settled", success);
      assert.equal(state.local, null); assert.equal(visible().length, 0);
      reset(); show("success", "switch", "recovery complete", family === "experiment" ? "experiment.manuscript.recoveryCompleted" : "experimentRun.manuscript.recoveryCompleted");
      assert.ok(state.local); assert.equal(visible().length, 1); // unchanged recovery path
    }
  }
});

test("C502 Experiment actual switch branches retain activation/reread and one safe terminal", async () => {
  for (const branch of ["success", "selected-noop", "preflight-noop", "dirty", "preflight-error", "error", "recovery", "refresh-failed", "cancel"]) {
    reset(); const { env, state } = editorEnvironment("experiment"); const calls = [];
    const outcome = branch === "success" || branch === "refresh-failed" ? { status: "success", sessionKey: "new", operationLogId: "internal" }
      : branch === "recovery" ? { ...diagnostic({ recoveryRequired: true }), status: "recovery-required", operationId: "internal" } : diagnostic();
    const original = structuredClone(outcome);
    Object.assign(env, { requestCounter: { current: 0 }, beginBusyAction: () => ({}), finishBusyAction: () => {}, isCurrentAction: () => true,
      setError: () => {}, setMainSessionKey: (key) => calls.push(["current", key]), setMainOpen: () => calls.push(["open"]),
      setMainPresentationEpoch: () => {}, setSwitchRecovery: (value) => calls.push(["recovery", value]), refreshSessions: () => calls.push(["sessions"]),
      loadCurrentDescriptor: async () => { calls.push(["reread"]); return branch !== "refresh-failed"; },
      requestChoice: async () => branch === "cancel" ? "cancel" : "confirm",
      service: { selectTarget: async () => branch === "selected-noop" ? { status: "no-op", reason: "current-file" } : { status: "success", sessionKey: "target", fileName: "fixture.md" },
        preflight: async () => branch === "preflight-noop" ? { status: "no-op" } : branch === "dirty" ? diagnostic({ code: "EXPERIMENT_FORMAL_SWITCH_CURRENT_DIRTY" }) : branch === "preflight-error" ? diagnostic() : { status: "ready", preflightToken: "fixture" },
        confirm: async () => outcome, listRecoveries: async () => [{ operationId: "internal" }] }, resultCode: (value) => value.error?.code
    });
    await productionFunction(paths.experiment, "switchDocument", env)(true);
    if (["success", "selected-noop", "preflight-noop", "cancel"].includes(branch)) {
      assert.equal(state.local, null, branch); assert.equal(visible().length, 0, branch);
    } else { assert.ok(state.local, branch); assert.equal(visible().length, 0, branch); }
    if (["success", "refresh-failed"].includes(branch)) {
      assert.ok(calls.some(([kind, key]) => kind === "current" && key === "new"));
      assert.ok(calls.some(([kind]) => kind === "reread"));
    }
    if (branch === "refresh-failed") assert.equal(state.local.severity, "warning");
    if (branch === "recovery") assert.ok(calls.some(([kind, value]) => kind === "recovery" && value));
    assert.deepEqual(outcome, original);
  }
});

test("C502 Run actual request preserves confirmation, activation, callback and truthful failure/recovery/no-op", async () => {
  for (const branch of ["success", "noop", "preflight-error", "error", "recovery", "cancel", "throw", "refresh-failed"]) {
    reset(); const { env, state } = editorEnvironment("run"); const calls = [];
    const outcome = ["success", "refresh-failed"].includes(branch) ? { status: "success", sessionKey: "new" } : branch === "cancel" ? { status: "canceled" }
      : branch === "recovery" ? { ...diagnostic({ recoveryRequired: true }), status: "recovery-required" } : diagnostic();
    env.input.onSwitched = async () => { if (branch === "refresh-failed") throw new Error("READBACK_SENTINEL"); calls.push("reread"); };
    Object.assign(env, { requestCounter: { current: 0 }, setBusy: () => {}, isCurrentRequest: () => true,
      formalSwitchService: { preflight: async () => branch === "noop" ? { status: "already-current" } : branch === "preflight-error" ? diagnostic() : { status: "ready", targetFileName: "fixture.md", preflightToken: "fixture" },
        confirm: async () => { if (branch === "throw") throw new Error("UNEXPOSED_SENTINEL"); return outcome; } },
      requestChoice: async () => { calls.push("confirm"); return "confirm"; }, refreshSessions: () => calls.push("sessions"),
      setMainSessionKey: (key) => calls.push(key), setMainPresentationEpoch: () => {}, setMainOpen: () => {}, setIndependentSessionKey: () => {}, setIndependentOpen: () => {}, setIndependentPresentationEpoch: () => {}
    });
    await productionFunction(paths.run, "requestFormalSwitch", env)();
    if (["success", "noop", "cancel"].includes(branch)) { assert.equal(state.local, null); assert.equal(visible().length, 0); }
    else { assert.ok(state.local); assert.equal(visible().length, 0); }
    if (branch === "success") assert.deepEqual(calls, ["confirm", "sessions", "new", "reread"]);
    if (branch === "recovery") assert.equal(state.local.message, subject.projectFormalSwitchFailure(outcome, ui).summary);
    if (branch === "refresh-failed") assert.equal(state.local.message, subject.projectFormalSwitchFailure({ error: { sideEffectSummary: { databaseCommitted: true } } }, ui).summary);
  }
});

test("C502 Run switch preparation suppresses only its successful Open message, retaining ordinary Open and failures", async () => {
  for (const forFormalSwitch of [true, false]) for (const status of ["activation-succeeded", "activation-failed"]) {
    const calls = [];
    const opened = productionFunction(paths.run, "openDocument", {
      input: { runId: "fixture", ui, independentOpenPreviewProvider: {} }, requestCounter: { current: 0 },
      setBusy: () => {}, setCurrentActionResult: () => {}, isCurrentRequest: () => true,
      openProtocol: { execute: async () => ({ status }) }, showResult: (...args) => calls.push(args)
    });
    await opened(forFormalSwitch);
    assert.equal(calls.length, forFormalSwitch && status === "activation-succeeded" ? 0 : 1);
  }
  let requested = false;
  const result = await productionFunction(paths.run, "switchDocument", {
    lastOpenedIndependentSessionKeyRef: { current: "old" },
    openDocument: async (forSwitch) => { assert.equal(forSwitch, true); return true; },
    requestFormalSwitch: async () => { requested = true; return true; }
  })();
  assert.equal(result, true); assert.equal(requested, true);
});

test("C502 Review actual settled caller keeps current handle and rereads, silently ignores already-current, safely maps failures", async () => {
  for (const branch of ["success", "noop", "error", "missing-session", "refresh-failed"]) {
    reset(); const calls = [];
    const outcome = branch === "error" ? diagnostic() : { status: "success", ...(branch !== "missing-session" ? { sessionKey: "new" } : {}) };
    const env = { ...subject, workflow: { ownerId: "review-fixture", setCurrent: async () => outcome }, isActive: () => true,
      currentSession: {}, currentHandle: "old", available: [{ fileRefId: "target", displayName: "fixture.md", isCurrent: branch === "noop" }],
      reviewRawManuscriptService: { getSession: () => ({ file: { kind: "durable", fileRefId: "old" } }) }, activeIndependentHandleRef: { current: undefined },
      input: { ui, onFeedback: pageFeedback, onRefreshDetail: async () => { if (branch === "refresh-failed") throw new Error("READBACK_SENTINEL"); calls.push("detail"); } },
      setCurrentHandle: (key) => calls.push(key), setCurrentPresentationRevision: () => {}, refresh: async () => calls.push("reread"), refreshSessions: () => calls.push("sessions") };
    await productionFunction(paths.review, "setCurrent", env)("target", undefined, undefined, true);
    assert.equal(visible().length, ["error", "missing-session", "refresh-failed"].includes(branch) ? 1 : 0);
    if (branch === "success") assert.deepEqual(calls, ["new", "reread", "detail", "sessions"]);
    if (branch === "missing-session") assert.equal(visible()[0].title, subject.projectFormalSwitchFailure({ error: { sideEffectSummary: { databaseCommitted: true } } }, ui).summary);
  }
});

test("C502 Literature actual settled caller covers success, confirmed no-op and each changed failure branch", async () => {
  for (const branch of ["success", "noop", "error", "read-error", "copy-error", "refresh-failed"]) {
    reset(); const calls = [];
    const outcome = branch === "error" ? diagnostic() : branch === "noop" ? { status: "skipped", reason: "already-current" } : { status: "success", sessionKey: "new" };
    const workflow = { setCurrent: async () => outcome, createManagedCopy: async () => ({ status: "error", errors: [{ message: "PRIVATE_SENTINEL" }] }) };
    const session = { file: { kind: "durable", fileRefId: "old" }, draftRawText: "fixture" };
    const env = { ...subject, workflow, active: () => true, currentSession: session, currentHandle: "old", channel: "literature_outline",
      targetRequestSequence: { current: 0 }, activeIndependentHandleRef: { current: undefined }, manuscriptRequestTokenController: { begin: () => 1 },
      input: { literatureId: "fixture", ui, onFeedback: pageFeedback, onReloadDetail: async () => { if (branch === "refresh-failed") throw new Error("READBACK_SENTINEL"); calls.push("detail"); } },
      literatureRawManuscriptService: { getSession: () => session, close: async () => calls.push("close-target") },
      selectTarget: async (_candidate, token) => ({ fileRefId: "target", locationMode: branch === "copy-error" ? "external" : "managed", token }),
      openIndependentHandle: async () => branch === "read-error" ? { result: diagnostic() } : { handle: "target", view: {} },
      targetDocumentView: () => ({ displayName: "fixture.md" }), buildCanonicalFormalSwitchArchiveCandidate: () => ({ ok: false }),
      requestChoice: async () => "confirm", setBusy: () => {}, replaceCurrentHandle: (key) => calls.push(key),
      refreshAvailable: async () => calls.push("reread"), refreshSessions: () => calls.push("sessions") };
    await productionFunction(paths.literature, "switchCurrent", env)(true);
    assert.equal(visible().length, ["error", "read-error", "copy-error", "refresh-failed"].includes(branch) ? 1 : 0, branch);
    if (branch === "success") assert.deepEqual(calls, ["new", "reread", "detail", "sessions", "close-target"]);
    if (visible().length && branch !== "refresh-failed") assert.equal(visible()[0].title, subject.projectFormalSwitchFailure(diagnostic(), ui).summary);
  }
});

test("C502 Literature and Review selection/registration failures use safe projections without changing control flow", async () => {
  for (const family of ["literature", "review"]) for (const branch of ["selection", "registration"]) {
    reset(); const error = { status: "error", code: "PRIVATE_CODE", message: "PRIVATE_MESSAGE", requestToken: 1 };
    const workflow = { selectManuscript: async () => branch === "selection" ? error : { status: "success", selection: { requestToken: 1, locationMode: "managed" } },
      ensureSelectedManuscript: async () => error };
    const env = { ...subject, workflow, input: { ui, onFeedback: pageFeedback }, active: () => true, isActive: () => true,
      targetRequestSequence: { current: 1 }, manuscriptRequestTokenController: { begin: () => 1 } };
    await productionFunction(paths[family], family === "literature" ? "selectTarget" : "selectSwitchTarget", env)(workflow, 1);
    assert.equal(visible().length, 1); assert.equal(visible()[0].title, subject.projectFormalSwitchFailure(error, ui).summary);
  }
});

test("C502 Outputs actual host and page keep one safe failure, preserve visible settlement and silence success/no-op/cancel", async () => {
  for (const branch of ["success", "noop", "error", "activation-missing", "cancel", "refresh-failed"]) {
    reset(); const calls = [];
    const committed = branch === "error" ? diagnostic() : branch === "noop" ? diagnostic({ causeCode: "OUTPUT_MANUSCRIPT_FORMAL_SWITCH_TARGET_ALREADY_CURRENT" })
      : branch === "cancel" ? { status: "canceled" } : { status: "success", sessionKey: "new" };
    const env = { ...subject, owner: { ownerType: "finding", ownerId: "fixture" }, currentDocument: { fileRefId: "old" }, currentHandle: "old",
      setStatus: (status) => calls.push(status), createOutputManuscriptFormalSwitchService: () => ({ commit: async () => { calls.push("commit"); return committed; } }),
      nextRequest: () => 1, setError: () => {}, syncStatus: () => {}, ownerLeaseRef: { current: undefined },
      outputRawManuscriptService: { getSession: () => branch === "activation-missing" ? undefined : { file: { kind: "durable", fileRefId: "target", fileName: "fixture.md" } } },
      outputManuscriptStructuredSnapshotService: { get: async () => { if (branch === "refresh-failed") throw new Error("READBACK_SENTINEL"); calls.push("reread"); return {}; } },
      setCurrentSnapshot: () => {}, setCurrentHandle: (key) => calls.push(key), setCurrentPresentationRevision: () => {}, refresh: () => calls.push("sessions") };
    const execute = productionFunction(paths.outputs, "executeFormalSwitch", env);
    const page = productionFunction(paths.outputsPage, "executePendingManuscriptSwitch", {
      pendingManuscriptSwitch: { fileRefId: branch === "noop" ? "old" : "target" }, outputsManuscriptEditorHost: { requestFormalSwitch: execute },
      feedbackCenter: { pushPageFeedback: (value) => subject.pushPageFeedback({ ...value, scope }), consumeWriteError: (error, operation) => pageFeedback("error", error.message, operation) },
      t: ui, setPendingManuscriptSwitch: () => calls.push("closed-confirmation")
    });
    await page();
    assert.equal(visible().length, ["error", "activation-missing", "refresh-failed"].includes(branch) ? 1 : 0, branch);
    if (branch === "success") assert.deepEqual(calls, ["switching", "commit", "reread", "new", "open-clean", "sessions", "closed-confirmation"]);
    if (branch === "noop") assert.deepEqual(calls, ["switching", "commit", "closed-confirmation"]);
    if (branch === "activation-missing") assert.equal(visible()[0].title, subject.projectFormalSwitchFailure({ error: { sideEffectSummary: { databaseCommitted: true } } }).summary);
  }
});

test("C502 Outputs lifecycle and selection failure fallbacks do not propagate arbitrary diagnostics", async () => {
  reset();
  const sequence = productionFunction(paths.outputs, "requestLifecycleSequence", { ...subject,
    sharedEditorLifecycleController: { requestSequence: async () => ({ status: "failed", error: "PRIVATE_LIFECYCLE_SENTINEL" }) } });
  assert.equal((await sequence("switch-manuscript", "SWITCH_MANUSCRIPT", async () => {})).error, subject.projectFormalSwitchFailure({}).summary);
  assert.equal((await sequence("top-close", "CLOSE_EDITOR", async () => {})).error, "PRIVATE_LIFECYCLE_SENTINEL");
  await productionFunction(paths.outputsPage, "switchMarkdownManuscript", { ...subject, ui,
    outputsManuscriptEditorHost: { requestSelectForFormalSwitch: async () => ({ status: "error", error: "PRIVATE_SELECTION_SENTINEL" }) },
    feedbackCenter: { consumeWriteError: (error, operation) => pageFeedback("error", error.message, operation) }
  })();
  assert.equal(visible().length, 1); assert.equal(visible()[0].title, subject.projectFormalSwitchFailure({}, ui).summary);
});

test("C502 current wiring keeps confirmation, accessibility, shared-save settlement and Recovery surfaces", () => {
  for (const file of Object.values(paths).filter((file) => file !== paths.outputsPage)) assert.ok(read(file).includes("projectFormalSwitchFailure"), file);
  const editor = read("src/components/common/ManuscriptSegmentEditorWindow.tsx");
  assert.ok(editor.indexOf("if (saved.projectionState) setCurrentProjection(saved.projectionState)") < editor.indexOf("presentSaveResult(saved"));
  assert.ok(editor.includes('presentation.primaryFeedbackOwner === "shared-editor-operation-controller"'));
  assert.ok(editor.includes('role={ordinaryFeedback.severity === "error" ? "alert" : "status"}'));
  assert.ok(read("src/components/feedback/WriteFeedbackPanel.tsx").includes('role={entry.severity === "error" ? "alert" : "status"}'));
  for (const [file, evidence] of [
    ["src/pages/Experiments/ExperimentCurrentManuscriptEditor.tsx", ["ExperimentFormalSwitchRecoveryRail", "retrySwitchRecovery()", "cancelSwitchRecovery()"]],
    ["src/pages/Experiments/ExperimentRunCurrentManuscriptEditor.tsx", ["RecoveryBanner", "continueSwitchRecovery()", "safeCancelSwitchRecovery()", 'role={result.severity === "error" ? "alert" : "status"}']],
    ["src/components/common/FormalSwitchConfirmationDialog.tsx", ['aria-modal="true"', "onClick={onConfirm}", "onClick={onCancel}"]]
  ]) for (const text of evidence) assert.ok(read(file).includes(text), text);
  assert.ok(read(paths.run).includes('formalSwitchFailureMessage(result, input.ui("文稿切换仍需处理，请检查恢复状态。"))'));
});
