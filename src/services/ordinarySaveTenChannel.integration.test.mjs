import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const bundle = await build({
  stdin: {
    contents: `
      export * from "./sharedManuscriptSessionRuntime.ts";
      export * from "./rawManuscriptGateway.ts";
      export * from "./ordinaryOperationPresentation.ts";
    `,
    resolveDir: directory,
    sourcefile: "ordinary-save-ten-channel-harness.ts"
  },
  plugins: [{
    name: "tauri-core-stub",
    setup(esbuild) {
      esbuild.onResolve(
        { filter: /^@tauri-apps\/api\/core$/u },
        () => ({ path: "tauri-core", namespace: "stub" })
      );
      esbuild.onLoad(
        { filter: /^tauri-core$/u, namespace: "stub" },
        () => ({ contents: "export async function invoke() { throw new Error('TAURI_NOT_USED'); }" })
      );
    }
  }],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  target: "es2022"
});
const subject = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

const channels = [
  ["experiment", "primary"],
  ["experiment_run", "primary"],
  ["literature", "literature_outline"],
  ["literature", "dedicated_notes"],
  ["review", "primary"],
  ["resultItem", "primary"],
  ["finding", "primary"],
  ["outputCandidate", "primary"],
  ["outputGap", "primary"],
  ["researchOutput", "primary"]
];

function admissionPort() {
  let sequence = 0;
  const proofs = new Map();
  return {
    async acquire(input) {
      sequence += 1;
      const proof = `proof-${sequence}`;
      proofs.set(proof, {
        logicalSessionKey: input.logicalSessionKey,
        fileRefId: input.target.fileRefId,
        path: input.target.expectedPathIdentity,
        references: 1
      });
      return {
        proof,
        generation: "e1-process",
        logicalSessionKey: input.logicalSessionKey,
        fileRefId: input.target.fileRefId,
        canonicalPathIdentity: input.target.expectedPathIdentity,
        referenceCount: 1,
        renewSequence: 0
      };
    },
    async retain(proof) {
      const value = proofs.get(proof);
      if (!value) throw new Error("PROOF_STALE");
      value.references += 1;
      return {
        proof,
        generation: "e1-process",
        logicalSessionKey: value.logicalSessionKey,
        fileRefId: value.fileRefId,
        canonicalPathIdentity: value.path,
        referenceCount: value.references,
        renewSequence: 0
      };
    },
    async validate(proof) {
      const value = proofs.get(proof);
      if (!value) throw new Error("PROOF_STALE");
      return {
        valid: true,
        generation: "e1-process",
        referenceCount: value.references,
        renewSequence: 0
      };
    },
    async renew(proof) { return this.validate(proof); },
    async release(proof) {
      const value = proofs.get(proof);
      if (!value) throw new Error("PROOF_STALE");
      value.references -= 1;
      if (value.references === 0) proofs.delete(proof);
      return {
        released: true,
        finalRelease: value.references === 0,
        referenceCount: value.references
      };
    },
    async detachWindow() { return { releasedCount: 0 }; }
  };
}

