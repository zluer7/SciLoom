import {
  experimentRepositoryConfig
} from "../repositories/entityConfig";
import { createRepository } from "../repositories/repositoryFactory";
import { createRepositoryEntityId } from "../repositories/entityId";
import type { EntityId } from "../types";
import type { CreateEntityInput, UpdateEntityInput } from "../types/common";
import type { EntitySource } from "../types/planning";
import type {
  ConditionItem,
  CreateExperimentInput,
  CustomField,
  CustomFieldValue,
  CustomFieldValueType,
  Experiment,
  ExperimentRating,
  ExperimentStatus,
  FaultType,
  MethodStep,
  ResearchMaterial,
  ResearchVariable,
  UpdateExperimentInput
} from "../types/experiment";
import { EXPERIMENT_SCHEMA_VERSION } from "../types/experiment";
import {
  createCrossModuleWriteFeedback,
  publishCrossModuleWriteFeedback
} from "./crossModuleWriteFeedbackService";
import {
  assertCreatedLocalTimeNotPatched,
  assertCreatedLocalTimeRecord,
  captureCreatedLocalTime,
  type CreatedLocalTimeClock,
  type CreatedLocalTimeFacts
} from "./experimentCreatedLocalTime";
import { assertExperimentPlanningRelations } from "./experimentPlanningRelationService";
import {
  assertFrozenWorkspaceTitleIdentity,
  freezeWorkspaceTitleIdentity
} from "./experimentWorkspacePathService";
import { softDeleteExperimentMetadata } from "./experimentRunLifecycleService";
import {
  ensureExperimentManuscriptProvisioned,
  preflightExperimentManuscriptProvisioningCandidate
} from "./experimentManuscriptProvisioningService";
import type {
  ExperimentManuscriptProvisioningIssue,
  ExperimentManuscriptProvisioningPreflightResult,
  ExperimentManuscriptProvisioningResult
} from "../types/experimentProvisioning";
import type { ExperimentWorkspacePathDescriptor } from "../types/experimentWorkspacePath";

type LegacyExperimentRecord = Partial<Experiment> & Record<string, unknown>;

const repository = createRepository<Experiment>(experimentRepositoryConfig);
const FORMAL_EXPERIMENT_CUSTOM_FIELD_NAMES = new Set(["generalNotes"]);

export class ExperimentManuscriptProvisioningIncompleteError extends Error {
  readonly experiment: Experiment;
  readonly provisioningResult: ExperimentManuscriptProvisioningResult;

  constructor(experiment: Experiment, provisioningResult: ExperimentManuscriptProvisioningResult) {
    super(
      provisioningResult.errors[0]?.message ??
        "Experiment was created, but its canonical manuscript provisioning is incomplete."
    );
    this.name = "ExperimentManuscriptProvisioningIncompleteError";
    this.experiment = experiment;
    this.provisioningResult = provisioningResult;
  }
}

export class ExperimentManuscriptProvisioningPreflightError extends Error {
  readonly issue: ExperimentManuscriptProvisioningIssue;

