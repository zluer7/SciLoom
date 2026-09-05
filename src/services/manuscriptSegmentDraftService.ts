import type {
  ManuscriptEditorLocalRange,
  ManuscriptLosslessMergeEvidence,
  ManuscriptNormalizedRangePatch,
  ManuscriptSegmentEditInputType,
  ManuscriptSegmentEditLineageEvent,
  ManuscriptSegmentProjection,
  ManuscriptSegmentRegionDraft,
  ManuscriptSourceByteRange
} from "../types/manuscriptSegmentProjection";
import {
  isAtomicGraphemeBoundary,
  isValidatedUnicodeBoundary,
  manuscriptByteSliceFingerprint,
  mapRegionEditorOffsetToSourceByte,
  normalizeManuscriptSegmentInsertedNewlines,
  sourceRangeContains
} from "./manuscriptSegmentProjectionService";

const textEncoder = new TextEncoder();

type BaselinePiece = Readonly<{
  kind: "BASELINE";
  startUtf16: number;
  endUtf16: number;
}>;

type InsertedPiece = Readonly<{
  kind: "INSERTED";
  text: string;
}>;

type DraftPiece = BaselinePiece | InsertedPiece;

interface InternalRegionDraft {
  targetId: string;
  targetKind:
    | "MANAGED_VALUE_SOURCE"
    | "UNMANAGED_RAW_SOURCE"
    | "UNMANAGED_INSERTION_ANCHOR";
  segmentId: string;
  stableKey?: string;
  anchorId?: string;
  baselineText: string;
  currentText: string;
  pieces: DraftPiece[];
  lineage: ManuscriptSegmentEditLineageEvent[];
  effectivePatches: ManuscriptNormalizedRangePatch[];
}

export type ManuscriptSegmentDraftWorkspace = ReturnType<
  typeof createManuscriptSegmentDraftWorkspace
>;

