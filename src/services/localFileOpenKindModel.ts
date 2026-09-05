type CommonFileExtension =
  | ".csv"
  | ".doc"
  | ".docx"
  | ".json"
  | ".m"
  | ".md"
  | ".pdf"
  | ".py"
  | ".txt"
  | ".xls"
  | ".xlsx"
  | ".zip"
  | ".png"
  | ".jpg"
  | ".jpeg"
  | ".gif"
  | ".tif"
  | ".tiff"
  | ".bmp"
  | ".svg"
  | ".rtf"
  | ".ppt"
  | ".pptx"
  | ".log"
  | ".mat"
  | ".tdms"
  | ".npy"
  | ".npz"
  | ".h5"
  | ".hdf5";

type ResolvedOpenKindForPath<
  FileType extends string | undefined,
  Path extends string | undefined
> = Path extends string
  ? Lowercase<Path> extends `${string}${CommonFileExtension}`
    ? "file"
    : FileType extends "data_folder"
      ? "folder"
      : "file"
  : FileType extends "data_folder"
    ? "folder"
    : "file";

const commonFileExtensions = new Set<string>([
  ".csv",
  ".doc",
  ".docx",
  ".json",
  ".m",
  ".md",
  ".pdf",
  ".py",
  ".txt",
  ".xls",
  ".xlsx",
  ".zip",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".tif",
  ".tiff",
  ".bmp",
  ".svg",
  ".rtf",
  ".ppt",
  ".pptx",
  ".log",
  ".mat",
  ".tdms",
  ".npy",
  ".npz",
  ".h5",
  ".hdf5"
]);

function extensionFromPath(path: string | undefined) {
  const normalized = (path ?? "").trim().replace(/^(['"])(.*)\1$/, "$2").replace(/[\\/]+$/, "");
  const segments = normalized.split(/[\\/]+/).filter(Boolean);
  const fileName = segments[segments.length - 1] ?? normalized;
  return fileName.match(/(\.[^./\\]+)$/)?.[1]?.toLowerCase();
}

export function resolveFileRefOpenKind<
  const FileType extends string | undefined,
  const Path extends string | undefined
>(fileType: FileType, path: Path): ResolvedOpenKindForPath<FileType, Path>;
export function resolveFileRefOpenKind(
  fileType: string | undefined,
  path: string | undefined
): "file" | "folder" {
  const extension = extensionFromPath(path);
  if (extension && commonFileExtensions.has(extension)) {
    return "file";
  }
  return fileType === "data_folder" ? "folder" : "file";
}

export function isWindowsFileFallbackEligible(
  actionType: "open_path" | "open_file" | "open_folder",
  options: { openKind?: "file" | "folder" | "unknown" }
) {
  return actionType === "open_file" || options.openKind === "file";
}
