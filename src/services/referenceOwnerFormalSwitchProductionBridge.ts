import { invoke } from "@tauri-apps/api/core";
import type {
  FormalSwitchAdapter,
  FormalSwitchError,
  FormalSwitchRecoveryEvidence,
  FormalSwitchSnapshot
} from "./formalSwitchEngine";
import {
  buildCanonicalFormalSwitchArchiveCandidate,
  buildCanonicalFormalSwitchTargetCleanupPlan,
  type CanonicalFormalSwitchTargetCleanupPlan
} from "./canonicalFormalSwitchArchiveConvergence";

export type ReferenceOwnerType =
  | "experiment"
  | "experimentRun"
  | "literature"
  | "review"
  | "resultItem"
  | "finding"
  | "outputCandidate"
  | "outputGap"
  | "researchOutput";
export type ReferenceOwnerManuscriptChannel =
  | "primary"
  | "literature_outline"
  | "dedicated_notes";
export type ReferenceOwnerSubtype =
  | "stage"
  | "periodic"
  | "experiment_comparison"
  | "literature_comparison"
  | "custom";

export interface ReferenceOwnerRuntimeEvidenceInput {
  actualRuntimeHandle: string;
  runtimeGeneration: number;
  runtimeConsumerId: string;
  logicalIdentity: string;
  fileRefId: string;
}

export interface ReferenceOwnerBeginInput {
  ownerType: ReferenceOwnerType;
  ownerId: string;
  manuscriptChannel: ReferenceOwnerManuscriptChannel;
  ownerSubtype?: ReferenceOwnerSubtype;
  expectedStructuredRevision?: number;
  expectedDescriptorIdentity?: string;
  expectedLifecycleEvidence?: string;
  operationId: string;
  occurredAt: string;
  occurredAtEpochMs: number;
  oldCurrentFileRefId: string;
  defaultFileRefId: string;
  targetFileRefId: string;
  oldCurrentPhysicalRevision: string;
  targetPhysicalRevision: string;
  expectedOldCurrentPostText: string;
  replacements: readonly { stableKey: string; value?: string }[];
  previewSnapshotIdentity: string;
  currentRuntime: ReferenceOwnerRuntimeEvidenceInput;
  targetRuntime: ReferenceOwnerRuntimeEvidenceInput;
}

export interface ReferenceOwnerActivationInput {
  actualRuntimeHandle: string;
  runtimeGeneration: number;
  runtimeConsumerId: string;
  logicalIdentity: string;
  fileRefId: string;
  exactActive: boolean;
  authoritativePhysicalRevision: string;
  authoritativeRawByteLength: number;
}

export interface ReferenceOwnerTargetCleanupInput {
  expectedRevision: string;
  expectedPreByteLength: number;
  expectedPostText: string;
  exactMarkerSpans: readonly {
    lineStartByte: number;
    ownedEndByte: number;
    markerKind: "BEGIN" | "END";
  }[];
}

export interface ReferenceOwnerRecoverySummary {
  operationId: string;
  ownerType: ReferenceOwnerType;
  ownerId: string;
  manuscriptChannel: ReferenceOwnerManuscriptChannel;
  ownerSubtype?: ReferenceOwnerSubtype;
  phase: string;
  phaseRevision: number;
  terminalCode?: string;
  oldCurrentFileRefId: string;
  defaultFileRefId: string;
  targetFileRefId: string;
  parentOwnerId?: string;
  projectId?: string;
  createdAtEpochMs: number;
}

export type ReferenceOwnerBridgeRequest =
  | { action: "inspectLegacyDrain" }
  | { action: "begin"; input: ReferenceOwnerBeginInput }
  | { action: "continue"; operationId: string; occurredAt: string; occurredAtEpochMs: number }
  | { action: "resolveActivation"; operationId: string; activation: ReferenceOwnerActivationInput; occurredAtEpochMs: number }
  | { action: "cleanupTarget"; operationId: string; cleanup: ReferenceOwnerTargetCleanupInput }
  | {
      action: "listRecoveries";
      ownerType: ReferenceOwnerType;
      ownerId: string;
      manuscriptChannel: ReferenceOwnerManuscriptChannel;
      ownerSubtype?: ReferenceOwnerSubtype;
    }
  | { action: "discoverRecoveries" }
  | { action: "cancelPrepared"; operationId: string; occurredAtEpochMs: number };

