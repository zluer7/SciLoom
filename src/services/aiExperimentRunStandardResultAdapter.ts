import type {
  AIParseDraftSourceSnapshot,
  AIStandardResult,
  AIStandardResultAction,
  AIStandardResultEffectReceipt,
  AIStandardResultTarget,
  AIStandardResultValidationIssue
} from "../types/aiStandardResult";
import type {
  ConditionItem,
  CreateExperimentRunInput,
  CustomField,
  Experiment,
  ExperimentRating,
  ExperimentRun,
  ExperimentRunStatus,
  MethodStep,
  ResearchMaterial,
  ResearchVariable,
  UpdateExperimentRunInput
} from "../types/experiment";
import { manuscriptBindingService } from "./manuscriptBindingService";
import { planningService } from "./planningService";
import { experimentService } from "./experimentService";
import {
  ExperimentRunManuscriptProvisioningIncompleteError,
  ExperimentRunUpdateConflictError,
  experimentRunService
} from "./experimentRunService";
import {
  canonicalAIStandardResultFingerprint,
  readAIStandardResultBlockingValidationIssues
} from "./aiStandardResultService";

export const AI_EXPERIMENT_RUN_TITLE_MAX_CHARS = 200;
export const AI_EXPERIMENT_RUN_SUMMARY_MAX_CHARS = 4_000;
export const AI_EXPERIMENT_RUN_TAG_MAX_CHARS = 60;
export const AI_EXPERIMENT_RUN_TAG_MAX = 12;
export const AI_EXPERIMENT_RUN_STRUCTURED_ITEM_MAX = 64;

const ACTIVE_STATUSES = new Set<ExperimentRunStatus>([
  "planned",
  "running",
  "completed",
  "paused",
  "failed",
  "cancelled"
]);
const RATINGS = new Set<ExperimentRating>([
  "excellent",
  "good",
  "usable",
  "inconclusive",
  "failed"
]);
const CONDITION_ROLES = new Set([
  "independent_variable",
  "dependent_variable",
  "control_variable",
  "environment",
  "sample",
  "parameter",
  "other"
]);
const CUSTOM_VALUE_TYPES = new Set([
  "text",
  "number",
  "boolean",
  "select",
  "multi_select",
  "date",
  "json"
]);
const EDITABLE_FIELDS = new Set([
  "title",
  "runLabel",
  "status",
  "startedAt",
  "completedAt",
  "conditionSummary",
  "variableParameterSummary",
  "methodSummary",
  "resultSummary",
  "conclusion",
  "summaryOther",
  "rating",
  "routeId",
  "taskId",
  "tags",
  "conditionItems",
  "methodSteps",
  "variables",
  "materials",
  "customFields"
]);
const OPERATION_MARKERS_FIELD = "lp13B1A13StandardResultOperations";
const FORMAL_RUN_CUSTOM_FIELD_NAMES = new Set([
  "summaryOther",
  "variableParameterSummary",
  "runVariableParameterSummary",
  "runSummaryOther"
]);

type ExperimentRunTarget = Extract<AIStandardResultTarget, { module: "experimentRun" }>;
type RunServices = Pick<
  typeof experimentRunService,
  | "createExperimentRun"
  | "updateExperimentRun"
  | "getRunById"
  | "listWritableExperimentRuns"
>;
type ExperimentServices = Pick<typeof experimentService, "getExperimentById">;
type PlanningServices = Pick<
  typeof planningService,
  "getProjectById" | "getRouteNodeById" | "getTaskById"
>;
type BindingServices = Pick<typeof manuscriptBindingService, "getBindingByOwner">;

export type AIExperimentRunStandardResultDependencies = {
  runs: RunServices;
  experiments: ExperimentServices;
  planning: PlanningServices;
  bindings: BindingServices;
};

const defaultDependencies: AIExperimentRunStandardResultDependencies = {
  runs: experimentRunService,
  experiments: experimentService,
  planning: planningService,
  bindings: manuscriptBindingService
};

export type AIExperimentRunStandardResultValidation = {
  executable: boolean;
  normalizedPayload: Record<string, unknown>;
  validationIssues: AIStandardResultValidationIssue[];
  targetSnapshotFingerprint?: string;
  resolvedTarget?: ExperimentRunTarget;
};

/**
 * Parse-time validation for the one authorized deferred-parent case: an
 * ExperimentRun CREATE that points to one exact earlier Experiment CREATE in
 * the same ParseAttempt. Parent existence is deliberately revalidated from the
 * sibling effect receipt immediately before canonical Run execution.
 */
export async function validateAIExperimentRunSiblingCreateProposal(input: {
  target: AIStandardResultTarget;
  payload: unknown;
  expectedProjectId: string;
  parentProposalRef: string;
  parentProposalLabel: string;
  dependencies?: AIExperimentRunStandardResultDependencies;
}): Promise<AIExperimentRunStandardResultValidation> {
  const dependencies = input.dependencies ?? defaultDependencies;
  const issues: AIStandardResultValidationIssue[] = [];
  if (
    input.target.module !== "experimentRun" ||
    input.target.entityType !== "experimentRun" ||
    input.target.projectId !== input.expectedProjectId ||
    input.target.entityId
  ) {
    issues.push(issue(
      "EXPERIMENT_RUN_SIBLING_TARGET_INVALID",
      "A sibling-parent Run CREATE requires the exact current-Project creation target."
    ));
  }
  if (!input.parentProposalRef.trim() || !input.parentProposalLabel.trim()) {
    issues.push(issue(
      "EXPERIMENT_RUN_SIBLING_PARENT_INVALID",
      "The exact earlier sibling Experiment proposal is missing."
    ));
  }
  const project = await dependencies.planning.getProjectById(input.expectedProjectId);
  if (!project || project.deletedAt || project.status === "archived") {
    issues.push(issue("EXPERIMENT_RUN_PROJECT_UNAVAILABLE", "The reviewed canonical Project is unavailable."));
  }
  const normalizedPayload = normalizePayload("CREATE", input.payload, issues);
  await validateRelations({
    projectId: input.expectedProjectId,
    routeId: normalizedPayload.routeId as string | null | undefined,
    taskId: normalizedPayload.taskId as string | null | undefined,
    dependencies,
    issues
  });
  const blocking = readAIStandardResultBlockingValidationIssues(issues);
  return {
    executable: blocking.length === 0,
    normalizedPayload,
    validationIssues: blocking.length === 0
      ? [...issues, issue(
          "EXPERIMENT_RUN_SIBLING_PARENT_PENDING",
          `所属实验将在同批建议 ${input.parentProposalLabel} 执行后以精确回执绑定。`,
          "target.parentExperimentId"
        )]
      : issues
  };
}

