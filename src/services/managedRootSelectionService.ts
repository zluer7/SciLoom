import { createPathIdentityKey } from "./fileRefIdentity";
import type { LocalFileResult, SelectLocalFolderOptions } from "../types/localFile";
import type { WriteFeedbackResult } from "../types/writeFeedback";
import { localFileService } from "./localFileService";
import {
  managedRootConfigService,
  type ManagedRootConfigurationResult,
  type ManagedRootConfigurationSnapshot
} from "./managedRootConfigService";

type ManagedRootConfigurationFeedback =
  WriteFeedbackResult<ManagedRootConfigurationResult>;

export type ManagedRootSelectionOutcome =
  | { status: "canceled" }
  | {
      status: "ready";
      selectedPath: string;
      snapshot: ManagedRootConfigurationSnapshot;
      feedback: ManagedRootConfigurationFeedback;
    }
  | {
      status: "failed";
      errorCode: string;
      snapshot?: ManagedRootConfigurationSnapshot;
      feedback?: ManagedRootConfigurationFeedback;
    };

export interface ManagedRootSelectionDependencies {
  selectFolder(options: SelectLocalFolderOptions): Promise<LocalFileResult>;
  configureFirstRoot(path: string): Promise<ManagedRootConfigurationFeedback>;
  readSnapshot(): Promise<ManagedRootConfigurationSnapshot>;
}

function stableError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function pathIdentity(path: string) {
  const value = path.trim();
  if (value.startsWith("/") && !value.startsWith("//")) {
    return createPathIdentityKey(value);
  }
  return value.replace(/\//gu, "\\").replace(/\\+$/u, "").toLowerCase();
}

export function createManagedRootSelectionService(
  dependencies: ManagedRootSelectionDependencies
) {
  return {
    async selectAndConfigure(
      options: SelectLocalFolderOptions
    ): Promise<ManagedRootSelectionOutcome> {
      const selected = await dependencies.selectFolder(options);
      if (selected.status === "canceled") return { status: "canceled" };
      if (!selected.ok || !selected.path) {
        return {
          status: "failed",
          errorCode: selected.errorMessage ?? "MANAGED_ROOT_FOLDER_PICKER_FAILED"
        };
      }

      try {
        const feedback = await dependencies.configureFirstRoot(selected.path);
        const snapshot = await dependencies.readSnapshot();
        const durablePath = snapshot.normalizedPath ?? snapshot.configuredPath ?? "";
        if (
          snapshot.durableState === "CONFIGURED" &&
          snapshot.readinessState === "READY" &&
          pathIdentity(durablePath) === pathIdentity(selected.path)
        ) {
          return {
            status: "ready",
            selectedPath: selected.path,
            snapshot,
            feedback
          };
        }
        return {
          status: "failed",
          errorCode:
            snapshot.errorCode ?? "MANAGED_ROOT_DURABLE_READBACK_MISMATCH",
          snapshot,
          feedback
        };
      } catch (error) {
        return {
          status: "failed",
          errorCode: stableError(error)
        };
      }
    }
  };
}

export const managedRootSelectionService = createManagedRootSelectionService({
  selectFolder: (options) => localFileService.selectFolder(options),
  configureFirstRoot: (path) => managedRootConfigService.configureFirstRoot(path),
  readSnapshot: () => managedRootConfigService.getConfigurationSnapshot()
});
