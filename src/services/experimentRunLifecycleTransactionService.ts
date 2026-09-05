import { invoke } from "@tauri-apps/api/core";
import type {
  ExperimentRunLifecycleDatabasePreflight,
  ExperimentRunLifecycleHardDeleteInput,
  ExperimentRunLifecycleIssuedToken,
  ExperimentRunLifecycleMutationInput,
  ExperimentRunLifecycleMutationResult,
  ExperimentRunLifecycleTokenIssueInput
} from "../types/experimentRunLifecycle";

// Trusted-renderer architectural boundary: this IPC wrapper is private to
// experimentRunLifecycleService. Production callers must never invoke these commands directly.

export function inspectExperimentRunLifecycleDatabase(
  ownerType: ExperimentRunLifecycleMutationInput["ownerType"],
  ownerId: string
) {
  return invoke<ExperimentRunLifecycleDatabasePreflight>(
    "db_inspect_experiment_run_lifecycle",
    { input: { ownerType, ownerId } }
  );
}

export function issueExperimentRunLifecyclePreflightToken(input: ExperimentRunLifecycleTokenIssueInput) {
  return invoke<ExperimentRunLifecycleIssuedToken>(
    "db_issue_experiment_run_lifecycle_preflight_token",
    { input }
  );
}

export function softDeleteExperimentRunLifecycleMetadata(input: ExperimentRunLifecycleMutationInput) {
  return invoke<ExperimentRunLifecycleMutationResult>(
    "db_soft_delete_experiment_run_metadata",
    { input }
  );
}

export function restoreExperimentRunLifecycleMetadata(input: ExperimentRunLifecycleMutationInput) {
  return invoke<ExperimentRunLifecycleMutationResult>(
    "db_restore_experiment_run_metadata",
    { input }
  );
}

export function confirmExperimentRunLifecycleHardMetadataDelete(input: ExperimentRunLifecycleHardDeleteInput) {
  return invoke<ExperimentRunLifecycleMutationResult>(
    "db_confirm_experiment_run_hard_metadata_delete",
    { input }
  );
}
