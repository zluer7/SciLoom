export const FORMAL_SWITCH_RECOVERY_PHASES = [
  "prepared",
  "writeback_unknown",
  "writeback_applied",
  "db_commit_unknown",
  "db_committed",
  "activation_pending",
  "resolved",
  "blocked",
  "cancelled_safe"
] as const;

export type FormalSwitchRecoveryPhase =
  (typeof FORMAL_SWITCH_RECOVERY_PHASES)[number];

export type FormalSwitchStage =
  | "preflight"
  | "confirm-revalidate"
  | "context-summary"
  | "recovery-log"
  | "old-current-writeback"
  | "database-transaction"
  | "post-verify"
  | "session-activation"
  | "page-refresh";

export interface FormalSwitchError {
  code: string;
  errorCode: string;
  message: string;
  stage: FormalSwitchStage;
  causeCode: string;
  recoverability: "none" | "retry" | "reselect" | "resolve-conflict" | "recovery-required";
  recoveryRequired: boolean;
  operationId: string;
  recoveryPhase?: FormalSwitchRecoveryPhase;
  sideEffectSummary: {
    oldCurrentWritten: boolean;
    targetWritten: false;
    databaseCommitted: boolean;
    sessionActivated: boolean;
  };
  provenance: {
    frontendProvenance: string;
    rustProvenance: string;
    schemaProvenance: string;
  };
  diagnosticDetails?: Record<string, unknown>;
}

function safeDiagnosticValue(value: unknown) {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,160}$/u.test(value)
    ? value
    : "unknown";
}

export function formatFormalSwitchDiagnostic(error: Partial<FormalSwitchError>) {
  return [
    `stage=${safeDiagnosticValue(error.stage)}`,
    `cause=${safeDiagnosticValue(error.causeCode)}`,
    `operation=${safeDiagnosticValue(error.operationId)}`,
    `frontend=${safeDiagnosticValue(error.provenance?.frontendProvenance)}`,
    `rust=${safeDiagnosticValue(error.provenance?.rustProvenance)}`,
    `schema=${safeDiagnosticValue(error.provenance?.schemaProvenance)}`
  ].join("; ");
}

export interface FormalSwitchSnapshot {
  ownerType:
    | "experiment"
    | "experimentRun"
    | "literature"
    | "review"
    | "resultItem"
    | "finding"
    | "outputCandidate"
    | "outputGap"
    | "researchOutput";
  ownerId: string;
  parentOwnerId?: string;
  channel: "primary" | "literature_outline" | "dedicated_notes";
  bindingId: string;
  currentFileRefId: string;
  defaultFileRefId: string;
  targetFileRefId: string;
  currentFileName: string;
  defaultFileName: string;
  targetFileName: string;
  targetLocationMode: "managed" | "external";
  currentRevision: string;
  targetRevision: string;
  currentRawText: string;
  targetRawText: string;
  replacements: readonly unknown[];
  diagnostics: readonly { code: string }[];
}

export interface FormalSwitchRecoveryEvidence {
  operationId: string;
  ownerType: FormalSwitchSnapshot["ownerType"];
  ownerId: string;
  parentOwnerId?: string;
  channel: FormalSwitchSnapshot["channel"];
  phase: FormalSwitchRecoveryPhase;
  oldCurrentFileRefId: string;
  defaultFileRefId: string;
  targetFileRefId: string;
  oldCurrentFileName: string;
  defaultFileName: string;
  targetFileName: string;
  oldCurrentPreRevision: string;
  oldCurrentPreDigest: string;
  oldCurrentExpectedPostDigest: string;
  targetRevision: string;
  targetDigest: string;
  oldCurrentPostRevision?: string;
  writebackVerificationResult?: string;
  prepareInput: unknown;
}

export interface FormalSwitchPostVerify {
  status:
    | "not_committed"
    | "committed_exact"
    | "committed_mismatch"
    | "ambiguous"
    | "identity_missing"
    | "duplicate_operation_log";
  safeDiagnosticCode: string;
}

