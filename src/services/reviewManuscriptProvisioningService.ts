import type { EntityId } from "../types/common";
import type {
  ProvisionManagedOwnerResult,
  ReviewManuscriptProvisioningResult,
  ReviewProvisioningStepState
} from "../types/provisioning";
import { PROVISIONING_ERROR_CODES } from "../types/provisioning";
import { managedFileProvisioningService } from "./managedFileProvisioningService";
import { MANUSCRIPT_BLANK_INITIAL_CONTENT } from "./manuscriptBlankBody";
import type {
  ValidatedPlanningAuthority,
  ValidatedPlanningAuthorityHandle
} from "./planningOwnerAuthorityPort";
import {
  runWithProvisioningAuthority,
  toProvisioningAuthorityIssue
} from "./provisioningAuthorityGuard";

export const REVIEW_MANUSCRIPT_FILE_NAME = "review.md";
export const REVIEW_MANUSCRIPT_CHANNEL = "primary" as const;
export const REVIEW_MANUSCRIPT_INITIAL_CONTENT = MANUSCRIPT_BLANK_INITIAL_CONTENT;

interface ReviewProvisioningAuthorityProjection {
  reviewId: EntityId;
  reviewTitle: string;
  reviewCreatedAt: string;
  projectId: EntityId;
  projectTitle: string;
}

export interface ReviewManuscriptProvisioningDependencies {
  withAuthority<T>(
    reviewId: EntityId,
    use: (
      projection: ReviewProvisioningAuthorityProjection,
      permit?: ValidatedPlanningAuthorityHandle,
      authority?: ValidatedPlanningAuthority
    ) => Promise<T>
  ): Promise<T>;
  provision(input: {
    ownerType: "review";
    ownerId: EntityId;
    ownerTitle: string;
    createdAt: string;
    projectId: EntityId;
    projectTitle: string;
    source: "system";
    manuscriptChannel: "primary";
    manuscriptFileName: "review.md";
    manuscriptDisplayName: string;
    initialContent: string;
  },
  permit?: ValidatedPlanningAuthorityHandle,
  authority?: ValidatedPlanningAuthority): Promise<ProvisionManagedOwnerResult>;
}

const defaultDependencies: ReviewManuscriptProvisioningDependencies = {
  withAuthority: (reviewId, use) =>
    runWithProvisioningAuthority({
      request: {
        intent: "provisioningWrite",
        requestId: `review-provisioning-${reviewId}`,
        ownerType: "review",
        ownerId: reviewId,
        scope: REVIEW_MANUSCRIPT_CHANNEL
      },
      write: (permit, authority) => {
        if (
          authority.ownerId !== reviewId ||
          authority.ownerType !== "review" ||
          !authority.projectId ||
          typeof authority.projectTitle !== "string" ||
          typeof authority.ownerTitle !== "string" ||
          typeof authority.ownerCreatedAt !== "string"
        ) {
          throw new Error("PLANNING_AUTHORITY_REVIEW_PROJECTION_INCOMPLETE");
        }
        return use({
          reviewId,
          reviewTitle: authority.ownerTitle,
          reviewCreatedAt: authority.ownerCreatedAt,
          projectId: authority.projectId,
          projectTitle: authority.projectTitle
        }, permit, authority);
      }
    }),
  provision: (input, permit, authority) =>
    managedFileProvisioningService.provision(input, permit, authority)
};

function metadataState(
  value: ProvisionManagedOwnerResult["folderFileRefState"]
): ReviewProvisioningStepState {
  if (value === "created") return "created";
  if (value === "reused") return "reused";
  return "missing";
}

