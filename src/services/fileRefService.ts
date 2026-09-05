import { fileRefRepository as repository } from "../repositories/fileRefRepository";
import type { EntityId } from "../types";
import type { CreateEntityInput, UpdateEntityInput } from "../types/common";
import type {
  CreateFileRefInput,
  FileRef,
  FileRefAvailabilityResult,
  FileRefPathSummary,
  FileRefOwnerType,
  UpdateFileRefInput
} from "../types/experiment";
import { EXPERIMENT_SCHEMA_VERSION } from "../types/experiment";
import {
  assertValidManuscriptChannelForOwner,
  normalizeManuscriptChannel
} from "../types/manuscriptChannel";
import type { OperationImpactSummary } from "../types/operationLog";
import type { AffectedEntity, RefreshKey, WriteFeedbackResult } from "../types/writeFeedback";
import {
  createCrossModuleWriteFeedback,
  publishCrossModuleWriteFeedback
} from "./crossModuleWriteFeedbackService";
import { getPathDisplayName, summarizePath } from "./localPathService";
import { getSafeManuscriptBasename } from "./manuscriptSafeFilename";
export { getSafeManuscriptBasename } from "./manuscriptSafeFilename";
import { isWindowsFileFallbackEligible, localFileService } from "./localFileService";
import { managedRootConfigService } from "./managedRootConfigService";
import { nativeFileService } from "./nativeFileService";
import type {
  LocalFileResult,
  OpenLocalPathOptions,
  SelectLocalFileOptions,
  SelectLocalFolderOptions
} from "../types/localFile";
import {
  createOperationLog,
  summarizeFeedbackForOperationLog
} from "./operationLogService";
import {
  assertFileRefIdentityContract,
  createPathIdentityKey,
  FileRefContractError,
  FILE_REF_CONTRACT_ERROR_CODES
} from "./fileRefIdentity";
import { validateFileRefOwner } from "./fileRefOwnerValidator";
import { recordRecycleEntry } from "./recycleBinService";
import {
  addWriteFeedbackWarning,
  createWriteFeedbackResult,
  toWriteFeedbackMessage
} from "./writeFeedbackService";
import type { ValidatedPlanningAuthorityHandle } from "./planningOwnerAuthorityPort";

export function getFileRefPathName(path: string) {
  return getPathDisplayName(path);
}

export function summarizeFileRefPath(path?: string | null) {
  return summarizePath(path ?? "");
}

function extensionFromName(fileName: string) {
  const index = fileName.lastIndexOf(".");
  if (index <= 0 || index === fileName.length - 1) {
    return undefined;
  }
  return fileName.slice(index + 1).toLowerCase();
}

export function buildFileRefPathSummary(fileRef: FileRef): FileRefPathSummary {
  const fileName = getFileRefPathName(fileRef.path) || fileRef.title || fileRef.id;
  const sizeValue = fileRef.customFields.find((field) => field.name === "sizeBytes")?.value;
  const mimeTypeValue = fileRef.customFields.find((field) => field.name === "mimeType")?.value;
  return {
    id: fileRef.id,
    ownerType: fileRef.ownerType,
    ownerId: fileRef.ownerId,
    fileName,
    extension: extensionFromName(fileName),
    fileKind: fileRef.fileType,
    mimeType: typeof mimeTypeValue === "string" ? mimeTypeValue : undefined,
    sizeBytes: typeof sizeValue === "number" ? sizeValue : undefined,
    createdAt: fileRef.createdAt,
    updatedAt: fileRef.updatedAt,
    pathSummary: summarizeFileRefPath(fileRef.path) || fileName,
    availabilityStatus: "not_verified"
  };
}

export interface InspectFileRefAvailabilityInput {
  path: string;
  resourceKind: "file" | "folder";
  locationMode?: "managed" | "external";
  configuredRoot?: string;
}

export interface FileRefActionFeedback {
  severity: "success" | "warning" | "error";
  operation: string;
  message: string;
}

export function toFileRefActionFeedback(
  result: LocalFileResult
): FileRefActionFeedback | undefined {
  if (result.status === "canceled") return undefined;
  return {
    severity: result.status === "success" ? "success" : "error",
    operation: `fileRef.${result.actionType}`,
    message:
      result.status === "success"
        ? result.actionType === "copy_path"
          ? "Path copied."
          : result.actionType === "select_file" || result.actionType === "select_folder"
            ? "Path selected."
            : "Path action completed."
        : result.errorMessage ?? "Path action failed."
  };
}

