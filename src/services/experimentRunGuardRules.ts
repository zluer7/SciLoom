export const EXPERIMENT_RUN_GUARD_ERROR_CODES = {
  notFound: "EXPERIMENT_RUN_NOT_FOUND",
  deleted: "EXPERIMENT_RUN_DELETED",
  parentNotFound: "EXPERIMENT_RUN_PARENT_NOT_FOUND",
  parentDeleted: "EXPERIMENT_RUN_PARENT_DELETED",
  projectMismatch: "EXPERIMENT_RUN_PROJECT_MISMATCH"
} as const;

export type ExperimentRunGuardErrorCode =
  (typeof EXPERIMENT_RUN_GUARD_ERROR_CODES)[keyof typeof EXPERIMENT_RUN_GUARD_ERROR_CODES];

export class ExperimentRunGuardError extends Error {
  readonly code: ExperimentRunGuardErrorCode;

  constructor(code: ExperimentRunGuardErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "ExperimentRunGuardError";
    this.code = code;
  }
}

interface GuardRunRecord {
  id: string;
  experimentId: string;
  projectId: string;
}

interface GuardParentRecord {
  id: string;
  projectId: string;
}

export interface ExperimentRunAccess<
  Run extends GuardRunRecord = GuardRunRecord,
  Parent extends GuardParentRecord = GuardParentRecord
> {
  run: Run;
  parent: Parent;
  readOnly: boolean;
  ownerDeleted: boolean;
  parentDeleted: boolean;
  reason?: ExperimentRunGuardErrorCode;
}

interface ExperimentRunGuardLoaders<
  Run extends GuardRunRecord,
  Parent extends GuardParentRecord
> {
  loadRun(id: string): Promise<Run | undefined>;
  loadDeletedRun(id: string): Promise<Run | undefined>;
  loadParent(id: string): Promise<Parent | undefined>;
  loadDeletedParent(id: string): Promise<Parent | undefined>;
}

function guardError(code: ExperimentRunGuardErrorCode, message: string) {
  return new ExperimentRunGuardError(code, message);
}

export function createExperimentRunGuard<
  Run extends GuardRunRecord,
  Parent extends GuardParentRecord
>(loaders: ExperimentRunGuardLoaders<Run, Parent>) {
  async function getControlledAccess(runId: string): Promise<ExperimentRunAccess<Run, Parent>> {
    const activeRun = await loaders.loadRun(runId);
    const deletedRun = activeRun ? undefined : await loaders.loadDeletedRun(runId);
    const run = activeRun ?? deletedRun;
    if (!run) {
      throw guardError(
        EXPERIMENT_RUN_GUARD_ERROR_CODES.notFound,
        "ExperimentRun metadata does not exist."
      );
    }

    const activeParent = await loaders.loadParent(run.experimentId);
    const deletedParent = activeParent
      ? undefined
      : await loaders.loadDeletedParent(run.experimentId);
    const parent = activeParent ?? deletedParent;
    if (!parent) {
      throw guardError(
        EXPERIMENT_RUN_GUARD_ERROR_CODES.parentNotFound,
        "Parent Experiment metadata does not exist."
      );
    }
    if (parent.projectId !== run.projectId) {
      throw guardError(
        EXPERIMENT_RUN_GUARD_ERROR_CODES.projectMismatch,
        "ExperimentRun Project does not match its parent Experiment."
      );
    }
    if (deletedParent) {
      return {
        run,
        parent,
        readOnly: true,
        ownerDeleted: Boolean(deletedRun),
        parentDeleted: true,
        reason: deletedRun
          ? EXPERIMENT_RUN_GUARD_ERROR_CODES.deleted
          : EXPERIMENT_RUN_GUARD_ERROR_CODES.parentDeleted
      };
    }
    if (deletedRun) {
      return {
        run,
        parent,
        readOnly: true,
        ownerDeleted: true,
        parentDeleted: false,
        reason: EXPERIMENT_RUN_GUARD_ERROR_CODES.deleted
      };
    }
    return {
      run,
      parent,
      readOnly: false,
      ownerDeleted: false,
      parentDeleted: false
    };
  }

  async function assertWritable(runId: string): Promise<ExperimentRunAccess<Run, Parent>> {
    const access = await getControlledAccess(runId);
    if (access.readOnly) {
      throw guardError(
        access.reason ?? EXPERIMENT_RUN_GUARD_ERROR_CODES.parentDeleted,
        access.ownerDeleted
          ? "ExperimentRun metadata is deleted."
          : "Parent Experiment is deleted; ExperimentRun metadata is read-only."
      );
    }
    return access;
  }

  return { getControlledAccess, assertWritable };
}
