import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..", "..");
const bundle = await build({
  stdin: {
    contents: `
      export * from "./services/firstLaunchWorkspaceDemoCore.ts";
      export { createManagedRootSelectionService } from "./services/managedRootSelectionService.ts";
    `,
    resolveDir: resolve(root, "src"),
    sourcefile: "lp15-b2-first-launch-demo-harness.ts"
  },
  plugins: [{
    name: "lp15-b2-production-owner-stubs",
    setup(api) {
      api.onResolve({ filter: /^\.\/localFileService$/u }, () => ({
        path: "local-file-service",
        namespace: "lp15-b2-stub"
      }));
      api.onResolve({ filter: /^\.\/managedRootConfigService$/u }, () => ({
        path: "managed-root-service",
        namespace: "lp15-b2-stub"
      }));
      api.onLoad({ filter: /.*/u, namespace: "lp15-b2-stub" }, (args) => ({
        contents: args.path === "local-file-service"
          ? "export const localFileService = {};"
          : "export const managedRootConfigService = {};"
      }));
    }
  }],
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

function emptyCounts() {
  return Object.fromEntries(
    Object.keys(subject.BUNDLED_DEMO_EXPECTED_OBJECT_COUNTS).map((key) => [key, 0])
  );
}

function emptyInventory() {
  return {
    projects: [],
    objectCounts: emptyCounts(),
    relationCount: 0,
    auxiliaryObjectCount: 0,
    deletedBusinessObjectCount: 0
  };
}

function exactDemoInventory() {
  return {
    projects: [{
      id: "project-demo-existing",
      title: subject.BUNDLED_DEMO_PROJECT_TITLE,
      source: "imported",
      tags: [...subject.BUNDLED_DEMO_IDENTITY_TAGS]
    }],
    objectCounts: { ...subject.BUNDLED_DEMO_EXPECTED_OBJECT_COUNTS },
    relationCount: subject.BUNDLED_DEMO_EXPECTED_RELATION_COUNT,
    auxiliaryObjectCount: 0,
    deletedBusinessObjectCount: 0
  };
}

function acceptedPlan() {
  return {
    ok: true,
    document: {},
    preview: {
      objectCounts: { ...subject.BUNDLED_DEMO_EXPECTED_OBJECT_COUNTS },
      relationCount: subject.BUNDLED_DEMO_EXPECTED_RELATION_COUNT,
      skippedCounts: { fields: 0, objects: 0, relations: 0 }
    },
    inputIdentity: {
      selectedMode: "auto",
      effectiveMode: "sqlite"
    },
    warnings: [],
    issues: []
  };
}

function successOutcome() {
  return {
    status: "success",
    project: { id: "project-demo-created", ref: "project_demo", title: subject.BUNDLED_DEMO_PROJECT_TITLE },
    createdCounts: { ...subject.BUNDLED_DEMO_EXPECTED_OBJECT_COUNTS },
    createdRelationCount: subject.BUNDLED_DEMO_EXPECTED_RELATION_COUNT,
    created: [],
    skippedCounts: { fields: 0, objects: 0, relations: 0 },
    warnings: []
  };
}

function demoResource() {
  return {
    content: "{}",
    byteLength: 2,
    sha256: subject.BUNDLED_DEMO_SHA256,
    relativePath: subject.BUNDLED_DEMO_RELATIVE_PATH,
    readMode: "tauri-resource"
  };
}

function provisionerHarness(overrides = {}) {
  const calls = {
    inventory: 0,
    resource: 0,
    preflight: 0,
    execute: 0,
    selected: []
  };
  const plan = acceptedPlan();
  const dependencies = {
    async readWorkspaceInventory() {
      calls.inventory += 1;
      return emptyInventory();
    },
    async readBundledDemoResource() {
      calls.resource += 1;
      return demoResource();
    },
    getDataSourceSnapshot() {
      return { selectedMode: "auto", effectiveMode: "sqlite" };
    },
    preflight(content, context) {
      calls.preflight += 1;
      calls.preflightInput = content;
      calls.preflightContext = context;
      return plan;
    },
    async execute(receivedPlan, options) {
      calls.execute += 1;
      calls.executePlan = receivedPlan;
      calls.executeOptions = options;
      return successOutcome();
    },
    selectProject(projectId) {
      calls.selected.push(projectId);
    },
    ...overrides
  };
  return {
    calls,
    plan,
    provisioner: subject.createFirstLaunchDemoProvisioner(dependencies)
  };
}

test("valid workspace proceeds while only NOT_CONFIGURED presents selection", () => {
  const base = {
    configuredPath: null,
    normalizedPath: null,
    pathIdentityKey: null,
    physicalIdentityHash: null,
    errorCode: null,
    checkedAt: "2026-09-04T12:00:00.000Z"
  };
  assert.equal(subject.decideFirstLaunchWorkspaceAction({
    ...base,
    durableState: "CONFIGURED",
    readinessState: "READY"
  }), "PROCEED");
  assert.equal(subject.decideFirstLaunchWorkspaceAction({
    ...base,
    durableState: "NOT_CONFIGURED",
    readinessState: "UNAVAILABLE"
  }), "SELECT");
  assert.equal(subject.decideFirstLaunchWorkspaceAction({
    ...base,
    durableState: "CONFIGURED",
    readinessState: "UNAVAILABLE"
  }), "RETRY");
});

test("picker cancel performs zero configuration and durable-read calls", async () => {
  let writes = 0;
  let reads = 0;
  const service = subject.createManagedRootSelectionService({
    async selectFolder() {
      return { ok: false, status: "canceled", actionType: "select_folder", errorCode: "canceled" };
    },
    async configureFirstRoot() {
      writes += 1;
      throw new Error("unexpected write");
    },
    async readSnapshot() {
      reads += 1;
      throw new Error("unexpected read");
    }
  });
  assert.deepEqual(await service.selectAndConfigure({}), { status: "canceled" });
  assert.equal(writes, 0);
  assert.equal(reads, 0);
});

test("workspace save requires exact durable READY readback", async () => {
  let writes = 0;
  let reads = 0;
  const feedback = { status: "success", messages: [], errors: [], warnings: [], skipped: [], refreshKeys: [] };
  const service = subject.createManagedRootSelectionService({
    async selectFolder() {
      return { ok: true, status: "success", actionType: "select_folder", path: "N:\\Workspace" };
    },
    async configureFirstRoot(path) {
      writes += 1;
      assert.equal(path, "N:\\Workspace");
      return feedback;
    },
    async readSnapshot() {
      reads += 1;
      return {
        durableState: "CONFIGURED",
        readinessState: "READY",
        configuredPath: "n:/workspace/",
        normalizedPath: "n:/workspace/",
        pathIdentityKey: "n:\\workspace",
        physicalIdentityHash: "hash",
        errorCode: null,
        checkedAt: "2026-09-04T12:00:00.000Z"
      };
    }
  });
  const result = await service.selectAndConfigure({});
  assert.equal(result.status, "ready");
  assert.equal(writes, 1);
  assert.equal(reads, 1);
});

test("empty workspace imports exact resource once with one frozen plan", async () => {
  const harness = provisionerHarness();
  const [first, concurrent] = await Promise.all([
    harness.provisioner.run(),
    harness.provisioner.run()
  ]);
  const secondCall = await harness.provisioner.run();
  assert.equal(first.status, "IMPORTED");
  assert.strictEqual(concurrent, first);
  assert.strictEqual(secondCall, first);
  assert.equal(harness.calls.inventory, 1);
  assert.equal(harness.calls.resource, 1);
  assert.equal(harness.calls.preflight, 1);
  assert.equal(harness.calls.execute, 1);
  assert.strictEqual(harness.calls.executePlan, harness.plan);
  assert.deepEqual(harness.calls.executeOptions, {
    confirmed: true,
    selectedMode: "auto",
    effectiveMode: "sqlite"
  });
  assert.deepEqual(harness.calls.selected, ["project-demo-created"]);
  assert.equal(first.importAttemptCount, 1);
});

test("exact Demo is selected without import and any other data blocks auto import", async () => {
  const exact = provisionerHarness({
    async readWorkspaceInventory() {
      return exactDemoInventory();
    }
  });
  const exactResult = await exact.provisioner.run();
  assert.equal(exactResult.status, "EXISTING_DEMO_SELECTED");
  assert.equal(exactResult.businessDataState, "EXACT_DEMO_PRESENT");
  assert.equal(exact.calls.resource, 0);
  assert.equal(exact.calls.execute, 0);
  assert.deepEqual(exact.calls.selected, ["project-demo-existing"]);

  const nonempty = provisionerHarness({
    async readWorkspaceInventory() {
      const inventory = emptyInventory();
      inventory.objectCounts.task = 1;
      return inventory;
    }
  });
  const nonemptyResult = await nonempty.provisioner.run();
  assert.equal(nonemptyResult.status, "SKIPPED_NONEMPTY");
  assert.equal(nonemptyResult.businessDataState, "NONEMPTY_OTHER");
  assert.equal(nonempty.calls.resource, 0);
  assert.equal(nonempty.calls.execute, 0);
});

test("unknown inventory and failed execute are nonfatal and never retried", async () => {
  const unknown = provisionerHarness({
    async readWorkspaceInventory() {
      throw new Error("controlled inventory read failure");
    }
  });
  const unknownResult = await unknown.provisioner.run();
  assert.equal(unknownResult.status, "SKIPPED_UNKNOWN");
  assert.equal(unknownResult.businessDataState, "UNKNOWN");
  assert.equal(unknownResult.canContinue, true);
  assert.equal(unknown.calls.resource, 0);

  let executeCalls = 0;
  const failed = provisionerHarness({
    async execute() {
      executeCalls += 1;
      return {
        ...successOutcome(),
        status: "failed",
        project: undefined,
        createdCounts: emptyCounts(),
        createdRelationCount: 0,
        failedAt: { type: "execution", message: "controlled Demo failure" }
      };
    }
  });
  const first = await failed.provisioner.run();
  const second = await failed.provisioner.run();
  assert.equal(first.status, "FAILED");
  assert.equal(first.canContinue, true);
  assert.strictEqual(second, first);
  assert.equal(first.importAttemptCount, 1);
  assert.equal(executeCalls, 1);
});

test("canonical Demo bytes, Tauri mapping, and release fallback boundary are fixed", () => {
  const destination = readFileSync(resolve(root, "demo/west-lake-vinegar-fish/project-import.json"));
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex").toUpperCase();
  assert.equal(destination.length, 58_274);
  assert.equal(hash(destination), subject.BUNDLED_DEMO_SHA256);

  const config = JSON.parse(readFileSync(resolve(root, "src-tauri/tauri.conf.json"), "utf8"));
  assert.deepEqual(config.bundle.resources, {
    "../demo/west-lake-vinegar-fish/project-import.json": "demo/west-lake-vinegar-fish/project-import.json",
    "../docs/QUICK_START.md": "docs/QUICK_START.md"
  });
  const rustSource = readFileSync(resolve(root, "src-tauri/src/bundled_demo_resource.rs"), "utf8");
  assert.match(rustSource, /#\[cfg\(debug_assertions\)\]/u);
  assert.doesNotMatch(rustSource, /N:\\\\LabPod|N:\\\\SciLoom/u);
});

test("startup gate never provisions until workspace selection returns ready", () => {
  const gateSource = readFileSync(resolve(root, "src/components/FirstLaunchWorkspaceGate.tsx"), "utf8");
  const appSource = readFileSync(resolve(root, "src/app/App.tsx"), "utf8");
  assert.match(gateSource, /if \(selection\.status !== "ready"\)/u);
  assert.match(gateSource, /const result = await firstLaunchWorkspaceDemoService\.run\(\)/u);
  assert.match(gateSource, /setPhase\("demo-failed"\)/u);
  assert.match(gateSource, /onClick=\{\(\) => setPhase\("ready"\)\}/u);
  assert.match(appSource, /<FirstLaunchWorkspaceGate>/u);
});

test("LP15-F2 workspace readback preserves POSIX case and Unicode", async () => {
  for (const selectedPath of ["/Users/Ada/研究 空格", "/Volumes/Data/Project"]) {
    for (const exact of [true, false]) {
      const writes = [];
      const service = subject.createManagedRootSelectionService({
        async selectFolder() { return { ok: true, status: "success", path: selectedPath }; },
        async configureFirstRoot(path) { writes.push(path); return { status: "success" }; },
        async readSnapshot() { return {
          durableState: "CONFIGURED", readinessState: "READY",
          normalizedPath: exact ? selectedPath : selectedPath.toLowerCase(), errorCode: null
        }; }
      });
      const result = await service.selectAndConfigure({});
      assert.equal(result.status, exact ? "ready" : "failed");
      if (!exact) assert.equal(result.errorCode, "MANAGED_ROOT_DURABLE_READBACK_MISMATCH");
      assert.deepEqual(writes, [selectedPath]);
    }
  }
});
