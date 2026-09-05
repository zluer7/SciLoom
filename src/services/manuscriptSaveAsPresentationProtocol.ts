import type { SharedSessionHandleResult } from "../types/sharedManuscriptSession";
import {
  manuscriptSaveAsOperationPort,
  type SaveAsOperationTransitionInput,
  type SaveAsOperationRecord
} from "./manuscriptSaveAsOperationPort";
import type {
  SaveAsCoreInternalReason,
  SharedSaveAsCoreOutcome
} from "./manuscriptSaveAsD2Adapter";
import {
  manuscriptSaveAsFinalizationPort,
  type SaveAsFinalizationPort,
  type SaveAsFinalizationRecord
} from "./manuscriptSaveAsFinalizationPort";

export type SaveAsPresentationTerminalOutcomeCode =
  | "TERMINAL_SUCCESS"
  | "TERMINAL_REJECT"
  | "TERMINAL_CANCEL"
  | "RETRYABLE_PRESENTATION_FAILURE"
  | "STALE_OPERATION"
  | "STALE_PROCESS"
  | "CONFLICTING_CALLBACK"
  | "UNKNOWN";

export function classifySaveAsPresentationOutcome(
  code: SaveAsPresentationTerminalOutcomeCode
) {
  switch (code) {
    case "TERMINAL_SUCCESS":
    case "TERMINAL_REJECT":
    case "TERMINAL_CANCEL":
      return {
        irreversible: true,
        retryPresentation: false,
        heavyResourceDisposition: "strip_immediately" as const,
        durableAcceptanceRequired: true,
        failClosed: false
      };
    case "RETRYABLE_PRESENTATION_FAILURE":
      return {
        irreversible: false,
        retryPresentation: true,
        heavyResourceDisposition:
          "strip_after_bounded_retry_horizon" as const,
        durableAcceptanceRequired: false,
        failClosed: false
      };
    case "STALE_OPERATION":
    case "STALE_PROCESS":
    case "CONFLICTING_CALLBACK":
      return {
        irreversible: true,
        retryPresentation: false,
        heavyResourceDisposition: "strip_immediately" as const,
        durableAcceptanceRequired: false,
        failClosed: true
      };
    case "UNKNOWN":
      return {
        irreversible: false,
        retryPresentation: false,
        heavyResourceDisposition: "strip_immediately" as const,
        durableAcceptanceRequired: false,
        failClosed: true
      };
  }
}

export interface SaveAsPresentationControlResources {
  cancelTimer?: () => void;
  abort?: () => void;
  detachListener?: () => void;
  settleDeferred?: () => void;
  detachCallback?: () => void;
  detachRetry?: () => void;
  diagnosticCleanup?: () => void;
}

export interface SaveAsPresentationPermitInput {
  operationId: string;
  operationGeneration: number;
  processGeneration: string;
  j0Revision: number;
  targetFileRefId: string;
  candidateReceiptId: string;
  runtime: SharedSessionHandleResult;
  consumerId: string;
  consumerGeneration: number;
  presentationGeneration: number;
  controlResources?: SaveAsPresentationControlResources;
}

export interface SaveAsPresentationPermit
  extends Omit<SaveAsPresentationPermitInput, "controlResources"> {
  permitId: string;
  ownerType: string;
  ownerId: string;
  channel: string;
  terminalOutcomeId: string;
  terminalOutcomeCode: "TERMINAL_SUCCESS";
  terminalOutcomeRevision: 1;
}

export type SaveAsPresentationAcknowledger = (
  permit: SaveAsPresentationPermit
) => boolean | Promise<boolean>;

export interface SaveAsPresentationReceipt {
  permitId: string;
  operationId: string;
  operationGeneration: number;
  processGeneration: string;
  candidateReceiptId: string;
  consumerId: string;
  consumerGeneration: number;
  presentationGeneration: number;
  terminalOutcomeId: string;
  terminalOutcomeCode: "TERMINAL_SUCCESS";
  terminalOutcomeRevision: 1;
  accepted: true;
}

