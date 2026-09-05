import type { FileRefOwnerType } from "../types/experiment";
import type { OwnerIdentity } from "../types/manuscriptOperation";
import type {
  FrozenSaveAsSourceEvidence,
  SaveAsOwnerDescriptor,
  SaveAsOutcome
} from "../types/manuscriptSaveAs";
import { sharedManuscriptSessionRuntime } from "./sharedManuscriptSessionComposition";
import type { ManuscriptSegmentDraftSnapshot } from "../types/manuscriptSegmentProjection";
import {
  createPhysicalRawBytesFromSnapshot,
  manuscriptSegmentFingerprint
} from "./manuscriptSegmentProjectionService";

interface SaveAsSourceRead {
  owner: OwnerIdentity;
  windowRole: "current" | "independent";
  sourceRuntimeHandle: string;
  sourceSessionKey: string;
  sourceSessionGeneration: number;
  sourceFileRefId: string;
  sourcePathIdentityKey: string;
  sourceRevision: string;
  frozenDraftRevision: number;
  frozenBaselineRevision: string;
  frozenBaselinePhysicalIdentity?: string;
  frozenDirty: boolean;
  rawText: string;
  encoding: "utf-8" | "utf-8-bom";
  newline: "lf" | "crlf" | "mixed" | "none";
  fileKind: "durable" | "ephemeral";
  accessMode: "writable" | "read-only";
  stale: boolean;
  recoveryRequired: boolean;
}

interface SaveAsSourceSessionAuthority {
  readSaveAsSourceSnapshot(handle: string): SaveAsSourceRead | undefined;
  validateSaveAsSourceIdentity(input: {
    sourceRuntimeHandle: string;
    owner: OwnerIdentity;
    sourceWindowRole: "current" | "independent";
    sourceSessionKey: string;
    sourceSessionGeneration: number;
    sourceFileRefId: string;
    sourcePathIdentityKey: string;
  }): boolean;
}

export interface ManuscriptSaveAsSourceSnapshotDependencies {
  sessions: SaveAsSourceSessionAuthority;
  createSnapshotId?: () => string;
}

export interface FreezeSaveAsSourceInput {
  owner: {
    ownerType: FileRefOwnerType;
    ownerId: string;
    channel: SaveAsOwnerDescriptor["channel"];
  };
  sourceWindowRole: "current" | "independent";
  sourceRuntimeHandle: string;
  frozenDraftSnapshot?: ManuscriptSegmentDraftSnapshot;
  /** Canonical caller-owned idempotency key; when present it becomes the LP12 operation identity. */
  operationRequestKey?: string;
}

function failed(): SaveAsOutcome<never> {
  return {
    ok: false,
    failure: {
      code: "SAVE_AS_SOURCE_SNAPSHOT_INVALID",
      stage: "pre_d1_closed",
      continuation: "start_new_operation",
      writeApplied: false
    }
  };
}

function sameOwner(left: OwnerIdentity, right: OwnerIdentity) {
  return (
    left.ownerType === right.ownerType &&
    left.ownerId === right.ownerId &&
    left.channel === right.channel
  );
}

