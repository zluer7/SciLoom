import type {
  EntityId,
  FileRef,
  ManuscriptBinding,
  ReviewType
} from "../types";
import {
  MANUSCRIPT_IO_ERROR_CODES,
  type ReadManuscriptByFileRefResult
} from "../types/manuscriptIo";
import {
  MANUSCRIPT_SWITCH_ERROR_CODES,
  type AvailableManuscriptItem,
  type ManuscriptSwitchErrorCode,
  type SwitchCurrentManuscriptResult
} from "../types/manuscriptSwitch";
import type {
  SharedManuscriptSession,
  SharedManuscriptSessionHandle
} from "../types/sharedManuscriptSession";
import { createPathIdentityKey } from "./fileRefIdentity";
import { fileRefService, getSafeManuscriptBasename } from "./fileRefService";
import { resolveMountedManuscriptLifecycleDecision } from "./fileRefOwnerValidator";
import type {
  FormalSwitchError,
  FormalSwitchRecoveryEvidence,
  FormalSwitchSnapshot
} from "./formalSwitchEngine";
import { tryAcquireCanonicalFormalSwitchOwnerOperation } from "./experimentManuscriptOwnerOperationGate";
import { manuscriptIoService } from "./manuscriptIoService";
import { manuscriptBindingService } from "./manuscriptBindingService";
import { manuscriptListService } from "./manuscriptListService";
import type { ManuscriptSwitchDependencies } from "./manuscriptSwitchService";
import {
  buildCanonicalFormalSwitchArchiveCandidate,
  buildCanonicalFormalSwitchOldCurrentSettlement
} from "./canonicalFormalSwitchArchiveConvergence";
import { convergeCanonicalFormalSwitchRuntime } from "./canonicalFormalSwitchRuntimeConvergence";
import { createOperationLog } from "./operationLogService";
import { reviewManuscriptAdapterService } from "./reviewManuscriptAdapterService";
import { reviewManuscriptPageStateService } from "./reviewManuscriptPageStateService";
import { reviewManuscriptSelectionService } from "./reviewManuscriptSelectionService";
import { reviewManuscriptStructuredDataService } from "./reviewManuscriptStructuredDataService";
import { reviewRawManuscriptService } from "./reviewRawManuscriptService";
import {
  createReferenceOwnerFormalSwitchProductionBridge,
  type ReferenceOwnerCanonicalAdapter,
  type ReferenceOwnerProductionProvider
} from "./referenceOwnerFormalSwitchProductionBridge";
import { publishRefreshEvent } from "./refreshEventService";
import {
  readReviewStructuredStates,
  type ReviewStructuredStateRecord
} from "./reviewStructuredStateService";

type ReviewTargetReadSuccess = Extract<
  ReadManuscriptByFileRefResult,
  { status: "success" }
>;
type ReviewTargetReadError = Extract<
  ReadManuscriptByFileRefResult,
  { status: "error" }
>;
type ReviewSwitchError = Extract<
  SwitchCurrentManuscriptResult,
  { status: "error" }
>;

export interface ReviewTargetReadOnlyCandidate {
  readonly ownerType: "review";
  readonly reviewId: EntityId;
  readonly manuscriptChannel: "primary";
  readonly bindingId: EntityId;
  readonly targetFileRefId: EntityId;
  readonly path: string;
  readonly pathIdentityKey: string;
  readonly locationMode: ReviewTargetReadSuccess["locationMode"];
  readonly source: ReviewTargetReadSuccess["source"];
  readonly exactRawSnapshot: string;
  readonly rawSnapshotSha256: string;
  readonly sizeBytes: number;
  readonly encoding: "utf-8";
  readonly warnings: readonly string[];
  readonly requestToken: number;
  readonly parserInputIdentity: string;
  readonly candidateSnapshotIdentity: string;
  readonly physicalRevisionEvidence: string;
  readonly operationIdentity: string;
}

export interface ReviewTargetReadOnlyDependencies {
  readTarget: typeof manuscriptIoService.readManuscriptByFileRef;
  hashRawSnapshot(rawMarkdown: string): Promise<string>;
  isRequestCurrent(): boolean;
}

