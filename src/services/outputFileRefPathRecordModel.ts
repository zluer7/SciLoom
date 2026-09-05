import type { FileRef } from "../types/experiment";
import type { OutputFileRefOwnerType } from "../types/outputFileRef";
import { summarizePath } from "./localPathService";

const OUTPUT_PATH_RECORD_OWNER_TYPES: readonly OutputFileRefOwnerType[] = [
  "resultItem",
  "finding",
  "outputCandidate",
  "outputGap",
  "researchOutput"
];

export type OutputFileRefPathRecordView = {
  fileRef: FileRef;
  kind: "workspace" | "file" | "folder";
  title: string;
  pathSummary: string;
  canOpen: boolean;
  canReveal: boolean;
  canCopy: boolean;
  canEdit: boolean;
  canDelete: boolean;
};

function assertOutputOwner(fileRef: FileRef) {
  if (!OUTPUT_PATH_RECORD_OWNER_TYPES.includes(fileRef.ownerType as OutputFileRefOwnerType)) {
    throw new Error(`Unsupported Outputs FileRef owner: ${fileRef.ownerType}.`);
  }
}

function stableRecordOrder(fileRef: FileRef) {
  if (fileRef.fileRole === "defaultFolder") return 0;
  if (fileRef.resourceKind === "file") return 1;
  return 2;
}

export function buildOutputFileRefPathRecordViews(
  fileRefs: readonly FileRef[],
  labels: { workspace: string }
): OutputFileRefPathRecordView[] {
  const visible = fileRefs
    .filter((fileRef) => !fileRef.deletedAt && fileRef.fileRole !== "manuscript")
    .map((fileRef) => {
      assertOutputOwner(fileRef);
      if (fileRef.fileRole === "defaultFolder") {
        return {
          fileRef,
          kind: "workspace" as const,
          title: labels.workspace,
          pathSummary: summarizePath(fileRef.path),
          canOpen: false,
          canReveal: true,
          canCopy: true,
          canEdit: false,
          canDelete: false
        };
      }
      const isFolder = fileRef.resourceKind === "folder";
      return {
        fileRef,
        kind: isFolder ? "folder" as const : "file" as const,
        title: fileRef.title,
        pathSummary: summarizePath(fileRef.path),
        canOpen: !isFolder,
        canReveal: true,
        canCopy: true,
        canEdit: true,
        canDelete: true
      };
    });

  return visible.sort((left, right) => {
    const rank = stableRecordOrder(left.fileRef) - stableRecordOrder(right.fileRef);
    if (rank) return rank;
    const created = left.fileRef.createdAt.localeCompare(right.fileRef.createdAt);
    return created || left.fileRef.id.localeCompare(right.fileRef.id);
  });
}

