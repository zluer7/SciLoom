import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

globalThis.crypto ??= webcrypto;

const directory = path.dirname(fileURLToPath(import.meta.url));
const bundle = await build({
  stdin: {
    contents: `
      export {
        createSharedManuscriptSaveAsCoreComposition
      } from "./sharedManuscriptSaveAsCoreComposition.ts";
      export {
        createExperimentManuscriptSaveAsAdapter
      } from "./experimentManuscriptSaveAsAdapter.ts";
      export {
        createExperimentRunManuscriptSaveAsAdapter
      } from "./experimentRunManuscriptSaveAsAdapter.ts";
      export {
        createReviewManuscriptSaveAsAdapter
      } from "./reviewManuscriptSaveAsAdapter.ts";
      export {
        createReviewManuscriptSaveAsPresentationAdapter
      } from "./reviewManuscriptSaveAsPresentationAdapter.ts";
      export {
        createLiteratureManuscriptSaveAsAdapter
      } from "./literatureManuscriptSaveAsAdapter.ts";
      export {
        createLiteratureManuscriptSaveAsPresentationAdapter
      } from "./literatureManuscriptSaveAsPresentationAdapter.ts";
      export {
        createOutputManuscriptSaveAsAdapter
      } from "./outputManuscriptSaveAsAdapter.ts";
      export {
        getOutputManuscriptStaticDescriptor
      } from "./outputManuscriptDescriptorService.ts";
      export {
        createManuscriptSaveAsLifecycleRegistry
      } from "./manuscriptSaveAsLifecycleRegistry.ts";
      export {
        createManuscriptSaveAsProductionRecoveryComposition
      } from "./manuscriptSaveAsProductionRecoveryComposition.ts";
    `,
    resolveDir: directory,
    sourcefile: "lp12-3-b-ip-2-r1-mounted-save-as.ts"
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  target: "es2022"
});
const real = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

async function sha256(rawText) {
  return Buffer.from(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(rawText)
    )
  ).toString("hex");
}

function createOperationAuthority(
  effects,
  onMarkReconcilable = () => {}
) {
  const records = new Map();
  const asciiCompare = (left, right) =>
    left === right ? 0 : left < right ? -1 : 1;
  function applyMutation(current, mutation) {
    const next = structuredClone(current);
    const stageOnly = {
      enter_r3_activation_pending: "r3_activation_pending",
      enter_p4_presentation_pending: "p4_presentation_pending"
    };
    if (stageOnly[mutation.intent]) {
      next.stage = stageOnly[mutation.intent];
      return next;
    }
    switch (mutation.intent) {
      case "enter_d2_commit_unknown":
        return Object.assign(next, {
          stage: "d2_commit_unknown",
          d2CommitState: "unknown",
          reconciliationState: "pending",
          blockingCode: undefined
        });
      case "confirm_d1":
        return Object.assign(next, {
          stage: "d1_confirmed",
          d1CommitState: "confirmed",
          reconciliationState: "resolved",
          d1PhysicalIdentityHash: mutation.d1PhysicalIdentityHash,
          d1ReadbackSha256: mutation.d1ReadbackSha256,
          d1ReadbackRevision: mutation.d1ReadbackRevision,
          d1ByteLength: mutation.d1ByteLength,
          d1ProofGeneration: mutation.d1ProofGeneration
        });
      case "close_pre_d1":
        return Object.assign(next, {
          stage: "pre_d1_closed",
          blockingCode: mutation.blockingCode,
          terminalAt: next.updatedAt
        });
      case "block_reconciliation":
        return Object.assign(next, {
          stage: "reconciliation_blocked",
          reconciliationState: "blocked",
          blockingCode: mutation.blockingCode,
          d1CommitState:
            current.stage === "d1_commit_unknown" ? "blocked" : current.d1CommitState,
          d2CommitState:
            current.stage === "d2_commit_unknown" ? "blocked" : current.d2CommitState,
          terminalAt: next.updatedAt
        });
      default:
        throw new Error(`unsupported mutation ${mutation.intent}`);
    }
  }
  return {
    async create(proposed) {
      effects.j0 += 1;
      assert.equal(records.has(proposed.operationId), false);
      const record = structuredClone(proposed);
      records.set(record.operationId, record);
      return structuredClone(record);
    },
    async transition(input) {
      effects.j0 += 1;
      const previous = records.get(input.operationId);
      assert.ok(previous);
      assert.equal(input.expected.revision, previous.revision);
      assert.equal(input.expected.stage, previous.stage);
      const record = {
        ...applyMutation(previous, input.mutation),
        revision: previous.revision + 1
      };
      records.set(record.operationId, record);
      return structuredClone(record);
    },
    async readback(operationId) {
      const record = records.get(operationId);
      return record ? structuredClone(record) : null;
    },
    async listReconcilable() {
      return [...records.values()]
        .filter((record) =>
          ["pending", "claimed"].includes(record.reconciliationState)
        )
        .sort(
          (left, right) =>
            asciiCompare(left.updatedAt, right.updatedAt) ||
            asciiCompare(left.operationId, right.operationId)
        )
        .map((record) => structuredClone(record));
    },
    async claimObservation(input) {
      const current = records.get(input.operationId);
      assert.ok(current);
      assert.equal(input.expected.revision, current.revision);
      const record = {
        ...current,
        revision: current.revision + 1,
        claimToken: `observation-${input.observationGeneration}`,
        claimRevision: current.revision + 1,
        claimProcessGeneration: "isolated-process",
        observationGeneration: input.observationGeneration,
        observationRevision: current.revision,
        reconciliationState: "claimed"
      };
      records.set(record.operationId, record);
      return structuredClone(record);
    },
    replace(record) {
      records.set(record.operationId, structuredClone(record));
    },
    markReconcilable(operationId, updatedAt) {
      const current = records.get(operationId);
      assert.ok(current);
      onMarkReconcilable(operationId);
      const record = {
        ...current,
        revision: current.revision + 1,
        stage: "d2_confirmed",
        reconciliationState: "pending",
        blockingCode: undefined,
        claimToken: undefined,
        claimRevision: undefined,
        claimProcessGeneration: undefined,
        observationGeneration: undefined,
        observationRevision: undefined,
        terminalAt: undefined,
        updatedAt
      };
      records.set(operationId, record);
      return structuredClone(record);
    },
    snapshot() {
      return [...records.values()].map((record) =>
        structuredClone(record)
      );
    }
  };
}

