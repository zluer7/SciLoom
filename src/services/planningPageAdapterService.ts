import { planningSelectorService } from "./planningSelectorService";
import { planningService } from "./planningService";
import type {
  EntityId,
  MilestoneTimeScale,
  Priority as PagePriority,
  WorkStatus
} from "../types";
import type {
  CaptureState,
  Project,
  ProjectStatus,
  Priority as PlanningPriority,
  RouteNode,
  RouteNodeStatus,
  RouteNodeType,
  Task,
  TaskStatus,
  TaskType,
  TimePrecision
} from "../types/planning";
import type {
  ProjectRoutineSummary,
  RouteCheckpointProgressSummary,
  RouteNodeTaskSummary
} from "../types/planningContext";
import {
  outputGapFeedbackSelectorService,
  type OutputGapFeedbackGapSummary
} from "./outputGapFeedbackSelectorService";
import type { TaskIdeaType } from "../utils/planningIdeaState";

export type PlanningProjectPageProject = {
  id: EntityId;
  title: string;
  name: string;
  description: string;
  significance: string;
  objective: string;
  methodSummary: string;
  expectedOutputs: string;
  keyQuestions: string[];
  status: WorkStatus;
  planningStatus: ProjectStatus;
  priority: PagePriority;
  planningPriority: PlanningPriority;
  progress: number;
  startDate?: string;
  targetDate?: string;
  customFields?: Record<string, unknown>;
  updatedAt: string;
  createdAt: string;
};

export type PlanningProjectPlanRouteEntry = {
  id: EntityId;
  projectId: EntityId;
  title: string;
  description: string;
  status: WorkStatus;
  planningStatus: RouteNodeStatus;
  nodeType: RouteNodeType;
  captureState: CaptureState;
  orderIndex: number;
  timeLabel: string;
  startDate: string;
  endDate: string;
  timeScale: MilestoneTimeScale;
  expectedOutput: string;
  progress: number;
  updatedAt: string;
  showInGantt: boolean;
  customFields?: Record<string, unknown>;
};

export type PlanningProjectPlanTaskEntry = {
  id: EntityId;
  projectId: EntityId;
  routeNodeId?: EntityId;
  milestoneId?: EntityId;
  title: string;
  description: string;
  status: WorkStatus;
  planningStatus: TaskStatus;
  taskType: TaskIdeaType;
  priority: PagePriority;
  captureState: CaptureState;
  timeLabel: string;
  startDate: string;
  endDate: string;
  acceptanceCriteria: string;
  resultNote: string;
};

export type PlanningProjectProgressSummary = {
  routeTotal: number;
  routeActive: number;
  routeBlocked: number;
  routeCompleted: number;
  taskTotal: number;
  taskActive: number;
  taskPlanned: number;
  taskIdea: number;
  taskCompleted: number;
  reviewTotal: number;
  latestReviewTitle: string;
  latestReviewUpdatedAt?: string;
};

export type PlanningProjectResearchContextSummary = {
  projectId: EntityId;
  routeCount: number;
  taskCount: number;
  reviewCount: number;
  experimentEvidenceCount: number;
  literatureEvidenceCount: number;
  outputEvidenceCount: number;
  outputGapCount: number;
  warningCount: number;
  missingReferenceCount: number;
  warnings: string[];
  excluded: string[];
  partial: boolean;
  aiReady: boolean;
  generatedAt: string;
};

export type PlanningProjectOverviewSummary = {
  progress: PlanningProjectProgressSummary;
  researchContext: PlanningProjectResearchContextSummary;
};

export type PlanningProjectsPageModel = {
  projects: PlanningProjectPageProject[];
  planItemsByProjectId: Record<
    EntityId,
    {
      routeNodes: PlanningProjectPlanRouteEntry[];
      tasks: PlanningProjectPlanTaskEntry[];
    }
  >;
  projectSummariesByProjectId: Record<EntityId, PlanningProjectOverviewSummary>;
};

export type PlanningProjectsPageBaseModel = Omit<
  PlanningProjectsPageModel,
  "projectSummariesByProjectId"
