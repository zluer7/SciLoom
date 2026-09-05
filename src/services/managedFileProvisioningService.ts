import { fileRefService } from "./fileRefService";
import { createPathIdentityKey } from "./fileRefIdentity";
import { manuscriptBindingService } from "./manuscriptBindingService";
import { managedRootConfigService } from "./managedRootConfigService";
import {
  buildManagedManuscriptPath,
  buildManagedEntryPath,
  getManagedPathParent,
  getManagedRelativePath
} from "./managedPathService";
import { nativeProvisioningService } from "./nativeProvisioningService";
import {
  getOutputManuscriptStaticDescriptor,
  isOutputManuscriptOwnerType
} from "./outputManuscriptDescriptorService";
import { validateFileRefOwner, type FileRefOwnerContext } from "./fileRefOwnerValidator";
import type { ManagedPathOwnerType } from "../types/managedPath";
import { assertValidManuscriptChannelForOwner } from "../types/manuscriptChannel";
import {
  PROVISIONING_ERROR_CODES,
  ProvisioningError,
  type NativeProvisionManagedEntryResult,
  type ProvisionManagedOwnerInput,
  type ProvisionManagedOwnerResult,
  type ProvisioningErrorCode
} from "../types/provisioning";
import {
  type ValidatedPlanningAuthority,
  type ValidatedPlanningAuthorityHandle
} from "./planningOwnerAuthorityPort";
import {
  manuscriptProvisioningMainlineCoordinator,
  observedManagedPrimarySteps
} from "./manuscriptProvisioningMainlineCoordinator";
import {
  runWithProvisioningAuthority,
  toProvisioningAuthorityIssue
} from "./provisioningAuthorityGuard";
import { MANUSCRIPT_BLANK_INITIAL_CONTENT } from "./manuscriptBlankBody";

type OwnerProjectEntity = FileRefOwnerContext["entity"] & {
  projectId?: string | null;
  primaryProjectId?: string | null;
};

export interface ManagedFileProvisioningDependencies {
  validateOwner(ownerType: string, ownerId: string): Promise<FileRefOwnerContext>;
  validateProject(input: ProvisionManagedOwnerInput, owner: FileRefOwnerContext): Promise<void>;
  getRootStatus(): ReturnType<typeof managedRootConfigService.getStatus>;
  buildPath: typeof buildManagedEntryPath;
  provisionFilesystem(input: {
    ownerType: ProvisionManagedOwnerInput["ownerType"];
    manuscriptChannel: NonNullable<ProvisionManagedOwnerInput["manuscriptChannel"]>;
    configuredRoot: string;
    targetDirectory: string;
    bodyPath: string;
    initialContent: string;
    allowCreateBody: boolean;
  }): Promise<NativeProvisionManagedEntryResult>;
  registerFileRef(
    input: Parameters<typeof fileRefService.registerFileRef>[0],
    authorityPermit?: ValidatedPlanningAuthorityHandle
  ): ReturnType<typeof fileRefService.registerFileRef>;
  getOwnerFileRefs: typeof fileRefService.getFileRefsByOwner;
  getBinding: typeof manuscriptBindingService.getBindingByOwner;
  getFileRefById: typeof fileRefService.getById;
  validateBinding: typeof manuscriptBindingService.validateBinding;
  upsertBindingDefaults(
    ownerType: Parameters<typeof manuscriptBindingService.upsertProvisionedDefaults>[0],
    ownerId: Parameters<typeof manuscriptBindingService.upsertProvisionedDefaults>[1],
    folderId: Parameters<typeof manuscriptBindingService.upsertProvisionedDefaults>[2],
    manuscriptId: Parameters<typeof manuscriptBindingService.upsertProvisionedDefaults>[3],
    channel: Parameters<typeof manuscriptBindingService.upsertProvisionedDefaults>[4],
    authorityPermit?: ValidatedPlanningAuthorityHandle
  ): ReturnType<typeof manuscriptBindingService.upsertProvisionedDefaults>;
}

