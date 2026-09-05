import type {
  AIParseDraftSourceSnapshot,
  AIStandardResult,
  AIStandardResultAction,
  AIStandardResultEffectReceipt,
  AIStandardResultTarget,
  AIStandardResultValidationIssue
} from "../types/aiStandardResult";
import type {
  CreateExperimentInput,
  Experiment,
  ExperimentRating,
  ExperimentStatus,
  UpdateExperimentInput
} from "../types/experiment";
import { manuscriptBindingService } from "./manuscriptBindingService";
import { planningService } from "./planningService";
import {
  ExperimentManuscriptProvisioningPreflightError,
  experimentService
} from "./experimentService";
import {
  canonicalAIStandardResultFingerprint,
  readAIStandardResultBlockingValidationIssues
} from "./aiStandardResultService";

export const AI_EXPERIMENT_TITLE_MAX_CHARS = 200;
export const AI_EXPERIMENT_SUMMARY_MAX_CHARS = 4_000;
export const AI_EXPERIMENT_TAG_MAX_CHARS = 60;
export const AI_EXPERIMENT_TAG_MAX = 12;

const ACTIVE_STATUSES = new Set<Exclude<ExperimentStatus, "archived">>([
  "planned",
  "running",
  "completed",
  "paused",
  "failed"
]);
const RATINGS = new Set<ExperimentRating>([
  "excellent",
  "good",
  "usable",
  "inconclusive",
  "failed"
]);
const EDITABLE_FIELDS = new Set([
  "title",
  "purposeAndQuestion",
  "conditionSummary",
  "methodSummary",
  "resultSummary",
  "conclusionAndNextSteps",
  "other",
  "status",
  "rating",
  "routeId",
  "taskId",
  "tags",
  "usableForPaper",
  "usableForReport",
  "usableForPatent"
]);
const OPERATION_MARKERS_FIELD = "lp13B1A10StandardResultOperations";

type ExperimentTarget = Extract<AIStandardResultTarget, { module: "experiment" }>;

type ExperimentServices = Pick<
  typeof experimentService,
  | "createExperiment"
  | "updateExperiment"
  | "getExperimentById"
  | "getExperimentsByProject"
>;
type PlanningServices = Pick<
  typeof planningService,
  "getProjectById" | "getRouteNodeById" | "getTaskById"
>;
type BindingServices = Pick<typeof manuscriptBindingService, "getBindingByOwner">;

export type AIExperimentStandardResultDependencies = {
  experiments: ExperimentServices;
  planning: PlanningServices;
  bindings: BindingServices;
};

const defaultDependencies: AIExperimentStandardResultDependencies = {
  experiments: experimentService,
  planning: planningService,
  bindings: manuscriptBindingService
};

export type AIExperimentStandardResultValidation = {
  executable: boolean;
  normalizedPayload: Record<string, unknown>;
  validationIssues: AIStandardResultValidationIssue[];
  targetSnapshotFingerprint?: string;
};

type ExperimentOperationMarker = {
  version: 1;
  action: "CREATE" | "UPDATE";
  resultId: string;
  authorizationId: string;
  confirmedPayloadFingerprint: string;
};

export class AIExperimentEffectUnknownError extends Error {
  readonly effectMayExist = true;

  constructor(message: string, readonly causeValue?: unknown) {
    super(message);
    this.name = "AIExperimentEffectUnknownError";
  }
}

export class AIExperimentEffectNoEffectError extends Error {
  readonly effectProvenAbsent = true;

