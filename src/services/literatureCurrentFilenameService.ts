import type {
  EntityId,
  FileRef,
  ManuscriptBindingIdentityResult,
  ManuscriptChannel
} from "../types";
import type {
  LiteratureCurrentFilenameDto,
  LiteratureManuscriptStatusSummary
} from "../types/literatureContext";
import { getSafeManuscriptBasename, fileRefService } from "./fileRefService";
import { manuscriptBindingService } from "./manuscriptBindingService";

export interface LiteratureCurrentFilenameDependencies {
  resolveIdentity(input: {
    ownerType: "literature";
    ownerId: EntityId;
    manuscriptChannel: ManuscriptChannel;
  }): Promise<ManuscriptBindingIdentityResult>;
  getFileRef(id: EntityId): Promise<FileRef | undefined>;
}

const defaultDependencies: LiteratureCurrentFilenameDependencies = {
  resolveIdentity: manuscriptBindingService.resolveIdentity,
  getFileRef: fileRefService.getById
};

function requireChannel(
  manuscriptChannel: ManuscriptChannel
): "literature_outline" | "dedicated_notes" {
  if (manuscriptChannel !== "literature_outline" && manuscriptChannel !== "dedicated_notes") {
    throw new Error(`Unsupported Literature current filename channel: ${manuscriptChannel}.`);
  }
  return manuscriptChannel;
}

export function safeManuscriptBasename(path: string) {
  return getSafeManuscriptBasename(path);
}

export function createLiteratureCurrentFilenameService(
  dependencies: LiteratureCurrentFilenameDependencies = defaultDependencies
) {
  return {
    async getCurrentFilename(
      literatureId: EntityId,
      requestedChannel: ManuscriptChannel
    ): Promise<LiteratureCurrentFilenameDto> {
      const manuscriptChannel = requireChannel(requestedChannel);
      const base = { literatureId, manuscriptChannel } as const;
      const identity = await dependencies.resolveIdentity({
        ownerType: "literature",
        ownerId: literatureId,
        manuscriptChannel
      });
      if (identity.status === "not-found") return { ...base, status: "uninitialized" };
      const binding = identity.binding;
      if (!binding) return { ...base, status: "invalid-current" };
      const currentSlot = identity.slots.currentFileRefId;
      if (currentSlot.status === "missing" || !currentSlot.fileRefId) {
        return { ...base, bindingId: binding.id, status: "missing-current" };
      }
      if (!identity.identityResolved) {
        return {
          ...base,
          bindingId: binding.id,
          currentFileRefId: currentSlot.fileRefId,
          status: "invalid-current"
        };
      }
      const fileRef = await dependencies.getFileRef(currentSlot.fileRefId);
      if (!fileRef) {
        return {
          ...base,
          bindingId: binding.id,
          currentFileRefId: currentSlot.fileRefId,
          status: "invalid-current"
        };
      }
      const currentFilename = safeManuscriptBasename(fileRef.path);
      if (!currentFilename) {
        return {
          ...base,
          bindingId: binding.id,
          currentFileRefId: fileRef.id,
          status: "invalid-filename"
        };
      }
      return {
        ...base,
        bindingId: binding.id,
        currentFileRefId: fileRef.id,
        currentFilename,
        currentLocationMode: fileRef.locationMode,
        status: "ready"
      };
    }
  };
}

export function toLiteratureManuscriptStatusSummary(
  dto: LiteratureCurrentFilenameDto
): LiteratureManuscriptStatusSummary {
  return {
    hasBinding: Boolean(dto.bindingId),
    currentFileRefId: dto.currentFileRefId,
    currentFileName: dto.currentFilename,
    currentLocationMode: dto.currentLocationMode,
    manuscriptStatus: dto.status === "invalid-filename" ? "invalid-current" : dto.status
  };
}

export const literatureCurrentFilenameService = createLiteratureCurrentFilenameService();
