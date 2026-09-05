import type { ManuscriptOutlineDescriptorLookupIdentity } from "./manuscriptOutlineParser";
import type { ManuscriptSegmentEntryKind } from "./manuscriptSegmentProductCapability";
import type { ManuscriptSegmentFocusedTarget } from "./manuscriptSegmentExplicitInsertion";
import type { ManuscriptSegmentProjectionSessionState } from "../types/manuscriptSegmentProjection";
import type { SharedManuscriptSession } from "../types/sharedManuscriptSession";

export type ManuscriptTemplateInsertionTarget = Readonly<{
  ownerType: string;
  ownerId: string;
  channel: string;
  entryKind: "current";
  fileRefId: string;
  pathIdentityKey: string;
  projectionGeneration: number;
  targetId: string;
  selectionStart: number;
  selectionEnd: number;
  baselineFingerprint: string;
  capturedAtOperationId: string;
}>;

export type ManuscriptTemplateTargetValidation =
  | Readonly<{ valid: true; focusedTarget: ManuscriptSegmentFocusedTarget }>
  | Readonly<{
      valid: false;
      reason:
        | "CURRENT_ENTRY_REQUIRED"
        | "PROJECTABLE_SOURCE_REQUIRED"
        | "SESSION_IDENTITY_MISMATCH"
        | "FOCUSED_TARGET_REQUIRED"
        | "PROJECTION_GENERATION_CHANGED"
        | "TARGET_REGION_CHANGED"
        | "TARGET_SELECTION_CHANGED"
        | "BASELINE_CHANGED";
    }>;

function operationId() {
  return globalThis.crypto?.randomUUID?.() ??
    `template-target-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function currentFileRefId(session: SharedManuscriptSession) {
  return session.logicalIdentity.fileRefId;
}

function validateFocusedTarget(
  state: ManuscriptSegmentProjectionSessionState,
  focusedTarget: ManuscriptSegmentFocusedTarget
): ManuscriptTemplateTargetValidation {
  if (focusedTarget.projectionGeneration !== state.projectionGeneration) {
    return Object.freeze({ valid: false, reason: "PROJECTION_GENERATION_CHANGED" });
  }
  const draft = state.regionDrafts.find((candidate) => candidate.targetId === focusedTarget.targetId);
  if (!draft) return Object.freeze({ valid: false, reason: "TARGET_REGION_CHANGED" });
  if (
    focusedTarget.selectionStart < 0 ||
    focusedTarget.selectionEnd < focusedTarget.selectionStart ||
    focusedTarget.selectionEnd > draft.currentText.length
  ) {
    return Object.freeze({ valid: false, reason: "TARGET_SELECTION_CHANGED" });
  }
  return Object.freeze({ valid: true, focusedTarget });
}

export function captureManuscriptTemplateInsertionTarget(input: Readonly<{
  state: ManuscriptSegmentProjectionSessionState;
  session: SharedManuscriptSession;
  descriptorLookupIdentity: ManuscriptOutlineDescriptorLookupIdentity;
  entryKind: ManuscriptSegmentEntryKind;
  focusedTarget?: ManuscriptSegmentFocusedTarget;
  capturedAtOperationId?: string;
}>): ManuscriptTemplateInsertionTarget | undefined {
  const { state, session, descriptorLookupIdentity, entryKind, focusedTarget } = input;
  if (entryKind !== "current" || state.projection.classification !== "PROJECTABLE") return undefined;
  if (
    session.windowRole !== "current" ||
    session.owner.ownerType !== descriptorLookupIdentity.ownerType ||
    session.owner.channel !== descriptorLookupIdentity.channel ||
    state.sessionKey !== session.sessionKey ||
    state.sessionGeneration !== session.sessionGeneration ||
    state.projection.baselineIdentity.fileRefId !== currentFileRefId(session)
  ) return undefined;
  if (!focusedTarget || !validateFocusedTarget(state, focusedTarget).valid) return undefined;
  return Object.freeze({
    ownerType: session.owner.ownerType,
    ownerId: session.owner.ownerId,
    channel: session.owner.channel,
    entryKind: "current",
    fileRefId: currentFileRefId(session),
    pathIdentityKey: session.file.pathIdentity,
    projectionGeneration: state.projectionGeneration,
    targetId: focusedTarget.targetId,
    selectionStart: focusedTarget.selectionStart,
    selectionEnd: focusedTarget.selectionEnd,
    baselineFingerprint: state.projection.baselineIdentity.rawSliceHash,
    capturedAtOperationId: input.capturedAtOperationId ?? operationId()
  });
}

export function revalidateManuscriptTemplateInsertionTarget(input: Readonly<{
  target: ManuscriptTemplateInsertionTarget;
  state: ManuscriptSegmentProjectionSessionState;
  session: SharedManuscriptSession;
  descriptorLookupIdentity: ManuscriptOutlineDescriptorLookupIdentity;
  entryKind: ManuscriptSegmentEntryKind;
}>): ManuscriptTemplateTargetValidation {
  const { target, state, session, descriptorLookupIdentity, entryKind } = input;
  if (entryKind !== "current" || target.entryKind !== "current" || session.windowRole !== "current") {
    return Object.freeze({ valid: false, reason: "CURRENT_ENTRY_REQUIRED" });
  }
  if (state.projection.classification !== "PROJECTABLE") {
    return Object.freeze({ valid: false, reason: "PROJECTABLE_SOURCE_REQUIRED" });
  }
  if (
    target.ownerType !== descriptorLookupIdentity.ownerType ||
    target.channel !== descriptorLookupIdentity.channel ||
    target.ownerType !== session.owner.ownerType ||
    target.ownerId !== session.owner.ownerId ||
    target.channel !== session.owner.channel ||
    target.fileRefId !== currentFileRefId(session) ||
    target.pathIdentityKey !== session.file.pathIdentity ||
    state.sessionKey !== session.sessionKey ||
    state.sessionGeneration !== session.sessionGeneration
  ) {
    return Object.freeze({ valid: false, reason: "SESSION_IDENTITY_MISMATCH" });
  }
  if (target.projectionGeneration !== state.projectionGeneration) {
    return Object.freeze({ valid: false, reason: "PROJECTION_GENERATION_CHANGED" });
  }
  if (target.baselineFingerprint !== state.projection.baselineIdentity.rawSliceHash) {
    return Object.freeze({ valid: false, reason: "BASELINE_CHANGED" });
  }
  return validateFocusedTarget(state, {
    targetId: target.targetId,
    projectionGeneration: target.projectionGeneration,
    selectionStart: target.selectionStart,
    selectionEnd: target.selectionEnd
  });
}
