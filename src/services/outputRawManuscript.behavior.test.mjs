import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const directory = path.dirname(fileURLToPath(import.meta.url));
const bundle = await build({
  stdin: {
    contents: `
      export * from "./outputRawManuscriptService.ts";
      export * from "./manuscriptIdentityResolver.ts";
    `,
    resolveDir: directory,
    sourcefile: "output-raw-manuscript-harness.ts"
  },
  plugins: [{
    name: "stub-tauri",
    setup(esbuild) {
      esbuild.onResolve(
        { filter: /^@tauri-apps\/api\/core$/u },
        () => ({ path: "tauri", namespace: "stub" })
      );
      esbuild.onLoad(
        { filter: /.*/u, namespace: "stub" },
        () => ({
          contents:
            "export async function invoke(){ throw new Error('not available'); }"
        })
      );
    }
  }],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  target: "es2022"
});
const contract = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

const owners = [
  "resultItem",
  "finding",
  "outputCandidate",
  "outputGap",
  "researchOutput"
];

function fixture(ownerType) {
  const ownerId = `${ownerType}-1`;
  const currentId = `${ownerType}-current`;
  const independentId = `${ownerType}-independent`;
  const sessions = new Map();
  const ownerState = {
    readOnly: false,
    deletedAt: undefined
  };
  const calls = { open: [], save: 0, reload: 0, close: 0 };
  const resolver = contract.createManuscriptIdentityResolver();
  const binding = {
    id: `binding-${ownerType}`,
    ownerType,
    ownerId,
    manuscriptChannel: "primary",
    currentFileRefId: currentId,
    schemaVersion: 1,
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z"
  };
  const fileRef = (id, locationMode = "managed") => ({
    id,
    ownerType,
    ownerId,
    manuscriptChannel: "primary",
    resourceKind: "file",
    fileRole: "manuscript",
    locationMode,
    fileType: "markdown",
    path: `C:\\LabPodData\\${id}.md`,
    pathIdentityKey: `C:\\LabPodData\\${id}.md`,
    title: `${id}.md`,
    source: "user",
    schemaVersion: 1,
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z"
  });
  const refs = new Map([
    [currentId, fileRef(currentId)],
    [independentId, fileRef(independentId, "external")]
  ]);
  const runtime = {
    async open(input) {
      calls.open.push(input);
      const handle = `handle-${input.windowRole}`;
      const session = {
        owner: input.owner,
        windowRole: input.windowRole,
        file: input.target.file,
        targetSnapshot: input.target,
        accessMode: "writable",
        dirty: false,
        sessionGeneration: 1
      };
      sessions.set(handle, session);
      return {
        status: "success",
        data: { handle, session }
      };
    },
    getSession(handle) {
      return sessions.get(handle);
    },
    updateDraft(handle, draftRawText) {
      const session = sessions.get(handle);
      if (!session) return undefined;
      Object.assign(session, { draftRawText, dirty: true });
      return session;
    },
    async save() {
      calls.save += 1;
      return { status: "success", data: {} };
    },
    async reload() {
      calls.reload += 1;
      return { status: "success", data: {} };
    },
    async close(handle) {
      calls.close += 1;
      sessions.delete(handle);
      return { status: "success", data: {} };
    },
    listSessionConsumers() {
      return [...sessions.entries()].map(([handle, session]) => ({
        handle,
        session
      }));
    },
    async closeCleanSessions() {
      return true;
    },
    requiresExternalWriteConfirmation(handle) {
      const session = sessions.get(handle);
      return Boolean(
        session?.windowRole === "independent" &&
        session.file.locationMode === "external" &&
        session.externalWriteConfirmedGeneration !== session.sessionGeneration
      );
    },
    confirmExternalWrite(handle, expectedSessionGeneration) {
      const session = sessions.get(handle);
      if (!session || session.sessionGeneration !== expectedSessionGeneration) {
        return false;
      }
      session.externalWriteConfirmedGeneration = expectedSessionGeneration;
      return true;
    }
  };
  const service = contract.createOutputRawManuscriptService({
    async getOwner(requestedType, requestedId) {
      assert.equal(requestedType, ownerType);
      assert.equal(requestedId, ownerId);
      return {
        ownerType,
        ownerId,
        entity: { id: ownerId, deletedAt: ownerState.deletedAt },
        readOnly: ownerState.readOnly,
        parentDeleted: false
      };
    },
    async getBinding() {
      return binding;
    },
    async getFileRef(id) {
      return refs.get(id);
    },
    async getDeletedFileRef() {
      return undefined;
    },
    async getManagedRoot() {
      return {
        status: "configured",
        managedRoot: "C:\\LabPodData"
      };
    },
    identityResolver: resolver,
    runtime
  });
  return {
    service,
    calls,
    ownerId,
    currentId,
    independentId,
    binding,
    refs,
    ownerState
  };
}

