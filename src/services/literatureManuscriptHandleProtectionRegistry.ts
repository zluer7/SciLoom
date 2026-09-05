import type {
  SharedManuscriptSessionHandle
} from "../types/sharedManuscriptSession";
import type {
  LiteratureManuscriptChannel
} from "./literatureRawManuscriptService";

export type LiteratureManuscriptCandidateProducer =
  | "save-as"
  | "recovery"
  | "independent-open";

export type LiteratureManuscriptCandidateTerminal =
  | "transferred"
  | "released_as_protected_alias"
  | "closed"
  | "already_absent"
  | "cleanup_blocked"
  | "protocol_violation";

export interface LiteratureManuscriptChannelLease {
  readonly ownerInstanceToken: object;
  readonly channelMountToken: object;
  readonly slotLeaseId: object;
  readonly literatureId: string;
  readonly channel: LiteratureManuscriptChannel;
}

export interface LiteratureManuscriptCandidateCustodyRequest {
  readonly ownerInstanceToken: object;
  readonly channelMountToken: object;
  readonly slotLeaseId: object;
  readonly custodyRequestToken: object;
  readonly literatureId: string;
  readonly channel: LiteratureManuscriptChannel;
  readonly producer: LiteratureManuscriptCandidateProducer;
  readonly replacementGeneration: number;
}

export interface LiteratureManuscriptCandidateCustodyReceipt {
  readonly request: LiteratureManuscriptCandidateCustodyRequest;
  readonly handle: SharedManuscriptSessionHandle;
  readonly literatureId: string;
  readonly channel: LiteratureManuscriptChannel;
  readonly producer: LiteratureManuscriptCandidateProducer;
  readonly operationId: string;
  readonly consumerId: string;
  readonly fileRefId?: string;
}

interface ProtectedChannelState {
  lease: LiteratureManuscriptChannelLease;
  current?: SharedManuscriptSessionHandle;
  independent?: SharedManuscriptSessionHandle;
  replacementGeneration: number;
}

interface CandidateState {
  request: LiteratureManuscriptCandidateCustodyRequest;
  receipt?: LiteratureManuscriptCandidateCustodyReceipt;
  terminal?: LiteratureManuscriptCandidateTerminal;
}

function frozenToken() {
  return Object.freeze({});
}

