import {
  manuscriptSaveAsCandidateCleanupCoordinator,
  manuscriptSaveAsCandidateCustodyPort,
  type CandidateCustodyRecord,
  type CandidateDisposition
} from "./manuscriptSaveAsCandidateCustody";
import {
  manuscriptSaveAsFinalizationPort,
  type LifecycleDecisionReceipt,
  type SaveAsFinalizationPort,
  type SaveAsFinalizationRecord
} from "./manuscriptSaveAsFinalizationPort";
import type {
  ManuscriptCandidateCustodyReceipt,
  ManuscriptCandidateCustodyRequest,
  ManuscriptSaveAsLifecycleRegistry
} from "./manuscriptSaveAsLifecycleRegistry";
import { manuscriptSaveAsOperationPort } from "./manuscriptSaveAsOperationPort";

export interface PresentedSaveAsCandidate {
  operationId: string;
  fileRefId: string;
  independentSessionKey: string;
  candidateCustody: ManuscriptCandidateCustodyReceipt;
}

export type SaveAsFinalizationTrigger =
  | "IMMEDIATE_RECEIPT"
  | "STARTUP_RECOVERY"
  | "PENDING_SCAN"
  | "EXPLICIT_RETRY";

type FinalizationSuccess = {
  status: "finalized";
  finalization: SaveAsFinalizationRecord;
  installedSessionKey: string;
  displacedSessionKey?: string;
  replacementGeneration: number;
  custody: CandidateCustodyRecord;
};

type FinalizationFailure = {
  status: "compensated" | "blocked";
  finalization: SaveAsFinalizationRecord;
  candidateDisposition: CandidateDisposition;
  errorCode:
    | "SAVE_AS_OPERATION_STALE"
    | "SAVE_AS_J0_RESPONSE_LOSS";
};

interface FinalizationDependencies {
  finalization: SaveAsFinalizationPort;
  custody: Pick<
    typeof manuscriptSaveAsCandidateCustodyPort,
    "readback" | "transfer"
  >;
  cleanup: Pick<
    typeof manuscriptSaveAsCandidateCleanupCoordinator,
    "automatic"
  >;
  operations: Pick<
    typeof manuscriptSaveAsOperationPort,
    "listReconcilable"
  >;
}

const defaultDependencies: FinalizationDependencies = {
  finalization: manuscriptSaveAsFinalizationPort,
  custody: manuscriptSaveAsCandidateCustodyPort,
  cleanup: manuscriptSaveAsCandidateCleanupCoordinator,
  operations: manuscriptSaveAsOperationPort
};

