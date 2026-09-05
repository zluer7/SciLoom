import { resultMetricRepositoryConfig } from "../repositories/entityConfig";
import { createRepository } from "../repositories/repositoryFactory";
import type { EntityId } from "../types";
import type { CreateEntityInput, UpdateEntityInput } from "../types/common";
import type {
  CreateResultMetricInput,
  ResultMetric,
  UpdateResultMetricInput
} from "../types/experiment";
import { EXPERIMENT_SCHEMA_VERSION } from "../types/experiment";
import type { CustomField } from "../types/experiment";
import {
  createCrossModuleWriteFeedback,
  publishCrossModuleWriteFeedback
} from "./crossModuleWriteFeedbackService";
import { assertExperimentRunWritable } from "./experimentRunGuard";

const repository = createRepository<ResultMetric>(resultMetricRepositoryConfig);
const KEY_RESULT_CUSTOM_FIELD_NAME = "isKeyResult";

function keyResultCustomField(value: boolean): CustomField {
  return {
    id: `resultMetric:${KEY_RESULT_CUSTOM_FIELD_NAME}`,
    name: KEY_RESULT_CUSTOM_FIELD_NAME,
    value,
    valueType: "boolean",
    group: "result",
    description: "Marks this metric as a user-confirmed key result."
  };
}

export function isResultMetricKeyResult(metric: ResultMetric) {
  return (metric.customFields ?? []).some(
    (field) => field.name === KEY_RESULT_CUSTOM_FIELD_NAME && field.value === true
  );
}

export function withResultMetricKeyResult(
  customFields: CustomField[] | undefined,
  isKeyResult: boolean
) {
  return [
    ...(customFields ?? []).filter((field) => field.name !== KEY_RESULT_CUSTOM_FIELD_NAME),
    keyResultCustomField(isKeyResult)
  ];
}

function toCreateInput(input: CreateResultMetricInput): CreateEntityInput<ResultMetric> {
  return {
    runId: input.runId,
    experimentId: input.experimentId ?? null,
    name: input.name,
    value: input.value,
    unit: input.unit,
    description: input.description,
    metricGroup: input.metricGroup,
    higherIsBetter: input.higherIsBetter,
    valueType: input.valueType,
    baselineValue: input.baselineValue,
    targetValue: input.targetValue,
    orderIndex: input.orderIndex,
    tags: input.tags ?? [],
    schemaVersion: EXPERIMENT_SCHEMA_VERSION,
    source: input.source ?? "user",
    customFields: input.customFields ?? []
  };
}

function toUpdateInput(
  existing: ResultMetric,
  patch: UpdateResultMetricInput
): UpdateEntityInput<ResultMetric> {
  const normalized = {
    ...existing,
    ...patch,
    tags: patch.tags ?? existing.tags ?? [],
    schemaVersion: EXPERIMENT_SCHEMA_VERSION,
    source: patch.source ?? existing.source ?? "user",
    customFields: patch.customFields ?? existing.customFields ?? []
  };
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = normalized;
  return rest;
}

async function getMetricsByRun(runId: EntityId) {
  return (await repository.list()).filter((metric) => metric.runId === runId);
}

async function createResultMetric(input: CreateResultMetricInput) {
  const access = await assertExperimentRunWritable(input.runId);
  if (input.experimentId && input.experimentId !== access.run.experimentId) {
    throw new Error("RESULT_METRIC_EXPERIMENT_MISMATCH: ResultMetric must use its Run parent Experiment.");
  }
  const metric = await repository.create(
    toCreateInput({ ...input, experimentId: access.run.experimentId })
  );
  publishCrossModuleWriteFeedback(
    createCrossModuleWriteFeedback({
      operation: "resultMetric.createResultMetric",
      data: metric,
      primaryEntity: {
        type: "resultMetric",
        id: metric.id,
        relation: "created",
        label: metric.name
      },
      affectedEntities: [
        {
          type: "experimentRun",
          id: metric.runId,
          relation: "linked"
        },
        ...(metric.experimentId
          ? [
              {
                type: "experiment",
                id: metric.experimentId,
                relation: "linked"
              }
            ]
          : [])
      ],
      affectedScopes: [
        {
          module: "experiment",
          experimentId: metric.experimentId ?? undefined,
          reason: "ResultMetric metadata was created."
        }
      ],
      refreshKeys: ["resultMetric.changed", "experimentRun.changed", "experiment.changed", "reviewContext.changed", "aiContext.changed"]
    }),
    "resultMetric.createResultMetric"
  );
  return metric;
}

