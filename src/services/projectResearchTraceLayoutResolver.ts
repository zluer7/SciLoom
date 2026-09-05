import type {
  ProjectResearchTraceLane,
  ProjectResearchTraceLayoutItem,
  ProjectResearchTraceLayoutOptions,
  ProjectResearchTraceLayoutResult,
  ProjectResearchTraceSlotGeometry,
  ProjectResearchTraceSlotSegment,
  ResearchTraceSegmentedTimelineEvent,
  ResearchTraceTimeSegment
} from "../types/projectResearchTrace";

export const RESEARCH_TRACE_LAYOUT_LANE_CARD_Y: Record<ProjectResearchTraceLane, number> = {
  upperOutcome: 8,
  upperInsight: 86,
  axis: 160,
  lowerProgress: 244,
  lowerWork: 318
};

export const RESEARCH_TRACE_CARD_OUTER_WIDTH = 190;
export const RESEARCH_TRACE_CARD_VISIBLE_GAP = 32;
export const RESEARCH_TRACE_CARD_WIDTH = RESEARCH_TRACE_CARD_OUTER_WIDTH;
export const RESEARCH_TRACE_CARD_HORIZONTAL_GAP = RESEARCH_TRACE_CARD_VISIBLE_GAP;
export const RESEARCH_TRACE_LEFT_SAFE_PADDING = 96;
export const RESEARCH_TRACE_SEGMENT_SAFE_GAP = 24;
export const RESEARCH_TRACE_LAYOUT_CONTENT_WIDTH = 3000;
export const RESEARCH_TRACE_SLOT_PITCH = RESEARCH_TRACE_CARD_OUTER_WIDTH + RESEARCH_TRACE_CARD_VISIBLE_GAP;

const DEFAULT_LAYOUT_OPTIONS: ProjectResearchTraceLayoutOptions = {
  cardWidth: RESEARCH_TRACE_CARD_OUTER_WIDTH,
  cardHeight: 58,
  horizontalGap: RESEARCH_TRACE_CARD_VISIBLE_GAP,
  verticalGap: 16,
  contentWidth: RESEARCH_TRACE_LAYOUT_CONTENT_WIDTH,
  leftSafePadding: RESEARCH_TRACE_LEFT_SAFE_PADDING,
  segmentSafeGap: RESEARCH_TRACE_SEGMENT_SAFE_GAP
};

const RESEARCH_TRACE_CARD_LAYOUT_LANES: ProjectResearchTraceLane[] = [
  "upperOutcome",
  "upperInsight",
  "lowerProgress",
  "lowerWork"
];

export const RESEARCH_TRACE_ALLOWED_BORROW_LANE: Partial<Record<ProjectResearchTraceLane, ProjectResearchTraceLane>> = {
  upperOutcome: "upperInsight",
  upperInsight: "upperOutcome",
  lowerProgress: "lowerWork",
  lowerWork: "lowerProgress"
};

export const RESEARCH_TRACE_MARKER_JITTER_PX = 15;
export const RESEARCH_TRACE_MARKER_JITTER_GROUP_PX = 24;
export const RESEARCH_TRACE_TARGET_WIDTH_RATIO = [2, 2, 3] as const;

type Slot = {
  index: number;
  x: number;
};

function clampRatio(value: number) {
  if (!Number.isFinite(value)) {
    return 0.5;
  }
  return Math.min(1, Math.max(0, value));
}

function resolveOptions(options: Partial<ProjectResearchTraceLayoutOptions> = {}) {
  return {
    ...DEFAULT_LAYOUT_OPTIONS,
    ...options
  };
}

function getSlotPitch(options: ProjectResearchTraceLayoutOptions) {
  return options.cardWidth + options.horizontalGap;
}

