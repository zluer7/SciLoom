import type { EntityId, ISODateString } from "../types/common";
import type {
  CandidateManuscriptSource,
  SaveCandidateManuscriptResult,
  SetCandidateAsCurrentInput,
  SetCandidateAsCurrentResult
} from "../types/candidateManuscript";
import { candidateManuscriptService } from "./candidateManuscriptService";
import { buildReviewCandidateFileName } from "./reviewCandidateFilenameService";
import { reviewManuscriptStructuredDataService } from "./reviewManuscriptStructuredDataService";
import { reviewCurrentFilenameService } from "./reviewCurrentFilenameService";
import {
  buildReviewMetaSnapshot,
  buildReviewOutlineSnapshot
} from "./reviewManuscriptPresentationService";

export interface ReviewCandidateRequest {
  reviewId: EntityId;
  source: CandidateManuscriptSource;
  occurredAt: ISODateString;
  candidateRequestId: string;
  content: string;
  requestToken: number;
}

export interface ReviewCandidatePreview {
  ownerType: "review";
  ownerId: EntityId;
  manuscriptChannel: "primary";
  source: CandidateManuscriptSource;
  occurredAt: ISODateString;
  candidateRequestId: string;
  filename: string;
  content: string;
  requiresUserConfirmation: true;
  currentChanged: false;
}

export interface ReviewCandidateDependencies {
  getStructured: typeof reviewManuscriptStructuredDataService.get;
  saveSharedCandidate: typeof candidateManuscriptService.saveCandidate;
  setSharedCandidateAsCurrent: typeof candidateManuscriptService.setCandidateAsCurrent;
  getCurrentFilename: typeof reviewCurrentFilenameService.get;
}

const defaultDependencies: ReviewCandidateDependencies = {
  getStructured: reviewManuscriptStructuredDataService.get,
  saveSharedCandidate: candidateManuscriptService.saveCandidate,
  setSharedCandidateAsCurrent: candidateManuscriptService.setCandidateAsCurrent,
  getCurrentFilename: reviewCurrentFilenameService.get
};

export function createReviewCandidateService(
  dependencies: ReviewCandidateDependencies = defaultDependencies
) {
  function preview(input: ReviewCandidateRequest): ReviewCandidatePreview {
    const filename = buildReviewCandidateFileName({
      ownerType: "review",
      manuscriptChannel: "primary",
      source: input.source,
      occurredAt: input.occurredAt,
      requestId: input.candidateRequestId
    }).fileName;
    if (!input.content.trim()) {
      throw new Error("CANDIDATE_REQUEST_INVALID: Review Candidate content is empty.");
    }
    return {
      ownerType: "review",
      ownerId: input.reviewId,
      manuscriptChannel: "primary",
      source: input.source,
      occurredAt: input.occurredAt,
      candidateRequestId: input.candidateRequestId,
      filename,
      content: input.content,
      requiresUserConfirmation: true,
      currentChanged: false
    };
  }

  return {
    preview,
    async saveCandidate(
      input: ReviewCandidateRequest & { confirmedByUser: boolean }
    ): Promise<SaveCandidateManuscriptResult> {
      preview(input);
      const structured = await dependencies.getStructured(input.reviewId);
      if (structured.status === "error") {
        return {
          status: "error",
          ownerType: "review",
          ownerId: input.reviewId,
          manuscriptChannel: "primary",
          requestId: input.candidateRequestId,
          occurredAt: input.occurredAt,
          source: input.source,
          createdFile: false,
          reusedFile: false,
          createdFileRef: false,
          contentSizeBytes: 0,
          warnings: [],
          errors: [{ code: structured.error.code, message: structured.error.message, step: "owner-validation" }],
          completedSteps: [],
          failedStep: "owner-validation",
          retryable: false,
          requestToken: input.requestToken,
          currentChanged: false
        };
      }
      return dependencies.saveSharedCandidate({
        ownerType: "review",
        ownerId: input.reviewId,
        manuscriptChannel: "primary",
        requestId: input.candidateRequestId,
        occurredAt: input.occurredAt,
        source: input.source,
        confirmedByUser: input.confirmedByUser,
        metaSnapshot: buildReviewMetaSnapshot(structured.dto),
        outline: buildReviewOutlineSnapshot(structured.dto),
        body: input.content,
        requestToken: input.requestToken
      });
    },
    async setCandidateAsCurrent(
      input: Omit<SetCandidateAsCurrentInput, "ownerType" | "manuscriptChannel">
    ): Promise<SetCandidateAsCurrentResult & { currentFilename?: string }> {
      const result = await dependencies.setSharedCandidateAsCurrent({
        ...input,
        ownerType: "review",
        manuscriptChannel: "primary"
      });
      if (result.status === "error") return result;
      const current = await dependencies.getCurrentFilename(input.ownerId);
      return current.status === "ready" ? { ...result, currentFilename: current.filename } : result;
    }
  };
}

export const reviewCandidateService = createReviewCandidateService();
