import type { CandidateManuscriptSource } from "../types/candidateManuscript";
import { createStableShortId } from "./managedPathService";
import {
  parseCandidateOccurredAt,
  validateCandidateRequestId
} from "./literatureCandidateFilenameService";

export const REVIEW_CANDIDATE_FILENAME_PATTERN =
  /^review_(ai|user)_[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{6}_[a-f0-9]{8}\.md$/u;

export interface ReviewCandidateFileNamePlan {
  ownerType: "review";
  manuscriptChannel: "primary";
  source: CandidateManuscriptSource;
  occurredAt: string;
  requestId: string;
  requestShortId: string;
  timestampSegment: string;
  fileName: string;
}

export function buildReviewCandidateFileName(input: {
  ownerType: "review";
  manuscriptChannel: "primary";
  source: CandidateManuscriptSource | string;
  occurredAt: string;
  requestId: string;
}): ReviewCandidateFileNamePlan {
  if (input.ownerType !== "review") {
    throw new Error("CANDIDATE_OWNER_MISMATCH: Review Candidate ownerType must be review.");
  }
  if (input.manuscriptChannel !== "primary") {
    throw new Error("CANDIDATE_CHANNEL_UNSUPPORTED: Review Candidate channel must be primary.");
  }
  if (input.source !== "ai" && input.source !== "user") {
    throw new Error("CANDIDATE_SOURCE_INVALID: Review Candidate source must be ai or user.");
  }
  const requestId = validateCandidateRequestId(input.requestId);
  const time = parseCandidateOccurredAt(input.occurredAt);
  const requestShortId = createStableShortId(requestId).slice(0, 8);
  const fileName = `review_${input.source}_${time.timestampSegment}_${requestShortId}.md`;
  if (!REVIEW_CANDIDATE_FILENAME_PATTERN.test(fileName)) {
    throw new Error("CANDIDATE_FILENAME_INVALID: generated Review Candidate filename is invalid.");
  }
  return {
    ownerType: "review",
    manuscriptChannel: "primary",
    source: input.source,
    occurredAt: time.occurredAt,
    requestId,
    requestShortId,
    timestampSegment: time.timestampSegment,
    fileName
  };
}

export const reviewCandidateFilenameService = {
  build: buildReviewCandidateFileName
};
