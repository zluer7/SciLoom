import type {
  DurableFileIdentity,
  OwnerIdentity,
  RawManuscriptGateway,
  RawManuscriptSnapshot
} from "../types/manuscriptOperation";
import type {
  DurableSharedTargetSnapshot,
  SharedSaveAsTargetActivationInput,
  SharedSessionHandleResult
} from "../types/sharedManuscriptSession";
import type {
  SaveAsClaimIdentity,
  SaveAsFailureCode
} from "../types/manuscriptSaveAs";
import {
  manuscriptSaveAsHandoffPort,
  SaveAsHandoffError,
  type SaveAsHandoffExpectation
} from "./manuscriptSaveAsHandoffPort";
import {
  manuscriptSaveAsOperationPort,
  saveAsOperationExpectation,
  type SaveAsOperationTransitionInput,
  type SaveAsOperationRecord
} from "./manuscriptSaveAsOperationPort";
import {
  type SaveAsCoreInternalReason,
  type SharedSaveAsCoreOutcome
} from "./manuscriptSaveAsD2Adapter";
import { rawManuscriptGateway } from "./rawManuscriptGateway";
import { sharedManuscriptSessionRuntime } from "./sharedManuscriptSessionComposition";
import {
  createManuscriptSaveAsCandidateCleanupCoordinator,
  manuscriptSaveAsCandidateCustodyPort,
  type CandidateDisposition,
  type CandidateCustodyRecord,
  type RecoveryCandidateActivationInput
} from "./manuscriptSaveAsCandidateCustody";

export type SaveAsHandoffAvailability =
  | {
      kind: "handoff";
      singleUseToken: string;
      expectation: SaveAsHandoffExpectation;
    }
  | {
      kind: "handoff_unavailable";
      evidence:
        | {
            kind: "process_restart";
            previousProcessGeneration: string;
            currentProcessGeneration: string;
          }
        | {
            kind: "natural_handoff_expiry";
            expiredProofIssuanceGeneration: number;
            currentProofIssuanceGeneration: number;
          }
        | {
            kind: "formal_cleanup";
            operationId: string;
            operationGeneration: number;
            j0Revision: number;
            cleanupGeneration: number;
            physicalTargetIdentityHash: string;
          };
    }
  | {
      kind: "proof_mismatch";
      reason:
        | "wrong_operation"
        | "wrong_operation_generation"
        | "wrong_target"
        | "physical_identity_mismatch"
        | "j0_claim_mismatch"
        | "raw_proof_mismatch"
        | "source_proof_mismatch";
    }
  | { kind: "already_consumed"; singleUseToken: string };

export interface SaveAsRuntimeActivationInput {
  operationId: string;
  operationGeneration: number;
  j0Revision: number;
  claimIdentity: SaveAsClaimIdentity;
  owner: OwnerIdentity;
  target: DurableSharedTargetSnapshot;
  consumerId: string;
  sourceRuntimeGeneration: number;
  handoff: SaveAsHandoffAvailability;
  recovery?: {
    expectedCustody: CandidateCustodyRecord;
  };
}

export interface SaveAsRuntimeActivationResult {
  operation: SaveAsOperationRecord;
  runtime: SharedSessionHandleResult;
  rawSource: "handoff" | "gateway_reread";
  gatewayRereadCount: 0 | 1;
  custody: CandidateCustodyRecord;
}

interface HandoffAuthority {
  consumeSaveAsHandoff(
    singleUseToken: string,
    expected: SaveAsHandoffExpectation
  ): Promise<{ proof: SaveAsHandoffExpectation; readbackText: string }>;
}

interface RuntimeAuthority {
  activateSaveAsTarget(
    input: SharedSaveAsTargetActivationInput
  ): Promise<{
    status: string;
    data?: SharedSessionHandleResult;
  }>;
  readSaveAsCandidateBinding(receiptId: string): import("../types/sharedManuscriptSession").SharedSaveAsCandidateRuntimeBinding | undefined;
  closeSaveAsCandidate(
    expected: import("../types/sharedManuscriptSession").SharedSaveAsCandidateRuntimeBinding
  ): Promise<import("../types/sharedManuscriptSession").SharedSaveAsCandidateCloseResult>;
}

interface OperationAuthority {
  transition(input: SaveAsOperationTransitionInput): Promise<SaveAsOperationRecord>;
  readback(operationId: string): Promise<SaveAsOperationRecord | null>;
}

