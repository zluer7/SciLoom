import {
  experimentRepositoryConfig,
  experimentRunRepositoryConfig
} from "../repositories/entityConfig";
import { createRepository } from "../repositories/repositoryFactory";
import type { Experiment, ExperimentRun, Project } from "../types";
import {
  EXPERIMENT_RUN_RAW_ERROR_CODES,
  type ExperimentRunRawSafeError
} from "../types/experimentRunRawManuscript";
import { getProjectById } from "./planningService";
import { deriveMountedManuscriptLifecycleDecision } from "./fileRefOwnerValidator";

export type ExperimentRunManuscriptPermissionOperation =
  | "read-current"
  | "read-independent"
  | "save-current"
  | "save-independent"
  | "reload";

export interface ExperimentRunManuscriptPermissionDependencies {
  loadRun(id: string): Promise<ExperimentRun | undefined | null>;
  loadDeletedRun(id: string): Promise<ExperimentRun | undefined | null>;
  loadParent(id: string): Promise<Experiment | undefined | null>;
  loadDeletedParent(id: string): Promise<Experiment | undefined | null>;
  loadProject?(id: string): Promise<Project | undefined | null>;
}

const runRepository = createRepository<ExperimentRun>(experimentRunRepositoryConfig);
const parentRepository = createRepository<Experiment>(experimentRepositoryConfig);

const defaultDependencies: ExperimentRunManuscriptPermissionDependencies = {
  loadRun: runRepository.getById,
  loadDeletedRun: runRepository.getDeletedById,
  loadParent: parentRepository.getById,
  loadDeletedParent: parentRepository.getDeletedById,
  loadProject: getProjectById
};

function denied(code: ExperimentRunRawSafeError["code"], causeCode?: string) {
  return {
    status: "denied" as const,
    error: {
      code,
      causeCode,
      retryable: false,
      writeApplied: false as const,
      verificationFailed: false
    }
  };
}

export function createExperimentRunManuscriptPermissionService(
  dependencies: ExperimentRunManuscriptPermissionDependencies = defaultDependencies
) {
  return Object.freeze({
    async evaluate(runId: string, operation: ExperimentRunManuscriptPermissionOperation) {
      const activeRun = await dependencies.loadRun(runId);
      const deletedRun = activeRun ? undefined : await dependencies.loadDeletedRun(runId);
      const run = activeRun ?? deletedRun;
      if (!run) return denied(EXPERIMENT_RUN_RAW_ERROR_CODES.ownerMissing);

      const activeParent = await dependencies.loadParent(run.experimentId);
      const deletedParent = activeParent
        ? undefined
        : await dependencies.loadDeletedParent(run.experimentId);
      const parent = activeParent ?? deletedParent;
      if (!parent) return denied(EXPERIMENT_RUN_RAW_ERROR_CODES.parentMissing);
      if (parent.id !== run.experimentId || parent.projectId !== run.projectId) {
        return denied(EXPERIMENT_RUN_RAW_ERROR_CODES.ownerMismatch);
      }

      const ownerDeleted = Boolean(deletedRun);
      const parentDeleted = Boolean(deletedParent);
      const projectUnavailable = dependencies.loadProject
        ? !(await dependencies.loadProject(run.projectId))
        : false;
      const writeOperation = operation === "save-current" || operation === "save-independent";
      const lifecycle = deriveMountedManuscriptLifecycleDecision({
        ownerType: "experimentRun",
        ownerId: runId,
        manuscriptChannel: "primary",
        ownerDeleted,
        parentDeleted,
        projectUnavailable
      });
      const allowed = writeOperation ? lifecycle.canWrite : lifecycle.canRead;
      if (!allowed) {
        return denied(
          EXPERIMENT_RUN_RAW_ERROR_CODES.permissionDenied,
          lifecycle.reasonCode === "OWNER_DELETED"
            ? "RUN_DELETED"
            : lifecycle.reasonCode === "RUN_PARENT_DELETED"
              ? "PARENT_DELETED"
              : lifecycle.reasonCode ?? "LIFECYCLE_DENIED"
        );
      }
      return {
        status: "allowed" as const,
        run,
        parent,
        ownerDeleted,
        parentDeleted,
        projectUnavailable,
        readOnly: lifecycle.readOnly,
        writable: lifecycle.canWrite
      };
    }
  });
}

export const experimentRunManuscriptPermissionService =
  createExperimentRunManuscriptPermissionService();

export type ExperimentRunManuscriptPermissionService =
  ReturnType<typeof createExperimentRunManuscriptPermissionService>;
