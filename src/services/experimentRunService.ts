import { experimentRunRepositoryConfig } from "../repositories/entityConfig";
import { createRepository } from "../repositories/repositoryFactory";
import type { EntityId } from "../types";
import type { CreateEntityInput, UpdateEntityInput } from "../types/common";
import type {
  CreateExperimentRunInput,
  ExperimentRun,
  ExperimentRunStatus,
  UpdateExperimentRunInput
} from "../types/experiment";
import { EXPERIMENT_SCHEMA_VERSION } from "../types/experiment";
import type {
  ExperimentRunManuscriptProvisioningResult
} from "../types/experimentRunProvisioning";
import {
  createCrossModuleWriteFeedback,
  publishCrossModuleWriteFeedback
} from "./crossModuleWriteFeedbackService";
import {
  assertCreatedLocalTimeNotPatched,
  captureCreatedLocalTime,
  type CreatedLocalTimeClock,
  type CreatedLocalTimeFacts
} from "./experimentCreatedLocalTime";
import { experimentService, toNullableString } from "./experimentService";
import {
  freezeWorkspaceTitleIdentity
} from "./experimentWorkspacePathService";
import {
  assertExperimentRunCreateIdentity,
  assertExperimentRunUpdateIdentity,
  resolveExperimentRunCreateRelations,
  resolveExperimentRunUpdateRelations
} from "./experimentRunBusinessRules";
import {
  assertExperimentRunWritable,
  getControlledExperimentRunAccess
} from "./experimentRunGuard";
import { ensureExperimentRunManuscriptProvisioned } from "./experimentRunManuscriptProvisioningService";
import { softDeleteExperimentRunMetadata } from "./experimentRunLifecycleService";
import { assertExperimentPlanningRelations } from "./experimentPlanningRelationService";

const repository = createRepository<ExperimentRun>(experimentRunRepositoryConfig);
export const EXPERIMENT_RUN_CREATE_PROVISIONING_ERROR_CODE =
  "EXPERIMENT_RUN_CREATE_MANUSCRIPT_PROVISIONING_INCOMPLETE" as const;

export class ExperimentRunManuscriptProvisioningIncompleteError extends Error {
  readonly code = EXPERIMENT_RUN_CREATE_PROVISIONING_ERROR_CODE;
  readonly run: ExperimentRun;
  readonly provisioningResult?: ExperimentRunManuscriptProvisioningResult;

  constructor(
    run: ExperimentRun,
    provisioningResult?: ExperimentRunManuscriptProvisioningResult,
    cause?: unknown
  ) {
    super(
      provisioningResult?.errors[0]?.message ??
        (cause instanceof Error ? cause.message : undefined) ??
        "ExperimentRun was created, but its canonical manuscript provisioning is incomplete."
    );
    this.name = "ExperimentRunManuscriptProvisioningIncompleteError";
    this.run = run;
    this.provisioningResult = provisioningResult;
  }
}

export const EXPERIMENT_RUN_UPDATE_CONFLICT_ERROR_CODE =
  "EXPERIMENT_RUN_UPDATE_CONFLICT" as const;

export class ExperimentRunUpdateConflictError extends Error {
  readonly code = EXPERIMENT_RUN_UPDATE_CONFLICT_ERROR_CODE;
  readonly expectedUpdatedAt: string;

  constructor(readonly runId: EntityId, expectedUpdatedAt: string) {
    super("ExperimentRun changed after the reviewed state; reload and review before updating.");
    this.name = "ExperimentRunUpdateConflictError";
    this.expectedUpdatedAt = expectedUpdatedAt;
  }
}

export type ExperimentRunUpdateGuard = {
  expectedUpdatedAt?: string;
};

export interface ExperimentRunCreationProvisioningDependencies {
  persist(
    input: CreateEntityInput<ExperimentRun>,
    options: { createdAt: string }
  ): Promise<ExperimentRun>;
  provision(runId: EntityId): Promise<ExperimentRunManuscriptProvisioningResult>;
}

const defaultExperimentRunCreationProvisioningDependencies:
  ExperimentRunCreationProvisioningDependencies = {
  persist: (input, options) => repository.create(input, options),
  provision: (runId) => ensureExperimentRunManuscriptProvisioned(runId)
};

