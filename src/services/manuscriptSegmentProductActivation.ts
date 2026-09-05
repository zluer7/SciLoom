import type { ManuscriptOutlineDescriptorLookupIdentity } from "./manuscriptOutlineParser";
import type { ReviewType } from "../types/planning";

export const MANUSCRIPT_SEGMENT_PRODUCT_CHANNELS = Object.freeze([
  Object.freeze({ ownerType: "experiment", channel: "primary" }),
  Object.freeze({ ownerType: "experimentRun", channel: "primary" }),
  Object.freeze({ ownerType: "literature", channel: "literature_outline" }),
  Object.freeze({ ownerType: "literature", channel: "dedicated_notes" }),
  Object.freeze({ ownerType: "review", channel: "primary" }),
  Object.freeze({ ownerType: "resultItem", channel: "primary" }),
  Object.freeze({ ownerType: "finding", channel: "primary" }),
  Object.freeze({ ownerType: "outputCandidate", channel: "primary" }),
  Object.freeze({ ownerType: "outputGap", channel: "primary" }),
  Object.freeze({ ownerType: "researchOutput", channel: "primary" })
] as const);

export type ManuscriptSegmentProductChannel =
  (typeof MANUSCRIPT_SEGMENT_PRODUCT_CHANNELS)[number];

/**
 * Standardized Operations is a projection of the canonical managed-channel
 * registry, not an independently maintained owner allowlist.  CREATE and
 * UPDATE are the only parent actions that may carry a nested manuscript
 * effect.
 */
export function projectStandardOperationManuscriptEffectCapabilities() {
  return MANUSCRIPT_SEGMENT_PRODUCT_CHANNELS.flatMap(({ ownerType, channel }) => [
    `CREATE.${ownerType}.${ownerType}.${channel}`,
    `UPDATE.${ownerType}.${ownerType}.${channel}`
  ]);
}

export const MANUSCRIPT_SEGMENT_REVIEW_TYPES = Object.freeze([
  "stage",
  "periodic",
  "experiment_comparison",
  "literature_comparison",
  "custom"
] as const satisfies readonly ReviewType[]);

export function isManuscriptSegmentProductIdentity(
  identity: ManuscriptOutlineDescriptorLookupIdentity
) {
  const channelSupported = MANUSCRIPT_SEGMENT_PRODUCT_CHANNELS.some(
    (entry) => entry.ownerType === identity.ownerType && entry.channel === identity.channel
  );
  if (!channelSupported) return false;
  if (identity.ownerType !== "review") return identity.reviewType === undefined;
  return Boolean(
    identity.reviewType &&
    MANUSCRIPT_SEGMENT_REVIEW_TYPES.includes(identity.reviewType)
  );
}
