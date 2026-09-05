import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..", "..");
const bundle = await build({
  stdin: {
    contents: `
      export * from "./services/actionDraftConfirmApplicationService.ts";
      export * from "./services/actionDraftSourceTupleService.ts";
      export * from "./services/aiDraftParserService.ts";
      export * from "./services/aiDraftManagerService.ts";
    `,
    resolveDir: resolve(root, "src"),
    sourcefile: "lp13-a1-c2-confirm-service-harness.ts"
  },
  plugins: [{
    name: "c2-service-boundary-stubs",
    setup(api) {
      const stub = (filter, contents) => {
        api.onResolve({ filter }, (args) => ({ path: args.path, namespace: "stub" }));
        api.onLoad({ filter: /.*/u, namespace: "stub" }, (args) => (
          filter.test(args.path) ? { contents } : undefined
        ));
      };
      stub(/repositories\/aiConversationRepository$/u, `
        export const aiConversationRepository = {
          async readConversation(){ throw new Error("unexpected default read"); }
        };
      `);
      stub(/services\/planningService$/u, `
        export const planningService = {
          async getProjectById(){ return undefined; },
          async getReviewById(){ return undefined; },
          async getRouteNodeById(){ return undefined; },
          async getTaskById(){ return undefined; }
        };
      `);
      stub(/services\/experimentService$/u, 'export const experimentService = { async getExperimentById(){ return undefined; } };');
      stub(/services\/literatureService$/u, 'export const literatureService = { async getLiteratureById(){ return undefined; } };');
      stub(/services\/outputConversionService$/u, `
        export const outputConversionService = {
          async getResultItemById(){ return undefined; }, async getFindingById(){ return undefined; },
          async getOutputCandidateById(){ return undefined; }, async getOutputGapById(){ return undefined; }
        };
      `);
      for (const [name, exported] of [
        ["aiTaskDraftApplyAdapter", "applyAITaskDraft"],
        ["aiReviewDraftApplyAdapter", "applyAIReviewDraft"],
        ["aiOutputGapDraftApplyAdapter", "applyAIOutputGapDraft"],
        ["aiFindingDraftApplyAdapter", "applyAIFindingDraft"],
        ["aiOutputCandidateDraftApplyAdapter", "applyAIOutputCandidateDraft"],
        ["aiEntityLinkDraftApplyAdapter", "applyAIEntityLinkDraft"]
      ]) {
        stub(new RegExp(`services\\/${name}$`, "u"), `
          export async function ${exported}(){ throw new Error("unguarded adapter reached"); }
        `);
      }
    }
  }],
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  target: "es2022"
});
const harness = { exports: {} };
new Function("require", "module", "exports", bundle.outputFiles[0].text)(
  createRequire(import.meta.url),
  harness,
  harness.exports
);
const subject = harness.exports;

const NOW = "2026-08-14T12:00:00.000Z";

