import type {
  AIStandardResultAction,
  AIStandardResultEffectReceipt,
  AIStandardResultTarget,
  AIStandardResultValidationIssue
} from "../types/aiStandardResult";
import type {
  RouteNode,
  RouteNodeStatus,
  RouteNodeType,
  TimePrecision,
  UpdateEntityInput
} from "../types/planning";
import { planningService } from "./planningService";
import {
  canonicalAIStandardResultFingerprint,
  readAIStandardResultBlockingValidationIssues
} from "./aiStandardResultService";

export const AI_ROUTE_TITLE_MAX_CHARS = 200;
export const AI_ROUTE_TEXT_MAX_CHARS = 4_000;
export const AI_ROUTE_TAG_MAX = 12;
export const AI_ROUTE_TAG_MAX_CHARS = 60;

const ROUTE_TYPES = new Set<RouteNodeType>([
  "literature", "experiment", "algorithm", "analysis", "writing", "output", "review", "other"
]);
const ROUTE_STATUSES = new Set<Exclude<RouteNodeStatus, "completed" | "archived">>([
  "planned", "active", "paused", "adjusted"
]);
const TIME_PRECISIONS = new Set<TimePrecision>([
  "day", "week", "month", "quarter", "phase", "free"
]);
const EDITABLE_FIELDS = new Set([
  "title",
  "description",
  "objective",
  "expectedOutput",
  "nodeType",
  "status",
  "startDate",
  "endDate",
  "timeLabel",
  "timePrecision",
  "showInGantt",
  "tags"
]);

type RouteTarget = Extract<AIStandardResultTarget, { module: "route" }>;
type RouteServices = Pick<
  typeof planningService,
  "createRouteNode" | "updateRouteNode" | "getRouteNodeById" | "getProjectById"
>;

export type AIRouteStandardResultValidation = {
  executable: boolean;
  normalizedPayload: Record<string, unknown>;
  validationIssues: AIStandardResultValidationIssue[];
  resolvedTarget?: RouteTarget;
  targetSnapshotFingerprint?: string;
};

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

function boundedText(
  value: unknown,
  field: string,
  maxChars: number,
  issues: AIStandardResultValidationIssue[],
  required = false
): string | undefined {
  if (!required && (value === undefined || value === null || value === "")) return undefined;
  if (
    typeof value !== "string" || !value.trim() || value.includes("\0") ||
    Array.from(value.trim()).length > maxChars
  ) {
    issues.push(issue("ROUTE_FIELD_INVALID", `${field} must contain 1-${maxChars} characters.`, field));
    return undefined;
  }
  return value.trim();
}

function optionalDate(
  value: unknown,
  field: string,
  issues: AIStandardResultValidationIssue[]
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (
    typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value) ||
    Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  ) {
    issues.push(issue("ROUTE_DATE_INVALID", `${field} must be a valid YYYY-MM-DD date.`, field));
    return undefined;
  }
  return value;
}

