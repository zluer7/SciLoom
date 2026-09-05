import type { RefreshEvent } from "../types/refresh";
import type {
  AffectedEntity,
  AffectedScope,
  WriteFeedbackResult
} from "../types/writeFeedback";
import {
  isRoutineBusinessOperationSuccess,
  projectBusinessOperationRefreshEvent,
  projectFormalBusinessAttemptFailure,
  publishFormalBusinessAttemptFailure
} from "./businessOperationFeedbackService";
import { isSilentFormalSwitchFeedback } from "./manuscriptFormalSwitchPresentation";

export type WriteFeedbackDisplaySeverity =
  | "success"
  | "info"
  | "warning"
  | "partial"
  | "skipped"
  | "error";

export type WriteFeedbackDisplayScope =
  | {
      classification: "action-local";
      page: string;
      projectId?: string;
      ownerType?: string;
      ownerId?: string;
      channel?: string;
      actionKind?: string;
    }
  | {
      classification: "owner";
      page: string;
      projectId?: string;
      ownerType: string;
      ownerId: string;
      channel?: string;
    }
  | {
      classification: "project";
      page: string;
      projectId: string;
    }
  | {
      classification: "global";
      source: string;
      systemClassification: string;
    };

export interface WriteFeedbackDisplayContext {
  page: string;
  projectId?: string;
  ownerKeys?: string[];
}

export interface WriteFeedbackDisplayEntry {
  id: string;
  severity: WriteFeedbackDisplaySeverity;
  title: string;
  summary?: string;
  operation?: string;
  operationLabel?: string;
  dedupeKey?: string;
  reason?: string;
  details: string[];
  affectedEntities: string[];
  affectedScopes: string[];
  createdAt: string;
  source: "writeFeedback" | "refreshEvent" | "pageMessage" | "reloadError";
  scope: WriteFeedbackDisplayScope;
  formalCrudTerminalPresentation?: "suppress" | "guidance-only";
}

export interface PushPageFeedbackInput {
  severity: WriteFeedbackDisplaySeverity;
  title: string;
  summary?: string;
  operation?: string;
  operationLabel?: string;
  dedupeKey?: string;
  reason?: string;
  details?: string[];
  scope: WriteFeedbackDisplayScope;
}

type Listener = () => void;

const maxEntriesPerScope = 5;
const maxTotalEntries = 50;
const dedupeWindowMs = 3500;
let entries: WriteFeedbackDisplayEntry[] = [];
const listeners = new Set<Listener>();
const recentSignatures = new Map<string, number>();
const consumedRefreshEventIds = new Set<string>();
const obviousSuccessfulOpenOperations = new Set([
  "experiment.manuscript.openCurrent",
  "experimentRun.manuscript.open",
  "output.markdown.load",
  "review.manuscript.openCurrent"
]);

function now() {
  return new Date().toISOString();
}

function notify() {
  listeners.forEach((listener) => listener());
}

function formatError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function uniqueTexts(values: Array<string | undefined>) {
  return [...new Set(values.map(cleanText).filter(Boolean))];
}

function summarizeEntity(entity: AffectedEntity) {
  const label = cleanText(entity.label);
  const relation = cleanText(entity.relation);
  const identity = label || `${entity.type}:${entity.id}`;
  return relation ? `${identity} (${relation})` : identity;
}

function summarizeScope(scope: AffectedScope) {
  const ids = [
    scope.projectId ? `project:${scope.projectId}` : "",
    scope.routeNodeId ? `route:${scope.routeNodeId}` : "",
    scope.taskId ? `task:${scope.taskId}` : "",
    scope.reviewId ? `review:${scope.reviewId}` : "",
    scope.experimentId ? `experiment:${scope.experimentId}` : "",
    scope.literatureId ? `literature:${scope.literatureId}` : "",
    scope.outputGapId ? `gap:${scope.outputGapId}` : "",
    scope.outputCandidateId ? `candidate:${scope.outputCandidateId}` : "",
    scope.researchOutputId ? `output:${scope.researchOutputId}` : ""
  ].filter(Boolean);
  return ids.length > 0 ? `${scope.module} (${ids.join(", ")})` : scope.module;
}

function missingReferenceText(feedback: WriteFeedbackResult) {
  return (feedback.missingReferences ?? []).map((reference) => {
    const relation = reference.relationType ? ` ${reference.relationType}` : "";
    return (
      reference.message ||
      `Missing reference:${relation} ${reference.targetType}:${reference.targetId}`
    );
  });
}

function severityForWriteFeedback(
  feedback: WriteFeedbackResult
): WriteFeedbackDisplaySeverity {
  if (feedback.errors.length > 0 || feedback.status === "error") {
    return "error";
  }
  if (feedback.status === "partial" || feedback.partial) {
    return "partial";
  }
  if (feedback.skipped.length > 0 || feedback.status === "skipped") {
    return "skipped";
  }
  if (feedback.warnings.length > 0 || (feedback.missingReferences?.length ?? 0) > 0) {
    return "warning";
  }
  return feedback.status === "success" ? "success" : "info";
}

