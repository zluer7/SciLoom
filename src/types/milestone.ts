import type { AuditableEntity, EntityId, ISODateString, WorkStatus } from "./common";

export type MilestoneTimeScale = "year" | "quarter" | "month" | "week";

export type MilestoneStatus = WorkStatus;

export type Milestone = AuditableEntity & {
  projectId: EntityId;
  title: string;
  description: string;
  timeScale: MilestoneTimeScale;
  startDate: ISODateString;
  endDate: ISODateString;
  expectedOutput: string;
  status: WorkStatus;
  progress: number;
};