export async function validateProvisioningProject(
  input: ProvisionManagedOwnerInput,
  owner: FileRefOwnerContext
) {
  const entity = owner.entity as OwnerProjectEntity;
  const assignedProjectId = (entity.projectId ?? entity.primaryProjectId)?.trim();
  if (input.projectId === null) {
    if (input.ownerType === "literature" && !assignedProjectId) {
      return;
    }
    throw new ProvisioningError(
      PROVISIONING_ERROR_CODES.projectMissing,
      `Owner-scoped managed placement is not allowed for ${input.ownerType}/${input.ownerId}.`
    );
  }
  const requestedProjectId = input.projectId?.trim();
  if (!requestedProjectId) {
    throw new ProvisioningError(
      PROVISIONING_ERROR_CODES.projectMissing,
      "Project ID cannot be empty."
    );
  }
  if (!assignedProjectId) {
    throw new ProvisioningError(
      PROVISIONING_ERROR_CODES.projectMissing,
      `Owner ${input.ownerType}/${input.ownerId} has no Project assignment.`
    );
  }
  if (assignedProjectId !== requestedProjectId) {
    throw new ProvisioningError(
      PROVISIONING_ERROR_CODES.projectMissing,
      `Owner Project ${assignedProjectId} does not match requested Project ${requestedProjectId}.`
    );
  }
}

const defaultDependencies: ManagedFileProvisioningDependencies = {
  validateOwner: validateFileRefOwner,
  validateProject: validateProvisioningProject,
  getRootStatus: () => managedRootConfigService.getStatus(),
  buildPath: buildManagedEntryPath,
  provisionFilesystem: (input) => nativeProvisioningService.provisionManagedEntry(input),
  registerFileRef: (input, authorityPermit) =>
    fileRefService.registerFileRef(input, authorityPermit),
  getOwnerFileRefs: (ownerType, ownerId) => fileRefService.getFileRefsByOwner(ownerType, ownerId),
  getBinding: (ownerType, ownerId, channel) => manuscriptBindingService.getBindingByOwner(ownerType, ownerId, channel),
  getFileRefById: (id) => fileRefService.getById(id),
  validateBinding: (binding) => manuscriptBindingService.validateBinding(binding),
  upsertBindingDefaults: (
    ownerType,
    ownerId,
    folderId,
    manuscriptId,
    channel,
    authorityPermit
  ) => manuscriptBindingService.upsertProvisionedDefaults(
    ownerType,
    ownerId,
    folderId,
    manuscriptId,
    channel,
    authorityPermit
  )
};

function resolveManuscriptFileName(input: ProvisionManagedOwnerInput, manuscriptChannel: string) {
  const requested = input.manuscriptFileName.trim();
  if (isOutputManuscriptOwnerType(input.ownerType)) {
    const descriptor = getOutputManuscriptStaticDescriptor(input.ownerType);
    if (manuscriptChannel !== descriptor.channel || requested !== descriptor.defaultFilename) {
      throw new ProvisioningError(
        PROVISIONING_ERROR_CODES.pathInvalid,
        `${input.ownerType} ${descriptor.channel} manuscript provisioning must explicitly use ${descriptor.defaultFilename}.`
      );
    }
    return descriptor.defaultFilename;
  }
  if (input.ownerType === "review") {
    if (manuscriptChannel !== "primary" || requested !== "review.md") {
      throw new ProvisioningError(
        PROVISIONING_ERROR_CODES.pathInvalid,
        "Review primary manuscript provisioning must explicitly use review.md."
      );
    }
    return "review.md";
  }
  if (input.ownerType !== "literature") {
    if (!requested) {
      throw new ProvisioningError(
        PROVISIONING_ERROR_CODES.pathInvalid,
        `${input.ownerType} manuscript provisioning requires an explicit default filename.`
      );
    }
    if (requested.toLocaleLowerCase("en-US") === "body.md") {
      throw new ProvisioningError(
        PROVISIONING_ERROR_CODES.pathInvalid,
        `${input.ownerType} manuscript provisioning does not permit the legacy body.md default.`
      );
    }
    return requested;
  }
  const expected = manuscriptChannel === "literature_outline"
    ? "literature-outline.md"
    : "dedicated-notes.md";
  if (requested !== expected) {
    throw new ProvisioningError(
      PROVISIONING_ERROR_CODES.pathInvalid,
      `Literature ${manuscriptChannel} must use ${expected}.`
    );
  }
  return expected;
}

function directFileName(path: string) {
  return String(path ?? "").replace(/\\/gu, "/").replace(/\/+$/u, "").split("/").pop() ?? "";
}

function pathParentIdentity(path: string) {
  return createPathIdentityKey(getManagedPathParent(path));
}

