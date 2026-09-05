import type { FileRef } from "../../types";

export function isCanonicalExperimentWorkspaceFileRef(
  fileRef: FileRef,
  experimentId: string
) {
  return (
    !fileRef.deletedAt &&
    fileRef.ownerType === "experiment" &&
    fileRef.ownerId === experimentId &&
    fileRef.manuscriptChannel === "primary" &&
    fileRef.resourceKind === "folder" &&
    fileRef.fileRole === "defaultFolder" &&
    fileRef.locationMode === "managed" &&
    fileRef.pathIdentityKey === fileRef.path
  );
}

export function partitionExperimentPathRecords(
  fileRefs: FileRef[],
  experimentId: string,
  defaultFolderFileRefId?: string
) {
  const workspaceFolder = fileRefs.find(
    (fileRef) =>
      fileRef.id === defaultFolderFileRefId &&
      isCanonicalExperimentWorkspaceFileRef(fileRef, experimentId)
  );

  return {
    workspaceFolder,
    attachmentFileRefs: fileRefs.filter(
      (fileRef) =>
        !fileRef.deletedAt &&
        fileRef.ownerType === "experiment" &&
        fileRef.ownerId === experimentId &&
        fileRef.fileRole === "attachment" &&
        (fileRef.resourceKind === "file" || fileRef.resourceKind === "folder")
    )
  };
}

export function isCanonicalExperimentRunWorkspaceFileRef(
  fileRef: FileRef,
  runId: string
) {
  return (
    !fileRef.deletedAt &&
    fileRef.ownerType === "experimentRun" &&
    fileRef.ownerId === runId &&
    fileRef.manuscriptChannel === "primary" &&
    fileRef.resourceKind === "folder" &&
    fileRef.fileRole === "defaultFolder" &&
    fileRef.locationMode === "managed" &&
    fileRef.pathIdentityKey === fileRef.path
  );
}

export function partitionExperimentRunPathRecords(
  fileRefs: FileRef[],
  runId: string
) {
  const canonicalWorkspaceFolders = fileRefs.filter((fileRef) =>
    isCanonicalExperimentRunWorkspaceFileRef(fileRef, runId)
  );
  return {
    workspaceFolder:
      canonicalWorkspaceFolders.length === 1
        ? canonicalWorkspaceFolders[0]
        : undefined,
    attachmentFileRefs: fileRefs.filter(
      (fileRef) =>
        !fileRef.deletedAt &&
        fileRef.ownerType === "experimentRun" &&
        fileRef.ownerId === runId &&
        fileRef.source === "user" &&
        fileRef.fileRole === "attachment" &&
        (fileRef.resourceKind === "file" || fileRef.resourceKind === "folder")
    )
  };
}