function isUserCancelledWriteFeedback(feedback: WriteFeedbackResult) {
  return feedback.messages.some((message) => message.code === "user_cancelled");
}

function formalCrudTerminalPresentation(
  terminal: ReturnType<typeof projectBusinessOperationRefreshEvent>,
  operation: string | undefined,
  cleanSuccess: boolean
): WriteFeedbackDisplayEntry["formalCrudTerminalPresentation"] {
  if (cleanSuccess && isRoutineBusinessOperationSuccess(operation, terminal)) return "suppress";
  if (terminal?.result === "failure") return "guidance-only";
  return undefined;
}

function projectWriteFeedbackBusinessTerminal(feedback: WriteFeedbackResult) {
  if (isUserCancelledWriteFeedback(feedback)) return undefined;
  return projectBusinessOperationRefreshEvent({
    id: `write-feedback-display:${feedback.operation}`,
    keys: feedback.refreshKeys,
    affectedEntities: feedback.affectedEntities,
    affectedScopes: feedback.affectedScopes,
    source: "service.write",
    operation: feedback.operation,
    writeFeedbackStatus: feedback.status === "skipped" ? "error" : feedback.status,
    warnings: feedback.warnings,
    errors: feedback.errors,
    skipped: feedback.skipped,
    createdAt: feedback.createdAt ?? now()
  });
}

function projectRefreshBusinessTerminal(event: RefreshEvent) {
  return projectBusinessOperationRefreshEvent(
    event.writeFeedbackStatus === "skipped"
      ? { ...event, writeFeedbackStatus: "error" }
      : event
  );
}

function severityForRefreshEvent(event: RefreshEvent): WriteFeedbackDisplaySeverity {
  if ((event.errors?.length ?? 0) > 0 || event.writeFeedbackStatus === "error") {
    return "error";
  }
  if (event.writeFeedbackStatus === "partial") {
    return "partial";
  }
  if ((event.skipped?.length ?? 0) > 0 || event.writeFeedbackStatus === "skipped") {
    return "skipped";
  }
  if ((event.warnings?.length ?? 0) > 0) {
    return "warning";
  }
  return "info";
}

function titleForSeverity(severity: WriteFeedbackDisplaySeverity) {
  if (severity === "error") return "Action failed";
  if (severity === "partial") return "Completed with partial result";
  if (severity === "skipped") return "Action skipped";
  if (severity === "warning") return "Completed with notice";
  if (severity === "success") return "Action completed";
  return "Write feedback";
}

