import { invoke } from "@tauri-apps/api/core";
import { experimentService } from "./experimentService";
import { milestoneService } from "./milestoneService";
import { outputService } from "./outputService";
import { planningService } from "./planningService";
import { taskService } from "./taskService";
import type { EntityId } from "../types";
import type { Experiment, Milestone, ResearchOutput, ResearchTask } from "../types";
import type { Project } from "../types/planning";
import { getTaskTypeDisplayLabel } from "../utils/planningIdeaState";

type ResearchPlanSnapshot = {
  exportedAt: string;
  schemaVersion: 1;
  scope: "all" | "project";
  projectId?: EntityId;
  projects: Project[];
  milestones: Milestone[];
  tasks: ResearchTask[];
  experiments: Experiment[];
  outputs: ResearchOutput[];
};

type ExportResult = {
  saved: boolean;
  filePath?: string;
  message: string;
};

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function timestampForFileName() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function sanitizeFileName(value: string) {
  return value.replace(/[<>:"/\\|?*]/g, "_").replace(/\s+/g, "_").slice(0, 80);
}

function downloadBlob(defaultFileName: string, contents: string, mimeType: string) {
  const blob = new Blob([contents], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = defaultFileName;
  link.click();
  URL.revokeObjectURL(url);
}

async function saveTextFile(defaultFileName: string, contents: string, mimeType: string) {
  if (isTauriRuntime()) {
    const filePath = await invoke<string | null>("save_text_file", {
      defaultFileName,
      contents
    });

    return filePath
      ? {
          saved: true,
          filePath,
          message: `Export saved to ${filePath}`
        }
      : {
          saved: false,
          message: "Export cancelled."
        };
  }

  downloadBlob(defaultFileName, contents, mimeType);
  return {
    saved: true,
    message: `Browser download started for ${defaultFileName}`
  };
}

async function loadSnapshot(projectId?: EntityId): Promise<ResearchPlanSnapshot> {
  const [projects, milestones, tasks, experiments, outputs] = await Promise.all([
    planningService.queryProjects(),
    milestoneService.listMilestones(),
    taskService.listTasks(),
    experimentService.listExperiments(),
    outputService.listOutputs()
  ]);

  if (!projectId) {
    return {
      exportedAt: new Date().toISOString(),
      schemaVersion: 1,
      scope: "all",
      projects,
      milestones,
      tasks,
      experiments,
      outputs
    };
  }

  return {
    exportedAt: new Date().toISOString(),
    schemaVersion: 1,
    scope: "project",
    projectId,
    projects: projects.filter((project) => project.id === projectId),
    milestones: milestones.filter((milestone) => milestone.projectId === projectId),
    tasks: tasks.filter((task) => task.projectId === projectId),
    experiments: experiments.filter((experiment) => experiment.projectId === projectId),
    outputs: outputs.filter((output) => output.projectId === projectId)
  };
}

function toJson(snapshot: ResearchPlanSnapshot) {
  return JSON.stringify(snapshot, null, 2);
}

function valueOrEmpty(value: unknown) {
  return value === undefined || value === null || value === "" ? "-" : String(value);
}

function toMarkdown(snapshot: ResearchPlanSnapshot) {
  const projectNameById = new Map(snapshot.projects.map((project) => [project.id, project.title]));
  const taskNameById = new Map(snapshot.tasks.map((task) => [task.id, task.title]));

  const taskSections = snapshot.tasks.map((task) =>
    [
      `### ${task.title}`,
      "",
      `- Project: ${valueOrEmpty(projectNameById.get(task.projectId) ?? task.projectId)}`,
      `- Type: ${getTaskTypeDisplayLabel(task.taskType)}`,
      `- Priority: ${task.priority}`,
      `- Status: ${task.status}`,
      `- Start date: ${valueOrEmpty(task.startDate)}`,
      `- Due date: ${valueOrEmpty(task.dueDate)}`,
      `- Estimated hours: ${valueOrEmpty(task.estimatedHours)}`,
      `- Actual hours: ${valueOrEmpty(task.actualHours)}`,
      `- Acceptance criteria: ${valueOrEmpty(task.acceptanceCriteria)}`,
      `- Blocker: ${valueOrEmpty(task.blocker)}`,
      `- Review: ${valueOrEmpty(task.review)}`,
      "",
      task.description
    ].join("\n")
  );

  const experimentSections = snapshot.experiments.map((experiment) =>
    [
      `### ${experiment.experimentName}`,
      "",
      `- Project: ${valueOrEmpty(projectNameById.get(experiment.projectId) ?? experiment.projectId)}`,
      `- Related task: ${valueOrEmpty(experiment.taskId ? taskNameById.get(experiment.taskId) ?? experiment.taskId : undefined)}`,
      `- Machine object: ${experiment.machineObject}`,
      `- Fault type: ${experiment.faultType}`,
      `- Speed: ${valueOrEmpty(experiment.speed)}`,
      `- Load: ${valueOrEmpty(experiment.load)}`,
      `- Sensor config: ${experiment.sensorConfig}`,
      `- Data path: ${experiment.dataPath}`,
      `- Sampling rate: ${valueOrEmpty(experiment.samplingRate)}`,
      `- Duration: ${valueOrEmpty(experiment.duration)}`,
      `- Result summary: ${valueOrEmpty(experiment.resultSummary)}`,
      `- Problem notes: ${valueOrEmpty(experiment.problemNotes)}`,
      `- Next action: ${valueOrEmpty(experiment.nextAction)}`
    ].join("\n")
  );

  return [
    "# SciLoom Tasks and Experiments",
    "",
    `Exported at: ${snapshot.exportedAt}`,
    `Scope: ${snapshot.scope}${snapshot.projectId ? ` (${snapshot.projectId})` : ""}`,
    "",
    "## Tasks",
    "",
    taskSections.length > 0 ? taskSections.join("\n\n") : "No tasks.",
    "",
    "## Experiments",
    "",
    experimentSections.length > 0 ? experimentSections.join("\n\n") : "No experiments.",
    ""
  ].join("\n");
}

function csvCell(value: unknown) {
  const text = value === undefined || value === null ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function toOutputsCsv(outputs: ResearchOutput[]) {
  const headers = [
    "id",
    "projectId",
    "taskId",
    "experimentId",
    "outputName",
    "outputType",
    "usableForPaper",
    "description",
    "createdAt",
    "updatedAt",
    "deletedAt"
  ];

  const rows = outputs.map((output) =>
    headers.map((header) => csvCell(output[header as keyof ResearchOutput])).join(",")
  );

  return [headers.join(","), ...rows].join("\r\n");
}

export const exportService = {
  async listProjects() {
    return planningService.queryProjects();
  },

  async exportAllJson(): Promise<ExportResult> {
    const snapshot = await loadSnapshot();
    return saveTextFile(
      `labpod-all-${timestampForFileName()}.json`,
      toJson(snapshot),
      "application/json"
    );
  },

  async exportProjectJson(projectId: EntityId): Promise<ExportResult> {
    const snapshot = await loadSnapshot(projectId);
    const projectName = snapshot.projects[0]?.title ?? projectId;
    return saveTextFile(
      `labpod-project-${sanitizeFileName(projectName)}-${timestampForFileName()}.json`,
      toJson(snapshot),
      "application/json"
    );
  },

  async exportTasksAndExperimentsMarkdown(projectId?: EntityId): Promise<ExportResult> {
    const snapshot = await loadSnapshot(projectId);
    return saveTextFile(
      `labpod-tasks-experiments-${timestampForFileName()}.md`,
      toMarkdown(snapshot),
      "text/markdown"
    );
  },

  async exportOutputsCsv(projectId?: EntityId): Promise<ExportResult> {
    const snapshot = await loadSnapshot(projectId);
    return saveTextFile(
      `labpod-outputs-${timestampForFileName()}.csv`,
      toOutputsCsv(snapshot.outputs),
      "text/csv"
    );
  },

  isDesktopRuntime: isTauriRuntime
};
