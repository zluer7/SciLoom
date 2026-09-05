import type {
  EntityId,
  FileRef,
  FileRefOwnerType,
  ManuscriptBinding,
  ManuscriptChannel,
  WriteFeedbackResult
} from "../types";
import { MANUSCRIPT_IO_ERROR_CODES, type ReadManuscriptByFileRefResult } from "../types/manuscriptIo";
import {
  MANUSCRIPT_SWITCH_ERROR_CODES,
  type ManuscriptEditorDocument,
  type ManuscriptSwitchErrorCode,
  type SwitchCurrentManuscriptInput,
  type SwitchCurrentManuscriptResult
} from "../types/manuscriptSwitch";
import { fileRefService } from "./fileRefService";
import { createPathIdentityKey } from "./fileRefIdentity";
import { validateFileRefOwner } from "./fileRefOwnerValidator";
import {
  parseLabPodMarkdownDocument,
  upsertLabPodStandardBlocks
} from "./labPodMarkdownDocumentService";
import { manuscriptBindingService } from "./manuscriptBindingService";
import { manuscriptIoService } from "./manuscriptIoService";
import { isManuscriptEditorDirty } from "./manuscriptEditorStateService";
import { manuscriptRequestTokenController } from "./manuscriptRequestTokenController";
import { isLikelyAbsoluteLocalPath } from "./localPathService";
import { assertLiteratureDocumentV2 } from "./literatureMarkdownCodecService";

export interface ManuscriptSwitchDependencies {
  validateOwner: typeof validateFileRefOwner;
  getBinding(ownerType: FileRefOwnerType, ownerId: EntityId, manuscriptChannel?: ManuscriptChannel): Promise<ManuscriptBinding | undefined>;
  getFileRef(id: EntityId): Promise<FileRef | undefined>;
  getDeletedFileRef(id: EntityId): Promise<FileRef | undefined>;
  readTarget(
    ownerType: FileRefOwnerType,
    ownerId: EntityId,
    fileRefId: EntityId,
    options: { requestToken?: number; manuscriptChannel?: ManuscriptChannel }
  ): Promise<ReadManuscriptByFileRefResult>;
  saveCurrent: typeof manuscriptIoService.saveCurrentManuscript;
  setCurrent(
    ownerType: FileRefOwnerType,
    ownerId: EntityId,
    fileRefId: EntityId,
    manuscriptChannel?: ManuscriptChannel,
    expectedCurrentFileRefId?: EntityId | null
  ): Promise<WriteFeedbackResult<ManuscriptBinding>>;
  isRequestCurrent(token: number): boolean;
  validateTargetDocument?(input: {
    ownerType: FileRefOwnerType;
    ownerId: EntityId;
    manuscriptChannel: ManuscriptChannel;
    metaSnapshot: string;
    outline: string;
  }): void | Promise<void>;
  refreshTargetBeforeSwitch?(input: {
    ownerType: FileRefOwnerType;
    ownerId: EntityId;
    manuscriptChannel: ManuscriptChannel;
    targetFileRefId: EntityId;
    confirmedExternalWrite: boolean;
    requestToken: number;
  }): Promise<
    | { status: "success"; warnings?: string[] }
    | { status: "error"; error: { message: string }; warnings?: string[] }
  >;
}

const defaultDependencies: ManuscriptSwitchDependencies = {
  validateOwner: validateFileRefOwner,
  getBinding: manuscriptBindingService.getBindingByOwner,
  getFileRef: fileRefService.getById,
  getDeletedFileRef: fileRefService.getDeletedById,
  readTarget: manuscriptIoService.readManuscriptByFileRef,
  saveCurrent: manuscriptIoService.saveCurrentManuscript,
  setCurrent: manuscriptBindingService.setCurrentManuscript,
  isRequestCurrent: manuscriptRequestTokenController.isCurrent,
  validateTargetDocument(input) {
    if (input.ownerType === "literature") {
      assertLiteratureDocumentV2({
        metaSnapshot: input.metaSnapshot,
        outline: input.outline,
        channel: input.manuscriptChannel
      });
    }
  }
};

function failure(
  input: Pick<SwitchCurrentManuscriptInput, "requestToken">,
  code: ManuscriptSwitchErrorCode,
  message: string,
  warnings: string[] = []
): SwitchCurrentManuscriptResult {
  return {
    status: "error",
    error: { code, message },
    warnings,
    requestToken: input.requestToken
  };
}

