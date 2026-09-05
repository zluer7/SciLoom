import type { EntityId, FileRef, ManuscriptBindingIdentityResult } from "../types";
import { REVIEW_MANUSCRIPT_ERROR_CODES } from "../types/reviewManuscript";
import { fileRefService } from "./fileRefService";
import { manuscriptBindingService } from "./manuscriptBindingService";
import { planningService } from "./planningService";
import { reviewCurrentFilenameService } from "./reviewCurrentFilenameService";
import { classifyManuscriptProvisioningIssue } from "./manuscriptProvisioningContract";
import type {
  ManuscriptProvisioningIssue,
  ManuscriptProvisioningIssueKind
} from "../types/manuscriptProvisioning";

export type ReviewManuscriptPageStatus =
  | "ready"
  | "partial"
  | "missing"
  | "repair-required"
  | "failed";

export interface ReviewManuscriptPageState {
  reviewId: EntityId;
  workspaceStatus: ReviewManuscriptPageStatus;
  currentStatus: ReviewManuscriptPageStatus;
  provisioningStatus: ReviewManuscriptPageStatus;
  currentFilename?: string;
  currentFileRefId?: EntityId;
  workspaceFolder?: FileRef;
  warning?: string;
  canOpenCurrent: boolean;
  canRetryProvisioning: boolean;
  issue?: ReviewManuscriptPageIssue;
}

export type ReviewManuscriptPageIssue = ManuscriptProvisioningIssue & {
  kind: ManuscriptProvisioningIssueKind;
  ownerType: "review";
  ownerId: EntityId;
  manuscriptChannel: "primary";
  action: "review.provisioning.retry";
};

export interface ReviewManuscriptPageStateDependencies {
  getReview(reviewId: EntityId): ReturnType<typeof planningService.getReviewById>;
  getIdentity(reviewId: EntityId): Promise<ManuscriptBindingIdentityResult>;
  getFileRef(fileRefId: EntityId): Promise<FileRef | undefined>;
  getCurrent(reviewId: EntityId): ReturnType<typeof reviewCurrentFilenameService.get>;
}

const defaultDependencies: ReviewManuscriptPageStateDependencies = {
  getReview: planningService.getReviewById,
  getIdentity: (reviewId) => manuscriptBindingService.resolveIdentity({
    ownerType: "review",
    ownerId: reviewId,
    manuscriptChannel: "primary"
  }),
  getFileRef: fileRefService.getById,
  getCurrent: reviewCurrentFilenameService.get
};

function currentStatusFor(code: string): ReviewManuscriptPageStatus {
  if (
    code === REVIEW_MANUSCRIPT_ERROR_CODES.ownerMissing ||
    code === REVIEW_MANUSCRIPT_ERROR_CODES.ownerDeleted
  ) {
    return "failed";
  }
  if (
    code === REVIEW_MANUSCRIPT_ERROR_CODES.fileRefMissing ||
    code === REVIEW_MANUSCRIPT_ERROR_CODES.fileRefInactive ||
    code === REVIEW_MANUSCRIPT_ERROR_CODES.fileMissing ||
    code === REVIEW_MANUSCRIPT_ERROR_CODES.pathUnsafe ||
    code === REVIEW_MANUSCRIPT_ERROR_CODES.ownerMismatch ||
    code === REVIEW_MANUSCRIPT_ERROR_CODES.channelMismatch ||
    code === REVIEW_MANUSCRIPT_ERROR_CODES.resourceKindMismatch ||
    code === REVIEW_MANUSCRIPT_ERROR_CODES.fileRoleMismatch
  ) {
    return "repair-required";
  }
  return code === REVIEW_MANUSCRIPT_ERROR_CODES.bindingMissing
    ? "missing"
    : "partial";
}