interface CustodyAuthority {
  plan(input: {
    operationId: string;
    expectedOperationRevision: number;
    candidateFileRefId: string;
    runtimeConsumerId: string;
  }): Promise<CandidateCustodyRecord>;
  recordActivation(input: {
    operationId: string;
    expectedCustodyRevision: number;
    receiptId: string;
    runtimeHandle: string;
    runtimeGeneration: number;
  }): Promise<CandidateCustodyRecord>;
  recordRecoveryActivation(
    input: RecoveryCandidateActivationInput
  ): Promise<CandidateCustodyRecord>;
  readback(operationId: string): Promise<CandidateCustodyRecord | null>;
  claimCleanup(input: {
    operationId: string;
    expectedCustodyRevision: number;
  }): Promise<CandidateCustodyRecord>;
  recordCleanup(input: {
    operationId: string;
    expectedCustodyRevision: number;
    receiptId: string;
    cleanupClaimToken?: string;
    cycle: "automatic" | "explicit";
    result:
      | "closed"
      | "already_absent"
      | "not_activated"
      | "retryable_failure"
      | "cleanup_blocked"
      | "process_generation_retired";
    errorCode?: string;
  }): Promise<CandidateCustodyRecord>;
}

function exactCustody(
  actual: CandidateCustodyRecord | null,
  expected: CandidateCustodyRecord,
  input: SaveAsRuntimeActivationInput
) {
  return Boolean(
    actual &&
    actual.operationId === input.operationId &&
    actual.operationId === expected.operationId &&
    actual.receiptId === expected.receiptId &&
    actual.revision === expected.revision &&
    actual.ownerType === input.owner.ownerType &&
    actual.ownerId === input.owner.ownerId &&
    actual.channel === input.owner.channel &&
    actual.candidateFileRefId === input.target.file.fileRefId &&
    actual.runtimeHandle === expected.runtimeHandle &&
    actual.runtimeGeneration === expected.runtimeGeneration &&
    actual.runtimeConsumerId === expected.runtimeConsumerId &&
    [
      "activation_planned",
      "activated_held",
      "transfer_pending",
      "transferred"
    ].includes(
      actual.custodyState
    )
  );
}

function exactActivatedCustody(
  actual: CandidateCustodyRecord | null,
  expected: CandidateCustodyRecord,
  input: SaveAsRuntimeActivationInput,
  runtime: SharedSessionHandleResult
) {
  return Boolean(
    actual &&
    actual.operationId === expected.operationId &&
    actual.receiptId === expected.receiptId &&
    actual.revision === expected.revision + 1 &&
    actual.ownerType === input.owner.ownerType &&
    actual.ownerId === input.owner.ownerId &&
    actual.channel === input.owner.channel &&
    actual.candidateFileRefId === input.target.file.fileRefId &&
    actual.runtimeHandle === runtime.handle &&
    actual.runtimeGeneration === runtime.session.sessionGeneration &&
    actual.runtimeConsumerId === input.consumerId &&
    actual.currentCustodyAuthority === "shared_recovery" &&
    actual.custodyState === "transferred"
  );
}

function exactRecoveryRetryCustody(
  actual: CandidateCustodyRecord | null,
  expected: CandidateCustodyRecord,
  input: SaveAsRuntimeActivationInput
) {
  return Boolean(
    actual &&
    actual.operationId === expected.operationId &&
    actual.receiptId === expected.receiptId &&
    actual.revision === expected.revision + 1 &&
    actual.ownerType === input.owner.ownerType &&
    actual.ownerId === input.owner.ownerId &&
    actual.channel === input.owner.channel &&
    actual.candidateFileRefId === input.target.file.fileRefId &&
    actual.runtimeHandle &&
    actual.runtimeGeneration !== undefined &&
    actual.runtimeConsumerId === input.consumerId &&
    actual.currentCustodyAuthority === "shared_recovery" &&
    actual.custodyState === "transferred"
  );
}

function fail(
  code: SaveAsFailureCode,
  record: SaveAsOperationRecord | null,
  internalReason: SaveAsCoreInternalReason,
  writeApplied: false | true | "unknown" = false,
  candidateDisposition?: CandidateDisposition
): SharedSaveAsCoreOutcome<never> {
  return {
    ok: false,
    failure: {
      code,
      stage: record?.stage ?? "reconciliation_blocked",
      continuation:
        internalReason === "handoff_unavailable" ||
        internalReason === "runtime_activation_failed"
          ? "await_recovery"
          : "hard_block",
      writeApplied
    },
    internalReason,
    candidateDisposition
  };
}

