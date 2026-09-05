import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..", "..");
const bundle = await build({
  stdin: {
    contents: `
      export * from "./services/businessOperationFeedbackService.ts";
      export { pushPageFeedback, pushWriteFeedback, getWriteFeedbackEntries, clearWriteFeedback } from "./services/writeFeedbackDisplayService.ts";
      export { publishWriteFeedbackRefresh, subscribeRefreshEvents } from "./services/refreshEventService.ts";
    `,
    resolveDir: resolve(root, "src"),
    sourcefile: "lp14-b1-a3-f1-binary-feedback-harness.ts"
  },
  bundle: true,
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
const scope = { classification: "action-local", page: "f1-test" };

function resetToast() {
  const toast = subject.getBusinessOperationToast();
  if (toast) subject.dismissBusinessOperationToast(toast.id);
}

function writeFeedback(overrides = {}) {
  return {
    status: "error",
    operation: "planning.updateTask",
    affectedEntities: [],
    affectedScopes: [],
    refreshKeys: [],
    messages: [],
    warnings: [],
    errors: ["write failed"],
    skipped: [],
    partial: false,
    missingReferences: [],
    createdAt: "2026-09-01T16:00:00.000Z",
    ...overrides
  };
}

test("F1 maps the exact formal object/action identities to binary failure without a failure taxonomy", () => {
  const cases = [
    ["planning.createProject", "project", "create"],
    ["researcherProfile.update", "researcherProfile", "update"],
    ["planning.updateRouteNode", "route", "update"],
    ["planning.deleteTask", "task", "delete"],
    ["planning.createReviewWithTargets", "review", "create"],
    ["experiment.updateExperiment", "experiment", "update"],
    ["experimentRun.createExperimentRun", "experimentRun", "create"],
    ["literature.delete", "literature", "delete"],
    ["output.resultItem.create", "resultItem", "create"],
    ["output.finding.edit", "finding", "update"],
    ["output.outputCandidate.softDelete", "outputCandidate", "delete"],
    ["output.outputGap.create", "outputGap", "create"],
    ["output.researchOutput.edit", "researchOutput", "update"]
  ];
  for (const [operation, objectType, action] of cases) {
    assert.deepEqual(subject.projectFormalBusinessAttemptFailure(operation), {
      objectType,
      action,
      result: "failure"
    });
  }
  assert.equal(subject.projectFormalBusinessAttemptFailure("quickAnalysis.run"), undefined);
  assert.equal(subject.projectFormalBusinessAttemptFailure("operationLog.create"), undefined);
  assert.equal(subject.projectFormalBusinessAttemptFailure("ai.standardResult.pending"), undefined);
});

test("F1 shared write and page error seams publish one minimal formal failure", () => {
  resetToast();
  subject.pushWriteFeedback(writeFeedback(), scope);
  assert.deepEqual(
    (({ objectType, action, result }) => ({ objectType, action, result }))(
      subject.getBusinessOperationToast()
    ),
    { objectType: "task", action: "update", result: "failure" }
  );

  resetToast();
  subject.pushPageFeedback({
    severity: "error",
    title: "forbidden detail remains inline only",
    operation: "planning.createReviewWithTargets",
    scope
  });
  assert.deepEqual(
    (({ objectType, action, result }) => ({ objectType, action, result }))(
      subject.getBusinessOperationToast()
    ),
    { objectType: "review", action: "create", result: "failure" }
  );
  resetToast();
});

test("F1 treats formal partial/skipped writes as failure and keeps user cancel silent", () => {
  resetToast();
  subject.pushWriteFeedback(writeFeedback({
    status: "partial",
    operation: "planning.updateRouteNode",
    errors: [],
    warnings: ["related refresh incomplete"],
    partial: true
  }), scope);
  assert.equal(subject.getBusinessOperationToast()?.result, "failure");

  resetToast();
  subject.pushWriteFeedback(writeFeedback({
    status: "skipped",
    operation: "planning.deleteProject",
    errors: [],
    skipped: ["project_not_found_or_already_deleted"]
  }), scope);
  assert.equal(subject.getBusinessOperationToast()?.result, "failure");

  resetToast();
  subject.pushWriteFeedback(writeFeedback({
    status: "skipped",
    operation: "planning.deleteProject",
    errors: [],
    skipped: ["The operation was cancelled by the user."],
    messages: [{ severity: "info", code: "user_cancelled", message: "cancelled" }]
  }), scope);
  assert.equal(subject.getBusinessOperationToast(), null);
});

test("F1 excludes ordinary AI, Quick, and background errors and suppresses duplicate Toast publication", () => {
  resetToast();
  for (const operation of ["quickAnalysis.run", "operationLog.create", "ai.context.request"]) {
    subject.pushWriteFeedback(writeFeedback({ operation }), scope);
    assert.equal(subject.getBusinessOperationToast(), null);
  }

  let notifications = 0;
  const unsubscribe = subject.subscribeBusinessOperationToast(() => {
    notifications += 1;
  });
  subject.pushWriteFeedback(writeFeedback({ operation: "planning.createProject" }), scope);
  const firstToastId = subject.getBusinessOperationToast()?.id;
  subject.pushPageFeedback({
    severity: "error",
    title: "same attempt reached the page catch",
    operation: "planning.createProject",
    scope
  });
  assert.equal(subject.getBusinessOperationToast()?.id, firstToastId);
  assert.equal(notifications, 1);
  unsubscribe();
  resetToast();
});

test("F1 production wiring stays bounded and leaves Settings, OperationCenter, AI, and Quick semantics untouched", () => {
  const read = (path) => readFileSync(resolve(root, path), "utf8");
  const display = read("src/services/writeFeedbackDisplayService.ts");
  const business = read("src/services/businessOperationFeedbackService.ts");
  const reviews = read("src/pages/Reviews/ReviewsPage.tsx");
  const literature = read("src/pages/Literature/LiteraturePage.tsx");
  const experiments = read("src/pages/Experiments/ExperimentsPage.tsx");
  const outputs = read("src/pages/Outputs/OutputsPage.tsx");
  const settings = read("src/components/settings/BusinessOperationHistoryPanel.tsx");
  const operationCenter = read("src/components/settings/OperationCenterPanel.tsx");

  assert.match(display, /publishFormalBusinessAttemptFailure/u);
  assert.match(display, /message\.code === "user_cancelled"/u);
  for (const source of [reviews, literature, experiments, outputs]) {
    assert.match(source, /publishFormalBusinessAttemptFailure/u);
  }
  assert.doesNotMatch(business, /preflight_failure|validation_failure|write_failure|readback_failure|Error Translator|Error Reason Engine/u);
  assert.doesNotMatch(business, /createOperationLog|Provider|quickAnalysisFeedbackService|GlobalAIChatPanel/u);
  assert.doesNotMatch(settings, /publishFormalBusinessAttemptFailure/u);
  assert.doesNotMatch(operationCenter, /publishFormalBusinessAttemptFailure/u);
});

test("C501 exact eligibility table silences every proven operation/entity without consuming refresh truth", () => {
  let listener;
  const published = [];
  const owner = subject.createBusinessOperationFeedbackOwner({
    refreshPort: { subscribe(callback) { listener = callback; return { unsubscribe() {} }; } },
    publish: (terminal) => published.push(terminal)
  });
  owner.start();
  const counts = { project: 3, route: 3, task: 6, review: 4, researcherProfile: 1,
    experiment: 3, experimentRun: 3, literature: 4, resultItem: 6, finding: 6,
    outputCandidate: 6, outputGap: 7, researchOutput: 6 };
  assert.deepEqual(Object.fromEntries(Object.entries(subject.ROUTINE_SUCCESS_OPERATIONS)
    .map(([type, operations]) => [type, operations.length])), counts);
  for (const [objectType, operations] of Object.entries(subject.ROUTINE_SUCCESS_OPERATIONS)) {
    for (const operation of operations) {
      const rawType = subject.BUSINESS_OPERATION_OBJECT_METADATA[objectType].rawEntityTypes[0];
      const { action } = subject.projectFormalBusinessAttemptFailure(operation, rawType);
      const feedback = writeFeedback({ status: "success", operation, errors: [],
        affectedEntities: [{ type: rawType, id: "c501-fixture", relation: { create: "created", update: "updated", delete: "deleted" }[action] }],
        refreshKeys: ["global.changed"] });
      const original = structuredClone(feedback);
      const rereadEvents = [];
      const sub = subject.subscribeRefreshEvents((event) => { rereadEvents.push(event); listener(event); });
      subject.publishWriteFeedbackRefresh(feedback);
      sub.unsubscribe();
      assert.equal(rereadEvents.length, 1, operation);
      assert.deepEqual(rereadEvents[0].keys, ["global.changed"]);
      assert.deepEqual(feedback, original);
      subject.pushWriteFeedback(feedback, scope);
      assert.equal(subject.getWriteFeedbackEntries()[0].formalCrudTerminalPresentation, "suppress", operation);
    }
  }
  assert.equal(published.length, 0);
  owner.stop();
});

test("C501 unlisted success defaults to existing feedback; warning/unknown and sticky failures remain", () => {
  resetToast();
  const terminal = { objectType: "task", action: "create", result: "success" };
  assert.equal(subject.isRoutineBusinessOperationSuccess("planning.cloneTask", terminal), false);
  subject.publishBusinessOperationTerminal(terminal);
  assert.equal(subject.getBusinessOperationToast().result, "success");
  resetToast();
  for (const operation of ["planning.cloneTask", "projectImport.execute", "settings.dataSource.update", "quickAnalysis.run"]) {
    subject.pushPageFeedback({ severity: "success", title: "important result", operation, scope });
    assert.equal(subject.getWriteFeedbackEntries()[0].formalCrudTerminalPresentation, undefined);
  }
  for (const patch of [{ status: "unknown" }, { warnings: ["review the partial effect"] }, { partial: true }]) {
    subject.pushWriteFeedback(writeFeedback({ status: "success", operation: "planning.updateTask", errors: [],
      affectedEntities: [{ type: "task", id: "fixture", relation: "updated" }], ...patch }), scope);
    assert.notEqual(subject.getWriteFeedbackEntries()[0].formalCrudTerminalPresentation, "suppress");
  }
  subject.pushWriteFeedback(writeFeedback(), scope);
  const failure = subject.getBusinessOperationToast();
  subject.publishBusinessOperationTerminal(terminal);
  assert.equal(subject.getBusinessOperationToast(), failure);
  assert.equal(subject.getWriteFeedbackEntries()[0].formalCrudTerminalPresentation, "guidance-only");
  resetToast();
});

test("C501 planning, manuscript-related and output callers retain their authoritative reread wiring", () => {
  for (const [file, state, reload] of [
    ["Projects/ProjectsPage.tsx", "setProjects(projectRows)", "reload: refreshByKeys"],
    ["Experiments/ExperimentsPage.tsx", "setExperiments(rows)", "reload: refreshByKeys"],
    ["Outputs/OutputsPage.tsx", "setLists(nextLists)", "reload: reloadCurrentPage"]
  ]) {
    const source = readFileSync(resolve(root, "src/pages", file), "utf8");
    for (const text of [state, reload, "useRefreshEventReload({", "onReloadError:"]) assert.ok(source.includes(text), `${file}: ${text}`);
  }
});

test("C501 actual profile handler settles saved state, removes only its old message and keeps failure handling", async () => {
  const source = readFileSync(resolve(root, "src/pages/Projects/ProjectsPage.tsx"), "utf8");
  const ast = ts.createSourceFile("ProjectsPage.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let node;
  function visit(value) {
    if (ts.isFunctionDeclaration(value) && value.name?.text === "handleProfileSubmit") node = value;
    ts.forEachChild(value, visit);
  }
  visit(ast);
  assert.ok(node);
  const code = ts.transpile(node.getText(ast), { target: ts.ScriptTarget.ES2022 });
  const saved = { id: "profile-fixture", nickname: "fixture" };
  const calls = [];
  let fail = false;
  const handler = new Function("researcherProfileService", "profileForm", "toResearcherProfileInput", "toResearcherProfileForm", "setResearcherProfile", "setProfileForm", "setIsProfileEditing", "feedbackCenter", `${code}; return handleProfileSubmit;`)(
    { async updateResearcherProfile() { if (fail) throw new Error("fixture failure"); return saved; } },
    {}, (value) => value, (value) => value,
    (value) => calls.push(["profile", value]), (value) => calls.push(["form", value]),
    (value) => calls.push(["editing", value]),
    { entries: [{ id: "old", operation: "researcherProfile.update" }, { id: "unrelated", operation: "other" }],
      dismissFeedback: (id) => calls.push(["dismiss", id]), consumeWriteError: (_error, operation) => calls.push(["error", operation]),
      consumeWriteResult: () => assert.fail("no synthetic success") }
  );
  await handler({ preventDefault() {} });
  assert.deepEqual(calls, [["profile", saved], ["form", saved], ["editing", false], ["dismiss", "old"]]);
  calls.length = 0; fail = true;
  await handler({ preventDefault() {} });
  assert.deepEqual(calls, [["error", "researcherProfile.update"]]);
});