export type ReferenceOwnerBridgeResult =
  | {
      status: "legacyDrain";
      experimentUnresolved: number;
      experimentPreparedOrUnknown: number;
      experimentRunUnresolved: number;
      experimentRunPreparedOrUnknown: number;
    }
  | {
      status: "activationRequired";
      operationId: string;
      ownerType: ReferenceOwnerType;
      ownerId: string;
      manuscriptChannel: ReferenceOwnerManuscriptChannel;
      ownerSubtype?: ReferenceOwnerSubtype;
      targetFileRefId: string;
      defaultFileRefId: string;
      activationLogicalIdentity: string;
      finalizationIdentity: string;
    }
  | {
      status: "resolved";
      operationId: string;
      ownerType: ReferenceOwnerType;
      ownerId: string;
      manuscriptChannel: ReferenceOwnerManuscriptChannel;
      ownerSubtype?: ReferenceOwnerSubtype;
      targetFileRefId: string;
      defaultFileRefId: string;
    }
  | { status: "recoveries"; items: ReferenceOwnerRecoverySummary[] }
  | {
      status: "targetCleanup";
      operationId: string;
      attempted: boolean;
      classification: "CLEAN" | "RESIDUE" | "TARGET_CHANGED" | "NOT_CLEANED";
      actualPhysicalRevision: string;
      actualRawByteLength: number;
    }
  | { status: "canceled"; operationId: string };

export interface ReferenceOwnerFormalSwitchBridgePort {
  execute(request: ReferenceOwnerBridgeRequest): Promise<ReferenceOwnerBridgeResult>;
}

export const referenceOwnerFormalSwitchBridgePort: ReferenceOwnerFormalSwitchBridgePort =
  Object.freeze({
    execute(request: ReferenceOwnerBridgeRequest) {
      return invoke<ReferenceOwnerBridgeResult>(
        "reference_owner_formal_switch_bridge",
        { request }
      );
    }
  });

export async function listReferenceOwnerFormalSwitchRecoveries(
  ownerType: ReferenceOwnerType,
  ownerId: string,
  manuscriptChannel: ReferenceOwnerManuscriptChannel,
  ownerSubtype?: ReferenceOwnerSubtype
) {
  const result = await referenceOwnerFormalSwitchBridgePort.execute({
    action: "listRecoveries",
    ownerType,
    ownerId,
    manuscriptChannel,
    ownerSubtype
  });
  if (result.status !== "recoveries") throw new Error("FORMAL_SWITCH_RECOVERY_READ_INVALID");
  return result.items;
}

export async function discoverReferenceOwnerFormalSwitchRecoveries() {
  const result = await referenceOwnerFormalSwitchBridgePort.execute({ action: "discoverRecoveries" });
  if (result.status !== "recoveries") throw new Error("FORMAL_SWITCH_RECOVERY_DISCOVERY_INVALID");
  return result.items;
}

interface Token<TSnapshot> {
  ownerId: string;
  operationId: string;
  snapshot: TSnapshot;
  expiresAt: number;
  confirming: boolean;
  targetCleanupPlan: CanonicalFormalSwitchTargetCleanupPlan;
}

export interface ReferenceOwnerProductionProvider<TSnapshot extends FormalSwitchSnapshot> {
  buildBeginInput(input: {
    snapshot: TSnapshot;
    evidence: FormalSwitchRecoveryEvidence;
    expectedPost: string;
    operationId: string;
    occurredAt: string;
    replacements: readonly {
      stableKey: string;
      action: "set" | "clear";
      value?: string;
    }[];
  }): ReferenceOwnerBeginInput;
  activate(snapshot: TSnapshot): Promise<{ sessionKey: string }>;
  activateRecovered(ticket: Extract<ReferenceOwnerBridgeResult, { status: "activationRequired" }>): Promise<{ sessionKey: string }>;
  readActivatedRuntime(input: {
    sessionKey: string;
    ticket: Extract<ReferenceOwnerBridgeResult, { status: "activationRequired" }>;
  }): ReferenceOwnerActivationInput | undefined;
}

export type ReferenceOwnerCanonicalAdapter<
  TSnapshot extends FormalSwitchSnapshot,
  TPreflight,
  TConfirm
