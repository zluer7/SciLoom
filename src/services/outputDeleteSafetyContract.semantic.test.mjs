import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function source(relativePath) {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

function between(text, start, end) {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Missing source marker: ${start}`);
  assert.notEqual(endIndex, -1, `Missing source marker: ${end}`);
  return text.slice(startIndex, endIndex);
}

const types = source("../types/outputDeleteSafety.ts");
const service = source("./outputDeleteSafetyService.ts");
const outputConversionService = source("./outputConversionService.ts");
const outputService = source("./outputService.ts");
const recycleBinService = source("./recycleBinService.ts");
const outputLifecycleTransaction = source("./outputLifecycleTransactionService.ts");
const outputTypes = source("../types/output.ts");
const relationService = source("./outputConversionRelationService.ts");
const relationTypes = source("../types/outputConversion.ts");
const outputFileRefService = source("./outputFileRefService.ts");
const outputMarkdownHost = source("./outputRawManuscriptService.ts");
const outputsPage = source("../pages/Outputs/OutputsPage.tsx");
const aiContextBuilder = source("./aiContextBuilderService.ts");
const outputExport = source("./outputConversionExportService.ts");
const aiAdapters = [
  source("./aiFindingDraftApplyAdapter.ts"),
  source("./aiOutputCandidateDraftApplyAdapter.ts"),
  source("./aiOutputGapDraftApplyAdapter.ts"),
  source("./aiEntityLinkDraftApplyAdapter.ts")
].join("\n");
const frontendSchema = source("../db/schema.ts");
const rustSchema = source("../../src-tauri/src/db/schema.rs");

const layerType =
  types.match(/export type OutputDeleteSafetyLayer\s*=([\s\S]*?);/)?.[1] ?? "";
for (const layer of [
  "resultItem",
  "finding",
  "outputCandidate",
  "outputGap",
  "researchOutput"
]) {
  assert.match(layerType, new RegExp(`["']${layer}["']`), `${layer} must be supported`);
}
assert.doesNotMatch(layerType, /resultAsset|formalOutput/, "View aliases must not become delete layers");

for (const field of [
  "layer",
  "id",
  "mode",
  "confirmedByUser",
  "confirmedAt",
  "previewHash",
  "localFileSafetyAcknowledged"
]) {
  assert.match(types, new RegExp(`\\b${field}\\b`), `Confirmation contract must include ${field}`);
}
for (const field of [
  "refreshLists",
  "refreshDetail",
  "refreshChains",
  "refreshRelations",
  "refreshFileRefs",
  "refreshRecycleBin"
]) {
  assert.match(types, new RegExp(`${field}:\\s*boolean`), `Refresh hints must include ${field}`);
}

const previewBody = between(
  service,
  "export async function getOutputDeleteImpactPreview",
  "export function confirmOutputDeleteImpactPreview"
);
assert.match(previewBody, /queryOutputConversionRelations/, "Preview must summarize internal relations");
assert.match(previewBody, /queryLinkedEntities/, "Preview must summarize cross-module EntityLinks");
assert.match(previewBody, /getFileRefsByOwnerIncludingDeleted/, "Preview must classify manuscript FileRef metadata");
assert.match(previewBody, /manuscriptBindingService\.getBindingByOwner/, "Preview must include current Binding metadata");
assert.doesNotMatch(previewBody, /markdownBody|markdownExists/, "Preview must not inspect migrated DB BODY");
assert.match(previewBody, /hasStructuredSummary/, "Preview must count structured summary existence");
assert.match(previewBody, /stableHash/, "Preview must generate a confirmation hash");
assert.doesNotMatch(
  previewBody,
  /createOperationLog|recordRecycleEntry|\.softDelete\(|\.hardDelete\(|\.restore\(/,
  "Preview must be read-only"
);
assert.doesNotMatch(
  previewBody,
  /\b(?:fullPath|absolutePath|localPath)\b|fileRef\.path\b/,
  "Preview must not expose a complete local path"
);

assert.match(service, /preview\.previewHash\s*!==\s*confirmation\.previewHash/, "Stale preview hashes must be rejected");
assert.match(service, /confirmation\.confirmedByUser\s*!==\s*true/, "A boolean nested in an incomplete object must not bypass validation");
assert.match(service, /confirmation\.localFileSafetyAcknowledged\s*!==\s*true/, "Local-file safety acknowledgement is mandatory");
assert.doesNotMatch(aiAdapters, /outputDeleteSafety|OutputDeleteConfirmation|confirmOutputDeleteImpactPreview/, "AI adapters must not construct deletion confirmation");

const softDeleteBody = between(
  service,
  "export async function softDeleteOutputEntity",
  "export async function restoreOutputEntity"
);
assert.match(softDeleteBody, /validateConfirmation\(confirmation,\s*["']softDelete["']\)/);
assert.match(softDeleteBody, /commitOutputLifecycleTransaction/);
assert.match(softDeleteBody, /createRequiredOutputLifecycleOperationLog/);
assert.match(softDeleteBody, /createRecycleEntry/);
assert.match(softDeleteBody, /durableReadbackConfirmed/);
assert.match(softDeleteBody, /resultFor/, "Soft delete must return refresh hints through the shared result");

const restoreBody = between(
  service,
  "export async function restoreOutputEntity",
  "async function permanentlyDeleteRelatedMetadata"
);
assert.match(restoreBody, /validateConfirmation\(confirmation,\s*["']restore["']\)/);
assert.match(restoreBody, /commitOutputLifecycleTransaction/);
assert.match(restoreBody, /createRequiredOutputLifecycleOperationLog/);
assert.match(restoreBody, /recycleRestoreStatus\s*!==\s*["']restored["']/);
assert.match(restoreBody, /durableReadbackConfirmed/);
assert.match(restoreBody, /resultFor/);

assert.match(outputLifecycleTransaction, /commit_output_lifecycle_transaction/,
  "SQLite output lifecycle must use one native transaction command");
assert.match(outputLifecycleTransaction, /writeLocalTransaction/,
  "Explicit localStorage mode must use one rollback-protected transaction adapter");

const permanentDeleteBody = between(
  service,
  "export async function permanentlyDeleteOutputEntity",
  "export const outputDeleteSafetyService"
);
assert.match(permanentDeleteBody, /validateConfirmation\(confirmation,\s*["']permanentDelete["']\)/);
assert.match(permanentDeleteBody, /repository\.hardDelete/);
assert.match(permanentDeleteBody, /permanentlyDeleteRelatedMetadata/);
assert.match(permanentDeleteBody, /writeOperationLog[\s\S]*?["']permanently_delete["']/);
assert.match(permanentDeleteBody, /restoreStatus:\s*["']permanently_deleted["']/);
assert.match(permanentDeleteBody, /resultFor/);

assert.match(service, /OUTPUT_LOCAL_FILE_SAFETY_NOTICE[\s\S]*?does not delete,\s*read,\s*upload,\s*move,\s*or modify referenced local files/);
assert.doesNotMatch(service, /\b(?:fs\.unlink|fs\.rm|removeFile|deleteFile|readFile|uploadFile|invoke)\s*\(/, "Delete safety must not access real files or Tauri file commands");
assert.match(service, /fileRefService\.hardDeleteMetadataPrimitive/, "Permanent delete must use the controlled FileRef metadata primitive");
assert.match(
  service,
  /fileRefService\.softDeleteMetadataPrimitive\(fileRef\.id\)[\s\S]*?fileRefService\.hardDeleteMetadataPrimitive\(fileRef\.id\)/,
  "Active FileRef metadata must be soft-deleted before the repository's deleted-only hard-delete path"
);
const bindingPreflightIndex = permanentDeleteBody.indexOf("outputManuscriptLifecycleService.cleanupHardDeleteMetadata");
const ownerHardDeleteIndex = permanentDeleteBody.indexOf("adapter.repository.hardDelete");
assert.ok(bindingPreflightIndex >= 0, "Permanent file-aware owner delete must run shared manuscript metadata cleanup");
assert.ok(
  ownerHardDeleteIndex > bindingPreflightIndex,
  "Binding/FileRef cleanup must run before permanently deleting the owner"
);
assert.match(permanentDeleteBody, /status:\s*"partial"[\s\S]*retryable:\s*cleanup\.retryable/,
  "partial cleanup must preserve the owner and return a retryable result");
assert.match(service, /entityLinkService\.removeEntityLink/, "Permanent delete must remove orphaned cross-module metadata links");
assert.match(service, /relationRepository\.hardDelete/, "Permanent delete must remove orphaned internal relation metadata");

assert.doesNotMatch(outputService, /\bsoftDelete\b|\bhardDelete\b|\bdeleteResearchOutput\b|\bremove:\b/, "ResearchOutput service must not retain an unsafe delete bypass");
for (const name of ["deleteResultItem", "deleteFinding", "deleteOutputCandidate", "deleteOutputGap"]) {
  assert.doesNotMatch(outputConversionService, new RegExp(`\\b${name}\\b`), `${name} bypass must be removed`);
}
assert.match(recycleBinService, /OUTPUT_DELETE_SAFETY_ENTITY_TYPES[\s\S]*?output_delete_safety_confirmation_required/, "Generic recycle actions must not bypass five-layer confirmation");
assert.match(outputsPage, /getOutputDeleteImpactPreview[\s\S]*?confirmOutputDeleteImpactPreview[\s\S]*?softDeleteOutputEntity/, "OutputsPage must use preview-confirm-service deletion");

assert.doesNotMatch(service, /outputMarkdownService|outputMarkdownHostAdapter|normalizeStructuredSummary|saveOutputMarkdown/, "Delete must not transform Markdown or structured summaries");
assert.doesNotMatch(outputMarkdownHost, /outputDeleteSafetyService/, "Markdown host must remain independent of delete execution");
assert.doesNotMatch(service, /ensureOutputConversionRelation|createEntityLink/, "Delete must not create internal or cross-module relations");
assert.doesNotMatch(
  relationTypes.match(/export type OutputConversionEntityType\s*=([\s\S]*?);/)?.[1] ?? "",
  /task|routeNode/,
  "Task and RouteNode must remain outside internal output relations"
);
assert.match(relationService, /output_conversion_relations|OUTPUT_CONVERSION_RELATION_CONSTRAINTS/);

assert.doesNotMatch(outputTypes, /\bfilePath\b/, "ResearchOutput.filePath must remain retired");
assert.doesNotMatch(outputFileRefService, /\b(?:fs\.unlink|fs\.rm|removeFile|deleteFile|readFile|uploadFile)\s*\(/);
assert.doesNotMatch(service, /run_ai_text|GlobalAIChatPanel|runAi|callAi/, "Delete safety must not call real AI");
assert.doesNotMatch(aiContextBuilder, /includeDeleted\s*:\s*true/, "Default AI context must not opt into deleted output entities");
assert.doesNotMatch(outputExport, /includeDeleted\s*:\s*true/, "Default output export must not opt into deleted entities");

for (const schema of [frontendSchema, rustSchema]) {
  assert.doesNotMatch(schema, /CREATE TABLE(?: IF NOT EXISTS)?\s+(?:research_outputs|formal_outputs|result_assets)/i);
}

console.log("outputDeleteSafetyContract semantic checks passed");
