import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..", "..");
const bundle = await build({
  stdin: {
    contents: 'export * from "./repositories/dataSourceMode.ts";',
    resolveDir: resolve(root, "src"),
    sourcefile: "lp14-b1-a2-data-source-mode-harness.ts"
  },
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  target: "es2022"
});
const harness = { exports: {} };
new Function("module", "exports", bundle.outputFiles[0].text)(harness, harness.exports);
const subject = harness.exports;

test("Auto resolves to a concrete healthy source without becoming a mismatch", () => {
  assert.deepEqual(subject.projectDataSourceMode("auto", true), {
    selectedMode: "auto",
    effectiveMode: "sqlite",
    resolutionState: "RESOLVED_AUTO"
  });
  assert.deepEqual(subject.projectDataSourceMode("auto", false), {
    selectedMode: "auto",
    effectiveMode: "localStorage",
    resolutionState: "RESOLVED_AUTO"
  });
  assert.deepEqual(subject.projectDataSourceMode("sqlite", false), {
    selectedMode: "sqlite",
    effectiveMode: "localStorage",
    resolutionState: "NON_TAURI_FALLBACK"
  });
  assert.deepEqual(subject.projectDataSourceMode("sqlite", true), {
    selectedMode: "sqlite",
    effectiveMode: "sqlite",
    resolutionState: "MATCHED_EXPLICIT"
  });
  assert.deepEqual(subject.projectDataSourceMode("localStorage", true), {
    selectedMode: "localStorage",
    effectiveMode: "localStorage",
    resolutionState: "MATCHED_EXPLICIT"
  });
});

test("an unknown persisted value returns to the existing safe Auto semantics", () => {
  const previousWindow = globalThis.window;
  globalThis.window = {
    __TAURI_INTERNALS__: {},
    localStorage: {
      getItem() { return "unknown-source"; }
    }
  };
  assert.equal(subject.getDataSourceMode(), "auto");
  assert.deepEqual(subject.getDataSourceModeSnapshot(), {
    selectedMode: "auto",
    effectiveMode: "sqlite",
    resolutionState: "RESOLVED_AUTO"
  });
  globalThis.window = previousWindow;
});

test("canonical setter writes once, reads back once, and publishes the readback", () => {
  const previousWindow = globalThis.window;
  const previousCustomEvent = globalThis.CustomEvent;
  const values = new Map();
  let setCount = 0;
  let getCount = 0;
  const events = [];
  globalThis.CustomEvent = class {
    constructor(type, options) {
      this.type = type;
      this.detail = options?.detail;
    }
  };
  globalThis.window = {
    __TAURI_INTERNALS__: {},
    localStorage: {
      getItem(key) {
        getCount += 1;
        return values.get(key) ?? null;
      },
      setItem(key, value) {
        setCount += 1;
        values.set(key, value);
      }
    },
    dispatchEvent(event) {
      events.push(event);
      return true;
    }
  };

  const readback = subject.setDataSourceMode("sqlite");
  assert.equal(readback, "sqlite");
  assert.equal(setCount, 1);
  assert.equal(getCount, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, subject.DATA_SOURCE_MODE_CHANGE_EVENT);
  assert.deepEqual(events[0].detail, { mode: "sqlite" });

  globalThis.window = previousWindow;
  globalThis.CustomEvent = previousCustomEvent;
});
