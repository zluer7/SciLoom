import type { EntityId } from "../types/common";
import type {
  ReadCurrentManuscriptResult
} from "../types/manuscriptIo";
import { MANUSCRIPT_IO_ERROR_CODES } from "../types/manuscriptIo";
import {
  REVIEW_MANUSCRIPT_ERROR_CODES,
  type ReviewManuscriptDocument,
  type ReviewManuscriptDocumentResult,
  type ReviewManuscriptError,
  type ReviewManuscriptErrorCode,
  type ReviewManuscriptRequestIdentity,
  type ReviewManuscriptRequestScope,
  type ReviewManuscriptStructuredDto,
  type ReviewManuscriptStructuredResult,
  type ReviewManuscriptWarning
} from "../types/reviewManuscript";
import {
  parseLabPodMarkdownDocument,
  upsertLabPodStandardBlocks
} from "./labPodMarkdownDocumentService";
import { getSafeManuscriptBasename } from "./fileRefService";
import { manuscriptIoService } from "./manuscriptIoService";
import {
  formatReviewContextInsert
} from "./reviewManuscriptPresentationService";
import { reviewManuscriptStructuredDataService } from "./reviewManuscriptStructuredDataService";

export const REVIEW_MANUSCRIPT_OWNER = "review" as const;
export const REVIEW_MANUSCRIPT_CHANNEL = "primary" as const;

export interface ReviewManuscriptLaterStageDependencies {
  getStructuredDto(reviewId: EntityId): Promise<ReviewManuscriptStructuredResult>;
  readCurrentForContext(
    ownerType: "review",
    ownerId: EntityId,
    options: { requestToken: number; manuscriptChannel: "primary" }
  ): Promise<ReadCurrentManuscriptResult>;
  now(): string;
}

const defaultDependencies: ReviewManuscriptLaterStageDependencies = {
  getStructuredDto: reviewManuscriptStructuredDataService.get,
  readCurrentForContext: manuscriptIoService.readCurrentManuscript,
  now: () => new Date().toISOString()
};

function requestIdentity(
  reviewId: EntityId,
  scope: ReviewManuscriptRequestScope,
  requestToken: number,
  fileRefId?: EntityId
): ReviewManuscriptRequestIdentity {
  return {
    scope,
    requestToken,
    refreshIdentity: `${reviewId}:primary:${scope}:${fileRefId ?? "unresolved"}`
  };
}

function errorResult(
  reviewId: EntityId,
  scope: ReviewManuscriptRequestScope,
  requestToken: number,
  error: ReviewManuscriptError,
  fileRefId?: EntityId
): ReviewManuscriptDocumentResult {
  return {
    status: "error",
    reviewId,
    error,
    request: requestIdentity(reviewId, scope, requestToken, fileRefId)
  };
}