function errorResult(
  input: ProvisionManagedOwnerInput,
  code: ProvisioningErrorCode | string,
  message: string,
  failedStep: string,
  retryable: boolean,
  partial: Partial<ProvisionManagedOwnerResult> = {}
): ProvisionManagedOwnerResult {
  return {
    status: partial.completedSteps?.length ? "partial" : "error",
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    createdFolder: false,
    createdBody: false,
    reusedFolder: false,
    reusedBody: false,
    warnings: [],
    errors: [{ code, message, step: failedStep }],
    completedSteps: [],
    failedStep,
    retryable,
    ...partial
  };
}

function codeFromUnknown(error: unknown, fallback: ProvisioningErrorCode) {
  return error instanceof ProvisioningError ? error.code : fallback;
}

async function resolveManagedMainlineIdentityWithDependencies(
  input: ProvisionManagedOwnerInput,
  dependencies: ManagedFileProvisioningDependencies,
  authority: ValidatedPlanningAuthority
) {
  if (!input.manuscriptChannel) {
    throw new ProvisioningError(
      PROVISIONING_ERROR_CODES.channelInvalid,
      "Manuscript provisioning requires an explicit channel."
    );
  }
  const manuscriptChannel = assertValidManuscriptChannelForOwner(
    input.ownerType,
    input.manuscriptChannel
  );
  const manuscriptFileName = resolveManuscriptFileName(input, manuscriptChannel);
  const rootStatus = await dependencies.getRootStatus();
  if (rootStatus.status !== "configured") {
    throw new ProvisioningError(
      rootStatus.status === "unconfigured"
        ? PROVISIONING_ERROR_CODES.rootMissing
        : PROVISIONING_ERROR_CODES.rootInvalid,
      rootStatus.status === "unconfigured" ? "Managed root is not configured." : "Managed root is invalid."
    );
  }
  const canonicalInput = input.projectId
    ? { ...input, projectTitle: authority.projectTitle ?? input.projectTitle }
    : input;
  const pathInput = canonicalInput.projectId
    ? {
        root: rootStatus.managedRoot,
        projectId: canonicalInput.projectId,
        projectTitle: canonicalInput.projectTitle,
        ownerType: canonicalInput.ownerType as ManagedPathOwnerType,
        ownerId: canonicalInput.ownerId,
        ownerTitle: canonicalInput.ownerTitle,
        createdAt: canonicalInput.createdAt,
        collectionFolder: canonicalInput.collectionFolder
      }
    : {
        root: rootStatus.managedRoot,
        projectId: null,
        projectTitle: null,
        ownerType: "literature" as const,
        ownerId: canonicalInput.ownerId,
        ownerTitle: canonicalInput.ownerTitle,
        createdAt: canonicalInput.createdAt,
        collectionFolder: canonicalInput.collectionFolder
      };
  const path = dependencies.buildPath(pathInput);
  const [binding, ownerFileRefs] = await Promise.all([
    dependencies.getBinding(input.ownerType, input.ownerId, manuscriptChannel),
    dependencies.getOwnerFileRefs(input.ownerType, input.ownerId)
  ]);
  const boundFolder = binding?.defaultFolderFileRefId
    ? await dependencies.getFileRefById(binding.defaultFolderFileRefId)
    : undefined;
  const boundManuscript = binding?.defaultManuscriptFileRefId
    ? await dependencies.getFileRefById(binding.defaultManuscriptFileRefId)
    : undefined;
  const reusableFolder = ownerFileRefs.find((fileRef) =>
    fileRef.resourceKind === "folder" &&
    fileRef.fileRole === "defaultFolder" &&
    fileRef.locationMode === "managed"
  );
  const reusableManuscript = ownerFileRefs.find((fileRef) =>
    fileRef.resourceKind === "file" &&
    fileRef.fileRole === "manuscript" &&
    fileRef.locationMode === "managed" &&
    fileRef.manuscriptChannel === manuscriptChannel &&
    directFileName(fileRef.path) === manuscriptFileName
  );
  const expectedDirectoryPath = boundFolder?.path ?? reusableFolder?.path ??
    (boundManuscript || reusableManuscript
      ? getManagedPathParent((boundManuscript ?? reusableManuscript)!.path)
      : path.absolutePath);
  const expectedManuscriptPath = boundManuscript?.path ?? reusableManuscript?.path ??
    buildManagedManuscriptPath(expectedDirectoryPath, manuscriptFileName);
  return {
    canonicalInput,
    identity: {
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      scope: "primary" as const,
      manuscriptChannel,
      expectedDirectoryPath,
      expectedManuscripts: [{ manuscriptChannel, path: expectedManuscriptPath }]
    }
  };
}

