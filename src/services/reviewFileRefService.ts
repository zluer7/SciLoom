import type { EntityId } from "../types";
import { fileRefService } from "./fileRefService";
import {
  buildReviewFileRefCreateInput,
  toReviewFileRefPathMaterialSummary,
  type CreateReviewFileRefInput
} from "./reviewFileRefPathMaterialModel";

async function createReviewFileRef(reviewId: EntityId, input: CreateReviewFileRefInput) {
  return (await fileRefService.registerFileRef(buildReviewFileRefCreateInput(reviewId, input))).fileRef;
}

async function queryAllReviewFileRefs(reviewId: EntityId) {
  return fileRefService.getFileRefsByOwner("review", reviewId);
}

async function queryReviewFileRefs(reviewId: EntityId) {
  return (await queryAllReviewFileRefs(reviewId)).filter(
    (fileRef) => fileRef.fileRole === "attachment"
  );
}

async function queryReviewFileRefPathMaterialSummaries(reviewId: EntityId) {
  const fileRefs = await queryReviewFileRefs(reviewId);
  return fileRefs
    .filter((fileRef) => !fileRef.deletedAt)
    .map(toReviewFileRefPathMaterialSummary);
}

export const reviewFileRefService = {
  buildReviewFileRefCreateInput,
  createReviewFileRef,
  queryAllReviewFileRefs,
  queryReviewFileRefs,
  queryReviewFileRefPathMaterialSummaries,
  toReviewFileRefPathMaterialSummary
};

export type ReviewFileRefService = typeof reviewFileRefService;