type ExperimentRunOperationMarker = {
  version: 1;
  action: "CREATE" | "UPDATE";
  resultId: string;
  authorizationId: string;
  confirmedPayloadFingerprint: string;
};

export class AIExperimentRunEffectUnknownError extends Error {
  readonly effectMayExist = true;

  constructor(message: string, readonly causeValue?: unknown) {
    super(message);
    this.name = "AIExperimentRunEffectUnknownError";
  }
}

export class AIExperimentRunEffectNoEffectError extends Error {
  readonly effectProvenAbsent = true;

  constructor(readonly code: string, message: string, readonly causeValue?: unknown) {
    super(message);
    this.name = "AIExperimentRunEffectNoEffectError";
  }
}

function issue(code: string, message: string, field?: string): AIStandardResultValidationIssue {
  return { code, message, ...(field ? { field } : {}) };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function boundedIdentity(
  value: unknown,
  field: string,
  issues: AIStandardResultValidationIssue[]
): string | undefined {
  if (
    typeof value !== "string" || value !== value.trim() || !value ||
    Array.from(value).length > 200 || /[\0-\x1F\x7F]/u.test(value)
  ) {
    issues.push(issue("EXPERIMENT_RUN_IDENTITY_INVALID", `${field} must be one exact bounded identity.`, field));
    return undefined;
  }
  return value;
}

function boundedRequiredText(
  value: unknown,
  field: string,
  maxChars: number,
  issues: AIStandardResultValidationIssue[]
): string | undefined {
  if (
    typeof value !== "string" || !value.trim() || value.includes("\0") ||
    Array.from(value.trim()).length > maxChars
  ) {
    issues.push(issue(
      "EXPERIMENT_RUN_FIELD_INVALID",
      `${field} must contain 1-${maxChars} characters.`,
      field
    ));
    return undefined;
  }
  return value.trim();
}

function boundedOptionalText(
  value: unknown,
  field: string,
  maxChars: number,
  issues: AIStandardResultValidationIssue[]
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return boundedRequiredText(value, field, maxChars, issues);
}

function optionalIdentity(
  value: unknown,
  field: string,
  issues: AIStandardResultValidationIssue[]
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  return boundedIdentity(value, field, issues);
}

function optionalInstant(
  value: unknown,
  field: string,
  issues: AIStandardResultValidationIssue[]
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (
    typeof value !== "string" || value !== value.trim() || value.length > 80 ||
    !Number.isFinite(Date.parse(value))
  ) {
    issues.push(issue("EXPERIMENT_RUN_INSTANT_INVALID", `${field} must be a valid bounded ISO instant or null.`, field));
    return undefined;
  }
  return value;
}

function normalizeTags(value: unknown, issues: AIStandardResultValidationIssue[]): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) || value.length > AI_EXPERIMENT_RUN_TAG_MAX ||
    value.some((tag) => (
      typeof tag !== "string" || !tag.trim() || tag.includes("\0") ||
      Array.from(tag.trim()).length > AI_EXPERIMENT_RUN_TAG_MAX_CHARS
    ))
  ) {
    issues.push(issue(
      "EXPERIMENT_RUN_TAGS_INVALID",
      `tags must contain at most ${AI_EXPERIMENT_RUN_TAG_MAX} bounded non-empty strings.`,
      "tags"
    ));
    return undefined;
  }
  const normalized = value.map((tag) => (tag as string).trim());
  if (new Set(normalized).size !== normalized.length) {
    issues.push(issue("EXPERIMENT_RUN_TAGS_INVALID", "tags must not contain duplicates.", "tags"));
    return undefined;
  }
  return normalized;
}

function assertExactKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
  issues: AIStandardResultValidationIssue[]
) {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) {
      issues.push(issue(
        "EXPERIMENT_RUN_STRUCTURED_FIELD_UNSUPPORTED",
        `${field}.${key} is unsupported.`,
        `${field}.${key}`
      ));
    }
  }
}

function boundedNestedText(
  record: Record<string, unknown>,
  key: string,
  field: string,
  issues: AIStandardResultValidationIssue[]
) {
  if (!hasOwn(record, key)) return undefined;
  return boundedOptionalText(record[key], `${field}.${key}`, 1_000, issues);
}

function normalizeConditionItems(
  value: unknown,
  issues: AIStandardResultValidationIssue[]
): ConditionItem[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > AI_EXPERIMENT_RUN_STRUCTURED_ITEM_MAX) {
    issues.push(issue("EXPERIMENT_RUN_CONDITION_ITEMS_INVALID", "conditionItems must be one bounded array.", "conditionItems"));
    return undefined;
  }
  return value.flatMap((candidate, index) => {
    const field = `conditionItems[${index}]`;
    const record = asRecord(candidate);
    if (!record) {
      issues.push(issue("EXPERIMENT_RUN_CONDITION_ITEMS_INVALID", `${field} must be an object.`, field));
      return [];
    }
    assertExactKeys(record, ["id", "name", "value", "unit", "role", "description"], field, issues);
    const id = boundedIdentity(record.id, `${field}.id`, issues);
    const name = boundedRequiredText(record.name, `${field}.name`, 200, issues);
    const itemValue = record.value;
    if (typeof itemValue !== "string" && typeof itemValue !== "number" && typeof itemValue !== "boolean") {
      issues.push(issue("EXPERIMENT_RUN_CONDITION_VALUE_INVALID", `${field}.value must be string, number, or boolean.`, `${field}.value`));
    }
    if (typeof itemValue === "number" && !Number.isFinite(itemValue)) {
      issues.push(issue("EXPERIMENT_RUN_CONDITION_VALUE_INVALID", `${field}.value must be finite.`, `${field}.value`));
    }
    const role = record.role;
    if (role !== undefined && (typeof role !== "string" || !CONDITION_ROLES.has(role))) {
      issues.push(issue("EXPERIMENT_RUN_CONDITION_ROLE_INVALID", `${field}.role is unsupported.`, `${field}.role`));
    }
    const unit = boundedNestedText(record, "unit", field, issues);
    const description = boundedNestedText(record, "description", field, issues);
    return id && name && (typeof itemValue === "string" || typeof itemValue === "boolean" || Number.isFinite(itemValue))
      ? [{ id, name, value: itemValue as string | number | boolean, ...(unit ? { unit } : {}), ...(role ? { role: role as ConditionItem["role"] } : {}), ...(description ? { description } : {}) }]
      : [];
  });
}

