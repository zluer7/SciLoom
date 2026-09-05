import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { DataClearFooterRow } from "../../components/common/DataClearRow";
import { PageHeader } from "../../components/common/PageHeader";
import { WriteFeedbackPanel } from "../../components/feedback/WriteFeedbackPanel";
import { OperationConfirmDialog } from "../../components/safety/OperationConfirmDialog";
import { useOperationConfirm } from "../../hooks/useOperationConfirm";
import { useRefreshEventReload } from "../../hooks/useRefreshEventReload";
import { useWriteFeedbackCenter } from "../../hooks/useWriteFeedbackCenter";
import { useI18n } from "../../i18n/I18nProvider";
import {
  createOperationCancelledFeedback,
  createOperationImpactPreview
} from "../../services/operationImpactPreviewService";
import {
  createOperationLog,
  summarizeFeedbackForOperationLog,
  summarizeImpactPreviewForOperationLog
} from "../../services/operationLogService";
import {
  planningPageAdapterService,
  type PlanningProjectPageProject,
  type PlanningProjectPlanRouteEntry
} from "../../services/planningPageAdapterService";
import { planningService } from "../../services/planningService";
import {
  readSharedCurrentProjectSelection,
  resolveSharedCurrentProjectSelection,
  writeSharedCurrentProjectSelection
} from "../../services/sharedCurrentProjectSelection";
import {
  createRoutesResearchProgressRequestCoordinator,
  isRoutesResearchProgressDataForProject,
  type RoutesResearchProgressRequestCoordinator
} from "../../services/routesResearchProgressRequestCoordinator";
import { resolveRoutesResearchProgress } from "../../services/routesResearchProgressSelectorService";
import { resolveRoutesLatestUpdatedAt } from "../../services/routesLatestUpdateResolverService";
import {
  getResearchTraceDisplayChecked,
  isRouteResearchTraceDefaultDisplayed,
  saveResearchTraceDisplayPreference
} from "../../services/projectResearchTracePreferenceUiService";
import type { OutputGapFeedbackGapSummary } from "../../services/outputGapFeedbackSelectorService";
import { outputGapFeedbackCardSelectorService } from "../../services/outputGapFeedbackCardSelectorService";
import type { PlanningFeedbackCardSummary } from "../../services/outputGapFeedbackCardSelectorService";
import { outputGapFeedbackCardService } from "../../services/outputGapFeedbackCardService";
import { publishWriteFeedbackRefresh } from "../../services/refreshEventService";
import { recordRecycleEntry } from "../../services/recycleBinService";
import { publishBusinessOperationTerminal } from "../../services/businessOperationFeedbackService";
import {
  addWriteFeedbackWarning,
  createWriteFeedbackResult
} from "../../services/writeFeedbackService";
import type {
  MilestoneTimeScale,
  RouteCheckpoint,
  RouteCheckpointProgressSummary,
  RouteCheckpointStatus,
  RouteNodeTaskSummary,
  OutputGapFeedbackCard,
  WriteFeedbackResult,
  WorkStatus
} from "../../types";
import type { OperationImpactPreview } from "../../types/operationSafety";
import type { CaptureState, RouteNode, RouteNodeStatus, TimePrecision } from "../../types/planning";
import type { RefreshEvent, RefreshKeyPattern } from "../../types/refresh";
import type {
  RouteResearchProgressItem,
  RoutesResearchProgressData
} from "../../types/routesResearchProgress";
import { isRouteConceptCaptureState } from "../../utils/planningIdeaState";

type Project = PlanningProjectPageProject;
type PlanningRouteEntry = PlanningProjectPlanRouteEntry;

type RouteFormState = {
  projectId: string;
  title: string;
  description: string;
  timeLabel: string;
  startDate: string;
  endDate: string;
  status: WorkStatus;
  showInGantt: boolean;
  researchTraceDisplayChecked: boolean;
  captureState: CaptureState;
};

type RouteGroupKey = "completed" | "active" | "idea" | "planned";
type RouteFilterKey = "all" | RouteGroupKey;
type RouteCardStatus = "planned" | "active" | "blocked" | "completed";

type RouteCheckpointFormState = {
  title: string;
  status: RouteCheckpointStatus;
  description: string;
  acceptanceCriteria: string;
  dueDate: string;
  feedback: string;
};

type RouteCheckpointEditorMode = "create" | "edit" | null;

type RoutesResearchProgressAsyncState = {
  projectId: string;
  status: "idle" | "loading" | "success" | "empty" | "error";
  data: RoutesResearchProgressData | null;
  sourceRoutes: RouteNode[];
  requestId?: number;
  errorMessage?: string;
};

const initialResearchProgressState: RoutesResearchProgressAsyncState = {
  projectId: "",
  status: "idle",
  data: null,
  sourceRoutes: []
};

const routeGroupKeys: RouteGroupKey[] = ["completed", "active", "idea", "planned"];

const ROUTES_REFRESH_KEYS: RefreshKeyPattern[] = [
  "project.changed",
  "route.changed",
  "task.changed",
  "output.gap.changed",
  "entityLink.changed",
  "review.changed",
  "reviewContext.changed",
  "aiContext.changed",
  "global.changed"
];

const emptyForm: RouteFormState = {
  projectId: "",
  title: "",
  description: "",
  timeLabel: "",
  startDate: "",
  endDate: "",
  status: "planned",
  showInGantt: true,
  researchTraceDisplayChecked: false,
  captureState: "scheduled"
};

const emptyRouteCheckpointForm: RouteCheckpointFormState = {
  title: "",
  status: "planned",
  description: "",
  acceptanceCriteria: "",
  dueDate: "",
  feedback: ""
};

const routeCheckpointStatuses: RouteCheckpointStatus[] = [
  "completed",
  "active",
  "blocked",
  "abandoned",
  "planned"
];

function toForm(item: PlanningRouteEntry): RouteFormState {
  return {
    projectId: item.projectId,
    title: item.title,
    description: item.description,
    timeLabel: item.timeLabel,
    startDate: item.startDate,
    endDate: item.endDate,
    status: item.status,
    showInGantt: item.showInGantt,
    researchTraceDisplayChecked: false,
    captureState: item.captureState
  };
}

function toRouteCheckpointForm(item: RouteCheckpoint): RouteCheckpointFormState {
  return {
    title: item.title,
    status: item.status,
    description: item.description ?? "",
    acceptanceCriteria: item.acceptanceCriteria ?? "",
    dueDate: item.dueDate ?? "",
    feedback: item.feedback ?? ""
  };
}

function inferTimeScale(startDate: string, endDate: string): MilestoneTimeScale {
  if (!startDate || !endDate) {
    return "week";
  }

  const start = new Date(startDate);
  const end = new Date(endDate);
  const diffDays = Math.abs(end.getTime() - start.getTime()) / 86400000;

  if (diffDays >= 300) {
    return "year";
  }
  if (diffDays >= 70) {
    return "quarter";
  }
  if (diffDays >= 21) {
    return "month";
  }
  return "week";
}

function timeScaleToTimePrecision(timeScale: MilestoneTimeScale): TimePrecision {
  switch (timeScale) {
    case "quarter":
      return "quarter";
    case "month":
      return "month";
    case "week":
      return "week";
    case "year":
    default:
      return "phase";
  }
}

function workStatusToRouteNodeStatus(status: WorkStatus): RouteNodeStatus {
  switch (status) {
    case "in_progress":
      return "active";
    case "blocked":
      return "paused";
    case "completed":
      return "completed";
    case "archived":
      return "archived";
    case "not_started":
    case "planned":
    default:
      return "planned";
  }
}

function routeProgressForStatus(status: WorkStatus) {
  return status === "completed" ? 100 : 0;
}

function resolveDateFallback(dateText: string) {
  return dateText || undefined;
}

