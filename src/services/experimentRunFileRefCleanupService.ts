import { invoke } from "@tauri-apps/api/core";
import {
  independentManuscriptOpenProtocol
} from "./independentManuscriptOpenProtocol";
import {
  experimentRunManuscriptLifecycleSessionRegistry,
  type ExperimentRunManuscriptLifecycleSessionRegistry
} from "./experimentRunManuscriptLifecycleSessionRegistry";

export const EXPERIMENT_RUN_FILE_REF_CLEANUP_ERROR_CODES = {
  blockedBySession: "RUN_FILE_REF_CLEANUP_BLOCKED_BY_SESSION",
  referenceConflict: "RUN_FILE_REF_CLEANUP_REFERENCE_CONFLICT",
  identityMismatch: "RUN_FILE_REF_CLEANUP_IDENTITY_MISMATCH",
  failed: "RUN_FILE_REF_CLEANUP_FAILED"
} as const;

export interface ExperimentRunFileRefCleanupInput {
  runId: string;
  parentExperimentId: string;
  targetFileRefIds: [string, string];
  operationId: string;
  occurredAt: string;
}

export interface ExperimentRunFileRefCleanupSuccess {
  status: "success";
  runId: string;
  parentExperimentId: string;
  deletedFileRefIds: string[];
  operationLogId: string;
  physicalFileActionCount: 0;
  parentPhysicalFilesUnchanged: true;
}

type CleanupResult = ExperimentRunFileRefCleanupSuccess | {
  status: "error";
  error: { code: string; message: string };
};

export interface ExperimentRunFileRefCleanupDependencies {
  sessionRegistry: ExperimentRunManuscriptLifecycleSessionRegistry;
  independentOpenProtocol: Pick<
    typeof independentManuscriptOpenProtocol,
    "hasPendingOwner" | "cancelOwner"
  >;
  commit(input: ExperimentRunFileRefCleanupInput): Promise<CleanupResult>;
}

const defaultDependencies: ExperimentRunFileRefCleanupDependencies = {
  sessionRegistry: experimentRunManuscriptLifecycleSessionRegistry,
  independentOpenProtocol: independentManuscriptOpenProtocol,
  commit: (input) => invoke<CleanupResult>("db_cleanup_experiment_run_file_refs", { input })
};

function blocked(message: string): CleanupResult {
  return {
    status: "error",
    error: {
      code: EXPERIMENT_RUN_FILE_REF_CLEANUP_ERROR_CODES.blockedBySession,
      message
    }
  };
}

export function createExperimentRunFileRefCleanupService(
  dependencies: ExperimentRunFileRefCleanupDependencies = defaultDependencies
) {
  return Object.freeze({
    async cleanup(input: ExperimentRunFileRefCleanupInput): Promise<CleanupResult> {
      const owner = {
        ownerType: "experimentRun",
        ownerId: input.runId,
        channel: "primary"
      } as const;
      if (dependencies.independentOpenProtocol.hasPendingOwner(owner)) {
        return blocked("A pending ExperimentRun picker registration must be resolved first.");
      }
      const sessions = input.targetFileRefIds.flatMap((id) =>
        dependencies.sessionRegistry.listFileSessions(id)
      );
      const unsafe = sessions.some((session) => {
        const state = session as typeof session & {
          loading?: boolean;
          saving?: boolean;
          reloading?: boolean;
          activeRequest?: unknown;
        };
        return state.dirty || state.loading || state.saving || state.reloading ||
          state.conflict || state.writeAppliedUnverified || state.recovery ||
          Boolean(state.activeRequest);
      });
      if (unsafe) {
        return blocked("An ExperimentRun manuscript Session is dirty, active, conflicted, or requires recovery.");
      }
      for (const session of sessions) {
        if (!session.closed && !session.disposed) dependencies.sessionRegistry.close(session.sessionKey);
        dependencies.sessionRegistry.dispose(session.sessionKey);
      }
      dependencies.independentOpenProtocol.cancelOwner(owner);
      try {
        return await dependencies.commit(input);
      } catch {
        return {
          status: "error",
          error: {
            code: EXPERIMENT_RUN_FILE_REF_CLEANUP_ERROR_CODES.failed,
            message: "ExperimentRun FileRef metadata cleanup failed."
          }
        };
      }
    }
  });
}

export const experimentRunFileRefCleanupService =
  createExperimentRunFileRefCleanupService();
