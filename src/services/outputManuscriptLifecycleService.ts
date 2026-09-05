import type {
  OutputManuscriptHardCleanupResult,
  OutputManuscriptOwnerType
} from "../types";
import type { EntityId } from "../types/common";
import { fileRefService } from "./fileRefService";
import {
  resolveMountedManuscriptLifecycleDecision,
  validateFileRefOwner
} from "./fileRefOwnerValidator";
import { manuscriptBindingService } from "./manuscriptBindingService";
import { assertOutputManuscriptChannel } from "./outputManuscriptDescriptorService";

const cleanupBlockedOwners = new Set<string>();
const ownerKey = (ownerType: OutputManuscriptOwnerType, ownerId: EntityId) => `${ownerType}:${ownerId}`;

export interface OutputManuscriptLifecycleDependencies {
  validateOwner(ownerType: string, ownerId: EntityId): ReturnType<typeof validateFileRefOwner>;
  removeBinding(ownerType: OutputManuscriptOwnerType, ownerId: EntityId): ReturnType<typeof manuscriptBindingService.removeBindingByOwner>;
  listFileRefs(ownerType: OutputManuscriptOwnerType, ownerId: EntityId): ReturnType<typeof fileRefService.getFileRefsByOwnerIncludingDeleted>;
  removeFileRefMetadata(fileRefId: EntityId): Promise<boolean>;
}

const defaultDependencies: OutputManuscriptLifecycleDependencies = {
  validateOwner: validateFileRefOwner,
  removeBinding: (ownerType, ownerId) =>
    manuscriptBindingService.removeBindingByOwner(ownerType, ownerId, "primary"),
  listFileRefs: fileRefService.getFileRefsByOwnerIncludingDeleted,
  removeFileRefMetadata: async (fileRefId) => {
    const active = await fileRefService.getById(fileRefId);
  if (active && !(await fileRefService.softDeleteMetadataPrimitive(fileRefId))) return false;
    const deleted = await fileRefService.getDeletedById(fileRefId);
  return deleted ? fileRefService.hardDeleteMetadataPrimitive(fileRefId) : !active;
  }
};

export function createOutputManuscriptLifecycleService(
  dependencies: OutputManuscriptLifecycleDependencies = defaultDependencies
) {
  return {
    async assertOwnerActive(
      ownerType: OutputManuscriptOwnerType,
      ownerId: EntityId,
      channel: "primary"
    ) {
      assertOutputManuscriptChannel(ownerType, channel);
      if (cleanupBlockedOwners.has(ownerKey(ownerType, ownerId))) {
        throw new Error(`OUTPUT_MANUSCRIPT_FILE_CLEANUP_IN_PROGRESS: ${ownerType}/${ownerId}.`);
      }
      const lifecycle = await resolveMountedManuscriptLifecycleDecision({
        ownerType,
        ownerId,
        manuscriptChannel: channel
      });
      if (!lifecycle.canWrite) {
        throw new Error(
          `OUTPUT_MANUSCRIPT_OWNER_NOT_WRITABLE: ${lifecycle.reasonCode ?? "UNKNOWN"}.`
        );
      }
      return dependencies.validateOwner(ownerType, ownerId);
    },

    async cleanupHardDeleteMetadata(input: {
      ownerType: OutputManuscriptOwnerType;
      ownerId: EntityId;
      channel: "primary";
      confirmedByUser: boolean;
    }): Promise<OutputManuscriptHardCleanupResult> {
      assertOutputManuscriptChannel(input.ownerType, input.channel);
      if (input.confirmedByUser !== true) {
        throw new Error("OUTPUT_MANUSCRIPT_HARD_CLEANUP_NOT_CONFIRMED");
      }
      try {
        await dependencies.validateOwner(input.ownerType, input.ownerId);
        throw new Error("OUTPUT_MANUSCRIPT_HARD_CLEANUP_OWNER_ACTIVE");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("OUTPUT_MANUSCRIPT_HARD_CLEANUP_OWNER_ACTIVE")) throw error;
        if (!message.includes("OWNER_DELETED")) throw error;
      }
      cleanupBlockedOwners.add(ownerKey(input.ownerType, input.ownerId));
      let removedBinding = false;
      let removedFileRefCount = 0;
      try {
        const binding = await dependencies.removeBinding(input.ownerType, input.ownerId);
        if (binding.status === "error" || binding.status === "partial") {
          throw new Error(binding.errors.join("; ") || "Binding cleanup failed.");
        }
        removedBinding = binding.status === "success";
      } catch {
        return {
          status: "partial",
          ownerType: input.ownerType,
          ownerId: input.ownerId,
          removedBinding,
          removedFileRefCount,
          failedStep: "binding",
          retryable: true,
          physicalFilesTouched: false,
          warnings: ["Physical files were not read, moved, overwritten, scanned, or deleted."]
        };
      }
      try {
        const fileRefs = await dependencies.listFileRefs(input.ownerType, input.ownerId);
        for (const fileRef of fileRefs) {
          if (await dependencies.removeFileRefMetadata(fileRef.id)) removedFileRefCount += 1;
        }
      } catch {
        return {
          status: "partial",
          ownerType: input.ownerType,
          ownerId: input.ownerId,
          removedBinding,
          removedFileRefCount,
          failedStep: "fileRefs",
          retryable: true,
          physicalFilesTouched: false,
          warnings: ["Physical files were not read, moved, overwritten, scanned, or deleted."]
        };
      }
      return {
        status: "complete",
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        removedBinding,
        removedFileRefCount,
        retryable: false,
        physicalFilesTouched: false,
        warnings: ["Only Binding and FileRef metadata were permanently removed; physical files remain untouched."]
      };
    },

    isBlocked(ownerType: OutputManuscriptOwnerType, ownerId: EntityId) {
      return cleanupBlockedOwners.has(ownerKey(ownerType, ownerId));
    }
  };
}

export const outputManuscriptLifecycleService = createOutputManuscriptLifecycleService();
