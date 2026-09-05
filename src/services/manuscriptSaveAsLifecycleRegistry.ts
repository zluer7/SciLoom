import type { ManuscriptChannel } from "../types";
import type { FileRefOwnerType } from "../types/experiment";
import type { SharedManuscriptSessionHandle } from "../types/sharedManuscriptSession";
import type {
  LifecycleDecision,
  LifecycleDecisionReceipt,
  SaveAsFinalizationRecord
} from "./manuscriptSaveAsFinalizationPort";

export type ManuscriptSaveAsProducer = "save-as" | "recovery";

export interface ManuscriptOwnerMountLease {
  readonly ownerType: FileRefOwnerType;
  readonly ownerId: string;
  readonly channel: ManuscriptChannel;
  readonly ownerInstanceToken: string;
  readonly mountToken: string;
  readonly leaseToken: string;
  readonly mountGeneration: number;
}

export interface ManuscriptCandidateCustodyRequest {
  readonly ownerLease: ManuscriptOwnerMountLease;
  readonly candidateToken: string;
  readonly consumerScopeId: string;
  readonly producer: ManuscriptSaveAsProducer;
  readonly sourceWindowRole?: "current" | "independent";
  readonly sourceRuntimeHandle?: SharedManuscriptSessionHandle;
  readonly replacementGeneration: number;
}

export interface ManuscriptCandidateCustodyReceipt {
  readonly request: ManuscriptCandidateCustodyRequest;
  readonly handle: SharedManuscriptSessionHandle;
  readonly ownerType: FileRefOwnerType;
  readonly ownerId: string;
  readonly channel: ManuscriptChannel;
  readonly producer: ManuscriptSaveAsProducer;
  readonly operationId: string;
  readonly consumerId: string;
  readonly fileRefId: string;
  readonly receiptId: string;
  readonly receiptVersion: 1;
  readonly processGeneration: string;
  readonly runtimeGeneration: number;
  readonly currentCustodyAuthority:
    | "outputs_adapter"
    | "outputs_lifecycle"
    | "installed_session";
}

type CandidateTerminal =
  | "installed"
  | "closed"
  | "already-absent"
  | "cleanup-blocked"
  | "rejected";

interface ProvisionalInstall {
  provisionalInstallId: string;
  lifecycleDecisionId: string;
  request: ManuscriptCandidateCustodyRequest;
  receipt: ManuscriptCandidateCustodyReceipt;
  finalizationRequestId: string;
  acknowledgementNonce: string;
  sourceDisposition: "retain" | "release";
  displacedHandle?: SharedManuscriptSessionHandle;
  state: "prepared" | "installed" | "committed" | "revoked";
  decisionReceipt: LifecycleDecisionReceipt;
  revokeReceipt?: LifecycleDecisionReceipt;
}

interface OwnerMountState {
  lease: ManuscriptOwnerMountLease;
  active: boolean;
  replacementGeneration: number;
  currentHandle?: SharedManuscriptSessionHandle;
  independentHandle?: SharedManuscriptSessionHandle;
  retainedIndependentHandles: Set<SharedManuscriptSessionHandle>;
  candidates: Map<
    string,
    {
      request: ManuscriptCandidateCustodyRequest;
      terminal?: CandidateTerminal;
    }
  >;
  provisional: Map<string, ProvisionalInstall>;
}

function authorityId() {
  return crypto.randomUUID();
}

function sameOwner(
  left: ManuscriptOwnerMountLease,
  right: ManuscriptOwnerMountLease
) {
  return (
    left.ownerType === right.ownerType &&
    left.ownerId === right.ownerId &&
    left.channel === right.channel
  );
}

