import {
  experimentRepositoryConfig,
  experimentRunRepositoryConfig
} from "../repositories/entityConfig";
import { createRepository } from "../repositories/repositoryFactory";
import type { Experiment, ExperimentRun } from "../types/experiment";
import { createExperimentRunGuard } from "./experimentRunGuardRules";

export {
  EXPERIMENT_RUN_GUARD_ERROR_CODES,
  ExperimentRunGuardError,
  createExperimentRunGuard
} from "./experimentRunGuardRules";
export type {
  ExperimentRunAccess,
  ExperimentRunGuardErrorCode
} from "./experimentRunGuardRules";

const runRepository = createRepository<ExperimentRun>(experimentRunRepositoryConfig);
const parentRepository = createRepository<Experiment>(experimentRepositoryConfig);

const productionGuard = createExperimentRunGuard({
  loadRun: runRepository.getById,
  loadDeletedRun: runRepository.getDeletedById,
  loadParent: parentRepository.getById,
  loadDeletedParent: parentRepository.getDeletedById
});

export const getControlledExperimentRunAccess = productionGuard.getControlledAccess;
export const assertExperimentRunWritable = productionGuard.assertWritable;

/** Canonical active Run enumeration reusing the same parent/project integrity guard. */
export async function listControlledActiveExperimentRuns() {
  const runs = await runRepository.list();
  const access = await Promise.all(runs.map(async (run) => {
    try {
      return await productionGuard.getControlledAccess(run.id);
    } catch {
      return undefined;
    }
  }));
  return access.filter((item): item is NonNullable<typeof item> => Boolean(item && !item.readOnly));
}