function ownerCode(error: unknown): ManuscriptSwitchErrorCode {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("OWNER_DELETED")
    ? MANUSCRIPT_SWITCH_ERROR_CODES.ownerDeleted
    : MANUSCRIPT_SWITCH_ERROR_CODES.ownerNotFound;
}

function targetReadCode(result: Extract<ReadManuscriptByFileRefResult, { status: "error" }>) {
  if (result.error.code === MANUSCRIPT_IO_ERROR_CODES.fileRefNotFound) {
    return MANUSCRIPT_SWITCH_ERROR_CODES.targetNotFound;
  }
  if (result.error.code === MANUSCRIPT_IO_ERROR_CODES.fileRefDeleted) {
    return MANUSCRIPT_SWITCH_ERROR_CODES.targetDeleted;
  }
  if (result.error.code === MANUSCRIPT_IO_ERROR_CODES.fileRefOwnerMismatch) {
    return MANUSCRIPT_SWITCH_ERROR_CODES.targetOwnerMismatch;
  }
  if (result.error.code === MANUSCRIPT_IO_ERROR_CODES.fileRefChannelMismatch) {
    return MANUSCRIPT_SWITCH_ERROR_CODES.targetChannelMismatch;
  }
  if (result.error.code === MANUSCRIPT_IO_ERROR_CODES.fileRefInvalidKind) {
    return MANUSCRIPT_SWITCH_ERROR_CODES.targetInvalidKind;
  }
  if (result.error.code === MANUSCRIPT_IO_ERROR_CODES.fileRefInvalidRole) {
    return MANUSCRIPT_SWITCH_ERROR_CODES.targetInvalidRole;
  }
  return MANUSCRIPT_SWITCH_ERROR_CODES.targetUnreadable;
}

function documentFromRead(
  read: Extract<ReadManuscriptByFileRefResult, { status: "success" }>,
  requestToken: number
): ManuscriptEditorDocument {
  const parsed = parseLabPodMarkdownDocument(read.content);
  const standard = parsed.status === "valid" || parsed.status === "valid-empty";
  const content = standard ? parsed.body ?? "" : read.content;
  return {
    ownerType: read.ownerType,
    ownerId: read.ownerId,
    bindingId: read.bindingId,
    fileRefId: read.fileRefId,
    path: read.path,
    locationMode: read.locationMode,
    source: read.source,
    rawMarkdown: read.content,
    loadedContent: content,
    draftContent: content,
    isDirty: false,
    parseStatus: parsed.status,
    metaSnapshot: parsed.metaSnapshot ?? "",
    outline: parsed.outline ?? "",
    outsideContent: parsed.outsideContent,
    diagnostics: parsed.diagnostics,
    requestToken,
    readOnly: !standard
  };
}

function validateTarget(
  input: SwitchCurrentManuscriptInput,
  target: FileRef
): SwitchCurrentManuscriptResult | undefined {
  if (target.deletedAt) {
    return failure(input, MANUSCRIPT_SWITCH_ERROR_CODES.targetDeleted, "Target FileRef is deleted.");
  }
  if (target.ownerType !== input.ownerType || target.ownerId !== input.ownerId) {
    return failure(input, MANUSCRIPT_SWITCH_ERROR_CODES.targetOwnerMismatch, "Target FileRef owner does not match.");
  }
  const manuscriptChannel = input.manuscriptChannel ?? "primary";
  if ((target.manuscriptChannel ?? "primary") !== manuscriptChannel) {
    return failure(input, MANUSCRIPT_SWITCH_ERROR_CODES.targetChannelMismatch, "Target FileRef channel does not match.");
  }
  if (target.resourceKind !== "file") {
    return failure(input, MANUSCRIPT_SWITCH_ERROR_CODES.targetInvalidKind, "Target FileRef is not a file.");
  }
  if (target.fileRole !== "manuscript") {
    return failure(input, MANUSCRIPT_SWITCH_ERROR_CODES.targetInvalidRole, "Target FileRef is not a manuscript.");
  }
  if (target.locationMode !== "managed" && target.locationMode !== "external") {
    return failure(input, MANUSCRIPT_SWITCH_ERROR_CODES.targetUnreadable, "Target location mode is invalid.");
  }
  if (!target.path.trim() || !isLikelyAbsoluteLocalPath(target.path)) {
    return failure(input, MANUSCRIPT_SWITCH_ERROR_CODES.targetUnreadable, "Target manuscript path must be absolute.");
  }
  try {
    if (createPathIdentityKey(target.path) !== target.pathIdentityKey) {
      return failure(input, MANUSCRIPT_SWITCH_ERROR_CODES.targetUnreadable, "Target manuscript path identity is invalid.");
    }
  } catch {
    return failure(input, MANUSCRIPT_SWITCH_ERROR_CODES.targetUnreadable, "Target manuscript path is invalid.");
  }
  if (!/\.(?:md|markdown)$/iu.test(target.path)) {
    return failure(input, MANUSCRIPT_SWITCH_ERROR_CODES.targetUnreadable, "Target manuscript extension is unsupported.");
  }
  return undefined;
}

