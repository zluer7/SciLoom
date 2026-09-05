import { literatureRepository } from "../repositories/literatureRepository";
import type {
  EntityId,
  FileRefLocationMode,
  ManuscriptChannel
} from "../types";
import { assertValidManuscriptChannelForOwner } from "../types/manuscriptChannel";
import type { LiteratureManuscriptStatusSummary } from "../types/literatureContext";
import { parseLabPodMarkdownDocument, serializeLabPodMarkdownDocument } from "./labPodMarkdownDocumentService";
import { manuscriptBindingService } from "./manuscriptBindingService";
import { fileRefService } from "./fileRefService";
import { ensureLiteratureManuscriptProvisioned } from "./literatureManuscriptProvisioningService";
import { localMarkdownFileService } from "./localMarkdownFileService";
import { managedRootConfigService } from "./managedRootConfigService";
import {
  buildManagedManuscriptPath,
  createStableShortId,
  getManagedPathParent,
  isPathWithinDirectory,
  isPathWithinRoot
} from "./managedPathService";
import { nativeFileService } from "./nativeFileService";
import { nativeManuscriptIoService } from "./nativeManuscriptIoService";
import { createPathIdentityKey } from "./fileRefIdentity";
import { literatureManuscriptCutoverService } from "./literatureManuscriptCutoverService";
import {
  literatureCurrentFilenameService,
  toLiteratureManuscriptStatusSummary
} from "./literatureCurrentFilenameService";

export interface LiteratureTargetManuscriptDocument {
  literatureId: EntityId;
  manuscriptChannel: "literature_outline" | "dedicated_notes";
  fileRefId: EntityId;
  displayName: string;
  locationMode: FileRefLocationMode;
  rawMarkdown: string;
  metaSnapshot: string;
  outline: string;
  body: string;
  loadedOutline: string;
  loadedBody: string;
  parseStatus: import("../types").LabPodMarkdownDocumentStatus;
  diagnostics: import("../types").LabPodMarkdownDiagnostic[];
  createdAt: string;
  requestToken: number;
}

export interface LiteratureWorkspaceFolder {
  fileRefId: EntityId;
  path: string;
  managedRoot: string;
}

export interface LiteratureManuscriptPickerSelection {
  literatureId: EntityId;
  manuscriptChannel: ManuscriptChannel;
  path: string;
  displayName: string;
  locationMode: FileRefLocationMode;
  requestToken: number;
}

export type LiteratureManuscriptPickerResult =
  | { status: "success"; selection: LiteratureManuscriptPickerSelection }
  | { status: "canceled"; code: "MANUSCRIPT_PICKER_CANCELED"; requestToken: number }
  | { status: "error"; code: string; message: string; requestToken: number };

export type LiteratureManuscriptEnsureResult =
  | {
      status: "success" | "skipped";
      fileRefId: EntityId;
      locationMode: FileRefLocationMode;
      requestToken: number;
    }
  | { status: "error"; code: string; message: string; requestToken: number };

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

async function getActiveLiterature(literatureId: EntityId) {
  const literature = await literatureRepository.getById(literatureId);
  if (!literature) {
    throw new Error(`Literature not found or inactive: ${literatureId}.`);
  }
  return literature;
}

function pickerError(requestToken: number, code: string, message: string): LiteratureManuscriptPickerResult {
  return { status: "error", code, message, requestToken };
}

