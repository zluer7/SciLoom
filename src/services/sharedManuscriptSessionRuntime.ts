import {
  MANUSCRIPT_OPERATION_ERROR_CODES,
  type DurableFileIdentity,
  type FileIdentity,
  type ManuscriptOperationError,
  type ManuscriptOperationResult,
  type OwnerIdentity,
  type RawManuscriptGateway,
  type RawManuscriptSnapshot
} from "../types/manuscriptOperation";
import type {
  SharedCloseDecision,
  SharedConsumerReleaseOutcome,
  SharedLogicalSessionIdentity,
  SharedManuscriptSession,
  SharedManuscriptSessionHandle,
  SharedManuscriptSessionKey,
  SharedOperationToken,
  SharedSaveAsCandidateCloseResult,
  SharedSaveAsCandidateRuntimeBinding,
  SharedSaveAsTargetActivationInput,
  SharedSessionHandleResult,
  SharedSessionOpenInput,
  SharedSessionRevalidation,
  SharedTargetSnapshot,
  SharedWritableAdmissionGrant,
  SharedWritableAdmissionPort,
  SharedWritableTargetRequest
} from "../types/sharedManuscriptSession";
import {
  createManuscriptIdentityResolver,
  ManuscriptIdentityError,
  type ManuscriptIdentityResolver
} from "./manuscriptIdentityResolver";

export const SHARED_SESSION_ERROR_CODES = {
  staleHandle: "MANUSCRIPT_STALE_SESSION_HANDLE",
  admissionConflict: "MANUSCRIPT_ADMISSION_CONFLICT",
  admissionProofStale: "MANUSCRIPT_ADMISSION_PROOF_STALE",
  targetChanged: "MANUSCRIPT_TARGET_CHANGED",
  currentChanged: "MANUSCRIPT_CURRENT_CHANGED",
  readOnly: "MANUSCRIPT_SESSION_READ_ONLY",
  dirtyDecisionRequired: "MANUSCRIPT_DIRTY_DECISION_REQUIRED",
  discardFailed: "MANUSCRIPT_DISCARD_FAILED",
  closeCanceled: "MANUSCRIPT_CLOSE_CANCELED",
  externalWriteConfirmationRequired:
    "MANUSCRIPT_EXTERNAL_WRITE_CONFIRMATION_REQUIRED",
  invariantFailed: "MANUSCRIPT_SESSION_INVARIANT_FAILED"
} as const;

interface InternalSession {
  state: SharedManuscriptSession;
  admission?: SharedWritableAdmissionGrant;
  handles: Set<SharedManuscriptSessionHandle>;
  consumerHandles: Map<string, SharedManuscriptSessionHandle>;
}

interface HandleRecord {
  sessionKey: SharedManuscriptSessionKey;
  sessionGeneration: number;
  consumerId?: string;
  receiptId?: string;
}

