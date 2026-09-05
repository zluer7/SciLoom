import type { AIResearchObjectType } from "../types/aiContext";
import type { FileRefOwnerType } from "../types/experiment";
import type { ManuscriptChannel } from "../types/manuscriptChannel";
import { MANUSCRIPT_SEGMENT_PRODUCT_CHANNELS } from "./manuscriptSegmentProductActivation";

export type QuickAnalysisCapabilityRow =
  (typeof MANUSCRIPT_SEGMENT_PRODUCT_CHANNELS)[number];
export type QuickAnalysisOwnerType = QuickAnalysisCapabilityRow["ownerType"];
export type QuickAnalysisChannel = QuickAnalysisCapabilityRow["channel"];

export interface QuickAnalysisStartInput {
  ownerType: QuickAnalysisOwnerType;
  ownerId: string;
  channel: QuickAnalysisChannel;
  /** Consistency hint only. Canonical owner/scope services remain authoritative. */
  expectedProjectOrScopeId?: string;
}
export type QuickAnalysisDomainCandidatePortId =
  | "experimentQuickAnalysisCandidatePort"
  | "experimentRunQuickAnalysisCandidatePort"
  | "literatureQuickAnalysisCandidatePort"
  | "reviewQuickAnalysisCandidatePort"
  | "outputsQuickAnalysisCandidatePort";

export interface QuickAnalysisCapabilityBinding {
  ownerType: QuickAnalysisOwnerType;
  channel: QuickAnalysisChannel;
  canonicalManuscriptIdentitySourcePort:
    "quickAnalysisCanonicalSourcePort.resolve";
  researchObjectType: AIResearchObjectType;
  candidateTarget: {
    module: QuickAnalysisOwnerType;
    entityType: QuickAnalysisOwnerType;
    manuscriptChannel: QuickAnalysisChannel;
  };
  domainCandidateApplicationPort: QuickAnalysisDomainCandidatePortId;
  candidateReadbackProjection: "quickAnalysisCandidateReadbackProjection";
}

function domainPort(ownerType: FileRefOwnerType): QuickAnalysisDomainCandidatePortId {
  if (ownerType === "experiment") return "experimentQuickAnalysisCandidatePort";
  if (ownerType === "experimentRun") return "experimentRunQuickAnalysisCandidatePort";
  if (ownerType === "literature") return "literatureQuickAnalysisCandidatePort";
  if (ownerType === "review") return "reviewQuickAnalysisCandidatePort";
  return "outputsQuickAnalysisCandidatePort";
}

/**
 * The sole Quick Analysis capability-binding owner. It projects the existing
 * canonical manuscript registry and therefore cannot invent owner/channel rows.
 */
export const QUICK_ANALYSIS_CAPABILITY_BINDINGS: readonly QuickAnalysisCapabilityBinding[] =
  Object.freeze(MANUSCRIPT_SEGMENT_PRODUCT_CHANNELS.map((identity) => Object.freeze({
    ownerType: identity.ownerType,
    channel: identity.channel,
    canonicalManuscriptIdentitySourcePort: "quickAnalysisCanonicalSourcePort.resolve" as const,
    researchObjectType: identity.ownerType as AIResearchObjectType,
    candidateTarget: Object.freeze({
      module: identity.ownerType,
      entityType: identity.ownerType,
      manuscriptChannel: identity.channel
    }),
    domainCandidateApplicationPort: domainPort(identity.ownerType),
    candidateReadbackProjection: "quickAnalysisCandidateReadbackProjection" as const
  })));

export function resolveQuickAnalysisCapabilityBinding(input: {
  ownerType: string;
  channel: ManuscriptChannel | string;
}): QuickAnalysisCapabilityBinding {
  const matches = QUICK_ANALYSIS_CAPABILITY_BINDINGS.filter((binding) =>
    binding.ownerType === input.ownerType && binding.channel === input.channel);
  if (matches.length !== 1) {
    throw new Error(
      `QUICK_ANALYSIS_CAPABILITY_UNSUPPORTED: ${input.ownerType}/${input.channel}.`
    );
  }
  return matches[0];
}
