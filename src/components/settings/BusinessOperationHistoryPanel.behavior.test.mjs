import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

// Production Settings render path, both panels, projector, refresh hook and log
// service. Only unrelated Settings sections/i18n and repository I/O are ports.
const bundle = await build({
  stdin: {
    contents: `export { SettingsPage } from "./src/pages/Settings/SettingsPage.tsx";
      export { BusinessOperationHistoryPanel } from "./src/components/settings/BusinessOperationHistoryPanel.tsx";
      export * from "./src/services/businessOperationFeedbackService.ts";
      export { createOperationLog, listOperationLogs, getOperationLog } from "./src/services/operationLogService.ts";
      export { publishRefreshEvent } from "./src/services/refreshEventService.ts";`,
    resolveDir: resolve("."), sourcefile: "b3-mounted-history-harness.ts"
  },
  bundle: true, write: false, platform: "node", format: "cjs", target: "es2022",
  jsx: "automatic", external: ["react", "react/jsx-runtime"],
  plugins: [{
    name: "b3-bounded-ports",
    setup(api) {
      api.onResolve({ filter: /i18n\/I18nProvider$/u }, () => ({ path: "i18n", namespace: "ports" }));
      api.onResolve({ filter: /repositories\/repositoryFactory$/u }, () => ({ path: "repository", namespace: "ports" }));
      api.onResolve({ filter: /hooks\/useWriteFeedbackCenter$/u }, () => ({ path: "feedback", namespace: "ports" }));
      api.onResolve({ filter: /components\/layout\/SettingsPanel$/u }, () => ({ path: "settings-layout", namespace: "ports" }));
      api.onResolve({ filter: /components\/(feedback\/WriteFeedbackPanel|settings\/(ManagedRootSettingsPanel|AIProviderSettingsPanel|AppearanceSettingsPanel|ProjectImportPanel|ProjectExportV1Panel|SupportedRecycleRestorePanel))$/u }, (args) => ({ path: args.path.split("/").at(-1), namespace: "ports" }));
      api.onLoad({ filter: /.*/u, namespace: "ports" }, ({ path }) => ({
        loader: "js",
        contents: path === "i18n"
          ? `export const useI18n = () => ({ language: globalThis.__b3.language, t: key => key });`
          : path === "repository"
            ? `export const createRepository = config => { if (config.entityName !== "operationLog") throw Error("Unexpected repository"); return {
                list: () => globalThis.__b3.list(), getById: id => globalThis.__b3.get(id),
                create: (input, options) => globalThis.__b3.create(input, options),
                update: (...args) => globalThis.__b3.mutate("update", args),
                softDelete: (...args) => globalThis.__b3.mutate("delete", args),
                restore: (...args) => globalThis.__b3.mutate("restore", args)
              }; };`
            : path === "feedback"
              ? `export const useWriteFeedbackCenter = () => ({ entries: [], dismissFeedback() {}, consumeWriteResult() {}, consumeWriteError() {}, pushWriteFeedback() {} });`
              : path === "settings-layout"
                ? `export const SettingsPanel = ({ renderSections }) => renderSections({ dataSourceSettings: null });`
                : `export const ${path} = () => null;`
      }));
    }
  }]
});
const module = { exports: {} };
new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const subject = module.exports;

function entry(overrides = {}) {
  return {
    id: "log-private-id", operationType: "create", source: "user", module: "planning",
    status: "success", riskLevel: "low", target: { entityType: "project", entityId: "private-object-id", title: "Project Ω" },
    summary: "canonical IPC SQL raw-summary-secret", warnings: ["raw-warning-secret"], errors: ["raw-stack-secret"], skipped: [],
    relatedEntities: [], actorId: "local_user", actorLabel: "Local user", refreshKeys: [], schemaVersion: 1,
    isRecoverable: false, createdAt: "2026-10-03T15:00:00.000Z", updatedAt: "2026-10-03T15:00:00.000Z", deletedAt: null,
    ...overrides
  };
}