  constructor(issue: ExperimentManuscriptProvisioningIssue) {
    super(issue.summary);
    this.name = "ExperimentManuscriptProvisioningPreflightError";
    this.issue = issue;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toStringValue(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

export function toNullableString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function toNumberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toBooleanValue(value: unknown, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

function toTags(value: unknown) {
  return Array.isArray(value) ? value.filter((tag): tag is string => typeof tag === "string") : [];
}

function isEntitySource(value: unknown): value is EntitySource {
  return value === "user" || value === "ai" || value === "imported" || value === "system";
}

function isExperimentStatus(value: unknown): value is ExperimentStatus {
  return (
    value === "planned" ||
    value === "running" ||
    value === "completed" ||
    value === "paused" ||
    value === "failed" ||
    value === "archived"
  );
}

function isExperimentRating(value: unknown): value is ExperimentRating {
  return (
    value === "excellent" ||
    value === "good" ||
    value === "usable" ||
    value === "inconclusive" ||
    value === "failed"
  );
}

function isFaultType(value: unknown): value is FaultType {
  return (
    value === "healthy" ||
    value === "unbalance" ||
    value === "misalignment" ||
    value === "bearing_fault" ||
    value === "unknown"
  );
}

function customFieldValue(value: unknown): CustomFieldValue {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === "string")) {
      return value;
    }
    if (value.every((item) => typeof item === "number")) {
      return value;
    }
    return { items: value };
  }

  if (isRecord(value)) {
    return value;
  }

  return String(value);
}

function customFieldValueType(value: unknown): CustomFieldValueType {
  if (typeof value === "number") {
    return "number";
  }
  if (typeof value === "boolean") {
    return "boolean";
  }
  if (Array.isArray(value)) {
    return "multi_select";
  }
  if (isRecord(value)) {
    return "json";
  }
  return "text";
}

function normalizeCustomFields(value: unknown): CustomField[] {
  if (Array.isArray(value)) {
    return value
      .filter(isRecord)
      .filter((field) => !FORMAL_EXPERIMENT_CUSTOM_FIELD_NAMES.has(toStringValue(field.name)))
      .map((field, index) => ({
        id: toStringValue(field.id, `custom-field-${index}`),
        name: toStringValue(field.name, `field_${index + 1}`),
        value: customFieldValue(field.value),
        valueType: toStringValue(field.valueType) as CustomFieldValueType | undefined,
        unit: toNullableString(field.unit),
        group: toNullableString(field.group),
        description: toNullableString(field.description)
      }));
  }

  if (!isRecord(value)) {
    return [];
  }

  return Object.entries(value)
    .filter(([key]) => !FORMAL_EXPERIMENT_CUSTOM_FIELD_NAMES.has(key))
    .map(([key, fieldValue]) => ({
      id: `legacy-custom-${key}`,
      name: key,
      value: customFieldValue(fieldValue),
      valueType: customFieldValueType(fieldValue),
      group: "legacy"
    }));
}

function makeConditionItem(
  id: string,
  name: string,
  value: string | number | boolean,
  unit?: string,
  role: ConditionItem["role"] = "other"
): ConditionItem {
  return { id, name, value, unit, role };
}

function normalizeConditionItems(record: LegacyExperimentRecord): ConditionItem[] {
  const existing = Array.isArray(record.conditionItems)
    ? record.conditionItems
        .filter(isRecord)
        .map((item, index) => ({
          id: toStringValue(item.id, `condition-${index}`),
          name: toStringValue(item.name, `condition_${index + 1}`),
          value:
            typeof item.value === "string" ||
            typeof item.value === "number" ||
            typeof item.value === "boolean"
              ? item.value
              : "",
          unit: toNullableString(item.unit),
          role: item.role as ConditionItem["role"],
          description: toNullableString(item.description)
        }))
        .filter((item) => !(
          item.id === "legacy-fault-type" &&
          item.name === "faultType" &&
          item.value === "unknown"
        ))
    : [];

  const generated = [
    toStringValue(record.machineObject)
      ? makeConditionItem(
          "legacy-machine-object",
          "machineObject",
          toStringValue(record.machineObject),
          undefined,
          "sample"
        )
      : undefined,
    isFaultType(record.faultType) && record.faultType !== "unknown"
      ? makeConditionItem("legacy-fault-type", "faultType", record.faultType, undefined, "sample")
      : undefined,
    toNumberValue(record.speed) !== undefined
      ? makeConditionItem(
          "legacy-speed",
          "speed",
          toNumberValue(record.speed) as number,
          "rpm",
          "independent_variable"
        )
      : undefined,
    toNumberValue(record.load) !== undefined
      ? makeConditionItem(
          "legacy-load",
          "load",
          toNumberValue(record.load) as number,
          undefined,
          "control_variable"
        )
      : undefined,
    toNumberValue(record.samplingRate) !== undefined
      ? makeConditionItem(
          "legacy-sampling-rate",
          "samplingRate",
          toNumberValue(record.samplingRate) as number,
          "Hz",
          "parameter"
        )
      : undefined,
    toNumberValue(record.duration) !== undefined
      ? makeConditionItem(
          "legacy-duration",
          "duration",
          toNumberValue(record.duration) as number,
          "s",
          "parameter"
        )
      : undefined
  ].filter((item): item is ConditionItem => Boolean(item));

  const existingNames = new Set(existing.map((item) => item.name));
  return [...existing, ...generated.filter((item) => !existingNames.has(item.name))];
}

function normalizeMethodSteps(value: unknown): MethodStep[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isRecord).map((step, index) => ({
    id: toStringValue(step.id, `method-step-${index}`),
    order: toNumberValue(step.order) ?? index + 1,
    title: toStringValue(step.title, `Step ${index + 1}`),
    description: toNullableString(step.description),
    toolOrMethod: toNullableString(step.toolOrMethod),
    parameters: isRecord(step.parameters) ? step.parameters : undefined
  }));
}