function wrapProvisioningResult(
  result: ProvisionManagedOwnerResult,
  reviewRecord: ReviewProvisioningStepState = "reused"
): ReviewManuscriptProvisioningResult {
  const completionState = result.status === "success" || result.status === "skipped"
    ? "complete"
    : result.status === "partial"
      ? "partial"
      : "failed";
  const failed = completionState === "failed" ? "failed" : "missing";
  return {
    ...result,
    completionState,
    steps: {
      reviewRecord,
      workspace: result.createdFolder ? "created" : result.reusedFolder ? "reused" : failed,
      defaultFile: result.createdBody ? "created" : result.reusedBody ? "reused" : failed,
      folderFileRef: result.defaultFolderFileRef ? metadataState(result.folderFileRefState) : failed,
      manuscriptFileRef: result.defaultManuscriptFileRef
        ? metadataState(result.manuscriptFileRefState)
        : failed,
      binding: result.binding
        ? result.bindingState === "created" ? "created" : "reused"
        : failed,
      current: result.binding?.currentFileRefId
        ? result.currentState === "initialized" ? "created" : "reused"
        : failed
    },
    physicalFilePresent: result.createdBody || result.reusedBody,
    metadataGap: !result.defaultFolderFileRef || !result.defaultManuscriptFileRef ||
      !result.binding || !result.binding.currentFileRefId
  };
}

function failedResult(
  reviewId: EntityId,
  code: string,
  message: string,
  step: string,
  reviewRecord: ReviewProvisioningStepState,
  retryable = false
): ReviewManuscriptProvisioningResult {
  return wrapProvisioningResult({
    status: "error",
    ownerType: "review",
    ownerId: reviewId,
    createdFolder: false,
    createdBody: false,
    reusedFolder: false,
    reusedBody: false,
    warnings: [],
    errors: [{ code, message, step }],
    completedSteps: reviewRecord === "reused" ? ["review-record"] : [],
    failedStep: step,
    retryable
  }, reviewRecord);
}

export function createReviewManuscriptProvisioningService(
  dependencies: ReviewManuscriptProvisioningDependencies = defaultDependencies
) {
  return {
    async ensureReviewManuscriptProvisioning(
      reviewId: EntityId,
      options: { reviewRecordState?: "created" | "reused" } = {}
    ): Promise<ReviewManuscriptProvisioningResult> {
      const reviewRecordState = options.reviewRecordState ?? "reused";
      try {
        return await dependencies.withAuthority(
          reviewId,
          async (projection, permit, authority) => {
            const result = await dependencies.provision({
              ownerType: "review",
              ownerId: projection.reviewId,
              ownerTitle: projection.reviewTitle,
              createdAt: projection.reviewCreatedAt,
              projectId: projection.projectId,
              projectTitle: projection.projectTitle,
              source: "system",
              manuscriptChannel: REVIEW_MANUSCRIPT_CHANNEL,
              manuscriptFileName: REVIEW_MANUSCRIPT_FILE_NAME,
              manuscriptDisplayName: "复盘文稿",
              initialContent: REVIEW_MANUSCRIPT_INITIAL_CONTENT
            }, permit, authority);
            return wrapProvisioningResult(result, reviewRecordState);
          }
        );
      } catch (error) {
        const issue = toProvisioningAuthorityIssue(error);
        if (issue.status === "NotFound") {
          return failedResult(
            reviewId,
            PROVISIONING_ERROR_CODES.ownerNotFound,
            issue.message,
            "review-record",
            "missing"
          );
        }
        if (issue.status === "Deleted") {
          return failedResult(
            reviewId,
            PROVISIONING_ERROR_CODES.ownerDeleted,
            issue.message,
            "review-record",
            "reused"
          );
        }
        if (
          issue.status === "ProjectUnavailable" ||
          issue.status === "OwnerProjectMismatch"
        ) {
          return failedResult(
            reviewId,
            PROVISIONING_ERROR_CODES.projectNotFound,
            issue.message,
            "project-validation",
            "reused"
          );
        }
        return failedResult(
          reviewId,
          issue.code,
          issue.message,
          "authority-admission",
          "reused",
          issue.retryable
        );
      }
    }
  };
}

export const reviewManuscriptProvisioningService =
  createReviewManuscriptProvisioningService();

export const ensureReviewManuscriptProvisioning = (
  reviewId: EntityId,
  options?: { reviewRecordState?: "created" | "reused" }
) => reviewManuscriptProvisioningService.ensureReviewManuscriptProvisioning(reviewId, options);
