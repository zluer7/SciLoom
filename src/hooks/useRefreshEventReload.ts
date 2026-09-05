import { useCallback, useEffect, useRef } from "react";
import {
  hasAnyRefreshKey,
  subscribeRefreshEvents
} from "../services/refreshEventService";
import type { RefreshEvent, RefreshKeyPattern } from "../types/refresh";

export interface UseRefreshEventReloadOptions {
  pageName: string;
  watchedKeys: RefreshKeyPattern[];
  reload: (event: RefreshEvent) => void | Promise<void>;
  enabled?: boolean;
  onMatchedEvent?: (event: RefreshEvent) => void;
  onRefreshFeedback?: (event: RefreshEvent) => void;
  onReloadError?: (error: unknown, event: RefreshEvent) => void;
}

export function useRefreshEventReload({
  pageName,
  watchedKeys,
  reload,
  enabled = true,
  onMatchedEvent,
  onRefreshFeedback,
  onReloadError
}: UseRefreshEventReloadOptions): void {
  const reloadRef = useRef(reload);
  const onMatchedEventRef = useRef(onMatchedEvent);
  const onRefreshFeedbackRef = useRef(onRefreshFeedback);
  const onReloadErrorRef = useRef(onReloadError);
  const isMountedRef = useRef(false);
  const isReloadingRef = useRef(false);
  const pendingEventRef = useRef<RefreshEvent | null>(null);

  useEffect(() => {
    reloadRef.current = reload;
  }, [reload]);

  useEffect(() => {
    onMatchedEventRef.current = onMatchedEvent;
    onRefreshFeedbackRef.current = onRefreshFeedback;
    onReloadErrorRef.current = onReloadError;
  }, [onMatchedEvent, onRefreshFeedback, onReloadError]);

  const executeReload = useCallback(
    async (event: RefreshEvent) => {
      if (isReloadingRef.current) {
        pendingEventRef.current = event;
        return;
      }

      isReloadingRef.current = true;
      let nextEvent: RefreshEvent | null = event;

      try {
        while (nextEvent && isMountedRef.current) {
          const currentEvent = nextEvent;
          pendingEventRef.current = null;
          nextEvent = null;

          try {
            await reloadRef.current(currentEvent);
          } catch (error) {
            console.warn(`Refresh reload failed for ${pageName}.`, error);
            onReloadErrorRef.current?.(error, currentEvent);
          }

          nextEvent = pendingEventRef.current;
        }
      } finally {
        isReloadingRef.current = false;
        const pendingEvent = pendingEventRef.current;
        pendingEventRef.current = null;
        if (pendingEvent && isMountedRef.current) {
          void executeReload(pendingEvent);
        }
      }
    },
    [pageName]
  );

  useEffect(() => {
    isMountedRef.current = true;
    if (!enabled) {
      return () => {
        isMountedRef.current = false;
        pendingEventRef.current = null;
      };
    }

    const subscription = subscribeRefreshEvents((event) => {
      if (hasAnyRefreshKey(event, watchedKeys)) {
        onMatchedEventRef.current?.(event);
        onRefreshFeedbackRef.current?.(event);
        void executeReload(event);
      }
    });

    return () => {
      isMountedRef.current = false;
      pendingEventRef.current = null;
      subscription.unsubscribe();
    };
  }, [enabled, executeReload, watchedKeys]);
}
