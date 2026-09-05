import type { EntityId, ISODateString } from "./common";
import type { RefreshKey } from "./writeFeedback";

export const PROJECT_RESEARCH_TRACE_REFRESH_KEYS: RefreshKey[] = [
  "researchTrace.changed",
  "project.changed",
  "route.changed",
  "review.changed",
  "output.finding.changed",
  "output.candidate.changed",
  "output.gap.changed",
  "output.researchOutput.changed"
];

export type ProjectResearchTraceEventType =
  | "projectCreated"
  | "routeStarted"
  | "routeCompleted"
  | "reviewRecorded"
  | "findingCreated"
  | "candidateCreated"
  | "gapCreated"
  | "researchOutputCreated"
  | "taskRecorded"
  | "experimentRecorded"
  | "experimentRunRecorded"
  | "literatureRecorded"
  | "resultItemCreated";

export type ProjectResearchTraceTargetType =
  | "project"
  | "route"
  | "review"
  | "finding"
  | "outputCandidate"
  | "outputGap"
  | "researchOutput"
  | "task"
  | "experiment"
  | "experimentRun"
  | "literature"
  | "resultItem"
  | "fileRef"
  | "readingRecord"
  | "operationLog"
  | "ai"
  | "entityLink"
  | "other";

export type ProjectResearchTraceSourceModule =
  | "project"
  | "route"
  | "review"
  | "outputs"
  | "experiment"
  | "literature"
  | "task"
  | "other";

export type ProjectResearchTraceSourcePolicy = "auto" | "pinned" | "hidden";

export type ProjectResearchTraceDisplayState = "auto" | "pinned";

export type ProjectResearchTracePreferenceVisibility = "auto" | "pinned" | "hidden";

export type ResearchTraceDisplayDensity = "compact" | "standard" | "relaxed";

export type ResearchTraceTimeScaleMode = "segmentedCompressed";

export type ResearchTraceTimeSegmentId = "history" | "middle" | "recent";

export type ResearchTraceTickGranularity = "day" | "week" | "month" | "quarter" | "year";

export type ResearchTraceTickLimits = Record<ResearchTraceTimeSegmentId, number>;

export interface ResearchTraceEventPreference {
  id: EntityId;
  projectId: EntityId;
  targetType: ProjectResearchTraceTargetType;
  targetId: EntityId;
  visibility: ProjectResearchTracePreferenceVisibility;
  note?: string;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  deletedAt?: ISODateString | null;
}

export type ProjectResearchTraceDatePrecision = "day" | "month" | "year" | "unknown";

export type ProjectResearchTraceLane =
  | "upperOutcome"
  | "upperInsight"
  | "axis"
  | "lowerProgress"
  | "lowerWork";

export type ProjectResearchTracePriority =
  | "researchOutput"
  | "outputCandidate"
  | "finding"
  | "normal";

export type ProjectResearchTraceWarningCode =
  | "missingProject"
  | "missingDate"
  | "invalidDate"
  | "futureDate"
  | "overLimit";

export interface ProjectResearchTraceData {
  projectId: string;
  projectTitle?: string;
  generatedAt: string;
  rangeStart?: string;
  rangeEnd?: string;
  displayLimit: number;
  defaultVisibleCount: number;
  maxRenderableCount: number;
  visibleCount: number;
  totalCount: number;
  overflowCount: number;
  collapsedCount: number;
  isLimited: boolean;
  events: ProjectResearchTraceEvent[];
  hiddenSummary: ProjectResearchTraceHiddenSummary;
  warnings?: ProjectResearchTraceWarning[];
  partial: boolean;
}

export interface ResearchTraceTimeSegment {
  id: ResearchTraceTimeSegmentId;
  startDate: string;
  endDate: string;
  timeRatio: number;
  widthRatio: number;
  widthShare: number;
  startXRatio: number;
  endXRatio: number;
  eventLimit: number;
}

export interface ResearchTraceSegmentedTimelineEvent extends ProjectResearchTraceEvent {
  segmentId: ResearchTraceTimeSegmentId;
  xRatioInSegment: number;
  xRatioOverall: number;
}

export interface ProjectResearchTraceLayoutItem {
  eventId: string;
  segmentId: ResearchTraceTimeSegmentId;
  semanticLane: ProjectResearchTraceLane;
  layoutLane: ProjectResearchTraceLane;
  anchorX: number;
  markerX: number;
  cardX: number;
  cardY: number;
  slotIndex: number | null;
  isOverflowHidden: boolean;
}