> = Pick<
  FormalSwitchAdapter<TSnapshot, TPreflight, TConfirm>,
  | "ownerType"
  | "operationPrefix"
  | "codes"
  | "now"
  | "createId"
  | "acquire"
  | "resolveSnapshot"
  | "isSnapshot"
  | "ready"
  | "revalidateIdentityAndRevision"
  | "isRevalidatedSnapshot"
  | "buildPreparedEvidence"
  | "success"
  | "recoveryRequired"
  | "error"
  | "canceled"
  | "publish"
  | "recordPrePreparedFailure"
> & {
  readonly schemaProvenance?: string;
  resolveLifecycleEligibility(ownerId: string): Promise<{
    canSwitch: boolean;
    reasonCode?: string;
  }>;
};

const activationTails = new Map<string, Promise<void>>();
const locallyActivatedSessions = new Map<string, string>();
const targetCleanupAttempts = new Set<string>();

async function withActivationSerialization<T>(identity: string, run: () => Promise<T>) {
  const previous = activationTails.get(identity) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => tail);
  activationTails.set(identity, queued);
  await previous;
  try {
    return await run();
  } finally {
    release();
    if (activationTails.get(identity) === queued) activationTails.delete(identity);
  }
}

function timestamp(value: string) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function failure<TSnapshot extends FormalSwitchSnapshot, TPreflight, TConfirm>(
  adapter: ReferenceOwnerCanonicalAdapter<TSnapshot, TPreflight, TConfirm>,
  operationId: string,
  stage: FormalSwitchError["stage"],
  causeCode: string,
  recoveryRequired: boolean,
  databaseCommitted = false
): FormalSwitchError {
  const code = recoveryRequired ? adapter.codes.recovery : adapter.codes.stale;
  return {
    code,
    errorCode: code,
    message: causeCode,
    stage,
    causeCode,
    recoverability: recoveryRequired ? "recovery-required" : "retry",
    recoveryRequired,
    operationId,
    provenance: {
      frontendProvenance: "reference_owner_formal_switch_production_bridge_v1",
      rustProvenance: "canonical_formal_switch_engine_v1",
      schemaProvenance: adapter.schemaProvenance ?? "schema-v53"
    },
    sideEffectSummary: {
      oldCurrentWritten: recoveryRequired,
      targetWritten: false,
      databaseCommitted,
      sessionActivated: false
    }
  };
}

