import type {
  AIParseDraftSourceSnapshot,
  AIStandardResult,
  AIStandardResultAction,
  AIStandardResultEffectReceipt,
  AIStandardResultTarget,
  AIStandardResultValidationIssue
} from "../types/aiStandardResult";
import type {
  FindingConfidence,
  FindingMaturity,
  FindingType
} from "../types/outputConversion";
import { experimentService } from "./experimentService";
import { outputConversionRelationService } from "./outputConversionRelationService";
import {
  outputConversionService,
  type CreateFindingInput
} from "./outputConversionService";
import { planningService } from "./planningService";

export const AI_FINDING_TITLE_MAX_CHARS = 200;
export const AI_FINDING_SUMMARY_MAX_CHARS = 4_000;
export const AI_FINDING_TAG_MAX = 12;
export const AI_FINDING_TAG_MAX_CHARS = 80;
export const AI_FINDING_RELATION_ID_MAX = 16;
export const AI_FINDING_ID_MAX_CHARS = 200;

const FINDING_TYPES = new Set<FindingType>([
  "phenomenon", "comparison", "method", "limitation", "evidence",
  "hypothesis", "negative_result", "other"
]);
const FINDING_CONFIDENCES = new Set<FindingConfidence>(["high", "medium", "low", "uncertain"]);
const FINDING_MATURITIES = new Set<FindingMaturity>(["high", "medium", "low", "uncertain"]);
const EDITABLE_FIELDS = new Set([
  "title",
  "summary",
  "findingType",
  "confidence",
  "maturity",
  "tags",
  "routeId",
  "taskId",
  "experimentId",
  "resultItemIds"
]);

type FindingTarget = Extract<AIStandardResultTarget, { module: "finding" }>;

export type AIFindingStandardResultValidation = {
  executable: boolean;
  normalizedPayload: Record<string, unknown>;
  validationIssues: AIStandardResultValidationIssue[];
};

export type AIFindingStandardResultDependencies = {
  getProjectById: typeof planningService.getProjectById;
  getRouteNodeById: typeof planningService.getRouteNodeById;
  getTaskById: typeof planningService.getTaskById;
  getExperimentById: typeof experimentService.getExperimentById;
  getResultItemById: typeof outputConversionService.getResultItemById;
  createFinding: typeof outputConversionService.createFinding;
  getFindingById: typeof outputConversionService.getFindingById;
  queryRelations: typeof outputConversionRelationService.queryOutputConversionRelations;
};

const DEFAULT_DEPENDENCIES: AIFindingStandardResultDependencies = {
  getProjectById: planningService.getProjectById,
  getRouteNodeById: planningService.getRouteNodeById,
  getTaskById: planningService.getTaskById,
  getExperimentById: experimentService.getExperimentById,
  getResultItemById: outputConversionService.getResultItemById,
  createFinding: outputConversionService.createFinding,
  getFindingById: outputConversionService.getFindingById,
  queryRelations: outputConversionRelationService.queryOutputConversionRelations
};