function createHandoffAuthority() {
  const receipts = new Map();
  return {
    async issueSaveAsHandoff(proof, readbackText) {
      receipts.set(proof.singleUseToken, {
        proof: structuredClone(proof),
        readbackText
      });
      return proof;
    },
    async consumeSaveAsHandoff(token) {
      const receipt = receipts.get(token);
      if (!receipt) throw new Error("SAVE_AS_HANDOFF_ALREADY_CONSUMED");
      receipts.delete(token);
      return receipt;
    },
    get activeCount() {
      return receipts.size;
    }
  };
}

function createFileRefAuthority(effects) {
  const fileRefs = new Map();
  let sequence = 0;
  return {
    async registerAndReadbackFileRef(input) {
      effects.fileRef += 1;
      effects.d2 += 1;
      const existing = fileRefs.get(
        input.pathIdentityKey
      );
      if (existing) {
        return {
          fileRef: structuredClone(existing),
          state: "existing",
          durableCommitConfirmed: true
        };
      }
      const id = `isolated-file-${++sequence}`;
      const fileRef = {
        id,
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        manuscriptChannel: input.manuscriptChannel,
        resourceKind: "file",
        fileRole: "manuscript",
        locationMode: input.locationMode,
        fileType: "markdown",
        path: input.path,
        pathIdentityKey: input.pathIdentityKey,
        title: input.path.replace(/^.*[\\/]/u, ""),
        schemaVersion: 8,
        source: "system",
        customFields: [],
        createdAt: "2026-07-29T00:00:00.000Z",
        updatedAt: "2026-07-29T00:00:00.000Z"
      };
      fileRefs.set(input.pathIdentityKey, fileRef);
      return {
        fileRef: structuredClone(fileRef),
        state: "created",
        durableCommitConfirmed: true
      };
    },
    async getFileRefByIdentity(input) {
      const identity =
        typeof input === "string" ? input : input.pathIdentityKey;
      const fileRef = fileRefs.get(identity);
      return fileRef ? structuredClone(fileRef) : undefined;
    },
    async getFileRefById(id) {
      const fileRef = [...fileRefs.values()].find(
        (candidate) => candidate.id === id
      );
      return fileRef ? structuredClone(fileRef) : undefined;
    },
    get count() {
      return fileRefs.size;
    }
  };
}

