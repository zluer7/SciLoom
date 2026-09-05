import type { PlanningData, Task } from "../types/planning";
import {
  getRouteSemanticLabel,
  getTaskCaptureStateDisplayLabel,
  getTaskSemanticLabel
} from "./planningIdeaState";
import { getProjectExportContext, getVisibleItems } from "./planningSelectors";

function escapeCsvValue(value: unknown): string {
  const text = value === undefined || value === null ? "" : String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

function taskToCsvRow(task: Task): string {
  return [
    task.id,
    task.projectId,
    task.routeNodeId ?? "",
    task.title,
    getTaskSemanticLabel(task),
    task.status,
    task.priority,
    task.timeBucket,
    getTaskCaptureStateDisplayLabel(task.captureState),
    task.scheduledDate ?? "",
    task.dueDate ?? "",
    task.completedAt ?? "",
    task.acceptanceCriteria ?? "",
    task.blockedReason ?? "",
    task.tags.join(";")
  ]
    .map(escapeCsvValue)
    .join(",");
}

export function exportPlanningAsJson(data: PlanningData): string {
  return JSON.stringify(
    {
      ...data,
      exportedAt: new Date().toISOString()
    },
    null,
    2
  );
}

export const exportAsJson = exportPlanningAsJson;

export function exportProjectAsMarkdown(data: PlanningData, projectId: string): string {
  const context = getProjectExportContext(data, projectId);
  if (!context) {
    return `# Project Not Found\n\nProject id: ${projectId}\n`;
  }

  const routeLines = context.routeNodes.length
    ? context.routeNodes.map((route) => `- ${route.title} (${route.status}, ${getRouteSemanticLabel(route)})`)
    : ["- 暂无路线"];

  const taskLines = context.tasks.length
    ? context.tasks.map((task) => `- [${task.status}] ${task.title}`)
    : ["- 暂无任务"];

  const reviewLines = context.reviews.length
    ? context.reviews.map((review) => `- ${review.title}`)
    : ["- 暂无复盘"];

  const experimentLines = context.experimentSummaries.length
    ? context.experimentSummaries.map((experiment) => `- ${experiment.title}`)
    : ["- 暂无实验摘要"];

  return [
    `# ${context.project.title}`,
    "",
    `Direction: ${context.direction?.title ?? "未设置"}`,
    `Status: ${context.project.status}`,
    `Priority: ${context.project.priority}`,
    "",
    "## Description",
    "",
    context.project.description ?? "暂无描述",
    "",
    "## Objective",
    "",
    context.project.objective ?? "暂无目标",
    "",
    "## Routes",
    "",
    ...routeLines,
    "",
    "## Tasks",
    "",
    ...taskLines,
    "",
    "## Reviews",
    "",
    ...reviewLines,
    "",
    "## Experiments",
    "",
    ...experimentLines,
    ""
  ].join("\n");
}

export function exportTasksAsCsv(data: PlanningData, projectId?: string): string {
  const tasks = getVisibleItems(data.tasks)
    .filter((task) => !projectId || task.projectId === projectId)
    .sort((a, b) => a.orderIndex - b.orderIndex);

  const header = [
    "id",
    "projectId",
    "routeNodeId",
    "title",
    "taskTypeLabel",
    "status",
    "priority",
    "timeBucket",
    "captureStateLabel",
    "scheduledDate",
    "dueDate",
    "completedAt",
    "acceptanceCriteria",
    "blockedReason",
    "tags"
  ].join(",");

  return [header, ...tasks.map(taskToCsvRow)].join("\n");
}
