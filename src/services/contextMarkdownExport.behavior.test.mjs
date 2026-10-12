import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";

const calls = [];
let nativeResult = null;
globalThis.contextExportTestPorts = {
  invoke: async (command, args) => {
    calls.push({ command, args });
    if (nativeResult instanceof Error) throw nativeResult;
    return nativeResult;
  }
};

const bundle = await build({
  entryPoints: [resolve("src/services/exportService.ts")],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  target: "es2022",
  plugins: [{
    name: "context-export-isolated-ports",
    setup(api) {
      api.onResolve({ filter: /^@tauri-apps\/api\/core$/u }, () => ({ path: "tauri", namespace: "test-stub" }));
      api.onResolve({ filter: /(?:experimentService|outputService|planningService|planningIdeaState)$/u }, () => ({
        path: "unrelated",
        namespace: "test-stub"
      }));
      api.onLoad({ filter: /^tauri$/u, namespace: "test-stub" }, () => ({
        contents: "export const invoke = (...args) => globalThis.contextExportTestPorts.invoke(...args);"
      }));
      api.onLoad({ filter: /^unrelated$/u, namespace: "test-stub" }, () => ({
        contents: "export const experimentService = {}; export const outputService = {}; export const planningService = {}; export const getTaskTypeDisplayLabel = () => '';"
      }));
    }
  }]
});
const module = { exports: {} };
new Function("require", "module", "exports", bundle.outputFiles[0].text)(
  createRequire(import.meta.url), module, module.exports
);
const { exportService } = module.exports;
globalThis.window = { __TAURI_INTERNALS__: {} };

test("Context Markdown goes unchanged to existing native Save As with an .md default", async () => {
  calls.length = 0;
  nativeResult = "N:\\controlled\\context.md";
  const text = "  # 中英文\n**bold** & `code`\nC:\\user\\own-path\n\n尾空格  ";
  const result = await exportService.exportMarkdownText(text);
  assert.deepEqual(calls, [{
    command: "save_text_file",
    args: { defaultFileName: "context.md", contents: text }
  }]);
  assert.equal(result.saved, true);
  assert.equal(result.filePath, nativeResult);
});

test("native Save As cancellation stays unsaved and a write error is not reported as success", async () => {
  calls.length = 0;
  nativeResult = null;
  const cancelled = await exportService.exportMarkdownText("draft");
  assert.equal(cancelled.saved, false);
  assert.equal(cancelled.filePath, undefined);
  nativeResult = new Error("controlled write failure");
  await assert.rejects(exportService.exportMarkdownText("draft"), /controlled write failure/u);
  assert.equal(calls.length, 2);
});
