import type { SaveCandidateManuscriptInput } from "../types/candidateManuscript";
import { candidateManuscriptService } from "./candidateManuscriptService";
import type {
  QuickAnalysisDomainCandidatePortId,
  QuickAnalysisOwnerType
} from "./quickAnalysisCapabilityBinding";

type QuickAnalysisCandidateSaveInput = SaveCandidateManuscriptInput & {
  authorization: Extract<
    NonNullable<SaveCandidateManuscriptInput["authorization"]>,
    { source: "DERIVED_FROM_QUICK_ANALYSIS_RUN_AUTHORIZATION" }
  >;
  frozenWorkspace: NonNullable<SaveCandidateManuscriptInput["frozenWorkspace"]>;
};

function ownerAllowed(portId: QuickAnalysisDomainCandidatePortId, ownerType: QuickAnalysisOwnerType) {
  if (portId === "experimentQuickAnalysisCandidatePort") return ownerType === "experiment";
  if (portId === "experimentRunQuickAnalysisCandidatePort") return ownerType === "experimentRun";
  if (portId === "literatureQuickAnalysisCandidatePort") return ownerType === "literature";
  if (portId === "reviewQuickAnalysisCandidatePort") return ownerType === "review";
  return ownerType === "resultItem" || ownerType === "finding" ||
    ownerType === "outputCandidate" || ownerType === "outputGap" ||
    ownerType === "researchOutput";
}
/** Thin domain-local ports. The existing candidate service remains the sole writer. */
export async function saveQuickAnalysisCandidateThroughLocalPort(
  portId: QuickAnalysisDomainCandidatePortId,
  input: QuickAnalysisCandidateSaveInput
) {
  if (!ownerAllowed(portId, input.ownerType)) {
    throw new Error(`QUICK_ANALYSIS_CANDIDATE_PORT_OWNER_MISMATCH: ${portId}/${input.ownerType}.`);
  }
  if ((input.authorization as { source?: string } | undefined)?.source !== "DERIVED_FROM_QUICK_ANALYSIS_RUN_AUTHORIZATION") {
    throw new Error("QUICK_ANALYSIS_CANDIDATE_AUTHORIZATION_SOURCE_INVALID");
  }
  return candidateManuscriptService.saveCandidate(input);
}