function deferred() {
  let resolvePromise;
  const promise = new Promise((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

function projectSourceRef(projectId = "project-a") {
  return {
    module: "project", entityType: "project", entityId: projectId,
    sourceKind: "userAuthored", isUserAuthored: true
  };
}

function canonicalReadback() {
  const conversation = {
    id: "conversation-a", stableKey: "global-ai-chat/conversation-a",
    createdAt: NOW, updatedAt: NOW
  };
  const user = {
    id: "user-a", conversationId: conversation.id, sequence: 1,
    role: "user", content: "question", createdAt: NOW
  };
  const assistant = {
    id: "assistant-a", conversationId: conversation.id, sequence: 2,
    role: "assistant", content: "same answer", createdAt: NOW
  };
  const chatAttempt = {
    id: "chat-attempt-a", requestId: "chat-attempt-a", conversationId: conversation.id,
    sequence: 1, purpose: "chat_response", triggerMessageId: user.id,
    resultMessageId: assistant.id, provider: "deepseek", model: "deepseek-chat",
    status: "succeeded", contextPackageId: "context-a", contextPackageVersion: "1",
    contextSourceRefs: [projectSourceRef()], warnings: [], promptPackageId: "prompt-a",
    promptCreatedAt: NOW, startedAt: NOW, settledAt: NOW, authorizedFileRefs: []
  };
  const draftAttempt = {
    id: "draft-attempt-a", requestId: "draft-attempt-a", conversationId: conversation.id,
    sequence: 2, purpose: "action_draft_generation", triggerMessageId: assistant.id,
    triggerCallAttemptId: chatAttempt.id, provider: "deepseek", model: "deepseek-chat",
    status: "succeeded", contextPackageId: "context-a", contextPackageVersion: "1",
    contextSourceRefs: [projectSourceRef()], warnings: [], promptPackageId: "draft-prompt-a",
    promptCreatedAt: NOW, startedAt: NOW, settledAt: NOW, authorizedFileRefs: []
  };
  return {
    conversation,
    messages: [user, assistant],
    projectedMessages: [user, assistant],
    callAttempts: [chatAttempt, draftAttempt],
    retryRegenerate: {
      latestTurnId: user.id,
      effectiveAssistantMessageId: assistant.id,
      effectiveSourceAttemptId: chatAttempt.id,
      latestAttemptId: chatAttempt.id,
      latestAttemptStatus: "succeeded",
      retryEligible: false,
      regenerateEligible: true,
      attachmentReauthorizationRequired: false,
      activeConflict: false,
      safeIntegrityState: "ok"
    }
  };
}

function tuple(overrides = {}) {
  return Object.freeze({
    conversationId: "conversation-a",
    canonicalBusinessScopeIdentity: Object.freeze({ scopeKind: "project", scopeId: "project-a" }),
    effectiveSourceAssistantMessageId: "assistant-a",
    sourceOrdinaryChatCallAttemptId: "chat-attempt-a",
    actionDraftGenerationCallAttemptId: "draft-attempt-a",
    ...overrides
  });
}

function snapshot(sourceTuple = tuple(), overrides = {}) {
  return {
    conversationId: sourceTuple.conversationId,
    scopeIdentity: sourceTuple.canonicalBusinessScopeIdentity,
    tupleKey: subject.actionDraftSourceTupleKey(sourceTuple),
    uiGeneration: 7,
    ...overrides
  };
}

function acceptedTaskDraft(overrides = {}) {
  return {
    draftInstanceId: "draft-instance-a",
    batchId: "batch-a",
    draftType: "task_create",
    capability: "supported",
    targetModule: "task",
    targetEntityType: "task",
    target: { module: "task", entityType: "task", label: "Scoped task" },
    title: "Scoped task",
    sourceRefs: [],
    proposedPayload: { projectId: "project-a", title: "Scoped task" },
    writePreview: { requiresUserConfirmation: true },
    handled: false,
    result: { reviewStatus: "accepted", applyStatus: "ready" },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

function durableGenerationResult(readback = canonicalReadback()) {
  const actionAttempt = readback.callAttempts.find((attempt) => (
    attempt.id === "draft-attempt-a"
  ));
  const assistant = readback.messages.find((message) => message.id === "assistant-a");
  return {
    response: { text: '{"draftType":"task_create"}', provider: "deepseek", model: "deepseek-chat" },
    conversation: readback.conversation,
    triggerMessage: assistant,
    callAttempt: actionAttempt,
    readback
  };
}

function fixture(options = {}) {
  const state = {
    readback: options.readback ?? canonicalReadback(),
    mounted: snapshot(),
    reads: 0,
    formalInvocations: [],
    feedback: []
  };
  const service = subject.createActionDraftConfirmApplicationService({
    async readConversation() {
      state.reads += 1;
      if (options.beforeReadReturn) await options.beforeReadReturn(state);
      return state.readback;
    },
    async getProjectById(projectId) {
      if (options.beforeProjectReturn) await options.beforeProjectReturn(state);
      return projectId === "project-a" ? { id: projectId } : undefined;
    },
    async getReviewById() { return undefined; },
    async resolveEntityProjectId() { return "project-a"; },
    publishFeedback(result) { state.feedback.push(result); },
    now: () => NOW,
    async formalApplyBoundary(context) {
      state.formalInvocations.push({
        scopeId: context.verifiedCanonicalBusinessScope.scopeId,
        payloadProjectId: context.validatedDraft.proposedPayload.projectId,
        draftInstanceId: context.validatedDraft.draftInstanceId
      });
      if (options.onFormalApply) return options.onFormalApply(context, state);
      return {
        success: true, result: "written", sourceDraftId: context.validatedDraft.draftInstanceId,
        createdEntity: { module: "task", entityType: "task", entityId: `task-${state.formalInvocations.length}` },
        appliedAt: NOW
      };
    }
  });
  function input(overrides = {}) {
    const sourceTuple = overrides.sourceTuple ?? tuple();
    const mountedSelectionSnapshot = overrides.mountedSelectionSnapshot ?? snapshot(sourceTuple);
    state.mounted = overrides.currentMountedSelection ?? mountedSelectionSnapshot;
    return {
      draft: overrides.draft ?? acceptedTaskDraft(),
      sourceTuple,
      mountedSelectionSnapshot,
      readCurrentMountedSelection: () => state.mounted,
      userConfirmedWrite: overrides.userConfirmedWrite ?? true
    };
  }
  return { service, state, input };
}

test("generation readback derives one frozen canonical source tuple from durable truth", async () => {
  const { service, state } = fixture();
  const envelope = await service.readGeneration(durableGenerationResult(state.readback));
  assert.deepEqual(envelope.sourceTuple, tuple());
  assert.equal(Object.isFrozen(envelope), true);
  assert.equal(Object.isFrozen(envelope.sourceTuple), true);
  assert.equal(Object.isFrozen(envelope.sourceTuple.canonicalBusinessScopeIdentity), true);
  assert.equal(state.reads, 1);
});

test("parser and manager preserve the same tuple reference and stable opaque DraftInstanceId", () => {
  const sourceTuple = tuple();
  const parsed = subject.parseAIActionDraftsFromText(JSON.stringify({ drafts: [
    { id: "llm-controlled", draftType: "task_create", proposedPayload: { projectId: "project-a", title: "A" } },
    { id: "llm-controlled", draftType: "task_create", proposedPayload: { projectId: "project-a", title: "A" } }
  ] }), { sourceTuple, now: NOW });
  assert.strictEqual(parsed.sourceTuple, sourceTuple);
  assert.equal(parsed.drafts.length, 2);
  assert.notEqual(parsed.drafts[0].draftInstanceId, parsed.drafts[1].draftInstanceId);
  assert.notEqual(parsed.drafts[0].draftInstanceId, "llm-controlled");
  const manager = subject.createAIActionDraftManager([parsed]);
  const draftInstanceId = parsed.drafts[0].draftInstanceId;
  manager.acceptDraft(draftInstanceId, NOW);
  manager.editDraft(draftInstanceId, { proposedPayload: { projectId: "project-b", title: "edited" } }, NOW);
  assert.equal(manager.getDraft(draftInstanceId).draftInstanceId, draftInstanceId);
  assert.strictEqual(manager.getBatch(parsed.id).sourceTuple, sourceTuple);
  const fallback = subject.parseAIActionDraftsFromText("not JSON", { sourceTuple, now: NOW });
  assert.strictEqual(fallback.sourceTuple, sourceTuple);
  assert.throws(
    () => subject.parseAIActionDraftsFromText("not JSON", { now: NOW }),
    /canonical source context is unavailable/u
  );
});

const staleCases = [
  {
    name: "N1 mounted Conversation mismatch",
    arrange(f) {
      const mounted = snapshot(tuple(), { conversationId: "conversation-b" });
      return f.input({ mountedSelectionSnapshot: mounted, currentMountedSelection: mounted });
    },
    errorCode: "action_draft_source_changed"
  },
  {
    name: "N2 mounted Project scope mismatch",
    arrange(f) {
      const mounted = snapshot(tuple(), {
        scopeIdentity: { scopeKind: "project", scopeId: "project-b" }
      });
      return f.input({ mountedSelectionSnapshot: mounted, currentMountedSelection: mounted });
    },
    errorCode: "action_draft_scope_changed"
  },
  {
    name: "N3 successful Regenerate supersedes the old effective source",
    arrange(f) {
      const regenerated = {
        id: "assistant-b", conversationId: "conversation-a", sequence: 3,
        role: "assistant", content: "same answer", createdAt: NOW
      };
      const regeneratedAttempt = {
        ...f.state.readback.callAttempts[0], id: "chat-attempt-b", requestId: "chat-attempt-b",
        sequence: 3, resultMessageId: regenerated.id
      };
      f.state.readback = {
        ...f.state.readback,
        messages: [...f.state.readback.messages, regenerated],
        projectedMessages: [f.state.readback.messages[0], regenerated],
        callAttempts: [...f.state.readback.callAttempts, regeneratedAttempt],
        retryRegenerate: {
          ...f.state.readback.retryRegenerate,
          effectiveAssistantMessageId: regenerated.id,
          effectiveSourceAttemptId: regeneratedAttempt.id,
          latestAttemptId: regeneratedAttempt.id
        }
      };
      return f.input();
    },
    errorCode: "action_draft_generation_not_valid"
  },
  {
    name: "N4 source ordinary Chat CallAttempt mismatch",
    arrange(f) {
      const sourceTuple = tuple({ sourceOrdinaryChatCallAttemptId: "chat-attempt-wrong" });
      return f.input({ sourceTuple });
    },
    errorCode: "action_draft_source_changed"
  },
  {
    name: "N5 action-draft generation CallAttempt mismatch",
    arrange(f) {
      const sourceTuple = tuple({ actionDraftGenerationCallAttemptId: "draft-attempt-wrong" });
      return f.input({ sourceTuple });
    },
    errorCode: "action_draft_generation_not_valid"
  }
];

for (const scenario of staleCases) {
  test(`${scenario.name} fails closed before the formal boundary`, async () => {
    const f = fixture();
    const result = await f.service.confirm(scenario.arrange(f));
    assert.equal(result.success, false);
    assert.equal(result.errorCode, scenario.errorCode);
    assert.equal(f.state.formalInvocations.length, 0);
  });
}

test("N6 missing explicit confirmation performs no canonical read or formal invocation", async () => {
  const f = fixture();
  const result = await f.service.confirm(f.input({ userConfirmedWrite: false }));
  assert.equal(result.errorCode, "action_draft_confirmation_required");
  assert.equal(f.state.reads, 0);
  assert.equal(f.state.formalInvocations.length, 0);
});

for (const mutation of [
  { name: "non-succeeded", patch: { status: "failed" } },
  { name: "wrong-purpose", patch: { purpose: "chat_response" } }
]) {
  test(`N5 ${mutation.name} generation attempt fails closed`, async () => {
    const readback = canonicalReadback();
    readback.callAttempts = readback.callAttempts.map((attempt) => (
      attempt.id === "draft-attempt-a" ? { ...attempt, ...mutation.patch } : attempt
    ));
    const f = fixture({ readback });
    const result = await f.service.confirm(f.input());
    assert.equal(result.errorCode, "action_draft_generation_not_valid");
    assert.equal(f.state.formalInvocations.length, 0);
  });
}

test("N7 duplicate confirm is one tuple-plus-DraftInstanceId operation; distinct items remain distinct", async () => {
  const formalGate = deferred();
  const f = fixture({
    async onFormalApply(context, state) {
      await formalGate.promise;
      return {
        success: true, result: "written", sourceDraftId: context.validatedDraft.draftInstanceId,
        createdEntity: { module: "task", entityType: "task", entityId: `task-${state.formalInvocations.length}` },
        appliedAt: NOW
      };
    }
  });
  const input = f.input();
  const first = f.service.confirm(input);
  const duplicate = f.service.confirm(input);
  assert.strictEqual(first, duplicate);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(f.state.formalInvocations.length, 1);
  formalGate.resolve();
  await Promise.all([first, duplicate]);
  const distinctDraft = acceptedTaskDraft({ draftInstanceId: "draft-instance-b" });
  await f.service.confirm(f.input({ draft: distinctDraft }));
  assert.equal(f.state.formalInvocations.length, 2);
});

test("N8 valid exact tuple reaches one existing formal boundary invocation", async () => {
  const f = fixture();
  const result = await f.service.confirm(f.input());
  assert.equal(result.success, true);
  assert.equal(f.state.reads, 1);
  assert.deepEqual(f.state.formalInvocations, [{
    scopeId: "project-a",
    payloadProjectId: "project-a",
    draftInstanceId: "draft-instance-a"
  }]);
});

test("verified context dispatches the existing Task adapter with canonical scope only", async () => {
  const readback = canonicalReadback();
  const adapterCalls = [];
  const service = subject.createActionDraftConfirmApplicationService({
    async readConversation() { return readback; },
    async getProjectById(projectId) { return projectId === "project-a" ? { id: projectId } : undefined; },
    async getReviewById() { return undefined; },
    async resolveEntityProjectId() { return "project-a"; },
    publishFeedback() {},
    now: () => NOW,
    async applyTaskDraft(input) {
      adapterCalls.push(input);
      return {
        success: true, result: "written", sourceDraftId: input.draft.draftInstanceId,
        createdEntity: { module: "task", entityType: "task", entityId: "task-a" },
        appliedAt: input.appliedAt
      };
    }
  });
  const sourceTuple = tuple();
  const mounted = snapshot(sourceTuple);
  const result = await service.confirm({
    draft: acceptedTaskDraft({
      proposedPayload: { projectId: "project-b", title: "Attempted redirect" }
    }),
    sourceTuple,
    mountedSelectionSnapshot: mounted,
    readCurrentMountedSelection: () => mounted,
    userConfirmedWrite: true
  });
  assert.equal(result.success, true);
  assert.equal(adapterCalls.length, 1);
  assert.equal(adapterCalls[0].draft.proposedPayload.projectId, "project-a");
});

test("N9 payload scope spoof is overwritten by verified canonical scope", async () => {
  const f = fixture();
  const spoofed = acceptedTaskDraft({
    proposedPayload: { projectId: "project-b", title: "Attempted redirect" }
  });
  const result = await f.service.confirm(f.input({ draft: spoofed }));
  assert.equal(result.success, true);
  assert.equal(f.state.formalInvocations[0].scopeId, "project-a");
  assert.equal(f.state.formalInvocations[0].payloadProjectId, "project-a");
  assert.equal(f.state.formalInvocations.filter((call) => call.scopeId === "project-b").length, 0);
});

test("N10a switch before authorization linearization yields zero formal invocation", async () => {
  const readGate = deferred();
  const f = fixture({ beforeReadReturn: () => readGate.promise });
  const operation = f.service.confirm(f.input());
  f.state.mounted = snapshot(tuple(), {
    scopeIdentity: { scopeKind: "project", scopeId: "project-b" },
    uiGeneration: 8
  });
  readGate.resolve();
  const result = await operation;
  assert.equal(result.errorCode, "action_draft_scope_changed");
  assert.equal(f.state.formalInvocations.length, 0);
});

test("N10b switch after linearization cannot redirect the one authorized invocation", async () => {
  const formalStarted = deferred();
  const formalGate = deferred();
  const f = fixture({
    async onFormalApply(context) {
      formalStarted.resolve();
      await formalGate.promise;
      return {
        success: true, result: "written", sourceDraftId: context.validatedDraft.draftInstanceId,
        createdEntity: { module: "task", entityType: "task", entityId: "task-a" },
        appliedAt: NOW
      };
    }
  });
  const operation = f.service.confirm(f.input());
  await formalStarted.promise;
  f.state.mounted = snapshot(tuple(), {
    scopeIdentity: { scopeKind: "project", scopeId: "project-b" },
    uiGeneration: 8
  });
  formalGate.resolve();
  const result = await operation;
  assert.equal(result.success, true);
  assert.equal(f.state.formalInvocations.length, 1);
  assert.equal(f.state.formalInvocations[0].scopeId, "project-a");
  assert.equal(f.state.formalInvocations.filter((call) => call.scopeId === "project-b").length, 0);
});