function experimentRunCreateTimeProvisioningReadinessError(
  run: ExperimentRun,
  result: ExperimentRunManuscriptProvisioningResult
) {
  if (result.completionState !== "complete") {
    return result.errors[0]?.message ?? "ExperimentRun manuscript provisioning is incomplete.";
  }
  if (
    result.ownerType !== "experimentRun" ||
    result.ownerId !== run.id ||
    result.channel !== "primary"
  ) {
    return "ExperimentRun manuscript provisioning owner identity is inconsistent.";
  }
  if (
    !result.workspacePathIdentity ||
    !result.defaultFilePath ||
    !result.defaultFolderFileRefId ||
    !result.defaultManuscriptFileRefId ||
    !result.bindingId ||
    !result.defaultFileRefId ||
    !result.currentFileRefId ||
    !result.physicalDirectoryState ||
    !result.physicalFileState
  ) {
    return "ExperimentRun manuscript provisioning readback is incomplete.";
  }
  if (
    result.defaultFileRefId !== result.defaultManuscriptFileRefId ||
    result.currentFileRefId !== result.defaultManuscriptFileRefId
  ) {
    return "ExperimentRun primary, default, and current manuscript identities must match at creation.";
  }
  if (!result.writable || result.readOnly || result.deleted || result.errors.length > 0) {
    return "ExperimentRun manuscript provisioning did not produce a writable ready identity.";
  }
  return undefined;
}

export async function persistExperimentRunWithCreateTimeProvisioning(
  input: CreateEntityInput<ExperimentRun>,
  options: { createdAt: string },
  dependencies: ExperimentRunCreationProvisioningDependencies =
    defaultExperimentRunCreationProvisioningDependencies
) {
  const run = await dependencies.persist(input, options);
  let provisioningResult: ExperimentRunManuscriptProvisioningResult;
  try {
    provisioningResult = await dependencies.provision(run.id);
  } catch (error) {
    throw new ExperimentRunManuscriptProvisioningIncompleteError(run, undefined, error);
  }
  const readinessError = experimentRunCreateTimeProvisioningReadinessError(
    run,
    provisioningResult
  );
  if (readinessError) {
    throw new ExperimentRunManuscriptProvisioningIncompleteError(
      run,
      provisioningResult,
      new Error(readinessError)
    );
  }
  return { run, provisioningResult } as const;
}

const FORMAL_RUN_CUSTOM_FIELD_NAMES = new Set([
  "summaryOther",
  "variableParameterSummary",
  "runVariableParameterSummary",
  "runSummaryOther"
]);

type RuntimeExperimentRunUpdateInput = UpdateExperimentRunInput & Record<string, unknown>;

function sanitizeRunCustomFields(value: CreateExperimentRunInput["customFields"] | undefined) {
  return (Array.isArray(value) ? value : []).filter(
    (field) => !FORMAL_RUN_CUSTOM_FIELD_NAMES.has(field.name)
  );
}

type RunOutlineTextField =
  | "conditionSummary"
  | "variableParameterSummary"
  | "methodSummary"
  | "resultSummary"
  | "conclusion"
  | "summaryOther";

function normalizeUpdatedOutlineText(
  patch: UpdateExperimentRunInput,
  existing: ExperimentRun,
  field: RunOutlineTextField
) {
  return Object.prototype.hasOwnProperty.call(patch, field)
    ? toNullableString(patch[field])
    : existing[field];
}

function toTags(value: CreateExperimentRunInput["tags"] | undefined) {
  return Array.isArray(value) ? value : [];
}

function toCreateInput(
  input: CreateExperimentRunInput & CreatedLocalTimeFacts & {
    projectId: EntityId;
    workspaceTitleIdentity: string;
  }
): CreateEntityInput<ExperimentRun> {
  return {
    experimentId: input.experimentId,
    projectId: input.projectId,
    routeId: input.routeId ?? null,
    taskId: input.taskId ?? null,
    createdLocalDate: input.createdLocalDate,
    createdLocalTime: input.createdLocalTime,
    workspaceTitleIdentity: input.workspaceTitleIdentity,
    title: input.title ?? input.runLabel ?? "Untitled run",
    runLabel: input.runLabel,
    status: input.status ?? "planned",
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    conditionSummary: toNullableString(input.conditionSummary),
    variableParameterSummary: toNullableString(input.variableParameterSummary),
    methodSummary: toNullableString(input.methodSummary),
    resultSummary: toNullableString(input.resultSummary),
    conclusion: toNullableString(input.conclusion),
    summaryOther: toNullableString(input.summaryOther),
    rating: input.rating,
    tags: toTags(input.tags),
    schemaVersion: EXPERIMENT_SCHEMA_VERSION,
    source: input.source ?? "user",
    conditionItems: input.conditionItems ?? [],
    methodSteps: input.methodSteps ?? [],
    variables: input.variables ?? [],
    materials: input.materials ?? [],
    customFields: sanitizeRunCustomFields(input.customFields),
    legacy: input.legacy
  };
}