function issue(code: string, message: string, field?: string): AIStandardResultValidationIssue {
  return { code, message, ...(field ? { field } : {}) };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function characters(value: string): number {
  return Array.from(value).length;
}

function boundedRequiredText(
  value: unknown,
  field: string,
  maxChars: number,
  issues: AIStandardResultValidationIssue[]
): string | undefined {
  if (
    typeof value !== "string" || !value.trim() || value.includes("\0") ||
    characters(value.trim()) > maxChars
  ) {
    issues.push(issue(
      "FINDING_FIELD_INVALID",
      `${field} must contain 1-${maxChars} characters without NUL.`,
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

function optionalEnum<T extends string>(
  value: unknown,
  field: string,
  values: ReadonlySet<T>,
  issues: AIStandardResultValidationIssue[]
): T | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !values.has(value as T)) {
    issues.push(issue("FINDING_ENUM_INVALID", `${field} is not a supported Finding value.`, field));
    return undefined;
  }
  return value as T;
}

function optionalIdentity(
  value: unknown,
  field: string,
  issues: AIStandardResultValidationIssue[]
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (
    typeof value !== "string" || value !== value.trim() || !value ||
    characters(value) > AI_FINDING_ID_MAX_CHARS || /[\0-\x1F\x7F]/u.test(value)
  ) {
    issues.push(issue(
      "FINDING_RELATION_ID_INVALID",
      `${field} requires one exact bounded canonical identity.`,
      field
    ));
    return undefined;
  }
  return value;
}

function boundedStringList(
  value: unknown,
  field: "tags" | "resultItemIds",
  maxItems: number,
  maxItemChars: number,
  issues: AIStandardResultValidationIssue[]
): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > maxItems) {
    issues.push(issue(
      "FINDING_LIST_INVALID",
      `${field} must be an array with at most ${maxItems} entries.`,
      field
    ));
    return undefined;
  }
  const normalized: string[] = [];
  for (const candidate of value) {
    if (
      typeof candidate !== "string" || candidate !== candidate.trim() || !candidate ||
      characters(candidate) > maxItemChars || /[\0-\x1F\x7F]/u.test(candidate)
    ) {
      issues.push(issue(
        "FINDING_LIST_ITEM_INVALID",
        `${field} entries must be exact non-empty strings of at most ${maxItemChars} characters.`,
        field
      ));
      return undefined;
    }
    normalized.push(candidate);
  }
  return [...new Set(normalized)].sort((left, right) => left.localeCompare(right));
}

function normalizePayload(
  payload: unknown,
  issues: AIStandardResultValidationIssue[]
): Record<string, unknown> {
  const value = asRecord(payload);
  if (!value) {
    issues.push(issue("FINDING_PAYLOAD_INVALID", "Finding CREATE payload must be one JSON object."));
    return {};
  }
  for (const field of Object.keys(value)) {
    if (!EDITABLE_FIELDS.has(field)) {
      issues.push(issue(
        "FINDING_FIELD_FORBIDDEN",
        `${field} is not part of the Finding CREATE positive allowlist.`,
        field
      ));
    }
  }
  const normalized: Record<string, unknown> = {};
  const title = boundedRequiredText(value.title, "title", AI_FINDING_TITLE_MAX_CHARS, issues);
  const summary = boundedOptionalText(value.summary, "summary", AI_FINDING_SUMMARY_MAX_CHARS, issues);
  const findingType = optionalEnum(value.findingType, "findingType", FINDING_TYPES, issues);
  const confidence = optionalEnum(value.confidence, "confidence", FINDING_CONFIDENCES, issues);
  const maturity = optionalEnum(value.maturity, "maturity", FINDING_MATURITIES, issues);
  const tags = boundedStringList(
    value.tags,
    "tags",
    AI_FINDING_TAG_MAX,
    AI_FINDING_TAG_MAX_CHARS,
    issues
  );
  const routeId = optionalIdentity(value.routeId, "routeId", issues);
  const taskId = optionalIdentity(value.taskId, "taskId", issues);
  const experimentId = optionalIdentity(value.experimentId, "experimentId", issues);
  const resultItemIds = boundedStringList(
    value.resultItemIds,
    "resultItemIds",
    AI_FINDING_RELATION_ID_MAX,
    AI_FINDING_ID_MAX_CHARS,
    issues
  );
  if (title !== undefined) normalized.title = title;
  if (summary !== undefined) normalized.summary = summary;
  if (findingType !== undefined) normalized.findingType = findingType;
  if (confidence !== undefined) normalized.confidence = confidence;
  if (maturity !== undefined) normalized.maturity = maturity;
  if (tags !== undefined) normalized.tags = tags;
  if (routeId !== undefined) normalized.routeId = routeId;
  if (taskId !== undefined) normalized.taskId = taskId;
  if (experimentId !== undefined) normalized.experimentId = experimentId;
  if (resultItemIds !== undefined) normalized.resultItemIds = resultItemIds;
  return normalized;
}

async function validateRelations(
  projectId: string,
  payload: Record<string, unknown>,
  issues: AIStandardResultValidationIssue[],
  dependencies: AIFindingStandardResultDependencies
): Promise<void> {
  const routeId = typeof payload.routeId === "string" ? payload.routeId : undefined;
  if (routeId) {
    const route = await dependencies.getRouteNodeById(routeId);
    if (!route || route.status === "archived") {
      issues.push(issue("FINDING_ROUTE_UNAVAILABLE", "routeId is missing or archived.", "routeId"));
    } else if (route.projectId !== projectId) {
      issues.push(issue("FINDING_ROUTE_PROJECT_MISMATCH", "routeId is outside the target Project.", "routeId"));
    }
  }
  const taskId = typeof payload.taskId === "string" ? payload.taskId : undefined;
  if (taskId) {
    const task = await dependencies.getTaskById(taskId);
    if (!task || task.status === "archived" || task.captureState === "archived" || task.archivedAt) {
      issues.push(issue("FINDING_TASK_UNAVAILABLE", "taskId is missing or archived.", "taskId"));
    } else if (task.projectId !== projectId) {
      issues.push(issue("FINDING_TASK_PROJECT_MISMATCH", "taskId is outside the target Project.", "taskId"));
    }
  }
  const experimentId = typeof payload.experimentId === "string" ? payload.experimentId : undefined;
  if (experimentId) {
    const experiment = await dependencies.getExperimentById(experimentId);
    if (!experiment || experiment.status === "archived") {
      issues.push(issue(
        "FINDING_EXPERIMENT_UNAVAILABLE",
        "experimentId is missing or archived.",
        "experimentId"
      ));
    } else if (experiment.projectId !== projectId) {
      issues.push(issue(
        "FINDING_EXPERIMENT_PROJECT_MISMATCH",
        "experimentId is outside the target Project.",
        "experimentId"
      ));
    }
  }
  const resultItemIds = Array.isArray(payload.resultItemIds)
    ? payload.resultItemIds.filter((value): value is string => typeof value === "string")
    : [];
  for (const resultItemId of resultItemIds) {
    const resultItem = await dependencies.getResultItemById(resultItemId);
    if (!resultItem) {
      issues.push(issue(
        "FINDING_RESULT_ITEM_UNAVAILABLE",
        `resultItemIds contains a missing ResultItem: ${resultItemId}.`,
        "resultItemIds"
      ));
    } else if (resultItem.projectId !== projectId) {
      issues.push(issue(
        "FINDING_RESULT_ITEM_PROJECT_MISMATCH",
        `ResultItem ${resultItemId} is outside the target Project.`,
        "resultItemIds"
      ));
    }
  }
}

export async function validateAIFindingStandardResultProposal(
  input: {
    action: AIStandardResultAction;
    target: AIStandardResultTarget;
    source?: AIParseDraftSourceSnapshot;
    payload: unknown;
    expectedProjectId: string;
  },
  dependencies: AIFindingStandardResultDependencies = DEFAULT_DEPENDENCIES
): Promise<AIFindingStandardResultValidation> {
  const issues: AIStandardResultValidationIssue[] = [];
  if (input.action !== "CREATE") {
    issues.push(issue(
      "FINDING_ACTION_UNSUPPORTED",
      "C4 supports only Finding CREATE.",
      "action"
    ));
  }
  if (input.target.module !== "finding" || input.target.entityType !== "finding") {
    issues.push(issue(
      "FINDING_TARGET_UNSUPPORTED",
      "Finding CREATE requires the exact canonical finding target.",
      "target"
    ));
  }
  const target = input.target as FindingTarget;
  if (
    !input.expectedProjectId.trim() || target.projectId !== input.expectedProjectId ||
    !input.source || input.source.projectId !== input.expectedProjectId
  ) {
    issues.push(issue(
      "FINDING_PROJECT_SCOPE_MISMATCH",
      "Finding CREATE Project is bound to the canonical Parse Draft source, not the payload.",
      "target.projectId"
    ));
  }
  const normalizedPayload = normalizePayload(input.payload, issues);
  if (target.projectId) {
    const project = await dependencies.getProjectById(target.projectId);
    if (!project || project.status === "archived") {
      issues.push(issue(
        "FINDING_PROJECT_UNAVAILABLE",
        "The target Project is missing or archived.",
        "target.projectId"
      ));
    }
    await validateRelations(target.projectId, normalizedPayload, issues, dependencies);
  }
  return {
    executable: issues.length === 0,
    normalizedPayload,
    validationIssues: issues
  };
}

export class AIFindingEffectUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AIFindingEffectUnknownError";
  }
}

