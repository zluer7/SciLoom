import type { ManuscriptOutlineDescriptorLookupIdentity } from "./manuscriptOutlineParser";
import { getManuscriptOutlineDescriptor } from "./manuscriptOutlineDescriptorRegistry";
import {
  buildManuscriptOutlineProductionCandidate,
  type ManuscriptOutlineProductionCandidateResult
} from "./manuscriptOutlineProductionCandidateService";
import {
  buildStructuredOutlineArchiveSettlementBytes,
  demoteStructuredOutlineArchiveMarkers,
  resolveStructuredOutlineArchiveParserInput,
  serializeCanonicalStructuredOutlineArchiveBytes,
  type StructuredOutlineArchiveIdentityTerminal,
  type StructuredOutlineArchiveParserProtocolTerminal
} from "./manuscriptStructuredOutlineArchive";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const UTF8_BOM = Object.freeze([0xef, 0xbb, 0xbf] as const);

export interface CanonicalFormalSwitchCleanupSpan {
  readonly lineStartByte: number;
  readonly ownedEndByte: number;
  readonly markerKind: "BEGIN" | "END";
}

export interface CanonicalFormalSwitchTargetCleanupPlan {
  readonly expectedRevision: string;
  readonly expectedPreByteLength: number;
  readonly archiveIdentityTerminal: StructuredOutlineArchiveIdentityTerminal;
  readonly exactMarkerSpans: readonly CanonicalFormalSwitchCleanupSpan[];
  readonly expectedPostText: string;
  readonly cleanupRequired: boolean;
}

export type CanonicalFormalSwitchArchiveCandidateResult =
  | (Extract<ManuscriptOutlineProductionCandidateResult, { ok: true }> & Readonly<{
      archiveIdentityTerminal: StructuredOutlineArchiveIdentityTerminal;
      parserProtocolTerminal: "EXECUTABLE";
    }>)
  | Readonly<{
      ok: false;
      archiveIdentityTerminal: StructuredOutlineArchiveIdentityTerminal;
      parserProtocolTerminal: StructuredOutlineArchiveParserProtocolTerminal;
      error: {
        stage: "parser" | "projector";
        code: string;
        message: string;
        descriptorLookupIdentity: ManuscriptOutlineDescriptorLookupIdentity;
      };
    }>;

function hasBom(bytes: Uint8Array) {
  return bytes.length >= UTF8_BOM.length &&
    UTF8_BOM.every((byte, index) => bytes[index] === byte);
}

function decodePreservingBom(bytes: Uint8Array) {
  const bom = hasBom(bytes);
  const text = decoder.decode(bom ? bytes.slice(UTF8_BOM.length) : bytes);
  return bom ? `\ufeff${text}` : text;
}

function archiveLineEnding(rawMarkdown: string): "\n" | "\r\n" {
  return rawMarkdown.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * The sole production Formal Switch target parser entry. F5-3 Archive identity
 * is resolved first; only a UNIQUE Archive interior reaches A2/A3. NONE and
 * MULTIPLE_OR_AMBIGUOUS intentionally map through the canonical empty outline.
 */
export function buildCanonicalFormalSwitchArchiveCandidate(input: Readonly<{
  rawMarkdown: string;
  descriptorLookupIdentity: ManuscriptOutlineDescriptorLookupIdentity;
}>): CanonicalFormalSwitchArchiveCandidateResult {
  const parserInput = resolveStructuredOutlineArchiveParserInput(
    encoder.encode(input.rawMarkdown)
  );
  if (parserInput.parserProtocolTerminal === "TECHNICAL_FAILURE") {
    return Object.freeze({
      ok: false,
      archiveIdentityTerminal: parserInput.archiveIdentityTerminal,
      parserProtocolTerminal: parserInput.parserProtocolTerminal,
      error: Object.freeze({
        stage: "parser" as const,
        code: parserInput.errorCode,
        message: "The exact Archive interior is not executable UTF-8.",
        descriptorLookupIdentity: input.descriptorLookupIdentity
      })
    });
  }
  const candidate = buildManuscriptOutlineProductionCandidate({
    rawMarkdown: parserInput.canonicalParserInputRawMarkdown,
    descriptorLookupIdentity: input.descriptorLookupIdentity
  });
  if (!candidate.ok) {
    return Object.freeze({
      ...candidate,
      archiveIdentityTerminal: parserInput.archiveIdentityTerminal,
      parserProtocolTerminal: parserInput.parserProtocolTerminal
    });
  }
  return Object.freeze({
    ...candidate,
    archiveIdentityTerminal: parserInput.archiveIdentityTerminal,
    parserProtocolTerminal: parserInput.parserProtocolTerminal
  });
}

/** Builds the immutable, execution-local F5-4 target marker demotion plan. */
export function buildCanonicalFormalSwitchTargetCleanupPlan(input: Readonly<{
  rawMarkdown: string;
  expectedRevision: string;
}>): CanonicalFormalSwitchTargetCleanupPlan {
  const sourceBytes = encoder.encode(input.rawMarkdown);
  const parserInput = resolveStructuredOutlineArchiveParserInput(sourceBytes);
  const demotion = demoteStructuredOutlineArchiveMarkers(sourceBytes);
  return Object.freeze({
    expectedRevision: input.expectedRevision,
    expectedPreByteLength: sourceBytes.byteLength,
    archiveIdentityTerminal: parserInput.archiveIdentityTerminal,
    exactMarkerSpans: Object.freeze(
      demotion.removedMarkerLineSpans.map((span) => Object.freeze({
        lineStartByte: span.lineStartByte,
        ownedEndByte: span.ownedEndByte,
        markerKind: span.markerKind
      }))
    ),
    expectedPostText: decodePreservingBom(demotion.resultBytes),
    cleanupRequired: demotion.removedMarkerLineCount > 0
  });
}

/**
 * The sole production switch-away serializer/settlement planner. Owner code
 * supplies typed values only; A1 fixes field identity/order and F5-3 fixes all
 * Archive/BODY byte semantics.
 */
export function buildCanonicalFormalSwitchOldCurrentSettlement(input: Readonly<{
  currentRawMarkdown: string;
  descriptorLookupIdentity: ManuscriptOutlineDescriptorLookupIdentity;
  currentStructuredValues: Readonly<Record<string, unknown>>;
  humanHint?: string;
}>) {
  const descriptor = getManuscriptOutlineDescriptor(input.descriptorLookupIdentity);
  const sourceBytes = encoder.encode(input.currentRawMarkdown);
  const archiveBytes = serializeCanonicalStructuredOutlineArchiveBytes({
    descriptor,
    values: input.currentStructuredValues,
    humanHint: input.humanHint,
    lineEnding: archiveLineEnding(input.currentRawMarkdown)
  });
  const settlement = buildStructuredOutlineArchiveSettlementBytes({
    existingRawBytes: sourceBytes,
    archiveBytes
  });
  return Object.freeze({
    expectedPostText: decodePreservingBom(settlement.resultBytes),
    archiveBytes: archiveBytes.slice(),
    removedStaleMarkerLineCount: settlement.demotion.removedMarkerLineCount,
    existingBodyMutationCount: settlement.append.existingByteMutationCount,
    descriptorLookupIdentity: input.descriptorLookupIdentity
  });
}

export const canonicalFormalSwitchArchiveConvergence = Object.freeze({
  buildTargetCandidate: buildCanonicalFormalSwitchArchiveCandidate,
  buildTargetCleanupPlan: buildCanonicalFormalSwitchTargetCleanupPlan,
  buildOldCurrentSettlement: buildCanonicalFormalSwitchOldCurrentSettlement
});