function source(rows = [], language = "en-US") {
  const state = { rows: structuredClone(rows), language, reads: 0, gets: 0, writes: [], businessWrites: 0, readPort: null };
  state.list = async () => {
    state.reads += 1;
    return state.readPort ? state.readPort() : structuredClone(state.rows);
  };
  state.get = async id => { state.gets += 1; return structuredClone(state.rows.find(row => row.id === id)); };
  state.create = async (input, options) => {
    state.writes.push(["create", options.id]);
    const row = { ...structuredClone(input), ...options, updatedAt: options.createdAt, deletedAt: null };
    state.rows.push(row);
    return structuredClone(row);
  };
  state.mutate = (kind) => { state.writes.push([kind]); assert.fail(`Browsing invoked ${kind}`); };
  globalThis.__b3 = state;
  return state;
}

const text = node => typeof node === "string" ? node : Array.isArray(node) ? node.map(text).join(" ") : text(node?.children ?? []);
const business = renderer => renderer.root.findByProps({ "data-settings-top-level": "business-history" });
const articles = renderer => business(renderer).findAllByType("article");
const refresh = renderer => business(renderer).findByType("button");
const snapshot = state => JSON.stringify(state.rows);
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const event = () => subject.publishRefreshEvent({ id: "b3-readonly-refresh", keys: ["operationLog.changed"], affectedEntities: [], affectedScopes: [], source: "service.write", createdAt: "2026-10-03T16:00:00Z" });
async function mount(component = subject.BusinessOperationHistoryPanel) {
  let renderer;
  await act(async () => { renderer = TestRenderer.create(React.createElement(component)); });
  return renderer;
}
async function dispose(renderer) { await act(async () => renderer.unmount()); }

test("history projection keeps all current pairs, exact log titles and truthful results without changing binary toast semantics", () => {
  for (const { objectType, action } of subject.BUSINESS_OPERATION_APPLICABLE_PAIRS) {
    const entityType = subject.BUSINESS_OPERATION_OBJECT_METADATA[objectType].rawEntityTypes[0];
    for (const [status, result] of [["success", "success"], ["partial", "partial"], ["error", "failure"], ["skipped", "skipped"], ["future-status", "unknown"]]) {
      const row = entry({ operationType: action, status, target: { entityType, entityId: "private", title: "Recorded title Ω" } });
      const before = JSON.stringify(row);
      const projected = subject.projectBusinessOperationLogEntry(row);
      assert.equal(projected.objectType, objectType);
      assert.equal(projected.action, action);
      assert.equal(projected.result, result);
      assert.equal(projected.objectTitle, "Recorded title Ω");
      assert.equal(JSON.stringify(row), before);
    }
  }
  for (const patch of [{ source: "system" }, { source: "ai" }, { operationType: "custom" }, { operationType: "restore" }, { operationType: "convert" }, { target: { entityType: "fileRef", entityId: "private" } }, { target: { entityType: "researcherProfile", entityId: "private" } }]) {
    assert.equal(subject.projectBusinessOperationLogEntry(entry(patch)), undefined);
  }
  for (const title of [undefined, "   ", "private-object-id"]) {
    assert.equal(subject.projectBusinessOperationLogEntry(entry({ target: { entityType: "project", entityId: "private-object-id", title } })).objectTitle, undefined);
  }
  assert.equal(subject.admitBusinessOperationTerminal({ objectType: "project", action: "create", result: "partial" }), undefined);
});

test("production Settings mounts visible business history and reachable collapsed diagnostics from the same readonly source", async () => {
  const state = source([entry(), entry({ id: "diagnostic", operationType: "custom", createdAt: "2026-10-03T16:00:00Z" })]);
  const before = snapshot(state);
  const renderer = await mount(subject.SettingsPage);
  assert.equal(business(renderer).type, "section");
  assert.equal(business(renderer).findByType("h2").children.join(""), "User operation history");
  assert.equal(articles(renderer).length, 1);
  assert.match(text(business(renderer)), /Project Ω/);
  assert.match(text(business(renderer)), /Succeeded/);
  assert.doesNotMatch(text(business(renderer)), /private-object-id|canonical IPC|raw-summary-secret|raw-warning-secret|raw-stack-secret|custom/);
  const diagnostics = renderer.root.findByProps({ "data-recent-operation-log": "true" });
  assert.equal(diagnostics.type, "details");
  assert.ok(!diagnostics.props.open);
  assert.equal(diagnostics.findByType("summary").children.join(""), "Technical diagnostic logs");
  assert.match(text(diagnostics), /raw-summary-secret/);
  assert.match(text(diagnostics), /custom/);
  assert.equal(state.reads, 2);
  assert.equal(snapshot(state), before);
  assert.deepEqual(state.writes, []);
  assert.equal(state.businessWrites, 0);
  console.log("B3_MOUNTED_PROOF", JSON.stringify({ renderer: "react-test-renderer", productionSettingsTree: renderer.toJSON(), defaultBusinessRows: articles(renderer).length, diagnosticHost: diagnostics.type, diagnosticInitiallyOpen: Boolean(diagnostics.props.open), readCalls: state.reads, logMutationCalls: state.writes.length, before: JSON.parse(before), after: state.rows }));
  await dispose(renderer);
});

