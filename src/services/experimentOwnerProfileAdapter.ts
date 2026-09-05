import type { Experiment } from "../types/experiment";
import type { ExperimentDetailContext } from "../types/experimentContext";
import type {
  ExperimentOwnerProfileDto,
  ExperimentOwnerProfileReadResult
} from "../types/experimentManuscriptAdapter";
import { experimentService } from "./experimentService";
import { getExperimentDetailContext } from "./experimentSelectorService";

export interface ExperimentOwnerProfileAdapterDependencies {
  readContext(experimentId: string): Promise<ExperimentDetailContext | null>;
  readDeleted(experimentId: string): Promise<Experiment | undefined>;
}

function immutable<T>(value: T): Readonly<T> {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      immutable(nested);
    }
  }
  return value;
}

export function createExperimentOwnerProfileAdapter(
  dependencies: ExperimentOwnerProfileAdapterDependencies = {
    readContext: getExperimentDetailContext,
    readDeleted: experimentService.getDeletedById
  }
) {
  return Object.freeze({
    async read(experimentId: string): Promise<ExperimentOwnerProfileReadResult> {
      const context = await dependencies.readContext(experimentId);
      if (!context) {
        const deleted = await dependencies.readDeleted(experimentId);
        return {
          status: "error",
          code: deleted
            ? "EXPERIMENT_OWNER_PROFILE_DELETED"
            : "EXPERIMENT_OWNER_PROFILE_NOT_FOUND"
        };
      }
      if (!context.project) {
        return {
          status: "error",
          code: "EXPERIMENT_OWNER_PROFILE_PROJECT_MISSING"
        };
      }
      const experiment = context.experiment;
      const warnings = [
        !context.route && experiment.routeId ? "route-unavailable" : "",
        !context.task && experiment.taskId ? "task-unavailable" : ""
      ].filter(Boolean);
      const profile: ExperimentOwnerProfileDto = {
        ownerType: "experiment",
        id: experiment.id,
        title: experiment.title,
        project: { id: context.project.id, title: context.project.title },
        route: context.route
          ? { id: context.route.id, title: context.route.title }
          : null,
        task: context.task
          ? { id: context.task.id, title: context.task.title }
          : null,
        status: experiment.status,
        rating: experiment.rating ?? null,
        tags: [...experiment.tags],
        usableForPaper: experiment.usableForPaper,
        usableForReport: experiment.usableForReport,
        usableForPatent: experiment.usableForPatent,
        conditionItems: structuredClone(experiment.conditionItems),
        methodSteps: structuredClone(experiment.methodSteps),
        variables: structuredClone(experiment.variables),
        materials: structuredClone(experiment.materials),
        provenance: {
          source: "database-selector",
          ownerUpdatedAt: experiment.updatedAt,
          relationshipSource: "planning-selector"
        },
        warnings
      };
      return { status: "success", profile: immutable(profile) };
    }
  });
}

export const experimentOwnerProfileAdapter =
  createExperimentOwnerProfileAdapter();