export async function sha256ReviewTargetSnapshot(rawMarkdown: string) {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(rawMarkdown)
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function switchFailure(
  requestToken: number,
  code: ManuscriptSwitchErrorCode,
  message: string,
  warnings: string[] = []
): ReviewSwitchError {
  return {
    status: "error",
    error: { code, message },
    warnings,
    requestToken
  };
}

function targetReadCode(error: ReviewTargetReadError) {
  switch (error.error.code) {
    case MANUSCRIPT_IO_ERROR_CODES.fileRefNotFound:
      return MANUSCRIPT_SWITCH_ERROR_CODES.targetNotFound;
    case MANUSCRIPT_IO_ERROR_CODES.fileRefDeleted:
      return MANUSCRIPT_SWITCH_ERROR_CODES.targetDeleted;
    case MANUSCRIPT_IO_ERROR_CODES.fileRefOwnerMismatch:
      return MANUSCRIPT_SWITCH_ERROR_CODES.targetOwnerMismatch;
    case MANUSCRIPT_IO_ERROR_CODES.fileRefChannelMismatch:
      return MANUSCRIPT_SWITCH_ERROR_CODES.targetChannelMismatch;
    case MANUSCRIPT_IO_ERROR_CODES.fileRefInvalidKind:
      return MANUSCRIPT_SWITCH_ERROR_CODES.targetInvalidKind;
    case MANUSCRIPT_IO_ERROR_CODES.fileRefInvalidRole:
      return MANUSCRIPT_SWITCH_ERROR_CODES.targetInvalidRole;
    case MANUSCRIPT_IO_ERROR_CODES.staleRequest:
      return MANUSCRIPT_SWITCH_ERROR_CODES.stale;
    default:
      return MANUSCRIPT_SWITCH_ERROR_CODES.targetUnreadable;
  }
}

function readError(
  candidate: ReviewTargetReadOnlyCandidate,
  requestToken: number,
  code: ReviewTargetReadError["error"]["code"],
  message: string
): ReviewTargetReadError {
  return {
    status: "error",
    ownerType: candidate.ownerType,
    ownerId: candidate.reviewId,
    error: { code, message },
    warnings: [],
    requestToken
  };
}

function candidateReadResult(
  candidate: ReviewTargetReadOnlyCandidate,
  requestToken: number
): ReviewTargetReadSuccess {
  return {
    status: "success",
    ownerType: candidate.ownerType,
    ownerId: candidate.reviewId,
    bindingId: candidate.bindingId,
    fileRefId: candidate.targetFileRefId,
    path: candidate.path,
    locationMode: candidate.locationMode,
    source: candidate.source,
    content: candidate.exactRawSnapshot,
    sizeBytes: candidate.sizeBytes,
    encoding: candidate.encoding,
    warnings: [...candidate.warnings],
    requestToken
  };
}

export async function readReviewTargetReadOnlyCandidate(
  dependencies: ReviewTargetReadOnlyDependencies,
  input: {
    reviewId: EntityId;
    targetFileRefId: EntityId;
    requestToken: number;
  }
): Promise<
  | { status: "success"; candidate: ReviewTargetReadOnlyCandidate }
  | ReviewSwitchError
> {
  if (!dependencies.isRequestCurrent()) {
    return switchFailure(
      input.requestToken,
      MANUSCRIPT_SWITCH_ERROR_CODES.stale,
      "Review manuscript switch request is stale."
    );
  }
  const read = await dependencies.readTarget(
    "review",
    input.reviewId,
    input.targetFileRefId,
    {
      requestToken: input.requestToken,
      manuscriptChannel: "primary"
    }
  );
  if (read.status === "error") {
    return switchFailure(
      input.requestToken,
      targetReadCode(read),
      read.error.message,
      read.warnings
    );
  }
  if (!dependencies.isRequestCurrent()) {
    return switchFailure(
      input.requestToken,
      MANUSCRIPT_SWITCH_ERROR_CODES.stale,
      "Review manuscript switch request is stale."
    );
  }
  if (
    read.ownerType !== "review" ||
    read.ownerId !== input.reviewId ||
    read.fileRefId !== input.targetFileRefId
  ) {
    return switchFailure(
      input.requestToken,
      MANUSCRIPT_SWITCH_ERROR_CODES.targetOwnerMismatch,
      "Resolved Review target manuscript identity does not match."
    );
  }
  let pathIdentityKey: string;
  try {
    pathIdentityKey = createPathIdentityKey(read.path);
  } catch {
    return switchFailure(
      input.requestToken,
      MANUSCRIPT_SWITCH_ERROR_CODES.targetUnreadable,
      "Review target manuscript path identity is invalid."
    );
  }
  const rawSnapshotSha256 = await dependencies.hashRawSnapshot(read.content);
  if (!dependencies.isRequestCurrent()) {
    return switchFailure(
      input.requestToken,
      MANUSCRIPT_SWITCH_ERROR_CODES.stale,
      "Review manuscript switch request is stale."
    );
  }
  const exactUtf8ByteLength = new TextEncoder().encode(read.content).byteLength;
  if (exactUtf8ByteLength !== read.sizeBytes) {
    return switchFailure(
      input.requestToken,
      MANUSCRIPT_SWITCH_ERROR_CODES.targetUnreadable,
      "Review target manuscript byte identity does not match its readback."
    );
  }
  const candidateSnapshotIdentity = [
    "review",
    input.reviewId,
    "primary",
    input.targetFileRefId,
    pathIdentityKey,
    rawSnapshotSha256,
    String(read.sizeBytes)
  ].join(":");
  return {
    status: "success",
    candidate: Object.freeze({
      ownerType: "review",
      reviewId: input.reviewId,
      manuscriptChannel: "primary",
      bindingId: read.bindingId,
      targetFileRefId: input.targetFileRefId,
      path: read.path,
      pathIdentityKey,
      locationMode: read.locationMode,
      source: read.source,
      exactRawSnapshot: read.content,
      rawSnapshotSha256,
      sizeBytes: read.sizeBytes,
      encoding: read.encoding,
      warnings: Object.freeze([...read.warnings]),
      requestToken: input.requestToken,
      parserInputIdentity: `${input.targetFileRefId}:${rawSnapshotSha256}`,
      candidateSnapshotIdentity,
      physicalRevisionEvidence:
        `utf8-sha256:${rawSnapshotSha256}:bytes:${read.sizeBytes}`,
      operationIdentity:
        `${input.reviewId}:primary:${input.requestToken}:${input.targetFileRefId}:${rawSnapshotSha256}`
    })
  };
}

export function createReviewTargetCandidateReadPort(
  dependencies: ReviewTargetReadOnlyDependencies,
  candidate: ReviewTargetReadOnlyCandidate
): ManuscriptSwitchDependencies["readTarget"] {
  return async (ownerType, ownerId, fileRefId, options) => {
    const requestToken = options.requestToken ?? candidate.requestToken;
    if (
      ownerType !== candidate.ownerType ||
      ownerId !== candidate.reviewId ||
      (options.manuscriptChannel ?? "primary") !==
        candidate.manuscriptChannel ||
      fileRefId !== candidate.targetFileRefId
    ) {
      return readError(
        candidate,
        requestToken,
        MANUSCRIPT_IO_ERROR_CODES.externalIdentityConflict,
        "Review target comparison identity does not match the confirmed candidate."
      );
    }
    if (!dependencies.isRequestCurrent()) {
      return readError(
        candidate,
        requestToken,
        MANUSCRIPT_IO_ERROR_CODES.staleRequest,
        "Review target comparison request is stale."
      );
    }
    const compared = await dependencies.readTarget(
      ownerType,
      ownerId,
      fileRefId,
      {
        requestToken,
        manuscriptChannel: candidate.manuscriptChannel
      }
    );
    if (compared.status === "error") return compared;
    const comparedHash = await dependencies.hashRawSnapshot(compared.content);
    let comparedPathIdentity: string;
    try {
      comparedPathIdentity = createPathIdentityKey(compared.path);
    } catch {
      return readError(
        candidate,
        requestToken,
        MANUSCRIPT_IO_ERROR_CODES.pathInvalid,
        "Review target comparison path identity is invalid."
      );
    }
    if (!dependencies.isRequestCurrent()) {
      return readError(
        candidate,
        requestToken,
        MANUSCRIPT_IO_ERROR_CODES.staleRequest,
        "Review target comparison request is stale."
      );
    }
    const changed =
      compared.ownerType !== candidate.ownerType ||
      compared.ownerId !== candidate.reviewId ||
      compared.bindingId !== candidate.bindingId ||
      compared.fileRefId !== candidate.targetFileRefId ||
      comparedPathIdentity !== candidate.pathIdentityKey ||
      compared.locationMode !== candidate.locationMode ||
      compared.source !== candidate.source ||
      compared.encoding !== candidate.encoding ||
      compared.sizeBytes !== candidate.sizeBytes ||
      comparedHash !== candidate.rawSnapshotSha256 ||
      compared.content !== candidate.exactRawSnapshot;
    if (changed) {
      return readError(
        candidate,
        requestToken,
        MANUSCRIPT_IO_ERROR_CODES.staleRequest,
        "Review target manuscript changed after confirmation; select and confirm it again."
      );
    }
    return candidateReadResult(candidate, requestToken);
  };
}

interface ReviewFormalSwitchSnapshot extends FormalSwitchSnapshot {
  ownerType: "review";
  ownerSubtype: ReviewType;
  channel: "primary";
  binding: ManuscriptBinding;
  currentFile: FileRef;
  defaultFile: FileRef;
  targetFile: FileRef;
  currentSession: SharedManuscriptSession;
  targetSession: SharedManuscriptSession;
  currentSessionHandle: SharedManuscriptSessionHandle;
  targetSessionHandle: SharedManuscriptSessionHandle;
  currentRuntimeConsumerId: string;
  targetRuntimeConsumerId: string;
  structuredState: ReviewStructuredStateRecord;
  structuredIdentity: string;
  replacements: readonly {
    stableKey: string;
    action: "set" | "clear";
    value?: string;
  }[];
}

type ReviewCanonicalPreflight =
  | {
      status: "ready";
      preflightToken: string;
      operationId: string;
      expiresAt: string;
      diagnostics: readonly { code: string }[];
    }
  | { status: "error"; error: FormalSwitchError };

type ReviewCanonicalConfirm =
  | {
      status: "success";
      operationId: string;
      sessionKey: string;
      warnings: string[];
    }
  | { status: "canceled"; operationId: string }
  | { status: "error"; error: FormalSwitchError };

interface ReviewPreflightRuntimeInput {
  currentSessionHandle: SharedManuscriptSessionHandle;
  targetSessionHandle: SharedManuscriptSessionHandle;
  targetFileRefId: EntityId;
}

function now() {
  return new Date().toISOString();
}

function createId(prefix: string) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

function hashText(text: string) {
  const bytes = new TextEncoder().encode(text);
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}

function byteLength(text: string) {
  return new TextEncoder().encode(text).byteLength;
}

function sameFile(expected: FileRef, actual: FileRef | undefined) {
  return Boolean(
    actual &&
      !actual.deletedAt &&
      actual.id === expected.id &&
      actual.ownerType === "review" &&
      actual.ownerId === expected.ownerId &&
      actual.manuscriptChannel === "primary" &&
      actual.resourceKind === "file" &&
      actual.fileRole === "manuscript" &&
      actual.locationMode === expected.locationMode &&
      actual.pathIdentityKey === expected.pathIdentityKey
  );
}

function formalFailure(
  operationId: string,
  stage: FormalSwitchError["stage"],
  causeCode: string,
  recoveryRequired = false
): FormalSwitchError {
  const code = recoveryRequired
    ? "REVIEW_MANUSCRIPT_FORMAL_SWITCH_RECOVERY_REQUIRED"
    : "REVIEW_MANUSCRIPT_FORMAL_SWITCH_STALE";
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
      frontendProvenance: "review_formal_switch_canonical_provider_v1",
      rustProvenance: "canonical_formal_switch_engine_v1",
      schemaProvenance: "schema-v54"
    },
    sideEffectSummary: {
      oldCurrentWritten: recoveryRequired,
      targetWritten: false,
      databaseCommitted: false,
      sessionActivated: false
    }
  };
}