  constructor(readonly code: string, message: string, readonly causeValue?: unknown) {
    super(message);
    this.name = "AIExperimentEffectNoEffectError";
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
    issues.push(issue("EXPERIMENT_FIELD_INVALID", `${field} must contain 1-${maxChars} characters.`, field));
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
  if (
    typeof value !== "string" || value !== value.trim() || !value ||
    Array.from(value).length > 200 || /[\0-\x1F\x7F]/u.test(value)
  ) {
    issues.push(issue("EXPERIMENT_RELATION_ID_INVALID", `${field} must be a bounded canonical identity or null.`, field));
    return undefined;
  }
  return value;
}

function normalizeTags(value: unknown, issues: AIStandardResultValidationIssue[]): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) || value.length > AI_EXPERIMENT_TAG_MAX ||
    value.some((tag) => (
      typeof tag !== "string" || !tag.trim() || tag.includes("\0") ||
      Array.from(tag.trim()).length > AI_EXPERIMENT_TAG_MAX_CHARS
    ))
  ) {
    issues.push(issue(
      "EXPERIMENT_TAGS_INVALID",
      `tags must contain at most ${AI_EXPERIMENT_TAG_MAX} values of at most ${AI_EXPERIMENT_TAG_MAX_CHARS} characters.`,
      "tags"
    ));
    return undefined;
  }
  const normalized = value.map((tag) => (tag as string).trim());
  if (new Set(normalized).size !== normalized.length) {
    issues.push(issue("EXPERIMENT_TAGS_INVALID", "tags must not contain duplicate values.", "tags"));
    return undefined;
  }
  return normalized;
}

