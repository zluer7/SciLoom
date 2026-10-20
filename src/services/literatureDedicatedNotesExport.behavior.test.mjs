import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { build } from "esbuild";
import React from "react";
import { act, create } from "react-test-renderer";

const bundle = await build({ stdin: { contents: `
  export {literatureDedicatedNotesExportService as service} from './literatureDedicatedNotesExportService';
  export {LiteratureDedicatedNotesExportButton as Button} from '../pages/Literature/LiteratureDedicatedNotesExportButton';
  export {I18nProvider} from '../i18n/I18nProvider';
`, resolveDir: import.meta.dirname }, bundle: true, write: false, format: "cjs", platform: "node", target: "es2022",
  external: ["react", "react/jsx-runtime"], loader: { ".md": "text" }, logLevel: "silent",
  plugins: [{ name: "controlled-source-and-native-boundary", setup(api) {
    for (const name of ["literatureService", "planningService", "fileRefOwnerValidator"]) {
      api.onResolve({ filter: new RegExp(`^\\./${name}$`) }, () => ({ path: name, namespace: "source" }));
    }
    api.onLoad({ filter: /.*/, namespace: "source" }, ({ path }) => ({ contents: path === "literatureService"
      ? "export const literatureService={getLiteratureById:id=>globalThis.__notesRead(id)};"
      : path === "planningService" ? "export const getProjectById=async id=>globalThis.__notesProject(id);export const planningService={getProjectById};"
      : "export const resolveMountedManuscriptLifecycleDecision=async()=>globalThis.__notesLifecycle();export function validateFileRefOwner(){throw new Error('Unexpected FileRef write')}" }));
    api.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: "ipc", namespace: "native" }));
    api.onLoad({ filter: /.*/, namespace: "native" }, () => ({ contents: "export const invoke=(...args)=>globalThis.__notesNative(...args); export const isTauri=()=>true;export const convertFileSrc=x=>x;export class Channel{}" }));
  } }]
});
const module = { exports: {} };
new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { service, Button, I18nProvider } = module.exports;
const identity = { literatureId: "a", projectId: "p" };
const fields = ["knowledgeProjectSummary", "knowledgeProjectRelevance", "knowledgeRelatedObjectNotes", "knowledgeReusableMethods", "knowledgeComparableConclusions", "knowledgeOther"];
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture() {
  const db = new DatabaseSync(":memory:"); db.exec("CREATE TABLE literature(id TEXT PRIMARY KEY, payload TEXT)");
  const directory = mkdtempSync(join(tmpdir(), "sc3-c1-a2-notes-"));
  const put = (id, patch = {}) => {
    const row = { id, title: `TEST_ONLY 文献 ${id} [方括号]`, primaryProjectId: "p", updatedAt: "r1", abstract: "OUTLINE_ONLY",
      customFields: fields.map((name, i) => ({ name, value: i === 5 ? "" : `已保存 ${i}\n第二行 *literal* [link] <tag>\n` + "````literal" })), ...patch };
    db.prepare("INSERT OR REPLACE INTO literature VALUES (?,?)").run(id, JSON.stringify(row)); return row;
  };
  put("a"); put("b");
  const f = { db, directory, calls: [], canRead: true, project: { id: "p" }, cancel: false,
    readWait: null, saveWait: null, fail: false, put,
    snapshot: () => JSON.stringify(db.prepare("SELECT * FROM literature ORDER BY id").all()) };
  globalThis.window = { __TAURI_INTERNALS__: {}, localStorage: { getItem: () => null }, addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
  globalThis.__notesRead = async id => { if (f.readWait) await f.readWait; const row = db.prepare("SELECT payload FROM literature WHERE id=?").get(id); return row ? JSON.parse(row.payload) : undefined; };
  globalThis.__notesProject = () => f.project;
  globalThis.__notesLifecycle = () => ({ canRead: f.canRead });
  globalThis.__notesNative = async (command, args) => {
    assert.equal(command, "save_text_file"); f.calls.push({ ...args });
    if (f.saveWait) await f.saveWait;
    if (f.fail) throw new Error("CONTROLLED_WRITE_FAILURE");
    if (f.cancel) return null;
    const path = join(directory, `actual-controlled-${f.calls.length}.md`);
    writeFileSync(path, args.contents, "utf8"); return path;
  };
  return f;
}

test("fresh six-field projection follows the descriptor, preserves literal text and exports exact UTF-8 without source writes", async () => {
  const f = fixture(), before = f.snapshot();
  const snapshot = await service.prepare(identity, "zh-CN");
  assert.equal(Object.isFrozen(snapshot), true); assert.equal(Object.isFrozen(snapshot.identity), true);
  assert.equal((snapshot.markdown.match(/^## /gm) ?? []).length, 6);
  assert.ok(snapshot.markdown.includes("已保存 0\n第二行 *literal* [link] <tag>\n````literal"));
  assert.ok(snapshot.markdown.includes("`````\n")); assert.ok(snapshot.markdown.includes("未设置"));
  for (const forbidden of ["OUTLINE_ONLY", "RAW_ONLY", "UNSAVED_ONLY", "<!-- labpod"]) assert.equal(snapshot.markdown.includes(forbidden), false);
  const receipt = await service.savePrepared(snapshot, () => true);
  const bytes = readFileSync(receipt.result.filePath);
  assert.equal(bytes.toString("utf8"), snapshot.markdown); assert.equal(bytes.length, snapshot.byteLength);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), snapshot.sha256);
  assert.equal(f.snapshot(), before);
  f.put("a", { customFields: fields.map(name => ({ name, value: "LATEST_SAVED" })) });
  assert.ok((await service.prepare(identity, "en-US")).markdown.includes("LATEST_SAVED"));
  console.log(JSON.stringify({ evidence: "CONTROLLED", filePath: receipt.result.filePath, sha256: snapshot.sha256, byteLength: bytes.length }));
  f.db.close();
});

test("cancel, failure, denied owner, deleted owner, wrong Project and unavailable Project never pretend success", async () => {
  const f = fixture(); const snapshot = await service.prepare(identity, "zh-CN");
  f.cancel = true; assert.equal((await service.savePrepared(snapshot, () => true)).status, "canceled");
  assert.equal(existsSync(join(f.directory, "actual-controlled-1.md")), false);
  f.fail = true; await assert.rejects(service.savePrepared(snapshot, () => true), /CONTROLLED_WRITE_FAILURE/);
  f.canRead = false; await assert.rejects(service.prepare(identity, "zh-CN"), /SOURCE_UNAVAILABLE/);
  f.canRead = true; f.put("a", { deletedAt: "deleted" }); await assert.rejects(service.prepare(identity, "zh-CN"));
  f.put("a"); await assert.rejects(service.prepare({ ...identity, projectId: "wrong" }, "zh-CN"));
  f.project = undefined; await assert.rejects(service.prepare(identity, "zh-CN"), /PROJECT_UNAVAILABLE/);
  assert.equal(f.calls.length, 2); f.db.close();
});

test("readable archived source exports saved fields without enabling structured writes; null Project is explicit", async () => {
  const f = fixture(); f.put("a", { isArchived: true, archivedAt: "archived", primaryProjectId: null });
  const snapshot = await service.prepare({ literatureId: "a", projectId: null }, "en-US");
  assert.ok(snapshot.markdown.includes("Saved structured notes")); assert.equal(f.calls.length, 0); f.db.close();
});

test("stale pre-dialog work refuses the writer; late native success remains bound to its frozen source", async () => {
  const f = fixture(), snapshot = await service.prepare(identity, "zh-CN");
  assert.equal((await service.savePrepared(snapshot, () => false)).status, "stale"); assert.equal(f.calls.length, 0);
  const pending = defer(); f.saveWait = pending.promise; let current = true;
  const saving = service.savePrepared(snapshot, () => current);
  for (let i = 0; i < 20 && !f.calls.length; i++) await new Promise(r => setImmediate(r));
  current = false; f.put("a", { customFields: fields.map(name => ({ name, value: "AFTER_DIALOG" })) }); pending.resolve();
  const receipt = await saving;
  assert.equal(receipt.status, "saved"); assert.equal(receipt.snapshot, snapshot);
  assert.equal(readFileSync(receipt.result.filePath, "utf8"), snapshot.markdown);
  assert.equal(f.calls[0].contents.includes("AFTER_DIALOG"), false); f.db.close();
});

const props = { identity, scopeId: "p", sourceRevision: "r1", disabled: false, hasUnsavedEdits: false };
const wrapped = p => React.createElement(I18nProvider, null, React.createElement(Button, p));
test("mounted unique short Export button disables unsaved-card edits, prevents duplicates and handles native cancel", async () => {
  const f = fixture(), pending = defer(); let renderer;
  await act(async () => { renderer = create(wrapped({ ...props, hasUnsavedEdits: true })); });
  const button = () => renderer.root.findByProps({ "data-testid": "dedicated-notes-export" });
  assert.equal(button().props.disabled, true);
  await act(async () => renderer.update(wrapped(props)));
  f.readWait = pending.promise;
  await act(async () => { button().props.onClick(); button().props.onClick(); });
  assert.equal(button().props.disabled, true); f.cancel = true;
  await act(async () => { pending.resolve(); });
  for (let i = 0; i < 20 && !f.calls.length; i++) await act(async () => new Promise(r => setImmediate(r)));
  assert.equal(f.calls.length, 1); assert.equal(button().props["aria-busy"], false);
  assert.equal(renderer.root.findAllByProps({ role: "status" }).length, 1);
  await act(async () => renderer.unmount()); f.db.close();
});

test("mounted A to B to A invalidates delayed prepare and delayed native feedback; never exports a different selection", async () => {
  const f = fixture(), read = defer(); let renderer;
  await act(async () => { renderer = create(wrapped(props)); });
  const click = () => renderer.root.findByProps({ "data-testid": "dedicated-notes-export" }).props.onClick();
  f.readWait = read.promise; await act(async () => click());
  await act(async () => renderer.update(wrapped({ ...props, identity: { ...identity, literatureId: "b" } })));
  await act(async () => renderer.update(wrapped(props)));
  await act(async () => read.resolve());
  for (let i = 0; i < 5; i++) await act(async () => new Promise(r => setImmediate(r)));
  assert.equal(f.calls.length, 0);
  f.readWait = null; const save = defer(); f.saveWait = save.promise;
  await act(async () => click());
  for (let i = 0; i < 20 && !f.calls.length; i++) await act(async () => new Promise(r => setImmediate(r)));
  await act(async () => renderer.update(wrapped({ ...props, identity: { ...identity, literatureId: "b" } })));
  await act(async () => { save.resolve(); });
  assert.equal(f.calls.length, 1); assert.ok(f.calls[0].contents.includes("文献 a"));
  assert.equal(renderer.root.findAllByProps({ role: "status" }).length, 0);
  await act(async () => renderer.unmount()); f.db.close();
});

test("only the dedicated-notes card mounts the new entry next to Edit", () => {
  const page = readFileSync(new URL("../pages/Literature/LiteraturePage.tsx", import.meta.url), "utf8");
  assert.equal((page.match(/<LiteratureDedicatedNotesExportButton\b/g) ?? []).length, 1);
  assert.match(page, /literature-knowledge-deposit-actions[\s\S]*?openProjectSpecificNotesEditor[\s\S]*?<LiteratureDedicatedNotesExportButton/);
});
