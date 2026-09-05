import type { EntityId, FileRef, FileRefOwnerType, ManuscriptBinding, ManuscriptChannel } from "../types";
import {
  MANUSCRIPT_SWITCH_ERROR_CODES,
  type AvailableManuscriptItem,
  type AvailableManuscriptsResult,
  type ManuscriptSwitchErrorCode
} from "../types/manuscriptSwitch";
import { fileRefService, getSafeManuscriptBasename, summarizeFileRefPath } from "./fileRefService";
import { validateFileRefOwner } from "./fileRefOwnerValidator";
import { manuscriptBindingService } from "./manuscriptBindingService";

export interface ManuscriptListDependencies {
  validateOwner: typeof validateFileRefOwner;
  getBinding(ownerType: FileRefOwnerType, ownerId: EntityId, manuscriptChannel?: ManuscriptChannel): Promise<ManuscriptBinding | undefined>;
  getFileRefs(ownerType: FileRefOwnerType, ownerId: EntityId): Promise<FileRef[]>;
}

const defaultDependencies: ManuscriptListDependencies = {
  validateOwner: validateFileRefOwner,
  getBinding: manuscriptBindingService.getBindingByOwner,
  getFileRefs: fileRefService.getFileRefsByOwner
};

function ownerError(error: unknown): ManuscriptSwitchErrorCode {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("OWNER_DELETED")
    ? MANUSCRIPT_SWITCH_ERROR_CODES.ownerDeleted
    : MANUSCRIPT_SWITCH_ERROR_CODES.ownerNotFound;
}

function compareManuscripts(left: AvailableManuscriptItem, right: AvailableManuscriptItem) {
  if (left.isCurrent !== right.isCurrent) return left.isCurrent ? -1 : 1;
  if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
  if (left.locationMode !== right.locationMode) return left.locationMode === "managed" ? -1 : 1;
  const created = left.createdAt.localeCompare(right.createdAt);
  if (created !== 0) return created;
  const title = left.title.localeCompare(right.title);
  return title !== 0 ? title : left.fileRefId.localeCompare(right.fileRefId);
}

export function createManuscriptListService(
  dependencies: ManuscriptListDependencies = defaultDependencies
) {
  return {
    async getAvailableManuscripts(
      ownerType: FileRefOwnerType,
      ownerId: EntityId,
      manuscriptChannel: ManuscriptChannel = "primary"
    ): Promise<AvailableManuscriptsResult> {
      try {
        await dependencies.validateOwner(ownerType, ownerId);
      } catch (error) {
        return {
          status: "error",
          ownerType,
          ownerId,
          error: {
            code: ownerError(error),
            message: error instanceof Error ? error.message : String(error)
          }
        };
      }
      const binding = await dependencies.getBinding(ownerType, ownerId, manuscriptChannel);
      if (!binding) {
        return {
          status: "error",
          ownerType,
          ownerId,
          error: {
            code: MANUSCRIPT_SWITCH_ERROR_CODES.bindingNotFound,
            message: "Manuscript binding was not found."
          }
        };
      }
      const refs = await dependencies.getFileRefs(ownerType, ownerId);
      const items = refs
        .filter((fileRef) =>
          !fileRef.deletedAt &&
          fileRef.ownerType === ownerType &&
          fileRef.ownerId === ownerId &&
          fileRef.resourceKind === "file" &&
          fileRef.fileRole === "manuscript" &&
          (fileRef.manuscriptChannel ?? "primary") === manuscriptChannel &&
          (fileRef.locationMode === "managed" || fileRef.locationMode === "external")
        )
        .flatMap((fileRef): AvailableManuscriptItem[] => {
          const displayName = getSafeManuscriptBasename(fileRef.path);
          return displayName ? [{
            fileRefId: fileRef.id,
            title: fileRef.title,
            displayName,
            pathSummary: summarizeFileRefPath(fileRef.path),
            locationMode: fileRef.locationMode,
            isCurrent: binding.currentFileRefId === fileRef.id,
            isDefault: binding.defaultManuscriptFileRefId === fileRef.id,
            source: fileRef.source,
            createdAt: fileRef.createdAt,
            updatedAt: fileRef.updatedAt
          }] : [];
        })
        .sort(compareManuscripts);
      return { status: "success", ownerType, ownerId, items };
    }
  };
}

export const manuscriptListService = createManuscriptListService();