export interface ProjectResearchTraceLayoutResult {
  items: ProjectResearchTraceLayoutItem[];
  overflowCount: number;
  slotGeometry: ProjectResearchTraceSlotGeometry;
  geometry: ProjectResearchTraceLayoutGeometry;
}

export interface ProjectResearchTraceLayoutGeometry {
  contentWidthPx: number;
  cardOuterWidth: number;
  visibleGap: number;
  slotPitch: number;
  leftSafePadding: number;
  segmentSafeGap: number;
  segmentGeometry: ProjectResearchTraceSlotSegment[];
}

export interface ProjectResearchTraceLayoutOptions {
  cardWidth: number;
  cardHeight: number;
  horizontalGap: number;
  verticalGap: number;
  contentWidth: number;
  leftSafePadding: number;
  segmentSafeGap: number;
}

export interface ProjectResearchTraceSlotSegment {
  id: ResearchTraceTimeSegmentId;
  timeRatio: number;
  widthRatio: number;
  targetWidthRatio: number;
  slotCount: number;
  startPx: number;
  endPx: number;
  usableStartPx: number;
  usableEndPx: number;
  safeStartPx: number;
  safeEndPx: number;
  startXRatio: number;
  endXRatio: number;
  usableStartXRatio: number;
  usableEndXRatio: number;
}

export interface ProjectResearchTraceSlotGeometry {
  cardWidth: number;
  horizontalGap: number;
  slotPitch: number;
  leftSafePadding: number;
  segmentSafeGap: number;
  contentWidth: number;
  targetWidthRatio: [number, number, number];
  segments: ProjectResearchTraceSlotSegment[];
}

export interface ResearchTraceTick {
  id: string;
  segmentId: ResearchTraceTimeSegmentId;
  label: string;
  occurredAt: string;
  xRatioInSegment: number;
  xRatioOverall: number;
  granularity: ResearchTraceTickGranularity;
}

export type ResearchTraceAdaptiveTick = ResearchTraceTick;

export interface ResearchTraceAxisBreak {
  id: "history-middle" | "middle-recent";
  xRatioOverall: number;
}

export interface ResearchTraceSegmentedTimelineViewModel {
  timeScaleMode: ResearchTraceTimeScaleMode;
  displayDensity: ResearchTraceDisplayDensity;
  baseDisplayLimit: number;
  rangeStart?: string;
  rangeEnd?: string;
  segments: ResearchTraceTimeSegment[];
  events: ResearchTraceSegmentedTimelineEvent[];
  projectCreatedEvent?: ResearchTraceSegmentedTimelineEvent;
  adaptiveTicks: ResearchTraceTick[];
  tickGranularity: ResearchTraceTickGranularity;
  tickSegmentGranularity: Record<ResearchTraceTimeSegmentId, ResearchTraceTickGranularity>;
  axisBreaks: ResearchTraceAxisBreak[];
  collapsedCount: number;
  totalTimelineEventCount: number;
}

export interface ProjectResearchTraceEvent {
  id: string;
  projectId: string;
  eventType: ProjectResearchTraceEventType;
  targetType: ProjectResearchTraceTargetType;
  targetId: string;
  title: string;
  description?: string;
  occurredAt: string;
  occurredAtPrecision: ProjectResearchTraceDatePrecision;
  sourcePolicy: ProjectResearchTraceSourcePolicy;
  displayState: ProjectResearchTraceDisplayState;
  canBePinned: boolean;
  sourceModule: ProjectResearchTraceSourceModule;
  lane: ProjectResearchTraceLane;
  priority: ProjectResearchTracePriority;
  traceDisplayPriority: number;
  renderOrder: number;
  markerStackIndex: number;
  markerStackOffset: number;
  typeLabel: string;
  statusLabel?: string;
  warning?: string;
}

export interface ProjectResearchTraceHiddenSummary {
  hiddenMissingDate: number;
  hiddenInvalidDate: number;
  hiddenFutureDate: number;
  hiddenArchivedOrDeleted: number;
  hiddenByProject: number;
  hiddenByDefaultPolicy: number;
  hiddenByPreference: number;
  overLimit: number;
}

export interface ProjectResearchTraceWarning {
  code: ProjectResearchTraceWarningCode;
  message: string;
  eventType?: ProjectResearchTraceEventType;
  targetType?: ProjectResearchTraceTargetType;
  targetId?: string;
}

export interface ProjectResearchTraceSelectorOptions {
  limit?: number;
  defaultVisibleCount?: number;
  maxRenderableCount?: number;
  baseDisplayLimit?: number;
  includeWarnings?: boolean;
  includeHiddenSummary?: boolean;
  today?: string;
  excludeFutureEvents?: boolean;
}
