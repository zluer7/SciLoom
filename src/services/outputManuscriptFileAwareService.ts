import type {
  OutputManuscriptDocument,
  OutputManuscriptOperationResult,
  OutputManuscriptOwnerType,
  OutputManuscriptStructuredSnapshot
} from "../types";
import { OUTPUT_MANUSCRIPT_FILE_ERROR_CODES } from "../types";
import type { EntityId } from "../types/common";
import type {
  ReadCurrentManuscriptResult,
  ReadManuscriptByFileRefResult,
  SaveCurrentManuscriptResult,
  SaveManuscriptByFileRefResult
} from "../types/manuscriptIo";
import { getSafeManuscriptBasename } from "./fileRefService";
import { manuscriptIoService } from "./manuscriptIoService";
import {
  replaceOutputManuscriptStandardBlocks,
  refreshOutputManuscriptStandardBlocks
} from "./outputManuscriptBlockAdapterService";
import { outputManuscriptLifecycleService } from "./outputManuscriptLifecycleService";
import { outputManuscriptStructuredSnapshotService } from "./outputManuscriptStructuredSnapshotService";
import { parseLabPodMarkdownDocument } from "./labPodMarkdownDocumentService";

type ReadResult = ReadCurrentManuscriptResult | ReadManuscriptByFileRefResult;
type SaveResult = SaveCurrentManuscriptResult | SaveManuscriptByFileRefResult;

export interface OutputManuscriptFileAwareDependencies {
  assertOwnerActive(ownerType: OutputManuscriptOwnerType, ownerId: EntityId, channel: "primary"): Promise<unknown>;
  getSnapshot(ownerType: OutputManuscriptOwnerType, ownerId: EntityId, filename?: string): Promise<OutputManuscriptStructuredSnapshot>;
  readCurrent: typeof manuscriptIoService.readCurrentManuscript;
  readTarget: typeof manuscriptIoService.readManuscriptByFileRef;
  saveCurrent: typeof manuscriptIoService.saveCurrentManuscript;
  saveTarget: typeof manuscriptIoService.saveManuscriptByFileRef;
}

const defaultDependencies: OutputManuscriptFileAwareDependencies = {
  assertOwnerActive: outputManuscriptLifecycleService.assertOwnerActive,
  getSnapshot: outputManuscriptStructuredSnapshotService.get,
  readCurrent: manuscriptIoService.readCurrentManuscript,
  readTarget: manuscriptIoService.readManuscriptByFileRef,
  saveCurrent: manuscriptIoService.saveCurrentManuscript,
  saveTarget: manuscriptIoService.saveManuscriptByFileRef
};

function failure<T>(code: string, message: string, warnings: string[] = []): OutputManuscriptOperationResult<T> {
  return { status: "error", error: { code, message }, warnings, currentChanged: false };
}

function parseDocument(
  read: Extract<ReadResult, { status: "success" }>,
  snapshot: OutputManuscriptStructuredSnapshot
): OutputManuscriptOperationResult<OutputManuscriptDocument> {
  const parsed = parseLabPodMarkdownDocument(read.content);
  if (parsed.status === "invalid" || parsed.status === "ambiguous") {
    return failure(
      parsed.status === "ambiguous"
        ? OUTPUT_MANUSCRIPT_FILE_ERROR_CODES.parseAmbiguous
        : OUTPUT_MANUSCRIPT_FILE_ERROR_CODES.parseInvalid,
      `Outputs manuscript standard blocks are ${parsed.status}.`,
      parsed.diagnostics.map((diagnostic) => diagnostic.code)
    );
  }
  const standard = parsed.status === "valid" || parsed.status === "valid-empty";
  return {
    status: "success",
    data: {
      ownerType: read.ownerType as OutputManuscriptOwnerType,
      ownerId: read.ownerId,
      channel: "primary",
      fileRefId: read.fileRefId,
      filename: getSafeManuscriptBasename(read.path) || "manuscript.md",
      locationMode: read.locationMode,
      rawMarkdown: read.content,
      body: standard ? parsed.body ?? "" : read.content,
      parsed,
      snapshot,
      warnings: [
        ...read.warnings,
        ...(parsed.status === "missing" ? ["LABPOD_STANDARD_BLOCKS_MISSING"] : [])
      ],
      requestToken: read.requestToken
    },
    warnings: read.warnings,
    currentChanged: false
  };
}