export async function resolveLiteratureWorkspaceFolder(
  literatureId: EntityId
): Promise<LiteratureWorkspaceFolder> {
  await getActiveLiterature(literatureId);
  const [outlineBinding, notesBinding] = await Promise.all([
    manuscriptBindingService.getBindingByOwner("literature", literatureId, "literature_outline"),
    manuscriptBindingService.getBindingByOwner("literature", literatureId, "dedicated_notes")
  ]);
  if (
    !outlineBinding?.defaultFolderFileRefId ||
    outlineBinding.defaultFolderFileRefId !== notesBinding?.defaultFolderFileRefId
  ) {
    throw new Error("WORKSPACE_FOLDER_BINDINGS_INVALID: Literature channels must share one workspace FileRef.");
  }
  const folder = await fileRefService.getById(outlineBinding.defaultFolderFileRefId);
  if (!folder) {
    throw new Error("WORKSPACE_FOLDER_FILE_REF_MISSING: Literature workspace FileRef is inactive.");
  }
  if (folder.ownerType !== "literature" || folder.ownerId !== literatureId) {
    throw new Error("WORKSPACE_FOLDER_OWNER_MISMATCH: Literature workspace owner does not match.");
  }
  if (
    folder.resourceKind !== "folder" ||
    folder.fileRole !== "defaultFolder" ||
    folder.locationMode !== "managed"
  ) {
    throw new Error("WORKSPACE_FOLDER_INVALID: Literature workspace FileRef contract is invalid.");
  }
  const rootStatus = await managedRootConfigService.getStatus();
  if (rootStatus.status !== "configured" || !rootStatus.managedRoot) {
    throw new Error("WORKSPACE_FOLDER_OUTSIDE_ROOT: Managed root is not configured or invalid.");
  }
  if (!isPathWithinRoot(rootStatus.managedRoot, folder.path)) {
    throw new Error("WORKSPACE_FOLDER_OUTSIDE_ROOT: Literature workspace is outside the managed root.");
  }
  const validated = await nativeFileService.validateManagedFolder(
    rootStatus.managedRoot,
    folder.path
  );
  if (createPathIdentityKey(validated.path) !== createPathIdentityKey(folder.path)) {
    throw new Error("WORKSPACE_FOLDER_OUTSIDE_ROOT: Workspace canonical path identity changed.");
  }
  return {
    fileRefId: folder.id,
    path: validated.path,
    managedRoot: rootStatus.managedRoot
  };
}

