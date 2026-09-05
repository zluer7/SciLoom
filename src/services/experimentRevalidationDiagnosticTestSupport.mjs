import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const directory = path.dirname(fileURLToPath(import.meta.url));
const bundle = await build({
  stdin: {
    contents: `
      export * from "./experimentManuscriptSwitchService.ts";
      export * from "./experimentRevalidationDiagnostic.ts";
      export * from "./experimentCurrentRawManuscriptService.ts";
      export * from "./experimentIndependentRawManuscriptService.ts";
      export * from "./manuscriptIdentityResolver.ts";
      export * from "./rawManuscriptGateway.ts";
      export * from "./sharedManuscriptSessionRuntime.ts";
    `,
    resolveDir: directory,
    sourcefile: "experiment-revalidation-diagnostic-test-support.ts"
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
            "export async function invoke(){ throw new Error('not available in D1 isolated harness'); }"
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

export const production = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

function fnv1a64(bytes) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}

async function physicalSnapshot(input) {
  const bytes = await readFile(input.filePath);
  const metadata = await stat(input.filePath, { bigint: true });
  const physicalIdentity = process.platform === "win32"
    ? `windows-node-stat:${metadata.dev.toString(16)}:${metadata.ino.toString(16)}`
    : `unix:${metadata.dev.toString(16).padStart(16, "0")}:${metadata.ino.toString(16).padStart(16, "0")}`;
  const lastWriteTick = process.platform === "win32"
    ? metadata.mtimeNs.toString(16).padStart(16, "0")
    : `${(metadata.mtimeNs / 1_000_000_000n).toString(16).padStart(16, "0")}:${(metadata.mtimeNs % 1_000_000_000n).toString(16).padStart(8, "0")}`;
  const revision = [
    "manuscript-physical-v2",
    fnv1a64(new TextEncoder().encode(input.expectedPathIdentity)),
    physicalIdentity,
    bytes.byteLength.toString(16).padStart(16, "0"),
    lastWriteTick,
    fnv1a64(bytes)
  ].join(":");
  return {
    status: "success",
    content: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes),
    fileName: input.expectedFileName,
    pathIdentity: input.expectedPathIdentity,
    physicalIdentity,
    hash: fnv1a64(bytes),
    mtimeNs: metadata.mtimeNs.toString(),
    revision,
    byteLength: bytes.byteLength,
    lineEnding: "lf",
    encoding: "utf-8"
  };
}

function createNativePort() {
  const calls = { read: 0, save: 0, readsByPath: new Map(), savesByPath: new Map() };
  let hold;

  return {
    calls,
    holdNextRead(filePath) {
      if (hold) throw new Error("D1_HOLD_ALREADY_ACTIVE");
      let markStarted;
      let releaseRead;
      const started = new Promise((resolve) => {
        markStarted = resolve;
      });
      const released = new Promise((resolve) => {
        releaseRead = resolve;
      });
      hold = { filePath, markStarted, released };
      return {
        started,
        release() {
          releaseRead();
        }
      };
    },
    async read(input) {
      calls.read += 1;
      calls.readsByPath.set(
        input.filePath,
        (calls.readsByPath.get(input.filePath) ?? 0) + 1
      );
      if (hold?.filePath === input.filePath) {
        const current = hold;
        hold = undefined;
        current.markStarted();
        await current.released;
      }
      return physicalSnapshot(input);
    },
    async save(input) {
      calls.save += 1;
      calls.savesByPath.set(
        input.filePath,
        (calls.savesByPath.get(input.filePath) ?? 0) + 1
      );
      const before = await physicalSnapshot(input);
      if (before.revision !== input.expectedRevision) {
        return {
          status: "error",
          errorCode: "MANUSCRIPT_REVISION_CONFLICT",
          writeApplied: false
        };
      }
      if (before.content === input.content) {
        return { ...before, writeApplied: false };
      }
      await writeFile(input.filePath, input.content, "utf8");
      return { ...(await physicalSnapshot(input)), writeApplied: true };
    }
  };
}

function createAdmissionPort() {
  const grants = new Map();
  let id = 0;
  return {
    async acquire(input) {
      const proof = `d1-admission-${++id}`;
      const grant = {
        proof,
        generation: "d1-isolated-process",
        logicalSessionKey: input.logicalSessionKey,
        fileRefId: input.target.fileRefId,
        canonicalPathIdentity: input.target.expectedPathIdentity,
        referenceCount: 1,
        renewSequence: 0
      };
      grants.set(proof, grant);
      return structuredClone(grant);
    },
    async retain(proof) {
      const grant = grants.get(proof);
      grant.referenceCount += 1;
      return structuredClone(grant);
    },
    async validate(proof) {
      const grant = grants.get(proof);
      return {
        valid: Boolean(grant),
        generation: "d1-isolated-process",
        referenceCount: grant?.referenceCount ?? 0,
        renewSequence: grant?.renewSequence ?? 0
      };
    },
    async renew(proof) {
      return this.validate(proof);
    },
    async release(proof) {
      const grant = grants.get(proof);
      if (!grant) {
        return { released: false, finalRelease: false, referenceCount: 0 };
      }
      grant.referenceCount -= 1;
      if (grant.referenceCount === 0) grants.delete(proof);
      return {
        released: true,
        finalRelease: grant.referenceCount === 0,
        referenceCount: grant.referenceCount
      };
    },
    async detachWindow() {
      const releasedCount = grants.size;
      grants.clear();
      return { releasedCount };
    }
  };
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

export async function createRealFileDiagnosticFixture(
  root,
  { completeSwitch = false } = {}
) {
  const currentPath = path.join(root, "current.md");
  const targetPath = path.join(root, "target.md");
  const currentRaw = "# Current manuscript\n\ncurrent body\n";
  const targetRaw = "# Target manuscript\n\ntarget body\n";
  await Promise.all([
    writeFile(currentPath, currentRaw, "utf8"),
    writeFile(targetPath, targetRaw, "utf8")
  ]);

  const timestamp = "2026-08-08T00:00:00.000Z";
  const experiment = {
    id: "experiment-d1",
    projectId: "project-d1",
    title: "D1 experiment",
    rating: 5,
    tags: ["d1"],
    purposeAndQuestion: "existing purpose",
    conditionSummary: "existing condition",
    methodSummary: "existing method",
    resultSummary: "existing result",
    conclusionAndNextSteps: "existing conclusion",
    other: "existing other",
    createdAt: timestamp,
    updatedAt: timestamp
  };
  const project = {
    id: "project-d1",
    title: "D1 project",
    createdAt: timestamp,
    updatedAt: timestamp
  };
  const resolver = production.createManuscriptIdentityResolver();
  const pathIdentity = (absolutePath) =>
    resolver.resolveEphemeralFile({
      absolutePath,
      locationMode: "external"
    }).pathIdentity;
  const fileRef = (id, absolutePath) => ({
    id,
    ownerType: "experiment",
    ownerId: experiment.id,
    resourceKind: "file",
    fileRole: "manuscript",
    manuscriptChannel: "primary",
    locationMode: "external",
    path: absolutePath,
    pathIdentityKey: pathIdentity(absolutePath),
    title: path.basename(absolutePath),
    label: path.basename(absolutePath),
    note: "",
    source: "user",
    createdAt: timestamp,
    updatedAt: timestamp
  });
  const files = {
    current: fileRef("file-current-d1", currentPath),
    target: fileRef("file-target-d1", targetPath)
  };
  const binding = {
    id: "binding-d1",
    ownerType: "experiment",
    ownerId: experiment.id,
    manuscriptChannel: "primary",
    defaultFolderFileRefId: null,
    defaultManuscriptFileRefId: files.current.id,
    currentFileRefId: files.current.id,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  const fileMap = new Map(Object.values(files).map((item) => [item.id, item]));
  const nativePort = createNativePort();
  const runtime = production.createSharedManuscriptSessionRuntime({
    gateway: production.createRawManuscriptGateway({
      nativePort,
      identityResolver: resolver
    }),
    admission: createAdmissionPort(),
    identityResolver: resolver,
    now: () => timestamp,
    createId: (() => {
      let id = 0;
      return () => `d1-runtime-${++id}`;
    })()
  });
  const common = {
    getExperiment: async () => clone(experiment),
    getDeletedExperiment: async () => undefined,
    getBinding: async () => clone(binding),
    getFileRef: async (id) => clone(fileMap.get(id)),
    getManagedRoot: async () => ({ status: "unconfigured" }),
    identityResolver: resolver,
    runtime
  };
  const currentService = production.createExperimentCurrentRawManuscriptService({
    ...common,
    getProject: async () => clone(project),
    getDeletedFileRef: async () => undefined
  });
  const independentService = production.createExperimentIndependentRawManuscriptService({
    ...common,
    listOwnerFileRefs: async () => clone([...fileMap.values()]),
    selectTarget: async () => ({ status: "canceled" }),
    registerTarget: async () => ({ status: "error", code: "D1_NOT_USED" }),
    createPendingId: () => "d1-pending-not-used"
  });

  const currentOpened = await currentService.openCurrent(
    experiment.id,
    "d1-current-consumer"
  );
  if (currentOpened.status !== "success") {
    throw new Error(`D1_CURRENT_OPEN_FAILED:${currentOpened.status}`);
  }
  const targetOpened = await independentService.openRegistered(
    experiment.id,
    files.target.id,
    "d1-target-consumer"
  );
  if (targetOpened.status !== "success") {
    throw new Error(`D1_TARGET_OPEN_FAILED:${targetOpened.status}`);
  }

  const diagnostics = [];
  const logs = new Map();
  const recoveries = new Map();
  const calls = {
    commit: 0,
    recoveryPrepare: 0,
    writeback: 0,
    publish: 0,
    failureRecord: 0
  };
  let id = 0;
  const service = production.createExperimentManuscriptSwitchService({
    getExperiment: async () => clone(experiment),
    getProject: async () => clone(project),
    getBinding: async () => clone(binding),
    getFileRef: async (fileRefId) => clone(fileMap.get(fileRefId)),
    currentService,
    independentService,
    commitPort: {
      async commit(input) {
        calls.commit += 1;
        if (!completeSwitch) throw new Error("D1_UNEXPECTED_COMMIT");
        binding.currentFileRefId = input.targetFileRefId;
        binding.updatedAt = input.occurredAt;
        experiment.updatedAt = input.occurredAt;
        logs.set(input.operationId, {
          id: input.operationId,
          status: "success",
          module: "experiment",
          isRecoverable: false
        });
      },
      async readPostCommit() {
        throw new Error("D1_UNEXPECTED_POST_COMMIT_READ");
      }
    },
    recoveryPort: {
      async prepare(input) {
        calls.recoveryPrepare += 1;
        if (!completeSwitch) throw new Error("D1_UNEXPECTED_RECOVERY_PREPARE");
        recoveries.set(input.operationId, {
          input: clone(input),
          phase: "prepared",
          oldCurrentPostRevision: undefined,
          writebackVerificationResult: undefined
        });
      },
      async get(operationId) {
        const value = recoveries.get(operationId);
        return value ? clone({ ...value.input, ...value }) : undefined;
      },
      async getDetail(operationId) {
        const value = recoveries.get(operationId);
        if (!value) return undefined;
        return clone(value);
      },
      async list() {
        return [...recoveries.values()]
          .filter((value) => !["resolved", "cancelled_safe"].includes(value.phase))
          .map((value) => clone({ ...value.input, ...value }));
      },
      async discoverAll() {
        return [...recoveries.values()].map((value) => clone({ ...value.input, ...value }));
      },
      async updatePhase(input) {
        const value = recoveries.get(input.operationId);
        if (!value || value.phase !== input.expectedPhase) {
          throw new Error("D1_RECOVERY_PHASE_MISMATCH");
        }
        recoveries.set(input.operationId, {
          ...value,
          phase: input.nextPhase,
          oldCurrentPostRevision:
            input.oldCurrentPostRevision ?? value.oldCurrentPostRevision,
          writebackVerificationResult:
            input.writebackVerificationResult ?? value.writebackVerificationResult
        });
      },
      async postVerify(operationId) {
        const value = recoveries.get(operationId);
        const committed = Boolean(
          value &&
          binding.currentFileRefId === files.target.id &&
          logs.has(operationId)
        );
        return {
          status: committed ? "committed_exact" : "not_committed",
          operationId,
          phase: value?.phase ?? "prepared",
          operationLogCount: committed ? 1 : 0,
          databaseReadSource: "sqlite-direct-test-double",
          safeDiagnosticCode: committed ? "R1_COMMITTED_EXACT" : "R1_NOT_COMMITTED"
        };
      },
      async completeDatabase() {
        throw new Error("D1_UNEXPECTED_RECOVERY_COMPLETE");
      },
      async safeCancel(operationId) {
        const value = recoveries.get(operationId);
        if (!value) throw new Error("D1_RECOVERY_NOT_FOUND");
        recoveries.set(operationId, { ...value, phase: "cancelled_safe" });
      }
    },
    async writeback(handle, rawText) {
      calls.writeback += 1;
      if (!completeSwitch) throw new Error("D1_UNEXPECTED_WRITEBACK");
      const updated = currentService.updateDraft(handle, rawText);
      if (updated.status !== "success") return undefined;
      const saved = await currentService.save(handle);
      if (saved.status !== "success" && saved.status !== "no-op") {
        return undefined;
      }
      return currentService.getSession(handle);
    },
    acquire: () => () => undefined,
    now: () => timestamp,
    createId: (prefix) => `${prefix}-d1-${++id}`,
    publish: () => {
      calls.publish += 1;
    },
    async recordFailure(error, ownerId) {
      calls.failureRecord += 1;
      logs.set(error.operationId, {
        id: error.operationId,
        ownerId,
        status: "error",
        diagnosticDetailsWriteCount: error.diagnosticDetails ? 1 : 0,
        experimentRevalidation: clone(error.diagnosticDetails)
      });
    },
    captureRevalidationDiagnostic(evidence) {
      diagnostics.push(clone(evidence));
    }
  });

  return {
    root,
    currentPath,
    targetPath,
    currentRaw,
    targetRaw,
    experiment,
    project,
    files,
    binding,
    nativePort,
    runtime,
    currentService,
    independentService,
    currentHandle: currentOpened.sessionKey,
    targetHandle: targetOpened.sessionKey,
    service,
    diagnostics,
    logs,
    recoveries,
    calls,
    async preflight() {
      return service.preflight(experiment.id, targetOpened.sessionKey);
    },
    async digest(filePath) {
      return fnv1a64(await readFile(filePath));
    },
    async physical(filePath) {
      const file = filePath === currentPath ? files.current : files.target;
      return physicalSnapshot({
        filePath,
        expectedPathIdentity: file.pathIdentityKey,
        expectedFileName: path.basename(filePath)
      });
    },
    async beginHeldReload(handle, filePath) {
      const hold = nativePort.holdNextRead(filePath);
      const pending = runtime.reload(handle);
      await hold.started;
      return { pending, release: hold.release };
    }
  };
}