export class AIFindingEffectNoEffectError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AIFindingEffectNoEffectError";
  }
}

function createInput(
  projectId: string,
  payload: Record<string, unknown>
): CreateFindingInput {
  return {
    projectId,
    title: payload.title as string,
    ...(typeof payload.summary === "string" ? { summary: payload.summary } : {}),
    ...(typeof payload.findingType === "string" ? { findingType: payload.findingType as FindingType } : {}),
    ...(typeof payload.confidence === "string" ? { confidence: payload.confidence as FindingConfidence } : {}),
    ...(typeof payload.maturity === "string" ? { maturity: payload.maturity as FindingMaturity } : {}),
    ...(Array.isArray(payload.tags) ? { tags: payload.tags as string[] } : {}),
    ...(typeof payload.routeId === "string" ? { routeId: payload.routeId } : {}),
    ...(typeof payload.taskId === "string" ? { taskId: payload.taskId } : {}),
    ...(typeof payload.experimentId === "string" ? { experimentId: payload.experimentId } : {}),
    ...(Array.isArray(payload.resultItemIds) ? { resultItemIds: payload.resultItemIds as string[] } : {})
  };
}

function exactOptionalValue(actual: unknown, expected: unknown): boolean {
  return (actual ?? undefined) === (expected ?? undefined);
}