function normalizePayload(
  action: "CREATE" | "UPDATE",
  value: unknown,
  existingRoute: RouteNode | undefined,
  issues: AIStandardResultValidationIssue[]
): Record<string, unknown> {
  const payload = asRecord(value);
  if (!payload) {
    issues.push(issue("ROUTE_PAYLOAD_INVALID", "The visible Route payload must be one object."));
    return {};
  }
  for (const key of Object.keys(payload)) {
    if (!EDITABLE_FIELDS.has(key)) {
      issues.push(issue("ROUTE_FIELD_UNSUPPORTED", `${key} is not an editable Route field.`, key));
    }
  }
  if (action === "UPDATE" && Object.keys(payload).length === 0) {
    issues.push(issue("ROUTE_UPDATE_EMPTY", "Route UPDATE requires at least one visible field change."));
  }
  const normalized: Record<string, unknown> = {};
  if (action === "CREATE" || hasOwn(payload, "title")) {
    const title = boundedText(payload.title, "title", AI_ROUTE_TITLE_MAX_CHARS, issues, true);
    if (title !== undefined) normalized.title = title;
  }
  for (const field of ["description", "objective", "expectedOutput"] as const) {
    if (hasOwn(payload, field)) {
      normalized[field] = boundedText(payload[field], field, AI_ROUTE_TEXT_MAX_CHARS, issues);
    }
  }
  if (hasOwn(payload, "timeLabel")) {
    normalized.timeLabel = boundedText(payload.timeLabel, "timeLabel", 200, issues);
  }

  if (action === "CREATE" || hasOwn(payload, "nodeType")) {
    const nodeType = payload.nodeType ?? "other";
    if (typeof nodeType !== "string" || !ROUTE_TYPES.has(nodeType as RouteNodeType)) {
      issues.push(issue("ROUTE_ENUM_INVALID", "nodeType is unsupported.", "nodeType"));
    } else normalized.nodeType = nodeType;
  }

  if (action === "CREATE" || hasOwn(payload, "status")) {
    const status = payload.status ?? "planned";
    if (typeof status !== "string" || !ROUTE_STATUSES.has(status as Exclude<RouteNodeStatus, "completed" | "archived">)) {
      issues.push(issue(
        "ROUTE_ENUM_INVALID",
        "status must be a supported non-completed, non-archived Route status.",
        "status"
      ));
    } else normalized.status = status;
  }

  if (hasOwn(payload, "startDate")) {
    normalized.startDate = optionalDate(payload.startDate, "startDate", issues);
  }
  if (hasOwn(payload, "endDate")) {
    normalized.endDate = optionalDate(payload.endDate, "endDate", issues);
  }
  const resultingStartDate = normalized.startDate ?? existingRoute?.startDate;
  const resultingEndDate = normalized.endDate ?? existingRoute?.endDate;
  if (
    typeof resultingStartDate === "string" && typeof resultingEndDate === "string" &&
    resultingEndDate < resultingStartDate
  ) {
    issues.push(issue("ROUTE_DATE_ORDER_INVALID", "endDate cannot be earlier than startDate.", "endDate"));
  }

  if (hasOwn(payload, "timePrecision")) {
    if (payload.timePrecision === undefined || payload.timePrecision === null || payload.timePrecision === "") {
      normalized.timePrecision = undefined;
    } else if (
      typeof payload.timePrecision !== "string" ||
      !TIME_PRECISIONS.has(payload.timePrecision as TimePrecision)
    ) {
      issues.push(issue("ROUTE_ENUM_INVALID", "timePrecision is unsupported.", "timePrecision"));
    } else normalized.timePrecision = payload.timePrecision;
  }
  if (hasOwn(payload, "showInGantt")) {
    if (typeof payload.showInGantt !== "boolean") {
      issues.push(issue("ROUTE_FIELD_INVALID", "showInGantt must be boolean.", "showInGantt"));
    } else normalized.showInGantt = payload.showInGantt;
  }
  if (hasOwn(payload, "tags")) {
    if (
      !Array.isArray(payload.tags) || payload.tags.length > AI_ROUTE_TAG_MAX ||
      payload.tags.some((tag) => (
        typeof tag !== "string" || !tag.trim() || tag.includes("\0") ||
        Array.from(tag.trim()).length > AI_ROUTE_TAG_MAX_CHARS
      ))
    ) {
      issues.push(issue(
        "ROUTE_TAGS_INVALID",
        `tags must contain at most ${AI_ROUTE_TAG_MAX} values of at most ${AI_ROUTE_TAG_MAX_CHARS} characters.`,
        "tags"
      ));
    } else {
      normalized.tags = [...new Set(payload.tags.map((tag) => (tag as string).trim()))];
    }
  }
  return normalized;
}

function routeSnapshotFingerprint(route: RouteNode): string {
  return canonicalAIStandardResultFingerprint({
    id: route.id,
    projectId: route.projectId,
    title: route.title,
    description: route.description ?? null,
    objective: route.objective ?? null,
    expectedOutput: route.expectedOutput ?? null,
    nodeType: route.nodeType,
    status: route.status,
    startDate: route.startDate ?? null,
    endDate: route.endDate ?? null,
    timeLabel: route.timeLabel ?? null,
    timePrecision: route.timePrecision ?? null,
    showInGantt: route.showInGantt ?? true,
    tags: [...route.tags],
    updatedAt: route.updatedAt,
    archivedAt: route.archivedAt ?? null,
    deletedAt: route.deletedAt ?? null
  });
}

