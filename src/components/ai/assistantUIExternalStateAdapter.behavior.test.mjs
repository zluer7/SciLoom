import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..", "..", "..");
const bundle = await build({
  stdin: {
    contents: 'export * from "./components/ai/assistantUIExternalStateAdapter.ts";',
    resolveDir: resolve(root, "src"),
    sourcefile: "lp13-a1-b4-assistant-ui-adapter-harness.ts"
  },
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  target: "es2022"
});
const harness = { exports: {} };
new Function("require", "module", "exports", bundle.outputFiles[0].text)(
  createRequire(import.meta.url), harness, harness.exports
);
const { extractComposerText, mapCanonicalMessage, orderCanonicalMessages } = harness.exports;

test("canonical messages are projected in durable order with stable ids", () => {
  const messages = [
    { id: "assistant-2", sequence: 2, role: "assistant", content: "answer", createdAt: "2026-08-14T00:00:02Z" },
    { id: "user-1", sequence: 1, role: "user", content: "question", createdAt: "2026-08-14T00:00:01Z" }
  ];
  assert.deepEqual(orderCanonicalMessages(messages).map(({ id }) => id), ["user-1", "assistant-2"]);
  assert.deepEqual(mapCanonicalMessage(messages[0]), {
    id: "assistant-2",
    role: "assistant",
    content: "answer",
    createdAt: new Date("2026-08-14T00:00:02Z"),
    status: { type: "complete", reason: "stop" }
  });
});

test("Composer accepts only the plain-text user payload", () => {
  assert.equal(extractComposerText({
    role: "user",
    content: [{ type: "text", text: " first " }, { type: "text", text: "second" }]
  }), "first \nsecond");
  assert.equal(extractComposerText({ role: "assistant", content: [{ type: "text", text: "no" }] }), "");
});
