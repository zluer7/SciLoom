import type {
  AIActionDraft,
  AIActionDraftApplyResult,
  AIReviewCandidateDraftPayload
} from "../types/aiDraft";
import { planningService } from "./planningService";
import { manuscriptRequestTokenController } from "./manuscriptRequestTokenController";
import {
  applyReviewAiDraftProposal,
  createReviewAiDraftProposal
} from "./reviewAiReadyContextService";

export interface ApplyAIReviewDraftOptions {
  draft: AIActionDraft<"review_candidate">;
  appliedAt?: string;
  requestToken?: number;
  getReviewById?: typeof planningService.getReviewById;
  saveCandidate?: Parameters<typeof applyReviewAiDraftProposal>[0]["saveCandidate"];
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function failedResult(draftId: string, appliedAt: string, errorCode: string, message: string): AIActionDraftApplyResult {
  return { success: false, result: "failed", message, errorCode, errorMessage: message, sourceDraftId: draftId, appliedAt };
}

export async function applyAIReviewDraft({
  draft,
  appliedAt = new Date().toISOString(),
  requestToken = manuscriptRequestTokenController.begin(),
  getReviewById = planningService.getReviewById,
  saveCandidate
}: ApplyAIReviewDraftOptions): Promise<AIActionDraftApplyResult> {
  const payload = draft.proposedPayload as AIReviewCandidateDraftPayload;
  const reviewId = textValue(payload?.reviewId);
  const candidateMarkdown = textValue(payload?.candidateMarkdown);
  if (!reviewId || !candidateMarkdown) {
    return failedResult(draft.draftInstanceId, appliedAt, "invalid_review_candidate_payload", "Review Candidate requires reviewId and candidateMarkdown.");
  }
  const review = await getReviewById(reviewId);
  if (!review || review.deletedAt) {
    return failedResult(draft.draftInstanceId, appliedAt, "review_not_found", `Review was not found or is deleted: ${reviewId}.`);
  }
  const proposal = createReviewAiDraftProposal({
    draftId: draft.draftInstanceId,
    reviewId,
    draftType: "review_candidate",
    createdAt: appliedAt,
    proposedCandidate: { content: candidateMarkdown },
    suggestions: {
      summary: textValue(payload.suggestedSummary),
      warnings: payload.suggestedWarnings,
      nextActionsText: textValue(payload.suggestedNextActionsText),
      questions: payload.suggestedQuestions,
      targetNotes: textValue(payload.suggestedTargetNotes)
    }
  });
  const result = await applyReviewAiDraftProposal({ proposal, userConfirmed: true, requestToken, appliedAt, saveCandidate });
  if (!result.success || !result.candidate?.fileRefId) {
    return failedResult(draft.draftInstanceId, appliedAt, "review_candidate_save_failed", result.message);
  }
  return {
    success: true,
    result: "written",
    message: result.message,
    updatedEntity: {
      module: "review",
      entityType: "fileRef",
      entityId: result.candidate.fileRefId,
      label: result.candidate.fileName ?? "Review Candidate"
    },
    sourceDraftId: draft.draftInstanceId,
    appliedAt
  };
}