function normalizeVariables(value: unknown): ResearchVariable[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isRecord).map((variable, index) => ({
    id: toStringValue(variable.id, `variable-${index}`),
    name: toStringValue(variable.name, `variable_${index + 1}`),
    value:
      typeof variable.value === "string" ||
      typeof variable.value === "number" ||
      typeof variable.value === "boolean"
        ? variable.value
        : undefined,
    unit: toNullableString(variable.unit),
    role: variable.role as ResearchVariable["role"],
    description: toNullableString(variable.description)
  }));
}

function normalizeMaterials(value: unknown): ResearchMaterial[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isRecord).map((material, index) => ({
    id: toStringValue(material.id, `material-${index}`),
    name: toStringValue(material.name, `material_${index + 1}`),
    materialType: toNullableString(material.materialType),
    amount:
      typeof material.amount === "string" || typeof material.amount === "number"
        ? material.amount
        : undefined,
    unit: toNullableString(material.unit),
    description: toNullableString(material.description)
  }));
}

function collectLegacyFields(record: LegacyExperimentRecord) {
  return isRecord(record.legacy) ? { ...record.legacy } : undefined;
}

export function normalizeExperimentRecord(record: LegacyExperimentRecord): Experiment {
  assertCreatedLocalTimeRecord(record, "Experiment");
  const timestamp = new Date().toISOString();
  const title = toStringValue(
    record.title,
    toStringValue(record.experimentName, "Untitled Experiment")
  );
  const resultSummary = toStringValue(record.resultSummary);
  const sensorConfig = toStringValue(record.sensorConfig);
  const dataPath = toStringValue(record.dataPath);
  const conditionItems = normalizeConditionItems(record);

  return {
    id: toStringValue(record.id, `experiment-${Date.now()}`),
    createdAt: toStringValue(record.createdAt, timestamp),
    createdLocalDate: record.createdLocalDate,
    createdLocalTime: record.createdLocalTime,
    workspaceTitleIdentity: assertFrozenWorkspaceTitleIdentity(
      record.workspaceTitleIdentity,
      "experiment"
    ),
    updatedAt: toStringValue(record.updatedAt, timestamp),
    deletedAt:
      record.deletedAt === null || typeof record.deletedAt === "string"
        ? record.deletedAt
        : null,
    schemaVersion: EXPERIMENT_SCHEMA_VERSION,
    source: isEntitySource(record.source) ? record.source : "user",
    tags: toTags(record.tags),
    projectId: toStringValue(record.projectId),
    routeId: toNullableString(record.routeId) ?? null,
    taskId: toNullableString(record.taskId) ?? null,
    title,
    purposeAndQuestion: toNullableString(record.purposeAndQuestion),
    conditionSummary: toNullableString(record.conditionSummary),
    methodSummary: toNullableString(record.methodSummary),
    resultSummary,
    conclusionAndNextSteps: toNullableString(record.conclusionAndNextSteps),
    other: toNullableString(record.other),
    status: isExperimentStatus(record.status) ? record.status : "planned",
    rating: isExperimentRating(record.rating) ? record.rating : undefined,
    usableForPaper: toBooleanValue(record.usableForPaper),
    usableForReport: toBooleanValue(record.usableForReport),
    usableForPatent: toBooleanValue(record.usableForPatent),
    conditionItems,
    methodSteps: normalizeMethodSteps(record.methodSteps),
    variables: normalizeVariables(record.variables),
    materials: normalizeMaterials(record.materials),
    customFields: normalizeCustomFields(record.customFields),
    legacy: collectLegacyFields(record),
    migratedFromLegacy: toBooleanValue(record.migratedFromLegacy),
    experimentName: toStringValue(record.experimentName, title),
    machineObject: toStringValue(record.machineObject),
    faultType: isFaultType(record.faultType) ? record.faultType : "unknown",
    speed: toNumberValue(record.speed),
    load: toNumberValue(record.load),
    sensorConfig,
    dataPath,
    samplingRate: toNumberValue(record.samplingRate),
    duration: toNumberValue(record.duration),
    problemNotes: toNullableString(record.problemNotes),
    nextAction: toNullableString(record.nextAction)
  };
}

export function migrateLegacyExperimentRecord(record: LegacyExperimentRecord): Experiment {
  return normalizeExperimentRecord({
    ...record,
    migratedFromLegacy: true
  });
}