function issueKindFor(code: string): ManuscriptProvisioningIssueKind {
  switch (code) {
    case REVIEW_MANUSCRIPT_ERROR_CODES.ownerDeleted:
      return "owner-deleted";
    case REVIEW_MANUSCRIPT_ERROR_CODES.ownerMismatch:
    case REVIEW_MANUSCRIPT_ERROR_CODES.channelMismatch:
    case REVIEW_MANUSCRIPT_ERROR_CODES.resourceKindMismatch:
    case REVIEW_MANUSCRIPT_ERROR_CODES.fileRoleMismatch:
    case REVIEW_MANUSCRIPT_ERROR_CODES.pathUnsafe:
      return "identity-conflict";
    case REVIEW_MANUSCRIPT_ERROR_CODES.fileRefInactive:
    case REVIEW_MANUSCRIPT_ERROR_CODES.fileMissing:
      return "canonical-resource-missing";
    case REVIEW_MANUSCRIPT_ERROR_CODES.bindingMissing:
    case REVIEW_MANUSCRIPT_ERROR_CODES.currentMissing:
    case REVIEW_MANUSCRIPT_ERROR_CODES.fileRefMissing:
      return "transient";
    default:
      return "transient";
  }
}

function pageIssue(
  reviewId: EntityId,
  code: string,
  kind: ManuscriptProvisioningIssueKind = issueKindFor(code)
): ReviewManuscriptPageIssue {
  return {
    ...classifyManuscriptProvisioningIssue({ kind, causeCode: code }),
    kind,
    ownerType: "review",
    ownerId: reviewId,
    manuscriptChannel: "primary",
    action: "review.provisioning.retry"
  };
}

export function createReviewManuscriptPageStateService(
  dependencies: ReviewManuscriptPageStateDependencies = defaultDependencies
) {
  return {
    async get(reviewId: EntityId): Promise<ReviewManuscriptPageState> {
      const [review, identity, current] = await Promise.all([
        dependencies.getReview(reviewId),
        dependencies.getIdentity(reviewId),
        dependencies.getCurrent(reviewId)
      ]);
      const folderId = identity.slots.defaultFolderFileRefId.fileRefId;
      const resolvedFolder = identity.identityResolved && folderId
        ? await dependencies.getFileRef(folderId)
        : undefined;
      const workspaceFolder = resolvedFolder;
      if (!review || review.deletedAt) {
        const issue = pageIssue(
          reviewId,
          review?.deletedAt
            ? REVIEW_MANUSCRIPT_ERROR_CODES.ownerDeleted
            : REVIEW_MANUSCRIPT_ERROR_CODES.ownerMissing,
          review?.deletedAt ? "owner-deleted" : "identity-conflict"
        );
        return {
          reviewId,
          workspaceStatus: "failed",
          currentStatus: "failed",
          provisioningStatus: "failed",
          warning: "复盘不存在或已删除。",
          canOpenCurrent: false,
          canRetryProvisioning: false,
          issue
        };
      }
      if (current.status === "ready" && workspaceFolder) {
        return {
          reviewId,
          workspaceStatus: "ready",
          currentStatus: "ready",
          provisioningStatus: "ready",
          currentFilename: current.filename,
          currentFileRefId: current.currentFileRefId,
          workspaceFolder,
          canOpenCurrent: true,
          canRetryProvisioning: false
        };
      }
      const currentStatus = current.status === "ready"
        ? "ready"
        : currentStatusFor(current.error.code);
      const workspaceStatus = workspaceFolder ? "ready" : "missing";
      const provisioningStatus = currentStatus === "failed"
        ? "failed"
        : currentStatus === "repair-required"
          ? "repair-required"
          : workspaceFolder || current.status === "ready"
            ? "partial"
            : "missing";
      const issue = current.status === "error"
        ? pageIssue(reviewId, current.error.code)
        : pageIssue(
            reviewId,
            "REVIEW_PROVISIONING_DEFAULT_FOLDER_MISSING",
            "transient"
          );
      return {
        reviewId,
        workspaceStatus,
        currentStatus,
        provisioningStatus,
        currentFilename: current.status === "ready" ? current.filename : undefined,
        currentFileRefId: current.currentFileRefId,
        workspaceFolder,
        warning: current.status === "error" ? current.error.message : "复盘工作目录尚未就绪。",
        canOpenCurrent: current.status === "ready" && Boolean(workspaceFolder),
        canRetryProvisioning: issue.retryable,
        issue
      };
    }
  };
}

export const reviewManuscriptPageStateService = createReviewManuscriptPageStateService();
