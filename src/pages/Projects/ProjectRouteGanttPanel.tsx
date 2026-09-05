import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { UIEvent } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import {
  clampProjectRouteGanttScrollLeft,
  resolveProjectRouteGanttDefaultScrollLeft,
  resolveProjectRouteGanttDateRatio,
  resolveProjectRouteGanttTodayState,
  resolveProjectRouteGanttViewportGeometry
} from "../../services/projectRouteGanttGeometry";
import {
  clampProjectRouteGanttScrollTop,
  hasProjectRouteGanttVerticalContextChanged,
  resolveProjectRouteGanttDefaultScrollTop
} from "../../services/projectRouteGanttVerticalScroll";
import type {
  ProjectRouteGanttData,
  ProjectRouteGanttItem
} from "../../types/projectRouteGantt";

type ProjectRouteGanttPanelProps = {
  projectId: string;
  data: ProjectRouteGanttData | null;
  isLoading: boolean;
  today: string;
  errorMessage?: string;
};

function resolveBarGeometry(
  item: ProjectRouteGanttItem,
  rangeStart: string,
  rangeEnd: string
) {
  const left = resolveProjectRouteGanttDateRatio(item.startDate ?? rangeStart, rangeStart, rangeEnd) * 100;
  const right = resolveProjectRouteGanttDateRatio(item.endDate ?? rangeEnd, rangeStart, rangeEnd) * 100;
  const width = Math.max(0, Math.min(100, Math.max(6, right - left)));

  if (item.dateCompleteness === "endOnly") {
    return {
      left: "0%",
      width: `${Math.max(8, right)}%`
    };
  }

  if (item.dateCompleteness === "startOnly") {
    return {
      left: `${left}%`,
      width: `${Math.max(8, 100 - left)}%`
    };
  }

  return {
    left: `${left}%`,
    width: `${width}%`
  };
}

function compactTimeLabel(item: ProjectRouteGanttItem) {
  switch (item.dateCompleteness) {
    case "complete":
      return item.startDate && item.endDate ? `${item.startDate}...${item.endDate}` : item.timeLabel;
    case "startOnly":
      return item.startDate ? `${item.startDate}...` : item.timeLabel;
    case "endOnly":
      return item.endDate ? `...${item.endDate}` : item.timeLabel;
  }
}

function hasHiddenRouteSummary(data: ProjectRouteGanttData) {
  return Boolean(
    data.hiddenSummary.hiddenByDisplaySwitch ||
      data.hiddenSummary.hiddenIdeaWithoutDate ||
      data.hiddenSummary.hiddenNoDate ||
      data.hiddenSummary.hiddenInvalidDateRange
  );
}