function sameClaim(
  record: SaveAsOperationRecord,
  claim: SaveAsClaimIdentity
) {
  return (
    record.claimToken === claim.claimToken &&
    record.claimRevision === claim.claimRevision &&
    record.claimProcessGeneration === claim.claimProcessGeneration &&
    (record.observationGeneration ?? 0) === claim.observationGeneration &&
    (record.observationRevision ?? 0) === claim.observationRevision
  );
}

function recordMatches(
  record: SaveAsOperationRecord,
  input: SaveAsRuntimeActivationInput
) {
  return (
    record.operationId === input.operationId &&
    record.operationGeneration === input.operationGeneration &&
    record.revision === input.j0Revision &&
    sameClaim(record, input.claimIdentity) &&
    record.ownerType === input.owner.ownerType &&
    record.ownerId === input.owner.ownerId &&
    record.channel === input.owner.channel &&
    record.targetPathIdentityKey === input.target.file.pathIdentity &&
    record.targetFileRefId === input.target.file.fileRefId &&
    record.targetLocationMode === input.target.file.locationMode &&
    record.sourceRuntimeGeneration === input.sourceRuntimeGeneration &&
    record.d1CommitState === "confirmed" &&
    record.d2CommitState === "confirmed"
  );
}

function unavailableEvidenceMatches(
  record: SaveAsOperationRecord,
  input: SaveAsRuntimeActivationInput,
  handoff: Extract<SaveAsHandoffAvailability, { kind: "handoff_unavailable" }>
) {
  const evidence = handoff.evidence;
  if (evidence.kind === "process_restart") {
    return (
      evidence.previousProcessGeneration === record.producerProcessGeneration &&
      Boolean(evidence.currentProcessGeneration.trim()) &&
      evidence.currentProcessGeneration !== evidence.previousProcessGeneration
    );
  }
  if (evidence.kind === "natural_handoff_expiry") {
    return (
      evidence.expiredProofIssuanceGeneration ===
        record.d1ProofGeneration &&
      evidence.currentProofIssuanceGeneration >
        evidence.expiredProofIssuanceGeneration
    );
  }
  return (
    evidence.operationId === input.operationId &&
    evidence.operationGeneration === input.operationGeneration &&
    evidence.j0Revision === input.j0Revision &&
    evidence.cleanupGeneration > 0 &&
    evidence.physicalTargetIdentityHash === record.d1PhysicalIdentityHash
  );
}

function handoffExpectationMatchesRecord(
  record: SaveAsOperationRecord,
  expectation: SaveAsHandoffExpectation
) {
  return (
    expectation.operationId === record.operationId &&
    expectation.operationGeneration === record.operationGeneration &&
    expectation.normalizedTargetIdentity === record.targetPathIdentityKey &&
    expectation.physicalTargetIdentityHash ===
      record.d1PhysicalIdentityHash &&
    expectation.d1ReadbackSha256 === record.d1ReadbackSha256 &&
    expectation.byteLength === record.d1ByteLength &&
    expectation.encodingContractVersion ===
      record.encodingContractVersion &&
    expectation.newlineContractVersion ===
      record.newlineContractVersion &&
    expectation.sourceSnapshotSha256 === record.snapshotSha256 &&
    expectation.sourceRevision === record.sourceRevision &&
    expectation.sourceRuntimeGeneration ===
      record.sourceRuntimeGeneration &&
    expectation.j0Revision <= record.revision &&
    expectation.proofIssuanceGeneration === record.d1ProofGeneration &&
    sameClaim(record, expectation.claimIdentity)
  );
}