export async function invokeAIFindingStandardResultEffect(
  input: {
    result: AIStandardResult;
    normalizedPayload: Record<string, unknown>;
  },
  dependencies: AIFindingStandardResultDependencies = DEFAULT_DEPENDENCIES
): Promise<AIStandardResultEffectReceipt> {
  const { result } = input;
  if (
    result.category !== "DATA_OPERATION" || result.action !== "CREATE" ||
    result.target.module !== "finding" || result.target.entityType !== "finding"
  ) {
    throw new AIFindingEffectNoEffectError(
      "FINDING_EFFECT_UNSUPPORTED",
      "Only DATA_OPERATION + CREATE + finding can reach the C4 formal effect."
    );
  }
  if (
    !result.confirmationStartedAt || !result.authorizationId || !result.confirmedPayload ||
    !result.confirmedPayloadFingerprint
  ) {
    throw new AIFindingEffectNoEffectError(
      "FINDING_CONFIRMATION_REQUIRED",
      "A durable explicit Standard Result confirmation is required before Finding CREATE."
    );
  }
  const validation = await validateAIFindingStandardResultProposal({
    action: result.action,
    target: result.target,
    source: result.source,
    payload: input.normalizedPayload,
    expectedProjectId: result.source.projectId
  }, dependencies);
  if (!validation.executable || validation.validationIssues.length > 0) {
    throw new AIFindingEffectNoEffectError(
      "FINDING_EFFECT_VALIDATION_FAILED",
      validation.validationIssues.map((candidate) => candidate.message).join(" ") ||
        "Finding CREATE failed deterministic validation."
    );
  }

  let createdId = "";
  try {
    const created = await dependencies.createFinding(
      createInput(result.target.projectId, validation.normalizedPayload)
    );
    createdId = created.id;
    const finding = await dependencies.getFindingById(created.id);
    const relations = await dependencies.queryRelations({
      targetType: "finding",
      targetId: created.id,
      sourceType: "resultItem",
      relationType: "evidence_for"
    });
    const expectedResultItemIds = Array.isArray(validation.normalizedPayload.resultItemIds)
      ? validation.normalizedPayload.resultItemIds as string[]
      : [];
    const actualResultItemIds = [...new Set(relations.map((relation) => relation.sourceId))]
      .sort((left, right) => left.localeCompare(right));
    const expectedTags = Array.isArray(validation.normalizedPayload.tags)
      ? validation.normalizedPayload.tags as string[]
      : [];
    if (
      !finding || !finding.id || finding.id !== created.id ||
      finding.projectId !== result.target.projectId ||
      finding.title !== validation.normalizedPayload.title ||
      finding.summary !== (validation.normalizedPayload.summary ?? "") ||
      finding.status !== "pending_confirmation" ||
      !exactOptionalValue(finding.findingType, validation.normalizedPayload.findingType) ||
      !exactOptionalValue(finding.confidence, validation.normalizedPayload.confidence) ||
      !exactOptionalValue(finding.maturity, validation.normalizedPayload.maturity) ||
      !exactOptionalValue(finding.routeId, validation.normalizedPayload.routeId) ||
      !exactOptionalValue(finding.taskId, validation.normalizedPayload.taskId) ||
      !exactOptionalValue(finding.experimentId, validation.normalizedPayload.experimentId) ||
      JSON.stringify(finding.tags ?? []) !== JSON.stringify(expectedTags) ||
      JSON.stringify(actualResultItemIds) !== JSON.stringify(expectedResultItemIds)
    ) {
      throw new Error("The canonical Finding authoritative readback does not match the confirmed operation.");
    }
    return {
      module: "finding",
      entityType: "finding",
      entityId: finding.id,
      operation: "CREATE",
      service: "outputConversionService.createFinding",
      canonicalReadback: {
        id: finding.id,
        projectId: finding.projectId,
        title: finding.title,
        summary: finding.summary,
        status: finding.status,
        findingType: finding.findingType ?? null,
        confidence: finding.confidence ?? null,
        maturity: finding.maturity ?? null,
        tags: [...finding.tags],
        routeId: finding.routeId ?? null,
        taskId: finding.taskId ?? null,
        experimentId: finding.experimentId ?? null,
        resultItemIds: actualResultItemIds,
        resultId: result.id,
        authorizationId: result.authorizationId,
        confirmedPayloadFingerprint: result.confirmedPayloadFingerprint
      }
    };
  } catch (error) {
    throw new AIFindingEffectUnknownError(
      `${createdId ? "Finding CREATE committed or began readback" : "Finding CREATE crossed the business-effect boundary"}; automatic retry is disabled. ${error instanceof Error ? error.message : "Authoritative outcome is unknown."}`
    );
  }
}
