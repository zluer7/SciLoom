import type { ExperimentManuscriptOwnerType } from "../types/experimentManuscript";
import {
  EXPERIMENT_RUN_LIFECYCLE_ERROR_CODES as CODES,
  type ExperimentRunLifecycleDatabasePreflight,
  type ExperimentRunLifecycleErrorCode,
  type ExperimentRunLifecycleMutationResult,
  type ExperimentRunLifecyclePreflightResult,
  type ExperimentRunLifecycleSessionSummary
} from "../types/experimentRunLifecycle";
import { getPlanningData } from "./planningRepository";
import { sharedManuscriptSessionRuntime } from "./sharedManuscriptSessionComposition";
import {
  getExperimentRunRawLifecycleSessionBlock,
  experimentRunManuscriptLifecycleSessionRegistry
} from "./experimentRunManuscriptLifecycleSessionRegistry";
import {
  getExperimentManuscriptOwnerOperation,
  tryAcquireExperimentManuscriptOwnerOperation
} from "./experimentManuscriptOwnerOperationGate";
import {
  confirmExperimentRunLifecycleHardMetadataDelete,
  inspectExperimentRunLifecycleDatabase,
  issueExperimentRunLifecyclePreflightToken,
  restoreExperimentRunLifecycleMetadata,
  softDeleteExperimentRunLifecycleMetadata
} from "./experimentRunLifecycleTransactionService";
import { publishRefreshEvent } from "./refreshEventService";
import { resolveMountedManuscriptLifecycleDecision } from "./fileRefOwnerValidator";

type TokenRecord = {
  ownerType: ExperimentManuscriptOwnerType;
  ownerId: string;
  database: ExperimentRunLifecycleDatabasePreflight;
  sessionDigest: string;
  externalDependencyDigest: string;
  expiresAtMs: number;
};

const tokens = new Map<string, TokenRecord>();

function lifecycleCode(cause: unknown): ExperimentRunLifecycleErrorCode {
  const message = cause instanceof Error ? cause.message : String(cause);
  return Object.values(CODES).find((code) => message.includes(code)) ?? CODES.transactionFailed;
}

function errorResult(cause: unknown): Extract<ExperimentRunLifecycleMutationResult, { status: "error" }> {
  const code = lifecycleCode(cause);
  return { status: "error", error: { code, message: code } };
}

