import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..", "..");
const bundle = await build({
  stdin: {
    contents: `
      export { buildAIPromptPackage } from "./services/aiPromptPackageService.ts";
      export { validatePrompt } from "./services/aiClient.ts";
      export {
        measureAIParseDynamicContextBudget,
        toAIProviderTransportPromptEnvelope
      } from "./services/aiParseDynamicContextBudgetService.ts";
      export {
        PARSE_DRAFT_PHASE_A_CONTEXT_OR_FINAL_DIRECTIVE,
        PARSE_DRAFT_USER_INSTRUCTION
      } from "./services/aiParseDraftService.ts";
      export { resolveAIActiveConstraintRequest } from "./services/aiConstraintService.ts";
      export { createAIContextRequestResponseContract } from "./services/aiContextRequestService.ts";
      export { createAIStandardResultResponseContract } from "./services/aiStandardResultService.ts";
    `,
    resolveDir: resolve(root, "src"),
    sourcefile: "lp15-a3-r1-parse-dynamic-context-budget-harness.ts"
  },
  plugins: [{
    name: "tauri-invoke-stub",
    setup(api) {
      api.onResolve({ filter: /^@tauri-apps\/api\/core$/u }, () => ({
        path: "tauri-core",
        namespace: "stub"
      }));
      api.onLoad({ filter: /^tauri-core$/u, namespace: "stub" }, () => ({
        contents: "export class Channel { constructor(onmessage){ this.onmessage = onmessage; } } export async function invoke(){ throw new Error('unexpected invoke'); }"
      }));
    }
  }],
  bundle: true,
  loader: { ".md": "text" },
  write: false,
  format: "cjs",
  platform: "node",
  target: "es2022"
});
const harness = { exports: {} };
new Function("require", "module", "exports", bundle.outputFiles[0].text)(
  createRequire(import.meta.url), harness, harness.exports
);
const subject = harness.exports;

const PROJECT_ID = "project-lp15-a3-r1";

function requestableRef(index) {
  return {
    refKind: "AI_RESEARCH_OBJECT",
    refId: `task-lp15-a3-r1-${String(index).padStart(2, "0")}`,
    projectId: PROJECT_ID,
    label: `R1 Task ${index}`,
    entityType: "task",
    allowedContributionKinds: ["IDENTITY_METADATA"]
  };
}

function contextPackage(requestableCount = 64) {
  return {
    id: "context-lp15-a3-r1",
    version: "ai-lp15-a3-r1-v1",
    createdAt: "2026-09-03T00:00:00.000Z",
    scope: { type: "project", id: PROJECT_ID, label: "R1 Project" },
    contextMode: "BRIEF",
    compositionPolicy: "DEFAULT",
    researchObjects: [],
    materialDecisions: [],
    approvedContextRequestContributions: [],
    requestableRefs: Array.from({ length: requestableCount }, (_, index) => requestableRef(index + 1)),
    sections: [{
      id: "project",
      title: "Current Project",
      module: "project",
      priority: "critical",
      charCount: 497,
      budgetUsed: 497,
      truncated: false,
      sourceRefs: [],
      items: [{
        id: PROJECT_ID,
        title: "R1 Project",
        summary: "Small representative Auto-Pull context.",
        module: "project",
        entityType: "project",
        sourceRefs: [],
        priority: "critical",
        charCount: 497,
        sendable: true,
        truncated: false
      }]
    }],
    sourceRefs: [],
    warnings: [],
    excluded: [],
    reviewFingerprint: "review-lp15-a3-r1",
    budget: {
      maxChars: 15_000,
      reservedForUserQuestion: 0,
      reservedForSystemInstruction: 0,
      strategy: "balanced"
    },
    budgetSummary: {
      maxChars: 15_000,
      usedChars: 497,
      remainingChars: 14_503,
      truncatedSections: 0,
      truncatedItems: 0,
      excludedItems: 0,
      notes: []
    }
  };
}