export function acceptSaveAsPresentationPermit(
  permit: SaveAsPresentationPermit
): SaveAsPresentationReceipt {
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

export type SaveAsPresentationConsumer = (
  permit: SaveAsPresentationPermit
) => Promise<SaveAsPresentationReceipt>;

export interface SaveAsPresentationConsumerRegistration {
  status: "registered";
  consumerId: string;
  consumerGeneration: number;
  registrationGeneration: number;
  registrationToken: string;
}

export type SaveAsPresentationConsumerRegistrationResult =
  | SaveAsPresentationConsumerRegistration
  | {
      status: "rejected";
      failure: {
        code: "SAVE_AS_OPERATION_STALE";
        stage: "reconciliation_blocked";
        continuation: "await_recovery";
        writeApplied: false;
      };
    };

export type SaveAsPresentationConsumerDetachResult =
  | { status: "detached" }
  | { status: "stale" }
  | { status: "closed" };

export type SaveAsPresentationCallbackClassification =
  | "DUPLICATE"
  | "LATE_ACCEPTED"
  | "OUTCOME_ACCEPTANCE_PENDING"
  | "EVICTING"
  | "ACTIVE"
  | "STALE_OPERATION"
  | "STALE_PROCESS"
  | "CONFLICTING_CALLBACK"
  | "UNKNOWN_STALE_CALLBACK";

type CleanupStatus =
  | "EVICTED"
  | "EVICTED_WITH_CLEANUP_WARNING"
  | "EVICTION_BLOCKED";

interface PermitIdentity {
  permitId: string;
  operationId: string;
  operationGeneration: number;
  processGeneration: string;
  candidateReceiptId: string;
  ownerType: string;
  ownerId: string;
  channel: string;
  consumerId: string;
  consumerGeneration: number;
  presentationGeneration: number;
  terminalOutcomeId: string;
  terminalOutcomeCode: SaveAsPresentationTerminalOutcomeCode;
  terminalOutcomeRevision: number;
}

interface ActivePermitState {
  kind: "ACTIVE";
  permit: SaveAsPresentationPermit;
  registrationToken?: string;
  phase: "pending" | "transferred";
  controlResources?: SaveAsPresentationControlResources;
  createdSequence: number;
  createdAtMonotonic: number;
}

interface AcceptancePendingState {
  kind: "OUTCOME_ACCEPTANCE_PENDING";
  identity: PermitIdentity;
  acceptanceAttempt: number;
  createdSequence: number;
  createdAtMonotonic: number;
  pendingDeadline: number;
  cleanupStatus: CleanupStatus;
  cleanupCodes: readonly string[];
}

interface EvictingState {
  kind: "EVICTING";
  identity: PermitIdentity;
  acceptanceAttempt: number;
  createdSequence: number;
  pendingDeadline: number;
  durableAcceptanceRevision: number;
  cleanupStatus: CleanupStatus;
  cleanupCodes: readonly string[];
}

interface TombstoneState {
  kind: "TOMBSTONED";
  tombstoneVersion: 1;
  identity: PermitIdentity;
  durableAcceptanceRevision: number;
  evictionSequence: number;
  evictedAtUtc: string;
  monotonicExpiryDeadline: number;
  cleanupStatus: Exclude<CleanupStatus, "EVICTION_BLOCKED">;
  cleanupCodes: readonly string[];
}

type PermitRegistryState =
  | ActivePermitState
  | AcceptancePendingState
  | EvictingState
  | TombstoneState;

interface OperationAuthority {
  readback(operationId: string): Promise<SaveAsOperationRecord | null>;
  transition(input: SaveAsOperationTransitionInput): Promise<SaveAsOperationRecord>;
}

interface RegistryLimits {
  maximumActivePermitCount: number;
  maximumPendingPermitCount: number;
  maximumPendingPermitAgeMs: number;
  maximumAcceptanceRetryCount: number;
  maximumTombstoneCount: number;
  maximumCallbackRetryWindowMs: number;
  tombstoneTtlMs: number;
}

const DEFAULT_LIMITS: RegistryLimits = Object.freeze({
  maximumActivePermitCount: 128,
  maximumPendingPermitCount: 128,
  maximumPendingPermitAgeMs: 5 * 60_000,
  maximumAcceptanceRetryCount: 3,
  maximumTombstoneCount: 512,
  maximumCallbackRetryWindowMs: 10 * 60_000,
  tombstoneTtlMs: 15 * 60_000
});

let processPermitSequence = 0;

function failed<T>(
  record: SaveAsOperationRecord | null,
  internalReason: SaveAsCoreInternalReason,
  writeApplied: false | true | "unknown" = false
): SharedSaveAsCoreOutcome<T> {
  return {
    ok: false,
    failure: {
      code:
        internalReason === "presentation_response_unknown"
          ? "SAVE_AS_PHYSICAL_EFFECT_UNKNOWN"
          : "SAVE_AS_OPERATION_STALE",
      stage: record?.stage ?? "reconciliation_blocked",
      continuation:
        internalReason === "presentation_response_unknown"
          ? "readback_reconcile"
          : "await_recovery",
      writeApplied
    },
    internalReason
  };
}

function receiptMatchesPermit(
  permit: SaveAsPresentationPermit,
  receipt: SaveAsPresentationReceipt
) {
  return (
    receipt.accepted === true &&
    receipt.permitId === permit.permitId &&
    receipt.operationId === permit.operationId &&
    receipt.operationGeneration === permit.operationGeneration &&
    receipt.processGeneration === permit.processGeneration &&
    receipt.candidateReceiptId === permit.candidateReceiptId &&
    receipt.consumerId === permit.consumerId &&
    receipt.consumerGeneration === permit.consumerGeneration &&
    receipt.presentationGeneration === permit.presentationGeneration &&
    receipt.terminalOutcomeId === permit.terminalOutcomeId &&
    receipt.terminalOutcomeCode === permit.terminalOutcomeCode &&
    receipt.terminalOutcomeRevision === permit.terminalOutcomeRevision
  );
}

function identityMatchesReceipt(
  identity: PermitIdentity,
  receipt: SaveAsPresentationReceipt
) {
  return (
    receipt.accepted === true &&
    identity.permitId === receipt.permitId &&
    identity.operationId === receipt.operationId &&
    identity.operationGeneration === receipt.operationGeneration &&
    identity.processGeneration === receipt.processGeneration &&
    identity.candidateReceiptId === receipt.candidateReceiptId &&
    identity.consumerId === receipt.consumerId &&
    identity.consumerGeneration === receipt.consumerGeneration &&
    identity.presentationGeneration === receipt.presentationGeneration &&
    identity.terminalOutcomeId === receipt.terminalOutcomeId &&
    identity.terminalOutcomeCode === receipt.terminalOutcomeCode &&
    identity.terminalOutcomeRevision === receipt.terminalOutcomeRevision
  );
}

function pendingIdentityAcceptsReceipt(
  identity: PermitIdentity,
  receipt: SaveAsPresentationReceipt
) {
  return (
    identityMatchesReceipt(identity, receipt) ||
    (identity.terminalOutcomeCode === "UNKNOWN" &&
      identity.permitId === receipt.permitId &&
      identity.operationId === receipt.operationId &&
      identity.operationGeneration === receipt.operationGeneration &&
      identity.processGeneration === receipt.processGeneration &&
      identity.candidateReceiptId === receipt.candidateReceiptId &&
      identity.consumerId === receipt.consumerId &&
      identity.consumerGeneration === receipt.consumerGeneration &&
      identity.presentationGeneration === receipt.presentationGeneration &&
      identity.terminalOutcomeId === receipt.terminalOutcomeId &&
      identity.terminalOutcomeRevision ===
        receipt.terminalOutcomeRevision)
  );
}

function durableAcceptanceMatches(
  identity: PermitIdentity,
  record: SaveAsFinalizationRecord | null
) {
  return (
    record !== null &&
    record.operationId === identity.operationId &&
    record.receiptId === identity.candidateReceiptId &&
    record.p4PermitId === identity.permitId &&
    record.p4OperationGeneration === identity.operationGeneration &&
    record.p4ProcessGeneration === identity.processGeneration &&
    record.terminalOutcomeId === identity.terminalOutcomeId &&
    record.terminalOutcomeCode === identity.terminalOutcomeCode &&
    record.terminalOutcomeRevision === identity.terminalOutcomeRevision &&
    record.ownerType === identity.ownerType &&
    record.ownerId === identity.ownerId &&
    record.channel === identity.channel &&
    record.revision >= 0
  );
}

function operationAlreadyHasExactDurableAcceptance(
  input: SaveAsPresentationPermitInput,
  operation: SaveAsOperationRecord,
  record: SaveAsFinalizationRecord | null
) {
  return (
    record !== null &&
    record.operationId === input.operationId &&
    record.receiptId === input.candidateReceiptId &&
    record.ownerType === operation.ownerType &&
    record.ownerId === operation.ownerId &&
    record.channel === operation.channel &&
    record.candidateFileRefId === input.targetFileRefId &&
    record.p4OperationGeneration === input.operationGeneration &&
    record.p4ProcessGeneration === input.processGeneration &&
    record.terminalOutcomeCode === "TERMINAL_SUCCESS" &&
    record.terminalOutcomeRevision > 0 &&
    Boolean(record.p4PermitId) &&
    Boolean(record.terminalOutcomeId)
  );
}

function identityFromPermit(
  permit: SaveAsPresentationPermit,
  terminalOutcomeCode: SaveAsPresentationTerminalOutcomeCode =
    permit.terminalOutcomeCode
): PermitIdentity {
  return {
    permitId: permit.permitId,
    operationId: permit.operationId,
    operationGeneration: permit.operationGeneration,
    processGeneration: permit.processGeneration,
    candidateReceiptId: permit.candidateReceiptId,
    ownerType: permit.ownerType,
    ownerId: permit.ownerId,
    channel: permit.channel,
    consumerId: permit.consumerId,
    consumerGeneration: permit.consumerGeneration,
    presentationGeneration: permit.presentationGeneration,
    terminalOutcomeId: permit.terminalOutcomeId,
    terminalOutcomeCode,
    terminalOutcomeRevision: permit.terminalOutcomeRevision
  };
}

function releaseControlResources(
  resources: SaveAsPresentationControlResources | undefined
): { status: CleanupStatus; codes: readonly string[] } {
  if (!resources) return { status: "EVICTED", codes: [] };
  const blocked = new Set([
    "timer",
    "listener",
    "deferred",
    "callback",
    "retry"
  ]);
  const failures: string[] = [];
  const release = (code: string, action: (() => void) | undefined) => {
    if (!action) return;
    try {
      action();
    } catch {
      failures.push(code);
    }
  };
  release("timer", resources.cancelTimer);
  release("abort", resources.abort);
  release("listener", resources.detachListener);
  release("deferred", resources.settleDeferred);
  release("callback", resources.detachCallback);
  release("retry", resources.detachRetry);
  release("diagnostic", resources.diagnosticCleanup);
  if (failures.some((code) => blocked.has(code))) {
    return { status: "EVICTION_BLOCKED", codes: failures };
  }
  return failures.length > 0
    ? {
        status: "EVICTED_WITH_CLEANUP_WARNING",
        codes: failures
      }
    : { status: "EVICTED", codes: [] };
}

function normalizeLimits(
  input: Partial<RegistryLimits> | undefined
): RegistryLimits {
  const limits = { ...DEFAULT_LIMITS, ...input };
  if (
    Object.values(limits).some(
      (value) => !Number.isSafeInteger(value) || value <= 0
    ) ||
    limits.tombstoneTtlMs < limits.maximumCallbackRetryWindowMs
  ) {
    throw new Error("SAVE_AS_P4_REGISTRY_LIMITS_INVALID");
  }
  return limits;
}

export function createManuscriptSaveAsPresentationProtocol(dependencies: {
  operations: OperationAuthority;
  finalization?: Pick<
    SaveAsFinalizationPort,
    "recordPresentation" | "readback"
  >;
  createPermitId?: () => string;
  createRegistrationToken?: () => string;
  createTerminalOutcomeId?: () => string;
  monotonicNow?: () => number;
  nowUtc?: () => string;
  limits?: Partial<RegistryLimits>;
}) {
  const consumers = new Map<
    string,
    {
      generation: number;
      registrationGeneration: number;
      registrationToken: string;
      consume: SaveAsPresentationConsumer;
    }
  >();
  const registry = new Map<string, PermitRegistryState>();
  const limits = normalizeLimits(dependencies.limits);
  let registrationGeneration = 0;
  let createdSequence = 0;
  let evictionSequence = 0;
  let currentProcessGeneration: string | undefined;
  const createPermitId =
    dependencies.createPermitId ??
    (() => globalThis.crypto.randomUUID());
  const createRegistrationToken =
    dependencies.createRegistrationToken ??
    (() => globalThis.crypto.randomUUID());
  const createTerminalOutcomeId =
    dependencies.createTerminalOutcomeId ??
    (() => globalThis.crypto.randomUUID());
  const monotonicNow =
    dependencies.monotonicNow ?? (() => globalThis.performance.now());
  const nowUtc =
    dependencies.nowUtc ?? (() => new Date().toISOString());
  const isolatedPresentations = new Map<
    string,
    SaveAsFinalizationRecord
  >();
  const finalization =
    dependencies.finalization ?? {
      async recordPresentation(input: {
        operationId: string;
        expectedOperationRevision: number;
        receiptId: string;
        permitId: string;
        operationGeneration: number;
        processGeneration: string;
        terminalOutcomeId: string;
        terminalOutcomeCode: SaveAsPresentationTerminalOutcomeCode;
        terminalOutcomeRevision: number;
      }) {
        const existing = isolatedPresentations.get(
          input.operationId
        );
        if (existing) return existing;
        const operation = await dependencies.operations.readback(
          input.operationId
        );
        if (
          !operation ||
          operation.revision !== input.expectedOperationRevision ||
          operation.operationGeneration !== input.operationGeneration ||
          operation.producerProcessGeneration !== input.processGeneration ||
          operation.stage !== "p4_presentation_pending"
        ) {
          throw new Error("SAVE_AS_FINALIZATION_REVISION_CONFLICT");
        }
        const timestamp = nowUtc();
        const record = {
          operationId: input.operationId,
          revision: 0,
          finalizationState: "presentation_completed",
          receiptId: input.receiptId,
          ownerType: operation.ownerType,
          ownerId: operation.ownerId,
          channel: operation.channel,
          candidateFileRefId: operation.targetFileRefId!,
          p4PermitId: input.permitId,
          p4OperationGeneration: input.operationGeneration,
          p4ProcessGeneration: input.processGeneration,
          terminalOutcomeId: input.terminalOutcomeId,
          terminalOutcomeCode: input.terminalOutcomeCode,
          terminalOutcomeRevision: input.terminalOutcomeRevision,
          createdAt: timestamp,
          updatedAt: timestamp
        } as SaveAsFinalizationRecord;
        isolatedPresentations.set(input.operationId, record);
        return record;
      },
      async readback(operationId: string) {
        return isolatedPresentations.get(operationId) ?? null;
      }
    };

  function entriesByKind<T extends PermitRegistryState["kind"]>(
    kind: T
  ) {
    return [...registry.values()].filter(
      (state): state is Extract<PermitRegistryState, { kind: T }> =>
        state.kind === kind
    );
  }

  function pruneTombstones() {
    const timestamp = monotonicNow();
    const tombstones = [...registry.entries()]
      .filter(
        (
          entry
        ): entry is [string, TombstoneState] =>
          entry[1].kind === "TOMBSTONED"
      )
      .sort(
        (left, right) =>
          left[1].evictionSequence - right[1].evictionSequence ||
          (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0)
      );
    let pruned = 0;
    for (const [permitId, tombstone] of tombstones) {
      if (tombstone.monotonicExpiryDeadline <= timestamp) {
        registry.delete(permitId);
        pruned += 1;
      }
    }
    const retained = [...registry.entries()]
      .filter(
        (
          entry
        ): entry is [string, TombstoneState] =>
          entry[1].kind === "TOMBSTONED"
      )
      .sort(
        (left, right) =>
          left[1].evictionSequence - right[1].evictionSequence ||
          (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0)
      );
    const overflow = retained.length - limits.maximumTombstoneCount;
    for (let index = 0; index < overflow; index += 1) {
      registry.delete(retained[index][0]);
      pruned += 1;
    }
    return { status: "TOMBSTONE_PRUNED" as const, pruned };
  }

  function stripHeavyResources(
    state: ActivePermitState,
    terminalOutcomeCode: SaveAsPresentationTerminalOutcomeCode
  ) {
    const cleanup = releaseControlResources(state.controlResources);
    const pending: AcceptancePendingState = {
      kind: "OUTCOME_ACCEPTANCE_PENDING",
      identity: identityFromPermit(
        state.permit,
        terminalOutcomeCode
      ),
      acceptanceAttempt: 0,
      createdSequence: state.createdSequence,
      createdAtMonotonic: state.createdAtMonotonic,
      pendingDeadline:
        monotonicNow() + limits.maximumPendingPermitAgeMs,
      cleanupStatus: cleanup.status,
      cleanupCodes: cleanup.codes
    };
    registry.set(state.permit.permitId, pending);
    return pending;
  }

  function evictAccepted(
    pending: AcceptancePendingState,
    acceptance: SaveAsFinalizationRecord
  ) {
    if (!durableAcceptanceMatches(pending.identity, acceptance)) {
      return { status: "EVICTION_BLOCKED" as const };
    }
    const evicting: EvictingState = {
      kind: "EVICTING",
      identity: pending.identity,
      acceptanceAttempt: pending.acceptanceAttempt,
      createdSequence: pending.createdSequence,
      pendingDeadline: pending.pendingDeadline,
      durableAcceptanceRevision: acceptance.revision,
      cleanupStatus: pending.cleanupStatus,
      cleanupCodes: pending.cleanupCodes
    };
    registry.set(pending.identity.permitId, evicting);
    if (evicting.cleanupStatus === "EVICTION_BLOCKED") {
      return { status: "EVICTION_BLOCKED" as const };
    }
    evictionSequence += 1;
    const tombstone: TombstoneState = {
      kind: "TOMBSTONED",
      tombstoneVersion: 1,
      identity: evicting.identity,
      durableAcceptanceRevision: evicting.durableAcceptanceRevision,
      evictionSequence,
      evictedAtUtc: nowUtc(),
      monotonicExpiryDeadline:
        monotonicNow() + limits.tombstoneTtlMs,
      cleanupStatus: evicting.cleanupStatus,
      cleanupCodes: evicting.cleanupCodes
    };
    registry.set(tombstone.identity.permitId, tombstone);
    pruneTombstones();
    return { status: tombstone.cleanupStatus };
  }

  async function persistPresentation(
    pending: AcceptancePendingState
  ): Promise<SharedSaveAsCoreOutcome<SaveAsOperationRecord>> {
    const current = await dependencies.operations.readback(
      pending.identity.operationId
    );
    if (
      !current ||
      current.operationGeneration !==
        pending.identity.operationGeneration ||
      current.producerProcessGeneration !==
        pending.identity.processGeneration ||
      current.targetFileRefId === undefined ||
      current.stage !== "p4_presentation_pending"
    ) {
      return failed(current, "stale_operation");
    }
    pending.acceptanceAttempt += 1;
    try {
      const acceptance = await finalization.recordPresentation({
        operationId: current.operationId,
        expectedOperationRevision: current.revision,
        receiptId: pending.identity.candidateReceiptId,
        permitId: pending.identity.permitId,
        operationGeneration:
          pending.identity.operationGeneration,
        processGeneration: pending.identity.processGeneration,
        terminalOutcomeId: pending.identity.terminalOutcomeId,
        terminalOutcomeCode:
          pending.identity.terminalOutcomeCode,
        terminalOutcomeRevision:
          pending.identity.terminalOutcomeRevision
      });
      if (!durableAcceptanceMatches(pending.identity, acceptance)) {
        return failed(current, "stale_operation");
      }
      const eviction = evictAccepted(pending, acceptance);
      if (eviction.status === "EVICTION_BLOCKED") {
        return failed(
          current,
          "presentation_response_unknown",
          "unknown"
        );
      }
      return { ok: true, continuation: "close", value: current };
    } catch {
      const presentationReadback = await finalization.readback(
        pending.identity.operationId
      );
      const readback = await dependencies.operations.readback(
        pending.identity.operationId
      );
      if (
        durableAcceptanceMatches(
          pending.identity,
          presentationReadback
        ) &&
        readback?.stage === "p4_presentation_pending"
      ) {
        const eviction = evictAccepted(
          pending,
          presentationReadback!
        );
        if (eviction.status !== "EVICTION_BLOCKED") {
          return {
            ok: true,
            continuation: "close",
            value: readback
          };
        }
      }
      await reconcileOrphans();
      return failed(
        readback,
        "presentation_response_unknown",
        "unknown"
      );
    }
  }

  async function reconcileOrphans() {
    pruneTombstones();
    const timestamp = monotonicNow();
    const pending = entriesByKind("OUTCOME_ACCEPTANCE_PENDING")
      .sort(
        (left, right) =>
          left.createdSequence - right.createdSequence ||
          (left.identity.permitId < right.identity.permitId
            ? -1
            : left.identity.permitId > right.identity.permitId
              ? 1
              : 0)
      );
    let reconciled = 0;
    let removed = 0;
    for (const state of pending) {
      const underPressure =
        pending.length - removed >
        limits.maximumPendingPermitCount;
      const expired = state.pendingDeadline <= timestamp;
      if (!expired && !underPressure) continue;
      const acceptance = await finalization.readback(
        state.identity.operationId
      );
      state.acceptanceAttempt += 1;
      if (durableAcceptanceMatches(state.identity, acceptance)) {
        evictAccepted(state, acceptance!);
        reconciled += 1;
        continue;
      }
      if (
        expired ||
        state.acceptanceAttempt >=
          limits.maximumAcceptanceRetryCount ||
        underPressure
      ) {
        registry.delete(state.identity.permitId);
        removed += 1;
      }
    }
    const evicting = entriesByKind("EVICTING").sort(
      (left, right) =>
        left.createdSequence - right.createdSequence ||
        (left.identity.permitId < right.identity.permitId
          ? -1
          : left.identity.permitId > right.identity.permitId
            ? 1
            : 0)
    );
    for (let index = 0; index < evicting.length; index += 1) {
      const state = evicting[index];
      if (
        state.pendingDeadline <= timestamp ||
        evicting.length - index >
          limits.maximumPendingPermitCount
      ) {
        registry.delete(state.identity.permitId);
        removed += 1;
      }
    }
    return { reconciled, removed };
  }

  async function classifyCallback(
    receipt: SaveAsPresentationReceipt
  ): Promise<SaveAsPresentationCallbackClassification> {
    pruneTombstones();
    if (
      !currentProcessGeneration ||
      receipt.processGeneration !== currentProcessGeneration
    ) {
      return "STALE_PROCESS";
    }
    const state = registry.get(receipt.permitId);
    if (state) {
      if (state.kind === "ACTIVE") {
        return receiptMatchesPermit(state.permit, receipt)
          ? "ACTIVE"
          : "CONFLICTING_CALLBACK";
      }
      if (
        state.kind === "OUTCOME_ACCEPTANCE_PENDING"
          ? !pendingIdentityAcceptsReceipt(state.identity, receipt)
          : !identityMatchesReceipt(state.identity, receipt)
      ) {
        return "CONFLICTING_CALLBACK";
      }
      if (state.kind === "OUTCOME_ACCEPTANCE_PENDING") {
        return "OUTCOME_ACCEPTANCE_PENDING";
      }
      if (state.kind === "EVICTING") return "EVICTING";
      return "DUPLICATE";
    }
    const operation = await dependencies.operations.readback(
      receipt.operationId
    );
    if (
      operation &&
      (operation.operationGeneration !==
        receipt.operationGeneration ||
        operation.producerProcessGeneration !== receipt.processGeneration)
    ) {
      return "STALE_OPERATION";
    }
    const acceptance = await finalization.readback(
      receipt.operationId
    );
    return durableAcceptanceMatches(
      {
        permitId: receipt.permitId,
        operationId: receipt.operationId,
        operationGeneration: receipt.operationGeneration,
        processGeneration: receipt.processGeneration,
        candidateReceiptId: receipt.candidateReceiptId,
        ownerType: operation?.ownerType ?? "",
        ownerId: operation?.ownerId ?? "",
        channel: operation?.channel ?? "",
        consumerId: receipt.consumerId,
        consumerGeneration: receipt.consumerGeneration,
        presentationGeneration: receipt.presentationGeneration,
        terminalOutcomeId: receipt.terminalOutcomeId,
        terminalOutcomeCode: receipt.terminalOutcomeCode,
        terminalOutcomeRevision: receipt.terminalOutcomeRevision
      },
      acceptance
    )
      ? "LATE_ACCEPTED"
      : acceptance
        ? "CONFLICTING_CALLBACK"
        : "UNKNOWN_STALE_CALLBACK";
  }

  return Object.freeze({
    registerConsumer(input: {
      consumerId: string;
      consumerGeneration: number;
      consume: SaveAsPresentationConsumer;
    }): SaveAsPresentationConsumerRegistrationResult {
      pruneTombstones();
      if (!input.consumerId.trim() || input.consumerGeneration <= 0) {
        return {
          status: "rejected",
          failure: {
            code: "SAVE_AS_OPERATION_STALE",
            stage: "reconciliation_blocked",
            continuation: "await_recovery",
            writeApplied: false
          }
        };
      }
      const existing = consumers.get(input.consumerId);
      if (
        existing &&
        input.consumerGeneration <= existing.generation
      ) {
        return {
          status: "rejected",
          failure: {
            code: "SAVE_AS_OPERATION_STALE",
            stage: "reconciliation_blocked",
            continuation: "await_recovery",
            writeApplied: false
          }
        };
      }
      registrationGeneration += 1;
      const registrationToken = createRegistrationToken();
      consumers.set(input.consumerId, {
        generation: input.consumerGeneration,
        registrationGeneration,
        registrationToken,
        consume: input.consume
      });
      for (const state of registry.values()) {
        if (
          state.kind === "ACTIVE" &&
          state.phase === "pending" &&
          state.permit.consumerId === input.consumerId &&
          state.permit.consumerGeneration !== input.consumerGeneration
        ) {
          stripHeavyResources(state, "STALE_OPERATION");
        }
      }
      return {
        status: "registered",
        consumerId: input.consumerId,
        consumerGeneration: input.consumerGeneration,
        registrationGeneration,
        registrationToken
      };
    },

    detachConsumer(
      registration: SaveAsPresentationConsumerRegistration
    ): SaveAsPresentationConsumerDetachResult {
      pruneTombstones();
      const consumer = consumers.get(registration.consumerId);
      if (!consumer) return { status: "closed" };
      if (
        consumer.generation !== registration.consumerGeneration ||
        consumer.registrationGeneration !==
          registration.registrationGeneration ||
        consumer.registrationToken !== registration.registrationToken
      ) {
        return { status: "stale" };
      }
      consumers.delete(registration.consumerId);
      for (const state of registry.values()) {
        if (
          state.kind === "ACTIVE" &&
          state.phase === "pending" &&
          state.permit.consumerId === registration.consumerId &&
          state.permit.consumerGeneration ===
            registration.consumerGeneration
        ) {
          stripHeavyResources(state, "STALE_OPERATION");
        }
      }
      return { status: "detached" };
    },

    async issue(
      input: SaveAsPresentationPermitInput
    ): Promise<SharedSaveAsCoreOutcome<SaveAsPresentationPermit>> {
      await reconcileOrphans();
      const record = await dependencies.operations.readback(
        input.operationId
      );
      if (
        !record ||
        record.operationId !== input.operationId ||
        record.stage !== "p4_presentation_pending" ||
        record.operationGeneration !== input.operationGeneration ||
        record.producerProcessGeneration !== input.processGeneration ||
        record.revision !== input.j0Revision ||
        record.targetFileRefId !== input.targetFileRefId ||
        typeof input.processGeneration !== "string" ||
        !input.processGeneration.trim() ||
        input.consumerGeneration <= 0 ||
        input.presentationGeneration <= 0 ||
        !input.candidateReceiptId.trim()
      ) {
        return failed(record, "stale_operation");
      }
      const durableAcceptance = await finalization.readback(
        input.operationId
      );
      if (durableAcceptance) {
        return failed(
          record,
          operationAlreadyHasExactDurableAcceptance(
            input,
            record,
            durableAcceptance
          )
            ? "already_consumed"
            : "stale_operation"
        );
      }
      if (
        currentProcessGeneration &&
        currentProcessGeneration !== input.processGeneration
      ) {
        const hasLivePreviousGeneration = [...registry.values()].some(
          (state) => state.kind !== "TOMBSTONED"
        );
        if (hasLivePreviousGeneration) {
          return failed(record, "stale_operation");
        }
        registry.clear();
      }
      currentProcessGeneration = input.processGeneration;
      const duplicate = [...registry.values()].find((state) => {
        const identity =
          state.kind === "ACTIVE"
            ? state.permit
            : state.identity;
        return (
          identity.operationId === input.operationId &&
          identity.operationGeneration ===
            input.operationGeneration &&
          identity.presentationGeneration ===
            input.presentationGeneration
        );
      });
      if (
        duplicate ||
        entriesByKind("ACTIVE").length >=
          limits.maximumActivePermitCount
      ) {
        return failed(record, "stale_operation");
      }
      processPermitSequence += 1;
      createdSequence += 1;
      const permit = {
        ...input,
        controlResources: undefined,
        permitId: `${createPermitId()}:${processPermitSequence}`,
        ownerType: record.ownerType,
        ownerId: record.ownerId,
        channel: record.channel,
        terminalOutcomeId: `${createTerminalOutcomeId()}:${processPermitSequence}`,
        terminalOutcomeCode: "TERMINAL_SUCCESS" as const,
        terminalOutcomeRevision: 1 as const
      };
      delete (permit as Partial<SaveAsPresentationPermitInput>)
        .controlResources;
      const consumer = consumers.get(input.consumerId);
      registry.set(permit.permitId, {
        kind: "ACTIVE",
        permit,
        registrationToken:
          consumer?.generation === input.consumerGeneration
            ? consumer.registrationToken
            : undefined,
        phase: "pending",
        controlResources: input.controlResources,
        createdSequence,
        createdAtMonotonic: monotonicNow()
      });
      return { ok: true, continuation: "close", value: permit };
    },

    async transfer(
      permitId: string
    ): Promise<SharedSaveAsCoreOutcome<SaveAsOperationRecord>> {
      await reconcileOrphans();
      const state = registry.get(permitId);
      const record =
        state?.kind === "ACTIVE"
          ? await dependencies.operations.readback(
              state.permit.operationId
            )
          : state
            ? await dependencies.operations.readback(
                state.identity.operationId
              )
            : null;
      if (!state || state.kind !== "ACTIVE") {
        return failed(
          record,
          state?.kind === "OUTCOME_ACCEPTANCE_PENDING" ||
            state?.kind === "EVICTING"
            ? "presentation_response_unknown"
            : "stale_operation",
          state?.kind === "OUTCOME_ACCEPTANCE_PENDING" ||
            state?.kind === "EVICTING"
            ? "unknown"
            : false
        );
      }
      if (state.phase !== "pending") {
        return failed(
          record,
          "presentation_response_unknown",
          "unknown"
        );
      }
      const consumer = consumers.get(state.permit.consumerId);
      if (
        !consumer ||
        consumer.generation !== state.permit.consumerGeneration
      ) {
        return failed(record, "presentation_consumer_unavailable");
      }
      const registrationToken =
        state.registrationToken ?? consumer.registrationToken;
      state.registrationToken = registrationToken;
      state.phase = "transferred";
      let receipt: SaveAsPresentationReceipt;
      try {
        receipt = await consumer.consume(state.permit);
      } catch {
        stripHeavyResources(state, "UNKNOWN");
        await reconcileOrphans();
        return failed(
          record,
          "presentation_response_unknown",
          "unknown"
        );
      }
      const currentConsumer = consumers.get(state.permit.consumerId);
      if (
        !currentConsumer ||
        currentConsumer.generation !==
          state.permit.consumerGeneration ||
        currentConsumer.registrationToken !== registrationToken
      ) {
        stripHeavyResources(state, "STALE_OPERATION");
        await reconcileOrphans();
        return failed(record, "stale_operation", true);
      }
      if (!receiptMatchesPermit(state.permit, receipt)) {
        stripHeavyResources(state, "CONFLICTING_CALLBACK");
        await reconcileOrphans();
        return failed(record, "stale_operation", true);
      }
      const pending = stripHeavyResources(
        state,
        receipt.terminalOutcomeCode
      );
      return persistPresentation(pending);
    },

    async reconcileConsumed(
      permitId: string,
      receipt: SaveAsPresentationReceipt
    ): Promise<SharedSaveAsCoreOutcome<SaveAsOperationRecord>> {
      await reconcileOrphans();
      const classification = await classifyCallback(receipt);
      const record = await dependencies.operations.readback(
        receipt.operationId
      );
      if (
        classification === "DUPLICATE" ||
        classification === "LATE_ACCEPTED"
      ) {
        return record
          ? { ok: true, continuation: "close", value: record }
          : failed(record, "stale_operation");
      }
      const state = registry.get(permitId);
      if (
        !state ||
        state.kind !== "OUTCOME_ACCEPTANCE_PENDING" ||
        !pendingIdentityAcceptsReceipt(state.identity, receipt)
      ) {
        return failed(
          record,
          classification === "OUTCOME_ACCEPTANCE_PENDING" ||
            classification === "EVICTING"
            ? "presentation_response_unknown"
            : "stale_operation",
          classification === "OUTCOME_ACCEPTANCE_PENDING" ||
            classification === "EVICTING"
            ? "unknown"
            : false
        );
      }
      if (state.identity.terminalOutcomeCode === "UNKNOWN") {
        state.identity = {
          ...state.identity,
          terminalOutcomeCode: receipt.terminalOutcomeCode
        };
      }
      return persistPresentation(state);
    },

    classifyCallback,
    reconcileOrphans,
    pruneTombstones,

    inspectPermit(permitId: string) {
      pruneTombstones();
      const state = registry.get(permitId);
      if (!state) return undefined;
      if (state.kind === "ACTIVE") {
        return {
          permit: structuredClone(state.permit),
          state: "ACTIVE" as const,
          phase: state.phase
        };
      }
      return {
        state: state.kind,
        identity: structuredClone(state.identity),
        cleanupStatus:
          state.kind === "TOMBSTONED" ||
          state.kind === "EVICTING" ||
          state.kind === "OUTCOME_ACCEPTANCE_PENDING"
            ? state.cleanupStatus
            : undefined
      };
    },

    inspectResources(permitId?: string) {
      pruneTombstones();
      const states = permitId
        ? [registry.get(permitId)].filter(
            (state): state is PermitRegistryState =>
              state !== undefined
          )
        : [...registry.values()];
      const active = states.filter(
        (state): state is ActivePermitState =>
          state.kind === "ACTIVE"
      );
      return {
        activePermitCount: entriesByKind("ACTIVE").length,
        acceptancePendingCount: entriesByKind(
          "OUTCOME_ACCEPTANCE_PENDING"
        ).length,
        evictingCount: entriesByKind("EVICTING").length,
        tombstoneCount: entriesByKind("TOMBSTONED").length,
        hasRawSnapshot: false,
        hasCallback: active.some(
          (state) =>
            Boolean(state.controlResources?.detachCallback) ||
            consumers.has(state.permit.consumerId)
        ),
        hasTimer: active.some((state) =>
          Boolean(state.controlResources?.cancelTimer)
        ),
        hasListener: active.some((state) =>
          Boolean(state.controlResources?.detachListener)
        ),
        hasDeferred: active.some((state) =>
          Boolean(state.controlResources?.settleDeferred)
        ),
        hasRuntimeReference: active.length > 0,
        lifecycleStates: states.map((state) => state.kind),
        limits: { ...limits }
      };
    },

    readFinalization(operationId: string) {
      return finalization.readback(operationId);
    }
  });
}

export const manuscriptSaveAsPresentationProtocol =
  createManuscriptSaveAsPresentationProtocol({
    operations: manuscriptSaveAsOperationPort,
    finalization: manuscriptSaveAsFinalizationPort
  });