function normalizeDeleteSuggestionPayload(
  value: unknown,
  issues: AIStandardResultValidationIssue[]
): Record<string, unknown> {
  const payload = asRecord(value);
  if (!payload || Object.keys(payload).some((key) => key !== "reason")) {
    issues.push(issue(
      "ROUTE_DELETE_SUGGESTION_INVALID",
      "DELETE_SUGGESTION accepts exactly one reason field."
    ));
  }
  const reason = boundedText(payload?.reason, "reason", 1_000, issues, true);
  return reason ? { reason } : {};
}

export async function validateAIRouteStandardResultProposal(input: {
  action: AIStandardResultAction;
  target: AIStandardResultTarget;
  payload: unknown;
  expectedProjectId: string;
  expectedTargetSnapshotFingerprint?: string;
  services?: RouteServices;
}): Promise<AIRouteStandardResultValidation> {
  const issues: AIStandardResultValidationIssue[] = [];
  const services = input.services ?? planningService;
  if (
    input.target.module !== "route" ||
    (input.action !== "CREATE" && input.action !== "UPDATE" && input.action !== "DELETE_SUGGESTION")
  ) {
    return {
      executable: false,
      normalizedPayload: {},
      validationIssues: [issue(
        "ROUTE_ACTION_UNSUPPORTED",
        "Route Standard Result supports CREATE, UPDATE, and non-executable DELETE advisory only."
      )]
    };
  }
  if (input.target.projectId !== input.expectedProjectId) {
    issues.push(issue("ROUTE_SCOPE_MISMATCH", "The proposed Route scope crosses the reviewed Project.", "target.projectId"));
  }
  const project = await services.getProjectById(input.expectedProjectId);
  if (!project || project.deletedAt) {
    issues.push(issue("ROUTE_PROJECT_UNAVAILABLE", "The reviewed Project is unavailable."));
  }
  let route: RouteNode | undefined;
  if (input.action === "UPDATE") {
    route = input.target.entityId
      ? await services.getRouteNodeById(input.target.entityId)
      : undefined;
    if (!route) {
      issues.push(issue("ROUTE_TARGET_UNAVAILABLE", "The canonical Route target is missing or deleted."));
    } else if (
      route.projectId !== input.expectedProjectId ||
      route.projectId !== input.target.projectId
    ) {
      issues.push(issue(
        "ROUTE_TARGET_SCOPE_MISMATCH",
        "The canonical Route target does not belong to the reviewed Project.",
        "target.entityId"
      ));
    } else if (route.deletedAt || route.archivedAt || route.status === "archived") {
      issues.push(issue(
        "ROUTE_TARGET_LIFECYCLE_UNSUPPORTED",
        "Deleted or archived Routes cannot be updated from a Standard Result."
      ));
    }
  }
  if (input.action === "DELETE_SUGGESTION") {
    const target = input.target;
    const existing = target.entityId
      ? await services.getRouteNodeById(target.entityId)
      : undefined;
    if (
      !existing || existing.deletedAt || existing.archivedAt || existing.status === "archived"
    ) {
      issues.push(issue(
        "ROUTE_TARGET_UNAVAILABLE",
        "The canonical Route target is missing, archived, or deleted."
      ));
    } else if (
      existing.id !== target.entityId ||
      existing.projectId !== input.expectedProjectId ||
      existing.projectId !== target.projectId
    ) {
      issues.push(issue(
        "ROUTE_TARGET_SCOPE_MISMATCH",
        "The canonical Route target does not belong to the reviewed Project.",
        "target.entityId"
      ));
    }
    const normalizedPayload = normalizeDeleteSuggestionPayload(input.payload, issues);
    const blockingIssues = readAIStandardResultBlockingValidationIssues(issues);
    return {
      executable: false,
      normalizedPayload,
      validationIssues: blockingIssues.length > 0
        ? issues
        : [issue(
            "DELETE_SUGGESTION_INFORMATIONAL_ONLY",
            "DELETE_SUGGESTION is advisory only; use the existing Route deletion flow."
          )],
      ...(existing && blockingIssues.length === 0
        ? {
            resolvedTarget: {
              module: "route",
              projectId: existing.projectId,
              entityType: "routeNode",
              entityId: existing.id
            }
          }
        : {})
    };
  }
  const normalizedPayload = normalizePayload(input.action, input.payload, route, issues);
  const currentTargetFingerprint = route ? routeSnapshotFingerprint(route) : undefined;
  if (
    input.expectedTargetSnapshotFingerprint &&
    currentTargetFingerprint !== input.expectedTargetSnapshotFingerprint
  ) {
    issues.push(issue("ROUTE_TARGET_STALE", "The canonical Route changed after Parse Draft; re-parse is required."));
  }
  return {
    executable: readAIStandardResultBlockingValidationIssues(issues).length === 0,
    normalizedPayload,
    validationIssues: issues,
    ...(currentTargetFingerprint ? { targetSnapshotFingerprint: currentTargetFingerprint } : {})
  };
}