function parseDescriptor(contextRequestCapabilityEligible) {
  return subject.resolveAIActiveConstraintRequest({
    request: { kind: "current", category: "PARSE_DRAFT" },
    purpose: "parse_draft",
    contextRequestCapabilityEligible
  }).descriptor;
}

function buildRepresentativeParsePrompt(options = {}) {
  const context = options.context ?? contextPackage();
  const contract = options.withContextRequest === false
    ? undefined
    : subject.createAIContextRequestResponseContract(context);
  return subject.buildAIPromptPackage(
    context,
    subject.PARSE_DRAFT_USER_INSTRUCTION,
    {
      constraintDescriptor: parseDescriptor(Boolean(contract)),
      ...(contract ? { contextRequestResponseContract: contract } : {}),
      standardResultResponseContract: subject.createAIStandardResultResponseContract(),
      runScopedDirective: subject.PARSE_DRAFT_PHASE_A_CONTEXT_OR_FINAL_DIRECTIVE,
      parseDynamicRunScopedSegments: [
        "The CURRENT PARSE DELTA starts after sequence 0 and ends at sequence 2.",
        "## Provider Owner Entity Refs\n[{\"ownerType\":\"project\",\"ownerId\":\"project-lp15-a3-r1\"}]"
      ],
      conversationMessages: options.conversationMessages ?? [
        { id: "message-user", sequence: 1, role: "user", content: "创建一个校准任务并关联当前课题。" },
        { id: "message-assistant", sequence: 2, role: "assistant", content: "A".repeat(1_320) }
      ],
      maxConversationHistoryChars: 4_000,
      maxConversationHistoryMessages: 12,
      ...(options.contextMarkdownOverride !== undefined
        ? { contextMarkdownOverride: options.contextMarkdownOverride }
        : {}),
      technicalCapacityChars: 45_000,
      outputDetailPreference: "STANDARD"
    }
  );
}

test("fresh representative Parse may exceed the old total threshold while dynamic context stays below 45k", () => {
  const prompt = buildRepresentativeParsePrompt();
  const receipt = prompt.budgetSummary.parseDynamicContextBudget;
  assert.ok(Array.from(prompt.finalPrompt).length > 45_000);
  assert.equal(receipt.classification, "PARSE_DYNAMIC_CONTEXT_BUDGET");
  assert.equal(receipt.includedInputClass, "SOFTWARE_DYNAMIC_CONTEXT");
  assert.deepEqual(receipt.excludedInputClasses, ["FIXED_SYSTEM_CONTENT", "USER_EXPLICIT_CONTENT"]);
  assert.ok(receipt.estimatedCharacters < 45_000);
  assert.equal(receipt.status, "WITHIN_GUARD");
  assert.equal(prompt.budgetSummary.technicalCapacity.estimatedCharacters, receipt.estimatedCharacters);
  assert.equal(prompt.warnings.some((warning) => warning.code === "technical_capacity_or_safety_error"), false);
  assert.equal(subject.validatePrompt(prompt.finalPrompt).ok, false, "the replaced old-style total guard would block");
  assert.equal(subject.validatePrompt(prompt.finalPrompt, { enforceLegacyTotalCharacterGuard: false }).ok, true);
  assert.equal(prompt.providerPromptEnvelope.runScopedDirective, subject.PARSE_DRAFT_PHASE_A_CONTEXT_OR_FINAL_DIRECTIVE);
  assert.equal(prompt.providerPromptEnvelope.parseDynamicContextBudget.runScopedDynamicSegments.length, 2);
  const transport = subject.toAIProviderTransportPromptEnvelope(prompt.providerPromptEnvelope);
  assert.equal("entityType" in transport.contextRequestResponseContract.requestableRefs[0], false);
});

test("true Parse software dynamic context above 45k remains fail-closed", () => {
  const prompt = buildRepresentativeParsePrompt({
    context: contextPackage(0),
    withContextRequest: false,
    contextMarkdownOverride: "D".repeat(45_001),
    conversationMessages: []
  });
  assert.ok(prompt.budgetSummary.parseDynamicContextBudget.estimatedCharacters > 45_000);
  assert.equal(prompt.budgetSummary.parseDynamicContextBudget.status, "TECHNICAL_CAPACITY_OR_SAFETY_ERROR");
  assert.equal(prompt.warnings.some((warning) => warning.code === "technical_capacity_or_safety_error"), true);
});