function isWellFormedUnicode(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

type SegmenterLike = new (
  locale?: string | string[],
  options?: { granularity: "grapheme" }
) => { segment(value: string): Iterable<{ index: number; segment: string }> };

function graphemes(value: string) {
  const Segmenter = (Intl as unknown as { Segmenter?: SegmenterLike }).Segmenter;
  if (Segmenter) {
    return [...new Segmenter(undefined, { granularity: "grapheme" }).segment(value)]
      .map((item) => item.segment);
  }
  return Array.from(value);
}

function deriveMinimalGraphemeEdit(currentText: string, nextText: string) {
  if (currentText === nextText) return null;
  const current = graphemes(currentText);
  const next = graphemes(nextText);
  let prefix = 0;
  while (
    prefix < current.length &&
    prefix < next.length &&
    current[prefix] === next[prefix]
  ) prefix += 1;
  let suffix = 0;
  while (
    suffix < current.length - prefix &&
    suffix < next.length - prefix &&
    current[current.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) suffix += 1;
  const prefixText = current.slice(0, prefix).join("");
  return Object.freeze({
    range: Object.freeze({
      startUtf16: prefixText.length,
      endUtf16:
        prefixText.length +
        current.slice(prefix, current.length - suffix).join("").length
    }),
    replacementText: next.slice(prefix, next.length - suffix).join("")
  });
}

function pieceText(piece: DraftPiece, baselineText: string) {
  return piece.kind === "BASELINE"
    ? baselineText.slice(piece.startUtf16, piece.endUtf16)
    : piece.text;
}

function pieceLength(piece: DraftPiece, baselineText: string) {
  return pieceText(piece, baselineText).length;
}

function coalescePieces(pieces: readonly DraftPiece[]) {
  const result: DraftPiece[] = [];
  for (const piece of pieces) {
    if (piece.kind === "INSERTED" && piece.text.length === 0) continue;
    if (piece.kind === "BASELINE" && piece.endUtf16 <= piece.startUtf16) continue;
    const previous = result[result.length - 1];
    if (previous?.kind === "INSERTED" && piece.kind === "INSERTED") {
      result[result.length - 1] = Object.freeze({
        kind: "INSERTED",
        text: previous.text + piece.text
      });
    } else if (
      previous?.kind === "BASELINE" &&
      piece.kind === "BASELINE" &&
      previous.endUtf16 === piece.startUtf16
    ) {
      result[result.length - 1] = Object.freeze({
        kind: "BASELINE",
        startUtf16: previous.startUtf16,
        endUtf16: piece.endUtf16
      });
    } else {
      result.push(Object.freeze(piece));
    }
  }
  return result;
}

function splitPiecesAt(
  pieces: readonly DraftPiece[],
  baselineText: string,
  draftOffset: number
) {
  const result: DraftPiece[] = [];
  let cursor = 0;
  let splitIndex = 0;
  let splitDone = false;
  for (const piece of pieces) {
    const length = pieceLength(piece, baselineText);
    if (!splitDone && draftOffset >= cursor && draftOffset <= cursor + length) {
      const local = draftOffset - cursor;
      if (local === 0) {
        splitIndex = result.length;
        result.push(piece);
        splitDone = true;
      } else if (local === length) {
        result.push(piece);
        splitIndex = result.length;
        splitDone = true;
        cursor += length;
        continue;
      } else if (piece.kind === "BASELINE") {
        const middle = piece.startUtf16 + local;
        result.push(Object.freeze({
          kind: "BASELINE",
          startUtf16: piece.startUtf16,
          endUtf16: middle
        }));
        splitIndex = result.length;
        result.push(Object.freeze({
          kind: "BASELINE",
          startUtf16: middle,
          endUtf16: piece.endUtf16
        }));
        splitDone = true;
      } else {
        result.push(Object.freeze({ kind: "INSERTED", text: piece.text.slice(0, local) }));
        splitIndex = result.length;
        result.push(Object.freeze({ kind: "INSERTED", text: piece.text.slice(local) }));
        splitDone = true;
      }
    } else {
      result.push(piece);
    }
    cursor += length;
  }
  if (!splitDone && draftOffset === cursor) {
    splitIndex = result.length;
    splitDone = true;
  }
  if (!splitDone) throw new Error("DRAFT_OFFSET_OUT_OF_RANGE");
  return { pieces: result, index: splitIndex };
}

function applyPieceEdit(
  draft: InternalRegionDraft,
  range: ManuscriptEditorLocalRange,
  replacementText: string
) {
  const atStart = splitPiecesAt(draft.pieces, draft.baselineText, range.startUtf16);
  const atEnd = splitPiecesAt(atStart.pieces, draft.baselineText, range.endUtf16);
  const startAgain = splitPiecesAt(
    atEnd.pieces,
    draft.baselineText,
    range.startUtf16
  );
  const inserted = replacementText.length > 0
    ? [Object.freeze({ kind: "INSERTED" as const, text: replacementText })]
    : [];
  draft.pieces = coalescePieces([
    ...startAgain.pieces.slice(0, startAgain.index),
    ...inserted,
    ...startAgain.pieces.slice(atEnd.index)
  ]);
  draft.currentText = draft.pieces.map(
    (piece) => pieceText(piece, draft.baselineText)
  ).join("");
}

function trimEquivalentPatch(
  baselineText: string,
  startUtf16: number,
  endUtf16: number,
  replacementText: string
) {
  const original = graphemes(baselineText.slice(startUtf16, endUtf16));
  const replacement = graphemes(replacementText);
  let prefix = 0;
  while (
    prefix < original.length &&
    prefix < replacement.length &&
    original[prefix] === replacement[prefix]
  ) prefix += 1;
  let suffix = 0;
  while (
    suffix < original.length - prefix &&
    suffix < replacement.length - prefix &&
    original[original.length - 1 - suffix] ===
      replacement[replacement.length - 1 - suffix]
  ) suffix += 1;
  const prefixText = original.slice(0, prefix).join("");
  return Object.freeze({
    startUtf16: startUtf16 + prefixText.length,
    endUtf16:
      startUtf16 + prefixText.length +
      original.slice(prefix, original.length - suffix).join("").length,
    replacementText: replacement.slice(prefix, replacement.length - suffix).join("")
  });
}

function publicDraft(draft: InternalRegionDraft): ManuscriptSegmentRegionDraft {
  return Object.freeze({
    targetId: draft.targetId,
    targetKind: draft.targetKind,
    segmentId: draft.segmentId,
    stableKey: draft.stableKey,
    anchorId: draft.anchorId,
    baselineText: draft.baselineText,
    currentText: draft.currentText,
    dirty: draft.effectivePatches.length > 0,
    lineage: Object.freeze([...draft.lineage]),
    effectivePatches: Object.freeze([...draft.effectivePatches])
  });
}

function normalizeDraft(
  projection: Extract<ManuscriptSegmentProjection, { classification: "PROJECTABLE" }>,
  draft: InternalRegionDraft
) {
  if (draft.currentText === draft.baselineText) {
    draft.pieces = draft.baselineText.length > 0
      ? [Object.freeze({
        kind: "BASELINE",
        startUtf16: 0,
        endUtf16: draft.baselineText.length
      })]
      : [];
    draft.effectivePatches = [];
    return;
  }
  const operationOrder = draft.lineage[draft.lineage.length - 1]?.operationOrder ?? 0;
  if (draft.targetKind === "UNMANAGED_INSERTION_ANCHOR") {
    const anchor = projection.insertionAnchors.find(
      (candidate) => candidate.anchorId === draft.anchorId
    );
    if (!anchor) throw new Error("INSERTION_ANCHOR_NOT_FOUND");
    draft.effectivePatches = [Object.freeze({
      patchId: `anchor-patch:${anchor.anchorId}:${operationOrder}`,
      projectionGeneration: projection.baselineIdentity.projectionGeneration,
      expectedBaselineIdentity: projection.baselineIdentity.rawSliceHash,
      baselineRevisionEvidence: projection.baselineIdentity.baselineRevisionEvidence,
      segmentId: anchor.anchorId,
      segmentKind: "UNMANAGED_INSERTION_ANCHOR",
      anchorId: anchor.anchorId,
      originalRegionLocalRange: Object.freeze({ startUtf16: 0, endUtf16: 0 }),
      sourceRange: Object.freeze({
        startByte: anchor.anchorByteOffset,
        endByte: anchor.anchorByteOffset
      }),
      expectedOriginalSliceFingerprint: anchor.anchorFingerprint,
      replacementText: draft.currentText,
      replacementUtf8Bytes: textEncoder.encode(draft.currentText),
      operationOrder
    })];
    return;
  }
  const segment = projection.sourceSegments.find(
    (candidate) => candidate.segmentId === draft.segmentId && candidate.editable
  );
  if (!segment) throw new Error("EDITABLE_SEGMENT_NOT_FOUND");
  const patches: ManuscriptNormalizedRangePatch[] = [];
  let baselineCursor = 0;
  let pendingInserted = "";
  const emit = (endUtf16: number) => {
    const trimmed = trimEquivalentPatch(
      draft.baselineText,
      baselineCursor,
      endUtf16,
      pendingInserted
    );
    pendingInserted = "";
    baselineCursor = endUtf16;
    if (
      trimmed.startUtf16 === trimmed.endUtf16 &&
      trimmed.replacementText.length === 0
    ) return;
    const startByte = mapRegionEditorOffsetToSourceByte({
      projection,
      segmentId: segment.segmentId,
      editorLocalUtf16Offset: trimmed.startUtf16,
      requireAtomicGraphemeBoundary: true
    });
    const endByte = mapRegionEditorOffsetToSourceByte({
      projection,
      segmentId: segment.segmentId,
      editorLocalUtf16Offset: trimmed.endUtf16,
      requireAtomicGraphemeBoundary: true
    });
    patches.push(Object.freeze({
      patchId: `segment-patch:${segment.segmentId}:${patches.length}:${operationOrder}`,
      projectionGeneration: projection.baselineIdentity.projectionGeneration,
      expectedBaselineIdentity: projection.baselineIdentity.rawSliceHash,
      baselineRevisionEvidence: projection.baselineIdentity.baselineRevisionEvidence,
      segmentId: segment.segmentId,
      segmentKind: segment.sourceKind as "MANAGED_VALUE_SOURCE" | "UNMANAGED_RAW_SOURCE",
      stableKey: segment.stableKey,
      originalRegionLocalRange: Object.freeze({
        startUtf16: trimmed.startUtf16,
        endUtf16: trimmed.endUtf16
      }),
      sourceRange: Object.freeze({ startByte, endByte }),
      expectedOriginalSliceFingerprint: manuscriptByteSliceFingerprint(
        projection.authoritativeRawBytes,
        startByte,
        endByte
      ),
      replacementText: trimmed.replacementText,
      replacementUtf8Bytes: textEncoder.encode(trimmed.replacementText),
      operationOrder: operationOrder + patches.length
    }));
  };
  for (const piece of draft.pieces) {
    if (piece.kind === "INSERTED") {
      pendingInserted += piece.text;
      continue;
    }
    if (piece.startUtf16 < baselineCursor) {
      throw new Error("BASELINE_PIECE_ORDER_INVALID");
    }
    if (piece.startUtf16 > baselineCursor || pendingInserted.length > 0) {
      emit(piece.startUtf16);
    }
    baselineCursor = piece.endUtf16;
  }
  if (baselineCursor < draft.baselineText.length || pendingInserted.length > 0) {
    emit(draft.baselineText.length);
  }
  draft.effectivePatches = patches;
}

export function createManuscriptSegmentDraftWorkspace(
  projection: ManuscriptSegmentProjection
) {
  if (projection.classification !== "PROJECTABLE") {
    throw new Error("WRITABLE_PROJECTION_REQUIRED");
  }
  const projectable = projection;
  const drafts = new Map<string, InternalRegionDraft>();
  let operationSequence = 0;
  for (const segment of projection.sourceSegments.filter(
    (candidate) => candidate.editable
  )) {
    drafts.set(segment.segmentId, {
      targetId: segment.segmentId,
      targetKind: segment.sourceKind as
        | "MANAGED_VALUE_SOURCE"
        | "UNMANAGED_RAW_SOURCE",
      segmentId: segment.segmentId,
      stableKey: segment.stableKey,
      baselineText: segment.decodedText,
      currentText: segment.decodedText,
      pieces: segment.decodedText.length > 0
        ? [Object.freeze({
          kind: "BASELINE",
          startUtf16: 0,
          endUtf16: segment.decodedText.length
        })]
        : [],
      lineage: [],
      effectivePatches: []
    });
  }
  for (const anchor of projection.insertionAnchors) {
    drafts.set(anchor.anchorId, {
      targetId: anchor.anchorId,
      targetKind: "UNMANAGED_INSERTION_ANCHOR",
      segmentId: anchor.anchorId,
      anchorId: anchor.anchorId,
      baselineText: "",
      currentText: "",
      pieces: [],
      lineage: [],
      effectivePatches: []
    });
  }

  function applyEdit(input: Readonly<{
    targetId: string;
    expectedProjectionGeneration: number;
    range: ManuscriptEditorLocalRange;
    replacementText: string;
    inputType: ManuscriptSegmentEditInputType;
    compositionActive?: boolean;
  }>) {
    if (
      input.expectedProjectionGeneration !==
      projectable.baselineIdentity.projectionGeneration
    ) return Object.freeze({ accepted: false as const, reason: "STALE_PROJECTION_GENERATION" });
    if (input.compositionActive) {
      return Object.freeze({ accepted: false as const, reason: "ACTIVE_IME_COMPOSITION" });
    }
    const draft = drafts.get(input.targetId);
    if (!draft) return Object.freeze({ accepted: false as const, reason: "DRAFT_TARGET_NOT_FOUND" });
    if (
      input.range.startUtf16 > input.range.endUtf16 ||
      input.range.endUtf16 > draft.currentText.length
    ) return Object.freeze({ accepted: false as const, reason: "DRAFT_RANGE_INVALID" });
    if (
      !isAtomicGraphemeBoundary(draft.currentText, input.range.startUtf16) ||
      !isAtomicGraphemeBoundary(draft.currentText, input.range.endUtf16)
    ) return Object.freeze({ accepted: false as const, reason: "DRAFT_RANGE_NOT_ATOMIC" });
    if (!isWellFormedUnicode(input.replacementText)) {
      return Object.freeze({ accepted: false as const, reason: "REPLACEMENT_UNICODE_INVALID" });
    }
    let replacementText: string;
    try {
      replacementText = normalizeManuscriptSegmentInsertedNewlines({
        projection: projectable,
        segmentId: draft.targetKind === "UNMANAGED_INSERTION_ANCHOR"
          ? undefined
          : draft.segmentId,
        anchorId: draft.anchorId,
        replacementText: input.replacementText
      });
    } catch {
      return Object.freeze({ accepted: false as const, reason: "NEWLINE_CONVENTION_UNRESOLVED" });
    }
    const before = {
      operationSequence,
      currentText: draft.currentText,
      pieces: draft.pieces,
      lineage: draft.lineage,
      effectivePatches: draft.effectivePatches
    };
    try {
      operationSequence += 1;
      applyPieceEdit(draft, input.range, replacementText);
      const event: ManuscriptSegmentEditLineageEvent = Object.freeze({
        eventId: `segment-edit:${operationSequence}`,
        operationOrder: operationSequence,
        targetId: draft.targetId,
        inputType: input.inputType,
        draftLocalRangeBefore: Object.freeze({ ...input.range }),
        replacementText,
        resultingDraftUtf16Length: draft.currentText.length
      });
      draft.lineage = [...draft.lineage, event];
      normalizeDraft(projectable, draft);
    } catch {
      operationSequence = before.operationSequence;
      draft.currentText = before.currentText;
      draft.pieces = before.pieces;
      draft.lineage = before.lineage;
      draft.effectivePatches = before.effectivePatches;
      return Object.freeze({ accepted: false as const, reason: "PATCH_NORMALIZATION_FAILED" });
    }
    return Object.freeze({
      accepted: true as const,
      draft: publicDraft(draft),
      dirty: draft.effectivePatches.length > 0
    });
  }

  function applyNextText(input: Readonly<{
    targetId: string;
    expectedProjectionGeneration: number;
    nextText: string;
    inputType: ManuscriptSegmentEditInputType;
    compositionActive?: boolean;
  }>) {
    const draft = drafts.get(input.targetId);
    if (!draft) return Object.freeze({ accepted: false as const, reason: "DRAFT_TARGET_NOT_FOUND" });
    if (draft.currentText === input.nextText) {
      return Object.freeze({ accepted: true as const, draft: publicDraft(draft), dirty: draft.effectivePatches.length > 0 });
    }
    const edit = deriveMinimalGraphemeEdit(draft.currentText, input.nextText);
    if (!edit) return Object.freeze({ accepted: true as const, draft: publicDraft(draft), dirty: false });
    return applyEdit({
      targetId: input.targetId,
      expectedProjectionGeneration: input.expectedProjectionGeneration,
      range: edit.range,
      replacementText: edit.replacementText,
      inputType: input.inputType,
      compositionActive: input.compositionActive
    });
  }

  function effectivePatches() {
    return Object.freeze(
      [...drafts.values()]
        .flatMap((draft) => draft.effectivePatches)
        .sort((left, right) =>
          left.sourceRange.startByte - right.sourceRange.startByte ||
          left.sourceRange.endByte - right.sourceRange.endByte ||
          left.operationOrder - right.operationOrder
        )
    );
  }

  return Object.freeze({
    projection: projectable,
    applyEdit,
    applyNextText,
    readDraft(targetId: string) {
      const draft = drafts.get(targetId);
      return draft ? publicDraft(draft) : undefined;
    },
    listDrafts() {
      return Object.freeze([...drafts.values()].map(publicDraft));
    },
    effectivePatches,
    isDirty() {
      return effectivePatches().length > 0;
    },
    reset() {
      for (const draft of drafts.values()) {
        draft.currentText = draft.baselineText;
        draft.pieces = draft.baselineText.length > 0
          ? [Object.freeze({
            kind: "BASELINE",
            startUtf16: 0,
            endUtf16: draft.baselineText.length
          })]
          : [];
        draft.lineage = [];
        draft.effectivePatches = [];
      }
    }
  });
}

function replacementBytesEqual(
  expected: Uint8Array,
  actual: Uint8Array
) {
  return expected.length === actual.length &&
    expected.every((byte, index) => byte === actual[index]);
}

export function validateManuscriptNormalizedPatches(input: Readonly<{
  projection: ManuscriptSegmentProjection;
  patches: readonly ManuscriptNormalizedRangePatch[];
}>) {
  if (input.projection.classification !== "PROJECTABLE") {
    throw new Error("WRITABLE_PROJECTION_REQUIRED");
  }
  const projection = input.projection;
  const sorted = [...input.patches].sort((left, right) =>
    left.sourceRange.startByte - right.sourceRange.startByte ||
    left.sourceRange.endByte - right.sourceRange.endByte ||
    left.operationOrder - right.operationOrder
  );
  let previousEnd = 0;
  for (const patch of sorted) {
    if (
      patch.projectionGeneration !== projection.baselineIdentity.projectionGeneration ||
      patch.expectedBaselineIdentity !== projection.baselineIdentity.rawSliceHash ||
      patch.baselineRevisionEvidence !== projection.baselineIdentity.baselineRevisionEvidence
    ) throw new Error("PATCH_BASELINE_IDENTITY_MISMATCH");
    if (
      patch.sourceRange.startByte < previousEnd ||
      patch.sourceRange.endByte < patch.sourceRange.startByte ||
      patch.sourceRange.endByte > projection.authoritativeRawBytes.length
    ) throw new Error("PATCH_RANGE_OVERLAP_OR_INVALID");
    if (!replacementBytesEqual(
      textEncoder.encode(patch.replacementText),
      patch.replacementUtf8Bytes
    )) throw new Error("PATCH_REPLACEMENT_BYTES_MISMATCH");
    if (patch.segmentKind === "UNMANAGED_INSERTION_ANCHOR") {
      const anchor = projection.insertionAnchors.find(
        (candidate) => candidate.anchorId === patch.anchorId
      );
      if (
        !anchor ||
        patch.sourceRange.startByte !== patch.sourceRange.endByte ||
        patch.sourceRange.startByte !== anchor.anchorByteOffset ||
        patch.expectedOriginalSliceFingerprint !== anchor.anchorFingerprint
      ) throw new Error("PATCH_ANCHOR_INVALID");
    } else {
      const segment = projection.sourceSegments.find(
        (candidate) => candidate.segmentId === patch.segmentId && candidate.editable
      );
      if (
        !segment ||
        segment.sourceKind !== patch.segmentKind ||
        segment.stableKey !== patch.stableKey ||
        !sourceRangeContains(segment.sourceRange, patch.sourceRange) ||
        manuscriptByteSliceFingerprint(
          projection.authoritativeRawBytes,
          patch.sourceRange.startByte,
          patch.sourceRange.endByte
        ) !== patch.expectedOriginalSliceFingerprint
      ) throw new Error("PATCH_SEGMENT_OR_FINGERPRINT_INVALID");
      try {
        const mappedStartByte = mapRegionEditorOffsetToSourceByte({
          projection,
          segmentId: segment.segmentId,
          editorLocalUtf16Offset: patch.originalRegionLocalRange.startUtf16,
          requireAtomicGraphemeBoundary: true
        });
        const mappedEndByte = mapRegionEditorOffsetToSourceByte({
          projection,
          segmentId: segment.segmentId,
          editorLocalUtf16Offset: patch.originalRegionLocalRange.endUtf16,
          requireAtomicGraphemeBoundary: true
        });
        if (
          mappedStartByte !== patch.sourceRange.startByte ||
          mappedEndByte !== patch.sourceRange.endByte
        ) throw new Error("PATCH_SOURCE_MAPPING_MISMATCH");
      } catch {
        throw new Error("PATCH_UNICODE_BOUNDARY_INVALID");
      }
    }
    previousEnd = Math.max(previousEnd, patch.sourceRange.endByte);
  }
  return Object.freeze(sorted);
}

export function mergeManuscriptSegmentPatchesLosslessly(input: Readonly<{
  projection: ManuscriptSegmentProjection;
  patches: readonly ManuscriptNormalizedRangePatch[];
}>): ManuscriptLosslessMergeEvidence {
  if (input.projection.classification !== "PROJECTABLE") {
    throw new Error("WRITABLE_PROJECTION_REQUIRED");
  }
  const patches = validateManuscriptNormalizedPatches(input);
  const baseline = input.projection.authoritativeRawBytes;
  const chunks: Uint8Array[] = [];
  const replaced: ManuscriptSourceByteRange[] = [];
  const deleted: ManuscriptSourceByteRange[] = [];
  const anchors: Array<{ patchId: string; anchorId?: string; startByte: number }> = [];
  const inserted: ManuscriptSourceByteRange[] = [];
  const preserved: Array<ManuscriptSourceByteRange & { rawSliceHash: string }> = [];
  let baselineCursor = 0;
  let resultCursor = 0;
  for (const patch of patches) {
    if (patch.sourceRange.startByte > baselineCursor) {
      const source = baseline.slice(baselineCursor, patch.sourceRange.startByte);
      chunks.push(source);
      preserved.push(Object.freeze({
        startByte: baselineCursor,
        endByte: patch.sourceRange.startByte,
        rawSliceHash: manuscriptByteSliceFingerprint(
          baseline,
          baselineCursor,
          patch.sourceRange.startByte
        )
      }));
      resultCursor += source.length;
    }
    if (patch.sourceRange.endByte > patch.sourceRange.startByte) {
      const range = Object.freeze({ ...patch.sourceRange });
      replaced.push(range);
      if (patch.replacementUtf8Bytes.length === 0) deleted.push(range);
    } else {
      anchors.push(Object.freeze({
        patchId: patch.patchId,
        anchorId: patch.anchorId,
        startByte: patch.sourceRange.startByte
      }));
    }
    if (patch.replacementUtf8Bytes.length > 0) {
      chunks.push(patch.replacementUtf8Bytes);
      inserted.push(Object.freeze({
        startByte: resultCursor,
        endByte: resultCursor + patch.replacementUtf8Bytes.length
      }));
      resultCursor += patch.replacementUtf8Bytes.length;
    }
    baselineCursor = patch.sourceRange.endByte;
  }
  if (baselineCursor < baseline.length) {
    const source = baseline.slice(baselineCursor);
    chunks.push(source);
    preserved.push(Object.freeze({
      startByte: baselineCursor,
      endByte: baseline.length,
      rawSliceHash: manuscriptByteSliceFingerprint(
        baseline,
        baselineCursor,
        baseline.length
      )
    }));
  }
  const resultLength = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const resultBytes = new Uint8Array(resultLength);
  let resultOffset = 0;
  for (const chunk of chunks) {
    resultBytes.set(chunk, resultOffset);
    resultOffset += chunk.length;
  }
  return Object.freeze({
    resultBytes,
    replacedBaselineRanges: Object.freeze(replaced),
    deletedBaselineRanges: Object.freeze(deleted),
    insertionAnchors: Object.freeze(anchors),
    insertedResultRanges: Object.freeze(inserted),
    preservedBaselineSliceHashes: Object.freeze(preserved)
  });
}

export const manuscriptSegmentDraftService = Object.freeze({
  createWorkspace: createManuscriptSegmentDraftWorkspace,
  validatePatches: validateManuscriptNormalizedPatches,
  mergeLosslessly: mergeManuscriptSegmentPatchesLosslessly,
  isValidatedUnicodeBoundary
});