export async function sha256SaveAsRaw(value: string) {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

export function createManuscriptSaveAsSourceSnapshot(
  dependencies: ManuscriptSaveAsSourceSnapshotDependencies
) {
  const createSnapshotId =
    dependencies.createSnapshotId ??
    (() => globalThis.crypto.randomUUID());

  async function freeze(
    input: FreezeSaveAsSourceInput
  ): Promise<SaveAsOutcome<FrozenSaveAsSourceEvidence>> {
    // This synchronous read is intentionally the first operation boundary:
    // the Raw string is copied before hashing, owner I/O, picker, or target I/O.
    const source = dependencies.sessions.readSaveAsSourceSnapshot(
      input.sourceRuntimeHandle
    );
    const snapshotId = input.operationRequestKey ?? createSnapshotId();
    const draft = input.frozenDraftSnapshot;
    if (
      !source ||
      !snapshotId.trim() || snapshotId !== snapshotId.trim() ||
      Array.from(snapshotId).length > 200 || /[\0-\x1F\x7F]/u.test(snapshotId) ||
      !sameOwner(source.owner, input.owner) ||
      source.windowRole !== input.sourceWindowRole ||
      source.sourceRuntimeHandle !== input.sourceRuntimeHandle ||
      source.fileKind !== "durable" ||
      source.accessMode !== "writable" ||
      source.stale ||
      source.recoveryRequired ||
      !source.sourceSessionKey.trim() ||
      source.sourceSessionGeneration < 0 ||
      !source.sourceFileRefId.trim() ||
      !source.sourcePathIdentityKey.trim() ||
      !source.sourceRevision.trim() ||
      source.frozenDraftRevision < 0
      || (draft !== undefined && (
        draft.runtimeHandle !== input.sourceRuntimeHandle ||
        draft.ownerType !== input.owner.ownerType ||
        draft.ownerId !== input.owner.ownerId ||
        draft.channel !== input.owner.channel ||
        draft.windowRole !== input.sourceWindowRole ||
        draft.sessionKey !== source.sourceSessionKey ||
        draft.sessionGeneration !== source.sourceSessionGeneration ||
        draft.fileRefId !== source.sourceFileRefId ||
        draft.pathIdentityKey !== source.sourcePathIdentityKey ||
        draft.baselineRevisionEvidence !== source.frozenBaselineRevision ||
        draft.baselinePhysicalIdentity !== source.frozenBaselinePhysicalIdentity ||
        draft.encoding !== source.encoding ||
        draft.snapshotByteLength !== new TextEncoder().encode(draft.mergedRawText).byteLength ||
        draft.effectivePatchCount < 0
      ))
    ) {
      return failed();
    }
    if (
      draft &&
      draft.baselineRawFingerprint !== manuscriptSegmentFingerprint(
        createPhysicalRawBytesFromSnapshot({
          rawText: source.rawText,
          encoding: source.encoding
        })
      )
    ) {
      return failed();
    }

    const frozenRawText = `${draft?.mergedRawText ?? source.rawText}`;
    const frozenSha256 = await sha256SaveAsRaw(frozenRawText);
    if (draft && frozenSha256 !== draft.snapshotSha256) return failed();
    const owner = Object.freeze({
      ownerType: input.owner.ownerType,
      ownerId: input.owner.ownerId,
      channel: input.owner.channel,
      sourceWindowRole: input.sourceWindowRole
    });
    const evidence: FrozenSaveAsSourceEvidence = Object.freeze({
      snapshotId,
      operationId: snapshotId,
      operationGeneration: 1,
      owner,
      sourceRuntimeHandle: input.sourceRuntimeHandle,
      sourceSessionKey: source.sourceSessionKey,
      stableSessionInstanceId:
        `${source.sourceSessionKey}@${source.sourceSessionGeneration}`,
      sourceFileRefId: source.sourceFileRefId,
      sourcePathIdentityKey: source.sourcePathIdentityKey,
      sourceRevision: source.sourceRevision,
      sourceRuntimeGeneration: source.sourceSessionGeneration,
      frozenDraftRevision: source.frozenDraftRevision,
      frozenBaselineRevision: source.frozenBaselineRevision,
      frozenBaselinePhysicalIdentity:
        source.frozenBaselinePhysicalIdentity,
      frozenDirty: draft ? draft.effectivePatchCount > 0 : source.frozenDirty,
      frozenRawText,
      snapshotSha256: frozenSha256,
      snapshotByteLength:
        new TextEncoder().encode(frozenRawText).byteLength,
      encodingContractVersion: "utf-8-v1",
      newlineContractVersion: `${source.newline}-v1`
    });
    return { ok: true, continuation: "close", value: evidence };
  }

  function validateStableIdentity(
    evidence: FrozenSaveAsSourceEvidence
  ) {
    return dependencies.sessions.validateSaveAsSourceIdentity({
      sourceRuntimeHandle: evidence.sourceRuntimeHandle,
      owner: evidence.owner,
      sourceWindowRole: evidence.owner.sourceWindowRole,
      sourceSessionKey: evidence.sourceSessionKey,
      sourceSessionGeneration: evidence.sourceRuntimeGeneration,
      sourceFileRefId: evidence.sourceFileRefId,
      sourcePathIdentityKey: evidence.sourcePathIdentityKey
    });
  }

  return Object.freeze({ freeze, validateStableIdentity });
}

export const manuscriptSaveAsSourceSnapshot =
  createManuscriptSaveAsSourceSnapshot({
    sessions: sharedManuscriptSessionRuntime
  });
