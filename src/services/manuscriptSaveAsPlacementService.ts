import type {
  FileRef,
  FileRefOwnerType,
  ManuscriptChannel
} from "../types";
import type { FrozenSaveAsSourceEvidence } from "../types/manuscriptSaveAs";
import {
  fileRefService,
  getFileRefPathName
} from "./fileRefService";
import {
  createPathIdentityKey,
  validateManuscriptBindingReference
} from "./fileRefIdentity";
import {
  localMarkdownFileService,
  MARKDOWN_SAVE_PATH_FILTER,
  sanitizeMarkdownFileName
} from "./localMarkdownFileService";
import { isLikelyAbsoluteLocalPath } from "./localPathService";
import { manuscriptBindingService } from "./manuscriptBindingService";

export type SaveAsPlacementSource =
  | "ACTIVE_PHYSICAL_PARENT"
  | "AUTHORITATIVE_WORKSPACE_PLACEMENT";

export type SaveAsPlacementFailureReason =
  | "NO_ACTIVE_FILE"
  | "FILE_REF_MISSING"
  | "FILE_REF_DELETED"
  | "FILE_REF_IDENTITY_MISMATCH"
  | "PHYSICAL_PATH_MISSING"
  | "PHYSICAL_PATH_NOT_ABSOLUTE"
  | "PHYSICAL_PARENT_MISSING"
  | "PHYSICAL_PARENT_NOT_DIRECTORY"
  | "READBACK_FAILED"
  | "STALE_SESSION";

export interface SaveAsPlacementIdentity {
  ownerType: FileRefOwnerType;
  ownerId: string;
  channel: ManuscriptChannel;
  windowRole: "current" | "independent";
}

export interface SaveAsPlacementResolution {
  placementSource: SaveAsPlacementSource;
  expectedInitialDirectory: string;
  expectedInitialDirectoryIdentity: string;
  sourceFileName?: string;
  workspaceFileRefId?: string;
}

export type SaveAsPlacementResult =
  | { status: "resolved"; value: SaveAsPlacementResolution }
  | { status: "error"; reason: SaveAsPlacementFailureReason };

export type SaveAsPlacementSelection =
  | {
      status: "selected";
      path: string;
      requestToken: string;
      placement: SaveAsPlacementResolution;
      suggestedFilename: string;
      rawNativeSelectedPath: string;
      normalizedSelectedPath: string;
    }
  | { status: "canceled"; requestToken: string }
  | {
      status: "error";
      errorCode:
        | "SAVE_AS_PATH_INVALID"
        | "SAVE_AS_TARGET_CANDIDATE_INVALID"
        | "SAVE_AS_PERMISSION_DENIED"
        | "SAVE_AS_GUARD_CONFLICT"
        | "SAVE_AS_OPERATION_STALE";
      reason?: SaveAsPlacementFailureReason;
    };

interface PlacementDependencies {
  getFileRef(id: string): Promise<FileRef | undefined>;
  inspectFileRef(id: string): ReturnType<
    typeof fileRefService.inspectFileRefResource
  >;
  inspectDirectory(path: string): ReturnType<
    typeof fileRefService.inspectFileRefAvailability
  >;
  resolveBinding: typeof manuscriptBindingService.resolveIdentity;
  selectMarkdownSavePath: typeof localMarkdownFileService.selectMarkdownSavePath;
}

const RESERVED_WINDOWS_STEM = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

export function getAuthoritativePathParent(path: string) {
  const normalized = path.trim().replace(/[\\/]+$/u, "");
  const separator = Math.max(
    normalized.lastIndexOf("/"),
    normalized.lastIndexOf("\\")
  );
  if (separator <= 0 || (/^[a-z]:[\\/]/iu.test(normalized) && separator === 2)) {
    throw new Error("PHYSICAL_PARENT_MISSING");
  }
  return normalized.slice(0, separator);
}

export function resolveSaveAsSuggestedFilename(
  sourceFileName: string | undefined,
  ownerFallback: string
) {
  const source = sanitizeMarkdownFileName(
    sourceFileName?.trim() || ownerFallback
  );
  const stem = source
    .replace(/\.(?:md|markdown)$/iu, "")
    .replace(/[.\s]+$/gu, "")
    .trim();
  const safeStem = !stem || RESERVED_WINDOWS_STEM.test(stem)
    ? "labpod-notes"
    : stem;
  return sanitizeMarkdownFileName(`${safeStem.slice(0, 100)}-副本.md`);
}

