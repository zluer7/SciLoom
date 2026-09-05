import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openPath as openWithSystem, revealItemInDir } from "@tauri-apps/plugin-opener";
import type {
  LocalFileActionType,
  LocalFileDebugCode,
  LocalFileDiagnosticStage,
  LocalFileErrorCode,
  OpenLocalPathOptions,
  LocalPathDiagnostics,
  LocalFileResult,
  SelectLocalFileOptions,
  SelectLocalFolderOptions
} from "../types/localFile";
import {
  getPathDisplayName,
  isLikelyAbsoluteLocalPath,
  isWindowsAbsoluteLocalPath,
  normalizePathInput,
  summarizePath
} from "./localPathService";
import { nativeFileService, type NativeOpenFileDiagnostics } from "./nativeFileService";
import {
  isWindowsFileFallbackEligible,
  resolveFileRefOpenKind
} from "./localFileOpenKindModel";

export { isWindowsFileFallbackEligible, resolveFileRefOpenKind };

function isDesktopRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function isWindowsDesktopRuntime() {
  if (!isDesktopRuntime() || typeof navigator === "undefined") {
    return false;
  }

  const navigatorWithPlatform = navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  const platform = navigatorWithPlatform.userAgentData?.platform ?? navigator.platform ?? "";
  const userAgent = navigator.userAgent ?? "";
  return /win/i.test(platform) || /windows/i.test(userAgent);
}

export function shouldUseWindowsNativeFolderOpen(path: string) {
  return (
    isDesktopRuntime() &&
    (isWindowsDesktopRuntime() || isWindowsAbsoluteLocalPath(path))
  );
}

function success(
  actionType: LocalFileActionType,
  path?: string,
  paths?: string[],
  metadata: Partial<
    Pick<
      LocalFileResult,
      | "fallbackUsed"
      | "debugCode"
      | "openerStage"
      | "nativeStage"
      | "pathDiagnostics"
      | "debugTrace"
      | "nativeDiagnostics"
      | "nativeMessage"
    >
  > = {}
): LocalFileResult {
  return { ok: true, status: "success", actionType, path, paths, ...metadata };
}

function canceled(actionType: LocalFileActionType): LocalFileResult {
  return {
    ok: false,
    status: "canceled",
    actionType,
    errorCode: "canceled",
    errorMessage: "The user canceled the local file action."
  };
}

function failure(
  actionType: LocalFileActionType,
  errorCode: LocalFileErrorCode,
  errorMessage: string,
  metadata: Partial<
    Pick<
      LocalFileResult,
      | "fallbackUsed"
      | "debugCode"
      | "openerStage"
      | "nativeStage"
      | "pathDiagnostics"
      | "debugTrace"
      | "nativeDiagnostics"
      | "nativeMessage"
    >
  > = {}
): LocalFileResult {
  return { ok: false, status: "failed", actionType, errorCode, errorMessage, ...metadata };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
}

function toLocalFileErrorCode(error: unknown, fallback: LocalFileErrorCode) {
  const message = errorMessage(error);
  if (message.includes("workspace_folder_not_found")) {
    return "path_not_found";
  }
  if (message.includes("workspace_folder_invalid") || message.includes("workspace_folder_outside_root")) {
    return "invalid_path";
  }
  if (message.includes("workspace_folder_open_failed")) {
    return "native_command_failed";
  }
  if (message.includes("native_invalid_file_path") || message.includes("native_file_not_found")) {
    return "path_not_found";
  }
  if (message.includes("permission") || message.includes("denied") || message.includes("forbidden")) {
    return "permission_denied";
  }
  if (message.includes("native command")) {
    return "native_command_failed";
  }
  if (message.includes("not found") || message.includes("does not exist")) {
    return "path_not_found";
  }
  if (message.includes("unsupported") || message.includes("not supported")) {
    return "unsupported";
  }
  return fallback;
}

function shouldUseWindowsNativeFallback(
  actionType: "open_path" | "open_file" | "open_folder",
  options: OpenLocalPathOptions
) {
  return (
    isWindowsDesktopRuntime() &&
    (isWindowsFileFallbackEligible(actionType, options) ||
      actionType === "open_folder" ||
      options.openKind === "folder")
  );
}