function normalizePayload(
  action: "CREATE" | "UPDATE",
  value: unknown,
  issues: AIStandardResultValidationIssue[]
): Record<string, unknown> {
  const payload = asRecord(value);
  if (!payload) {
    issues.push(issue("EXPERIMENT_PAYLOAD_INVALID", "The visible Experiment payload must be one JSON object."));
    return {};
  }
  for (const key of Object.keys(payload)) {
    if (!EDITABLE_FIELDS.has(key)) {
      issues.push(issue(
        "EXPERIMENT_FIELD_UNSUPPORTED",
        `${key} is not an editable Experiment Standard Result field.`,
        key
      ));
    }
  }
  if (action === "UPDATE" && Object.keys(payload).length === 0) {
    issues.push(issue("EXPERIMENT_UPDATE_EMPTY", "Experiment UPDATE requires at least one visible field change."));
  }
  const normalized: Record<string, unknown> = {};
  if (action === "CREATE" || hasOwn(payload, "title")) {
    const title = boundedRequiredText(payload.title, "title", AI_EXPERIMENT_TITLE_MAX_CHARS, issues);
    if (title !== undefined) normalized.title = title;
  }
  for (const field of [
    "purposeAndQuestion",
    "conditionSummary",
    "methodSummary",
    "resultSummary",
    "conclusionAndNextSteps",
    "other"
  ] as const) {
    if (action === "CREATE" || hasOwn(payload, field)) {
      const normalizedText = boundedOptionalText(
        payload[field],
        field,
        AI_EXPERIMENT_SUMMARY_MAX_CHARS,
        issues
      );
      if (normalizedText !== undefined) normalized[field] = normalizedText;
      else if (hasOwn(payload, field)) normalized[field] = undefined;
    }
  }
  if (action === "CREATE" || hasOwn(payload, "status")) {
    const status = payload.status ?? "planned";
    if (typeof status !== "string" || !ACTIVE_STATUSES.has(status as Exclude<ExperimentStatus, "archived">)) {
      issues.push(issue("EXPERIMENT_STATUS_INVALID", "status must be one supported non-archived Experiment status.", "status"));
    } else normalized.status = status;
  }
  if (hasOwn(payload, "rating")) {
    const rating = payload.rating;
    if (rating === null || rating === "") normalized.rating = undefined;
    else if (typeof rating !== "string" || !RATINGS.has(rating as ExperimentRating)) {
      issues.push(issue("EXPERIMENT_RATING_INVALID", "rating is unsupported.", "rating"));
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
  for (const field of ["usableForPaper", "usableForReport", "usableForPatent"] as const) {
    if (action === "CREATE" || hasOwn(payload, field)) {
      const value = payload[field] ?? false;
      if (typeof value !== "boolean") {
        issues.push(issue("EXPERIMENT_BOOLEAN_INVALID", `${field} must be boolean.`, field));
      } else normalized[field] = value;
    }
  }
  if (action === "CREATE" && !hasOwn(normalized, "resultSummary")) normalized.resultSummary = "";
  return normalized;
}

function experimentSnapshotFingerprint(experiment: Experiment): string {
  return canonicalAIStandardResultFingerprint({
    id: experiment.id,
    projectId: experiment.projectId,
    routeId: experiment.routeId ?? null,
    taskId: experiment.taskId ?? null,
    title: experiment.title,
    purposeAndQuestion: experiment.purposeAndQuestion ?? null,
    conditionSummary: experiment.conditionSummary ?? null,
    methodSummary: experiment.methodSummary ?? null,
    resultSummary: experiment.resultSummary,
    conclusionAndNextSteps: experiment.conclusionAndNextSteps ?? null,
    other: experiment.other ?? null,
    status: experiment.status,
    rating: experiment.rating ?? null,
    tags: [...experiment.tags],
    usableForPaper: experiment.usableForPaper,
    usableForReport: experiment.usableForReport,
    usableForPatent: experiment.usableForPatent,
    updatedAt: experiment.updatedAt,
    deletedAt: experiment.deletedAt ?? null
  });
}

async function validateFrozenSource(input: {
  source?: AIParseDraftSourceSnapshot;
  expectedProjectId: string;
  target: ExperimentTarget;
  action: AIStandardResultAction;
  dependencies: AIExperimentStandardResultDependencies;
  issues: AIStandardResultValidationIssue[];
}): Promise<Experiment[]> {
  const sourceIds = input.source?.selectedExperimentIds ?? [];
  if (!input.source) {
    input.issues.push(issue(
      "EXPERIMENT_SOURCE_SCOPE_REQUIRED",
      "Experiment Standard Results require a frozen canonical source snapshot."
    ));
    return [];
  }
  if (input.action !== "CREATE" && sourceIds.length === 0) {
    input.issues.push(issue(
      "EXPERIMENT_SOURCE_SCOPE_REQUIRED",
      "Existing-Experiment operations require a frozen source containing the canonical Experiment target."
    ));
    return [];
  }
  if (
    input.source.projectId !== input.expectedProjectId ||
    input.source.conversationId.trim().length === 0
  ) {
    input.issues.push(issue("EXPERIMENT_SOURCE_SCOPE_MISMATCH", "The frozen Experiment source scope is mismatched."));
  }
  if (
    input.action !== "CREATE" &&
    (!input.target.entityId || !sourceIds.includes(input.target.entityId))
  ) {
    input.issues.push(issue(
      "EXPERIMENT_TARGET_OUTSIDE_FROZEN_SCOPE",
      "The existing Experiment target is outside the frozen selected Experiment source scope.",
      "target.entityId"
    ));
  }
  const resolved = await Promise.all(sourceIds.map((id) => input.dependencies.experiments.getExperimentById(id)));
  for (const [index, experiment] of resolved.entries()) {
    if (!experiment || experiment.deletedAt || experiment.status === "archived") {
      input.issues.push(issue(
        "EXPERIMENT_SOURCE_UNAVAILABLE",
        `Frozen source Experiment ${sourceIds[index]} is unavailable; re-parse is required.`
      ));
    } else if (experiment.projectId !== input.expectedProjectId) {
      input.issues.push(issue(
        "EXPERIMENT_SOURCE_SCOPE_MISMATCH",
        `Frozen source Experiment ${experiment.id} no longer belongs to the reviewed Project.`
      ));
    }
  }
  return resolved.filter((candidate): candidate is Experiment => Boolean(candidate));
}

async function validateRelations(input: {
  projectId: string;
  routeId: string | null | undefined;
  taskId: string | null | undefined;
  dependencies: AIExperimentStandardResultDependencies;
  issues: AIStandardResultValidationIssue[];
}) {
  const [route, task] = await Promise.all([
    input.routeId ? input.dependencies.planning.getRouteNodeById(input.routeId) : undefined,
    input.taskId ? input.dependencies.planning.getTaskById(input.taskId) : undefined
  ]);
  if (input.routeId && (!route || route.deletedAt || route.projectId !== input.projectId)) {
    input.issues.push(issue(
      "EXPERIMENT_ROUTE_SCOPE_MISMATCH",
      "routeId is unavailable in the reviewed Project.",
      "routeId"
    ));
  }
  if (input.taskId && (!task || task.deletedAt || task.projectId !== input.projectId)) {
    input.issues.push(issue(
      "EXPERIMENT_TASK_SCOPE_MISMATCH",
      "taskId is unavailable in the reviewed Project.",
      "taskId"
    ));
  }
  const taskRouteId = task
    ? ((task as typeof task & { milestoneId?: string | null }).milestoneId ?? task.routeNodeId)
    : undefined;
  if (input.routeId && taskRouteId && input.routeId !== taskRouteId) {
    input.issues.push(issue(
      "EXPERIMENT_RELATION_CONFLICT",
      "The linked Task route conflicts with routeId.",
      "taskId"
    ));
  }
}

export async function validateAIExperimentStandardResultProposal(input: {
  action: AIStandardResultAction;
  target: AIStandardResultTarget;
  source?: AIParseDraftSourceSnapshot;
  payload: unknown;
  expectedProjectId: string;
  expectedTargetSnapshotFingerprint?: string;
  dependencies?: AIExperimentStandardResultDependencies;
}): Promise<AIExperimentStandardResultValidation> {
  const dependencies = input.dependencies ?? defaultDependencies;
  const issues: AIStandardResultValidationIssue[] = [];
  if (input.target.module !== "experiment" || input.target.entityType !== "experiment") {
    return {
      executable: false,
      normalizedPayload: {},
      validationIssues: [issue("EXPERIMENT_TARGET_INVALID", "The Experiment adapter requires an exact Experiment target descriptor.")]
    };
  }
  if (input.target.projectId !== input.expectedProjectId) {
    issues.push(issue(
      "EXPERIMENT_SCOPE_MISMATCH",
      "The proposed Experiment scope crosses the reviewed Project.",
      "target.projectId"
    ));
  }
  await validateFrozenSource({
    source: input.source,
    expectedProjectId: input.expectedProjectId,
    target: input.target,
    action: input.action,
    dependencies,
    issues
  });
  const project = await dependencies.planning.getProjectById(input.expectedProjectId);
  if (!project || project.deletedAt || project.status === "archived") {
    issues.push(issue("EXPERIMENT_PROJECT_UNAVAILABLE", "The reviewed canonical Project is unavailable."));
  }

  let existing: Experiment | undefined;
  if (input.action !== "CREATE") {
    existing = input.target.entityId
      ? await dependencies.experiments.getExperimentById(input.target.entityId)
      : undefined;
    if (!existing || existing.deletedAt) {
      issues.push(issue("EXPERIMENT_TARGET_UNAVAILABLE", "The canonical Experiment target is missing or deleted."));
    } else if (existing.projectId !== input.expectedProjectId) {
      issues.push(issue("EXPERIMENT_SCOPE_MISMATCH", "The canonical Experiment target moved outside the reviewed Project."));
    } else if (existing.status === "archived") {
      issues.push(issue("EXPERIMENT_TARGET_LIFECYCLE_UNSUPPORTED", "Archived Experiments cannot be changed from a Standard Result."));
    }
  }
  const currentTargetFingerprint = existing ? experimentSnapshotFingerprint(existing) : undefined;
  if (
    input.expectedTargetSnapshotFingerprint &&
    currentTargetFingerprint !== input.expectedTargetSnapshotFingerprint
  ) {
    issues.push(issue("EXPERIMENT_TARGET_STALE", "The canonical Experiment changed after Parse Draft; re-parse is required."));
  }

  if (input.action === "DELETE_SUGGESTION") {
    const payload = asRecord(input.payload);
    if (!payload || Object.keys(payload).some((key) => key !== "reason")) {
      issues.push(issue("EXPERIMENT_DELETE_SUGGESTION_INVALID", "DELETE_SUGGESTION accepts exactly one reason field."));
    }
    const reason = boundedRequiredText(payload?.reason, "reason", 1_000, issues);
    return {
      executable: false,
      normalizedPayload: reason ? { reason } : {},
      validationIssues: readAIStandardResultBlockingValidationIssues(issues).length > 0
        ? issues
        : [issue(
            "DELETE_SUGGESTION_INFORMATIONAL_ONLY",
            "DELETE_SUGGESTION has no AI executor; use the existing Experiment deletion flow."
          )],
      ...(currentTargetFingerprint ? { targetSnapshotFingerprint: currentTargetFingerprint } : {})
    };
  }
  if (input.action === "NEW_MANUSCRIPT") {
    return {
      executable: false,
      normalizedPayload: asRecord(input.payload) ?? {},
      validationIssues: [
        ...issues,
        issue(
          "EXPERIMENT_NEW_MANUSCRIPT_NOT_ENABLED_IN_A10",
          "Experiment NEW_MANUSCRIPT is recognized by the shared contract but is not executable in LP13-B1-A10."
        )
      ],
      ...(currentTargetFingerprint ? { targetSnapshotFingerprint: currentTargetFingerprint } : {})
    };
  }
  if (input.action !== "CREATE" && input.action !== "UPDATE") {
    return {
      executable: false,
      normalizedPayload: {},
      validationIssues: [...issues, issue("EXPERIMENT_ACTION_UNSUPPORTED", "The Experiment action is unsupported.")]
    };
  }
  const normalizedPayload = normalizePayload(input.action, input.payload, issues);
  const resultingRouteId = hasOwn(normalizedPayload, "routeId")
    ? normalizedPayload.routeId as string | null | undefined
    : existing?.routeId;
  const resultingTaskId = hasOwn(normalizedPayload, "taskId")
    ? normalizedPayload.taskId as string | null | undefined
    : existing?.taskId;
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
    ...(currentTargetFingerprint ? { targetSnapshotFingerprint: currentTargetFingerprint } : {})
  };
}

function operationMarker(result: AIStandardResult): ExperimentOperationMarker {
  if (
    (result.action !== "CREATE" && result.action !== "UPDATE") ||
    !result.authorizationId || !result.confirmedPayloadFingerprint
  ) {
    throw new AIExperimentEffectNoEffectError(
      "EXPERIMENT_OPERATION_BINDING_INVALID",
      "The claimed Experiment Result has no exact operation/authorization/payload binding."
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

function readOperationMarkers(experiment: Experiment): ExperimentOperationMarker[] {
  const candidate = experiment.legacy?.[OPERATION_MARKERS_FIELD];
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

function markerMatches(experiment: Experiment, expected: ExperimentOperationMarker): boolean {
  return readOperationMarkers(experiment).some((marker) => (
    marker.action === expected.action &&
    marker.resultId === expected.resultId &&
    marker.authorizationId === expected.authorizationId &&
    marker.confirmedPayloadFingerprint === expected.confirmedPayloadFingerprint
  ));
}

function legacyWithMarker(experiment: Experiment | undefined, marker: ExperimentOperationMarker) {
  const prior = experiment ? readOperationMarkers(experiment) : [];
  const withoutCurrent = prior.filter((candidate) => candidate.resultId !== marker.resultId);
  return {
    ...(experiment?.legacy ?? {}),
    [OPERATION_MARKERS_FIELD]: [...withoutCurrent, marker]
  };
}

function canonicalExperimentReadback(
  experiment: Experiment,
  marker: ExperimentOperationMarker,
  provisioning?: Record<string, unknown>
): Record<string, unknown> {
  return {
    id: experiment.id,
    projectId: experiment.projectId,
    routeId: experiment.routeId ?? null,
    taskId: experiment.taskId ?? null,
    title: experiment.title,
    purposeAndQuestion: experiment.purposeAndQuestion ?? null,
    conditionSummary: experiment.conditionSummary ?? null,
    methodSummary: experiment.methodSummary ?? null,
    resultSummary: experiment.resultSummary,
    conclusionAndNextSteps: experiment.conclusionAndNextSteps ?? null,
    other: experiment.other ?? null,
    status: experiment.status,
    rating: experiment.rating ?? null,
    tags: [...experiment.tags],
    usableForPaper: experiment.usableForPaper,
    usableForReport: experiment.usableForReport,
    usableForPatent: experiment.usableForPatent,
    updatedAt: experiment.updatedAt,
    operationId: marker.resultId,
    authorizationId: marker.authorizationId,
    confirmedPayloadFingerprint: marker.confirmedPayloadFingerprint,
    ...(provisioning ? { serviceOwnedCreateProvisioning: provisioning } : {})
  };
}

async function canonicalExperimentReceipt(input: {
  experiment: Experiment;
  marker: ExperimentOperationMarker;
  target: ExperimentTarget;
  dependencies: AIExperimentStandardResultDependencies;
}): Promise<AIStandardResultEffectReceipt> {
  const readback = await input.dependencies.experiments.getExperimentById(input.experiment.id);
  if (
    !readback || readback.deletedAt || readback.status === "archived" ||
    readback.projectId !== input.target.projectId ||
    !markerMatches(readback, input.marker)
  ) {
    throw new AIExperimentEffectUnknownError(
      "The canonical Experiment effect readback is unavailable or has no exact Result operation binding."
    );
  }
  let provisioning: Record<string, unknown> | undefined;
  if (input.marker.action === "CREATE") {
    const binding = await input.dependencies.bindings.getBindingByOwner(
      "experiment",
      readback.id,
      "primary"
    );
    if (
      !binding?.defaultFolderFileRefId ||
      !binding.defaultManuscriptFileRefId ||
      !binding.currentFileRefId
    ) {
      throw new AIExperimentEffectUnknownError(
        "Experiment CREATE exists but canonical service-owned primary manuscript initialization is incomplete."
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
    module: "experiment",
    entityType: "experiment",
    entityId: readback.id,
    operation: input.marker.action,
    service: input.marker.action === "CREATE"
      ? "experimentService.createExperiment"
      : "experimentService.updateExperiment",
    canonicalReadback: canonicalExperimentReadback(readback, input.marker, provisioning)
  };
}

export async function readAIExperimentStandardResultEffect(input: {
  result: AIStandardResult;
  dependencies?: AIExperimentStandardResultDependencies;
}): Promise<AIStandardResultEffectReceipt | undefined> {
  const dependencies = input.dependencies ?? defaultDependencies;
  if (input.result.target.module !== "experiment") return undefined;
  const marker = operationMarker(input.result);
  if (marker.action === "CREATE") {
    const experiments = await dependencies.experiments.getExperimentsByProject(
      input.result.target.projectId
    );
    const matches = experiments.filter((experiment) => markerMatches(experiment, marker));
    if (matches.length > 1) {
      throw new AIExperimentEffectUnknownError(
        "One Experiment CREATE Result operation resolved to multiple canonical Experiments."
      );
    }
    return matches[0]
      ? canonicalExperimentReceipt({
          experiment: matches[0],
          marker,
          target: input.result.target,
          dependencies
        })
      : undefined;
  }
  const entityId = input.result.target.entityId;
  if (!entityId) return undefined;
  const experiment = await dependencies.experiments.getExperimentById(entityId);
  if (!experiment || !markerMatches(experiment, marker)) return undefined;
  return canonicalExperimentReceipt({
    experiment,
    marker,
    target: input.result.target,
    dependencies
  });
}

export async function invokeAIExperimentStandardResultEffect(input: {
  result: AIStandardResult;
  normalizedPayload: Record<string, unknown>;
  dependencies?: AIExperimentStandardResultDependencies;
}): Promise<AIStandardResultEffectReceipt> {
  const dependencies = input.dependencies ?? defaultDependencies;
  if (input.result.target.module !== "experiment") {
    throw new AIExperimentEffectNoEffectError(
      "EXPERIMENT_TARGET_INVALID",
      "The Experiment effect adapter received a non-Experiment target."
    );
  }
  const prior = await readAIExperimentStandardResultEffect({
    result: input.result,
    dependencies
  });
  if (prior) return prior;
  const marker = operationMarker(input.result);
  if (marker.action === "CREATE") {
    try {
      const created = await dependencies.experiments.createExperiment({
        ...(input.normalizedPayload as CreateExperimentInput),
        projectId: input.result.target.projectId,
        source: "ai",
        legacy: legacyWithMarker(undefined, marker)
      });
      return await canonicalExperimentReceipt({
        experiment: created,
        marker,
        target: input.result.target,
        dependencies
      });
    } catch (error) {
      if (
        error instanceof ExperimentManuscriptProvisioningPreflightError ||
        (error instanceof Error && error.name === "ExperimentManuscriptProvisioningPreflightError")
      ) {
        throw new AIExperimentEffectNoEffectError(
          "EXPERIMENT_CREATE_PROVISIONING_PREFLIGHT_FAILED",
          error instanceof Error ? error.message : "Experiment CREATE provisioning preflight failed with zero effect.",
          error
        );
      }
      const readback = await readAIExperimentStandardResultEffect({
        result: input.result,
        dependencies
      }).catch(() => undefined);
      if (readback) return readback;
      if (error instanceof AIExperimentEffectUnknownError) throw error;
      throw new AIExperimentEffectUnknownError(
        "Experiment CREATE did not reach an authoritative marker-bound initialized readback; keep the claimed Result pending for same-operation readback/continuation.",
        error
      );
    }
  }

  const entityId = input.result.target.entityId;
  if (!entityId) {
    throw new AIExperimentEffectNoEffectError(
      "EXPERIMENT_UPDATE_TARGET_MISSING",
      "Experiment UPDATE requires one exact canonical target identity."
    );
  }
  const existing = await dependencies.experiments.getExperimentById(entityId);
  if (!existing) {
    throw new AIExperimentEffectNoEffectError(
      "EXPERIMENT_UPDATE_TARGET_UNAVAILABLE",
      "The Experiment UPDATE target is unavailable before the domain effect."
    );
  }
  try {
    const updated = await dependencies.experiments.updateExperiment(entityId, {
      ...(input.normalizedPayload as UpdateExperimentInput),
      legacy: legacyWithMarker(existing, marker)
    });
    if (!updated) {
      throw new AIExperimentEffectNoEffectError(
        "EXPERIMENT_UPDATE_ZERO_EFFECT",
        "The canonical Experiment service proved that UPDATE produced no effect."
      );
    }
    return await canonicalExperimentReceipt({
      experiment: updated,
      marker,
      target: input.result.target,
      dependencies
    });
  } catch (error) {
    if (error instanceof AIExperimentEffectNoEffectError) throw error;
    const readback = await readAIExperimentStandardResultEffect({
      result: input.result,
      dependencies
    }).catch(() => undefined);
    if (readback) return readback;
    if (error instanceof AIExperimentEffectUnknownError) throw error;
    throw new AIExperimentEffectUnknownError(
      "Experiment UPDATE did not reach an authoritative marker-bound readback; keep the claimed Result pending for same-operation readback/continuation.",
      error
    );
  }
}

export const aiExperimentStandardResultAdapter = {
  validate: validateAIExperimentStandardResultProposal,
  invoke: invokeAIExperimentStandardResultEffect,
  readEffect: readAIExperimentStandardResultEffect
};
