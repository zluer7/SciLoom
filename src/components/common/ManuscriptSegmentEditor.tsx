import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type CompositionEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent
} from "react";
import {
  MANUSCRIPT_SEGMENT_EDITOR_MODEL,
  type ManuscriptSegmentEditInputType,
  type ManuscriptSegmentProjectionSessionState
} from "../../types/manuscriptSegmentProjection";
import type { ManuscriptSegmentFocusedTarget } from "../../services/manuscriptSegmentExplicitInsertion";
import {
  buildManuscriptContinuousEditorOperation,
  type ManuscriptContinuousEditorIntent,
  type ManuscriptContinuousEditorOperation,
  type ManuscriptContinuousEditorSelection
} from "../../services/manuscriptContinuousEditorEventAdapter";

export interface ManuscriptSegmentEditorEditRequest {
  readonly targetId: string;
  readonly expectedProjectionGeneration: number;
  readonly nextText: string;
  readonly inputType: ManuscriptSegmentEditInputType;
  readonly compositionActive: false;
}

export interface ManuscriptSegmentEditorProps {
  readonly projectionState: ManuscriptSegmentProjectionSessionState;
  readonly onEdit: (
    request: ManuscriptSegmentEditorEditRequest
  ) =>
    | Readonly<{ accepted: boolean; reason?: string }>
    | Promise<Readonly<{ accepted: boolean; reason?: string }>>;
  readonly onRejectedEvent?: (reason: string) => void;
  readonly interactionDisabled?: boolean;
  readonly onFocusTarget?: (target: ManuscriptSegmentFocusedTarget) => void;
  readonly focusRestoreRequest?: Readonly<{
    requestId: string;
    target: ManuscriptSegmentFocusedTarget;
  }>;
  readonly labels?: Partial<Readonly<{
    projectionUnavailable: string;
    structuredOutline: string;
    startWriting: string;
    ariaLabel: string;
  }>>;
}

type LocalHistoryRecord = Readonly<{
  targetId: string;
  beforeText: string;
  afterText: string;
  beforeOffset: number;
  afterOffset: number;
}>;

function regionElementFromNode(root: HTMLElement, node: Node | null): HTMLElement | undefined {
  let current: Node | null = node;
  while (current && current !== root) {
    if (current instanceof HTMLElement && current.dataset.manuscriptEditableRegion === "true") {
      return current;
    }
    current = current.parentNode;
  }
  return undefined;
}

function offsetWithinRegion(region: HTMLElement, node: Node, offset: number) {
  const range = document.createRange();
  range.selectNodeContents(region);
  try {
    range.setEnd(node, offset);
  } catch {
    return undefined;
  }
  return range.toString().length;
}

function readContinuousSelection(root: HTMLElement): ManuscriptContinuousEditorSelection | undefined {
  if (typeof window === "undefined") return undefined;
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !selection.anchorNode || !selection.focusNode) {
    return undefined;
  }
  const anchorRegion = regionElementFromNode(root, selection.anchorNode);
  const focusRegion = regionElementFromNode(root, selection.focusNode);
  if (!anchorRegion || !focusRegion) return undefined;
  const anchorOffset = offsetWithinRegion(anchorRegion, selection.anchorNode, selection.anchorOffset);
  const focusOffset = offsetWithinRegion(focusRegion, selection.focusNode, selection.focusOffset);
  const anchorTargetId = anchorRegion.dataset.targetId;
  const focusTargetId = focusRegion.dataset.targetId;
  if (
    anchorOffset === undefined || focusOffset === undefined ||
    !anchorTargetId || !focusTargetId
  ) return undefined;
  return { anchorTargetId, anchorOffset, focusTargetId, focusOffset };
}

function textNodeAtOffset(region: HTMLElement, requestedOffset: number) {
  const walker = document.createTreeWalker(region, NodeFilter.SHOW_TEXT);
  let remaining = requestedOffset;
  let current = walker.nextNode();
  while (current) {
    const length = current.textContent?.length ?? 0;
    if (remaining <= length) return { node: current, offset: remaining };
    remaining -= length;
    current = walker.nextNode();
  }
  return { node: region as Node, offset: region.childNodes.length };
}

