import type {
  CreateRefreshEventFromWriteFeedbackOptions,
  RefreshEvent,
  RefreshEventListener,
  RefreshKeyPattern,
  RefreshSubscription
} from "../types/refresh";
import type { RefreshKey, WriteFeedbackResult } from "../types/writeFeedback";

export const MAX_REFRESH_EVENT_HISTORY = 50;

const refreshEventHistory: RefreshEvent[] = [];
const refreshEventListeners = new Set<RefreshEventListener>();

function now() {
  return new Date().toISOString();
}

function createRefreshEventId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `refresh_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function dedupeRefreshKeys(keys: RefreshKey[] = []) {
  return [...new Set(keys.filter(Boolean))];
}

function cloneRefreshEvent(event: RefreshEvent): RefreshEvent {
  return {
    ...event,
    keys: [...event.keys],
    affectedEntities: event.affectedEntities.map((entity) => ({ ...entity })),
    affectedScopes: event.affectedScopes.map((scope) => ({ ...scope })),
    warnings: event.warnings ? [...event.warnings] : undefined,
    errors: event.errors ? [...event.errors] : undefined,
    skipped: event.skipped ? [...event.skipped] : undefined
  };
}

export function createRefreshEventFromWriteFeedback<T = unknown>(
  feedback: WriteFeedbackResult<T>,
  options: CreateRefreshEventFromWriteFeedbackOptions = {}
): RefreshEvent {
  return {
    id: options.id ?? createRefreshEventId(),
    keys: dedupeRefreshKeys([...(feedback.refreshKeys ?? []), ...(options.additionalKeys ?? [])]),
    affectedEntities: feedback.affectedEntities.map((entity) => ({ ...entity })),
    affectedScopes: feedback.affectedScopes.map((scope) => ({ ...scope })),
    source: options.source ?? "service.write",
    operation: feedback.operation,
    reason: options.reason,
    writeFeedbackStatus: feedback.status,
    warnings: [...feedback.warnings],
    errors: [...feedback.errors],
    skipped: [...feedback.skipped],
    createdAt: options.createdAt ?? feedback.createdAt ?? now()
  };
}

export function publishRefreshEvent(event: RefreshEvent): RefreshEvent {
  const publishedEvent = cloneRefreshEvent(event);
  refreshEventHistory.push(publishedEvent);
  if (refreshEventHistory.length > MAX_REFRESH_EVENT_HISTORY) {
    refreshEventHistory.splice(0, refreshEventHistory.length - MAX_REFRESH_EVENT_HISTORY);
  }
  refreshEventListeners.forEach((listener) => listener(cloneRefreshEvent(publishedEvent)));
  return cloneRefreshEvent(publishedEvent);
}

export function publishWriteFeedbackRefresh<T = unknown>(
  feedback: WriteFeedbackResult<T>,
  options: CreateRefreshEventFromWriteFeedbackOptions = {}
): RefreshEvent | undefined {
  try {
    return publishRefreshEvent(createRefreshEventFromWriteFeedback(feedback, options));
  } catch {
    const warning = "RefreshEvent publish failed; business write result was preserved.";
    feedback.warnings.push(warning);
    feedback.messages.push({
      severity: "warning",
      message: warning,
      code: "refresh_publish_failed"
    });
    if (feedback.status === "success") {
      feedback.status = "partial";
      feedback.partial = true;
    }
    return undefined;
  }
}

export function subscribeRefreshEvents(listener: RefreshEventListener): RefreshSubscription {
  refreshEventListeners.add(listener);
  return {
    unsubscribe() {
      refreshEventListeners.delete(listener);
    }
  };
}

export function getRefreshEventHistory(): RefreshEvent[] {
  return refreshEventHistory.map(cloneRefreshEvent);
}

export function clearRefreshEventHistory(): void {
  refreshEventHistory.length = 0;
}

function isGlobalKey(key: RefreshKeyPattern) {
  return key === "global.changed";
}

function matchesNamespaceWildcard(eventKey: RefreshKeyPattern, watchedKey: RefreshKeyPattern) {
  if (!watchedKey.endsWith(".*")) return false;
  const namespace = watchedKey.slice(0, -2);
  return eventKey === namespace || eventKey.startsWith(`${namespace}.`);
}

export function matchesRefreshKeys(
  eventKeys: readonly RefreshKeyPattern[] = [],
  watchedKeys: readonly RefreshKeyPattern[] = []
): boolean {
  return eventKeys.some((eventKey) =>
    watchedKeys.some((watchedKey) => {
      if (isGlobalKey(eventKey) || isGlobalKey(watchedKey)) return true;
      if (eventKey === watchedKey) return true;
      return matchesNamespaceWildcard(eventKey, watchedKey);
    })
  );
}

export function hasAnyRefreshKey(
  event: RefreshEvent,
  watchedKeys: readonly RefreshKeyPattern[] = []
): boolean {
  return matchesRefreshKeys(event.keys, watchedKeys);
}

export const refreshEventService = {
  createRefreshEventFromWriteFeedback,
  publishRefreshEvent,
  publishWriteFeedbackRefresh,
  subscribeRefreshEvents,
  getRefreshEventHistory,
  clearRefreshEventHistory,
  matchesRefreshKeys,
  hasAnyRefreshKey
};
