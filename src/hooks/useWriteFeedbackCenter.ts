import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { RefreshEvent } from "../types/refresh";
import type { WriteFeedbackResult } from "../types/writeFeedback";
import {
  clearWriteFeedback,
  clearWriteFeedbackByDedupeKey,
  dismissWriteFeedback,
  getWriteFeedbackEntries,
  selectWriteFeedbackEntries,
  pushPageFeedback,
  pushRefreshEventFeedback,
  pushReloadErrorFeedback,
  pushWriteFeedback,
  subscribeWriteFeedbackEntries,
  type PushPageFeedbackInput,
  type WriteFeedbackDisplayContext,
  type WriteFeedbackDisplayScope
} from "../services/writeFeedbackDisplayService";
import {
  normalizeWriteFeedbackError,
  normalizeWriteFeedbackResult,
  type NormalizeWriteFeedbackOptions
} from "../services/writeFeedbackService";

type BoundPushPageFeedbackInput = Omit<PushPageFeedbackInput, "scope"> & {
  scope?: WriteFeedbackDisplayScope;
};

export function useWriteFeedbackCenter(context: WriteFeedbackDisplayContext) {
  useSyncExternalStore(
    subscribeWriteFeedbackEntries,
    getWriteFeedbackEntries,
    getWriteFeedbackEntries
  );
  const entries = selectWriteFeedbackEntries(context);
  const fallbackScope = useMemo<WriteFeedbackDisplayScope>(() => ({
    classification: "action-local",
    page: context.page,
    projectId: context.projectId
  }), [context.page, context.projectId]);

  const dismissFeedback = useCallback((id: string) => dismissWriteFeedback(id), []);
  const clearFeedback = useCallback(() => clearWriteFeedback(context), [context]);
  const clearFeedbackByDedupeKey = useCallback(
    (dedupeKey: string) => clearWriteFeedbackByDedupeKey(dedupeKey, context),
    [context]
  );
  const pushPage = useCallback(
    (input: BoundPushPageFeedbackInput) =>
      pushPageFeedback({ ...input, scope: input.scope ?? fallbackScope }),
    [fallbackScope]
  );
  const pushWrite = useCallback(
    (feedback?: WriteFeedbackResult | null) => pushWriteFeedback(feedback, fallbackScope),
    [fallbackScope]
  );
  const consumeWriteResult = useCallback(
    <T,>(
      result: T | WriteFeedbackResult<T>,
      options: NormalizeWriteFeedbackOptions<T>
    ) => {
      const feedback = normalizeWriteFeedbackResult(result, options);
      pushWriteFeedback(feedback, fallbackScope);
      return feedback;
    },
    [fallbackScope]
  );
  const consumeWriteError = useCallback((error: unknown, operation: string) => {
    const feedback = normalizeWriteFeedbackError(error, operation);
    pushWriteFeedback(feedback, fallbackScope);
    return feedback;
  }, [fallbackScope]);
  const pushRefreshEvent = useCallback(
    (event: RefreshEvent) => pushRefreshEventFeedback(event, fallbackScope),
    [fallbackScope]
  );
  const pushReloadError = useCallback(
    (error: unknown, event: RefreshEvent, pageName: string) =>
      pushReloadErrorFeedback(error, event, pageName, fallbackScope),
    [fallbackScope]
  );

  return useMemo(() => ({
    entries,
    dismissFeedback,
    clearFeedback,
    clearFeedbackByDedupeKey,
    pushPageFeedback: pushPage,
    pushWriteFeedback: pushWrite,
    consumeWriteResult,
    consumeWriteError,
    pushRefreshEventFeedback: pushRefreshEvent,
    pushReloadErrorFeedback: pushReloadError
  }), [
    clearFeedback,
    clearFeedbackByDedupeKey,
    dismissFeedback,
    entries,
    consumeWriteError,
    consumeWriteResult,
    pushPage,
    pushRefreshEvent,
    pushReloadError,
    pushWrite
  ]);
}
