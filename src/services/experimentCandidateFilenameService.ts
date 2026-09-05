import type { CandidateManuscriptSource } from "../types/candidateManuscript";
import { createStableShortId } from "./managedPathService";
import {
  parseCandidateOccurredAt,
  validateCandidateRequestId
} from "./literatureCandidateFilenameService";

export const EXPERIMENT_CANDIDATE_FILENAME_PATTERN =
  /^experiment_(ai|user)_[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{6}_[a-f0-9]{8}\.md$/u;

export function buildExperimentCandidateFileName(input: {
  ownerType: "experiment";
  manuscriptChannel: "primary";
  source: CandidateManuscriptSource | string;
  occurredAt: string;
  requestId: string;
}) {
  if (input.ownerType !== "experiment" || input.manuscriptChannel !== "primary") {
    throw new Error("CANDIDATE_CHANNEL_UNSUPPORTED: Experiment Candidate channel must be primary.");
  }
  if (input.source !== "ai" && input.source !== "user") {
    throw new Error("CANDIDATE_SOURCE_INVALID: Experiment Candidate source must be ai or user.");
  }
  const requestId = validateCandidateRequestId(input.requestId);
  const time = parseCandidateOccurredAt(input.occurredAt);
  const requestShortId = createStableShortId(requestId).slice(0, 8);
  const fileName = `experiment_${input.source}_${time.timestampSegment}_${requestShortId}.md`;
  if (!EXPERIMENT_CANDIDATE_FILENAME_PATTERN.test(fileName)) {
    throw new Error("CANDIDATE_FILENAME_INVALID: generated Experiment Candidate filename is invalid.");
  }
  return {
    ownerType: input.ownerType,
    manuscriptChannel: input.manuscriptChannel,
    source: input.source,
    occurredAt: time.occurredAt,
    requestId,
    requestShortId,
    timestampSegment: time.timestampSegment,
    fileName
  };
}

export const experimentCandidateFilenameService = {
  build: buildExperimentCandidateFileName
};