export function createManuscriptSaveAsLifecycleRegistry() {
  const ownerInstanceToken = authorityId();
  const consumerScopeId = authorityId();
  const mounts = new Map<string, OwnerMountState>();
  const decisions = new Map<string, LifecycleDecisionReceipt>();
  const requestToProvisional = new Map<string, ProvisionalInstall>();
  let mountGeneration = 0;

  function stateFor(lease: ManuscriptOwnerMountLease) {
    const state = mounts.get(lease.leaseToken);
    return state?.lease === lease ? state : undefined;
  }

  function mountOwner(
    ownerType: FileRefOwnerType,
    ownerId: string,
    channel: ManuscriptChannel
  ): ManuscriptOwnerMountLease {
    const lease = Object.freeze({
      ownerType,
      ownerId,
      channel,
      ownerInstanceToken,
      mountToken: authorityId(),
      leaseToken: authorityId(),
      mountGeneration: ++mountGeneration
    });
    mounts.set(lease.leaseToken, {
      lease,
      active: true,
      replacementGeneration: 0,
      retainedIndependentHandles: new Set(),
      candidates: new Map(),
      provisional: new Map()
    });
    return lease;
  }

  function isCurrentLease(lease: ManuscriptOwnerMountLease) {
    return stateFor(lease)?.active === true;
  }

  function protectHandle(
    lease: ManuscriptOwnerMountLease,
    role: "current" | "independent",
    handle: SharedManuscriptSessionHandle | undefined
  ) {
    const state = stateFor(lease);
    if (!state?.active) return false;
    if (role === "current") state.currentHandle = handle;
    else state.independentHandle = handle;
    return true;
  }

  function focusIndependent(
    lease: ManuscriptOwnerMountLease,
    handle: SharedManuscriptSessionHandle
  ) {
    const state = stateFor(lease);
    if (!state?.active) return false;
    const displacedHandle = state.independentHandle;
    if (displacedHandle && displacedHandle !== handle) {
      state.retainedIndependentHandles.add(displacedHandle);
    }
    state.retainedIndependentHandles.delete(handle);
    state.independentHandle = handle;
    return true;
  }

  function listIndependentHandles(
    lease: ManuscriptOwnerMountLease
  ) {
    const state = stateFor(lease);
    if (!state?.active) return [];
    return [
      ...(state.independentHandle
        ? [state.independentHandle]
        : []),
      ...state.retainedIndependentHandles
    ];
  }

  function unmountOwner(lease: ManuscriptOwnerMountLease) {
    const state = stateFor(lease);
    if (!state) return false;
    state.active = false;
    state.currentHandle = undefined;
    state.independentHandle = undefined;
    state.retainedIndependentHandles.clear();
    if (state.candidates.size === 0 && state.provisional.size === 0) {
      mounts.delete(lease.leaseToken);
    }
    return true;
  }

  function beginCandidate(input: {
    ownerLease: ManuscriptOwnerMountLease;
    producer: ManuscriptSaveAsProducer;
    sourceWindowRole?: "current" | "independent";
    sourceRuntimeHandle?: SharedManuscriptSessionHandle;
  }): ManuscriptCandidateCustodyRequest | undefined {
    const state = stateFor(input.ownerLease);
    if (!state?.active) return undefined;
    const request = Object.freeze({
      ownerLease: input.ownerLease,
      candidateToken: authorityId(),
      consumerScopeId,
      producer: input.producer,
      sourceWindowRole: input.sourceWindowRole,
      sourceRuntimeHandle: input.sourceRuntimeHandle,
      replacementGeneration: state.replacementGeneration
    });
    state.candidates.set(request.candidateToken, { request });
    return request;
  }

  function verifyReceipt(
    receipt: ManuscriptCandidateCustodyReceipt | undefined
  ) {
    if (!receipt) return false;
    const state = stateFor(receipt.request.ownerLease);
    const candidate = state?.candidates.get(
      receipt.request.candidateToken
    );
    return Boolean(
      state &&
        candidate?.request === receipt.request &&
        candidate.terminal === undefined &&
        sameOwner(state.lease, receipt.request.ownerLease) &&
        receipt.ownerType === state.lease.ownerType &&
        receipt.ownerId === state.lease.ownerId &&
        receipt.channel === state.lease.channel &&
        receipt.producer === receipt.request.producer &&
        receipt.consumerId.trim() &&
        receipt.operationId.trim() &&
        receipt.fileRefId.trim() &&
        receipt.receiptId.trim() &&
        receipt.handle
    );
  }

  function isCandidateCurrent(
    request: ManuscriptCandidateCustodyRequest
  ) {
    const state = stateFor(request.ownerLease);
    const candidate = state?.candidates.get(request.candidateToken);
    return Boolean(
      state?.active &&
        candidate?.request === request &&
        candidate.terminal === undefined &&
        state.replacementGeneration === request.replacementGeneration
    );
  }

  function isProtected(
    handle: SharedManuscriptSessionHandle,
    excluding?: ManuscriptCandidateCustodyRequest
  ) {
    for (const state of mounts.values()) {
      if (
        state.currentHandle === handle ||
        state.independentHandle === handle ||
        state.retainedIndependentHandles.has(handle)
      ) {
        return true;
      }
      for (const candidate of state.candidates.values()) {
        if (
          candidate.terminal === undefined &&
          candidate.request !== excluding &&
          candidate.request.sourceRuntimeHandle === handle
        ) {
          return true;
        }
      }
      for (const provisional of state.provisional.values()) {
        if (
          (provisional.state === "prepared" ||
            provisional.state === "installed") &&
          provisional.receipt.handle === handle
        ) {
          return true;
        }
      }
    }
    return false;
  }

  function decisionReceipt(
    input: {
      finalization: SaveAsFinalizationRecord;
      request: ManuscriptCandidateCustodyRequest;
      receipt: ManuscriptCandidateCustodyReceipt;
      provisionalInstallId: string;
      lifecycleDecisionId: string;
    },
    decision: LifecycleDecision
  ): LifecycleDecisionReceipt {
    const lease = input.request.ownerLease;
    return Object.freeze({
      decisionVersion: 1,
      lifecycleDecisionId: input.lifecycleDecisionId,
      finalizationRequestId:
        input.finalization.finalizationRequestId!,
      acknowledgementNonce:
        input.finalization.acknowledgementNonce!,
      operationId: input.receipt.operationId,
      receiptId: input.receipt.receiptId,
      ownerType: input.receipt.ownerType,
      ownerId: input.receipt.ownerId,
      channel: input.receipt.channel,
      candidateFileRefId: input.receipt.fileRefId,
      ownerInstanceToken: lease.ownerInstanceToken,
      mountToken: lease.mountToken,
      leaseToken: lease.leaseToken,
      mountGeneration: lease.mountGeneration,
      replacementGeneration:
        input.request.replacementGeneration,
      provisionalInstallId: input.provisionalInstallId,
      decision,
      decisionCreatedAt: new Date().toISOString()
    });
  }

  function finalizationMatches(
    finalization: SaveAsFinalizationRecord,
    request: ManuscriptCandidateCustodyRequest,
    receipt: ManuscriptCandidateCustodyReceipt
  ) {
    const lease = request.ownerLease;
    return Boolean(
      finalization.finalizationRequestId &&
        finalization.acknowledgementNonce &&
        finalization.operationId === receipt.operationId &&
        finalization.receiptId === receipt.receiptId &&
        finalization.ownerType === lease.ownerType &&
        finalization.ownerId === lease.ownerId &&
        finalization.channel === receipt.channel &&
        finalization.candidateFileRefId === receipt.fileRefId &&
        finalization.ownerInstanceToken ===
          lease.ownerInstanceToken &&
        finalization.mountToken === lease.mountToken &&
        finalization.leaseToken === lease.leaseToken &&
        finalization.mountGeneration === lease.mountGeneration &&
        finalization.replacementGeneration ===
          request.replacementGeneration
    );
  }

  function rejectInstall(input: {
    request: ManuscriptCandidateCustodyRequest;
    receipt: ManuscriptCandidateCustodyReceipt;
    finalization: SaveAsFinalizationRecord;
    decision: Extract<
      LifecycleDecision,
      | "rejected"
      | "stale"
      | "owner_unavailable"
      | "identity_mismatch"
      | "install_failed"
    >;
  }) {
    const existing = input.finalization.finalizationRequestId
      ? decisions.get(input.finalization.finalizationRequestId)
      : undefined;
    if (existing) return existing;
    const provisionalInstallId = authorityId();
    const lifecycleDecisionId = authorityId();
    const receipt = decisionReceipt(
      {
        ...input,
        provisionalInstallId,
        lifecycleDecisionId
      },
      input.decision
    );
    decisions.set(receipt.finalizationRequestId, receipt);
    return receipt;
  }

  function prepareInstall(input: {
    request: ManuscriptCandidateCustodyRequest;
    receipt: ManuscriptCandidateCustodyReceipt;
    finalization: SaveAsFinalizationRecord;
    expectedFileRefId: string;
    sourceDisposition: "retain" | "release";
  }) {
    const existing = input.finalization.finalizationRequestId
      ? requestToProvisional.get(
          input.finalization.finalizationRequestId
        )
      : undefined;
    if (existing) {
      return existing.state === "revoked"
        ? { status: "rejected" as const, decision: existing.revokeReceipt! }
        : {
            status: "prepared" as const,
            provisionalInstallId: existing.provisionalInstallId,
            decision: existing.decisionReceipt,
            displacedHandle: existing.displacedHandle
          };
    }
    const state = stateFor(input.request.ownerLease);
    if (
      !state?.active ||
      state.replacementGeneration !==
        input.request.replacementGeneration ||
      !verifyReceipt(input.receipt) ||
      input.receipt.request !== input.request ||
      input.receipt.fileRefId !== input.expectedFileRefId ||
      !finalizationMatches(
        input.finalization,
        input.request,
        input.receipt
      ) ||
      isProtected(input.receipt.handle, input.request)
    ) {
      return {
        status: "rejected" as const,
        decision: rejectInstall({
          ...input,
          decision: "stale"
        })
      };
    }
    const displacedHandle = state.independentHandle;
    if (
      input.sourceDisposition === "retain" &&
      (input.request.sourceWindowRole !== "independent" ||
        !displacedHandle ||
        displacedHandle !== input.request.sourceRuntimeHandle)
    ) {
      return {
        status: "rejected" as const,
        decision: rejectInstall({
          ...input,
          decision: "identity_mismatch"
        })
      };
    }
    const provisionalInstallId = authorityId();
    const lifecycleDecisionId = authorityId();
    const receipt = decisionReceipt(
      {
        ...input,
        provisionalInstallId,
        lifecycleDecisionId
      },
      "prepared"
    );
    const provisional: ProvisionalInstall = {
      provisionalInstallId,
      lifecycleDecisionId,
      request: input.request,
      receipt: input.receipt,
      finalizationRequestId: receipt.finalizationRequestId,
      acknowledgementNonce: receipt.acknowledgementNonce,
      sourceDisposition: input.sourceDisposition,
      displacedHandle,
      state: "prepared",
      decisionReceipt: receipt
    };
    state.provisional.set(provisionalInstallId, provisional);
    requestToProvisional.set(receipt.finalizationRequestId, provisional);
    decisions.set(receipt.finalizationRequestId, receipt);
    return {
      status: "prepared" as const,
      provisionalInstallId,
      decision: receipt,
      displacedHandle
    };
  }

  function markInstalled(input: {
    request: ManuscriptCandidateCustodyRequest;
    receipt: ManuscriptCandidateCustodyReceipt;
    finalization: SaveAsFinalizationRecord;
    provisionalInstallId: string;
  }) {
    const state = stateFor(input.request.ownerLease);
    const provisional =
      state?.provisional.get(input.provisionalInstallId) ??
      requestToProvisional.get(
        input.finalization.finalizationRequestId!
      );
    if (
      !state?.active ||
      !provisional ||
      provisional.request !== input.request ||
      provisional.receipt !== input.receipt ||
      provisional.state === "revoked" ||
      !finalizationMatches(
        input.finalization,
        input.request,
        input.receipt
      )
    ) {
      return {
        status: "rejected" as const,
        decision: rejectInstall({
          ...input,
          decision: "stale"
        })
      };
    }
    if (provisional.state === "installed") {
      return {
        status: "installed" as const,
        provisionalInstallId: provisional.provisionalInstallId,
        decision: provisional.decisionReceipt
      };
    }
    const installed = decisionReceipt(
      {
        ...input,
        lifecycleDecisionId: provisional.lifecycleDecisionId
      },
      "installed"
    );
    provisional.state = "installed";
    provisional.decisionReceipt = installed;
    decisions.set(installed.finalizationRequestId, installed);
    return {
      status: "installed" as const,
      provisionalInstallId: provisional.provisionalInstallId,
      decision: installed
    };
  }

  function commitInstall(input: {
    request: ManuscriptCandidateCustodyRequest;
    operationId: string;
    receiptId: string;
    finalizationRequestId: string;
    provisionalInstallId: string;
    durableFinalization: SaveAsFinalizationRecord;
  }) {
    const state = stateFor(input.request.ownerLease);
    const provisional =
      state?.provisional.get(input.provisionalInstallId) ??
      requestToProvisional.get(input.finalizationRequestId);
    if (provisional?.state === "committed") {
      return {
        status: "committed" as const,
        handle: provisional.receipt.handle,
        displacedHandle:
          provisional.sourceDisposition === "release"
            ? provisional.displacedHandle
            : undefined,
        replacementGeneration: state!.replacementGeneration
      };
    }
    if (
      !state?.active ||
      !provisional ||
      provisional.state !== "installed" ||
      provisional.request !== input.request ||
      provisional.receipt.operationId !== input.operationId ||
      provisional.receipt.receiptId !== input.receiptId ||
      provisional.finalizationRequestId !==
        input.finalizationRequestId ||
      input.durableFinalization.finalizationState !== "finalized" ||
      input.durableFinalization.operationId !== input.operationId ||
      input.durableFinalization.receiptId !== input.receiptId ||
      input.durableFinalization.finalizationRequestId !==
        input.finalizationRequestId ||
      input.durableFinalization.provisionalInstallId !==
        input.provisionalInstallId
    ) {
      return { status: "rejected" as const };
    }
    if (
      provisional.sourceDisposition === "retain" &&
      provisional.displacedHandle
    ) {
      state.retainedIndependentHandles.add(
        provisional.displacedHandle
      );
    } else if (provisional.displacedHandle) {
      state.retainedIndependentHandles.delete(
        provisional.displacedHandle
      );
    }
    state.retainedIndependentHandles.delete(
      provisional.receipt.handle
    );
    state.replacementGeneration += 1;
    state.independentHandle = provisional.receipt.handle;
    provisional.state = "committed";
    const candidate = state.candidates.get(
      input.request.candidateToken
    );
    if (candidate) candidate.terminal = "installed";
    state.candidates.delete(input.request.candidateToken);
    return {
      status: "committed" as const,
      handle: provisional.receipt.handle,
      displacedHandle:
        provisional.sourceDisposition === "release"
          ? provisional.displacedHandle
          : undefined,
      replacementGeneration: state.replacementGeneration
    };
  }

  function revokeInstall(input: {
    request: ManuscriptCandidateCustodyRequest;
    operationId: string;
    receiptId: string;
    finalizationRequestId: string;
    provisionalInstallId: string;
    ownerInstanceToken: string;
    mountGeneration: number;
    replacementGeneration: number;
  }) {
    const state = stateFor(input.request.ownerLease);
    const provisional =
      state?.provisional.get(input.provisionalInstallId) ??
      requestToProvisional.get(input.finalizationRequestId);
    if (
      !state ||
      !provisional ||
      provisional.provisionalInstallId !==
        input.provisionalInstallId ||
      provisional.request !== input.request ||
      provisional.receipt.operationId !== input.operationId ||
      provisional.receipt.receiptId !== input.receiptId ||
      provisional.finalizationRequestId !==
        input.finalizationRequestId ||
      state.lease.ownerInstanceToken !== input.ownerInstanceToken ||
      state.lease.mountGeneration !== input.mountGeneration ||
      provisional.request.replacementGeneration !==
        input.replacementGeneration
    ) {
      return { status: "rejected" as const };
    }
    if (
      provisional.state === "revoked" &&
      provisional.revokeReceipt
    ) {
      return {
        status: "revoked" as const,
        decision: provisional.revokeReceipt
      };
    }
    if (provisional.state === "committed") {
      return { status: "rejected" as const };
    }
    const revoked = decisionReceipt(
      {
        request: provisional.request,
        receipt: provisional.receipt,
        finalization: {
          operationId: provisional.receipt.operationId,
          receiptId: provisional.receipt.receiptId,
          ownerType: provisional.receipt.ownerType,
          ownerId: provisional.receipt.ownerId,
          channel: provisional.receipt.channel,
          candidateFileRefId: provisional.receipt.fileRefId,
          finalizationRequestId:
            provisional.finalizationRequestId,
          acknowledgementNonce:
            provisional.acknowledgementNonce,
          ownerInstanceToken: state.lease.ownerInstanceToken,
          mountToken: state.lease.mountToken,
          leaseToken: state.lease.leaseToken,
          mountGeneration: state.lease.mountGeneration,
          replacementGeneration:
            provisional.request.replacementGeneration
        } as SaveAsFinalizationRecord,
        provisionalInstallId: provisional.provisionalInstallId,
        lifecycleDecisionId: authorityId()
      },
      "revoked"
    );
    provisional.state = "revoked";
    provisional.revokeReceipt = revoked;
    state.provisional.delete(input.provisionalInstallId);
    const candidate = state.candidates.get(
      input.request.candidateToken
    );
    if (candidate) candidate.terminal = "rejected";
    state.candidates.delete(input.request.candidateToken);
    if (!state.active && state.provisional.size === 0) {
      mounts.delete(state.lease.leaseToken);
    }
    return { status: "revoked" as const, decision: revoked };
  }

  function readLifecycleDecision(finalizationRequestId: string) {
    return decisions.get(finalizationRequestId);
  }

  function readProvisionalInstall(
    finalizationRequestId: string,
    provisionalInstallId: string
  ) {
    const provisional = requestToProvisional.get(
      finalizationRequestId
    );
    return provisional?.provisionalInstallId ===
      provisionalInstallId
      ? {
          provisionalInstallId,
          state: provisional.state,
          operationId: provisional.receipt.operationId,
          receiptId: provisional.receipt.receiptId
        }
      : undefined;
  }

  function completeCandidate(
    request: ManuscriptCandidateCustodyRequest,
    terminal: CandidateTerminal
  ) {
    const state = stateFor(request.ownerLease);
    const candidate = state?.candidates.get(request.candidateToken);
    if (!state || candidate?.request !== request || candidate.terminal) {
      return false;
    }
    candidate.terminal = terminal;
    state.candidates.delete(request.candidateToken);
    if (
      !state.active &&
      state.candidates.size === 0 &&
      state.provisional.size === 0
    ) {
      mounts.delete(request.ownerLease.leaseToken);
    }
    return true;
  }

  return Object.freeze({
    consumerScopeId,
    mountOwner,
    unmountOwner,
    isCurrentLease,
    protectHandle,
    focusIndependent,
    listIndependentHandles,
    beginCandidate,
    verifyReceipt,
    isCandidateCurrent,
    rejectInstall,
    prepareInstall,
    markInstalled,
    commitInstall,
    revokeInstall,
    readLifecycleDecision,
    readProvisionalInstall,
    completeCandidate,
    isProtected
  });
}

export type ManuscriptSaveAsLifecycleRegistry = ReturnType<
  typeof createManuscriptSaveAsLifecycleRegistry
>;
