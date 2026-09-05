import { invoke } from "@tauri-apps/api/core";
import type {
  LocalMarkdownFileSelectionResult,
  LocalMarkdownReadErrorCode,
  LocalMarkdownReadResult,
  LocalMarkdownSaveErrorCode,
  MarkdownSavePathSelectionRequest,
  LocalMarkdownSavePathResult,
  LocalMarkdownSaveResult
} from "../types/localMarkdownFile";
import { localFileService } from "./localFileService";
import { MANAGED_PATH_LIMITS } from "./managedPathService";
import {
  getPathDisplayName,
  isLikelyAbsoluteLocalPath,
  normalizePathInput,
  summarizePath
} from "./localPathService";

type NativeMarkdownReadResult = {
  content: string;
  fileName: string;
  sizeBytes: number;
};

type NativeMarkdownSaveResult = {
  fileName: string;
  sizeBytes: number;
  overwritten: boolean;
};

type NativeMarkdownSavePath =
  | { status: "SELECTED"; path: string; requestToken: string }
  | { status: "CANCELLED"; requestToken: string }
  | { status: "BUSY"; requestToken: string }
  | { status: "CAPABILITY_DENIED" }
  | { status: "DIALOG_FAILED" }
  | { status: "PATH_INVALID"; requestToken?: string };

interface MarkdownSavePathSelectorDependencies {
  isDesktopRuntime(): boolean;
  invokeSelection(input: {
    title: string;
    defaultFileName: string;
    defaultDirectory: string;
    requestToken: string;
  }): Promise<NativeMarkdownSavePath>;
}

const markdownExtensions = [".md", ".markdown"];

export const MARKDOWN_SAVE_PATH_FILTER = Object.freeze({
  name: "Markdown" as const,
  extensions: ["md", "markdown"] as const
});

function isMarkdownPath(path: string) {
  const lowerPath = normalizePathInput(path).toLowerCase();
  return markdownExtensions.some((extension) => lowerPath.endsWith(extension));
}

function errorCodeFromUnknown(error: unknown): LocalMarkdownReadErrorCode {
  const message = String(error).toLowerCase();
  if (message.includes("manuscript_extension_unsupported")) return "invalid_extension";
  if (message.includes("manuscript_file_not_found")) return "path_not_found";
  if (message.includes("manuscript_path_is_directory")) return "not_file";
  if (message.includes("manuscript_file_too_large")) return "file_too_large";
  if (message.includes("manuscript_encoding_invalid")) return "invalid_utf8";
  if (message.includes("manuscript_read_failed") || message.includes("manuscript_symlink_not_allowed")) {
    return "read_failed";
  }
  const knownCodes: LocalMarkdownReadErrorCode[] = [
    "empty_path",
    "invalid_extension",
    "path_not_found",
    "not_file",
    "file_too_large",
    "invalid_utf8",
    "read_failed"
  ];
  return knownCodes.find((code) => message.includes(code)) ?? "unknown";
}

function saveErrorCodeFromUnknown(error: unknown): LocalMarkdownSaveErrorCode {
  const message = String(error).toLowerCase();
  const knownCodes: LocalMarkdownSaveErrorCode[] = [
    "empty_path",
    "invalid_extension",
    "path_exists_requires_confirm",
    "parent_not_found",
    "not_file_target",
    "content_too_large",
    "write_failed"
  ];
  return knownCodes.find((code) => message.includes(code)) ?? "unknown";
}

export function sanitizeMarkdownFileName(value: string) {
  const sanitized = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/[.\s]+$/g, "")
    .trim()
    .slice(0, 120);
  const baseName = sanitized || "labpod-notes";
  return isMarkdownPath(baseName) ? baseName : `${baseName}.md`;
}

export async function selectMarkdownFile(
  title = "Select a Markdown file",
  defaultPath?: string
): Promise<LocalMarkdownFileSelectionResult> {
  const selected = await localFileService.selectFile({
    title,
    multiple: false,
    filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
    defaultPath
  });

  if (!selected.ok) {
    return {
      ok: false,
      errorCode: selected.errorCode === "canceled"
        ? "canceled"
        : selected.errorCode === "not_desktop"
          ? "not_desktop"
          : "unknown"
    };
  }

  const path = normalizePathInput(selected.path ?? "");
  if (!path) return { ok: false, errorCode: "empty_path" };
  if (!isMarkdownPath(path)) return { ok: false, errorCode: "invalid_extension" };

  return {
    ok: true,
    path,
    fileName: getPathDisplayName(path)
  };
}

