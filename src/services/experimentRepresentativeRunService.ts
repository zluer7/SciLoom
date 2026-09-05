import { experimentRepresentativeRunRepository } from "../repositories/experimentRepresentativeRunRepository";
import type { OperationLogInput } from "../types/operationLog";
import type {
  ExperimentRepresentativeRunRepository,
  RepresentativeRelationOwnerType
} from "../types/representativeExperimentRun";
import { createOperationLog } from "./operationLogService";

interface ExperimentRepresentativeRunServiceDependencies {
  repository: ExperimentRepresentativeRunRepository;
  createId: () => string;
  now: () => string;
  writeOperationLog: (input: OperationLogInput) => Promise<unknown>;
}

function defaultCreateId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `experiment-representative-run-${crypto.randomUUID()}`;
  }
  return `experiment-representative-run-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function recordMeaningfulMutation(
  writeOperationLog: ExperimentRepresentativeRunServiceDependencies["writeOperationLog"],
  input: OperationLogInput
) {
  try {
    await writeOperationLog(input);
  } catch {
    // The canonical relation mutation has already committed; audit persistence is best effort.
  }
}

export function createExperimentRepresentativeRunService(
  dependencies: ExperimentRepresentativeRunServiceDependencies
) {
  const { repository, createId, now, writeOperationLog } = dependencies;

  return {
    listRepresentativeRuns(experimentId: string) {
      return repository.listRepresentativeRuns(experimentId);
    },

    getRepresentativeRunAggregate(experimentId: string) {
      return repository.getRepresentativeRunAggregate(experimentId);
    },

    async addRepresentativeRun(experimentId: string, runId: string) {
      const occurredAt = now();
      const relation = await repository.addRepresentativeRun({
        relationId: createId(),
        experimentId,
        runId,
        occurredAt
      });
      await recordMeaningfulMutation(writeOperationLog, {
        operationType: "link",
        source: "user",
        module: "experiment",
        status: "success",
        riskLevel: "low",
        target: { entityType: "experiment", entityId: experimentId },
        summary: `Representative Run added: experimentId=${experimentId}; runId=${runId}; sortOrder=${relation.sortOrder}`,
        isRecoverable: false,
        createdAt: occurredAt
      });
      return relation;
    },

    async removeRepresentativeRun(experimentId: string, runId: string) {
      const occurredAt = now();
      const relation = await repository.removeRepresentativeRun({
        experimentId,
        runId,
        occurredAt
      });
      await recordMeaningfulMutation(writeOperationLog, {
        operationType: "unlink",
        source: "user",
        module: "experiment",
        status: "success",
        riskLevel: "low",
        target: { entityType: "experiment", entityId: experimentId },
        summary: `Representative Run removed: experimentId=${experimentId}; runId=${runId}; previousSortOrder=${relation.sortOrder}`,
        isRecoverable: false,
        createdAt: occurredAt
      });
      return relation;
    },

    async setRepresentativeRunOrder(experimentId: string, orderedRunIds: string[]) {
      const occurredAt = now();
      const result = await repository.setRepresentativeRunOrder({
        experimentId,
        orderedRunIds,
        occurredAt
      });
      if (result.changed) {
        await recordMeaningfulMutation(writeOperationLog, {
          operationType: "update",
          source: "user",
          module: "experiment",
          status: "success",
          riskLevel: "low",
          target: { entityType: "experiment", entityId: experimentId },
          summary: `Representative Run order set: experimentId=${experimentId}; orderedRunIds=${orderedRunIds.join(",")}`,
          isRecoverable: false,
          createdAt: occurredAt
        });
      }
      return result;
    },

    async cleanupRepresentativeRunRelations(
      ownerType: RepresentativeRelationOwnerType,
      ownerId: string
    ) {
      const occurredAt = now();
      const result = await repository.cleanupRepresentativeRunRelations({
        ownerType,
        ownerId,
        occurredAt
      });
      if (result.removedCount > 0) {
        await recordMeaningfulMutation(writeOperationLog, {
          operationType: "unlink",
          source: "system",
          module: "experiment",
          status: "success",
          riskLevel: "low",
          target: { entityType: ownerType, entityId: ownerId },
          summary: `Representative Run metadata cleaned: ownerType=${ownerType}; ownerId=${ownerId}; removedCount=${result.removedCount}`,
          isRecoverable: false,
          createdAt: occurredAt
        });
      }
      return result;
    }
  };
}

export const experimentRepresentativeRunService = createExperimentRepresentativeRunService({
  repository: experimentRepresentativeRunRepository,
  createId: defaultCreateId,
  now: () => new Date().toISOString(),
  writeOperationLog: createOperationLog
});