>;

export type PlanningRoutesPageModel = {
  projects: PlanningProjectPageProject[];
  routeNodes: PlanningProjectPlanRouteEntry[];
  outputGapSummariesByRouteNodeId: Record<EntityId, OutputGapFeedbackGapSummary[]>;
  checkpointSummariesByRouteNodeId: Record<EntityId, RouteCheckpointProgressSummary>;
  taskSummariesByRouteNodeId: Record<EntityId, RouteNodeTaskSummary>;
};

export type PlanningTasksPageModel = {
  projects: PlanningProjectPageProject[];
  routeNodes: PlanningProjectPlanRouteEntry[];
  tasks: PlanningProjectPlanTaskEntry[];
  outputGapSummariesByTaskId: Record<EntityId, OutputGapFeedbackGapSummary[]>;
  projectRoutineSummariesByProjectId: Record<EntityId, ProjectRoutineSummary>;
};

export type PlanningReviewTargetsModel = {
  projects: PlanningProjectPageProject[];
  routeNodes: PlanningProjectPlanRouteEntry[];
  tasks: PlanningProjectPlanTaskEntry[];
};

type PlanningProjectOverviewContext = Awaited<
  ReturnType<typeof planningSelectorService.getProjectOverviewContext>
>;

function formatTimeLabel(startDate?: string, endDate?: string, explicitLabel?: string) {
  if (explicitLabel) {
    return explicitLabel;
  }

  const start = startDate || endDate || "";
  const end = endDate || startDate || "";

  if (!start && !end) {
    return "Unscheduled";
  }

  return end && start !== end ? `${start} - ${end}` : start;
}

function readStringCustomField(
  customFields: Record<string, unknown> | undefined,
  key: string
) {
  const value = customFields?.[key];
  return typeof value === "string" ? value : "";
}

