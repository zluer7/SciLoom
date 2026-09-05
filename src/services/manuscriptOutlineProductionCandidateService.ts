import {
  parseCanonicalManuscriptOutline,
  type ManuscriptOutlineDescriptorLookupIdentity,
  type ManuscriptOutlineReplacementDto
} from "./manuscriptOutlineParser";
import {
  projectManuscriptOutlineReplacements,
  type ManuscriptOutlineOwnerApplicationMapping,
  type ManuscriptOutlineOwnerProjectorFailure
} from "./manuscriptOutlineOwnerProjector";

export type ManuscriptOutlineProductionCandidateFailure = Readonly<{
  stage: "parser" | "projector";
  code: string;
  message: string;
  descriptorLookupIdentity: ManuscriptOutlineDescriptorLookupIdentity;
}>;

export type ManuscriptOutlineProductionCandidateResult =
  | Readonly<{
      ok: true;
      orderedReplacementDto: ManuscriptOutlineReplacementDto;
      applicationMapping: ManuscriptOutlineOwnerApplicationMapping;
      setFieldCount: number;
      clearFieldCount: number;
      clearedStableKeys: readonly string[];
    }>
  | Readonly<{
      ok: false;
      error: ManuscriptOutlineProductionCandidateFailure;
    }>;

function projectorFailure(
  error: ManuscriptOutlineOwnerProjectorFailure
): ManuscriptOutlineProductionCandidateResult {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      stage: "projector",
      code: error.code,
      message: error.message,
      descriptorLookupIdentity: error.descriptorLookupIdentity
    })
  });
}

export function buildManuscriptOutlineProductionCandidate(input: Readonly<{
  rawMarkdown: string;
  descriptorLookupIdentity: ManuscriptOutlineDescriptorLookupIdentity;
}>): ManuscriptOutlineProductionCandidateResult {
  const parsed = parseCanonicalManuscriptOutline(input);
  if (!parsed.ok) {
    return Object.freeze({
      ok: false,
      error: Object.freeze({
        stage: "parser",
        code: parsed.error.code,
        message: parsed.error.message,
        descriptorLookupIdentity: parsed.error.descriptorLookupIdentity
      })
    });
  }
  const projected = projectManuscriptOutlineReplacements({
    orderedReplacementDto: parsed.dto,
    descriptorLookupIdentity: input.descriptorLookupIdentity
  });
  if (!projected.ok) return projectorFailure(projected.error);
  const clearedStableKeys = parsed.dto.orderedReplacements
    .filter((replacement) => replacement.action === "clear")
    .map((replacement) => replacement.stableKey);
  return Object.freeze({
    ok: true,
    orderedReplacementDto: parsed.dto,
    applicationMapping: projected.mapping,
    setFieldCount: parsed.dto.orderedReplacements.length - clearedStableKeys.length,
    clearFieldCount: clearedStableKeys.length,
    clearedStableKeys: Object.freeze(clearedStableKeys)
  });
}

export const manuscriptOutlineProductionCandidateService = Object.freeze({
  build: buildManuscriptOutlineProductionCandidate
});
