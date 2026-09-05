import type { ManuscriptOutlineDescriptorLookupIdentity } from "./manuscriptOutlineParser";
import type {
  ManuscriptSegmentEditInputType,
  ManuscriptSegmentDraftSnapshot,
  ManuscriptSegmentEditLineageEvent,
  ManuscriptSegmentOrdinarySaveResult,
  ManuscriptSegmentProjectionSessionState,
  ManuscriptSegmentRegionDraft
} from "../types/manuscriptSegmentProjection";
import type { RawManuscriptGateway } from "../types/manuscriptOperation";
import type {
  SharedManuscriptSession,
  SharedManuscriptSessionHandle,
  SharedSessionRevalidation
} from "../types/sharedManuscriptSession";
import type { SharedManuscriptSessionRuntime } from "./sharedManuscriptSessionRuntime";
import {
  buildManuscriptSegmentProjection,
  createPhysicalRawBytesFromSnapshot
} from "./manuscriptSegmentProjectionService";
import { ordinarySavePresentation } from "./ordinaryOperationPresentation";
import { buildManuscriptSegmentDraftSnapshot } from "./manuscriptSegmentDraftSnapshot";

export const MANUSCRIPT_SEGMENT_FOUNDATION_ERROR_CODES = Object.freeze({
  sessionUnavailable: "MANUSCRIPT_SEGMENT_SESSION_UNAVAILABLE",
  sessionNotReady: "MANUSCRIPT_SEGMENT_SESSION_NOT_READY",
  sessionIdentityDrift: "MANUSCRIPT_SEGMENT_SESSION_IDENTITY_DRIFT",
  projectionFailClosed: "MANUSCRIPT_SEGMENT_PROJECTION_FAIL_CLOSED",
  projectionGenerationStale: "MANUSCRIPT_SEGMENT_PROJECTION_GENERATION_STALE",
  projectionSaveDisabled: "MANUSCRIPT_SEGMENT_PROJECTION_SAVE_DISABLED",
  runtimeDraftRejected: "MANUSCRIPT_SEGMENT_RUNTIME_DRAFT_REJECTED",
  saveFailed: "MANUSCRIPT_SEGMENT_SAVE_FAILED",
  readbackUnconfirmed: "MANUSCRIPT_SEGMENT_READBACK_UNCONFIRMED",
  draftSnapshotInvalid: "MANUSCRIPT_SEGMENT_DRAFT_SNAPSHOT_INVALID"
} as const);

const SESSION_RAW_DRAFT_TARGET_ID = "session-raw-draft";

interface RawDraftRecord {
  runtimeHandle: SharedManuscriptSessionHandle;
  descriptorLookupIdentity: ManuscriptOutlineDescriptorLookupIdentity;
  projection: ReturnType<typeof buildManuscriptSegmentProjection>;
  state: ManuscriptSegmentProjectionSessionState;
  editSequence: number;
  lineage: ManuscriptSegmentEditLineageEvent[];
  statusOverride?: ManuscriptSegmentProjectionSessionState["status"];
  saveDisabledOverride?: boolean;
  lastFailureCode?: string;
}

export interface ManuscriptSegmentSessionAdapterDependencies {
  readonly runtime: SharedManuscriptSessionRuntime;
  /** Kept as the injected canonical persistence authority; Runtime owns use. */
  readonly gateway: RawManuscriptGateway;
  readonly createOperationId?: () => string;
}