export function resolveResearchTraceSlotGeometry(
  segments: ResearchTraceTimeSegment[],
  optionOverrides: Partial<ProjectResearchTraceLayoutOptions> = {}
): ProjectResearchTraceSlotGeometry {
  const options = resolveOptions(optionOverrides);
  const slotPitch = getSlotPitch(options);
  const targetWeightTotal = segments.reduce((total, segment) => total + segment.widthRatio, 0) || 1;
  const draftSegments = segments.map((segment, index) => {
    const boundarySafeStartPx = index === 0 ? 0 : options.segmentSafeGap / 2;
    const leftSafeStartPx = index === 0 ? options.leftSafePadding : 0;
    const safeStartPx = boundarySafeStartPx + leftSafeStartPx;
    const safeEndPx = index === segments.length - 1 ? 0 : options.segmentSafeGap / 2;
    const targetWidthPx = options.contentWidth * (segment.widthRatio / targetWeightTotal);
    const targetSlotAreaPx = Math.max(slotPitch, targetWidthPx - boundarySafeStartPx - safeEndPx);
    const slotCount = Math.max(1, Math.round(targetSlotAreaPx / slotPitch));
    const widthPx = slotCount * slotPitch + safeStartPx + safeEndPx;

    return {
      id: segment.id,
      timeRatio: segment.timeRatio,
      widthRatio: segment.widthRatio,
      targetWidthRatio: segment.widthRatio / targetWeightTotal,
      slotCount,
      widthPx,
      safeStartPx,
      safeEndPx
    };
  });

  const actualContentWidth = draftSegments.reduce((total, segment) => total + segment.widthPx, 0) || options.contentWidth;
  let cursorPx = 0;
  const slotSegments: ProjectResearchTraceSlotSegment[] = draftSegments.map((segment) => {
    const startPx = cursorPx;
    const endPx = startPx + segment.widthPx;
    cursorPx = endPx;
    const usableStartPx = startPx + segment.safeStartPx;
    const usableEndPx = endPx - segment.safeEndPx;

    return {
      id: segment.id,
      timeRatio: segment.timeRatio,
      widthRatio: segment.widthRatio,
      targetWidthRatio: segment.targetWidthRatio,
      slotCount: segment.slotCount,
      startPx,
      endPx,
      usableStartPx,
      usableEndPx,
      safeStartPx: segment.safeStartPx,
      safeEndPx: segment.safeEndPx,
      startXRatio: clampRatio(startPx / actualContentWidth),
      endXRatio: clampRatio(endPx / actualContentWidth),
      usableStartXRatio: clampRatio(usableStartPx / actualContentWidth),
      usableEndXRatio: clampRatio(usableEndPx / actualContentWidth)
    };
  });

  return {
    cardWidth: options.cardWidth,
    horizontalGap: options.horizontalGap,
    slotPitch,
    leftSafePadding: options.leftSafePadding,
    segmentSafeGap: options.segmentSafeGap,
    contentWidth: actualContentWidth,
    targetWidthRatio: [2, 2, 3],
    segments: slotSegments
  };
}

function getSlotSegmentForTimelineSegment(
  segmentId: ResearchTraceTimeSegment["id"],
  geometry: ProjectResearchTraceSlotGeometry
) {
  return geometry.segments.find((segment) => segment.id === segmentId);
}

export function mapResearchTraceSegmentXToSlotGeometry(
  segmentId: ResearchTraceTimeSegment["id"],
  xRatioInSegment: number,
  geometry: ProjectResearchTraceSlotGeometry
) {
  const segment = getSlotSegmentForTimelineSegment(segmentId, geometry);
  if (!segment) {
    return clampRatio(xRatioInSegment);
  }

  const segmentRatio = clampRatio(xRatioInSegment);
  return clampRatio(
    segment.usableStartXRatio + (segment.usableEndXRatio - segment.usableStartXRatio) * segmentRatio
  );
}

export function mapResearchTraceTimelineEventToSlotGeometry(
  event: ResearchTraceSegmentedTimelineEvent,
  geometry: ProjectResearchTraceSlotGeometry
) {
  return mapResearchTraceSegmentXToSlotGeometry(event.segmentId, event.xRatioInSegment, geometry);
}

export function mapResearchTraceOriginalXToSlotGeometry(
  xRatioOverall: number,
  segments: ResearchTraceTimeSegment[],
  geometry: ProjectResearchTraceSlotGeometry
) {
  const sourceX = clampRatio(xRatioOverall);
  const sourceSegment =
    segments.find((segment) => sourceX >= segment.startXRatio && sourceX <= segment.endXRatio) ??
    segments[segments.length - 1];

  if (!sourceSegment) {
    return sourceX;
  }

  const segmentWidth = sourceSegment.endXRatio - sourceSegment.startXRatio;
  const xRatioInSegment = segmentWidth <= 0 ? 0.5 : (sourceX - sourceSegment.startXRatio) / segmentWidth;
  return mapResearchTraceSegmentXToSlotGeometry(sourceSegment.id, xRatioInSegment, geometry);
}

