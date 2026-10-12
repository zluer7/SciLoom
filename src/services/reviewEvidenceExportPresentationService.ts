import type { Review } from "../types";
import { planningService } from "./planningService";
import { buildReviewAggregationAiContext } from "./reviewAiContextService";
import { reviewExportService } from "./reviewExportService";
import { sanitizeFileName, saveTextFile } from "./exportService";

export type PreparedReviewMarkdownExport = Readonly<{
  reviewId: string;
  reviewTitle: string;
  contents: string;
  defaultFileName: string;
}>;

// A local read guard, not a new Review revision or lifecycle authority.
function sameReview(left: Review, right: Review) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function requireCurrentReview(expected: Review) {
  if (!expected?.id || expected.deletedAt) throw new Error("review_unavailable");
  const current = await planningService.getReviewById(expected.id);
  if (!current || current.deletedAt) throw new Error("review_unavailable");
  if (!sameReview(expected, current)) throw new Error("review_changed");
  return current;
}

export const reviewEvidenceExportPresentationService = {
  async read(expected: Review) {
    await requireCurrentReview(expected);
    const context = await buildReviewAggregationAiContext(expected.id);
    await requireCurrentReview(expected);
    if (!context || context.scopeSummary.reviewId !== expected.id) throw new Error("review_unavailable");
    return context;
  },

  async prepare(expected: Review) {
    const current = await requireCurrentReview(expected);
    // Keep the current serializer as the sole Markdown authority.
    const contents = await reviewExportService.exportReviewAggregationContextMarkdown(current.id);
    await requireCurrentReview(current);
    return Object.freeze({
      reviewId: current.id,
      reviewTitle: current.title,
      contents,
      defaultFileName: `review-${sanitizeFileName(current.title || "review")}.md`
    });
  },

  async save(prepared: PreparedReviewMarkdownExport) {
    return saveTextFile(prepared.defaultFileName, prepared.contents, "text/markdown");
  }
};
