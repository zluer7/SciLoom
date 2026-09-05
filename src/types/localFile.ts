export type LocalFileActionType =
  | "select_file"
  | "select_folder"
  | "open_path"
  | "open_file"
  | "open_folder"
  | "reveal_in_folder"
  | "open_containing_folder"
  | "copy_path"
  | "summarize_path"
  | "get_path_display_name";

export type LocalFileResultStatus = "success" | "canceled" | "failed";

export type LocalFileErrorCode =
  | "canceled"
  | "empty_path"
  | "invalid_path"
  | "path_not_found"
  | "not_desktop"
  | "permission_denied"
  | "open_failed"
  | "native_command_failed"
  | "reveal_failed"
  | "clipboard_failed"
  | "unsupported"
  | "unknown";

export type LocalFileDebugCode =
  | "opener_success"
  | "opener_failed"
  | "fallback_skipped"
  | "fallback_started"
  | "fallback_failed"
  | "native_command_attempted"
  | "native_command_failed"
  | "native_command_success"
  | "rust_path_validation_failed";

export type LocalFileDiagnosticStage =
  | "clicked"
  | "validated"
  | "validation_failed"
  | "opener_attempted"
  | "opener_success"
  | "opener_failed"
  | "fallback_skipped"
  | "fallback_attempted"
  | "native_command_attempted"
  | "native_command_success"
  | "native_command_failed"
  | "rust_open_file_received"
  | "rust_path_validation_passed"
  | "rust_path_validation_failed"
  | "rust_powershell_started"
  | "rust_powershell_status_success"
  | "rust_powershell_status_failed"
  | "rust_powershell_spawn_failed";

export interface LocalPathDiagnostics {
  isEmpty: boolean;
  hasFileScheme: boolean;
  hasWrappingQuotes: boolean;
  hasBackslash: boolean;
  hasForwardSlash: boolean;
  hasWhitespace: boolean;
  hasNonAscii: boolean;
  extension?: string;
  drivePrefix?: string;
  length: number;
}

export interface LocalFileResult {
  ok: boolean;
  status: LocalFileResultStatus;
  actionType: LocalFileActionType;
  path?: string;
  paths?: string[];
  resourceKind?: "file" | "folder";
  errorCode?: LocalFileErrorCode;
  errorMessage?: string;
  fallbackUsed?: boolean;
  debugCode?: LocalFileDebugCode;
  openerStage?: LocalFileDiagnosticStage;
  nativeStage?: LocalFileDiagnosticStage;
  pathDiagnostics?: LocalPathDiagnostics;
  debugTrace?: LocalFileDiagnosticStage[];
  nativeMessage?: string;
  nativeDiagnostics?: {
    received?: boolean;
    pathValidationPassed?: boolean;
    powershellStarted?: boolean;
    powershellSuccess?: boolean;
    statusCode?: number | null;
  };
}

export type LocalFileOpenKind = "file" | "folder" | "unknown";

export interface OpenLocalPathOptions {
  openKind?: LocalFileOpenKind;
}

export interface LocalFileDialogFilter {
  name: string;
  extensions: string[];
}

export interface SelectLocalFileOptions {
  title?: string;
  multiple?: boolean;
  filters?: LocalFileDialogFilter[];
  defaultPath?: string;
}

export interface SelectLocalFolderOptions {
  title?: string;
  multiple?: boolean;
}
