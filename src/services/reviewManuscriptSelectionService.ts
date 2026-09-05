import type { EntityId, FileRefLocationMode, ReviewType } from "../types";
import { extractReviewManuscriptBlocks } from "./reviewManuscriptAdapterService";
import { buildCanonicalFormalSwitchArchiveCandidate } from "./canonicalFormalSwitchArchiveConvergence";
import { fileRefService } from "./fileRefService";
import { createPathIdentityKey } from "./fileRefIdentity";
import { localMarkdownFileService } from "./localMarkdownFileService";
import { managedRootConfigService } from "./managedRootConfigService";
import { getManagedPathParent, isPathWithinDirectory, isPathWithinRoot } from "./managedPathService";
import { manuscriptBindingService } from "./manuscriptBindingService";
import { nativeFileService } from "./nativeFileService";
import { nativeManuscriptIoService } from "./nativeManuscriptIoService";
import { planningService } from "./planningService";

export interface ReviewWorkspaceFolder {
  fileRefId: EntityId;
  path: string;
  managedRoot: string;
  reviewType: ReviewType;
}

export interface ReviewManuscriptPickerSelection {
  reviewId: EntityId;
  path: string;
  displayName: string;
  locationMode: FileRefLocationMode;
  requestToken: number;
}

export type ReviewManuscriptPickerResult =
  | { status: "success"; selection: ReviewManuscriptPickerSelection }
  | { status: "canceled"; code: "MANUSCRIPT_PICKER_CANCELED"; requestToken: number }
  | { status: "error"; code: string; message: string; requestToken: number };

export type ReviewManuscriptEnsureResult =
  | {
      status: "success" | "skipped";
      fileRefId: EntityId;
      locationMode: FileRefLocationMode;
      requestToken: number;
      formalSwitchPresentation?: Readonly<{
        reviewType: ReviewType;
        fieldActions: readonly Readonly<{
          key: string;
          action: "set" | "clear";
        }>[];
      }>;
    }
  | { status: "error"; code: string; message: string; requestToken: number };

function pickerError(
  requestToken: number,
  code: string,
  message: string
): ReviewManuscriptPickerResult {
  return { status: "error", code, message, requestToken };
}

export async function resolveReviewWorkspaceFolder(
  reviewId: EntityId
): Promise<ReviewWorkspaceFolder> {
  const review = await planningService.getReviewById(reviewId);
  if (!review || review.deletedAt) {
    throw new Error("REVIEW_MANUSCRIPT_OWNER_MISSING: Review does not exist or is inactive.");
  }
  const identity = await manuscriptBindingService.resolveIdentity({
    ownerType: "review",
    ownerId: reviewId,
    manuscriptChannel: "primary"
  });
  const folderFileRefId = identity.slots.defaultFolderFileRefId.fileRefId;
  if (!identity.identityResolved || !folderFileRefId) {
    throw new Error("WORKSPACE_FOLDER_FILE_REF_MISSING: Review workspace is not initialized.");
  }
  const folder = await fileRefService.getById(folderFileRefId);
  if (!folder) {
    throw new Error("WORKSPACE_FOLDER_FILE_REF_MISSING: Review workspace FileRef is inactive.");
  }
  const root = await managedRootConfigService.getStatus();
  if (root.status !== "configured" || !root.managedRoot) {
    throw new Error("WORKSPACE_FOLDER_OUTSIDE_ROOT: Managed root is unavailable.");
  }
  if (!isPathWithinRoot(root.managedRoot, folder.path)) {
    throw new Error("WORKSPACE_FOLDER_OUTSIDE_ROOT: Review workspace is outside the managed root.");
  }
  const validated = await nativeFileService.validateManagedFolder(root.managedRoot, folder.path);
  if (createPathIdentityKey(validated.path) !== createPathIdentityKey(folder.path)) {
    throw new Error("WORKSPACE_FOLDER_OUTSIDE_ROOT: Workspace canonical path identity changed.");
  }
  return {
    fileRefId: folder.id,
    path: validated.path,
    managedRoot: root.managedRoot,
    reviewType: review.reviewType
  };
}