export function createManuscriptSwitchService(
  overrides: Partial<ManuscriptSwitchDependencies> = {}
) {
  const dependencies: ManuscriptSwitchDependencies = { ...defaultDependencies, ...overrides };
  return {
    async switchCurrentManuscript(
      input: SwitchCurrentManuscriptInput
    ): Promise<SwitchCurrentManuscriptResult> {
      try {
        await dependencies.validateOwner(input.ownerType, input.ownerId);
      } catch (error) {
        return failure(
          input,
          ownerCode(error),
          error instanceof Error ? error.message : String(error)
        );
      }
      const manuscriptChannel = input.manuscriptChannel ?? "primary";
      const binding = await dependencies.getBinding(input.ownerType, input.ownerId, manuscriptChannel);
      if (!binding) {
        return failure(input, MANUSCRIPT_SWITCH_ERROR_CODES.bindingNotFound, "Manuscript binding was not found.");
      }
      if (binding.currentFileRefId !== input.currentEditorState.currentFileRefId) {
        return failure(input, MANUSCRIPT_SWITCH_ERROR_CODES.stale, "Editor current manuscript does not match binding.");
      }
      if (binding.currentFileRefId === input.targetFileRefId) {
        return {
          status: "skipped",
          reason: "already-current",
          currentEditorState: input.currentEditorState,
          warnings: [],
          requestToken: input.requestToken
        };
      }

      const target = await dependencies.getFileRef(input.targetFileRefId);
      if (!target) {
        const deleted = await dependencies.getDeletedFileRef(input.targetFileRefId);
        return failure(
          input,
          deleted ? MANUSCRIPT_SWITCH_ERROR_CODES.targetDeleted : MANUSCRIPT_SWITCH_ERROR_CODES.targetNotFound,
          deleted ? "Target FileRef is deleted." : "Target FileRef was not found."
        );
      }
      const targetError = validateTarget(input, target);
      if (targetError) return targetError;
      if (input.currentEditorState.hasPendingSave) {
        return failure(input, MANUSCRIPT_SWITCH_ERROR_CODES.saveInProgress, "A manuscript save is in progress.");
      }

      const dirty = isManuscriptEditorDirty(input.currentEditorState);
      if (dirty) {
        if (!input.dirtyDecision) {
          return failure(input, MANUSCRIPT_SWITCH_ERROR_CODES.dirtyRequiresDecision, "Dirty manuscript requires save, discard, or cancel.");
        }
        if (input.dirtyDecision === "cancel") {
          return failure(input, MANUSCRIPT_SWITCH_ERROR_CODES.canceled, "Manuscript switch was canceled.");
        }
        if (input.dirtyDecision === "discard" && input.confirmedDiscardUnsavedChanges !== true) {
          return failure(input, MANUSCRIPT_SWITCH_ERROR_CODES.discardNotConfirmed, "Discarding unsaved changes was not confirmed.");
        }
        if (input.dirtyDecision === "save") {
          if (input.currentEditorState.parseStatus !== "valid" && input.currentEditorState.parseStatus !== "valid-empty") {
            return failure(input, MANUSCRIPT_SWITCH_ERROR_CODES.saveFailed, "Non-standard or invalid current manuscript cannot be saved during switch.");
          }
          const serialized = upsertLabPodStandardBlocks(
            input.currentEditorState.rawMarkdown,
            {
              metaSnapshot: input.currentEditorState.metaSnapshot,
              outline: input.currentEditorState.outline,
              body: input.currentEditorState.draftContent
            }
          );
          if (serialized.status === "error") {
            return failure(input, MANUSCRIPT_SWITCH_ERROR_CODES.saveFailed, "Current manuscript serialization failed.");
          }
          if (!dependencies.isRequestCurrent(input.requestToken)) {
            return failure(input, MANUSCRIPT_SWITCH_ERROR_CODES.stale, "Manuscript switch request is stale.");
          }
          const saved = await dependencies.saveCurrent(
            input.ownerType,
            input.ownerId,
            serialized.markdown,
            {
              requestToken: input.requestToken,
              manuscriptChannel,
              expectedCurrentFileRefId: input.currentEditorState.currentFileRefId
            }
          );
          if (saved.status === "error") {
            return failure(input, MANUSCRIPT_SWITCH_ERROR_CODES.saveFailed, saved.error.message);
          }
        }
      }

      if (!dependencies.isRequestCurrent(input.requestToken)) {
        return failure(input, MANUSCRIPT_SWITCH_ERROR_CODES.stale, "Manuscript switch request is stale.");
      }
      if (dependencies.refreshTargetBeforeSwitch) {
        let refreshed;
        try {
          refreshed = await dependencies.refreshTargetBeforeSwitch({
            ownerType: input.ownerType,
            ownerId: input.ownerId,
            manuscriptChannel,
            targetFileRefId: input.targetFileRefId,
            confirmedExternalWrite: input.confirmedExternalTargetWrite === true,
            requestToken: input.requestToken
          });
        } catch (error) {
          return failure(
            input,
            MANUSCRIPT_SWITCH_ERROR_CODES.targetRefreshFailed,
            error instanceof Error ? error.message : String(error)
          );
        }
        if (refreshed.status === "error") {
          return failure(
            input,
            MANUSCRIPT_SWITCH_ERROR_CODES.targetRefreshFailed,
            refreshed.error.message,
            refreshed.warnings ?? []
          );
        }
        if (!dependencies.isRequestCurrent(input.requestToken)) {
          return failure(input, MANUSCRIPT_SWITCH_ERROR_CODES.stale, "Manuscript switch request is stale.");
        }
      }
      const read = await dependencies.readTarget(
        input.ownerType,
        input.ownerId,
        input.targetFileRefId,
        { requestToken: input.requestToken, manuscriptChannel }
      );
      if (read.status === "error") {
        return failure(input, targetReadCode(read), read.error.message);
      }
      const parsed = parseLabPodMarkdownDocument(read.content);
      if (parsed.status === "invalid") {
        return failure(
          input,
          MANUSCRIPT_SWITCH_ERROR_CODES.targetParseInvalid,
          "Target manuscript standard blocks are invalid.",
          parsed.diagnostics.map((item) => item.code)
        );
      }
      if (parsed.status === "ambiguous") {
        return failure(
          input,
          MANUSCRIPT_SWITCH_ERROR_CODES.targetParseAmbiguous,
          "Target manuscript standard blocks are ambiguous.",
          parsed.diagnostics.map((item) => item.code)
        );
      }
      if (parsed.status === "valid" || parsed.status === "valid-empty") {
        try {
          await dependencies.validateTargetDocument?.({
            ownerType: input.ownerType,
            ownerId: input.ownerId,
            manuscriptChannel,
            metaSnapshot: parsed.metaSnapshot ?? "",
            outline: parsed.outline ?? ""
          });
        } catch (error) {
          return failure(
            input,
            MANUSCRIPT_SWITCH_ERROR_CODES.targetContentInvalid,
            error instanceof Error ? error.message : String(error)
          );
        }
      }
      if (!dependencies.isRequestCurrent(input.requestToken)) {
        return failure(input, MANUSCRIPT_SWITCH_ERROR_CODES.stale, "Manuscript switch request is stale.");
      }
      const updated = await dependencies.setCurrent(
        input.ownerType,
        input.ownerId,
        input.targetFileRefId,
        manuscriptChannel,
        input.currentEditorState.currentFileRefId
      );
      if (updated.status === "error" || updated.data?.currentFileRefId !== input.targetFileRefId) {
        return failure(
          input,
          MANUSCRIPT_SWITCH_ERROR_CODES.bindingUpdateFailed,
          updated.errors[0] ?? "Current manuscript binding update failed."
        );
      }
      return {
        status: "success",
        document: documentFromRead(read, input.requestToken),
        warnings: parsed.status === "missing" ? ["LABPOD_STANDARD_BLOCKS_MISSING"] : [],
        requestToken: input.requestToken
      };
    }
  };
}

export const manuscriptSwitchService = createManuscriptSwitchService();
