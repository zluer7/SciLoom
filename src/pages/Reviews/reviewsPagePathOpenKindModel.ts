type LocalFileOpenKind = "file" | "folder" | "unknown";

export type ReviewPathOpenKindDependencies = {
  resolveFileRefOpenKind: (
    fileType: string | undefined,
    path: string | undefined
  ) => "file" | "folder";
  isWindowsFileFallbackEligible: (
    actionType: "open_path",
    options: { openKind: LocalFileOpenKind }
  ) => boolean;
};

export type ReviewPathActionFileRef = {
  path: string;
  fileType?: string;
};

export type ReviewPathOpenActionModel = {
  actionPath: string;
  displayPathSummary: string;
  openKind: LocalFileOpenKind;
  windowsFileFallbackEligible: boolean;
};

export function resolveReviewFileRefOpenKind(
  fileRef: ReviewPathActionFileRef | null | undefined,
  dependencies: Pick<ReviewPathOpenKindDependencies, "resolveFileRefOpenKind">
): LocalFileOpenKind {
  const path = fileRef?.path.trim() ?? "";
  const fileType = fileRef?.fileType?.trim() ?? "";
  if (!path) {
    return "unknown";
  }
  if (fileType === "data_folder" || /[\\/]$/.test(path)) {
    return "folder";
  }
  if (/(?:^|[\\/])[^\\/]+\.[^\\/.]+$/.test(path)) {
    return dependencies.resolveFileRefOpenKind(fileType, path);
  }
  if (fileType && fileType !== "review_material") {
    return dependencies.resolveFileRefOpenKind(fileType, path);
  }
  return "unknown";
}

export function buildReviewPathOpenActionModel(
  fileRef: ReviewPathActionFileRef | null | undefined,
  pathSummary: string,
  dependencies: ReviewPathOpenKindDependencies
): ReviewPathOpenActionModel {
  const openKind = resolveReviewFileRefOpenKind(fileRef, dependencies);
  return {
    actionPath: fileRef?.path ?? "",
    displayPathSummary: pathSummary,
    openKind,
    windowsFileFallbackEligible: dependencies.isWindowsFileFallbackEligible("open_path", {
      openKind
    })
  };
}
