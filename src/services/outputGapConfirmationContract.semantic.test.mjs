import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function source(relativePath) {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

function interfaceBody(sourceText, typeName) {
  return (
    sourceText.match(
      new RegExp(`export\\s+interface\\s+${typeName}\\b[^\\{]*\\{([\\s\\S]*?)\\n\\}`)
    )?.[1] ?? ""
  );
}

function functionBlock(sourceText, functionName, nextName) {
  const end = nextName
    ? `(?=export\\s+(?:async\\s+)?function\\s+${nextName}\\b)`
    : "(?=export\\s+const\\s+)";
  return (
    sourceText.match(
      new RegExp(
        `export\\s+(?:async\\s+)?function\\s+${functionName}\\b([\\s\\S]*?)${end}`
      )
    )?.[0] ?? ""
  );
}

const confirmationTypes = source("../types/outputGapConfirmation.ts");
const confirmationService = source("./outputGapConfirmationService.ts");
const planningService = source("./planningService.ts");
const outputsPage = source("../pages/Outputs/OutputsPage.tsx");
const aiGapAdapter = source("./aiOutputGapDraftApplyAdapter.ts");
const outputConversionService = source("./outputConversionService.ts");
const outputTypes = source("../types/output.ts");
const outputConversionTypes = source("../types/outputConversion.ts");
const chainTypes = source("../types/outputChain.ts");
const selectorTypes = source("../types/outputSelector.ts");
const aiEntityLinkAdapter = source("./aiEntityLinkDraftApplyAdapter.ts");
const entityConfig = source("../repositories/entityConfig.ts");
const sqliteRepository = source("../repositories/sqliteRepository.ts");

for (const typeName of [
  "OutputGapTaskDraftPayload",
  "OutputGapRouteFeedbackDraftPayload",
  "OutputGapFeedbackDraft",
  "OutputGapFeedbackPreview",
  "OutputGapFeedbackConfirmation",
  "OutputGapFeedbackApplyResult",
  "CreateOutputGapFeedbackDraftInput",
  "ApplyOutputGapFeedbackDraftInput"
]) {
  assert.match(
    confirmationTypes,
    new RegExp(`export\\s+interface\\s+${typeName}\\b`),
    `${typeName} must exist`
  );
}

const draftBody = interfaceBody(confirmationTypes, "OutputGapFeedbackDraft");
for (const field of [
  "id",
  "gapId",
  "kind",
  "projectId",
  "sourceGapStatus",
  "sourceGapUpdatedAt",
  "proposedPayload",
  "warnings",
  "sourceBoundary"
]) {
  assert.match(draftBody, new RegExp(`\\b${field}\\b`), `draft must expose ${field}`);
}
const previewBody = interfaceBody(confirmationTypes, "OutputGapFeedbackPreview");
for (const field of ["draftId", "proposedChanges", "canApply", "previewHash", "warnings", "sourceBoundary"]) {
  assert.match(previewBody, new RegExp(`\\b${field}\\b`), `preview must expose ${field}`);
}
const confirmationBody = interfaceBody(confirmationTypes, "OutputGapFeedbackConfirmation");
for (const field of ["draftId", "confirmedByUser", "confirmedAt", "previewHash"]) {
  assert.match(confirmationBody, new RegExp(`\\b${field}\\b`), `confirmation must expose ${field}`);
}

for (const entry of [
  "createTaskDraftFromOutputGap",
  "previewTaskDraftFromOutputGap",
  "applyTaskDraftFromOutputGap",
  "createRouteFeedbackDraftFromOutputGap",
  "previewRouteFeedbackDraftFromOutputGap",
  "applyRouteFeedbackDraftFromOutputGap",
  "confirmOutputGapFeedbackPreview",
  "applyOutputGapFeedbackDraft"
]) {
  assert.match(
    confirmationService,
    new RegExp(`export\\s+(?:async\\s+)?function\\s+${entry}\\b`),
    `${entry} must exist`
  );
}

const previewBlock = functionBlock(
  confirmationService,
  "previewOutputGapFeedbackDraft",
  "previewTaskDraftFromOutputGap"
);
assert.match(previewBlock, /\bpreviewRegistry\.set\b/, "preview must register its deterministic hash");
assert.doesNotMatch(
  previewBlock,
  /\b(?:planningService|entityLinkService|outputConversionService)\./,
  "preview must not write Task, RouteNode, EntityLink, or OutputGap"
);

const validationBlock =
  confirmationService.match(
    /function\s+validateConfirmation\b[\s\S]*?(?=async\s+function\s+rejectExistingFeedback)/
  )?.[0] ?? "";
assert.match(validationBlock, /confirmation\.confirmedByUser\s*!==\s*true/, "apply must require a confirmation object");
assert.match(validationBlock, /confirmation\.draftId\s*!==\s*draft\.id/, "confirmation must match draftId");
assert.match(validationBlock, /confirmation\.previewHash\s*!==\s*expectedHash/, "confirmation must match previewHash");
assert.match(validationBlock, /!registered/, "apply must reject a draft that was not previewed");

const taskApplyBlock =
  confirmationService.match(
    /async\s+function\s+applyTask\b[\s\S]*?(?=async\s+function\s+applyRouteFeedback)/
  )?.[0] ?? "";
assert.match(taskApplyBlock, /planningService\.createTask\(/, "Task apply must create a Task");
assert.match(taskApplyBlock, /relatedTaskId:\s*task\.id[\s\S]*?status:\s*["']task_created["']/, "Task apply must write relatedTaskId and task_created");
assert.match(taskApplyBlock, /entityLinkService\.ensureEntityLink\([\s\S]*?targetType:\s*["']task["'][\s\S]*?needs_followup_task/, "Task apply must ensure a cross-module EntityLink");
assert.doesNotMatch(taskApplyBlock, /status:\s*["'](?:resolved|done)["']/, "Task apply must not resolve the Gap or complete the Task");
assert.doesNotMatch(taskApplyBlock, /createRouteNode\(/, "Task apply must not create a RouteNode");

const routeApplyBlock =
  confirmationService.match(
    /async\s+function\s+applyRouteFeedback\b[\s\S]*?(?=export\s+async\s+function\s+applyOutputGapFeedbackDraft)/
  )?.[0] ?? "";
assert.match(routeApplyBlock, /planningService\.createRouteNode\(/, "Route apply must create a RouteNode");
assert.match(routeApplyBlock, /relatedRouteNodeId:\s*routeNode\.id[\s\S]*?status:\s*["']route_feedback_created["']/, "Route apply must write relatedRouteNodeId and route_feedback_created");
assert.match(routeApplyBlock, /entityLinkService\.ensureEntityLink\([\s\S]*?targetType:\s*["']routeNode["'][\s\S]*?relationType:\s*["']produces["']/, "Route apply must ensure a cross-module EntityLink");
assert.doesNotMatch(routeApplyBlock, /status:\s*["']resolved["']/, "Route apply must not resolve the Gap");
assert.doesNotMatch(routeApplyBlock, /createTask\(/, "Route apply must not create a Task");

assert.match(confirmationService, /\bpreviewHash\b[\s\S]*?\bdeterministicHash\b/, "previewHash must be deterministic");
assert.match(confirmationService, /\bappliedDraftResults\.get\b/, "duplicate apply must return a controlled result");
assert.match(confirmationService, /\brejectExistingFeedback\b[\s\S]*?relatedTaskId[\s\S]*?relatedRouteNodeId/, "existing direct feedback references must block duplicates");
assert.match(confirmationService, /entityLinkService\.queryLinksBySource/, "existing cross-module links must block duplicates");

assert.doesNotMatch(planningService, /\bcreateTaskFromOutputGap\b/, "planningService must not expose the old Task boolean-confirm bypass");
assert.doesNotMatch(planningService, /\bcreateRouteNodeFromOutputGap\b/, "planningService must not expose the old Route boolean-confirm bypass");
const pageFeedbackBlock =
  [
    outputsPage.match(
      /function\s+openFeedbackCardCreate\b[\s\S]*?(?=\n\s*function\s+openFeedbackCardEdit)/
    )?.[0] ?? "",
    outputsPage.match(
      /async\s+function\s+submitFeedbackCardForm\b[\s\S]*?(?=\n\s*async\s+function\s+setFeedbackCardStatus)/
    )?.[0] ?? "",
    outputsPage.match(
      /function\s+renderLayerActions\b[\s\S]*?(?=\n\s*function\s+depositionTitle)/
    )?.[0] ?? ""
  ].join("\n");
assert.match(pageFeedbackBlock, /openFeedbackCardCreate\("task",\s*detail\)/, "OutputsPage must keep a Task feedback card entry");
assert.match(pageFeedbackBlock, /openFeedbackCardCreate\("route",\s*detail\)/, "OutputsPage must keep a Route feedback card entry");
assert.match(pageFeedbackBlock, /outputGapFeedbackCardService\.createOutputGapFeedbackCard/, "OutputsPage must create feedback cards through the card service");
assert.match(pageFeedbackBlock, /type:\s*feedbackCardEditor\.type/, "OutputsPage must preserve task/route feedback card type");
assert.match(pageFeedbackBlock, /status:\s*feedbackCardFormDraft\.status/, "OutputsPage must preserve feedback card status instead of creating planning objects");
assert.match(pageFeedbackBlock, /priority:\s*feedbackCardFormDraft\.priority/, "OutputsPage must preserve feedback card priority");
assert.doesNotMatch(pageFeedbackBlock, /createTaskDraftFromOutputGap|createRouteFeedbackDraftFromOutputGap/, "OutputsPage must not bind to obsolete draft helper names");
assert.doesNotMatch(pageFeedbackBlock, /confirmOutputGapFeedbackPreview|applyOutputGapFeedbackDraft/, "OutputsPage feedback-card path must not apply planning feedback");
assert.doesNotMatch(pageFeedbackBlock, /confirmedByUser\s*:\s*true/, "OutputsPage feedback-card path must not pass a boolean confirmation");
assert.doesNotMatch(pageFeedbackBlock, /planningService\.|createTask\(|createRouteNode\(/, "OutputsPage feedback-card path must not create planning objects directly");

assert.doesNotMatch(
  aiGapAdapter,
  /outputGapConfirmationService|applyOutputGapFeedbackDraft|applyTaskDraftFromOutputGap|applyRouteFeedbackDraftFromOutputGap|createTaskFromOutputGap|createRouteNodeFromOutputGap/,
  "AI OutputGap adapter must not apply Task or Route feedback"
);
assert.doesNotMatch(
  aiGapAdapter,
  /OutputGapFeedbackConfirmation|previewHash/,
  "AI OutputGap adapter must not construct a feedback confirmation"
);

assert.doesNotMatch(
  confirmationService,
  /outputConversionRelationService|output_conversion_relations/,
  "Task and Route feedback must not write internal output relations"
);
assert.doesNotMatch(
  confirmationService,
  /\b(?:readFile|readTextFile|upload|openFile|deleteFile|removeFile|filePath|file_path|fullPath|absolutePath|localPath)\b/,
  "confirmation service must not read or expose local file content or paths"
);
assert.doesNotMatch(
  confirmationService,
  /\b(?:run_ai_text|runAI|callAI|invoke\()\b/,
  "confirmation service must not call AI"
);

const researchOutputBody = interfaceBody(outputTypes, "ResearchOutput");
assert.doesNotMatch(researchOutputBody, /\bfilePath\b/, "ResearchOutput.filePath must not return");
assert.match(selectorTypes, /export\s+type\s+OutputEntityDetailDto\b/);
assert.match(chainTypes, /export\s+interface\s+OutputChainDto\b/);
assert.match(outputConversionService, /\bcreateFindingFromResultItems\b/, "LP8-3 write layer must remain");
assert.match(outputConversionTypes, /export type OutputGap[\s\S]*?\bstructuredSummary\b/, "OutputGap structured contract must remain");
assert.doesNotMatch(outputConversionTypes.match(/export type OutputGap =([\s\S]*?)export type OutputGapFeedbackCardType/)?.[1] ?? "", /markdownBody/);
assert.match(aiEntityLinkAdapter, /output_conversion_internal_relation_forbidden/, "internal EntityLink bypass must remain blocked");
assert.doesNotMatch(
  entityConfig + sqliteRepository,
  /\b(?:result_assets|research_outputs|formal_outputs)\b/,
  "confirmation work must not add parallel output tables"
);

console.log("output gap confirmation contract semantic tests passed");
