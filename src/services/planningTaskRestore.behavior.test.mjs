import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";

// Execute the production service, repository, guard, owner port and persistence
// adapter. Only native IPC and browser event transport are represented here;
// real SQLite/CAS/durable/restart acceptance is exercised in the native evidence.
const bundle = await build({
  stdin: {
    contents: `
      export * as service from './planningService';
      export * as repository from './planningRepository';
      export {planningOwnerAuthorityPort as port} from './planningOwnerAuthorityPort';
      export {authorityWriterGuard as guard} from './authorityWriterGuard';
    `,
    resolveDir: import.meta.dirname,
    sourcefile: "planning-task-restore-harness.ts"
  },
  bundle: true, write: false, format: "cjs", platform: "node", target: "es2022",
  logLevel: "silent",
  plugins: [{ name: "native-ipc-boundary", setup(api) {
    api.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: "ipc", namespace: "fixture" }));
    api.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `
      export const invoke=(command,args)=>globalThis.__taskRestoreIPC(command,args);
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
  f.target = wire(f.target);
  globalThis.window = {
    __TAURI_INTERNALS__: {},
    localStorage: { getItem(key) { assert.equal(key, "researchpilot.dataSourceMode", "no legacy Planning read/fallback"); return "sqlite"; } },
    dispatchEvent() { f.invalidations++; }
  };
  globalThis.__taskRestoreIPC = async (command, args) => {
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

function business(task) {
  const { status, captureState, archivedAt, updatedAt, ...preserved } = task;
  // Undefined optional keys have no persisted JSON value, as at native IPC.
  return wire(preserved);
}
async function rejectsWithoutWrite(f, action, code) {
  const before = structuredClone(f.target);
  const count = [f.writes, f.invalidations];
  await assert.rejects(action, error => error.code === code);
  assert.deepEqual(f.target, before);
  assert.deepEqual([f.writes, f.invalidations], count);
  assert.equal(f.leases.size, 0);
}

test("formal create -> ordinary update -> archive -> restore preserves facts, relations and CAS progression", async () => {
  const f = await fixture();
  const task = await service.createTask({ projectId: "p", routeNodeId: "r", title: "New", description: "Content", resultNote: "Result", customFields: { nested: [1, 2] } });
  await service.updateTask(task.id, { acceptanceCriteria: "Ordinary active update" });
  const archived = await service.archiveTask(task.id);
  assert.equal(archived.status, "archived");
  assert.ok(archived.archivedAt);
  const before = structuredClone(f.target);
  const restored = await service.restoreTask(task.id);
  assert.deepEqual(business(restored), business(archived));
  assert.deepEqual([restored.status, restored.captureState, restored.archivedAt], ["todo", "pending", undefined]);
  assert.equal(f.target.revision, "13");
  assert.deepEqual(f.target.snapshot.entityLinks, before.snapshot.entityLinks);
  assert.equal(f.target.snapshot.changeLogs.at(-1).action, "updated");
  assert.deepEqual(wire(await service.getTaskById(task.id)), wire(restored));
});

test("existing result, metadata, Gap link and completedAt survive restore; options cannot carry a patch", async () => {
  const f = await fixture();
  const before = structuredClone(f.target.snapshot);
  const restored = await service.restoreTask("t", { status: "doing", note: "Previously ignored", title: "Forbidden", projectId: "other", resultNote: "Erase", customFields: {} });
  assert.equal(restored.status, "doing");
  assert.deepEqual(business(restored), business(before.tasks[0]));
  for (const key of Object.keys(before).filter(key => !["tasks", "changeLogs", "exportedAt"].includes(key))) {
    assert.deepEqual(f.target.snapshot[key], before[key]);
  }
});

for (const status of ["todo", "doing", "done", "delayed", "blocked", "cancelled"]) {
  test(`existing non-archived status option: ${status}`, async () => {
    await fixture();
    const result = await service.restoreTask("t", { status });
    assert.equal(result.status, status);
    assert.equal(result.completedAt, "completion-time");
  });
}

for (const kind of ["status", "archivedAt", "captureState"]) {
  test(`recognizes current archived selector marker: ${kind}`, async () => {
    const f = await fixture();
    Object.assign(f.target.snapshot.tasks[0], { status: "todo", archivedAt: undefined, captureState: "pending" });
    Object.assign(f.target.snapshot.tasks[0], { [kind]: kind === "archivedAt" ? "archive-time" : "archived" });
    assert.equal((await service.restoreTask("t")).status, "todo");
  });
}

for (const [label, mutate, id, code] of [
  ["non-archived", f => Object.assign(f.target.snapshot.tasks[0], { status: "todo", archivedAt: undefined, captureState: "pending" }), "t", "PLANNING_TASK_NOT_ARCHIVED"],
  ["missing", () => {}, "missing", "PLANNING_AUTHORITY_OWNER_NOT_FOUND"],
  ["permanently absent", f => { f.target.snapshot.tasks = []; }, "t", "PLANNING_AUTHORITY_OWNER_NOT_FOUND"],
  ["soft-deleted and archived", f => { f.target.snapshot.tasks[0].deletedAt = "deleted"; }, "t", "PLANNING_AUTHORITY_OWNER_DELETED"],
  ["soft-deleted non-archived", f => Object.assign(f.target.snapshot.tasks[0], { deletedAt: "deleted", status: "todo", archivedAt: undefined, captureState: "pending" }), "t", "PLANNING_AUTHORITY_OWNER_DELETED"],
  ["deleted Project", f => { f.target.snapshot.projects[0].deletedAt = "deleted"; }, "t", "PLANNING_AUTHORITY_PROJECT_UNAVAILABLE"],
  ["archived Project", f => { f.target.snapshot.projects[0].status = "archived"; }, "t", "PLANNING_AUTHORITY_PROJECT_UNAVAILABLE"],
  ["missing Project", f => { f.target.snapshot.tasks[0].projectId = "missing"; }, "t", "PLANNING_AUTHORITY_PROJECT_NOT_FOUND"],
  ["wrong Route Project", f => { f.target.snapshot.routeNodes[0].projectId = "other"; }, "t", "PLANNING_TASK_ROUTE_PROJECT_MISMATCH"],
  ["missing Route", f => { f.target.snapshot.routeNodes = []; }, "t", "PLANNING_TASK_ROUTE_NOT_FOUND"],
  ["deleted Route", f => { f.target.snapshot.routeNodes[0].deletedAt = "deleted"; }, "t", "PLANNING_TASK_ROUTE_NOT_FOUND"]
]) {
  test(`restore rejects ${label} without write/reconstruction`, async () => {
    const f = await fixture(); mutate(f);
    await rejectsWithoutWrite(f, () => service.restoreTask(id), code);
  });
}

test("invalid target status rejected; archived ordinary update still denied", async () => {
  const f = await fixture();
  for (const status of ["archived", "unknown"]) {
    await rejectsWithoutWrite(f, () => service.restoreTask("t", { status }), "PLANNING_TASK_RESTORE_STATUS_INVALID");
  }
  await rejectsWithoutWrite(f, () => service.updateTask("t", { title: "Forbidden" }), "PLANNING_AUTHORITY_OWNER_NOT_WRITABLE");
});

for (const [fault, code] of [[{ expectedRevision: "0" }, "PLANNING_SNAPSHOT_REVISION_STALE"], [{ expectedEpoch: "wrong" }, "PLANNING_SNAPSHOT_EPOCH_MISMATCH"]]) {
  test(`actual restore path propagates CAS rejection, no blind retry: ${code}`, async () => {
    const f = await fixture(); f.fault = fault;
    await rejectsWithoutWrite(f, () => service.restoreTask("t"), code);
    assert.equal(f.commits, 1);
  });
}

test("existing authority rejects wrong Project and wrong owner permit scope", async () => {
  const f = await fixture();
  const request = { intent: "ownerRestore", requestId: "test", ownerType: "task", ownerId: "t", scope: "primary" };
  const wrongProject = await port.acquirePlanningOwnerAuthority({ ...request, projectId: "other" });
  assert.equal(wrongProject.code, "PLANNING_AUTHORITY_OWNER_PROJECT_MISMATCH");
  const granted = await port.acquirePlanningOwnerAuthority(request);
  assert.equal(granted.status, "Validated");
  try {
    await assert.rejects(guard.run({ request: { ...request, ownerId: "other-task" }, permit: granted.handle, invalidation: { domain: "planning" }, write() { assert.fail("wrong owner must never execute"); } }), error => error.code === "PLANNING_AUTHORITY_PERMIT_SCOPE_MISMATCH");
  } finally { await port.releasePlanningOwnerAuthority(granted.handle); }
  assert.equal(f.writes, 0);
  assert.equal(f.leases.size, 0);
});
