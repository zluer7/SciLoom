export type LocalMarkdownReadErrorCode =
  | "canceled"
  | "empty_path"
  | "invalid_extension"
  | "path_not_found"
  | "not_file"
  | "file_too_large"
  | "read_failed"
  | "invalid_utf8"
  | "not_desktop"
  | "unknown";

export type LocalMarkdownFileSelectionResult =
  | {
      ok: true;
      path: string;
      fileName: string;
    }
  | {
      ok: false;
      errorCode: LocalMarkdownReadErrorCode;
    };

export type LocalMarkdownReadResult =
  | {
      ok: true;
      content: string;
      fileName: string;
      sizeBytes: number;
    }
  | {
      ok: false;
      errorCode: LocalMarkdownReadErrorCode;
    };

export type LocalMarkdownSaveErrorCode =
  | "canceled"
  | "empty_path"
  | "invalid_extension"
  | "path_exists_requires_confirm"
  | "parent_not_found"
  | "not_file_target"
  | "content_too_large"
  | "write_failed"
  | "not_desktop"
  | "unknown";

export type LocalMarkdownSaveResult =
  | {
      ok: true;
      fileName: string;
      sizeBytes: number;
      overwritten: boolean;
      pathSummary: string;
    }
  | {
      ok: false;
      errorCode: LocalMarkdownSaveErrorCode;
      path?: string;
      fileName?: string;
    };

export interface MarkdownSavePathFilter {
  name: "Markdown";
  extensions: readonly ["md", "markdown"];
}

export interface MarkdownSavePathSelectionRequest {
  title: string;
  suggestedFileName: string;
  defaultDirectory: string;
  requestToken: string;
  filter: MarkdownSavePathFilter;
}

export type LocalMarkdownSavePathResult =
  | {
      status: "SELECTED";
      path: string;
      fileName: string;
      requestToken: string;
      rawNativeSelectedPath: string;
      normalizedSelectedPath: string;
    }
  | { status: "CANCELLED"; requestToken: string }
  | { status: "BUSY"; requestToken: string }
  | { status: "CAPABILITY_DENIED" }
  | { status: "DIALOG_FAILED" }
  | { status: "PATH_INVALID"; requestToken?: string; fileName?: string };