export async function inspectFileRefAvailability(
  input: InspectFileRefAvailabilityInput
): Promise<FileRefAvailabilityResult> {
  const path = input.path.trim();
  if (!path) {
    return {
      status: "unavailable",
      path,
      expectedResourceKind: input.resourceKind,
      errorCode: "empty_path",
      errorMessage: "A local path is required."
    };
  }
  if (!nativeFileService.isDesktopRuntime()) {
    return {
      status: "not_verified",
      path,
      expectedResourceKind: input.resourceKind,
      errorCode: "not_desktop",
      errorMessage: "Resource availability can only be verified in the Tauri desktop app."
    };
  }
  try {
    const result = await nativeFileService.inspectLocalPath(
      path,
      input.resourceKind,
      input.locationMode === "managed" ? input.configuredRoot : undefined
    );
    return {
      status: result.status,
      path,
      expectedResourceKind: input.resourceKind,
      actualResourceKind: result.actualResourceKind,
      canonicalPath: result.canonicalPath,
      symlinkDetected: result.symlinkDetected,
      errorCode: result.errorCode,
      errorMessage: result.errorCode
    };
  } catch (error) {
    return {
      status: "unavailable",
      path,
      expectedResourceKind: input.resourceKind,
      errorCode: "availability_check_failed",
      errorMessage: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function inspectFileRefResource(id: EntityId): Promise<FileRefAvailabilityResult> {
  const active = await repository.getById(id);
  if (active) {
    let configuredRoot: string | undefined;
    if (active.locationMode === "managed") {
      const rootStatus = await managedRootConfigService.getStatus();
      if (rootStatus.status !== "configured" || !rootStatus.managedRoot) {
        return {
          status: "managed_placement_invalid",
          path: active.path,
          expectedResourceKind: active.resourceKind,
          errorCode: rootStatus.status === "invalid" ? "managed_root_invalid" : "managed_root_unconfigured",
          errorMessage: "Managed FileRef availability requires a valid configured managed root."
        };
      }
      configuredRoot = rootStatus.managedRoot;
    }
    return inspectFileRefAvailability({
      path: active.path,
      resourceKind: active.resourceKind,
      locationMode: active.locationMode,
      configuredRoot
    });
  }
  const deleted = await repository.getDeletedById(id);
  if (deleted) {
    return {
      status: "metadata_deleted",
      path: deleted.path,
      expectedResourceKind: deleted.resourceKind,
      errorCode: FILE_REF_CONTRACT_ERROR_CODES.deletedIdentity,
      errorMessage: "FileRef metadata is deleted; resource availability was not checked."
    };
  }
  return {
    status: "metadata_not_found",
    path: "",
    expectedResourceKind: "file",
    errorCode: "file_ref_not_found",
    errorMessage: `FileRef metadata was not found: ${id}.`
  };
}

export type FileRefDeleteBoundaryResult =
  | { status: "allowed"; fileRef: FileRef }
  | { status: "reference_blocked"; fileRef: FileRef; errorCode: string }
  | { status: "already_deleted"; fileRef: FileRef }
  | { status: "not_found" };

export async function inspectFileRefDeleteBoundary(
  id: EntityId
): Promise<FileRefDeleteBoundaryResult> {
  const active = await repository.getById(id);
  if (active) {
    return (await repository.isReferencedByBinding(id))
      ? {
          status: "reference_blocked",
          fileRef: active,
          errorCode: FILE_REF_CONTRACT_ERROR_CODES.inUseByBinding
        }
      : { status: "allowed", fileRef: active };
  }
  const deleted = await repository.getDeletedById(id);
  return deleted ? { status: "already_deleted", fileRef: deleted } : { status: "not_found" };
}

function toCreateInput(input: CreateFileRefInput): CreateEntityInput<FileRef> {
  const resourceKind = input.resourceKind ?? (input.fileType === "folder" ? "folder" : "file");
  const fileRole = input.fileRole ?? "attachment";
  const locationMode = input.locationMode ?? "external";
  assertFileRefIdentityContract({ resourceKind, fileRole, locationMode });
  const manuscriptChannel = fileRole === "manuscript"
    ? assertValidManuscriptChannelForOwner(input.ownerType, input.manuscriptChannel)
    : normalizeManuscriptChannel(input.manuscriptChannel);
  return {
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    manuscriptChannel,
    resourceKind,
    fileRole,
    locationMode,
    fileType: input.fileType ?? "other",
    path: input.path.trim(),
    pathIdentityKey: createPathIdentityKey(input.path),
    title: input.title?.trim() || getFileRefPathName(input.path),
    description: input.description,
    candidateRequestId: input.candidateRequestId,
    candidateOccurredAt: input.candidateOccurredAt,
    schemaVersion: EXPERIMENT_SCHEMA_VERSION,
    source: input.source ?? "user",
    customFields: input.customFields ?? []
  };
}

function ownerEntityType(ownerType: FileRefOwnerType) {
  return ownerType === "experimentRun" ? "experimentRun" : ownerType;
}

function isOutputConversionOwner(ownerType: FileRefOwnerType) {
  return (
    ownerType === "resultItem" ||
    ownerType === "finding" ||
    ownerType === "outputCandidate" ||
    ownerType === "outputGap"
  );
}

function ownerModule(
  ownerType: FileRefOwnerType
): "experiment" | "literature" | "review" | "output" | "outputConversion" {
  if (ownerType === "review") {
    return "review";
  }
  if (ownerType === "researchOutput") {
    return "output";
  }
  if (isOutputConversionOwner(ownerType)) {
    return "outputConversion";
  }
  return ownerType === "literature" ? "literature" : "experiment";
}

function ownerRefreshKeys(ownerType: FileRefOwnerType): RefreshKey[] {
  if (ownerType === "review") {
    return ["fileRef.changed", "review.changed", "reviewContext.changed", "aiContext.changed"];
  }
  if (ownerType === "researchOutput") {
    return ["fileRef.changed", "output.researchOutput.changed", "reviewContext.changed", "aiContext.changed"];
  }
  if (isOutputConversionOwner(ownerType)) {
    const outputKeyByOwner: Record<
      "resultItem" | "finding" | "outputCandidate" | "outputGap",
      RefreshKey
    > = {
      resultItem: "output.resultItem.changed",
      finding: "output.finding.changed",
      outputCandidate: "output.candidate.changed",
      outputGap: "output.gap.changed"
    };
    return [
      "fileRef.changed",
      outputKeyByOwner[ownerType],
      "reviewContext.changed",
      "aiContext.changed"
    ];
  }
  return ownerType === "literature"
    ? ["fileRef.changed", "literature.changed", "reviewContext.changed", "aiContext.changed"]
    : ["fileRef.changed", "experiment.changed", "experimentRun.changed", "reviewContext.changed", "aiContext.changed"];
}

function ownerAffectedScopes(fileRef: FileRef, reason: string) {
  if (fileRef.ownerType === "review") {
    return [
      {
        module: "review",
        reviewId: fileRef.ownerId,
        reason
      },
      {
        module: "ai",
        reviewId: fileRef.ownerId,
        reason: "AI context may include safe Review path summaries, not file contents."
      }
    ];
  }
  if (fileRef.ownerType === "researchOutput") {
    return [
      {
        module: "output",
        researchOutputId: fileRef.ownerId,
        reason
      },
      {
        module: "ai",
        researchOutputId: fileRef.ownerId,
        reason: "AI context may include safe formal-output path summaries, not file contents."
      }
    ];
  }
  if (isOutputConversionOwner(fileRef.ownerType)) {
    return [
      {
        module: "outputConversion",
        reason
      },
      {
        module: "ai",
        reason: "AI context may include safe output-chain path summaries, not file contents."
      }
    ];
  }
  return fileRef.ownerType === "literature"
    ? [
        {
          module: "literature",
          literatureId: fileRef.ownerId,
          reason
        },
        {
          module: "review",
          literatureId: fileRef.ownerId,
          reason: "Review context can include literature path metadata summaries."
        },
        {
          module: "ai",
          literatureId: fileRef.ownerId,
          reason: "AI context may include safe literature path summaries, not file contents."
        }
      ]
    : [
        {
          module: "experiment",
          experimentId: fileRef.ownerType === "experiment" ? fileRef.ownerId : undefined,
          reason
        }
      ];
}

function assertIdentityFieldsUnchanged(existing: FileRef, patch: Record<string, unknown>) {
  const expected: Record<string, unknown> = {
    ownerType: existing.ownerType,
    ownerId: existing.ownerId,
    manuscriptChannel: existing.manuscriptChannel,
    resourceKind: existing.resourceKind,
    fileRole: existing.fileRole,
    locationMode: existing.locationMode,
    path: existing.path,
    pathIdentityKey: existing.pathIdentityKey
  };
  for (const [field, value] of Object.entries(expected)) {
    if (Object.prototype.hasOwnProperty.call(patch, field) && patch[field] !== value) {
      throw new FileRefContractError(
        FILE_REF_CONTRACT_ERROR_CODES.identityFieldImmutable,
        `FileRef identity field cannot be changed by ordinary update: ${field}.`
      );
    }
  }
}

function toUpdateInput(existing: FileRef, patch: UpdateFileRefInput): UpdateEntityInput<FileRef> {
  assertIdentityFieldsUnchanged(existing, patch as Record<string, unknown>);
  return {
    fileType: patch.fileType ?? existing.fileType,
    title: patch.title ?? existing.title,
    description: patch.description ?? existing.description,
    schemaVersion: EXPERIMENT_SCHEMA_VERSION,
    source: patch.source ?? existing.source ?? "user",
    customFields: patch.customFields ?? existing.customFields ?? []
  };
}

async function getFileRefByIdentity(input: CreateFileRefInput) {
  const normalized = toCreateInput(input);
  const all = [...(await repository.list()), ...(await repository.listDeleted())];
  return all.find(
    (fileRef) =>
      fileRef.ownerType === normalized.ownerType &&
      fileRef.ownerId === normalized.ownerId &&
      fileRef.manuscriptChannel === normalized.manuscriptChannel &&
      fileRef.pathIdentityKey === normalized.pathIdentityKey &&
      fileRef.resourceKind === normalized.resourceKind &&
      fileRef.fileRole === normalized.fileRole &&
      fileRef.locationMode === normalized.locationMode
  );
}

async function getFileRefsByOwner(ownerType: FileRefOwnerType, ownerId: EntityId) {
  return (await repository.list()).filter(
    (fileRef) => fileRef.ownerType === ownerType && fileRef.ownerId === ownerId
  );
}

async function getFileRefsByOwnerIncludingDeleted(ownerType: FileRefOwnerType, ownerId: EntityId) {
  const all = [...(await repository.list()), ...(await repository.listDeleted())];
  return all.filter(
    (fileRef) => fileRef.ownerType === ownerType && fileRef.ownerId === ownerId
  );
}

let managedManuscriptIdentityGate: Promise<void> = Promise.resolve();

async function withManagedManuscriptIdentityGate<T>(action: () => Promise<T>) {
  const previous = managedManuscriptIdentityGate;
  let release = () => {};
  managedManuscriptIdentityGate = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await action();
  } finally {
    release();
  }
}

export async function getActiveManagedManuscriptPathConflicts(
  ownerType: FileRefOwnerType,
  ownerId: EntityId,
  pathIdentityKey: string
) {
  const identity = createPathIdentityKey(pathIdentityKey);
  return (await repository.list()).filter((fileRef) =>
    !fileRef.deletedAt &&
    (fileRef.ownerType !== ownerType || fileRef.ownerId !== ownerId) &&
    fileRef.resourceKind === "file" &&
    fileRef.fileRole === "manuscript" &&
    fileRef.locationMode === "managed" &&
    fileRef.pathIdentityKey === identity &&
    createPathIdentityKey(fileRef.path) === identity
  );
}

export async function getActiveManuscriptPathConflicts(
  ownerType: FileRefOwnerType,
  ownerId: EntityId,
  pathIdentityKey: string
) {
  const identity = createPathIdentityKey(pathIdentityKey);
  return (await repository.list()).filter((fileRef) =>
    !fileRef.deletedAt &&
    (fileRef.ownerType !== ownerType || fileRef.ownerId !== ownerId) &&
    fileRef.resourceKind === "file" &&
    fileRef.fileRole === "manuscript" &&
    fileRef.pathIdentityKey === identity &&
    createPathIdentityKey(fileRef.path) === identity
  );
}

async function getCandidateFileRefsByRequestId(
  ownerType: FileRefOwnerType,
  ownerId: EntityId,
  candidateRequestId: string
) {
  return (await getFileRefsByOwnerIncludingDeleted(ownerType, ownerId)).filter(
    (fileRef) => fileRef.candidateRequestId === candidateRequestId
  );
}

async function getFileRefPathSummariesByOwner(ownerType: FileRefOwnerType, ownerId: EntityId) {
  return (await getFileRefsByOwner(ownerType, ownerId)).map(buildFileRefPathSummary);
}

async function registerFileRefRecord(
  input: CreateFileRefInput,
  authorityPermit?: ValidatedPlanningAuthorityHandle
): Promise<{
  fileRef: FileRef;
  created: boolean;
}> {
  await validateFileRefOwner(input.ownerType, input.ownerId);
  const existing = await getFileRefByIdentity(input);
  if (existing) {
    if (existing.deletedAt) {
      throw new FileRefContractError(
        FILE_REF_CONTRACT_ERROR_CODES.deletedIdentity,
        `Deleted FileRef identity must be restored explicitly: ${existing.id}.`
      );
    }
    return { fileRef: existing, created: false };
  }
  let fileRef: FileRef;
  try {
    fileRef = await repository.create(toCreateInput(input), undefined, authorityPermit);
  } catch (error) {
    const concurrent = await getFileRefByIdentity(input);
    if (concurrent && !concurrent.deletedAt) {
      return { fileRef: concurrent, created: false };
    }
    if (concurrent?.deletedAt) {
      throw new FileRefContractError(
        FILE_REF_CONTRACT_ERROR_CODES.deletedIdentity,
        `Deleted FileRef identity must be restored explicitly: ${concurrent.id}.`
      );
    }
    throw error;
  }
  const readback = await repository.getById(fileRef.id);
  if (!readback) {
    throw new FileRefContractError(
      FILE_REF_CONTRACT_ERROR_CODES.readbackFailed,
      `Created FileRef could not be read back: ${fileRef.id}.`
    );
  }
  const normalized = toCreateInput(input);
  if (
    readback.ownerType !== normalized.ownerType ||
    readback.ownerId !== normalized.ownerId ||
    readback.manuscriptChannel !== normalized.manuscriptChannel ||
    readback.resourceKind !== normalized.resourceKind ||
    readback.fileRole !== normalized.fileRole ||
    readback.locationMode !== normalized.locationMode ||
    readback.pathIdentityKey !== normalized.pathIdentityKey ||
    readback.deletedAt
  ) {
    throw new FileRefContractError(
      FILE_REF_CONTRACT_ERROR_CODES.readbackFailed,
      `Created FileRef readback did not match the requested identity: ${fileRef.id}.`
    );
  }
  fileRef = readback;
  publishCrossModuleWriteFeedback(
    createCrossModuleWriteFeedback({
      operation: "fileRef.registerFileRef",
      data: fileRef,
      primaryEntity: {
        type: "fileRef",
        id: fileRef.id,
        relation: "created",
        label: fileRef.title
      },
      affectedEntities: [
        {
          type: ownerEntityType(fileRef.ownerType),
          id: fileRef.ownerId,
          relation: "linked"
        }
      ],
      affectedScopes: ownerAffectedScopes(
        fileRef,
        "FileRef metadata was created; file body was not read."
      ),
      refreshKeys: ownerRefreshKeys(fileRef.ownerType)
    }),
    "fileRef.registerFileRef"
  );
  return { fileRef, created: true };
}

async function updateFileRef(id: EntityId, patch: UpdateFileRefInput) {
  const existing = await repository.getById(id);
  if (!existing) {
    publishCrossModuleWriteFeedback(
      createCrossModuleWriteFeedback({
        operation: "fileRef.updateFileRef",
        primaryEntity: {
          type: "fileRef",
          id,
          relation: "skipped"
        },
        skipped: ["file_ref_not_found"],
        refreshKeys: ["fileRef.changed", "experiment.changed", "reviewContext.changed", "aiContext.changed"]
      }),
      "fileRef.updateFileRef"
    );
    return undefined;
  }

  await validateFileRefOwner(existing.ownerType, existing.ownerId);
  const updated = await repository.update(id, toUpdateInput(existing, patch));
  const fileRef = updated ? await repository.getById(id) : undefined;
  if (updated && !fileRef) {
    throw new FileRefContractError(
      FILE_REF_CONTRACT_ERROR_CODES.readbackFailed,
      `Updated FileRef could not be read back: ${id}.`
    );
  }
  publishCrossModuleWriteFeedback(
    createCrossModuleWriteFeedback({
      operation: "fileRef.updateFileRef",
      data: fileRef,
      primaryEntity: {
        type: "fileRef",
        id,
        relation: fileRef ? "updated" : "skipped",
        label: fileRef?.title ?? existing.title
      },
      affectedEntities: [
        {
          type: ownerEntityType((fileRef ?? existing).ownerType),
          id: (fileRef ?? existing).ownerId,
          relation: "linked"
        }
      ],
      affectedScopes: ownerAffectedScopes(
        fileRef ?? existing,
        "FileRef metadata was updated; file body was not read."
      ),
      refreshKeys: ownerRefreshKeys((fileRef ?? existing).ownerType),
      skipped: fileRef ? [] : ["file_ref_update_failed"]
    }),
    "fileRef.updateFileRef"
  );
  return fileRef;
}

async function softDeleteMetadataPrimitive(id: EntityId) {
  const existing = await repository.getById(id);
  if (existing) {
    await validateFileRefOwner(existing.ownerType, existing.ownerId);
  }
  const removed = await repository.softDelete(id);
  if (removed && !(await repository.getDeletedById(id))) {
    throw new FileRefContractError(
      FILE_REF_CONTRACT_ERROR_CODES.readbackFailed,
      `Soft-deleted FileRef could not be read back: ${id}.`
    );
  }
  publishCrossModuleWriteFeedback(
    createCrossModuleWriteFeedback({
      operation: "fileRef.deleteFileRef",
      data: removed,
      primaryEntity: {
        type: "fileRef",
        id,
        relation: removed ? "deleted" : "skipped",
        label: existing?.title
      },
      affectedEntities: existing
        ? [
            {
              type: ownerEntityType(existing.ownerType),
              id: existing.ownerId,
              relation: "linked"
            }
          ]
        : [],
      affectedScopes: existing
        ? ownerAffectedScopes(
            existing,
            "FileRef metadata was deleted or delete was attempted; file body was not read."
          )
        : [],
      refreshKeys: existing
        ? ownerRefreshKeys(existing.ownerType)
        : ["fileRef.changed", "experiment.changed", "reviewContext.changed", "aiContext.changed"],
      skipped: removed ? [] : ["file_ref_not_found"]
    }),
    "fileRef.deleteFileRef"
  );
  return removed;
}

export async function registerFileRef(
  input: CreateFileRefInput,
  authorityPermit?: ValidatedPlanningAuthorityHandle
): Promise<{
  fileRef: FileRef;
  state: "created" | "reused";
}> {
  const register = async () => {
    await validateFileRefOwner(input.ownerType, input.ownerId);
    if (
      input.resourceKind === "file" &&
      input.fileRole === "manuscript" &&
      input.locationMode === "managed"
    ) {
      const conflicts = await getActiveManagedManuscriptPathConflicts(
        input.ownerType,
        input.ownerId,
        input.pathIdentityKey ?? input.path
      );
      if (conflicts.length > 0) {
        throw new FileRefContractError(
          FILE_REF_CONTRACT_ERROR_CODES.crossOwnerManagedPathConflict,
          "An active managed manuscript with the same physical identity belongs to another owner."
        );
      }
    }
    const existing = await getFileRefByIdentity(input);
    if (existing && !existing.deletedAt) {
      return { fileRef: existing, state: "reused" as const };
    }
    if (existing?.deletedAt) {
      throw new FileRefContractError(
        FILE_REF_CONTRACT_ERROR_CODES.deletedIdentity,
        `Deleted FileRef identity blocks registration until an explicit Lifecycle decision: ${existing.id}.`
      );
    }
    const created = await registerFileRefRecord(input, authorityPermit);
    return { fileRef: created.fileRef, state: created.created ? "created" as const : "reused" as const };
  };
  return input.resourceKind === "file" && input.fileRole === "manuscript" && input.locationMode === "managed"
    ? withManagedManuscriptIdentityGate(register)
    : register();
}

export async function registerAndReadbackFileRef(
  input: CreateFileRefInput,
  authorityPermit?: ValidatedPlanningAuthorityHandle
): Promise<{
  fileRef: FileRef;
  state: "created" | "reused" | "reconciled";
  durableCommitConfirmed: true;
}> {
  let registered:
    | { fileRef: FileRef; state: "created" | "reused" }
    | undefined;
  let reconciledAfterError = false;
  try {
    registered = await registerFileRef(input, authorityPermit);
  } catch (registrationError) {
    let reconciled: FileRef | undefined;
    try {
      reconciled = await getFileRefByIdentity(input);
    } catch {
      throw registrationError;
    }
    if (!reconciled || reconciled.deletedAt) throw registrationError;
    registered = { fileRef: reconciled, state: "reused" };
    reconciledAfterError = true;
  }

  const authoritative = await repository.getById(registered.fileRef.id);
  const expected = toCreateInput(input);
  if (
    !authoritative ||
    authoritative.deletedAt ||
    authoritative.ownerType !== expected.ownerType ||
    authoritative.ownerId !== expected.ownerId ||
    authoritative.manuscriptChannel !== expected.manuscriptChannel ||
    authoritative.resourceKind !== expected.resourceKind ||
    authoritative.fileRole !== expected.fileRole ||
    authoritative.locationMode !== expected.locationMode ||
    authoritative.pathIdentityKey !== expected.pathIdentityKey ||
    createPathIdentityKey(authoritative.path) !== expected.pathIdentityKey
  ) {
    throw new FileRefContractError(
      FILE_REF_CONTRACT_ERROR_CODES.readbackFailed,
      "FileRef registration could not be reconciled to one authoritative identity."
    );
  }
  return {
    fileRef: authoritative,
    state: reconciledAfterError
      ? "reconciled"
      :
      registered.fileRef.id === authoritative.id &&
      registered.state === "created"
        ? "created"
        : registered.state === "reused"
          ? "reused"
          : "reconciled",
    durableCommitConfirmed: true
  };
}

export async function replaceFileRefPath(
  id: EntityId,
  input: Pick<CreateFileRefInput, "path"> & UpdateFileRefInput
): Promise<{ fileRef: FileRef; state: "created" | "reused"; replacedFileRefId: EntityId }> {
  const existing = await repository.getById(id);
  if (!existing) {
    throw new FileRefContractError(
      FILE_REF_CONTRACT_ERROR_CODES.identityConflict,
      `Active FileRef not found for path replacement: ${id}.`
    );
  }
  const boundary = await inspectFileRefDeleteBoundary(id);
  if (boundary.status !== "allowed") {
    throw new FileRefContractError(
      boundary.status === "reference_blocked"
        ? FILE_REF_CONTRACT_ERROR_CODES.inUseByBinding
        : FILE_REF_CONTRACT_ERROR_CODES.identityConflict,
      `FileRef path replacement is blocked: ${id}/${boundary.status}.`
    );
  }
  const registered = await registerFileRef({
    ownerType: existing.ownerType,
    ownerId: existing.ownerId,
    manuscriptChannel: existing.manuscriptChannel,
    resourceKind: existing.resourceKind,
    fileRole: existing.fileRole,
    locationMode: existing.locationMode,
    fileType: input.fileType ?? existing.fileType,
    path: input.path,
    title: input.title ?? existing.title,
    description: input.description ?? existing.description,
    source: input.source ?? existing.source,
    customFields: input.customFields ?? existing.customFields
  });
  if (registered.fileRef.id === existing.id) {
    const { path: _identityPath, ...metadataPatch } = input;
    const updated = await updateFileRef(existing.id, metadataPatch);
    if (!updated) {
      throw new FileRefContractError(
        FILE_REF_CONTRACT_ERROR_CODES.readbackFailed,
        `Reused FileRef could not be updated during path replacement: ${id}.`
      );
    }
    return { fileRef: updated, state: "reused", replacedFileRefId: id };
  }
  await softDeleteMetadataPrimitive(existing.id);
  return {
    fileRef: registered.fileRef,
    state: registered.state,
    replacedFileRefId: existing.id
  };
}

async function hardDeleteMetadataPrimitive(id: EntityId) {
  const existing = await repository.getDeletedById(id);
  if (!existing) return false;
  await validateFileRefOwner(existing.ownerType, existing.ownerId);
  const removed = await repository.hardDelete(id);
  if (removed && ((await repository.getById(id)) || (await repository.getDeletedById(id)))) {
    throw new FileRefContractError(
      FILE_REF_CONTRACT_ERROR_CODES.readbackFailed,
      `Hard-deleted FileRef still exists after authoritative readback: ${id}.`
    );
  }
  return removed;
}

export interface DeleteFileRefWithAuditInput {
  id: EntityId;
  title?: string;
  summary?: string;
  relatedEntities?: AffectedEntity[];
  impactSummary?: OperationImpactSummary;
  refreshKeys?: RefreshKey[];
}

function defaultDeleteImpactSummary(
  fileRef: FileRef,
  title: string,
  relatedEntities: AffectedEntity[]
): OperationImpactSummary {
  return {
    affectedEntityCount: Math.max(1, relatedEntities.length + 1),
    affectedItems: [
      {
        entityType: "fileRef",
        entityId: fileRef.id,
        title,
        severity: "warning"
      },
      ...relatedEntities.map((entity) => ({
        entityType: entity.type,
        entityId: entity.id,
        title: entity.label ?? entity.id,
        description: entity.relation,
        severity: "info" as const
      }))
    ],
    warnings: [
      "Only the SciLoom path record is moved to the recycle area.",
      "The referenced local file is not read, uploaded, moved, or deleted."
    ],
    blockingReasons: [],
    deepScanPerformed: false
  };
}

async function deleteFileRefWithAudit(
  input: DeleteFileRefWithAuditInput
): Promise<WriteFeedbackResult<boolean>> {
  const existing = await repository.getById(input.id);
  const removed = await softDeleteMetadataPrimitive(input.id);
  const title = input.title ?? existing?.title ?? existing?.path ?? input.id;
  const module = existing ? ownerModule(existing.ownerType) : "global";
  const refreshKeys = [
    ...new Set<RefreshKey>([
      ...(input.refreshKeys ?? (existing ? ownerRefreshKeys(existing.ownerType) : ["fileRef.changed"])),
      "operationLog.changed",
      "recycleBin.changed"
    ])
  ];
  const relatedEntities =
    input.relatedEntities ??
    (existing
      ? [
          {
            type: ownerEntityType(existing.ownerType),
            id: existing.ownerId,
            relation: "linked",
            label: existing.ownerId
          }
        ]
      : []);
  const affectedScopes = existing
    ? ownerAffectedScopes(
        existing,
        "FileRef metadata was soft-deleted; file body was not read."
      )
    : [];
  let feedback = createWriteFeedbackResult<boolean>({
    status: removed ? "success" : "skipped",
    operation: "fileRef.deleteFileRefWithAudit",
    data: removed,
    affectedEntities: [
      {
        type: "fileRef",
        id: input.id,
        relation: removed ? "deleted" : "skipped",
        label: title
      },
      ...relatedEntities
    ],
    affectedScopes,
    refreshKeys,
    skipped: removed ? [] : ["file_ref_not_found"],
    messages: [
      toWriteFeedbackMessage(
        removed
          ? "FileRef metadata moved to recycle area. The local file was not read or deleted."
          : "The FileRef does not exist or has already been deleted.",
        removed ? "success" : "warning"
      )
    ],
    warnings: removed
      ? ["Only SciLoom metadata was deleted. Local files referenced by paths were not touched."]
      : []
  });

  if (!removed || !existing) {
    return feedback;
  }

  const deletedAt = new Date().toISOString();
  const impactSummary =
    input.impactSummary ?? defaultDeleteImpactSummary(existing, title, relatedEntities);
  let operationLogId: EntityId | undefined;
  try {
    const operationLogFeedback = await createOperationLog({
      operationType: "delete",
      source: "user",
      module,
      status: feedback.status,
      riskLevel: "medium",
      target: {
        entityType: "fileRef",
        entityId: existing.id,
        title
      },
      summary:
        input.summary ??
        `FileRef metadata for ${existing.ownerType}/${existing.ownerId} moved to recycle area.`,
      relatedEntities,
      impactSummary,
      confirmation: {
        required: true,
        confirmedByUser: true,
        confirmedAt: deletedAt
      },
      feedback: summarizeFeedbackForOperationLog(feedback),
      isRecoverable: true,
      refreshKeys
    });
    operationLogId = operationLogFeedback.data?.id;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    feedback = addWriteFeedbackWarning(
      feedback,
      `Operation log write failed: ${message}`,
      "operation_log_write_failed"
    );
  }

  try {
    await recordRecycleEntry({
      entityType: "fileRef",
      entityId: existing.id,
      title,
      summary:
        input.summary ??
        `FileRef metadata for ${existing.ownerType}/${existing.ownerId} was soft-deleted. No local file was read, moved, or deleted.`,
      module,
      deletedAt,
      deletedBy: "user",
      operationLogId,
      canRestore: true,
      knownImpactSummary: impactSummary,
      restoreStatus: "not_started",
      refreshKeys
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    feedback = addWriteFeedbackWarning(
      feedback,
      `Recycle entry write failed: ${message}`,
      "recycle_entry_write_failed"
    );
  }

  return feedback;
}

export const fileRefService = {
  list: repository.list,
  getById: repository.getById,
  getDeletedById: repository.getDeletedById,
  update: updateFileRef,
  getFileRefsByOwner,
  getFileRefsByOwnerIncludingDeleted,
  getActiveManagedManuscriptPathConflicts,
  getActiveManuscriptPathConflicts,
  getCandidateFileRefsByRequestId,
  getFileRefPathSummariesByOwner,
  buildFileRefPathSummary,
  registerFileRef,
  registerAndReadbackFileRef,
  replaceFileRefPath,
  updateFileRef,
  deleteFileRefWithAudit,
  softDeleteMetadataPrimitive,
  hardDeleteMetadataPrimitive,
  getFileRefByIdentity,
  inspectFileRefAvailability,
  inspectFileRefResource,
  inspectFileRefDeleteBoundary,
  selectFile: localFileService.selectFile,
  selectFolder: localFileService.selectFolder,
  openPath: localFileService.openPath,
  openFile: localFileService.openFile,
  openFolder: localFileService.openFolder,
  locatePath: localFileService.openContainingFolder,
  copyPath: localFileService.copyPath,
  getPathDisplayName: localFileService.getPathDisplayName,
  resolveFileRefOpenKind: localFileService.resolveFileRefOpenKind,
  isWindowsFileFallbackEligible,
  toFileRefActionFeedback
};

export type FileRefService = typeof fileRefService;