export interface FormalSwitchRecoveryRepository {
  list(ownerType: FormalSwitchSnapshot["ownerType"], ownerId: string): Promise<FormalSwitchRecoveryEvidence[]>;
  get(operationId: string): Promise<FormalSwitchRecoveryEvidence | undefined>;
  prepare(evidence: FormalSwitchRecoveryEvidence): Promise<void>;
  transition(input: {
    operationId: string;
    expectedPhase: FormalSwitchRecoveryPhase;
    nextPhase: FormalSwitchRecoveryPhase;
    occurredAt: string;
    oldCurrentPostRevision?: string;
    writebackVerificationResult?: string;
    lastErrorCode?: string;
    lastDiagnosticSummary?: string;
  }): Promise<void>;
  postVerify(operationId: string): Promise<FormalSwitchPostVerify>;
  completeDatabase(operationId: string, oldCurrentPostRevision: string, occurredAt: string): Promise<FormalSwitchPostVerify>;
  safeCancel(operationId: string, observedRevision: string, occurredAt: string): Promise<void>;
}

interface FormalSwitchCodes {
  inProgress: string;
  stale: string;
  recovery: string;
  writeback: string;
  transaction: string;
  postVerify: string;
  activation: string;
}

export interface FormalSwitchAdapter<TSnapshot extends FormalSwitchSnapshot, TPreflight, TConfirm> {
  readonly ownerType: TSnapshot["ownerType"];
  readonly operationPrefix: string;
  readonly codes: FormalSwitchCodes;
  readonly rustProvenance: string;
  readonly schemaProvenance: string;
  readonly recoveryRepository: FormalSwitchRecoveryRepository;
  now(): string;
  createId(prefix: string): string;
  acquire(ownerId: string): (() => void) | undefined;
  resolveSnapshot(ownerId: string, targetSessionKey: string): Promise<TSnapshot | TPreflight>;
  isSnapshot(value: TSnapshot | TPreflight): value is TSnapshot;
  ready(snapshot: TSnapshot, token: string, operationId: string, expiresAt: string): TPreflight;
  revalidateIdentityAndRevision(
    snapshot: TSnapshot,
    context: FormalSwitchRevalidationContext
  ): Promise<TSnapshot | TConfirm>;
  isRevalidatedSnapshot(value: TSnapshot | TConfirm): value is TSnapshot;
  buildPreparedEvidence(snapshot: TSnapshot, operationId: string, occurredAt: string): Promise<{
    evidence: FormalSwitchRecoveryEvidence;
    expectedPost: string;
  }>;
  writeOldCurrent(snapshot: TSnapshot, expectedPost: string): Promise<{ revision: string; rawText: string }>;
  commit(snapshot: TSnapshot, evidence: FormalSwitchRecoveryEvidence, oldCurrentPostRevision: string, occurredAt: string): Promise<void>;
  activate(snapshot: TSnapshot): Promise<{ sessionKey: string }>;
  activateRecovered(evidence: FormalSwitchRecoveryEvidence): Promise<{ sessionKey: string }>;
  openRecoveryCurrent(evidence: FormalSwitchRecoveryEvidence): Promise<{ sessionKey: string; revision: string; rawText: string; dirty: boolean }>;
  rebuildRecoveryPost(evidence: FormalSwitchRecoveryEvidence, currentRawText: string): Promise<string>;
  success(snapshot: TSnapshot, operationId: string, sessionKey: string): TConfirm;
  recoveryRequired(error: FormalSwitchError): TConfirm;
  error(error: FormalSwitchError): TConfirm | TPreflight;
  canceled(operationId: string): TConfirm;
  publish(snapshot: TSnapshot, operationId: string): void;
  recordPrePreparedFailure(details: FormalSwitchError & {
    ownerType: TSnapshot["ownerType"];
    ownerId: string;
    sourceSafeIdentity: string;
    targetSafeIdentity: string;
  }): Promise<void>;
}

export interface FormalSwitchRevalidationContext {
  operationId: string;
  confirmInvocationCount: number;
  revalidationInvocationCount: number;
  confirmTimestamp: string;
  revalidationTimestamp: string;
}

interface Token<TSnapshot extends FormalSwitchSnapshot> {
  adapter: FormalSwitchAdapter<TSnapshot, unknown, unknown>;
  snapshot: TSnapshot;
  operationId: string;
  state: "issued" | "running" | "used";
  expiresAtMs: number;
  confirmInvocationCount: number;
  revalidationInvocationCount: number;
  confirmTimestamp?: string;
}

const TOKEN_TTL_MS = 10 * 60 * 1000;

