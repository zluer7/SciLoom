export type LabPodMarkdownBlockType = "metaSnapshot" | "outline" | "body";
export type LabPodMarkdownBlockStatus =
  | "valid"
  | "valid-empty"
  | "missing"
  | "invalid"
  | "ambiguous";
export type LabPodMarkdownDocumentStatus = LabPodMarkdownBlockStatus;
export type LabPodMarkdownNewlineStyle = "lf" | "crlf" | "mixed" | "none";
export type LabPodMarkdownSerializeMode = "strict" | "normalize";

export interface LabPodMarkdownRange {
  start: number;
  end: number;
}

export const LABPOD_MARKDOWN_DIAGNOSTIC_CODES = {
  metaMissing: "LABPOD_BLOCK_META_MISSING",
  outlineMissing: "LABPOD_BLOCK_OUTLINE_MISSING",
  bodyMissing: "LABPOD_BLOCK_BODY_MISSING",
  startMissing: "LABPOD_BLOCK_START_MISSING",
  endMissing: "LABPOD_BLOCK_END_MISSING",
  duplicate: "LABPOD_BLOCK_DUPLICATE",
  orderInvalid: "LABPOD_BLOCK_ORDER_INVALID",
  nested: "LABPOD_BLOCK_NESTED",
  overlapped: "LABPOD_BLOCK_OVERLAPPED",
  ambiguous: "LABPOD_BLOCK_AMBIGUOUS",
  markerMalformed: "LABPOD_BLOCK_MARKER_MALFORMED",
  outsideContent: "LABPOD_BLOCK_OUTSIDE_CONTENT_PRESENT",
  mixedNewlines: "LABPOD_BLOCK_MIXED_NEWLINES",
  unclosedFence: "LABPOD_BLOCK_UNCLOSED_FENCE",
  serializeMissingSource: "LABPOD_BLOCK_SERIALIZE_MISSING_SOURCE",
  serializeInvalidSource: "LABPOD_BLOCK_SERIALIZE_INVALID_SOURCE",
  serializeAmbiguousSource: "LABPOD_BLOCK_SERIALIZE_AMBIGUOUS_SOURCE",
  serializeUnsupportedMode: "LABPOD_BLOCK_SERIALIZE_UNSUPPORTED_MODE"
} as const;

export type LabPodMarkdownDiagnosticCode =
  (typeof LABPOD_MARKDOWN_DIAGNOSTIC_CODES)[keyof typeof LABPOD_MARKDOWN_DIAGNOSTIC_CODES];

export interface LabPodMarkdownDiagnostic {
  code: LabPodMarkdownDiagnosticCode;
  severity: "warning" | "error";
  blockType?: LabPodMarkdownBlockType;
  message: string;
  range?: LabPodMarkdownRange;
  details?: Record<string, string | number | boolean>;
}

export interface LabPodMarkdownBlockRanges {
  startMarkerRange: LabPodMarkdownRange;
  contentRange: LabPodMarkdownRange;
  endMarkerRange: LabPodMarkdownRange;
  fullRange: LabPodMarkdownRange;
}

export interface LabPodMarkdownBlockParseResult {
  type: LabPodMarkdownBlockType;
  status: LabPodMarkdownBlockStatus;
  content?: string;
  ranges?: LabPodMarkdownBlockRanges;
  startMarkerCount: number;
  endMarkerCount: number;
}

export interface LabPodMarkdownDocumentParseResult {
  status: LabPodMarkdownDocumentStatus;
  metaSnapshot?: string;
  outline?: string;
  body?: string;
  blocks: Record<LabPodMarkdownBlockType, LabPodMarkdownBlockParseResult>;
  newlineStyle: LabPodMarkdownNewlineStyle;
  preferredNewline: "\n" | "\r\n";
  hasBom: boolean;
  diagnostics: LabPodMarkdownDiagnostic[];
  ranges: Partial<Record<LabPodMarkdownBlockType, LabPodMarkdownBlockRanges>>;
  outsideContent: string;
  outsideRanges: LabPodMarkdownRange[];
}

export interface SerializeLabPodMarkdownDocumentInput {
  metaSnapshot: string;
  outline: string;
  body: string;
  newlineStyle?: "lf" | "crlf";
  preserveBom?: boolean;
  trailingNewline?: boolean;
}

export interface UpsertLabPodStandardBlocksInput {
  metaSnapshot?: string;
  outline?: string;
  body?: string;
}

export interface UpsertLabPodStandardBlocksOptions {
  mode?: LabPodMarkdownSerializeMode;
  newlineStyle?: "lf" | "crlf";
  preserveBom?: boolean;
  trailingNewline?: boolean;
  preserveOutsideContent?: boolean;
}

export type UpsertLabPodStandardBlocksResult =
  | {
      status: "success";
      markdown: string;
      source: LabPodMarkdownDocumentParseResult;
      diagnostics: LabPodMarkdownDiagnostic[];
    }
  | {
      status: "error";
      source: LabPodMarkdownDocumentParseResult;
      diagnostics: LabPodMarkdownDiagnostic[];
    };
