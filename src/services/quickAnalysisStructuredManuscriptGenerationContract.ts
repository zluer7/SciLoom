import type { ManuscriptOutlineDescriptor } from "./manuscriptOutlineDescriptorRegistry";
import { buildCanonicalStructuredManuscriptTargetTemplate } from "./structuredManuscriptAIGuidance";

export const QUICK_ANALYSIS_USER_INSTRUCTION = [
  "Generate one new candidate manuscript body from the frozen start-time source and admitted context.",
  "Return only the candidate manuscript body in the exact target-specific structured format below; do not emit application control fields or any envelope outside that manuscript body.",
  "Use the dominant language of the admitted research content and do not claim user confirmation."
].join(" ");

export function buildQuickAnalysisStructuredManuscriptGenerationContract(
  descriptor: ManuscriptOutlineDescriptor
) {
  const target = buildCanonicalStructuredManuscriptTargetTemplate(descriptor);
  return [
    "## Required target-specific structured manuscript format",
    `Target descriptor identity: ${target.descriptorIdentity}.`,
    "Return exactly one canonical Structured Outline Archive as the entire candidate manuscript body.",
    "Preserve every marker line and display heading in the exact template below, in the same order and exactly once.",
    "Do not rename stable keys, replace stable-key markers with display headings, add a code fence, add a second archive, or use a different target descriptor.",
    "Write each field's content below its matching display heading and before the next marker; leave a field empty when the admitted evidence does not support it.",
    "The canonical Archive is the candidate manuscript body itself, not an application control envelope or a Standard Result wrapper.",
    "### Exact canonical target template",
    target.archiveTemplate
  ].join("\n\n");
}

export function buildQuickAnalysisGenerationInput(
  rawContent: string,
  descriptor: ManuscriptOutlineDescriptor
) {
  return [
    QUICK_ANALYSIS_USER_INSTRUCTION,
    buildQuickAnalysisStructuredManuscriptGenerationContract(descriptor),
    "## Current raw manuscript (frozen START_TIME_SNAPSHOT)",
    rawContent
  ].join("\n\n");
}