function normalizeMethodSteps(
  value: unknown,
  issues: AIStandardResultValidationIssue[]
): MethodStep[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > AI_EXPERIMENT_RUN_STRUCTURED_ITEM_MAX) {
    issues.push(issue("EXPERIMENT_RUN_METHOD_STEPS_INVALID", "methodSteps must be one bounded array.", "methodSteps"));
    return undefined;
  }
  return value.flatMap((candidate, index) => {
    const field = `methodSteps[${index}]`;
    const record = asRecord(candidate);
    if (!record) {
      issues.push(issue("EXPERIMENT_RUN_METHOD_STEPS_INVALID", `${field} must be an object.`, field));
      return [];
    }
    assertExactKeys(record, ["id", "order", "title", "description", "toolOrMethod", "parameters"], field, issues);
    const id = boundedIdentity(record.id, `${field}.id`, issues);
    const title = boundedRequiredText(record.title, `${field}.title`, 300, issues);
    const order = record.order;
    if (typeof order !== "number" || !Number.isInteger(order) || order < 0) {
      issues.push(issue("EXPERIMENT_RUN_METHOD_ORDER_INVALID", `${field}.order must be a non-negative integer.`, `${field}.order`));
    }
    const description = boundedNestedText(record, "description", field, issues);
    const toolOrMethod = boundedNestedText(record, "toolOrMethod", field, issues);
    let parameters: Record<string, unknown> | undefined;
    if (record.parameters !== undefined) {
      parameters = asRecord(record.parameters) ?? undefined;
      let serialized = "";
      try { serialized = JSON.stringify(parameters); } catch { serialized = ""; }
      if (!parameters || serialized.length > 4_000 || serialized.includes("\0")) {
        issues.push(issue("EXPERIMENT_RUN_METHOD_PARAMETERS_INVALID", `${field}.parameters must be one bounded JSON object.`, `${field}.parameters`));
        parameters = undefined;
      } else parameters = structuredClone(parameters);
    }
    return id && title && typeof order === "number" && Number.isInteger(order) && order >= 0
      ? [{ id, order, title, ...(description ? { description } : {}), ...(toolOrMethod ? { toolOrMethod } : {}), ...(parameters ? { parameters } : {}) }]
      : [];
  });
}

function normalizeVariables(
  value: unknown,
  issues: AIStandardResultValidationIssue[]
): ResearchVariable[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > AI_EXPERIMENT_RUN_STRUCTURED_ITEM_MAX) {
    issues.push(issue("EXPERIMENT_RUN_VARIABLES_INVALID", "variables must be one bounded array.", "variables"));
    return undefined;
  }
  return value.flatMap((candidate, index) => {
    const field = `variables[${index}]`;
    const record = asRecord(candidate);
    if (!record) {
      issues.push(issue("EXPERIMENT_RUN_VARIABLES_INVALID", `${field} must be an object.`, field));
      return [];
    }
    assertExactKeys(record, ["id", "name", "value", "unit", "role", "description"], field, issues);
    const id = boundedIdentity(record.id, `${field}.id`, issues);
    const name = boundedRequiredText(record.name, `${field}.name`, 200, issues);
    const itemValue = record.value;
    if (itemValue !== undefined && typeof itemValue !== "string" && typeof itemValue !== "number" && typeof itemValue !== "boolean") {
      issues.push(issue("EXPERIMENT_RUN_VARIABLE_VALUE_INVALID", `${field}.value has an unsupported type.`, `${field}.value`));
    }
    if (typeof itemValue === "number" && !Number.isFinite(itemValue)) {
      issues.push(issue("EXPERIMENT_RUN_VARIABLE_VALUE_INVALID", `${field}.value must be finite.`, `${field}.value`));
    }
    const role = record.role;
    if (role !== undefined && (typeof role !== "string" || !CONDITION_ROLES.has(role))) {
      issues.push(issue("EXPERIMENT_RUN_VARIABLE_ROLE_INVALID", `${field}.role is unsupported.`, `${field}.role`));
    }
    const unit = boundedNestedText(record, "unit", field, issues);
    const description = boundedNestedText(record, "description", field, issues);
    return id && name
      ? [{ id, name, ...(itemValue !== undefined ? { value: itemValue as string | number | boolean } : {}), ...(unit ? { unit } : {}), ...(role ? { role: role as ResearchVariable["role"] } : {}), ...(description ? { description } : {}) }]
      : [];
  });
}

function normalizeMaterials(
  value: unknown,
  issues: AIStandardResultValidationIssue[]
): ResearchMaterial[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > AI_EXPERIMENT_RUN_STRUCTURED_ITEM_MAX) {
    issues.push(issue("EXPERIMENT_RUN_MATERIALS_INVALID", "materials must be one bounded array.", "materials"));
    return undefined;
  }
  return value.flatMap((candidate, index) => {
    const field = `materials[${index}]`;
    const record = asRecord(candidate);
    if (!record) {
      issues.push(issue("EXPERIMENT_RUN_MATERIALS_INVALID", `${field} must be an object.`, field));
      return [];
    }
    assertExactKeys(record, ["id", "name", "materialType", "amount", "unit", "description"], field, issues);
    const id = boundedIdentity(record.id, `${field}.id`, issues);
    const name = boundedRequiredText(record.name, `${field}.name`, 200, issues);
    const amount = record.amount;
    if (amount !== undefined && typeof amount !== "string" && typeof amount !== "number") {
      issues.push(issue("EXPERIMENT_RUN_MATERIAL_AMOUNT_INVALID", `${field}.amount must be string or number.`, `${field}.amount`));
    }
    if (typeof amount === "number" && !Number.isFinite(amount)) {
      issues.push(issue("EXPERIMENT_RUN_MATERIAL_AMOUNT_INVALID", `${field}.amount must be finite.`, `${field}.amount`));
    }
    const materialType = boundedNestedText(record, "materialType", field, issues);
    const unit = boundedNestedText(record, "unit", field, issues);
    const description = boundedNestedText(record, "description", field, issues);
    return id && name
      ? [{ id, name, ...(materialType ? { materialType } : {}), ...(amount !== undefined ? { amount: amount as string | number } : {}), ...(unit ? { unit } : {}), ...(description ? { description } : {}) }]
      : [];
  });
}

function validCustomValue(value: unknown): boolean {
  if (typeof value === "string") return !value.includes("\0") && value.length <= 2_000;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  if (Array.isArray(value)) {
    return value.length <= 64 && value.every((item) => (
      typeof item === "string" && !item.includes("\0") && item.length <= 500 ||
      typeof item === "number" && Number.isFinite(item)
    ));
  }
  const record = asRecord(value);
  if (!record) return false;
  try {
    const serialized = JSON.stringify(record);
    return serialized.length <= 4_000 && !serialized.includes("\0");
  } catch {
    return false;
  }
}

