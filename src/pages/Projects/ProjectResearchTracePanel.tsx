import { useEffect, useMemo, useRef, type CSSProperties } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import type { TranslationKey } from "../../i18n/translations";
import type {
  ProjectResearchTraceData,
  ProjectResearchTraceEvent,
  ProjectResearchTraceEventType,
  ProjectResearchTraceLayoutItem,
  ProjectResearchTraceSlotGeometry,
  ResearchTraceDisplayDensity,
  ResearchTraceSegmentedTimelineEvent,
  ResearchTraceTimeSegment
} from "../../types/projectResearchTrace";
import { buildResearchTraceSegmentedTimelineViewModel } from "../../services/projectResearchTraceDisplayRules";
import {
  RESEARCH_TRACE_CARD_OUTER_WIDTH,
  RESEARCH_TRACE_CARD_VISIBLE_GAP,
  RESEARCH_TRACE_LEFT_SAFE_PADDING,
  RESEARCH_TRACE_LAYOUT_CONTENT_WIDTH,
  RESEARCH_TRACE_SEGMENT_SAFE_GAP,
  mapResearchTraceOriginalXToSlotGeometry,
  mapResearchTraceTimelineEventToSlotGeometry,
  resolveResearchTraceCardLayout
} from "../../services/projectResearchTraceLayoutResolver";

type ProjectResearchTracePanelProps = {
  data: ProjectResearchTraceData | null;
  displayDensity?: ResearchTraceDisplayDensity;
  isLoading: boolean;
  errorMessage?: string;
};

const eventTypeTranslationKeys: Record<ProjectResearchTraceEventType, TranslationKey> = {
  projectCreated: "projectResearchTraceEventProjectCreated",
  routeStarted: "projectResearchTraceEventRouteStarted",
  routeCompleted: "projectResearchTraceEventRouteCompleted",
  reviewRecorded: "projectResearchTraceEventReviewRecorded",
  findingCreated: "projectResearchTraceEventFindingCreated",
  candidateCreated: "projectResearchTraceEventCandidateCreated",
  gapCreated: "projectResearchTraceEventGapCreated",
  researchOutputCreated: "projectResearchTraceEventResearchOutputCreated",
  taskRecorded: "projectResearchTraceEventTaskRecorded",
  experimentRecorded: "projectResearchTraceEventExperimentRecorded",
  experimentRunRecorded: "projectResearchTraceEventExperimentRunRecorded",
  literatureRecorded: "projectResearchTraceEventLiteratureRecorded",
  resultItemCreated: "projectResearchTraceEventResultItemCreated"
};

const defaultDisplayDensity: ResearchTraceDisplayDensity = "standard";

function getEventTypeLabel(event: ProjectResearchTraceEvent, t: (key: TranslationKey) => string) {
  const translationKey = eventTypeTranslationKeys[event.eventType];
  return translationKey ? t(translationKey) : event.typeLabel;
}

function getTimelineEvents<T extends ProjectResearchTraceEvent>(events: T[]) {
  return events.filter((event) => event.eventType !== "projectCreated");
}

function getTracePositionStyle(xRatioOverall: number) {
  return {
    "--research-trace-x": `${Math.min(100, Math.max(0, xRatioOverall * 100))}%`
  } as CSSProperties;
}

function getTraceCardPositionStyle(layoutItem: ProjectResearchTraceLayoutItem) {
  return {
    ...getTracePositionStyle(layoutItem.cardX),
    "--research-trace-card-y": `${layoutItem.cardY}px`
  } as CSSProperties;
}

function getTraceTimelineEventPositionStyle(
  event: ResearchTraceSegmentedTimelineEvent,
  slotGeometry: ProjectResearchTraceSlotGeometry
) {
  return getTracePositionStyle(mapResearchTraceTimelineEventToSlotGeometry(event, slotGeometry));
}

function getTraceOriginalPositionStyle(
  xRatioOverall: number,
  segments: ResearchTraceTimeSegment[],
  slotGeometry: ProjectResearchTraceSlotGeometry
) {
  return getTracePositionStyle(
    mapResearchTraceOriginalXToSlotGeometry(xRatioOverall, segments, slotGeometry)
  );
}