function createPresentation(core, operations, effects, options) {
  return async ({
    consumerId,
    result,
    presentationAllowed = async () => true,
    acknowledgePresentation
  }) => {
    if (!(await presentationAllowed())) {
      return { status: "recovery-required" };
    }
    const registration = core.presentation.registerConsumer({
      consumerId,
      consumerGeneration: 1,
      async consume(permit) {
        if (!(await presentationAllowed())) {
          throw new Error("SAVE_AS_OPERATION_STALE");
        }
        if (
          typeof acknowledgePresentation === "function" &&
          !(await acknowledgePresentation(permit))
        ) {
          throw new Error("SAVE_AS_PRESENTATION_NOT_ACKNOWLEDGED");
        }
        effects.p4 += 1;
        return {
          permitId: permit.permitId,
          operationId: permit.operationId,
          operationGeneration: permit.operationGeneration,
          processGeneration: permit.processGeneration,
          candidateReceiptId: permit.candidateReceiptId,
          consumerId: permit.consumerId,
          consumerGeneration: permit.consumerGeneration,
          presentationGeneration: permit.presentationGeneration,
          terminalOutcomeId: permit.terminalOutcomeId,
          terminalOutcomeCode: permit.terminalOutcomeCode,
          terminalOutcomeRevision: permit.terminalOutcomeRevision,
          accepted: true
        };
      }
    });
    assert.equal(registration.status, "registered");
    try {
      const issued = await core.presentation.issue({
        operationId: result.operation.operationId,
        operationGeneration: result.operation.operationGeneration,
        processGeneration: result.operation.producerProcessGeneration,
        j0Revision: result.operation.revision,
        targetFileRefId: result.d2.fileRef.id,
        candidateReceiptId: result.r3.custody.receiptId,
        runtime: result.r3.runtime,
        consumerId,
        consumerGeneration: 1,
        presentationGeneration: 1
      });
      assert.equal(issued.ok, true);
      const transferred = await core.presentation.transfer(
        issued.value.permitId
      );
      assert.equal(transferred.ok, true);
      await options.duringPresentation?.({
        handle: result.r3.runtime.handle,
        result
      });
      const presented = await operations.readback(
        result.operation.operationId
      );
      assert.ok(presented);
      return {
        status: "success",
        sessionHandle: result.r3.runtime.handle,
        operation: presented
      };
    } finally {
      effects.p4Detach += 1;
      core.presentation.detachConsumer(registration);
    }
  };
}

/**
 * Attaches the real owner adapter and Shared S0/F0/Engine/P4 composition to
 * the real Shared Runtime created by createRealMountedComposition().
 * All durable ports remain isolated, in-memory test authorities.
 */