function normalizeCustomFields(
  value: unknown,
  issues: AIStandardResultValidationIssue[]
): CustomField[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 32) {
    issues.push(issue("EXPERIMENT_RUN_CUSTOM_FIELDS_INVALID", "customFields must be one bounded array.", "customFields"));
    return undefined;
  }
  return value.flatMap((candidate, index) => {
    const field = `customFields[${index}]`;
    const record = asRecord(candidate);
    if (!record) {
      issues.push(issue("EXPERIMENT_RUN_CUSTOM_FIELDS_INVALID", `${field} must be an object.`, field));
      return [];
    }
    assertExactKeys(record, ["id", "name", "value", "valueType", "unit", "group", "description"], field, issues);
    const id = boundedIdentity(record.id, `${field}.id`, issues);
    const name = boundedRequiredText(record.name, `${field}.name`, 200, issues);
    if (name && FORMAL_RUN_CUSTOM_FIELD_NAMES.has(name)) {
      issues.push(issue("EXPERIMENT_RUN_CUSTOM_FIELD_RESERVED", `${field}.name conflicts with a formal Run field.`, `${field}.name`));
    }
    if (!validCustomValue(record.value)) {
      issues.push(issue("EXPERIMENT_RUN_CUSTOM_VALUE_INVALID", `${field}.value is not a bounded supported value.`, `${field}.value`));
    }
    const valueType = record.valueType;
    if (valueType !== undefined && (typeof valueType !== "string" || !CUSTOM_VALUE_TYPES.has(valueType))) {
      issues.push(issue("EXPERIMENT_RUN_CUSTOM_VALUE_TYPE_INVALID", `${field}.valueType is unsupported.`, `${field}.valueType`));
    }
    const unit = boundedNestedText(record, "unit", field, issues);
    const group = boundedNestedText(record, "group", field, issues);
    const description = boundedNestedText(record, "description", field, issues);
    return id && name && !FORMAL_RUN_CUSTOM_FIELD_NAMES.has(name) && validCustomValue(record.value)
      ? [{ id, name, value: structuredClone(record.value) as CustomField["value"], ...(valueType ? { valueType: valueType as CustomField["valueType"] } : {}), ...(unit ? { unit } : {}), ...(group ? { group } : {}), ...(description ? { description } : {}) }]
      : [];
  });
}

function normalizePayload(
  action: "CREATE" | "UPDATE",
  value: unknown,
  issues: AIStandardResultValidationIssue[]
): Record<string, unknown> {
  const payload = asRecord(value);
  if (!payload) {
    issues.push(issue("EXPERIMENT_RUN_PAYLOAD_INVALID", "The visible ExperimentRun payload must be one JSON object."));
    return {};
  }
  for (const key of Object.keys(payload)) {
    if (!EDITABLE_FIELDS.has(key)) {
      issues.push(issue("EXPERIMENT_RUN_FIELD_UNSUPPORTED", `${key} is not an editable ExperimentRun field.`, key));
    }
  }
  if (action === "UPDATE" && Object.keys(payload).length === 0) {
    issues.push(issue("EXPERIMENT_RUN_UPDATE_EMPTY", "ExperimentRun UPDATE requires at least one visible field change."));
  }
  const normalized: Record<string, unknown> = {};
  if (action === "CREATE" || hasOwn(payload, "title")) {
    const title = boundedRequiredText(payload.title, "title", AI_EXPERIMENT_RUN_TITLE_MAX_CHARS, issues);
    if (title !== undefined) normalized.title = title;
  }
  if (action === "CREATE" || hasOwn(payload, "runLabel")) {
    const runLabel = boundedOptionalText(payload.runLabel, "runLabel", 200, issues);
    if (runLabel !== undefined) normalized.runLabel = runLabel;
    else if (hasOwn(payload, "runLabel")) normalized.runLabel = undefined;
  }
  for (const field of [
    "conditionSummary",
    "variableParameterSummary",
    "methodSummary",
    "resultSummary",
    "conclusion",
    "summaryOther"
  ] as const) {
    if (action === "CREATE" || hasOwn(payload, field)) {
      const text = boundedOptionalText(payload[field], field, AI_EXPERIMENT_RUN_SUMMARY_MAX_CHARS, issues);
      if (text !== undefined) normalized[field] = text;
      else if (hasOwn(payload, field)) normalized[field] = undefined;
    }
  }
  if (action === "CREATE" || hasOwn(payload, "status")) {
    const status = payload.status ?? "planned";
    if (typeof status !== "string" || !ACTIVE_STATUSES.has(status as ExperimentRunStatus)) {
      issues.push(issue("EXPERIMENT_RUN_STATUS_INVALID", "status is unsupported.", "status"));
    } else normalized.status = status;
  }
  for (const field of ["startedAt", "completedAt"] as const) {
    if (action === "CREATE" || hasOwn(payload, field)) {
      const instant = optionalInstant(payload[field], field, issues);
      if (instant !== undefined) normalized[field] = instant;
      else if (hasOwn(payload, field)) normalized[field] = undefined;
    }
  }
  if (hasOwn(payload, "rating")) {
    const rating = payload.rating;
    if (rating === null || rating === "") normalized.rating = undefined;
    else if (typeof rating !== "string" || !RATINGS.has(rating as ExperimentRating)) {
      issues.push(issue("EXPERIMENT_RUN_RATING_INVALID", "rating is unsupported.", "rating"));
    } else normalized.rating = rating;
  }
  for (const field of ["routeId", "taskId"] as const) {
    if (hasOwn(payload, field)) {
      const identity = optionalIdentity(payload[field], field, issues);
      if (identity !== undefined) normalized[field] = identity;
    }
  }
  if (hasOwn(payload, "tags")) {
    const tags = normalizeTags(payload.tags, issues);
    if (tags !== undefined) normalized.tags = tags;
  } else if (action === "CREATE") normalized.tags = [];

  const structured = {
    conditionItems: normalizeConditionItems,
    methodSteps: normalizeMethodSteps,
    variables: normalizeVariables,
    materials: normalizeMaterials,
    customFields: normalizeCustomFields
  } as const;
  for (const field of Object.keys(structured) as Array<keyof typeof structured>) {
    if (hasOwn(payload, field)) {
      const items = structured[field](payload[field], issues) as unknown[] | undefined;
      if (items !== undefined) normalized[field] = items;
    } else if (action === "CREATE") normalized[field] = [];
  }
  return normalized;
}

