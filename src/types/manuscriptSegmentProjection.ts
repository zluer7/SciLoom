import type { ManuscriptOutlineDescriptorLookupIdentity } from "../services/manuscriptOutlineParser";
import type { FileIdentity, RawManuscriptSnapshot } from "./manuscriptOperation";
import type {
  SharedManuscriptSessionHandle,
  SharedManuscriptSessionKey
} from "./sharedManuscriptSession";

export const MANUSCRIPT_SEGMENT_EDITOR_MODEL = "CONTINUOUS_SEGMENT_EDITOR" as const;

export type ManuscriptProjectionStatus =
  | "ACTIVE"
  | "DIRTY"
  | "STALE_DRAFT"
  | "FAIL_CLOSED"
  | "SAVE_COMMITTED_READBACK_UNCONFIRMED";

export type ManuscriptSourceSegmentKind =
  | "PROTECTED_PREAMBLE_SOURCE"
  | "PROTOCOL_CONTROL_SOURCE"
  | "PROTOCOL_HEADING_SOURCE"
  | "MANAGED_VALUE_SOURCE"
  | "UNMANAGED_RAW_SOURCE";

export type ManuscriptEditableSourceSegmentKind =
  | "MANAGED_VALUE_SOURCE"
  | "UNMANAGED_RAW_SOURCE";

export type ManuscriptPresentationNodeKind =
  | "SYNTHETIC_MANAGED_HEADING"
  | "EMPTY_STATE_HINT"
  | "UI_SEPARATOR";

export interface ManuscriptSourceByteRange {
  readonly startByte: number;
  readonly endByte: number;
}

export interface ManuscriptProjectionBaselineIdentity {
  readonly ownerType: string;
  readonly ownerId: string;
  readonly channel: string;
  readonly fileRefId: string;
  readonly sessionKey: SharedManuscriptSessionKey;
  readonly sessionGeneration: number;
  readonly projectionGeneration: number;
  readonly baselineRevisionEvidence: string;
  readonly baselinePhysicalIdentity?: string;
  readonly rawByteLength: number;
  readonly rawSliceHash: string;
  readonly controlFingerprint: string;
  readonly encoding: "utf-8" | "utf-8-bom";
}

export interface ManuscriptSourceSegment {
  readonly segmentId: string;
  readonly sourceKind: ManuscriptSourceSegmentKind;
  readonly sourceRange: ManuscriptSourceByteRange;
  readonly rawSliceHash: string;
  readonly baselineIdentityEvidence: string;
  readonly editable: boolean;
  readonly decodedText: string;
  readonly stableKey?: string;
  readonly displayLabel?: string;
  readonly protocolRole?:
    | "BOM"
    | "OUTLINE_START"
    | "OUTLINE_END"
    | "OUTLINE_DELIMITER"
    | "OUTLINE_HEADING"
    | "FIELD_MARKER"
    | "FIELD_HEADING"
    | "FIELD_DELIMITER";
}

export interface ManuscriptPresentationNode {
  readonly nodeId: string;
  readonly nodeKind: ManuscriptPresentationNodeKind;
  readonly stableKey?: string;
  readonly displayText?: string;
  readonly sourceRange: null;
  readonly persistentByteCount: 0;
  readonly reverseMapping: "PROHIBITED";
}

export interface ManuscriptEditableProjectionNode {
  readonly nodeId: string;
  readonly nodeKind: "EDITABLE_SOURCE_REGION";
  readonly segmentId: string;
  readonly sourceKind: ManuscriptEditableSourceSegmentKind;
  readonly stableKey?: string;
  readonly text: string;
  readonly sourceRange: ManuscriptSourceByteRange;
}

export type ManuscriptProjectionNode =
  | ManuscriptPresentationNode
  | ManuscriptEditableProjectionNode;

export type ManuscriptUnmanagedInsertionPolicy =
  | "DOCUMENT_START_OUTSIDE_PROTOCOL"
  | "DOCUMENT_END_OUTSIDE_PROTOCOL"
  | "UNMANAGED_REGION_BOUNDARY";

