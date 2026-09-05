import { fileRefService } from "../../services/fileRefService";
import type { LocalFileResult } from "../../types/localFile";

export type FileRefPathPickerLabels = {
  selectFile: string;
  selectFolder: string;
};

export type FileRefPathPickerProps = {
  disabled?: boolean;
  labels: FileRefPathPickerLabels;
  onResult: (result: LocalFileResult) => void;
};

export function FileRefPathPicker({
  disabled = false,
  labels,
  onResult
}: FileRefPathPickerProps) {
  async function handleSelectFile() {
    onResult(await fileRefService.selectFile());
  }

  async function handleSelectFolder() {
    onResult(await fileRefService.selectFolder());
  }

  return (
    <div className="file-ref-path-picker">
      <button type="button" disabled={disabled} onClick={() => void handleSelectFile()}>
        {labels.selectFile}
      </button>
      <button type="button" disabled={disabled} onClick={() => void handleSelectFolder()}>
        {labels.selectFolder}
      </button>
    </div>
  );
}