async function validateRelations(input: {
  projectId: string;
  routeId: string | null | undefined;
  taskId: string | null | undefined;
  dependencies: AIExperimentRunStandardResultDependencies;
  issues: AIStandardResultValidationIssue[];
}) {
  const [route, task] = await Promise.all([
    input.routeId ? input.dependencies.planning.getRouteNodeById(input.routeId) : undefined,
    input.taskId ? input.dependencies.planning.getTaskById(input.taskId) : undefined
  ]);
  if (input.routeId && (!route || route.deletedAt || route.projectId !== input.projectId)) {
    input.issues.push(issue("EXPERIMENT_RUN_ROUTE_SCOPE_MISMATCH", "routeId is unavailable in the parent Project.", "routeId"));
  }
  if (input.taskId && (!task || task.deletedAt || task.projectId !== input.projectId)) {
    input.issues.push(issue("EXPERIMENT_RUN_TASK_SCOPE_MISMATCH", "taskId is unavailable in the parent Project.", "taskId"));
  }
  const taskRouteId = task
    ? ((task as typeof task & { milestoneId?: string | null }).milestoneId ?? task.routeNodeId)
    : undefined;
  if (input.routeId && taskRouteId && input.routeId !== taskRouteId) {
    input.issues.push(issue("EXPERIMENT_RUN_RELATION_CONFLICT", "The linked Task route conflicts with routeId.", "taskId"));
  }
}

function resolvedTargetMatches(
  provided: ExperimentRunTarget,
  resolved: ExperimentRunTarget
): boolean {
  const applicationFields = [
    "manuscriptChannel",
    "parentExperimentId",
    "parentExperimentLabel",
    "projectLabel",
    "expectedUpdatedAt"
  ] as const;
  return applicationFields.every((field) =>
    !hasOwn(provided, field) || provided[field] === resolved[field]
  );
}

function targetFingerprint(input: {
  action: AIStandardResultAction;
  target: ExperimentRunTarget;
  sourceRuns: ExperimentRun[];
  parent: Experiment;
  project: { id: string; title: string; status: string; updatedAt: string };
  existing?: ExperimentRun;
}) {
  return canonicalAIStandardResultFingerprint({
    resolvedTarget: input.target,
    sourceRuns: input.sourceRuns.map((run) => ({
      id: run.id,
      experimentId: run.experimentId,
      projectId: run.projectId,
      updatedAt: run.updatedAt,
      deletedAt: run.deletedAt ?? null
    })),
    parent: {
      id: input.parent.id,
      projectId: input.parent.projectId,
      title: input.parent.title,
      status: input.parent.status,
      // A confirmed same-batch parent Experiment UPDATE advances only the
      // parent's revision token. That is not a mutation of an existing Run.
      // Keep CREATE/NEW_MANUSCRIPT parent freshness strict while letting an
      // UPDATE remain guarded by the Run's own expectedUpdatedAt/fingerprint.
      ...(input.action === "UPDATE" ? {} : { updatedAt: input.parent.updatedAt }),
      deletedAt: input.parent.deletedAt ?? null
    },
    project: input.project,
    existing: input.existing ? {
      id: input.existing.id,
      experimentId: input.existing.experimentId,
      projectId: input.existing.projectId,
      routeId: input.existing.routeId ?? null,
      taskId: input.existing.taskId ?? null,
      title: input.existing.title,
      runLabel: input.existing.runLabel ?? null,
      status: input.existing.status,
      updatedAt: input.existing.updatedAt,
      deletedAt: input.existing.deletedAt ?? null
    } : null
  });
}