export async function selectReviewManuscript(
  reviewId: EntityId,
  requestToken: number,
  title: string
): Promise<ReviewManuscriptPickerResult> {
  let workspace: ReviewWorkspaceFolder;
  try {
    workspace = await resolveReviewWorkspaceFolder(reviewId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return pickerError(
      requestToken,
      message.match(/[A-Z][A-Z0-9_]+/u)?.[0] ?? "WORKSPACE_FOLDER_INVALID",
      message
    );
  }
  const selected = await localMarkdownFileService.selectMarkdownFile(title, workspace.path);
  if (!selected.ok) {
    if (selected.errorCode === "canceled") {
      return { status: "canceled", code: "MANUSCRIPT_PICKER_CANCELED", requestToken };
    }
    const code = selected.errorCode === "invalid_extension"
      ? "MANUSCRIPT_PICKER_UNSUPPORTED_EXTENSION"
      : selected.errorCode === "not_file"
        ? "MANUSCRIPT_PICKER_TARGET_IS_DIRECTORY"
        : "MANUSCRIPT_PICKER_INVALID_SELECTION";
    return pickerError(requestToken, code, selected.errorCode);
  }
  return {
    status: "success",
    selection: {
      reviewId,
      path: selected.path,
      displayName: selected.fileName,
      locationMode: isPathWithinDirectory(workspace.path, selected.path) ? "managed" : "external",
      requestToken
    }
  };
}

export async function ensureSelectedReviewManuscript(
  selection: ReviewManuscriptPickerSelection
): Promise<ReviewManuscriptEnsureResult> {
  try {
    const workspace = await resolveReviewWorkspaceFolder(selection.reviewId);
    const locationMode = isPathWithinDirectory(workspace.path, selection.path)
      ? "managed"
      : "external";
    if (locationMode !== selection.locationMode) {
      return {
        status: "error",
        code: "MANUSCRIPT_PICKER_STALE",
        message: "The selected Review manuscript location changed before registration.",
        requestToken: selection.requestToken
      };
    }
    const read = await nativeManuscriptIoService.readManuscriptFile({
      filePath: selection.path,
      locationMode,
      configuredRoot: locationMode === "managed" ? workspace.managedRoot : undefined
    });
    if (
      locationMode === "managed" &&
      (!isPathWithinDirectory(workspace.path, read.path) ||
        createPathIdentityKey(getManagedPathParent(read.path)) !==
          createPathIdentityKey(workspace.path))
    ) {
      return {
        status: "error",
        code: "MANUSCRIPT_PICKER_INVALID_SELECTION",
        message: "Review manuscripts must be direct children of the Review workspace.",
        requestToken: selection.requestToken
      };
    }
    const blocks = extractReviewManuscriptBlocks(read.content);
    if (blocks.status === "error") {
      return {
        status: "error",
        code: "MANUSCRIPT_PICKER_INVALID_SELECTION",
        message: blocks.error.message,
        requestToken: selection.requestToken
      };
    }
    const presentationCandidate = buildCanonicalFormalSwitchArchiveCandidate({
      rawMarkdown: read.content,
      descriptorLookupIdentity: {
        ownerType: "review",
        channel: "primary",
        reviewType: workspace.reviewType
      }
    });
    const ensured = await fileRefService.registerFileRef({
      ownerType: "review",
      ownerId: selection.reviewId,
      manuscriptChannel: "primary",
      resourceKind: "file",
      fileRole: "manuscript",
      locationMode,
      fileType: "markdown",
      path: read.path,
      title: read.fileName,
      source: "imported"
    });
    return {
      status: ensured.state === "reused" ? "skipped" : "success",
      fileRefId: ensured.fileRef.id,
      locationMode,
      requestToken: selection.requestToken,
      formalSwitchPresentation: Object.freeze({
        reviewType: workspace.reviewType,
        fieldActions: Object.freeze(presentationCandidate.ok
          ? presentationCandidate.orderedReplacementDto.orderedReplacements.map(
              (replacement) => Object.freeze({
                key: replacement.stableKey,
                action: replacement.action
              })
            )
          : [])
      })
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "error",
      code: message.match(/[A-Z][A-Z0-9_]+/u)?.[0] ?? "MANUSCRIPT_MANAGED_ENSURE_FAILED",
      message,
      requestToken: selection.requestToken
    };
  }
}

export const reviewManuscriptSelectionService = {
  resolveWorkspaceFolder: resolveReviewWorkspaceFolder,
  selectManuscript: selectReviewManuscript,
  ensureSelectedManuscript: ensureSelectedReviewManuscript
};