export function resolveManagedMainlineIdentity(
  input: ProvisionManagedOwnerInput,
  authority: ValidatedPlanningAuthority
) {
  return resolveManagedMainlineIdentityWithDependencies(input, defaultDependencies, authority);
}

export function createManagedFileProvisioningService(
  dependencies: ManagedFileProvisioningDependencies = defaultDependencies
) {
  return {
    async provision(
      input: ProvisionManagedOwnerInput,
      authorityPermit?: ValidatedPlanningAuthorityHandle,
      validatedAuthority?: ValidatedPlanningAuthority
    ): Promise<ProvisionManagedOwnerResult> {
      if (input.ownerType === "experiment" || input.ownerType === "experimentRun") {
        return errorResult(
          input,
          PROVISIONING_ERROR_CODES.pathInvalid,
          `${input.ownerType} requires the dedicated LP11-8-C-2/C-3 provisioning workflow.`,
          "path-build",
          false
        );
      }
      let owner: FileRefOwnerContext;
      try {
        owner = validatedAuthority
          ? ({
              ownerType: input.ownerType,
              ownerId: input.ownerId,
              entity: {
                id: input.ownerId,
                projectId: validatedAuthority.projectId
              }
            } as FileRefOwnerContext)
          : await dependencies.validateOwner(input.ownerType, input.ownerId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const deleted = message.includes("OWNER_DELETED");
        return errorResult(
          input,
          deleted ? PROVISIONING_ERROR_CODES.ownerDeleted : PROVISIONING_ERROR_CODES.ownerNotFound,
          message,
          "owner-validation",
          false
        );
      }
      try {
        await dependencies.validateProject(input, owner);
      } catch (error) {
        return errorResult(
          input,
          codeFromUnknown(error, PROVISIONING_ERROR_CODES.projectMissing),
          error instanceof Error ? error.message : String(error),
          "project-validation",
          false
        );
      }

      let manuscriptChannel;
      try {
        if (!input.manuscriptChannel) {
          throw new ProvisioningError(
            PROVISIONING_ERROR_CODES.channelInvalid,
            "Manuscript provisioning requires an explicit channel."
          );
        }
        if (input.ownerType === "review" && input.manuscriptChannel !== "primary") {
          throw new ProvisioningError(
            PROVISIONING_ERROR_CODES.channelInvalid,
            "Review provisioning must explicitly use the primary manuscript channel."
          );
        }
        manuscriptChannel = assertValidManuscriptChannelForOwner(
          input.ownerType,
          input.manuscriptChannel
        );
      } catch (error) {
        return errorResult(
          input,
          PROVISIONING_ERROR_CODES.channelInvalid,
          error instanceof Error ? error.message : String(error),
          "channel-validation",
          false
        );
      }

      const rootStatus = await dependencies.getRootStatus();
      if (rootStatus.status !== "configured") {
        return errorResult(
          input,
          rootStatus.status === "unconfigured"
            ? PROVISIONING_ERROR_CODES.rootMissing
            : PROVISIONING_ERROR_CODES.rootInvalid,
          rootStatus.status === "unconfigured" ? "Managed root is not configured." : "Managed root is invalid.",
          "root-validation",
          false
        );
      }

      let path;
      try {
        if (
          isOutputManuscriptOwnerType(input.ownerType) &&
          input.collectionFolder !== getOutputManuscriptStaticDescriptor(input.ownerType).collectionFolder
        ) {
          throw new ProvisioningError(
            PROVISIONING_ERROR_CODES.pathInvalid,
            `${input.ownerType} manuscript provisioning must use the outputs collection folder.`
          );
        }
        const pathInput = input.projectId
          ? {
              root: rootStatus.managedRoot,
              projectId: input.projectId,
              projectTitle: input.projectTitle,
              ownerType: input.ownerType as ManagedPathOwnerType,
              ownerId: input.ownerId,
              ownerTitle: input.ownerTitle,
              createdAt: input.createdAt,
              collectionFolder: input.collectionFolder
            }
          : {
              root: rootStatus.managedRoot,
              projectId: null,
              projectTitle: null,
              ownerType: "literature" as const,
              ownerId: input.ownerId,
              ownerTitle: input.ownerTitle,
              createdAt: input.createdAt,
              collectionFolder: input.collectionFolder
            };
        path = dependencies.buildPath(pathInput);
      } catch (error) {
        return errorResult(
          input,
          PROVISIONING_ERROR_CODES.pathInvalid,
          error instanceof Error ? error.message : String(error),
          "path-build",
          false
        );
      }
      let manuscriptFileName;
      try {
        manuscriptFileName = resolveManuscriptFileName(input, manuscriptChannel);
      } catch (error) {
        return errorResult(
          input,
          codeFromUnknown(error, PROVISIONING_ERROR_CODES.pathInvalid),
          error instanceof Error ? error.message : String(error),
          "manuscript-filename",
          false
        );
      }
      const existingBinding = await dependencies.getBinding(input.ownerType, input.ownerId, manuscriptChannel);
      const ownerFileRefs = await dependencies.getOwnerFileRefs(input.ownerType, input.ownerId);
      const boundFolder = existingBinding?.defaultFolderFileRefId
        ? await dependencies.getFileRefById(existingBinding.defaultFolderFileRefId)
        : undefined;
      const boundManuscript = existingBinding?.defaultManuscriptFileRefId
        ? await dependencies.getFileRefById(existingBinding.defaultManuscriptFileRefId)
        : undefined;
      const unboundDefaultFolders = ownerFileRefs.filter(
        (fileRef) =>
          fileRef.resourceKind === "folder" &&
          fileRef.fileRole === "defaultFolder" &&
          fileRef.locationMode === "managed" &&
          (input.ownerType !== "review" || fileRef.manuscriptChannel === "primary")
      );
      if (
        (!boundFolder && unboundDefaultFolders.length > 1) ||
        (input.ownerType === "review" && boundFolder && unboundDefaultFolders.some((item) => item.id !== boundFolder.id))
      ) {
        return errorResult(
          input,
          PROVISIONING_ERROR_CODES.defaultFolderFileRefFailed,
          "Multiple active managed default-folder FileRefs exist for this owner.",
          "existing-metadata",
          false
        );
      }
      const existingFolder = boundFolder ?? unboundDefaultFolders[0];
      const managedChannelManuscripts = ownerFileRefs.filter(
        (fileRef) =>
          fileRef.resourceKind === "file" &&
          fileRef.fileRole === "manuscript" &&
          fileRef.manuscriptChannel === manuscriptChannel &&
          fileRef.locationMode === "managed"
      );
      if (input.ownerType === "review") {
        const invalidReviewManuscript = managedChannelManuscripts.find(
          (fileRef) => ["body.md", "review-notes.md"].includes(directFileName(fileRef.path))
        );
        if (invalidReviewManuscript) {
          return errorResult(
            input,
            PROVISIONING_ERROR_CODES.metadataConflict,
            `Review managed manuscript must be review.md, not ${directFileName(invalidReviewManuscript.path) || "an empty filename"}.`,
            "existing-metadata",
            false
          );
        }
      }
      const reusableManuscripts = managedChannelManuscripts.filter(
        (fileRef) => directFileName(fileRef.path) === manuscriptFileName
      );
      if (!boundManuscript && reusableManuscripts.length > 1) {
        return errorResult(
          input,
          PROVISIONING_ERROR_CODES.defaultManuscriptFileRefFailed,
          "Multiple active managed default-manuscript FileRefs exist for this owner and channel.",
          "existing-metadata",
          false
        );
      }
      const existingManuscript = boundManuscript ?? reusableManuscripts[0];
      if (existingBinding) {
        const populatedBindingSlotMissing = Boolean(
          (existingBinding.defaultFolderFileRefId && !boundFolder) ||
          (existingBinding.defaultManuscriptFileRefId && !boundManuscript)
        );
        const currentRef = existingBinding.currentFileRefId
          ? await dependencies.getFileRefById(existingBinding.currentFileRefId)
          : undefined;
        // The established Binding contract permits an independently selected
        // current manuscript, but every populated slot must still resolve to an
        // active same-owner/same-channel manuscript identity.
        const populatedCurrentMissing = Boolean(
          existingBinding.currentFileRefId && !currentRef
        );
        const currentConflicts = Boolean(
          currentRef && (
            currentRef.ownerType !== input.ownerType ||
            currentRef.ownerId !== input.ownerId ||
            currentRef.manuscriptChannel !== manuscriptChannel ||
            currentRef.resourceKind !== "file" ||
            currentRef.fileRole !== "manuscript" ||
            !["managed", "external"].includes(currentRef.locationMode) ||
            currentRef.deletedAt
          )
        );
        const slotConflicts = Boolean(
          (boundFolder && existingFolder && boundFolder.id !== existingFolder.id) ||
          (boundManuscript && existingManuscript && boundManuscript.id !== existingManuscript.id)
        );
        if (
          populatedBindingSlotMissing ||
          populatedCurrentMissing ||
          currentConflicts ||
          slotConflicts
        ) {
          return errorResult(
            input,
            PROVISIONING_ERROR_CODES.metadataConflict,
            "Existing manuscript Binding contains a conflicting or unreadable populated identity slot.",
            "existing-binding-validation",
            false
          );
        }
        // A Binding with absent defaults/current is an expected durable partial.
        // Fully populated rows still pass through the established strict resolver.
        if (
          existingBinding.defaultFolderFileRefId &&
          existingBinding.defaultManuscriptFileRefId &&
          existingBinding.currentFileRefId &&
          currentRef
        ) {
          try {
            await dependencies.validateBinding(existingBinding);
          } catch (error) {
            return errorResult(
              input,
              PROVISIONING_ERROR_CODES.metadataConflict,
              error instanceof Error ? error.message : String(error),
              "existing-binding-validation",
              false
            );
          }
        }
      }
      if (existingManuscript && directFileName(existingManuscript.path) !== manuscriptFileName) {
        return errorResult(
          input,
          PROVISIONING_ERROR_CODES.metadataConflict,
          `Bound default manuscript basename must be ${manuscriptFileName}.`,
          "existing-metadata",
          false
        );
      }
      if (existingFolder && existingFolder.fileType !== "folder") {
        return errorResult(
          input,
          PROVISIONING_ERROR_CODES.metadataConflict,
          "Default folder FileRef must use fileType=folder.",
          "existing-metadata",
          false
        );
      }
      if (existingManuscript && existingManuscript.fileType !== "markdown") {
        return errorResult(
          input,
          PROVISIONING_ERROR_CODES.metadataConflict,
          "Default manuscript FileRef must use fileType=markdown.",
          "existing-metadata",
          false
        );
      }
      if (existingFolder && existingManuscript) {
        let sameParent = false;
        try {
          sameParent = createPathIdentityKey(existingFolder.path) === pathParentIdentity(existingManuscript.path);
        } catch {
          sameParent = false;
        }
        if (!sameParent) {
          return errorResult(
            input,
            PROVISIONING_ERROR_CODES.metadataConflict,
            "Default folder and default manuscript path identities do not match.",
            "existing-metadata",
            false
          );
        }
      }
      const targetDirectory =
        existingFolder?.path ??
        (existingManuscript ? getManagedPathParent(existingManuscript.path) : path.absolutePath);
      const requestedBodyPath = existingManuscript?.path ?? buildManagedManuscriptPath(targetDirectory, manuscriptFileName);
      let relativeFolderPath: string;
      try {
        relativeFolderPath = getManagedRelativePath(path.rootPath, targetDirectory);
      } catch (error) {
        return errorResult(
          input,
          PROVISIONING_ERROR_CODES.pathOutsideRoot,
          error instanceof Error ? error.message : String(error),
          "existing-metadata",
          false
        );
      }
      let native: NativeProvisionManagedEntryResult;
      try {
        native = await dependencies.provisionFilesystem({
          ownerType: input.ownerType,
          manuscriptChannel,
          configuredRoot: path.rootPath,
          targetDirectory,
          bodyPath: requestedBodyPath,
          initialContent: input.initialContent ?? MANUSCRIPT_BLANK_INITIAL_CONTENT,
          allowCreateBody: !existingManuscript
        });
      } catch (error) {
        return errorResult(
          input,
          PROVISIONING_ERROR_CODES.directoryCreateFailed,
          error instanceof Error ? error.message : String(error),
          "filesystem",
          true,
          {
            status: "partial",
            rootPath: path.rootPath,
            relativeFolderPath,
            absoluteFolderPath: targetDirectory,
            effectOutcomeUnknown: true,
            completedSteps: ["filesystem-outcome-unknown"]
          }
        );
      }
      const completedSteps = [
        ...(native.createdDirectory || native.reusedDirectory ? ["directory"] : []),
        ...(native.createdBody || native.reusedBody ? ["default-manuscript-file"] : [])
      ];
      if (native.status === "error" || native.status === "partial") {
        const durableMetadataSteps = [
          ...(existingFolder ? ["default-folder-file-ref"] : []),
          ...(existingManuscript ? ["default-manuscript-file-ref"] : []),
          ...(existingBinding ? ["binding"] : [])
        ];
        return errorResult(
          input,
          native.errorCode ?? PROVISIONING_ERROR_CODES.bodyCreateFailed,
          native.errorMessage ?? "Filesystem provisioning failed.",
          "filesystem",
          native.retryable,
          {
            status: native.status === "error" && durableMetadataSteps.length > 0
              ? "partial"
              : native.status,
            rootPath: path.rootPath,
            relativeFolderPath,
            absoluteFolderPath: native.directoryPath,
            bodyPath: native.bodyPath,
            createdFolder: native.createdDirectory,
            createdBody: native.createdBody,
            reusedFolder: native.reusedDirectory,
            reusedBody: native.reusedBody,
            completedSteps: [...new Set([...completedSteps, ...durableMetadataSteps])]
          }
        );
      }

      let folderResult;
      try {
        folderResult = await dependencies.registerFileRef({
          ownerType: input.ownerType,
          ownerId: input.ownerId,
          manuscriptChannel: "primary",
          resourceKind: "folder",
          fileRole: "defaultFolder",
          locationMode: "managed",
          fileType: "folder",
          path: native.directoryPath,
          title: input.ownerTitle || "Managed folder",
          source: input.source ?? "system"
        }, authorityPermit);
        completedSteps.push("default-folder-file-ref");
      } catch (error) {
        return errorResult(
          input,
          PROVISIONING_ERROR_CODES.defaultFolderFileRefFailed,
          error instanceof Error ? error.message : String(error),
          "default-folder-file-ref",
          true,
          {
            rootPath: path.rootPath,
            relativeFolderPath,
            absoluteFolderPath: native.directoryPath,
            bodyPath: native.bodyPath,
            createdFolder: native.createdDirectory,
            createdBody: native.createdBody,
            reusedFolder: native.reusedDirectory,
            reusedBody: native.reusedBody,
            completedSteps
          }
        );
      }

      let manuscriptResult;
      try {
        manuscriptResult = await dependencies.registerFileRef({
          ownerType: input.ownerType,
          ownerId: input.ownerId,
          manuscriptChannel,
          resourceKind: "file",
          fileRole: "manuscript",
          locationMode: "managed",
          fileType: "markdown",
          path: native.bodyPath,
          title: input.manuscriptDisplayName?.trim() || manuscriptFileName,
          source: input.source ?? "system"
        }, authorityPermit);
        completedSteps.push("default-manuscript-file-ref");
      } catch (error) {
        return errorResult(
          input,
          PROVISIONING_ERROR_CODES.defaultManuscriptFileRefFailed,
          error instanceof Error ? error.message : String(error),
          "default-manuscript-file-ref",
          true,
          {
            rootPath: path.rootPath,
            relativeFolderPath,
            absoluteFolderPath: native.directoryPath,
            bodyPath: native.bodyPath,
            defaultFolderFileRef: folderResult.fileRef,
            folderFileRefState: folderResult.state,
            createdFolder: native.createdDirectory,
            createdBody: native.createdBody,
            reusedFolder: native.reusedDirectory,
            reusedBody: native.reusedBody,
            completedSteps
          }
        );
      }

      const bindingFeedback = await dependencies.upsertBindingDefaults(
        input.ownerType,
        input.ownerId,
        folderResult.fileRef.id,
        manuscriptResult.fileRef.id,
        manuscriptChannel,
        authorityPermit
      );
      if (bindingFeedback.status === "error" || !bindingFeedback.data) {
        return errorResult(
          input,
          PROVISIONING_ERROR_CODES.bindingFailed,
          bindingFeedback.errors.join("; ") || "Manuscript binding provisioning failed.",
          "binding",
          true,
          {
            rootPath: path.rootPath,
            relativeFolderPath,
            absoluteFolderPath: native.directoryPath,
            bodyPath: native.bodyPath,
            defaultFolderFileRef: folderResult.fileRef,
            defaultManuscriptFileRef: manuscriptResult.fileRef,
            folderFileRefState: folderResult.state,
            manuscriptFileRefState: manuscriptResult.state,
            createdFolder: native.createdDirectory,
            createdBody: native.createdBody,
            reusedFolder: native.reusedDirectory,
            reusedBody: native.reusedBody,
            completedSteps
          }
        );
      }
      completedSteps.push("binding");
      const changed =
        native.status === "success" ||
        folderResult.state !== "reused" ||
        manuscriptResult.state !== "reused" ||
        bindingFeedback.status === "success";
      return {
        status: changed ? "success" : "skipped",
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        rootPath: path.rootPath,
        relativeFolderPath,
        absoluteFolderPath: native.directoryPath,
        bodyPath: native.bodyPath,
        defaultFolderFileRef: folderResult.fileRef,
        defaultManuscriptFileRef: manuscriptResult.fileRef,
        binding: bindingFeedback.data,
        folderFileRefState: folderResult.state,
        manuscriptFileRefState: manuscriptResult.state,
        bindingState: existingBinding || bindingFeedback.status === "skipped" ? "reused" : "created",
        currentState: existingBinding?.currentFileRefId ? "preserved" : "initialized",
        createdFolder: native.createdDirectory,
        createdBody: native.createdBody,
        reusedFolder: native.reusedDirectory,
        reusedBody: native.reusedBody,
        warnings: [...path.warnings, ...bindingFeedback.warnings],
        errors: [],
        completedSteps,
        retryable: false
      };
    }
  };
}

const managedFileProvisioningCore = createManagedFileProvisioningService();

export const managedFileProvisioningService = {
  async provision(
    input: ProvisionManagedOwnerInput,
    authorityPermit?: ValidatedPlanningAuthorityHandle,
    validatedAuthority?: ValidatedPlanningAuthority
  ): Promise<ProvisionManagedOwnerResult> {
    const executeMainline = async (
      permit: ValidatedPlanningAuthorityHandle,
      authority: ValidatedPlanningAuthority
    ) => {
      let resolved;
      try {
        resolved = await resolveManagedMainlineIdentity(input, authority);
      } catch (error) {
        return errorResult(
          input,
          codeFromUnknown(error, PROVISIONING_ERROR_CODES.pathInvalid),
          error instanceof Error ? error.message : String(error),
          "durable-mainline-placement",
          false
        );
      }
      const { canonicalInput, identity } = resolved;
      let operation;
      try {
        operation = await manuscriptProvisioningMainlineCoordinator.begin(identity, permit);
      } catch (error) {
        return errorResult(
          input,
          PROVISIONING_ERROR_CODES.partial,
          error instanceof Error ? error.message : String(error),
          "durable-mainline-begin",
          true
        );
      }
      const result = await managedFileProvisioningCore.provision(
        canonicalInput,
        permit,
        authority
      );
      const effectReady = result.status === "success" || result.status === "skipped";
      try {
        const terminal = await manuscriptProvisioningMainlineCoordinator.finish(
          identity,
          operation.operationId,
          effectReady,
          result.errors[0]?.code,
          observedManagedPrimarySteps(result),
          permit,
          result.effectOutcomeUnknown === true
        );
        return {
          ...result,
          status: terminal.ready
            ? result.status
            : terminal.operationStatus === "terminal-failed"
              ? result.status
              : "partial" as const,
          retryable: terminal.ready ? result.retryable : terminal.nextAction === "retry",
          durableOperationId: terminal.operationId,
          durableRootOperationId: terminal.rootOperationId,
          durableReady: terminal.ready
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ...result,
          status: "partial" as const,
          retryable: false,
          durableOperationId: operation.operationId,
          durableRootOperationId: operation.rootOperationId,
          durableReady: false,
          warnings: [
            ...result.warnings,
            `The provisioning effect may be durable, but terminal confirmation is unavailable; automatic retry is disabled: ${message}`
          ]
        };
      }
    };
    if (authorityPermit && validatedAuthority) {
      return executeMainline(authorityPermit, validatedAuthority);
    }
    try {
      return await runWithProvisioningAuthority({
        request: {
          intent: "provisioningWrite",
          requestId: `managed-file-provisioning-${input.ownerType}-${input.ownerId}`,
          projectId: input.projectId ?? undefined,
          ownerType: input.ownerType,
          ownerId: input.ownerId,
          scope: input.manuscriptChannel
        },
        write: executeMainline
      });
    } catch (error) {
      const issue = toProvisioningAuthorityIssue(error);
      return errorResult(
        input,
        issue.code,
        issue.message,
        "authority-admission",
        issue.retryable
      );
    }
  }
};

// Literature owns one aggregate durable intent. Its two exact child channels
// reuse this effect adapter under the already-held aggregate authority; the
// adapter never starts a second durable operation.
export function provisionManagedEntryWithinMainline(
  input: ProvisionManagedOwnerInput,
  authorityPermit: ValidatedPlanningAuthorityHandle,
  validatedAuthority: ValidatedPlanningAuthority
) {
  return managedFileProvisioningCore.provision(input, authorityPermit, validatedAuthority);
}