function toCreateInput(
  input: CreateExperimentInput & CreatedLocalTimeFacts & Pick<Experiment, "workspaceTitleIdentity">
): CreateEntityInput<Experiment> {
  const normalized = normalizeExperimentRecord(input);
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, deletedAt: _deletedAt, ...rest } =
    normalized;
  return rest;
}

function toUpdateInput(
  existing: Experiment,
  patch: UpdateExperimentInput
): UpdateEntityInput<Experiment> {
  const normalized = normalizeExperimentRecord({
    ...existing,
    ...patch,
    id: existing.id,
    createdAt: existing.createdAt
  });
  const {
    id: _id,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    createdLocalDate: _createdLocalDate,
    createdLocalTime: _createdLocalTime,
    workspaceTitleIdentity: _workspaceTitleIdentity,
    ...rest
  } = normalized;
  return rest;
}

async function getExperiments() {
  return (await repository.list()).map((experiment) => normalizeExperimentRecord(experiment));
}

async function getExperimentById(id: EntityId) {
  const experiment = await repository.getById(id);
  return experiment ? normalizeExperimentRecord(experiment) : undefined;
}

async function getDeletedExperimentById(id: EntityId) {
  const experiment = await repository.getDeletedById(id);
  return experiment ? normalizeExperimentRecord(experiment) : undefined;
}

export interface ExperimentCreationProvisioningDependencies {
  preflight(
    experiment: Experiment
  ): Promise<ExperimentManuscriptProvisioningPreflightResult>;
  persist(
    input: CreateEntityInput<Experiment>,
    options: { createdAt: string; id: EntityId }
  ): Promise<Experiment>;
  provision(
    experimentId: EntityId,
    descriptor: ExperimentWorkspacePathDescriptor
  ): Promise<ExperimentManuscriptProvisioningResult>;
}

const defaultExperimentCreationProvisioningDependencies: ExperimentCreationProvisioningDependencies = {
  preflight: (experiment) => preflightExperimentManuscriptProvisioningCandidate(experiment),
  persist: (input, options) => repository.create(input, options),
  provision: (experimentId, descriptor) =>
    ensureExperimentManuscriptProvisioned(experimentId, descriptor)
};

export async function persistExperimentAfterProvisioningPreflight(
  candidate: Experiment,
  input: CreateEntityInput<Experiment>,
  dependencies: ExperimentCreationProvisioningDependencies =
    defaultExperimentCreationProvisioningDependencies
) {
  const preflight = await dependencies.preflight(candidate);
  if (preflight.status === "blocked") {
    throw new ExperimentManuscriptProvisioningPreflightError(preflight.issue);
  }
  const created = await dependencies.persist(input, {
    createdAt: candidate.createdAt,
    id: candidate.id
  });
  const experiment = normalizeExperimentRecord(created);
  const provisioningResult = await dependencies.provision(
    experiment.id,
    preflight.descriptor
  );
  if (provisioningResult.completionState !== "complete") {
    throw new ExperimentManuscriptProvisioningIncompleteError(experiment, provisioningResult);
  }
  return experiment;
}

async function createExperiment(input: CreateExperimentInput, clock: CreatedLocalTimeClock = {}) {
  const creationTime = captureCreatedLocalTime(clock);
  const creationTitle = input.title ?? input.experimentName ?? "Untitled Experiment";
  const creationInput = {
    ...input,
    ...creationTime,
    workspaceTitleIdentity: freezeWorkspaceTitleIdentity(creationTitle, "experiment")
  };
  await assertExperimentPlanningRelations(normalizeExperimentRecord(creationInput));
  const provisionalId = createRepositoryEntityId(experimentRepositoryConfig.idPrefix);
  const candidate = normalizeExperimentRecord({
    ...creationInput,
    id: provisionalId,
    createdAt: creationTime.createdAt,
    updatedAt: creationTime.createdAt,
    deletedAt: null
  });
  const experiment = await persistExperimentAfterProvisioningPreflight(
    candidate,
    toCreateInput(creationInput)
  );
  publishCrossModuleWriteFeedback(
    createCrossModuleWriteFeedback({
      operation: "experiment.createExperiment",
      data: experiment,
      primaryEntity: {
        type: "experiment",
        id: experiment.id,
        relation: "created",
        label: experiment.title
      },
      affectedEntities: [
        {
          type: "project",
          id: experiment.projectId,
          relation: "linked"
        },
        ...(experiment.taskId
          ? [
              {
                type: "task",
                id: experiment.taskId,
                relation: "linked"
              }
            ]
          : [])
      ],
      affectedScopes: [
        {
          module: "experiment",
          projectId: experiment.projectId,
          taskId: experiment.taskId ?? undefined,
          experimentId: experiment.id,
          reason: "Experiment metadata and its canonical manuscript workspace were created."
        }
      ],
      refreshKeys: ["experiment.changed", "project.changed", "reviewContext.changed", "aiContext.changed"]
    }),
    "experiment.createExperiment"
  );
  return experiment;
}

