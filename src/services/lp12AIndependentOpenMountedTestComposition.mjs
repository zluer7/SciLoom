import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const bundle = await build({
  stdin: {
    contents: `
      export * from "./independentManuscriptOpenProtocol.ts";
      export * from "./sharedManuscriptSessionRuntime.ts";
    `,
    resolveDir: directory,
    sourcefile: "lp12-a-mounted-real-composition.ts"
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  target: "es2022",
  plugins: [{
    name: "lp12-a-mounted-default-authorities",
    setup(esbuild) {
      esbuild.onResolve(
        { filter: /^\.\/(?:fileRefService|manuscriptBindingService)$/u },
        (args) => ({ path: args.path, namespace: "stub" })
      );
      esbuild.onLoad({ filter: /.*/u, namespace: "stub" }, (args) => ({
        contents: args.path.includes("fileRefService")
          ? "export const fileRefService = {};"
          : "export const manuscriptBindingService = {};"
      }));
    }
  }]
});
const real = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

let sequence = 0;
const nextId = () => `mounted-real-${++sequence}`;

function snapshot(rawText = "mounted real raw") {
  return {
    rawText,
    revision: `hash:${rawText}`,
    byteLength: new TextEncoder().encode(rawText).byteLength,
    encoding: "utf-8",
    newline: "lf",
    dominantNewline: "lf"
  };
}

function admissionAuthority() {
  const proofs = new Map();
  return {
    activeCount: () => proofs.size,
    port: {
      async acquire(input) {
        const proof = `proof:${nextId()}`;
        proofs.set(proof, {
          references: 1,
          logicalSessionKey: input.logicalSessionKey,
          fileRefId: input.target.fileRefId,
          path: input.target.expectedPathIdentity
        });
        return {
          proof,
          generation: "mounted-process",
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
          generation: "mounted-process",
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
          generation: "mounted-process",
          referenceCount: value.references,
          renewSequence: 0
        };
      },
      async renew(proof) {
        return this.validate(proof);
      },
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
      async detachWindow() {
        const releasedCount = proofs.size;
        proofs.clear();
        return { releasedCount };
      }
    }
  };
}

export function createRealMountedComposition(ownerType, channel, ownerId) {
  const absolutePath =
    `C:\\lp12-a-mounted\\${ownerType}-${channel}-${ownerId}.md`;
  const pathIdentityKey =
    `c:/lp12-a-mounted/${ownerType}-${channel}-${ownerId}.md`.toLowerCase();
  const fileRef = {
    id: `file:${ownerType}:${channel}:${ownerId}`,
    ownerType,
    ownerId,
    manuscriptChannel: channel,
    resourceKind: "file",
    fileRole: "manuscript",
    locationMode: "external",
    fileType: "markdown",
    path: absolutePath,
    pathIdentityKey,
    title: `${ownerType}-${channel}-${ownerId}.md`,
    source: "user",
    customFields: {},
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z",
    deletedAt: null
  };
  let selected = {
    absolutePath,
    pathIdentityKey,
    physicalIdentity: `physical:${ownerType}:${channel}:${ownerId}`,
    physicalRevision: "physical-revision-1",
    fileName: fileRef.title,
    locationMode: "external",
    byteLength: 16,
    encoding: "utf-8",
    newline: "lf"
  };
  const rows = [fileRef];
  const admission = admissionAuthority();
  let raw = snapshot();
  const runtime = real.createSharedManuscriptSessionRuntime({
    gateway: {
      async read() {
        return {
          operation: "read",
          status: "success",
          operationId: nextId(),
          data: structuredClone(raw)
        };
      },
      async save(input) {
        raw = snapshot(input.draftRawText);
        return {
          operation: "save",
          status: "success",
          operationId: nextId(),
          data: { snapshot: structuredClone(raw), physicalWrite: true }
        };
      }
    },
    admission: admission.port,
    createId: nextId,
    now: () => "2026-07-27T00:00:00.000Z"
  });
  const protocol = real.createIndependentManuscriptOpenProtocol({
    async listOwnerFileRefsIncludingDeleted() {
      return rows;
    },
    async getFileRef(id) {
      return rows.find((candidate) => candidate.id === id);
    },
    async getBinding() {
      return {};
    },
    async registerAndReadback(input) {
      const created = {
        ...fileRef,
        ...input,
        id: `file:${nextId()}`
      };
      rows.push(created);
      return {
        fileRef: created,
        state: "created",
        durableCommitConfirmed: true
      };
    },
    createId: nextId
  });
  const previewProvider = {
    async selectAndPreview() {
      return { status: "success", preview: selected };
    },
    async previewPath() {
      return { status: "success", preview: selected };
    },
    async revalidatePreview() {
      return { status: "success", preview: selected };
    }
  };
  function openInput(role, consumerId) {
    return {
      owner: { ownerType, ownerId, channel },
      target: {
        file: {
          kind: "durable",
          fileRefId: fileRef.id,
          absolutePath,
          pathIdentity: pathIdentityKey,
          fileName: fileRef.title,
          locationMode: "external",
          resourceKind: "file",
          fileRole: "manuscript",
          fileType: "markdown"
        },
        bindingRevision: "binding-1",
        lifecycleRevision: "active-1",
        readOnly: false
      },
      windowRole: role,
      accessMode: "writable",
      consumerId
    };
  }
  async function open(role, consumerId) {
    const result = await runtime.open(openInput(role, consumerId));
    if (result.status !== "success") return result;
    return {
      status: "success",
      sessionKey: result.data.handle,
      session: result.data.session,
      fileName: fileRef.title,
      fileRefId: fileRef.id
    };
  }
  const baseRawService = {
    getSession(handle) {
      return runtime.getSession(handle);
    },
    listSessions() {
      return runtime.listSessionConsumers();
    },
    updateDraft(handle, value) {
      const session = runtime.updateDraft(handle, value);
      return session
        ? { status: "success", sessionKey: handle, session }
        : { status: "error", error: { code: "UPDATE_FAILED" } };
    },
    async save(handle) {
      return runtime.save(handle, async (target) => ({ status: "valid", target }));
    },
    async reload(handle, ...args) {
      const decision = args.at(-1);
      return runtime.reload(
        handle,
        decision === "discard" ? "discard" : undefined
      );
    },
    async close(handle, ...args) {
      const decision = args.at(-1);
      return runtime.close(
        handle,
        decision === "discard" ? "discard" : undefined
      );
    }
  };
  const rawServices = {
    experimentCurrent: {
      ...baseRawService,
      async resolveCurrentDescriptor() {
        return {
          status: "success",
          currentFileRefId: fileRef.id,
          fileName: fileRef.title,
          locationMode: fileRef.locationMode,
          displayLabel: fileRef.title
        };
      },
      openCurrent: async (_id, consumerId) => open("current", consumerId),
      requestClose: baseRawService.close
    },
    experimentIndependent: {
      ...baseRawService,
      openRegistered: async (_id, _fileRefId, consumerId) =>
        open("independent", consumerId),
      requestClose: baseRawService.close,
      cancelOwner() {}
    },
    run: {
      ...baseRawService,
      openCurrent: async (_id, consumerId) => open("current", consumerId),
      openIndependent: async (_id, _fileRefId, consumerId) =>
        open("independent", consumerId)
    },
    review: {
      ...baseRawService,
      openCurrent: async (_id, consumerId) => open("current", consumerId),
      openIndependent: async (_id, _fileRefId, consumerId) =>
        open("independent", consumerId)
    },
    literature: {
      ...baseRawService,
      openCurrent: async (_id, _channel, consumerId) =>
        open("current", consumerId),
      openIndependent: async (_id, _channel, _fileRefId, consumerId) =>
        open("independent", consumerId),
      updateDraft(handle, _channel, _role, value) {
        return baseRawService.updateDraft(handle, value);
      },
      getSession(handle) {
        return runtime.getSession(handle);
      }
    },
    outputs: {
      ...baseRawService,
      openCurrent: async (_type, _id, consumerId) =>
        open("current", consumerId),
      openIndependent: async (_type, _id, _fileRefId, consumerId) =>
        open("independent", consumerId),
      updateDraft(handle, _type, _id, _role, value) {
        return baseRawService.updateDraft(handle, value);
      },
      getSession(handle) {
        return runtime.getSession(handle);
      }
    }
  };
  return {
    ownerType,
    channel,
    ownerId,
    fileRef,
    protocol,
    previewProvider,
    runtime,
    admission,
    rawServices,
    registerProtocolFileRef(candidate) {
      if (!rows.some((row) => row.id === candidate.id)) {
        rows.push(structuredClone(candidate));
      }
    },
    selectProtocolFileRef(fileRefId) {
      const candidate = rows.find((row) => row.id === fileRefId);
      if (!candidate) throw new Error("FILE_REF_NOT_FOUND");
      selected = {
        absolutePath: candidate.path,
        pathIdentityKey: candidate.pathIdentityKey,
        physicalIdentity: `physical:${candidate.id}`,
        physicalRevision: "physical-revision-1",
        fileName: candidate.title,
        locationMode: candidate.locationMode,
        byteLength: 16,
        encoding: "utf-8",
        newline: "lf"
      };
    },
    async cleanup() {
      for (const { handle } of runtime.listSessionConsumers()) {
        await runtime.close(handle, "discard");
      }
      return {
        sessions: runtime.listSessions().length,
        consumers: runtime.listSessionConsumers().length,
        admissions: admission.activeCount()
      };
    }
  };
}
