import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setImmediate as nextTurn } from "node:timers/promises";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..", "..");
const fixtureKey = "__authorityInvalidationBehaviorFixture";
const eventName = "labpod://authority-invalidated";
const payload = Object.freeze({
  domain: "planning", projectId: "project-fixture",
  ownerType: "experiment", ownerId: "owner-fixture", scope: "raw"
});
let moduleSequence = 0;

function deferred() {
  let resolvePromise, rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

// Compile the actual service, singleton guard and representative caller. Only
// their external event/admission/authority dependencies are replaced in memory.
async function loadSubject(realEvent = false) {
  const result = await build({
    stdin: {
      contents: realEvent
        ? 'export * from "./services/authorityInvalidationService.ts";'
        : 'export * from "./services/authorityInvalidationService.ts"; export * from "./services/authorityWriterGuard.ts"; export * from "./services/metadataAuthorityWriterGuard.ts";',
      resolveDir: resolve(root, "src"),
      sourcefile: "authority-invalidation-behavior-harness.ts"
    },
    bundle: true, write: false, format: "esm", platform: "node", target: "es2022",
    plugins: [{
      name: "authority-invalidation-external-fixture",
      setup(api) {
        api.onResolve({ filter: /^@tauri-apps\/api\/event$/u }, () => realEvent
          ? { path: pathToFileURL(resolve(root, "node_modules/@tauri-apps/api/event.js")).href, external: true }
          : { path: "event", namespace: "fixture" });
        api.onResolve({ filter: /\/desktopSQLiteProvisioningAdmissionGuard(?:\.ts)?$/u },
          () => ({ path: "admission", namespace: "fixture" }));
        api.onResolve({ filter: /\/planningOwnerAuthorityPort(?:\.ts)?$/u },
          () => ({ path: "port", namespace: "fixture" }));
        api.onLoad({ filter: /.*/u, namespace: "fixture" }, ({ path }) => ({
          contents: path === "event"
            ? 'export function emit(event, input) { return globalThis.__authorityInvalidationBehaviorFixture.emit(event, input); }'
            : path === "admission"
              ? 'export function assertDesktopSQLiteProvisioningAdmission() { globalThis.__authorityInvalidationBehaviorFixture.trace.push("admission"); }'
              : 'export const planningOwnerAuthorityPort = { acquirePlanningOwnerAuthority: (...args) => globalThis.__authorityInvalidationBehaviorFixture.port.acquirePlanningOwnerAuthority(...args), revalidatePlanningAuthority: (...args) => globalThis.__authorityInvalidationBehaviorFixture.port.revalidatePlanningAuthority(...args), releasePlanningOwnerAuthority: (...args) => globalThis.__authorityInvalidationBehaviorFixture.port.releasePlanningOwnerAuthority(...args) };',
          loader: "js"
        }));
      }
    }]
  });
  const text = result.outputFiles[0].text + "\n// fixture module " + ++moduleSequence;
  return import("data:text/javascript;base64," + Buffer.from(text).toString("base64"));
}

function createFixture() {
  const f = {
    trace: [], localEvents: [], nativeCalls: [], requests: [],
    inPublisher: false, native: deferred(), nativeStarted: deferred(),
    writeStarted: deferred(), writeGate: deferred(),
    durableResult: Object.freeze({ committed: true, revision: "17" }),
    permit: Object.freeze({ requests: Object.freeze([{ key: { kind: "owner", ownerType: "experiment", ownerId: "owner-fixture" }, mode: "write" }]) }),
    context: Object.freeze({ repositoryEpoch: "epoch-fixture", revision: "17", snapshot: Object.freeze({}) })
  };
  f.emit = (event, input) => {
    f.trace.push("native-call");
    f.nativeCalls.push({ event, input, inPublisher: f.inPublisher });
    f.nativeStarted.resolve();
    if (f.nativeThrow) throw f.nativeThrow;
    return f.native.promise;
  };
  f.window = {
    dispatchEvent(event) {
      f.trace.push("local-publish");
      f.localEvents.push(event);
      if (f.localThrow) throw f.localThrow;
      return true;
    }
  };
  f.port = {
    async acquirePlanningOwnerAuthority(request) {
      f.trace.push("lease-acquire");
      f.requests.push(request);
      return { status: "Validated", handle: f.permit, context: f.context };
    },
    async revalidatePlanningAuthority(permit, request) {
      assert.equal(permit, f.permit);
      f.trace.push("revalidate");
      f.requests.push(request);
      return f.revalidationFailure ?? { status: "Validated", context: f.context };
    },
    async releasePlanningOwnerAuthority(permit) {
      assert.equal(permit, f.permit);
      f.trace.push("lease-release");
    }
  };
  return f;
}

async function withFixture(name, body, { noWindow = false, realEvent = false } = {}) {
  const windowBefore = Object.getOwnPropertyDescriptor(globalThis, "window");
  const fixtureBefore = Object.getOwnPropertyDescriptor(globalThis, fixtureKey);
  const f = createFixture();
  Object.defineProperty(globalThis, fixtureKey, { value: f, configurable: true });
  if (noWindow) delete globalThis.window;
  else Object.defineProperty(globalThis, "window", { value: f.window, configurable: true });
  try {
    const subject = await loadSubject(realEvent);
    await body(subject, f);
    // Drain handled continuations and let Node detect unexpected unhandled
    // rejections. This is cleanup, not a fixed-tick ordering assertion.
    await nextTurn();
    console.log("SC3_A6_TRACE " + JSON.stringify({
      case: name, trace: f.trace,
      localEvents: f.localEvents.length, nativeCalls: f.nativeCalls.length,
      nativeInPublisherStack: f.nativeCalls.map(call => call.inPublisher)
    }));
  } finally {
    f.native.resolve();
    f.writeGate.resolve();
    await nextTurn();
    if (windowBefore) Object.defineProperty(globalThis, "window", windowBefore);
    else delete globalThis.window;
    if (fixtureBefore) Object.defineProperty(globalThis, fixtureKey, fixtureBefore);
    else delete globalThis[fixtureKey];
  }
}

function publish(subject, f, input = payload) {
  f.inPublisher = true;
  try { return subject.publishAuthorityInvalidation(input); }
  finally { f.inPublisher = false; f.trace.push("publisher-return"); }
}

function startWrite(subject, f) {
  return subject.authorityWriterGuard.run({
    request: {
      intent: "ownerWrite", requestId: "request-fixture",
      projectId: payload.projectId, ownerType: payload.ownerType,
      ownerId: payload.ownerId, scope: payload.scope,
      expectedPlanningEpoch: f.context.repositoryEpoch,
      expectedPlanningRevision: f.context.revision
    },
    invalidation: payload,
    async write(permit, context) {
      assert.equal(permit, f.permit);
      assert.equal(context, f.context);
      f.trace.push("write-start");
      f.writeStarted.resolve();
      await f.writeGate.promise;
      if (f.writeFailure) throw f.writeFailure;
      f.trace.push("durable-success");
      return f.durableResult;
    }
  }).then(result => { f.trace.push("caller-result"); return result; });
}

function assertOrdering(f) {
  assert.ok(f.trace.indexOf("durable-success") < f.trace.indexOf("local-publish"));
  assert.ok(f.trace.indexOf("local-publish") < f.trace.indexOf("lease-release"));
  assert.ok(f.trace.indexOf("lease-release") < f.trace.indexOf("caller-result"));
  assert.equal(f.localEvents[0].type, eventName);
}

const options = { concurrency: false, timeout: 10000 };

test("actual installed event API and publisher import/call are safe without window", options, async () => {
  await withFixture("real-api-no-window", async (subject, f) => {
    const api = await import(pathToFileURL(resolve(root, "node_modules/@tauri-apps/api/event.js")).href);
    assert.equal(typeof api.emit, "function");
    assert.equal(publish(subject, f), undefined);
    assert.deepEqual(f.localEvents, []);
    assert.deepEqual(f.nativeCalls, []);
  }, { noWindow: true, realEvent: true });
});

test("no-window guard prevents local dispatch and stub native calls", options, async () => {
  await withFixture("stub-no-window", async (subject, f) => {
    assert.equal(publish(subject, f), undefined);
    await nextTurn();
    assert.equal(f.localEvents.length, 0);
    assert.equal(f.nativeCalls.length, 0);
  }, { noWindow: true });
});

test("local CustomEvent is synchronous and frozen; native is deferred and retains payload identity", options, async () => {
  await withFixture("local-first-payload-defer", async (subject, f) => {
    assert.equal(subject.AUTHORITY_INVALIDATION_EVENT, eventName);
    assert.equal(publish(subject, f), undefined);
    assert.deepEqual(f.trace, ["local-publish", "publisher-return"]);
    assert.ok(f.localEvents[0] instanceof CustomEvent);
    assert.equal(f.localEvents[0].type, eventName);
    assert.notEqual(f.localEvents[0].detail, payload);
    assert.deepEqual(f.localEvents[0].detail, payload);
    assert.ok(Object.isFrozen(f.localEvents[0].detail));
    await f.nativeStarted.promise;
    assert.equal(f.nativeCalls.length, 1);
    assert.equal(f.nativeCalls[0].inPublisher, false);
    assert.equal(f.nativeCalls[0].event, eventName);
    assert.equal(f.nativeCalls[0].input, payload);
    assert.ok(f.trace.indexOf("publisher-return") < f.trace.indexOf("native-call"));
    // Native is still pending while the synchronous publisher has returned.
  });
});

test("browser-like window without native capability contains the real API rejection", options, async () => {
  await withFixture("real-api-browser-without-native", async (subject, f) => {
    assert.equal(f.window.__TAURI_INTERNALS__, undefined);
    assert.equal(publish(subject, f), undefined);
    assert.equal(f.localEvents.length, 1);
    await nextTurn();
    assert.equal(f.localEvents[0].type, eventName);
  }, { realEvent: true });
});

test("controlled native rejection cannot propagate through publisher", options, async () => {
  await withFixture("publisher-native-reject", async (subject, f) => {
    assert.equal(publish(subject, f), undefined);
    await f.nativeStarted.promise;
    f.trace.push("native-reject");
    f.native.reject(new Error("isolated-native-rejection"));
    await nextTurn();
    assert.equal(f.localEvents.length, 1);
  });
});

test("an expressive synchronous native throw is contained by the deferred boundary", options, async () => {
  await withFixture("publisher-native-sync-throw", async (subject, f) => {
    f.nativeThrow = new Error("isolated-native-sync-throw");
    assert.equal(publish(subject, f), undefined);
    await f.nativeStarted.promise;
    await nextTurn();
    assert.equal(f.nativeCalls[0].inPublisher, false);
    assert.equal(f.localEvents.length, 1);
  });
});

test("actual guard publishes after controlled durable success and releases without waiting for native", options, async () => {
  await withFixture("guard-native-pending", async (subject, f) => {
    const resultPromise = startWrite(subject, f);
    await f.writeStarted.promise;
    assert.equal(f.localEvents.length, 0);
    assert.equal(f.nativeCalls.length, 0);
    f.writeGate.resolve();
    assert.equal(await resultPromise, f.durableResult);
    assertOrdering(f);
    assert.equal(f.context.repositoryEpoch, "epoch-fixture");
    assert.equal(f.context.revision, "17");
    assert.equal(f.requests[0].expectedPlanningEpoch, "epoch-fixture");
    assert.equal(f.requests[0].expectedPlanningRevision, "17");
    await f.nativeStarted.promise;
    assert.equal(f.nativeCalls[0].input, payload);
    // The native Promise remains unresolved through lease release/caller result.
  });
});

for (const mode of ["reject", "sync-throw"]) {
  test("actual guard durable result and lease survive native " + mode, options, async () => {
    await withFixture("guard-native-" + mode, async (subject, f) => {
      if (mode === "sync-throw") f.nativeThrow = new Error("isolated-native-sync-throw");
      f.writeGate.resolve();
      const result = await startWrite(subject, f);
      await f.nativeStarted.promise;
      if (mode === "reject") {
        f.trace.push("native-reject");
        f.native.reject(new Error("isolated-native-rejection"));
      }
      await nextTurn();
      assert.equal(result, f.durableResult);
      assertOrdering(f);
    });
  });
}

test("failed durable write propagates its error and releases without any publish", options, async () => {
  await withFixture("guard-write-failure", async (subject, f) => {
    f.writeFailure = new Error("durable-write-failure");
    f.writeGate.resolve();
    await assert.rejects(startWrite(subject, f), error => error === f.writeFailure);
    assert.equal(f.localEvents.length, 0);
    assert.equal(f.nativeCalls.length, 0);
    assert.ok(f.trace.includes("lease-release"));
  });
});

test("local dispatch failure remains a writer failure and finally releases the lease", options, async () => {
  await withFixture("guard-local-failure", async (subject, f) => {
    f.localThrow = new Error("local-dispatch-failure");
    f.writeGate.resolve();
    await assert.rejects(startWrite(subject, f), error => error === f.localThrow);
    assert.equal(f.nativeCalls.length, 0);
    assert.ok(f.trace.indexOf("durable-success") < f.trace.indexOf("local-publish"));
    assert.ok(f.trace.indexOf("local-publish") < f.trace.indexOf("lease-release"));
  });
});

test("authority revalidation failure stays visible and cannot publish or write", options, async () => {
  await withFixture("guard-revalidation-failure", async (subject, f) => {
    f.revalidationFailure = { status: "AuthorityChanged", code: "fixture-stale-revision" };
    await assert.rejects(startWrite(subject, f), error =>
      error.status === "AuthorityChanged" && error.code === "fixture-stale-revision");
    assert.equal(f.localEvents.length, 0);
    assert.equal(f.nativeCalls.length, 0);
    assert.ok(!f.trace.includes("write-start"));
    assert.ok(f.trace.includes("lease-release"));
  });
});

test("representative actual metadata caller preserves request/payload and never awaits native", options, async () => {
  await withFixture("metadata-caller-native-pending", async (subject, f) => {
    const result = await subject.runMetadataAuthorityWrite({
      domain: "binding", operation: "fixture-bind",
      ownerType: "experiment", ownerId: "owner-fixture", scope: "raw",
      async write(permit) {
        assert.equal(permit, f.permit);
        f.trace.push("durable-success");
        return f.durableResult;
      }
    });
    f.trace.push("caller-result");
    assert.equal(result, f.durableResult);
    assertOrdering(f);
    assert.equal(f.requests[0].intent, "metadataWrite");
    assert.equal(f.requests[0].requestId, "fixture-bind-experiment-owner-fixture-raw");
    await f.nativeStarted.promise;
    assert.deepEqual(f.nativeCalls[0].input, {
      domain: "binding", projectId: undefined,
      ownerType: "experiment", ownerId: "owner-fixture", scope: "raw"
    });
    assert.deepEqual(f.localEvents[0].detail, f.nativeCalls[0].input);
  });
});