function getAxisBreakPositionStyle(
  axisBreakId: string,
  slotGeometry: ProjectResearchTraceSlotGeometry
) {
  const segmentId = axisBreakId === "history-middle" ? "history" : "middle";
  const segment = slotGeometry.segments.find((item) => item.id === segmentId);
  return getTracePositionStyle(segment?.endXRatio ?? 0.5);
}

function getPriorityClassName(event: ProjectResearchTraceEvent) {
  return `project-research-trace-node-priority-${event.priority}`;
}

function getEventClassNames(
  event: ProjectResearchTraceEvent,
  extraClassNames: string[] = []
) {
  return [
    ...extraClassNames,
    `project-research-trace-node-${event.priority}`,
    `project-research-trace-node-${event.eventType}`,
    `project-research-trace-type-${event.eventType}`,
    `project-research-trace-source-${event.displayState}`,
    getPriorityClassName(event)
  ];
}

function getHistoryClassName(
  event: ResearchTraceSegmentedTimelineEvent
) {
  if (event.segmentId === "recent" || event.priority !== "normal") {
    return "";
  }
  return "project-research-trace-history-muted";
}

function ProjectResearchTraceNode({
  event,
  positionStyle,
  className
}: {
  event: ProjectResearchTraceEvent;
  positionStyle: CSSProperties;
  className: string;
}) {
  const { t } = useI18n();

  return (
    <article
      className={`project-research-trace-event project-research-trace-node ${className}`}
      role="listitem"
      style={positionStyle}
    >
      <span className="project-research-trace-node-mark" aria-hidden="true" />
      <div className="project-research-trace-node-head">
        <span>{getEventTypeLabel(event, t)}</span>
        <time dateTime={event.occurredAt}>{event.occurredAt}</time>
      </div>
      <h4>{event.title}</h4>
    </article>
  );
}

function ProjectResearchTraceProjectCreated({
  event,
  positionStyle
}: {
  event: ProjectResearchTraceEvent;
  positionStyle: CSSProperties;
}) {
  const { t } = useI18n();

  return (
    <div
      className="project-research-trace-project-created project-research-trace-node-projectCreated"
      role="listitem"
      style={positionStyle}
    >
      <span>{getEventTypeLabel(event, t)}</span>
      <time dateTime={event.occurredAt}>{event.occurredAt}</time>
    </div>
  );
}

function ProjectResearchTraceMarker({
  event,
  positionStyle
}: {
  event: ProjectResearchTraceEvent;
  positionStyle: CSSProperties;
}) {
  const style = {
    ...positionStyle,
    zIndex: Math.max(4, 40 - event.markerStackIndex)
  } as CSSProperties;

  return (
    <span
      className={[
        "project-research-trace-axis-marker",
        `project-research-trace-type-${event.eventType}`,
        `project-research-trace-source-${event.displayState}`
      ].join(" ")}
      style={style}
      aria-hidden="true"
    />
  );
}

