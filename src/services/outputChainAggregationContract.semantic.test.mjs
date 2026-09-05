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

const chainTypes = source("../types/outputChain.ts");
const chainService = source("./outputChainAggregationService.ts");
const selectorTypes = source("../types/outputSelector.ts");
const fiveLayerSelector = source("./outputFiveLayerSelectorService.ts");
const legacySelector = source("./outputConversionSelectorService.ts");
const outputConversionTypes = source("../types/outputConversion.ts");
const outputTypes = source("../types/output.ts");
const outputConversionService = source("./outputConversionService.ts");
const outputService = source("./outputService.ts");
const outputDeleteSafetyService = source("./outputDeleteSafetyService.ts");
const aiEntityLinkAdapter = source("./aiEntityLinkDraftApplyAdapter.ts");
const entityConfig = source("../repositories/entityConfig.ts");
const sqliteRepository = source("../repositories/sqliteRepository.ts");

for (const typeName of [
  "OutputChainBoundary",
  "OutputChainNode",
  "OutputChainEdge",
  "OutputChainDto",
  "OutputChainOptions",
  "OutputChainQuery"
]) {
  assert.match(
    chainTypes,
    new RegExp(`export\\s+interface\\s+${typeName}\\b`),
    `${typeName} must exist`
  );
}

const dtoBody = interfaceBody(chainTypes, "OutputChainDto");
for (const field of ["kind", "root", "nodes", "edges", "depth", "maxDepth", "maxNodes", "boundary"]) {
  assert.match(dtoBody, new RegExp(`\\b${field}\\b`), `OutputChainDto must expose ${field}`);
}
const boundaryBody = interfaceBody(chainTypes, "OutputChainBoundary");
for (const field of [
  "missing",
  "partial",
  "truncated",
  "cycleDetected",
  "depthLimitReached",
  "nodeLimitReached",
  "sourceBoundary",
  "warnings"
]) {
  assert.match(boundaryBody, new RegExp(`\\b${field}\\b`), `chain boundary must expose ${field}`);
}