test("E1/C502 real Shared Runtime and Raw Gateway preserve no-op and changed-save settlement across ten channels", async () => {
  const counters = {
    gatewayRequest: 0,
    physicalReplace: 0,
    readback: 0,
    sessionFinalize: 0,
    projector: 0,
    bindingCurrentMutation: 0,
    formalFieldImport: 0
  };
  let id = 0;
  const nativePort = {
    async read(input) {
      return {
        status: "success",
        content: "same-content",
        fileName: input.expectedFileName,
        pathIdentity: input.expectedPathIdentity,
        revision: "revision-1",
        byteLength: 12,
        lineEnding: "none",
        encoding: "utf-8"
      };
    },
    async save(input) {
      counters.gatewayRequest += 1;
      counters.readback += 1;
      const writeApplied = input.content !== "same-content";
      if (writeApplied) counters.physicalReplace += 1;
      return {
        status: "success",
        content: input.content,
        fileName: input.expectedFileName,
        pathIdentity: input.expectedPathIdentity,
        revision: "revision-1",
        byteLength: new TextEncoder().encode(input.content).byteLength,
        lineEnding: "none",
        encoding: "utf-8",
        writeApplied
      };
    }
  };
  const gateway = subject.createRawManuscriptGateway({
    nativePort,
    createOperationId: () => `gateway-${++id}`
  });
  const runtime = subject.createSharedManuscriptSessionRuntime({
    gateway,
    admission: admissionPort(),
    createId: () => `runtime-${++id}`,
    now: () => "2026-08-08T00:00:00.000Z"
  });

  for (const [ownerType, channel] of channels) {
    const ownerId = `${ownerType}-${channel}`;
    const fileName = `${ownerId}.md`;
    const absolutePath = `C:\\e1\\${fileName}`;
    const pathIdentity = `c:/e1/${fileName}`;
    const opened = await runtime.open({
      owner: { ownerType, ownerId, channel },
      target: {
        file: {
          kind: "durable",
          fileRefId: `file-${ownerId}`,
          absolutePath,
          pathIdentity,
          fileName,
          locationMode: "managed",
          resourceKind: "file",
          fileRole: "manuscript",
          fileType: "markdown",
          configuredRoot: "C:\\e1"
        },
        readOnly: false
      },
      windowRole: "current",
      accessMode: "writable",
      consumerId: `consumer-${ownerId}`
    });
    assert.equal(opened.status, "success");
    const saved = await runtime.save(opened.data.handle);
    const presentation = subject.ordinarySavePresentation(
      saved,
      { ownerType, channel }
    );
    assert.equal(saved.status, "no-op");
    assert.equal(presentation.terminal.terminalClass, "SUCCESS_NO_OP");
    assert.equal(presentation.userMessageKey, "ordinary.save.noOp");
    assert.equal(presentation.primaryFeedbackOwner, "none");
    const session = runtime.getSession(opened.data.handle);
    assert.equal(session.activeOperation, undefined);
    assert.equal(session.dirty, false);
    counters.sessionFinalize += 1;
    runtime.updateDraft(opened.data.handle, "changed-content");
    assert.equal(runtime.getSession(opened.data.handle).dirty, true);
    const changed = await runtime.save(opened.data.handle);
    assert.equal(changed.status, "success");
    assert.equal(subject.ordinarySavePresentation(changed, { ownerType, channel }).primaryFeedbackOwner, "none");
    assert.equal(runtime.getSession(opened.data.handle).dirty, false);
    assert.equal(runtime.getSession(opened.data.handle).draftRawText, "changed-content");
  }

  assert.deepEqual(counters, {
    gatewayRequest: 20,
    physicalReplace: 10,
    readback: 20,
    sessionFinalize: 10,
    projector: 0,
    bindingCurrentMutation: 0,
    formalFieldImport: 0
  });
});

test("C502 ordinary save success/no-op is silent for every shared channel; actionable failures retain ownership", () => {
  for (const [ownerType, channel] of channels) {
    for (const status of ["success", "no-op"]) {
      const result = subject.ordinarySavePresentation({ status }, { ownerType, channel });
      assert.equal(result.primaryFeedbackOwner, "none");
      assert.equal(result.nextAction, "none");
    }
  }
  for (const [status, code, nextAction] of [
    ["conflict", "MANUSCRIPT_REVISION_CONFLICT", "reload"],
    ["permission-denied", "MANUSCRIPT_SESSION_READ_ONLY", "none"],
    ["missing-session", "MANUSCRIPT_SESSION_NOT_FOUND", "reopen"],
    ["error", "MANUSCRIPT_OPERATION_IN_PROGRESS", "wait"],
    ["unexpected-error", "MANUSCRIPT_UNEXPECTED_FAILURE", "retry"]
  ]) {
    const result = subject.ordinarySavePresentation({ status, error: { code } }, { ownerType: "experiment", channel: "primary" });
    assert.equal(result.primaryFeedbackOwner, "shared-editor-operation-controller");
    assert.equal(result.nextAction, nextAction);
  }
});
