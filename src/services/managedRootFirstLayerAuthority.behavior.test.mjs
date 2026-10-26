import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";

// Execute the production managed-root configuration service, writer guard,
// owner port and Planning repository. Only native IPC is represented here;
// the native folder selection and SQLite write are exercised in the desktop app.
const bundle = await build({
  stdin: {
    contents: `
      export * as repository from './planningRepository';
      export {createManagedRootConfigService} from './managedRootConfigService';
      export {planningOwnerAuthorityPort as port} from './planningOwnerAuthorityPort';
    `,
    resolveDir: import.meta.dirname,
    sourcefile: "managed-root-first-layer-harness.ts"
  },
  bundle: true, write: false, format: "cjs", platform: "node", target: "es2022",
  logLevel: "silent",
  plugins: [{ name: "native-ipc-boundary", setup(api) {
    api.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: "ipc", namespace: "fixture" }));
    api.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `
      export const invoke=(command,args)=>globalThis.__managedRootIPC(command,args);
      export const isTauri=()=>true;
      export const convertFileSrc=x=>x;
    ` }));
  } }]
});
const module = { exports: {} };
new Function("require", "module", "exports", bundle.outputFiles[0].text)(
  createRequire(import.meta.url), module, module.exports
);
const { repository, createManagedRootConfigService, port } = module.exports;
const epoch = "22222222-2222-4222-8222-222222222222";
const session = { processGeneration: "test", producerSessionGeneration: 1, transportGeneration: 1 };
const base = { createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", tags: [], source: "user", schemaVersion: 1 };
const wire = value => JSON.parse(JSON.stringify(value));
const selectedPath = "/Users/researcher/SciLoom Workspace";

async function fixture() {
  const f = {
    target: wire({ envelopeVersion: 1, repositoryEpoch: epoch, revision: "4", snapshot: repository.normalizePlanningPersistenceData({
      ...repository.createEmptyPlanningData("2026-10-01T00:00:00.000Z"),
      projects: [{ ...base, id: "p", title: "Project", status: "active" }],
      // First-layer Review whose SQLite second layer is not provisioned yet.
      reviews: [{ ...base, id: "review", projectId: "p", title: "First layer only" }]
    }) }),
    secondLayerReads: 0, configured: [], leases: new Map()
  };
  globalThis.window = {
    __TAURI_INTERNALS__: {},
    localStorage: { getItem(key) { assert.equal(key, "researchpilot.dataSourceMode", "no legacy Planning read/fallback"); return "sqlite"; } },
    dispatchEvent() {}
  };
  globalThis.__managedRootIPC = async (command, args) => {
    if (command === "planning_repository_read") return structuredClone(f.target);
    // Native reads return only provisioned rows; none exist for this Review.
    if (command === "read_review_structured_states") { f.secondLayerReads++; return []; }
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

function completedResult(path) {
  return {
    status: "COMPLETED",
    attemptId: "managed-root-attempt",
    previousDurableState: "NOT_CONFIGURED",
    targetPathIdentity: path,
    errorCode: null,
    snapshot: {
      durableState: "CONFIGURED",
      readinessState: "READY",
      configuredPath: path,
      normalizedPath: path,
      pathIdentityKey: path,
      physicalIdentityHash: "fixture",
      errorCode: null,
      checkedAt: "2026-10-01T00:00:00.000Z"
    }
  };
}

test("fixture keeps exact Review consumers fail-closed on the missing second layer", async () => {
  const f = await fixture();
  await assert.rejects(repository.getPlanningRepositoryEnvelope(), /SECOND_LAYER_NOT_PROVISIONED/);
  assert.equal(f.secondLayerReads, 1);
});

test("first managed-root configuration is not blocked by an unprovisioned Review second layer", async () => {
  const f = await fixture();
  const logged = [];
  const service = createManagedRootConfigService({
    readSnapshot() { assert.fail("configuration must not depend on a snapshot read"); },
    async configure(path) { f.configured.push(path); return completedResult(path); },
    async writeOperationLog(result) { logged.push(result.status); }
  });
  const feedback = await service.configureFirstRoot(selectedPath);
  assert.deepEqual(
    [feedback.status, feedback.data.status, feedback.data.errorCode],
    ["success", "COMPLETED", null]
  );
  assert.deepEqual(f.configured, [selectedPath]);
  assert.deepEqual(logged, ["COMPLETED"]);
  assert.equal(f.secondLayerReads, 0);
  assert.equal(f.leases.size, 0);
});

test("managed-root authority holds only the managed-root write lease", async () => {
  const f = await fixture();
  const granted = await port.acquirePlanningOwnerAuthority({ intent: "managedRootWrite", requestId: "managed-root-test" });
  assert.equal(granted.status, "Validated");
  try {
    assert.deepEqual(wire(granted.handle.requests), [{ key: { kind: "managedRoot" }, mode: "write" }]);
    assert.equal(granted.context.revision, "4");
  } finally { await port.releasePlanningOwnerAuthority(granted.handle); }
  assert.equal(f.secondLayerReads, 0);
  assert.equal(f.leases.size, 0);
});