function sharedFailure<T>(result: Extract<ReadResult | SaveResult, { status: "error" }>) {
  return failure<T>(result.error.code, result.error.message, result.warnings);
}

function ownerFailure<T>(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.includes("CLEANUP_IN_PROGRESS")
    ? OUTPUT_MANUSCRIPT_FILE_ERROR_CODES.cleanupInProgress
    : message.includes("OWNER_NOT_FOUND")
      ? OUTPUT_MANUSCRIPT_FILE_ERROR_CODES.ownerNotFound
      : message.includes("OWNER_DELETED")
        ? OUTPUT_MANUSCRIPT_FILE_ERROR_CODES.ownerDeleted
        : OUTPUT_MANUSCRIPT_FILE_ERROR_CODES.operationFailed;
  return failure<T>(code, message);
}

export function createOutputManuscriptFileAwareService(
  dependencies: OutputManuscriptFileAwareDependencies = defaultDependencies
) {
  const active = (
    ownerType: OutputManuscriptOwnerType,
    ownerId: EntityId,
    channel: "primary"
  ) => dependencies.assertOwnerActive(ownerType, ownerId, channel);

  async function readCurrent(input: {
    ownerType: OutputManuscriptOwnerType;
    ownerId: EntityId;
    channel: "primary";
    requestToken?: number;
  }): Promise<OutputManuscriptOperationResult<OutputManuscriptDocument>> {
    try { await active(input.ownerType, input.ownerId, input.channel); }
    catch (error) { return ownerFailure(error); }
    const read = await dependencies.readCurrent(input.ownerType, input.ownerId, {
      manuscriptChannel: input.channel,
      requestToken: input.requestToken
    });
    if (read.status === "error") return sharedFailure(read);
    const filename = getSafeManuscriptBasename(read.path);
    try {
      return parseDocument(read, await dependencies.getSnapshot(input.ownerType, input.ownerId, filename));
    } catch (error) {
      return failure(OUTPUT_MANUSCRIPT_FILE_ERROR_CODES.operationFailed, error instanceof Error ? error.message : String(error));
    }
  }

  async function readTarget(input: {
    ownerType: OutputManuscriptOwnerType;
    ownerId: EntityId;
    channel: "primary";
    fileRefId: EntityId;
    requestToken?: number;
  }): Promise<OutputManuscriptOperationResult<OutputManuscriptDocument>> {
    try { await active(input.ownerType, input.ownerId, input.channel); }
    catch (error) { return ownerFailure(error); }
    const read = await dependencies.readTarget(input.ownerType, input.ownerId, input.fileRefId, {
      manuscriptChannel: input.channel,
      requestToken: input.requestToken
    });
    if (read.status === "error") return sharedFailure(read);
    const filename = getSafeManuscriptBasename(read.path);
    try {
      return parseDocument(read, await dependencies.getSnapshot(input.ownerType, input.ownerId, filename));
    } catch (error) {
      return failure(OUTPUT_MANUSCRIPT_FILE_ERROR_CODES.operationFailed, error instanceof Error ? error.message : String(error));
    }
  }

  async function saveCurrent(input: {
    ownerType: OutputManuscriptOwnerType;
    ownerId: EntityId;
    channel: "primary";
    expectedCurrentFileRefId: EntityId;
    body: string;
    requestToken?: number;
  }): Promise<OutputManuscriptOperationResult<OutputManuscriptDocument>> {
    if (!input.expectedCurrentFileRefId) {
      return failure(OUTPUT_MANUSCRIPT_FILE_ERROR_CODES.currentStale, "expectedCurrentFileRefId is required.");
    }
    const current = await readCurrent(input);
    if (current.status !== "success") return current;
    if (current.data.fileRefId !== input.expectedCurrentFileRefId) {
      return failure(OUTPUT_MANUSCRIPT_FILE_ERROR_CODES.currentStale, "Current manuscript changed before save.");
    }
    const snapshot = await dependencies.getSnapshot(input.ownerType, input.ownerId, current.data.filename);
    const refreshed = refreshOutputManuscriptStandardBlocks(
      current.data.rawMarkdown,
      snapshot,
      input.body,
      current.data.filename
    );
    if (refreshed.status === "error") {
      return failure(
        refreshed.parsed.status === "ambiguous"
          ? OUTPUT_MANUSCRIPT_FILE_ERROR_CODES.parseAmbiguous
          : OUTPUT_MANUSCRIPT_FILE_ERROR_CODES.parseInvalid,
        "Current manuscript could not be refreshed safely."
      );
    }
    const saved = await dependencies.saveCurrent(input.ownerType, input.ownerId, refreshed.markdown, {
      manuscriptChannel: input.channel,
      expectedCurrentFileRefId: input.expectedCurrentFileRefId,
      requestToken: input.requestToken
    });
    if (saved.status === "error") return sharedFailure(saved);
    return readCurrent(input);
  }

  async function saveCurrentDocument(input: {
    ownerType: OutputManuscriptOwnerType;
    ownerId: EntityId;
    channel: "primary";
    expectedCurrentFileRefId: EntityId;
    metaSnapshot: string;
    outline: string;
    body: string;
    requestToken?: number;
  }): Promise<OutputManuscriptOperationResult<OutputManuscriptDocument>> {
    if (!input.expectedCurrentFileRefId) {
      return failure(OUTPUT_MANUSCRIPT_FILE_ERROR_CODES.currentStale, "expectedCurrentFileRefId is required.");
    }
    const current = await readCurrent(input);
    if (current.status !== "success") return current;
    if (current.data.fileRefId !== input.expectedCurrentFileRefId) {
      return failure(OUTPUT_MANUSCRIPT_FILE_ERROR_CODES.currentStale, "Current manuscript changed before save.");
    }
    const replaced = replaceOutputManuscriptStandardBlocks(current.data.rawMarkdown, {
      metaSnapshot: input.metaSnapshot,
      outline: input.outline,
      body: input.body
    });
    if (replaced.status === "error") {
      return failure(
        replaced.parsed.status === "ambiguous"
          ? OUTPUT_MANUSCRIPT_FILE_ERROR_CODES.parseAmbiguous
          : OUTPUT_MANUSCRIPT_FILE_ERROR_CODES.parseInvalid,
        "Current manuscript standard blocks could not be updated safely."
      );
    }
    const saved = await dependencies.saveCurrent(input.ownerType, input.ownerId, replaced.markdown, {
      manuscriptChannel: input.channel,
      expectedCurrentFileRefId: input.expectedCurrentFileRefId,
      requestToken: input.requestToken
    });
    if (saved.status === "error") return sharedFailure(saved);
    return readCurrent(input);
  }

  async function settleCurrentForFormalSwitch(input: {
    ownerType: OutputManuscriptOwnerType;
    ownerId: EntityId;
    channel: "primary";
    expectedCurrentFileRefId: EntityId;
    draftMarkdown?: string;
    requestToken?: number;
  }): Promise<OutputManuscriptOperationResult<OutputManuscriptDocument>> {
    const current = await readCurrent(input);
    if (current.status !== "success") return current;
    if (current.data.fileRefId !== input.expectedCurrentFileRefId) {
      return failure(OUTPUT_MANUSCRIPT_FILE_ERROR_CODES.currentStale, "Current manuscript changed before formal switch.");
    }
    const source = input.draftMarkdown ?? current.data.rawMarkdown;
    const parsedSource = parseLabPodMarkdownDocument(source);
    if (parsedSource.status === "invalid" || parsedSource.status === "ambiguous") {
      return failure(
        parsedSource.status === "ambiguous"
          ? OUTPUT_MANUSCRIPT_FILE_ERROR_CODES.parseAmbiguous
          : OUTPUT_MANUSCRIPT_FILE_ERROR_CODES.parseInvalid,
        "Current manuscript draft could not be settled safely."
      );
    }
    const body = parsedSource.status === "valid" || parsedSource.status === "valid-empty"
      ? parsedSource.body ?? ""
      : source;
    const snapshot = await dependencies.getSnapshot(input.ownerType, input.ownerId, current.data.filename);
    const refreshed = refreshOutputManuscriptStandardBlocks(source, snapshot, body, current.data.filename);
    if (refreshed.status === "error") {
      return failure(OUTPUT_MANUSCRIPT_FILE_ERROR_CODES.parseInvalid, "Current manuscript standard blocks could not be settled safely.");
    }
    const saved = await dependencies.saveCurrent(input.ownerType, input.ownerId, refreshed.markdown, {
      manuscriptChannel: input.channel,
      expectedCurrentFileRefId: input.expectedCurrentFileRefId,
      requestToken: input.requestToken
    });
    if (saved.status === "error") return sharedFailure(saved);
    return readCurrent(input);
  }

  async function saveTarget(input: {
    ownerType: OutputManuscriptOwnerType;
    ownerId: EntityId;
    channel: "primary";
    fileRefId: EntityId;
    body: string;
    confirmedExternalWrite: boolean;
    requestToken?: number;
  }): Promise<OutputManuscriptOperationResult<OutputManuscriptDocument>> {
    const target = await readTarget(input);
    if (target.status !== "success") return target;
    const snapshot = await dependencies.getSnapshot(input.ownerType, input.ownerId, target.data.filename);
    const refreshed = refreshOutputManuscriptStandardBlocks(
      target.data.rawMarkdown,
      snapshot,
      input.body,
      target.data.filename
    );
    if (refreshed.status === "error") {
      return failure(OUTPUT_MANUSCRIPT_FILE_ERROR_CODES.parseInvalid, "Target manuscript could not be refreshed safely.");
    }
    const saved = await dependencies.saveTarget(
      input.ownerType,
      input.ownerId,
      input.fileRefId,
      refreshed.markdown,
      {
        manuscriptChannel: input.channel,
        confirmedExternalWrite: input.confirmedExternalWrite,
        requestToken: input.requestToken
      }
    );
    if (saved.status === "error") return sharedFailure(saved);
    return readTarget(input);
  }

  async function saveTargetDocument(input: {
    ownerType: OutputManuscriptOwnerType;
    ownerId: EntityId;
    channel: "primary";
    fileRefId: EntityId;
    metaSnapshot: string;
    outline: string;
    body: string;
    confirmedExternalWrite: boolean;
    requestToken?: number;
  }): Promise<OutputManuscriptOperationResult<OutputManuscriptDocument>> {
    const target = await readTarget(input);
    if (target.status !== "success") return target;
    const replaced = replaceOutputManuscriptStandardBlocks(target.data.rawMarkdown, {
      metaSnapshot: input.metaSnapshot,
      outline: input.outline,
      body: input.body
    });
    if (replaced.status === "error") {
      return failure(
        replaced.parsed.status === "ambiguous"
          ? OUTPUT_MANUSCRIPT_FILE_ERROR_CODES.parseAmbiguous
          : OUTPUT_MANUSCRIPT_FILE_ERROR_CODES.parseInvalid,
        "Target manuscript standard blocks could not be updated safely."
      );
    }
    const saved = await dependencies.saveTarget(
      input.ownerType,
      input.ownerId,
      input.fileRefId,
      replaced.markdown,
      {
        manuscriptChannel: input.channel,
        confirmedExternalWrite: input.confirmedExternalWrite,
        requestToken: input.requestToken
      }
    );
    if (saved.status === "error") return sharedFailure(saved);
    return readTarget(input);
  }

  return {
    readTargetForFormalSwitch: readTarget,
    settleCurrentForFormalSwitch
  };
}

export const outputManuscriptFileAwareService = createOutputManuscriptFileAwareService();
