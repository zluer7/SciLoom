import type {
  ManuscriptSegmentEditInputType,
  ManuscriptSegmentProjectionSessionState
} from "../types/manuscriptSegmentProjection";
import { resolveStructuredOutlineArchiveIdentity } from "./manuscriptStructuredOutlineArchive";

export type ManuscriptSegmentFocusedTarget = Readonly<{
  targetId: string;
  projectionGeneration: number;
  selectionStart: number;
  selectionEnd: number;
}>;

export type ManuscriptSegmentInsertionResult =
  | Readonly<{
      status: "SUCCESS_DIRTY";
      targetId: string;
      insertionStart: number;
      caretAfter: number;
    }>
  | Readonly<{
      status:
        | "FAILURE_RAW_DRAFT_MISSING"
        | "FAILURE_CONTROL_LINE_REJECTED"
        | "FAILURE_STALE_PROJECTION"
        | "FAILURE_EXPECTED";
      reason: string;
    }>;

const encoder = new TextEncoder();

function utf16OffsetAtUtf8Byte(rawText: string, requestedByte: number) {
  let byteOffset = 0;
  let utf16Offset = 0;
  while (utf16Offset < rawText.length && byteOffset < requestedByte) {
    const codePoint = rawText.codePointAt(utf16Offset);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    byteOffset += encoder.encode(character).length;
    utf16Offset += character.length;
  }
  if (byteOffset !== requestedByte) {
    throw new Error("RAW_BODY_INSERTION_BYTE_BOUNDARY_INVALID");
  }
  return utf16Offset;
}

function withReadableSeparation(
  current: string,
  start: number,
  end: number,
  inserted: string
) {
  let value = inserted;
  if (start > 0 && !/\r?\n$/u.test(current.slice(0, start)) && !/^\r?\n/u.test(value)) {
    value = `\n\n${value}`;
  }
  if (end < current.length && !/\r?\n$/u.test(value) && !/^\r?\n/u.test(current.slice(end))) {
    value = `${value}\n\n`;
  }
  return Object.freeze({
    nextText: `${current.slice(0, start)}${value}${current.slice(end)}`,
    insertionStart: start,
    caretAfter: start + value.length
  });
}

/**
 * Shared explicit insertion is BODY-only. It never searches stable keys or a
 * protected/safe target. With a unique EOF Archive, an absent or Archive-local
 * selection inserts immediately before the BEGIN line so the Archive remains
 * separate and its interior is never an automatic write target.
 */
export function executeManuscriptSegmentExplicitInsertion(input: Readonly<{
  state: ManuscriptSegmentProjectionSessionState;
  markdown: string;
  focusedTarget?: ManuscriptSegmentFocusedTarget;
  explicitTargetId?: string;
  inputType?: ManuscriptSegmentEditInputType;
  applyNextText(request: Readonly<{
    targetId: string;
    expectedProjectionGeneration: number;
    nextText: string;
    inputType: ManuscriptSegmentEditInputType;
    compositionActive: false;
  }>): Readonly<{ accepted: boolean; reason?: string }>;
}>): ManuscriptSegmentInsertionResult {
  if (
    input.state.projection.classification !== "PROJECTABLE" ||
    input.state.saveDisabled
  ) {
    return Object.freeze({ status: "FAILURE_EXPECTED", reason: "RAW_DRAFT_NOT_WRITABLE" });
  }
  if (!input.markdown) {
    return Object.freeze({ status: "FAILURE_EXPECTED", reason: "INSERTION_SOURCE_EMPTY" });
  }
  // Exact V1 marker lines are reserved protocol controls. Legacy markers and
  // all other structured-looking Markdown are ordinary BODY and are accepted.
  const insertedIdentity = resolveStructuredOutlineArchiveIdentity(
    encoder.encode(input.markdown)
  );
  if (insertedIdentity.exactMarkerLines.length > 0) {
    return Object.freeze({
      status: "FAILURE_CONTROL_LINE_REJECTED",
      reason: "ARCHIVE_PROTOCOL_CONTROL_LINE_REJECTED"
    });
  }
  const draft = input.state.regionDrafts[0];
  if (!draft) {
    return Object.freeze({ status: "FAILURE_RAW_DRAFT_MISSING", reason: "RAW_DRAFT_MISSING" });
  }
  if (input.explicitTargetId && input.explicitTargetId !== draft.targetId) {
    return Object.freeze({ status: "FAILURE_STALE_PROJECTION", reason: "TARGET_NOT_CURRENT" });
  }

  let start = draft.currentText.length;
  let end = start;
  const focused = input.focusedTarget;
  if (focused) {
    if (
      focused.projectionGeneration !== input.state.projectionGeneration ||
      focused.targetId !== draft.targetId ||
      focused.selectionStart < 0 ||
      focused.selectionEnd < focused.selectionStart ||
      focused.selectionEnd > draft.currentText.length
    ) {
      return Object.freeze({ status: "FAILURE_STALE_PROJECTION", reason: "TARGET_SELECTION_STALE" });
    }
    start = focused.selectionStart;
    end = focused.selectionEnd;
  }

  const identity = resolveStructuredOutlineArchiveIdentity(
    encoder.encode(draft.currentText)
  );
  if (identity.terminal === "UNIQUE" && identity.pair) {
    const archiveStart = utf16OffsetAtUtf8Byte(
      draft.currentText,
      identity.pair.archiveBlockStartByte
    );
    const archiveEnd = utf16OffsetAtUtf8Byte(
      draft.currentText,
      identity.pair.archiveBlockEndByte
    );
    const noFocusedBodyTarget = !focused;
    const caretInsideArchive = start === end && start >= archiveStart && start < archiveEnd;
    const selectionTouchesArchive = start !== end && start < archiveEnd && end > archiveStart;
    if (noFocusedBodyTarget || caretInsideArchive || selectionTouchesArchive) {
      start = archiveStart;
      end = archiveStart;
    }
  }

  const insertion = withReadableSeparation(
    draft.currentText,
    start,
    end,
    input.markdown
  );
  const applied = input.applyNextText({
    targetId: draft.targetId,
    expectedProjectionGeneration: input.state.projectionGeneration,
    nextText: insertion.nextText,
    inputType: input.inputType ?? "insertText",
    compositionActive: false
  });
  return applied.accepted
    ? Object.freeze({
        status: "SUCCESS_DIRTY",
        targetId: draft.targetId,
        insertionStart: insertion.insertionStart,
        caretAfter: insertion.caretAfter
      })
    : Object.freeze({
        status: applied.reason === "STALE_PROJECTION_GENERATION"
          ? "FAILURE_STALE_PROJECTION"
          : "FAILURE_EXPECTED",
        reason: applied.reason ?? "INSERTION_REJECTED"
      });
}
