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
      export * from "./manuscriptIdentityResolver.ts";
      export * from "../types/manuscriptOperation.ts";
      export * from "../types/sharedManuscriptSession.ts";
    `,
    resolveDir: directory,
    sourcefile: "shared-session-core-harness.ts"
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  target: "es2022"
});
const core = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

let sequence = 0;
function createId() {
  sequence += 1;
  return `id-${sequence}`;
}

const owner = {
  ownerType: "experiment",
  ownerId: "experiment-1",
  channel: "primary"
};

function durableFile(overrides = {}) {
  return {
    kind: "durable",
    fileRefId: "file-1",
    absolutePath: "C:\\workspace\\paper.md",
    pathIdentity: "c:/workspace/paper.md",
    fileName: "paper.md",
    locationMode: "managed",
    resourceKind: "file",
    fileRole: "manuscript",
    fileType: "markdown",
    configuredRoot: "C:\\workspace",
    ...overrides
  };
}

function ephemeralFile() {
  return {
    kind: "ephemeral",
    identityToken: "picker-1",
    absolutePath: "C:\\external\\paper.md",
    pathIdentity: "c:/external/paper.md",
    fileName: "paper.md",
    locationMode: "external",
    resourceKind: "file",
    fileRole: "manuscript",
    fileType: "markdown"
  };
}

function snapshot(rawText, sequenceNumber = 1) {
  return {
    rawText,
    revision: {
      byteLength: new TextEncoder().encode(rawText).byteLength,
      modifiedAtUnixMs: sequenceNumber,
      contentHash: `hash-${sequenceNumber}`
    },
    byteLength: new TextEncoder().encode(rawText).byteLength,
    encoding: "utf-8",
    newline: "lf",
    dominantNewline: "lf"
  };
}

function createGateway(initialRaw = "opened") {
  let current = snapshot(initialRaw);
  let saveGate;
  const calls = { read: 0, save: 0 };
  return {
    calls,
    setRaw(rawText) {
      current = snapshot(rawText, current.revision.modifiedAtUnixMs + 1);
    },
    delaySave() {
      saveGate = {};
      saveGate.promise = new Promise((resolve) => {
        saveGate.release = resolve;
      });
      return saveGate;
    },
    port: {
      async read() {
        calls.read += 1;
        return {
          operation: "read",
          status: "success",
          operationId: createId(),
          data: structuredClone(current)
        };
      },
      async save(input) {
        calls.save += 1;
        if (saveGate) {
          const gate = saveGate;
          saveGate = undefined;
          await gate.promise;
        }
        if (input.draftRawText === current.rawText) {
          return {
            operation: "save",
            status: "no-op",
            operationId: createId(),
            data: { snapshot: structuredClone(current), physicalWrite: false }
          };
        }
        current = snapshot(
          input.draftRawText,
          current.revision.modifiedAtUnixMs + 1
        );
        return {
          operation: "save",
          status: "success",
          operationId: createId(),
          data: { snapshot: structuredClone(current), physicalWrite: true }
        };
      }
    }
  };
}

function createAdmissionAuthority() {
  const targets = new Map();
  const proofs = new Map();
  const calls = {
    acquire: 0,
    retain: 0,
    validate: 0,
    release: 0,
    detach: 0
  };
  return {
    calls,
    port(caller) {
      return {
        async acquire(input) {
          calls.acquire += 1;
          const targetKey = `${input.target.fileRefId}:${input.target.expectedPathIdentity}`;
          if (targets.has(targetKey)) throw new Error("MANUSCRIPT_ADMISSION_TARGET_CONFLICT");
          const proof = `${caller}:proof:${calls.acquire}`;
          const record = {
            caller,
            proof,
            targetKey,
            logicalSessionKey: input.logicalSessionKey,
            referenceCount: 1
          };
          targets.set(targetKey, proof);
          proofs.set(proof, record);
          return {
            proof,
            generation: "process-1",
            logicalSessionKey: input.logicalSessionKey,
            fileRefId: input.target.fileRefId,
            canonicalPathIdentity: input.target.expectedPathIdentity,
            referenceCount: 1,
            renewSequence: 0
          };
        },
        async retain(proof) {
          calls.retain += 1;
          const record = proofs.get(proof);
          if (!record || record.caller !== caller) throw new Error("PROOF_STALE");
          record.referenceCount += 1;
          return {
            proof,
            generation: "process-1",
            logicalSessionKey: record.logicalSessionKey,
            fileRefId: record.targetKey.split(":")[0],
            canonicalPathIdentity: record.targetKey,
            referenceCount: record.referenceCount,
            renewSequence: 0
          };
        },
        async validate(proof) {
          calls.validate += 1;
          const record = proofs.get(proof);
          if (!record || record.caller !== caller) throw new Error("PROOF_STALE");
          return {
            valid: true,
            generation: "process-1",
            referenceCount: record.referenceCount,
            renewSequence: 0
          };
        },
        async renew(proof) {
          return this.validate(proof);
        },
        async release(proof) {
          calls.release += 1;
          const record = proofs.get(proof);
          if (!record || record.caller !== caller) throw new Error("PROOF_STALE");
          record.referenceCount -= 1;
          if (record.referenceCount === 0) {
            proofs.delete(proof);
            targets.delete(record.targetKey);
          }
          return {
            released: true,
            finalRelease: record.referenceCount === 0,
            referenceCount: record.referenceCount
          };
        },
        async detachWindow() {
          calls.detach += 1;
          let releasedCount = 0;
          for (const [proof, record] of [...proofs]) {
            if (record.caller === caller) {
              proofs.delete(proof);
              targets.delete(record.targetKey);
              releasedCount += 1;
            }
          }
          return { releasedCount };
        }
      };
    }
  };
}

function createRuntime(gateway, admission) {
  return core.createSharedManuscriptSessionRuntime({
    gateway: gateway.port,
    admission,
    createId,
    now: () => "2026-07-27T00:00:00.000Z"
  });
}

function writableInput(file = durableFile(), windowRole = "current") {
  return {
    owner,
    target: {
      file,
      expectedCurrentFileRefId: file.fileRefId,
      bindingRevision: "binding-1",
      lifecycleRevision: "owner-1",
      readOnly: false
    },
    windowRole,
    accessMode: "writable"
  };
}

test("logical identity uses owner, channel, role, and fileRef only", () => {
  const first = core.createSharedLogicalSessionKey(
    core.createSharedLogicalSessionIdentity(owner, durableFile(), "current")
  );
  const changedPath = core.createSharedLogicalSessionKey(
    core.createSharedLogicalSessionIdentity(
      owner,
      durableFile({
        absolutePath: "D:\\moved\\paper.md",
        pathIdentity: "d:/moved/paper.md"
      }),
      "current"
    )
  );
  const independent = core.createSharedLogicalSessionKey(
    core.createSharedLogicalSessionIdentity(owner, durableFile(), "independent")
  );
  assert.equal(first, changedPath);
  assert.notEqual(first, independent);
  assert.doesNotMatch(first, /workspace|paper\.md|binding-1/u);
});

test("same WebView duplicate consumers share canonical state and reference admission", async () => {
  const gateway = createGateway();
  const authority = createAdmissionAuthority();
  const runtime = createRuntime(gateway, authority.port("window-a"));
  const first = await runtime.open(writableInput());
  const second = await runtime.open(writableInput());
  assert.equal(first.status, "success");
  assert.equal(second.status, "success");
  assert.notEqual(first.data.handle, second.data.handle);
  assert.equal(first.data.session.sessionKey, second.data.session.sessionKey);
  assert.equal(runtime.listSessions().length, 1);
  assert.equal(runtime.listSessions()[0].consumerCount, 2);
  assert.equal(gateway.calls.read, 1);
  assert.equal(authority.calls.acquire, 1);
  assert.equal(authority.calls.retain, 1);
  await runtime.close(first.data.handle);
  assert.equal(runtime.listSessions()[0].consumerCount, 1);
  await runtime.close(second.data.handle);
  assert.equal(runtime.listSessions().length, 0);
});

test("two WebView runtimes reject the second writer before creating or reading state", async () => {
  const gatewayA = createGateway();
  const gatewayB = createGateway();
  const authority = createAdmissionAuthority();
  const runtimeA = createRuntime(gatewayA, authority.port("window-a"));
  const runtimeB = createRuntime(gatewayB, authority.port("window-b"));
  const first = await runtimeA.open(writableInput());
  const second = await runtimeB.open(writableInput());
  assert.equal(first.status, "success");
  assert.equal(second.status, "conflict");
  assert.equal(runtimeB.listSessions().length, 0);
  assert.equal(gatewayB.calls.read, 0);
});

test("save captures one Raw snapshot while later edits remain dirty", async () => {
  const gateway = createGateway("opened");
  const authority = createAdmissionAuthority();
  const runtime = createRuntime(gateway, authority.port("window-a"));
  const opened = await runtime.open(writableInput());
  runtime.updateDraft(opened.data.handle, "save-this");
  const gate = gateway.delaySave();
  const saving = runtime.save(opened.data.handle, async (target) => ({
    status: "valid",
    target
  }));
  await Promise.resolve();
  runtime.updateDraft(opened.data.handle, "newer-draft");
  gate.release();
  const saved = await saving;
  assert.equal(saved.status, "success");
  assert.equal(saved.data.baseline.rawText, "save-this");
  assert.equal(saved.data.draftRawText, "newer-draft");
  assert.equal(saved.data.dirty, true);
});

test("read-only picker sessions never receive admission and cannot edit or save", async () => {
  const gateway = createGateway();
  const authority = createAdmissionAuthority();
  const runtime = createRuntime(gateway, authority.port("window-a"));
  const opened = await runtime.open({
    owner,
    target: { file: ephemeralFile(), readOnly: true },
    windowRole: "independent",
    accessMode: "read-only"
  });
  assert.equal(opened.status, "success");
  assert.equal(authority.calls.acquire, 0);
  assert.equal(runtime.updateDraft(opened.data.handle, "blocked"), undefined);
  const saved = await runtime.save(opened.data.handle);
  assert.equal(saved.status, "error");
  assert.equal(saved.error.code, "MANUSCRIPT_SESSION_READ_ONLY");
});

test("discard rereads authoritative bytes and failed writes preserve the dirty draft", async () => {
  const gateway = createGateway("opened");
  const authority = createAdmissionAuthority();
  const runtime = createRuntime(gateway, authority.port("window-a"));
  const opened = await runtime.open(writableInput());
  runtime.updateDraft(opened.data.handle, "dirty");
  gateway.setRaw("disk-now");
  const discarded = await runtime.discard(opened.data.handle);
  assert.equal(discarded.status, "success");
  assert.equal(discarded.data.draftRawText, "disk-now");
  assert.equal(discarded.data.dirty, false);
});
