import type {
  ManuscriptSegmentEditInputType,
  ManuscriptSegmentProjectionSessionState
} from "../types/manuscriptSegmentProjection";

export type ManuscriptContinuousEditorSelection = Readonly<{
  anchorTargetId: string;
  anchorOffset: number;
  focusTargetId: string;
  focusOffset: number;
}>;

export type ManuscriptContinuousEditorIntent =
  | ManuscriptSegmentEditInputType
  | "insertParagraph"
  | "insertLineBreak";

export type ManuscriptContinuousEditorOperation = Readonly<{
  targetId: string;
  expectedProjectionGeneration: number;
  nextText: string;
  inputType: ManuscriptSegmentEditInputType;
  compositionActive: false;
  selectionBefore: Readonly<{ start: number; end: number }>;
  caretAfter: number;
}>;

export type ManuscriptContinuousEditorOperationResult =
  | Readonly<{ status: "READY"; operation: ManuscriptContinuousEditorOperation }>
  | Readonly<{
      status: "REJECTED";
      reason:
        | "PROJECTION_NOT_WRITABLE"
        | "TARGET_NOT_FOUND"
        | "SELECTION_OUT_OF_RANGE"
        | "DISCONTIGUOUS_RAW_SELECTION"
        | "INPUT_NOT_SUPPORTED";
    }>;

function previousCodePointOffset(text: string, offset: number) {
  if (offset <= 0) return 0;
  const previous = text.charCodeAt(offset - 1);
  return previous >= 0xdc00 && previous <= 0xdfff && offset >= 2
    ? offset - 2
    : offset - 1;
}

function nextCodePointOffset(text: string, offset: number) {
  if (offset >= text.length) return text.length;
  const current = text.charCodeAt(offset);
  return current >= 0xd800 && current <= 0xdbff && offset + 1 < text.length
    ? offset + 2
    : offset + 1;
}

function normalizedInputType(intent: ManuscriptContinuousEditorIntent): ManuscriptSegmentEditInputType {
  if (intent === "insertParagraph" || intent === "insertLineBreak") return "insertText";
  return intent;
}

export function buildManuscriptContinuousEditorOperation(input: Readonly<{
  state: ManuscriptSegmentProjectionSessionState;
  selection: ManuscriptContinuousEditorSelection;
  intent: ManuscriptContinuousEditorIntent;
  data?: string | null;
}>): ManuscriptContinuousEditorOperationResult {
  const { state, selection, intent } = input;
  if (
    state.saveDisabled ||
    state.status === "STALE_DRAFT" ||
    state.status === "FAIL_CLOSED" ||
    state.status === "SAVE_COMMITTED_READBACK_UNCONFIRMED"
  ) {
    return Object.freeze({ status: "REJECTED", reason: "PROJECTION_NOT_WRITABLE" });
  }
  if (selection.anchorTargetId !== selection.focusTargetId) {
    return Object.freeze({ status: "REJECTED", reason: "DISCONTIGUOUS_RAW_SELECTION" });
  }
  const draft = state.regionDrafts.find((candidate) => candidate.targetId === selection.anchorTargetId);
  if (!draft) return Object.freeze({ status: "REJECTED", reason: "TARGET_NOT_FOUND" });
  const start = Math.min(selection.anchorOffset, selection.focusOffset);
  const end = Math.max(selection.anchorOffset, selection.focusOffset);
  if (start < 0 || end > draft.currentText.length) {
    return Object.freeze({ status: "REJECTED", reason: "SELECTION_OUT_OF_RANGE" });
  }

  let replaceStart = start;
  let replaceEnd = end;
  let replacement = input.data ?? "";
  switch (intent) {
    case "insertParagraph":
    case "insertLineBreak":
      replacement = "\n";
      break;
    case "insertText":
    case "insertFromPaste":
    case "insertFromDrop":
    case "insertCompositionText":
    case "replace":
      break;
    case "deleteContentBackward":
      replacement = "";
      if (start === end) replaceStart = previousCodePointOffset(draft.currentText, start);
      break;
    case "deleteContentForward":
      replacement = "";
      if (start === end) replaceEnd = nextCodePointOffset(draft.currentText, end);
      break;
    case "deleteByCut":
      replacement = "";
      break;
    case "historyUndo":
    case "historyRedo":
      return Object.freeze({ status: "REJECTED", reason: "INPUT_NOT_SUPPORTED" });
    default:
      return Object.freeze({ status: "REJECTED", reason: "INPUT_NOT_SUPPORTED" });
  }

  const nextText = `${draft.currentText.slice(0, replaceStart)}${replacement}${draft.currentText.slice(replaceEnd)}`;
  return Object.freeze({
    status: "READY",
    operation: Object.freeze({
      targetId: draft.targetId,
      expectedProjectionGeneration: state.projectionGeneration,
      nextText,
      inputType: normalizedInputType(intent),
      compositionActive: false,
      selectionBefore: Object.freeze({ start, end }),
      caretAfter: replaceStart + replacement.length
    })
  });
}
