import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import { DataClearFooterRow } from "../../components/common/DataClearRow";
import { PageHeader } from "../../components/common/PageHeader";
import { WriteFeedbackPanel } from "../../components/feedback/WriteFeedbackPanel";
import { OperationConfirmDialog } from "../../components/safety/OperationConfirmDialog";
import { useOperationConfirm } from "../../hooks/useOperationConfirm";
import { useRefreshEventReload } from "../../hooks/useRefreshEventReload";
import { useWriteFeedbackCenter } from "../../hooks/useWriteFeedbackCenter";
import { useI18n } from "../../i18n/I18nProvider";
import type { TranslationKey } from "../../i18n/translations";
import {
  planningPageAdapterService,
  type PlanningProjectPageProject,
  type PlanningProjectPlanRouteEntry,
  type PlanningProjectPlanTaskEntry
} from "../../services/planningPageAdapterService";
import { planningService } from "../../services/planningService";
import {
  readSharedCurrentProjectSelection,
  resolveSharedCurrentProjectSelection,
  writeSharedCurrentProjectSelection
} from "../../services/sharedCurrentProjectSelection";
import {
  getResearchTraceDisplayChecked,
  saveResearchTraceDisplayPreference
} from "../../services/projectResearchTracePreferenceUiService";
import { outputGapFeedbackCardSelectorService } from "../../services/outputGapFeedbackCardSelectorService";
import type { PlanningFeedbackCardSummary } from "../../services/outputGapFeedbackCardSelectorService";
import { outputGapFeedbackCardService } from "../../services/outputGapFeedbackCardService";
import {
  createOperationCancelledFeedback,
  createOperationImpactPreview
} from "../../services/operationImpactPreviewService";
import {
  createOperationLog,
  summarizeFeedbackForOperationLog,
  summarizeImpactPreviewForOperationLog
} from "../../services/operationLogService";
import { publishWriteFeedbackRefresh } from "../../services/refreshEventService";
import { recordRecycleEntry } from "../../services/recycleBinService";
import {
  addWriteFeedbackWarning,
  createWriteFeedbackResult
} from "../../services/writeFeedbackService";
import type {
  OutputGapFeedbackCard,
  Priority,
  WorkStatus,
  WriteFeedbackResult
} from "../../types";
import type { ProjectRoutineSummary, RoutineCurrentPeriodSummary } from "../../types/planningContext";
import type { OperationImpactPreview } from "../../types/operationSafety";
import type {
  CaptureState,
  Priority as PlanningPriority,
  ResearchRoutine,
  RoutineFrequency,
  RoutineTargetType,
  Task,
  TaskCheckpoint,
  TaskCheckpointStatus,
  TaskStatus,
  TaskType
} from "../../types/planning";
import type { RefreshEvent, RefreshKeyPattern } from "../../types/refresh";
import { isTaskIdeaType, type TaskIdeaType } from "../../utils/planningIdeaState";

type Project = PlanningProjectPageProject;
type PlanningRouteEntry = PlanningProjectPlanRouteEntry;
type PlanningTaskEntry = PlanningProjectPlanTaskEntry;

type TimeRangeFilter = "this_week" | "this_month" | "last_7_days" | "last_30_days" | "all";
type TaskGroupKey = "completed" | "in_progress" | "idea" | "planned";
type PriorityFilter = "all" | Priority;
type RoutineDialogMode = "create" | "edit" | null;

type TaskFormState = {
  title: string;
  description: string;
  projectId: string;
  routeNodeId: string;
  timeLabel: string;
  startDate: string;
  endDate: string;
  status: TaskStatus;
  priority: PlanningPriority;
  acceptanceCriteria: string;
  resultNote: string;
  researchTraceDisplayChecked: boolean;
  taskType: TaskIdeaType;
};

type TaskCheckpointFormState = {
  title: string;
  status: TaskCheckpointStatus;
  description: string;
  acceptanceCriteria: string;
  dueDate: string;
  feedback: string;
};

type TaskCheckpointEditorMode = "create" | "edit" | null;

type RoutineFormState = {
  title: string;
  description: string;
  frequency: RoutineFrequency;
  targetType: RoutineTargetType;
  targetCount: string;
  targetDescription: string;
  projectId: string;
  isActive: boolean;
  startDate: string;
  endDate: string;
};

type TaskVisibilityTarget = Pick<
  PlanningTaskEntry,
  | "id"
  | "projectId"
  | "routeNodeId"
  | "milestoneId"
  | "title"
  | "description"
  | "status"
  | "planningStatus"
  | "taskType"
  | "priority"
  | "startDate"
  | "endDate"
  | "timeLabel"
  | "acceptanceCriteria"
>;

async function recordUnsupportedTaskPlanningDeleteAudit<T>(
  feedback: WriteFeedbackResult<T>,
  preview: OperationImpactPreview,
  input: {
    entityType: string;
    entityId: string;
    title: string;
    summary?: string;
    deletedAt: string;
    operationSummary: string;
    cannotRestoreReason: string;
    auditWarningPrefix: string;
  }
): Promise<WriteFeedbackResult<T>> {
  try {
    const operationLogFeedback = await createOperationLog({
      operationType: "delete",
      source: "user",
      module: "planning",
      status: feedback.status,
      riskLevel: preview.riskLevel,
      target: {
        entityType: input.entityType,
        entityId: input.entityId,
        title: input.title
      },
      summary: input.operationSummary,
      relatedEntities: feedback.affectedEntities,
      impactSummary: summarizeImpactPreviewForOperationLog(preview),
      confirmation: {
        required: true,
        confirmedByUser: true,
        confirmedAt: input.deletedAt
      },
      feedback: summarizeFeedbackForOperationLog(feedback),
      isRecoverable: false
    });
    await recordRecycleEntry({
      entityType: input.entityType,
      entityId: input.entityId,
      title: input.title,
      summary: input.summary,
      module: "planning",
      deletedAt: input.deletedAt,
      deletedBy: "user",
      operationLogId: operationLogFeedback.data?.id,
      canRestore: false,
      cannotRestoreReason: input.cannotRestoreReason,
      restoreStatus: "unsupported",
      knownImpactSummary: summarizeImpactPreviewForOperationLog(preview),
      refreshKeys: feedback.refreshKeys
    });
    publishWriteFeedbackRefresh(
      createWriteFeedbackResult({
        status: "success",
        operation: "recycleBin.record",
        refreshKeys: ["recycleBin.changed"]
      }),
      {
        source: "service.write",
        reason: "planning task recycle entry recorded"
      }
    );
    return feedback;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return addWriteFeedbackWarning(
      feedback,
      `${input.auditWarningPrefix}: ${message}`,
      "planning_delete_audit_trail_failed"
    );
  }
}

const allRoutesValue = "all";
const defaultCollapsedGroups: Record<TaskGroupKey, boolean> = {
  completed: true,
  in_progress: false,
  idea: false,
  planned: true
};

function createDefaultCollapsedGroups(): Record<TaskGroupKey, boolean> {
  return { ...defaultCollapsedGroups };
}

const emptyForm: TaskFormState = {
  title: "",
  description: "",
  projectId: "",
  routeNodeId: "",
  timeLabel: "",
  startDate: "",
  endDate: "",
  status: "todo",
  priority: "medium",
  acceptanceCriteria: "",
  resultNote: "",
  researchTraceDisplayChecked: false,
  taskType: "analysis"
};

const emptyTaskCheckpointForm: TaskCheckpointFormState = {
  title: "",
  status: "planned",
  description: "",
  acceptanceCriteria: "",
  dueDate: "",
  feedback: ""
};

const emptyRoutineForm: RoutineFormState = {
  title: "",
  description: "",
  frequency: "daily",
  targetType: "count",
  targetCount: "1",
  targetDescription: "",
  projectId: "",
  isActive: true,
  startDate: "",
  endDate: ""
};

const groupOrder: TaskGroupKey[] = ["completed", "in_progress", "idea", "planned"];
const taskCheckpointStatuses: TaskCheckpointStatus[] = [
  "completed",
  "active",
  "blocked",
  "abandoned",
  "planned"
];

const TASKS_REFRESH_KEYS: RefreshKeyPattern[] = [
  "project.changed",
  "route.changed",
  "task.changed",
  "routine.changed",
  "routine.checkin.changed",
  "output.gap.changed",
  "entityLink.changed",
  "review.changed",
  "reviewContext.changed",
  "aiContext.changed",
  "global.changed"
];

function toForm(task: PlanningTaskEntry): TaskFormState {
  return {
    title: task.title,
    description: task.description,
    projectId: task.projectId,
    routeNodeId: task.routeNodeId || task.milestoneId || "",
    timeLabel: task.timeLabel === "Unscheduled" ? "" : task.timeLabel,
    startDate: task.startDate,
    endDate: task.endDate,
    status: task.planningStatus,
    priority: task.priority === "critical" ? "high" : task.priority,
    acceptanceCriteria: task.acceptanceCriteria,
    resultNote: task.resultNote,
    researchTraceDisplayChecked: false,
    taskType: task.taskType
  };
}

function toTaskCheckpointForm(checkpoint: TaskCheckpoint): TaskCheckpointFormState {
  return {
    title: checkpoint.title,
    status: checkpoint.status,
    description: checkpoint.description ?? "",
    acceptanceCriteria: checkpoint.acceptanceCriteria ?? "",
    dueDate: checkpoint.dueDate ?? "",
    feedback: checkpoint.feedback ?? ""
  };
}

function toRoutineForm(routine: ResearchRoutine): RoutineFormState {
  return {
    title: routine.title,
    description: routine.description ?? "",
    frequency: routine.frequency,
    targetType: routine.targetType,
    targetCount: String(routine.targetCount ?? 1),
    targetDescription: routine.targetDescription ?? "",
    projectId: routine.projectId ?? "",
    isActive: routine.isActive,
    startDate: routine.startDate ?? "",
    endDate: routine.endDate ?? ""
  };
}