export interface ManuscriptUnmanagedInsertionAnchor {
  readonly anchorId: string;
  readonly projectionGeneration: number;
  readonly baselineRevisionEvidence: string;
  readonly baselineIdentityEvidence: string;
  readonly ownerType: string;
  readonly ownerId: string;
  readonly channel: string;
  readonly fileRefId: string;
  readonly leftSourceBoundary: string;
  readonly rightSourceBoundary: string;
  readonly anchorByteOffset: number;
  readonly anchorFingerprint: string;
  readonly allowedInsertionPolicy: ManuscriptUnmanagedInsertionPolicy;
}

export interface ProjectableManuscriptSegmentProjection {
  readonly classification: "PROJECTABLE";
  readonly writableProjection: "AVAILABLE";
  readonly status: "ACTIVE" | "DIRTY";
  readonly baselineIdentity: ManuscriptProjectionBaselineIdentity;
  readonly descriptorLookupIdentity: ManuscriptOutlineDescriptorLookupIdentity;
  readonly authoritativeRawBytes: Uint8Array;
  readonly decodedRawMarkdown: string;
  readonly hasUtf8Bom: boolean;
  readonly sourceSegments: readonly ManuscriptSourceSegment[];
  readonly projectionNodes: readonly ManuscriptProjectionNode[];
  readonly insertionAnchors: readonly ManuscriptUnmanagedInsertionAnchor[];
  readonly editableRegionCount: number;
  readonly physicalWriteCount: 0;
  readonly protocolOwnedControlSpanRenderedInEditableRegionCount: 0;
  readonly userOwnedMarkerLikeTextRenderedCount: number;
}

export interface NonProjectableManuscriptSegmentProjection {
  readonly classification: "NON_PROJECTABLE_FAIL_CLOSED";
  readonly writableProjection: null;
  readonly status: "FAIL_CLOSED";
  readonly baselineIdentity: ManuscriptProjectionBaselineIdentity;
  readonly authoritativeRawBytes: Uint8Array;
  readonly diagnostics: readonly string[];
  readonly editableRegionCount: 0;
  readonly physicalWriteCount: 0;
}

export type ManuscriptSegmentProjection =
  | ProjectableManuscriptSegmentProjection
  | NonProjectableManuscriptSegmentProjection;

export interface ManuscriptEditorLocalRange {
  readonly startUtf16: number;
  readonly endUtf16: number;
}

export type ManuscriptSegmentEditInputType =
  | "insertText"
  | "insertFromPaste"
  | "deleteContentBackward"
  | "deleteContentForward"
  | "deleteByCut"
  | "insertFromDrop"
  | "historyUndo"
  | "historyRedo"
  | "insertCompositionText"
  | "replace";

export interface ManuscriptSegmentEditLineageEvent {
  readonly eventId: string;
  readonly operationOrder: number;
  readonly targetId: string;
  readonly inputType: ManuscriptSegmentEditInputType;
  readonly draftLocalRangeBefore: ManuscriptEditorLocalRange;
  readonly replacementText: string;
  readonly resultingDraftUtf16Length: number;
}

export type ManuscriptRangePatchTargetKind =
  | ManuscriptEditableSourceSegmentKind
  | "UNMANAGED_INSERTION_ANCHOR";

export interface ManuscriptNormalizedRangePatch {
  readonly patchId: string;
  readonly projectionGeneration: number;
  readonly expectedBaselineIdentity: string;
  readonly baselineRevisionEvidence: string;
  readonly segmentId: string;
  readonly segmentKind: ManuscriptRangePatchTargetKind;
  readonly stableKey?: string;
  readonly anchorId?: string;
  readonly originalRegionLocalRange: ManuscriptEditorLocalRange;
  readonly sourceRange: ManuscriptSourceByteRange;
  readonly expectedOriginalSliceFingerprint: string;
  readonly replacementText: string;
  readonly replacementUtf8Bytes: Uint8Array;
  readonly operationOrder: number;
}

export interface ManuscriptSegmentRegionDraft {
  readonly targetId: string;
  readonly targetKind: ManuscriptRangePatchTargetKind;
  readonly segmentId: string;
  readonly stableKey?: string;
  readonly anchorId?: string;
  readonly baselineText: string;
  readonly currentText: string;
  readonly dirty: boolean;
  readonly lineage: readonly ManuscriptSegmentEditLineageEvent[];
  readonly effectivePatches: readonly ManuscriptNormalizedRangePatch[];
}