function defaultOperationId() {
  return globalThis.crypto?.randomUUID?.() ??
    `raw-editor-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isWellFormedUnicode(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function ordinaryResult(
  operationId: string,
  input: Partial<ManuscriptSegmentOrdinarySaveResult> &
    Pick<ManuscriptSegmentOrdinarySaveResult, "status">
): ManuscriptSegmentOrdinarySaveResult {
  return Object.freeze({
    operationId,
    gatewaySaveInvocationCount: 0,
    physicalReplaceCount: 0,
    preflightReadCount: 0,
    durableReadbackConfirmed: false,
    draftRetained: true,
    patchCount: 0,
    businessWriteCount: 0,
    bindingMutationCount: 0,
    formalSwitchInvocationCount: 0,
    ...input
  });
}

function rawDraft(
  session: SharedManuscriptSession,
  lineage: readonly ManuscriptSegmentEditLineageEvent[]
): ManuscriptSegmentRegionDraft {
  return Object.freeze({
    targetId: SESSION_RAW_DRAFT_TARGET_ID,
    targetKind: "UNMANAGED_RAW_SOURCE",
    segmentId: SESSION_RAW_DRAFT_TARGET_ID,
    baselineText: session.baseline?.rawText ?? "",
    currentText: session.draftRawText,
    dirty: session.dirty,
    lineage: Object.freeze([...lineage]),
    effectivePatches: Object.freeze([])
  });
}

export function createManuscriptSegmentSessionAdapter(
  dependencies: ManuscriptSegmentSessionAdapterDependencies
) {
  const createOperationId = dependencies.createOperationId ?? defaultOperationId;
  const records = new Map<SharedManuscriptSessionHandle, RawDraftRecord>();
  let projectionGeneration = 0;

  function sessionFor(handle: SharedManuscriptSessionHandle) {
    const session = dependencies.runtime.getSession(handle);
    return session?.baseline ? session : undefined;
  }

  function createState(
    record: Omit<RawDraftRecord, "state">,
    session: SharedManuscriptSession
  ): ManuscriptSegmentProjectionSessionState {
    const projectionUnavailable =
      record.projection.classification === "NON_PROJECTABLE_FAIL_CLOSED";
    const saveDisabled = record.saveDisabledOverride ?? (
      projectionUnavailable ||
      session.accessMode === "read-only" ||
      session.stale ||
      session.recoveryRequired
    );
    const status = record.statusOverride ?? (
      projectionUnavailable
        ? "FAIL_CLOSED"
        : session.dirty
          ? "DIRTY"
          : "ACTIVE"
    );
    return Object.freeze({
      runtimeHandle: record.runtimeHandle,
      sessionKey: session.sessionKey,
      sessionGeneration: session.sessionGeneration,
      projectionGeneration: record.projection.baselineIdentity.projectionGeneration,
      descriptorLookupIdentity: Object.freeze({ ...record.descriptorLookupIdentity }),
      projection: record.projection,
      status,
      regionDrafts: projectionUnavailable
        ? Object.freeze([])
        : Object.freeze([rawDraft(session, record.lineage)]),
      normalizedEffectivePatches: Object.freeze([]),
      dirty: session.dirty,
      saveDisabled,
      lastFailureCode: record.lastFailureCode
    });
  }

  function refreshState(record: RawDraftRecord) {
    const session = sessionFor(record.state.runtimeHandle);
    if (!session) return record.state;
    record.state = createState(record, session);
    return record.state;
  }

  function buildRecord(
    handle: SharedManuscriptSessionHandle,
    descriptorLookupIdentity: ManuscriptOutlineDescriptorLookupIdentity
  ) {
    const session = sessionFor(handle);
    if (!session) throw new Error(MANUSCRIPT_SEGMENT_FOUNDATION_ERROR_CODES.sessionNotReady);
    projectionGeneration += 1;
    const fileRefId = session.file.kind === "durable"
      ? session.file.fileRefId
      : session.logicalIdentity.fileRefId;
    const projection = buildManuscriptSegmentProjection({
      rawBytes: createPhysicalRawBytesFromSnapshot(session.baseline!),
      ownerType: session.owner.ownerType,
      ownerId: session.owner.ownerId,
      channel: session.owner.channel,
      fileRefId,
      sessionKey: session.sessionKey,
      sessionGeneration: session.sessionGeneration,
      projectionGeneration,
      baseline: session.baseline!,
      descriptorLookupIdentity
    });
    const draftRecord: Omit<RawDraftRecord, "state"> = {
      runtimeHandle: handle,
      descriptorLookupIdentity: Object.freeze({ ...descriptorLookupIdentity }),
      projection,
      editSequence: 0,
      lineage: []
    };
    const record: RawDraftRecord = {
      ...draftRecord,
      state: createState(draftRecord, session)
    };
    records.set(handle, record);
    return record;
  }

  function verifyRuntimeIdentity(record: RawDraftRecord) {
    const session = sessionFor(record.state.runtimeHandle);
    if (!session) return MANUSCRIPT_SEGMENT_FOUNDATION_ERROR_CODES.sessionUnavailable;
    const identity = record.projection.baselineIdentity;
    if (
      session.sessionKey !== identity.sessionKey ||
      session.sessionGeneration !== identity.sessionGeneration ||
      session.logicalIdentity.fileRefId !== identity.fileRefId
    ) return MANUSCRIPT_SEGMENT_FOUNDATION_ERROR_CODES.sessionIdentityDrift;
    return null;
  }

  function mark(record: RawDraftRecord, input: Readonly<{
    status: ManuscriptSegmentProjectionSessionState["status"];
    saveDisabled: boolean;
    failureCode?: string;
  }>) {
    record.statusOverride = input.status;
    record.saveDisabledOverride = input.saveDisabled;
    record.lastFailureCode = input.failureCode;
    return refreshState(record);
  }

  function attach(
    handle: SharedManuscriptSessionHandle,
    descriptorLookupIdentity: ManuscriptOutlineDescriptorLookupIdentity
  ) {
    return buildRecord(handle, descriptorLookupIdentity).state;
  }

  function applyNextText(input: Readonly<{
    runtimeHandle: SharedManuscriptSessionHandle;
    expectedProjectionGeneration: number;
    targetId: string;
    nextText: string;
    inputType: ManuscriptSegmentEditInputType;
    compositionActive?: boolean;
  }>) {
    const record = records.get(input.runtimeHandle);
    if (!record || record.state.saveDisabled) {
      return Object.freeze({ accepted: false as const, reason: "RAW_DRAFT_NOT_WRITABLE" });
    }
    if (
      input.expectedProjectionGeneration !== record.state.projectionGeneration ||
      input.targetId !== SESSION_RAW_DRAFT_TARGET_ID
    ) {
      return Object.freeze({ accepted: false as const, reason: "STALE_PROJECTION_GENERATION" });
    }
    if (input.compositionActive || !isWellFormedUnicode(input.nextText)) {
      return Object.freeze({ accepted: false as const, reason: "RAW_DRAFT_TEXT_INVALID" });
    }
    const drift = verifyRuntimeIdentity(record);
    if (drift) {
      mark(record, { status: "STALE_DRAFT", saveDisabled: true, failureCode: drift });
      return Object.freeze({ accepted: false as const, reason: drift });
    }
    const before = dependencies.runtime.getSession(input.runtimeHandle);
    if (!before) {
      return Object.freeze({ accepted: false as const, reason: "RAW_DRAFT_SESSION_MISSING" });
    }
    const updated = dependencies.runtime.updateDraft(input.runtimeHandle, input.nextText);
    if (!updated || updated.sessionGeneration !== record.state.sessionGeneration) {
      return Object.freeze({ accepted: false as const, reason: "RAW_DRAFT_UPDATE_REJECTED" });
    }
    if (before.draftRawText !== input.nextText) {
      record.editSequence += 1;
      record.lineage.push(Object.freeze({
        eventId: `raw-draft-edit:${record.editSequence}`,
        operationOrder: record.editSequence,
        targetId: SESSION_RAW_DRAFT_TARGET_ID,
        inputType: input.inputType,
        draftLocalRangeBefore: Object.freeze({
          startUtf16: 0,
          endUtf16: before.draftRawText.length
        }),
        replacementText: input.nextText,
        resultingDraftUtf16Length: input.nextText.length
      }));
    }
    record.statusOverride = undefined;
    record.saveDisabledOverride = undefined;
    record.lastFailureCode = undefined;
    return Object.freeze({
      accepted: true as const,
      draft: rawDraft(updated, record.lineage),
      dirty: updated.dirty,
      projectionState: refreshState(record)
    });
  }

  async function buildDraftSnapshot(input: Readonly<{
    runtimeHandle: SharedManuscriptSessionHandle;
    expectedProjectionGeneration: number;
  }>): Promise<ManuscriptSegmentDraftSnapshot> {
    const record = records.get(input.runtimeHandle);
    if (!record || input.expectedProjectionGeneration !== record.state.projectionGeneration) {
      throw new Error(MANUSCRIPT_SEGMENT_FOUNDATION_ERROR_CODES.projectionGenerationStale);
    }
    const drift = verifyRuntimeIdentity(record);
    if (drift) {
      mark(record, { status: "STALE_DRAFT", saveDisabled: true, failureCode: drift });
      throw new Error(drift);
    }
    const session = dependencies.runtime.getSession(input.runtimeHandle);
    if (!session) throw new Error(MANUSCRIPT_SEGMENT_FOUNDATION_ERROR_CODES.sessionUnavailable);
    return buildManuscriptSegmentDraftSnapshot({
      state: refreshState(record),
      session
    });
  }

  async function save(input: Readonly<{
    runtimeHandle: SharedManuscriptSessionHandle;
    expectedProjectionGeneration: number;
    revalidate?: (
      target: Parameters<NonNullable<Parameters<SharedManuscriptSessionRuntime["save"]>[1]>>[0]
    ) => Promise<SharedSessionRevalidation>;
  }>): Promise<ManuscriptSegmentOrdinarySaveResult> {
    const operationId = createOperationId();
    const record = records.get(input.runtimeHandle);
    if (!record || record.projection.classification !== "PROJECTABLE") {
      return ordinaryResult(operationId, {
        status: "FAILURE_EXPECTED",
        error: {
          code: MANUSCRIPT_SEGMENT_FOUNDATION_ERROR_CODES.projectionFailClosed,
          retryable: false,
          recoveryRequired: false,
          writeApplied: false
        }
      });
    }
    if (input.expectedProjectionGeneration !== record.state.projectionGeneration) {
      return ordinaryResult(operationId, {
        status: "STALE_DRAFT",
        projectionState: record.state,
        error: {
          code: MANUSCRIPT_SEGMENT_FOUNDATION_ERROR_CODES.projectionGenerationStale,
          retryable: false,
          recoveryRequired: false,
          writeApplied: false
        }
      });
    }
    if (record.state.saveDisabled) {
      return ordinaryResult(operationId, {
        status: "FAILURE_EXPECTED",
        projectionState: record.state,
        error: {
          code: MANUSCRIPT_SEGMENT_FOUNDATION_ERROR_CODES.projectionSaveDisabled,
          retryable: false,
          recoveryRequired: false,
          writeApplied: false
        }
      });
    }
    const drift = verifyRuntimeIdentity(record);
    if (drift) {
      const state = mark(record, {
        status: "STALE_DRAFT",
        saveDisabled: true,
        failureCode: drift
      });
      return ordinaryResult(operationId, {
        status: "STALE_DRAFT",
        projectionState: state,
        error: { code: drift, retryable: false, recoveryRequired: false, writeApplied: false }
      });
    }
    const before = dependencies.runtime.getSession(input.runtimeHandle);
    if (!before) {
      return ordinaryResult(operationId, {
        status: "STALE_DRAFT",
        error: {
          code: MANUSCRIPT_SEGMENT_FOUNDATION_ERROR_CODES.sessionUnavailable,
          retryable: false,
          recoveryRequired: false,
          writeApplied: false
        }
      });
    }
    const patchCount = before.dirty ? 1 : 0;
    const saved = await dependencies.runtime.save(
      input.runtimeHandle,
      input.revalidate
    );
    if (saved.status === "success" || saved.status === "no-op") {
      const next = buildRecord(input.runtimeHandle, record.descriptorLookupIdentity);
      return ordinaryResult(operationId, {
        status: saved.status === "success" ? "SUCCESS_CHANGED" : "SUCCESS_NO_OP",
        gatewaySaveInvocationCount: 1,
        physicalReplaceCount: saved.status === "success" ? 1 : 0,
        durableReadbackConfirmed: true,
        draftRetained: false,
        patchCount,
        projectionState: next.state
      });
    }
    const savedCode = String(
      saved.error?.code ?? MANUSCRIPT_SEGMENT_FOUNDATION_ERROR_CODES.saveFailed
    );
    const readbackUnconfirmed = saved.status === "write-applied-readback-failed" ||
      saved.error?.writeApplied === true ||
      saved.error?.writeApplied === "unknown";
    const runtimeStale = saved.status === "conflict" ||
      saved.status === "stale" ||
      savedCode === "MANUSCRIPT_CURRENT_CHANGED" ||
      savedCode === "MANUSCRIPT_TARGET_CHANGED" ||
      savedCode === "MANUSCRIPT_STALE_SESSION_HANDLE" ||
      savedCode === "MANUSCRIPT_SESSION_IDENTITY_MISMATCH";
    const gatewayNotInvoked = savedCode === "MANUSCRIPT_CURRENT_CHANGED" ||
      savedCode === "MANUSCRIPT_TARGET_CHANGED" ||
      savedCode === "MANUSCRIPT_SESSION_READ_ONLY" ||
      savedCode === "MANUSCRIPT_EXTERNAL_WRITE_CONFIRMATION_REQUIRED" ||
      savedCode === "MANUSCRIPT_OPERATION_IN_PROGRESS" ||
      savedCode === "MANUSCRIPT_STALE_SESSION_HANDLE" ||
      savedCode === "MANUSCRIPT_SESSION_NOT_FOUND" ||
      (
        savedCode === "MANUSCRIPT_ADMISSION_PROOF_STALE" &&
        saved.error?.writeApplied === false
      );
    const nextState = mark(record, {
      status: readbackUnconfirmed
        ? "SAVE_COMMITTED_READBACK_UNCONFIRMED"
        : runtimeStale
          ? "STALE_DRAFT"
          : "DIRTY",
      saveDisabled: readbackUnconfirmed || runtimeStale,
      failureCode: savedCode
    });
    return ordinaryResult(operationId, {
      status: readbackUnconfirmed
        ? "SAVE_COMMITTED_READBACK_UNCONFIRMED"
        : runtimeStale
          ? "STALE_DRAFT"
          : "FAILURE_EXPECTED",
      gatewaySaveInvocationCount: gatewayNotInvoked ? 0 : 1,
      physicalReplaceCount: readbackUnconfirmed ? "UNKNOWN" : 0,
      patchCount,
      projectionState: nextState,
      error: {
        code: savedCode,
        retryable: saved.error?.retryable ?? false,
        recoveryRequired: saved.error?.recoveryRequired ?? readbackUnconfirmed,
        writeApplied: saved.error?.writeApplied ?? (readbackUnconfirmed ? "unknown" : false)
      }
    });
  }

  async function reload(input: Readonly<{
    runtimeHandle: SharedManuscriptSessionHandle;
    decision?: "discard" | "cancel";
    revalidate?: (
      target: Parameters<NonNullable<Parameters<SharedManuscriptSessionRuntime["reload"]>[2]>>[0]
    ) => Promise<SharedSessionRevalidation>;
  }>) {
    const record = records.get(input.runtimeHandle);
    const state = record ? refreshState(record) : undefined;
    if (state?.dirty && !input.decision) {
      return Object.freeze({ status: "warning" as const, projectionState: state });
    }
    if (input.decision === "cancel") {
      return Object.freeze({ status: "canceled" as const, projectionState: state });
    }
    const reloaded = await dependencies.runtime.reload(
      input.runtimeHandle,
      state?.dirty ? "discard" : input.decision,
      input.revalidate
    );
    if (reloaded.status !== "success" || !record) return reloaded;
    return Object.freeze({
      ...reloaded,
      projectionState: buildRecord(
        input.runtimeHandle,
        record.descriptorLookupIdentity
      ).state
    });
  }

  async function discard(runtimeHandle: SharedManuscriptSessionHandle) {
    const record = records.get(runtimeHandle);
    const discarded = await dependencies.runtime.discard(runtimeHandle);
    if (discarded.status !== "success" || !record) return discarded;
    return Object.freeze({
      ...discarded,
      projectionState: buildRecord(
        runtimeHandle,
        record.descriptorLookupIdentity
      ).state
    });
  }

  async function close(input: Readonly<{
    runtimeHandle: SharedManuscriptSessionHandle;
    decision?: "save" | "discard" | "cancel";
    expectedProjectionGeneration?: number;
  }>) {
    const record = records.get(input.runtimeHandle);
    const state = record ? refreshState(record) : undefined;
    if (state?.dirty && !input.decision) {
      return Object.freeze({ status: "warning" as const, projectionState: state });
    }
    if (input.decision === "cancel") {
      return Object.freeze({ status: "canceled" as const, projectionState: state });
    }
    if (state?.dirty && input.decision === "save") {
      const saved = await save({
        runtimeHandle: input.runtimeHandle,
        expectedProjectionGeneration:
          input.expectedProjectionGeneration ?? state.projectionGeneration
      });
      if (saved.status !== "SUCCESS_CHANGED" && saved.status !== "SUCCESS_NO_OP") {
        return Object.freeze({ status: "save-not-complete" as const, saveResult: saved });
      }
    }
    if (state?.dirty && input.decision === "discard") {
      const discarded = await dependencies.runtime.discard(input.runtimeHandle);
      if (discarded.status !== "success") return discarded;
    }
    const closed = await dependencies.runtime.close(input.runtimeHandle);
    if (closed.status === "success") records.delete(input.runtimeHandle);
    return closed;
  }

  return Object.freeze({
    attach,
    applyNextText,
    buildDraftSnapshot,
    save,
    reload,
    discard,
    close,
    read(runtimeHandle: SharedManuscriptSessionHandle) {
      const record = records.get(runtimeHandle);
      return record ? refreshState(record) : undefined;
    },
    detach(runtimeHandle: SharedManuscriptSessionHandle) {
      return records.delete(runtimeHandle);
    },
    presentSaveResult(
      result: ManuscriptSegmentOrdinarySaveResult,
      ownerContext: { ownerType: string; channel: string; ownerLabel?: string }
    ) {
      const canonical = result.status === "SUCCESS_CHANGED"
        ? { status: "success", operationId: result.operationId }
        : result.status === "SUCCESS_NO_OP"
          ? { status: "no-op", operationId: result.operationId }
          : {
              status: result.status === "STALE_DRAFT" ? "stale" : "error",
              operationId: result.operationId,
              error: result.error
            };
      return ordinarySavePresentation(canonical, ownerContext);
    }
  });
}

export type ManuscriptSegmentSessionAdapter = ReturnType<
  typeof createManuscriptSegmentSessionAdapter
>;
