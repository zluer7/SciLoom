import type { EntityId } from "../types";
import type { CreateFileRefInput, FileRef } from "../types/experiment";

export type ReviewFileRefPathMaterialSummary = {
  fileRefId: EntityId;
  title: string;
  fileType: string;
  notes?: string;
  displayName: string;
  pathSummary: string;
  isExternalPath: true;
  hasFullPath: boolean;
  safetyBoundary: "path_metadata_only";
};

export type CreateReviewFileRefInput = Omit<
  CreateFileRefInput,
  "ownerType" | "ownerId"
>;

function normalizePathInput(path: string) {
  const trimmed = path.trim();
  if (!/^file:\/\//i.test(trimmed)) {
    return trimmed;
  }

  const withoutScheme = trimmed.slice("file://".length);
  if (/^\/[A-Za-z]:[\\/]/.test(withoutScheme)) {
    return withoutScheme.slice(1);
  }
  if (/^[A-Za-z]:[\\/]/.test(withoutScheme) || withoutScheme.startsWith("/")) {
    return withoutScheme;
  }
  return `//${withoutScheme}`;
}

function pathSegments(path: string) {
  return normalizePathInput(path)
    .replace(/[\\/]+$/, "")
    .split(/[\\/]+/)
    .filter(Boolean);
}

function preferredSeparator(path: string) {
  const normalized = normalizePathInput(path);
  return normalized.includes("\\") && !normalized.includes("/") ? "\\" : "/";
}

function getPathDisplayName(path: string) {
  const normalized = normalizePathInput(path);
  const segments = pathSegments(normalized);
  return segments[segments.length - 1] ?? normalized;
}

function summarizePath(path: string) {
  const normalized = normalizePathInput(path);
  if (!normalized) {
    return "";
  }

  const segments = pathSegments(normalized);
  if (segments.length === 0) {
    return "";
  }
  if (segments.length === 1) {
    return segments[0];
  }

  const separator = preferredSeparator(normalized);
  return `…${separator}${segments.slice(-2).join(separator)}`;
}

export function buildReviewFileRefCreateInput(
  reviewId: EntityId,
  input: CreateReviewFileRefInput
): CreateFileRefInput {
  return {
    ...input,
    ownerType: "review",
    ownerId: reviewId
  };
}

function assertReviewFileRef(fileRef: FileRef) {
  if (fileRef.ownerType !== "review") {
    throw new Error(
      `Review FileRef contract violation: expected ownerType review, got ${fileRef.ownerType}.`
    );
  }
}

export function toReviewFileRefPathMaterialSummary(
  fileRef: FileRef
): ReviewFileRefPathMaterialSummary {
  assertReviewFileRef(fileRef);
  return {
    fileRefId: fileRef.id,
    title: fileRef.title,
    fileType: fileRef.fileType,
    notes: fileRef.description,
    displayName: getPathDisplayName(fileRef.path),
    pathSummary: summarizePath(fileRef.path),
    isExternalPath: true,
    hasFullPath: Boolean(fileRef.path?.trim()),
    safetyBoundary: "path_metadata_only"
  };
}