async function updateResultMetric(id: EntityId, patch: UpdateResultMetricInput) {
  const existing = await repository.getById(id);
  if (!existing) {
    publishCrossModuleWriteFeedback(
      createCrossModuleWriteFeedback({
        operation: "resultMetric.updateResultMetric",
        primaryEntity: {
          type: "resultMetric",
          id,
          relation: "skipped"
        },
        skipped: ["result_metric_not_found"],
        refreshKeys: ["resultMetric.changed", "experiment.changed", "reviewContext.changed", "aiContext.changed"]
      }),
      "resultMetric.updateResultMetric"
    );
    return undefined;
  }

  await assertExperimentRunWritable(existing.runId);
  if (patch.runId !== undefined && patch.runId !== existing.runId) {
    throw new Error("RESULT_METRIC_RUN_IMMUTABLE: ResultMetric Run cannot be changed.");
  }
  if (patch.experimentId !== undefined && patch.experimentId !== existing.experimentId) {
    throw new Error("RESULT_METRIC_EXPERIMENT_IMMUTABLE: ResultMetric Experiment cannot be changed.");
  }

  const metric = await repository.update(id, toUpdateInput(existing, patch));
  publishCrossModuleWriteFeedback(
    createCrossModuleWriteFeedback({
      operation: "resultMetric.updateResultMetric",
      data: metric,
      primaryEntity: {
        type: "resultMetric",
        id,
        relation: metric ? "updated" : "skipped",
        label: metric?.name ?? existing.name
      },
      affectedEntities: [
        {
          type: "experimentRun",
          id: (metric ?? existing).runId,
          relation: "linked"
        },
        ...((metric ?? existing).experimentId
          ? [
              {
                type: "experiment",
                id: (metric ?? existing).experimentId as EntityId,
                relation: "linked"
              }
            ]
          : [])
      ],
      affectedScopes: [
        {
          module: "experiment",
          experimentId: (metric ?? existing).experimentId ?? undefined,
          reason: "ResultMetric metadata was updated."
        }
      ],
      refreshKeys: ["resultMetric.changed", "experimentRun.changed", "experiment.changed", "reviewContext.changed", "aiContext.changed"],
      skipped: metric ? [] : ["result_metric_update_failed"]
    }),
    "resultMetric.updateResultMetric"
  );
  return metric;
}

async function setResultMetricKeyResult(id: EntityId, isKeyResult: boolean) {
  const existing = await repository.getById(id);
  if (!existing) {
    throw new Error("ResultMetric not found.");
  }
  return updateResultMetric(id, {
    customFields: withResultMetricKeyResult(existing.customFields, isKeyResult)
  });
}

async function deleteResultMetric(id: EntityId) {
  const existing = await repository.getById(id);
  if (existing) {
    await assertExperimentRunWritable(existing.runId);
  }
  const removed = await repository.softDelete(id);
  publishCrossModuleWriteFeedback(
    createCrossModuleWriteFeedback({
      operation: "resultMetric.deleteResultMetric",
      data: removed,
      primaryEntity: {
        type: "resultMetric",
        id,
        relation: removed ? "deleted" : "skipped",
        label: existing?.name
      },
      affectedEntities: existing
        ? [
            {
              type: "experimentRun",
              id: existing.runId,
              relation: "linked"
            },
            ...(existing.experimentId
              ? [
                  {
                    type: "experiment",
                    id: existing.experimentId,
                    relation: "linked"
                  }
                ]
              : [])
          ]
        : [],
      affectedScopes: [
        {
          module: "experiment",
          experimentId: existing?.experimentId ?? undefined,
          reason: "ResultMetric metadata was deleted or delete was attempted."
        }
      ],
      refreshKeys: ["resultMetric.changed", "experimentRun.changed", "experiment.changed", "reviewContext.changed", "aiContext.changed"],
      skipped: removed ? [] : ["result_metric_not_found"]
    }),
    "resultMetric.deleteResultMetric"
  );
  return removed;
}

export const resultMetricService = {
  list: repository.list,
  getById: repository.getById,
  create: createResultMetric,
  update: updateResultMetric,
  softDelete: deleteResultMetric,
  remove: deleteResultMetric,
  getMetricsByRun,
  createResultMetric,
  updateResultMetric,
  setResultMetricKeyResult,
  deleteResultMetric
};

export type ResultMetricService = typeof resultMetricService;
