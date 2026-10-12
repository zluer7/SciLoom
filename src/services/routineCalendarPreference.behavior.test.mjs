import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";

// Reuse the existing service/repository/CAS harness pattern. Only native IPC is
// represented here; durable SQLite and process restart are verified in Windows.
const bundle = await build({
  stdin: { contents: `export * as service from './planningService';
    export * as repository from './planningRepository';`, resolveDir: import.meta.dirname },
  bundle: true, write: false, format: "cjs", platform: "node", target: "es2022", logLevel: "silent",
  plugins: [{ name: "native-ipc-boundary", setup(api) {
    api.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: "ipc", namespace: "fixture" }));
    api.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `
      export const invoke=(command,args)=>globalThis.__routineCalendarIPC(command,args);
      export const isTauri=()=>true; export const convertFileSrc=x=>x;` }));
  } }]
});
const module = { exports: {} };
new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { service, repository } = module.exports;
const session = { processGeneration: "routine-test", producerSessionGeneration: 1, transportGeneration: 1 };
const wire = value => JSON.parse(JSON.stringify(value));
const base = { createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z", tags: [], source: "user", schemaVersion: 1 };

async function fixture() {
  const f = { writes: 0, leases: new Map(), fault: undefined, target: {
    envelopeVersion: 1, repositoryEpoch: "11111111-1111-4111-8111-111111111111", revision: "9",
    snapshot: wire(repository.normalizePlanningPersistenceData({
      ...repository.createEmptyPlanningData(base.createdAt),
      projects: [{ ...base, id: "p", title: "Project", status: "active" }],
      routeNodes: [{ ...base, id: "r", title: "Route", projectId: "p", status: "active" }],
      tasks: [{ ...base, id: "t", title: "Unchanged task", projectId: "p", routeNodeId: "r", scheduledDate: "2026-09-27", dueDate: "2026-09-30" }],
      researchRoutines: [{ ...base, id: "old", title: "Existing routine", projectId: "p", frequency: "weekly", targetType: "count", targetCount: 2,
        isActive: true, startDate: "2026-09-01", endDate: "2026-12-31", orderIndex: 3, customFields: { preserved: true } }]
    }))
  } };
  globalThis.window = { __TAURI_INTERNALS__: {}, dispatchEvent() {}, localStorage: { getItem(key) {
    assert.equal(key, "researchpilot.dataSourceMode", "no legacy Planning preference storage"); return "sqlite";
  } } };
  globalThis.__routineCalendarIPC = async (command, args) => {
    if (command === "planning_repository_read") return wire(f.target);
    if (command === "planning_repository_commit") {
      const request = { ...args.request, ...f.fault };
      const expectedIdentity = { repositoryEpoch: request.expectedEpoch, revision: request.expectedRevision };
      const currentIdentity = { repositoryEpoch: f.target.repositoryEpoch, revision: f.target.revision };
      if (request.expectedEpoch !== currentIdentity.repositoryEpoch) return { status: "epoch_mismatch", expectedIdentity, currentIdentity };
      if (request.expectedRevision !== currentIdentity.revision) return { status: "revision_stale", expectedIdentity, currentIdentity };
      f.target = { ...f.target, revision: String(BigInt(f.target.revision) + 1n), snapshot: wire(request.nextSnapshot) };
      f.writes++;
      return { status: "committed", expectedIdentity, envelope: wire(f.target) };
    }
    if (command === "owner_authority_try_acquire_many") {
      const token = `lease-${f.leases.size}`; f.leases.set(token, args.requests); return { token, requests: args.requests };
    }
    if (command === "owner_authority_validate") {
      assert.deepEqual(f.leases.get(args.token), args.requests); return { valid: true, registryGeneration: "fixture" };
    }
    if (command === "owner_authority_release") return { released: f.leases.delete(args.token) };
    if (command === "plugin:event|emit") return;
    throw Error(`Unexpected IPC command: ${command}`);
  };
  repository.activatePlanningRepositoryProducerWriter(session);
  await repository.bootstrapPlanningSQLitePersistence();
  return f;
}

test("old Routine records remain untouched; new records get backward-compatible hidden/sage defaults", async () => {
  const f = await fixture();
  const old = wire(await service.getResearchRoutineById("old"));
  assert.equal(old.showInRollingWeek, undefined);
  assert.equal(old.rollingWeekColor, undefined);
  const result = await service.createResearchRoutine({ title: "New routine", projectId: "p" });
  assert.equal(result.data.showInRollingWeek, false);
  assert.equal(result.data.rollingWeekColor, "sage");
  assert.deepEqual(wire(await service.getResearchRoutineById("old")), old);
  assert.equal(f.writes, 1);
});

test("all five color keys round-trip through formal service and serialized persistence; edits preserve facts and other collections", async () => {
  const f = await fixture();
  const before = wire(f.target.snapshot);
  for (const color of ["sage", "steel", "lavender", "sand", "rose"]) {
    const created = await service.createResearchRoutine({ title: color, projectId: "p", showInRollingWeek: true, rollingWeekColor: color });
    assert.deepEqual([created.data.showInRollingWeek, created.data.rollingWeekColor], [true, color]);
    assert.equal((await service.getResearchRoutineById(created.data.id)).rollingWeekColor, color);
    await service.updateResearchRoutine("old", { showInRollingWeek: true, rollingWeekColor: color });
    const saved = await service.getResearchRoutineById("old");
    assert.deepEqual([saved.showInRollingWeek, saved.rollingWeekColor], [true, color]);
  }
  await service.updateResearchRoutine("old", { showInRollingWeek: false });
  const saved = wire(await service.getResearchRoutineById("old"));
  assert.equal(saved.rollingWeekColor, "rose");
  assert.equal(saved.showInRollingWeek, false);
  const { updatedAt, showInRollingWeek, rollingWeekColor, ...facts } = saved;
  const { updatedAt: oldUpdatedAt, ...oldFacts } = before.researchRoutines[0];
  assert.deepEqual(facts, oldFacts);
  for (const key of Object.keys(before).filter(k => !["researchRoutines", "changeLogs", "exportedAt"].includes(k))) {
    assert.deepEqual(f.target.snapshot[key], before[key]);
  }
  assert.equal(f.target.revision, "20");
  assert.equal(f.leases.size, 0);
});

test("invalid color/boolean preferences reject before any write; no arbitrary HEX values", async () => {
  const f = await fixture();
  const before = wire(f.target);
  for (const patch of [{ rollingWeekColor: "#abc123" }, { rollingWeekColor: "blue" }, { rollingWeekColor: null },
    { showInRollingWeek: "false" }, { showInRollingWeek: null }]) {
    await assert.rejects(() => service.createResearchRoutine({ title: "Invalid", projectId: "p", ...patch }), /ResearchRoutine/);
    await assert.rejects(() => service.updateResearchRoutine("old", patch), /ResearchRoutine/);
  }
  assert.deepEqual(f.target, before);
  assert.equal(f.writes, 0);
});

test("Routine preference writes retain CAS rejection with no partial preference change", async () => {
  const f = await fixture();
  const before = wire(f.target);
  f.fault = { expectedRevision: "0" };
  await assert.rejects(() => service.updateResearchRoutine("old", { showInRollingWeek: true, rollingWeekColor: "rose" }),
    error => error.code === "PLANNING_SNAPSHOT_REVISION_STALE");
  assert.deepEqual(f.target, before);
  assert.equal(f.writes, 0);
  assert.equal(f.leases.size, 0);
});