function hashText(text: string) {
  const bytes = new TextEncoder().encode(text);
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}

function stableCause(error: unknown, fallback: string) {
  const value = (error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "").trim();
  return /^[A-Z][A-Z0-9_:-]{2,120}$/u.test(value) ? value : fallback;
}

function safeMessage(stage: FormalSwitchStage) {
  switch (stage) {
    case "confirm-revalidate": return "确认后文稿状态发生变化，请重新检查后再切换。";
    case "old-current-writeback": return "旧当前稿写回未完成，请先处理恢复提示。";
    case "database-transaction":
    case "post-verify": return "文稿切换的数据库确认未完成，请先处理恢复提示。";
    case "session-activation": return "文稿已切换，但编辑窗口尚未完成激活。";
    default: return "文稿切换未完成，请根据诊断编号重试。";
  }
}

function readDiagnosticDetails(error: unknown) {
  const details = (error as {
    formalSwitchDiagnosticDetails?: unknown;
  } | null)?.formalSwitchDiagnosticDetails;
  return details && typeof details === "object" && !Array.isArray(details)
    ? details as Record<string, unknown>
    : undefined;
}

function failure(
  adapter: FormalSwitchAdapter<FormalSwitchSnapshot, unknown, unknown>,
  operationId: string,
  code: string,
  stage: FormalSwitchStage,
  causeCode: string,
  state: Partial<FormalSwitchError["sideEffectSummary"]> = {},
  recoveryPhase?: FormalSwitchRecoveryPhase,
  diagnosticDetails?: Record<string, unknown>
): FormalSwitchError {
  return {
    code,
    errorCode: code,
    message: safeMessage(stage),
    stage,
    causeCode,
    recoverability: recoveryPhase ? "recovery-required" : "retry",
    recoveryRequired: Boolean(recoveryPhase),
    operationId,
    ...(recoveryPhase ? { recoveryPhase } : {}),
    sideEffectSummary: {
      oldCurrentWritten: state.oldCurrentWritten ?? false,
      targetWritten: false,
      databaseCommitted: state.databaseCommitted ?? false,
      sessionActivated: state.sessionActivated ?? false
    },
    provenance: {
      frontendProvenance: "formal-switch-engine-v1",
      rustProvenance: adapter.rustProvenance,
      schemaProvenance: adapter.schemaProvenance
    },
    ...(diagnosticDetails ? { diagnosticDetails } : {})
  };
}