function getSegmentForEvent(
  event: ResearchTraceSegmentedTimelineEvent,
  segments: ResearchTraceTimeSegment[]
) {
  return segments.find((segment) => segment.id === event.segmentId);
}

function getSlotCenters(
  segment: ProjectResearchTraceSlotSegment,
  geometry: ProjectResearchTraceSlotGeometry
): Slot[] {
  const firstCenterPx = segment.usableStartPx + geometry.cardWidth / 2;
  const minCenter = firstCenterPx / geometry.contentWidth;
  const maxCenter = (segment.usableEndPx - geometry.cardWidth / 2) / geometry.contentWidth;

  if (minCenter >= maxCenter || segment.slotCount === 1) {
    return [
      {
        index: 0,
        x: clampRatio((segment.usableStartXRatio + segment.usableEndXRatio) / 2)
      }
    ];
  }

  return Array.from({ length: segment.slotCount }, (_, index) => {
    const xPx = firstCenterPx + index * geometry.slotPitch;
    return {
      index,
      x: clampRatio(Math.min(maxCenter, Math.max(minCenter, xPx / geometry.contentWidth)))
    };
  });
}

function compareLayoutPlacementPriority(
  left: ResearchTraceSegmentedTimelineEvent,
  right: ResearchTraceSegmentedTimelineEvent
) {
  return (
    right.traceDisplayPriority - left.traceDisplayPriority ||
    right.occurredAt.localeCompare(left.occurredAt) ||
    left.renderOrder - right.renderOrder ||
    left.id.localeCompare(right.id)
  );
}

function getNearestAvailableSlot(
  anchorX: number,
  slots: Slot[],
  occupiedSlotIndexes: Set<number>
) {
  return [...slots]
    .filter((slot) => !occupiedSlotIndexes.has(slot.index))
    .sort((left, right) => Math.abs(left.x - anchorX) - Math.abs(right.x - anchorX) || left.index - right.index)[0];
}

function groupLayoutEvents(events: ResearchTraceSegmentedTimelineEvent[]) {
  const groups = new Map<string, ResearchTraceSegmentedTimelineEvent[]>();
  for (const event of events) {
    if (event.lane === "axis") {
      continue;
    }
    const key = event.segmentId;
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }
  return groups;
}

function getCandidateLayoutLanes(event: ResearchTraceSegmentedTimelineEvent) {
  const borrowLane = RESEARCH_TRACE_ALLOWED_BORROW_LANE[event.lane];
  return [event.lane, borrowLane].filter(
    (lane): lane is ProjectResearchTraceLane =>
      lane !== undefined && RESEARCH_TRACE_CARD_LAYOUT_LANES.includes(lane)
  );
}

function getNearestAvailableSlotForLane(
  anchorX: number,
  lane: ProjectResearchTraceLane,
  slotsByLane: Map<ProjectResearchTraceLane, Slot[]>,
  occupiedSlotsByLane: Map<ProjectResearchTraceLane, Set<number>>
) {
  return getNearestAvailableSlot(
    anchorX,
    slotsByLane.get(lane) ?? [],
    occupiedSlotsByLane.get(lane) ?? new Set<number>()
  );
}

function getMarkerJitterOffsets(
  events: ResearchTraceSegmentedTimelineEvent[],
  segments: ResearchTraceTimeSegment[],
  geometry: ProjectResearchTraceSlotGeometry
) {
  const eventsByAnchor = new Map<string, ResearchTraceSegmentedTimelineEvent[]>();

  for (const event of events) {
    if (event.lane === "axis") {
      continue;
    }
    const anchorX = mapResearchTraceTimelineEventToSlotGeometry(event, geometry);
    const anchorBucket = Math.round(anchorX * geometry.contentWidth / RESEARCH_TRACE_MARKER_JITTER_GROUP_PX);
    const key = `${event.segmentId}:${anchorBucket}`;
    eventsByAnchor.set(key, [...(eventsByAnchor.get(key) ?? []), event]);
  }

  const offsets = new Map<string, number>();
  for (const groupEvents of eventsByAnchor.values()) {
    if (groupEvents.length <= 1) {
      continue;
    }

    const sortedEvents = [...groupEvents].sort(compareLayoutPlacementPriority);
    for (const [index, event] of sortedEvents.entries()) {
      const segment = getSegmentForEvent(event, segments);
      if (!segment) {
        continue;
      }
      const slotSegment = getSlotSegmentForTimelineSegment(segment.id, geometry);
      if (!slotSegment) {
        continue;
      }
      const anchorX = mapResearchTraceTimelineEventToSlotGeometry(event, geometry);
      const offsetPx =
        sortedEvents.length === 2
          ? (index === 0 ? -RESEARCH_TRACE_MARKER_JITTER_PX / 2 : RESEARCH_TRACE_MARKER_JITTER_PX / 2)
          : -RESEARCH_TRACE_MARKER_JITTER_PX +
            (RESEARCH_TRACE_MARKER_JITTER_PX * 2 * index) / (sortedEvents.length - 1);
      const markerX = clampRatio(anchorX + offsetPx / geometry.contentWidth);
      offsets.set(
        event.id,
        Math.min(slotSegment.usableEndXRatio, Math.max(slotSegment.usableStartXRatio, markerX))
      );
    }
  }

  return offsets;
}