export interface ManuscriptSegmentProjectionSessionState {
  readonly runtimeHandle: SharedManuscriptSessionHandle;
  readonly sessionKey: SharedManuscriptSessionKey;
  readonly sessionGeneration: number;
  readonly projectionGeneration: number;
  readonly descriptorLookupIdentity: ManuscriptOutlineDescriptorLookupIdentity;
  readonly projection: ManuscriptSegmentProjection;
  readonly status: ManuscriptProjectionStatus;
  readonly regionDrafts: readonly ManuscriptSegmentRegionDraft[];
  readonly normalizedEffectivePatches: readonly ManuscriptNormalizedRangePatch[];
  readonly dirty: boolean;
  readonly saveDisabled: boolean;
  readonly lastFailureCode?: string;
}

/**
 * Ephemeral, operation-local evidence for Preview and Save As. It is derived
 * from the segment sidecar and is never persisted as a second manuscript.
 */
export interface ManuscriptSegmentDraftSnapshot {
  readonly snapshotToken: string;
  readonly runtimeHandle: SharedManuscriptSessionHandle;
  readonly ownerType: string;
  readonly ownerId: string;
  readonly channel: string;
  readonly windowRole: "current" | "independent";
  readonly fileRefId: string;
  readonly pathIdentityKey: string;
  readonly sessionKey: SharedManuscriptSessionKey;
  readonly sessionGeneration: number;
  readonly projectionGeneration: number;
  readonly baselineRevisionEvidence: string;
  readonly baselinePhysicalIdentity?: string;
  readonly baselineRawFingerprint: string;
  readonly controlFingerprint: string;
  readonly mergedRawText: string;
  readonly markerFreePreviewMarkdown: string;
  readonly snapshotByteLength: number;
  readonly snapshotSha256: string;
  readonly effectivePatchCount: number;
  readonly encoding: "utf-8" | "utf-8-bom";
  readonly newline: "lf" | "crlf" | "mixed" | "none";
}

export interface ManuscriptLosslessMergeEvidence {
  readonly resultBytes: Uint8Array;
  readonly replacedBaselineRanges: readonly ManuscriptSourceByteRange[];
  readonly deletedBaselineRanges: readonly ManuscriptSourceByteRange[];
  readonly insertionAnchors: readonly Readonly<{
    patchId: string;
    anchorId?: string;
    startByte: number;
  }>[];
  readonly insertedResultRanges: readonly ManuscriptSourceByteRange[];
  readonly preservedBaselineSliceHashes: readonly Readonly<
    ManuscriptSourceByteRange & { rawSliceHash: string }
  >[];
}

export interface ManuscriptSegmentProjectionBuildInput {
  readonly rawBytes: Uint8Array;
  readonly ownerType: string;
  readonly ownerId: string;
  readonly channel: string;
  readonly fileRefId: string;
  readonly sessionKey: SharedManuscriptSessionKey;
  readonly sessionGeneration: number;
  readonly projectionGeneration: number;
  readonly baseline: RawManuscriptSnapshot;
  readonly descriptorLookupIdentity: ManuscriptOutlineDescriptorLookupIdentity;
}

export interface ManuscriptSegmentOrdinarySaveInput {
  readonly runtimeHandle: SharedManuscriptSessionHandle;
  readonly expectedProjectionGeneration: number;
}

export type ManuscriptSegmentOrdinarySaveResult = Readonly<{
  status:
    | "SUCCESS_CHANGED"
    | "SUCCESS_NO_OP"
    | "STALE_DRAFT"
    | "FAILURE_EXPECTED"
    | "FAILURE_UNEXPECTED"
    | "SAVE_COMMITTED_READBACK_UNCONFIRMED";
  operationId: string;
  gatewaySaveInvocationCount: number;
  physicalReplaceCount: number | "UNKNOWN";
  preflightReadCount: number;
  durableReadbackConfirmed: boolean;
  draftRetained: boolean;
  patchCount: number;
  businessWriteCount: 0;
  bindingMutationCount: 0;
  formalSwitchInvocationCount: 0;
  projectionState?: ManuscriptSegmentProjectionSessionState;
  mergeEvidence?: ManuscriptLosslessMergeEvidence;
  error?: Readonly<{
    code: string;
    retryable: boolean;
    recoveryRequired: boolean;
    writeApplied: true | false | "unknown";
  }>;
}>;

export interface ManuscriptSegmentFoundationFileContext {
  readonly file: FileIdentity;
  readonly baseline: RawManuscriptSnapshot;
}