for (const [selector, kind] of [
  ["getFindingEvidenceChain", "findingEvidence"],
  ["getOutputCandidateEvidenceChain", "candidateEvidence"],
  ["getOutputGapImpactChain", "outputGapImpact"],
  ["getResearchOutputSourceChain", "researchOutputSource"]
]) {
  assert.match(
    chainService,
    new RegExp(`export\\s+function\\s+${selector}\\b[\\s\\S]*?kind:\\s*["']${kind}["']`),
    `${selector} must use the unified chain mainline`
  );
}
assert.match(chainService, /export\s+async\s+function\s+getOutputChain\b/, "unified chain selector must exist");
assert.match(
  chainService,
  /import\s+\{\s*getOutputEntityDetail\s*\}\s+from\s+["']\.\/outputFiveLayerSelectorService["']/,
  "chain aggregation must build on the LP8-4-A detail selector"
);
assert.match(fiveLayerSelector, /export\s+async\s+function\s+getOutputEntityDetail\b/, "LP8-4-A detail selector must remain available");
assert.match(selectorTypes, /export\s+type\s+OutputEntityDetailDto\b/, "conditional five-layer detail DTO must remain available");

for (const relationType of [
  "evidence_for",
  "supports",
  "uses",
  "blocks",
  "resolves",
  "converted_to",
  "extends",
  "contradicts"
]) {
  assert.match(
    chainService,
    new RegExp(`["']${relationType}["']`),
    `chain traversal must recognize ${relationType}`
  );
}
assert.match(
  chainService,
  /case\s+["']finding["'][\s\S]*?evidence_for/,
  "Finding chain must traverse resultItem -> finding evidence_for"
);
assert.match(
  chainService,
  /case\s+["']outputCandidate["'][\s\S]*?supports[\s\S]*?uses[\s\S]*?converted_to/,
  "Candidate chain must traverse supports, uses, and converted_to"
);
assert.match(
  chainService,
  /case\s+["']outputGap["'][\s\S]*?blocks[\s\S]*?resolves/,
  "Gap chain must traverse blocks and resolves"
);
assert.match(
  chainService,
  /case\s+["']researchOutput["'][\s\S]*?converted_to/,
  "ResearchOutput chain must traverse converted_to"
);

assert.match(chainService, /DEFAULT_MAX_DEPTH\s*=\s*3/, "default maxDepth must be bounded");
assert.match(chainService, /DEFAULT_MAX_NODES\s*=\s*50/, "default maxNodes must be bounded");
assert.match(chainService, /\bvisited:\s*Set<string>/, "visited set must guard duplicate expansion");
assert.match(chainService, /\bactivePath:\s*Set<string>/, "active path must detect cycles");
assert.match(chainService, /\bexpandedRelationIds:\s*Set<string>/, "relation IDs must be deduplicated");
assert.match(chainService, /state\.activePath\.has\(nextNodeId\)[\s\S]*?markCycle/, "cycle detection must set boundary state");
assert.match(chainService, /depth\s*>=\s*state\.options\.maxDepth/, "maxDepth must stop expansion");
assert.match(chainService, /state\.nodes\.size\s*>=\s*state\.options\.maxNodes/, "maxNodes must stop node creation");
assert.match(chainService, /markDepthLimit[\s\S]*?truncated\s*=\s*true/, "depth truncation must be diagnostic");
assert.match(chainService, /markNodeLimit[\s\S]*?truncated\s*=\s*true/, "node truncation must be diagnostic");

assert.match(chainService, /\bfileRefs:\s*includeFileRefs\s*\?\s*detail\.fileRefs/, "nodes must reuse detail-selector FileRef summaries");
assert.match(chainService, /\bfileRef\.pathSummary\b/, "FileRef nodes must expose only pathSummary");
const fileSummaryBody = interfaceBody(selectorTypes, "OutputFileRefSummary");
assert.doesNotMatch(
  fileSummaryBody,
  /\b(?:path|fullPath|absolutePath|localPath)\s*[?:]/,
  "chain FileRef summaries must not expose full path fields"
);
assert.doesNotMatch(
  chainService,
  /\b(?:readFile|readTextFile|upload|openFile|deleteFileRef|removeFile|unlink)\b/,
  "chain selector must not read, upload, open, or delete real files"
);
assert.doesNotMatch(
  chainService,
  /\b(?:filePath|file_path|fullPath|absolutePath|localPath|fileRef\.path)\b/,
  "chain selector must not read or return complete path fields"
);

assert.doesNotMatch(
  chainService,
  /\b(?:linkedResultItemIds|linkedFindingIds|linkedAssetIds|formalOutputId|sourceCandidateId|outputCandidateId|resolvedByResultItemId)\b/,
  "chain selector must not use old arrays or direct relation FKs"
);
assert.doesNotMatch(
  chainService,
  /\b(?:EntityLink|entityLinkService)\b/,
  "chain selector must not use internal EntityLink aggregation"
);
assert.match(
  chainService,
  /function\s+addProvenanceSnapshot\b[\s\S]*?output\.provenance/,
  "provenance may be represented only by the snapshot helper"
);
assert.doesNotMatch(
  chainService,
  /provenance\.(?:sourceCandidateId|linkedFindingIds|linkedResultItemIds|linkedAssetIds|outputGapIds)/,
  "provenance snapshot must not drive live chain relations"
);

assert.match(
  chainService,
  /relatedTaskId[\s\S]*?relationType:\s*["']planning_feedback["']/,
  "Gap chain must expose Task as a lightweight cross-module reference"
);
assert.match(
  chainService,
  /relatedRouteNodeId[\s\S]*?relationType:\s*["']planning_feedback["']/,
  "Gap chain must expose RouteNode as a lightweight cross-module reference"
);
assert.doesNotMatch(
  chainService,
  /\b(?:create|update|softDelete|hardDelete|remove)(?:Task|RouteNode|OutputGap|OutputCandidate|Finding|ResultItem|ResearchOutput)\b/,
  "chain selector must not write business state"
);

assert.match(
  legacySelector,
  /export\s+async\s+function\s+getCandidateEvidenceChain\b[\s\S]*?getOutputCandidateEvidenceChain\(/,
  "legacy Candidate evidence entry must delegate to the unified chain selector"
);
assert.doesNotMatch(
  legacySelector,
  /\b(?:sourceNodesForContext|resultItemToEvidenceNode|collectCandidateEvidenceReferenceState)\b/,
  "the old competing recursive Candidate chain must be removed"
);

const researchOutputBody = interfaceBody(outputTypes, "ResearchOutput");
assert.doesNotMatch(researchOutputBody, /\bfilePath\b/, "ResearchOutput.filePath must not return");
for (const entity of ["ResultItem", "Finding", "OutputCandidate", "OutputGap"]) {
  const body =
    outputConversionTypes.match(
      new RegExp(`export\\s+type\\s+${entity}\\b[^{=]*(?:=\\s*[^&]+&\\s*)?\\{([\\s\\S]*?)\\n\\};?`)
    )?.[1] ?? "";
  for (const field of ["status", "structuredSummary"]) {
    assert.match(body, new RegExp(`\\b${field}\\b`), `${entity} must retain ${field}`);
  }
  assert.doesNotMatch(body, /\bmarkdownBody\b/, `${entity} must use file-aware manuscript BODY`);
}
assert.doesNotMatch(chainTypes + chainService, /markdownPreview|detail\.markdownBody/,
  "chain DTOs must not expose migrated or legacy manuscript BODY previews");
assert.match(outputConversionService, /\bcreateFindingFromResultItems\b/, "LP8-3 write service must remain");
assert.doesNotMatch(outputService, /\bdeleteResearchOutput\b/, "ResearchOutput must not retain the old boolean-confirm delete path");
assert.match(outputDeleteSafetyService, /\bresearchOutput\b[\s\S]*?\bsoftDeleteOutputEntity\b/, "ResearchOutput deletion must use the LP8-6-C safety service");
assert.match(
  aiEntityLinkAdapter,
  /output_conversion_internal_relation_forbidden/,
  "AI EntityLink internal-relation bypass must remain blocked"
);
assert.doesNotMatch(
  entityConfig + sqliteRepository,
  /\b(?:result_assets|research_outputs|formal_outputs)\b/,
  "chain work must not introduce parallel output tables"
);

console.log("output chain aggregation contract semantic tests passed");
