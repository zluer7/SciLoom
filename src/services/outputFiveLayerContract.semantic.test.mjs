import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function source(relativePath) {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const outputConversionTypes = source("../types/outputConversion.ts");
const outputTypes = source("../types/output.ts");
const outputStructuredSummaryTypes = source("../types/outputStructuredSummary.ts");
const outputCanonicalValueTypes = source("../types/outputCanonicalValue.ts");
const typeIndex = source("../types/index.ts");
const frontendSchema = source("../db/schema.ts");
const rustSchema = source("../../src-tauri/src/db/schema.rs");
const sqliteRepository = source("../repositories/sqliteRepository.ts");
const outputConversionService = source("./outputConversionService.ts");
const outputService = source("./outputService.ts");
const outputConversionSelectorService = source("./outputConversionSelectorService.ts");
const outputConversionExportService = source("./outputConversionExportService.ts");
const outputsPage = source("../pages/Outputs/OutputsPage.tsx");
const aiDraftTypes = source("../types/aiDraft.ts");
const planningService = source("./planningService.ts");
const outputGapConfirmationService = source("./outputGapConfirmationService.ts");

function exportedUnion(sourceText, typeName) {
  const match = sourceText.match(new RegExp(`export\\s+type\\s+${typeName}\\s*=([\\s\\S]*?);`));
  assert.ok(match, `${typeName} must be exported`);
  return match[1];
}

function typeBody(sourceText, typeName) {
  const match =
    sourceText.match(new RegExp(`export\\s+type\\s+${typeName}\\s*=\\s*AuditableEntity\\s*&\\s*\\{([\\s\\S]*?)\\n\\};`)) ??
    sourceText.match(new RegExp(`export\\s+type\\s+${typeName}\\s*=([\\s\\S]*?);`));
  assert.ok(match, `${typeName} must be exported`);
  return match[1];
}

function assertUnionValues(sourceText, typeName, expectedValues) {
  const body = exportedUnion(sourceText, typeName);
  for (const value of expectedValues) {
    assert.match(body, new RegExp(`["']${value}["']`), `${typeName} must include ${value}`);
  }
}

function assertUnionExcludes(sourceText, typeName, forbiddenValues) {
  const body = exportedUnion(sourceText, typeName);
  for (const value of forbiddenValues) {
    assert.doesNotMatch(body, new RegExp(`["']${value}["']`), `${typeName} must not include ${value}`);
  }
}

function tableBlock(schema, tableName) {
  const match =
    schema.match(new RegExp(`name:\\s*["']${tableName}["'][\\s\\S]*?columns:\\s*\\[([\\s\\S]*?)\\n\\s*\\]`, "m")) ??
    schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${tableName}\\s*\\(([\\s\\S]*?)\\n\\);`, "m"));
  assert.ok(match, `${tableName} schema block must exist`);
  return match[1];
}

const fiveLayerTables = ["result_items", "findings", "output_candidates", "output_gaps", "outputs"];
const fiveLayerEntityTypes = [
  "resultItem",
  "finding",
  "outputCandidate",
  "outputGap",
  "researchOutput"
];

assertUnionValues(outputConversionTypes, "ResultItemStatus", [
  "pending_review",
  "marked",
  "ignored"
]);
assertUnionValues(outputConversionTypes, "FindingStatus", [
  "pending_confirmation",
  "confirmed",
  "needs_evidence",
  "abandoned"
]);
assertUnionValues(outputConversionTypes, "OutputCandidateStatus", [
  "pending_evaluation",
  "needs_gap_resolution",
  "ready_for_formal",
  "converted"
]);
assertUnionValues(outputConversionTypes, "OutputGapStatus", [
  "pending",
  "task_created",
  "route_feedback_created",
  "resolved",
  "abandoned"
]);
assertUnionValues(outputTypes, "ResearchOutputStatus", ["draft", "organizing", "archived"]);

assertUnionExcludes(outputConversionTypes, "FindingMaturity", [
  "idea",
  "preliminary",
  "validated",
  "ready_for_output"
]);
assertUnionExcludes(outputConversionTypes, "OutputCandidateStatus", [
  "idea",
  "collecting",
  "drafting",
  "validating",
  "ready",
  "paused",
  "archived"
]);
assertUnionExcludes(outputConversionTypes, "OutputGapStatus", [
  "open",
  "linked_to_task",
  "linked_to_route",
  "in_progress",
  "partiallyResolved",
  "ignored"
]);

for (const typeName of ["ResultItem", "Finding", "OutputCandidate", "OutputGap"]) {
  const body = typeBody(outputConversionTypes, typeName);
  assert.match(body, /status:\s*\w+Status/, `${typeName} must have a formal status`);
  assert.match(body, /structuredSummary:\s*StructuredSummary/, `${typeName} must have structuredSummary`);
  assert.doesNotMatch(body, /markdownBody/, `${typeName} BODY must be file-aware`);
}

const researchOutputBody = typeBody(outputTypes, "ResearchOutput");
assert.match(researchOutputBody, /status:\s*ResearchOutputStatus/, "ResearchOutput must have status");
assert.match(researchOutputBody, /structuredSummary:\s*StructuredSummary/, "ResearchOutput must have structuredSummary");
assert.doesNotMatch(researchOutputBody, /markdownBody/, "ResearchOutput BODY must be file-aware");

for (const exportedType of [
  "StructuredSummary",
  "StructuredSummarySection",
  "StructuredSummaryEntityType",
  "StructuredSummaryDefinition"
]) {
  assert.match(typeIndex, new RegExp(`\\b${exportedType}\\b`), `public type index must export ${exportedType}`);
}

for (const entityType of fiveLayerEntityTypes) {
  assert.match(
    outputStructuredSummaryTypes,
    new RegExp(`${entityType}[\\s\\S]*?other`),
    `${entityType} structured summary definition must include other`
  );
}

for (const [entityType, keys] of Object.entries({
  resultItem: ["summary", "keyPhenomenon", "conditionBrief", "initialJudgement", "conversionValue", "other"],
  finding: ["content", "supportingEvidence", "noveltyDifference", "reliabilityJudgement", "boundaryOrMissingEvidence", "other"],
  outputCandidate: ["coreClaim", "outputType", "innovationContribution", "evidenceSummary", "risksAndGaps", "other"],
  outputGap: ["gapDescription", "gapType", "affectedObject", "strengtheningPlan", "completionCriteria", "other"],
  researchOutput: ["summary", "outputType", "coreContribution", "sourceChainSummary", "archiveUsage", "other"]
})) {
  const [directKey, ...structuredKeys] = keys;
  assert.match(
    outputCanonicalValueTypes,
    new RegExp(`${entityType}: descriptor\\([\\s\\S]*?["']${directKey}["']`),
    `${entityType} direct canonical summary must include ${directKey}`
  );
  for (const key of structuredKeys) {
    assert.match(outputStructuredSummaryTypes, new RegExp(`["']${key}["']`), `${entityType} summary must include ${key}`);
  }
}

for (const table of fiveLayerTables) {
  const tsTable = tableBlock(frontendSchema, table);
  const rustTable = tableBlock(rustSchema, table);
  assert.match(tsTable, /status/, `${table} TypeScript schema must include status`);
  assert.match(tsTable, /structured_summary/, `${table} TypeScript schema must include structured_summary`);
  assert.match(rustTable, /status/, `${table} Rust schema must include status`);
  assert.match(rustTable, /structured_summary/, `${table} Rust schema must include structured_summary`);
  assert.doesNotMatch(tsTable, /markdown_body/, `${table} must not declare DB BODY`);
  assert.doesNotMatch(rustTable, /markdown_body/, `${table} must not declare DB BODY`);
}

for (const table of fiveLayerTables) {
  const mappingBlock = sqliteRepository.match(new RegExp(`${table}:\\s*\\{([\\s\\S]*?)\\n\\s*\\},`))?.[1] ?? "";
  assert.match(mappingBlock, /structuredSummary:\s*["']structured_summary["']/);
  assert.doesNotMatch(mappingBlock, /markdownBody|markdown_body/);
}

for (const table of fiveLayerTables) {
  const jsonPattern = new RegExp(`${table}:\\s*\\[[^\\]]*["']structuredSummary["']`);
  assert.match(sqliteRepository, jsonPattern, `${table} structuredSummary must be serialized as JSON`);
}

for (const fileText of [outputConversionService, outputService]) {
  assert.match(fileText, /normalizeStatus/, "write services must normalize five-layer status");
  assert.match(fileText, /normalizeStructuredSummary/, "write services must normalize structuredSummary");
}
assert.doesNotMatch(outputConversionService, /markdownBody|normalizeMarkdownBody/, "ResultItem write must not keep DB BODY");
assert.doesNotMatch(outputService, /markdownBody/, "ResearchOutput write must not keep DB BODY");

assert.match(outputConversionService, /status:\s*["']converted["']/, "Candidate conversion must set converted");
assert.match(outputService, /DEFAULT_RESEARCH_OUTPUT_STATUS:[\s\S]*["']draft["']/, "ResearchOutput create must default to draft");
assert.match(outputGapConfirmationService, /status:\s*["']task_created["']/, "OutputGap -> Task must write task_created");
assert.match(outputGapConfirmationService, /status:\s*["']route_feedback_created["']/, "OutputGap -> RouteNode must write route_feedback_created");

for (const oldStatus of [
  "idea",
  "collecting",
  "drafting",
  "validating",
  "ready",
  "paused",
  "open",
  "linked_to_task",
  "linked_to_route",
  "in_progress",
  "partiallyResolved"
]) {
  assert.doesNotMatch(outputsPage, new RegExp(`["']${oldStatus}["']`), `OutputsPage must not write old status ${oldStatus}`);
  assert.doesNotMatch(outputConversionService, new RegExp(`status:\\s*["']${oldStatus}["']`), `outputConversionService must not generate old status ${oldStatus}`);
  assert.doesNotMatch(planningService, new RegExp(`status:\\s*["']${oldStatus}["']`), `planningService must not generate old OutputGap status ${oldStatus}`);
  assert.doesNotMatch(outputGapConfirmationService, new RegExp(`status:\\s*["']${oldStatus}["']`), `confirmation service must not generate old OutputGap status ${oldStatus}`);
}

assert.match(aiDraftTypes, /status\?:\s*Extract<OutputGapStatus,\s*["']pending["']>/, "AI OutputGap drafts must use pending status only");
assert.match(aiDraftTypes, /status\?:\s*Exclude<OutputCandidateStatus,\s*["']converted["']>/, "AI candidate drafts must not depend on old candidate statuses");
assert.match(aiDraftTypes, /status\?:\s*FindingStatus/, "AI finding drafts must use FindingStatus, not maturity status");

assert.doesNotMatch(
  outputConversionTypes,
  /customFields\?:\s*CustomField\[\];\s*\/\*\s*core/i,
  "customFields must not be documented as the core summary contract"
);
assert.match(
  outputConversionTypes,
  /customFields\?:\s*CustomField\[\];/,
  "customFields may remain only as non-core extension fields"
);
assert.match(outputConversionSelectorService, /structuredSummary|summary/, "selectors must tolerate structured summaries");
assert.match(outputConversionExportService, /structuredSummary|summary/, "exports must tolerate structured summaries");

assert.doesNotMatch(
  frontendSchema + rustSchema,
  /\bresult_assets\b/,
  "LP8-2-B must not introduce a result_assets table"
);
assert.doesNotMatch(outputTypes, /\bfilePath\b/, "ResearchOutput.filePath is retired after LP8-2-D");

console.log("output five-layer contract semantic test passed");
