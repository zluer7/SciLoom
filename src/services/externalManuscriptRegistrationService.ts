import type { EntityId } from "../types/common";
import type { FileRefOwnerType } from "../types/experiment";
import type { ManuscriptChannel } from "../types/manuscriptChannel";
import {
  MANUSCRIPT_IO_ERROR_CODES,
  type ExternalManuscriptRegistrationResult,
  type ManuscriptIoErrorCode
} from "../types/manuscriptIo";
import { fileRefService } from "./fileRefService";
import { validateFileRefOwner } from "./fileRefOwnerValidator";
import { localMarkdownFileService } from "./localMarkdownFileService";
import { nativeManuscriptIoService } from "./nativeManuscriptIoService";

export interface ExternalManuscriptRegistrationDependencies {
  validateOwner: typeof validateFileRefOwner;
  selectMarkdown: typeof localMarkdownFileService.selectMarkdownFile;
  readExternal: typeof nativeManuscriptIoService.readManuscriptFile;
  registerFileRef: typeof fileRefService.registerFileRef;
}

const defaultDependencies: ExternalManuscriptRegistrationDependencies = {
  validateOwner: validateFileRefOwner,
  selectMarkdown: localMarkdownFileService.selectMarkdownFile,
  readExternal: nativeManuscriptIoService.readManuscriptFile,
  registerFileRef: fileRefService.registerFileRef
};

function failure(
  ownerType: FileRefOwnerType,
  ownerId: EntityId,
  status: "canceled" | "error",
  code: ManuscriptIoErrorCode,
  message: string,
  requestToken?: number
): ExternalManuscriptRegistrationResult {
  return { status, ownerType, ownerId, error: { code, message }, warnings: [], requestToken };
}

function nativeErrorCode(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = Object.values(MANUSCRIPT_IO_ERROR_CODES).find((candidate) => message.includes(candidate));
  return code ?? MANUSCRIPT_IO_ERROR_CODES.readFailed;
}

export function createExternalManuscriptRegistrationService(
  dependencies: ExternalManuscriptRegistrationDependencies = defaultDependencies
) {
  return {
    async selectAndRegisterExternalManuscript(
      ownerType: FileRefOwnerType,
      ownerId: EntityId,
      options: { title?: string; requestToken?: number; manuscriptChannel?: ManuscriptChannel } = {}
    ): Promise<ExternalManuscriptRegistrationResult> {
      try {
        await dependencies.validateOwner(ownerType, ownerId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = message.includes("OWNER_DELETED")
          ? MANUSCRIPT_IO_ERROR_CODES.ownerDeleted
          : MANUSCRIPT_IO_ERROR_CODES.ownerNotFound;
        return failure(ownerType, ownerId, "error", code, message, options.requestToken);
      }
      const selection = await dependencies.selectMarkdown(options.title);
      if (!selection.ok) {
        if (selection.errorCode === "canceled") {
          return failure(
            ownerType,
            ownerId,
            "canceled",
            MANUSCRIPT_IO_ERROR_CODES.externalSelectionCanceled,
            "The user canceled external manuscript selection.",
            options.requestToken
          );
        }
        const code = selection.errorCode === "invalid_extension"
          ? MANUSCRIPT_IO_ERROR_CODES.extensionUnsupported
          : MANUSCRIPT_IO_ERROR_CODES.externalRegistrationFailed;
        return failure(ownerType, ownerId, "error", code, selection.errorCode, options.requestToken);
      }
      let readResult;
      try {
        readResult = await dependencies.readExternal({
          filePath: selection.path,
          locationMode: "external"
        });
      } catch (error) {
        return failure(
          ownerType,
          ownerId,
          "error",
          nativeErrorCode(error),
          error instanceof Error ? error.message : String(error),
          options.requestToken
        );
      }
      try {
        const ensured = await dependencies.registerFileRef({
          ownerType,
          ownerId,
          manuscriptChannel: options.manuscriptChannel ?? "primary",
          resourceKind: "file",
          fileRole: "manuscript",
          locationMode: "external",
          fileType: "markdown",
          path: readResult.path,
          title: readResult.fileName,
          source: "imported"
        });
        return {
          status: ensured.state === "reused" ? "skipped" : "success",
          ownerType,
          ownerId,
          registeredFileRef: ensured.fileRef,
          fileRefState: ensured.state,
          content: readResult.content,
          sizeBytes: readResult.sizeBytes,
          encoding: readResult.encoding,
          path: readResult.path,
          warnings: [],
          requestToken: options.requestToken
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = message.includes("FILE_REF_IDENTITY_CONFLICT")
          ? MANUSCRIPT_IO_ERROR_CODES.externalIdentityConflict
          : MANUSCRIPT_IO_ERROR_CODES.externalRegistrationFailed;
        return failure(ownerType, ownerId, "error", code, message, options.requestToken);
      }
    }
  };
}

export const externalManuscriptRegistrationService =
  createExternalManuscriptRegistrationService();