test("Outputs adapter rejects lifecycle and identity mismatches before Runtime admission", async () => {
  const deleted = fixture("resultItem");
  deleted.ownerState.readOnly = true;
  deleted.ownerState.deletedAt = "2026-07-27T01:00:00.000Z";
  const deletedResult = await deleted.service.openCurrent(
    "resultItem",
    deleted.ownerId
  );
  assert.equal(
    deletedResult.error.code,
    "OUTPUT_MANUSCRIPT_OWNER_DELETED"
  );
  assert.equal(deleted.calls.open.length, 0);

  const bindingMismatch = fixture("finding");
  bindingMismatch.binding.ownerId = "other-owner";
  const bindingResult = await bindingMismatch.service.openCurrent(
    "finding",
    bindingMismatch.ownerId
  );
  assert.equal(
    bindingResult.error.code,
    "OUTPUT_MANUSCRIPT_BINDING_INVALID"
  );
  assert.equal(bindingMismatch.calls.open.length, 0);

  const fileMismatch = fixture("outputCandidate");
  fileMismatch.refs.get(fileMismatch.currentId).fileRole = "attachment";
  const fileResult = await fileMismatch.service.openCurrent(
    "outputCandidate",
    fileMismatch.ownerId
  );
  assert.equal(
    fileResult.error.code,
    "OUTPUT_MANUSCRIPT_FILE_REF_INVALID"
  );
  assert.equal(fileMismatch.calls.open.length, 0);
});

test("Outputs adapter rejects a handle under the wrong ordinary role", async () => {
  const current = fixture("outputGap");
  const opened = await current.service.openCurrent(
    "outputGap",
    current.ownerId
  );
  assert.equal(opened.status, "success");
  const mismatched = current.service.updateDraft(
    opened.sessionKey,
    "outputGap",
    current.ownerId,
    "independent",
    "draft"
  );
  assert.equal(
    mismatched.error.code,
    "OUTPUT_MANUSCRIPT_SESSION_ROLE_MISMATCH"
  );
});

for (const ownerType of owners) {
  test(`${ownerType} current and independent roles remain isolated`, async () => {
    const { service, calls, ownerId, currentId, independentId } =
      fixture(ownerType);
    const current = await service.openCurrent(ownerType, ownerId);
    const independent = await service.openIndependent(
      ownerType,
      ownerId,
      independentId
    );
    assert.equal(current.status, "success", JSON.stringify(current));
    assert.equal(
      independent.status,
      "success",
      JSON.stringify(independent)
    );
    assert.equal(calls.open.length, 2);
    assert.equal(calls.open[0].windowRole, "current");
    assert.equal(calls.open[0].target.file.fileRefId, currentId);
    assert.equal(calls.open[1].windowRole, "independent");
    assert.equal(calls.open[1].target.file.fileRefId, independentId);
    assert.equal(calls.open[0].owner.ownerType, ownerType);
    assert.equal(calls.open[0].owner.channel, "primary");

    const blocked = await service.save(
      independent.sessionKey,
      ownerType,
      ownerId,
      "independent"
    );
    assert.equal(
      blocked.error.code,
      "OUTPUT_MANUSCRIPT_EXTERNAL_WRITE_CONFIRMATION_REQUIRED"
    );
    assert.equal(calls.save, 0);
    const saved = await service.save(
      independent.sessionKey,
      ownerType,
      ownerId,
      "independent",
      { confirmedExternalWrite: true }
    );
    assert.equal(saved.status, "success");
    assert.equal(calls.save, 1);
  });
}