test("mounted mixed results, newest-first order, fallback and long user text remain accurate in both languages", async () => {
  const longTitle = "<script>literal user title Ω</script>" + "长标题".repeat(200);
  const statuses = ["success", "partial", "error", "skipped", "unrecognized-status"];
  const state = source(statuses.map((status, i) => entry({ id: `row-${i}`, status, operationType: ["create", "update", "delete"][i % 3], createdAt: `2026-10-03T1${i}:00:00Z`, target: { entityType: "literature", entityId: `private-${i}`, title: i === 4 ? longTitle : i === 3 ? "private-3" : undefined } })));
  const before = snapshot(state);
  const renderer = await mount();
  assert.deepEqual(articles(renderer).map(row => row.findByType("time").props.dateTime), statuses.map((_, i) => `2026-10-03T1${i}:00:00Z`).reverse());
  assert.deepEqual(articles(renderer).map(row => row.findAllByType("span").at(-1).children.join("")), ["Outcome unknown", "Skipped", "Failed", "Partially succeeded", "Succeeded"]);
  assert.deepEqual(articles(renderer).map(row => row.findAllByType("span").at(-1).props.className.split(" ").at(-1)), ["operation-status-unknown", "operation-status-skipped", "operation-status-error", "operation-status-partial", "operation-status-success"]);
  assert.ok(text(business(renderer)).includes(longTitle));
  assert.match(text(business(renderer)), /Object name unavailable/);
  assert.doesNotMatch(text(business(renderer)), /private-3|unrecognized-status|raw-stack-secret/);
  await act(async () => { state.language = "zh-CN"; renderer.update(React.createElement(subject.BusinessOperationHistoryPanel)); });
  assert.match(text(business(renderer)), /部分成功/);
  assert.match(text(business(renderer)), /结果未知/);
  assert.match(text(business(renderer)), /对象名称不可用/);
  assert.equal(snapshot(state), before);
  assert.deepEqual(state.writes, []);
  await dispose(renderer);
});

test("loading, read failure and recent diagnostic-only empty window are distinct; refresh recovers by reading", async () => {
  const state = source([entry({ operationType: "custom" })]);
  const firstRead = deferred();
  state.readPort = () => firstRead.promise;
  const renderer = await mount();
  assert.match(text(business(renderer)), /Loading user operation history/);
  assert.equal(refresh(renderer).props.disabled, true);
  await act(async () => firstRead.reject(new Error("SQLite raw-stack-secret")));
  assert.match(text(business(renderer)), /temporarily unavailable/);
  assert.doesNotMatch(text(business(renderer)), /No user business|raw-stack-secret|SQLite/);
  state.readPort = null;
  await act(async () => refresh(renderer).props.onClick());
  assert.match(text(business(renderer)), /No recent user operations/);
  assert.match(text(business(renderer)), /latest 50 logs/);
  assert.equal(state.rows.length, 1);
  assert.deepEqual(state.writes, []);
  await dispose(renderer);
});