function summarizeCheckpointText(value?: string, maxLength = 80) {
  const text = value?.trim() ?? "";
  if (!text) {
    return "";
  }
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function parseDate(dateText?: string) {
  if (!dateText) {
    return null;
  }

  const date = new Date(dateText);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date;
}

function formatShortDate(dateText?: string) {
  const date = parseDate(dateText);
  if (!date) {
    return "";
  }
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function startOfDay(date: Date) {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  return result;
}

function endOfDay(date: Date) {
  const result = new Date(date);
  result.setHours(23, 59, 59, 999);
  return result;
}

function dateForTask(task: Pick<TaskVisibilityTarget, "endDate" | "startDate">) {
  return parseDate(task.endDate || task.startDate);
}

function isWithinTimeRange(
  task: Pick<TaskVisibilityTarget, "endDate" | "startDate">,
  timeRange: TimeRangeFilter
) {
  if (timeRange === "all") {
    return true;
  }

  const taskDate = dateForTask(task);
  if (!taskDate) {
    return false;
  }

  const now = new Date();
  if (timeRange === "last_7_days" || timeRange === "last_30_days") {
    const days = timeRange === "last_7_days" ? 7 : 30;
    const start = startOfDay(new Date(now));
    start.setDate(start.getDate() - days + 1);
    return taskDate >= start && taskDate <= endOfDay(now);
  }

  if (timeRange === "this_month") {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = endOfDay(new Date(now.getFullYear(), now.getMonth() + 1, 0));
    return taskDate >= start && taskDate <= end;
  }

  const weekStart = startOfDay(new Date(now));
  const day = weekStart.getDay();
  weekStart.setDate(weekStart.getDate() - (day === 0 ? 6 : day - 1));
  const weekEnd = endOfDay(new Date(weekStart));
  weekEnd.setDate(weekEnd.getDate() + 6);
  return taskDate >= weekStart && taskDate <= weekEnd;
}

function isOverdue(task: PlanningTaskEntry) {
  if (
    !task.endDate ||
    task.planningStatus === "done" ||
    task.planningStatus === "cancelled" ||
    task.planningStatus === "archived"
  ) {
    return false;
  }

  const due = endOfDay(new Date(task.endDate));
  return due.getTime() < Date.now();
}

function isDueSoon(task: PlanningTaskEntry) {
  if (
    !task.endDate ||
    task.planningStatus === "done" ||
    task.planningStatus === "cancelled" ||
    task.planningStatus === "archived"
  ) {
    return false;
  }

  const due = parseDate(task.endDate);
  if (!due) {
    return false;
  }

  const now = startOfDay(new Date());
  const nextWeek = endOfDay(new Date(now));
  nextWeek.setDate(nextWeek.getDate() + 7);
  return due >= now && due <= nextWeek;
}

function groupTask(task: PlanningTaskEntry): TaskGroupKey {
  return getTaskGroupKey(task);
}

function getTaskGroupKey(
  task: Pick<TaskVisibilityTarget, "status" | "planningStatus" | "taskType">
): TaskGroupKey {
  if (task.planningStatus === "done") {
    return "completed";
  }
  if (
    task.planningStatus === "doing" ||
    task.planningStatus === "delayed" ||
    task.planningStatus === "blocked"
  ) {
    return "in_progress";
  }
  if (isTaskIdeaType(task.taskType)) {
    return "idea";
  }
  return "planned";
}

function sortTasks(tasks: PlanningTaskEntry[]) {
  return [...tasks].sort((left, right) => {
    const leftDate = left.endDate || left.startDate || left.timeLabel;
    const rightDate = right.endDate || right.startDate || right.timeLabel;
    return leftDate.localeCompare(rightDate) || left.title.localeCompare(right.title);
  });
}

function taskMatchesKeyword(task: PlanningTaskEntry, keyword: string) {
  return isTaskMatchedByKeyword(task, keyword);
}

function isTaskMatchedByKeyword(task: TaskVisibilityTarget, keyword: string) {
  if (!keyword.trim()) {
    return true;
  }

  const query = keyword.trim().toLowerCase();
  return [task.title, task.description, task.acceptanceCriteria, task.timeLabel]
    .join(" ")
    .toLowerCase()
    .includes(query);
}

function taskRouteId(task: PlanningTaskEntry) {
  return visibilityTaskRouteId(task);
}

function visibilityTaskRouteId(task: Pick<TaskVisibilityTarget, "routeNodeId" | "milestoneId">) {
  return task.routeNodeId || task.milestoneId || "";
}

function planningTaskStatusToWorkStatus(status: TaskStatus): WorkStatus {
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

function planningTaskTypeToPageTaskType(taskType: TaskType): TaskIdeaType {
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

function taskToVisibilityTarget(task: Task): TaskVisibilityTarget {
  return {
    id: task.id,
    projectId: task.projectId,
    routeNodeId: task.routeNodeId,
    milestoneId: task.routeNodeId,
    title: task.title,
    description: task.description ?? "",
    status: planningTaskStatusToWorkStatus(task.status),
    planningStatus: task.status,
    taskType: planningTaskTypeToPageTaskType(task.taskType),
    priority: task.priority,
    startDate: task.scheduledDate ?? "",
    endDate: task.dueDate ?? "",
    timeLabel: task.timeLabel ?? "",
    acceptanceCriteria: task.acceptanceCriteria ?? ""
  };
}

function taskStatusLabel(status: TaskStatus, t: (key: TranslationKey) => string) {
  switch (status) {
    case "todo":
      return t("planned");
    case "doing":
      return t("in_progress");
    case "blocked":
      return t("blocked");
    case "delayed":
      return t("taskDelayed");
    case "done":
      return t("completed");
    case "cancelled":
      return t("taskCancelled");
    case "archived":
      return t("archived");
    default:
      return status;
  }
}

function captureStateForTask(form: TaskFormState): CaptureState {
  return form.startDate || form.endDate ? "scheduled" : "unscheduled";
}

export function TasksPage() {
  const { t } = useI18n();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const queryProjectId = searchParams.get("projectId");
  const focusedTaskQueryId = searchParams.get("taskId") || searchParams.get("focus");
  const queryRouteNodeId = searchParams.get("routeNodeId");
  const queryFocusKey = [
    focusedTaskQueryId ?? "",
    queryRouteNodeId ?? "",
    queryProjectId ?? ""
  ].join("|");
  const [tasks, setTasks] = useState<PlanningTaskEntry[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [routeItems, setRouteItems] = useState<PlanningRouteEntry[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState(
    () => readSharedCurrentProjectSelection() ?? ""
  );
  const [selectedRouteId, setSelectedRouteId] = useState(allRoutesValue);
  const [timeRange, setTimeRange] = useState<TimeRangeFilter>("all");
  const [searchKeyword, setSearchKeyword] = useState("");
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>("all");
  const [taskFeedbackCardSummary, setTaskFeedbackCardSummary] =
    useState<PlanningFeedbackCardSummary | null>(null);
  const [projectRoutineSummaries, setProjectRoutineSummaries] = useState<
    Record<string, ProjectRoutineSummary>
  >({});
  const [collapsedGroups, setCollapsedGroups] =
    useState<Record<TaskGroupKey, boolean>>(createDefaultCollapsedGroups);
  const [focusedTaskId, setFocusedTaskId] = useState<string | null>(null);
  const [hasLoadedPage, setHasLoadedPage] = useState(false);
  const [isPageLoading, setIsPageLoading] = useState(false);
  const [loadErrorMessage, setLoadErrorMessage] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [form, setForm] = useState<TaskFormState>(emptyForm);
  const [taskCheckpoints, setTaskCheckpoints] = useState<TaskCheckpoint[]>([]);
  const [checkpointEditorMode, setCheckpointEditorMode] =
    useState<TaskCheckpointEditorMode>(null);
  const [editingCheckpointId, setEditingCheckpointId] = useState<string | null>(null);
  const [checkpointForm, setCheckpointForm] =
    useState<TaskCheckpointFormState>(emptyTaskCheckpointForm);
  const [showCheckpointOptionalFields, setShowCheckpointOptionalFields] = useState(false);
  const [isCheckpointLoading, setIsCheckpointLoading] = useState(false);
  const [updatingCheckpointId, setUpdatingCheckpointId] = useState<string | null>(null);
  const [checkpointTitleError, setCheckpointTitleError] = useState("");
  const [routineDialogMode, setRoutineDialogMode] = useState<RoutineDialogMode>(null);
  const [editingRoutineId, setEditingRoutineId] = useState<string | null>(null);
  const [routineForm, setRoutineForm] = useState<RoutineFormState>(emptyRoutineForm);
  const [routineFormError, setRoutineFormError] = useState("");
  const [checkingInRoutineId, setCheckingInRoutineId] = useState<string | null>(null);
  const consumedQueryFocusRef = useRef<string | null>(null);
  const isTaskPageMountedRef = useRef(false);
  const loadRequestIdRef = useRef(0);
  const lastTasksLocationKeyRef = useRef(location.key);
  const pendingPageWriteOperationRef = useRef<string | null>(null);
  const researchTracePreferenceRequestRef = useRef("");
  const feedbackContext = useMemo(() => ({
    page: "tasks",
    projectId: selectedProjectId || undefined
  }), [selectedProjectId]);
  const feedbackCenter = useWriteFeedbackCenter(feedbackContext);
  const operationConfirm = useOperationConfirm();
  const feedbackCenterRef = useRef(feedbackCenter);

  useEffect(() => {
    feedbackCenterRef.current = feedbackCenter;
  }, [feedbackCenter]);

  useEffect(() => {
    isTaskPageMountedRef.current = true;
    return () => {
      isTaskPageMountedRef.current = false;
      loadRequestIdRef.current += 1;
    };
  }, []);

  const loadTaskCheckpoints = useCallback(
    async (taskId: string) => {
      setIsCheckpointLoading(true);
      try {
        const checkpoints = await planningService.queryTaskCheckpointsByTask(taskId);
        setTaskCheckpoints(checkpoints);
      } catch (error) {
        feedbackCenter.consumeWriteError(error, "planning.queryTaskCheckpointsByTask");
      } finally {
        setIsCheckpointLoading(false);
      }
    },
    [feedbackCenter]
  );

  const loadPageData = useCallback(async () => {
    const requestId = loadRequestIdRef.current + 1;
    loadRequestIdRef.current = requestId;
    setIsPageLoading(true);
    setLoadErrorMessage("");

    try {
      const pageModel = await planningPageAdapterService.getPlanningTasksPageModel();
      if (!isTaskPageMountedRef.current || requestId !== loadRequestIdRef.current) {
        return;
      }

      setTasks(pageModel.tasks);
      setProjects(pageModel.projects);
      setRouteItems(pageModel.routeNodes);
      setProjectRoutineSummaries(pageModel.projectRoutineSummariesByProjectId);
      setHasLoadedPage(true);
      setSelectedProjectId((current) => {
        if (current && pageModel.projects.some((project) => project.id === current)) {
          return current;
        }
        return resolveSharedCurrentProjectSelection(pageModel.projects);
      });
    } catch (error) {
      if (!isTaskPageMountedRef.current || requestId !== loadRequestIdRef.current) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      setHasLoadedPage(true);
      setLoadErrorMessage(message);
      feedbackCenterRef.current.consumeWriteError(
        error,
        "planning.getPlanningTasksPageModel"
      );
    } finally {
      if (isTaskPageMountedRef.current && requestId === loadRequestIdRef.current) {
        setIsPageLoading(false);
      }
    }
  }, []);

  const refreshTaskFeedbackCardSummary = useCallback(async (projectId: string) => {
    if (!projectId) {
      setTaskFeedbackCardSummary(null);
      return;
    }
    const summary = await outputGapFeedbackCardSelectorService.getPlanningFeedbackCardSummary(
      projectId,
      "task"
    );
    setTaskFeedbackCardSummary(summary);
  }, []);

  const reloadCurrentPage = useCallback(
    async (event?: RefreshEvent) => {
      if (
        event?.source === "service.write" &&
        event.operation &&
        pendingPageWriteOperationRef.current === event.operation
      ) {
        pendingPageWriteOperationRef.current = null;
        return;
      }
      await loadPageData();
      await refreshTaskFeedbackCardSummary(selectedProjectId);
    },
    [loadPageData, refreshTaskFeedbackCardSummary, selectedProjectId]
  );

  const refreshByKeys = reloadCurrentPage;

  useRefreshEventReload({
    pageName: "tasks",
    watchedKeys: TASKS_REFRESH_KEYS,
    reload: refreshByKeys,
    onRefreshFeedback: feedbackCenter.pushRefreshEventFeedback,
    onReloadError: (error, event) =>
      feedbackCenter.pushReloadErrorFeedback(error, event, "tasks")
  });

  useEffect(() => {
    void loadPageData();
  }, [loadPageData]);

  useEffect(() => {
    void refreshTaskFeedbackCardSummary(selectedProjectId);
  }, [refreshTaskFeedbackCardSummary, selectedProjectId]);

  useEffect(() => {
    if (location.pathname !== "/tasks" || location.key === lastTasksLocationKeyRef.current) {
      return;
    }

    lastTasksLocationKeyRef.current = location.key;
    void loadPageData();
  }, [loadPageData, location.key, location.pathname]);

  const selectedProjectRoutes = useMemo(
    () => routeItems.filter((item) => item.projectId === selectedProjectId),
    [routeItems, selectedProjectId]
  );

  const projectRouteItems = useMemo(
    () => routeItems.filter((item) => item.projectId === form.projectId),
    [form.projectId, routeItems]
  );

  useEffect(() => {
    if (
      selectedRouteId !== allRoutesValue &&
      !selectedProjectRoutes.some((route) => route.id === selectedRouteId)
    ) {
      setSelectedRouteId(allRoutesValue);
    }
  }, [selectedProjectRoutes, selectedRouteId]);

  const projectTasks = useMemo(
    () => tasks.filter((task) => task.projectId === selectedProjectId),
    [selectedProjectId, tasks]
  );

  const crossFilteredTasks = useMemo(() => {
    return sortTasks(
      projectTasks.filter((task) => {
        const routeMatches =
          selectedRouteId === allRoutesValue || taskRouteId(task) === selectedRouteId;

        return routeMatches && isWithinTimeRange(task, timeRange);
      })
    );
  }, [projectTasks, selectedRouteId, timeRange]);

  const filteredTasks = useMemo(() => {
    return crossFilteredTasks.filter((task) => {
      const priorityMatches = priorityFilter === "all" || task.priority === priorityFilter;
      return priorityMatches && taskMatchesKeyword(task, searchKeyword);
    });
  }, [crossFilteredTasks, priorityFilter, searchKeyword]);

  const taskFeedbackCards = (taskFeedbackCardSummary?.cards ?? []).filter(
    (card) => !card.archivedAt && !card.deletedAt
  );

  const routineSummaries = useMemo(() => {
    return projectRoutineSummaries[selectedProjectId]?.summaries ?? [];
  }, [projectRoutineSummaries, selectedProjectId]);

  const summary = useMemo(() => {
    const groups = filteredTasks.reduce(
      (result, task) => {
        const groupKey = groupTask(task);
        return {
          ...result,
          [groupKey]: result[groupKey] + 1,
          blocked: result.blocked + (task.planningStatus === "blocked" ? 1 : 0),
          dueSoon: result.dueSoon + (isDueSoon(task) ? 1 : 0)
        };
      },
      {
        completed: 0,
        in_progress: 0,
        idea: 0,
        planned: 0,
        blocked: 0,
        dueSoon: 0
      }
    );

    return {
      total: filteredTasks.length,
      ...groups
    };
  }, [filteredTasks]);

  const groupedTasks = useMemo(() => {
    const groups: Record<TaskGroupKey, PlanningTaskEntry[]> = {
      completed: [],
      in_progress: [],
      idea: [],
      planned: []
    };

    filteredTasks.forEach((task) => {
      groups[groupTask(task)].push(task);
    });

    return groups;
  }, [filteredTasks]);

  useEffect(() => {
    if (
      !hasLoadedPage ||
      loadErrorMessage ||
      consumedQueryFocusRef.current === queryFocusKey
    ) {
      return;
    }

    const focusedTask = focusedTaskQueryId
      ? tasks.find((task) => task.id === focusedTaskQueryId)
      : undefined;
    if (focusedTask) {
      const focusedRouteId = taskRouteId(focusedTask);
      const focusedGroupKey = getTaskGroupKey(focusedTask);
      setFocusedTaskId(focusedTask.id);
      setSelectedProjectId(focusedTask.projectId);
      setSelectedRouteId(focusedRouteId || allRoutesValue);
      setTimeRange((current) =>
        current === "all" || isWithinTimeRange(focusedTask, current) ? current : "all"
      );
      setPriorityFilter((current) =>
        current === "all" || current === focusedTask.priority ? current : "all"
      );
      setSearchKeyword((current) =>
        isTaskMatchedByKeyword(focusedTask, current) ? current : ""
      );
      setCollapsedGroups((current) => ({
        ...current,
        [focusedGroupKey]: false
      }));
      consumedQueryFocusRef.current = queryFocusKey;
      return;
    }

    const queryRoute = queryRouteNodeId
      ? routeItems.find((route) => route.id === queryRouteNodeId)
      : undefined;
    if (queryRoute && (!queryProjectId || queryRoute.projectId === queryProjectId)) {
      setFocusedTaskId(null);
      setSelectedProjectId(queryRoute.projectId);
      setSelectedRouteId(queryRoute.id);
      setTimeRange("all");
      consumedQueryFocusRef.current = queryFocusKey;
      return;
    }

    const queryProject = queryProjectId
      ? projects.find((project) => project.id === queryProjectId)
      : undefined;
    if (queryProject) {
      setFocusedTaskId(null);
      setSelectedProjectId(queryProject.id);
      setSelectedRouteId(allRoutesValue);
      setTimeRange("all");
    }
    consumedQueryFocusRef.current = queryFocusKey;
  }, [
    focusedTaskQueryId,
    hasLoadedPage,
    loadErrorMessage,
    projects,
    queryFocusKey,
    queryProjectId,
    queryRouteNodeId,
    routeItems,
    tasks
  ]);

  function clearQueryFocusSelection() {
    if (focusedTaskId) {
      setFocusedTaskId(null);
    }
  }

  function ensureModelLoadedForFilter() {
    if ((!hasLoadedPage || loadErrorMessage) && !isPageLoading) {
      void loadPageData();
    }
  }

  function resetCollapsedGroupsToDefault() {
    setCollapsedGroups(createDefaultCollapsedGroups());
  }

  function selectProject(projectId: string) {
    clearQueryFocusSelection();
    writeSharedCurrentProjectSelection(projectId);
    setSelectedProjectId(projectId);
    resetCollapsedGroupsToDefault();
    ensureModelLoadedForFilter();
  }

  function selectRoute(routeNodeId: string) {
    clearQueryFocusSelection();
    setSelectedRouteId(routeNodeId);
    resetCollapsedGroupsToDefault();
    ensureModelLoadedForFilter();
  }

  function selectTimeRange(value: TimeRangeFilter) {
    clearQueryFocusSelection();
    setTimeRange(value);
    resetCollapsedGroupsToDefault();
    ensureModelLoadedForFilter();
  }

  function selectPriority(value: PriorityFilter) {
    clearQueryFocusSelection();
    setPriorityFilter(value);
    ensureModelLoadedForFilter();
  }

  function updateSearchKeyword(value: string) {
    clearQueryFocusSelection();
    setSearchKeyword(value);
    ensureModelLoadedForFilter();
  }

  function resetTaskCheckpointEditor() {
    setTaskCheckpoints([]);
    setCheckpointEditorMode(null);
    setEditingCheckpointId(null);
    setCheckpointForm(emptyTaskCheckpointForm);
    setShowCheckpointOptionalFields(false);
    setIsCheckpointLoading(false);
    setUpdatingCheckpointId(null);
    setCheckpointTitleError("");
  }

  function openCreateModal() {
    const projectId = selectedProjectId || projects[0]?.id || "";
    researchTracePreferenceRequestRef.current = "";
    setEditingId(null);
    resetTaskCheckpointEditor();
    setForm({
      ...emptyForm,
      projectId,
      routeNodeId: selectedRouteId === allRoutesValue ? "" : selectedRouteId
    });
    setIsModalOpen(true);
  }

  function openEditModal(task: PlanningTaskEntry) {
    const requestKey = `${task.projectId}:task:${task.id}`;
    researchTracePreferenceRequestRef.current = requestKey;
    setEditingId(task.id);
    setForm(toForm(task));
    resetTaskCheckpointEditor();
    setIsModalOpen(true);
    void loadTaskCheckpoints(task.id);
    void loadTaskResearchTracePreference(task, requestKey);
  }

  function closeModal() {
    researchTracePreferenceRequestRef.current = "";
    setEditingId(null);
    setForm(emptyForm);
    resetTaskCheckpointEditor();
    setIsModalOpen(false);
  }

  function clearTaskForm() {
    setForm((current) => ({
      ...current,
      title: "",
      description: "",
      timeLabel: "",
      startDate: "",
      endDate: "",
      acceptanceCriteria: "",
      resultNote: "",
      researchTraceDisplayChecked: false
    }));
  }

  async function loadTaskResearchTracePreference(
    task: PlanningTaskEntry,
    requestKey: string
  ) {
    try {
      const checked = await getResearchTraceDisplayChecked({
        projectId: task.projectId,
        targetType: "task",
        targetId: task.id,
        defaultDisplayed: false
      });
      if (researchTracePreferenceRequestRef.current !== requestKey) {
        return;
      }
      setForm((current) => ({
        ...current,
        researchTraceDisplayChecked: checked
      }));
    } catch (error) {
      feedbackCenter.consumeWriteError(error, "researchTrace.preference.load");
    }
  }

  function ensureTaskVisible(savedTask: TaskVisibilityTarget) {
    const savedRouteId = visibilityTaskRouteId(savedTask);
    const savedGroupKey = getTaskGroupKey(savedTask);

    setSelectedProjectId(savedTask.projectId);
    setSelectedRouteId((current) => {
      if (savedRouteId) {
        return current === savedRouteId ? current : savedRouteId;
      }
      return current === allRoutesValue ? current : allRoutesValue;
    });
    setTimeRange((current) =>
      current === "all" || isWithinTimeRange(savedTask, current) ? current : "all"
    );
    setPriorityFilter((current) =>
      current === "all" || current === savedTask.priority ? current : "all"
    );
    setSearchKeyword((current) =>
      isTaskMatchedByKeyword(savedTask, current) ? current : ""
    );
    setCollapsedGroups((current) => ({
      ...current,
      [savedGroupKey]: false
    }));
    setFocusedTaskId(savedTask.id);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const taskFields = {
      projectId: form.projectId,
      routeNodeId: form.routeNodeId || undefined,
      title: form.title,
      description: form.description,
      taskType: form.taskType,
      priority: form.priority,
      scheduledDate: form.startDate || undefined,
      dueDate: form.endDate || undefined,
      acceptanceCriteria: form.acceptanceCriteria.trim() || undefined,
      timeLabel: form.timeLabel,
      timeBucket: "none" as const,
      captureState: captureStateForTask(form)
    };

    const originalTask = editingId
      ? tasks.find((task) => task.id === editingId)
      : undefined;
    let operation = editingId ? "planning.updateTask" : "planning.createTask";
    if (editingId && originalTask) {
      if (form.status === "done" && originalTask.planningStatus !== "done") {
        operation = "planning.completeTask";
      } else if (
        originalTask.planningStatus === "done" &&
        (form.status === "todo" ||
          form.status === "doing" ||
          form.status === "blocked")
      ) {
        operation = "planning.reopenTask";
      } else if (
        form.status === "delayed" &&
        originalTask.planningStatus !== "delayed"
      ) {
        operation = "planning.postponeTask";
      }
    }

    pendingPageWriteOperationRef.current = operation;
    try {
      let savedTask: Task | undefined;
      if (editingId) {
        if (!originalTask) {
          throw new Error(`Task was not found: ${editingId}.`);
        }
        if (operation === "planning.completeTask") {
          savedTask = await planningService.completeTask(editingId, {
            completionNote: form.resultNote.trim() || undefined,
            patch: taskFields
          });
        } else if (operation === "planning.reopenTask") {
          savedTask = await planningService.reopenTask(editingId, {
            status: form.status,
            patch: {
              ...taskFields,
              resultNote: form.resultNote.trim() || undefined
            }
          });
        } else if (operation === "planning.postponeTask") {
          savedTask = await planningService.postponeTask(editingId, {
            dueDate: form.endDate || undefined,
            scheduledDate: form.startDate || undefined,
            patch: taskFields
          });
        } else {
          savedTask = await planningService.updateTask(editingId, {
            ...taskFields,
            status: form.status,
            resultNote: form.resultNote.trim() || undefined
          });
        }
      } else {
        savedTask = await planningService.createTask({
          ...taskFields,
          status: form.status,
          resultNote: form.resultNote.trim() || undefined
        });
      }

      if (!savedTask) {
        throw new Error(`Task write did not return a saved task: ${operation}.`);
      }
      pendingPageWriteOperationRef.current = null;
      try {
        await saveResearchTraceDisplayPreference({
          projectId: savedTask.projectId,
          targetType: "task",
          targetId: savedTask.id,
          defaultDisplayed: false,
          checked: form.researchTraceDisplayChecked
        });
      } catch (preferenceError) {
        feedbackCenter.consumeWriteError(
          preferenceError,
          "researchTrace.preference.save"
        );
      }
      ensureTaskVisible(taskToVisibilityTarget(savedTask));
      closeModal();
      await loadPageData();
    } catch (error) {
      pendingPageWriteOperationRef.current = null;
      feedbackCenter.consumeWriteError(error, operation);
    }
  }

  function openCreateRoutineDialog() {
    setRoutineDialogMode("create");
    setEditingRoutineId(null);
    setRoutineForm({
      ...emptyRoutineForm,
      projectId: selectedProjectId
    });
    setRoutineFormError("");
  }

  function openEditRoutineDialog(summary: RoutineCurrentPeriodSummary) {
    setRoutineDialogMode("edit");
    setEditingRoutineId(summary.routineId);
    setRoutineForm(toRoutineForm(summary.routine));
    setRoutineFormError("");
  }

  function closeRoutineDialog() {
    setRoutineDialogMode(null);
    setEditingRoutineId(null);
    setRoutineForm(emptyRoutineForm);
    setRoutineFormError("");
  }

  function buildRoutinePatchFromForm() {
    const title = routineForm.title.trim();
    if (!title) {
      setRoutineFormError(t("routineTitleRequired"));
      return null;
    }

    const targetCountValue = Number(routineForm.targetCount);
    const targetCount = Math.floor(targetCountValue);
    if (
      routineForm.targetType === "count" &&
      (!routineForm.targetCount.trim() ||
        !Number.isInteger(targetCountValue) ||
        targetCountValue < 1)
    ) {
      setRoutineFormError(t("routineTargetCountRequired"));
      return null;
    }

    const targetDescription = routineForm.targetDescription.trim();
    if (routineForm.targetType === "description" && !targetDescription) {
      setRoutineFormError(t("routineTargetDescriptionRequired"));
      return null;
    }

    setRoutineFormError("");
    return {
      title,
      description: routineForm.description.trim() || undefined,
      frequency: routineForm.frequency,
      targetType: routineForm.targetType,
      targetCount: routineForm.targetType === "count" ? targetCount : undefined,
      targetDescription: routineForm.targetType === "description" ? targetDescription : undefined,
      projectId: routineForm.projectId || undefined,
      isActive: routineForm.isActive,
      startDate: routineForm.startDate || undefined,
      endDate: routineForm.endDate || undefined
    };
  }

  async function handleRoutineSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const patch = buildRoutinePatchFromForm();
    if (!patch) {
      return;
    }

    const operation =
      routineDialogMode === "edit" ? "planning.updateResearchRoutine" : "planning.createResearchRoutine";
    pendingPageWriteOperationRef.current = operation;
    try {
      const feedback =
        routineDialogMode === "edit" && editingRoutineId
          ? await planningService.updateResearchRoutine(editingRoutineId, patch)
          : await planningService.createResearchRoutine({
              ...patch,
              orderIndex: routineSummaries.length
            });
      feedbackCenter.consumeWriteResult(feedback, {
        operation,
        successMessage:
          routineDialogMode === "edit" ? t("routineUpdated") : t("routineCreated"),
        skippedMessage: t("routineSaveSkipped")
      });
      pendingPageWriteOperationRef.current = null;
      if (feedback.data) {
        closeRoutineDialog();
        await loadPageData();
      }
    } catch (error) {
      pendingPageWriteOperationRef.current = null;
      feedbackCenter.consumeWriteError(error, operation);
    }
  }

  async function handleRoutineCheckIn(summary: RoutineCurrentPeriodSummary) {
    if (checkingInRoutineId) {
      return;
    }

    const operation = "planning.createRoutineCheckIn";
    setCheckingInRoutineId(summary.routineId);
    pendingPageWriteOperationRef.current = operation;
    try {
      const feedback = await planningService.createRoutineCheckIn({
        routineId: summary.routineId,
        checkedAt: new Date().toISOString(),
        count: 1
      });
      feedbackCenter.consumeWriteResult(feedback, {
        operation,
        successMessage: t("routineChecked"),
        skippedMessage: t("routineSaveSkipped")
      });
      pendingPageWriteOperationRef.current = null;
      if (feedback.data) {
        await loadPageData();
      }
    } catch (error) {
      pendingPageWriteOperationRef.current = null;
      feedbackCenter.consumeWriteError(error, operation);
    } finally {
      setCheckingInRoutineId(null);
    }
  }

  function startCreateTaskCheckpoint() {
    setCheckpointEditorMode("create");
    setEditingCheckpointId(null);
    setCheckpointForm(emptyTaskCheckpointForm);
    setShowCheckpointOptionalFields(false);
    setCheckpointTitleError("");
  }

  function startEditTaskCheckpoint(checkpoint: TaskCheckpoint) {
    setCheckpointEditorMode("edit");
    setEditingCheckpointId(checkpoint.id);
    setCheckpointForm(toTaskCheckpointForm(checkpoint));
    setShowCheckpointOptionalFields(
      Boolean(
        checkpoint.description?.trim() ||
          checkpoint.acceptanceCriteria?.trim() ||
          checkpoint.dueDate ||
          checkpoint.feedback?.trim()
      )
    );
    setCheckpointTitleError("");
  }

  function closeTaskCheckpointEditor() {
    setCheckpointEditorMode(null);
    setEditingCheckpointId(null);
    setCheckpointForm(emptyTaskCheckpointForm);
    setShowCheckpointOptionalFields(false);
    setCheckpointTitleError("");
  }

  async function handleTaskCheckpointStatusChange(
    checkpoint: TaskCheckpoint,
    status: TaskCheckpointStatus
  ) {
    if (!editingId || checkpoint.status === status || updatingCheckpointId) {
      return;
    }

    const operation = "planning.updateTaskCheckpoint";
    setUpdatingCheckpointId(checkpoint.id);
    try {
      const feedback = await planningService.updateTaskCheckpoint(checkpoint.id, { status });
      feedbackCenter.consumeWriteResult(feedback, {
        operation,
        successMessage: t("taskCheckpointStatusUpdated"),
        skippedMessage: t("taskCheckpointSaveSkipped")
      });
      if (feedback.data) {
        await loadTaskCheckpoints(editingId);
      }
    } catch (error) {
      feedbackCenter.consumeWriteError(error, operation);
    } finally {
      setUpdatingCheckpointId(null);
    }
  }

  async function handleTaskFeedbackCardStatusToggle(card: OutputGapFeedbackCard) {
    const nextStatus = card.status === "pending" ? "resolved" : "pending";
    const operation = "outputGapFeedbackCard.setTaskReminderStatus";
    try {
      const updated = await outputGapFeedbackCardService.setOutputGapFeedbackCardStatus(
        card.id,
        nextStatus
      );
      feedbackCenter.consumeWriteResult(updated, {
        operation,
        successMessage: t("outputGapFeedbackCardStatusUpdated"),
        skippedMessage: t("outputGapFeedbackCardWriteFailed"),
        affectedEntities: [
          {
            type: "outputGapFeedbackCard",
            id: card.id,
            label: card.title,
            relation: "updated"
          }
        ],
        affectedScopes: [
          {
            module: "outputConversion",
            projectId: card.projectId,
            reason: "OutputGap feedback card status changed from Tasks page."
          }
        ],
        refreshKeys: ["output.gap.changed"],
        voidIsSuccess: false
      });
      await refreshTaskFeedbackCardSummary(selectedProjectId);
    } catch (error) {
      feedbackCenter.consumeWriteError(error, operation);
    }
  }

  async function handleTaskCheckpointSubmit() {
    if (!editingId) {
      return;
    }

    const title = checkpointForm.title.trim();
    if (!title) {
      setCheckpointTitleError(t("taskCheckpointTitleRequired"));
      return;
    }

    const patch = {
      title,
      status: checkpointForm.status,
      description: checkpointForm.description.trim() || undefined,
      acceptanceCriteria: checkpointForm.acceptanceCriteria.trim() || undefined,
      dueDate: checkpointForm.dueDate || undefined,
      feedback: checkpointForm.feedback.trim() || undefined
    };
    const operation =
      checkpointEditorMode === "edit"
        ? "planning.updateTaskCheckpoint"
        : "planning.createTaskCheckpoint";

    try {
      const feedback =
        checkpointEditorMode === "edit" && editingCheckpointId
          ? await planningService.updateTaskCheckpoint(editingCheckpointId, patch)
          : await planningService.createTaskCheckpoint({
              ...patch,
              taskId: editingId,
              orderIndex: taskCheckpoints.length
            });
      feedbackCenter.consumeWriteResult(feedback, {
        operation,
        successMessage:
          checkpointEditorMode === "edit"
            ? t("taskCheckpointUpdated")
            : t("taskCheckpointCreated"),
        skippedMessage: t("taskCheckpointSaveSkipped")
      });
      if (feedback.data) {
        await loadTaskCheckpoints(editingId);
        closeTaskCheckpointEditor();
      }
    } catch (error) {
      feedbackCenter.consumeWriteError(error, operation);
    }
  }

  function routeTitle(routeNodeId?: string) {
    return routeItems.find((item) => item.id === routeNodeId)?.title || t("unlinkedRoute");
  }

  function toggleGroup(groupKey: TaskGroupKey) {
    setCollapsedGroups((current) => ({
      ...current,
      [groupKey]: !current[groupKey]
    }));
  }

  const groupLabels: Record<TaskGroupKey, string> = {
    completed: t("taskGroupCompleted"),
    in_progress: t("taskGroupActive"),
    idea: t("taskGroupIdea"),
    planned: t("taskGroupPlanned")
  };

  const timeRangeOptions: Array<{ value: TimeRangeFilter; label: string }> = [
    { value: "this_week", label: t("thisWeek") },
    { value: "this_month", label: t("thisMonth") },
    { value: "last_7_days", label: t("last7Days") },
    { value: "last_30_days", label: t("last30Days") },
    { value: "all", label: t("allTime") }
  ];

  const taskCheckpointStatusLabels: Record<TaskCheckpointStatus, string> = {
    completed: t("taskCheckpointCompleted"),
    active: t("taskCheckpointActive"),
    blocked: t("taskCheckpointBlocked"),
    abandoned: t("taskCheckpointAbandoned"),
    planned: t("taskCheckpointPlanned")
  };
  const taskFeedbackCardStatusLabels = {
    pending: t("outputGapFeedbackCardStatusPending"),
    resolved: t("outputGapFeedbackCardStatusResolved")
  };
  const taskFeedbackCardPriorityLabels = {
    high: t("outputGapFeedbackCardPriorityHigh"),
    medium: t("outputGapFeedbackCardPriorityMedium"),
    low: t("outputGapFeedbackCardPriorityLow")
  };

  const routineFrequencyLabels: Record<RoutineFrequency, string> = {
    daily: t("routineDaily"),
    weekly: t("routineWeekly"),
    monthly: t("routineMonthly")
  };

  function routineFrequencyText(summary: RoutineCurrentPeriodSummary) {
    const base = routineFrequencyLabels[summary.frequency];
    if (summary.targetType === "count") {
      return `${base} ${summary.targetCount ?? 1} ${t("routineCountUnit")}`;
    }
    return base;
  }

  function routineProgressText(summary: RoutineCurrentPeriodSummary) {
    if (summary.targetType === "count") {
      const prefix =
        summary.frequency === "daily"
          ? t("routineTodayProgress")
          : summary.frequency === "weekly"
            ? t("routineThisWeekProgress")
            : t("routineThisMonthProgress");
      return `${prefix} ${summary.totalCount}/${summary.targetCount ?? 1}`;
    }
    if (summary.frequency === "daily") {
      return summary.isCompleted ? t("routineTodayDone") : t("routineTodayNotDone");
    }
    if (summary.frequency === "weekly") {
      return summary.isCompleted ? t("routineThisWeekChecked") : t("routineThisWeekNotChecked");
    }
    return summary.isCompleted ? t("routineThisMonthChecked") : t("routineThisMonthNotChecked");
  }

  function routineLatestText(summary: RoutineCurrentPeriodSummary) {
    const latestDate = formatShortDate(summary.latestCheckIn?.checkedAt);
    return latestDate ? `${t("routineLatestCheckIn")}: ${latestDate}` : "";
  }

  function projectTitle(projectId?: string) {
    if (!projectId) {
      return t("routineGlobalProject");
    }
    return projects.find((project) => project.id === projectId)?.name ?? t("notProvided");
  }

  function buildTaskDeletePreview(task: PlanningTaskEntry): OperationImpactPreview {
    const routeId = taskRouteId(task);
    return createOperationImpactPreview({
      operationId: "planning.task.delete",
      operation: "delete",
      target: {
        type: "task",
        id: task.id,
        title: task.title
      },
      summary: t("confirmDeleteTask"),
      riskLevel: "high",
      executionKind: "soft-delete",
      isRecoverable: false,
      hasRestoreEntry: false,
      requiresUserConfirmation: true,
      canProceed: true,
      deepScanPerformed: false,
      confirmLabel: t("deleteTask"),
      affectedItems: [
        {
          entityType: "project",
          entityId: task.projectId,
          title: `${t("taskDeleteImpactProject")}: ${projectTitle(task.projectId)}`,
          severity: "info" as const
        },
        routeId
          ? {
              entityType: "routeNode",
              entityId: routeId,
              title: `${t("taskDeleteImpactRoute")}: ${routeTitle(routeId)}`,
              severity: "info" as const
            }
          : null,
        {
          entityType: "task",
          entityId: task.id,
          title: `${t("taskDeleteImpactStatus")}: ${taskStatusLabel(task.planningStatus, t)}`,
          severity: "warning" as const
        }
      ].filter((item): item is NonNullable<typeof item> => item !== null),
      warnings: [t("taskDeleteNotRestorable"), t("taskDeleteRelatedRecordsWarning")]
    });
  }

  function buildTaskCheckpointDeletePreview(checkpoint: TaskCheckpoint): OperationImpactPreview {
    const task = tasks.find((item) => item.id === checkpoint.taskId);
    return createOperationImpactPreview({
      operationId: "planning.taskCheckpoint.delete",
      operation: "delete",
      target: {
        type: "taskCheckpoint",
        id: checkpoint.id,
        title: checkpoint.title
      },
      summary: t("confirmDeleteTaskCheckpoint"),
      riskLevel: "high",
      executionKind: "soft-delete",
      isRecoverable: false,
      hasRestoreEntry: false,
      requiresUserConfirmation: true,
      canProceed: true,
      deepScanPerformed: false,
      confirmLabel: t("deleteTaskCheckpoint"),
      affectedItems: [
        {
          entityType: "task",
          entityId: checkpoint.taskId,
          title: `${t("taskCheckpointDeleteImpactTask")}: ${task?.title ?? t("notProvided")}`,
          severity: "info" as const
        },
        {
          entityType: "taskCheckpoint",
          entityId: checkpoint.id,
          title: `${t("taskCheckpointDeleteImpactStatus")}: ${
            taskCheckpointStatusLabels[checkpoint.status]
          }`,
          severity: "warning" as const
        }
      ],
      warnings: [
        t("taskCheckpointDeleteNotRestorable"),
        t("taskCheckpointDeleteRelatedRecordsWarning")
      ]
    });
  }

  function buildRoutineDeletePreview(
    summary: RoutineCurrentPeriodSummary
  ): OperationImpactPreview {
    return createOperationImpactPreview({
      operationId: "planning.researchRoutine.delete",
      operation: "delete",
      target: {
        type: "researchRoutine",
        id: summary.routineId,
        title: summary.title
      },
      summary: t("confirmDeleteRoutine"),
      riskLevel: "high",
      executionKind: "soft-delete",
      isRecoverable: false,
      hasRestoreEntry: false,
      requiresUserConfirmation: true,
      canProceed: true,
      deepScanPerformed: false,
      confirmLabel: t("deleteRoutine"),
      affectedItems: [
        {
          entityType: "project",
          entityId: summary.projectId,
          title: `${t("routineDeleteImpactProject")}: ${projectTitle(summary.projectId)}`,
          severity: "info" as const
        },
        {
          entityType: "researchRoutine",
          entityId: summary.routineId,
          title: `${t("routineDeleteImpactFrequency")}: ${routineFrequencyLabels[summary.frequency]}`,
          severity: "info" as const
        },
        {
          entityType: "researchRoutine",
          entityId: summary.routineId,
          title: `${t("routineDeleteImpactTarget")}: ${routineFrequencyText(summary)}`,
          severity: "warning" as const
        }
      ],
      warnings: [t("routineDeleteNotRestorable"), t("routineDeleteRelatedRecordsWarning")]
    });
  }

  async function handleDeleteTask(task: PlanningTaskEntry) {
    const preview = buildTaskDeletePreview(task);
    const confirmed = await operationConfirm.requestConfirmation(preview);
    if (!confirmed) {
      feedbackCenter.pushWriteFeedback(
        createOperationCancelledFeedback(preview, t("taskDeleteCancelled"))
      );
      return;
    }

    const operation = "planning.deleteTask";
    pendingPageWriteOperationRef.current = operation;
    try {
      const deletedAt = new Date().toISOString();
      let feedback = await planningService.deleteTask(task.id);
      if (feedback.status === "success" && feedback.data) {
        feedback = await recordUnsupportedTaskPlanningDeleteAudit(feedback, preview, {
          entityType: "task",
          entityId: task.id,
          title: task.title,
          summary: task.description,
          deletedAt,
          operationSummary: t("taskDeleted"),
          cannotRestoreReason: t("taskDeleteNotRestorable"),
          auditWarningPrefix: t("taskDeleteAuditTrailWarning")
        });
        closeModal();
        clearQueryFocusSelection();
        await loadPageData();
      }
      feedbackCenter.consumeWriteResult(feedback, {
        operation,
        successMessage: t("taskDeleted"),
        skippedMessage: t("taskDeleteSkipped")
      });
    } catch (error) {
      feedbackCenter.consumeWriteError(error, operation);
    } finally {
      pendingPageWriteOperationRef.current = null;
    }
  }

  async function handleDeleteTaskCheckpoint(checkpoint: TaskCheckpoint) {
    if (!editingId) {
      return;
    }
    const preview = buildTaskCheckpointDeletePreview(checkpoint);
    const confirmed = await operationConfirm.requestConfirmation(preview);
    if (!confirmed) {
      feedbackCenter.pushWriteFeedback(
        createOperationCancelledFeedback(preview, t("taskCheckpointDeleteCancelled"))
      );
      return;
    }

    const operation = "planning.deleteTaskCheckpoint";
    pendingPageWriteOperationRef.current = operation;
    try {
      const deletedAt = new Date().toISOString();
      let feedback = await planningService.deleteTaskCheckpoint(checkpoint.id);
      if (feedback.status === "success" && feedback.data) {
        feedback = await recordUnsupportedTaskPlanningDeleteAudit(feedback, preview, {
          entityType: "taskCheckpoint",
          entityId: checkpoint.id,
          title: checkpoint.title,
          summary: checkpoint.description,
          deletedAt,
          operationSummary: t("taskCheckpointDeleted"),
          cannotRestoreReason: t("taskCheckpointDeleteNotRestorable"),
          auditWarningPrefix: t("taskDeleteAuditTrailWarning")
        });
        closeTaskCheckpointEditor();
        await loadTaskCheckpoints(editingId);
        await loadPageData();
      }
      feedbackCenter.consumeWriteResult(feedback, {
        operation,
        successMessage: t("taskCheckpointDeleted"),
        skippedMessage: t("taskCheckpointDeleteSkipped")
      });
    } catch (error) {
      feedbackCenter.consumeWriteError(error, operation);
    } finally {
      pendingPageWriteOperationRef.current = null;
    }
  }

  async function handleDeleteRoutine(summary: RoutineCurrentPeriodSummary) {
    const preview = buildRoutineDeletePreview(summary);
    const confirmed = await operationConfirm.requestConfirmation(preview);
    if (!confirmed) {
      feedbackCenter.pushWriteFeedback(
        createOperationCancelledFeedback(preview, t("routineDeleteCancelled"))
      );
      return;
    }

    const operation = "planning.deleteResearchRoutine";
    pendingPageWriteOperationRef.current = operation;
    try {
      const deletedAt = new Date().toISOString();
      let feedback = await planningService.deleteResearchRoutine(summary.routineId);
      if (feedback.status === "success" && feedback.data) {
        feedback = await recordUnsupportedTaskPlanningDeleteAudit(feedback, preview, {
          entityType: "researchRoutine",
          entityId: summary.routineId,
          title: summary.title,
          summary: summary.routine.description,
          deletedAt,
          operationSummary: t("routineDeleted"),
          cannotRestoreReason: t("routineDeleteNotRestorable"),
          auditWarningPrefix: t("taskDeleteAuditTrailWarning")
        });
        closeRoutineDialog();
        await loadPageData();
      }
      feedbackCenter.consumeWriteResult(feedback, {
        operation,
        successMessage: t("routineDeleted"),
        skippedMessage: t("routineDeleteSkipped")
      });
    } catch (error) {
      feedbackCenter.consumeWriteError(error, operation);
    } finally {
      pendingPageWriteOperationRef.current = null;
    }
  }

  return (
    <section className="page-section tasks-page">
      <PageHeader title={t("tasks")} description={t("tasksDescription")} />
      <WriteFeedbackPanel
        entries={feedbackCenter.entries}
        onDismiss={feedbackCenter.dismissFeedback}
        presentation="primary-page"
      />
      <OperationConfirmDialog
        preview={operationConfirm.preview}
        onConfirm={operationConfirm.confirm}
        onCancel={operationConfirm.cancel}
      />

      <section className="task-filter-panel" aria-label={t("taskFilterSummary")}>
        <div className="task-filter-stack">
          <div className="task-project-row project-context-selector">
            <span className="project-context-selector__label">{t("project")}</span>
            <select
              className="project-context-selector__control"
              aria-label={t("project")}
              value={selectedProjectId}
              onChange={(event) => selectProject(event.target.value)}
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </div>

          <div className="task-filter-inline-row">
            <div className="task-filter-inline-field">
              <span>{t("routeFilter")}</span>
              <select
                aria-label={t("routeFilter")}
                value={selectedRouteId}
                onChange={(event) => selectRoute(event.target.value)}
                disabled={selectedProjectRoutes.length === 0}
              >
                <option value={allRoutesValue}>{t("allRoutes")}</option>
                {selectedProjectRoutes.map((route) => (
                  <option key={route.id} value={route.id}>
                    {route.title}
                  </option>
                ))}
              </select>
            </div>
            <div className="task-filter-inline-field">
              <span>{t("timeRange")}</span>
              <select
                aria-label={t("timeRange")}
                value={timeRange}
                onChange={(event) => selectTimeRange(event.target.value as TimeRangeFilter)}
              >
                {timeRangeOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        <div className="task-summary-strip">
          {loadErrorMessage ? (
            <span className="lightweight-stat-surface">{t("operationLogStatusError")}: {loadErrorMessage}</span>
          ) : (
            <>
              <span className="lightweight-stat-surface">{t("taskTotal")}: {summary.total}</span>
              <span className="lightweight-stat-surface">{t("taskDueSoonCount")}: {summary.dueSoon}</span>
              <span className="lightweight-stat-surface">{t("taskActiveCount")}: {summary.in_progress}</span>
              <span className="lightweight-stat-surface">{t("taskIdeaCount")}: {summary.idea}</span>
              <span className="lightweight-stat-surface">{t("taskBlockedCount")}: {summary.blocked}</span>
              <span className="lightweight-stat-surface">{t("taskPlannedCount")}: {summary.planned}</span>
              <span className="lightweight-stat-surface">{t("taskCompletedCount")}: {summary.completed}</span>
            </>
          )}
        </div>
      </section>

      <div className="task-workspace">
        <aside className="task-left-column">
          <section className="task-routines-panel">
            <div className="card-heading">
              <div>
                <h2>{t("researchRoutines")}</h2>
              </div>
              <button
                type="button"
                className="task-routine-primary-button primary-page-action primary-page-action--primary"
                onClick={openCreateRoutineDialog}
              >
                {t("newRoutine")}
              </button>
            </div>
            {loadErrorMessage ? (
              <p className="task-routine-empty">{loadErrorMessage}</p>
            ) : routineSummaries.length > 0 ? (
              <div className="task-routine-list">
                {routineSummaries.map((summary) => {
                  const latestText = routineLatestText(summary);
                  return (
                    <article className="task-routine-item" key={summary.routineId}>
                      <div className="task-routine-item__primary">
                        <button
                          type="button"
                          className={`task-routine-check ${
                            summary.isCompleted ? "is-checked" : ""
                          }`}
                          aria-label={`${t("routineCheckIn")}: ${summary.title}`}
                          onClick={() => void handleRoutineCheckIn(summary)}
                          disabled={checkingInRoutineId !== null}
                        >
                          {summary.isCompleted ? "✓" : ""}
                        </button>
                        <strong>{summary.title}</strong>
                        <button
                          type="button"
                          className="secondary-button task-routine-edit-button primary-page-action primary-page-action--secondary"
                          onClick={() => openEditRoutineDialog(summary)}
                        >
                          {t("edit")}
                        </button>
                      </div>
                      <div className="task-routine-item__meta">
                        <span>{routineFrequencyText(summary)}</span>
                        <span>{routineProgressText(summary)}</span>
                        {latestText ? <span>{latestText}</span> : null}
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <p className="task-routine-empty">{t("noResearchRoutines")}</p>
            )}
          </section>

          <section className="task-output-gap-panel">
            <div className="card-heading">
              <div>
                <h2>{t("taskOutputGapFeedback")}</h2>
              </div>
            </div>
            {loadErrorMessage ? (
              <div className="task-output-gap-empty">
                <p>{loadErrorMessage}</p>
              </div>
            ) : taskFeedbackCards.length > 0 ? (
              <div className="planning-feedback-card-reminders__list">
                {taskFeedbackCards.map((card) => (
                  <article className="planning-feedback-card-reminder" key={card.id}>
                    <div className="planning-feedback-card-reminder__body">
                      <strong>{card.title}</strong>
                      {card.description?.trim() ? <p>{card.description}</p> : null}
                      <span>
                        {taskFeedbackCardStatusLabels[card.status]} ·{" "}
                        {taskFeedbackCardPriorityLabels[card.priority]}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="planning-feedback-card-reminder__toggle"
                      onClick={() => void handleTaskFeedbackCardStatusToggle(card)}
                    >
                      {card.status === "pending"
                        ? t("outputGapFeedbackCardMarkResolved")
                        : t("outputGapFeedbackCardMarkPending")}
                    </button>
                  </article>
                ))}
              </div>
            ) : (
              <div className="task-output-gap-empty">
                <p>{t("taskOutputGapEmptyTitle")}</p>
              </div>
            )}
          </section>
        </aside>

        <section className="tasks-board task-board-panel">
          <div className="tasks-board-heading">
            <div>
              <h2>{t("taskBoard")}</h2>
              {!loadErrorMessage && selectedProjectRoutes.length === 0 ? (
                <p>{t("noRoutesForProject")}</p>
              ) : null}
            </div>
          </div>

          <div className="task-list-toolbar">
            <button
              type="button"
              className="primary-page-action primary-page-action--primary"
              onClick={openCreateModal}
            >
              {t("createTaskShort")}
            </button>
            <div className="task-list-filters">
              <select
                className="compact-list-toolbar-control"
                aria-label={t("priorityFilter")}
                value={priorityFilter}
                onChange={(event) => selectPriority(event.target.value as PriorityFilter)}
              >
                <option value="all">{t("allPriorities")}</option>
                <option value="high">{t("high")}</option>
                <option value="medium">{t("medium")}</option>
                <option value="low">{t("low")}</option>
              </select>
              <input
                className="compact-list-toolbar-control"
                aria-label={t("taskSearch")}
                value={searchKeyword}
                onChange={(event) => updateSearchKeyword(event.target.value)}
                placeholder={t("taskSearchPlaceholder")}
              />
            </div>
          </div>

          {isPageLoading && !hasLoadedPage ? (
            <div className="task-empty-state" aria-live="polite">
              <strong>{t("taskBoard")}</strong>
              <p>{t("taskBoard")}...</p>
            </div>
          ) : loadErrorMessage ? (
            <div className="task-empty-state" aria-live="polite">
              <strong>{t("operationLogStatusError")}</strong>
              <p>{loadErrorMessage}</p>
            </div>
          ) : projects.length === 0 ? (
            <div className="task-empty-state">
              <strong>{t("taskNoProjectTitle")}</strong>
              <p>{t("taskNoProjectDescription")}</p>
            </div>
          ) : (
            groupOrder.map((groupKey) => {
              const groupTasks = groupedTasks[groupKey];
              const isCollapsed = collapsedGroups[groupKey];
              return (
                <section className={`task-group task-group-${groupKey}`} key={groupKey}>
                  <button
                    type="button"
                    className="task-group-heading"
                    onClick={() => toggleGroup(groupKey)}
                  >
                    <span>{isCollapsed ? "▸" : "▾"}</span>
                    <h3>{groupLabels[groupKey]}</h3>
                    <strong>{groupTasks.length}</strong>
                  </button>

                  {!isCollapsed ? (
                    <div className="task-group-list">
                      {groupTasks.map((task) => {
                        const routeId = taskRouteId(task);
                        return (
                          <article
                            className={`task-list-item ${task.id === focusedTaskId ? "task-focus-item" : ""} ${
                              isOverdue(task) ? "task-overdue-item" : ""
                            } ${task.planningStatus === "blocked" ? "task-risk-item" : ""}`}
                            key={task.id}
                          >
                            <button type="button" onClick={() => openEditModal(task)}>
                              <div className="task-card-main">
                                <div className="task-card-title-row">
                                  <h4>{task.title}</h4>
                                  <span className="status-pill">
                                    {taskStatusLabel(task.planningStatus, t)}
                                  </span>
                                </div>
                                {task.description ? (
                                  <p className="task-card-description">{task.description}</p>
                                ) : null}
                                <div className="task-tag-row">
                                  <span>{t("priority")}: {t(task.priority)}</span>
                                  <span>{t("due")}: {task.endDate || t("unset")}</span>
                                  <span>{t("relatedRoute")}: {routeTitle(routeId)}</span>
                                </div>
                              </div>
                            </button>
                          </article>
                        );
                      })}
                      {groupTasks.length === 0 ? (
                        <p className="task-group-empty">{t("taskGroupEmpty")}</p>
                      ) : null}
                    </div>
                  ) : null}
                </section>
              );
            })
          )}
        </section>
      </div>

      {routineDialogMode ? (
        <div className="modal-backdrop" role="presentation" onClick={closeRoutineDialog}>
          <form
            className="task-routine-modal-form"
            onSubmit={handleRoutineSubmit}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="card-heading">
              <h2>{routineDialogMode === "edit" ? t("editRoutine") : t("newRoutine")}</h2>
              <button type="button" className="secondary-button" onClick={closeRoutineDialog}>
                {t("close")}
              </button>
            </div>

            <label>
              {t("routineTitle")}
              <input
                value={routineForm.title}
                onChange={(event) =>
                  setRoutineForm({ ...routineForm, title: event.target.value })
                }
                required
              />
            </label>

            <div className="form-row">
              <label>
                {t("routineFrequency")}
                <select
                  value={routineForm.frequency}
                  onChange={(event) =>
                    setRoutineForm({
                      ...routineForm,
                      frequency: event.target.value as RoutineFrequency
                    })
                  }
                >
                  <option value="daily">{t("routineDaily")}</option>
                  <option value="weekly">{t("routineWeekly")}</option>
                  <option value="monthly">{t("routineMonthly")}</option>
                </select>
              </label>
              <label>
                {t("routineTargetType")}
                <select
                  value={routineForm.targetType}
                  onChange={(event) =>
                    setRoutineForm({
                      ...routineForm,
                      targetType: event.target.value as RoutineTargetType
                    })
                  }
                >
                  <option value="count">{t("routineTargetCount")}</option>
                  <option value="description">{t("routineTargetDescription")}</option>
                </select>
              </label>
            </div>

            {routineForm.targetType === "count" ? (
              <label>
                {t("routineTargetCountInput")}
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={routineForm.targetCount}
                  onChange={(event) =>
                    setRoutineForm({ ...routineForm, targetCount: event.target.value })
                  }
                  required
                />
              </label>
            ) : (
              <label>
                {t("routineTargetDescriptionInput")}
                <input
                  value={routineForm.targetDescription}
                  onChange={(event) =>
                    setRoutineForm({
                      ...routineForm,
                      targetDescription: event.target.value
                    })
                  }
                  required
                />
              </label>
            )}

            <label>
              {t("routineProject")} {t("optional")}
              <select
                value={routineForm.projectId}
                onChange={(event) =>
                  setRoutineForm({ ...routineForm, projectId: event.target.value })
                }
              >
                <option value="">{t("routineGlobalProject")}</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>

            <label>
              {t("routineDescription")} {t("optional")}
              <textarea
                className="semantic-textarea-compact-summary"
                rows={2}
                value={routineForm.description}
                onChange={(event) =>
                  setRoutineForm({ ...routineForm, description: event.target.value })
                }
              />
            </label>

            <div className="form-row">
              <label>
                {t("startDate")} {t("optional")}
                <input
                  type="date"
                  value={routineForm.startDate}
                  onChange={(event) =>
                    setRoutineForm({ ...routineForm, startDate: event.target.value })
                  }
                />
              </label>
              <label>
                {t("endDate")} {t("optional")}
                <input
                  type="date"
                  value={routineForm.endDate}
                  onChange={(event) =>
                    setRoutineForm({ ...routineForm, endDate: event.target.value })
                  }
                />
              </label>
            </div>

            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={routineForm.isActive}
                onChange={(event) =>
                  setRoutineForm({ ...routineForm, isActive: event.target.checked })
                }
              />
              {t("routineIsActive")}
            </label>

            {routineFormError ? (
              <span className="task-routine-field-error">{routineFormError}</span>
            ) : null}

            {routineDialogMode === "edit" && editingRoutineId ? (
              <details className="task-routine-danger-details">
                <summary>{t("dangerZone")}</summary>
                <div className="task-danger-body">
                  <p>{t("routineDeleteDescription")}</p>
                  <button
                    type="button"
                    className="danger-button"
                    onClick={() => {
                      const summary = routineSummaries.find(
                        (item) => item.routineId === editingRoutineId
                      );
                      if (summary) {
                        void handleDeleteRoutine(summary);
                      }
                    }}
                  >
                    {t("deleteRoutine")}
                  </button>
                </div>
              </details>
            ) : null}

            <div className="button-row">
              <button type="submit">
                {routineDialogMode === "edit" ? t("save") : t("create")}
              </button>
              <button type="button" className="secondary-button" onClick={closeRoutineDialog}>
                {t("cancel")}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {isModalOpen ? (
        <div
          className="modal-backdrop task-editor-modal-backdrop"
          role="presentation"
          onClick={closeModal}
        >
          <form
            className="task-modal-form task-editor-modal"
            onSubmit={handleSubmit}
            onClick={(event) => event.stopPropagation()}
          >
            <header className="card-heading task-editor-modal__header">
              <h2>{editingId ? t("editTask") : t("createTask")}</h2>
              <button type="button" className="secondary-button" onClick={closeModal}>
                {t("close")}
              </button>
            </header>

            <div className="task-editor-modal__body">

            <label>
              {t("title")}
              <input
                value={form.title}
                onChange={(event) => setForm({ ...form, title: event.target.value })}
                required
              />
            </label>

            <label>
              {t("description")} {t("optional")}
              <textarea
                className="semantic-textarea-compact-summary"
                rows={2}
                value={form.description}
                onChange={(event) => setForm({ ...form, description: event.target.value })}
              />
            </label>

            <p className="task-form-project-context">
              <span>{t("currentProject")}</span>
              <strong>
                {projects.find((project) => project.id === form.projectId)?.name ??
                  t("notProvided")}
              </strong>
            </p>

            <div className="form-row task-modal-time-row">
              <label>
                {t("startDate")} {t("optional")}
                <input
                  type="date"
                  value={form.startDate}
                  onChange={(event) => setForm({ ...form, startDate: event.target.value })}
                />
              </label>
              <label>
                {t("endDate")} {t("optional")}
                <input
                  type="date"
                  value={form.endDate}
                  onChange={(event) => setForm({ ...form, endDate: event.target.value })}
                />
              </label>
              <label>
                {t("timeLabel")} {t("optional")}
                <input
                  value={form.timeLabel}
                  onChange={(event) => setForm({ ...form, timeLabel: event.target.value })}
                  placeholder={t("timeLabelPlaceholder")}
                />
              </label>
            </div>

            <div className="form-row task-modal-route-status-row">
              <label>
                {t("relatedRoute")} {t("optional")}
                <select
                  value={form.routeNodeId}
                  onChange={(event) => setForm({ ...form, routeNodeId: event.target.value })}
                >
                  <option value="">{t("unlinkedRoute")}</option>
                  {projectRouteItems.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.title}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t("status")}
                <select
                  value={form.status}
                  onChange={(event) =>
                    setForm({ ...form, status: event.target.value as TaskStatus })
                  }
                >
                  <option value="todo">{t("planned")}</option>
                  <option value="doing">{t("in_progress")}</option>
                  <option value="blocked">{t("blocked")}</option>
                  <option value="delayed">{t("taskDelayed")}</option>
                  <option value="done">{t("completed")}</option>
                  <option value="cancelled">{t("taskCancelled")}</option>
                </select>
              </label>
            </div>

            <details className="task-form-secondary-fields">
              <summary>{t("moreTaskFields")}</summary>
              <div className="form-row">
                <label>
                  {t("priority")}
                  <select
                    value={form.priority}
                    onChange={(event) =>
                      setForm({ ...form, priority: event.target.value as PlanningPriority })
                    }
                  >
                    <option value="high">{t("high")}</option>
                    <option value="medium">{t("medium")}</option>
                    <option value="low">{t("low")}</option>
                  </select>
                </label>
                <label>
                  {t("taskAcceptanceCriteria")} {t("optional")}
                  <input
                    value={form.acceptanceCriteria}
                    onChange={(event) =>
                      setForm({ ...form, acceptanceCriteria: event.target.value })
                    }
                  />
                </label>
              </div>
              <div className="form-row">
                <label className="checkbox-row research-trace-preference-row">
                  <input
                    type="checkbox"
                    checked={form.researchTraceDisplayChecked}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        researchTraceDisplayChecked: event.target.checked
                      })
                    }
                  />
                  {t("showInResearchTrace")}
                </label>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={isTaskIdeaType(form.taskType)}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        taskType: event.target.checked ? "idea" : "analysis"
                      })
                    }
                  />
                  {t("markAsTaskIdea")}
                </label>
              </div>
            </details>

            {form.status === "done" ? (
              <label>
                {t("taskCompletionNote")} {t("optional")}
                <textarea
                  value={form.resultNote}
                  onChange={(event) => setForm({ ...form, resultNote: event.target.value })}
                />
              </label>
            ) : null}

            <section className="task-checkpoint-editor" aria-label={t("taskCheckpoints")}>
              <div className="task-checkpoint-editor__heading">
                <h3>{t("taskCheckpoints")}</h3>
                {editingId ? (
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={startCreateTaskCheckpoint}
                  >
                    {t("createTaskCheckpoint")}
                  </button>
                ) : null}
              </div>

              {!editingId ? (
                <p className="task-checkpoint-empty">
                  {t("taskCheckpointCreateHintAfterTaskSave")}
                </p>
              ) : (
                <>
                  <div className="task-checkpoint-list">
                    {isCheckpointLoading ? (
                      <p className="task-checkpoint-empty">{t("taskCheckpointLoading")}</p>
                    ) : taskCheckpoints.length > 0 ? (
                      taskCheckpoints.map((checkpoint) => {
                        const description = summarizeCheckpointText(checkpoint.description);
                        return (
                          <article className="task-checkpoint-item" key={checkpoint.id}>
                            <div className="task-checkpoint-item__primary">
                              <strong>{checkpoint.title}</strong>
                              <div
                                className="task-checkpoint-status-options"
                                role="group"
                                aria-label={t("taskCheckpointStatus")}
                              >
                                {taskCheckpointStatuses.map((status) => (
                                  <button
                                    type="button"
                                    className={`task-checkpoint-status-option ${
                                      checkpoint.status === status ? "is-active" : ""
                                    }`}
                                    key={status}
                                    onClick={() =>
                                      void handleTaskCheckpointStatusChange(checkpoint, status)
                                    }
                                    disabled={updatingCheckpointId !== null}
                                  >
                                    {taskCheckpointStatusLabels[status]}
                                  </button>
                                ))}
                              </div>
                              <button
                                type="button"
                                className="secondary-button task-checkpoint-edit-button"
                                onClick={() => startEditTaskCheckpoint(checkpoint)}
                              >
                                {t("edit")}
                              </button>
                            </div>
                            {checkpoint.dueDate || description ? (
                              <div className="task-checkpoint-item__details">
                                {checkpoint.dueDate ? (
                                  <span>
                                    <strong>{t("taskCheckpointDueDateLabel")}:</strong>{" "}
                                    {checkpoint.dueDate}
                                  </span>
                                ) : null}
                                {description ? (
                                  <span>
                                    <strong>{t("taskCheckpointDescriptionLabel")}:</strong>{" "}
                                    {description}
                                  </span>
                                ) : null}
                              </div>
                            ) : null}
                          </article>
                        );
                      })
                    ) : (
                      <p className="task-checkpoint-empty">{t("taskCheckpointListEmpty")}</p>
                    )}
                  </div>

                  {checkpointEditorMode ? (
                    <div className="task-checkpoint-form">
                      <div className="task-checkpoint-form__heading">
                        <h4>
                          {checkpointEditorMode === "edit"
                            ? t("editTaskCheckpoint")
                            : t("createTaskCheckpoint")}
                        </h4>
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={closeTaskCheckpointEditor}
                        >
                          {t("close")}
                        </button>
                      </div>

                      <label>
                        {t("taskCheckpointTitle")}
                        <input
                          value={checkpointForm.title}
                          onChange={(event) => {
                            setCheckpointForm({
                              ...checkpointForm,
                              title: event.target.value
                            });
                            if (checkpointTitleError) {
                              setCheckpointTitleError("");
                            }
                          }}
                          required
                        />
                      </label>
                      {checkpointTitleError ? (
                        <span className="task-checkpoint-field-error">
                          {checkpointTitleError}
                        </span>
                      ) : null}

                      <label>
                        {t("taskCheckpointStatus")}
                        <select
                          value={checkpointForm.status}
                          onChange={(event) =>
                            setCheckpointForm({
                              ...checkpointForm,
                              status: event.target.value as TaskCheckpointStatus
                            })
                          }
                        >
                          {taskCheckpointStatuses.map((status) => (
                            <option key={status} value={status}>
                              {taskCheckpointStatusLabels[status]}
                            </option>
                          ))}
                        </select>
                      </label>

                      <button
                        type="button"
                        className="secondary-button task-checkpoint-fields-toggle"
                        onClick={() =>
                          setShowCheckpointOptionalFields(
                            (currentVisible) => !currentVisible
                          )
                        }
                      >
                        {showCheckpointOptionalFields
                          ? t("taskCheckpointCollapseFields")
                          : t("taskCheckpointMoreFields")}
                      </button>

                      {showCheckpointOptionalFields ? (
                        <div className="task-checkpoint-optional-fields">
                          <label>
                            {t("taskCheckpointDescription")} {t("optional")}
                            <textarea
                              value={checkpointForm.description}
                              onChange={(event) =>
                                setCheckpointForm({
                                  ...checkpointForm,
                                  description: event.target.value
                                })
                              }
                            />
                          </label>
                          <div className="form-row">
                            <label>
                              {t("taskCheckpointDueDate")} {t("optional")}
                              <input
                                type="date"
                                value={checkpointForm.dueDate}
                                onChange={(event) =>
                                  setCheckpointForm({
                                    ...checkpointForm,
                                    dueDate: event.target.value
                                  })
                                }
                              />
                            </label>
                            <label>
                              {t("taskCheckpointAcceptanceCriteria")} {t("optional")}
                              <input
                                value={checkpointForm.acceptanceCriteria}
                                onChange={(event) =>
                                  setCheckpointForm({
                                    ...checkpointForm,
                                    acceptanceCriteria: event.target.value
                                  })
                                }
                              />
                            </label>
                          </div>
                          <label>
                            {t("taskCheckpointFeedback")} {t("optional")}
                            <textarea
                              value={checkpointForm.feedback}
                              onChange={(event) =>
                                setCheckpointForm({
                                  ...checkpointForm,
                                  feedback: event.target.value
                                })
                              }
                            />
                          </label>
                        </div>
                      ) : null}

                      {checkpointEditorMode === "edit" && editingCheckpointId ? (
                        <details className="task-checkpoint-danger-details">
                          <summary>{t("dangerZone")}</summary>
                          <div className="task-danger-body">
                            <p>{t("taskCheckpointDeleteDescription")}</p>
                            <button
                              type="button"
                              className="danger-button"
                              onClick={() => {
                                const checkpoint = taskCheckpoints.find(
                                  (item) => item.id === editingCheckpointId
                                );
                                if (checkpoint) {
                                  void handleDeleteTaskCheckpoint(checkpoint);
                                }
                              }}
                            >
                              {t("deleteTaskCheckpoint")}
                            </button>
                          </div>
                        </details>
                      ) : null}

                      <div className="button-row">
                        <button type="button" onClick={() => void handleTaskCheckpointSubmit()}>
                          {t("saveTaskCheckpoint")}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </>
              )}
            </section>

            </div>

            <DataClearFooterRow
              className="task-editor-modal__footer"
              contextKey={`task:${editingId ?? "new"}`}
              regionLabel={t("dataClearing")}
              clearLabel={t("clear")}
              deleteLabel={t("delete")}
              onClear={clearTaskForm}
              onDelete={
                editingId
                  ? () => {
                      const task = tasks.find((item) => item.id === editingId);
                      if (task) void handleDeleteTask(task);
                    }
                  : undefined
              }
            >
              <button type="submit">{t("save")}</button>
              <button type="button" className="secondary-button" onClick={closeModal}>
                {t("cancel")}
              </button>
            </DataClearFooterRow>
          </form>
        </div>
      ) : null}
    </section>
  );
}
