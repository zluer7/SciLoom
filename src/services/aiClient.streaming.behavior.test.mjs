import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..", "..");
const bundle = await build({
  stdin: {
    contents: 'export * from "./services/aiClient.ts";',
    resolveDir: resolve(root, "src"),
    sourcefile: "lp13-a1-b3-ai-client-stream-harness.ts"
  },
  plugins: [{
    name: "tauri-channel-runtime-stub",
    setup(api) {
      api.onResolve({ filter: /^@tauri-apps\/api\/core$/u }, () => ({
        path: "tauri-core",
        namespace: "stub"
      }));
      api.onLoad({ filter: /^tauri-core$/u, namespace: "stub" }, () => ({
        contents: `
          export class Channel {
            constructor(onmessage){ this.onmessage = onmessage; globalThis.__lp13B3Client.channel = this; }
          }
          export function invoke(command, args){ return globalThis.__lp13B3Client.invoke(command, args); }
        `
      }));
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

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function request(requestId = "attempt-client") {
  const constraintDescriptor = {
    category: "NORMAL_QA", lifecycle: "ACTIVE",
    constraintRef: "labpod.ai.constraint.normal_qa", constraintVersion: 1,
    sharedInvariantRef: "labpod.ai.constraint.shared_invariant", sharedInvariantVersion: 2,
    boundedPolicyRefs: ["labpod.ai.policy.normal_qa.presentation"]
  };
  return {
    promptEnvelope: {
      constraintDescriptor,
      constraintSegments: [
        { kind: "shared_invariant", ref: constraintDescriptor.sharedInvariantRef, version: 1, text: "shared" },
        { kind: "category_policy", category: "NORMAL_QA", ref: constraintDescriptor.constraintRef, version: 1, boundedPolicyRefs: constraintDescriptor.boundedPolicyRefs, text: "normal" }
      ],
      researchContext: "context",
      conversationHistory: [],
      userQuestion: "question",
      finalPromptHardBudget: 15000
    },
    expectedConfigurationRevision: 31,
    requestId,
    callAttemptId: requestId,
    conversationId: "conversation-client",
    triggerMessageId: "message-client"
  };
}

function event(requestValue, eventKind, eventSequence, fields = {}) {
  return {
    requestId: requestValue.requestId,
    callAttemptId: requestValue.callAttemptId,
    conversationId: requestValue.conversationId,
    triggerMessageId: requestValue.triggerMessageId,
    eventKind,
    eventSequence,
    ...fields
  };
}

function control() {
  const streamInvoke = deferred();
  const invocations = [];
  const value = {
    channel: undefined,
    invocations,
    streamInvoke,
    invoke(command, args) {
      invocations.push({ command, args });
      if (command === "stream_ai_text") return streamInvoke.promise;
      if (command === "cancel_ai_text_stream") {
        return Promise.resolve({
          requestId: args.requestId,
          callAttemptId: args.callAttemptId,
          status: "CANCEL_ACCEPTED"
        });
      }
      throw new Error(`unexpected command ${command}`);
    }
  };
  globalThis.__lp13B3Client = value;
  return value;
}

test("Channel fence accepts one ordered terminal and ignores invoke completion afterward", async () => {
  const c = control();
  const streamRequest = request();
  const observed = [];
  const transport = subject.startAITextStream(streamRequest, (value) => observed.push(value));
  c.channel.onmessage(event(streamRequest, "started", 0, {
    provider: "deepseek", model: "deepseek-v4-flash"
  }));
  c.channel.onmessage(event(streamRequest, "delta", 1, { text: "part" }));
  const completed = event(streamRequest, "completed", 2, {
    text: "complete",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    finishReason: "stop"
  });
  c.channel.onmessage(completed);
  c.streamInvoke.resolve();
  assert.equal(await transport.completion, completed);
  assert.equal(observed.length, 3);
  assert.equal(c.invocations[0].command, "stream_ai_text");
  assert.equal(c.invocations[0].args.onEvent, c.channel);
});

test("Tauri stream transport omits frontend-only requestable-ref metadata", async () => {
  const c = control();
  const streamRequest = request("attempt-provider-contract");
  const sourceReference = {
    refKind: "AI_RESEARCH_OBJECT",
    refId: "experiment-1",
    projectId: "project-1",
    label: "Experiment 1",
    entityType: "experiment",
    allowedContributionKinds: ["IDENTITY_METADATA"]
  };
  streamRequest.promptEnvelope.contextRequestResponseContract = {
    contract: "LABPOD_CONTEXT_REQUEST_V1",
    wrapperStart: "<labpod_context_request>",
    wrapperEnd: "</labpod_context_request>",
    requestableRefs: [sourceReference],
    alreadySuppliedRefs: [{
      refKind: "FILE_REF",
      refId: "file-supplied",
      projectId: "project-1",
      contributionKind: "BODY_CONTENT"
    }],
    contributionKinds: ["IDENTITY_METADATA", "BODY_CONTENT"]
  };

  const transport = subject.startAITextStream(streamRequest);
  const transportedReference = c.invocations[0].args.request
    .promptEnvelope.contextRequestResponseContract.requestableRefs[0];
  assert.deepEqual(transportedReference, {
    refKind: "AI_RESEARCH_OBJECT",
    refId: "experiment-1",
    projectId: "project-1",
    label: "Experiment 1",
    allowedContributionKinds: ["IDENTITY_METADATA"]
  });
  assert.equal("entityType" in transportedReference, false);
  assert.equal(sourceReference.entityType, "experiment");
  assert.deepEqual(
    c.invocations[0].args.request.promptEnvelope.contextRequestResponseContract.alreadySuppliedRefs,
    [{
      refKind: "FILE_REF",
      refId: "file-supplied",
      projectId: "project-1",
      contributionKind: "BODY_CONTENT"
    }]
  );

  c.channel.onmessage(event(streamRequest, "started", 0, {
    provider: "deepseek", model: "deepseek-v4-flash"
  }));
  const completed = event(streamRequest, "completed", 1, {
    text: "complete",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    finishReason: "stop"
  });
  c.channel.onmessage(completed);
  c.streamInvoke.resolve();
  assert.equal(await transport.completion, completed);
});

test("PARSE_DRAFT native JSON response format reaches the final IPC request unchanged", async () => {
  const c = control();
  const streamRequest = request("attempt-native-json");
  streamRequest.responseFormat = { type: "json_object" };
  const transport = subject.startAITextStream(streamRequest);
  assert.deepEqual(c.invocations[0].args.request.responseFormat, {
    type: "json_object"
  });
  c.channel.onmessage(event(streamRequest, "started", 0, {
    provider: "deepseek",
    model: "deepseek-v4-flash"
  }));
  c.channel.onmessage(event(streamRequest, "failed", 1, {
    errorCode: "invalid_request",
    errorMessage: "deterministic fixture terminal",
    errorRetryable: false
  }));
  c.streamInvoke.resolve();
  assert.equal((await transport.completion).eventKind, "failed");
});

test("identity or sequence violation rejects once and sends best-effort exact cancel", async () => {
  const c = control();
  const streamRequest = request("attempt-protocol");
  const transport = subject.startAITextStream(streamRequest);
  c.channel.onmessage(event(streamRequest, "started", 0, {
    provider: "deepseek", model: "deepseek-v4-flash"
  }));
  c.channel.onmessage(event(streamRequest, "delta", 2, { text: "out of order" }));
  await assert.rejects(
    transport.completion,
    (error) => error.code === "stream_protocol_error"
  );
  await Promise.resolve();
  const cancellation = c.invocations.find(
    (invocation) => invocation.command === "cancel_ai_text_stream"
  );
  assert.equal(cancellation.args.requestId, streamRequest.requestId);
  assert.equal(cancellation.args.callAttemptId, streamRequest.callAttemptId);
  c.streamInvoke.resolve();
});

test("invoke resolution without a verified terminal is classified as transport error", async () => {
  const c = control();
  const transport = subject.startAITextStream(request("attempt-closed"));
  c.streamInvoke.resolve();
  await assert.rejects(
    transport.completion,
    (error) => error.code === "transport_error"
  );
});

test("bounded material gate failure may be terminal before provider started", async () => {
  const c = control();
  const streamRequest = request("attempt-material-gate");
  const transport = subject.startAITextStream(streamRequest);
  const failed = event(streamRequest, "failed", 0, {
    errorCode: "material_encoding_unsupported",
    errorMessage: "Material is not valid UTF-8 text.",
    errorRetryable: false
  });
  c.channel.onmessage(failed);
  c.streamInvoke.resolve();
  assert.equal(await transport.completion, failed);
  assert.equal(c.invocations.filter((item) => item.command === "cancel_ai_text_stream").length, 0);
});

test("cancel command preserves canonical identity and exact status vocabulary", async () => {
  const c = control();
  const response = await subject.cancelAITextStream("attempt-cancel", "attempt-cancel");
  assert.equal(response.status, "CANCEL_ACCEPTED");
  assert.deepEqual(c.invocations[0], {
    command: "cancel_ai_text_stream",
    args: {
      requestId: "attempt-cancel",
      callAttemptId: "attempt-cancel"
    }
  });
});
