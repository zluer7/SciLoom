import { invoke } from "@tauri-apps/api/core";

export interface NativeOpenFileDiagnostics {
  received: boolean;
  pathValidationPassed: boolean;
  powershellStarted: boolean;
  powershellSuccess: boolean;
  statusCode?: number | null;
}

export interface NativeFolderValidation {
  path: string;
}

export interface NativePathInspection {
  status: "available" | "missing" | "unavailable" | "wrong_type" | "managed_placement_invalid";
  path: string;
  expectedResourceKind: "file" | "folder";
  actualResourceKind?: "file" | "folder";
  canonicalPath?: string;
  symlinkDetected: boolean;
  errorCode?: string;
}

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function browserModeMessage(action: string) {
  return `${action} is available only in the Tauri desktop app. The browser preview cannot open local file system paths.`;
}

function folderFromFilePath(filePath: string) {
  const normalizedPath = filePath.replace(/\\/g, "/");
  const separatorIndex = normalizedPath.lastIndexOf("/");
  return separatorIndex >= 0 ? normalizedPath.slice(0, separatorIndex) : normalizedPath;
}

async function invokeNativeCommand<T = void>(command: string, payload: Record<string, string>) {
  if (!isTauriRuntime()) {
    throw new Error(browserModeMessage("Native file opening"));
  }

  return await invoke<T>(command, payload);
}

export const nativeFileService = {
  async openFile(filePath: string) {
    return await invokeNativeCommand<NativeOpenFileDiagnostics>("open_file", { filePath });
  },

  async openFolder(folderPath: string) {
    await invokeNativeCommand("open_folder", { folderPath });
  },

  async validateManagedFolder(configuredRoot: string, folderPath: string) {
    return await invokeNativeCommand<NativeFolderValidation>("validate_managed_folder", {
      configuredRoot,
      folderPath
    });
  },

  async validateExistingFolder(folderPath: string) {
    return await invokeNativeCommand<NativeFolderValidation>("validate_existing_folder", {
      folderPath
    });
  },

  async inspectLocalPath(
    path: string,
    expectedResourceKind: "file" | "folder",
    configuredRoot?: string
  ) {
    return await invoke<NativePathInspection>("inspect_local_path", {
      path,
      expectedResourceKind,
      configuredRoot
    });
  },

  async openContainingFolder(filePath: string) {
    await this.openFolder(folderFromFilePath(filePath));
  },

  async revealInFolder(filePath: string) {
    await invokeNativeCommand("reveal_in_folder", { filePath });
  },

  isDesktopRuntime: isTauriRuntime
};
