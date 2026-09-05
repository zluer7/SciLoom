import type {
  AuditableEntity,
  EntityId,
  ISODateString,
  Priority,
  WorkStatus
} from "./common";

export type TaskType =
  | "reading"
  | "experiment"
  | "analysis"
  | "coding"
  | "writing"
  | "review";

export type ResearchTask = AuditableEntity & {
  projectId: EntityId;
  milestoneId?: EntityId;
  title: string;
  description: string;
  taskType: TaskType;
  priority: Priority;
  status: WorkStatus;
  startDate?: ISODateString;
  dueDate?: ISODateString;
  estimatedHours?: number;
  actualHours?: number;
  acceptanceCriteria: string;
  blocker?: string;
  review?: string;
};

export type Task = ResearchTask;
export type TaskStatus = WorkStatus;
