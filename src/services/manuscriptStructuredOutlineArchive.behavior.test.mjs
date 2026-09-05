import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..", "..");
const bundle = await build({
  stdin: {
    contents: [
      'export * from "./services/manuscriptStructuredOutlineArchive.ts";',
      'export * from "./services/manuscriptOutlineDescriptorRegistry.ts";',
      'export * from "./services/manuscriptOutlineSerializer.ts";',
      'export * from "./services/manuscriptOutlineParser.ts";',
      'export * from "./services/canonicalFormalSwitchArchiveConvergence.ts";',
      'export * from "./services/quickAnalysisStructuredManuscriptGenerationContract.ts";',
      'export { buildAIPromptPackage } from "./services/aiPromptPackageService.ts";',
      'export { resolveAIQuickConstraintDescriptor } from "./services/aiConstraintService.ts";',
      'export { createAIStandardResultResponseContract } from "./services/aiStandardResultService.ts";',
      'export {',
      '  AI_PARSE_DRAFT_STRUCTURED_MANUSCRIPT_GUIDANCE_MAX_VARIANTS,',
      '  PARSE_DRAFT_STANDARD_RESULT_ONLY_DIRECTIVE,',
      '  buildAIParseDraftPromptPackage,',
      '  buildAIParseDraftStructuredManuscriptGuidance',
      '} from "./services/aiParseDraftService.ts";'
    ].join("\n"),
    resolveDir: resolve(root, "src"),
    sourcefile: "f5-3-structured-outline-archive-harness.ts"
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
  format: "esm",
  platform: "node",
  target: "es2022"
});
const subject = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const begin = subject.structuredOutlineArchiveBeginMarker;
const end = subject.structuredOutlineArchiveEndMarker;

function bytes(value) {
  return typeof value === "string" ? encoder.encode(value) : value;
}

function occurrenceCount(value, needle) {
  return value.split(needle).length - 1;
}

function representedStableKeys(value) {
  return [...value.matchAll(/<!-- labpod:field=([^\s]+) -->/gu)]
    .map((match) => match[1]);
}

function quickContextPackage() {
  return {
    id: "context-lp15-c2",
    version: "ai-lp15-c2-v1",
    createdAt: "2026-09-04T00:00:00.000Z",
    scope: { type: "project", id: "project-lp15-c2", label: "C2 Project" },
    contextMode: "BRIEF",
    compositionPolicy: "DEFAULT",
    researchObjects: [],
    materialDecisions: [],
    approvedContextRequestContributions: [],
    requestableRefs: [],
    sections: [{
      id: "project",
      title: "Current Project",
      module: "project",
      priority: "critical",
      charCount: 120,
      budgetUsed: 120,
      truncated: false,
      sourceRefs: [],
      items: [{
        id: "project-lp15-c2",
        title: "C2 Project",
        summary: "Deterministic Quick Analysis contract fixture.",
        module: "project",
        entityType: "project",
        sourceRefs: [],
        priority: "critical",
        charCount: 120,
        sendable: true,
        truncated: false
      }]
    }],
    sourceRefs: [],
    warnings: [],
    excluded: [],
    reviewFingerprint: "review-lp15-c2",
    budget: {
      maxChars: 20_000,
      reservedForUserQuestion: 0,
      reservedForSystemInstruction: 0,
      strategy: "balanced"
    },
    budgetSummary: {
      maxChars: 20_000,
      usedChars: 120,
      remainingChars: 19_880,
      truncatedSections: 0,
      truncatedItems: 0,
      excludedItems: 0,
      notes: []
    }
  };
}

function buildQuickProviderPackage(descriptor, rawContent) {
  const userQuestion = subject.buildQuickAnalysisGenerationInput(rawContent, descriptor);
  const promptPackage = subject.buildAIPromptPackage(
    quickContextPackage(),
    userQuestion,
    {
      constraintDescriptor: subject.resolveAIQuickConstraintDescriptor({
        ownerType: descriptor.ownerType,
        channel: descriptor.channel
      }),
      technicalCapacityChars: 20_000,
      includeSourceRefs: false,
      includeWarnings: true,
      conversationMessages: [],
      maxConversationHistoryChars: 4_000,
      maxConversationHistoryMessages: 12,
      outputDetailPreference: "STANDARD",
      runScopedDirective: "Generate the body once from the frozen Quick Analysis source."
    }
  );
  return { userQuestion, promptPackage };
}

const PARSE_PROJECT_ID = "project-lp15-c4";
const PARSE_CONVERSATION_ID = "conversation-lp15-c4";
const PARSE_NOW = "2026-09-04T12:00:00.000Z";

function parseResearchObject(objectType, objectId, options = {}) {
  const module = objectType === "review"
    ? "review"
    : objectType === "literature"
      ? "literature"
      : "experiment";
  return {
    objectType,
    objectId,
    projectId: PARSE_PROJECT_ID,
    label: `${objectType} ${objectId}`,
    sourceRef: {
      module,
      entityType: objectType,
      entityId: objectId,
      label: `${objectType} ${objectId}`,
      field: "identity",
      sourceKind: "userAuthored",
      isUserAuthored: true,
      isAiGenerated: false,
      isVerified: true
    },
    safeMetadata: options.safeMetadata ?? {},
    ownerModule: module,
    channel: "global_chat"
  };
}

function primaryContextRef(object) {
  return {
    ...object.sourceRef,
    contextMode: "BRIEF",
    contextLevel: 1,
    contextRole: "primary",
    contextDisposition: "included"
  };
}

function parseContextPackage(researchObjects) {
  const literature = researchObjects.find((object) => object.objectType === "literature");
  const sourceRefs = researchObjects.map(primaryContextRef);
  if (literature) {
    sourceRefs.push({
      module: "literature",
      entityType: "literature",
      entityId: literature.objectId,
      label: literature.label,
      field: "canonical Literature Project association",
      sourceKind: "userAuthored",
      contextMode: "BRIEF",
      contextLevel: 1,
      contextRole: "primary",
      contextDisposition: "included",
      literatureProjectAssociationKind: "assigned",
      literatureCanonicalProjectId: PARSE_PROJECT_ID,
      literatureLifecycleEligibility: "eligible",
      literatureConversationProjectEligibilityDisposition: "allowed_same_project",
      literatureSelectionOrder: 0,
      literatureNormalizedProjectionFingerprint: "lp15-c4-literature-projection",
      literatureSelectionAggregateEligibility: "ALLOWED"
    });
  }
  return {
    id: "context-lp15-c4",
    version: "ai-lp15-c4-v1",
    createdAt: PARSE_NOW,
    scope: { type: "project", id: PARSE_PROJECT_ID, label: "LP15-C4 Project" },
    contextMode: "BRIEF",
    compositionPolicy: "DEFAULT",
    researchObjects,
    materialDecisions: [],
    approvedContextRequestContributions: [],
    requestableRefs: [],
    sections: [{
      id: "project",
      title: "Current Project",
      module: "project",
      priority: "critical",
      charCount: 120,
      budgetUsed: 120,
      truncated: false,
      sourceRefs: [],
      items: [{
        id: PARSE_PROJECT_ID,
        title: "LP15-C4 Project",
        summary: "Representative CREATE and UPDATE guidance fixture.",
        module: "project",
        entityType: "project",
        sourceRefs: [],
        priority: "critical",
        charCount: 120,
        sendable: true,
        truncated: false
      }]
    }],
    sourceRefs,
    warnings: [],
    excluded: [],
    reviewFingerprint: "review-lp15-c4",
    budget: {
      maxChars: 20_000,
      reservedForUserQuestion: 0,
      reservedForSystemInstruction: 0,
      strategy: "balanced"
    },
    budgetSummary: {
      maxChars: 20_000,
      usedChars: 120,
      remainingChars: 19_880,
      truncatedSections: 0,
      truncatedItems: 0,
      excludedItems: 0,
      notes: []
    }
  };
}

function parseReadback() {
  const user = {
    id: "message-lp15-c4-user",
    conversationId: PARSE_CONVERSATION_ID,
    sequence: 1,
    role: "user",
    content: "创建一个新实验文稿，并更新当前阶段复盘和文献的客观纲要与专属笔记。",
    messageKind: "text",
    createdAt: PARSE_NOW
  };
  const assistant = {
    id: "message-lp15-c4-assistant",
    conversationId: PARSE_CONVERSATION_ID,
    sequence: 2,
    role: "assistant",
    content: "已形成对应建议，等待解析为 Standardized Operations 草稿。",
    messageKind: "text",
    createdAt: PARSE_NOW
  };
  return {
    conversation: {
      id: PARSE_CONVERSATION_ID,
      stableKey: "global-ai-chat/lp15-c4",
      createdAt: PARSE_NOW,
      updatedAt: PARSE_NOW
    },
    messages: [user, assistant],
    projectedMessages: [structuredClone(user), structuredClone(assistant)],
    callAttempts: [{
      id: "attempt-lp15-c4-chat",
      requestId: "attempt-lp15-c4-chat",
      conversationId: PARSE_CONVERSATION_ID,
      sequence: 1,
      purpose: "chat_response",
      triggerMessageId: user.id,
      resultMessageId: assistant.id,
      provider: "deepseek",
      model: "deepseek-v4-flash",
      status: "succeeded",
      contextPackageId: "context-lp15-c4-chat",
      contextPackageVersion: "1",
      contextSourceRefs: [],
      warnings: [],
      promptPackageId: "prompt-lp15-c4-chat",
      promptCreatedAt: PARSE_NOW,
      responseTruncated: false,
      startedAt: PARSE_NOW,
      settledAt: PARSE_NOW,
      authorizedFileRefs: []
    }],
    contextRequests: [],
    standardResults: [],
    retryRegenerate: {
      latestTurnId: user.id,
      effectiveAssistantMessageId: assistant.id,
      effectiveSourceAttemptId: "attempt-lp15-c4-chat",
      latestAttemptId: "attempt-lp15-c4-chat",
      latestAttemptStatus: "succeeded",
      retryEligible: false,
      regenerateEligible: true,
      attachmentReauthorizationRequired: false,
      activeConflict: false,
      safeIntegrityState: "ok"
    }
  };
}

test("F5-3 Archive identity uses exact V1 comment lines and separates content terminals", () => {
  const noneInputs = [
    "ordinary body",
    "<!-- labpod:outline:start -->\nold body\n<!-- labpod:outline:end -->",
    "<!-- LABPOD:STRUCTURED_OUTLINE_ARCHIVE_BEGIN_V1 typo -->",
    "<!-- nearby:comment -->"
  ];
  for (const raw of noneInputs) {
    const identity = subject.resolveStructuredOutlineArchiveIdentity(bytes(raw));
    assert.equal(identity.terminal, "NONE", raw);
    const parserInput = subject.resolveStructuredOutlineArchiveParserInput(bytes(raw));
    assert.equal(parserInput.parserProtocolTerminal, "EXECUTABLE");
    assert.equal(parserInput.archiveIdentityTerminal, "NONE");
    assert.equal(parserInput.useCanonicalEmptyOutline, true);
  }

  for (const newline of ["\n", "\r\n"]) {
    for (const hint of [undefined, "原文档结构化纲要", "hint changed freely"]) {
      const raw = `${begin(hint)}${newline}## 结构化内容${newline}Unicode 中文 😀${newline}${end()}`;
      const identity = subject.resolveStructuredOutlineArchiveIdentity(bytes(raw));
      assert.equal(identity.terminal, "UNIQUE");
      assert.equal(identity.exactBeginMarkerCount, 1);
      assert.equal(identity.exactEndMarkerCount, 1);
      assert.equal(identity.pair.endMarker.lineTerminator, "NONE");
      const parserInput = subject.resolveStructuredOutlineArchiveParserInput(bytes(raw));
      assert.equal(parserInput.parserProtocolTerminal, "EXECUTABLE");
      assert.equal(parserInput.archiveIdentityTerminal, "UNIQUE");
      assert.match(parserInput.canonicalParserInputRawMarkdown, /Unicode 中文 😀/u);
      assert.equal(parserInput.useCanonicalEmptyOutline, false);
    }
  }

  const pair = `${begin()}\ninside\n${end()}`;
  for (const raw of [
    `${pair}\n${pair}`,
    `${begin()}\ninside without end`,
    `${end()}\n${begin()}`,
    `${begin()}\n${end()}\n${end()}`
  ]) {
    const identity = subject.resolveStructuredOutlineArchiveIdentity(bytes(raw));
    assert.equal(identity.terminal, "MULTIPLE_OR_AMBIGUOUS", raw);
    const parserInput = subject.resolveStructuredOutlineArchiveParserInput(bytes(raw));
    assert.equal(parserInput.parserProtocolTerminal, "EXECUTABLE");
    assert.equal(parserInput.archiveIdentityTerminal, "MULTIPLE_OR_AMBIGUOUS");
    assert.equal(parserInput.useCanonicalEmptyOutline, true);
  }
});

test("F5-3 Archive parser technical failure is not NONE or ambiguity", () => {
  const prefix = bytes(`${begin()}\n`);
  const suffix = bytes(`\n${end()}`);
  const invalid = new Uint8Array(prefix.length + 1 + suffix.length);
  invalid.set(prefix, 0);
  invalid[prefix.length] = 0xff;
  invalid.set(suffix, prefix.length + 1);
  const identity = subject.resolveStructuredOutlineArchiveIdentity(invalid);
  assert.equal(identity.terminal, "UNIQUE");
  const parserInput = subject.resolveStructuredOutlineArchiveParserInput(invalid);
  assert.equal(parserInput.parserProtocolTerminal, "TECHNICAL_FAILURE");
  assert.equal(parserInput.archiveIdentityTerminal, "UNIQUE");
  assert.equal(
    parserInput.errorCode,
    "STRUCTURED_OUTLINE_ARCHIVE_INTERIOR_INVALID_UTF8"
  );
});

test("F5-3 canonical Archive serializer consumes the live descriptor registry", () => {
  const covered = [];
  for (const registration of subject.MANUSCRIPT_OUTLINE_DESCRIPTOR_REGISTRY) {
    const descriptor = registration.ownerType === "review"
      ? registration.descriptors.find((candidate) => candidate.reviewType === "stage")
      : registration.descriptors[0];
    assert.ok(descriptor);
    const values = Object.fromEntries(descriptor.fields.map((field) => [
      field.stableKey,
      `value-${field.stableKey}`
    ]));
    const archive = subject.serializeCanonicalStructuredOutlineArchive({
      descriptor,
      values,
      humanHint: `${registration.ownerType}/${registration.channel}`,
      lineEnding: "\n"
    });
    const parserInput = subject.resolveStructuredOutlineArchiveParserInput(bytes(archive));
    assert.equal(parserInput.parserProtocolTerminal, "EXECUTABLE");
    assert.equal(parserInput.archiveIdentityTerminal, "UNIQUE");
    const parsed = subject.parseCanonicalManuscriptSourceSpans({
      rawMarkdown: parserInput.canonicalParserInputRawMarkdown,
      descriptorLookupIdentity: {
        ownerType: registration.ownerType,
        channel: registration.channel,
        reviewType: descriptor.reviewType
      }
    });
    assert.equal(parsed.ok, true, `${registration.ownerType}/${registration.channel}`);
    let previous = -1;
    for (const field of descriptor.fields) {
      const marker = subject.manuscriptOutlineFieldMarker(field.stableKey);
      const position = parserInput.canonicalParserInputRawMarkdown.indexOf(marker);
      assert.ok(position > previous, `${registration.ownerType}/${field.stableKey}`);
      assert.match(
        parserInput.canonicalParserInputRawMarkdown,
        new RegExp(`value-${field.stableKey}`, "u")
      );
      previous = position;
    }
    covered.push(`${registration.ownerType}/${registration.channel}`);
  }
  assert.equal(covered.length, subject.MANUSCRIPT_OUTLINE_DESCRIPTOR_REGISTRY.length);
  assert.equal(new Set(covered).size, covered.length);
});

test("LP15-C2 Group B injects one exact target contract into the actual Quick Provider package", () => {
  const descriptor = subject.getManuscriptOutlineDescriptor({
    ownerType: "experiment",
    channel: "primary"
  });
  const expectedStableKeys = descriptor.fields.map((field) => field.stableKey);
  const { userQuestion, promptPackage } = buildQuickProviderPackage(
    descriptor,
    "C2 frozen raw sentinel without protocol markers."
  );

  assert.equal(promptPackage.userQuestion, userQuestion);
  assert.equal(promptPackage.providerPromptEnvelope.userQuestion, userQuestion);
  assert.equal(occurrenceCount(promptPackage.finalPrompt, begin()), 1);
  assert.equal(occurrenceCount(promptPackage.finalPrompt, end()), 1);
  assert.equal(occurrenceCount(userQuestion, begin()), 1);
  assert.equal(occurrenceCount(userQuestion, end()), 1);
  assert.equal(occurrenceCount(userQuestion, subject.MANUSCRIPT_OUTLINE_START_MARKER), 1);
  assert.equal(occurrenceCount(userQuestion, subject.MANUSCRIPT_OUTLINE_END_MARKER), 1);
  assert.deepEqual(representedStableKeys(userQuestion), expectedStableKeys);

  const sentinelValues = Object.fromEntries(descriptor.fields.map((field) => [
    field.stableKey,
    `C2 sentinel value for ${field.stableKey}`
  ]));
  const sentinelProviderBody = subject.serializeCanonicalStructuredOutlineArchive({
    descriptor,
    values: sentinelValues
  });
  const consumer = subject.buildCanonicalFormalSwitchArchiveCandidate({
    rawMarkdown: sentinelProviderBody,
    descriptorLookupIdentity: {
      ownerType: descriptor.ownerType,
      channel: descriptor.channel
    }
  });
  assert.equal(consumer.ok, true);
  assert.equal(consumer.archiveIdentityTerminal, "UNIQUE");
  assert.equal(consumer.parserProtocolTerminal, "EXECUTABLE");
  assert.equal(consumer.setFieldCount, expectedStableKeys.length);
  assert.equal(consumer.clearFieldCount, 0);
  assert.deepEqual(
    consumer.orderedReplacementDto.orderedReplacements.map((replacement) => ({
      stableKey: replacement.stableKey,
      value: replacement.action === "set" ? replacement.value : undefined
    })),
    expectedStableKeys.map((stableKey) => ({
      stableKey,
      value: sentinelValues[stableKey]
    }))
  );
});

test("LP15-C2 Group C keeps different owner/channel descriptors isolated", async () => {
  const representative = subject.getManuscriptOutlineDescriptor({
    ownerType: "experiment",
    channel: "primary"
  });
  const secondary = subject.getManuscriptOutlineDescriptor({
    ownerType: "literature",
    channel: "literature_outline"
  });
  const representativePackage = buildQuickProviderPackage(
    representative,
    "Representative source sentinel."
  ).promptPackage;
  const secondaryPackage = buildQuickProviderPackage(
    secondary,
    "Secondary source sentinel."
  ).promptPackage;
  const representativeKeys = representative.fields.map((field) => field.stableKey);
  const secondaryKeys = secondary.fields.map((field) => field.stableKey);

  assert.deepEqual(
    representedStableKeys(representativePackage.providerPromptEnvelope.userQuestion),
    representativeKeys
  );
  assert.deepEqual(
    representedStableKeys(secondaryPackage.providerPromptEnvelope.userQuestion),
    secondaryKeys
  );
  assert.equal(
    representativePackage.providerPromptEnvelope.userQuestion.includes("channel=literature_outline"),
    false
  );
  assert.equal(
    secondaryPackage.providerPromptEnvelope.userQuestion.includes("owner=experiment; channel=primary"),
    false
  );
  assert.equal(representativePackage.constraintDescriptor.constraintVersion, 3);
  assert.equal(secondaryPackage.constraintDescriptor.constraintVersion, 4);
  assert.throws(
    () => subject.getManuscriptOutlineDescriptor({ ownerType: "review", channel: "primary" }),
    /MANUSCRIPT_OUTLINE_DESCRIPTOR_NOT_FOUND/u
  );

  const coordinatorSource = await readFile(
    resolve(root, "src", "services", "quickAnalysisCoordinator.ts"),
    "utf8"
  );
  assert.equal(
    occurrenceCount(coordinatorSource, "buildQuickAnalysisGenerationInput("),
    1
  );
  assert.match(
    coordinatorSource,
    /buildQuickAnalysisGenerationInput\(\s*sourceSnapshot\.rawContent,\s*preflight\.manuscriptOutlineDescriptor\s*\)/u
  );
  assert.equal(
    occurrenceCount(coordinatorSource, "startDurableAIStreamingInvocation("),
    1
  );
});

test("LP15-C4 Group B injects bounded live descriptor guidance into the actual Parse package", async () => {
  const experiment = parseResearchObject("experiment", "experiment-lp15-c4");
  const review = parseResearchObject("review", "review-lp15-c4", {
    safeMetadata: { reviewType: "stage" }
  });
  const literature = parseResearchObject("literature", "literature-lp15-c4");
  const context = parseContextPackage([experiment, review, literature]);
  const built = await subject.buildAIParseDraftPromptPackage({
    conversationId: PARSE_CONVERSATION_ID,
    contextPackage: context,
    technicalCapacityChars: 45_000,
    readback: parseReadback(),
    outputDetailPreference: "STANDARD"
  });
  const envelope = built.promptPackage.providerPromptEnvelope;
  const expectedContract = subject.createAIStandardResultResponseContract();
  const dynamicSegments = envelope.parseDynamicContextBudget.runScopedDynamicSegments;
  const guidanceSegments = dynamicSegments.filter((segment) =>
    segment.startsWith("## Nested manuscript effect.body structure guidance")
  );

  assert.deepEqual(envelope.standardResultResponseContract, expectedContract);
  assert.equal(envelope.runScopedDirective, subject.PARSE_DRAFT_STANDARD_RESULT_ONLY_DIRECTIVE);
  assert.equal(guidanceSegments.length, 1);
  assert.equal(occurrenceCount(built.promptPackage.finalPrompt, "## Nested manuscript effect.body structure guidance"), 1);
  assert.equal(occurrenceCount(guidanceSegments[0], begin()), 4);
  assert.equal(occurrenceCount(guidanceSegments[0], end()), 4);
  for (const identity of [
    "owner=experiment; channel=primary",
    "owner=review; channel=primary; reviewType=stage",
    "owner=literature; channel=literature_outline",
    "owner=literature; channel=dedicated_notes"
  ]) {
    assert.equal(occurrenceCount(guidanceSegments[0], identity), 1, identity);
  }
  assert.equal(guidanceSegments[0].includes("reviewType=periodic"), false);
  assert.equal(occurrenceCount(guidanceSegments[0], "labpod:field=stage_summary"), 1);
  assert.equal(occurrenceCount(guidanceSegments[0], "labpod:field=period_summary"), 0);
  assert.equal(occurrenceCount(guidanceSegments[0], "labpod:field=research_problem"), 1);
  assert.equal(occurrenceCount(guidanceSegments[0], "labpod:field=project_relevance"), 1);
  assert.equal(
    envelope.standardResultResponseContract.resultItemContract.manuscriptEffects.exactEffectKeys.join(","),
    "channel,body"
  );

  const parseSource = await readFile(
    resolve(root, "src", "services", "aiParseDraftService.ts"),
    "utf8"
  );
  assert.equal(
    occurrenceCount(parseSource, "buildAIParseDraftStructuredManuscriptGuidance({"),
    1
  );
  assert.match(
    parseSource,
    /\.\.\.\(structuredManuscriptGuidance\.text \? \[structuredManuscriptGuidance\.text\] : \[\]\)/u
  );
});

test("LP15-C4 Group B preserves exact-target isolation and the generic residual path", () => {
  const experiment = parseResearchObject("experiment", "experiment-lp15-c4");
  const literature = parseResearchObject("literature", "literature-lp15-c4");
  const exact = subject.buildAIParseDraftStructuredManuscriptGuidance({
    researchObjects: [experiment, literature],
    quickAnalysisTarget: {
      ownerType: "literature",
      ownerId: literature.objectId,
      channel: "dedicated_notes",
      projectOrScopeId: PARSE_PROJECT_ID,
      sourceFileRefId: "file-lp15-c4",
      sourceDirectoryFileRefId: "folder-lp15-c4",
      whitelistFingerprint: "whitelist-lp15-c4"
    }
  });
  assert.equal(exact.mode, "EXACT_QUICK_TARGET");
  assert.deepEqual(exact.descriptorIdentities, [
    "owner=literature; channel=dedicated_notes"
  ]);
  assert.equal(occurrenceCount(exact.text, begin()), 1);
  assert.equal(exact.text.includes("owner=experiment"), false);
  assert.equal(exact.text.includes("channel=literature_outline"), false);

  const routeOnly = subject.buildAIParseDraftStructuredManuscriptGuidance({
    researchObjects: [{
      ...parseResearchObject("experiment", "temporary"),
      objectType: "route",
      objectId: "route-lp15-c4",
      sourceRef: {
        ...parseResearchObject("experiment", "temporary").sourceRef,
        module: "route",
        entityType: "route",
        entityId: "route-lp15-c4"
      },
      ownerModule: "route"
    }]
  });
  assert.equal(routeOnly.mode, "GENERIC_PATH");
  assert.equal(routeOnly.text, "");
  assert.deepEqual(routeOnly.descriptorIdentities, []);
  assert.equal(subject.AI_PARSE_DRAFT_STRUCTURED_MANUSCRIPT_GUIDANCE_MAX_VARIANTS, 4);
});

test("F5-3 marker demotion removes exact marker lines only for LF, CRLF, EOF and BOM", () => {
  const cases = [
    {
      raw: `body\n${begin("hint")}\n\ninside 中文\n\n${end()}`,
      expected: "body\n\ninside 中文\n\n"
    },
    {
      raw: `body\r\n${begin()}\r\n\r\ninside\r\n\r\n${end()}\r\ntail`,
      expected: "body\r\n\r\ninside\r\n\r\ntail"
    },
    {
      raw: `${begin()}\ninside\n${end()}\n${begin("two")}\nsecond\n${end()}`,
      expected: "inside\nsecond\n"
    }
  ];
  for (const fixture of cases) {
    const result = subject.demoteStructuredOutlineArchiveMarkers(bytes(fixture.raw));
    assert.equal(decoder.decode(result.resultBytes), fixture.expected);
    assert.equal(result.archiveInteriorMutationCount, 0);
    assert.equal(result.archiveOutsideBodyMutationCount, 0);
  }

  const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
  const body = bytes(`${begin()}\ninside😀\n${end()}`);
  const withBom = new Uint8Array(bom.length + body.length);
  withBom.set(bom, 0);
  withBom.set(body, bom.length);
  const demoted = subject.demoteStructuredOutlineArchiveMarkers(withBom);
  assert.deepEqual([...demoted.resultBytes.slice(0, 3)], [...bom]);
  assert.equal(decoder.decode(demoted.resultBytes.slice(3)), "inside😀\n");
});

test("F5-3 EOF append and settlement preserve every existing non-marker byte", () => {
  const descriptor = subject.MANUSCRIPT_OUTLINE_DESCRIPTOR_REGISTRY[0].descriptors[0];
  const archiveBytes = subject.serializeCanonicalStructuredOutlineArchiveBytes({
    descriptor,
    values: { purposeAndQuestion: "question" },
    lineEnding: "\r\n"
  });
  const existing = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes("body-no-newline")]);
  const appended = subject.appendStructuredOutlineArchiveAtEof({
    existingRawBytes: existing,
    archiveBytes
  });
  assert.deepEqual(
    [...appended.resultBytes.slice(0, existing.length)],
    [...existing]
  );
  assert.equal(decoder.decode(appended.separatorBytesAdded), "\r\n");
  assert.equal(appended.existingByteMutationCount, 0);
  assert.equal(
    subject.resolveStructuredOutlineArchiveIdentity(appended.resultBytes).terminal,
    "UNIQUE"
  );

  const bomOnly = new Uint8Array([0xef, 0xbb, 0xbf]);
  const appendedToBomOnly = subject.appendStructuredOutlineArchiveAtEof({
    existingRawBytes: bomOnly,
    archiveBytes
  });
  assert.deepEqual([...appendedToBomOnly.resultBytes.slice(0, 3)], [...bomOnly]);
  assert.equal(appendedToBomOnly.separatorBytesAdded.length, 0);
  assert.equal(appendedToBomOnly.appendedArchiveStartByte, 3);

  const old = bytes(`A\n${begin()}\nold interior\n${end()}\nB`);
  const settlement = subject.buildStructuredOutlineArchiveSettlementBytes({
    existingRawBytes: old,
    archiveBytes
  });
  const settledText = decoder.decode(settlement.resultBytes);
  assert.ok(settledText.startsWith("A\nold interior\nB\r\n"));
  assert.equal(
    subject.resolveStructuredOutlineArchiveIdentity(settlement.resultBytes).terminal,
    "UNIQUE"
  );
  assert.equal(settlement.demotion.archiveInteriorMutationCount, 0);
});