async function sha256Utf8(value: string) {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function newlineSnapshot(rawText: string) {
  const crlf = (rawText.match(/\r\n/g) ?? []).length;
  const lf = (rawText.match(/(?<!\r)\n/g) ?? []).length;
  if (!crlf && !lf) return { newline: "none" as const };
  if (crlf && !lf) {
    return { newline: "crlf" as const, dominantNewline: "crlf" as const };
  }
  if (lf && !crlf) {
    return { newline: "lf" as const, dominantNewline: "lf" as const };
  }
  return {
    newline: "mixed" as const,
    dominantNewline: crlf >= lf ? ("crlf" as const) : ("lf" as const)
  };
}

async function verifiedSnapshot(
  record: SaveAsOperationRecord,
  rawText: string,
  revision?: string
): Promise<RawManuscriptSnapshot | undefined> {
  const canonicalRevision = revision ?? record.d1ReadbackRevision;
  if (
    !record.d1ReadbackSha256 ||
    !record.d1ReadbackRevision ||
    !canonicalRevision ||
    canonicalRevision !== record.d1ReadbackRevision ||
    record.d1ByteLength === undefined ||
    !record.d1PhysicalIdentityHash ||
    (await sha256Utf8(rawText)) !== record.d1ReadbackSha256 ||
    new TextEncoder().encode(rawText).byteLength !== record.d1ByteLength
  ) {
    return undefined;
  }
  return {
    rawText,
    revision: canonicalRevision,
    physicalIdentity: record.d1PhysicalIdentityHash,
    encoding: "utf-8",
    ...newlineSnapshot(rawText),
    byteLength: record.d1ByteLength
  };
}

export function createManuscriptSaveAsRuntimeActivation(dependencies: {
  handoff: HandoffAuthority;
  gateway: RawManuscriptGateway;
  runtime: RuntimeAuthority;
  operations: OperationAuthority;
  custody: CustodyAuthority;
}) {
  return Object.freeze({
    async activate(
      input: SaveAsRuntimeActivationInput
    ): Promise<SharedSaveAsCoreOutcome<SaveAsRuntimeActivationResult>> {
      let current = await dependencies.operations.readback(input.operationId);
      if (
        !current ||
        !recordMatches(current, input) ||
        !["d2_confirmed", "r3_activation_pending"].includes(current.stage)
      ) {
        return fail(
          "SAVE_AS_HANDOFF_MISMATCH",
          current,
          "proof_mismatch"
        );
      }
      if (
        input.handoff.kind === "proof_mismatch" ||
        input.handoff.kind === "already_consumed"
      ) {
        return fail(
          input.handoff.kind === "already_consumed"
            ? "SAVE_AS_HANDOFF_ALREADY_CONSUMED"
            : "SAVE_AS_HANDOFF_MISMATCH",
          current,
          input.handoff.kind === "already_consumed"
            ? "already_consumed"
            : "proof_mismatch"
        );
      }
      if (
        input.handoff.kind === "handoff" &&
        !handoffExpectationMatchesRecord(
          current,
          input.handoff.expectation
        )
      ) {
        return fail(
          "SAVE_AS_HANDOFF_MISMATCH",
          current,
          "proof_mismatch"
        );
      }

      if (current.stage === "d2_confirmed") {
        try {
          current = await dependencies.operations.transition({
            operationId: current.operationId,
            expected: saveAsOperationExpectation(current),
            mutation: { intent: "enter_r3_activation_pending" }
          });
        } catch {
          return fail(
            "SAVE_AS_J0_CAS_CONFLICT",
            current,
            "stale_operation"
          );
        }
      }

      let accepted: RawManuscriptSnapshot | undefined;
      let rawSource: "handoff" | "gateway_reread";
      let gatewayRereadCount: 0 | 1;
      if (input.handoff.kind === "handoff") {
        try {
          const envelope =
            await dependencies.handoff.consumeSaveAsHandoff(
              input.handoff.singleUseToken,
              input.handoff.expectation
            );
          accepted = await verifiedSnapshot(current, envelope.readbackText);
        } catch (cause) {
          return fail(
            cause instanceof SaveAsHandoffError
              ? cause.code
              : "SAVE_AS_HANDOFF_MISMATCH",
            current,
            cause instanceof SaveAsHandoffError &&
              cause.code === "SAVE_AS_HANDOFF_ALREADY_CONSUMED"
              ? "already_consumed"
              : "proof_mismatch"
          );
        }
        if (!accepted) {
          return fail(
            "SAVE_AS_HANDOFF_MISMATCH",
            current,
            "proof_mismatch"
          );
        }
        rawSource = "handoff";
        gatewayRereadCount = 0;
      } else {
        if (!unavailableEvidenceMatches(current, input, input.handoff)) {
          return fail(
            "SAVE_AS_HANDOFF_MISMATCH",
            current,
            "proof_mismatch"
          );
        }
        const reread = await dependencies.gateway.read({
          file: input.target.file
        });
        if (reread.status !== "success" || !reread.data) {
          return fail(
            "SAVE_AS_D1_READBACK_FAILED",
            current,
            "handoff_unavailable",
            true
          );
        }
        accepted = await verifiedSnapshot(
          current,
          reread.data.rawText,
          reread.data.revision
        );
        if (!accepted) {
          return fail(
            "SAVE_AS_D1_READBACK_MISMATCH",
            current,
            "proof_mismatch",
            true
          );
        }
        rawSource = "gateway_reread";
        gatewayRereadCount = 1;
      }

      let custody: CandidateCustodyRecord;
      let recoveryAlreadyRecorded = false;
      if (input.recovery) {
        const readback = await dependencies.custody.readback(
          current.operationId
        );
        recoveryAlreadyRecorded = exactRecoveryRetryCustody(
          readback,
          input.recovery.expectedCustody,
          input
        );
        if (
          !recoveryAlreadyRecorded &&
          !exactCustody(readback, input.recovery.expectedCustody, input)
        ) {
          return fail(
            "SAVE_AS_OPERATION_STALE",
            current,
            "stale_operation",
            true
          );
        }
        custody = readback!;
      } else {
        try {
          custody = await dependencies.custody.plan({
            operationId: current.operationId,
            expectedOperationRevision: current.revision,
            candidateFileRefId: input.target.file.fileRefId,
            runtimeConsumerId: input.consumerId
          });
        } catch {
          return fail(
            "SAVE_AS_J0_RESPONSE_LOSS",
            current,
            "runtime_activation_failed",
            true
          );
        }
      }
      const activated = await dependencies.runtime.activateSaveAsTarget({
        operationId: input.operationId,
        operationGeneration: input.operationGeneration,
        processGeneration: current.producerProcessGeneration,
        receiptId: custody.receiptId,
        sourceRuntimeGeneration: input.sourceRuntimeGeneration,
        expectedSourceRuntimeGeneration: current.sourceRuntimeGeneration,
        owner: input.owner,
        target: input.target,
        acceptedSnapshot: accepted,
        consumerId: input.consumerId,
        expectedCandidateBinding: input.recovery &&
          custody.runtimeHandle &&
          custody.runtimeGeneration !== undefined
          ? {
              receiptId: custody.receiptId,
              operationId: custody.operationId,
              processGeneration: custody.processGeneration,
              owner: {
                ownerType: custody.ownerType,
                ownerId: custody.ownerId,
                channel: custody.channel
              },
              candidateFileRefId: custody.candidateFileRefId,
              runtimeHandle: custody.runtimeHandle,
              runtimeConsumerId: custody.runtimeConsumerId,
              runtimeGeneration: custody.runtimeGeneration
            }
          : undefined
      });
      if (activated.status !== "success" || !activated.data) {
        return fail(
          "SAVE_AS_PHYSICAL_EFFECT_UNKNOWN",
          current,
          "runtime_activation_failed",
          true
        );
      }
      try {
        if (input.recovery) {
          if (recoveryAlreadyRecorded) {
            // The durable CAS committed and its response was lost.  Reuse the
            // authoritative identity without advancing the revision again.
          } else {
            custody = await dependencies.custody.recordRecoveryActivation({
              operationId: current.operationId,
              receiptId: custody.receiptId,
              expectedCustodyRevision: custody.revision,
              ownerType: custody.ownerType,
              ownerId: custody.ownerId,
              channel: custody.channel,
              candidateFileRefId: custody.candidateFileRefId,
              expectedRuntimeHandle: custody.runtimeHandle,
              expectedRuntimeConsumerId: custody.runtimeConsumerId,
              expectedRuntimeGeneration: custody.runtimeGeneration,
              runtimeHandle: activated.data.handle,
              runtimeConsumerId: input.consumerId,
              runtimeGeneration: activated.data.session.sessionGeneration
            });
          }
        } else {
          custody = await dependencies.custody.recordActivation({
            operationId: current.operationId,
            expectedCustodyRevision: custody.revision,
            receiptId: custody.receiptId,
            runtimeHandle: activated.data.handle,
            runtimeGeneration: activated.data.session.sessionGeneration
          });
        }
      } catch {
        let readback = await dependencies.custody.readback(current.operationId);
        if (
          input.recovery &&
          exactActivatedCustody(
            readback,
            input.recovery.expectedCustody,
            input,
            activated.data
          )
        ) {
          custody = readback!;
        } else if (input.recovery) {
          await dependencies.runtime.closeSaveAsCandidate({
            receiptId: custody.receiptId,
            operationId: custody.operationId,
            processGeneration: custody.processGeneration,
            owner: {
              ownerType: custody.ownerType,
              ownerId: custody.ownerId,
              channel: custody.channel
            },
            candidateFileRefId: custody.candidateFileRefId,
            runtimeHandle: activated.data.handle,
            runtimeConsumerId: input.consumerId,
            runtimeGeneration: activated.data.session.sessionGeneration
          });
          return fail(
            "SAVE_AS_J0_CAS_CONFLICT",
            current,
            "stale_operation",
            true
          );
        } else {
          if (
            readback?.receiptId === custody.receiptId &&
            readback.custodyState === "activation_planned"
          ) {
            try {
              readback = await dependencies.custody.recordActivation({
                operationId: current.operationId,
                expectedCustodyRevision: readback.revision,
                receiptId: readback.receiptId,
                runtimeHandle: activated.data.handle,
                runtimeGeneration: activated.data.session.sessionGeneration
              });
            } catch {
              readback = await dependencies.custody.readback(current.operationId);
            }
          }
          if (
            !readback ||
            readback.receiptId !== custody.receiptId ||
            readback.runtimeHandle !== activated.data.handle ||
            readback.custodyState !== "activated_held"
          ) {
            const coordinator =
              createManuscriptSaveAsCandidateCleanupCoordinator({
                custody: dependencies.custody,
                runtime: dependencies.runtime,
                processLifecycle: {
                  async observeCurrentProcessGeneration() {
                    return {
                      processGeneration: current.producerProcessGeneration
                    };
                  }
                }
              });
            const disposition = await coordinator.automatic(
              current.operationId
            );
            return fail(
              "SAVE_AS_J0_RESPONSE_LOSS",
              current,
              "runtime_activation_failed",
              true,
              disposition
            );
          }
          custody = readback;
        }
      }
      if (
        input.recovery &&
        !exactActivatedCustody(
          custody,
          input.recovery.expectedCustody,
          input,
          activated.data
        )
      ) {
        return fail(
          "SAVE_AS_OPERATION_STALE",
          current,
          "stale_operation",
          true
        );
      }
      let presentationPending: SaveAsOperationRecord;
      try {
        presentationPending = await dependencies.operations.transition({
          operationId: current.operationId,
          expected: saveAsOperationExpectation(current),
          mutation: { intent: "enter_p4_presentation_pending" }
        });
      } catch {
        const readback = await dependencies.operations.readback(
          input.operationId
        );
        if (readback?.stage !== "p4_presentation_pending") {
          return fail(
            "SAVE_AS_J0_RESPONSE_LOSS",
            readback ?? current,
            "runtime_activation_failed",
            true
          );
        }
        presentationPending = readback;
      }
      return {
        ok: true,
        continuation: "close",
        value: {
          operation: presentationPending,
          runtime: activated.data,
          rawSource,
          gatewayRereadCount
          ,
          custody
        }
      };
    }
  });
}

export const manuscriptSaveAsRuntimeActivation =
  createManuscriptSaveAsRuntimeActivation({
    handoff: manuscriptSaveAsHandoffPort,
    gateway: rawManuscriptGateway,
    runtime: sharedManuscriptSessionRuntime,
    operations: manuscriptSaveAsOperationPort,
    custody: manuscriptSaveAsCandidateCustodyPort
  });

export function durableTargetFromFileRef(input: {
  fileRefId: string;
  absolutePath: string;
  pathIdentity: string;
  fileName: string;
  locationMode: "managed" | "external";
  configuredRoot?: string;
}): DurableSharedTargetSnapshot {
  const file: DurableFileIdentity = {
    kind: "durable",
    fileRefId: input.fileRefId,
    absolutePath: input.absolutePath,
    pathIdentity: input.pathIdentity,
    fileName: input.fileName,
    resourceKind: "file",
    fileRole: "manuscript",
    fileType: "markdown",
    locationMode: input.locationMode,
    configuredRoot: input.configuredRoot
  };
  return { file, readOnly: false };
}