export async function readMarkdownFile(path: string): Promise<LocalMarkdownReadResult> {
  if (!localFileService.isDesktopRuntime()) {
    return { ok: false, errorCode: "not_desktop" };
  }

  const normalizedPath = normalizePathInput(path);
  if (!normalizedPath) return { ok: false, errorCode: "empty_path" };
  if (!isMarkdownPath(normalizedPath)) {
    return { ok: false, errorCode: "invalid_extension" };
  }

  try {
    const result = await invoke<NativeMarkdownReadResult>("read_markdown_file", {
      filePath: normalizedPath,
      locationMode: "external"
    });
    return {
      ok: true,
      content: result.content,
      fileName: result.fileName,
      sizeBytes: result.sizeBytes
    };
  } catch (error) {
    return { ok: false, errorCode: errorCodeFromUnknown(error) };
  }
}

function isTypedSelectionInvokeFailure(
  error: unknown
): error is { code: "CAPABILITY_DENIED" | "DIALOG_FAILED" } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "CAPABILITY_DENIED" || error.code === "DIALOG_FAILED")
  );
}

function validateSelectedMarkdownPath(
  pathInput: string,
  requestToken: string
): LocalMarkdownSavePathResult {
  const path = normalizePathInput(pathInput);
  if (
    !path ||
    !isLikelyAbsoluteLocalPath(path) ||
    path.length > MANAGED_PATH_LIMITS.maximumAbsolutePath ||
    !isMarkdownPath(path)
  ) {
    return {
      status: "PATH_INVALID",
      requestToken,
      fileName: path ? getPathDisplayName(path) : undefined
    };
  }
  return {
    status: "SELECTED",
    path,
    fileName: getPathDisplayName(path),
    requestToken,
    rawNativeSelectedPath: pathInput,
    normalizedSelectedPath: path
  };
}

export function createMarkdownSavePathSelector(
  dependencies: MarkdownSavePathSelectorDependencies
) {
  return async function selectMarkdownSavePath(
    request: MarkdownSavePathSelectionRequest
  ): Promise<LocalMarkdownSavePathResult> {
    if (!dependencies.isDesktopRuntime()) {
      return { status: "DIALOG_FAILED" };
    }
    if (!request.requestToken.trim() || !request.defaultDirectory.trim()) {
      return { status: "PATH_INVALID", requestToken: request.requestToken };
    }

    try {
      const selected = await dependencies.invokeSelection({
        title: request.title,
        defaultFileName: sanitizeMarkdownFileName(request.suggestedFileName),
        defaultDirectory: normalizePathInput(request.defaultDirectory),
        requestToken: request.requestToken
      });
      if (
        "requestToken" in selected &&
        selected.requestToken !== request.requestToken
      ) {
        return { status: "DIALOG_FAILED" };
      }
      if (selected.status === "CANCELLED" || selected.status === "BUSY") {
        return selected;
      }
      if (selected.status === "CAPABILITY_DENIED") return selected;
      if (selected.status === "DIALOG_FAILED") return selected;
      if (selected.status === "PATH_INVALID") return selected;
      return validateSelectedMarkdownPath(selected.path, selected.requestToken);
    } catch (error) {
      return isTypedSelectionInvokeFailure(error)
        ? { status: error.code }
        : { status: "DIALOG_FAILED" };
    }
  };
}

export const selectMarkdownSavePath = createMarkdownSavePathSelector({
  isDesktopRuntime: () => localFileService.isDesktopRuntime(),
  invokeSelection: (input) =>
    invoke<NativeMarkdownSavePath>("select_markdown_save_path", input)
});

export async function saveMarkdownFile(
  path: string,
  content: string,
  options: { overwriteConfirmed?: boolean } = {}
): Promise<LocalMarkdownSaveResult> {
  if (!localFileService.isDesktopRuntime()) {
    return { ok: false, errorCode: "not_desktop" };
  }

  const normalizedPath = normalizePathInput(path);
  if (!normalizedPath) return { ok: false, errorCode: "empty_path" };
  if (!isMarkdownPath(normalizedPath)) {
    return {
      ok: false,
      errorCode: "invalid_extension",
      fileName: getPathDisplayName(normalizedPath)
    };
  }

  try {
    const result = await invoke<NativeMarkdownSaveResult>("save_markdown_file", {
      filePath: normalizedPath,
      content,
      overwriteConfirmed: options.overwriteConfirmed ?? false
    });
    return {
      ok: true,
      fileName: result.fileName,
      sizeBytes: result.sizeBytes,
      overwritten: result.overwritten,
      pathSummary: summarizePath(normalizedPath)
    };
  } catch (error) {
    return {
      ok: false,
      errorCode: saveErrorCodeFromUnknown(error),
      path: normalizedPath,
      fileName: getPathDisplayName(normalizedPath)
    };
  }
}

export const localMarkdownFileService = {
  selectMarkdownFile,
  readMarkdownFile,
  selectMarkdownSavePath,
  saveMarkdownFile
};