export async function selectLiteratureManuscript(
  literatureId: EntityId,
  manuscriptChannel: ManuscriptChannel,
  requestToken: number,
  title: string
): Promise<LiteratureManuscriptPickerResult> {
  try {
    assertValidManuscriptChannelForOwner(
      "literature",
      manuscriptChannel
    );
  } catch (error) {
    return pickerError(
      requestToken,
      "LITERATURE_MANUSCRIPT_CHANNEL_INVALID",
      error instanceof Error ? error.message : String(error)
    );
  }
  let workspace: LiteratureWorkspaceFolder;
  try {
    workspace = await resolveLiteratureWorkspaceFolder(literatureId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = message.match(/[A-Z][A-Z0-9_]+/u)?.[0] ?? "WORKSPACE_FOLDER_INVALID";
    return pickerError(requestToken, code, message);
  }
  const selected = await localMarkdownFileService.selectMarkdownFile(title, workspace.path);
  if (!selected.ok) {
    if (selected.errorCode === "canceled") {
      return { status: "canceled", code: "MANUSCRIPT_PICKER_CANCELED", requestToken };
    }
    const code = selected.errorCode === "invalid_extension"
      ? "MANUSCRIPT_PICKER_UNSUPPORTED_EXTENSION"
      : selected.errorCode === "not_file"
        ? "MANUSCRIPT_PICKER_TARGET_IS_DIRECTORY"
        : "MANUSCRIPT_PICKER_INVALID_SELECTION";
    return pickerError(requestToken, code, selected.errorCode);
  }
  return {
    status: "success",
    selection: {
      literatureId,
      manuscriptChannel,
      path: selected.path,
      displayName: selected.fileName,
      locationMode: isPathWithinDirectory(workspace.path, selected.path) ? "managed" : "external",
      requestToken
    }
  };
}

export async function ensureSelectedLiteratureManuscript(
  selection: LiteratureManuscriptPickerSelection
): Promise<LiteratureManuscriptEnsureResult> {
  try {
    assertValidManuscriptChannelForOwner(
      "literature",
      selection.manuscriptChannel
    );
    const workspace = await resolveLiteratureWorkspaceFolder(selection.literatureId);
    const locationMode = isPathWithinDirectory(workspace.path, selection.path)
      ? "managed"
      : "external";
    if (locationMode !== selection.locationMode) {
      return {
        status: "error",
        code: "MANUSCRIPT_PICKER_STALE",
        message: "The selected manuscript location changed before registration.",
        requestToken: selection.requestToken
      };
    }
    const read = await nativeManuscriptIoService.readManuscriptFile({
      filePath: selection.path,
      locationMode,
      configuredRoot: locationMode === "managed" ? workspace.managedRoot : undefined
    });
    if (locationMode === "managed" && !isPathWithinDirectory(workspace.path, read.path)) {
      return {
        status: "error",
        code: "WORKSPACE_FOLDER_OUTSIDE_ROOT",
        message: "The selected manuscript is outside the Literature workspace.",
        requestToken: selection.requestToken
      };
    }
    if (
      locationMode === "managed" &&
      createPathIdentityKey(getManagedPathParent(read.path)) !== createPathIdentityKey(workspace.path)
    ) {
      return {
        status: "error",
        code: "MANUSCRIPT_PICKER_INVALID_SELECTION",
        message: "Literature manuscripts must be direct children of the Literature workspace.",
        requestToken: selection.requestToken
      };
    }
    const parsed = parseLabPodMarkdownDocument(read.content);
    if (parsed.status === "invalid" || parsed.status === "ambiguous") {
      return {
        status: "error",
        code: "MANUSCRIPT_PICKER_INVALID_SELECTION",
        message: "The selected manuscript has invalid or ambiguous SciLoom standard blocks.",
        requestToken: selection.requestToken
      };
    }
    const ensured = await fileRefService.registerFileRef({
      ownerType: "literature",
      ownerId: selection.literatureId,
      manuscriptChannel: selection.manuscriptChannel,
      resourceKind: "file",
      fileRole: "manuscript",
      locationMode,
      fileType: "markdown",
      path: read.path,
      title: read.fileName,
      source: "imported"
    });
    return {
      status: ensured.state === "reused" ? "skipped" : "success",
      fileRefId: ensured.fileRef.id,
      locationMode,
      requestToken: selection.requestToken
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = message.match(/[A-Z][A-Z0-9_]+/u)?.[0] ?? "MANUSCRIPT_MANAGED_ENSURE_FAILED";
    return { status: "error", code, message, requestToken: selection.requestToken };
  }
}

export async function getLiteratureManuscriptStatus(
  literatureId: EntityId,
  manuscriptChannel: ManuscriptChannel = "literature_outline"
): Promise<LiteratureManuscriptStatusSummary> {
  return toLiteratureManuscriptStatusSummary(
    await literatureCurrentFilenameService.getCurrentFilename(literatureId, manuscriptChannel)
  );
}

export async function createManagedLiteratureCopy(
  document: LiteratureTargetManuscriptDocument,
  requestToken: number
): Promise<{
  status: "success" | "skipped" | "partial" | "error";
  fileRefId?: EntityId;
  errors: Array<{ code: string; message: string; step: string }>;
  requestToken: number;
}> {
  if (document.locationMode !== "external") {
    throw new Error("Only an external manuscript can be copied into managed storage.");
  }
  if (document.manuscriptChannel !== "literature_outline" && document.manuscriptChannel !== "dedicated_notes") {
    throw new Error("Literature managed copy requires an explicit Literature manuscript channel.");
  }
  const manuscriptChannel = document.manuscriptChannel;
  const fail = (code: string, message: string, step: string, status: "partial" | "error" = "error") => ({
    status,
    errors: [{ code, message, step }],
    requestToken
  });
  const binding = await manuscriptBindingService.getBindingByOwner(
    "literature",
    document.literatureId,
    manuscriptChannel
  );
  const otherChannel: ManuscriptChannel = manuscriptChannel === "literature_outline"
    ? "dedicated_notes"
    : "literature_outline";
  const otherBinding = await manuscriptBindingService.getBindingByOwner(
    "literature",
    document.literatureId,
    otherChannel
  );
  if (!binding?.defaultFolderFileRefId || binding.defaultFolderFileRefId !== otherBinding?.defaultFolderFileRefId) {
    return fail("MANAGED_COPY_WORKSPACE_INVALID", "Literature channels do not resolve to one managed workspace.", "workspace");
  }
  const folder = await fileRefService.getById(binding.defaultFolderFileRefId);
  if (!folder || folder.deletedAt || folder.resourceKind !== "folder" || folder.fileRole !== "defaultFolder" || folder.locationMode !== "managed") {
    return fail("MANAGED_COPY_WORKSPACE_INVALID", "Literature managed workspace FileRef is unavailable.", "workspace");
  }
  const rootStatus = await managedRootConfigService.getStatus();
  if (rootStatus.status !== "configured") {
    return fail("MANAGED_COPY_ROOT_UNAVAILABLE", "Managed root is unavailable.", "root");
  }
  const channelPrefix = manuscriptChannel === "literature_outline"
    ? "literature-outline"
    : "dedicated-notes";
  const fileName = `${channelPrefix}_imported_${createStableShortId(document.fileRefId)}.md`;
  const plannedPath = buildManagedManuscriptPath(folder.path, fileName);
  const content = serializeLabPodMarkdownDocument({
    metaSnapshot: document.metaSnapshot,
    outline: document.outline,
    body: document.body
  });
  let native: Awaited<ReturnType<typeof nativeManuscriptIoService.createManagedWorkspaceMarkdownCopy>>;
  try {
    native = await nativeManuscriptIoService.createManagedWorkspaceMarkdownCopy({
      configuredRoot: rootStatus.managedRoot,
      workspaceDirectory: folder.path,
      manuscriptChannel,
      sourceFileRefId: document.fileRefId,
      expectedFileName: fileName,
      content
    });
  } catch (error) {
    return fail(
      "MANAGED_COPY_CREATE_FAILED",
      error instanceof Error ? error.message : "Managed copy could not be created.",
      "filesystem"
    );
  }
  if (native.status !== "success" && native.status !== "skipped") {
    return fail(native.errorCode ?? "MANAGED_COPY_CREATE_FAILED", native.errorMessage ?? "Managed copy could not be created.", "filesystem", native.status === "partial" ? "partial" : "error");
  }
  if (native.fileName !== fileName || createPathIdentityKey(native.path) !== createPathIdentityKey(plannedPath)) {
    return fail("MANAGED_COPY_PATH_MISMATCH", "Native managed-copy path did not match the planned workspace basename.", "filesystem-result", "partial");
  }
  try {
    const ensured = await fileRefService.registerFileRef({
      ownerType: "literature",
      ownerId: document.literatureId,
      manuscriptChannel,
      resourceKind: "file",
      fileRole: "manuscript",
      locationMode: "managed",
      fileType: "markdown",
      path: native.path,
      title: fileName,
      source: "imported"
    });
    return {
      status: native.status === "skipped" && ensured.state === "reused" ? "skipped" : "success",
      fileRefId: ensured.fileRef.id,
      errors: [],
      requestToken
    };
  } catch (error) {
    return fail("MANAGED_COPY_FILE_REF_FAILED", error instanceof Error ? error.message : String(error), "file-ref", "partial");
  }
}

export const literatureManuscriptService = {
  ensureProvisioned: ensureLiteratureManuscriptProvisioned,
  getStatus: getLiteratureManuscriptStatus,
  createManagedCopy: createManagedLiteratureCopy,
  cutoverToV2: literatureManuscriptCutoverService.cutoverToV2,
  resolveWorkspaceFolder: resolveLiteratureWorkspaceFolder,
  selectManuscript: selectLiteratureManuscript,
  ensureSelectedManuscript: ensureSelectedLiteratureManuscript
};
