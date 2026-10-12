import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

// Only IPC and ambiguous-result readers are replaced. IDs, normalization and
// SQLite field encoding use the production implementation; SQLite atomicity
// and racing requests are covered by native tests and the real WebView run.
const bundle = await build({
  entryPoints: [fileURLToPath(new URL("./outputCandidateCommitService.ts", import.meta.url))],
  bundle: true, write: false, format: "esm", platform: "node", target: "es2022",
  plugins: [{ name: "conversion-boundary", setup(builder) {
    builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: "ipc", namespace: "boundary" }));
    builder.onResolve({ filter: /^\.\/outputConversionRelationService$/ }, () => ({ path: "relations", namespace: "boundary" }));
    builder.onResolve({ filter: /^\.\/outputService$/ }, () => ({ path: "outputs", namespace: "boundary" }));
    builder.onLoad({ filter: /.*/, namespace: "boundary" }, ({ path }) => ({ loader: "js", contents: {
      ipc: "export const invoke=(command,args)=>globalThis.__conversionInvoke(command,args);",
      relations: "export const outputConversionRelationService={queryOutputConversionRelations:async()=>globalThis.__conversionLinks};",
      outputs: "export const outputService={getById:async()=>globalThis.__conversionExisting};"
    }[path] }));
  } }]
});
const { commitOutputCandidateConversion } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const candidate = { id: "candidate", projectId: "project", taskId: "task", updatedAt: "revision-1" };
const input = { projectId: "project", taskId: "task", outputName: "正式成果", outputType: "report", usableForPaper: false, description: "保留原文", provenance: { confirmedByUser: true, sourceCandidateId: "candidate" } };

test("conversion preserves native created/reused outcome and exact current Task/provenance", async () => {
  for (const created of [true, false]) {
    globalThis.__conversionInvoke = async (command, args) => {
      assert.equal(command, "db_convert_output_candidate");
      assert.equal(args.input.outputRecord.task_id, "task");
      assert.equal(args.input.expectedCandidateUpdatedAt, "revision-1");
      assert.equal(JSON.parse(args.input.outputRecord.provenance).confirmedByUser, true);
      assert.equal(args.input.relationRecord.target_id, args.input.outputRecord.id);
      return { created, output: args.input.outputRecord };
    };
    const result = await commitOutputCandidateConversion(candidate, input, false);
    assert.equal(result.created, created);
    assert.equal(result.output.taskId, "task");
    assert.equal(result.output.description, "保留原文");
  }
});

test("unknown conversion result reads existing durable outcome without another write; missing result retains failure", async () => {
  let calls = 0;
  globalThis.__conversionInvoke = async () => { calls++; throw new Error("lost acknowledgement"); };
  globalThis.__conversionLinks = [{ targetId: "existing" }];
  globalThis.__conversionExisting = { ...input, id: "existing" };
  const result = await commitOutputCandidateConversion(candidate, input, false);
  assert.equal(result.created, false);
  assert.equal(result.output.id, "existing");
  assert.equal(calls, 1);
  globalThis.__conversionLinks = [];
  globalThis.__conversionExisting = undefined;
  await assert.rejects(() => commitOutputCandidateConversion(candidate, input, false), /lost acknowledgement/);
  assert.equal(calls, 2);
});
