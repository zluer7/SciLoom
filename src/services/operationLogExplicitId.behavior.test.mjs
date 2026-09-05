import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const directory = path.dirname(fileURLToPath(import.meta.url));
const bundle = await build({
  stdin: {
    contents: `export { createOperationLog, getOperationLog } from "./operationLogService.ts";`,
    resolveDir: directory,
    sourcefile: "operation-log-explicit-id-harness.ts"
  },
  plugins: [{
    name: "stub-tauri-core",
    setup(esbuild) {
      esbuild.onResolve(
        { filter: /^@tauri-apps\/api\/core$/u },
        () => ({ path: "tauri-core", namespace: "stub" })
      );
      esbuild.onLoad(
        { filter: /.*/u, namespace: "stub" },
        () => ({ contents: "export async function invoke() { throw new Error('TAURI_NOT_AVAILABLE_IN_NODE_TEST'); }" })
      );
    }
  }],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  target: "es2022"
});
const service = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

test("operation log creation preserves a caller-owned operationId and timestamp", async () => {
  const operationId = "experiment-formal-switch-operation-fixed";
  const createdAt = "2026-07-19T03:00:00.000Z";
  const created = await service.createOperationLog({
    id: operationId,
    operationType: "custom",
    source: "user",
    module: "experiment",
    status: "partial",
    riskLevel: "medium",
    target: { entityType: "experiment", entityId: "experiment-1" },
    summary: "Experiment formal manuscript switch",
    confirmation: {
      required: true,
      confirmedByUser: true,
      confirmedAt: createdAt,
      confirmationId: "correlation-fixed",
      metadataOnly: false
    },
    isRecoverable: true,
    createdAt,
    updatedAt: createdAt
  });
  assert.equal(created.status, "success");
  assert.equal(created.data.id, operationId);
  assert.equal(created.data.createdAt, createdAt);
  const readback = await service.getOperationLog(operationId);
  assert.equal(readback.id, operationId);
  assert.equal(readback.createdAt, createdAt);
});