export function ProjectRouteGanttPanel({
  projectId,
  data: requestedData,
  isLoading,
  today,
  errorMessage
}: ProjectRouteGanttPanelProps) {
  const data = requestedData?.projectId === projectId ? requestedData : null;
  const { t } = useI18n();
  const hasInitializedHorizontalScrollRef = useRef(false);
  const horizontalScrollContextKeyRef = useRef<string | null>(null);
  const horizontalScrollElementRef = useRef<HTMLDivElement | null>(null);
  const horizontalScrollPositionRef = useRef(0);
  const shouldRestoreHorizontalScrollRef = useRef(false);
  const hasInitializedVerticalScrollRef = useRef(false);
  const verticalScrollContextKeyRef = useRef<string | null>(null);
  const verticalScrollElementRef = useRef<HTMLDivElement | null>(null);
  const lastVerticalScrollTopRef = useRef(0);
  const shouldRestoreVerticalScrollRef = useRef(false);
  const [scrollContainerElement, setScrollContainerElement] = useState<HTMLDivElement | null>(null);
  const [verticalScrollElement, setVerticalScrollElement] = useState<HTMLDivElement | null>(null);
  const [viewportWidthPx, setViewportWidthPx] = useState(0);
  const todayState = useMemo(
    () => resolveProjectRouteGanttTodayState({
      today,
      rangeStart: data?.rangeStart,
      rangeEnd: data?.rangeEnd
    }),
    [data?.rangeEnd, data?.rangeStart, today]
  );
  const viewportGeometry = useMemo(
    () => resolveProjectRouteGanttViewportGeometry({ viewportWidthPx }),
    [viewportWidthPx]
  );
  const hasRange = Boolean(data?.rangeStart && data?.rangeEnd);
  const todayLeftPercent = todayState.todayRatio === null
    ? null
    : todayState.todayRatio * 100;
  const defaultScrollResult = useMemo(
    () => resolveProjectRouteGanttDefaultScrollLeft({
      todayState,
      viewportWidthPx: viewportGeometry.viewportWidthPx,
      contentWidthPx: viewportGeometry.contentWidthPx,
      maxScrollLeftPx: viewportGeometry.maxScrollLeftPx,
      isMeasured: viewportGeometry.isMeasured
    }),
    [todayState, viewportGeometry]
  );
  const isEmpty = !isLoading && !errorMessage && (!data || data.visibleItems.length === 0);
  const canvasStyle = viewportGeometry.isMeasured
    ? {
        width: `${viewportGeometry.contentWidthPx}px`,
        minWidth: `${viewportGeometry.contentWidthPx}px`
      }
    : {
        width: "100%",
        minWidth: "100%"
      };

  const handleHorizontalScroll = (event: UIEvent<HTMLDivElement>) => {
    horizontalScrollPositionRef.current = event.currentTarget.scrollLeft;
  };

  const handleVerticalScroll = (event: UIEvent<HTMLDivElement>) => {
    lastVerticalScrollTopRef.current = event.currentTarget.scrollTop;
  };

  useEffect(() => {
    if (!scrollContainerElement) {
      setViewportWidthPx(0);
      return;
    }

    const measure = () => {
      const nextWidth = scrollContainerElement.clientWidth;
      setViewportWidthPx((currentWidth) => (currentWidth === nextWidth ? currentWidth : nextWidth));
    };

    measure();

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(measure);
    observer.observe(scrollContainerElement);
    return () => observer.disconnect();
  }, [scrollContainerElement]);

  useLayoutEffect(() => {
    const projectChanged = horizontalScrollContextKeyRef.current !== data?.projectId;
    if (projectChanged) {
      horizontalScrollContextKeyRef.current = data?.projectId ?? null;
      hasInitializedHorizontalScrollRef.current = false;
      horizontalScrollPositionRef.current = 0;
      shouldRestoreHorizontalScrollRef.current = false;
    }

    if (horizontalScrollElementRef.current !== scrollContainerElement) {
      horizontalScrollElementRef.current = scrollContainerElement;
      if (scrollContainerElement && hasInitializedHorizontalScrollRef.current && !projectChanged) {
        shouldRestoreHorizontalScrollRef.current = true;
      }
    }

    if (!scrollContainerElement || !viewportGeometry.isMeasured) {
      return;
    }

    const domMaxScrollLeft = Math.max(
      0,
      scrollContainerElement.scrollWidth - scrollContainerElement.clientWidth
    );
    if (domMaxScrollLeft === 0 && viewportGeometry.maxScrollLeftPx > 0) {
      return;
    }

    const legalMaxScrollLeft = Math.min(
      viewportGeometry.maxScrollLeftPx,
      domMaxScrollLeft
    );

    if (
      shouldRestoreHorizontalScrollRef.current &&
      hasInitializedHorizontalScrollRef.current
    ) {
      const restoredScrollLeft = clampProjectRouteGanttScrollLeft(
        horizontalScrollPositionRef.current,
        legalMaxScrollLeft
      );
      scrollContainerElement.scrollLeft = restoredScrollLeft;
      horizontalScrollPositionRef.current = restoredScrollLeft;
      shouldRestoreHorizontalScrollRef.current = false;
      return;
    }

    if (hasInitializedHorizontalScrollRef.current || defaultScrollResult.scrollLeftPx === null) {
      return;
    }

    scrollContainerElement.scrollLeft = clampProjectRouteGanttScrollLeft(
      defaultScrollResult.scrollLeftPx,
      legalMaxScrollLeft
    );
    horizontalScrollPositionRef.current = scrollContainerElement.scrollLeft;
    hasInitializedHorizontalScrollRef.current = true;
  }, [
    data?.projectId,
    defaultScrollResult.scrollLeftPx,
    scrollContainerElement,
    viewportGeometry.maxScrollLeftPx
  ]);

  useLayoutEffect(() => {
    if (!scrollContainerElement || !viewportGeometry.isMeasured) {
      return;
    }

    const domMaxScrollLeft = Math.max(
      0,
      scrollContainerElement.scrollWidth - scrollContainerElement.clientWidth
    );
    const legalMaxScrollLeft = Math.min(
      viewportGeometry.maxScrollLeftPx,
      domMaxScrollLeft
    );
    const clampedScrollLeft = clampProjectRouteGanttScrollLeft(
      scrollContainerElement.scrollLeft,
      legalMaxScrollLeft
    );
    if (clampedScrollLeft !== scrollContainerElement.scrollLeft) {
      scrollContainerElement.scrollLeft = clampedScrollLeft;
      horizontalScrollPositionRef.current = clampedScrollLeft;
    }
  }, [
    scrollContainerElement,
    viewportGeometry.isMeasured,
    viewportGeometry.maxScrollLeftPx
  ]);

  useLayoutEffect(() => {
    const projectChanged = hasProjectRouteGanttVerticalContextChanged(
      verticalScrollContextKeyRef.current,
      projectId
    );
    if (projectChanged) {
      verticalScrollContextKeyRef.current = projectId;
      hasInitializedVerticalScrollRef.current = false;
      lastVerticalScrollTopRef.current = 0;
      shouldRestoreVerticalScrollRef.current = false;
    }

    if (verticalScrollElementRef.current !== verticalScrollElement) {
      verticalScrollElementRef.current = verticalScrollElement;
      if (verticalScrollElement && hasInitializedVerticalScrollRef.current && !projectChanged) {
        shouldRestoreVerticalScrollRef.current = true;
      }
    }

    if (isLoading || errorMessage || !data) {
      return;
    }

    if (!verticalScrollElement) {
      if (data.visibleItems.length === 0) {
        hasInitializedVerticalScrollRef.current = true;
        lastVerticalScrollTopRef.current = 0;
      }
      return;
    }

    const viewportHeightPx = verticalScrollElement.clientHeight;
    const scrollHeightPx = verticalScrollElement.scrollHeight;
    if (viewportHeightPx <= 0 || scrollHeightPx <= 0) {
      return;
    }

    const maxScrollTopPx = Math.max(0, scrollHeightPx - viewportHeightPx);
    if (
      shouldRestoreVerticalScrollRef.current &&
      hasInitializedVerticalScrollRef.current
    ) {
      const restoredScrollTop = clampProjectRouteGanttScrollTop(
        lastVerticalScrollTopRef.current,
        maxScrollTopPx
      );
      verticalScrollElement.scrollTop = restoredScrollTop;
      lastVerticalScrollTopRef.current = restoredScrollTop;
      shouldRestoreVerticalScrollRef.current = false;
      return;
    }

    if (hasInitializedVerticalScrollRef.current) {
      const clampedScrollTop = clampProjectRouteGanttScrollTop(
        verticalScrollElement.scrollTop,
        maxScrollTopPx
      );
      if (clampedScrollTop !== verticalScrollElement.scrollTop) {
        verticalScrollElement.scrollTop = clampedScrollTop;
      }
      lastVerticalScrollTopRef.current = clampedScrollTop;
      return;
    }

    if (!data.defaultVerticalAnchorRouteId) {
      const naturalTopResult = resolveProjectRouteGanttDefaultScrollTop({
        hasActiveAnchor: false,
        viewportHeightPx,
        scrollHeightPx
      });
      verticalScrollElement.scrollTop = naturalTopResult.scrollTopPx ?? 0;
      lastVerticalScrollTopRef.current = verticalScrollElement.scrollTop;
      hasInitializedVerticalScrollRef.current = true;
      return;
    }

    const routeRows = verticalScrollElement.querySelectorAll<HTMLElement>(
      '[data-gantt-route-row="true"]'
    );
    const anchorRow = Array.from(routeRows).find(
      (row) => row.dataset.routeId === data.defaultVerticalAnchorRouteId
    );
    const routeHeader = verticalScrollElement.querySelector<HTMLElement>(
      ".project-route-gantt-route-header"
    );
    if (!anchorRow || !routeHeader) {
      return;
    }

    const tableRect = verticalScrollElement.getBoundingClientRect();
    const anchorRect = anchorRow.getBoundingClientRect();
    const headerRect = routeHeader.getBoundingClientRect();
    const defaultScrollTopResult = resolveProjectRouteGanttDefaultScrollTop({
      hasActiveAnchor: true,
      targetOffsetTopPx: anchorRect.top - tableRect.top + verticalScrollElement.scrollTop,
      targetHeightPx: anchorRect.height,
      viewportHeightPx,
      scrollHeightPx,
      headerHeightPx: headerRect.height
    });
    if (defaultScrollTopResult.scrollTopPx === null) {
      return;
    }

    verticalScrollElement.scrollTop = defaultScrollTopResult.scrollTopPx;
    lastVerticalScrollTopRef.current = verticalScrollElement.scrollTop;
    hasInitializedVerticalScrollRef.current = true;
  }, [data, errorMessage, isLoading, projectId, verticalScrollElement]);

  useEffect(() => {
    if (!verticalScrollElement || typeof ResizeObserver === "undefined") {
      return;
    }

    const clampVerticalScroll = () => {
      if (!hasInitializedVerticalScrollRef.current) {
        return;
      }
      const maxScrollTopPx = Math.max(
        0,
        verticalScrollElement.scrollHeight - verticalScrollElement.clientHeight
      );
      const clampedScrollTop = clampProjectRouteGanttScrollTop(
        verticalScrollElement.scrollTop,
        maxScrollTopPx
      );
      if (clampedScrollTop !== verticalScrollElement.scrollTop) {
        verticalScrollElement.scrollTop = clampedScrollTop;
      }
      lastVerticalScrollTopRef.current = clampedScrollTop;
    };

    const observer = new ResizeObserver(clampVerticalScroll);
    observer.observe(verticalScrollElement);
    return () => observer.disconnect();
  }, [verticalScrollElement]);

  return (
    <section className="project-route-gantt-panel" aria-live="polite">
      {isLoading ? (
        <div className="project-route-gantt-state">{t("projectRouteGanttLoading")}</div>
      ) : null}

      {!isLoading && errorMessage ? (
        <div className="project-route-gantt-state project-route-gantt-state-error">
          {t("projectRouteGanttError")}
          <span>{errorMessage}</span>
        </div>
      ) : null}

      {isEmpty ? (
        <div className="project-route-gantt-state">
          <strong>{t(data ? "projectRouteGanttEmptyTitle" : "projectRouteGanttNoProjectTitle")}</strong>
          <span>
            {data && hasHiddenRouteSummary(data)
              ? t("projectRouteGanttEmptyHiddenDescription")
              : data
                ? t("projectRouteGanttEmptyDescription")
                : t("projectRouteGanttNoProjectDescription")}
          </span>
        </div>
      ) : null}

      {!isLoading && !errorMessage && data && data.visibleItems.length > 0 && hasRange ? (
        <div
          className="project-route-gantt-table"
          ref={setVerticalScrollElement}
          onScroll={handleVerticalScroll}
        >
          <div className="project-route-gantt-left-column">
            <div className="project-route-gantt-route-header">
              {t("projectRouteGanttRouteColumn")}
            </div>
            <div className="project-route-gantt-route-name-list">
              {data.visibleItems.map((item) => (
                <div
                  className="project-route-gantt-route project-route-gantt-route-name project-route-gantt-row-separator"
                  data-gantt-route-row="true"
                  data-route-id={item.routeId}
                  key={item.routeId}
                  title={`${item.title} · ${item.statusLabel} · ${item.timeLabel}`}
                >
                  <strong>{item.title}</strong>
                </div>
              ))}
            </div>
          </div>
          <div
            className="project-route-gantt-scroll-x"
            ref={setScrollContainerElement}
            onScroll={handleHorizontalScroll}
          >
            <div className="project-route-gantt-canvas" style={canvasStyle}>
              <div className="project-route-gantt-month-row">
                <div className="project-route-gantt-axis" aria-label={t("projectRouteGanttMonthAxis")}>
                  {data.timeTicks.map((tick, index) => (
                    <span
                      className={`project-route-gantt-axis-tick${
                        index === 0 ? " project-route-gantt-axis-tick-start" : ""
                      }${index === data.timeTicks.length - 1 ? " project-route-gantt-axis-tick-end" : ""}`}
                      data-gantt-tick-date={tick.date}
                      data-gantt-tick-granularity={tick.granularity}
                      key={tick.id}
                      style={{
                        left: `${resolveProjectRouteGanttDateRatio(
                          tick.date,
                          data.rangeStart,
                          data.rangeEnd
                        ) * 100}%`
                      }}
                    >
                      {tick.label}
                    </span>
                  ))}
                  {todayState.todayInRange && todayLeftPercent !== null ? (
                    <span
                      className="project-route-gantt-today-axis-line"
                      style={{ left: `${todayLeftPercent}%` }}
                    />
                  ) : null}
                </div>
              </div>
              <div className="project-route-gantt-row-list project-route-gantt-rows">
                {data.visibleItems.map((item) => {
                  const geometry = resolveBarGeometry(item, data.rangeStart!, data.rangeEnd!);
                  return (
                    <div
                      className="project-route-gantt-row project-route-gantt-chart-row project-route-gantt-row-separator"
                      key={item.routeId}
                      title={`${item.title} · ${item.statusLabel} · ${item.timeLabel}`}
                    >
                      <div className="project-route-gantt-track">
                        {todayState.todayInRange && todayLeftPercent !== null ? (
                          <span
                            className="project-route-gantt-today-line"
                            style={{ left: `${todayLeftPercent}%` }}
                          />
                        ) : null}
                        <div
                          className={`project-route-gantt-bar project-route-gantt-bar-${item.displayMode} project-route-gantt-bar-status-${item.status}`}
                          data-display-mode={item.displayMode}
                          data-date-completeness={item.dateCompleteness}
                          style={geometry}
                        >
                          <span className="project-route-gantt-bar-time">{compactTimeLabel(item)}</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {data ? (
        <div className="project-route-gantt-hidden-summary project-route-gantt-hidden-inline">
          <strong>{t("projectRouteGanttHiddenSummaryTitle")}</strong>
          <div className="project-route-gantt-hidden-chips">
            <span>
              {t("projectRouteGanttHiddenByDisplaySwitch")}:{" "}
              {data.hiddenSummary.hiddenByDisplaySwitch}
            </span>
            <span>
              {t("projectRouteGanttHiddenIdeaWithoutDate")}:{" "}
              {data.hiddenSummary.hiddenIdeaWithoutDate}
            </span>
            <span>
              {t("projectRouteGanttHiddenNoDate")}: {data.hiddenSummary.hiddenNoDate}
            </span>
            <span>
              {t("projectRouteGanttHiddenInvalidDateRange")}:{" "}
              {data.hiddenSummary.hiddenInvalidDateRange}
            </span>
          </div>
        </div>
      ) : null}
    </section>
  );
}