function mapSharedErrorCode(
  code: string,
  scope: "current" | "target",
  operation: "read" | "save"
): ReviewManuscriptErrorCode {
  switch (code) {
    case MANUSCRIPT_IO_ERROR_CODES.ownerNotFound:
      return REVIEW_MANUSCRIPT_ERROR_CODES.ownerMissing;
    case MANUSCRIPT_IO_ERROR_CODES.ownerDeleted:
      return REVIEW_MANUSCRIPT_ERROR_CODES.ownerDeleted;
    case MANUSCRIPT_IO_ERROR_CODES.bindingNotFound:
      return REVIEW_MANUSCRIPT_ERROR_CODES.bindingMissing;
    case MANUSCRIPT_IO_ERROR_CODES.currentNotSet:
      return REVIEW_MANUSCRIPT_ERROR_CODES.currentMissing;
    case MANUSCRIPT_IO_ERROR_CODES.fileRefNotFound:
      return REVIEW_MANUSCRIPT_ERROR_CODES.fileRefMissing;
    case MANUSCRIPT_IO_ERROR_CODES.fileRefDeleted:
      return scope === "target"
        ? REVIEW_MANUSCRIPT_ERROR_CODES.targetDeleted
        : REVIEW_MANUSCRIPT_ERROR_CODES.fileRefInactive;
    case MANUSCRIPT_IO_ERROR_CODES.fileRefOwnerMismatch:
      return REVIEW_MANUSCRIPT_ERROR_CODES.ownerMismatch;
    case MANUSCRIPT_IO_ERROR_CODES.fileRefChannelMismatch:
      return REVIEW_MANUSCRIPT_ERROR_CODES.channelMismatch;
    case MANUSCRIPT_IO_ERROR_CODES.fileRefInvalidKind:
    case MANUSCRIPT_IO_ERROR_CODES.pathIsDirectory:
      return REVIEW_MANUSCRIPT_ERROR_CODES.resourceKindMismatch;
    case MANUSCRIPT_IO_ERROR_CODES.fileRefInvalidRole:
      return REVIEW_MANUSCRIPT_ERROR_CODES.fileRoleMismatch;
    case MANUSCRIPT_IO_ERROR_CODES.extensionUnsupported:
      return REVIEW_MANUSCRIPT_ERROR_CODES.extensionUnsupported;
    case MANUSCRIPT_IO_ERROR_CODES.fileNotFound:
      return REVIEW_MANUSCRIPT_ERROR_CODES.fileMissing;
    case MANUSCRIPT_IO_ERROR_CODES.pathInvalid:
    case MANUSCRIPT_IO_ERROR_CODES.pathOutsideRoot:
    case MANUSCRIPT_IO_ERROR_CODES.symlinkNotAllowed:
      return REVIEW_MANUSCRIPT_ERROR_CODES.pathUnsafe;
    case MANUSCRIPT_IO_ERROR_CODES.staleRequest:
      return REVIEW_MANUSCRIPT_ERROR_CODES.staleRequest;
    default:
      return operation === "save"
        ? REVIEW_MANUSCRIPT_ERROR_CODES.saveFailed
        : REVIEW_MANUSCRIPT_ERROR_CODES.fileUnreadable;
  }
}

function sharedError(
  result: Extract<ReadCurrentManuscriptResult, { status: "error" }>
): ReviewManuscriptError {
  return {
    code: mapSharedErrorCode(result.error.code, "current", "read"),
    message: result.error.message
  };
}

function parseError(
  status: "invalid" | "ambiguous",
  diagnostics: string[]
): ReviewManuscriptError {
  return {
    code: status === "ambiguous"
      ? REVIEW_MANUSCRIPT_ERROR_CODES.parseAmbiguous
      : REVIEW_MANUSCRIPT_ERROR_CODES.parseInvalid,
    message: status === "ambiguous"
      ? "Review manuscript contains ambiguous standard blocks."
      : "Review manuscript contains invalid standard blocks.",
    diagnostics
  };
}

function warningsFor(
  dto: ReviewManuscriptStructuredDto,
  diagnosticCodes: string[]
): ReviewManuscriptWarning[] {
  return [
    ...dto.warnings,
    ...diagnosticCodes.map((code) => ({
      code,
      message: `文稿标准区块提示：${code}`
    }))
  ];
}

function hasRecognizedStandardBlockMarker(
  parsed: ReturnType<typeof parseLabPodMarkdownDocument>
) {
  return Object.values(parsed.blocks).some(
    (block) => block.startMarkerCount > 0 || block.endMarkerCount > 0
  );
}

export function extractReviewManuscriptBlocks(markdown: string) {
  const parsed = parseLabPodMarkdownDocument(markdown);
  if (parsed.status === "invalid" || parsed.status === "ambiguous") {
    return {
      status: "error" as const,
      parsed,
      error: parseError(
        parsed.status,
        parsed.diagnostics.map((item) => item.code)
      )
    };
  }
  const standard = parsed.status === "valid" || parsed.status === "valid-empty";
  const partialStandardDocument =
    parsed.status === "missing" && hasRecognizedStandardBlockMarker(parsed);
  return {
    status: "success" as const,
    parsed,
    metaSnapshot: standard ? parsed.metaSnapshot ?? "" : "",
    outline: standard ? parsed.outline ?? "" : "",
    body: standard
      ? parsed.body ?? ""
      : partialStandardDocument
        ? parsed.body ?? ""
        : markdown
  };
}

