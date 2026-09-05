export type RouteResearchProgressStatus =
  | "active"
  | "completed"
  | "planned";

export type RouteResearchProgressItem = {
  routeId: string;
  projectId: string;
  title: string;
  status: RouteResearchProgressStatus;
  startDate?: string;
  endDate?: string;
  timeText: string;
  sortDate: string;
  colorState: RouteResearchProgressStatus;
};

export type RoutesResearchProgressData = {
  projectId: string;
  items: RouteResearchProgressItem[];
};