function canonicalError(
  causeCode: string,
  operationId = createId("review-primary-formal-switch")
): { status: "error"; error: FormalSwitchError } {
  return {
    status: "error",
    error: formalFailure(operationId, "preflight", causeCode)
  };
}

function parseRuntimeInput(value: string): ReviewPreflightRuntimeInput {
  const input = JSON.parse(value) as Partial<ReviewPreflightRuntimeInput>;
  if (
    typeof input.currentSessionHandle !== "string" ||
    typeof input.targetSessionHandle !== "string" ||
    typeof input.targetFileRefId !== "string"
  ) {
    throw new Error("REVIEW_MANUSCRIPT_FORMAL_SWITCH_RUNTIME_INPUT_INVALID");
  }
  return input as ReviewPreflightRuntimeInput;
}

function exactSession(
  handle: SharedManuscriptSessionHandle,
  reviewId: EntityId,
  role: "current" | "independent",
  fileRefId: EntityId
) {
  const session = reviewRawManuscriptService.getSession(handle);
  if (
    !session ||
    session.owner.ownerId !== reviewId ||
    session.owner.channel !== "primary" ||
    session.windowRole !== role ||
    session.file.kind !== "durable" ||
    session.file.fileRefId !== fileRefId ||
    !session.baseline ||
    session.dirty ||
    session.recoveryRequired ||
    session.saveStatus === "saving"
  ) {
    throw new Error("REVIEW_MANUSCRIPT_FORMAL_SWITCH_RUNTIME_IDENTITY_INVALID");
  }
  return session;
}