function toUpdateInput(
  existing: ExperimentRun,
  patch: UpdateExperimentRunInput
): UpdateEntityInput<ExperimentRun> {
  const normalized = {
    ...existing,
    ...patch,
    tags: patch.tags ?? existing.tags ?? [],
    schemaVersion: EXPERIMENT_SCHEMA_VERSION,
    source: patch.source ?? existing.source ?? "user",
    conditionItems: patch.conditionItems ?? existing.conditionItems ?? [],
    methodSteps: patch.methodSteps ?? existing.methodSteps ?? [],
    variables: patch.variables ?? existing.variables ?? [],
    materials: patch.materials ?? existing.materials ?? [],
    customFields: sanitizeRunCustomFields(patch.customFields ?? existing.customFields),
    conditionSummary: normalizeUpdatedOutlineText(patch, existing, "conditionSummary"),
    variableParameterSummary: normalizeUpdatedOutlineText(
      patch,
      existing,
      "variableParameterSummary"
    ),
    methodSummary: normalizeUpdatedOutlineText(patch, existing, "methodSummary"),
    resultSummary: normalizeUpdatedOutlineText(patch, existing, "resultSummary"),
    conclusion: normalizeUpdatedOutlineText(patch, existing, "conclusion"),
    summaryOther: normalizeUpdatedOutlineText(patch, existing, "summaryOther")
  };
  const {
    id: _id,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    experimentId: _experimentId,
    projectId: _projectId,
    createdLocalDate: _createdLocalDate,
    createdLocalTime: _createdLocalTime,
    workspaceTitleIdentity: _workspaceTitleIdentity,
    ...rest
  } = normalized;
  return rest;
}

async function loadActiveParent(experimentId: EntityId | undefined) {
  if (!experimentId) {
    throw new Error("ExperimentRun parent experiment is required.");
  }
  const parent = await experimentService.getExperimentById(experimentId);
  if (!parent) {
    throw new Error("ExperimentRun parent experiment does not exist.");
  }
  return parent;
}

async function normalizeExperimentRunCreate(input: CreateExperimentRunInput) {
  assertExperimentRunCreateIdentity(input as CreateExperimentRunInput & Record<string, unknown>);
  const parent = await loadActiveParent(input.experimentId);
  const relations = resolveExperimentRunCreateRelations(parent, input);
  await assertExperimentPlanningRelations(relations);
  return { ...input, ...relations };
}

async function normalizeExperimentRunUpdate(
  existing: ExperimentRun,
  patch: UpdateExperimentRunInput,
  parent: Awaited<ReturnType<typeof experimentService.getExperimentById>>
) {
  assertCreatedLocalTimeNotPatched(patch as RuntimeExperimentRunUpdateInput, "ExperimentRun");
  assertExperimentRunUpdateIdentity(patch as RuntimeExperimentRunUpdateInput);
  if (!parent) {
    throw new Error("ExperimentRun parent experiment does not exist.");
  }
  const relations = resolveExperimentRunUpdateRelations(existing, patch, parent);
  await assertExperimentPlanningRelations(relations, existing);
  return { ...patch, routeId: relations.routeId, taskId: relations.taskId };
}

async function listWritableExperimentRuns() {
  const runs = await repository.list();
  const access = await Promise.all(
    runs.map(async (run) => {
      try {
        return await getControlledExperimentRunAccess(run.id);
      } catch {
        return undefined;
      }
    })
  );
  return access
    .filter((item): item is NonNullable<typeof item> => Boolean(item && !item.readOnly))
    .map((item) => item.run);
}

async function getRunsByExperiment(experimentId: EntityId) {
  return (await listWritableExperimentRuns()).filter((run) => run.experimentId === experimentId);
}

async function getRunById(id: EntityId) {
  try {
    const access = await getControlledExperimentRunAccess(id);
    return access.readOnly ? undefined : access.run;
  } catch {
    return undefined;
  }
}

