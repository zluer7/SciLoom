import type { CaptureState, TaskType } from "../types/planning";

export type TaskIdeaType =
  | "reading"
  | "experiment"
  | "analysis"
  | "coding"
  | "writing"
  | "review"
  | "idea";

const routeConceptStates = new Set<CaptureState>(["idea", "pending", "someday"]);
const taskPendingStates = new Set<CaptureState>(["pending", "someday"]);

type TaskSemanticInput = {
  taskType?: string;
  captureState?: string;
};

type RouteSemanticInput = {
  captureState?: string;
};

const taskTypeLabels: Record<TaskType, string> = {
  reading: "阅读任务",
  experiment: "实验任务",
  coding: "代码任务",
  writing: "写作任务",
  analysis: "分析任务",
  meeting: "会议任务",
  idea: "任务想法",
  review: "复盘任务",
  other: "其他任务"
};

const taskCaptureStateLabels: Record<CaptureState, string> = {
  scheduled: "已排期",
  unscheduled: "未排期",
  idea: "捕获为想法",
  pending: "待整理",
  someday: "未来再议",
  archived: "已归档"
};

const routeCaptureStateLabels: Record<CaptureState, string> = {
  scheduled: "已排期路线",
  unscheduled: "未排期路线",
  idea: "路线构想",
  pending: "待整理路线",
  someday: "未来再议路线",
  archived: "已归档路线"
};

export function isTaskIdeaType(taskType?: string): taskType is "idea" {
  return taskType === "idea";
}

export function isTaskIdea(task: TaskSemanticInput): boolean {
  return isTaskIdeaType(task.taskType);
}

export function isTaskIdeaOrPending(task: TaskSemanticInput): boolean {
  return isTaskIdea(task) || taskPendingStates.has(task.captureState as CaptureState);
}

export function isRouteConceptCaptureState(captureState?: string): captureState is CaptureState {
  return routeConceptStates.has(captureState as CaptureState);
}

export function isRouteConcept(route: RouteSemanticInput | string | undefined): boolean {
  const captureState = typeof route === "string" ? route : route?.captureState;
  return isRouteConceptCaptureState(captureState);
}

export function resolveDefaultRouteCaptureState(hasExplicitTime: boolean): CaptureState {
  return hasExplicitTime ? "scheduled" : "pending";
}

export function getTaskTypeDisplayLabel(taskType?: string): string {
  if (!taskType) {
    return "任务类型未设置";
  }

  return taskTypeLabels[taskType as TaskType] ?? `未知任务类型（raw: ${taskType}）`;
}

export function getTaskCaptureStateDisplayLabel(captureState?: string): string {
  if (!captureState) {
    return "捕获状态未设置";
  }

  return taskCaptureStateLabels[captureState as CaptureState] ?? `未知捕获状态（raw: ${captureState}）`;
}

export function getRouteCaptureStateDisplayLabel(captureState?: string): string {
  if (!captureState) {
    return "路线捕获状态未设置";
  }

  return routeCaptureStateLabels[captureState as CaptureState] ?? `未知路线捕获状态（raw: ${captureState}）`;
}

export function getTaskSemanticLabel(task: TaskSemanticInput): string {
  if (isTaskIdea(task)) {
    return getTaskTypeDisplayLabel("idea");
  }

  return getTaskTypeDisplayLabel(task.taskType);
}

export function getRouteSemanticLabel(route: RouteSemanticInput): string {
  return getRouteCaptureStateDisplayLabel(route.captureState);
}