function createId(source: WriteFeedbackDisplayEntry["source"]) {
  return `${source}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

export function createFeedbackOwnerKey(
  ownerType: string,
  ownerId: string,
  channel?: string
) {
  return [ownerType, ownerId, channel ?? ""].join(":");
}

function scopeKey(scope: WriteFeedbackDisplayScope) {
  if (scope.classification === "global") {
    return [scope.classification, scope.source, scope.systemClassification].join(":");
  }
  return [
    scope.classification,
    scope.page,
    scope.projectId ?? "",
    "ownerType" in scope ? scope.ownerType ?? "" : "",
    "ownerId" in scope ? scope.ownerId ?? "" : "",
    "channel" in scope ? scope.channel ?? "" : "",
    "actionKind" in scope ? scope.actionKind ?? "" : ""
  ].join(":");
}

function contextOwnsScope(
  scope: Exclude<WriteFeedbackDisplayScope, { classification: "global" }>,
  context: WriteFeedbackDisplayContext
) {
  if (scope.page !== context.page) return false;
  if (scope.projectId && scope.projectId !== context.projectId) return false;
  if (!("ownerId" in scope) || !scope.ownerId || !scope.ownerType) return true;
  const ownerKeys = context.ownerKeys ?? [];
  const exactKey = createFeedbackOwnerKey(scope.ownerType, scope.ownerId, scope.channel);
  const ownerOnlyKey = createFeedbackOwnerKey(scope.ownerType, scope.ownerId);
  return ownerKeys.some((key) =>
    scope.channel ? key === exactKey : key === ownerOnlyKey || key.startsWith(`${ownerOnlyKey}:`)
  );
}

export function isWriteFeedbackVisibleToContext(
  entry: WriteFeedbackDisplayEntry,
  context: WriteFeedbackDisplayContext
) {
  return entry.scope.classification === "global"
    ? true
    : contextOwnsScope(entry.scope, context);
}

export function selectWriteFeedbackEntries(context: WriteFeedbackDisplayContext) {
  return entries.filter((entry) => isWriteFeedbackVisibleToContext(entry, context));
}

function entrySignature(entry: WriteFeedbackDisplayEntry) {
  return [
    scopeKey(entry.scope),
    entry.source,
    entry.severity,
    entry.operation ?? "",
    entry.reason ?? "",
    entry.title,
    entry.summary ?? "",
    entry.details.join("|")
  ].join("::");
}

function pushEntry(entry: WriteFeedbackDisplayEntry) {
  const canonicalScopeKey = scopeKey(entry.scope);
  const currentActionEntries = entry.operation
    ? entries.filter(
        (item) =>
          scopeKey(item.scope) !== canonicalScopeKey || item.operation !== entry.operation
      )
    : entries;
  if (entry.dedupeKey) {
    entries = [
      entry,
      ...currentActionEntries.filter(
        (item) =>
          item.dedupeKey !== entry.dedupeKey || scopeKey(item.scope) !== canonicalScopeKey
      )
    ];
    entries = retainEntryLimits(entries, canonicalScopeKey);
    notify();
    return;
  }
  const signature = entrySignature(entry);
  const timestamp = Date.now();
  const lastTimestamp = recentSignatures.get(signature);
  if (lastTimestamp && timestamp - lastTimestamp < dedupeWindowMs) {
    entries = [
      entry,
      ...currentActionEntries.filter((item) => entrySignature(item) !== signature)
    ];
  } else {
    entries = [entry, ...currentActionEntries];
  }
  entries = retainEntryLimits(entries, canonicalScopeKey);
  recentSignatures.set(signature, timestamp);
  notify();
}

function retainEntryLimits(
  candidates: WriteFeedbackDisplayEntry[],
  changedScopeKey: string
) {
  let changedScopeCount = 0;
  return candidates
    .filter((item) => {
      if (scopeKey(item.scope) !== changedScopeKey) return true;
      changedScopeCount += 1;
      return changedScopeCount <= maxEntriesPerScope;
    })
    .slice(0, maxTotalEntries);
}

function hasVisibleRefreshFeedback(event: RefreshEvent) {
  return (
    event.writeFeedbackStatus === "error" ||
    event.writeFeedbackStatus === "partial" ||
    event.writeFeedbackStatus === "skipped" ||
    (event.warnings?.length ?? 0) > 0 ||
    (event.errors?.length ?? 0) > 0 ||
    (event.skipped?.length ?? 0) > 0 ||
    Boolean(cleanText(event.reason) && event.writeFeedbackStatus !== "success")
  );
}

export function getWriteFeedbackEntries() {
  return entries;
}

export function subscribeWriteFeedbackEntries(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function dismissWriteFeedback(id: string) {
  entries = entries.filter((entry) => entry.id !== id);
  notify();
}

export function clearWriteFeedback(context: WriteFeedbackDisplayContext) {
  entries = entries.filter((entry) => !isWriteFeedbackVisibleToContext(entry, context));
  notify();
}

export function clearWriteFeedbackByDedupeKey(
  dedupeKey: string,
  context: WriteFeedbackDisplayContext
) {
  entries = entries.filter(
    (entry) =>
      entry.dedupeKey !== dedupeKey || !isWriteFeedbackVisibleToContext(entry, context)
  );
  notify();
}

export function pushPageFeedback(input: PushPageFeedbackInput) {
  const formalTerminal =
    input.operation && (input.severity === "success" || input.severity === "error")
      ? projectFormalBusinessAttemptFailure(input.operation)
      : undefined;
  pushEntry({
    id: createId("pageMessage"),
    severity: input.severity,
    title: input.title,
    summary: input.summary,
    operation: input.operation,
    operationLabel: input.operationLabel,
    dedupeKey: input.dedupeKey,
    reason: input.reason,
    details: uniqueTexts(input.details ?? []),
    affectedEntities: [],
    affectedScopes: [],
    createdAt: now(),
    source: "pageMessage",
    scope: input.scope,
    formalCrudTerminalPresentation: isSilentFormalSwitchFeedback(input.operation, input.severity)
      ? "suppress"
      : formalTerminal
      ? formalCrudTerminalPresentation(
          { ...formalTerminal, result: input.severity === "success" ? "success" : "failure" },
          input.operation,
          input.severity === "success" && !input.details?.length
        )
      : input.severity === "success" &&
          Boolean(input.operation && obviousSuccessfulOpenOperations.has(input.operation))
        ? "suppress"
        : undefined
  });
  if (input.severity === "error" && input.operation) {
    publishFormalBusinessAttemptFailure(input.operation);
  }
}

export function pushReloadErrorFeedback(
  error: unknown,
  event: RefreshEvent,
  pageName: string,
  scope: WriteFeedbackDisplayScope
) {
  pushEntry({
    id: createId("reloadError"),
    severity: "warning",
    title: "Page refresh did not complete",
    summary: formatError(error),
    operation: event.operation,
    reason: `page:${pageName}`,
    details: uniqueTexts([event.reason, ...event.keys]),
    affectedEntities: event.affectedEntities.map(summarizeEntity).slice(0, 6),
    affectedScopes: event.affectedScopes.map(summarizeScope).slice(0, 6),
    createdAt: now(),
    source: "reloadError",
    scope
  });
}

const ownerTypes = new Set([
  "review",
  "experiment",
  "experimentRun",
  "literature",
  "resultItem",
  "finding",
  "outputCandidate",
  "outputGap",
  "researchOutput",
  "output"
]);

function scopeFromAffected(
  affectedEntities: AffectedEntity[],
  affectedScopes: AffectedScope[],
  fallback: WriteFeedbackDisplayScope
): WriteFeedbackDisplayScope {
  const projectIds = [
    ...new Set(affectedScopes.map((scope) => scope.projectId).filter(Boolean))
  ] as string[];
  const owners = affectedEntities.filter(
    (entity) => ownerTypes.has(entity.type) && Boolean(entity.id)
  );
  const uniqueOwners = [
    ...new Map(owners.map((owner) => [`${owner.type}:${owner.id}`, owner])).values()
  ];
  if (uniqueOwners.length === 1 && fallback.classification !== "global") {
    const owner = uniqueOwners[0];
    return {
      classification: "owner",
      page: fallback.page,
      projectId: projectIds.length === 1 ? projectIds[0] : fallback.projectId,
      ownerType: owner.type === "output" ? "researchOutput" : owner.type,
      ownerId: owner.id
    };
  }
  if (projectIds.length === 1 && fallback.classification !== "global") {
    return {
      classification: "project",
      page: fallback.page,
      projectId: projectIds[0]
    };
  }
  return fallback;
}

export function pushWriteFeedback(
  feedback: WriteFeedbackResult | null | undefined,
  fallbackScope: WriteFeedbackDisplayScope
) {
  if (!feedback) return;

  const severity = severityForWriteFeedback(feedback);
  const formalTerminal = projectWriteFeedbackBusinessTerminal(feedback);
  const messageDetails = feedback.messages.map((message) => message.message);
  const details = uniqueTexts([
    ...feedback.errors,
    ...feedback.warnings,
    ...feedback.skipped.map((item) => `Skipped: ${item}`),
    ...missingReferenceText(feedback),
    ...messageDetails
  ]);

  pushEntry({
    id: createId("writeFeedback"),
    severity,
    title: titleForSeverity(severity),
    summary: details[0] ?? feedback.operation,
    operation: feedback.operation,
    details: details.slice(0, 8),
    affectedEntities: feedback.affectedEntities.map(summarizeEntity).slice(0, 6),
    affectedScopes: feedback.affectedScopes.map(summarizeScope).slice(0, 6),
    createdAt: feedback.createdAt ?? now(),
    source: "writeFeedback",
    formalCrudTerminalPresentation: formalCrudTerminalPresentation(
      formalTerminal, feedback.operation, severity === "success"
    ),
    scope: scopeFromAffected(
      feedback.affectedEntities,
      feedback.affectedScopes,
      fallbackScope
    )
  });
  if (
    !isUserCancelledWriteFeedback(feedback) &&
    (severity === "error" || feedback.status !== "success")
  ) {
    publishFormalBusinessAttemptFailure(feedback.operation);
  }
}

export function pushRefreshEventFeedback(
  event: RefreshEvent,
  fallbackScope: WriteFeedbackDisplayScope
) {
  if (consumedRefreshEventIds.has(event.id)) {
    return;
  }
  consumedRefreshEventIds.add(event.id);

  if (!hasVisibleRefreshFeedback(event)) {
    return;
  }

  const severity = severityForRefreshEvent(event);
  const formalTerminal = projectRefreshBusinessTerminal(event);
  const details = uniqueTexts([
    ...(event.errors ?? []),
    ...(event.warnings ?? []),
    ...(event.skipped ?? []).map((item) => `Skipped: ${item}`),
    event.reason,
    ...event.keys
  ]);

  pushEntry({
    id: `refreshEvent:${event.id}`,
    severity,
    title: titleForSeverity(severity),
    summary: details[0] ?? event.operation,
    operation: event.operation,
    reason: event.reason,
    details: details.slice(0, 8),
    affectedEntities: event.affectedEntities.map(summarizeEntity).slice(0, 6),
    affectedScopes: event.affectedScopes.map(summarizeScope).slice(0, 6),
    createdAt: event.createdAt,
    source: "refreshEvent",
    formalCrudTerminalPresentation: formalCrudTerminalPresentation(
      formalTerminal, event.operation, false
    ),
    scope: scopeFromAffected(event.affectedEntities, event.affectedScopes, fallbackScope)
  });
}
