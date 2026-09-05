import { invoke } from "@tauri-apps/api/core";
import type {
  NativeProvisionExperimentManuscriptInput,
  NativeProvisionExperimentRunManuscriptInput,
  NativeProvisionManagedEntryInput,
  NativeProvisionManagedEntryResult
} from "../types/provisioning";

export function provisionExperimentManuscriptFilesystem(
  input: NativeProvisionExperimentManuscriptInput
) {
  return invoke<NativeProvisionManagedEntryResult>("provision_experiment_manuscript", {
    configuredRoot: input.configuredRoot,
    projectWorkspace: input.projectWorkspace,
    targetWorkspace: input.targetWorkspace,
    defaultFilePath: input.defaultFilePath,
    initialContent: input.initialContent
  });
}

export function provisionExperimentRunManuscriptFilesystem(
  input: NativeProvisionExperimentRunManuscriptInput
) {
  return invoke<NativeProvisionManagedEntryResult>("provision_experiment_run_manuscript", {
    configuredRoot: input.configuredRoot,
    projectWorkspace: input.projectWorkspace,
    parentExperimentWorkspace: input.parentExperimentWorkspace,
    targetWorkspace: input.targetWorkspace,
    defaultFilePath: input.defaultFilePath,
    initialContent: input.initialContent
  });
}

export function provisionManagedEntryFilesystem(input: NativeProvisionManagedEntryInput) {
  return invoke<NativeProvisionManagedEntryResult>("provision_managed_entry", {
    ownerType: input.ownerType,
    manuscriptChannel: input.manuscriptChannel,
    configuredRoot: input.configuredRoot,
    targetDirectory: input.targetDirectory,
    bodyPath: input.bodyPath,
    initialContent: input.initialContent,
    allowCreateBody: input.allowCreateBody
  });
}

export const nativeProvisioningService = {
  provisionManagedEntry: provisionManagedEntryFilesystem,
  provisionExperimentManuscript: provisionExperimentManuscriptFilesystem,
  provisionExperimentRunManuscript: provisionExperimentRunManuscriptFilesystem
};
