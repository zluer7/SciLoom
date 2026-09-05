export type ProjectRouteGanttStatus = "completed" | "active" | "planned" | "idea";

export type ProjectRouteGanttDateCompleteness = "complete" | "startOnly" | "endOnly";

export type ProjectRouteGanttDisplayMode = "solid" | "fadeRight" | "fadeLeft";

export type ProjectRouteGanttTickGranularity =
  | "day"
  | "week"
  | "month"
  | "quarter"
  | "year";

export interface ProjectRouteGanttTimeTick {
  id: string;
  date: string;
  label: string;
  granularity: ProjectRouteGanttTickGranularity;
}

export type ProjectRouteGanttWarningCode =
  | "invalidDateRange"
  | "missingProject"
  | "unknownStatus";

export interface ProjectRouteGanttData {
  projectId: string;
  projectTitle?: string;
  rangeStart?: string;
  rangeEnd?: string;
  timeTicks: ProjectRouteGanttTimeTick[];
  tickGranularity?: ProjectRouteGanttTickGranularity;
  defaultVerticalAnchorRouteId?: string;
  visibleItems: ProjectRouteGanttItem[];
  hiddenSummary: ProjectRouteGanttHiddenSummary;
  warnings?: ProjectRouteGanttWarning[];
}

export interface ProjectRouteGanttItem {
  routeId: string;
  projectId: string;
  title: string;
  status: ProjectRouteGanttStatus;
  statusLabel: string;
  startDate?: string;
  endDate?: string;
  dateCompleteness: ProjectRouteGanttDateCompleteness;
  displayMode: ProjectRouteGanttDisplayMode;
  timeLabel: string;
  orderIndex: number;
  originalStatus?: string;
  captureState?: string;
}

export interface ProjectRouteGanttHiddenSummary {
  hiddenByDisplaySwitch: number;
  hiddenIdeaWithoutDate: number;
  hiddenNoDate: number;
  hiddenInvalidDateRange: number;
}

export interface ProjectRouteGanttWarning {
  routeId?: string;
  code: ProjectRouteGanttWarningCode;
  message: string;
}
