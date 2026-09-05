import type { ManuscriptOutlineDescriptor } from "./manuscriptOutlineDescriptorRegistry";
import { serializeCanonicalStructuredOutlineArchive } from "./manuscriptStructuredOutlineArchive";

export type CanonicalStructuredManuscriptTargetTemplate = Readonly<{
  descriptorIdentity: string;
  archiveTemplate: string;
}>;

/**
 * Pure runtime projection of the live descriptor into the exact candidate-body
 * skeleton used by AI guidance. It grants no target, write, or switch authority.
 */
export function buildCanonicalStructuredManuscriptTargetTemplate(
  descriptor: ManuscriptOutlineDescriptor
): CanonicalStructuredManuscriptTargetTemplate {
  return Object.freeze({
    descriptorIdentity: [
      `owner=${descriptor.ownerType}`,
      `channel=${descriptor.channel}`,
      ...(descriptor.reviewType ? [`reviewType=${descriptor.reviewType}`] : [])
    ].join("; "),
    archiveTemplate: serializeCanonicalStructuredOutlineArchive({
      descriptor,
      values: {}
    })
  });
}
