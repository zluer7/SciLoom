import { buildCanonicalFormalSwitchArchiveCandidate } from "./canonicalFormalSwitchArchiveConvergence";
import { getManuscriptOutlineDescriptor } from "./manuscriptOutlineDescriptorRegistry";
import type { ManuscriptOutlineDescriptorLookupIdentity } from "./manuscriptOutlineParser";
import { resolveStructuredOutlineArchiveParserInput } from "./manuscriptStructuredOutlineArchive";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export const STRUCTURED_OUTLINE_PREVIEW_HINT =
  "此区域作为文稿切换的可读区域，请勿修改格式。" as const;

export type StructuredOutlinePreviewPresentation = Readonly<{
  bodyMarkdown: string;
  sourceMarkdown: string;
  sourceMutationCount: 0;
  archive?: Readonly<{
    hint: string;
    fields: readonly Readonly<{
      stableKey: string;
      label: string;
      value: string;
    }>[];
  }>;
}>;

function withoutArchiveBlock(
  sourceBytes: Uint8Array,
  startByte: number,
  endByte: number
) {
  const result = new Uint8Array(
    sourceBytes.byteLength - (endByte - startByte)
  );
  result.set(sourceBytes.slice(0, startByte), 0);
  result.set(sourceBytes.slice(endByte), startByte);
  return decoder.decode(result);
}

/**
 * Preview-only projector. It never serializes or writes manuscript bytes and
 * only suppresses a UNIQUE, canonically executable Archive from BODY preview.
 */
export function buildStructuredOutlinePreviewPresentation(input: Readonly<{
  rawMarkdown: string;
  descriptorLookupIdentity: ManuscriptOutlineDescriptorLookupIdentity;
  hint?: string;
  emptyValue?: string;
  resolveLabel?: (stableKey: string, fallback: string) => string;
}>): StructuredOutlinePreviewPresentation {
  const sourceBytes = encoder.encode(input.rawMarkdown);
  const parserInput = resolveStructuredOutlineArchiveParserInput(sourceBytes);
  if (
    parserInput.parserProtocolTerminal !== "EXECUTABLE" ||
    parserInput.archiveIdentityTerminal !== "UNIQUE" ||
    !parserInput.identity.pair
  ) {
    return Object.freeze({
      bodyMarkdown: input.rawMarkdown,
      sourceMarkdown: input.rawMarkdown,
      sourceMutationCount: 0 as const
    });
  }
  const candidate = buildCanonicalFormalSwitchArchiveCandidate({
    rawMarkdown: input.rawMarkdown,
    descriptorLookupIdentity: input.descriptorLookupIdentity
  });
  if (
    !candidate.ok ||
    candidate.orderedReplacementDto.contentStatus !== "VALID_OUTLINE"
  ) {
    return Object.freeze({
      bodyMarkdown: input.rawMarkdown,
      sourceMarkdown: input.rawMarkdown,
      sourceMutationCount: 0 as const
    });
  }
  const descriptor = getManuscriptOutlineDescriptor(
    input.descriptorLookupIdentity
  );
  const descriptorByKey = new Map(
    descriptor.fields.map((field) => [field.stableKey, field] as const)
  );
  const fields = candidate.orderedReplacementDto.orderedReplacements.map(
    (replacement) => {
      const field = descriptorByKey.get(replacement.stableKey);
      if (!field) {
        throw new Error("STRUCTURED_OUTLINE_PREVIEW_DESCRIPTOR_MISMATCH");
      }
      return Object.freeze({
        stableKey: field.stableKey,
        label: input.resolveLabel?.(field.stableKey, field.displayLabel) ??
          field.displayLabel,
        value: replacement.action === "set"
          ? replacement.value
          : input.emptyValue ?? "未填写"
      });
    }
  );
  const pair = parserInput.identity.pair;
  return Object.freeze({
    bodyMarkdown: withoutArchiveBlock(
      sourceBytes,
      pair.archiveBlockStartByte,
      pair.archiveBlockEndByte
    ),
    sourceMarkdown: input.rawMarkdown,
    sourceMutationCount: 0 as const,
    archive: Object.freeze({
      hint: input.hint ?? STRUCTURED_OUTLINE_PREVIEW_HINT,
      fields: Object.freeze(fields)
    })
  });
}

export const manuscriptStructuredOutlinePreviewPresentation = Object.freeze({
  build: buildStructuredOutlinePreviewPresentation
});