function cause(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function listCanonicalRecoveries(
  port: ReferenceOwnerFormalSwitchBridgePort,
  ownerType: ReferenceOwnerType,
  ownerId: string,
  manuscriptChannel: ReferenceOwnerManuscriptChannel,
  ownerSubtype?: ReferenceOwnerSubtype
) {
  const result = await port.execute({
    action: "listRecoveries",
    ownerType,
    ownerId,
    manuscriptChannel,
    ownerSubtype
  });
  if (result.status !== "recoveries") {
    throw new Error("FORMAL_SWITCH_RECOVERY_READ_INVALID");
  }
  return result.items;
}

type ReferenceOwnerOperationResult = Extract<
  ReferenceOwnerBridgeResult,
  { status: "activationRequired" | "resolved" }
>;

function assertOperationIdentity(
  result: ReferenceOwnerOperationResult,
  ownerType: ReferenceOwnerType,
  manuscriptChannel: ReferenceOwnerManuscriptChannel,
  ownerId?: string,
  ownerSubtype?: ReferenceOwnerSubtype
) {
  if (
    result.ownerType !== ownerType ||
    result.manuscriptChannel !== manuscriptChannel ||
    (ownerId !== undefined && result.ownerId !== ownerId) ||
    (ownerSubtype !== undefined && result.ownerSubtype !== ownerSubtype)
  ) {
    throw new Error("FORMAL_SWITCH_RECOVERY_IDENTITY_MISMATCH");
  }
}

export function createReferenceOwnerFormalSwitchProductionBridge<
  TSnapshot extends FormalSwitchSnapshot,
  TPreflight,
  TConfirm
>(input: {
  adapter: ReferenceOwnerCanonicalAdapter<TSnapshot, TPreflight, TConfirm>;
  provider: ReferenceOwnerProductionProvider<TSnapshot>;
  manuscriptChannel: ReferenceOwnerManuscriptChannel;
  ownerSubtype?: ReferenceOwnerSubtype;
  port?: ReferenceOwnerFormalSwitchBridgePort;
}) {
  const { adapter, provider, manuscriptChannel, ownerSubtype } = input;
  const port = input.port ?? referenceOwnerFormalSwitchBridgePort;
  const tokens = new Map<string, Token<TSnapshot>>();
  const descriptorLookupIdentity = Object.freeze({
    ownerType: adapter.ownerType,
    channel: manuscriptChannel,
    ...(ownerSubtype ? { reviewType: ownerSubtype } : {})
  });

  async function finishActivation(
    ticket: Extract<ReferenceOwnerBridgeResult, { status: "activationRequired" }>,
    activate: () => Promise<{ sessionKey: string }>,
    fresh?: Readonly<{ targetCleanupPlan: CanonicalFormalSwitchTargetCleanupPlan }>
  ) {
    assertOperationIdentity(
      ticket,
      adapter.ownerType,
      manuscriptChannel,
      ticket.ownerId,
      ownerSubtype
    );
    return withActivationSerialization(ticket.activationLogicalIdentity, async () => {
      const now = new Date().toISOString();
      const current = await port.execute({
        action: "continue",
        operationId: ticket.operationId,
        occurredAt: now,
        occurredAtEpochMs: timestamp(now)
      });
      if (current.status === "resolved") {
        assertOperationIdentity(
          current,
          adapter.ownerType,
          manuscriptChannel,
          ticket.ownerId,
          ownerSubtype
        );
        locallyActivatedSessions.delete(ticket.operationId);
        return { activated: { sessionKey: "" }, resolved: current };
      }
      if (current.status !== "activationRequired") {
        throw new Error("FORMAL_SWITCH_ACTIVATION_REVALIDATION_INVALID");
      }
      assertOperationIdentity(
        current,
        adapter.ownerType,
        manuscriptChannel,
        ticket.ownerId,
        ownerSubtype
      );
      if (
        current.targetFileRefId !== ticket.targetFileRefId ||
        current.defaultFileRefId !== ticket.defaultFileRefId ||
        current.activationLogicalIdentity !== ticket.activationLogicalIdentity ||
        current.finalizationIdentity !== ticket.finalizationIdentity
      ) {
        throw new Error("FORMAL_SWITCH_RECOVERY_ENVELOPE_MISMATCH");
      }
      if (
        fresh?.targetCleanupPlan.cleanupRequired &&
        !targetCleanupAttempts.has(ticket.operationId)
      ) {
        targetCleanupAttempts.add(ticket.operationId);
        try {
          await port.execute({
            action: "cleanupTarget",
            operationId: ticket.operationId,
            cleanup: {
              expectedRevision: fresh.targetCleanupPlan.expectedRevision,
              expectedPreByteLength: fresh.targetCleanupPlan.expectedPreByteLength,
              expectedPostText: fresh.targetCleanupPlan.expectedPostText,
              exactMarkerSpans: fresh.targetCleanupPlan.exactMarkerSpans
            }
          });
        } catch {
          // F5-4 cleanup is same-process, best-effort, and never retried. The
          // canonical Runtime convergence below must consume actual bytes.
        }
      }
      const existingSessionKey = locallyActivatedSessions.get(ticket.operationId);
      const activated = existingSessionKey
        ? { sessionKey: existingSessionKey }
        : await activate();
      locallyActivatedSessions.set(ticket.operationId, activated.sessionKey);
      const runtime = await provider.readActivatedRuntime({
        sessionKey: activated.sessionKey,
        ticket
      });
      if (!runtime || !runtime.exactActive) {
        throw new Error("FORMAL_SWITCH_ACTIVATION_READBACK_INVALID");
      }
      const resolved = await port.execute({
        action: "resolveActivation",
        operationId: ticket.operationId,
        activation: runtime,
        occurredAtEpochMs: Date.now()
      });
      if (resolved.status !== "resolved") {
        throw new Error("FORMAL_SWITCH_ACTIVATION_RESOLUTION_INVALID");
      }
      assertOperationIdentity(
        resolved,
        adapter.ownerType,
        manuscriptChannel,
        ticket.ownerId,
        ownerSubtype
      );
      locallyActivatedSessions.delete(ticket.operationId);
      targetCleanupAttempts.delete(ticket.operationId);
      return { activated, resolved };
    });
  }

  return Object.freeze({
    async preflight(ownerId: string, targetSessionKey: string): Promise<TPreflight> {
      try {
        const lifecycle = await adapter.resolveLifecycleEligibility(ownerId);
        if (!lifecycle.canSwitch) {
          return adapter.error(failure(
            adapter,
            adapter.createId(adapter.operationPrefix),
            "preflight",
            `FORMAL_SWITCH_LIFECYCLE_${lifecycle.reasonCode ?? "DENIED"}`,
            false
          )) as TPreflight;
        }
      } catch {
        return adapter.error(failure(
          adapter,
          adapter.createId(adapter.operationPrefix),
          "preflight",
          "FORMAL_SWITCH_LIFECYCLE_UNAVAILABLE",
          false
        )) as TPreflight;
      }
      const active = await listCanonicalRecoveries(
        port,
        adapter.ownerType,
        ownerId,
        manuscriptChannel,
        ownerSubtype
      );
      if (active.length) {
        return adapter.error(failure(adapter, adapter.createId(adapter.operationPrefix), "preflight", "FORMAL_SWITCH_RECOVERY_PENDING", false)) as TPreflight;
      }
      const resolved = await adapter.resolveSnapshot(ownerId, targetSessionKey);
      if (!adapter.isSnapshot(resolved)) return resolved;
      const targetCleanupPlan = buildCanonicalFormalSwitchTargetCleanupPlan({
        rawMarkdown: resolved.targetRawText,
        expectedRevision: resolved.targetRevision
      });
      const token = adapter.createId(`${adapter.operationPrefix}-preflight`);
      const operationId = adapter.createId(adapter.operationPrefix);
      const expiresAt = Date.now() + 10 * 60 * 1000;
      tokens.set(token, {
        ownerId,
        operationId,
        snapshot: resolved,
        expiresAt,
        confirming: false,
        targetCleanupPlan
      });
      return adapter.ready(resolved, token, operationId, new Date(expiresAt).toISOString());
    },

    async confirm(preflightToken: string): Promise<TConfirm> {
      const token = tokens.get(preflightToken);
      if (!token || token.expiresAt < Date.now() || token.confirming) {
        return adapter.error(failure(adapter, token?.operationId ?? adapter.createId(adapter.operationPrefix), "confirm-revalidate", "FORMAL_SWITCH_TOKEN_STALE", false)) as TConfirm;
      }
      token.confirming = true;
      const release = adapter.acquire(token.ownerId);
      if (!release) {
        token.confirming = false;
        return adapter.error(failure(adapter, token.operationId, "confirm-revalidate", "FORMAL_SWITCH_RESOURCE_BUSY", false)) as TConfirm;
      }
      let prepared = false;
      try {
        const checked = await adapter.revalidateIdentityAndRevision(token.snapshot, {
          operationId: token.operationId,
          confirmInvocationCount: 1,
          revalidationInvocationCount: 1,
          confirmTimestamp: adapter.now(),
          revalidationTimestamp: adapter.now()
        });
        if (!adapter.isRevalidatedSnapshot(checked)) return checked;
        const occurredAt = adapter.now();
        const built = await adapter.buildPreparedEvidence(checked, token.operationId, occurredAt);
        const candidate = buildCanonicalFormalSwitchArchiveCandidate({
          rawMarkdown: checked.targetRawText,
          descriptorLookupIdentity
        });
        if (!candidate.ok) {
          throw new Error(
            `FORMAL_SWITCH_ARCHIVE_${candidate.error.stage.toUpperCase()}_${candidate.error.code}`
          );
        }
        const targetCleanupPlan = buildCanonicalFormalSwitchTargetCleanupPlan({
          rawMarkdown: checked.targetRawText,
          expectedRevision: checked.targetRevision
        });
        if (
          JSON.stringify(targetCleanupPlan) !==
          JSON.stringify(token.targetCleanupPlan)
        ) {
          throw new Error("FORMAL_SWITCH_TARGET_ARCHIVE_PLAN_CHANGED");
        }
        const begin = input.provider.buildBeginInput({
          snapshot: checked,
          evidence: built.evidence,
          expectedPost: built.expectedPost,
          operationId: token.operationId,
          occurredAt,
          replacements: candidate.orderedReplacementDto.orderedReplacements
        });
        const result = await port.execute({ action: "begin", input: begin });
        prepared = true;
        if (result.status !== "activationRequired" && result.status !== "resolved") {
          throw new Error("FORMAL_SWITCH_CANONICAL_BRIDGE_RESULT_INVALID");
        }
        assertOperationIdentity(
          result,
          adapter.ownerType,
          manuscriptChannel,
          token.ownerId,
          ownerSubtype
        );
        let sessionKey: string;
        if (result.status === "activationRequired") {
          const finished = await finishActivation(
            result,
            () => provider.activate(checked),
            { targetCleanupPlan }
          );
          sessionKey = finished.activated.sessionKey;
        } else {
          sessionKey = "";
        }
        tokens.delete(preflightToken);
        adapter.publish(checked, token.operationId);
        return adapter.success(checked, token.operationId, sessionKey);
      } catch (error) {
        const recovery = prepared || (await listCanonicalRecoveries(
          port,
          adapter.ownerType,
          token.ownerId,
          manuscriptChannel,
          ownerSubtype
        ))
          .some((item) => item.operationId === token.operationId);
        const diagnostic = failure(
          adapter,
          token.operationId,
          recovery ? "recovery-log" : "confirm-revalidate",
          cause(error),
          recovery
        );
        if (!recovery) await adapter.recordPrePreparedFailure?.({
          ...diagnostic,
          ownerType: adapter.ownerType as TSnapshot["ownerType"],
          ownerId: token.ownerId,
          sourceSafeIdentity: token.snapshot.currentFileRefId,
          targetSafeIdentity: token.snapshot.targetFileRefId
        });
        return recovery
          ? adapter.recoveryRequired(diagnostic)
          : adapter.error(diagnostic) as TConfirm;
      } finally {
        token.confirming = false;
        release();
      }
    },

    listRecoveries(ownerId: string) {
      return listCanonicalRecoveries(
        port,
        adapter.ownerType,
        ownerId,
        manuscriptChannel,
        ownerSubtype
      );
    },

    async continueRecovery(operationId: string, expectedOwnerId?: string): Promise<TConfirm> {
      try {
        const occurredAt = adapter.now();
        const result = await port.execute({
          action: "continue",
          operationId,
          occurredAt,
          occurredAtEpochMs: timestamp(occurredAt)
        });
        if (result.status === "activationRequired" || result.status === "resolved") {
          assertOperationIdentity(
            result,
            adapter.ownerType,
            manuscriptChannel,
            expectedOwnerId,
            ownerSubtype
          );
        }
        if (result.status === "resolved") {
          const snapshot = {
            ownerType: result.ownerType,
            ownerId: result.ownerId,
            channel: result.manuscriptChannel,
            ownerSubtype: result.ownerSubtype,
            targetFileRefId: result.targetFileRefId,
            defaultFileRefId: result.defaultFileRefId
          } as unknown as TSnapshot;
          return adapter.success(snapshot, operationId, "");
        }
        if (result.status !== "activationRequired") throw new Error("FORMAL_SWITCH_RECOVERY_RESULT_INVALID");
        const finished = await finishActivation(result, () => provider.activateRecovered(result));
        const snapshot = {
          ownerType: result.ownerType,
          ownerId: result.ownerId,
          channel: result.manuscriptChannel,
          ownerSubtype: result.ownerSubtype,
          targetFileRefId: result.targetFileRefId,
          defaultFileRefId: result.defaultFileRefId,
          parentOwnerId: undefined
        } as unknown as TSnapshot;
        return adapter.success(snapshot, operationId, finished.activated.sessionKey);
      } catch (error) {
        return adapter.recoveryRequired(failure(adapter, operationId, "recovery-log", cause(error), true));
      }
    },

    async safeCancel(operationId: string, expectedOwnerId?: string): Promise<TConfirm> {
      try {
        if (expectedOwnerId !== undefined) {
          const active = await listCanonicalRecoveries(
            port,
            adapter.ownerType,
            expectedOwnerId,
            manuscriptChannel,
            ownerSubtype
          );
          if (!active.some((item) => item.operationId === operationId)) {
            throw new Error("FORMAL_SWITCH_RECOVERY_IDENTITY_MISMATCH");
          }
        }
        const result = await port.execute({ action: "cancelPrepared", operationId, occurredAtEpochMs: Date.now() });
        if (result.status !== "canceled") throw new Error("FORMAL_SWITCH_SAFE_CANCEL_INVALID");
        return adapter.canceled(operationId);
      } catch (error) {
        return adapter.error(failure(adapter, operationId, "recovery-log", cause(error), true)) as TConfirm;
      }
    }
  });
}
