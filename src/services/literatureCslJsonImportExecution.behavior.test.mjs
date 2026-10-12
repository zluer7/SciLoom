import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: [path.resolve("src/services/literatureCslJsonImportExecution.ts")],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  target: "es2022",
  plugins: [{
    name: "canonical-service-stub",
    setup(api) {
      api.onResolve({ filter: /literatureService$/u }, () => ({ path: "literature-service", namespace: "stub" }));
      api.onLoad({ filter: /.*/u, namespace: "stub" }, () => ({
        contents: "export const literatureService = { createLiterature: () => { throw Error('Use injected canonical CREATE'); } };"
      }));
    }
  }]
});
const module = { exports: {} };
new Function("require", "module", "exports", bundle.outputFiles[0].text)(
  createRequire(import.meta.url), module, module.exports
);
const { executeLiteratureCslJsonImport } = module.exports;

const entries = [
  { index: 0, title: "A", input: { title: "A" }, status: "ready", warnings: [], errors: [], ignoredFields: [] },
  { index: 1, title: "Invalid", status: "invalid", warnings: [], errors: ["无标题"], ignoredFields: [] },
  { index: 2, title: "B", input: { title: "B" }, status: "ready", warnings: [], errors: [], ignoredFields: [] },
  { index: 3, title: "C", input: { title: "C" }, status: "ready", warnings: [], errors: [], ignoredFields: [] }
];

test("sequential canonical CREATE preserves successes, invalid skips and partial created ID", async () => {
  const calls = [];
  const outcome = await executeLiteratureCslJsonImport(entries, async (input) => {
    calls.push(input.title);
    const id = input.title === "A" ? "literature-a" : input.title === "B" ? "literature-b" : "literature-c";
    return {
      status: input.title === "B" ? "partial" : "success",
      literatureId: id,
      literature: { id, title: input.title },
      completedSteps: ["literature"],
      retryable: false,
      warnings: [],
      errors: []
    };
  });
  assert.deepEqual(calls, ["A", "B", "C"]);
  assert.deepEqual(outcome.createdIds, ["literature-a", "literature-b", "literature-c"]);
  assert.deepEqual(outcome.items.map((item) => item.status), [
    "created", "skipped_invalid", "created_partial", "created"
  ]);
});

test("unknown commit result is pending review and does not replay or submit later items", async () => {
  const calls = [];
  const outcome = await executeLiteratureCslJsonImport(entries, async (input) => {
    calls.push(input.title);
    if (input.title === "B") throw Error("Transport ended after CREATE request");
    return {
      status: "success", literatureId: "literature-a",
      completedSteps: ["literature"], retryable: false, warnings: [], errors: []
    };
  });
  assert.deepEqual(calls, ["A", "B"]);
  assert.deepEqual(outcome.createdIds, ["literature-a"]);
  assert.deepEqual(outcome.items.map((item) => item.status), [
    "created", "skipped_invalid", "pending_review", "unprocessed"
  ]);
});