function canonicalRouteReadback(route: RouteNode): Record<string, unknown> {
  return {
    id: route.id,
    projectId: route.projectId,
    title: route.title,
    description: route.description ?? null,
    objective: route.objective ?? null,
    expectedOutput: route.expectedOutput ?? null,
    nodeType: route.nodeType,
    status: route.status,
    startDate: route.startDate ?? null,
    endDate: route.endDate ?? null,
    timeLabel: route.timeLabel ?? null,
    timePrecision: route.timePrecision ?? null,
    showInGantt: route.showInGantt ?? true,
    tags: [...route.tags],
    updatedAt: route.updatedAt
  };
}

export async function invokeAIRouteStandardResultEffect(input: {
  action: "CREATE" | "UPDATE";
  target: RouteTarget;
  normalizedPayload: Record<string, unknown>;
  services?: RouteServices;
}): Promise<AIStandardResultEffectReceipt> {
  const services = input.services ?? planningService;
  const payload = input.normalizedPayload;
  if (input.action === "UPDATE") {
    const entityId = input.target.entityId;
    if (!entityId) throw new Error("Route UPDATE requires a canonical target identity.");
    const updated = await services.updateRouteNode(
      entityId,
      payload as UpdateEntityInput<RouteNode>
    );
    const readback = updated ? await services.getRouteNodeById(entityId) : undefined;
    if (!readback || readback.projectId !== input.target.projectId) {
      throw new Error("The canonical Route UPDATE readback did not match its reviewed target.");
    }
    return {
      module: "route",
      entityType: "routeNode",
      entityId: readback.id,
      operation: "UPDATE",
      service: "planningService.updateRouteNode",
      canonicalReadback: canonicalRouteReadback(readback)
    };
  }
  const route = await services.createRouteNode({
    projectId: input.target.projectId,
    title: payload.title as string,
    description: payload.description as string | undefined,
    objective: payload.objective as string | undefined,
    expectedOutput: payload.expectedOutput as string | undefined,
    nodeType: payload.nodeType as RouteNodeType,
    status: payload.status as Exclude<RouteNodeStatus, "completed" | "archived">,
    startDate: payload.startDate as string | undefined,
    endDate: payload.endDate as string | undefined,
    timeLabel: payload.timeLabel as string | undefined,
    timePrecision: payload.timePrecision as TimePrecision | undefined,
    showInGantt: payload.showInGantt as boolean | undefined,
    tags: (payload.tags as string[] | undefined) ?? [],
    captureState: "unscheduled",
    orderIndex: 0
  });
  const readback = await services.getRouteNodeById(route.id);
  if (!readback || readback.projectId !== input.target.projectId) {
    throw new Error("The canonical Route CREATE readback did not match its reviewed Project.");
  }
  return {
    module: "route",
    entityType: "routeNode",
    entityId: readback.id,
    operation: "CREATE",
    service: "planningService.createRouteNode",
    canonicalReadback: canonicalRouteReadback(readback)
  };
}