function readStringArrayCustomField(
  customFields: Record<string, unknown> | undefined,
  key: string
) {
  const value = customFields?.[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function projectStatusToWorkStatus(status: ProjectStatus): WorkStatus {
  switch (status) {
    case "active":
      return "in_progress";
    case "paused":
      return "blocked";
    case "completed":
    case "archived":
      return status;
    case "planning":
    default:
      return "planned";
  }
}

function routeNodeStatusToWorkStatus(status: RouteNodeStatus): WorkStatus {
  switch (status) {
    case "active":
      return "in_progress";
    case "completed":
    case "archived":
      return status;
    case "paused":
    case "adjusted":
      return "blocked";
    case "planned":
    default:
      return "planned";
  }
}

function taskStatusToWorkStatus(status: TaskStatus): WorkStatus {
  switch (status) {
    case "doing":
      return "in_progress";
    case "done":
      return "completed";
    case "delayed":
    case "blocked":
      return "blocked";
    case "cancelled":
    case "archived":
      return "archived";
    case "todo":
    default:
      return "planned";
  }
}

function planningPriorityToPagePriority(priority: PlanningPriority): PagePriority {
  return priority;
}

function routeProgress(routeNode: RouteNode) {
  const progress = routeNode.customFields?.progress;
  if (typeof progress === "number") {
    return progress;
  }
  return routeNode.status === "completed" ? 100 : 0;
}

function timePrecisionToTimeScale(timePrecision?: TimePrecision): MilestoneTimeScale {
  switch (timePrecision) {
    case "month":
      return "month";
    case "quarter":
    case "phase":
      return "quarter";
    case "day":
    case "week":
    case "free":
    default:
      return "week";
  }
}

function taskTypeToPageTaskType(taskType: TaskType): TaskIdeaType {
  switch (taskType) {
    case "reading":
    case "experiment":
    case "coding":
    case "writing":
    case "analysis":
    case "idea":
    case "review":
      return taskType;
    case "meeting":
    case "other":
    default:
      return "analysis";
  }
}

function projectToPageProject(project: Project): PlanningProjectPageProject {
  const keyQuestions = readStringArrayCustomField(project.customFields, "keyQuestions");

  return {
    id: project.id,
    title: project.title,
    name: project.title,
    description: project.description ?? "",
    significance: readStringCustomField(project.customFields, "significance"),
    objective: project.objective ?? "",
    methodSummary: readStringCustomField(project.customFields, "methodSummary"),
    expectedOutputs: readStringCustomField(project.customFields, "expectedOutputs"),
    keyQuestions: keyQuestions.length > 0
      ? keyQuestions
      : project.researchQuestion
        ? [project.researchQuestion]
        : [],
    status: projectStatusToWorkStatus(project.status),
    planningStatus: project.status,
    priority: planningPriorityToPagePriority(project.priority),
    planningPriority: project.priority,
    progress: project.progress ?? 0,
    startDate: project.startDate,
    targetDate: project.targetDate,
    customFields: project.customFields,
    updatedAt: project.updatedAt,
    createdAt: project.createdAt
  };
}

function resolveRouteGanttVisibility(routeNode: RouteNode) {
  return routeNode.showInGantt !== false;
}

function routeToPlanningRouteEntry(routeNode: RouteNode): PlanningProjectPlanRouteEntry {
  return {
    id: routeNode.id,
    projectId: routeNode.projectId,
    title: routeNode.title,
    description: routeNode.description ?? "",
    status: routeNodeStatusToWorkStatus(routeNode.status),
    planningStatus: routeNode.status,
    nodeType: routeNode.nodeType,
    captureState: routeNode.captureState,
    orderIndex: routeNode.orderIndex,
    timeLabel: formatTimeLabel(routeNode.startDate, routeNode.endDate, routeNode.timeLabel),
    startDate: routeNode.startDate ?? "",
    endDate: routeNode.endDate ?? "",
    timeScale: timePrecisionToTimeScale(routeNode.timePrecision),
    expectedOutput: routeNode.expectedOutput ?? "",
    progress: routeProgress(routeNode),
    updatedAt: routeNode.updatedAt ?? "",
    showInGantt: resolveRouteGanttVisibility(routeNode),
    customFields: routeNode.customFields
  };
}

function taskToPlanningTaskEntry(task: Task): PlanningProjectPlanTaskEntry {
  return {
    id: task.id,
    projectId: task.projectId,
    routeNodeId: task.routeNodeId,
    milestoneId: task.routeNodeId,
    title: task.title,
    description: task.description ?? "",
    status: taskStatusToWorkStatus(task.status),
    planningStatus: task.status,
    taskType: taskTypeToPageTaskType(task.taskType),
    priority: planningPriorityToPagePriority(task.priority),
    captureState: task.captureState,
    timeLabel: formatTimeLabel(task.scheduledDate, task.dueDate, task.timeLabel),
    startDate: task.scheduledDate ?? "",
    endDate: task.dueDate ?? "",
    acceptanceCriteria: task.acceptanceCriteria ?? "",
    resultNote: task.resultNote ?? ""
  };
}

function sortByTimeAndTitle<T extends { timeLabel: string; title: string }>(items: T[]) {
  return [...items].sort(
    (left, right) =>
      left.timeLabel.localeCompare(right.timeLabel) || left.title.localeCompare(right.title)
  );
}

function groupPlanItemsByProject(
  projectIds: EntityId[],
  routeNodes: PlanningProjectPlanRouteEntry[],
  tasks: PlanningProjectPlanTaskEntry[]
): PlanningProjectsPageModel["planItemsByProjectId"] {
  return Object.fromEntries(
    projectIds.map((projectId) => [
      projectId,
      {
        routeNodes: routeNodes.filter((item) => item.projectId === projectId),
        tasks: tasks.filter((item) => item.projectId === projectId)
      }
    ])
  );
}

function latestByUpdatedAt(
  items: Array<{ title: string; updatedAt?: string; createdAt?: string }>
) {
  return [...items].sort((left, right) => {
    const leftTime = left.updatedAt ?? left.createdAt ?? "";
    const rightTime = right.updatedAt ?? right.createdAt ?? "";
    return rightTime.localeCompare(leftTime) || left.title.localeCompare(right.title);
  })[0];
}

function buildProgressSummary(
  routeNodes: PlanningProjectPlanRouteEntry[],
  tasks: PlanningProjectPlanTaskEntry[],
  context: PlanningProjectOverviewContext | null
): PlanningProjectProgressSummary {
  const latestReview = context ? latestByUpdatedAt(context.reviews) : undefined;

  return {
    routeTotal: routeNodes.length,
    routeActive: routeNodes.filter((routeNode) => routeNode.status === "in_progress").length,
    routeBlocked: routeNodes.filter((routeNode) => routeNode.status === "blocked").length,
    routeCompleted: routeNodes.filter((routeNode) => routeNode.status === "completed").length,
    taskTotal: tasks.length,
    taskActive: tasks.filter((task) => task.status === "in_progress").length,
    taskPlanned: tasks.filter((task) => task.status === "planned").length,
    taskIdea: tasks.filter((task) => task.taskType === "idea" || task.captureState === "idea")
      .length,
    taskCompleted: tasks.filter((task) => task.status === "completed").length,
    reviewTotal: context?.reviews.length ?? 0,
    latestReviewTitle: latestReview?.title ?? "",
    latestReviewUpdatedAt: latestReview?.updatedAt ?? latestReview?.createdAt
  };
}

function emptyResearchContextSummary(
  projectId: EntityId,
  warning?: string
): PlanningProjectResearchContextSummary {
  return {
    projectId,
    routeCount: 0,
    taskCount: 0,
    reviewCount: 0,
    experimentEvidenceCount: 0,
    literatureEvidenceCount: 0,
    outputEvidenceCount: 0,
    outputGapCount: 0,
    warningCount: warning ? 1 : 0,
    missingReferenceCount: 0,
    warnings: warning ? [warning] : [],
    excluded: [],
    partial: Boolean(warning),
    aiReady: false,
    generatedAt: new Date().toISOString()
  };
}

function buildResearchContextSummary(
  projectId: EntityId,
  context: PlanningProjectOverviewContext | null,
  routeCount: number,
  taskCount: number
): PlanningProjectResearchContextSummary {
  if (!context) {
    return emptyResearchContextSummary(projectId, "Project research context is unavailable.");
  }

  return {
    projectId,
    routeCount,
    taskCount,
    reviewCount: context.reviews.length,
    experimentEvidenceCount: context.experimentEvidenceCount,
    literatureEvidenceCount: context.literatureEvidenceCount,
    outputEvidenceCount: context.outputEvidenceCount,
    outputGapCount: context.outputGapCount,
    warningCount: context.warnings.length,
    missingReferenceCount: context.missingReferenceCount,
    warnings: context.warnings.slice(0, 3),
    excluded: [],
    partial: context.partial,
    aiReady: !context.partial && context.missingReferenceCount === 0,
    generatedAt: context.generatedAt
  };
}

async function buildProjectOverviewSummaries(
  planItemsByProjectId: PlanningProjectsPageModel["planItemsByProjectId"]
): Promise<Record<EntityId, PlanningProjectOverviewSummary>> {
  const pairs = await Promise.all(
    Object.entries(planItemsByProjectId).map(async ([projectId, planItems]) => {
      try {
        const context = await planningSelectorService.getProjectOverviewContext(projectId);
        return [
          projectId,
          {
            progress: buildProgressSummary(planItems.routeNodes, planItems.tasks, context),
            researchContext: buildResearchContextSummary(
              projectId,
              context,
              planItems.routeNodes.length,
              planItems.tasks.length
            )
          }
        ] as const;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown context error.";
        return [
          projectId,
          {
            progress: buildProgressSummary(planItems.routeNodes, planItems.tasks, null),
            researchContext: emptyResearchContextSummary(projectId, message)
          }
        ] as const;
      }
    })
  );

  return Object.fromEntries(pairs);
}

async function loadPlanningPageBase() {
  const [projects, routeNodes, tasks] = await Promise.all([
    planningService.queryProjects(),
    planningService.queryRouteNodes(),
    planningService.queryTasks()
  ]);
  const projectModels = projects.map(projectToPageProject);
  const routeModels = sortByTimeAndTitle(
    routeNodes.map((routeNode) => routeToPlanningRouteEntry(routeNode))
  );
  const taskModels = sortByTimeAndTitle(
    tasks
      .filter((task) => task.status !== "archived")
      .map((task) => taskToPlanningTaskEntry(task))
  );

  return { projects: projectModels, routeNodes: routeModels, tasks: taskModels };
}

export async function getPlanningProjectsPageBaseModel(): Promise<PlanningProjectsPageBaseModel> {
  const base = await loadPlanningPageBase();
  const planItemsByProjectId = groupPlanItemsByProject(
    base.projects.map((project) => project.id),
    base.routeNodes,
    base.tasks
  );

  return {
    projects: base.projects,
    planItemsByProjectId
  };
}

export async function getPlanningProjectOverviewSummaries(
  planItemsByProjectId: PlanningProjectsPageModel["planItemsByProjectId"]
): Promise<PlanningProjectsPageModel["projectSummariesByProjectId"]> {
  return buildProjectOverviewSummaries(planItemsByProjectId);
}

export async function getPlanningProjectsPageModel(): Promise<PlanningProjectsPageModel> {
  const base = await getPlanningProjectsPageBaseModel();
  return {
    ...base,
    projectSummariesByProjectId: await getPlanningProjectOverviewSummaries(
      base.planItemsByProjectId
    )
  };
}

export async function getPlanningRoutesPageModel(): Promise<PlanningRoutesPageModel> {
  const base = await loadPlanningPageBase();
  const routeNodeIds = base.routeNodes.map((routeNode) => routeNode.id);
  const [outputGapPairs, checkpointSummariesByRouteNodeId, taskSummariesByRouteNodeId] =
    await Promise.all([
      Promise.all(
        base.routeNodes.map(async (routeNode) => {
          const summaries =
            await outputGapFeedbackSelectorService.getRouteNodeOutputGapFeedbackSummary(
              routeNode.id
            );
          return [routeNode.id, summaries.outputGaps] as const;
        })
      ),
      planningSelectorService.getRouteCheckpointProgressSummaries(routeNodeIds),
      planningSelectorService.getRouteNodeTaskSummaries(routeNodeIds)
    ]);

  return {
    projects: base.projects,
    routeNodes: base.routeNodes,
    outputGapSummariesByRouteNodeId: Object.fromEntries(outputGapPairs),
    checkpointSummariesByRouteNodeId,
    taskSummariesByRouteNodeId
  };
}

export async function getPlanningTasksPageModel(): Promise<PlanningTasksPageModel> {
  const base = await loadPlanningPageBase();
  const [outputGapPairs, routineSummaryPairs] = await Promise.all([
    Promise.all(
      base.tasks.map(async (task) => {
        const summaries =
          await outputGapFeedbackSelectorService.getTaskOutputGapFeedbackSummary(task.id);
        return [task.id, summaries.outputGaps] as const;
      })
    ),
    Promise.all(
      base.projects.map(async (project) => [
        project.id,
        await planningSelectorService.getProjectRoutineSummary(project.id)
      ] as const)
    )
  ]);

  return {
    projects: base.projects,
    routeNodes: base.routeNodes,
    tasks: base.tasks,
    outputGapSummariesByTaskId: Object.fromEntries(outputGapPairs),
    projectRoutineSummariesByProjectId: Object.fromEntries(routineSummaryPairs)
  };
}

export async function getPlanningReviewTargetsModel(): Promise<PlanningReviewTargetsModel> {
  const base = await loadPlanningPageBase();

  return {
    projects: base.projects,
    routeNodes: base.routeNodes,
    tasks: base.tasks
  };
}

export const planningPageAdapterService = {
  getPlanningProjectsPageBaseModel,
  getPlanningProjectOverviewSummaries,
  getPlanningProjectsPageModel,
  getPlanningRoutesPageModel,
  getPlanningTasksPageModel,
  getPlanningReviewTargetsModel
};

export type PlanningPageAdapterService = typeof planningPageAdapterService;
