import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const bundle = await build({
  entryPoints: [path.join(directory, "literatureSelectionService.ts")],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  target: "es2022"
});
const contract = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

const rows = [
  { id: "literature-1", title: "One" },
  { id: "literature-2", title: "Two" }
];
const detail = (id, readiness = "ready") => ({
  literature: { id, title: id },
  provisioningReadiness: { readiness: { currentResourceReady: readiness } }
});
const management = (id, status = "ready", readiness = "ready") => ({
  status,
  baseLiterature: { id, title: id },
  detailContext: status === "ready" ? detail(id, readiness) : null,
  projectRelation: { status: "unassigned" },
  manuscriptReadiness: status === "ready" ? "ready" : "blocked",
  capabilities: {
    canViewBaseDetail: true,
    canEditMetadata: true,
    canDelete: true,
    canOpenOutline: status === "ready",
    canOpenNotes: status === "ready",
    canRepairRelation: false
  },
  degradationKinds: status === "ready" ? [] : ["detail-aggregation-failed"]
});

test("empty rows resolve to the canonical empty selection", async () => {
  let loads = 0;
  const result = await contract.resolveLiteratureSelection({
    rows: [],
    preferredLiteratureId: null,
    loadDetail: async () => {
      loads += 1;
      return null;
    }
  });
  assert.deepEqual(result, {
    status: "empty",
    selectedLiteratureId: null,
    detailContext: null,
    managementDetail: null
  });
  assert.equal(loads, 0);
});

test("a real row becomes selected only with its matching detail context", async () => {
  const result = await contract.resolveLiteratureSelection({
    rows,
    preferredLiteratureId: "literature-2",
    loadDetail: async (row) => management(row.id)
  });
  assert.equal(result.status, "ready");
  assert.equal(result.selectedLiteratureId, "literature-2");
  assert.equal(result.detailContext.literature.id, "literature-2");
});

test("typed degradation keeps a real Literature row selected without full detail", async () => {
  const result = await contract.resolveLiteratureSelection({
    rows: [rows[0]],
    loadDetail: async (row) => management(row.id, "degraded", "not-ready")
  });
  assert.equal(result.status, "degraded");
  assert.equal(result.selectedLiteratureId, "literature-1");
  assert.equal(result.managementDetail.baseLiterature.title, "literature-1");
  assert.equal(result.detailContext, null);
});

test("missing row, missing detail, mismatched detail and thrown load all clear selection", async () => {
  const cases = [
    {
      preferredLiteratureId: "missing",
      loadDetail: async (row) => management(row.id),
      code: "LITERATURE_SELECTION_ROW_MISSING"
    },
    {
      preferredLiteratureId: "literature-1",
      loadDetail: async () => null,
      code: "LITERATURE_SELECTION_DETAIL_MISSING"
    },
    {
      preferredLiteratureId: "literature-1",
      loadDetail: async () => management("literature-2"),
      code: "LITERATURE_SELECTION_DETAIL_MISMATCH"
    },
    {
      preferredLiteratureId: "literature-1",
      loadDetail: async () => {
        throw new Error("repository failed");
      },
      code: "LITERATURE_SELECTION_DETAIL_LOAD_FAILED"
    }
  ];
  for (const scenario of cases) {
    const result = await contract.resolveLiteratureSelection({
      rows,
      preferredLiteratureId: scenario.preferredLiteratureId,
      loadDetail: scenario.loadDetail
    });
    assert.equal(result.status, "error");
    assert.equal(result.code, scenario.code);
    assert.equal(result.selectedLiteratureId, null);
    assert.equal(result.detailContext, null);
  }
});