async function readStructuredState(reviewId: EntityId) {
  const states = await readReviewStructuredStates([reviewId]);
  const state = states.length === 1 ? states[0] : undefined;
  if (!state || state.reviewId !== reviewId) {
    throw new Error("SECOND_LAYER_NOT_PROVISIONED");
  }
  return state;
}

function structuredIdentity(state: ReviewStructuredStateRecord) {
  return hashText(JSON.stringify(state));
}

function targetCandidate(
  reviewType: ReviewType,
  rawMarkdown: string
) {
  return buildCanonicalFormalSwitchArchiveCandidate({
    rawMarkdown,
    descriptorLookupIdentity: {
      ownerType: "review",
      channel: "primary",
      reviewType
    }
  });
}

function canonicalOldCurrentPost(snapshot: ReviewFormalSwitchSnapshot) {
  const values = Object.fromEntries(
    snapshot.structuredState.outlineSections.map((section) => [
      section.key,
      section.content
    ])
  );
  return buildCanonicalFormalSwitchOldCurrentSettlement({
    currentRawMarkdown: snapshot.currentRawText,
    descriptorLookupIdentity: {
      ownerType: "review",
      channel: "primary",
      reviewType: snapshot.ownerSubtype
    },
    currentStructuredValues: values
  }).expectedPostText;
}

async function activateCurrent(reviewId: EntityId, targetFileRefId: EntityId) {
  return convergeCanonicalFormalSwitchRuntime({
    ownerType: "review",
    ownerId: reviewId,
    channel: "primary",
    targetFileRefId,
    consumerId: `review-formal-switch:${reviewId}:primary`,
    openCurrent: async (consumerId) => {
      const opened = await reviewRawManuscriptService.openCurrent(
        reviewId,
        consumerId
      );
      return opened.status === "success" && "sessionKey" in opened && "session" in opened
        ? { status: "success", sessionKey: opened.sessionKey, session: opened.session }
        : { status: opened.status };
    }
  });
}

function createReviewFormalSwitchAdapter(
  reviewType: ReviewType
): ReferenceOwnerCanonicalAdapter<
  ReviewFormalSwitchSnapshot,
  ReviewCanonicalPreflight,
  ReviewCanonicalConfirm
