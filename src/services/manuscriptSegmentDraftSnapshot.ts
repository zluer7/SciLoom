import type {
  ManuscriptSegmentDraftSnapshot,
  ManuscriptSegmentProjectionSessionState
} from "../types/manuscriptSegmentProjection";
import type { SharedManuscriptSession } from "../types/sharedManuscriptSession";

async function sha256(value: string) {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function createToken() {
  return globalThis.crypto?.randomUUID?.() ??
    `segment-draft-snapshot-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Preview and Save As consume the exact current Session Raw draft. Structured
 * parsing and Archive identity are deliberately outside this ordinary path.
 */
export async function buildManuscriptSegmentDraftSnapshot(input: Readonly<{
  state: ManuscriptSegmentProjectionSessionState;
  session: SharedManuscriptSession;
}>): Promise<ManuscriptSegmentDraftSnapshot> {
  const { state, session } = input;
  if (
    state.projection.classification !== "PROJECTABLE" ||
    state.sessionKey !== session.sessionKey ||
    state.sessionGeneration !== session.sessionGeneration ||
    state.projectionGeneration !== state.projection.baselineIdentity.projectionGeneration ||
    state.projection.baselineIdentity.fileRefId !== session.logicalIdentity.fileRefId ||
    session.owner.ownerType !== state.projection.baselineIdentity.ownerType ||
    session.owner.ownerId !== state.projection.baselineIdentity.ownerId ||
    session.owner.channel !== state.projection.baselineIdentity.channel ||
    !session.baseline
  ) {
    throw new Error("MANUSCRIPT_SEGMENT_DRAFT_SNAPSHOT_IDENTITY_INVALID");
  }
  const encoding = session.encoding ?? session.baseline.encoding;
  if (encoding !== state.projection.baselineIdentity.encoding) {
    throw new Error("MANUSCRIPT_SEGMENT_DRAFT_SNAPSHOT_ENCODING_INVALID");
  }
  const mergedRawText = session.draftRawText;
  const byteLength = new TextEncoder().encode(mergedRawText).byteLength;
  return Object.freeze({
    snapshotToken: createToken(),
    runtimeHandle: state.runtimeHandle,
    ownerType: session.owner.ownerType,
    ownerId: session.owner.ownerId,
    channel: session.owner.channel,
    windowRole: session.windowRole,
    fileRefId: session.logicalIdentity.fileRefId,
    pathIdentityKey: session.file.pathIdentity,
    sessionKey: state.sessionKey,
    sessionGeneration: state.sessionGeneration,
    projectionGeneration: state.projectionGeneration,
    baselineRevisionEvidence: state.projection.baselineIdentity.baselineRevisionEvidence,
    baselinePhysicalIdentity: state.projection.baselineIdentity.baselinePhysicalIdentity,
    baselineRawFingerprint: state.projection.baselineIdentity.rawSliceHash,
    controlFingerprint: state.projection.baselineIdentity.controlFingerprint,
    mergedRawText,
    // HTML comments are passed through to the normal Markdown renderer. The
    // renderer may hide comments in Preview; Raw editing never hides them.
    markerFreePreviewMarkdown: mergedRawText,
    snapshotByteLength: byteLength,
    snapshotSha256: await sha256(mergedRawText),
    effectivePatchCount: state.dirty ? 1 : 0,
    encoding,
    newline: session.baseline.newline
  });
}