export function createFormalSwitchEngine() {
  const tokens = new Map<string, Token<FormalSwitchSnapshot>>();

  async function recordPrePreparedFailure<TSnapshot extends FormalSwitchSnapshot>(
    adapter: FormalSwitchAdapter<TSnapshot, unknown, unknown>,
    snapshot: TSnapshot,
    error: FormalSwitchError
  ) {
    await adapter.recordPrePreparedFailure({
      ...error,
      ownerType: snapshot.ownerType,
      ownerId: snapshot.ownerId,
      sourceSafeIdentity: snapshot.currentFileName,
      targetSafeIdentity: snapshot.targetFileName
    });
  }

  async function preflight<TSnapshot extends FormalSwitchSnapshot, TPreflight, TConfirm>(
    adapter: FormalSwitchAdapter<TSnapshot, TPreflight, TConfirm>,
    ownerId: string,
    targetSessionKey: string
  ): Promise<TPreflight> {
    const active = await adapter.recoveryRepository.list(adapter.ownerType, ownerId);
    if (active.length > 0) {
      const error = failure(
        adapter as FormalSwitchAdapter<FormalSwitchSnapshot, unknown, unknown>,
        active[0].operationId,
        adapter.codes.inProgress,
        "preflight",
        "FORMAL_SWITCH_ACTIVE_RESOURCE_CONFLICT",
        {},
        active[0].phase
      );
      return adapter.error(error) as TPreflight;
    }
    const resolved = await adapter.resolveSnapshot(ownerId, targetSessionKey);
    if (!adapter.isSnapshot(resolved)) return resolved;
    const token = adapter.createId("formal-switch-token");
    const operationId = adapter.createId(adapter.operationPrefix);
    const expiresAtMs = Date.now() + TOKEN_TTL_MS;
    tokens.set(token, {
      adapter: adapter as FormalSwitchAdapter<TSnapshot, unknown, unknown>,
      snapshot: resolved,
      operationId,
      state: "issued",
      expiresAtMs,
      confirmInvocationCount: 0,
      revalidationInvocationCount: 0
    });
    return adapter.ready(resolved, token, operationId, new Date(expiresAtMs).toISOString());
  }

  async function confirm<TSnapshot extends FormalSwitchSnapshot, TPreflight, TConfirm>(
    requestedAdapter: FormalSwitchAdapter<TSnapshot, TPreflight, TConfirm>,
    preflightToken: string
  ): Promise<TConfirm> {
    const token = tokens.get(preflightToken);
    if (!token || token.adapter.ownerType !== requestedAdapter.ownerType) {
      const operationId = requestedAdapter.createId(requestedAdapter.operationPrefix);
      return requestedAdapter.error(failure(
        requestedAdapter as FormalSwitchAdapter<FormalSwitchSnapshot, unknown, unknown>,
        operationId,
        requestedAdapter.codes.stale,
        "confirm-revalidate",
        "FORMAL_SWITCH_TOKEN_NOT_FOUND"
      )) as TConfirm;
    }
    const adapter = requestedAdapter;
    const snapshot = token.snapshot as TSnapshot;
    const op = token.operationId;
    token.confirmInvocationCount += 1;
    token.confirmTimestamp ??= adapter.now();
    const failBeforePrepared = async (
      code: string,
      stage: FormalSwitchStage,
      cause: string,
      diagnosticDetails?: Record<string, unknown>
    ) => {
      const error = failure(
        adapter,
        op,
        code,
        stage,
        cause,
        {},
        undefined,
        diagnosticDetails
      );
      try { await recordPrePreparedFailure(adapter, snapshot, error); } catch { /* business state remains zero-write */ }
      token.state = "used";
      return adapter.error(error) as TConfirm;
    };
    if (token.state !== "issued" || Date.now() > token.expiresAtMs) {
      return failBeforePrepared(adapter.codes.stale, "confirm-revalidate", "FORMAL_SWITCH_TOKEN_STALE");
    }
    const release = adapter.acquire(snapshot.ownerId);
    if (!release) return failBeforePrepared(adapter.codes.inProgress, "confirm-revalidate", "FORMAL_SWITCH_RESOURCE_BUSY");
    token.state = "running";
    let prepared = false;
    try {
      let checked: TSnapshot | TConfirm;
      try {
        token.revalidationInvocationCount += 1;
        checked = await adapter.revalidateIdentityAndRevision(snapshot, {
          operationId: op,
          confirmInvocationCount: token.confirmInvocationCount,
          revalidationInvocationCount: token.revalidationInvocationCount,
          confirmTimestamp: token.confirmTimestamp,
          revalidationTimestamp: adapter.now()
        });
      } catch (error) {
        return failBeforePrepared(
          adapter.codes.stale,
          "confirm-revalidate",
          stableCause(error, "FORMAL_SWITCH_REVALIDATE_FAILED"),
          readDiagnosticDetails(error)
        );
      }
      if (!adapter.isRevalidatedSnapshot(checked)) {
        const result = checked as TConfirm;
        const embedded = (result as { error?: FormalSwitchError }).error;
        if (embedded) {
          try { await recordPrePreparedFailure(adapter, snapshot, { ...embedded, operationId: op }); } catch { /* zero-write audit failure */ }
        }
        token.state = "used";
        return result;
      }
      let built: Awaited<ReturnType<typeof adapter.buildPreparedEvidence>>;
      try {
        built = await adapter.buildPreparedEvidence(checked, op, adapter.now());
      } catch (error) {
        return failBeforePrepared(adapter.codes.stale, "context-summary", stableCause(error, "FORMAL_SWITCH_CONTEXT_BUILD_FAILED"));
      }
      try {
        await adapter.recoveryRepository.prepare(built.evidence);
        prepared = true;
      } catch (error) {
        return failBeforePrepared(adapter.codes.recovery, "recovery-log", stableCause(error, "FORMAL_SWITCH_RECOVERY_PREPARE_FAILED"));
      }
      await adapter.recoveryRepository.transition({
        operationId: op,
        expectedPhase: "prepared",
        nextPhase: "writeback_unknown",
        occurredAt: adapter.now(),
        writebackVerificationResult: undefined
      });
      let written: { revision: string; rawText: string };
      try {
        written = await adapter.writeOldCurrent(checked, built.expectedPost);
      } catch (error) {
        const diagnostic = failure(adapter, op, adapter.codes.writeback, "old-current-writeback", stableCause(error, "FORMAL_SWITCH_WRITEBACK_FAILED"), {}, "writeback_unknown");
        return adapter.recoveryRequired(diagnostic) as TConfirm;
      }
      if (hashText(written.rawText) !== built.evidence.oldCurrentExpectedPostDigest) {
        const diagnostic = failure(adapter, op, adapter.codes.writeback, "old-current-writeback", "FORMAL_SWITCH_WRITEBACK_READBACK_MISMATCH", { oldCurrentWritten: true }, "writeback_unknown");
        return adapter.recoveryRequired(diagnostic) as TConfirm;
      }
      built.evidence.phase = "writeback_applied";
      built.evidence.oldCurrentPostRevision = written.revision;
      await adapter.recoveryRepository.transition({
        operationId: op,
        expectedPhase: "writeback_unknown",
        nextPhase: "writeback_applied",
        occurredAt: adapter.now(),
        oldCurrentPostRevision: written.revision,
        writebackVerificationResult: "exact-post"
      });
      await adapter.recoveryRepository.transition({
        operationId: op,
        expectedPhase: "writeback_applied",
        nextPhase: "db_commit_unknown",
        occurredAt: adapter.now(),
        oldCurrentPostRevision: written.revision,
        writebackVerificationResult: "exact-post"
      });
      try {
        await adapter.commit(checked, built.evidence, written.revision, adapter.now());
      } catch {
        // Direct SQLite post-verify below is authoritative for an unknown command response.
      }
      let verified: FormalSwitchPostVerify;
      try {
        verified = await adapter.recoveryRepository.postVerify(op);
      } catch (error) {
        const diagnostic = failure(adapter, op, adapter.codes.postVerify, "post-verify", stableCause(error, "FORMAL_SWITCH_POST_VERIFY_FAILED"), { oldCurrentWritten: true }, "db_commit_unknown");
        return adapter.recoveryRequired(diagnostic) as TConfirm;
      }
      if (verified.status !== "committed_exact") {
        const nextPhase = verified.status === "not_committed" ? "writeback_applied" : "blocked";
        await adapter.recoveryRepository.transition({
          operationId: op,
          expectedPhase: "db_commit_unknown",
          nextPhase,
          occurredAt: adapter.now(),
          oldCurrentPostRevision: written.revision,
          writebackVerificationResult: "exact-post",
          lastErrorCode: verified.safeDiagnosticCode,
          lastDiagnosticSummary: verified.status
        });
        const diagnostic = failure(adapter, op, adapter.codes.transaction, "database-transaction", verified.safeDiagnosticCode, { oldCurrentWritten: true }, nextPhase);
        return adapter.recoveryRequired(diagnostic) as TConfirm;
      }
      const latest = await adapter.recoveryRepository.get(op);
      if (latest?.phase === "db_commit_unknown") {
        await adapter.recoveryRepository.transition({
          operationId: op,
          expectedPhase: "db_commit_unknown",
          nextPhase: "db_committed",
          occurredAt: adapter.now(),
          oldCurrentPostRevision: written.revision,
          writebackVerificationResult: "exact-post"
        });
      }
      let activated: { sessionKey: string };
      try {
        activated = await adapter.activate(checked);
      } catch (error) {
        const persisted = await adapter.recoveryRepository.get(op);
        if (persisted?.phase === "db_committed") {
          await adapter.recoveryRepository.transition({
            operationId: op,
            expectedPhase: "db_committed",
            nextPhase: "activation_pending",
            occurredAt: adapter.now(),
            lastErrorCode: adapter.codes.activation,
            lastDiagnosticSummary: "session activation pending"
          });
        }
        const diagnostic = failure(adapter, op, adapter.codes.activation, "session-activation", stableCause(error, "FORMAL_SWITCH_ACTIVATION_FAILED"), { oldCurrentWritten: true, databaseCommitted: true }, "activation_pending");
        return adapter.recoveryRequired(diagnostic) as TConfirm;
      }
      const beforeResolve = await adapter.recoveryRepository.get(op);
      await adapter.recoveryRepository.transition({
        operationId: op,
        expectedPhase: beforeResolve?.phase === "activation_pending" ? "activation_pending" : "db_committed",
        nextPhase: "resolved",
        occurredAt: adapter.now(),
        lastDiagnosticSummary: "verified and activated"
      });
      adapter.publish(checked, op);
      token.state = "used";
      return adapter.success(checked, op, activated.sessionKey) as TConfirm;
    } catch (error) {
      if (!prepared) return failBeforePrepared(adapter.codes.recovery, "recovery-log", stableCause(error, "FORMAL_SWITCH_PREPARED_NOT_PERSISTED"));
      const phase = (await adapter.recoveryRepository.get(op))?.phase ?? "prepared";
      const diagnostic = failure(adapter, op, adapter.codes.recovery, "recovery-log", stableCause(error, "FORMAL_SWITCH_RECOVERY_TRANSITION_FAILED"), {}, phase);
      return adapter.recoveryRequired(diagnostic) as TConfirm;
    } finally {
      if (token.state === "running") token.state = "used";
      release();
    }
  }

  async function continueRecovery<TSnapshot extends FormalSwitchSnapshot, TPreflight, TConfirm>(
    adapter: FormalSwitchAdapter<TSnapshot, TPreflight, TConfirm>,
    operationId: string
  ): Promise<TConfirm> {
    const evidence = await adapter.recoveryRepository.get(operationId);
    if (!evidence) {
      return adapter.error(failure(adapter as FormalSwitchAdapter<FormalSwitchSnapshot, unknown, unknown>, operationId, adapter.codes.recovery, "recovery-log", "FORMAL_SWITCH_RECOVERY_NOT_FOUND")) as TConfirm;
    }
    const release = adapter.acquire(evidence.ownerId);
    if (!release) {
      return adapter.error(failure(adapter as FormalSwitchAdapter<FormalSwitchSnapshot, unknown, unknown>, operationId, adapter.codes.inProgress, "confirm-revalidate", "FORMAL_SWITCH_RESOURCE_BUSY")) as TConfirm;
    }
    try {
      let phase = evidence.phase;
      let postRevision = evidence.oldCurrentPostRevision;
      if (phase === "prepared" || phase === "writeback_unknown") {
        const current = await adapter.openRecoveryCurrent(evidence);
        if (current.dirty) throw new Error("FORMAL_SWITCH_RECOVERY_CURRENT_DIRTY");
        const currentDigest = hashText(current.rawText);
        if (currentDigest === evidence.oldCurrentPreDigest) {
          if (phase === "prepared") {
            await adapter.recoveryRepository.transition({ operationId, expectedPhase: "prepared", nextPhase: "writeback_unknown", occurredAt: adapter.now() });
          }
          const expectedPost = await adapter.rebuildRecoveryPost(evidence, current.rawText);
          if (hashText(expectedPost) !== evidence.oldCurrentExpectedPostDigest) throw new Error("FORMAL_SWITCH_RECOVERY_EVIDENCE_MISMATCH");
          const snapshot = { ownerType: evidence.ownerType, ownerId: evidence.ownerId, channel: "primary" } as TSnapshot;
          const written = await adapter.writeOldCurrent(snapshot, expectedPost);
          postRevision = written.revision;
          await adapter.recoveryRepository.transition({ operationId, expectedPhase: "writeback_unknown", nextPhase: "writeback_applied", occurredAt: adapter.now(), oldCurrentPostRevision: postRevision, writebackVerificationResult: "exact-post" });
          phase = "writeback_applied";
        } else if (currentDigest === evidence.oldCurrentExpectedPostDigest) {
          postRevision = current.revision;
          await adapter.recoveryRepository.transition({ operationId, expectedPhase: phase, nextPhase: "writeback_applied", occurredAt: adapter.now(), oldCurrentPostRevision: postRevision, writebackVerificationResult: "exact-post" });
          phase = "writeback_applied";
        } else {
          await adapter.recoveryRepository.transition({ operationId, expectedPhase: phase, nextPhase: "blocked", occurredAt: adapter.now(), lastErrorCode: "FORMAL_SWITCH_RECOVERY_CURRENT_CONFLICT", lastDiagnosticSummary: "old current differs from pre and exact-post" });
          phase = "blocked";
        }
      }
      let verified = await adapter.recoveryRepository.postVerify(operationId);
      if (verified.status === "not_committed" && phase === "writeback_applied" && postRevision) {
        verified = await adapter.recoveryRepository.completeDatabase(operationId, postRevision, adapter.now());
      }
      if (verified.status !== "committed_exact") {
        const diagnostic = failure(adapter as FormalSwitchAdapter<FormalSwitchSnapshot, unknown, unknown>, operationId, adapter.codes.transaction, "database-transaction", verified.safeDiagnosticCode, { oldCurrentWritten: true }, phase);
        return adapter.recoveryRequired(diagnostic);
      }
      const latest = await adapter.recoveryRepository.get(operationId);
      if (latest?.phase === "db_commit_unknown") {
        await adapter.recoveryRepository.transition({ operationId, expectedPhase: "db_commit_unknown", nextPhase: "db_committed", occurredAt: adapter.now() });
      }
      let activated: { sessionKey: string };
      try {
        activated = await adapter.activateRecovered(evidence);
      } catch (error) {
        const persisted = await adapter.recoveryRepository.get(operationId);
        if (persisted?.phase === "db_committed") {
          await adapter.recoveryRepository.transition({ operationId, expectedPhase: "db_committed", nextPhase: "activation_pending", occurredAt: adapter.now(), lastErrorCode: adapter.codes.activation });
        }
        return adapter.recoveryRequired(failure(adapter as FormalSwitchAdapter<FormalSwitchSnapshot, unknown, unknown>, operationId, adapter.codes.activation, "session-activation", stableCause(error, "FORMAL_SWITCH_ACTIVATION_FAILED"), { oldCurrentWritten: true, databaseCommitted: true }, "activation_pending"));
      }
      const resolvedFrom = (await adapter.recoveryRepository.get(operationId))?.phase;
      await adapter.recoveryRepository.transition({ operationId, expectedPhase: resolvedFrom === "activation_pending" ? "activation_pending" : "db_committed", nextPhase: "resolved", occurredAt: adapter.now() });
      const recoveredSnapshot = { ownerType: evidence.ownerType, ownerId: evidence.ownerId, parentOwnerId: evidence.parentOwnerId, channel: "primary", currentFileRefId: evidence.oldCurrentFileRefId, defaultFileRefId: evidence.defaultFileRefId, targetFileRefId: evidence.targetFileRefId, currentFileName: evidence.oldCurrentFileName, defaultFileName: evidence.defaultFileName, targetFileName: evidence.targetFileName, targetLocationMode: "managed", currentRevision: evidence.oldCurrentPreRevision, targetRevision: evidence.targetRevision, currentRawText: "", targetRawText: "", replacements: [], diagnostics: [], bindingId: "" } as unknown as TSnapshot;
      adapter.publish(recoveredSnapshot, operationId);
      return adapter.success(recoveredSnapshot, operationId, activated.sessionKey);
    } finally {
      release();
    }
  }

  async function safeCancel<TSnapshot extends FormalSwitchSnapshot, TPreflight, TConfirm>(adapter: FormalSwitchAdapter<TSnapshot, TPreflight, TConfirm>, operationId: string): Promise<TConfirm> {
    const evidence = await adapter.recoveryRepository.get(operationId);
    if (!evidence || evidence.phase !== "prepared") {
      return adapter.error(failure(adapter as FormalSwitchAdapter<FormalSwitchSnapshot, unknown, unknown>, operationId, adapter.codes.recovery, "recovery-log", "FORMAL_SWITCH_SAFE_CANCEL_NOT_ALLOWED")) as TConfirm;
    }
    const current = await adapter.openRecoveryCurrent(evidence);
    if (current.dirty || current.revision !== evidence.oldCurrentPreRevision || hashText(current.rawText) !== evidence.oldCurrentPreDigest) {
      return adapter.error(failure(adapter as FormalSwitchAdapter<FormalSwitchSnapshot, unknown, unknown>, operationId, adapter.codes.recovery, "old-current-writeback", "FORMAL_SWITCH_SAFE_CANCEL_NOT_ALLOWED")) as TConfirm;
    }
    await adapter.recoveryRepository.safeCancel(operationId, current.revision, adapter.now());
    return adapter.canceled(operationId);
  }

  return Object.freeze({ preflight, confirm, continueRecovery, safeCancel });
}

export const formalSwitchEngine = createFormalSwitchEngine();