function sortRouteItems(items: PlanningRouteEntry[]) {
  return [...items].sort((left, right) => {
    const leftDate = left.startDate || left.endDate || left.timeLabel;
    const rightDate = right.startDate || right.endDate || right.timeLabel;
    return leftDate.localeCompare(rightDate) || left.title.localeCompare(right.title);
  });
}

function isRouteConceptItem(item: PlanningRouteEntry) {
  return isRouteConceptCaptureState(item.captureState);
}

function getRouteGroupKey(item: PlanningRouteEntry): RouteGroupKey {
  if (item.status === "completed" || item.status === "archived") {
    return "completed";
  }

  if (item.status === "in_progress" || item.status === "blocked") {
    return "active";
  }

  if (isRouteConceptItem(item)) {
    return "idea";
  }

  return "planned";
}

function getRouteCardStatus(status: WorkStatus): RouteCardStatus {
  switch (status) {
    case "completed":
    case "archived":
      return "completed";
    case "in_progress":
      return "active";
    case "blocked":
      return "blocked";
    case "not_started":
    case "planned":
    default:
      return "planned";
  }
}

function getRouteCardTimeLabel(item: PlanningRouteEntry) {
  const timeLabel = item.timeLabel.trim();
  if (!item.startDate && !item.endDate && timeLabel.toLowerCase() === "unscheduled") {
    return "";
  }
  return timeLabel;
}

function formatDate(dateText?: string) {
  if (!dateText) {
    return "";
  }

  return new Date(dateText).toLocaleDateString();
}