async function updateExperiment(id: EntityId, patch: UpdateExperimentInput) {
  assertCreatedLocalTimeNotPatched(
    patch as UpdateExperimentInput & Record<string, unknown>,
    "Experiment"
  );
  const existing = await getExperimentById(id);
  if (!existing) {
    publishCrossModuleWriteFeedback(
      createCrossModuleWriteFeedback({
        operation: "experiment.updateExperiment",
        primaryEntity: {
          type: "experiment",
          id,
          relation: "skipped"
        },
        skipped: ["experiment_not_found"],
        refreshKeys: ["experiment.changed", "reviewContext.changed", "aiContext.changed"]
      }),
      "experiment.updateExperiment"
    );
    return undefined;
  }

  const nextExperiment = normalizeExperimentRecord({
    ...existing,
    ...patch,
    id: existing.id,
    createdAt: existing.createdAt
  });
  await assertExperimentPlanningRelations(nextExperiment, existing);

  const updated = await repository.update(id, toUpdateInput(existing, patch));
  const experiment = updated ? normalizeExperimentRecord(updated) : undefined;
  publishCrossModuleWriteFeedback(
    createCrossModuleWriteFeedback({
      operation: "experiment.updateExperiment",
      data: experiment,
      primaryEntity: {
        type: "experiment",
        id,
        relation: experiment ? "updated" : "skipped",
        label: experiment?.title ?? existing.title
      },
      affectedEntities: [
        {
          type: "project",
          id: (experiment ?? existing).projectId,
          relation: "linked"
        },
        ...((experiment ?? existing).taskId
          ? [
              {
                type: "task",
                id: (experiment ?? existing).taskId as EntityId,
                relation: "linked"
              }
            ]
          : [])
      ],
      affectedScopes: [
        {
          module: "experiment",
          projectId: (experiment ?? existing).projectId,
          taskId: (experiment ?? existing).taskId ?? undefined,
          experimentId: id,
          reason: "Experiment metadata was updated."
        }
      ],
      refreshKeys: ["experiment.changed", "project.changed", "reviewContext.changed", "aiContext.changed"],
      skipped: experiment ? [] : ["experiment_update_failed"]
    }),
    "experiment.updateExperiment"
  );
  return experiment;
}

async function deleteExperiment(id: EntityId) {
  const result = await softDeleteExperimentMetadata(id);
  if (result.status === "error") throw new Error(result.error.code);
  return result.changed;
}

export const experimentService = {
  list: getExperiments,
  getById: getExperimentById,
  getDeletedById: getDeletedExperimentById,
  create: createExperiment,
  update: updateExperiment,
  softDelete: deleteExperiment,
  remove: deleteExperiment,
  getExperiments,
  listExperiments: getExperiments,
  getExperimentById,
  getDeletedExperimentById,
  createExperiment,
  updateExperiment,
  deleteExperiment,
  getExperimentsByProject: async (projectId: EntityId) =>
    (await getExperiments()).filter((experiment) => experiment.projectId === projectId),
  getExperimentsByTask: async (taskId: EntityId) =>
    (await getExperiments()).filter((experiment) => experiment.taskId === taskId),
  getExperimentsByRoute: async (routeId: EntityId) =>
    (await getExperiments()).filter((experiment) => experiment.routeId === routeId),
  getExperimentsByStatus: async (status: ExperimentStatus) =>
    (await getExperiments()).filter((experiment) => experiment.status === status),
  getExperimentsByTag: async (tag: string) =>
    (await getExperiments()).filter((experiment) => experiment.tags.includes(tag)),
  getExperimentsByRating: async (rating: ExperimentRating) =>
    (await getExperiments()).filter((experiment) => experiment.rating === rating),
};

export type ExperimentService = typeof experimentService;