export function createMountedSaveAsBoundary(composition, options) {
  const effects = {
    snapshotRead: 0,
    identityValidation: 0,
    picker: 0,
    physical: 0,
    guard: 0,
    j0: 0,
    d1: 0,
    d2: 0,
    r3: 0,
    p4: 0,
    p4Detach: 0,
    fileRef: 0,
    binding: 0,
    formalResource: 0,
    gatewayReread: 0,
    recovery: 0
    ,
    candidateCleanup: 0,
    candidateCloseAttempt: 0
  };
  const controls = {
    cancel: Boolean(options.cancel),
    ownerWritable: true,
    targetSequence: 0,
    async duringPicker() {
      await options.duringPicker?.();
    }
  };
  const presentationAcceptances = new Map();
  const operations = createOperationAuthority(
    effects,
    (operationId) => presentationAcceptances.delete(operationId)
  );
  const handoff = createHandoffAuthority();
  const fileRefs = createFileRefAuthority(effects);
  operations.atomicCommitD2 = async (input) => {
    const current = await operations.readback(input.operationId);
    assert.ok(current);
    assert.equal(input.expected.revision, current.revision);
    assert.equal(
      input.expected.commitFenceRevision,
      current.commitFenceRevision
    );
    assert.equal(input.expected.stage, current.stage);
    const registered = await fileRefs.registerAndReadbackFileRef({
      ownerType: current.ownerType,
      ownerId: current.ownerId,
      manuscriptChannel: current.channel,
      locationMode: current.targetLocationMode,
      path: current.targetDisplayPath,
      pathIdentityKey: current.targetPathIdentityKey
    });
    const operation = {
      ...current,
      revision: current.revision + 1,
      commitFenceRevision: current.commitFenceRevision + 1,
      stage: "d2_confirmed",
      d2CommitState: "confirmed",
      reconciliationState: "resolved",
      targetFileRefId: registered.fileRef.id,
      d2ReadbackRevision: registered.fileRef.updatedAt
    };
    operations.replace(operation);
    return {
      operation: structuredClone(operation),
      fileRef: registered.fileRef,
      state: registered.state === "existing" ? "reused" : "created"
    };
  };
  operations.containUnknownD2 = async (input) => {
    const current = await operations.readback(input.operationId);
    assert.ok(current);
    assert.equal(input.expected.revision, current.revision);
    assert.equal(
      input.expected.commitFenceRevision,
      current.commitFenceRevision
    );
    assert.equal(input.expected.stage, current.stage);
    assert.equal(current.stage, "d2_commit_unknown");
    const existing = await fileRefs.getFileRefByIdentity({
      pathIdentityKey: current.targetPathIdentityKey
    });
    const conflict = Boolean(current.targetFileRefId || existing);
    const operation = {
      ...current,
      revision: current.revision + 1,
      commitFenceRevision: current.commitFenceRevision + 1,
      containmentFenceToken: `containment:${current.operationId}`,
      reconciliationResultCode: conflict
        ? "D2_UNKNOWN_FILE_REF_CONFLICT"
        : "D2_UNKNOWN_CONTAINED",
      stage: conflict
        ? "d2_reconciliation_conflict"
        : "d2_reconciliation_contained",
      d2CommitState: conflict ? "blocked" : "unknown",
      reconciliationState: conflict ? "blocked" : "pending",
      blockingCode: conflict ? "D2_UNKNOWN_FILE_REF_CONFLICT" : undefined,
      terminalAt: conflict ? "2026-07-29T00:00:03.000Z" : undefined,
      updatedAt: "2026-07-29T00:00:03.000Z"
    };
    operations.replace(operation);
    return {
      operation: structuredClone(operation),
      state: conflict ? "conflict" : "containment"
    };
  };
  const activationResults = [];
  const custodies = new Map();
  const custody = {
    async plan(input) {
      const existing = custodies.get(input.operationId);
      if (existing) return existing;
      const operation = await operations.readback(input.operationId);
      const record = {
        operationId: input.operationId,
        revision: 0,
        receiptVersion: 1,
        receiptId: `receipt:${input.operationId}`,
        operationGeneration: operation.operationGeneration,
        processGeneration: operation.producerProcessGeneration,
        ownerType: operation.ownerType,
        ownerId: operation.ownerId,
        channel: operation.channel,
        candidateFileRefId: input.candidateFileRefId,
        runtimeConsumerId: input.runtimeConsumerId,
        activationAuthority: "r3_authority",
        currentCustodyAuthority: "r3_authority",
        custodyState: "activation_planned",
        initialAutomaticAttemptCount: 0,
        explicitCleanupCycleCount: 0,
        totalCloseAttemptCount: 0
      };
      custodies.set(input.operationId, record);
      return record;
    },
    async recordActivation(input) {
      const current = custodies.get(input.operationId);
      const record = {
        ...current,
        revision: current.revision + 1,
        runtimeHandle: input.runtimeHandle,
        runtimeGeneration: input.runtimeGeneration,
        custodyState: "activated_held"
      };
      custodies.set(input.operationId, record);
      return record;
    },
    async recordRecoveryActivation(input) {
      const current = custodies.get(input.operationId);
      const operation = await operations.readback(input.operationId);
      if (
        !current ||
        !operation ||
        current.receiptId !== input.receiptId ||
        current.revision !== input.expectedCustodyRevision ||
        current.ownerType !== input.ownerType ||
        current.ownerId !== input.ownerId ||
        current.channel !== input.channel ||
        current.candidateFileRefId !== input.candidateFileRefId ||
        current.runtimeHandle !== input.expectedRuntimeHandle ||
        current.runtimeGeneration !== input.expectedRuntimeGeneration ||
        current.runtimeConsumerId !== input.expectedRuntimeConsumerId ||
        operation.ownerType !== input.ownerType ||
        operation.ownerId !== input.ownerId ||
        operation.channel !== input.channel ||
        operation.targetFileRefId !== input.candidateFileRefId
      ) {
        throw new Error("SAVE_AS_CUSTODY_REVISION_CONFLICT");
      }
      const record = {
        ...current,
        revision: current.revision + 1,
        runtimeHandle: input.runtimeHandle,
        runtimeGeneration: input.runtimeGeneration,
        runtimeConsumerId: input.runtimeConsumerId,
        currentCustodyAuthority: "shared_recovery",
        custodyState: "transferred"
      };
      custodies.set(input.operationId, record);
      return record;
    },
    async readback(operationId) {
      return custodies.get(operationId) ?? null;
    },
    async transfer(input) {
      const current = custodies.get(input.operationId);
      const record = {
        ...current,
        revision: current.revision + 1,
        currentCustodyAuthority: input.nextAuthority,
        custodyState: "transferred"
      };
      custodies.set(input.operationId, record);
      return record;
    }
  };
  const writtenRawByOperation = new Map();
  let snapshotSequence = 0;
  let tokenSequence = 0;
  let permitSequence = 0;
  let r3FailureRemaining =
    options.r3FailureCode ? 1 : 0;
  let candidateCleanupFailureRemaining =
    options.candidateCleanupFailureCount ?? 0;
  const candidateCleanupHandles = [];
  async function closeCandidate(handle) {
    effects.candidateCloseAttempt += 1;
    candidateCleanupHandles.push(handle);
    if (candidateCleanupFailureRemaining > 0) {
      candidateCleanupFailureRemaining -= 1;
      return {
        status: "conflict",
        error: {
          code: "E1R2_INJECTED_EXACT_CLOSE_FAILURE",
          retryable: true
        }
      };
    }
    return composition.runtime.close(handle, "discard");
  }
  async function readIsolatedPhysical({ file }) {
    effects.gatewayReread += 1;
    const record = operations
      .snapshot()
      .find(
        (candidate) =>
          candidate.targetPathIdentityKey === file.pathIdentity
      );
    const rawText = record
      ? writtenRawByOperation.get(record.operationId)
      : undefined;
    if (record && rawText !== undefined) {
      return {
        status: "success",
        data: {
          rawText,
          revision: record.d1ReadbackRevision,
          encoding: "utf-8",
          newline: record.newlineContractVersion.replace(/-v1$/u, ""),
          physicalIdentity: record.d1PhysicalIdentityHash
        }
      };
    }
    return {
      status: "error",
      error: { code: "MANUSCRIPT_FILE_NOT_FOUND" }
    };
  }

  const core = real.createSharedManuscriptSaveAsCoreComposition({
    sourceSnapshot: {
      sessions: {
        readSaveAsSourceSnapshot(handle) {
          effects.snapshotRead += 1;
          return composition.runtime.readSaveAsSourceSnapshot(handle);
        },
        validateSaveAsSourceIdentity(input) {
          effects.identityValidation += 1;
          return composition.runtime.validateSaveAsSourceIdentity(input);
        }
      },
      createSnapshotId: () =>
        `isolated-snapshot-${++snapshotSequence}`
    },
    f0: {
      guard: {
        async observeCurrentProcessGeneration() {
          effects.guard += 1;
          return { processGeneration: "isolated-process" };
        }
      },
      physical: {
        async observeSaveAsTargetCandidate({ targetPath }) {
          effects.physical += 1;
          if (options.physicalFailureCode) {
            return {
              ok: false,
              failure: {
                code: options.physicalFailureCode,
                stage: "pre_d1_closed",
                continuation: "reselect_target",
                writeApplied: false
              }
            };
          }
          const normalized = targetPath.replaceAll("\\", "/").toLowerCase();
          const parent = normalized.replace(/\/[^/]+$/u, "");
          return {
            ok: true,
            continuation: "close",
            value: {
              normalizedTargetPath: targetPath,
              proposedTargetPathIdentity: normalized,
              canonicalParentPathIdentity: parent,
              parentPhysicalIdentityHash: "a".repeat(64),
              normalizedFinalFilename: targetPath.replace(/^.*[\\/]/u, ""),
              observationGeneration: `physical-${effects.physical}`,
              observationProof: "b".repeat(64),
              parentExists: true,
              targetExists: false
            }
          };
        }
      }
    },
    d2: {
      operations,
      fileRefs
    },
    activation: {
      operations,
      custody,
      handoff,
      gateway: { read: readIsolatedPhysical },
      runtime: {
        async activateSaveAsTarget(input) {
          effects.r3 += 1;
          if (r3FailureRemaining > 0) {
            r3FailureRemaining -= 1;
            const failed = {
              operation: "open",
              status: "error",
              operationId: input.operationId,
              error: {
                code: options.r3FailureCode,
                category: "session",
                retryable: true,
                writeApplied: false,
                recoveryRequired: true
              }
            };
            activationResults.push(failed);
            return failed;
          }
          const result =
            await composition.runtime.activateSaveAsTarget(input);
          activationResults.push(result);
          return result;
        }
      }
    },
    engine: {
      operations,
      handoff,
      guard: {
        async acquire(input) {
          return {
            ...input,
            processGeneration: "isolated-process",
            proof: `isolated-guard-${input.operationId}`,
            referenceCount: 1
          };
        },
        async release() {
          return {
            released: true,
            finalRelease: true,
            referenceCount: 0
          };
        }
      },
      d1: {
        async createNewWithReadback(input) {
          effects.d1 += 1;
          if (options.d1FailureCode) {
            const current = await operations.readback(
              input.source.operationId
            );
            assert.ok(current);
            operations.replace({
              ...current,
              revision: current.revision + 2,
              stage: "pre_d1_closed",
              d1CommitState: "not_started",
              d2CommitState: "not_started",
              reconciliationState: "not_required",
              blockingCode: options.d1FailureCode,
              updatedAt: "2026-07-29T00:00:01.000Z",
              terminalAt: "2026-07-29T00:00:01.000Z"
            });
            throw Object.freeze({
              kind: "save_as_d1_failure",
              code: options.d1FailureCode
            });
          }
          const rawText = input.frozenRawText;
          const digest = await sha256(rawText);
          const canonicalRevision =
            `manuscript-physical-v2:test:${digest}`;
          const current = await operations.readback(
            input.source.operationId
          );
          assert.ok(current);
          operations.replace({
            ...current,
            revision: current.revision + 1,
            stage: "d1_confirmed",
            d1CommitState: "confirmed",
            reconciliationState: "resolved",
            d1PhysicalIdentityHash: "c".repeat(64),
            d1ReadbackSha256: digest,
            d1ReadbackRevision: canonicalRevision,
            d1ByteLength:
              new TextEncoder().encode(rawText).byteLength,
            d1ProofGeneration: 1
          });
          writtenRawByOperation.set(
            input.source.operationId,
            rawText
          );
          await options.duringD1?.({
            operationId: input.source.operationId,
            rawText
          });
          return {
            proof: {
              normalizedTargetIdentity:
                input.target.pathIdentityKey,
              physicalTargetIdentityHash: "c".repeat(64),
              d1ReadbackSha256: digest,
              d1ReadbackRevision: canonicalRevision,
              byteLength:
                new TextEncoder().encode(rawText).byteLength,
              encodingContractVersion: "utf-8-v1",
              newlineContractVersion:
                input.source.newlineContractVersion,
              proofGeneration: 1
            },
            readbackText: rawText,
            writeApplied: true
          };
        }
      },
      createToken: () => `isolated-token-${++tokenSequence}`,
      now: () => "2026-07-29T00:00:00.000Z"
    },
    presentation: {
      operations,
      finalization: {
        async recordPresentation(input) {
          const existing = presentationAcceptances.get(
            input.operationId
          );
          if (existing) return structuredClone(existing);
          const operation = await operations.readback(
            input.operationId
          );
          assert.ok(operation);
          assert.equal(
            operation.revision,
            input.expectedOperationRevision
          );
          assert.equal(
            operation.operationGeneration,
            input.operationGeneration
          );
          assert.equal(
            operation.producerProcessGeneration,
            input.processGeneration
          );
          assert.equal(
            operation.stage,
            "p4_presentation_pending"
          );
          const record = {
            operationId: input.operationId,
            revision: 0,
            finalizationState: "presentation_completed",
            receiptId: input.receiptId,
            ownerType: operation.ownerType,
            ownerId: operation.ownerId,
            channel: operation.channel,
            candidateFileRefId: operation.targetFileRefId,
            p4PermitId: input.permitId,
            p4OperationGeneration: input.operationGeneration,
            p4ProcessGeneration: input.processGeneration,
            terminalOutcomeId: input.terminalOutcomeId,
            terminalOutcomeCode: input.terminalOutcomeCode,
            terminalOutcomeRevision:
              input.terminalOutcomeRevision,
            createdAt: "2026-07-29T00:00:00.000Z",
            updatedAt: "2026-07-29T00:00:00.000Z"
          };
          presentationAcceptances.set(
            input.operationId,
            record
          );
          return structuredClone(record);
        },
        async readback(operationId) {
          const record =
            presentationAcceptances.get(operationId);
          return record ? structuredClone(record) : null;
        }
      },
      createPermitId: () =>
        `isolated-permit-${++permitSequence}`
    },
    recovery: {
      operations,
      continuations: {
        async inspectD1() {
          return { state: "unavailable" };
        },
        async continueD2(current) {
          return { ok: true, continuation: "close", value: current };
        },
        async continueR3(current) {
          return { ok: true, continuation: "close", value: current };
        },
        async continueP4(current) {
          return { ok: true, continuation: "close", value: current };
        }
      }
    }
  });

  const present = createPresentation(
    core,
    operations,
    effects,
    options
  );
  let observationGeneration = 1000;
  let ownerPresent = present;
  if (
    composition.ownerType === "review" ||
    composition.ownerType === "literature"
  ) {
    let presentationGeneration = 0;
    const presentationAdapter =
      composition.ownerType === "review"
        ? real.createReviewManuscriptSaveAsPresentationAdapter({
            presentation: {
              registerConsumer(input) {
                return core.presentation.registerConsumer({
                  ...input,
                  async consume(permit) {
                    effects.p4 += 1;
                    const receipt = await input.consume(permit);
                    await options.duringPresentation?.();
                    return receipt;
                  }
                });
              },
              issue: (input) => core.presentation.issue(input),
              transfer: (permitId) => core.presentation.transfer(permitId),
              detachConsumer(registration) {
                effects.p4Detach += 1;
                return core.presentation.detachConsumer(registration);
              },
              reconcileConsumed: (permitId, receipt) =>
                core.presentation.reconcileConsumed(permitId, receipt),
              inspectPermit: (permitId) =>
                core.presentation.inspectPermit(permitId)
            },
            nextGeneration: () => ++presentationGeneration
          })
        : real.createLiteratureManuscriptSaveAsPresentationAdapter({
        presentation: {
          registerConsumer(input) {
            return core.presentation.registerConsumer({
              ...input,
              async consume(permit) {
                effects.p4 += 1;
                const receipt = await input.consume(permit);
                await options.duringPresentation?.();
                return receipt;
              }
            });
          },
          issue: (input) => core.presentation.issue(input),
          transfer: (permitId) => core.presentation.transfer(permitId),
          detachConsumer(registration) {
            effects.p4Detach += 1;
            return core.presentation.detachConsumer(registration);
          },
          reconcileConsumed: (permitId, receipt) =>
            core.presentation.reconcileConsumed(permitId, receipt),
          inspectPermit: (permitId) =>
            core.presentation.inspectPermit(permitId)
        },
        nextGeneration: () => ++presentationGeneration
      });
    ownerPresent = (input) => presentationAdapter.present(input);
  }
  const productionRecovery =
    real.createManuscriptSaveAsProductionRecoveryComposition({
      operations,
      d2: core.d2,
      activation: core.activation,
      gateway: { read: readIsolatedPhysical },
      physicalObservation: {
        async observeExistingSaveAsTarget({ expectedPathIdentity }) {
          const record = operations
            .snapshot()
            .find(
              (candidate) =>
                candidate.targetPathIdentityKey === expectedPathIdentity
            );
          return record?.d1PhysicalIdentityHash
            ? {
                ok: true,
                continuation: "close",
                value: {
                  targetExists: true,
                  targetPhysicalIdentityHash: record.d1PhysicalIdentityHash
                }
              }
            : {
                ok: false,
                failure: {
                  code: "SAVE_AS_D1_READBACK_FAILED",
                  stage: "reconciliation_blocked",
                  continuation: "start_new_operation",
                  writeApplied: false
                }
              };
        }
      },
      getFileRef: (id) => fileRefs.getFileRefById(id),
      listSessionConsumers: () =>
        composition.runtime.listSessionConsumers(),
      readCustody: (operationId) => custody.readback(operationId),
      readRuntimeBinding: (receiptId) =>
        composition.runtime.readSaveAsCandidateBinding(receiptId),
      transferCustody: (input) => custody.transfer(input),
      nextObservationGeneration: () => ++observationGeneration
    });
  const invocationResults = [];
  const adapterResults = [];
  const common = {
    async ownerWritable() {
      return controls.ownerWritable;
    },
    async selectTarget() {
      effects.picker += 1;
      await controls.duringPicker();
      if (controls.cancel) return { status: "canceled" };
      const sequence = ++controls.targetSequence;
      return {
        status: "selected",
        path:
          `N:\\lp12-3-b-ip-2-r1\\${composition.ownerType}` +
          `\\${options.locationMode}-${sequence}.md`
      };
    },
    async classifyTarget() {
      if (options.classificationFailureCode) {
        return {
          status: "error",
          errorCode: options.classificationFailureCode
        };
      }
      return {
        status: "allowed",
        locationMode: options.locationMode,
        ...(options.locationMode === "managed"
          ? { configuredRoot: "N:\\lp12-3-b-ip-2-r1" }
          : {})
      };
    },
    async invoke(input) {
      const result = await core.invocation.invoke(input);
      invocationResults.push(result);
      return result;
    },
    present: ownerPresent,
    listReconcilable: () => operations.listReconcilable(),
    recoverOperation(input) {
      effects.recovery += 1;
      return productionRecovery.recover(input);
    },
    async resolveConfiguredRoot() {
      return options.locationMode === "managed"
        ? "N:\\lp12-3-b-ip-2-r1"
        : undefined;
    },
    getSession(handle) {
      const session = composition.runtime.getSession(handle);
      if (!session || !options.candidateIdentityVariant) {
        return session;
      }
      const expectedFileRefId =
        operations
          .snapshot()
          .find(
            (record) =>
              record.targetFileRefId ===
              session.file.fileRefId
          )
          ?.targetFileRefId;
      if (!expectedFileRefId) return session;
      const fileWrong =
        options.candidateIdentityVariant === "file-wrong" ||
        options.candidateIdentityVariant === "both-wrong";
      const logicalWrong =
        options.candidateIdentityVariant === "logical-wrong" ||
        options.candidateIdentityVariant === "both-wrong";
      return {
        ...session,
        file: {
          ...session.file,
          fileRefId: fileWrong
            ? `wrong-file:${expectedFileRefId}`
            : session.file.fileRefId
        },
        logicalIdentity: {
          ...session.logicalIdentity,
          fileRefId: logicalWrong
            ? `wrong-logical:${expectedFileRefId}`
            : session.logicalIdentity.fileRefId
        }
      };
    },
    async cleanupOwnedCandidate(operationId) {
      effects.candidateCleanup += 1;
      const handle = custodies.get(operationId)?.runtimeHandle;
      if (!handle) return { status: "already-absent" };
      const first = await closeCandidate(handle);
      if (first.status === "success") {
        return { status: "closed" };
      }
      if (
        first.status === "error" &&
        String(first.error?.code) ===
          "MANUSCRIPT_STALE_SESSION_HANDLE"
      ) {
        return { status: "already-absent" };
      }
      if (
        first.status === "conflict" ||
        first.error?.retryable
      ) {
        const second = await closeCandidate(handle);
        if (second.status === "success") {
          return { status: "closed" };
        }
        if (
          second.status === "error" &&
          String(second.error?.code) ===
            "MANUSCRIPT_STALE_SESSION_HANDLE"
        ) {
          return { status: "already-absent" };
        }
      }
      return { status: "cleanup-blocked" };
    },
    transferCustody: (input) => custody.transfer(input),
    readCustody: (operationId) => custody.readback(operationId),
    finalization: {
      async finalize() {
        return { status: "finalized" };
      }
    },
    lifecycle: real.createManuscriptSaveAsLifecycleRegistry()
  };

  let adapterService;
  if (composition.ownerType === "experiment") {
    adapterService = real.createExperimentManuscriptSaveAsAdapter(common);
  } else if (composition.ownerType === "experimentRun") {
    adapterService = real.createExperimentRunManuscriptSaveAsAdapter({
      ...common,
      async listSwitchRecoveries() {
        return [];
      }
    });
  } else if (composition.ownerType === "review") {
    adapterService = real.createReviewManuscriptSaveAsAdapter(common);
  } else if (composition.ownerType === "literature") {
    adapterService = real.createLiteratureManuscriptSaveAsAdapter(common);
  } else if (
    [
      "resultItem",
      "finding",
      "outputCandidate",
      "outputGap",
      "researchOutput"
    ].includes(composition.ownerType)
  ) {
    adapterService =
      real.createOutputManuscriptSaveAsAdapter(common);
  } else {
    throw new Error(`Unsupported mounted owner: ${composition.ownerType}`);
  }
  const service = Object.freeze({
    ...adapterService,
    async saveAs(input) {
      const result = await adapterService.saveAs(input);
      adapterResults.push(result);
      return result;
    }
  });

  return {
    service,
    core,
    controls,
    effects,
    operations,
    invocationResults,
    adapterResults,
    activationResults,
    candidateCleanupHandles,
    writtenRawByOperation,
    async getFileRefById(id) {
      return fileRefs.getFileRefById(id);
    },
    createOutputLifecycleRegistry() {
    return real.createManuscriptSaveAsLifecycleRegistry();
    },
    getOutputManuscriptStaticDescriptor:
      real.getOutputManuscriptStaticDescriptor,
    resetEvidence(input = {}) {
      for (const key of Object.keys(effects)) effects[key] = 0;
      invocationResults.length = 0;
      adapterResults.length = 0;
      activationResults.length = 0;
      candidateCleanupHandles.length = 0;
      if (!input.preserveWrittenRaw) {
        writtenRawByOperation.clear();
      }
    },
    get writtenRaw() {
      return [...writtenRawByOperation.values()];
    },
    assertNoFormalResourceAccess(input = {}) {
      assert.equal(effects.formalResource, 0);
      assert.equal(effects.binding, 0);
      assert.equal(
        effects.gatewayReread,
        input.expectedGatewayReread ?? 0
      );
    }
  };
}