export function ProjectResearchTracePanel({
  data,
  displayDensity = defaultDisplayDensity,
  isLoading,
  errorMessage
}: ProjectResearchTracePanelProps) {
  const { t } = useI18n();
  const events = data?.events ?? [];
  const segmentedTimeline = useMemo(
    () => buildResearchTraceSegmentedTimelineViewModel(events, { displayDensity }),
    [displayDensity, events]
  );
  const displayEvents = segmentedTimeline.events;
  const projectCreatedEvent = segmentedTimeline.projectCreatedEvent;
  const displayTimelineEvents = useMemo(() => getTimelineEvents(displayEvents), [displayEvents]);
  const overflowCount = data?.overflowCount ?? data?.hiddenSummary.overLimit ?? 0;
  const visibleCount = displayTimelineEvents.length;
  const timelineEventCount = segmentedTimeline.totalTimelineEventCount;
  const displayTimelineEventCount = displayTimelineEvents.length;
  const localOverflowCount = segmentedTimeline.collapsedCount;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const autoScrollKeyRef = useRef("");
  const layoutResult = useMemo(
    () =>
      resolveResearchTraceCardLayout(displayTimelineEvents, segmentedTimeline.segments, {
        cardWidth: RESEARCH_TRACE_CARD_OUTER_WIDTH,
        cardHeight: 58,
        horizontalGap: RESEARCH_TRACE_CARD_VISIBLE_GAP,
        verticalGap: 16,
        contentWidth: RESEARCH_TRACE_LAYOUT_CONTENT_WIDTH,
        leftSafePadding: RESEARCH_TRACE_LEFT_SAFE_PADDING,
        segmentSafeGap: RESEARCH_TRACE_SEGMENT_SAFE_GAP
      }),
    [displayTimelineEvents, segmentedTimeline.segments]
  );
  const slotGeometry = layoutResult.slotGeometry;
  const layoutItemsByEventId = useMemo(
    () => new Map(layoutResult.items.map((item) => [item.eventId, item])),
    [layoutResult]
  );
  const layoutOverflowCount = layoutResult.overflowCount;
  const layoutWidthPx = layoutResult.geometry.contentWidthPx;
  const overflowText = useMemo(
    () => t("projectResearchTraceOverflowHint").replace("{count}", String(visibleCount)),
    [visibleCount, t]
  );
  const displayOverflowText = useMemo(
    () =>
      t("projectResearchTraceDisplayOverflowHint")
        .replace("{total}", String(timelineEventCount))
        .replace("{count}", String(displayTimelineEventCount)),
    [displayTimelineEventCount, timelineEventCount, t]
  );
  const layoutOverflowText = useMemo(
    () => t("projectResearchTraceLayoutOverflowHint").replace("{count}", String(layoutOverflowCount)),
    [layoutOverflowCount, t]
  );
  const autoScrollKey = `${data?.projectId ?? ""}:${data?.generatedAt ?? ""}:${visibleCount}:${overflowCount}:${displayDensity}`;

  useEffect(() => {
    const scrollElement = scrollRef.current;
    if (!scrollElement || displayEvents.length === 0 || isLoading || errorMessage) {
      return;
    }
    if (autoScrollKeyRef.current === autoScrollKey) {
      return;
    }
    autoScrollKeyRef.current = autoScrollKey;
    window.requestAnimationFrame(() => {
      scrollElement.scrollLeft = scrollElement.scrollWidth;
    });
  }, [autoScrollKey, displayEvents.length, errorMessage, isLoading]);

  if (isLoading) {
    return (
      <section className="project-research-trace-panel" aria-live="polite">
        <div className="project-research-trace-toolbar">
          <h3>{t("projectResearchTraceTitle")}</h3>
        </div>
        <div className="project-research-trace-state">
          <strong>{t("projectResearchTraceLoading")}</strong>
        </div>
      </section>
    );
  }

  if (errorMessage) {
    return (
      <section className="project-research-trace-panel" aria-live="polite">
        <div className="project-research-trace-toolbar">
          <h3>{t("projectResearchTraceTitle")}</h3>
        </div>
        <div className="project-research-trace-state project-research-trace-state-error">
          <strong>{t("projectResearchTraceError")}</strong>
          <span>{errorMessage}</span>
        </div>
      </section>
    );
  }

  return (
    <section className="project-research-trace-panel" aria-live="polite">
      <div className="project-research-trace-toolbar">
        <h3>{t("projectResearchTraceTitle")}</h3>
      </div>

      {overflowCount > 0 ? (
        <div className="project-research-trace-overflow-note project-research-trace-overflow-hint">
          {overflowText}
        </div>
      ) : null}

      {localOverflowCount > 0 ? (
        <div className="project-research-trace-overflow-note project-research-trace-display-overflow-hint">
          {displayOverflowText}
        </div>
      ) : null}

      {displayEvents.length === 0 ? (
        <div className="project-research-trace-state">
          <strong>{t("projectResearchTraceEmptyTitle")}</strong>
          <span>{t("projectResearchTraceEmptyDescription")}</span>
        </div>
      ) : (
        <div
          className="project-research-trace-scroll"
          aria-label={t("projectResearchTraceTitle")}
          ref={scrollRef}
        >
          <div
            className="project-research-trace-lanes"
            style={{
              width: `${layoutWidthPx}px`,
              "--research-trace-layout-width": `${layoutWidthPx}px`,
              "--research-trace-card-width": `${RESEARCH_TRACE_CARD_OUTER_WIDTH}px`
            } as CSSProperties}
          >
            <div
              className="project-research-trace-lane project-research-trace-lane-outcome"
              aria-hidden="true"
            />
            <div
              className="project-research-trace-lane project-research-trace-lane-upper"
              aria-hidden="true"
            />
            <div
              className="project-research-trace-lane project-research-trace-lane-progress"
              aria-hidden="true"
            />
            <div
              className="project-research-trace-lane project-research-trace-lane-work"
              aria-hidden="true"
            />

            <div className="project-research-trace-layout-layer" role="list">
              {displayTimelineEvents.map((event) => {
                const layoutItem = layoutItemsByEventId.get(event.id);
                if (!layoutItem || layoutItem.isOverflowHidden) {
                  return null;
                }
                return (
                  <ProjectResearchTraceNode
                    className={[
                      ...getEventClassNames(
                        event,
                        layoutItem.layoutLane === "lowerProgress"
                          ? ["project-research-trace-node-progress"]
                          : layoutItem.layoutLane === "lowerWork"
                            ? ["project-research-trace-node-work"]
                            : []
                      ),
                      getHistoryClassName(event)
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    event={event}
                    key={event.id}
                    positionStyle={getTraceCardPositionStyle(layoutItem)}
                  />
                );
              })}
            </div>

            <div className="project-research-trace-lane project-research-trace-lane-axis">
              <div className="project-research-trace-axis" aria-hidden="true">
                <div className="project-research-trace-axis-line" />
                {segmentedTimeline.adaptiveTicks.map((tick) => (
                  <span
                    className="project-research-trace-tick"
                    data-research-trace-tick-id={tick.id}
                    data-research-trace-tick-segment={tick.segmentId}
                    data-research-trace-tick-granularity={tick.granularity}
                    key={`adaptive-tick:${tick.id}`}
                    style={getTraceOriginalPositionStyle(tick.xRatioOverall, segmentedTimeline.segments, slotGeometry)}
                  >
                    <time className="project-research-trace-tick-label" dateTime={tick.occurredAt}>
                      {tick.label}
                    </time>
                  </span>
                ))}
                {segmentedTimeline.axisBreaks.map((axisBreak) => (
                  <span
                    className="project-research-trace-axis-break"
                    key={`axis-break:${axisBreak.id}`}
                    style={getAxisBreakPositionStyle(axisBreak.id, slotGeometry)}
                    aria-hidden="true"
                  >
                    <span className="project-research-trace-axis-break-slash">//</span>
                  </span>
                ))}
                {projectCreatedEvent ? (
                  <span
                    className="project-research-trace-project-created-marker project-research-trace-creation-marker project-research-trace-black-dot"
                    style={getTraceTimelineEventPositionStyle(projectCreatedEvent, slotGeometry)}
                    aria-hidden="true"
                  />
                ) : null}
                {displayTimelineEvents.map((event) => (
                  <ProjectResearchTraceMarker
                    event={event}
                    key={`marker:${event.id}`}
                    positionStyle={getTracePositionStyle(
                      layoutItemsByEventId.get(event.id)?.markerX ?? event.xRatioOverall
                    )}
                  />
                ))}
                <span className="project-research-trace-axis-arrow" aria-hidden="true" />
              </div>
              <div className="project-research-trace-axis-events" role="list">
                {projectCreatedEvent ? (
                  <ProjectResearchTraceProjectCreated
                    event={projectCreatedEvent}
                    positionStyle={getTraceTimelineEventPositionStyle(projectCreatedEvent, slotGeometry)}
                  />
                ) : null}
              </div>
            </div>
          </div>
        </div>
      )}

      {layoutOverflowCount > 0 ? (
        <div className="project-research-trace-overflow-note project-research-trace-layout-overflow-hint">
          {layoutOverflowText}
        </div>
      ) : null}
    </section>
  );
}
