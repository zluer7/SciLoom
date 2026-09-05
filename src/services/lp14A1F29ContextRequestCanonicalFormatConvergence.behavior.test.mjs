import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
      export {
        AI_CONTEXT_REQUEST_BOUNDED_POLICY,
        buildAIConstraintSemanticSegments,
        resolveAIActiveConstraintRequest,
        resolveAIConstraintDescriptor
      } from "./services/aiConstraintService.ts";
      export {
        AI_CONSTRAINT_CONTENT_REGISTRY_ENTRIES,
        normalizeAIConstraintDocumentContent,
        resolveAIConstraintContent
      } from "./services/aiConstraintContentService.ts";
      export {
        AI_CONTEXT_REQUEST_MAX_REQUESTABLE_REFS,
        createAIContextRequestResponseContract,
        parseAIContextRequestResponse
      } from "./services/aiContextRequestService.ts";
      export {
        createAIStandardResultResponseContract,
        parseAIParseDraftOutcome
      } from "./services/aiStandardResultService.ts";
      export {
        PARSE_DRAFT_PHASE_A_CONTEXT_OR_FINAL_DIRECTIVE,
        PARSE_DRAFT_USER_INSTRUCTION
      } from "./services/aiParseDraftService.ts";
    `,
    resolveDir: resolve(root, "src"),
    sourcefile: "lp14-a1-f29-context-request-canonical-format-harness.ts"
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

const PROJECT_ID = "project-lp14-a1-f29";

function requestableRef(index) {
  return {
    refKind: "AI_RESEARCH_OBJECT",
    refId: `task-lp14-a1-f29-${String(index).padStart(2, "0")}`,
    projectId: PROJECT_ID,
    label: `F29 Task ${index}`,
    entityType: "task",
    allowedContributionKinds: ["IDENTITY_METADATA"]
  };
}

function contextPackage(requestableCount = 31) {
  return {
    id: "context-lp14-a1-f29",
    version: "ai-lp13-d1-a23-v1",
    createdAt: "2026-09-01T00:00:00.000Z",
    scope: { type: "project", id: PROJECT_ID, label: "F29 Project" },
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
      items: [{
        id: PROJECT_ID,
        label: "F29 Project",
        value: "F29 bounded current project",
        provenance: []
      }]
    }],
    sourceRefs: [],
    warnings: [],
    excluded: [],
    reviewFingerprint: "review-lp14-a1-f29",
    budget: { maxChars: 15_000, maxItemChars: 1_200, maxItemsPerSection: 20 },
    budgetSummary: {
      maxChars: 15_000,
      usedChars: 0,
      remainingChars: 15_000,
      truncatedSections: 0,
      truncatedItems: 0,
      excludedItems: 0
    }
  };
}

function selectedDescriptor(category, purpose) {
  return subject.resolveAIActiveConstraintRequest({
    request: { kind: "current", category },
    purpose,
    contextRequestCapabilityEligible: true
  }).descriptor;
}

function resolvedContent(documentId, semanticVersion, role) {
  return subject.resolveAIConstraintContent({
    documentId,
    semanticVersion,
    role,
    lifecycle: "ACTIVE"
  }).content;
}

function canonicalMachineBlock(policy) {
  const normalized = subject.normalizeAIConstraintDocumentContent(policy);
  const marker = "## Canonical machine protocol";
  const offset = normalized.indexOf(marker);
  assert.notEqual(offset, -1);
  return normalized.slice(offset);
}

function occurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

test("F29 G1 current registry exposes one v5 canonical authority and immutable v16/v26 stage successors", () => {
  assert.deepEqual(subject.AI_CONTEXT_REQUEST_BOUNDED_POLICY, {
    documentId: "labpod.ai.policy.context_request",
    semanticVersion: 5
  });
  assert.equal(subject.resolveAIConstraintDescriptor("NORMAL_QA").constraintVersion, 16);
  assert.equal(subject.resolveAIConstraintDescriptor("PARSE_DRAFT").constraintVersion, 26);
  for (const identity of [
    ["labpod.ai.policy.context_request", 5, "BOUNDED_POLICY"],
    ["labpod.ai.constraint.normal_qa", 16, "CATEGORY_POLICY"],
    ["labpod.ai.constraint.parse_draft", 26, "CATEGORY_POLICY"]
  ]) {
    assert.equal(subject.AI_CONSTRAINT_CONTENT_REGISTRY_ENTRIES.filter((entry) =>
      entry.documentId === identity[0] && entry.semanticVersion === identity[1] &&
      entry.role === identity[2]).length, 1);
  }
});

test("F29 G2 a 31-ref current catalog remains request-capable and both Provider prompts reuse the identical canonical block once", () => {
  const context = contextPackage();
  const contract = subject.createAIContextRequestResponseContract(context);
  assert.equal(subject.AI_CONTEXT_REQUEST_MAX_REQUESTABLE_REFS, 64);
  assert.equal(contract.requestableRefs.length, 31);

  const policy = resolvedContent("labpod.ai.policy.context_request", 5, "BOUNDED_POLICY");
  const block = canonicalMachineBlock(policy);
  const blockHash = createHash("sha256").update(block).digest("hex");
  const natural = subject.buildAIPromptPackage(context, "请继续分析；若 exact target 缺失，请按当前协议请求。", {
    constraintDescriptor: selectedDescriptor("NORMAL_QA", "chat_response"),
    contextRequestResponseContract: contract,
    conversationMessages: []
  });
  const parse = subject.buildAIPromptPackage(context, "Parse Draft", {
    constraintDescriptor: selectedDescriptor("PARSE_DRAFT", "parse_draft"),
    contextRequestResponseContract: contract,
    standardResultResponseContract: subject.createAIStandardResultResponseContract(),
    conversationMessages: []
  });
  assert.equal(occurrences(natural.finalPrompt, block), 1);
  assert.equal(occurrences(parse.finalPrompt, block), 1);
  assert.equal(createHash("sha256").update(canonicalMachineBlock(natural.constraintSegments[2].text)).digest("hex"), blockHash);
  assert.equal(createHash("sha256").update(canonicalMachineBlock(parse.constraintSegments[2].text)).digest("hex"), blockHash);
  assert.equal(natural.providerPromptEnvelope.contextRequestResponseContract.requestableRefs.length, 31);
  assert.equal(parse.providerPromptEnvelope.contextRequestResponseContract.requestableRefs.length, 31);
  assert.equal(natural.budgetSummary.technicalCapacity.status, "WITHIN_GUARD");
  assert.equal(parse.budgetSummary.technicalCapacity.status, "WITHIN_GUARD");
});

test("F30 G6 the sole active machine contract is terminal and its carrier guard adds no second schema", () => {
  const context = contextPackage();
  const contract = subject.createAIContextRequestResponseContract(context);
  const natural = subject.buildAIPromptPackage(context, "Update the exact missing existing target.", {
    constraintDescriptor: selectedDescriptor("NORMAL_QA", "chat_response"),
    contextRequestResponseContract: contract,
    conversationMessages: []
  });
  const parse = subject.buildAIPromptPackage(context, "Parse Draft", {
    constraintDescriptor: selectedDescriptor("PARSE_DRAFT", "parse_draft"),
    contextRequestResponseContract: contract,
    standardResultResponseContract: subject.createAIStandardResultResponseContract(),
    conversationMessages: []
  });

  assert.ok(natural.finalPrompt.indexOf("## Typed Response Contract") > natural.finalPrompt.indexOf("## User Question"));
  assert.ok(parse.finalPrompt.indexOf("## Typed Parse Draft Outcome Contract") > parse.finalPrompt.indexOf("## User Question"));
  assert.equal(occurrences(natural.finalPrompt, "## Final carrier adherence gate"), 1);
  assert.equal(occurrences(parse.finalPrompt, "## Final carrier adherence gate"), 1);
  assert.match(parse.finalPrompt, /results contains 1-8 items and every Result has exactly category, action, target, and payload/u);
  assert.match(parse.finalPrompt, /\[action, target\.entityType, target\.entityType, channel\] joined with dots/u);
  assert.match(parse.finalPrompt, /Route uses target\.entityType routeNode and Task uses target\.entityType task; both have zero child-effect capability/u);
  assert.match(parse.finalPrompt, /must never use an empty results array as a fallback/u);
  assert.match(natural.finalPrompt, /A bare payload, Markdown-fenced payload, contract descriptor, prefix, or suffix is invalid\.[^]*$/u);
  assert.match(parse.finalPrompt, /A Markdown fence, prose, contract descriptor, bare nested payload, null alternate, or second outcome is invalid\.[^]*$/u);
  assert.equal(occurrences(natural.finalPrompt, "## Typed Response Contract"), 1);
  assert.equal(occurrences(parse.finalPrompt, "## Typed Parse Draft Outcome Contract"), 1);
});

test("F29 G3 category policies retain only stage semantics and do not define a second Context Request schema", () => {
  const normal = resolvedContent("labpod.ai.constraint.normal_qa", 16, "CATEGORY_POLICY");
  const parse = resolvedContent("labpod.ai.constraint.parse_draft", 26, "CATEGORY_POLICY");
  assert.match(normal, /唯一例外.*canonical Context Request policy/su);
  assert.match(parse, /本 category policy 不另行定义、改写或复制 machine schema/u);
  for (const category of [normal, parse]) {
    assert.doesNotMatch(category, /LABPOD_CONTEXT_REQUEST_V1/u);
    assert.doesNotMatch(category, /wrapperStart|wrapperEnd|payloadShape/u);
    assert.doesNotMatch(category, /request root key set.*contextRequest/su);
  }
  assert.doesNotMatch(subject.PARSE_DRAFT_USER_INSTRUCTION, /request root key set.*contextRequest/su);
  assert.match(subject.PARSE_DRAFT_USER_INSTRUCTION, /sole canonical Context Request policy/u);
});

test("LP15-A3-R1 Parse Draft exposes the dynamic-context budget while fixed rules remain intact", async () => {
  const context = contextPackage(1);
  const contract = subject.createAIContextRequestResponseContract(context);
  const prompt = subject.buildAIPromptPackage(context, subject.PARSE_DRAFT_USER_INSTRUCTION, {
    constraintDescriptor: selectedDescriptor("PARSE_DRAFT", "parse_draft"),
    contextRequestResponseContract: contract,
    standardResultResponseContract: subject.createAIStandardResultResponseContract(),
    runScopedDirective: subject.PARSE_DRAFT_PHASE_A_CONTEXT_OR_FINAL_DIRECTIVE,
    conversationMessages: [
      { id: "message-user", role: "user", content: "Create one short task draft." },
      { id: "message-assistant", role: "assistant", content: "I suggest a concise task draft." }
    ],
    technicalCapacityChars: 45_000
  });
  assert.ok(Array.from(subject.PARSE_DRAFT_USER_INSTRUCTION).length < 1_200);
  assert.equal(prompt.budgetSummary.technicalCapacity.status, "WITHIN_GUARD");
  assert.equal(prompt.warnings.some((warning) => warning.code === "technical_capacity_or_safety_error"), false);

  const panelSource = await readFile(resolve(root, "src/components/ai/GlobalAIChatPanel.tsx"), "utf8");
  assert.match(panelSource, /软件动态上下文超过 45,000 字符预算，尚未调用模型/u);
  assert.doesNotMatch(panelSource, /解析内容未通过发送前检查，请调整后重试/u);
});

test("F29 G4 the shared validator is exact-key fail-closed for Natural and Parse carriers", () => {
  const payload = {
    version: 1,
    assistantText: "需要 exact task identity 才能继续。",
    reason: "当前 frozen Context 未提供该 existing target。",
    requestedRefs: [{
      refKind: "AI_RESEARCH_OBJECT",
      refId: "task-lp14-a1-f29-01",
      contributionKind: "IDENTITY_METADATA"
    }]
  };
  const naturalValid = `<labpod_context_request>${JSON.stringify(payload)}</labpod_context_request>`;
  assert.equal(subject.parseAIContextRequestResponse(naturalValid).kind, "context_request");
  assert.equal(subject.parseAIContextRequestResponse(
    `<labpod_context_request>${JSON.stringify({ ...payload, extra: true })}</labpod_context_request>`
  ).kind, "invalid_structured");
  assert.equal(subject.parseAIContextRequestResponse(
    `<labpod_context_request>${JSON.stringify({
      ...payload,
      requestedRefs: [{ ...payload.requestedRefs[0], extra: true }]
    })}</labpod_context_request>`
  ).kind, "invalid_structured");

  assert.equal(subject.parseAIParseDraftOutcome(JSON.stringify({
    outcome: "AI_CONTEXT_REQUEST",
    contextRequest: payload
  })).kind, "context_request");
  assert.throws(() => subject.parseAIParseDraftOutcome(JSON.stringify({
    outcome: "AI_CONTEXT_REQUEST",
    contextRequest: { ...payload, extra: true }
  })), /payload shape or version is invalid/u);

  const legalTask = subject.parseAIParseDraftOutcome(JSON.stringify({
    outcome: "STANDARD_RESULT_BATCH",
    batch: {
      version: 1,
      results: [{
        category: "DATA_OPERATION",
        action: "CREATE",
        target: { projectId: PROJECT_ID, entityType: "task" },
        payload: { title: "R2 legal task" }
      }]
    }
  }));
  assert.equal(legalTask.kind, "standard_result_batch");

  assert.throws(() => subject.parseAIParseDraftOutcome(JSON.stringify({
    outcome: "STANDARD_RESULT_BATCH",
    batch: {
      version: 1,
      results: [{
        category: "DATA_OPERATION",
        action: "CREATE",
        target: { projectId: PROJECT_ID, entityType: "task" },
        payload: {
          title: "R2 task with forbidden effect",
          manuscriptEffects: [{ channel: "primary", body: "# Must fail closed" }]
        }
      }]
    }
  })), (error) => error?.code === "STANDARD_RESULT_MANUSCRIPT_EFFECT_INVALID" &&
    /parent action\/object\/channel manuscript effect tuple is unsupported/u.test(error.message));
});

test("F29 G5 Rust transport parity carries v16/v26/v5 and the 64-ref bound without changing C5", async () => {
  const rust = await readFile(resolve(root, "src-tauri/src/authorized_material.rs"), "utf8");
  const durable = await readFile(resolve(root, "src-tauri/src/db/ai_durable_foundation.rs"), "utf8");
  assert.match(rust, /NORMAL_QA_CONSTRAINT_VERSION: u64 = 16/u);
  assert.match(rust, /PARSE_DRAFT_CONSTRAINT_VERSION: u64 = 26/u);
  assert.match(rust, /CONTEXT_REQUEST_POLICY_VERSION: u64 = 5/u);
  assert.match(rust, /requestable_refs\.len\(\) > 64/u);
  assert.match(rust, /SAME_PARSE_ATTEMPT_AUTOMATIC_FOLLOWUP/u);
  assert.match(durable, /Some\(3 \| 4 \| 5\)/u);
});