test("user-explicit conversation bodies and material receipts are preserved but excluded from the Parse dynamic budget", () => {
  const shortUser = buildRepresentativeParsePrompt({
    context: contextPackage(0),
    withContextRequest: false,
    conversationMessages: [
      { id: "message-user", sequence: 1, role: "user", content: "用户输入" },
      { id: "message-assistant", sequence: 2, role: "assistant", content: "assistant continuity" }
    ]
  });
  const explicitUserBody = "用户明确提供的原文".repeat(300);
  const materialContext = contextPackage(0);
  materialContext.materialDecisions = [{
    fileRefId: "file-explicit-r1",
    displayName: "explicit.txt",
    availabilityStatus: "available",
    materialReadStatus: "metadata_only",
    materialPromptReservationCharacters: 32_000,
    materialFreshnessReceipt: {
      fileRefId: "file-explicit-r1",
      receiptVersion: "material-source-v1",
      sourceToken: "a".repeat(64)
    },
    selected: true,
    authorizationStatus: "pending_per_call_authorization",
    contextRole: "explicitMaterial",
    contextLevel: 1
  }];
  const largeExplicit = buildRepresentativeParsePrompt({
    context: materialContext,
    withContextRequest: false,
    conversationMessages: [
      { id: "message-user", sequence: 1, role: "user", content: explicitUserBody },
      { id: "message-assistant", sequence: 2, role: "assistant", content: "assistant continuity" }
    ]
  });
  assert.equal(
    largeExplicit.budgetSummary.parseDynamicContextBudget.estimatedCharacters,
    shortUser.budgetSummary.parseDynamicContextBudget.estimatedCharacters
  );
  assert.ok(largeExplicit.finalPrompt.includes(explicitUserBody));
  assert.equal(largeExplicit.warnings.some((warning) => warning.code === "technical_capacity_or_safety_error"), false);
  assert.ok(largeExplicit.budgetSummary.inputClassLedger
    .find((entry) => entry.inputClass === "USER_EXPLICIT_TASK_OR_INPUT_CONTENT")
    .characters >= 32_000);
});

test("shared v1 fixture fixes frontend transport accounting for deterministic Rust parity", async () => {
  const fixture = JSON.parse(await readFile(
    resolve(root, "tests/fixtures/parse_dynamic_context_budget_v1.json"),
    "utf8"
  ));
  const envelope = {
    constraintDescriptor: { category: "PARSE_DRAFT" },
    researchContext: fixture.researchContext,
    conversationHistory: fixture.conversationHistory,
    contextRequestResponseContract: {
      contract: "LABPOD_CONTEXT_REQUEST_V1",
      wrapperStart: "<labpod_context_request>",
      wrapperEnd: "</labpod_context_request>",
      requestableRefs: fixture.requestableRefs.map((reference, index) => ({
        ...reference,
        entityType: fixture.frontendOnlyEntityTypes[index]
      })),
      alreadySuppliedRefs: fixture.alreadySuppliedRefs,
      contributionKinds: ["IDENTITY_METADATA", "BODY_CONTENT"]
    },
    quickAnalysisContextCapability: fixture.quickAnalysisContextCapability,
    contextRequestFollowupState: fixture.contextRequestFollowupState,
    parseDynamicContextBudget: {
      classification: "PARSE_DYNAMIC_CONTEXT_BUDGET",
      maxCharacters: 45_000,
      runScopedDynamicSegments: fixture.runScopedDynamicSegments
    }
  };
  const receipt = subject.measureAIParseDynamicContextBudget(envelope);
  assert.deepEqual(receipt.components, fixture.expectedComponents);
  assert.equal(receipt.estimatedCharacters, fixture.expectedCharacters);
  assert.equal(receipt.estimatedCharacters, 862);
});