> {
  return {
    ownerType: "review",
    async resolveLifecycleEligibility(ownerId) {
      const decision = await resolveMountedManuscriptLifecycleDecision({
        ownerType: "review",
        ownerId,
        manuscriptChannel: "primary"
      });
      return decision.reasonCode
        ? { canSwitch: decision.canSwitch, reasonCode: decision.reasonCode }
        : { canSwitch: decision.canSwitch };
    },
    schemaProvenance: "schema-v54",
    operationPrefix: `review-${reviewType}-primary-formal-switch`,
    codes: {
      inProgress: "REVIEW_MANUSCRIPT_FORMAL_SWITCH_IN_PROGRESS",
      stale: "REVIEW_MANUSCRIPT_FORMAL_SWITCH_STALE",
      recovery: "REVIEW_MANUSCRIPT_FORMAL_SWITCH_RECOVERY_REQUIRED",
      writeback: "REVIEW_MANUSCRIPT_FORMAL_SWITCH_SETTLEMENT_FAILED",
      transaction: "REVIEW_MANUSCRIPT_FORMAL_SWITCH_TRANSACTION_FAILED",
      postVerify: "REVIEW_MANUSCRIPT_FORMAL_SWITCH_POST_VERIFY_FAILED",
      activation: "REVIEW_MANUSCRIPT_FORMAL_SWITCH_ACTIVATION_FAILED"
    },
    now,
    createId,
    acquire(ownerId) {
      return tryAcquireCanonicalFormalSwitchOwnerOperation("review", ownerId);
    },
    async resolveSnapshot(ownerId, runtimeInputJson) {
      try {
        const runtimeInput = parseRuntimeInput(runtimeInputJson);
        const [binding, state] = await Promise.all([
          manuscriptBindingService.getBindingByOwner("review", ownerId, "primary"),
          readStructuredState(ownerId)
        ]);
        if (
          state.reviewType !== reviewType ||
          state.descriptorIdentity !== `review/primary/${reviewType}/v1` ||
          state.lifecycleStatus !== "active"
        ) {
          return canonicalError("REVIEW_MANUSCRIPT_FORMAL_SWITCH_STRUCTURED_STATE_INVALID");
        }
        if (
          !binding ||
          binding.deletedAt ||
          binding.ownerType !== "review" ||
          binding.ownerId !== ownerId ||
          binding.manuscriptChannel !== "primary" ||
          !binding.currentFileRefId ||
          !binding.defaultManuscriptFileRefId
        ) {
          return canonicalError("REVIEW_MANUSCRIPT_FORMAL_SWITCH_BINDING_INVALID");
        }
        if (binding.currentFileRefId === runtimeInput.targetFileRefId) {
          return canonicalError("REVIEW_MANUSCRIPT_FORMAL_SWITCH_TARGET_ALREADY_CURRENT");
        }
        const [currentFile, defaultFile, targetFile] = await Promise.all([
          fileRefService.getById(binding.currentFileRefId),
          fileRefService.getById(binding.defaultManuscriptFileRefId),
          fileRefService.getById(runtimeInput.targetFileRefId)
        ]);
        if (!currentFile || !defaultFile || !targetFile) {
          return canonicalError("REVIEW_MANUSCRIPT_FORMAL_SWITCH_FILE_REF_MISSING");
        }
        for (const file of [currentFile, defaultFile, targetFile]) {
          if (
            file.deletedAt ||
            file.ownerType !== "review" ||
            file.ownerId !== ownerId ||
            file.manuscriptChannel !== "primary" ||
            file.resourceKind !== "file" ||
            file.fileRole !== "manuscript" ||
            file.fileType !== "markdown"
          ) {
            return canonicalError("REVIEW_MANUSCRIPT_FORMAL_SWITCH_FILE_REF_INVALID");
          }
        }
        const currentSession = exactSession(
          runtimeInput.currentSessionHandle,
          ownerId,
          "current",
          currentFile.id
        );
        const targetSession = exactSession(
          runtimeInput.targetSessionHandle,
          ownerId,
          "independent",
          targetFile.id
        );
        const candidate = targetCandidate(reviewType, targetSession.baseline!.rawText);
        if (!candidate.ok) return canonicalError(candidate.error.code);
        return {
          ownerType: "review",
          ownerSubtype: reviewType,
          ownerId,
          channel: "primary",
          bindingId: binding.id,
          currentFileRefId: currentFile.id,
          defaultFileRefId: defaultFile.id,
          targetFileRefId: targetFile.id,
          currentFileName: getSafeManuscriptBasename(currentFile.path) || "current.md",
          defaultFileName: getSafeManuscriptBasename(defaultFile.path) || "default.md",
          targetFileName: getSafeManuscriptBasename(targetFile.path) || "target.md",
          targetLocationMode: targetFile.locationMode,
          currentRevision: currentSession.baseline!.revision,
          targetRevision: targetSession.baseline!.revision,
          currentRawText: currentSession.baseline!.rawText,
          targetRawText: targetSession.baseline!.rawText,
          replacements: candidate.orderedReplacementDto.orderedReplacements,
          diagnostics: candidate.orderedReplacementDto.diagnostics,
          binding,
          currentFile,
          defaultFile,
          targetFile,
          currentSession,
          targetSession,
          currentSessionHandle: runtimeInput.currentSessionHandle,
          targetSessionHandle: runtimeInput.targetSessionHandle,
          currentRuntimeConsumerId:
            currentSession.consumerHandle ?? runtimeInput.currentSessionHandle,
          targetRuntimeConsumerId:
            targetSession.consumerHandle ?? runtimeInput.targetSessionHandle,
          structuredState: state,
          structuredIdentity: structuredIdentity(state)
        };
      } catch (error) {
        return canonicalError(
          error instanceof Error
            ? error.message
            : "REVIEW_MANUSCRIPT_FORMAL_SWITCH_PREFLIGHT_FAILED"
        );
      }
    },
    isSnapshot(value): value is ReviewFormalSwitchSnapshot {
      const snapshot = value as Partial<ReviewFormalSwitchSnapshot>;
      return snapshot.ownerType === "review" &&
        snapshot.ownerSubtype === reviewType &&
        snapshot.channel === "primary";
    },
    ready(snapshot, preflightToken, operationId, expiresAt) {
      return {
        status: "ready",
        preflightToken,
        operationId,
        expiresAt,
        diagnostics: snapshot.diagnostics
      };
    },
    async revalidateIdentityAndRevision(snapshot) {
      const [binding, currentFile, defaultFile, targetFile, state] =
        await Promise.all([
          manuscriptBindingService.getBindingByOwner("review", snapshot.ownerId, "primary"),
          fileRefService.getById(snapshot.currentFileRefId),
          fileRefService.getById(snapshot.defaultFileRefId),
          fileRefService.getById(snapshot.targetFileRefId),
          readStructuredState(snapshot.ownerId)
        ]);
      if (
        state.reviewType !== reviewType ||
        state.lifecycleStatus !== "active" ||
        structuredIdentity(state) !== snapshot.structuredIdentity
      ) {
        throw new Error("REVIEW_MANUSCRIPT_FORMAL_SWITCH_STRUCTURED_STATE_CHANGED");
      }
      if (
        !binding ||
        binding.deletedAt ||
        binding.id !== snapshot.bindingId ||
        binding.currentFileRefId !== snapshot.currentFileRefId ||
        binding.defaultManuscriptFileRefId !== snapshot.defaultFileRefId ||
        binding.manuscriptChannel !== "primary"
      ) {
        throw new Error("REVIEW_MANUSCRIPT_FORMAL_SWITCH_BINDING_CHANGED");
      }
      if (
        !sameFile(snapshot.currentFile, currentFile) ||
        !sameFile(snapshot.defaultFile, defaultFile) ||
        !sameFile(snapshot.targetFile, targetFile)
      ) {
        throw new Error("REVIEW_MANUSCRIPT_FORMAL_SWITCH_FILE_IDENTITY_CHANGED");
      }
      const [currentReload, targetReload] = await Promise.all([
        reviewRawManuscriptService.reload(snapshot.currentSessionHandle),
        reviewRawManuscriptService.reload(snapshot.targetSessionHandle)
      ]);
      if (
        !["success", "no-op"].includes(currentReload.status) ||
        !["success", "no-op"].includes(targetReload.status)
      ) {
        throw new Error("REVIEW_MANUSCRIPT_FORMAL_SWITCH_RUNTIME_REFRESH_FAILED");
      }
      const currentSession = exactSession(
        snapshot.currentSessionHandle,
        snapshot.ownerId,
        "current",
        snapshot.currentFileRefId
      );
      const targetSession = exactSession(
        snapshot.targetSessionHandle,
        snapshot.ownerId,
        "independent",
        snapshot.targetFileRefId
      );
      if (
        currentSession.baseline!.revision !== snapshot.currentRevision ||
        targetSession.baseline!.revision !== snapshot.targetRevision
      ) {
        throw new Error("REVIEW_MANUSCRIPT_FORMAL_SWITCH_PHYSICAL_REVISION_CHANGED");
      }
      const candidate = targetCandidate(reviewType, targetSession.baseline!.rawText);
      if (!candidate.ok) throw new Error(candidate.error.code);
      if (
        hashText(JSON.stringify(candidate.orderedReplacementDto.orderedReplacements)) !==
        hashText(JSON.stringify(snapshot.replacements))
      ) {
        throw new Error("REVIEW_MANUSCRIPT_FORMAL_SWITCH_REPLACEMENT_CHANGED");
      }
      return {
        ...snapshot,
        binding,
        currentFile: currentFile!,
        defaultFile: defaultFile!,
        targetFile: targetFile!,
        currentSession,
        targetSession,
        currentRawText: currentSession.baseline!.rawText,
        targetRawText: targetSession.baseline!.rawText,
        structuredState: state
      };
    },
    isRevalidatedSnapshot(value): value is ReviewFormalSwitchSnapshot {
      const snapshot = value as Partial<ReviewFormalSwitchSnapshot>;
      return snapshot.ownerType === "review" &&
        snapshot.ownerSubtype === reviewType &&
        snapshot.channel === "primary";
    },
    async buildPreparedEvidence(snapshot, operationId, occurredAt) {
      const expectedPost = canonicalOldCurrentPost(snapshot);
      const evidence: FormalSwitchRecoveryEvidence = {
        operationId,
        ownerType: "review",
        ownerId: snapshot.ownerId,
        channel: "primary",
        phase: "prepared",
        oldCurrentFileRefId: snapshot.currentFileRefId,
        defaultFileRefId: snapshot.defaultFileRefId,
        targetFileRefId: snapshot.targetFileRefId,
        oldCurrentFileName: snapshot.currentFileName,
        defaultFileName: snapshot.defaultFileName,
        targetFileName: snapshot.targetFileName,
        oldCurrentPreRevision: snapshot.currentRevision,
        oldCurrentPreDigest: hashText(snapshot.currentRawText),
        oldCurrentExpectedPostDigest: hashText(expectedPost),
        targetRevision: snapshot.targetRevision,
        targetDigest: hashText(snapshot.targetRawText),
        prepareInput: Object.freeze({
          operationId,
          ownerType: "review",
          ownerSubtype: reviewType,
          ownerId: snapshot.ownerId,
          channel: "primary",
          occurredAt,
          structuredRevision: snapshot.structuredState.structuredRevision,
          descriptorIdentity: snapshot.structuredState.descriptorIdentity,
          lifecycleEvidence: snapshot.structuredState.lifecycleEvidence,
          replacementDigest: hashText(JSON.stringify(snapshot.replacements)),
          oldCurrentExpectedPostByteLength: byteLength(expectedPost),
          targetByteLength: byteLength(snapshot.targetRawText)
        })
      };
      return { evidence, expectedPost };
    },
    success(snapshot, operationId, sessionKey) {
      return {
        status: "success",
        operationId,
        sessionKey,
        warnings: (snapshot.diagnostics ?? []).map((diagnostic) => diagnostic.code)
      };
    },
    recoveryRequired(error) {
      return { status: "error", error };
    },
    error(error) {
      return { status: "error", error };
    },
    canceled(operationId) {
      return { status: "canceled", operationId };
    },
    publish(snapshot, operationId) {
      publishRefreshEvent({
        id: `review-manuscript-formal-switch-${operationId}`,
        keys: [
          "review.changed",
          "reviewContext.changed",
          "aiContext.changed",
          "fileRef.changed",
          "operationLog.changed"
        ],
        affectedEntities: [
          { type: "review", id: snapshot.ownerId, relation: "updated" },
          { type: "fileRef", id: snapshot.targetFileRefId, relation: "selected" }
        ],
        affectedScopes: [],
        source: "service.write",
        operation: "review.manuscript.formalSwitch",
        reason: "Review structured state and current Binding committed canonically.",
        writeFeedbackStatus: "success",
        createdAt: now()
      });
    },
    async recordPrePreparedFailure(details) {
      await createOperationLog({
        id: details.operationId,
        operationType: "custom",
        source: "user",
        module: "review",
        status: "error",
        riskLevel: "medium",
        target: { entityType: "review", entityId: details.ownerId },
        summary: "Review formal manuscript switch failed before recovery preparation",
        relatedEntities: [],
        errors: [
          `stage=${details.stage}`,
          `cause=${details.causeCode}`,
          `frontend=${details.provenance.frontendProvenance}`,
          `rust=${details.provenance.rustProvenance}`,
          `schema=${details.provenance.schemaProvenance}`
        ],
        isRecoverable: false,
        refreshKeys: ["operationLog.changed"]
      });
    }
  };
}