function safeErrorMessage(errorCode: LocalFileErrorCode) {
  const messages: Record<LocalFileErrorCode, string> = {
    canceled: "The user canceled the local file action.",
    empty_path: "A local path is required.",
    invalid_path: "The value is not a supported absolute local path.",
    path_not_found: "The selected local path was not found.",
    not_desktop: "This local file action is available only in the Tauri desktop app.",
    permission_denied: "The operating system denied permission for this local file action.",
    open_failed: "The local path could not be opened.",
    native_command_failed: "The native file open command failed.",
    reveal_failed: "The local path could not be revealed in the system file manager.",
    clipboard_failed: "The local path could not be copied to the clipboard.",
    unsupported: "This local file action is not supported on the current platform.",
    unknown: "The local file action failed for an unknown reason."
  };
  return messages[errorCode];
}

function extensionFromPath(path: string) {
  const normalized = normalizePathInput(path).replace(/[\\/]+$/, "");
  const segments = normalized.split(/[\\/]+/).filter(Boolean);
  const fileName = segments[segments.length - 1] ?? normalized;
  const match = fileName.match(/(\.[^./\\]+)$/);
  return match?.[1];
}

export function getPathDiagnostics(path: string): LocalPathDiagnostics {
  const raw = path ?? "";
  const trimmed = raw.trim();
  const normalized = normalizePathInput(raw);
  const driveMatch = normalized.match(/^([A-Za-z]:)(?:[\\/]|$)/);

  return {
    isEmpty: normalized.length === 0,
    hasFileScheme: /^file:\/\//i.test(trimmed),
    hasWrappingQuotes: /^(['"]).*\1$/.test(trimmed),
    hasBackslash: normalized.includes("\\"),
    hasForwardSlash: normalized.includes("/"),
    hasWhitespace: /\s/.test(normalized),
    hasNonAscii: /[^\x00-\x7F]/.test(normalized),
    extension: extensionFromPath(normalized),
    drivePrefix: driveMatch?.[1],
    length: normalized.length
  };
}

function createTrace(...stages: LocalFileDiagnosticStage[]) {
  return stages;
}

function stagesFromNativeError(error: unknown): LocalFileDiagnosticStage[] {
  const message = errorMessage(error);
  if (message.includes("workspace_folder_not_found") || message.includes("workspace_folder_invalid")) {
    return ["rust_open_file_received", "rust_path_validation_failed"];
  }
  if (message.includes("native_file_not_found") || message.includes("native_invalid_file_path")) {
    return ["rust_open_file_received", "rust_path_validation_failed"];
  }
  if (message.includes("native_powershell_spawn_failed")) {
    return [
      "rust_open_file_received",
      "rust_path_validation_passed",
      "rust_powershell_spawn_failed"
    ];
  }
  if (message.includes("native_powershell_status_failed")) {
    return [
      "rust_open_file_received",
      "rust_path_validation_passed",
      "rust_powershell_started",
      "rust_powershell_status_failed"
    ];
  }
  return ["native_command_failed"];
}

function safeNativeMessage(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  if (!raw) {
    return "native_command_failed";
  }
  return raw
    .replace(/[A-Za-z]:[\\/][^\r\n"]+/g, "<local-path>")
    .replace(/file:\/\/[^\s"]+/gi, "<local-path>");
}

function stagesFromNativeDiagnostics(
  diagnostics: NativeOpenFileDiagnostics
): LocalFileDiagnosticStage[] {
  const stages: LocalFileDiagnosticStage[] = [];
  if (diagnostics.received) {
    stages.push("rust_open_file_received");
  }
  if (diagnostics.pathValidationPassed) {
    stages.push("rust_path_validation_passed");
  }
  if (diagnostics.powershellStarted) {
    stages.push("rust_powershell_started");
  }
  stages.push(
    diagnostics.powershellSuccess
      ? "rust_powershell_status_success"
      : "rust_powershell_status_failed"
  );
  return stages;
}

function desktopRequired(actionType: LocalFileActionType): LocalFileResult | null {
  return isDesktopRuntime()
    ? null
    : failure(actionType, "not_desktop", safeErrorMessage("not_desktop"));
}

type ValidatedPath =
  | { path: string; result?: never }
  | { path?: never; result: LocalFileResult };

function validatedPath(actionType: LocalFileActionType, path: string): ValidatedPath {
  const normalized = normalizePathInput(path);
  if (!normalized) {
    return {
      result: failure(actionType, "empty_path", safeErrorMessage("empty_path"))
    };
  }
  if (normalized.includes("\0") || !isLikelyAbsoluteLocalPath(normalized)) {
    return {
      result: failure(actionType, "invalid_path", safeErrorMessage("invalid_path"))
    };
  }
  return { path: normalized };
}

function selectedResult(
  actionType: LocalFileActionType,
  selected: string | string[] | null,
  resourceKind: "file" | "folder"
): LocalFileResult {
  if (selected === null) {
    return canceled(actionType);
  }

  const rawPaths = Array.isArray(selected) ? selected : [selected];
  const paths = rawPaths.map(normalizePathInput).filter(Boolean);
  if (paths.length === 0) {
    return failure(actionType, "invalid_path", safeErrorMessage("invalid_path"));
  }
  return { ...success(actionType, paths[0], paths), resourceKind };
}

export async function selectFile(
  options: SelectLocalFileOptions = {}
): Promise<LocalFileResult> {
  const actionType: LocalFileActionType = "select_file";
  const unavailable = desktopRequired(actionType);
  if (unavailable) {
    return unavailable;
  }

  try {
    const selected = await openDialog({
      title: options.title,
      directory: false,
      multiple: options.multiple ?? false,
      filters: options.filters,
      defaultPath: options.defaultPath,
      fileAccessMode: "scoped"
    });
    return selectedResult(actionType, selected, "file");
  } catch (error) {
    const code = toLocalFileErrorCode(error, "unknown");
    return failure(actionType, code, safeErrorMessage(code));
  }
}

export async function selectFolder(
  options: SelectLocalFolderOptions = {}
): Promise<LocalFileResult> {
  const actionType: LocalFileActionType = "select_folder";
  const unavailable = desktopRequired(actionType);
  if (unavailable) {
    return unavailable;
  }

  try {
    const selected = await openDialog({
      title: options.title,
      directory: true,
      multiple: options.multiple ?? false,
      recursive: false,
      fileAccessMode: "scoped"
    });
    return selectedResult(actionType, selected, "folder");
  } catch (error) {
    const code = toLocalFileErrorCode(error, "unknown");
    return failure(actionType, code, safeErrorMessage(code));
  }
}

async function openLocalPath(
  actionType: "open_path" | "open_file" | "open_folder",
  path: string,
  options: OpenLocalPathOptions = {}
): Promise<LocalFileResult> {
  const pathDiagnostics = getPathDiagnostics(path);
  const debugTrace = createTrace("clicked");
  const unavailable = desktopRequired(actionType);
  if (unavailable) {
    return { ...unavailable, pathDiagnostics, debugTrace };
  }
  const validated = validatedPath(actionType, path);
  if (validated.result) {
    return {
      ...validated.result,
      pathDiagnostics,
      debugTrace: [...debugTrace, "validation_failed"]
    };
  }
  debugTrace.push("validated");

  if (
    shouldUseWindowsNativeFolderOpen(validated.path) &&
    (actionType === "open_folder" || options.openKind === "folder")
  ) {
    try {
      debugTrace.push("native_command_attempted");
      await nativeFileService.openFolder(validated.path);
      debugTrace.push("native_command_success");
      return success(actionType, validated.path, undefined, {
        fallbackUsed: false,
        debugCode: "native_command_success",
        nativeStage: "native_command_success",
        pathDiagnostics,
        debugTrace
      });
    } catch (error) {
      debugTrace.push("native_command_failed");
      const code = toLocalFileErrorCode(error, "native_command_failed");
      return failure(actionType, code, safeErrorMessage(code), {
        fallbackUsed: false,
        debugCode: "native_command_failed",
        nativeStage: "native_command_failed",
        pathDiagnostics,
        debugTrace,
        nativeMessage: safeNativeMessage(error)
      });
    }
  }

  try {
    debugTrace.push("opener_attempted");
    await openWithSystem(validated.path);
    debugTrace.push("opener_success");
    return success(actionType, validated.path, undefined, {
      fallbackUsed: false,
      debugCode: "opener_success",
      openerStage: "opener_success",
      pathDiagnostics,
      debugTrace
    });
  } catch (error) {
    debugTrace.push("opener_failed");
    if (shouldUseWindowsNativeFallback(actionType, options)) {
      const fallbackDebugCode: LocalFileDebugCode = "native_command_failed";
      try {
        debugTrace.push("fallback_attempted", "native_command_attempted");
        const nativeDiagnostics =
          actionType === "open_folder" || options.openKind === "folder"
            ? undefined
            : await nativeFileService.openFile(validated.path);
        if (nativeDiagnostics) {
          debugTrace.push("native_command_success", ...stagesFromNativeDiagnostics(nativeDiagnostics));
        } else {
          await nativeFileService.openFolder(validated.path);
          debugTrace.push("native_command_success");
        }
        return success(actionType, validated.path, undefined, {
          fallbackUsed: true,
          debugCode: "native_command_success",
          openerStage: "opener_failed",
          nativeStage: nativeDiagnostics
            ? nativeDiagnostics.powershellSuccess
              ? "rust_powershell_status_success"
              : "rust_powershell_status_failed"
            : "native_command_success",
          pathDiagnostics,
          debugTrace,
          nativeDiagnostics
        });
      } catch (fallbackError) {
        const nativeErrorStages = stagesFromNativeError(fallbackError);
        const nativeStage = nativeErrorStages[nativeErrorStages.length - 1];
        debugTrace.push("native_command_failed", ...nativeErrorStages);
        const code = toLocalFileErrorCode(
          fallbackError,
          toLocalFileErrorCode(error, "native_command_failed")
        );
        return failure(actionType, code, safeErrorMessage(code), {
          fallbackUsed: true,
          debugCode:
            nativeStage === "rust_path_validation_failed"
              ? "rust_path_validation_failed"
              : fallbackDebugCode,
          openerStage: "opener_failed",
          nativeStage,
          pathDiagnostics,
          debugTrace,
          nativeMessage: safeNativeMessage(fallbackError)
        });
      }
    }

    debugTrace.push("fallback_skipped");
    const code = toLocalFileErrorCode(error, "open_failed");
    return failure(actionType, code, safeErrorMessage(code), {
      fallbackUsed: false,
      debugCode: "opener_failed",
      openerStage: "opener_failed",
      nativeStage: "fallback_skipped",
      pathDiagnostics,
      debugTrace
    });
  }
}

export function openPath(path: string, options: OpenLocalPathOptions = {}) {
  return openLocalPath("open_path", path, options);
}

export function openFile(path: string) {
  return openLocalPath("open_file", path, { openKind: "file" });
}

export function openFolder(path: string) {
  return openLocalPath("open_folder", path, { openKind: "folder" });
}

async function revealLocalPath(
  actionType: "reveal_in_folder" | "open_containing_folder",
  path: string
): Promise<LocalFileResult> {
  const unavailable = desktopRequired(actionType);
  if (unavailable) {
    return unavailable;
  }
  const validated = validatedPath(actionType, path);
  if (validated.result) {
    return validated.result;
  }

  try {
    await revealItemInDir(validated.path);
    return success(actionType, validated.path);
  } catch (error) {
    const code = toLocalFileErrorCode(error, "reveal_failed");
    return failure(actionType, code, safeErrorMessage(code));
  }
}

export function revealInFolder(path: string) {
  return revealLocalPath("reveal_in_folder", path);
}

export function openContainingFolder(path: string) {
  return revealLocalPath("open_containing_folder", path);
}

export async function copyPath(path: string): Promise<LocalFileResult> {
  const actionType: LocalFileActionType = "copy_path";
  const normalized = normalizePathInput(path);
  if (!normalized) {
    return failure(actionType, "empty_path", safeErrorMessage("empty_path"));
  }
  if (normalized.includes("\0")) {
    return failure(actionType, "invalid_path", safeErrorMessage("invalid_path"));
  }
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
    return failure(actionType, "clipboard_failed", safeErrorMessage("clipboard_failed"));
  }

  try {
    await navigator.clipboard.writeText(normalized);
    return success(actionType, normalized);
  } catch {
    return failure(actionType, "clipboard_failed", safeErrorMessage("clipboard_failed"));
  }
}

export const localFileService = {
  selectFile,
  selectFolder,
  openPath,
  openFile,
  openFolder,
  openContainingFolder,
  revealInFolder,
  copyPath,
  summarizePath,
  getPathDisplayName,
  getPathDiagnostics,
  resolveFileRefOpenKind,
  isWindowsFileFallbackEligible,
  isDesktopRuntime
};