export async function validateAIExperimentRunStandardResultProposal(input: {
  action: AIStandardResultAction;
  target: AIStandardResultTarget;
  source?: AIParseDraftSourceSnapshot;
  payload: unknown;
  expectedProjectId: string;
  expectedTargetSnapshotFingerprint?: string;
  dependencies?: AIExperimentRunStandardResultDependencies;
}): Promise<AIExperimentRunStandardResultValidation> {
  const dependencies = input.dependencies ?? defaultDependencies;
  const issues: AIStandardResultValidationIssue[] = [];
  if (input.target.module !== "experimentRun" || input.target.entityType !== "experimentRun") {
    return {
      executable: false,
      normalizedPayload: {},
      validationIssues: [issue("EXPERIMENT_RUN_TARGET_INVALID", "The ExperimentRun adapter requires one exact Run target descriptor.")]
    };
  }
  const target = input.target;
  if (target.projectId !== input.expectedProjectId) {
    issues.push(issue("EXPERIMENT_RUN_SCOPE_MISMATCH", "The proposed Run scope crosses the reviewed Project.", "target.projectId"));
  }
  const sourceIds = input.source?.selectedExperimentRunIds ?? [];
  const selectedExperimentIds = input.source?.selectedExperimentIds ?? [];
  if (
    !input.source ||
    input.action === "CREATE" && sourceIds.length === 0 && selectedExperimentIds.length === 0 ||
    input.action !== "CREATE" && sourceIds.length === 0
  ) {
    issues.push(issue(
      "EXPERIMENT_RUN_SOURCE_SCOPE_REQUIRED",
      input.action === "CREATE"
        ? "ExperimentRun CREATE requires one frozen canonical parent Experiment, selected directly or proven by the frozen Run-parent scope."
        : "ExperimentRun Results require a frozen A12 Run source."
    ));
  }
  if (input.source && (
    input.source.projectId !== input.expectedProjectId ||
    input.source.conversationId.trim().length === 0
  )) {
    issues.push(issue("EXPERIMENT_RUN_SOURCE_SCOPE_MISMATCH", "The frozen ExperimentRun source scope is mismatched."));
  }
  if (new Set(sourceIds).size !== sourceIds.length) {
    issues.push(issue("EXPERIMENT_RUN_SOURCE_SCOPE_MISMATCH", "The frozen ExperimentRun source contains duplicate IDs."));
  }
  if (new Set(selectedExperimentIds).size !== selectedExperimentIds.length) {
    issues.push(issue("EXPERIMENT_RUN_SOURCE_SCOPE_MISMATCH", "The frozen parent Experiment source contains duplicate IDs."));
  }
  if (input.action !== "CREATE" && (!target.entityId || !sourceIds.includes(target.entityId))) {
    issues.push(issue("EXPERIMENT_RUN_TARGET_OUTSIDE_FROZEN_SCOPE", "The exact Run target is outside the frozen A12 scope.", "target.entityId"));
  }
  if (input.action === "CREATE" && target.entityId) {
    issues.push(issue("EXPERIMENT_RUN_CREATE_TARGET_ID_FORBIDDEN", "ExperimentRun CREATE cannot accept a model-owned entityId.", "target.entityId"));
  }
  const writableRunIds = new Set(
    (await dependencies.runs.listWritableExperimentRuns()).map((candidate) => candidate.id)
  );
  const sourceRuns = (await Promise.all(sourceIds.map((id) => dependencies.runs.getRunById(id))))
    .filter((candidate): candidate is ExperimentRun => Boolean(candidate));
  if (sourceRuns.length !== sourceIds.length || sourceIds.some((id) => !writableRunIds.has(id))) {
    issues.push(issue("EXPERIMENT_RUN_SOURCE_UNAVAILABLE", "One or more frozen source Runs are unavailable or read-only."));
  }
  const relations = input.source?.experimentRunParentRelations ?? [];
  if (relations.length !== sourceIds.length) {
    issues.push(issue("EXPERIMENT_RUN_PARENT_RELATION_MISMATCH", "Frozen Run-parent relation cardinality is invalid."));
  }
  for (const runId of sourceIds) {
    const relation = relations.find((candidate) => candidate.runId === runId);
    const run = sourceRuns.find((candidate) => candidate.id === runId);
    if (
      !relation || !Number.isSafeInteger(relation.selectionOrder) || relation.selectionOrder < 0 ||
      relation.projectId !== input.expectedProjectId ||
      !run || run.experimentId !== relation.parentExperimentId || run.projectId !== relation.projectId
    ) {
      issues.push(issue("EXPERIMENT_RUN_PARENT_RELATION_MISMATCH", `Frozen parent relation for Run ${runId} is stale or contradictory.`));
    }
  }
  const directParentIds = input.action === "CREATE"
    ? [...new Set(selectedExperimentIds)]
    : [];
  const relationParentIds = [...new Set(relations
    .filter((relation) => sourceIds.includes(relation.runId))
    .map((relation) => relation.parentExperimentId))];
  const selectedParentId = input.action === "CREATE"
    ? directParentIds.length === 1
      ? directParentIds[0]
      : directParentIds.length === 0 && relationParentIds.length === 1
        ? relationParentIds[0]
        : undefined
    : sourceRuns.find((run) => run.id === target.entityId)?.experimentId;
  if (input.action === "CREATE" && !selectedParentId) {
    issues.push(issue(
      "EXPERIMENT_RUN_CREATE_PARENT_AMBIGUOUS",
      "CREATE requires exactly one directly selected parent Experiment, or one unique Run-derived parent when no Experiment is directly selected."
    ));
  }
  const parent = selectedParentId
    ? await dependencies.experiments.getExperimentById(selectedParentId)
    : undefined;
  if (!parent || parent.deletedAt || parent.status === "archived") {
    issues.push(issue("EXPERIMENT_RUN_PARENT_UNAVAILABLE", "The canonical parent Experiment is unavailable."));
  } else if (parent.projectId !== input.expectedProjectId) {
    issues.push(issue("EXPERIMENT_RUN_PARENT_PROJECT_MISMATCH", "The canonical parent Experiment crosses the reviewed Project."));
  }
  const project = await dependencies.planning.getProjectById(input.expectedProjectId);
  if (!project || project.deletedAt || project.status === "archived") {
    issues.push(issue("EXPERIMENT_RUN_PROJECT_UNAVAILABLE", "The reviewed canonical Project is unavailable."));
  }
  let existing: ExperimentRun | undefined;
  if (input.action !== "CREATE") {
    existing = target.entityId ? await dependencies.runs.getRunById(target.entityId) : undefined;
    if (!existing || existing.deletedAt || !writableRunIds.has(existing.id)) {
      issues.push(issue("EXPERIMENT_RUN_TARGET_UNAVAILABLE", "The canonical Run target is unavailable or read-only."));
    } else if (
      existing.projectId !== input.expectedProjectId ||
      existing.experimentId !== selectedParentId
    ) {
      issues.push(issue("EXPERIMENT_RUN_TARGET_PARENT_PROJECT_MISMATCH", "The canonical Run parent or Project changed after review."));
    }
  }

  let resolvedTarget: ExperimentRunTarget | undefined;
  let currentTargetFingerprint: string | undefined;
  if (parent && project && selectedParentId) {
    resolvedTarget = {
      module: "experimentRun",
      projectId: project.id,
      entityType: "experimentRun",
      ...(input.action === "CREATE" ? {} : { entityId: target.entityId }),
      parentExperimentId: parent.id,
      parentExperimentLabel: parent.title,
      projectLabel: project.title,
      ...(input.action === "NEW_MANUSCRIPT" ? { manuscriptChannel: "primary" } : {}),
      ...(input.action === "UPDATE" && existing ? { expectedUpdatedAt: target.expectedUpdatedAt ?? existing.updatedAt } : {})
    };
    if (!resolvedTargetMatches(target, resolvedTarget)) {
      issues.push(issue("EXPERIMENT_RUN_RESOLVED_TARGET_STALE", "The reviewed parent/Project/Run descriptor no longer matches canonical readback."));
    }
    if (input.action === "UPDATE" && existing && target.expectedUpdatedAt && existing.updatedAt !== target.expectedUpdatedAt) {
      issues.push(issue("EXPERIMENT_RUN_TARGET_STALE", "The canonical Run changed after the reviewed UPDATE target was frozen."));
    }
    currentTargetFingerprint = targetFingerprint({
      action: input.action,
      target: resolvedTarget,
      sourceRuns,
      parent,
      project: { id: project.id, title: project.title, status: project.status, updatedAt: project.updatedAt },
      existing
    });
    if (
      input.expectedTargetSnapshotFingerprint &&
      input.expectedTargetSnapshotFingerprint !== currentTargetFingerprint
    ) {
      issues.push(issue("EXPERIMENT_RUN_TARGET_STALE", "The resolved Run target fingerprint changed after Parse Draft."));
    }
  }

  if (input.action === "DELETE_SUGGESTION") {
    const payload = asRecord(input.payload);
    if (!payload || Object.keys(payload).some((key) => key !== "reason")) {
      issues.push(issue("EXPERIMENT_RUN_DELETE_SUGGESTION_INVALID", "DELETE_SUGGESTION accepts exactly one reason field."));
    }
    const reason = boundedRequiredText(payload?.reason, "reason", 1_000, issues);
    return {
      executable: false,
      normalizedPayload: reason ? { reason } : {},
      validationIssues: readAIStandardResultBlockingValidationIssues(issues).length > 0
        ? issues
        : [issue("DELETE_SUGGESTION_INFORMATIONAL_ONLY", "DELETE_SUGGESTION has no AI executor; use the existing Run deletion flow.")],
      ...(resolvedTarget ? { resolvedTarget } : {}),
      ...(currentTargetFingerprint ? { targetSnapshotFingerprint: currentTargetFingerprint } : {})
    };
  }
  if (input.action === "NEW_MANUSCRIPT") {
    return {
      executable: false,
      normalizedPayload: asRecord(input.payload) ?? {},
      validationIssues: [
        ...issues,
        issue("EXPERIMENT_RUN_NEW_MANUSCRIPT_NOT_ENABLED_IN_A13", "ExperimentRun NEW_MANUSCRIPT is outside LP13-B1-A13.")
      ],
      ...(resolvedTarget ? { resolvedTarget } : {}),
      ...(currentTargetFingerprint ? { targetSnapshotFingerprint: currentTargetFingerprint } : {})
    };
  }
  if (input.action !== "CREATE" && input.action !== "UPDATE") {
    return { executable: false, normalizedPayload: {}, validationIssues: [...issues, issue("EXPERIMENT_RUN_ACTION_UNSUPPORTED", "The ExperimentRun action is unsupported.")] };
  }
  const normalizedPayload = normalizePayload(input.action, input.payload, issues);
  const resultingRouteId = hasOwn(normalizedPayload, "routeId")
    ? normalizedPayload.routeId as string | null | undefined
    : input.action === "CREATE" ? parent?.routeId : existing?.routeId;
  const resultingTaskId = hasOwn(normalizedPayload, "taskId")
    ? normalizedPayload.taskId as string | null | undefined
    : input.action === "CREATE" ? parent?.taskId : existing?.taskId;
  await validateRelations({
    projectId: input.expectedProjectId,
    routeId: resultingRouteId,
    taskId: resultingTaskId,
    dependencies,
    issues
  });
  return {
    executable: readAIStandardResultBlockingValidationIssues(issues).length === 0,
    normalizedPayload,
    validationIssues: issues,
    ...(resolvedTarget ? { resolvedTarget } : {}),
    ...(currentTargetFingerprint ? { targetSnapshotFingerprint: currentTargetFingerprint } : {})
  };
}

