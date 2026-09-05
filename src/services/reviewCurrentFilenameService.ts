import type { EntityId } from "../types/common";
import type { FileRef } from "../types/experiment";
import type { ManuscriptBindingIdentityResult } from "../types/manuscriptBindingIdentity";
import { MANUSCRIPT_BINDING_IDENTITY_ERROR_CODES } from "../types/manuscriptBindingIdentity";
import {
  REVIEW_MANUSCRIPT_ERROR_CODES,
  type ReviewCurrentFilenameDto,
  type ReviewManuscriptErrorCode
} from "../types/reviewManuscript";
import { createPathIdentityKey } from "./fileRefIdentity";
import { fileRefService, getSafeManuscriptBasename } from "./fileRefService";
import { isLikelyAbsoluteLocalPath } from "./localPathService";
import { manuscriptBindingService } from "./manuscriptBindingService";
import { planningService } from "./planningService";

export interface ReviewCurrentFilenameDependencies {
  getOwnerState(reviewId: EntityId): Promise<"active" | "deleted" | "missing">;
  resolveIdentity(reviewId: EntityId): Promise<ManuscriptBindingIdentityResult>;
  getFileRef(fileRefId: EntityId): Promise<FileRef | undefined>;
}

const defaultDependencies: ReviewCurrentFilenameDependencies = {
  async getOwnerState(reviewId) {
    const reviews = await planningService.queryReviewFirstLayerIdentities({
      includeDeleted: true,
      includeArchived: true
    });
    const review = reviews.find((item) => item.id === reviewId);
    return !review ? "missing" : review.deletedAt ? "deleted" : "active";
  },
  resolveIdentity: (reviewId) => manuscriptBindingService.resolveIdentity({
    ownerType: "review",
    ownerId: reviewId,
    manuscriptChannel: "primary"
  }),
  getFileRef: fileRefService.getById
};

function errorDto(
  reviewId: EntityId,
  code: ReviewManuscriptErrorCode,
  message: string,
  currentFileRefId?: EntityId
): ReviewCurrentFilenameDto {
  return {
    status: "error",
    reviewId,
    manuscriptChannel: "primary",
    currentFileRefId,
    error: { code, message }
  };
}

export function createReviewCurrentFilenameService(
  dependencies: ReviewCurrentFilenameDependencies = defaultDependencies
) {
  return {
    async get(reviewId: EntityId): Promise<ReviewCurrentFilenameDto> {
      const ownerState = await dependencies.getOwnerState(reviewId);
      if (ownerState === "missing") {
        return errorDto(
          reviewId,
          REVIEW_MANUSCRIPT_ERROR_CODES.ownerMissing,
          "Review does not exist."
        );
      }
      if (ownerState === "deleted") {
        return errorDto(
          reviewId,
          REVIEW_MANUSCRIPT_ERROR_CODES.ownerDeleted,
          "Review is deleted."
        );
      }

      const identity = await dependencies.resolveIdentity(reviewId);
      if (identity.status === "not-found") {
        return errorDto(
          reviewId,
          REVIEW_MANUSCRIPT_ERROR_CODES.bindingMissing,
          "Review primary manuscript binding does not exist."
        );
      }
      const currentSlot = identity.slots.currentFileRefId;
      if (currentSlot.errors.includes(MANUSCRIPT_BINDING_IDENTITY_ERROR_CODES.ownerMismatch)) {
        return errorDto(
          reviewId,
          REVIEW_MANUSCRIPT_ERROR_CODES.ownerMismatch,
          "Review manuscript binding owner does not match."
        );
      }
      if (currentSlot.errors.includes(MANUSCRIPT_BINDING_IDENTITY_ERROR_CODES.channelMismatch)) {
        return errorDto(
          reviewId,
          REVIEW_MANUSCRIPT_ERROR_CODES.channelMismatch,
          "Review manuscript binding channel must be primary."
        );
      }
      if (!currentSlot.fileRefId) {
        return errorDto(
          reviewId,
          REVIEW_MANUSCRIPT_ERROR_CODES.currentMissing,
          "Review current manuscript is not set."
        );
      }

      const currentFileRefId = currentSlot.fileRefId;
      if (currentSlot.errors.includes(MANUSCRIPT_BINDING_IDENTITY_ERROR_CODES.fileRefDeleted)) {
        return errorDto(
          reviewId,
          REVIEW_MANUSCRIPT_ERROR_CODES.fileRefInactive,
          "Review current manuscript FileRef is inactive.",
          currentFileRefId
        );
      }
      if (currentSlot.errors.includes(MANUSCRIPT_BINDING_IDENTITY_ERROR_CODES.fileRefNotFound)) {
        return errorDto(
          reviewId,
          REVIEW_MANUSCRIPT_ERROR_CODES.fileRefMissing,
          "Review current manuscript FileRef does not exist.",
          currentFileRefId
        );
      }
      if (!identity.identityResolved) {
        return errorDto(
          reviewId,
          REVIEW_MANUSCRIPT_ERROR_CODES.bindingMissing,
          `Review manuscript identity is invalid: ${identity.errors.join(",")}.`,
          currentFileRefId
        );
      }
      const fileRef = await dependencies.getFileRef(currentFileRefId);
      if (!fileRef) {
        return errorDto(
          reviewId,
          REVIEW_MANUSCRIPT_ERROR_CODES.fileRefMissing,
          "Review current manuscript display metadata does not exist.",
          currentFileRefId
        );
      }
      if (!fileRef.path.trim() || !isLikelyAbsoluteLocalPath(fileRef.path)) {
        return errorDto(
          reviewId,
          REVIEW_MANUSCRIPT_ERROR_CODES.pathUnsafe,
          "Review current manuscript path must be absolute.",
          currentFileRefId
        );
      }
      if (!/\.(?:md|markdown)$/iu.test(fileRef.path)) {
        return errorDto(
          reviewId,
          REVIEW_MANUSCRIPT_ERROR_CODES.extensionUnsupported,
          "Review current manuscript must use a Markdown extension.",
          currentFileRefId
        );
      }
      try {
        if (createPathIdentityKey(fileRef.path) !== fileRef.pathIdentityKey) {
          throw new Error("path identity mismatch");
        }
      } catch {
        return errorDto(
          reviewId,
          REVIEW_MANUSCRIPT_ERROR_CODES.pathUnsafe,
          "Review current manuscript path identity is unsafe.",
          currentFileRefId
        );
      }
      const filename = getSafeManuscriptBasename(fileRef.path);
      if (!filename) {
        return errorDto(
          reviewId,
          REVIEW_MANUSCRIPT_ERROR_CODES.pathUnsafe,
          "Review current manuscript filename is unsafe.",
          currentFileRefId
        );
      }
      return {
        status: "ready",
        reviewId,
        manuscriptChannel: "primary",
        currentFileRefId,
        filename
      };
    }
  };
}

export const reviewCurrentFilenameService = createReviewCurrentFilenameService();