function restoreContinuousCaret(
  root: HTMLElement,
  targetId: string,
  selectionStart: number,
  selectionEnd = selectionStart
) {
  if (typeof window === "undefined") return;
  const region = Array.from(root.querySelectorAll<HTMLElement>("[data-manuscript-editable-region='true']"))
    .find((candidate) => candidate.dataset.targetId === targetId);
  if (!region) return;
  const start = textNodeAtOffset(region, selectionStart);
  const end = textNodeAtOffset(region, selectionEnd);
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

export function ManuscriptSegmentEditor(props: ManuscriptSegmentEditorProps) {
  const { projectionState } = props;
  const projection = projectionState.projection;
  const labels = {
    projectionUnavailable: "文稿投影视图不可用。",
    structuredOutline: "结构化纲要",
    startWriting: "开始撰写文稿",
    ariaLabel: "文稿原文",
    ...props.labels
  };
  const rootRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const compositionSelectionRef = useRef<ManuscriptContinuousEditorSelection>();
  const compositionTextRef = useRef("");
  const undoStackRef = useRef<LocalHistoryRecord[]>([]);
  const redoStackRef = useRef<LocalHistoryRecord[]>([]);
  const pendingCaretRef = useRef<Readonly<{ targetId: string; offset: number }>>();
  const [renderRevision, setRenderRevision] = useState(0);
  const [localTexts, setLocalTexts] = useState<ReadonlyMap<string, string>>(
    () => new Map(projectionState.regionDrafts.map((draft) => [draft.targetId, draft.currentText]))
  );

  const disabled = Boolean(props.interactionDisabled) || projectionState.saveDisabled ||
    projectionState.status === "STALE_DRAFT" ||
    projectionState.status === "FAIL_CLOSED" ||
    projectionState.status === "SAVE_COMMITTED_READBACK_UNCONFIRMED";

  useEffect(() => {
    setLocalTexts(new Map(
      projectionState.regionDrafts.map((draft) => [draft.targetId, draft.currentText])
    ));
  }, [projectionState.projectionGeneration, projectionState.regionDrafts]);

  useEffect(() => {
    undoStackRef.current = [];
    redoStackRef.current = [];
    pendingCaretRef.current = undefined;
  }, [projectionState.projectionGeneration]);

  useLayoutEffect(() => {
    const pending = pendingCaretRef.current;
    const root = rootRef.current;
    if (!pending || !root) return;
    pendingCaretRef.current = undefined;
    restoreContinuousCaret(root, pending.targetId, pending.offset);
  }, [localTexts, renderRevision]);

  useLayoutEffect(() => {
    const request = props.focusRestoreRequest;
    const root = rootRef.current;
    if (
      !request || !root || disabled ||
      request.target.projectionGeneration !== projectionState.projectionGeneration
    ) return;
    root.focus({ preventScroll: true });
    restoreContinuousCaret(
      root,
      request.target.targetId,
      request.target.selectionStart,
      request.target.selectionEnd
    );
    reportSelection({
      anchorTargetId: request.target.targetId,
      anchorOffset: request.target.selectionStart,
      focusTargetId: request.target.targetId,
      focusOffset: request.target.selectionEnd
    });
  }, [props.focusRestoreRequest?.requestId]);

  if (projection.classification === "NON_PROJECTABLE_FAIL_CLOSED") {
    return (
      <section
        aria-label={labels.ariaLabel}
        className="manuscript-continuous-editor-state"
        data-editor-model={MANUSCRIPT_SEGMENT_EDITOR_MODEL}
        data-product-editable-root-count="0"
        data-protocol-source-in-editable-dom-count="0"
        data-writable-projection="unavailable"
        role="alert"
      >
        {labels.projectionUnavailable}
      </section>
    );
  }

  const rawDraft = projectionState.regionDrafts[0];
  const rawText = rawDraft
    ? localTexts.get(rawDraft.targetId) ?? rawDraft.currentText
    : "";

  function readCurrentState(): ManuscriptSegmentProjectionSessionState {
    return {
      ...projectionState,
      regionDrafts: projectionState.regionDrafts.map((draft) => ({
        ...draft,
        currentText: localTexts.get(draft.targetId) ?? draft.currentText
      }))
    };
  }

  function reportSelection(selection?: ManuscriptContinuousEditorSelection) {
    const current = selection ?? (rootRef.current ? readContinuousSelection(rootRef.current) : undefined);
    if (!current || current.anchorTargetId !== current.focusTargetId) return;
    props.onFocusTarget?.({
      targetId: current.anchorTargetId,
      projectionGeneration: projectionState.projectionGeneration,
      selectionStart: Math.min(current.anchorOffset, current.focusOffset),
      selectionEnd: Math.max(current.anchorOffset, current.focusOffset)
    });
  }

  function commitOperation(
    operation: ManuscriptContinuousEditorOperation,
    historyMode: "record" | "undo" | "redo" = "record"
  ) {
    const state = readCurrentState();
    const draft = state.regionDrafts.find((candidate) => candidate.targetId === operation.targetId);
    if (!draft) {
      props.onRejectedEvent?.("TARGET_NOT_FOUND");
      return;
    }
    const beforeText = draft.currentText;
    if (beforeText === operation.nextText) {
      pendingCaretRef.current = { targetId: operation.targetId, offset: operation.caretAfter };
      setRenderRevision((value) => value + 1);
      return;
    }
    if (historyMode === "record") {
      undoStackRef.current.push({
        targetId: operation.targetId,
        beforeText,
        afterText: operation.nextText,
        beforeOffset: operation.selectionBefore.start,
        afterOffset: operation.caretAfter
      });
      redoStackRef.current = [];
    }
    setLocalTexts((current) => {
      const next = new Map(current);
      next.set(operation.targetId, operation.nextText);
      return next;
    });
    pendingCaretRef.current = { targetId: operation.targetId, offset: operation.caretAfter };
    void Promise.resolve(props.onEdit({
      targetId: operation.targetId,
      expectedProjectionGeneration: operation.expectedProjectionGeneration,
      nextText: operation.nextText,
      inputType: operation.inputType,
      compositionActive: false
    })).then((result) => {
      if (result.accepted) return;
      setLocalTexts((current) => {
        const next = new Map(current);
        next.set(operation.targetId, beforeText);
        return next;
      });
      pendingCaretRef.current = {
        targetId: operation.targetId,
        offset: operation.selectionBefore.start
      };
      props.onRejectedEvent?.(result.reason ?? "CONTINUOUS_EDIT_REJECTED");
    });
  }

  function performIntent(
    intent: ManuscriptContinuousEditorIntent,
    data?: string | null,
    selectionOverride?: ManuscriptContinuousEditorSelection
  ) {
    if (disabled) {
      props.onRejectedEvent?.("PROJECTION_NOT_WRITABLE");
      return false;
    }
    const root = rootRef.current;
    const selection = selectionOverride ?? (root ? readContinuousSelection(root) : undefined);
    if (!selection) {
      props.onRejectedEvent?.("NO_LEGAL_CONTINUOUS_SELECTION");
      return false;
    }
    const result = buildManuscriptContinuousEditorOperation({
      state: readCurrentState(),
      selection,
      intent,
      data
    });
    if (result.status === "REJECTED") {
      props.onRejectedEvent?.(result.reason);
      return false;
    }
    commitOperation(result.operation);
    reportSelection({
      anchorTargetId: result.operation.targetId,
      focusTargetId: result.operation.targetId,
      anchorOffset: result.operation.caretAfter,
      focusOffset: result.operation.caretAfter
    });
    return true;
  }

  function applyHistory(direction: "undo" | "redo") {
    if (disabled) {
      props.onRejectedEvent?.("PROJECTION_NOT_WRITABLE");
      return;
    }
    const source = direction === "undo" ? undoStackRef.current : redoStackRef.current;
    const record = source.pop();
    if (!record) return;
    const destination = direction === "undo" ? redoStackRef.current : undoStackRef.current;
    destination.push(record);
    commitOperation({
      targetId: record.targetId,
      expectedProjectionGeneration: projectionState.projectionGeneration,
      nextText: direction === "undo" ? record.beforeText : record.afterText,
      inputType: direction === "undo" ? "historyUndo" : "historyRedo",
      compositionActive: false,
      selectionBefore: {
        start: direction === "undo" ? record.afterOffset : record.beforeOffset,
        end: direction === "undo" ? record.afterOffset : record.beforeOffset
      },
      caretAfter: direction === "undo" ? record.beforeOffset : record.afterOffset
    }, direction);
  }

  function handleBeforeInput(event: FormEvent<HTMLDivElement>) {
    event.preventDefault();
    const native = event.nativeEvent as InputEvent;
    const intent = native.inputType as ManuscriptContinuousEditorIntent;
    if (composingRef.current && intent === "insertCompositionText") {
      compositionTextRef.current = native.data ?? compositionTextRef.current;
      return;
    }
    if (intent === "historyUndo") return applyHistory("undo");
    if (intent === "historyRedo") return applyHistory("redo");
    performIntent(intent || "replace", native.data);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!composingRef.current && event.key === "Backspace") {
      event.preventDefault();
      performIntent("deleteContentBackward");
      return;
    }
    if (!composingRef.current && event.key === "Delete") {
      event.preventDefault();
      performIntent("deleteContentForward");
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      applyHistory(event.shiftKey ? "redo" : "undo");
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
      event.preventDefault();
      applyHistory("redo");
      return;
    }
    if (event.key === "Enter" && !composingRef.current) {
      event.preventDefault();
      performIntent(event.shiftKey ? "insertLineBreak" : "insertParagraph");
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLDivElement>) {
    event.preventDefault();
    performIntent("insertFromPaste", event.clipboardData.getData("text/plain"));
  }

  function handleCut(event: ClipboardEvent<HTMLDivElement>) {
    event.preventDefault();
    performIntent("deleteByCut", "");
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    performIntent("insertFromDrop", event.dataTransfer.getData("text/plain"));
  }

  function handleCompositionStart() {
    if (disabled) {
      props.onRejectedEvent?.("PROJECTION_NOT_WRITABLE");
      return;
    }
    composingRef.current = true;
    compositionTextRef.current = "";
    compositionSelectionRef.current = rootRef.current
      ? readContinuousSelection(rootRef.current)
      : undefined;
  }

  function handleCompositionEnd(event: CompositionEvent<HTMLDivElement>) {
    const selection = compositionSelectionRef.current;
    const data = event.data || compositionTextRef.current;
    composingRef.current = false;
    compositionSelectionRef.current = undefined;
    compositionTextRef.current = "";
    if (selection) performIntent("insertCompositionText", data, selection);
  }

  return (
    <section
      aria-label="Shared manuscript continuous editor"
      className="manuscript-continuous-editor-shell"
      data-editor-model={MANUSCRIPT_SEGMENT_EDITOR_MODEL}
      data-archive-marker-visibility="raw"
      data-independent-editable-surface-count="0"
      data-product-editable-root-count="1"
      data-raw-draft-authority="session"
      data-visible-anchor-button-count="0"
      data-visible-segment-card-count="0"
      data-visible-segment-textarea-count="0"
      data-whole-visible-document-diff-count="0"
      data-writable-projection={disabled ? "disabled" : "available"}
    >
      <div
        aria-label={labels.ariaLabel}
        aria-multiline="true"
        aria-readonly={disabled}
        className="manuscript-continuous-editor"
        contentEditable={!disabled}
        data-editor-root="continuous-segment"
        key={`${projectionState.projectionGeneration}:${renderRevision}`}
        onBeforeInput={handleBeforeInput}
        onCompositionEnd={handleCompositionEnd}
        onCompositionStart={handleCompositionStart}
        onCut={handleCut}
        onDrop={handleDrop}
        onFocus={() => reportSelection()}
        onInput={() => {
          props.onRejectedEvent?.("UNCONTROLLED_DOM_MUTATION");
          setRenderRevision((value) => value + 1);
        }}
        onKeyDown={handleKeyDown}
        onKeyUp={() => reportSelection()}
        onMouseUp={() => reportSelection()}
        onPaste={handlePaste}
        ref={rootRef}
        role="textbox"
        spellCheck={false}
        suppressContentEditableWarning
      >
        {rawDraft ? (
          <div
            className="manuscript-continuous-editor__region manuscript-continuous-editor__region--unmanaged"
            data-manuscript-editable-region="true"
            data-placeholder={rawText.length === 0 ? labels.startWriting : undefined}
            data-source-kind="SESSION_RAW_DRAFT"
            data-target-id={rawDraft.targetId}
            key={rawDraft.targetId}
          >
            {rawText}
          </div>
        ) : null}
      </div>
    </section>
  );
}

export default ManuscriptSegmentEditor;