export function replaceReviewManuscriptSections(input: {
  existingMarkdown: string;
  metaSnapshot?: string;
  outline?: string;
  body?: string;
}) {
  const extracted = extractReviewManuscriptBlocks(input.existingMarkdown);
  if (extracted.status === "error") return extracted;
  if (
    extracted.parsed.status === "missing" &&
    !hasRecognizedStandardBlockMarker(extracted.parsed)
  ) {
    if (input.metaSnapshot === undefined && input.outline === undefined) {
      return {
        status: "success" as const,
        markdown: input.body ?? input.existingMarkdown
      };
    }
  }
  const serialized = upsertLabPodStandardBlocks(
    input.existingMarkdown,
    {
      metaSnapshot: input.metaSnapshot ?? extracted.metaSnapshot,
      outline: input.outline ?? extracted.outline,
      body: input.body ?? extracted.body
    },
    {
      mode: extracted.parsed.status === "missing" ? "normalize" : "strict",
      preserveOutsideContent: true
    }
  );
  return serialized.status === "error"
    ? {
        status: "error" as const,
        error: {
          code: REVIEW_MANUSCRIPT_ERROR_CODES.serializeFailed,
          message: "Review manuscript could not be serialized safely.",
          diagnostics: serialized.diagnostics.map((item) => item.code)
        }
      }
    : { status: "success" as const, markdown: serialized.markdown };
}

function documentFromRead(input: {
  reviewId: EntityId;
  requestToken: number;
  read: Extract<ReadCurrentManuscriptResult, { status: "success" }>;
  structured: ReviewManuscriptStructuredDto;
  now: string;
}): ReviewManuscriptDocumentResult {
  const { read, reviewId, requestToken, structured, now } = input;
  if (read.ownerType !== REVIEW_MANUSCRIPT_OWNER || read.ownerId !== reviewId) {
    return errorResult(
      reviewId,
      "current",
      requestToken,
      {
        code: REVIEW_MANUSCRIPT_ERROR_CODES.ownerMismatch,
        message: "Resolved Review manuscript owner does not match."
      },
      read.fileRefId
    );
  }
  const filename = getSafeManuscriptBasename(read.path);
  if (!filename) {
    return errorResult(
      reviewId,
      "current",
      requestToken,
      {
        code: REVIEW_MANUSCRIPT_ERROR_CODES.pathUnsafe,
        message: "Review manuscript filename is unsafe."
      },
      read.fileRefId
    );
  }
  const blocks = extractReviewManuscriptBlocks(read.content);
  if (blocks.status === "error") {
    return errorResult(
      reviewId,
      "current",
      requestToken,
      blocks.error,
      read.fileRefId
    );
  }
  return {
    status: "success",
    document: {
      ownerType: REVIEW_MANUSCRIPT_OWNER,
      reviewId,
      manuscriptChannel: REVIEW_MANUSCRIPT_CHANNEL,
      fileRefId: read.fileRefId,
      filename,
      rawMarkdown: read.content,
      metaSnapshot: blocks.metaSnapshot,
      outline: blocks.outline,
      body: blocks.body,
      parseStatus: blocks.parsed.status,
      diagnostics: blocks.parsed.diagnostics,
      warnings: warningsFor(
        structured,
        blocks.parsed.diagnostics.map((item) => item.code)
      ),
      updatedAt: now,
      request: requestIdentity(
        reviewId,
        "current",
        requestToken,
        read.fileRefId
      )
    }
  };
}

export function createReviewManuscriptLaterStageAdapter(
  dependencies: ReviewManuscriptLaterStageDependencies = defaultDependencies
) {
  async function structured(reviewId: EntityId) {
    return dependencies.getStructuredDto(reviewId);
  }

  return Object.freeze({
    async readCurrentForContext(
      reviewId: EntityId,
      requestToken: number
    ): Promise<ReviewManuscriptDocumentResult> {
      const dto = await structured(reviewId);
      if (dto.status === "error") {
        return errorResult(
          reviewId,
          "current",
          requestToken,
          dto.error
        );
      }
      const read = await dependencies.readCurrentForContext(
        REVIEW_MANUSCRIPT_OWNER,
        reviewId,
        {
          requestToken,
          manuscriptChannel: REVIEW_MANUSCRIPT_CHANNEL
        }
      );
      if (read.status === "error") {
        return errorResult(
          reviewId,
          "current",
          requestToken,
          sharedError(read)
        );
      }
      return documentFromRead({
        reviewId,
        requestToken,
        read,
        structured: dto.dto,
        now: dependencies.now()
      });
    },
    formatContextInsert: formatReviewContextInsert
  });
}

export const reviewManuscriptAdapterService =
  createReviewManuscriptLaterStageAdapter();