export function createManuscriptSaveAsFinalizationCoordinator(
  dependencies: FinalizationDependencies = defaultDependencies
) {
  let claimGeneration = 0;

  async function readCustody(
    operationId: string,
    receiptId: string
  ) {
    const custody = await dependencies.custody.readback(operationId);
    if (!custody || custody.receiptId !== receiptId) {
      throw new Error("SAVE_AS_FINALIZATION_CUSTODY_CONFLICT");
    }
    return custody;
  }

  async function transferCustody(
    custody: CandidateCustodyRecord,
    nextAuthority:
      | "outputs_lifecycle"
      | "installed_session"
      | "durable_cleanup"
  ) {
    if (
      custody.currentCustodyAuthority === nextAuthority ||
      custody.currentCustodyAuthority === "resolved"
    ) {
      return custody;
    }
    try {
      return await dependencies.custody.transfer({
        operationId: custody.operationId,
        expectedCustodyRevision: custody.revision,
        receiptId: custody.receiptId,
        nextAuthority
      });
    } catch (cause) {
      const readback = await readCustody(
        custody.operationId,
        custody.receiptId
      );
      if (
        readback.currentCustodyAuthority === nextAuthority ||
        readback.currentCustodyAuthority === "resolved"
      ) {
        return readback;
      }
      throw cause;
    }
  }

  async function issueRequest(
    presented: PresentedSaveAsCandidate,
    request: ManuscriptCandidateCustodyRequest,
    presentation: SaveAsFinalizationRecord
  ) {
    const lease = request.ownerLease;
    try {
      return await dependencies.finalization.issueRequest({
        operationId: presented.operationId,
        expectedFinalizationRevision: presentation.revision,
        receiptId: presented.candidateCustody.receiptId,
        ownerInstanceToken: lease.ownerInstanceToken,
        mountToken: lease.mountToken,
        leaseToken: lease.leaseToken,
        mountGeneration: lease.mountGeneration,
        replacementGeneration: request.replacementGeneration
      });
    } catch (cause) {
      const readback = await dependencies.finalization.readback(
        presented.operationId
      );
      if (
        readback?.receiptId ===
          presented.candidateCustody.receiptId &&
        readback.finalizationRequestId &&
        readback.acknowledgementNonce &&
        readback.ownerInstanceToken === lease.ownerInstanceToken &&
        readback.mountToken === lease.mountToken &&
        readback.leaseToken === lease.leaseToken &&
        readback.mountGeneration === lease.mountGeneration &&
        readback.replacementGeneration ===
          request.replacementGeneration
      ) {
        return readback;
      }
      throw cause;
    }
  }

  async function claim(
    current: SaveAsFinalizationRecord
  ) {
    const generation = ++claimGeneration;
    try {
      return await dependencies.finalization.claim({
        operationId: current.operationId,
        expectedFinalizationRevision: current.revision,
        finalizationRequestId: current.finalizationRequestId!,
        claimGeneration: generation
      });
    } catch (cause) {
      const readback = await dependencies.finalization.readback(
        current.operationId
      );
      if (
        readback?.finalizationRequestId ===
          current.finalizationRequestId &&
        readback?.claimToken &&
        readback?.claimNamespace === "save_as_finalization"
      ) {
        return readback;
      }
      throw cause;
    }
  }

  async function recordDecision(
    current: SaveAsFinalizationRecord,
    receipt: LifecycleDecisionReceipt
  ) {
    try {
      return await dependencies.finalization.recordDecision({
        expectedFinalizationRevision: current.revision,
        claimToken: current.claimToken!,
        receipt
      });
    } catch (cause) {
      const readback = await dependencies.finalization.readback(
        current.operationId
      );
      if (
        readback?.lifecycleDecisionId ===
          receipt.lifecycleDecisionId &&
        readback.provisionalInstallId ===
          receipt.provisionalInstallId &&
        readback.lifecycleDecision === receipt.decision
      ) {
        return readback;
      }
      throw cause;
    }
  }

  async function compensate(input: {
    presented: PresentedSaveAsCandidate;
    lifecycle: ManuscriptSaveAsLifecycleRegistry;
    request: ManuscriptCandidateCustodyRequest;
    current: SaveAsFinalizationRecord;
    provisionalInstallId?: string;
  }): Promise<FinalizationFailure | FinalizationSuccess> {
    let current =
      (await dependencies.finalization.readback(
        input.presented.operationId
      )) ?? input.current;
    if (current.finalizationState === "finalized") {
      return commitFinalized({
        ...input,
        current,
        provisionalInstallId:
          current.provisionalInstallId ??
          input.provisionalInstallId!
      });
    }

    if (input.provisionalInstallId) {
      const lease = input.request.ownerLease;
      const revoked = input.lifecycle.revokeInstall({
        request: input.request,
        operationId: input.presented.operationId,
        receiptId: input.presented.candidateCustody.receiptId,
        finalizationRequestId: current.finalizationRequestId!,
        provisionalInstallId: input.provisionalInstallId,
        ownerInstanceToken: lease.ownerInstanceToken,
        mountGeneration: lease.mountGeneration,
        replacementGeneration:
          input.request.replacementGeneration
      });
      if (revoked.status !== "revoked") {
        const blocked =
          await dependencies.finalization.block({
            operationId: current.operationId,
            expectedFinalizationRevision: current.revision,
            claimToken: current.claimToken!
          });
        return {
          status: "blocked",
          finalization: blocked,
          candidateDisposition: {
            kind: "RESIDUAL",
            receiptId: input.presented.candidateCustody.receiptId,
            operationId: input.presented.operationId,
            cleanupState: "cleanup_blocked"
          },
          errorCode: "SAVE_AS_J0_RESPONSE_LOSS"
        };
      }
      try {
        current = await dependencies.finalization.recordRevoked({
          expectedFinalizationRevision: current.revision,
          claimToken: current.claimToken!,
          receipt: revoked.decision
        });
      } catch (cause) {
        const readback = await dependencies.finalization.readback(
          current.operationId
        );
        if (
          readback?.revokeDecisionId ===
            revoked.decision.lifecycleDecisionId &&
          readback.finalizationState === "revoked"
        ) {
          current = readback;
        } else {
          throw cause;
        }
      }
    }

    let custody = await readCustody(
      input.presented.operationId,
      input.presented.candidateCustody.receiptId
    );
    custody = await transferCustody(custody, "durable_cleanup");
    const disposition = await dependencies.cleanup.automatic(
      input.presented.operationId
    );
    const terminal =
      disposition.kind === "CLOSED" ||
      disposition.kind === "NOT_ACTIVATED"
        ? await dependencies.finalization.completeCompensation({
            operationId: current.operationId,
            expectedFinalizationRevision: current.revision,
            claimToken: current.claimToken!
          })
        : await dependencies.finalization.block({
            operationId: current.operationId,
            expectedFinalizationRevision: current.revision,
            claimToken: current.claimToken!
          });
    return {
      status:
        terminal.finalizationState === "compensated"
          ? "compensated"
          : "blocked",
      finalization: terminal,
      candidateDisposition: disposition,
      errorCode:
        terminal.finalizationState === "compensated"
          ? "SAVE_AS_OPERATION_STALE"
          : "SAVE_AS_J0_RESPONSE_LOSS"
    };
  }

  async function commitFinalized(input: {
    presented: PresentedSaveAsCandidate;
    lifecycle: ManuscriptSaveAsLifecycleRegistry;
    request: ManuscriptCandidateCustodyRequest;
    current: SaveAsFinalizationRecord;
    provisionalInstallId: string;
  }): Promise<FinalizationSuccess> {
    const readback =
      (await dependencies.finalization.readback(
        input.presented.operationId
      )) ?? input.current;
    if (
      readback.finalizationState !== "finalized" ||
      readback.provisionalInstallId !== input.provisionalInstallId
    ) {
      throw new Error("SAVE_AS_FINALIZATION_RESPONSE_UNKNOWN");
    }
    const committed = input.lifecycle.commitInstall({
      request: input.request,
      operationId: input.presented.operationId,
      receiptId: input.presented.candidateCustody.receiptId,
      finalizationRequestId: readback.finalizationRequestId!,
      provisionalInstallId: input.provisionalInstallId,
      durableFinalization: readback
    });
    if (committed.status !== "committed") {
      throw new Error("SAVE_AS_LIFECYCLE_COMMIT_FAILED");
    }
    let custody = await readCustody(
      input.presented.operationId,
      input.presented.candidateCustody.receiptId
    );
    custody = await transferCustody(custody, "installed_session");
    return {
      status: "finalized",
      finalization: readback,
      installedSessionKey: committed.handle,
      displacedSessionKey: committed.displacedHandle,
      replacementGeneration: committed.replacementGeneration,
      custody
    };
  }

  async function finalize(input: {
    trigger: SaveAsFinalizationTrigger;
    presented: PresentedSaveAsCandidate;
    lifecycle: ManuscriptSaveAsLifecycleRegistry;
    sourceDisposition: "retain" | "release";
  }): Promise<FinalizationSuccess | FinalizationFailure> {
    const request = input.presented.candidateCustody.request;
    const initial = await dependencies.finalization.readback(
      input.presented.operationId
    );
    if (!initial) {
      throw new Error("SAVE_AS_FINALIZATION_RESPONSE_UNKNOWN");
    }
    let current: SaveAsFinalizationRecord = initial;
    if (current.finalizationState === "finalized") {
      return commitFinalized({
        ...input,
        request,
        current,
        provisionalInstallId: current.provisionalInstallId!
      });
    }
    if (current.finalizationState === "compensated") {
      return {
        status: "compensated",
        finalization: current,
        candidateDisposition: {
          kind: "CLOSED",
          receiptId: current.receiptId
        },
        errorCode: "SAVE_AS_OPERATION_STALE"
      };
    }
    if (!current.finalizationRequestId) {
      current = await issueRequest(
        input.presented,
        request,
        current
      );
    }
    if (!current.claimToken) {
      current = await claim(current);
    }

    const prepared = input.lifecycle.prepareInstall({
      request,
      receipt: input.presented.candidateCustody,
      finalization: current,
      expectedFileRefId: input.presented.fileRefId,
      sourceDisposition: input.sourceDisposition
    });
    if (prepared.status !== "prepared") {
      current = await recordDecision(current, prepared.decision);
      return compensate({
        ...input,
        request,
        current
      });
    }
    current = await recordDecision(current, prepared.decision);
    let custody = await readCustody(
      input.presented.operationId,
      input.presented.candidateCustody.receiptId
    );
    custody = await transferCustody(custody, "outputs_lifecycle");

    const installed = input.lifecycle.markInstalled({
      request,
      receipt: input.presented.candidateCustody,
      finalization: current,
      provisionalInstallId: prepared.provisionalInstallId
    });
    if (installed.status !== "installed") {
      current = await recordDecision(current, installed.decision);
      return compensate({
        ...input,
        request,
        current,
        provisionalInstallId: prepared.provisionalInstallId
      });
    }
    current = await recordDecision(current, installed.decision);
    try {
      current = await dependencies.finalization.finalize({
        operationId: current.operationId,
        expectedFinalizationRevision: current.revision,
        claimToken: current.claimToken!,
        lifecycleDecisionId:
          installed.decision.lifecycleDecisionId,
        provisionalInstallId: prepared.provisionalInstallId
      });
    } catch (cause) {
      const readback = await dependencies.finalization.readback(
        current.operationId
      );
      if (readback?.finalizationState === "finalized") {
        current = readback;
      } else {
        return compensate({
          ...input,
          request,
          current,
          provisionalInstallId: prepared.provisionalInstallId
        });
      }
    }
    return commitFinalized({
      ...input,
      request,
      current,
      provisionalInstallId: prepared.provisionalInstallId
    });
  }

  async function reconcile(input: {
    trigger: SaveAsFinalizationTrigger;
    operationId: string;
    presented?: PresentedSaveAsCandidate;
    lifecycle: ManuscriptSaveAsLifecycleRegistry;
    sourceDisposition: "retain" | "release";
  }) {
    const current = await dependencies.finalization.readback(
      input.operationId
    );
    if (!current) return { status: "not-found" as const };
    if (current.finalizationState === "finalized") {
      if (!input.presented) {
        return {
          status: "finalized-reopen-by-file-ref" as const,
          fileRefId: current.candidateFileRefId,
          finalization: current
        };
      }
      return finalize({
        trigger: input.trigger,
        presented: input.presented,
        lifecycle: input.lifecycle,
        sourceDisposition: input.sourceDisposition
      });
    }
    if (!input.presented) {
      return {
        status:
          current.finalizationState === "compensated"
            ? ("compensated" as const)
            : ("pending" as const),
        finalization: current
      };
    }
    return finalize({
      trigger: input.trigger,
      presented: input.presented,
      lifecycle: input.lifecycle,
      sourceDisposition: input.sourceDisposition
    });
  }

  async function reject(input: {
    trigger: SaveAsFinalizationTrigger;
    presented: PresentedSaveAsCandidate;
    lifecycle: ManuscriptSaveAsLifecycleRegistry;
    decision:
      | "rejected"
      | "stale"
      | "owner_unavailable"
      | "identity_mismatch"
      | "install_failed";
  }): Promise<FinalizationFailure | FinalizationSuccess> {
    const request = input.presented.candidateCustody.request;
    const initial = await dependencies.finalization.readback(
      input.presented.operationId
    );
    if (!initial) {
      throw new Error("SAVE_AS_FINALIZATION_RESPONSE_UNKNOWN");
    }
    let current: SaveAsFinalizationRecord = initial;
    if (current.finalizationState === "finalized") {
      return commitFinalized({
        ...input,
        request,
        current,
        provisionalInstallId: current.provisionalInstallId!
      });
    }
    if (!current.finalizationRequestId) {
      current = await issueRequest(
        input.presented,
        request,
        current
      );
    }
    if (!current.claimToken) current = await claim(current);
    const decision = input.lifecycle.rejectInstall({
      request,
      receipt: input.presented.candidateCustody,
      finalization: current,
      decision: input.decision
    });
    current = await recordDecision(current, decision);
    return compensate({
      presented: input.presented,
      lifecycle: input.lifecycle,
      request,
      current
    });
  }

  async function discover(
    trigger: Exclude<SaveAsFinalizationTrigger, "IMMEDIATE_RECEIPT">
  ) {
    const [pendingFinalizations, reconcilableOperations] =
      await Promise.all([
        dependencies.finalization.listPending(),
        dependencies.operations.listReconcilable()
      ]);
    return Object.freeze({
      trigger,
      pendingFinalizations,
      reconcilableOperations,
      operationIds: [
        ...new Set([
          ...pendingFinalizations.map((record) => record.operationId),
          ...reconcilableOperations.map((record) => record.operationId)
        ])
      ]
    });
  }

  return Object.freeze({ finalize, reject, reconcile, discover });
}

export const manuscriptSaveAsFinalizationCoordinator =
  createManuscriptSaveAsFinalizationCoordinator();

export type ManuscriptSaveAsFinalizationCoordinator =
  ReturnType<
    typeof createManuscriptSaveAsFinalizationCoordinator
  >;