function fnv(value: string) {
  const bytes = new TextEncoder().encode(value);
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function summarizeSessions(ownerType: ExperimentManuscriptOwnerType, ownerId: string) {
  const sessions: ExperimentRunLifecycleSessionSummary[] = ownerType === "experimentRun"
    ? experimentRunManuscriptLifecycleSessionRegistry.listOwnerSessions(ownerId).map((session) => ({
        sessionKey: session.sessionKey,
        fileRefId: session.fileRefId,
        mode: session.mode,
        dirty: session.dirty,
        loadStatus: session.loading || session.reloading ? "loading" : "ready",
        saveStatus: session.saving
          ? "saving"
          : session.conflict
            ? "conflict"
            : session.recovery
              ? "recovery-required"
              : "idle",
        conflict: session.conflict,
        writeAppliedUnverified: session.writeAppliedUnverified,
        recovery: session.recovery,
        closed: session.closed,
        disposed: session.disposed,
        ownerDeleted: session.ownerDeleted,
        parentDeleted: session.parentDeleted,
        revalidationRequired: session.writeAppliedUnverified || session.recovery
      }))
    : sharedManuscriptSessionRuntime.listSessions()
        .filter((session) => session.owner.ownerType === ownerType && session.owner.ownerId === ownerId)
        .map((session) => ({
          sessionKey: session.sessionKey,
          fileRefId: session.file.kind === "durable" ? session.file.fileRefId : undefined,
          dirty: session.dirty,
          loadStatus: session.loadStatus,
          saveStatus: session.saveStatus,
          conflict: session.saveStatus === "conflict",
          writeAppliedUnverified:
            session.recoveryRequired && session.recovery?.writeApplied !== false,
          recovery: session.recoveryRequired,
          closed: false,
          disposed: false,
          ownerDeleted: false,
          parentDeleted: false,
          revalidationRequired: session.recoveryRequired
        }));
  return sessions.sort((a, b) => a.sessionKey.localeCompare(b.sessionKey));
}

function sessionDigest(sessions: ExperimentRunLifecycleSessionSummary[]) {
  return fnv(JSON.stringify(sessions));
}

async function externalDependencyDigest(ownerType: ExperimentManuscriptOwnerType, ownerId: string) {
  const links = (await getPlanningData()).entityLinks.filter((link) =>
    (link.sourceType === ownerType && link.sourceId === ownerId) ||
    (link.targetType === ownerType && link.targetId === ownerId)
  );
  const identities = links.map((link) => `${link.id}:${link.sourceType}:${link.sourceId}:${link.targetType}:${link.targetId}:${link.relationType}`).sort();
  return { count: identities.length, digest: fnv(JSON.stringify(identities)) };
}

function databaseBlock(preflight: ExperimentRunLifecycleDatabasePreflight): ExperimentRunLifecycleErrorCode | undefined {
  if (!preflight.deleted) return CODES.ownerNotDeleted;
  if (preflight.blockingDependencies.some((item) => item.kind === "runs")) return CODES.runsExist;
  if (preflight.metricCount > 0) return CODES.metricsExist;
  if (preflight.blockingDependencies.some((item) => ["resultItems", "fileRefInboundReferences", "outputSourceLinks", "outputConversionRelations", "literatureLinks"].includes(item.kind))) {
    return CODES.sourceDependenciesExist;
  }
  if (preflight.blockingDependencies.length > 0) return CODES.businessDependenciesExist;
  return undefined;
}

async function preflight(ownerType: ExperimentManuscriptOwnerType, ownerId: string): Promise<ExperimentRunLifecyclePreflightResult> {
  try {
    if (getExperimentManuscriptOwnerOperation(ownerType, ownerId)) {
      return { status: "blocked", error: { code: CODES.sessionSaving, message: CODES.sessionSaving } };
    }
    const [database, external] = await Promise.all([
      inspectExperimentRunLifecycleDatabase(ownerType, ownerId),
      externalDependencyDigest(ownerType, ownerId)
    ]);
    const databaseBlockingCode = databaseBlock(database);
    if (databaseBlockingCode) {
      return { status: "blocked", error: { code: databaseBlockingCode, message: databaseBlockingCode }, preflight: database };
    }
    if (external.count > 0) {
      return { status: "blocked", error: { code: CODES.businessDependenciesExist, message: CODES.businessDependenciesExist }, preflight: database };
    }
    const sessions = summarizeSessions(ownerType, ownerId);
    const sessionBlockingCode = getExperimentRunRawLifecycleSessionBlock(sessions);
    if (sessionBlockingCode) {
      return { status: "blocked", error: { code: sessionBlockingCode, message: sessionBlockingCode }, preflight: database };
    }
    const digest = sessionDigest(sessions);
    const issued = await issueExperimentRunLifecyclePreflightToken({
      ownerType,
      ownerId,
      expectedStateDigest: database.stateDigest,
      sessionDigest: digest,
      externalDependencyDigest: external.digest
    });
    for (const [token, record] of tokens) {
      if (record.expiresAtMs < Date.now()) tokens.delete(token);
    }
    tokens.set(issued.preflightToken, {
      ownerType, ownerId, database, sessionDigest: digest,
      externalDependencyDigest: external.digest,
      expiresAtMs: issued.expiresAtUnixMs
    });
    return {
      status: "ready", ...database, requiresConfirmation: true,
      preflightToken: issued.preflightToken,
      expiresAt: new Date(issued.expiresAtUnixMs).toISOString(),
      sessionDigest: digest, sessions
    };
  } catch (cause) {
    return { status: "error", error: errorResult(cause).error };
  }
}

async function confirm(token: string): Promise<ExperimentRunLifecycleMutationResult> {
  const record = tokens.get(token);
  if (!record) return errorResult(CODES.preflightConsumed);
  tokens.delete(token);
  const release = tryAcquireExperimentManuscriptOwnerOperation(record.ownerType, record.ownerId, "hardMetadataDelete");
  if (!release) return errorResult(CODES.sessionSaving);
  let committed = false;
  try {
    const sessions = summarizeSessions(record.ownerType, record.ownerId);
    const blocking = getExperimentRunRawLifecycleSessionBlock(sessions);
    if (blocking) return errorResult(blocking);
    if (sessionDigest(sessions) !== record.sessionDigest) return errorResult(CODES.ownerChanged);
    const external = await externalDependencyDigest(record.ownerType, record.ownerId);
    if (external.count > 0 || external.digest !== record.externalDependencyDigest) return errorResult(CODES.businessDependenciesExist);
    const occurredAt = new Date().toISOString();
    const result = await confirmExperimentRunLifecycleHardMetadataDelete({
      preflightToken: token,
      occurredAt,
      operationId: crypto.randomUUID()
    });
    if (result.status === "error") return result;
    committed = true;
    if (record.ownerType === "experimentRun") {
      experimentRunManuscriptLifecycleSessionRegistry.disposeOwner(record.ownerId);
    } else {
      const closed = await sharedManuscriptSessionRuntime.closeCleanSessions(
        (item) =>
          item.owner.ownerType === record.ownerType &&
          item.owner.ownerId === record.ownerId
      );
      if (!closed) throw new Error(CODES.postCommitVerifyFailed);
    }
    publishLifecycleRefresh(record.ownerType, record.ownerId, "hardDelete", occurredAt);
    return result;
  } catch (cause) {
    return committed ? errorResult(CODES.postCommitVerifyFailed) : errorResult(cause);
  } finally {
    release();
  }
}

function publishLifecycleRefresh(
  ownerType: ExperimentManuscriptOwnerType,
  ownerId: string,
  operation: string,
  occurredAt: string,
  status: "success" | "partial" = "success"
) {
  try {
    publishRefreshEvent({
      id: `experiment-lifecycle-${operation}-${ownerId}-${occurredAt}`,
      keys: [ownerType === "experiment" ? "experiment.changed" : "experimentRun.changed", "fileRef.changed", "operationLog.changed"],
      affectedEntities: [{ type: ownerType, id: ownerId, relation: operation === "restore" ? "restored" : "deleted" }],
      affectedScopes: [{ module: "experiment", reason: `Experiment metadata lifecycle ${operation}.` }],
      source: "service.write", operation: `experiment.lifecycle.${operation}`,
      reason: "Metadata-only lifecycle operation committed without physical file actions.",
      writeFeedbackStatus: status, createdAt: occurredAt
    });
    return true;
  } catch {
    return false;
  }
}

async function mutate(ownerType: ExperimentManuscriptOwnerType, ownerId: string, restore: boolean): Promise<ExperimentRunLifecycleMutationResult> {
  const release = tryAcquireExperimentManuscriptOwnerOperation(ownerType, ownerId, "metadataLifecycle");
  if (!release) return errorResult(CODES.sessionSaving);
  const occurredAt = new Date().toISOString();
  let committed = false;
  try {
    const before = await resolveMountedManuscriptLifecycleDecision({
      ownerType,
      ownerId,
      manuscriptChannel: "primary"
    });
    if (restore ? !before.canRestore : !before.canWrite) {
      return errorResult(
        restore
          ? CODES.ownerNotDeleted
          : before.ownerDeleted
            ? CODES.ownerAlreadyDeleted
            : before.parentDeleted
              ? CODES.parentDeleted
              : CODES.transactionFailed
      );
    }
    const closed = await sharedManuscriptSessionRuntime.closeCleanSessions(
      (session) =>
        session.owner.ownerType === ownerType &&
        session.owner.ownerId === ownerId &&
        session.owner.channel === "primary"
    );
    if (!closed) return errorResult(CODES.sessionDirty);

    const input = { ownerType, ownerId, occurredAt, operationId: crypto.randomUUID() };
    const result = restore
      ? await restoreExperimentRunLifecycleMetadata(input)
      : await softDeleteExperimentRunLifecycleMetadata(input);
    if (result.status === "error" || !result.changed) return result;
    committed = true;
    const readback = await resolveMountedManuscriptLifecycleDecision({
      ownerType,
      ownerId,
      manuscriptChannel: "primary"
    });
    if (readback.ownerDeleted !== !restore) {
      return errorResult(CODES.postCommitVerifyFailed);
    }
    const warnings: string[] = [];
    try {
      if (ownerType === "experimentRun") {
        await experimentRunManuscriptLifecycleSessionRegistry.setOwnerDeleted(ownerId, !restore);
      } else {
        await experimentRunManuscriptLifecycleSessionRegistry.setParentDeleted(ownerId, !restore);
      }
    } catch {
      warnings.push("Committed metadata state was refreshed, but mounted session projection cleanup needs retry.");
    }
    const provisionalStatus = warnings.length > 0 ? "partial" : "success";
    const refreshPublished = publishLifecycleRefresh(
      ownerType,
      ownerId,
      restore ? "restore" : "softDelete",
      occurredAt,
      provisionalStatus
    );
    if (!refreshPublished) {
      warnings.push("Metadata mutation was committed, but lifecycle refresh publication needs retry.");
    }
    const partial = warnings.length > 0;
    return {
      ...result,
      partial,
      warnings,
      occurredAt,
      authoritativeState: restore ? "active" : "deleted"
    };
  } catch (cause) {
    return committed ? errorResult(CODES.postCommitVerifyFailed) : errorResult(cause);
  } finally {
    release();
  }
}

export function preflightExperimentHardMetadataDelete(experimentId: string) { return preflight("experiment", experimentId); }
export function preflightExperimentRunHardMetadataDelete(runId: string) { return preflight("experimentRun", runId); }
export function confirmExperimentHardMetadataDelete(preflightToken: string) { return confirm(preflightToken); }
export function confirmExperimentRunHardMetadataDelete(preflightToken: string) { return confirm(preflightToken); }
export function softDeleteExperimentMetadata(experimentId: string) { return mutate("experiment", experimentId, false); }
export function softDeleteExperimentRunMetadata(runId: string) { return mutate("experimentRun", runId, false); }
export function restoreExperimentMetadata(experimentId: string) { return mutate("experiment", experimentId, true); }
export function restoreExperimentRunMetadata(runId: string) { return mutate("experimentRun", runId, true); }

export const experimentRunLifecycleService = {
  preflightExperimentHardMetadataDelete, preflightExperimentRunHardMetadataDelete,
  confirmExperimentHardMetadataDelete, confirmExperimentRunHardMetadataDelete,
  softDeleteExperimentMetadata, softDeleteExperimentRunMetadata,
  restoreExperimentMetadata, restoreExperimentRunMetadata
};
