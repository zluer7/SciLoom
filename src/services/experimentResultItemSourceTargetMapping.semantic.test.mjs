import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const outputConversionServicePath = fileURLToPath(
  new URL("./outputConversionService.ts", import.meta.url)
);
const experimentGenerationServicePath = fileURLToPath(
  new URL("./experimentOutputGenerationService.ts", import.meta.url)
);
const outputSourceLinkServicePath = fileURLToPath(
  new URL("./outputSourceLinkService.ts", import.meta.url)
);
const outputConversionTypesPath = fileURLToPath(
  new URL("../types/outputConversion.ts", import.meta.url)
);

const outputConversionService = readFileSync(outputConversionServicePath, "utf8");
const experimentGenerationService = readFileSync(experimentGenerationServicePath, "utf8");
const outputSourceLinkService = readFileSync(outputSourceLinkServicePath, "utf8");
const outputConversionTypes = readFileSync(outputConversionTypesPath, "utf8");

const createResultItemBlock =
  outputConversionService.match(
    /async function createResultItem[\s\S]*?async function ensureResultItemForSource/
  )?.[0] ?? "";
const updateResultItemBlock =
  outputConversionService.match(
    /async function updateResultItem[\s\S]*?async function updateResultItemStatus/
  )?.[0] ?? "";
const experimentDraftBlock =
  experimentGenerationService.match(
    /export async function buildExperimentResultItemDraft[\s\S]*?export async function buildRunResultItemDraft/
  )?.[0] ?? "";
const runDraftBlock =
  experimentGenerationService.match(
    /export async function buildRunResultItemDraft[\s\S]*?export async function buildMetricResultItemDraft/
  )?.[0] ?? "";
const metricSourceBlock =
  experimentGenerationService.match(
    /async function resolveMetricSource[\s\S]*?export async function buildExperimentResultItemDraft/
  )?.[0] ?? "";
const createFromDraftBlock =
  experimentGenerationService.match(
    /async function createFromResolvedSource[\s\S]*?return \{[\s\S]*?\};/
  )?.[0] ?? "";
const outputSourceTypeBlock =
  outputConversionTypes.match(/export type OutputSourceType[\s\S]*?;/)?.[0] ?? "";
const sourceMatrixBlock =
  outputSourceLinkService.match(/OUTPUT_SOURCE_ALLOWED_MATRIX[\s\S]*?\} as const/)?.[0] ?? "";

assert.ok(createResultItemBlock, "createResultItem block should be located");
assert.ok(updateResultItemBlock, "updateResultItem block should be located");
assert.ok(experimentDraftBlock, "Experiment draft block should be located");
assert.ok(runDraftBlock, "ExperimentRun draft block should be located");
assert.ok(metricSourceBlock, "ResultMetric source resolution block should be located");
assert.ok(createFromDraftBlock, "ResultItem create-from-draft block should be located");
assert.ok(outputSourceTypeBlock, "OutputSourceType block should be located");
assert.ok(sourceMatrixBlock, "OUTPUT_SOURCE_ALLOWED_MATRIX block should be located");

assert.match(
  createResultItemBlock,
  /assertEntityReferenceValid\(\s*"experiment"\s*,\s*input\.sourceId\s*,\s*"ResultItem experiment source link target"/,
  "ResultItem experiment source validation must target the formal experiment entity"
);
assert.match(
  createResultItemBlock,
  /ensureEntityLink\(\s*"resultItem"\s*,\s*created\.id\s*,\s*"experiment"\s*,\s*created\.sourceId/,
  "ResultItem derived_from EntityLink must target the formal experiment entity"
);
assert.match(
  updateResultItemBlock,
  /assertEntityReferenceValid\(\s*"experiment"\s*,\s*nextSourceId\s*,\s*"ResultItem experiment source link target"/,
  "ResultItem update validation must target the formal experiment entity"
);
assert.doesNotMatch(
  outputConversionService,
  /"experimentSummary"/,
  "outputConversionService must not use experimentSummary as a ResultItem source target"
);

assert.match(
  experimentDraftBlock,
  /sourceType:\s*"experiment"[\s\S]*sourceId:\s*experiment\.id/,
  "Experiment-generated ResultItem drafts must use sourceType=experiment and sourceId=experiment.id"
);
assert.match(
  runDraftBlock,
  /sourceType:\s*"experimentRun"[\s\S]*sourceId:\s*run\.id/,
  "ExperimentRun-generated ResultItem drafts must use sourceType=experimentRun and sourceId=run.id"
);
assert.match(
  metricSourceBlock,
  /sourceType:\s*"experimentRun"[\s\S]*sourceId:\s*run\.id/,
  "ResultMetric with a valid run must resolve to ExperimentRun"
);
assert.match(
  metricSourceBlock,
  /sourceType:\s*"experiment"[\s\S]*sourceId:\s*experiment\.id/,
  "ResultMetric without a valid run must fall back to Experiment"
);
assert.match(
  metricSourceBlock,
  /Cannot determine a legal Experiment or ExperimentRun source/,
  "ResultMetric without a legal parent source must fail instead of becoming a source type"
);
assert.doesNotMatch(
  experimentGenerationService,
  /sourceType:\s*"resultMetric"|sourceType:\s*"metric"|sourceType:\s*"experimentSummary"/,
  "Experiment generation must not write ResultMetric, metric, or experimentSummary source types"
);

assert.match(
  createFromDraftBlock,
  /outputConversionService\.createResultItem\(\{[\s\S]*sourceType:\s*draft\.sourceType[\s\S]*sourceId:\s*draft\.sourceId/,
  "ResultItem create payload must use the resolved formal draft source"
);
assert.match(
  createFromDraftBlock,
  /createOutputSourceLink\(\{[\s\S]*ownerType:\s*"resultItem"[\s\S]*sourceType:\s*draft\.sourceType[\s\S]*sourceId:\s*draft\.sourceId/,
  "Canonical output_source_links write must use the resolved formal draft source"
);
assert.match(
  createFromDraftBlock,
  /getOutputSourceSummary\("resultItem",\s*resultItem\.id\)/,
  "Source link write must still be verified by a read-after-write summary"
);

assert.doesNotMatch(
  outputSourceTypeBlock,
  /experimentSummary|resultMetric/,
  "OutputSourceType must not include experimentSummary or resultMetric"
);
assert.doesNotMatch(
  sourceMatrixBlock,
  /experimentSummary|resultMetric/,
  "OUTPUT_SOURCE_ALLOWED_MATRIX must not allow experimentSummary or resultMetric"
);
assert.match(
  sourceMatrixBlock,
  /resultItem:\s*\["experiment",\s*"experimentRun",\s*"literature",\s*"review",\s*"other"\]/,
  "ResultItem source matrix must keep the formal Experiment and ExperimentRun sources"
);
assert.match(
  outputSourceLinkService,
  /Unsupported output source type/,
  "Source-link validation must still reject unsupported source types"
);
assert.match(
  outputSourceLinkService,
  /Unsupported output source relation:/,
  "Source-link validation must still enforce the allowed matrix"
);

console.log("Experiment ResultItem source target mapping semantic contract passed.");