async function createExperimentRun(input: CreateExperimentRunInput, clock: CreatedLocalTimeClock = {}) {
  const normalizedInput = await normalizeExperimentRunCreate(input);
  const creationTime = captureCreatedLocalTime(clock);
  const creationTitle = normalizedInput.title ?? normalizedInput.runLabel ?? "Untitled run";
  const { run } = await persistExperimentRunWithCreateTimeProvisioning(
    toCreateInput({
      ...normalizedInput,
      ...creationTime,
      workspaceTitleIdentity: freezeWorkspaceTitleIdentity(creationTitle, "experimentRun")
    }),
    { createdAt: creationTime.createdAt }
  );
  publishCrossModuleWriteFeedback(
    createCrossModuleWriteFeedback({
      operation: "experimentRun.createExperimentRun",
      data: run,
      primaryEntity: {
        type: "experimentRun",
        id: run.id,
        relation: "created",
        label: run.title
      },
      affectedEntities: [
        {
          type: "experiment",
          id: run.experimentId,
          relation: "linked"
        },
        ...(run.projectId
          ? [
              {
                type: "project",
                id: run.projectId,
                relation: "linked"
              }
            ]
          : []),
        ...(run.taskId
          ? [
              {
                type: "task",
                id: run.taskId,
                relation: "linked"
              }
            ]
          : [])
      ],
      affectedScopes: [
        {
          module: "experiment",
          projectId: run.projectId ?? undefined,
          taskId: run.taskId ?? undefined,
          experimentId: run.experimentId,
          reason: "ExperimentRun metadata was created."
        }
      ],
      refreshKeys: [
        "experimentRun.changed",
        "experiment.changed",
        "reviewContext.changed",
        "aiContext.changed"
      ]
    }),
    "experimentRun.createExperimentRun"
  );
  return run;
}

async function updateExperimentRun(
  id: EntityId,
  patch: UpdateExperimentRunInput,
  guard: ExperimentRunUpdateGuard = {}
) {
  assertExperimentRunUpdateIdentity(patch as RuntimeExperimentRunUpdateInput);
  const access = await assertExperimentRunWritable(id);
  const existing = access.run;
  const expectedUpdatedAt = guard.expectedUpdatedAt ?? existing.updatedAt;
  if (existing.updatedAt !== expectedUpdatedAt) {
    throw new ExperimentRunUpdateConflictError(id, expectedUpdatedAt);
  }
  const normalizedPatch = await normalizeExperimentRunUpdate(existing, patch, access.parent);
  if (!repository.updateWithExpectedUpdatedAt) {
    throw new Error("The canonical ExperimentRun repository lacks its bounded atomic update guard.");
  }
  const run = await repository.updateWithExpectedUpdatedAt(
    id,
    toUpdateInput(existing, normalizedPatch),
    { expectedUpdatedAt }
  );
  if (!run) {
    throw new ExperimentRunUpdateConflictError(id, expectedUpdatedAt);
  }
  publishCrossModuleWriteFeedback(
    createCrossModuleWriteFeedback({
      operation: "experimentRun.updateExperimentRun",
      data: run,
      primaryEntity: {
        type: "experimentRun",
        id,
        relation: run ? "updated" : "skipped",
        label: run?.title ?? existing.title
      },
      affectedEntities: [
        {
          type: "experiment",
          id: (run ?? existing).experimentId,
          relation: "linked"
        }
      ],
      affectedScopes: [
        {
          module: "experiment",
          projectId: (run ?? existing).projectId ?? undefined,
          taskId: (run ?? existing).taskId ?? undefined,
          experimentId: (run ?? existing).experimentId,
          reason: "ExperimentRun metadata was updated."
        }
      ],
      refreshKeys: ["experimentRun.changed", "experiment.changed", "reviewContext.changed", "aiContext.changed"],
      skipped: run ? [] : ["experiment_run_update_failed"]
    }),
    "experimentRun.updateExperimentRun"
  );
  return run;
}

async function deleteExperimentRun(id: EntityId) {
  const result = await softDeleteExperimentRunMetadata(id);
  if (result.status === "error") throw new Error(result.error.code);
  return result.changed;
}

export const experimentRunService = {
  list: listWritableExperimentRuns,
  getById: getRunById,
  create: createExperimentRun,
  update: updateExperimentRun,
  softDelete: deleteExperimentRun,
  remove: deleteExperimentRun,
  getRunsByExperiment,
  getRunById,
  createExperimentRun,
  updateExperimentRun,
  deleteExperimentRun,
  listWritableExperimentRuns,
  getControlledExperimentRunAccess,
  getRunsByStatus: async (status: ExperimentRunStatus) =>
    (await listWritableExperimentRuns()).filter((run) => run.status === status)
};

export type ExperimentRunService = typeof experimentRunService;