export function createLiteratureManuscriptHandleProtectionRegistry() {
  const ownerInstanceToken = frozenToken();
  const consumerScopeId = crypto.randomUUID();
  const channels = new Map<
    LiteratureManuscriptChannel,
    ProtectedChannelState
  >();
  const candidates = new WeakMap<
    object,
    CandidateState
  >();
  const cleanupBlockedResiduals = new Set<
    SharedManuscriptSessionHandle
  >();

  function resolveLease(
    lease: LiteratureManuscriptChannelLease
  ) {
    if (lease.ownerInstanceToken !== ownerInstanceToken) {
      return undefined;
    }
    const state = channels.get(lease.channel);
    return state?.lease === lease ? state : undefined;
  }

  function isProtected(
    handle: SharedManuscriptSessionHandle
  ) {
    if (cleanupBlockedResiduals.has(handle)) {
      return true;
    }
    for (const state of channels.values()) {
      if (
        state.current === handle ||
        state.independent === handle
      ) {
        return true;
      }
    }
    return false;
  }

  function beginCandidate(
    lease: LiteratureManuscriptChannelLease,
    producer: LiteratureManuscriptCandidateProducer,
    replacementGeneration: number
  ): LiteratureManuscriptCandidateCustodyRequest | undefined {
    const state = resolveLease(lease);
    if (
      !state ||
      replacementGeneration < state.replacementGeneration
    ) {
      return undefined;
    }
    state.replacementGeneration = replacementGeneration;
    const request = Object.freeze({
      ownerInstanceToken,
      channelMountToken: lease.channelMountToken,
      slotLeaseId: lease.slotLeaseId,
      custodyRequestToken: frozenToken(),
      literatureId: lease.literatureId,
      channel: lease.channel,
      producer,
      replacementGeneration
    });
    candidates.set(request.custodyRequestToken, {
      request
    });
    return request;
  }

  function verifyReceipt(
    request: LiteratureManuscriptCandidateCustodyRequest,
    receipt:
      | LiteratureManuscriptCandidateCustodyReceipt
      | undefined
  ) {
    const state = candidates.get(
      request.custodyRequestToken
    );
    const verified = Boolean(
      state &&
        !state.terminal &&
        state.request === request &&
        receipt &&
        receipt.request === request &&
        receipt.literatureId === request.literatureId &&
        receipt.channel === request.channel &&
        receipt.producer === request.producer &&
        typeof receipt.handle === "string" &&
        receipt.handle.length > 0 &&
        typeof receipt.operationId === "string" &&
        receipt.operationId.trim().length > 0 &&
        typeof receipt.consumerId === "string" &&
        receipt.consumerId.trim().length > 0 &&
        request.ownerInstanceToken ===
          ownerInstanceToken
    );
    if (verified && state && receipt) {
      state.receipt = receipt;
    }
    return verified;
  }

  return Object.freeze({
    ownerInstanceToken,
    consumerScopeId,
    mountChannel(
      literatureId: string,
      channel: LiteratureManuscriptChannel
    ): LiteratureManuscriptChannelLease {
      const lease = Object.freeze({
        ownerInstanceToken,
        channelMountToken: frozenToken(),
        slotLeaseId: frozenToken(),
        literatureId,
        channel
      });
      channels.set(channel, {
        lease,
        replacementGeneration: 0
      });
      return lease;
    },
    isCurrentLease: (
      lease: LiteratureManuscriptChannelLease
    ) => Boolean(resolveLease(lease)),
    unmountChannel(
      lease: LiteratureManuscriptChannelLease
    ) {
      const state = resolveLease(lease);
      if (!state) return false;
      channels.delete(lease.channel);
      return true;
    },
    protectCurrent(
      lease: LiteratureManuscriptChannelLease,
      handle: SharedManuscriptSessionHandle
    ) {
      const state = resolveLease(lease);
      if (!state) return false;
      state.current = handle;
      return true;
    },
    releaseCurrent(
      lease: LiteratureManuscriptChannelLease,
      expectedHandle?: SharedManuscriptSessionHandle
    ) {
      const state = resolveLease(lease);
      if (
        !state ||
        (expectedHandle !== undefined &&
          state.current !== expectedHandle)
      ) {
        return false;
      }
      state.current = undefined;
      return true;
    },
    replaceIndependent(
      lease: LiteratureManuscriptChannelLease,
      expectedGeneration: number,
      nextHandle?: SharedManuscriptSessionHandle
    ) {
      if (
        lease.ownerInstanceToken !== ownerInstanceToken
      ) {
        return {
          status:
            "rejected_stale_owner_lease" as const
        };
      }
      const state = channels.get(lease.channel);
      if (
        !state ||
        state.lease !== lease ||
        state.lease.channelMountToken !==
          lease.channelMountToken ||
        state.lease.slotLeaseId !== lease.slotLeaseId
      ) {
        return {
          status:
            "rejected_stale_channel_lease" as const
        };
      }
      if (
        expectedGeneration < state.replacementGeneration
      ) {
        return {
          status:
            "rejected_stale_generation" as const
        };
      }
      if (
        nextHandle &&
        state.independent !== nextHandle &&
        isProtected(nextHandle)
      ) {
        return {
          status: "protected_alias" as const
        };
      }
      state.replacementGeneration = expectedGeneration;
      const displaced = state.independent;
      state.independent = nextHandle;
      return {
        status: displaced === nextHandle
          ? "retained_same_handle" as const
          : nextHandle
            ? "installed" as const
            : "cleared" as const,
        displaced
      };
    },
    getIndependent(
      lease: LiteratureManuscriptChannelLease
    ) {
      return resolveLease(lease)?.independent;
    },
    isProtected,
    preserveCleanupBlockedResidual(
      handle: SharedManuscriptSessionHandle
    ) {
      cleanupBlockedResiduals.add(handle);
    },
    clearCleanupBlockedResidual(
      handle: SharedManuscriptSessionHandle
    ) {
      cleanupBlockedResiduals.delete(handle);
    },
    cleanupBlockedResiduals() {
      return [...cleanupBlockedResiduals];
    },
    beginCandidate,
    verifyReceipt,
    completeCandidate(
      request: LiteratureManuscriptCandidateCustodyRequest,
      terminal: LiteratureManuscriptCandidateTerminal
    ) {
      const state = candidates.get(
        request.custodyRequestToken
      );
      if (
        !state ||
        state.request !== request ||
        state.terminal
      ) {
        return false;
      }
      state.terminal = terminal;
      return true;
    },
    getCandidateTerminal(
      request: LiteratureManuscriptCandidateCustodyRequest
    ) {
      const state = candidates.get(
        request.custodyRequestToken
      );
      return state?.request === request
        ? state.terminal
        : undefined;
    },
    protectedHandles() {
      const handles = new Set<
        SharedManuscriptSessionHandle
      >();
      for (const state of channels.values()) {
        if (state.current) handles.add(state.current);
        if (state.independent) handles.add(state.independent);
      }
      for (const handle of cleanupBlockedResiduals) {
        handles.add(handle);
      }
      return [...handles];
    }
  });
}

export type LiteratureManuscriptHandleProtectionRegistry =
  ReturnType<
    typeof createLiteratureManuscriptHandleProtectionRegistry
  >;
