import { invoke } from "@tauri-apps/api/core";
import {
  MANUSCRIPT_OPERATION_ERROR_CODES,
  type FileIdentity,
  type ManuscriptNewline,
  type ManuscriptOperationError,
  type ManuscriptOperationErrorCode,
  type ManuscriptOperationResult,
  type ManuscriptUniformNewline,
  type NativeRawManuscriptFileResult,
  type NativeRawManuscriptReadInput,
  type NativeRawManuscriptSaveInput,
  type RawManuscriptGateway,
  type RawManuscriptNativePort,
  type RawManuscriptSaveSuccess,
  type RawManuscriptSnapshot
} from "../types/manuscriptOperation";
import {
  createManuscriptIdentityResolver,
  ManuscriptIdentityError,
  type ManuscriptIdentityResolver
} from "./manuscriptIdentityResolver";

export const RAW_MANUSCRIPT_MAX_BYTES = 1_048_576;

interface NewlineAnalysis {
  newline: ManuscriptNewline;
  dominantNewline?: ManuscriptUniformNewline;
}

export interface RawManuscriptGatewayDependencies {
  nativePort: RawManuscriptNativePort;
  identityResolver?: ManuscriptIdentityResolver;
  createOperationId?: () => string;
}

function createDefaultOperationId() {
  return globalThis.crypto?.randomUUID?.() ??
    `manuscript-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function analyzeRawManuscriptNewlines(rawText: string): NewlineAnalysis {
  let lfCount = 0;
  let crlfCount = 0;
  let first: ManuscriptUniformNewline | undefined;
  for (let index = 0; index < rawText.length; index += 1) {
    if (rawText[index] !== "\n") continue;
    const current: ManuscriptUniformNewline =
      index > 0 && rawText[index - 1] === "\r" ? "crlf" : "lf";
    first ??= current;
    if (current === "crlf") crlfCount += 1;
    else lfCount += 1;
  }
  if (lfCount === 0 && crlfCount === 0) return { newline: "none" };
  if (lfCount === 0) return { newline: "crlf", dominantNewline: "crlf" };
  if (crlfCount === 0) return { newline: "lf", dominantNewline: "lf" };
  return {
    newline: "mixed",
    dominantNewline:
      crlfCount === lfCount ? first : crlfCount > lfCount ? "crlf" : "lf"
  };
}

function errorDetails(
  code: ManuscriptOperationErrorCode,
  options: Partial<ManuscriptOperationError> = {}
): ManuscriptOperationError {
  return {
    code,
    category: options.category ?? "file",
    retryable: options.retryable ?? false,
    writeApplied: options.writeApplied ?? false,
    recoveryRequired: options.recoveryRequired ?? false,
    causeCode: options.causeCode
  };
}

function mapNativeError(
  result: Extract<NativeRawManuscriptFileResult, { status: "error" }>
): ManuscriptOperationError {
  const codeMap: Record<string, ManuscriptOperationErrorCode> = {
    MANUSCRIPT_FILE_NOT_FOUND: MANUSCRIPT_OPERATION_ERROR_CODES.fileNotFound,
    MANUSCRIPT_TARGET_IS_DIRECTORY:
      MANUSCRIPT_OPERATION_ERROR_CODES.targetIsDirectory,
    MANUSCRIPT_PATH_OUTSIDE_ROOT: MANUSCRIPT_OPERATION_ERROR_CODES.pathOutsideRoot,
    MANUSCRIPT_SYMLINK_ESCAPE: MANUSCRIPT_OPERATION_ERROR_CODES.symlinkEscape,
    MANUSCRIPT_ENCODING_INVALID:
      MANUSCRIPT_OPERATION_ERROR_CODES.encodingUnsupported,
    MANUSCRIPT_FILE_TOO_LARGE: MANUSCRIPT_OPERATION_ERROR_CODES.fileTooLarge,
    MANUSCRIPT_FILE_PATH_MISMATCH:
      MANUSCRIPT_OPERATION_ERROR_CODES.pathIdentityMismatch,
    MANUSCRIPT_PHYSICAL_IDENTITY_AMBIGUOUS:
      MANUSCRIPT_OPERATION_ERROR_CODES.pathIdentityMismatch,
    MANUSCRIPT_PERMISSION_DENIED:
      MANUSCRIPT_OPERATION_ERROR_CODES.permissionDenied,
    MANUSCRIPT_REVISION_CONFLICT:
      MANUSCRIPT_OPERATION_ERROR_CODES.revisionConflict,
    MANUSCRIPT_TEMPORARY_WRITE_FAILED:
      MANUSCRIPT_OPERATION_ERROR_CODES.temporaryWriteFailed,
    MANUSCRIPT_ATOMIC_REPLACE_FAILED:
      MANUSCRIPT_OPERATION_ERROR_CODES.atomicReplaceFailed,
    MANUSCRIPT_ATOMIC_WRITE_FAILED:
      MANUSCRIPT_OPERATION_ERROR_CODES.atomicWriteFailed,
    MANUSCRIPT_PHYSICAL_REREAD_FAILED:
      MANUSCRIPT_OPERATION_ERROR_CODES.readbackFailed,
    MANUSCRIPT_PHYSICAL_VERIFY_FAILED:
      MANUSCRIPT_OPERATION_ERROR_CODES.verificationFailed
  };
  const recoveryRequired =
    result.recoveryRequired === true ||
    result.writeApplied === true ||
    result.writeApplied === "unknown";
  const code =
    codeMap[result.errorCode] ?? MANUSCRIPT_OPERATION_ERROR_CODES.fileUnreadable;
  return errorDetails(code, {
    retryable:
      code === MANUSCRIPT_OPERATION_ERROR_CODES.revisionConflict ||
      code === MANUSCRIPT_OPERATION_ERROR_CODES.fileUnreadable,
    writeApplied: result.writeApplied ?? false,
    recoveryRequired,
    causeCode: result.errorCode
  });
}

function mapIdentityError(error: unknown): ManuscriptOperationError {
  const code = error instanceof ManuscriptIdentityError
    ? error.code
    : MANUSCRIPT_OPERATION_ERROR_CODES.invalidFileIdentity;
  return errorDetails(code, { category: "identity" });
}

function nativeReadInput(file: FileIdentity): NativeRawManuscriptReadInput {
  if (file.locationMode === "pending") {
    throw new ManuscriptIdentityError(
      MANUSCRIPT_OPERATION_ERROR_CODES.locationModeUnconfirmed
    );
  }
  return {
    filePath: file.absolutePath,
    expectedPathIdentity: file.pathIdentity,
    expectedFileName: file.fileName,
    locationMode: file.locationMode,
    configuredRoot: file.configuredRoot
  };
}

function toSnapshot(
  result: Extract<NativeRawManuscriptFileResult, { status: "success" }>
): RawManuscriptSnapshot {
  const hasBom = result.content.startsWith("\uFEFF");
  const rawText = hasBom ? result.content.slice(1) : result.content;
  return {
    rawText,
    revision: result.revision,
    physicalIdentity: result.physicalIdentity,
    encoding: hasBom ? "utf-8-bom" : "utf-8",
    ...analyzeRawManuscriptNewlines(rawText),
    byteLength: result.byteLength
  };
}

function validateNativeIdentity(
  file: FileIdentity,
  result: Extract<NativeRawManuscriptFileResult, { status: "success" }>
) {
  return result.pathIdentity === file.pathIdentity &&
    result.fileName.normalize("NFC") === file.fileName.normalize("NFC");
}

export function createRawManuscriptGateway(
  dependencies: RawManuscriptGatewayDependencies
): RawManuscriptGateway {
  const resolver = dependencies.identityResolver ??
    createManuscriptIdentityResolver();
  const createOperationId = dependencies.createOperationId ??
    createDefaultOperationId;

  return {
    async read(input) {
      const operationId = createOperationId();
      let file: FileIdentity;
      let nativeInput: NativeRawManuscriptReadInput;
      try {
        file = resolver.assertFile(input.file);
        nativeInput = nativeReadInput(file);
      } catch (error) {
        return {
          operation: "open",
          status: "error",
          operationId,
          error: mapIdentityError(error)
        };
      }
      try {
        const result = await dependencies.nativePort.read(nativeInput);
        if (result.status === "error") {
          const error = mapNativeError(result);
          return {
            operation: "open",
            status: error.recoveryRequired ? "recovery-required" : "error",
            operationId,
            error
          };
        }
        if (!validateNativeIdentity(file, result)) {
          return {
            operation: "open",
            status: "error",
            operationId,
            error: errorDetails(
              MANUSCRIPT_OPERATION_ERROR_CODES.pathIdentityMismatch,
              { category: "identity" }
            )
          };
        }
        return {
          operation: "open",
          status: "success",
          operationId,
          data: toSnapshot(result)
        };
      } catch {
        return {
          operation: "open",
          status: "error",
          operationId,
          error: errorDetails(
            MANUSCRIPT_OPERATION_ERROR_CODES.fileUnreadable,
            { retryable: true, causeCode: "NATIVE_PORT_REJECTED" }
          )
        };
      }
    },

    async save(input) {
      const operationId = createOperationId();
      let file: FileIdentity;
      let readInput: NativeRawManuscriptReadInput;
      try {
        file = resolver.assertFile(input.file);
        readInput = nativeReadInput(file);
      } catch (error) {
        return {
          operation: "save",
          status: "error",
          operationId,
          error: mapIdentityError(error)
        };
      }
      const savedRawText = input.draftRawText;
      const content = input.baseline.encoding === "utf-8-bom"
        ? `\uFEFF${savedRawText}`
        : savedRawText;
      if (new TextEncoder().encode(content).byteLength > RAW_MANUSCRIPT_MAX_BYTES) {
        return {
          operation: "save",
          status: "error",
          operationId,
          error: errorDetails(MANUSCRIPT_OPERATION_ERROR_CODES.fileTooLarge)
        };
      }
      try {
        const result = await dependencies.nativePort.save({
          ...readInput,
          expectedRevision: input.baseline.revision,
          content
        });
        if (result.status === "error") {
          const error = mapNativeError(result);
          return {
            operation: "save",
            status: error.writeApplied === true || error.writeApplied === "unknown"
              ? "write-applied-readback-failed"
              : error.code === MANUSCRIPT_OPERATION_ERROR_CODES.revisionConflict
                ? "conflict"
                : "error",
            operationId,
            error
          };
        }
        if (!validateNativeIdentity(file, result)) {
          const writeApplied = result.writeApplied ?? true;
          return {
            operation: "save",
            status: writeApplied ? "write-applied-readback-failed" : "error",
            operationId,
            error: errorDetails(
              writeApplied
                ? MANUSCRIPT_OPERATION_ERROR_CODES.verificationFailed
                : MANUSCRIPT_OPERATION_ERROR_CODES.pathIdentityMismatch,
              {
                category: "identity",
                writeApplied,
                recoveryRequired: writeApplied,
                causeCode: "READBACK_IDENTITY_MISMATCH"
              }
            )
          };
        }
        const snapshot = toSnapshot(result);
        if (
          snapshot.rawText !== savedRawText ||
          snapshot.encoding !== input.baseline.encoding
        ) {
          const writeApplied = result.writeApplied ?? true;
          return {
            operation: "save",
            status: writeApplied ? "write-applied-readback-failed" : "error",
            operationId,
            error: errorDetails(
              MANUSCRIPT_OPERATION_ERROR_CODES.verificationFailed,
              {
                writeApplied,
                recoveryRequired: writeApplied,
                causeCode: "READBACK_CONTENT_MISMATCH"
              }
            )
          };
        }
        const data: RawManuscriptSaveSuccess = {
          snapshot,
          savedRawText,
          writeApplied: result.writeApplied ?? true
        };
        return {
          operation: "save",
          status: data.writeApplied ? "success" : "no-op",
          operationId,
          data
        };
      } catch {
        return {
          operation: "save",
          status: "write-applied-readback-failed",
          operationId,
          error: errorDetails(
            MANUSCRIPT_OPERATION_ERROR_CODES.readbackFailed,
            {
              retryable: true,
              writeApplied: "unknown",
              recoveryRequired: true,
              causeCode: "NATIVE_PORT_REJECTED"
            }
          )
        };
      }
    }
  };
}

export const tauriRawManuscriptNativePort: RawManuscriptNativePort = {
  read(input) {
    return invoke<NativeRawManuscriptFileResult>(
      "read_explicit_manuscript_file",
      {
        filePath: input.filePath,
        expectedPathIdentity: input.expectedPathIdentity,
        expectedFileName: input.expectedFileName,
        locationMode: input.locationMode,
        configuredRoot: input.configuredRoot
      }
    );
  },
  save(input) {
    return invoke<NativeRawManuscriptFileResult>(
      "save_explicit_manuscript_file_atomic",
      {
        filePath: input.filePath,
        expectedPathIdentity: input.expectedPathIdentity,
        expectedFileName: input.expectedFileName,
        expectedRevision: input.expectedRevision,
        content: input.content,
        locationMode: input.locationMode,
        configuredRoot: input.configuredRoot
      }
    );
  }
};

export const rawManuscriptGateway = createRawManuscriptGateway({
  nativePort: tauriRawManuscriptNativePort
});
