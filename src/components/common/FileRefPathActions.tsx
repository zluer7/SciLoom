import { fileRefService } from "../../services/fileRefService";
import type { LocalFileOpenKind, LocalFileResult } from "../../types/localFile";
import type { FileRefResourceKind } from "../../types";

export type FileRefPathActionLabels = {
  open: string;
  reveal: string;
  copy: string;
};

export type FileRefPathActionsProps = {
  path?: string | null;
  openKind?: LocalFileOpenKind;
  resourceKind?: FileRefResourceKind;
  disabled?: boolean;
  labels: FileRefPathActionLabels;
  onResult?: (result: LocalFileResult) => void;
};

export function FileRefPathActions({
  path,
  openKind = "unknown",
  resourceKind,
  disabled = false,
  labels,
  onResult
}: FileRefPathActionsProps) {
  const normalizedPath = path?.trim() ?? "";
  const isDisabled = disabled || !normalizedPath;

  async function handleOpenPath() {
    let result: LocalFileResult;
    if (openKind === "file") {
      result = await fileRefService.openFile(normalizedPath);
    } else if (openKind === "folder") {
      result = await fileRefService.openFolder(normalizedPath);
    } else {
      result = await fileRefService.openPath(normalizedPath, { openKind });
    }

    onResult?.(result);
  }

  async function handleRevealPath() {
    onResult?.(
      resourceKind === "folder"
        ? await fileRefService.openFolder(normalizedPath)
        : await fileRefService.locatePath(normalizedPath)
    );
  }

  async function handleCopyPath() {
    onResult?.(await fileRefService.copyPath(normalizedPath));
  }

  return (
    <div className="file-ref-path-actions">
      {resourceKind !== "folder" ? (
        <button type="button" disabled={isDisabled} onClick={() => void handleOpenPath()}>
          {labels.open}
        </button>
      ) : null}
      <button type="button" disabled={isDisabled} onClick={() => void handleRevealPath()}>
        {labels.reveal}
      </button>
      <button type="button" disabled={isDisabled} onClick={() => void handleCopyPath()}>
        {labels.copy}
      </button>
    </div>
  );
}
