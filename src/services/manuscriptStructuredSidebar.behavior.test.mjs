import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { build } from "esbuild";
import React from "react";
import { act, create } from "react-test-renderer";

// Production UI, canonical services, repository serialization, owner policy and
// lifecycle controller run here. The native IPC boundary uses a task-owned SQLite
// transport fixture, not the product DB. This does not claim desktop IPC E2E.
const bundle = await build({
  stdin: { contents: `
    export * from './manuscriptStructuredSidebarService';
    export * from './manuscriptOutlineDescriptorRegistry';
    export {reconcileReviewOutlineSections} from './reviewCoreContractService';
    export * as repository from './planningRepository';
    export {createSharedEditorLifecycleController, sharedEditorLifecycleController as controller} from './sharedEditorLifecycleController';
    export {ManuscriptStructuredSidebar as Sidebar} from '../components/common/ManuscriptStructuredSidebar';
    export {ManuscriptSegmentEditorWindow as Window} from '../components/common/ManuscriptSegmentEditorWindow';
    export {I18nProvider} from '../i18n/I18nProvider';
  `, resolveDir: import.meta.dirname, sourcefile: "structured-sidebar-harness.tsx" },
  bundle: true, write: false, format: "cjs", platform: "node", target: "es2022",
  external: ["react", "react/jsx-runtime"], loader: { ".md": "text" }, logLevel: "silent",
  plugins: [{ name: "native-fixture", setup(api) {
    api.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: "ipc", namespace: "fixture" }));
    api.onLoad({ filter: /^ipc$/, namespace: "fixture" }, () => ({ contents: `
      export const invoke=(command,args)=>globalThis.__sidebarIPC(command,args);
      export const isTauri=()=>true; export const convertFileSrc=x=>x;
      export class Channel { constructor(onmessage){this.onmessage=onmessage;} }
    ` }));
    // Unrelated rendering widgets are replaced; the shared window/sidebar are real.
    for (const name of ["ManuscriptSegmentEditor", "ManuscriptSegmentPreview", "ManuscriptTemplateWorkspacePanel"]) {
      api.onResolve({ filter: new RegExp(`/${name}$`) }, () => ({ path: name, namespace: "widget" }));
    }
    api.onLoad({ filter: /.*/, namespace: "widget" }, args => ({ contents: `export function ${args.path}(){return null;}` }));
  } }]
});
const module = { exports: {} };
new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const subject = module.exports;
async function editSidebar(renderer) {
  await act(async () => renderer.root.findByProps({ className: "manuscript-structured-sidebar__actions" }).findAllByType("button")[0].props.onClick());
}
const wire = x => JSON.parse(JSON.stringify(x));
const base = { created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z", tags: "[]", source: "user", schema_version: 3 };
const locations = { experiment: "experiments", experimentRun: "experiment_runs", literature: "literatures", resultItem: "result_items", finding: "findings", outputCandidate: "output_candidates", outputGap: "output_gaps", researchOutput: "outputs" };
const quote = name => `"${name.replaceAll('"', '""')}"`;
const epoch = "11111111-1111-4111-8111-111111111111";

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "sc3-a4-a1-sidebar-"));
  const path = join(directory, "isolated.sqlite3");
  let db = new DatabaseSync(path);
  db.exec("CREATE TABLE fixture_documents(key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const put = (key, value) => db.prepare("INSERT OR REPLACE INTO fixture_documents VALUES (?,?)").run(key, JSON.stringify(value));
  const get = key => { const row = db.prepare("SELECT value FROM fixture_documents WHERE key=?").get(key); return row ? JSON.parse(row.value) : undefined; };
  const f = { directory, path, writes: 0, failWrite: false, get, put, reopen() { db.close(); db = new DatabaseSync(path); }, close() { db.close(); } };
  console.log(JSON.stringify({ fixturePath: path, purpose: "TEST_ONLY HR22 canonical service transport and mounted UI", productDatabaseOpened: false }));
  // Fixed isolated seed records. Production services perform subsequent writes.
  for (const [owner, table] of Object.entries(locations)) {
    const record = { ...base, id: `sc3-test-${owner}`, title: `TEST_ONLY ${owner}`, project_id: "p", status: owner === "literature" ? undefined : "draft", description: "before", summary: "before", structured_summary: "[]", custom_fields: "[]" };
    if (owner.startsWith("experiment")) Object.assign(record, { status: "planned", created_local_date: "2026-09-01", created_local_time: "0900", workspace_title_identity: owner === "experiment" ? "experiment" : "run", condition_items: "[]", method_steps: "[]", variables: "[]", materials: "[]", experiment_id: "sc3-test-experiment" });
    if (owner === "literature") Object.assign(record, { authors: "[]", keywords: "[]", external_ids: "[]", primary_project_id: null, reading_status: "unread", publication_type: "journal", abstract: "before", custom_fields: JSON.stringify([{ id: "unrelated", name: "unrelated", value: "keep" }]) });
    const clean = wire(record);
    db.exec(`CREATE TABLE ${quote(table)} (${Object.keys(clean).map(key => `${quote(key)} ${key === "id" ? "TEXT PRIMARY KEY" : ""}`).join(",")})`);
    // Fixture tables grow only with the actual serialized canonical service fields.
    f.put(`seed:${table}`, clean);
  }
  function record(table, id, patch, cas) {
    const columns = db.prepare(`PRAGMA table_info(${quote(table)})`).all().map(row => row.name);
    if (patch) {
      for (const key of Object.keys(patch)) if (!columns.includes(key)) db.exec(`ALTER TABLE ${quote(table)} ADD COLUMN ${quote(key)}`);
      const existing = db.prepare(`SELECT * FROM ${quote(table)} WHERE id=?`).get(id);
      if (cas && existing?.updated_at !== cas) return false;
      const next = { ...existing, ...patch, id };
      const keys = Object.keys(next);
      db.prepare(`INSERT OR REPLACE INTO ${quote(table)} (${keys.map(quote).join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map(key => next[key] ?? null));
      return true;
    }
    return db.prepare(`SELECT * FROM ${quote(table)} WHERE id=?`).get(id) ?? null;
  }
  f.record = record;
  for (const table of Object.values(locations)) { const seed = get(`seed:${table}`); record(table, seed.id, seed); }
  const snapshot = subject.repository.normalizePlanningPersistenceData({
    ...subject.repository.createEmptyPlanningData("2026-09-01T00:00:00.000Z"),
    projects: [{ id: "p", title: "TEST_ONLY project", status: "active", createdAt: base.created_at, updatedAt: base.updated_at, source: "user", schemaVersion: 1, tags: [] }],
    reviews: [{ id: "sc3-test-review", projectId: "p", title: "TEST_ONLY review", status: "draft", createdAt: base.created_at, updatedAt: base.updated_at, source: "user", schemaVersion: 3, tags: [] }]
  });
  put("planning", { envelopeVersion: 1, repositoryEpoch: epoch, revision: "9", snapshot });
  put("review", { reviewId: "sc3-test-review", reviewType: "custom", descriptorIdentity: "review/primary/custom/v1", outlineSections: subject.reconcileReviewOutlineSections("custom", []), structuredRevision: 0, lifecycleEvidence: "review-lifecycle/v1:none", lifecycleStatus: "active", createdAt: base.created_at, updatedAt: base.updated_at });
  globalThis.CustomEvent ??= class { constructor(type, options) { this.type = type; this.detail = options?.detail; } };
  globalThis.window = { __TAURI_INTERNALS__: {}, localStorage: { getItem: key => key === "researchpilot.dataSourceMode" ? "sqlite" : null }, dispatchEvent() {}, addEventListener() {}, removeEventListener() {} };
  globalThis.__sidebarIPC = async (command, args) => {
    if (command === "planning_repository_read") return get("planning");
    if (command === "db_get_record") { const row = record(args.tableName, args.id); return row?.deleted_at ? null : row; }
    if (command === "db_get_deleted_record") { const row = record(args.tableName, args.id); return row?.deleted_at ? row : null; }
    if (command === "db_list_records") return db.prepare(`SELECT * FROM ${quote(args.tableName)}`).all().filter(row => !row.deleted_at);
    if (command === "read_review_structured_states") return args.reviewIds.map(() => get("review"));
    if (command === "db_update_record" || command === "db_save_record") {
      if (f.failWrite) throw new Error("TEST_ONLY persistence rejection");
      const changed = record(args.tableName, args.id ?? args.record.id, args.record, args.expectedUpdatedAt); if (changed) f.writes++;
      return command === "db_update_record" ? changed : undefined;
    }
    if (command === "replace_review_structured_state") {
      if (f.failWrite) throw new Error("TEST_ONLY persistence rejection");
      const previous = get("review"), input = args.input;
      assert.equal(input.expectedStructuredRevision, previous.structuredRevision);
      assert.equal(input.expectedDescriptorIdentity, previous.descriptorIdentity);
      assert.equal(input.expectedLifecycleEvidence, previous.lifecycleEvidence);
      assert.equal(previous.lifecycleStatus, "active");
      const next = { ...previous, reviewType: input.reviewType, outlineSections: input.outlineSections, structuredRevision: previous.structuredRevision + 1, updatedAt: new Date().toISOString() };
      put("review", next); f.writes++; return next;
    }
    if (command === "plugin:event|emit") return;
    throw new Error(`Unexpected native command ${command}`);
  };
  subject.repository.activatePlanningRepositoryProducerWriter({ processGeneration: "sc3-fixture", producerSessionGeneration: 1, transportGeneration: 1 });
  await subject.repository.bootstrapPlanningSQLitePersistence();
  return f;
}

test("all ten current owner/channel descriptors write through canonical services and survive SQLite reopen", async () => {
  const f = await fixture();
  for (const entry of subject.MANUSCRIPT_OUTLINE_DESCRIPTOR_REGISTRY) {
    const identity = { ownerType: entry.ownerType, channel: entry.channel, ownerId: `sc3-test-${entry.ownerType}`, ...(entry.ownerType === "review" ? { reviewType: "custom" } : {}) };
    const baseline = await subject.readStructuredSidebar(identity);
    const before = entry.ownerType === "review" ? f.get("planning") : f.record(locations[entry.ownerType], identity.ownerId);
    const values = Object.fromEntries(subject.getManuscriptOutlineDescriptor(identity).fields.map(field => [field.stableKey, `TEST_ONLY ${entry.channel}/${field.stableKey}`]));
    assert.deepEqual((await subject.saveStructuredSidebar(baseline, values)).values, values);
    f.reopen();
    assert.deepEqual((await subject.readStructuredSidebar(identity)).values, values);
    const after = entry.ownerType === "review" ? f.get("planning") : f.record(locations[entry.ownerType], identity.ownerId);
    if (entry.ownerType === "review") assert.deepEqual(after, before);
    else for (const key of ["id", "title", "project_id", "experiment_id", "created_at", "created_local_date", "created_local_time", "workspace_title_identity", "tags"]) assert.equal(after[key], before[key], `${entry.ownerType} preserves ${key}`);
    if (entry.ownerType === "review") { assert.equal(f.get("review").structuredRevision, 1); assert.equal(f.get("planning").revision, "9"); }
    const cleared = Object.fromEntries(Object.keys(values).map(key => [key, ""]));
    assert.deepEqual((await subject.saveStructuredSidebar(await subject.readStructuredSidebar(identity), cleared)).values, cleared);
  }
  assert.equal(f.writes, 20);
  assert.equal(JSON.parse(f.record("literatures", "sc3-test-literature").custom_fields).find(field => field.id === "unrelated").value, "keep");
  console.log(JSON.stringify({ fixturePath: f.path, writes: f.writes, owners: Object.keys(locations), Review: f.get("review"), PlanningRevision: f.get("planning").revision }));
  f.close();
});

test("conflict, archived, deleted and durable failure refuse writes and preserve the caller draft", async () => {
  const f = await fixture();
  const identity = { ownerType: "literature", ownerId: "sc3-test-literature", channel: "literature_outline" };
  const baseline = await subject.readStructuredSidebar(identity), draft = { ...baseline.values, summary: "unsaved" };
  f.record("literatures", identity.ownerId, { abstract: "external" });
  await assert.rejects(() => subject.saveStructuredSidebar(baseline, draft), /其它入口变化/);
  const fresh = await subject.readStructuredSidebar(identity);
  f.record("literatures", identity.ownerId, { archived_at: "archived" });
  await assert.rejects(() => subject.saveStructuredSidebar(fresh, draft), /只读/);
  f.record("literatures", identity.ownerId, { archived_at: null, deleted_at: "deleted" });
  await assert.rejects(() => subject.saveStructuredSidebar(fresh, draft));
  f.record("literatures", identity.ownerId, { deleted_at: null }); f.failWrite = true;
  await assert.rejects(() => subject.saveStructuredSidebar(fresh, draft), /TEST_ONLY persistence rejection/);
  assert.equal(draft.summary, "unsaved"); assert.equal(f.writes, 0); assert.equal(f.record("literatures", identity.ownerId).abstract, "external");
  f.close();
});

test("mounted sidebar explicit save, cancel and errors preserve separate Raw bytes", async () => {
  const f = await fixture(), raw = join(f.directory, "raw.md"); writeFileSync(raw, "Raw original\r\n");
  const ref = React.createRef(); let renderer;
  await act(async () => { renderer = create(React.createElement(subject.Sidebar, { ref, identity: { ownerType: "literature", ownerId: "sc3-test-literature", channel: "literature_outline" }, disabled: false, onDraftChange() {}, ui: x => x })); });
  assert.equal(renderer.root.findAllByType("textarea").length, 0);
  assert.equal(ref.current.isDirty(), false);
  await editSidebar(renderer);
  const summary = () => renderer.root.findAllByType("textarea")[0];
  await act(async () => { summary().props.onChange({ target: { value: "new summary" } }); });
  assert.equal(ref.current.isDirty(), true);
  f.failWrite = true; await act(async () => { assert.equal(await ref.current.save(), false); });
  assert.equal(summary().props.value, "new summary"); assert.equal(ref.current.isDirty(), true);
  f.failWrite = false; await act(async () => { assert.equal(await ref.current.save(), true); });
  f.reopen(); assert.equal((await subject.readStructuredSidebar({ ownerType: "literature", ownerId: "sc3-test-literature", channel: "literature_outline" })).values.summary, "new summary");
  assert.equal(readFileSync(raw, "utf8"), "Raw original\r\n");
  assert.equal(renderer.root.findAllByType("textarea").length, 0);
  await editSidebar(renderer);
  await act(async () => { summary().props.onChange({ target: { value: "cancel me" } }); ref.current.discard(); });
  assert.equal(renderer.root.findAllByType("textarea").length, 0);
  assert.ok(renderer.root.findAllByType("dd").some(node => node.children.join("") === "new summary"));
  assert.equal(ref.current.isDirty(), false);
  await act(async () => renderer.unmount()); f.close();
});

test("native exit sees participant structured dirty when the exact Raw runtime session is clean", async () => {
  const raw = { sessionKey: "session", sessionGeneration: 1, logicalIdentity: { ownerType: "literature", ownerId: "sc3-test-literature", channel: "literature_outline", windowRole: "current", fileRefId: "raw" }, dirty: false };
  let structuredDirty = true, closes = 0;
  const controller = subject.createSharedEditorLifecycleController({ listSessions: () => [raw], createId: () => "decision" });
  controller.register({ participantId: "p", handle: "h", presentationEpoch: 1, readSession: () => ({ ...raw, dirty: raw.dirty || structuredDirty }), async save() { structuredDirty = false; }, async discard() { structuredDirty = false; } });
  const result = await controller.requestSequence({ trigger: "native-window-close", continuationIntent: "CLOSE_WINDOW", surface: "application", continuation: () => { closes++; } });
  assert.equal(result.status, "decision-required"); assert.equal(closes, 0);
  await controller.resolve(result.request.requestToken, "cancel"); assert.equal(closes, 0); assert.equal(structuredDirty, true);
  const second = await controller.requestSequence({ trigger: "application-exit", continuationIntent: "APP_EXIT", surface: "application", continuation: () => { closes++; } });
  await controller.resolve(second.request.requestToken, "save"); assert.equal(structuredDirty, false); assert.equal(closes, 1);
});

test("mounted Review descriptor refresh preserves the admitted unsaved draft and refuses redirected save", async () => {
  const f = await fixture(), ref = React.createRef(); let renderer;
  const properties = { ref, identity: { ownerType: "review", ownerId: "sc3-test-review", channel: "primary", reviewType: "custom" }, disabled: false, onDraftChange() {}, ui: x => x };
  await act(async () => { renderer = create(React.createElement(subject.Sidebar, properties)); });
  await editSidebar(renderer);
  await act(async () => { renderer.root.findAllByType("textarea")[0].props.onChange({ target: { value: "keep unsaved Review draft" } }); });
  await act(async () => { renderer.update(React.createElement(subject.Sidebar, { ...properties, identity: { ...properties.identity, reviewType: "periodic" } })); });
  assert.equal(renderer.root.findAllByType("textarea")[0].props.value, "keep unsaved Review draft");
  assert.equal(renderer.root.findAllByType("textarea")[0].props.disabled, true);
  assert.equal(ref.current.isDirty(), true); assert.equal(await ref.current.save(), false); assert.equal(f.writes, 0);
  await act(async () => renderer.unmount()); f.close();
});

test("mounted shared current window separates Raw Save and structured Save and guards switch/close", async () => {
  const f = await fixture(), rawPath = join(f.directory, "window-raw.md");
  writeFileSync(rawPath, "Original Raw\r\n");
  const identity = { ownerType: "literature", channel: "literature_outline" };
  const session = { key: "window-session", sessionKey: "window-session", sessionGeneration: 1,
    logicalIdentity: { ...identity, ownerId: "sc3-test-literature", windowRole: "current", fileRefId: "raw-file" },
    owner: { ...identity, ownerId: "sc3-test-literature" }, accessMode: "writable", file: { fileName: "window-raw.md" }, dirty: false };
  let state = { sessionGeneration: 1, descriptorLookupIdentity: identity, projectionGeneration: 1, dirty: false, saveDisabled: false, regionDrafts: [], projection: { classification: "PROJECTABLE", projectionNodes: [], insertionAnchors: [] } };
  let rawDraft = "Original Raw\r\n", switches = 0, closes = 0;
  const adapter = { read: () => state, attach: () => state, detach() {},
    async save() { writeFileSync(rawPath, rawDraft); state = { ...state, dirty: false }; return { projectionState: state }; },
    presentSaveResult: () => ({ terminal: { terminalClass: "SUCCESS_CHANGED" }, primaryFeedbackOwner: "shared-editor-operation-controller", userMessageKey: "ordinary.save.changed" }),
    async discard() { rawDraft = readFileSync(rawPath, "utf8"); state = { ...state, dirty: false }; return { status: "success", projectionState: state }; }
  };
  let renderer;
  await act(async () => { renderer = create(React.createElement(subject.I18nProvider, null, React.createElement(subject.Window, {
    isOpen: true, descriptorLookupIdentity: identity, entryKind: "current", entityTitle: "TEST_ONLY",
    lifecycle: { participantId: "window-participant", handle: "window-handle", presentationEpoch: 1, readSession: () => session },
    sessionAdapter: adapter, footerLeadingActions: [{ key: "switch", label: "切换文稿", onClick: () => { switches++; } }],
    onCancel: () => { closes++; }
  }))); });
  await editSidebar(renderer);
  const summary = () => renderer.root.findAllByType("textarea")[0];
  await act(async () => { summary().props.onChange({ target: { value: "structured pending" } }); });
  state = { ...state, dirty: true }; rawDraft = "New Raw exact\r\n";
  await act(async () => renderer.root.findByProps({ "data-footer-slot": "save" }).props.onClick());
  assert.equal(readFileSync(rawPath, "utf8"), "New Raw exact\r\n");
  assert.equal((await subject.readStructuredSidebar({ ...identity, ownerId: "sc3-test-literature" })).values.summary, "before");
  assert.equal(summary().props.value, "structured pending");
  await act(async () => renderer.root.findByProps({ "data-footer-slot": "switch" }).props.onClick());
  assert.equal(switches, 0); assert.equal(renderer.root.findAllByProps({ role: "alertdialog" }).length, 1);
  await act(async () => { await subject.controller.resolve(subject.controller.getSnapshot().request.requestToken, "cancel"); });
  assert.equal(summary().props.value, "structured pending");
  await act(async () => renderer.root.findByProps({ "data-footer-slot": "cancel" }).props.onClick());
  f.failWrite = true;
  await act(async () => { const result = await subject.controller.resolve(subject.controller.getSnapshot().request.requestToken, "save"); assert.equal(result.status, "failed"); });
  assert.equal(closes, 0); assert.equal(summary().props.value, "structured pending");
  f.failWrite = false;
  await act(async () => { await subject.controller.resolve(subject.controller.getSnapshot().request.requestToken, "save"); });
  assert.equal(closes, 1); f.reopen();
  assert.equal((await subject.readStructuredSidebar({ ...identity, ownerId: "sc3-test-literature" })).values.summary, "structured pending");
  assert.equal(readFileSync(rawPath, "utf8"), "New Raw exact\r\n");
  await act(async () => renderer.unmount()); f.close();
});

test("entering and cancelling unchanged edit mode never writes or marks dirty; read-only stays a summary", async () => {
  const f = await fixture(), ref = React.createRef(); let renderer;
  const props = { ref, identity: { ownerType: "experiment", ownerId: "sc3-test-experiment", channel: "primary" }, disabled: false, onDraftChange() {}, ui: x => x };
  await act(async () => { renderer = create(React.createElement(subject.Sidebar, props)); });
  assert.equal(renderer.root.findAllByType("textarea").length, 0);
  await editSidebar(renderer);
  assert.equal(renderer.root.findAllByType("textarea").length, 6);
  assert.equal(ref.current.isDirty(), false);
  await act(async () => ref.current.discard());
  assert.equal(renderer.root.findAllByType("textarea").length, 0);
  assert.equal(f.writes, 0);
  await act(async () => { renderer.update(React.createElement(subject.Sidebar, { ...props, disabled: true })); });
  assert.equal(renderer.root.findAllByType("button")[0].props.disabled, true);
  assert.equal(renderer.root.findAllByType("textarea").length, 0);
  await act(async () => renderer.unmount()); f.close();
});

test("A to B to A cannot revive a late read on the same sidebar mount", async () => {
  const f = await fixture(), originalIPC = globalThis.__sidebarIPC; let release;
  const wait = new Promise(resolve => { release = resolve; });
  globalThis.__sidebarIPC = async (command, args) => {
    if (command === "db_get_record" && args.tableName === "literatures") await wait;
    return originalIPC(command, args);
  };
  const props = { identity: { ownerType: "literature", ownerId: "sc3-test-literature", channel: "dedicated_notes" }, disabled: false, onDraftChange() {}, ui: x => x };
  let renderer;
  await act(async () => { renderer = create(React.createElement(subject.Sidebar, props)); });
  await act(async () => { renderer.update(React.createElement(subject.Sidebar, { ...props, identity: { ...props.identity, ownerId: "other" } })); });
  await act(async () => { renderer.update(React.createElement(subject.Sidebar, props)); release(); });
  assert.equal(renderer.root.findAllByType("dd").length, 0);
  assert.equal(renderer.root.findAllByType("textarea").length, 0);
  assert.ok(renderer.root.findAllByProps({ role: "alert" }).length);
  assert.equal(f.writes, 0);
  await act(async () => renderer.unmount()); f.close();
});

test("late completed save after A to B to A does not replace the admitted draft or report success", async () => {
  const f = await fixture(), originalIPC = globalThis.__sidebarIPC, ref = React.createRef(); let release;
  const wait = new Promise(resolve => { release = resolve; });
  const props = { ref, identity: { ownerType: "literature", ownerId: "sc3-test-literature", channel: "dedicated_notes" }, disabled: false, onDraftChange() {}, ui: x => x };
  let renderer, saving;
  await act(async () => { renderer = create(React.createElement(subject.Sidebar, props)); });
  await editSidebar(renderer);
  await act(async () => renderer.root.findAllByType("textarea")[0].props.onChange({ target: { value: "pending exact owner A" } }));
  globalThis.__sidebarIPC = async (command, args) => {
    if (command === "db_update_record") await wait;
    return originalIPC(command, args);
  };
  await act(async () => { saving = ref.current.save(); });
  await act(async () => renderer.update(React.createElement(subject.Sidebar, { ...props, identity: { ...props.identity, ownerId: "other" } })));
  await act(async () => renderer.update(React.createElement(subject.Sidebar, props)));
  await act(async () => { release(); assert.equal(await saving, false); });
  assert.equal(renderer.root.findAllByType("textarea")[0].props.value, "pending exact owner A");
  assert.equal(ref.current.isDirty(), true);
  assert.equal(renderer.root.findAllByProps({ role: "status" }).some(n => n.children.join("").includes("已保存并读回")), false);
  await act(async () => renderer.unmount()); f.close();
});

test("a committed write with mismatching readback keeps its draft and warning through cancel", async () => {
  const f = await fixture(), originalIPC = globalThis.__sidebarIPC, ref = React.createRef();
  const props = { ref, identity: { ownerType: "literature", ownerId: "sc3-test-literature", channel: "literature_outline" }, disabled: false, onDraftChange() {}, ui: x => x };
  let renderer;
  await act(async () => { renderer = create(React.createElement(subject.Sidebar, props)); });
  await editSidebar(renderer);
  await act(async () => renderer.root.findAllByType("textarea")[0].props.onChange({ target: { value: "intended" } }));
  globalThis.__sidebarIPC = async (command, args) => {
    const result = await originalIPC(command, args);
    if (command === "db_update_record" && args.tableName === "literatures") f.record("literatures", props.identity.ownerId, { abstract: "different readback" });
    return result;
  };
  await act(async () => assert.equal(await ref.current.save(), false));
  assert.equal(renderer.root.findAllByType("textarea")[0].props.value, "intended");
  assert.ok(renderer.root.findAllByProps({ role: "alert" }).some(n => n.children.join("").includes("读回")));
  await act(async () => ref.current.discard());
  assert.ok(renderer.root.findAllByProps({ role: "alert" }).some(n => n.children.join("").includes("读回")));
  assert.equal(f.record("literatures", props.identity.ownerId).abstract, "different readback");
  await act(async () => renderer.unmount()); f.close();
});

test("representative notes, Experiment, Review and Output sidebars share readonly/edit/save with durable canonical readback", async () => {
  const f = await fixture();
  for (const identity of [
    { ownerType: "literature", ownerId: "sc3-test-literature", channel: "dedicated_notes" },
    { ownerType: "experiment", ownerId: "sc3-test-experiment", channel: "primary" },
    { ownerType: "review", ownerId: "sc3-test-review", channel: "primary", reviewType: "periodic" },
    { ownerType: "finding", ownerId: "sc3-test-finding", channel: "primary" }
  ]) {
    if (identity.ownerType === "review") f.put("review", { ...f.get("review"), reviewType: "periodic", descriptorIdentity: "review/primary/periodic/v1", outlineSections: subject.reconcileReviewOutlineSections("periodic", []) });
    const ref = React.createRef(); let renderer;
    await act(async () => { renderer = create(React.createElement(subject.Sidebar, { ref, identity, disabled: false, onDraftChange() {}, ui: x => x })); });
    assert.equal(renderer.root.findAllByType("textarea").length, 0);
    await editSidebar(renderer);
    const expected = `TEST_ONLY ${identity.ownerType}/${identity.channel} saved`;
    await act(async () => renderer.root.findAllByType("textarea")[0].props.onChange({ target: { value: expected } }));
    await act(async () => assert.equal(await ref.current.save(), true));
    assert.equal(renderer.root.findAllByType("textarea").length, 0);
    f.reopen();
    assert.equal(Object.values((await subject.readStructuredSidebar(identity)).values)[0], expected);
    await act(async () => renderer.unmount());
  }
  f.close();
});