function operationMarker(result: AIStandardResult): ExperimentRunOperationMarker {
  if (
    (result.action !== "CREATE" && result.action !== "UPDATE") ||
    !result.authorizationId || !result.confirmedPayloadFingerprint
  ) {
    throw new AIExperimentRunEffectNoEffectError(
      "EXPERIMENT_RUN_OPERATION_BINDING_INVALID",
      "The claimed Run Result has no exact operation/authorization/payload binding."
    );
  }
  return {
    version: 1,
    action: result.action,
    resultId: result.id,
    authorizationId: result.authorizationId,
    confirmedPayloadFingerprint: result.confirmedPayloadFingerprint
  };
}

function readOperationMarkers(run: ExperimentRun): ExperimentRunOperationMarker[] {
  const candidate = run.legacy?.[OPERATION_MARKERS_FIELD];
  if (!Array.isArray(candidate)) return [];
  return candidate.flatMap((value) => {
    const marker = asRecord(value);
    if (
      marker?.version !== 1 ||
      (marker.action !== "CREATE" && marker.action !== "UPDATE") ||
      typeof marker.resultId !== "string" ||
      typeof marker.authorizationId !== "string" ||
      typeof marker.confirmedPayloadFingerprint !== "string"
    ) return [];
    return [{
      version: 1,
      action: marker.action,
      resultId: marker.resultId,
      authorizationId: marker.authorizationId,
      confirmedPayloadFingerprint: marker.confirmedPayloadFingerprint
    }];
  });
}

function markerMatches(run: ExperimentRun, expected: ExperimentRunOperationMarker): boolean {
  return readOperationMarkers(run).some((marker) => (
    marker.action === expected.action &&
    marker.resultId === expected.resultId &&
    marker.authorizationId === expected.authorizationId &&
    marker.confirmedPayloadFingerprint === expected.confirmedPayloadFingerprint
  ));
}

function legacyWithMarker(run: ExperimentRun | undefined, marker: ExperimentRunOperationMarker) {
  const prior = run ? readOperationMarkers(run) : [];
  return {
    ...(run?.legacy ?? {}),
    [OPERATION_MARKERS_FIELD]: [
      ...prior.filter((candidate) => candidate.resultId !== marker.resultId),
      marker
    ]
  };
}

function canonicalRunReadback(
  run: ExperimentRun,
  marker: ExperimentRunOperationMarker,
  provisioning?: Record<string, unknown>
): Record<string, unknown> {
  return {
    id: run.id,
    experimentId: run.experimentId,
    projectId: run.projectId,
    routeId: run.routeId ?? null,
    taskId: run.taskId ?? null,
    title: run.title,
    runLabel: run.runLabel ?? null,
    status: run.status,
    startedAt: run.startedAt ?? null,
    completedAt: run.completedAt ?? null,
    conditionSummary: run.conditionSummary ?? null,
    variableParameterSummary: run.variableParameterSummary ?? null,
    methodSummary: run.methodSummary ?? null,
    resultSummary: run.resultSummary ?? null,
    conclusion: run.conclusion ?? null,
    summaryOther: run.summaryOther ?? null,
    rating: run.rating ?? null,
    tags: [...run.tags],
    conditionItems: structuredClone(run.conditionItems),
    methodSteps: structuredClone(run.methodSteps),
    variables: structuredClone(run.variables),
    materials: structuredClone(run.materials),
    customFields: structuredClone(run.customFields),
    updatedAt: run.updatedAt,
    operationId: marker.resultId,
    authorizationId: marker.authorizationId,
    confirmedPayloadFingerprint: marker.confirmedPayloadFingerprint,
    ...(provisioning ? { serviceOwnedCreateProvisioning: provisioning } : {})
  };
}