test("formal production log setup publishes refresh, readback and manual/event refresh leave objects and logs unchanged", async () => {
  const state = source([entry()]);
  const renderer = await mount(subject.SettingsPage);
  const initial = snapshot(state);
  const initialReads = state.reads;
  await act(async () => refresh(renderer).props.onClick());
  assert.equal(state.reads, initialReads + 1);
  assert.equal(snapshot(state), initial);
  assert.deepEqual(state.writes, []);
  let feedback;
  await act(async () => {
    feedback = await subject.createOperationLog({ id: "b3-formal-setup", operationType: "delete", source: "user", module: "literature", status: "partial", riskLevel: "high", target: { entityType: "literature", entityId: "b3-literature", title: "Recorded literature title" }, summary: "raw-only setup", isRecoverable: true, createdAt: "2026-10-03T17:00:00Z" });
  });
  assert.equal(feedback.status, "success"); // log recorded; its business outcome stays partial.
  assert.equal(articles(renderer).length, 2);
  assert.match(text(articles(renderer)[0]), /Recorded literature title.*Delete.*Partially succeeded/);
  assert.equal((await subject.getOperationLog("b3-formal-setup")).status, "partial");
  const afterSetup = snapshot(state);
  const setupWrites = structuredClone(state.writes);
  const readsAfterSetup = state.reads;
  await act(async () => { event(); });
  await act(async () => refresh(renderer).props.onClick());
  assert.equal(state.reads, readsAfterSetup + 3); // event reads both panels; button reads business only.
  assert.equal(snapshot(state), afterSetup);
  assert.deepEqual(state.writes, setupWrites);
  assert.deepEqual(setupWrites, [["create", "b3-formal-setup"]]);
  assert.equal(state.businessWrites, 0);
  console.log("B3_READONLY_PROOF", JSON.stringify({ initialMountReads: initialReads, explicitRefreshReads: 1, isolatedLogSetupWrites: setupWrites, postSetupRefreshReads: state.reads - readsAfterSetup, businessWrites: state.businessWrites, historyReadLogWrites: state.writes.length - setupWrites.length, beforeAfterEqual: snapshot(state) === afterSetup, fixtureBeforeRefresh: JSON.parse(afterSetup), fixtureAfterRefresh: state.rows, rawRecordsPreserved: state.rows.length, productionEntry: "SettingsPage > BusinessOperationHistoryPanel; RecentOperationLogPanel details" }));
  await dispose(renderer);
});

test("production query filters/sorts then limits 50, business displays at most 20 without scanning for more", async () => {
  const rows = Array.from({ length: 60 }, (_, i) => entry({ id: `log-${i}`, createdAt: new Date(Date.UTC(2026, 9, 3, 0, i)).toISOString(), target: { entityType: "project", entityId: `object-${i}`, title: `Title ${i}` } }));
  const state = source(rows);
  const renderer = await mount();
  assert.equal(articles(renderer).length, 20);
  assert.match(text(articles(renderer)[0]), /Title 59/);
  assert.match(text(articles(renderer).at(-1)), /Title 40/);
  assert.equal(state.reads, 1);
  const queried = await subject.listOperationLogs({ operationType: "create", status: "success", limit: 50 });
  assert.equal(queried.length, 50);
  assert.equal(queried[49].id, "log-10");
  assert.equal((await subject.listOperationLogs({ source: "system", limit: 50 })).length, 0);
  state.rows.forEach((row, i) => { if (i >= 10) row.operationType = "custom"; }); // isolated source setup only.
  const afterSetup = snapshot(state);
  await act(async () => refresh(renderer).props.onClick());
  assert.equal(articles(renderer).length, 0);
  assert.match(text(business(renderer)), /No recent user operations/);
  assert.equal(snapshot(state), afterSetup);
  assert.equal(state.rows.length, 60);
  assert.deepEqual(state.writes, []);
  await dispose(renderer);
});

test("late initial reads cannot replace refreshed facts, and unmounted reads do not settle", async () => {
  const state = source([]);
  const oldRead = deferred();
  state.readPort = () => oldRead.promise;
  const renderer = await mount();
  state.readPort = async () => [entry({ target: { entityType: "project", entityId: "new", title: "Fresh event fact" } })];
  await act(async () => { event(); });
  assert.match(text(business(renderer)), /Fresh event fact/);
  await act(async () => oldRead.resolve([entry({ target: { entityType: "project", entityId: "old", title: "Stale initial fact" } })]));
  assert.doesNotMatch(text(business(renderer)), /Stale initial fact/);
  const finalRead = deferred();
  state.readPort = () => finalRead.promise;
  await act(async () => refresh(renderer).props.onClick());
  assert.match(text(business(renderer)), /Loading user operation history/);
  await dispose(renderer);
  await act(async () => finalRead.resolve([entry()]));
  assert.deepEqual(state.writes, []);
});