function summarizeText(value?: string, maxLength = 72) {
  const normalized = value?.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}…` : normalized;
}

async function recordUnsupportedPlanningDeleteAudit<T>(
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
        reason: "planning recycle entry recorded"
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

export function RoutesPage() {
  const { t, language } = useI18n();
  const [searchParams] = useSearchParams();
  const queryProjectId = searchParams.get("projectId");
  const focusedRouteNodeId = searchParams.get("routeNodeId") || searchParams.get("focus");
  const [projects, setProjects] = useState<Project[]>([]);
  const [routeItems, setRouteItems] = useState<PlanningRouteEntry[]>([]);
  const [researchProgressState, setResearchProgressState] =
    useState<RoutesResearchProgressAsyncState>(initialResearchProgressState);
  const [selectedProjectId, setSelectedProjectId] = useState(
    () => readSharedCurrentProjectSelection() ?? ""
  );
  const [loadErrorMessage, setLoadErrorMessage] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [form, setForm] = useState<RouteFormState>(emptyForm);
  const [routeResearchTraceDisplayTouched, setRouteResearchTraceDisplayTouched] =
    useState(false);
  const [routeCheckpoints, setRouteCheckpoints] = useState<RouteCheckpoint[]>([]);
  const [checkpointEditorMode, setCheckpointEditorMode] =
    useState<RouteCheckpointEditorMode>(null);
  const [editingCheckpointId, setEditingCheckpointId] = useState<string | null>(null);
  const [checkpointForm, setCheckpointForm] = useState<RouteCheckpointFormState>(
    emptyRouteCheckpointForm
  );
  const [showCheckpointOptionalFields, setShowCheckpointOptionalFields] = useState(false);
  const [isCheckpointLoading, setIsCheckpointLoading] = useState(false);
  const [updatingCheckpointId, setUpdatingCheckpointId] = useState<string | null>(null);
  const [checkpointTitleError, setCheckpointTitleError] = useState("");
  const [routeSearchText, setRouteSearchText] = useState("");
  const [routeFilter, setRouteFilter] = useState<RouteFilterKey>("all");
  const [routeOutputGapSummaries, setRouteOutputGapSummaries] = useState<
    Record<string, OutputGapFeedbackGapSummary[]>
  >({});
  const [routeFeedbackCardSummary, setRouteFeedbackCardSummary] =
    useState<PlanningFeedbackCardSummary | null>(null);
  const [routeCheckpointSummaries, setRouteCheckpointSummaries] = useState<
    Record<string, RouteCheckpointProgressSummary>
  >({});
  const [routeTaskSummaries, setRouteTaskSummaries] = useState<
    Record<string, RouteNodeTaskSummary>
  >({});
  const [collapsedGroups, setCollapsedGroups] = useState<Record<RouteGroupKey, boolean>>({
    completed: true,
    active: false,
    idea: false,
    planned: true
  });
  const feedbackContext = useMemo(() => ({
    page: "routes",
    projectId: selectedProjectId || undefined
  }), [selectedProjectId]);
  const feedbackCenter = useWriteFeedbackCenter(feedbackContext);
  const operationConfirm = useOperationConfirm();
  const hasConsumedQueryFocus = useRef(false);
  const researchProgressTimelineRef = useRef<HTMLDivElement | null>(null);
  const researchTracePreferenceRequestRef = useRef("");
  const languageRef = useRef(language);
  languageRef.current = language;
  const requestCoordinatorRef = useRef<RoutesResearchProgressRequestCoordinator | null>(null);
  if (!requestCoordinatorRef.current) {
    requestCoordinatorRef.current = createRoutesResearchProgressRequestCoordinator();
  }
  const requestCoordinator = requestCoordinatorRef.current;

  const loadPageData = useCallback(
    async (projectIdOverride?: string) => {
      let requestedProjectId =
        projectIdOverride ?? requestCoordinator.getCurrentProjectId();
      const requestToken = requestCoordinator.begin(requestedProjectId);

      setLoadErrorMessage("");
      setResearchProgressState({
        projectId: requestedProjectId,
        status: "loading",
        data: null,
        sourceRoutes: [],
        requestId: requestToken.requestId
      });

      try {
        const [pageModel, routeNodes] = await Promise.all([
          planningPageAdapterService.getPlanningRoutesPageModel(),
          planningService.queryRouteNodes({
            includeArchived: true,
            includeDeleted: true
          })
        ]);
        if (!requestCoordinator.isCurrent(requestToken)) {
          return;
        }

        const projectRows = pageModel.projects;
        const focusedItem = pageModel.routeNodes.find(
          (item) => item.id === focusedRouteNodeId
        );
        const requestedProject = projectRows.find(
          (project) => project.id === requestedProjectId
        );
        const queryProject = projectRows.find((project) => project.id === queryProjectId);
        const resolvedProjectId =
          requestedProject?.id ||
          focusedItem?.projectId ||
          queryProject?.id ||
          resolveSharedCurrentProjectSelection(projectRows);

        if (resolvedProjectId !== requestedProjectId) {
          if (!requestCoordinator.retarget(requestToken, resolvedProjectId)) {
            return;
          }
          requestedProjectId = resolvedProjectId;
        }

        const data = resolveRoutesResearchProgress({
          projectId: requestedProjectId,
          routes: routeNodes,
          locale: languageRef.current
        });
        if (!requestCoordinator.canCommitData(requestToken, data)) {
          if (requestCoordinator.isCurrent(requestToken)) {
            setResearchProgressState({
              projectId: requestedProjectId,
              status: "error",
              data: null,
              sourceRoutes: [],
              requestId: requestToken.requestId,
              errorMessage: "project_mismatch"
            });
          }
          return;
        }

        setProjects(projectRows);
        setRouteItems(pageModel.routeNodes);
        setRouteOutputGapSummaries(pageModel.outputGapSummariesByRouteNodeId);
        setRouteCheckpointSummaries(pageModel.checkpointSummariesByRouteNodeId);
        setRouteTaskSummaries(pageModel.taskSummariesByRouteNodeId);
        setSelectedProjectId(requestedProjectId);
        setResearchProgressState({
          projectId: requestedProjectId,
          status: data.items.length > 0 ? "success" : "empty",
          data,
          sourceRoutes: routeNodes,
          requestId: requestToken.requestId
        });
      } catch (error) {
        if (!requestCoordinator.isCurrent(requestToken)) {
          return;
        }
        setLoadErrorMessage(error instanceof Error ? error.message : String(error));
        setResearchProgressState({
          projectId: requestedProjectId,
          status: "error",
          data: null,
          sourceRoutes: [],
          requestId: requestToken.requestId
        });
      }
    },
    [focusedRouteNodeId, queryProjectId, requestCoordinator]
  );

  const selectResearchProgressProject = useCallback(
    (projectId: string) => {
      setSelectedProjectId(projectId);
      void loadPageData(projectId);
    },
    [loadPageData]
  );

  const refreshRouteFeedbackCardSummary = useCallback(async (projectId: string) => {
    if (!projectId) {
      setRouteFeedbackCardSummary(null);
      return;
    }
    const summary = await outputGapFeedbackCardSelectorService.getPlanningFeedbackCardSummary(
      projectId,
      "route"
    );
    setRouteFeedbackCardSummary(summary);
  }, []);

  const reloadCurrentPage = useCallback(
    async (_event?: RefreshEvent) => {
      await loadPageData();
      await refreshRouteFeedbackCardSummary(selectedProjectId);
    },
    [loadPageData, refreshRouteFeedbackCardSummary, selectedProjectId]
  );

  const refreshByKeys = reloadCurrentPage;

  useRefreshEventReload({
    pageName: "routes",
    watchedKeys: ROUTES_REFRESH_KEYS,
    reload: refreshByKeys,
    onRefreshFeedback: feedbackCenter.pushRefreshEventFeedback,
    onReloadError: (error, event) =>
      feedbackCenter.pushReloadErrorFeedback(error, event, "routes")
  });

  useEffect(() => {
    requestCoordinator.activate();
    return () => requestCoordinator.dispose();
  }, [requestCoordinator]);

  useEffect(() => {
    void loadPageData();
  }, [loadPageData]);

  useEffect(() => {
    setResearchProgressState((current) => {
      if (
        (current.status !== "success" && current.status !== "empty") ||
        !current.data
      ) {
        return current;
      }
      const data = resolveRoutesResearchProgress({
        projectId: current.projectId,
        routes: current.sourceRoutes,
        locale: language
      });
      if (!isRoutesResearchProgressDataForProject(data, current.projectId)) {
        return {
          projectId: current.projectId,
          status: "error",
          data: null,
          sourceRoutes: [],
          requestId: current.requestId,
          errorMessage: "project_mismatch"
        };
      }
      return {
        ...current,
        status: data.items.length > 0 ? "success" : "empty",
        data
      };
    });
  }, [language]);

  useEffect(() => {
    if (researchProgressTimelineRef.current) {
      researchProgressTimelineRef.current.scrollTop = 0;
    }
    void refreshRouteFeedbackCardSummary(selectedProjectId);
  }, [refreshRouteFeedbackCardSummary, selectedProjectId]);

  useEffect(() => {
    if (!focusedRouteNodeId || hasConsumedQueryFocus.current) {
      return;
    }

    const focusedItem = routeItems.find((item) => item.id === focusedRouteNodeId);
    if (!focusedItem) {
      return;
    }

    const groupKey = getRouteGroupKey(focusedItem);
    if (focusedItem.projectId !== selectedProjectId) {
      selectResearchProgressProject(focusedItem.projectId);
    }
    setRouteFilter((current) =>
      current === "all" || current === groupKey ? current : "all"
    );
    setRouteSearchText((current) => {
      if (!current.trim()) {
        return current;
      }

      const query = current.trim().toLowerCase();
      const matchesKeyword = [
        focusedItem.title,
        focusedItem.description,
        focusedItem.expectedOutput,
        focusedItem.timeLabel
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(query);

      return matchesKeyword ? current : "";
    });
    setCollapsedGroups((current) => ({
      ...current,
      [groupKey]: false
    }));
    hasConsumedQueryFocus.current = true;
  }, [focusedRouteNodeId, routeItems, selectResearchProgressProject, selectedProjectId]);

  const selectedProjectItems = useMemo(
    () => sortRouteItems(routeItems.filter((item) => item.projectId === selectedProjectId)),
    [routeItems, selectedProjectId]
  );
  const researchProgressStatus =
    researchProgressState.projectId === selectedProjectId
      ? researchProgressState.status
      : selectedProjectId
        ? "loading"
        : "idle";
  const researchProgressItems =
    researchProgressStatus === "success" &&
    researchProgressState.data?.projectId === selectedProjectId
      ? researchProgressState.data.items
      : [];
  const researchProgressLayoutMode =
    researchProgressItems.length >= 4
      ? "four-capacity"
      : researchProgressItems.length > 0
        ? "sparse"
        : "empty";
  const researchProgressRouteEntryById = useMemo(
    () => new Map(selectedProjectItems.map((item) => [item.id, item])),
    [selectedProjectItems]
  );

  const filteredProjectItems = useMemo(() => {
    const keyword = routeSearchText.trim().toLowerCase();

    return selectedProjectItems.filter((item) => {
      const groupKey = getRouteGroupKey(item);
      const matchesGroup = routeFilter === "all" || groupKey === routeFilter;
      const matchesKeyword =
        !keyword ||
        [item.title, item.description, item.expectedOutput, item.timeLabel]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(keyword);

      return matchesGroup && matchesKeyword;
    });
  }, [routeFilter, routeSearchText, selectedProjectItems]);
  const groupedRouteItems = useMemo(
    () =>
      routeGroupKeys.reduce(
        (groups, key) => ({
          ...groups,
          [key]: selectedProjectItems.filter((item) => getRouteGroupKey(item) === key)
        }),
        {
          completed: [] as PlanningRouteEntry[],
          active: [] as PlanningRouteEntry[],
          idea: [] as PlanningRouteEntry[],
          planned: [] as PlanningRouteEntry[]
        }
      ),
    [selectedProjectItems]
  );
  const visibleGroupedRouteItems = useMemo(
    () =>
      routeGroupKeys.reduce(
        (groups, key) => ({
          ...groups,
          [key]: filteredProjectItems.filter((item) => getRouteGroupKey(item) === key)
        }),
        {
          completed: [] as PlanningRouteEntry[],
          active: [] as PlanningRouteEntry[],
          idea: [] as PlanningRouteEntry[],
          planned: [] as PlanningRouteEntry[]
        }
      ),
    [filteredProjectItems]
  );

  const selectedProject = projects.find((project) => project.id === selectedProjectId);
  const latestProjectUpdate = useMemo(
    () =>
      resolveRoutesLatestUpdatedAt({
        projectId: selectedProjectId,
        routes: routeItems,
        projectUpdatedAt: selectedProject?.updatedAt,
        formatDate
      }),
    [routeItems, selectedProject?.updatedAt, selectedProjectId]
  );
  const hasSelectedProject = Boolean(selectedProject);
  const hasProjectRoutes = selectedProjectItems.length > 0;
  const hasFilteredRoutes = filteredProjectItems.length > 0;
  const routeListHintText = hasProjectRoutes
    ? t("routeListFilterNoResultHint")
    : t("routeListNoRoutesHint");
  const routeFeedbackCards = (routeFeedbackCardSummary?.cards ?? []).filter(
    (card) => !card.archivedAt && !card.deletedAt
  );
  const routeFeedbackCardStatusLabels = {
    pending: t("outputGapFeedbackCardStatusPending"),
    resolved: t("outputGapFeedbackCardStatusResolved")
  };
  const groupLabels: Record<RouteGroupKey, string> = {
    completed: t("routeGroupCompleted"),
    active: t("routeGroupActive"),
    idea: t("routeGroupIdea"),
    planned: t("routeGroupPlanned")
  };
  const routeCheckpointStatusLabels: Record<RouteCheckpointStatus, string> = {
    planned: t("routeCheckpointPlanned"),
    active: t("routeCheckpointActive"),
    blocked: t("routeCheckpointBlocked"),
    completed: t("routeCheckpointCompleted"),
    abandoned: t("routeCheckpointAbandoned")
  };
  const routeCardStatusLabels: Record<RouteCardStatus, string> = {
    planned: t("routeStatusPlanned"),
    active: t("routeStatusActive"),
    blocked: t("routeStatusBlocked"),
    completed: t("routeStatusCompleted")
  };
  const selectedProjectObjective = selectedProject?.objective?.trim() || t("notProvided");

  function applyRouteResearchTraceDefault(nextForm: RouteFormState) {
    if (editingId || routeResearchTraceDisplayTouched) {
      return nextForm;
    }
    return {
      ...nextForm,
      researchTraceDisplayChecked: isRouteResearchTraceDefaultDisplayed(nextForm)
    };
  }

  function openCreateModal() {
    researchTracePreferenceRequestRef.current = "";
    setEditingId(null);
    setRouteResearchTraceDisplayTouched(false);
    setForm({
      ...emptyForm,
      projectId: selectedProjectId || projects[0]?.id || ""
    });
    setRouteCheckpoints([]);
    setCheckpointEditorMode(null);
    setEditingCheckpointId(null);
    setCheckpointForm(emptyRouteCheckpointForm);
    setShowCheckpointOptionalFields(false);
    setCheckpointTitleError("");
    setIsModalOpen(true);
  }

  const loadRouteCheckpoints = useCallback(
    async (routeNodeId: string) => {
      setIsCheckpointLoading(true);
      try {
        setRouteCheckpoints(
          await planningService.queryRouteCheckpointsByRouteNode(routeNodeId)
        );
      } catch (error) {
        feedbackCenter.consumeWriteError(error, "planning.queryRouteCheckpoints");
      } finally {
        setIsCheckpointLoading(false);
      }
    },
    [feedbackCenter]
  );

  function openEditModal(item: PlanningRouteEntry) {
    const requestKey = `${item.projectId}:route:${item.id}`;
    researchTracePreferenceRequestRef.current = requestKey;
    setEditingId(item.id);
    setRouteResearchTraceDisplayTouched(false);
    setForm(toForm(item));
    setCheckpointEditorMode(null);
    setEditingCheckpointId(null);
    setCheckpointForm(emptyRouteCheckpointForm);
    setShowCheckpointOptionalFields(false);
    setCheckpointTitleError("");
    setIsModalOpen(true);
    void loadRouteCheckpoints(item.id);
    void loadRouteResearchTracePreference(item, requestKey);
  }

  function openResearchProgressRoute(item: RouteResearchProgressItem) {
    const currentProjectId = requestCoordinator.getCurrentProjectId();
    if (
      researchProgressState.status !== "success" ||
      currentProjectId !== selectedProjectId ||
      researchProgressState.projectId !== selectedProjectId ||
      researchProgressState.data?.projectId !== selectedProjectId ||
      !researchProgressState.data.items.some(
        (currentItem) =>
          currentItem.routeId === item.routeId && currentItem.projectId === item.projectId
      ) ||
      item.projectId !== currentProjectId
    ) {
      return;
    }
    const routeEntry = researchProgressRouteEntryById.get(item.routeId);
    if (!routeEntry || routeEntry.projectId !== currentProjectId) {
      return;
    }
    openEditModal(routeEntry);
  }

  function closeModal() {
    researchTracePreferenceRequestRef.current = "";
    setEditingId(null);
    setRouteResearchTraceDisplayTouched(false);
    setForm(emptyForm);
    setRouteCheckpoints([]);
    setCheckpointEditorMode(null);
    setEditingCheckpointId(null);
    setCheckpointForm(emptyRouteCheckpointForm);
    setShowCheckpointOptionalFields(false);
    setCheckpointTitleError("");
    setIsModalOpen(false);
  }

  function clearRouteForm() {
    setForm((current) => ({
      ...current,
      title: "",
      description: "",
      timeLabel: "",
      startDate: "",
      endDate: "",
      researchTraceDisplayChecked: false
    }));
  }

  async function loadRouteResearchTracePreference(
    item: PlanningRouteEntry,
    requestKey: string
  ) {
    try {
      const checked = await getResearchTraceDisplayChecked({
        projectId: item.projectId,
        targetType: "route",
        targetId: item.id,
        defaultDisplayed: isRouteResearchTraceDefaultDisplayed(item)
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

  function startCreateRouteCheckpoint() {
    setCheckpointEditorMode("create");
    setEditingCheckpointId(null);
    setCheckpointForm(emptyRouteCheckpointForm);
    setShowCheckpointOptionalFields(false);
    setCheckpointTitleError("");
  }

  function startEditRouteCheckpoint(item: RouteCheckpoint) {
    setCheckpointEditorMode("edit");
    setEditingCheckpointId(item.id);
    setCheckpointForm(toRouteCheckpointForm(item));
    setShowCheckpointOptionalFields(false);
    setCheckpointTitleError("");
  }

  function closeRouteCheckpointEditor() {
    setCheckpointEditorMode(null);
    setEditingCheckpointId(null);
    setCheckpointForm(emptyRouteCheckpointForm);
    setShowCheckpointOptionalFields(false);
    setCheckpointTitleError("");
  }

  function buildRouteCheckpointDeletePreview(
    checkpoint: RouteCheckpoint
  ): OperationImpactPreview {
    return createOperationImpactPreview({
      operationId: "planning.routeCheckpoint.delete",
      operation: "delete",
      target: {
        type: "routeCheckpoint",
        id: checkpoint.id,
        title: checkpoint.title
      },
      summary: t("confirmDeleteRouteCheckpoint"),
      riskLevel: "high",
      executionKind: "soft-delete",
      isRecoverable: false,
      hasRestoreEntry: false,
      requiresUserConfirmation: true,
      canProceed: true,
      deepScanPerformed: false,
      confirmLabel: t("deleteRouteCheckpoint"),
      affectedItems: [
        {
          entityType: "routeCheckpointProgress",
          title: t("routeCheckpointDeleteImpactProgress"),
          severity: "warning"
        },
        {
          entityType: "routeCheckpointCurrent",
          title: t("routeCheckpointDeleteImpactCurrent"),
          severity: "warning"
        },
        {
          entityType: "routeCheckpointFeedback",
          title: t("routeCheckpointDeleteImpactFeedback"),
          severity: "warning"
        }
      ],
      warnings: [
        t("routeCheckpointDeleteNotRestorable"),
        t("routeCheckpointDeleteAbandonHint")
      ]
    });
  }

  function buildRouteDeletePreview(route: PlanningRouteEntry): OperationImpactPreview {
    const checkpointCount = routeCheckpointSummaries[route.id]?.total ?? 0;
    const taskCount = routeTaskSummaries[route.id]?.total ?? 0;
    const gapCount = routeOutputGapSummaries[route.id]?.length ?? 0;

    return createOperationImpactPreview({
      operationId: "planning.routeNode.delete",
      operation: "delete",
      target: {
        type: "routeNode",
        id: route.id,
        title: route.title
      },
      summary: t("confirmDeleteRoute"),
      riskLevel: "critical",
      executionKind: "soft-delete",
      isRecoverable: false,
      hasRestoreEntry: false,
      requiresUserConfirmation: true,
      canProceed: true,
      deepScanPerformed: false,
      confirmLabel: t("deleteRoute"),
      affectedItems: [
        checkpointCount > 0
          ? {
              entityType: "routeCheckpoint",
              title: `${t("routeDeleteImpactCheckpoints")}: ${checkpointCount}`,
              severity: "warning" as const
            }
          : null,
        taskCount > 0
          ? {
              entityType: "task",
              title: `${t("routeDeleteImpactTasks")}: ${taskCount}`,
              severity: "warning" as const
            }
          : null,
        gapCount > 0
          ? {
              entityType: "outputGap",
              title: `${t("routeDeleteImpactGaps")}: ${gapCount}`,
              severity: "warning" as const
            }
          : null
      ].filter((item): item is NonNullable<typeof item> => item !== null),
      warnings: [t("routeDeleteNotRestorable"), t("routeDeleteRelatedRecordsWarning")]
    });
  }

  async function handleDeleteRouteCheckpoint(checkpoint: RouteCheckpoint) {
    if (!editingId) {
      return;
    }
    const preview = buildRouteCheckpointDeletePreview(checkpoint);
    const confirmed = await operationConfirm.requestConfirmation(preview);
    if (!confirmed) {
      feedbackCenter.pushWriteFeedback(
        createOperationCancelledFeedback(preview, t("routeCheckpointDeleteCancelled"))
      );
      return;
    }

    try {
      const deletedAt = new Date().toISOString();
      const deleted = await planningService.deleteRouteCheckpoint(checkpoint.id);
      let feedback = createWriteFeedbackResult<RouteCheckpoint>({
        status: deleted ? "success" : "skipped",
        operation: "planning.deleteRouteCheckpoint",
        data: checkpoint,
        affectedEntities: [
          {
            type: "routeCheckpoint",
            id: checkpoint.id,
            relation: deleted ? "deleted" : "skipped",
            label: checkpoint.title
          },
          {
            type: "routeNode",
            id: editingId,
            relation: deleted ? "updated" : "skipped"
          }
        ],
        affectedScopes: [
          {
            module: "route",
            projectId: form.projectId,
            routeNodeId: editingId,
            reason: "RouteCheckpoint deletion changed route progress."
          }
        ],
        refreshKeys: [
          "route.changed",
          "project.changed",
          "reviewContext.changed",
          "aiContext.changed"
        ],
        skipped: deleted ? [] : ["route_checkpoint_not_found_or_already_deleted"],
        warnings: deleted ? [t("routeCheckpointDeleteNotRestorable")] : [],
        messages: [
          {
            severity: deleted ? "success" : "warning",
            message: deleted
              ? t("routeCheckpointDeleted")
              : t("routeCheckpointDeleteSkipped")
          }
        ]
      });

      if (deleted) {
        feedback = await recordUnsupportedPlanningDeleteAudit(feedback, preview, {
          entityType: "routeCheckpoint",
          entityId: checkpoint.id,
          title: checkpoint.title,
          summary: checkpoint.description,
          deletedAt,
          operationSummary: t("routeCheckpointDeleted"),
          cannotRestoreReason: t("routeCheckpointDeleteNotRestorable"),
          auditWarningPrefix: t("routeDeleteAuditTrailWarning")
        });
        publishWriteFeedbackRefresh(
          createWriteFeedbackResult({
            status: "success",
            operation: "planning.deleteRouteCheckpoint.projectRefresh",
            refreshKeys: ["project.changed"]
          }),
          {
            source: "service.write",
            reason: "route checkpoint deletion changed project route progress"
          }
        );
        closeRouteCheckpointEditor();
        await loadRouteCheckpoints(editingId);
      }
      feedbackCenter.pushWriteFeedback(feedback);
    } catch (error) {
      feedbackCenter.consumeWriteError(error, "planning.deleteRouteCheckpoint");
    }
  }

  async function handleDeleteRoute(route: PlanningRouteEntry) {
    const preview = buildRouteDeletePreview(route);
    const confirmed = await operationConfirm.requestConfirmation(preview);
    if (!confirmed) {
      feedbackCenter.pushWriteFeedback(
        createOperationCancelledFeedback(preview, t("routeDeleteCancelled"))
      );
      return;
    }

    try {
      const deletedAt = new Date().toISOString();
      const deleted = await planningService.deleteRouteNode(route.id);
      let feedback = createWriteFeedbackResult<PlanningRouteEntry>({
        status: deleted ? "success" : "skipped",
        operation: "planning.deleteRouteNode",
        data: route,
        affectedEntities: [
          {
            type: "routeNode",
            id: route.id,
            relation: deleted ? "deleted" : "skipped",
            label: route.title
          }
        ],
        affectedScopes: [
          {
            module: "route",
            projectId: route.projectId,
            routeNodeId: route.id,
            reason: "RouteNode was soft deleted."
          }
        ],
        refreshKeys: [
          "route.changed",
          "project.changed",
          "task.changed",
          "reviewContext.changed",
          "aiContext.changed",
          "global.changed"
        ],
        skipped: deleted ? [] : ["route_node_not_found_or_already_deleted"],
        warnings: deleted ? [t("routeDeleteNotRestorable")] : [],
        messages: [
          {
            severity: deleted ? "success" : "warning",
            message: deleted ? t("routeDeleted") : t("routeDeleteSkipped")
          }
        ]
      });

      if (deleted) {
        feedback = await recordUnsupportedPlanningDeleteAudit(feedback, preview, {
          entityType: "routeNode",
          entityId: route.id,
          title: route.title,
          summary: route.description,
          deletedAt,
          operationSummary: t("routeDeleted"),
          cannotRestoreReason: t("routeDeleteNotRestorable"),
          auditWarningPrefix: t("routeDeleteAuditTrailWarning")
        });
        publishBusinessOperationTerminal({
          objectType: "route",
          action: "delete",
          result: "success"
        });
        closeModal();
        publishWriteFeedbackRefresh(feedback, {
          source: "service.write",
          reason: "route deleted from Routes page"
        });
        await loadPageData();
      }
      feedbackCenter.pushWriteFeedback(feedback);
    } catch (error) {
      feedbackCenter.consumeWriteError(error, "planning.deleteRouteNode");
    }
  }

  async function handleRouteCheckpointStatusChange(
    checkpoint: RouteCheckpoint,
    status: RouteCheckpointStatus
  ) {
    if (!editingId || checkpoint.status === status || updatingCheckpointId) {
      return;
    }

    const operation = "planning.updateRouteCheckpoint";
    setUpdatingCheckpointId(checkpoint.id);
    try {
      const updatedCheckpoint = await planningService.updateRouteCheckpoint(checkpoint.id, {
        status
      });
      feedbackCenter.consumeWriteResult(updatedCheckpoint, {
        operation,
        successMessage: t("routeCheckpointStatusUpdated"),
        skippedMessage: t("routeCheckpointSaveSkipped"),
        affectedEntities: [
          {
            type: "routeCheckpoint",
            id: updatedCheckpoint?.id ?? checkpoint.id,
            relation: "updated",
            label: updatedCheckpoint?.title ?? checkpoint.title
          }
        ],
        affectedScopes: [
          {
            module: "route",
            projectId: form.projectId,
            routeNodeId: editingId,
            reason: "RouteCheckpoint status changed."
          }
        ],
        refreshKeys: ["route.changed", "reviewContext.changed", "aiContext.changed"],
        voidIsSuccess: false
      });

      if (updatedCheckpoint) {
        await loadRouteCheckpoints(editingId);
      }
    } catch (error) {
      feedbackCenter.consumeWriteError(error, operation);
    } finally {
      setUpdatingCheckpointId(null);
    }
  }

  async function handleRouteFeedbackCardStatusToggle(card: OutputGapFeedbackCard) {
    const nextStatus = card.status === "pending" ? "resolved" : "pending";
    const operation = "outputGapFeedbackCard.setRouteReminderStatus";
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
            reason: "OutputGap feedback card status changed from Routes page."
          }
        ],
        refreshKeys: ["output.gap.changed"],
        voidIsSuccess: false
      });
      await refreshRouteFeedbackCardSummary(selectedProjectId);
    } catch (error) {
      feedbackCenter.consumeWriteError(error, operation);
    }
  }

  async function handleRouteCheckpointSubmit() {
    if (!editingId) {
      return;
    }

    const title = checkpointForm.title.trim();
    if (!title) {
      setCheckpointTitleError(t("routeCheckpointTitleRequired"));
      return;
    }
    setCheckpointTitleError("");

    const operation = editingCheckpointId
      ? "planning.updateRouteCheckpoint"
      : "planning.createRouteCheckpoint";

    try {
      const checkpoint = editingCheckpointId
        ? await planningService.updateRouteCheckpoint(editingCheckpointId, {
            title,
            status: checkpointForm.status,
            description: checkpointForm.description,
            acceptanceCriteria: checkpointForm.acceptanceCriteria,
            dueDate: checkpointForm.dueDate,
            feedback: checkpointForm.feedback
          })
        : await planningService.createRouteCheckpoint({
            routeNodeId: editingId,
            title,
            status: checkpointForm.status,
            description: checkpointForm.description,
            acceptanceCriteria: checkpointForm.acceptanceCriteria,
            dueDate: checkpointForm.dueDate,
            feedback: checkpointForm.feedback,
            orderIndex: routeCheckpoints.length
          });

      feedbackCenter.consumeWriteResult(checkpoint, {
        operation,
        successMessage: editingCheckpointId
          ? t("routeCheckpointUpdated")
          : t("routeCheckpointCreated"),
        skippedMessage: t("routeCheckpointSaveSkipped"),
        affectedEntities: [
          {
            type: "routeCheckpoint",
            id: checkpoint?.id ?? editingCheckpointId ?? "unknown-route-checkpoint",
            relation: editingCheckpointId ? "updated" : "created",
            label: checkpoint?.title ?? title
          }
        ],
        affectedScopes: [
          {
            module: "route",
            projectId: form.projectId,
            routeNodeId: editingId,
            reason: "RouteCheckpoint form write changed route progress."
          }
        ],
        refreshKeys: ["route.changed", "reviewContext.changed", "aiContext.changed"],
        voidIsSuccess: false
      });

      if (!checkpoint) {
        return;
      }

      await loadRouteCheckpoints(editingId);
      closeRouteCheckpointEditor();
    } catch (error) {
      feedbackCenter.consumeWriteError(error, operation);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const startDate = resolveDateFallback(form.startDate);
    const endDate = resolveDateFallback(form.endDate);
    const editingItem = editingId
      ? routeItems.find((item) => item.id === editingId)
      : undefined;
    const routeInput = {
      projectId: form.projectId,
      title: form.title,
      description: form.description,
      timeLabel: form.timeLabel || undefined,
      timePrecision: timeScaleToTimePrecision(inferTimeScale(startDate ?? "", endDate ?? "")),
      startDate,
      endDate,
      expectedOutput: form.title,
      status: workStatusToRouteNodeStatus(form.status),
      nodeType: editingItem?.nodeType ?? "other",
      showInGantt: form.showInGantt,
      captureState: form.captureState,
      orderIndex:
        editingItem?.orderIndex ??
        routeItems.filter((item) => item.projectId === form.projectId).length,
      customFields: {
        ...(editingItem?.customFields ?? {}),
        progress: routeProgressForStatus(form.status)
      }
    };

    const operation = editingId ? "planning.updateRouteNode" : "planning.createRouteNode";

    try {
      const routeNode = editingId
        ? await planningService.updateRouteNode(editingId, routeInput)
        : await planningService.createRouteNode(routeInput);

      feedbackCenter.consumeWriteResult(routeNode, {
        operation,
        successMessage: editingId ? t("routeUpdated") : t("routeCreated"),
        skippedMessage: t("routeSaveSkipped"),
        affectedEntities: [
          {
            type: "routeNode",
            id: routeNode?.id ?? editingId ?? "unknown-route-node",
            relation: editingId ? "updated" : "created",
            label: routeNode?.title ?? form.title
          }
        ],
        affectedScopes: [
          {
            module: "route",
            projectId: routeNode?.projectId ?? form.projectId,
            routeNodeId: routeNode?.id ?? editingId ?? undefined,
            reason: "Route form write changed route metadata."
          }
        ],
        refreshKeys: ["route.changed", "reviewContext.changed", "aiContext.changed"],
        voidIsSuccess: false
      });

      if (!routeNode) {
        return;
      }

      try {
        const defaultDisplayed = isRouteResearchTraceDefaultDisplayed(routeNode);
        await saveResearchTraceDisplayPreference({
          projectId: routeNode.projectId,
          targetType: "route",
          targetId: routeNode.id,
          defaultDisplayed,
          checked: form.researchTraceDisplayChecked
        });
      } catch (preferenceError) {
        feedbackCenter.consumeWriteError(
          preferenceError,
          "researchTrace.preference.save"
        );
      }

      closeModal();
      await loadPageData();
    } catch (error) {
      feedbackCenter.consumeWriteError(error, operation);
    }
  }

  return (
    <section className="page-section routes-page">
      <PageHeader title={t("routes")} description={t("routesDescription")} />
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

      <section className="routes-top-panel">
        <div className="routes-toolbar">
          <div className="routes-project-row project-context-selector">
            <span className="project-context-selector__label">{t("project")}</span>
            <select
              className="project-context-selector__control"
              value={selectedProjectId}
              onChange={(event) => {
                hasConsumedQueryFocus.current = true;
                const projectId = event.target.value;
                writeSharedCurrentProjectSelection(projectId);
                selectResearchProgressProject(projectId);
              }}
              aria-label={t("project")}
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </div>
          <div className="routes-research-goal">
            <span>{t("routeResearchGoal")}</span>
            <p>{selectedProjectObjective}</p>
          </div>
        </div>

        <div className="routes-progress-summary" aria-label={t("routeProgressSummary")}>
          <div>
            <span>{t("routeGroupActive")}</span>
            <strong>{groupedRouteItems.active.length}</strong>
          </div>
          <div>
            <span>{t("routeGroupIdea")}</span>
            <strong>{groupedRouteItems.idea.length}</strong>
          </div>
          <div>
            <span>{t("routeGroupCompleted")}</span>
            <strong>{groupedRouteItems.completed.length}</strong>
          </div>
          <div>
            <span>{t("routeGroupPlanned")}</span>
            <strong>{groupedRouteItems.planned.length}</strong>
          </div>
          <div>
            <span>{t("routeLatestUpdate")}</span>
            <strong>{latestProjectUpdate.displayText}</strong>
          </div>
        </div>
      </section>

      <section className="routes-timeline-panel routes-split-panel">
        {loadErrorMessage ? (
          <div className="routes-empty-state" aria-live="polite">
            <h2>{t("operationLogStatusError")}</h2>
            <p>{loadErrorMessage}</p>
          </div>
        ) : hasSelectedProject ? (
          <div className="routes-split-layout">
            <aside className="routes-left-timeline" aria-label={t("routeResearchProgress")}>
              <section className="routes-research-progress-panel">
                <div className="routes-timeline-heading">
                  <h2>{t("routeResearchProgress")}</h2>
                </div>
                <div
                  ref={researchProgressTimelineRef}
                  className={`routes-vertical-timeline routes-vertical-timeline--${researchProgressLayoutMode}`}
                  data-item-count={researchProgressItems.length}
                >
                  <div
                    className="routes-vertical-timeline__content"
                    data-has-items={researchProgressItems.length > 0}
                  >
                    {researchProgressStatus === "loading" ? (
                      <div className="routes-research-progress-empty" aria-live="polite">
                        <span>{t("routeResearchProgressLoading")}</span>
                      </div>
                    ) : researchProgressStatus === "error" ? (
                      <div className="routes-research-progress-empty" role="status">
                        <span>{t("routeResearchProgressError")}</span>
                      </div>
                    ) : researchProgressStatus === "success" ? (
                      researchProgressItems.map((item) => (
                        <article
                          className={`route-timeline-item ${item.routeId === focusedRouteNodeId ? "route-focus-item" : ""}`}
                          key={item.routeId}
                        >
                          <div
                            className={`route-timeline-marker route-timeline-marker--${item.colorState}`}
                          />
                          <button
                            type="button"
                            className="route-timeline-content"
                            onClick={() => openResearchProgressRoute(item)}
                          >
                            <span title={item.timeText}>{item.timeText}</span>
                            <h3 title={item.title}>{item.title}</h3>
                          </button>
                        </article>
                      ))
                    ) : researchProgressStatus === "empty" ? (
                      <div className="routes-research-progress-empty">
                        <span>{t("routeResearchProgressEmpty")}</span>
                      </div>
                    ) : null}
                  </div>
                </div>
              </section>

              <section className="route-output-gap-panel" aria-label={t("routeOutputFeedback")}>
                <div className="card-heading">
                  <h3>{t("routeOutputFeedback")}</h3>
                </div>
                {routeFeedbackCards.length > 0 ? (
                  <div className="planning-feedback-card-reminders__list">
                    {routeFeedbackCards.map((card) => (
                      <article className="planning-feedback-card-reminder" key={card.id}>
                        <div className="planning-feedback-card-reminder__body">
                          <strong>{card.title}</strong>
                          {card.description?.trim() ? <p>{card.description}</p> : null}
                          <span>
                            {routeFeedbackCardStatusLabels[card.status]} · {t("createdAt")}{" "}
                            {formatDate(card.createdAt) || t("notProvided")}
                          </span>
                        </div>
                        <button
                          type="button"
                          className="planning-feedback-card-reminder__toggle"
                          onClick={() => void handleRouteFeedbackCardStatusToggle(card)}
                        >
                          {card.status === "pending"
                            ? t("outputGapFeedbackCardMarkResolved")
                            : t("outputGapFeedbackCardMarkPending")}
                        </button>
                      </article>
                    ))}
                  </div>
                ) : (
                  <div className="routes-empty-state route-output-gap-empty">
                    <h2>{t("routeOutputGapEmptyTitle")}</h2>
                  </div>
                )}
              </section>
            </aside>

            <section className="routes-right-details" aria-label={t("routeDetails")}>
              <div className="routes-list-heading">
                <h2>{t("routeList")}</h2>
              </div>
              <div className="routes-details-toolbar">
                <button
                  type="button"
                  className="primary-page-action primary-page-action--primary"
                  onClick={openCreateModal}
                >
                  {t("createRouteShort")}
                </button>
                <select
                  className="compact-list-toolbar-control"
                  value={routeFilter}
                  onChange={(event) => setRouteFilter(event.target.value as RouteFilterKey)}
                  aria-label={t("status")}
                >
                  <option value="all">{t("allRoutes")}</option>
                  {routeGroupKeys.map((key) => (
                    <option key={key} value={key}>
                      {groupLabels[key]}
                    </option>
                  ))}
                </select>
                <input
                  className="compact-list-toolbar-control"
                  value={routeSearchText}
                  onChange={(event) => setRouteSearchText(event.target.value)}
                  placeholder={t("routeKeywordPlaceholder")}
                  aria-label={t("routeKeywordPlaceholder")}
                />
              </div>

              <div className="routes-detail-groups">
                {!hasFilteredRoutes ? (
                  <p className="routes-groups-hint">{routeListHintText}</p>
                ) : null}
                {routeGroupKeys.map((key) => {
                  const groupItems = visibleGroupedRouteItems[key];
                  const isCollapsed = collapsedGroups[key];

                  return (
                    <section className={`routes-detail-group routes-detail-${key}`} key={key}>
                      <button
                        type="button"
                        className="routes-detail-group-heading"
                        aria-expanded={!isCollapsed}
                        onClick={() =>
                          setCollapsedGroups((current) => ({
                            ...current,
                            [key]: !current[key]
                          }))
                        }
                      >
                        <span>{isCollapsed ? "\u25b8" : "\u25be"} {groupLabels[key]}</span>
                        <strong>{groupItems.length}</strong>
                      </button>

                      {!isCollapsed ? (
                        <div className="routes-detail-card-list">
                          {groupItems.length > 0 ? (
                            groupItems.map((item) => {
                              const checkpointSummary = routeCheckpointSummaries[item.id];
                              const routeStatus = getRouteCardStatus(item.status);
                              const routeDescription = item.description.trim();
                              const routeTimeLabel = getRouteCardTimeLabel(item);
                              const routeUpdatedAt = formatDate(item.updatedAt);

                              return (
                                <button
                                  type="button"
                                  className={`route-detail-card ${item.id === focusedRouteNodeId ? "route-focus-card" : ""}`}
                                  key={item.id}
                                  onClick={() => openEditModal(item)}
                                >
                                  <div className="route-card-heading">
                                    <h3>{item.title}</h3>
                                    <span
                                      className={`status-pill route-status-pill route-status-pill--${routeStatus}`}
                                    >
                                      {routeCardStatusLabels[routeStatus]}
                                    </span>
                                  </div>
                                  {routeDescription ? (
                                    <p className="route-card-description">{routeDescription}</p>
                                  ) : null}
                                  <div className="route-card-meta">
                                    {routeTimeLabel ? <span>{routeTimeLabel}</span> : null}
                                    <span>
                                      {t("routeCheckpointProgress")}{" "}
                                      {checkpointSummary?.completionRate ?? 0}%
                                    </span>
                                    {routeUpdatedAt ? (
                                      <span>
                                        {t("routeLastUpdated")} {routeUpdatedAt}
                                      </span>
                                    ) : null}
                                  </div>
                                </button>
                              );
                            })
                          ) : (
                            <p className="routes-detail-empty">{t("routeGroupEmpty")}</p>
                          )}
                        </div>
                      ) : null}
                    </section>
                  );
                })}
              </div>
            </section>
          </div>
        ) : (
          <div className="routes-empty-state">
            <h2>{t("routeNoProjectTitle")}</h2>
            <p>{t("routeNoProjectDescription")}</p>
          </div>
        )}
      </section>

      {isModalOpen ? (
        <div
          className="modal-backdrop route-editor-modal-backdrop"
          role="presentation"
          onClick={closeModal}
        >
          <form
            className="routes-modal-form route-editor-modal"
            onSubmit={handleSubmit}
            onClick={(event) => event.stopPropagation()}
          >
            <header className="card-heading route-editor-modal__header">
              <h2>{editingId ? t("editRoute") : t("createRoute")}</h2>
              <button type="button" className="secondary-button" onClick={closeModal}>
                {t("close")}
              </button>
            </header>

            <div className="route-editor-modal__body">

            <label>
              {t("title")}
              <input
                value={form.title}
                onChange={(event) => setForm({ ...form, title: event.target.value })}
                required
              />
            </label>

            <p className="route-form-project-context">
              <span>{t("currentProject")}</span>
              <strong>
                {projects.find((project) => project.id === form.projectId)?.name ??
                  t("notProvided")}
              </strong>
            </p>

            <div className="form-row routes-time-row">
              <label>
                {t("startDate")} {t("optional")}
                <input
                  type="date"
                  value={form.startDate}
                  onChange={(event) =>
                    setForm((current) =>
                      applyRouteResearchTraceDefault({
                        ...current,
                        startDate: event.target.value
                      })
                    )
                  }
                />
              </label>
              <label>
                {t("endDate")} {t("optional")}
                <input
                  type="date"
                  value={form.endDate}
                  onChange={(event) =>
                    setForm((current) =>
                      applyRouteResearchTraceDefault({
                        ...current,
                        endDate: event.target.value
                      })
                    )
                  }
                />
              </label>
              <label>
                {t("timeLabel")}
                <input
                  value={form.timeLabel}
                  onChange={(event) => setForm({ ...form, timeLabel: event.target.value })}
                  placeholder={t("timeLabelPlaceholder")}
                />
              </label>
            </div>

            <div className="form-row">
              <label>
                {t("status")}
                <select
                  value={form.status}
                  onChange={(event) =>
                    setForm((current) =>
                      applyRouteResearchTraceDefault({
                        ...current,
                        status: event.target.value as WorkStatus
                      })
                    )
                  }
                >
                  <option value="planned">{t("planned")}</option>
                  <option value="in_progress">{t("in_progress")}</option>
                  <option value="blocked">{t("blocked")}</option>
                  <option value="completed">{t("completed")}</option>
                </select>
              </label>
            </div>

            <details className="route-form-secondary-fields">
              <summary>{t("routeMoreFields")}</summary>
              <label>
                {t("description")} {t("optional")}
                <textarea
                  className="semantic-textarea-compact-summary"
                  rows={2}
                  value={form.description}
                  onChange={(event) => setForm({ ...form, description: event.target.value })}
                />
              </label>
              <div className="form-row">
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={form.showInGantt}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        showInGantt: event.target.checked
                      })
                    }
                  />
                  {t("showInGantt")}
                </label>
                <label className="checkbox-row research-trace-preference-row">
                  <input
                    type="checkbox"
                    checked={form.researchTraceDisplayChecked}
                    onChange={(event) => {
                      setRouteResearchTraceDisplayTouched(true);
                      setForm({
                        ...form,
                        researchTraceDisplayChecked: event.target.checked
                      });
                    }}
                  />
                  {t("showInResearchTrace")}
                </label>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={form.captureState === "idea"}
                    onChange={(event) =>
                      setForm((current) =>
                        applyRouteResearchTraceDefault({
                          ...current,
                          captureState: event.target.checked ? "idea" : "scheduled"
                        })
                      )
                    }
                  />
                  {t("markAsIdea")}
                </label>
              </div>
            </details>

            <section className="route-checkpoint-editor">
              <div className="route-checkpoint-editor__heading">
                <h3>{t("routeCheckpoint")}</h3>
                {editingId ? (
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={startCreateRouteCheckpoint}
                  >
                    {t("createRouteCheckpoint")}
                  </button>
                ) : null}
              </div>

              {!editingId ? (
                <p className="routes-detail-empty">
                  {t("routeCheckpointCreateHintAfterRouteSave")}
                </p>
              ) : (
                <>
                  <div className="route-checkpoint-list">
                    {isCheckpointLoading ? (
                      <p className="routes-detail-empty">{t("routeCheckpointLoading")}</p>
                    ) : routeCheckpoints.length > 0 ? (
                      routeCheckpoints.map((checkpoint) => (
                        <article className="route-checkpoint-item" key={checkpoint.id}>
                          <div className="route-checkpoint-item__primary">
                            <strong>{checkpoint.title}</strong>
                            <div
                              className="route-checkpoint-status-options"
                              role="group"
                              aria-label={t("routeCheckpointStatus")}
                            >
                              {routeCheckpointStatuses.map((status) => (
                                <button
                                  key={status}
                                  type="button"
                                  className={
                                    checkpoint.status === status
                                      ? "route-checkpoint-status-option is-active"
                                      : "route-checkpoint-status-option"
                                  }
                                  aria-pressed={checkpoint.status === status}
                                  disabled={updatingCheckpointId !== null}
                                  onClick={() =>
                                    void handleRouteCheckpointStatusChange(checkpoint, status)
                                  }
                                >
                                  {routeCheckpointStatusLabels[status]}
                                </button>
                              ))}
                            </div>
                            <button
                              type="button"
                              className="secondary-button route-checkpoint-edit-button"
                              onClick={() => startEditRouteCheckpoint(checkpoint)}
                            >
                              {t("edit")}
                            </button>
                          </div>
                          {checkpoint.dueDate || checkpoint.description?.trim() ? (
                            <div className="route-checkpoint-item__details">
                              {checkpoint.dueDate ? (
                                <span>
                                  <strong>{t("routeCheckpointDueDateLabel")}:</strong>{" "}
                                  {formatDate(checkpoint.dueDate)}
                                </span>
                              ) : null}
                              {checkpoint.description?.trim() ? (
                                <span>
                                  <strong>{t("routeCheckpointDescriptionLabel")}:</strong>{" "}
                                  {summarizeText(checkpoint.description)}
                                </span>
                              ) : null}
                            </div>
                          ) : null}
                        </article>
                      ))
                    ) : (
                      <p className="routes-detail-empty">{t("routeCheckpointListEmpty")}</p>
                    )}
                  </div>

                  {checkpointEditorMode ? (
                    <div className="route-checkpoint-form">
                      <div className="route-checkpoint-form__heading">
                        <h4>
                          {checkpointEditorMode === "edit"
                            ? t("editRouteCheckpoint")
                            : t("createRouteCheckpoint")}
                        </h4>
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={closeRouteCheckpointEditor}
                        >
                          {t("cancel")}
                        </button>
                      </div>
                      <div className="form-row">
                        <label>
                          {t("routeCheckpointTitle")}
                          <input
                            value={checkpointForm.title}
                            onChange={(event) => {
                              setCheckpointTitleError("");
                              setCheckpointForm({
                                ...checkpointForm,
                                title: event.target.value
                              });
                            }}
                          />
                          {checkpointTitleError ? (
                            <span className="route-checkpoint-field-error">
                              {checkpointTitleError}
                            </span>
                          ) : null}
                        </label>
                        <label>
                          {t("routeCheckpointStatus")}
                          <select
                            value={checkpointForm.status}
                            onChange={(event) =>
                              setCheckpointForm({
                                ...checkpointForm,
                                status: event.target.value as RouteCheckpointStatus
                              })
                            }
                          >
                            {routeCheckpointStatuses.map((status) => (
                              <option key={status} value={status}>
                                {routeCheckpointStatusLabels[status]}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                      <label>
                        {t("routeCheckpointDueDate")} {t("optional")}
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

                      <button
                        type="button"
                        className="route-checkpoint-fields-toggle secondary-button"
                        onClick={() => setShowCheckpointOptionalFields((current) => !current)}
                      >
                        {showCheckpointOptionalFields
                          ? t("routeCheckpointCollapseFields")
                          : t("routeCheckpointMoreFields")}
                      </button>

                      {showCheckpointOptionalFields ? (
                        <div className="route-checkpoint-optional-fields">
                          <label>
                            {t("routeCheckpointDescription")} {t("optional")}
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
                          <label>
                            {t("routeCheckpointAcceptanceCriteria")} {t("optional")}
                            <textarea
                              value={checkpointForm.acceptanceCriteria}
                              onChange={(event) =>
                                setCheckpointForm({
                                  ...checkpointForm,
                                  acceptanceCriteria: event.target.value
                                })
                              }
                            />
                          </label>
                          <label>
                            {t("routeCheckpointFeedback")} {t("optional")}
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
                        <details className="route-checkpoint-danger-details">
                          <summary>{t("dangerZone")}</summary>
                          <div className="route-danger-body">
                            <p>{t("routeCheckpointDeleteNotRestorable")}</p>
                            <button
                              type="button"
                              className="danger-button"
                              onClick={() => {
                                const checkpoint = routeCheckpoints.find(
                                  (item) => item.id === editingCheckpointId
                                );
                                if (checkpoint) {
                                  void handleDeleteRouteCheckpoint(checkpoint);
                                }
                              }}
                            >
                              {t("deleteRouteCheckpoint")}
                            </button>
                          </div>
                        </details>
                      ) : null}

                      <div className="button-row">
                        <button type="button" onClick={() => void handleRouteCheckpointSubmit()}>
                          {editingCheckpointId
                            ? t("saveRouteCheckpoint")
                            : t("createRouteCheckpoint")}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </>
              )}
            </section>

            </div>

            <DataClearFooterRow
              className="route-editor-modal__footer"
              contextKey={`route:${editingId ?? "new"}`}
              regionLabel={t("dataClearing")}
              clearLabel={t("clear")}
              deleteLabel={t("delete")}
              onClear={clearRouteForm}
              onDelete={
                editingId
                  ? () => {
                      const route = routeItems.find((item) => item.id === editingId);
                      if (route) void handleDeleteRoute(route);
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