export interface SharedManuscriptSessionRuntimeDependencies {
  gateway: RawManuscriptGateway;
  admission: SharedWritableAdmissionPort;
  identityResolver?: ManuscriptIdentityResolver;
  now?: () => string;
  createId?: () => string;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function defaultNow() {
  return new Date().toISOString();
}

function defaultId() {
  return globalThis.crypto?.randomUUID?.() ??
    `shared-session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function hash(value: string) {
  const bytes = new TextEncoder().encode(value);
  let state = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    state ^= BigInt(byte);
    state = BigInt.asUintN(64, state * 0x100000001b3n);
  }
  return state.toString(16).padStart(16, "0");
}

function error(
  code: ManuscriptOperationError["code"] | string,
  options: Partial<ManuscriptOperationError> = {}
): ManuscriptOperationError {
  return {
    code: code as ManuscriptOperationError["code"],
    category: options.category ?? "session",
    retryable: options.retryable ?? false,
    writeApplied: options.writeApplied ?? false,
    recoveryRequired: options.recoveryRequired ?? false,
    causeCode: options.causeCode
  };
}

function result(
  operation: ManuscriptOperationResult<never>["operation"],
  status: ManuscriptOperationResult<never>["status"],
  operationId: string,
  data: undefined,
  operationError?: ManuscriptOperationError
): ManuscriptOperationResult<never>;
function result<T>(
  operation: ManuscriptOperationResult<T>["operation"],
  status: ManuscriptOperationResult<T>["status"],
  operationId: string,
  data: T,
  operationError?: ManuscriptOperationError
): ManuscriptOperationResult<T>;
function result<T>(
  operation: ManuscriptOperationResult<T>["operation"],
  status: ManuscriptOperationResult<T>["status"],
  operationId: string,
  data: T | undefined,
  operationError?: ManuscriptOperationError
): ManuscriptOperationResult<T> {
  return { operation, status, operationId, data, error: operationError };
}

function durableTargetRequest(file: DurableFileIdentity): SharedWritableTargetRequest {
  return {
    fileRefId: file.fileRefId,
    filePath: file.absolutePath,
    expectedPathIdentity: file.pathIdentity,
    expectedFileName: file.fileName,
    locationMode: file.locationMode,
    configuredRoot: file.configuredRoot
  };
}

function sameOwner(left: OwnerIdentity, right: OwnerIdentity) {
  return left.ownerType === right.ownerType &&
    left.ownerId === right.ownerId &&
    left.channel === right.channel;
}

export function createSharedLogicalSessionIdentity(
  owner: OwnerIdentity,
  file: DurableFileIdentity,
  windowRole: "current" | "independent"
): SharedLogicalSessionIdentity {
  return Object.freeze({
    ownerType: owner.ownerType,
    ownerId: owner.ownerId,
    channel: owner.channel,
    windowRole,
    fileRefId: file.fileRefId
  });
}

export function createSharedLogicalSessionKey(
  identity: SharedLogicalSessionIdentity
): SharedManuscriptSessionKey {
  return [
    "shared-manuscript-session-v1",
    encodeURIComponent(identity.ownerType),
    encodeURIComponent(identity.ownerId),
    encodeURIComponent(identity.channel),
    encodeURIComponent(identity.windowRole),
    encodeURIComponent(identity.fileRefId)
  ].join(":");
}

function publicState(session: InternalSession) {
  return clone({
    ...session.state,
    consumerCount: session.handles.size
  });
}

export function createSharedManuscriptSessionRuntime(
  dependencies: SharedManuscriptSessionRuntimeDependencies
) {
  const identityResolver = dependencies.identityResolver ??
    createManuscriptIdentityResolver();
  const now = dependencies.now ?? defaultNow;
  const createId = dependencies.createId ?? defaultId;
  const sessions = new Map<SharedManuscriptSessionKey, InternalSession>();
  const handles = new Map<SharedManuscriptSessionHandle, HandleRecord>();
  const candidateBindings =
    new Map<string, SharedSaveAsCandidateRuntimeBinding>();
  const resolvedCandidateReceipts = new Set<string>();
  let generationCounter = 0;

  function resolveHandle(handle: SharedManuscriptSessionHandle) {
    const record = handles.get(handle);
    const session = record ? sessions.get(record.sessionKey) : undefined;
    if (
      !record ||
      !session ||
      record.sessionGeneration !== session.state.sessionGeneration ||
      !session.handles.has(handle)
    ) {
      return undefined;
    }
    return session;
  }

  function createHandle(
    session: InternalSession,
    consumerId?: string,
    receiptId?: string
  ) {
    if (consumerId) {
      const existing = session.consumerHandles.get(consumerId);
      if (existing && resolveHandle(existing)) return existing;
    }
    const handle = `manuscript-session-handle:${createId()}`;
    session.handles.add(handle);
    if (consumerId) session.consumerHandles.set(consumerId, handle);
    handles.set(handle, {
      sessionKey: session.state.sessionKey,
      sessionGeneration: session.state.sessionGeneration,
      consumerId,
      receiptId
    });
    return handle;
  }

  function bindSaveAsCandidate(
    input: SharedSaveAsTargetActivationInput,
    owner: OwnerIdentity,
    file: DurableFileIdentity,
    handle: SharedManuscriptSessionHandle,
    sessionGeneration: number
  ) {
    const proposed: SharedSaveAsCandidateRuntimeBinding = {
      receiptId: input.receiptId,
      operationId: input.operationId,
      processGeneration: input.processGeneration,
      owner: clone(owner),
      candidateFileRefId: file.fileRefId,
      runtimeHandle: handle,
      runtimeConsumerId: input.consumerId,
      runtimeGeneration: sessionGeneration
    };
    const existing = candidateBindings.get(input.receiptId);
    if (existing) {
      const alreadyBound =
        existing.operationId === proposed.operationId &&
        existing.processGeneration === proposed.processGeneration &&
        existing.runtimeHandle === proposed.runtimeHandle &&
        existing.runtimeConsumerId === proposed.runtimeConsumerId &&
        existing.runtimeGeneration === proposed.runtimeGeneration &&
        existing.candidateFileRefId === proposed.candidateFileRefId &&
        sameOwner(existing.owner, proposed.owner);
      if (alreadyBound) return true;
      const expected = input.expectedCandidateBinding;
      if (
        !expected ||
        existing.receiptId !== expected.receiptId ||
        existing.operationId !== expected.operationId ||
        existing.processGeneration !== expected.processGeneration ||
        existing.runtimeHandle !== expected.runtimeHandle ||
        existing.runtimeConsumerId !== expected.runtimeConsumerId ||
        existing.runtimeGeneration !== expected.runtimeGeneration ||
        existing.candidateFileRefId !== expected.candidateFileRefId ||
        !sameOwner(existing.owner, expected.owner)
      ) {
        return false;
      }
      candidateBindings.set(input.receiptId, proposed);
      return true;
    }
    if (
      resolvedCandidateReceipts.has(input.receiptId) &&
      !input.expectedCandidateBinding
    ) {
      return false;
    }
    resolvedCandidateReceipts.delete(input.receiptId);
    candidateBindings.set(input.receiptId, proposed);
    return true;
  }

  function beginOperation(
    session: InternalSession,
    kind: SharedOperationToken["kind"]
  ) {
    if (session.state.activeOperation) return undefined;
    session.state.operationGeneration += 1;
    session.state.requestGeneration = session.state.operationGeneration;
    const token: SharedOperationToken = {
      sessionKey: session.state.sessionKey,
      sessionGeneration: session.state.sessionGeneration,
      operationGeneration: session.state.operationGeneration,
      operationToken: createId(),
      kind,
      draftVersion: session.state.draftVersion,
      savedRaw: session.state.draftRawText,
      expectedPhysicalRevision: session.state.baseline?.revision
    };
    session.state.activeOperation = token;
    session.state.updatedAt = now();
    if (kind === "load" || kind === "reload" || kind === "discard") {
      session.state.loadStatus = "loading";
    } else if (kind === "save") {
      session.state.saveStatus = "saving";
    } else {
      session.state.closing = true;
    }
    return clone(token);
  }

  function tokenCurrent(session: InternalSession, token: SharedOperationToken) {
    return session.state.sessionGeneration === token.sessionGeneration &&
      session.state.activeOperation?.operationToken === token.operationToken;
  }

  function clearOperation(session: InternalSession) {
    session.state.activeOperation = undefined;
    session.state.closing = false;
    session.state.updatedAt = now();
  }

  async function transitionToReadOnly(
    session: InternalSession,
    causeCode?: string
  ) {
    const admission = session.admission;
    session.admission = undefined;
    if (admission) {
      for (let reference = 0; reference < session.handles.size; reference += 1) {
        const released = await dependencies.admission.release(admission.proof);
        if (released.finalRelease) break;
      }
    }
    session.state.accessMode = "read-only";
    session.state.targetSnapshot.readOnly = true;
    session.state.stale = true;
    session.state.externalChangeObserved = true;
    session.state.error = error(SHARED_SESSION_ERROR_CODES.readOnly, {
      causeCode
    });
    session.state.updatedAt = now();
    return publicState(session);
  }

  function hydrate(
    session: InternalSession,
    token: SharedOperationToken,
    snapshot: RawManuscriptSnapshot,
    preserveNewerDraft: boolean
  ) {
    if (!tokenCurrent(session, token)) return false;
    session.state.baseline = clone(snapshot);
    session.state.targetSnapshot.physicalRevision = snapshot.revision;
    session.state.openedRawText = snapshot.rawText;
    session.state.openedRevision = snapshot.revision;
    session.state.currentRevision = snapshot.revision;
    session.state.encoding = snapshot.encoding;
    session.state.newline = snapshot.newline;
    session.state.dominantNewline = snapshot.dominantNewline;
    if (!preserveNewerDraft || session.state.draftVersion === token.draftVersion) {
      session.state.draftRawText = snapshot.rawText;
      session.state.draftVersion += 1;
    }
    session.state.dirty =
      session.state.draftRawText !== snapshot.rawText;
    session.state.loadStatus = "ready";
    session.state.saveStatus = "idle";
    session.state.error = undefined;
    session.state.recoveryRequired = false;
    session.state.recovery = undefined;
    session.state.externalChangeObserved = false;
    clearOperation(session);
    return true;
  }

  function fail(
    session: InternalSession,
    token: SharedOperationToken,
    operationError: ManuscriptOperationError,
    status: ManuscriptOperationResult["status"]
  ) {
    if (!tokenCurrent(session, token)) return false;
    session.state.error = clone(operationError);
    session.state.recoveryRequired = operationError.recoveryRequired;
    session.state.recovery = operationError.recoveryRequired
      ? {
          required: true,
          writeApplied: operationError.writeApplied,
          causeCode: operationError.causeCode
        }
      : undefined;
    if (token.kind === "save") {
      session.state.saveStatus = status === "conflict"
        ? "conflict"
        : operationError.recoveryRequired
          ? "recovery-required"
          : "error";
    } else {
      session.state.loadStatus = "error";
    }
    clearOperation(session);
    return true;
  }

  async function open(
    input: SharedSessionOpenInput
  ): Promise<ManuscriptOperationResult<SharedSessionHandleResult>> {
    const operationId = createId();
    let owner: OwnerIdentity;
    let file: FileIdentity;
    try {
      owner = identityResolver.resolveOwner(input.owner);
      file = identityResolver.assertFile(input.target.file);
    } catch (cause) {
      return result(
        "open",
        "error",
        operationId,
        undefined,
        error(
          cause instanceof ManuscriptIdentityError
            ? cause.code
            : MANUSCRIPT_OPERATION_ERROR_CODES.invalidFileIdentity,
          { category: "identity" }
        )
      );
    }
    if (
      input.accessMode === "writable" &&
      (input.target.readOnly || file.kind !== "durable")
    ) {
      return result(
        "open",
        "error",
        operationId,
        undefined,
        error(SHARED_SESSION_ERROR_CODES.readOnly)
      );
    }
    const logicalIdentity = file.kind === "durable"
      ? createSharedLogicalSessionIdentity(owner, file, input.windowRole)
      : {
          ownerType: owner.ownerType,
          ownerId: owner.ownerId,
          channel: owner.channel,
          windowRole: input.windowRole,
          fileRefId: `ephemeral:${file.identityToken}`
        };
    const sessionKey = createSharedLogicalSessionKey(logicalIdentity);
    const existing = sessions.get(sessionKey);
    if (existing) {
      if (
        existing.state.accessMode === "writable" &&
        input.accessMode === "read-only" &&
        input.target.readOnly
      ) {
        try {
          await transitionToReadOnly(existing);
          existing.state.targetSnapshot = clone({ ...input.target, file });
        } catch (cause) {
          return result(
            "open",
            "error",
            operationId,
            undefined,
            error(SHARED_SESSION_ERROR_CODES.admissionProofStale, {
              causeCode: String(cause)
            })
          );
        }
      }
      if (
        !sameOwner(existing.state.owner, owner) ||
        existing.state.file.kind !== file.kind ||
        existing.state.file.pathIdentity !== file.pathIdentity ||
        existing.state.accessMode !== input.accessMode ||
        existing.state.targetSnapshot.readOnly !== input.target.readOnly ||
        (
          input.windowRole === "current" &&
          (
            existing.state.targetSnapshot.expectedCurrentFileRefId !==
              input.target.expectedCurrentFileRefId ||
            existing.state.targetSnapshot.bindingRevision !==
              input.target.bindingRevision
          )
        )
      ) {
        return result(
          "open",
          "conflict",
          operationId,
          undefined,
          error(MANUSCRIPT_OPERATION_ERROR_CODES.sessionIdentityMismatch)
        );
      }
      if (input.consumerId) {
        const existingHandle = existing.consumerHandles.get(input.consumerId);
        if (existingHandle && resolveHandle(existingHandle)) {
          return result("open", "success", operationId, {
            handle: existingHandle,
            session: publicState(existing)
          });
        }
      }
      if (existing.admission) {
        try {
          existing.admission = await dependencies.admission.retain(
            existing.admission.proof
          );
        } catch (cause) {
          return result(
            "open",
            "conflict",
            operationId,
            undefined,
            error(SHARED_SESSION_ERROR_CODES.admissionConflict, {
              causeCode: String(cause)
            })
          );
        }
      }
      const handle = createHandle(existing, input.consumerId);
      return result("open", "success", operationId, {
        handle,
        session: publicState(existing)
      });
    }

    let admission: SharedWritableAdmissionGrant | undefined;
    if (input.accessMode === "writable" && file.kind === "durable") {
      try {
        admission = await dependencies.admission.acquire({
          requestId: createId(),
          logicalSessionKey: sessionKey,
          target: durableTargetRequest(file)
        });
      } catch (cause) {
        return result(
          "open",
          "conflict",
          operationId,
          undefined,
          error(SHARED_SESSION_ERROR_CODES.admissionConflict, {
            retryable: true,
            causeCode: String(cause)
          })
        );
      }
    }

    generationCounter += 1;
    const timestamp = now();
    const internal: InternalSession = {
      admission,
      handles: new Set(),
      consumerHandles: new Map(),
      state: {
        key: sessionKey,
        sessionKey,
        logicalIdentity,
        owner: clone(owner),
        windowRole: input.windowRole,
        file: clone(file),
        targetSnapshot: clone({ ...input.target, file }),
        accessMode: input.accessMode,
        draftRawText: "",
        sessionGeneration: generationCounter,
        operationGeneration: 0,
        requestGeneration: 0,
        draftVersion: 0,
        dirty: false,
        loadStatus: "idle",
        saveStatus: "idle",
        stale: false,
        externalChangeObserved: false,
        closing: false,
        recoveryRequired: false,
        consumerCount: 0,
        createdAt: timestamp,
        updatedAt: timestamp
      }
    };
    sessions.set(sessionKey, internal);
    const handle = createHandle(internal, input.consumerId);
    const token = beginOperation(internal, "load")!;
    const gatewayResult = await dependencies.gateway.read({ file });
    if (!tokenCurrent(internal, token)) {
      return result(
        "open",
        "stale",
        operationId,
        undefined,
        error(SHARED_SESSION_ERROR_CODES.staleHandle)
      );
    }
    if (gatewayResult.status !== "success" || !gatewayResult.data) {
      handles.delete(handle);
      sessions.delete(sessionKey);
      if (admission) {
        try {
          await dependencies.admission.release(admission.proof);
        } catch {
          // The caller-bound Rust authority will reconcile on window detach.
        }
      }
      return result(
        "open",
        gatewayResult.status,
        operationId,
        undefined,
        gatewayResult.error ??
          error(MANUSCRIPT_OPERATION_ERROR_CODES.fileUnreadable)
      );
    }
    hydrate(internal, token, gatewayResult.data, false);
    return result("open", "success", operationId, {
      handle,
      session: publicState(internal)
    });
  }

  async function activateSaveAsTarget(
    input: SharedSaveAsTargetActivationInput
  ): Promise<ManuscriptOperationResult<SharedSessionHandleResult>> {
    const operationId = input.operationId;
    if (
      !operationId.trim() ||
      !input.processGeneration.trim() ||
      !input.receiptId.trim() ||
      input.operationGeneration <= 0 ||
      input.sourceRuntimeGeneration < 0 ||
      input.sourceRuntimeGeneration !== input.expectedSourceRuntimeGeneration ||
      !input.consumerId.trim()
    ) {
      return result(
        "open",
        "stale",
        operationId,
        undefined,
        error(SHARED_SESSION_ERROR_CODES.staleHandle)
      );
    }

    let owner: OwnerIdentity;
    let file: DurableFileIdentity;
    try {
      owner = identityResolver.resolveOwner(input.owner);
      file = identityResolver.assertFile(input.target.file) as DurableFileIdentity;
      if (
        file.kind !== "durable" ||
        input.target.readOnly
      ) {
        throw new ManuscriptIdentityError(
          MANUSCRIPT_OPERATION_ERROR_CODES.invalidFileIdentity
        );
      }
    } catch (cause) {
      return result(
        "open",
        "error",
        operationId,
        undefined,
        error(
          cause instanceof ManuscriptIdentityError
            ? cause.code
            : MANUSCRIPT_OPERATION_ERROR_CODES.invalidFileIdentity,
          { category: "identity" }
        )
      );
    }

    const logicalIdentity = createSharedLogicalSessionIdentity(
      owner,
      file,
      "independent"
    );
    const sessionKey = createSharedLogicalSessionKey(logicalIdentity);
    const existing = sessions.get(sessionKey);
    if (existing) {
      const baseline = existing.state.baseline;
      if (
        !sameOwner(existing.state.owner, owner) ||
        existing.state.windowRole !== "independent" ||
        existing.state.accessMode !== "writable" ||
        existing.state.file.kind !== "durable" ||
        existing.state.file.pathIdentity !== file.pathIdentity ||
        existing.state.file.fileRefId !== file.fileRefId ||
        !baseline ||
        baseline.rawText !== input.acceptedSnapshot.rawText ||
        baseline.revision !== input.acceptedSnapshot.revision ||
        baseline.physicalIdentity !==
          input.acceptedSnapshot.physicalIdentity
      ) {
        return result(
          "open",
          "conflict",
          operationId,
          undefined,
          error(MANUSCRIPT_OPERATION_ERROR_CODES.sessionIdentityMismatch)
        );
      }
      const existingHandle = existing.consumerHandles.get(input.consumerId);
      if (existingHandle && resolveHandle(existingHandle)) {
        if (
          !bindSaveAsCandidate(
            input,
            owner,
            file,
            existingHandle,
            existing.state.sessionGeneration
          )
        ) {
          return result(
            "open",
            "conflict",
            operationId,
            undefined,
            error(MANUSCRIPT_OPERATION_ERROR_CODES.sessionIdentityMismatch)
          );
        }
        return result("open", "success", operationId, {
          handle: existingHandle,
          session: publicState(existing)
        });
      }
      if (existing.admission) {
        try {
          existing.admission = await dependencies.admission.retain(
            existing.admission.proof
          );
        } catch (cause) {
          return result(
            "open",
            "conflict",
            operationId,
            undefined,
            error(SHARED_SESSION_ERROR_CODES.admissionConflict, {
              retryable: true,
              causeCode: String(cause)
            })
          );
        }
      }
      const handle = createHandle(
        existing,
        input.consumerId,
        input.receiptId
      );
      if (
        !bindSaveAsCandidate(
          input,
          owner,
          file,
          handle,
          existing.state.sessionGeneration
        )
      ) {
        await releaseHandle(handle);
        return result(
          "open",
          "conflict",
          operationId,
          undefined,
          error(MANUSCRIPT_OPERATION_ERROR_CODES.sessionIdentityMismatch)
        );
      }
      return result("open", "success", operationId, {
        handle,
        session: publicState(existing)
      });
    }

    let admission: SharedWritableAdmissionGrant;
    try {
      admission = await dependencies.admission.acquire({
        requestId: operationId,
        logicalSessionKey: sessionKey,
        target: durableTargetRequest(file)
      });
    } catch (cause) {
      return result(
        "open",
        "conflict",
        operationId,
        undefined,
        error(SHARED_SESSION_ERROR_CODES.admissionConflict, {
          retryable: true,
          causeCode: String(cause)
        })
      );
    }

    generationCounter += 1;
    const timestamp = now();
    const internal: InternalSession = {
      admission,
      handles: new Set(),
      consumerHandles: new Map(),
      state: {
        key: sessionKey,
        sessionKey,
        logicalIdentity,
        owner: clone(owner),
        windowRole: "independent",
        file: clone(file),
        targetSnapshot: clone({
          ...input.target,
          file,
          readOnly: false,
          physicalRevision: input.acceptedSnapshot.revision
        }),
        accessMode: "writable",
        draftRawText: "",
        sessionGeneration: generationCounter,
        operationGeneration: 0,
        requestGeneration: 0,
        draftVersion: 0,
        dirty: false,
        loadStatus: "idle",
        saveStatus: "idle",
        stale: false,
        externalChangeObserved: false,
        closing: false,
        recoveryRequired: false,
        consumerCount: 0,
        createdAt: timestamp,
        updatedAt: timestamp
      }
    };
    sessions.set(sessionKey, internal);
    const handle = createHandle(
      internal,
      input.consumerId,
      input.receiptId
    );
    if (
      !bindSaveAsCandidate(
        input,
        owner,
        file,
        handle,
        internal.state.sessionGeneration
      )
    ) {
      handles.delete(handle);
      internal.handles.delete(handle);
      sessions.delete(sessionKey);
      await dependencies.admission.release(admission.proof);
      return result(
        "open",
        "conflict",
        operationId,
        undefined,
        error(MANUSCRIPT_OPERATION_ERROR_CODES.sessionIdentityMismatch)
      );
    }
    const token = beginOperation(internal, "load")!;
    if (!hydrate(internal, token, input.acceptedSnapshot, false)) {
      handles.delete(handle);
      sessions.delete(sessionKey);
      await dependencies.admission.release(admission.proof);
      return result(
        "open",
        "stale",
        operationId,
        undefined,
        error(SHARED_SESSION_ERROR_CODES.staleHandle)
      );
    }
    return result("open", "success", operationId, {
      handle,
      session: publicState(internal)
    });
  }

  async function save(
    handle: SharedManuscriptSessionHandle,
    revalidate?: (
      target: SharedTargetSnapshot
    ) => Promise<SharedSessionRevalidation>
  ): Promise<ManuscriptOperationResult<SharedManuscriptSession>> {
    const operationId = createId();
    const session = resolveHandle(handle);
    if (!session?.state.baseline) {
      return result(
        "save",
        "error",
        operationId,
        undefined,
        error(
          handles.has(handle)
            ? MANUSCRIPT_OPERATION_ERROR_CODES.sessionNotFound
            : SHARED_SESSION_ERROR_CODES.staleHandle
        )
      );
    }
    if (
      session.state.accessMode !== "writable" ||
      session.state.targetSnapshot.readOnly ||
      !session.admission ||
      session.state.file.kind !== "durable"
    ) {
      return result(
        "save",
        "error",
        operationId,
        publicState(session),
        error(SHARED_SESSION_ERROR_CODES.readOnly)
      );
    }
    if (
      session.state.windowRole === "independent" &&
      session.state.file.locationMode === "external" &&
      session.state.externalWriteConfirmedGeneration !==
        session.state.sessionGeneration
    ) {
      return result(
        "save",
        "warning",
        operationId,
        publicState(session),
        error(SHARED_SESSION_ERROR_CODES.externalWriteConfirmationRequired)
      );
    }
    const token = beginOperation(session, "save");
    if (!token) {
      return result(
        "save",
        "conflict",
        operationId,
        publicState(session),
        error(MANUSCRIPT_OPERATION_ERROR_CODES.operationInProgress, {
          retryable: true
        })
      );
    }
    try {
      await dependencies.admission.renew(
        session.admission.proof,
        durableTargetRequest(session.state.file)
      );
    } catch (cause) {
      const operationError = error(SHARED_SESSION_ERROR_CODES.admissionProofStale, {
        causeCode: String(cause)
      });
      fail(session, token, operationError, "error");
      return result("save", "error", operationId, publicState(session), operationError);
    }
    if (revalidate) {
      const checked = await revalidate(clone(session.state.targetSnapshot));
      if (checked.status !== "valid") {
        session.state.stale =
          checked.status === "current-changed" ||
          checked.status === "target-changed";
        session.state.externalChangeObserved = session.state.stale;
        const code = checked.status === "current-changed"
          ? SHARED_SESSION_ERROR_CODES.currentChanged
          : checked.status === "read-only"
            ? SHARED_SESSION_ERROR_CODES.readOnly
            : SHARED_SESSION_ERROR_CODES.targetChanged;
        const operationError = error(code, { causeCode: checked.causeCode });
        if (checked.status === "read-only") {
          try {
            await transitionToReadOnly(session, checked.causeCode);
          } catch (cause) {
            operationError.causeCode = String(cause);
          }
        }
        fail(session, token, operationError, "error");
        return result("save", "error", operationId, publicState(session), operationError);
      }
      session.state.targetSnapshot = clone(checked.target);
    }
    const gatewayResult = await dependencies.gateway.save({
      file: session.state.file,
      baseline: session.state.baseline,
      draftRawText: token.savedRaw
    });
    if (!tokenCurrent(session, token)) {
      return result(
        "save",
        "stale",
        operationId,
        publicState(session),
        error(SHARED_SESSION_ERROR_CODES.staleHandle)
      );
    }
    if (
      (gatewayResult.status === "success" ||
        gatewayResult.status === "no-op") &&
      gatewayResult.data
    ) {
      try {
        await dependencies.admission.renew(
          session.admission.proof,
          durableTargetRequest(session.state.file),
          gatewayResult.data.snapshot.revision
        );
      } catch (cause) {
        const operationError = error(
          SHARED_SESSION_ERROR_CODES.admissionProofStale,
          {
            causeCode: String(cause),
            writeApplied: gatewayResult.data.writeApplied,
            recoveryRequired: gatewayResult.data.writeApplied
          }
        );
        fail(session, token, operationError, "error");
        return result(
          "save",
          "error",
          operationId,
          publicState(session),
          operationError
        );
      }
      hydrate(session, token, gatewayResult.data.snapshot, true);
      session.state.saveStatus = "saved";
      return result(
        "save",
        gatewayResult.status,
        operationId,
        publicState(session)
      );
    }
    const operationError = gatewayResult.error ??
      error(MANUSCRIPT_OPERATION_ERROR_CODES.operationFailed);
    fail(session, token, operationError, gatewayResult.status);
    return result(
      "save",
      gatewayResult.status,
      operationId,
      publicState(session),
      operationError
    );
  }

  async function reread(
    handle: SharedManuscriptSessionHandle,
    kind: "reload" | "discard"
  ): Promise<ManuscriptOperationResult<SharedManuscriptSession>> {
    const operationId = createId();
    const session = resolveHandle(handle);
    if (!session) {
      return result(
        "discard",
        "error",
        operationId,
        undefined,
        error(SHARED_SESSION_ERROR_CODES.staleHandle)
      );
    }
    const token = beginOperation(session, kind);
    if (!token) {
      return result(
        "discard",
        "conflict",
        operationId,
        publicState(session),
        error(MANUSCRIPT_OPERATION_ERROR_CODES.operationInProgress)
      );
    }
    const read = await dependencies.gateway.read({ file: session.state.file });
    if (
      read.status !== "success" ||
      !read.data ||
      !hydrate(session, token, read.data, false)
    ) {
      const operationError = read.error ??
        error(
          kind === "discard"
            ? SHARED_SESSION_ERROR_CODES.discardFailed
            : MANUSCRIPT_OPERATION_ERROR_CODES.fileUnreadable
        );
      fail(session, token, operationError, read.status);
      return result(
        "discard",
        read.status,
        operationId,
        publicState(session),
        operationError
      );
    }
    return result("discard", "success", operationId, publicState(session));
  }

  async function reload(
    handle: SharedManuscriptSessionHandle,
    decision?: "discard" | "cancel",
    revalidate?: (
      target: SharedTargetSnapshot
    ) => Promise<SharedSessionRevalidation>
  ) {
    const session = resolveHandle(handle);
    const operationId = createId();
    if (!session) {
      return result(
        "open",
        "error",
        operationId,
        undefined,
        error(SHARED_SESSION_ERROR_CODES.staleHandle)
      );
    }
    if (session.state.activeOperation) {
      return result(
        "open",
        "conflict",
        operationId,
        publicState(session),
        error(MANUSCRIPT_OPERATION_ERROR_CODES.operationInProgress, {
          retryable: true
        })
      );
    }
    if (session.state.dirty && !decision) {
      return result(
        "open",
        "warning",
        operationId,
        publicState(session),
        error(SHARED_SESSION_ERROR_CODES.dirtyDecisionRequired)
      );
    }
    if (decision === "cancel") {
      return result("open", "canceled", operationId, publicState(session));
    }
    if (revalidate) {
      const checked = await revalidate(clone(session.state.targetSnapshot));
      if (checked.status !== "valid") {
        const code = checked.status === "current-changed"
          ? SHARED_SESSION_ERROR_CODES.currentChanged
          : checked.status === "read-only"
            ? SHARED_SESSION_ERROR_CODES.readOnly
            : SHARED_SESSION_ERROR_CODES.targetChanged;
        if (checked.status === "read-only") {
          try {
            await transitionToReadOnly(session, checked.causeCode);
          } catch (cause) {
            return result(
              "open",
              "error",
              operationId,
              publicState(session),
              error(SHARED_SESSION_ERROR_CODES.admissionProofStale, {
                causeCode: String(cause)
              })
            );
          }
        } else {
          session.state.stale = true;
          session.state.externalChangeObserved = true;
          session.state.error = error(code, { causeCode: checked.causeCode });
        }
        return result(
          "open",
          "error",
          operationId,
          publicState(session),
          error(code, { causeCode: checked.causeCode })
        );
      }
      session.state.targetSnapshot = clone(checked.target);
    }
    return reread(handle, "reload");
  }

  async function releaseHandle(
    handle: SharedManuscriptSessionHandle
  ): Promise<SharedConsumerReleaseOutcome | undefined> {
    const session = resolveHandle(handle);
    if (!session) return undefined;
    const record = handles.get(handle);
    const admissionRelease = session.admission
      ? await dependencies.admission.release(session.admission.proof)
      : undefined;
    if (admissionRelease && !admissionRelease.released) {
      throw new Error("MANUSCRIPT_ADMISSION_RELEASE_UNCONFIRMED");
    }
    session.handles.delete(handle);
    if (record?.consumerId) session.consumerHandles.delete(record.consumerId);
    handles.delete(handle);
    if (record?.receiptId) {
      candidateBindings.delete(record.receiptId);
      resolvedCandidateReceipts.add(record.receiptId);
    }
    if (session.handles.size === 0) {
      sessions.delete(session.state.sessionKey);
      session.state.sessionGeneration += 1;
    }
    return {
      consumerCleanupState: "released",
      sessionCleanupState: session.handles.size === 0
        ? "released"
        : "retained-by-other-consumer",
      admissionCleanupState: !admissionRelease || admissionRelease.finalRelease
        ? "released"
        : "legitimately-retained"
    };
  }

  async function closeCleanSessions(
    predicate: (session: SharedManuscriptSession) => boolean
  ) {
    const matching = [...sessions.values()].filter((session) =>
      predicate(publicState(session))
    );
    if (
      matching.some((session) =>
        session.state.dirty ||
        session.state.recoveryRequired ||
        Boolean(session.state.activeOperation)
      )
    ) {
      return false;
    }
    for (const session of matching) {
      for (const handle of [...session.handles]) {
        if (!(await releaseHandle(handle))) return false;
      }
    }
    return true;
  }

  async function close(
    handle: SharedManuscriptSessionHandle,
    decision?: SharedCloseDecision,
    revalidate?: (
      target: SharedTargetSnapshot
    ) => Promise<SharedSessionRevalidation>
  ): Promise<ManuscriptOperationResult<SharedManuscriptSession>> {
    const operationId = createId();
    const session = resolveHandle(handle);
    if (!session) {
      return result(
        "close",
        "error",
        operationId,
        undefined,
        error(SHARED_SESSION_ERROR_CODES.staleHandle)
      );
    }
    if (session.state.activeOperation) {
      return result(
        "close",
        "conflict",
        operationId,
        publicState(session),
        error(MANUSCRIPT_OPERATION_ERROR_CODES.operationInProgress, {
          retryable: true
        })
      );
    }
    if (session.state.dirty && !decision) {
      return result(
        "close",
        "warning",
        operationId,
        publicState(session),
        error(SHARED_SESSION_ERROR_CODES.dirtyDecisionRequired)
      );
    }
    if (decision === "cancel") {
      return result(
        "close",
        "canceled",
        operationId,
        publicState(session),
        error(SHARED_SESSION_ERROR_CODES.closeCanceled)
      );
    }
    if (session.state.dirty && decision === "save") {
      const saved = await save(handle, revalidate);
      if (
        (saved.status !== "success" && saved.status !== "no-op") ||
        resolveHandle(handle)?.state.dirty
      ) {
        return result(
          "close",
          saved.status,
          operationId,
          saved.data ?? publicState(session),
          saved.error
        );
      }
    } else if (session.state.dirty && decision === "discard") {
      const discarded = await reread(handle, "discard");
      if (discarded.status !== "success") {
        return result(
          "close",
          discarded.status,
          operationId,
          discarded.data ?? publicState(session),
          discarded.error
        );
      }
    }
    const snapshot = publicState(session);
    try {
      const cleanup = await releaseHandle(handle);
      if (!cleanup) {
        return {
          ...result(
            "close",
            "error",
            operationId,
            publicState(session),
            error(SHARED_SESSION_ERROR_CODES.staleHandle)
          ),
          cleanup: {
            consumerCleanupState: "unresolved" as const,
            sessionCleanupState: "unresolved" as const,
            admissionCleanupState: "unresolved" as const
          }
        };
      }
      return {
        ...result("close", "success", operationId, snapshot),
        cleanup
      };
    } catch (cause) {
      return {
        ...result(
          "close",
          "error",
          operationId,
          publicState(session),
          error(SHARED_SESSION_ERROR_CODES.admissionProofStale, {
            causeCode: String(cause)
          })
        ),
        cleanup: {
          consumerCleanupState: "unresolved" as const,
          sessionCleanupState: "unresolved" as const,
          admissionCleanupState: "unresolved" as const
        }
      };
    }
  }

  return Object.freeze({
    open,
    activateSaveAsTarget,
    save,
    reload,
    discard(handle: SharedManuscriptSessionHandle) {
      return reread(handle, "discard");
    },
    close,
    readSaveAsCandidateBinding(receiptId: string) {
      const binding = candidateBindings.get(receiptId);
      return binding ? clone(binding) : undefined;
    },
    async closeSaveAsCandidate(
      expected: SharedSaveAsCandidateRuntimeBinding
    ): Promise<SharedSaveAsCandidateCloseResult> {
      const binding = candidateBindings.get(expected.receiptId);
      if (!binding) {
        return resolvedCandidateReceipts.has(expected.receiptId)
          ? { status: "already-absent", receiptId: expected.receiptId }
          : { status: "identity-mismatch", receiptId: expected.receiptId };
      }
      if (
        binding.operationId !== expected.operationId ||
        binding.processGeneration !== expected.processGeneration ||
        !sameOwner(binding.owner, expected.owner) ||
        binding.candidateFileRefId !== expected.candidateFileRefId ||
        binding.runtimeHandle !== expected.runtimeHandle ||
        binding.runtimeConsumerId !== expected.runtimeConsumerId
      ) {
        return {
          status: "identity-mismatch",
          receiptId: expected.receiptId
        };
      }
      if (binding.runtimeGeneration !== expected.runtimeGeneration) {
        return {
          status: "generation-mismatch",
          receiptId: expected.receiptId
        };
      }
      const closed = await close(binding.runtimeHandle, "discard");
      if (closed.status === "success") {
        return { status: "closed", binding: clone(binding) };
      }
      if (
        closed.status === "error" &&
        String(closed.error?.code) === SHARED_SESSION_ERROR_CODES.staleHandle
      ) {
        candidateBindings.delete(expected.receiptId);
        resolvedCandidateReceipts.add(expected.receiptId);
        return {
          status: "already-absent",
          receiptId: expected.receiptId
        };
      }
      return {
        status:
          closed.status === "conflict" || closed.error?.retryable
            ? "retryable-failure"
            : "cleanup-blocked",
        receiptId: expected.receiptId,
        errorCode: String(closed.error?.code ?? "SAVE_AS_CLEANUP_FAILED")
      };
    },
    closeCleanSessions,
    readSaveAsSourceSnapshot(
      handle: SharedManuscriptSessionHandle
    ) {
      const session = resolveHandle(handle);
      if (!session) return undefined;
      const sourceRevision =
        session.state.currentRevision ??
        session.state.openedRevision ??
        session.state.baseline?.revision;
      return {
        owner: clone(session.state.owner),
        windowRole: session.state.windowRole,
        sourceRuntimeHandle: handle,
        sourceSessionKey: session.state.sessionKey,
        sourceSessionGeneration: session.state.sessionGeneration,
        sourceFileRefId:
          session.state.file.kind === "durable"
            ? session.state.file.fileRefId
            : "",
        sourcePathIdentityKey: session.state.file.pathIdentity,
        sourceRevision: sourceRevision ?? "",
        frozenDraftRevision: session.state.draftVersion,
        frozenBaselineRevision:
          session.state.baseline?.revision ?? sourceRevision ?? "",
        frozenBaselinePhysicalIdentity:
          session.state.baseline?.physicalIdentity,
        frozenDirty: session.state.dirty,
        rawText: session.state.draftRawText,
        encoding:
          session.state.encoding ??
          session.state.baseline?.encoding ??
          "utf-8",
        newline:
          session.state.newline ??
          session.state.baseline?.newline ??
          "none",
        fileKind: session.state.file.kind,
        accessMode: session.state.accessMode,
        stale: session.state.stale,
        recoveryRequired: session.state.recoveryRequired
      };
    },
    validateSaveAsSourceIdentity(input: {
      sourceRuntimeHandle: SharedManuscriptSessionHandle;
      owner: OwnerIdentity;
      sourceWindowRole: "current" | "independent";
      sourceSessionKey: string;
      sourceSessionGeneration: number;
      sourceFileRefId: string;
      sourcePathIdentityKey: string;
    }) {
      const session = resolveHandle(input.sourceRuntimeHandle);
      return Boolean(
        session &&
        sameOwner(session.state.owner, input.owner) &&
        session.state.windowRole === input.sourceWindowRole &&
        session.state.sessionKey === input.sourceSessionKey &&
        session.state.sessionGeneration ===
          input.sourceSessionGeneration &&
        session.state.file.kind === "durable" &&
        session.state.file.fileRefId === input.sourceFileRefId &&
        session.state.file.pathIdentity ===
          input.sourcePathIdentityKey &&
        session.state.accessMode === "writable" &&
        !session.state.stale &&
        !session.state.recoveryRequired
      );
    },
    updateDraft(handle: SharedManuscriptSessionHandle, draftRawText: string) {
      const session = resolveHandle(handle);
      if (
        !session ||
        session.state.accessMode === "read-only" ||
        (
          session.state.activeOperation &&
          session.state.activeOperation.kind !== "save"
        )
      ) {
        return undefined;
      }
      session.state.draftRawText = draftRawText;
      session.state.draftVersion += 1;
      session.state.dirty =
        draftRawText !== session.state.baseline?.rawText;
      session.state.updatedAt = now();
      return publicState(session);
    },
    getSession(handle: SharedManuscriptSessionHandle) {
      const session = resolveHandle(handle);
      return session ? publicState(session) : undefined;
    },
    listSessions() {
      return [...sessions.values()].map(publicState);
    },
    listSessionConsumers() {
      return [...handles.entries()].flatMap(([handle, record]) => {
        const session = sessions.get(record.sessionKey);
        return session && resolveHandle(handle)
          ? [{ handle, consumerId: record.consumerId, session: publicState(session) }]
          : [];
      });
    },
    requiresExternalWriteConfirmation(
      handle: SharedManuscriptSessionHandle
    ) {
      const session = resolveHandle(handle);
      return Boolean(
        session &&
        session.state.windowRole === "independent" &&
        session.state.file.locationMode === "external" &&
        session.state.externalWriteConfirmedGeneration !==
          session.state.sessionGeneration
      );
    },
    confirmExternalWrite(
      handle: SharedManuscriptSessionHandle,
      expectedSessionGeneration: number
    ) {
      const session = resolveHandle(handle);
      if (
        !session ||
        session.state.windowRole !== "independent" ||
        session.state.file.locationMode !== "external" ||
        session.state.sessionGeneration !== expectedSessionGeneration
      ) {
        return false;
      }
      session.state.externalWriteConfirmedGeneration =
        expectedSessionGeneration;
      session.state.updatedAt = now();
      return true;
    },
    cancel(handle: SharedManuscriptSessionHandle) {
      const session = resolveHandle(handle);
      if (!session?.state.activeOperation) return false;
      session.state.operationGeneration += 1;
      clearOperation(session);
      return true;
    },
    async detachWindow() {
      handles.clear();
      sessions.clear();
      candidateBindings.clear();
      return dependencies.admission.detachWindow();
    },
    async transitionToReadOnlySessions(
      predicate: (session: SharedManuscriptSession) => boolean,
      causeCode?: string
    ) {
      const matching = [...sessions.values()].filter((session) =>
        predicate(publicState(session))
      );
      for (const session of matching) {
        await transitionToReadOnly(session, causeCode);
      }
      return matching.length;
    }
  });
}

export type SharedManuscriptSessionRuntime = ReturnType<
  typeof createSharedManuscriptSessionRuntime
>;