function validOwnerFileRef(
  fileRef: FileRef,
  identity: SaveAsPlacementIdentity,
  expectedPathIdentity?: string
) {
  return (
    !fileRef.deletedAt &&
    fileRef.ownerType === identity.ownerType &&
    fileRef.ownerId === identity.ownerId &&
    fileRef.manuscriptChannel === identity.channel &&
    fileRef.resourceKind === "file" &&
    fileRef.fileRole === "manuscript" &&
    (!expectedPathIdentity ||
      (fileRef.pathIdentityKey === expectedPathIdentity &&
        createPathIdentityKey(fileRef.path) === expectedPathIdentity))
  );
}

export function createManuscriptSaveAsPlacementService(
  dependencies: PlacementDependencies
) {
  async function validateDirectory(
    path: string
  ): Promise<SaveAsPlacementResult> {
    if (!isLikelyAbsoluteLocalPath(path)) {
      return { status: "error", reason: "PHYSICAL_PATH_NOT_ABSOLUTE" };
    }
    try {
      const inspected = await dependencies.inspectDirectory(path);
      if (inspected.status === "missing") {
        return { status: "error", reason: "PHYSICAL_PARENT_MISSING" };
      }
      if (
        inspected.status !== "available" ||
        inspected.actualResourceKind !== "folder"
      ) {
        return {
          status: "error",
          reason: "PHYSICAL_PARENT_NOT_DIRECTORY"
        };
      }
      const authoritativePath = inspected.canonicalPath || inspected.path;
      return {
        status: "resolved",
        value: {
          placementSource: "AUTHORITATIVE_WORKSPACE_PLACEMENT",
          expectedInitialDirectory: authoritativePath,
          expectedInitialDirectoryIdentity:
            createPathIdentityKey(authoritativePath)
        }
      };
    } catch {
      return { status: "error", reason: "READBACK_FAILED" };
    }
  }

  async function resolveWorkspacePlacement(
    identity: SaveAsPlacementIdentity
  ): Promise<SaveAsPlacementResult> {
    try {
      const binding = await dependencies.resolveBinding({
        ownerType: identity.ownerType,
        ownerId: identity.ownerId,
        manuscriptChannel: identity.channel
      });
      const slot = binding.slots.defaultFolderFileRefId;
      if (!binding.identityResolved || slot.status !== "resolved" || !slot.fileRefId) {
        return { status: "error", reason: "READBACK_FAILED" };
      }
      const folder = await dependencies.getFileRef(slot.fileRefId);
      if (
        !folder ||
        validateManuscriptBindingReference(
          "defaultFolderFileRefId",
          {
            ownerType: identity.ownerType,
            ownerId: identity.ownerId,
            manuscriptChannel: identity.channel
          },
          folder
        ).length > 0
      ) {
        return { status: "error", reason: "FILE_REF_IDENTITY_MISMATCH" };
      }
      const checked = await validateDirectory(folder.path);
      return checked.status === "resolved"
        ? {
            status: "resolved",
            value: {
              ...checked.value,
              placementSource: "AUTHORITATIVE_WORKSPACE_PLACEMENT",
              workspaceFileRefId: folder.id
            }
          }
        : checked;
    } catch {
      return { status: "error", reason: "READBACK_FAILED" };
    }
  }

  async function resolvePlacement(input: {
    identity: SaveAsPlacementIdentity;
    sourceFileRefId: string | null;
    sourcePathIdentityKey?: string;
  }): Promise<SaveAsPlacementResult> {
    if (!input.sourceFileRefId) {
      return resolveWorkspacePlacement(input.identity);
    }
    try {
      const fileRef = await dependencies.getFileRef(input.sourceFileRefId);
      if (!fileRef) {
        return { status: "error", reason: "FILE_REF_MISSING" };
      }
      if (fileRef.deletedAt) {
        return { status: "error", reason: "FILE_REF_DELETED" };
      }
      if (!validOwnerFileRef(fileRef, input.identity, input.sourcePathIdentityKey)) {
        return { status: "error", reason: "FILE_REF_IDENTITY_MISMATCH" };
      }
      const inspected = await dependencies.inspectFileRef(fileRef.id);
      if (inspected.status === "missing") {
        return { status: "error", reason: "PHYSICAL_PATH_MISSING" };
      }
      if (
        inspected.status !== "available" ||
        inspected.actualResourceKind !== "file"
      ) {
        return { status: "error", reason: "READBACK_FAILED" };
      }
      const authoritativePath = inspected.canonicalPath || fileRef.path;
      if (!isLikelyAbsoluteLocalPath(authoritativePath)) {
        return { status: "error", reason: "PHYSICAL_PATH_NOT_ABSOLUTE" };
      }
      const parent = getAuthoritativePathParent(authoritativePath);
      const checked = await validateDirectory(parent);
      if (checked.status !== "resolved") return checked;
      return {
        status: "resolved",
        value: {
          ...checked.value,
          placementSource: "ACTIVE_PHYSICAL_PARENT",
          sourceFileName: getFileRefPathName(authoritativePath)
        }
      };
    } catch {
      return { status: "error", reason: "READBACK_FAILED" };
    }
  }

  function requestToken(
    source: FrozenSaveAsSourceEvidence,
    dialogRequestGeneration: number
  ) {
    return [
      "save-as-dialog-v1",
      source.owner.ownerType,
      source.owner.ownerId,
      source.owner.channel,
      source.owner.sourceWindowRole,
      source.sourceSessionKey,
      source.sourceFileRefId,
      `presentationEpoch=${source.sourceRuntimeGeneration}`,
      `sessionGeneration=${source.sourceRuntimeGeneration}`,
      `requestGeneration=${dialogRequestGeneration}`,
      source.operationGeneration,
      source.snapshotId,
      source.snapshotSha256
    ].join(":");
  }

  async function selectTarget(input: {
    frozenSource: FrozenSaveAsSourceEvidence;
    dialogRequestGeneration: number;
    pickerTitle: string;
    ownerFallbackFilename: string;
  }): Promise<SaveAsPlacementSelection> {
    const identity: SaveAsPlacementIdentity = {
      ownerType: input.frozenSource.owner.ownerType,
      ownerId: input.frozenSource.owner.ownerId,
      channel: input.frozenSource.owner.channel,
      windowRole: input.frozenSource.owner.sourceWindowRole
    };
    const placement = await resolvePlacement({
      identity,
      sourceFileRefId: input.frozenSource.sourceFileRefId,
      sourcePathIdentityKey: input.frozenSource.sourcePathIdentityKey
    });
    if (placement.status !== "resolved") {
      return {
        status: "error",
        errorCode:
          placement.reason === "STALE_SESSION"
            ? "SAVE_AS_OPERATION_STALE"
            : "SAVE_AS_PATH_INVALID",
        reason: placement.reason
      };
    }
    const token = requestToken(
      input.frozenSource,
      input.dialogRequestGeneration
    );
    const suggestedFilename = resolveSaveAsSuggestedFilename(
      placement.value.sourceFileName,
      input.ownerFallbackFilename
    );
    const selected = await dependencies.selectMarkdownSavePath({
      title: input.pickerTitle,
      suggestedFileName: suggestedFilename,
      defaultDirectory: placement.value.expectedInitialDirectory,
      requestToken: token,
      filter: MARKDOWN_SAVE_PATH_FILTER
    });
    if (selected.status === "SELECTED") {
      return {
        status: "selected",
        path: selected.path,
        requestToken: token,
        placement: placement.value,
        suggestedFilename,
        rawNativeSelectedPath: selected.rawNativeSelectedPath,
        normalizedSelectedPath: selected.normalizedSelectedPath
      };
    }
    if (selected.status === "CANCELLED") {
      return { status: "canceled", requestToken: token };
    }
    if (selected.status === "BUSY") {
      return { status: "error", errorCode: "SAVE_AS_GUARD_CONFLICT" };
    }
    return {
      status: "error",
      errorCode:
        selected.status === "CAPABILITY_DENIED"
          ? "SAVE_AS_PERMISSION_DENIED"
          : selected.status === "PATH_INVALID"
            ? "SAVE_AS_PATH_INVALID"
            : "SAVE_AS_TARGET_CANDIDATE_INVALID"
    };
  }

  return Object.freeze({
    resolvePlacement,
    resolveWorkspacePlacement,
    selectTarget
  });
}

export const manuscriptSaveAsPlacementService =
  createManuscriptSaveAsPlacementService({
    getFileRef: (id) => fileRefService.getById(id),
    inspectFileRef: (id) => fileRefService.inspectFileRefResource(id),
    inspectDirectory: (path) =>
      fileRefService.inspectFileRefAvailability({
        path,
        resourceKind: "folder"
      }),
    resolveBinding: (input) => manuscriptBindingService.resolveIdentity(input),
    selectMarkdownSavePath: (input) =>
      localMarkdownFileService.selectMarkdownSavePath(input)
  });