export function resolveResearchTraceCardLayout(
  events: ResearchTraceSegmentedTimelineEvent[],
  segments: ResearchTraceTimeSegment[],
  optionOverrides: Partial<ProjectResearchTraceLayoutOptions> = {}
): ProjectResearchTraceLayoutResult {
  const options = resolveOptions(optionOverrides);
  const slotGeometry = resolveResearchTraceSlotGeometry(segments, options);
  const items = new Map<string, ProjectResearchTraceLayoutItem>();
  const groups = groupLayoutEvents(events);
  const markerJitterByEventId = getMarkerJitterOffsets(events, segments, slotGeometry);

  for (const groupEvents of groups.values()) {
    const firstEvent = groupEvents[0];
    const segment = firstEvent ? getSegmentForEvent(firstEvent, segments) : undefined;
    const slotSegment = segment ? getSlotSegmentForTimelineSegment(segment.id, slotGeometry) : undefined;
    if (!segment || !slotSegment) {
      continue;
    }

    const slotsByLane = new Map<ProjectResearchTraceLane, Slot[]>(
      RESEARCH_TRACE_CARD_LAYOUT_LANES.map((lane) => [lane, getSlotCenters(slotSegment, slotGeometry)])
    );
    const occupiedSlotsByLane = new Map<ProjectResearchTraceLane, Set<number>>(
      RESEARCH_TRACE_CARD_LAYOUT_LANES.map((lane) => [lane, new Set<number>()])
    );

    for (const event of [...groupEvents].sort(compareLayoutPlacementPriority)) {
      const anchorX = mapResearchTraceTimelineEventToSlotGeometry(event, slotGeometry);
      const markerX = markerJitterByEventId.get(event.id) ?? anchorX;
      const placement = getCandidateLayoutLanes(event)
        .map((lane) => ({
          lane,
          slot: getNearestAvailableSlotForLane(anchorX, lane, slotsByLane, occupiedSlotsByLane)
        }))
        .find((candidate) => Boolean(candidate.slot));
      const baseItem = {
        eventId: event.id,
        segmentId: event.segmentId,
        semanticLane: event.lane,
        layoutLane: placement?.lane ?? event.lane,
        anchorX,
        markerX,
        cardY: RESEARCH_TRACE_LAYOUT_LANE_CARD_Y[placement?.lane ?? event.lane]
      };

      if (!placement?.slot) {
        items.set(event.id, {
          ...baseItem,
          cardX: anchorX,
          slotIndex: null,
          isOverflowHidden: true
        });
        continue;
      }

      occupiedSlotsByLane.get(placement.lane)?.add(placement.slot.index);
      items.set(event.id, {
        ...baseItem,
        cardX: placement.slot.x,
        slotIndex: placement.slot.index,
        isOverflowHidden: false
      });
    }
  }

  const orderedItems = events
    .map((event) => items.get(event.id))
    .filter((item): item is ProjectResearchTraceLayoutItem => Boolean(item));

  return {
    items: orderedItems,
    overflowCount: orderedItems.filter((item) => item.isOverflowHidden).length,
    slotGeometry,
    geometry: {
      contentWidthPx: slotGeometry.contentWidth,
      cardOuterWidth: slotGeometry.cardWidth,
      visibleGap: slotGeometry.horizontalGap,
      slotPitch: slotGeometry.slotPitch,
      leftSafePadding: slotGeometry.leftSafePadding,
      segmentSafeGap: slotGeometry.segmentSafeGap,
      segmentGeometry: slotGeometry.segments
    }
  };
}