async function canonicalRunReceipt(input: {
  run: ExperimentRun;
  marker: ExperimentRunOperationMarker;
  target: ExperimentRunTarget;
  dependencies: AIExperimentRunStandardResultDependencies;
}): Promise<AIStandardResultEffectReceipt> {
  const readback = await input.dependencies.runs.getRunById(input.run.id);
  if (
    !readback || readback.deletedAt ||
    readback.projectId !== input.target.projectId ||
    readback.experimentId !== input.target.parentExperimentId ||
    !markerMatches(readback, input.marker)
  ) {
    throw new AIExperimentRunEffectUnknownError(
      "The canonical Run effect readback is unavailable or has no exact Result operation binding."
    );
  }
  let provisioning: Record<string, unknown> | undefined;
  if (input.marker.action === "CREATE") {
    const binding = await input.dependencies.bindings.getBindingByOwner("experimentRun", readback.id, "primary");
    if (
      !binding?.defaultFolderFileRefId ||
      !binding.defaultManuscriptFileRefId ||
      !binding.currentFileRefId
    ) {
      throw new AIExperimentRunEffectUnknownError(
        "Run CREATE exists but canonical service-owned primary manuscript initialization is incomplete."
      );
    }
    provisioning = {
      completionState: "complete_readback",
      bindingId: binding.id,
      defaultFolderFileRefId: binding.defaultFolderFileRefId,
      defaultManuscriptFileRefId: binding.defaultManuscriptFileRefId,
      currentFileRefId: binding.currentFileRefId
    };
  }
  return {
    module: "experimentRun",
    entityType: "experimentRun",
    entityId: readback.id,
    operation: input.marker.action,
    service: input.marker.action === "CREATE"
      ? "experimentRunService.createExperimentRun"
      : "experimentRunService.updateExperimentRun",
    canonicalReadback: canonicalRunReadback(readback, input.marker, provisioning)
  };
}

export async function readAIExperimentRunStandardResultEffect(input: {
  result: AIStandardResult;
  dependencies?: AIExperimentRunStandardResultDependencies;
}): Promise<AIStandardResultEffectReceipt | undefined> {
  const dependencies = input.dependencies ?? defaultDependencies;
  if (input.result.target.module !== "experimentRun") return undefined;
  const marker = operationMarker(input.result);
  if (marker.action === "CREATE") {
    const runs = await dependencies.runs.listWritableExperimentRuns();
    const matches = runs.filter((run) => markerMatches(run, marker));
    if (matches.length > 1) {
      throw new AIExperimentRunEffectUnknownError(
        "One Run CREATE Result operation resolved to multiple canonical Runs."
      );
    }
    return matches[0]
      ? canonicalRunReceipt({ run: matches[0], marker, target: input.result.target, dependencies })
      : undefined;
  }
  const entityId = input.result.target.entityId;
  if (!entityId) return undefined;
  const run = await dependencies.runs.getRunById(entityId);
  if (!run || !markerMatches(run, marker)) return undefined;
  return canonicalRunReceipt({ run, marker, target: input.result.target, dependencies });
}

export async function invokeAIExperimentRunStandardResultEffect(input: {
  result: AIStandardResult;
  normalizedPayload: Record<string, unknown>;
  dependencies?: AIExperimentRunStandardResultDependencies;
}): Promise<AIStandardResultEffectReceipt> {
  const dependencies = input.dependencies ?? defaultDependencies;
  if (input.result.target.module !== "experimentRun") {
    throw new AIExperimentRunEffectNoEffectError(
      "EXPERIMENT_RUN_TARGET_INVALID",
      "The Run effect adapter received a non-Run target."
    );
  }
  const prior = await readAIExperimentRunStandardResultEffect({ result: input.result, dependencies });
  if (prior) return prior;
  const marker = operationMarker(input.result);
  const parentExperimentId = input.result.target.parentExperimentId;
  if (!parentExperimentId) {
    throw new AIExperimentRunEffectNoEffectError(
      "EXPERIMENT_RUN_PARENT_TARGET_MISSING",
      "The reviewed Run target has no canonical parent Experiment."
    );
  }
  if (marker.action === "CREATE") {
    try {
      const created = await dependencies.runs.createExperimentRun({
        ...(input.normalizedPayload as CreateExperimentRunInput),
        experimentId: parentExperimentId,
        source: "ai",
        legacy: legacyWithMarker(undefined, marker)
      });
      return await canonicalRunReceipt({ run: created, marker, target: input.result.target, dependencies });
    } catch (error) {
      const readback = await readAIExperimentRunStandardResultEffect({ result: input.result, dependencies }).catch(() => undefined);
      if (readback) return readback;
      if (error instanceof AIExperimentRunEffectUnknownError) throw error;
      if (error instanceof ExperimentRunManuscriptProvisioningIncompleteError) {
        throw new AIExperimentRunEffectUnknownError(
          "Run CREATE exists but its canonical service-owned provisioning has not reached complete readback.",
          error
        );
      }
      throw new AIExperimentRunEffectUnknownError(
        "Run CREATE did not reach an authoritative marker-bound initialized readback; keep the claim pending for same-operation readback/continuation.",
        error
      );
    }
  }

  const entityId = input.result.target.entityId;
  const expectedUpdatedAt = input.result.target.expectedUpdatedAt;
  if (!entityId || !expectedUpdatedAt) {
    throw new AIExperimentRunEffectNoEffectError(
      "EXPERIMENT_RUN_UPDATE_TARGET_MISSING",
      "Run UPDATE requires one exact reviewed Run identity and atomic updatedAt token."
    );
  }
  const existing = await dependencies.runs.getRunById(entityId);
  if (!existing) {
    throw new AIExperimentRunEffectNoEffectError(
      "EXPERIMENT_RUN_UPDATE_TARGET_UNAVAILABLE",
      "The Run UPDATE target is unavailable before the domain effect."
    );
  }
  try {
    const updated = await dependencies.runs.updateExperimentRun(
      entityId,
      {
        ...(input.normalizedPayload as UpdateExperimentRunInput),
        legacy: legacyWithMarker(existing, marker)
      },
      { expectedUpdatedAt }
    );
    return await canonicalRunReceipt({ run: updated, marker, target: input.result.target, dependencies });
  } catch (error) {
    if (error instanceof ExperimentRunUpdateConflictError) {
      throw new AIExperimentRunEffectNoEffectError(
        "EXPERIMENT_RUN_UPDATE_STALE_CONFLICT",
        error.message,
        error
      );
    }
    if (error instanceof AIExperimentRunEffectNoEffectError) throw error;
    const readback = await readAIExperimentRunStandardResultEffect({ result: input.result, dependencies }).catch(() => undefined);
    if (readback) return readback;
    if (error instanceof AIExperimentRunEffectUnknownError) throw error;
    throw new AIExperimentRunEffectUnknownError(
      "Run UPDATE did not reach an authoritative marker-bound readback; keep the claim pending for same-operation readback/continuation.",
      error
    );
  }
}

export const aiExperimentRunStandardResultAdapter = {
  validate: validateAIExperimentRunStandardResultProposal,
  invoke: invokeAIExperimentRunStandardResultEffect,
  readEffect: readAIExperimentRunStandardResultEffect
};
