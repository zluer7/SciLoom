import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";

// Actual canonical services, guard, owner port and persistence with a task-owned
// durable SQLite IPC transport fixture. Native IPC E2E is not claimed.
const bundle = await build({
  stdin: {
    contents: `
      export * as service from './planningService';
      export * as repository from './planningRepository';
      export {planningOwnerAuthorityPort as port} from './planningOwnerAuthorityPort';
      export {authorityWriterGuard as guard} from './authorityWriterGuard';
    `,
    resolveDir: import.meta.dirname,
    sourcefile: "planning-archived-seams-harness.ts"
  },
  bundle: true, write: false, format: "cjs", platform: "node", target: "es2022",
  logLevel: "silent",
  plugins: [{ name: "native-ipc-boundary", setup(api) {
    api.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: "ipc", namespace: "fixture" }));
    api.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `
      export const invoke=(command,args)=>globalThis.__archivedSeamsIPC(command,args);
      export const isTauri=()=>true;
      export const convertFileSrc=x=>x;
    ` }));
  } }]
});
const module = { exports: {} };
new Function("require", "module", "exports", bundle.outputFiles[0].text)(
  createRequire(import.meta.url), module, module.exports
);
const { service, repository, port, guard } = module.exports;
const epoch = "11111111-1111-4111-8111-111111111111";
const session = { processGeneration: "test", producerSessionGeneration: 1, transportGeneration: 1 };
const base = { createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z", tags: [], source: "user", schemaVersion: 1 };
const wire = value => JSON.parse(JSON.stringify(value));

async function fixture() {
  const f = {
    target: { envelopeVersion: 1, repositoryEpoch: epoch, revision: "9", snapshot: repository.normalizePlanningPersistenceData({
      ...repository.createEmptyPlanningData("2026-09-01T00:00:00.000Z"),
      projects: [{ ...base, id: "p", title: "Project", status: "active" }, { ...base, id: "other", title: "Other", status: "active" }],
      routeNodes: [{ ...base, id: "r", projectId: "p", title: "Route", status: "active" }],
      // Missing unrelated Review second-layer state must not block Task restore.
      reviews: [{ ...base, id: "review", projectId: "p", title: "First layer only" }],
      tasks: [{ ...base, id: "t", projectId: "p", routeNodeId: "r", title: "Archived task", status: "archived", archivedAt: "archive-time", captureState: "archived", taskType: "analysis", priority: "high", timeBucket: "today", orderIndex: 2,
        description: "Keep the business content", resultNote: "Keep the completed result", completedAt: "completion-time", acceptanceCriteria: "Keep criteria", customFields: { sourceOutputGapId: "gap", nested: { value: 7 } }, aiMetadata: { needsReview: true } }],
      entityLinks: [{ ...base, id: "link", sourceType: "outputGap", sourceId: "gap", targetType: "task", targetId: "t", relationType: "needs_followup_task" }]
    }) },
    writes: 0, commits: 0, invalidations: 0, leases: new Map(), fault: undefined
  };
  const path = join(mkdtempSync(join(tmpdir(), "sc3-a4-a1-seams-")), "isolated.sqlite3");
  let db = new DatabaseSync(path);
  db.exec("CREATE TABLE planning_fixture(id INTEGER PRIMARY KEY CHECK(id=1), envelope TEXT NOT NULL)");
  const initial = wire(f.target);
  db.prepare("INSERT INTO planning_fixture VALUES (1,?)").run(JSON.stringify(initial));
  Object.defineProperty(f, "target", {
    get() { return JSON.parse(db.prepare("SELECT envelope FROM planning_fixture WHERE id=1").get().envelope); },
    set(value) { db.prepare("UPDATE planning_fixture SET envelope=? WHERE id=1").run(JSON.stringify(value)); }
  });
  f.path = path;
  f.close = () => db.close();
  f.reopen = () => { db.close(); db = new DatabaseSync(path); };
  console.log(JSON.stringify({ fixturePath: path, purpose: "TEST_ONLY HR23 canonical wrapper readback", productDatabaseOpened: false }));
  globalThis.window = {
    __TAURI_INTERNALS__: {},
    localStorage: { getItem(key) { assert.equal(key, "researchpilot.dataSourceMode", "no legacy Planning read/fallback"); return "sqlite"; } },
    dispatchEvent() { f.invalidations++; }
  };
  globalThis.__archivedSeamsIPC = async (command, args) => {
    if (command === "planning_repository_read") return structuredClone(f.target);
    if (command === "planning_repository_commit") {
      f.commits++;
      const request = { ...args.request, ...f.fault };
      const expectedIdentity = { repositoryEpoch: request.expectedEpoch, revision: request.expectedRevision };
      const currentIdentity = { repositoryEpoch: f.target.repositoryEpoch, revision: f.target.revision };
      if (request.expectedEpoch !== currentIdentity.repositoryEpoch) return { status: "epoch_mismatch", expectedIdentity, currentIdentity };
      if (request.expectedRevision !== currentIdentity.revision) return { status: "revision_stale", expectedIdentity, currentIdentity };
      f.target = { ...f.target, revision: String(BigInt(f.target.revision) + 1n), snapshot: wire(request.nextSnapshot) };
      f.writes++;
      return { status: "committed", expectedIdentity, envelope: structuredClone(f.target) };
    }
    if (command === "owner_authority_try_acquire_many") {
      const token = `lease-${f.leases.size}`;
      f.leases.set(token, args.requests);
      return { token, requests: args.requests };
    }
    if (command === "owner_authority_validate") {
      assert.deepEqual(f.leases.get(args.token), args.requests);
      return { valid: true, registryGeneration: "fixture" };
    }
    if (command === "owner_authority_release") return { released: f.leases.delete(args.token) };
    if (command === "plugin:event|emit") return;
    throw new Error(`Unexpected native command: ${command}`);
  };
  repository.activatePlanningRepositoryProducerWriter(session);
  await repository.bootstrapPlanningSQLitePersistence();
  return f;
}


function change(f, action) { const envelope = f.target; action(envelope.snapshot); f.target = envelope; }
function business(record) { const { status, captureState, archivedAt, updatedAt, ...rest } = record; return wire(rest); }

test("RouteNode wrapper restores archive with existing ownerRestore, identity and durable facts preserved", async () => {
  const f = await fixture();
  change(f, data => Object.assign(data.routeNodes[0], { status: "archived", archivedAt: "archive", captureState: "archived", description: "Keep", customFields: { nested: [1, false] } }));
  const before = f.target;
  await assert.rejects(() => service.updateRouteNode("r", { title: "Forbidden" }), error => error.code === "PLANNING_AUTHORITY_OWNER_NOT_WRITABLE");
  const restored = await service.restoreRouteNode("r", { status: "active", note: "ignored legacy option", title: "Forbidden" });
  assert.deepEqual(business(restored), business(before.snapshot.routeNodes[0]));
  assert.deepEqual([restored.status, restored.captureState, restored.archivedAt], ["active", "pending", undefined]);
  assert.equal(f.writes, 1); assert.equal(f.target.revision, "10"); f.reopen();
  assert.deepEqual(wire(await service.getRouteNodeById("r")), wire(restored));
  assert.deepEqual(f.target.snapshot.tasks, before.snapshot.tasks);
  assert.deepEqual(f.target.snapshot.reviews, before.snapshot.reviews);
  await assert.rejects(() => service.restoreRouteNode("r"), error => error.code === "PLANNING_ROUTE_NOT_ARCHIVED");
  assert.equal(f.writes, 1); f.close();
});

for (const [kind, code] of [["deleted", "PLANNING_AUTHORITY_OWNER_DELETED"], ["project-deleted", "PLANNING_AUTHORITY_PROJECT_UNAVAILABLE"], ["invalid-status", "PLANNING_ROUTE_RESTORE_STATUS_INVALID"], ["missing", "PLANNING_AUTHORITY_OWNER_NOT_FOUND"], ["cas", "PLANNING_SNAPSHOT_REVISION_STALE"]]) {
  test(`RouteNode restore rejects ${kind} without resurrection or write`, async () => {
    const f = await fixture(); change(f, data => { Object.assign(data.routeNodes[0], { status: "archived", archivedAt: "archive" }); if(kind === "deleted") data.routeNodes[0].deletedAt = "deleted"; if(kind === "project-deleted") data.projects[0].deletedAt = "deleted"; });
    if (kind === "cas") f.fault = { expectedRevision: "0" };
    const before = f.target;
    await assert.rejects(() => service.restoreRouteNode(kind === "missing" ? "missing" : "r", { status: kind === "invalid-status" ? "archived" : "planned" }), error => error.code === code);
    assert.deepEqual(f.target, before); assert.equal(f.writes, 0); assert.equal(f.leases.size, 0); f.close();
  });
}

test("Review archive wrapper is explicitly unsupported and never routes to typed soft-delete restore", async () => {
  const f = await fixture(); change(f, data => { data.reviews[0].archivedAt = "archive"; });
  const before = f.target;
  await assert.rejects(() => repository.updateReview("review", { title: "Forbidden" }), error => error.code === "PLANNING_AUTHORITY_OWNER_NOT_WRITABLE");
  await assert.rejects(() => service.restoreReview("review"), error => error.code === "PLANNING_REVIEW_ARCHIVE_RESTORE_UNSUPPORTED");
  assert.deepEqual(f.target, before); assert.equal(f.commits, 0); assert.equal(f.writes, 0); f.close();
});

test("Task archive note and lifecycle use one commit with durable merged metadata", async () => {
  const f = await fixture(); change(f, data => Object.assign(data.tasks[0], { status: "doing", archivedAt: undefined, captureState: "scheduled" }));
  const before = f.target.snapshot.tasks[0];
  const archived = await service.archiveTask("t", { note: "TEST_ONLY archive note" });
  assert.equal(f.commits, 1); assert.equal(f.writes, 1); assert.equal(archived.status, "archived"); assert.ok(archived.archivedAt);
  assert.deepEqual(archived.customFields, { ...before.customFields, archiveNote: "TEST_ONLY archive note" });
  f.reopen(); const readback = await service.getTaskById("t"); assert.deepEqual(wire(readback), wire(archived));
  await assert.rejects(() => service.updateTask("t", { customFields: { archiveNote: "Forbidden" } }), error => error.code === "PLANNING_AUTHORITY_OWNER_NOT_WRITABLE");
  assert.equal(f.writes, 1); const restored = await service.restoreTask("t"); assert.deepEqual(business(restored), business(archived)); f.close();
});

test("archive CAS refusal commits neither note nor archive", async () => {
  const f = await fixture(); change(f, data => Object.assign(data.tasks[0], { status: "todo", archivedAt: undefined, captureState: "pending" }));
  const before = f.target; f.fault = { expectedRevision: "0" };
  await assert.rejects(() => service.archiveTask("t", { note: "Must not commit" }), error => error.code === "PLANNING_SNAPSHOT_REVISION_STALE");
  assert.deepEqual(f.target, before); assert.equal(f.commits, 1); assert.equal(f.writes, 0); f.close();
});

test("lost archive acknowledgement is a failure with committed note/archive proven by canonical reopen, no blind retry", async () => {
  const f = await fixture(); change(f, data => Object.assign(data.tasks[0], { status: "todo", archivedAt: undefined, captureState: "pending" }));
  const original = globalThis.__archivedSeamsIPC;
  globalThis.__archivedSeamsIPC = async (command, args) => { const result = await original(command, args); if(command === "planning_repository_commit") throw new Error("TEST_ONLY lost acknowledgement"); return result; };
  await assert.rejects(() => service.archiveTask("t", { note: "Committed note" }));
  assert.equal(f.commits, 1); assert.equal(f.writes, 1); f.reopen(); const actual = await service.getTaskById("t");
  assert.equal(actual.status, "archived"); assert.ok(actual.archivedAt); assert.equal(actual.customFields.archiveNote, "Committed note");
  console.log(JSON.stringify({ fixturePath: f.path, committedDespiteLostAcknowledgement: true, readback: wire(actual) })); f.close();
});