function createReviewReferenceOwnerProvider(
  reviewType: ReviewType
): ReferenceOwnerProductionProvider<ReviewFormalSwitchSnapshot> {
  return {
    buildBeginInput({ snapshot, evidence, expectedPost, operationId, occurredAt, replacements }) {
      return {
        ownerType: "review",
        ownerId: snapshot.ownerId,
        manuscriptChannel: "primary",
        ownerSubtype: reviewType,
        expectedStructuredRevision: snapshot.structuredState.structuredRevision,
        expectedDescriptorIdentity: snapshot.structuredState.descriptorIdentity,
        expectedLifecycleEvidence: snapshot.structuredState.lifecycleEvidence,
        operationId,
        occurredAt,
        occurredAtEpochMs: Date.parse(occurredAt),
        oldCurrentFileRefId: snapshot.currentFileRefId,
        defaultFileRefId: snapshot.defaultFileRefId,
        targetFileRefId: snapshot.targetFileRefId,
        oldCurrentPhysicalRevision: snapshot.currentRevision,
        targetPhysicalRevision: snapshot.targetRevision,
        expectedOldCurrentPostText: expectedPost,
        replacements: replacements.map((item) => ({
          stableKey: item.stableKey,
          ...(item.action === "set" ? { value: item.value } : {})
        })),
        previewSnapshotIdentity: [
          operationId,
          "review",
          reviewType,
          snapshot.ownerId,
          snapshot.currentRevision,
          snapshot.targetRevision,
          snapshot.structuredState.structuredRevision,
          snapshot.structuredState.descriptorIdentity,
          snapshot.structuredState.lifecycleEvidence,
          evidence.oldCurrentExpectedPostDigest,
          hashText(JSON.stringify(snapshot.replacements))
        ].join(":"),
        currentRuntime: {
          actualRuntimeHandle: snapshot.currentSessionHandle,
          runtimeGeneration: snapshot.currentSession.sessionGeneration,
          runtimeConsumerId: snapshot.currentRuntimeConsumerId,
          logicalIdentity: `review:${snapshot.ownerId}:primary:current:${snapshot.currentFileRefId}`,
          fileRefId: snapshot.currentFileRefId
        },
        targetRuntime: {
          actualRuntimeHandle: snapshot.targetSessionHandle,
          runtimeGeneration: snapshot.targetSession.sessionGeneration,
          runtimeConsumerId: snapshot.targetRuntimeConsumerId,
          logicalIdentity: `review:${snapshot.ownerId}:primary:independent:${snapshot.targetFileRefId}`,
          fileRefId: snapshot.targetFileRefId
        }
      };
    },
    activate(snapshot) {
      return activateCurrent(snapshot.ownerId, snapshot.targetFileRefId);
    },
    activateRecovered(ticket) {
      if (
        ticket.ownerType !== "review" ||
        ticket.ownerSubtype !== reviewType ||
        ticket.manuscriptChannel !== "primary"
      ) {
        throw new Error("REVIEW_MANUSCRIPT_FORMAL_SWITCH_RECOVERY_IDENTITY_MISMATCH");
      }
      return activateCurrent(ticket.ownerId, ticket.targetFileRefId);
    },
    readActivatedRuntime({ sessionKey, ticket }) {
      const session = reviewRawManuscriptService.getSession(sessionKey);
      if (!session?.baseline || session.file.kind !== "durable") return undefined;
      return {
        actualRuntimeHandle: sessionKey,
        runtimeGeneration: session.sessionGeneration,
        runtimeConsumerId: session.consumerHandle ?? sessionKey,
        logicalIdentity: ticket.activationLogicalIdentity,
        fileRefId: session.file.fileRefId,
        authoritativePhysicalRevision: session.baseline.revision,
        authoritativeRawByteLength: byteLength(session.baseline.rawText),
        exactActive:
          ticket.ownerType === "review" &&
          ticket.ownerSubtype === reviewType &&
          ticket.manuscriptChannel === "primary" &&
          session.owner.ownerType === "review" &&
          session.owner.ownerId === ticket.ownerId &&
          session.owner.channel === "primary" &&
          session.windowRole === "current" &&
          session.file.fileRefId === ticket.targetFileRefId
      };
    }
  };
}

