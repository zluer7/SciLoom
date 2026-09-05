import type { CandidateManuscriptSource } from "../types/candidateManuscript";
import type { FileRefOwnerType } from "../types/experiment";
import { createStableShortId } from "./managedPathService";
import { parseCandidateOccurredAt, validateCandidateRequestId } from "./literatureCandidateFilenameService";

export type QuickAnalysisPrimaryCandidateOwnerType = Exclude<
  FileRefOwnerType,
  "literature" | "review" | "experiment"
>;

const PREFIX_BY_OWNER: Readonly<Record<QuickAnalysisPrimaryCandidateOwnerType, string>> = Object.freeze({
  experimentRun: "experiment-run",
  resultItem: "result-item",
  finding: "finding",
  outputCandidate: "output-candidate",
  outputGap: "output-gap",
  researchOutput: "research-output"
});

export function buildQuickAnalysisPrimaryCandidateFileName(input: {
  ownerType: QuickAnalysisPrimaryCandidateOwnerType;
  manuscriptChannel: "primary";
  source: CandidateManuscriptSource | string;
  occurredAt: string;
  requestId: string;
}) {
  const prefix = PREFIX_BY_OWNER[input.ownerType];
  if (!prefix || input.manuscriptChannel !== "primary") {
    throw new Error("CANDIDATE_CHANNEL_UNSUPPORTED: Quick Analysis Candidate owner/channel is unsupported.");
  }
  if (input.source !== "ai") {
    throw new Error("CANDIDATE_SOURCE_INVALID: Quick Analysis Candidate source must be ai.");
  }
  const requestId = validateCandidateRequestId(input.requestId);
  const time = parseCandidateOccurredAt(input.occurredAt);
  const requestShortId = createStableShortId(requestId).slice(0, 8);
  const fileName = `${prefix}_${input.source}_${time.timestampSegment}_${requestShortId}.md`;
  if (!/^[a-z-]+_(?:ai|user)_\d{4}-\d{2}-\d{2}_\d{6}_[a-f0-9]{8}\.md$/u.test(fileName)) {
    throw new Error("CANDIDATE_FILENAME_INVALID: generated Quick Analysis Candidate filename is invalid.");
  }
  return {
    ownerType: input.ownerType,
    manuscriptChannel: "primary" as const,
    source: input.source,
    occurredAt: time.occurredAt,
    requestId,
    requestShortId,
    timestampSegment: time.timestampSegment,
    fileName
  };
}
