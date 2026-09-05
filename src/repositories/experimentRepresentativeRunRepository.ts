import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./dataSourceMode";
import type {
  AddRepresentativeRunRepositoryInput,
  CleanupRepresentativeRunRelationsRepositoryInput,
  CleanupRepresentativeRunRelationsResult,
  ExperimentRepresentativeRunRepository,
  RemoveRepresentativeRunRepositoryInput,
  RepresentativeRunAggregate,
  RepresentativeRunRelation,
  SetRepresentativeRunOrderRepositoryInput,
  SetRepresentativeRunOrderResult
} from "../types/representativeExperimentRun";
import { REPRESENTATIVE_RUN_ERROR_CODES } from "../types/representativeExperimentRun";

function assertNativeBackend() {
  if (!isTauriRuntime()) {
    throw new Error(REPRESENTATIVE_RUN_ERROR_CODES.nativeBackendRequired);
  }
}

export const experimentRepresentativeRunRepository: ExperimentRepresentativeRunRepository = {
  async listRepresentativeRuns(experimentId) {
    assertNativeBackend();
    return invoke<RepresentativeRunRelation[]>("db_list_representative_runs", {
      experimentId
    });
  },
  async addRepresentativeRun(input: AddRepresentativeRunRepositoryInput) {
    assertNativeBackend();
    return invoke<RepresentativeRunRelation>("db_add_representative_run", { input });
  },
  async removeRepresentativeRun(input: RemoveRepresentativeRunRepositoryInput) {
    assertNativeBackend();
    return invoke<RepresentativeRunRelation>("db_remove_representative_run", { input });
  },
  async setRepresentativeRunOrder(input: SetRepresentativeRunOrderRepositoryInput) {
    assertNativeBackend();
    return invoke<SetRepresentativeRunOrderResult>("db_set_representative_run_order", {
      input
    });
  },
  async getRepresentativeRunAggregate(experimentId) {
    assertNativeBackend();
    return invoke<RepresentativeRunAggregate>("db_get_representative_run_aggregate", {
      experimentId
    });
  },
  async cleanupRepresentativeRunRelations(
    input: CleanupRepresentativeRunRelationsRepositoryInput
  ) {
    assertNativeBackend();
    return invoke<CleanupRepresentativeRunRelationsResult>(
      "db_cleanup_representative_run_relations",
      { input }
    );
  }
};