function createReviewCanonicalBridge(reviewType: ReviewType) {
  return createReferenceOwnerFormalSwitchProductionBridge({
    adapter: createReviewFormalSwitchAdapter(reviewType),
    provider: createReviewReferenceOwnerProvider(reviewType),
    manuscriptChannel: "primary",
    ownerSubtype: reviewType
  });
}

export function createReviewManuscriptFormalSwitchService(reviewId: EntityId) {
  async function bridgeForCurrentSubtype() {
    const state = await readStructuredState(reviewId);
    return {
      state,
      bridge: createReviewCanonicalBridge(state.reviewType)
    };
  }

  async function cleanupTarget(handle: SharedManuscriptSessionHandle) {
    if (!reviewRawManuscriptService.getSession(handle)) return;
    await reviewRawManuscriptService.close(handle, "discard");
  }

  return Object.freeze({
    ownerType: "review" as const,
    ownerId: reviewId,
    manuscriptChannel: "primary" as const,
    async getContextInsert() {
      const structured = await reviewManuscriptStructuredDataService.get(reviewId);
      if (structured.status === "error") throw new Error(structured.error.message);
      return reviewManuscriptAdapterService.formatContextInsert(structured.dto);
    },
    async getAvailable(): Promise<AvailableManuscriptItem[]> {
      const result = await manuscriptListService.getAvailableManuscripts(
        "review",
        reviewId,
        "primary"
      );
      return result.status === "success" ? result.items : [];
    },
    getPageState: () => reviewManuscriptPageStateService.get(reviewId),
    selectManuscript(requestToken: number, title: string) {
      return reviewManuscriptSelectionService.selectManuscript(
        reviewId,
        requestToken,
        title
      );
    },
    ensureSelectedManuscript: reviewManuscriptSelectionService.ensureSelectedManuscript,
    async setCurrent(input: {
      currentSessionHandle: SharedManuscriptSessionHandle;
      targetFileRefId: EntityId;
    }): Promise<ReviewCanonicalConfirm> {
      let targetHandle: SharedManuscriptSessionHandle | undefined;
      try {
        const { bridge } = await bridgeForCurrentSubtype();
        const pending = await bridge.listRecoveries(reviewId);
        if (pending.length > 0) {
          return bridge.continueRecovery(pending[0].operationId, reviewId);
        }
        const openedTarget = await reviewRawManuscriptService.openIndependent(
          reviewId,
          input.targetFileRefId,
          `review-formal-switch-target:${reviewId}:${createId("request")}`
        );
        if (openedTarget.status !== "success" || !("sessionKey" in openedTarget)) {
          return canonicalError("REVIEW_MANUSCRIPT_FORMAL_SWITCH_TARGET_OPEN_FAILED");
        }
        targetHandle = openedTarget.sessionKey;
        const runtimeInput: ReviewPreflightRuntimeInput = {
          currentSessionHandle: input.currentSessionHandle,
          targetSessionHandle: targetHandle,
          targetFileRefId: input.targetFileRefId
        };
        const preflight = await bridge.preflight(reviewId, JSON.stringify(runtimeInput));
        if (preflight.status !== "ready") {
          await cleanupTarget(targetHandle);
          return preflight;
        }
        let confirmed = await bridge.confirm(preflight.preflightToken);
        if (confirmed.status === "error" && confirmed.error.recoveryRequired) {
          confirmed = await bridge.continueRecovery(confirmed.error.operationId, reviewId);
        }
        if (confirmed.status !== "success") await cleanupTarget(targetHandle);
        return confirmed;
      } catch (error) {
        if (targetHandle) await cleanupTarget(targetHandle).catch(() => undefined);
        return canonicalError(
          error instanceof Error
            ? error.message
            : "REVIEW_MANUSCRIPT_FORMAL_SWITCH_FAILED"
        );
      }
    },
    async repairCurrent(_targetFileRefId: EntityId): Promise<ReviewCanonicalConfirm> {
      return canonicalError(
        "REVIEW_MANUSCRIPT_CURRENT_REPAIR_REQUIRES_SEPARATE_AUTHORITY"
      );
    },
    async listRecoveries() {
      const { bridge } = await bridgeForCurrentSubtype();
      return bridge.listRecoveries(reviewId);
    },
    async continueRecovery(operationId: string) {
      const { bridge } = await bridgeForCurrentSubtype();
      return bridge.continueRecovery(operationId, reviewId);
    },
    async safeCancelRecovery(operationId: string) {
      const { bridge } = await bridgeForCurrentSubtype();
      return bridge.safeCancel(operationId, reviewId);
    },
    dispose() {}
  });
}

export type ReviewManuscriptFormalSwitchService = ReturnType<
  typeof createReviewManuscriptFormalSwitchService
>;
