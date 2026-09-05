import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "../../components/common/PageHeader";
import { FileRefPathActions } from "../../components/common/FileRefPathActions";
import { FileRefPathPicker } from "../../components/common/FileRefPathPicker";
import { ModalPortal } from "../../components/common/ModalPortal";
import { FormalSwitchConfirmationDialog } from "../../components/common/FormalSwitchConfirmationDialog";
import { StructuredEditFieldGrid } from "../../components/common/StructuredEditFieldGrid";
import { DataClearFooterRow } from "../../components/common/DataClearRow";
import { StructuredSummaryDisplay } from "../../components/common/StructuredSummaryDisplay";
import { OperationConfirmDialog } from "../../components/safety/OperationConfirmDialog";
import { useLocation, useSearchParams } from "react-router-dom";
import { WriteFeedbackPanel } from "../../components/feedback/WriteFeedbackPanel";
import { useOperationConfirm } from "../../hooks/useOperationConfirm";
import { useRefreshEventReload } from "../../hooks/useRefreshEventReload";
import { useWriteFeedbackCenter } from "../../hooks/useWriteFeedbackCenter";
import { useI18n } from "../../i18n/I18nProvider";
import { nonPlanningEnumLabel, nonPlanningUi } from "../../i18n/nonPlanningI18n";
import {
  partitionExperimentPathRecords,
  partitionExperimentRunPathRecords
} from "./experimentsPagePathRecordModel";
import { useExperimentManuscriptEditor } from "./useExperimentManuscriptEditor";
import { useExperimentRunManuscriptEditor } from "./useExperimentRunManuscriptEditor";
import { ExperimentProvisioningIssueCard } from "./ExperimentProvisioningIssueCard";
import { ExperimentCurrentManuscriptEditor } from "./ExperimentCurrentManuscriptEditor";
import { ExperimentIndependentManuscriptEditor } from "./ExperimentIndependentManuscriptEditor";
import { ExperimentRunCurrentManuscriptEditor } from "./ExperimentRunCurrentManuscriptEditor";
import { ExperimentRunIndependentManuscriptEditor } from "./ExperimentRunIndependentManuscriptEditor";
import {
  createExperimentStructuredSummaryDto,
  createExperimentStructuredSummaryItems
} from "../../services/experimentStructuredSummaryProjection";
import { buildExperimentRunMarkdown } from "../../services/experimentExportService";
import {
  getExperimentDetailContext,
  getExperimentRunContext,
  queryExperiments
} from "../../services/experimentSelectorService";
import {
  experimentOutputGenerationService,
  type ExperimentOutputGenerationDraft
} from "../../services/experimentOutputGenerationService";
import {
  ExperimentRunManuscriptProvisioningIncompleteError,
  experimentRunService
} from "../../services/experimentRunService";
import { experimentRunLifecycleService } from "../../services/experimentRunLifecycleService";
import {
  ExperimentManuscriptProvisioningIncompleteError,
  ExperimentManuscriptProvisioningPreflightError,
  experimentService
} from "../../services/experimentService";
import {
  experimentProvisioningIssueFromResult,
  inspectExperimentManuscriptProvisioning,
  recoverExperimentManuscriptProvisioning
} from "../../services/experimentManuscriptProvisioningService";
import {
  fileRefService,
  getFileRefPathName,
  summarizeFileRefPath
} from "../../services/fileRefService";
import {
  createOperationCancelledFeedback,
  createOperationImpactPreview
} from "../../services/operationImpactPreviewService";
import {
  createOperationLog,
  summarizeFeedbackForOperationLog,
  summarizeImpactPreviewForOperationLog
} from "../../services/operationLogService";
import { planningService } from "../../services/planningService";
import {
  readSharedCurrentProjectSelection,
  resolveSharedCurrentProjectSelection,
  writeSharedCurrentProjectSelection
} from "../../services/sharedCurrentProjectSelection";
import { publishFormalBusinessAttemptFailure } from "../../services/businessOperationFeedbackService";
import {
  getResearchTraceDisplayChecked,
  saveResearchTraceDisplayPreference
} from "../../services/projectResearchTracePreferenceUiService";
import { publishWriteFeedbackRefresh } from "../../services/refreshEventService";
import { recordRecycleEntry } from "../../services/recycleBinService";
import {
  isResultMetricKeyResult,
  resultMetricService,
  withResultMetricKeyResult
} from "../../services/resultMetricService";
import { ExperimentQuickAnalysisButton } from "./ExperimentQuickAnalysisButton";
import { ExperimentRunQuickAnalysisButton } from "./ExperimentRunQuickAnalysisButton";
import {
  addWriteFeedbackWarning,
  createWriteFeedbackResult
} from "../../services/writeFeedbackService";
import type { WriteFeedbackDisplayScope } from "../../services/writeFeedbackDisplayService";
import type { ExperimentRunLifecycleMutationResult } from "../../types/experimentRunLifecycle";
import type {
  Experiment,
  ExperimentRating,
  ExperimentRun,
  ExperimentRunStatus,
  ExperimentStatus,
  FileRef,
  FileRefOwnerType,
  ResultMetric,
  ResultMetricValueType,
} from "../../types";
import type { ResultItem } from "../../types/outputConversion";
import type { ExperimentDetailContext, ExperimentRunContext } from "../../types/experimentContext";
import type { ExperimentManuscriptProvisioningIssue } from "../../types/experimentProvisioning";
import type { LocalFileOpenKind, LocalFileResult } from "../../types/localFile";
import type { Project, RouteNode, Task } from "../../types/planning";
import type { RefreshEvent, RefreshKeyPattern } from "../../types/refresh";
import type { OperationImpactPreview } from "../../types/operationSafety";
import type { RefreshKey, WriteFeedbackResult } from "../../types/writeFeedback";

const experimentStatuses: ExperimentStatus[] = [
  "planned",
  "running",
  "completed",
  "paused",
  "failed",
  "archived"
];

const runStatuses: ExperimentRunStatus[] = [
  "planned",
  "running",
  "completed",
  "paused",
  "failed",
  "cancelled"
];

const ratings: Array<ExperimentRating | ""> = [
  "",
  "excellent",
  "good",
  "usable",
  "inconclusive",
  "failed"
];

const EXPERIMENTS_REFRESH_KEYS: RefreshKeyPattern[] = [
  "project.changed",
  "task.changed",
  "experiment.changed",
  "experimentRun.changed",
  "resultMetric.changed",
  "fileRef.changed",
  "entityLink.changed",
  "reviewContext.changed",
  "aiContext.changed",
  "global.changed"
];

type FileRefFormState = {
  fileType: string;
  path: string;
  title: string;
  description: string;
};

type FileRefEditorState = {
  ownerType: FileRefOwnerType;
  fileRefId: string | null;
  form: FileRefFormState;
};

type ExperimentFormState = {
  projectId: string;
  routeId: string;
  taskId: string;
  title: string;
  purposeAndQuestion: string;
  conditionSummary: string;
  methodSummary: string;
  resultSummary: string;
  conclusionAndNextSteps: string;
  status: ExperimentStatus;
  rating: ExperimentRating | "";
  tags: string;
  other: string;
  usableForPaper: boolean;
  usableForReport: boolean;
  usableForPatent: boolean;
  dataPath: string;
  researchTraceDisplayChecked: boolean;
};

type RunFormState = {
  title: string;
  runLabel: string;
  status: ExperimentRunStatus;
  rating: ExperimentRating | "";
  conditionSummary: string;
  variableParameterSummary: string;
  methodSummary: string;
  resultSummary: string;
  conclusion: string;
  summaryOther: string;
  tags: string;
  researchTraceDisplayChecked: boolean;
};

type ExperimentPanelMode = "view" | "create" | "edit";
type RunPanelMode = "view" | "create" | "edit";
type ResultMetricFormState = {
  name: string;
  value: string;
  unit: string;
  metricGroup: string;
  description: string;
  valueType: ResultMetricValueType;
  isKeyResult: boolean;
};

type ResultMetricEditorState = {
  metricId: string | null;
  form: ResultMetricFormState;
};

type OutputGenerationDraftState = ExperimentOutputGenerationDraft & {
  error?: string;
};

type ExperimentFilterSnapshot = {
  keyword: string;
  projectId: string;
  routeId: string;
  taskId?: string;
  status: string;
  tags: string;
  timeRange: string;
};

type LoadExperimentsOptions = {
  filters?: ExperimentFilterSnapshot;
  preferredExperimentId?: string | null;
  preferredRunId?: string | null;
  preserveSelection?: boolean;
  autoSelectFirstRun?: boolean;
  requestId?: number;
  setLoading?: boolean;
};

type LoadExperimentContextOptions = {
  preferredRunId?: string | null;
  autoSelectFirstRun?: boolean;
};

type AuditedExperimentDeleteInput = {
  preview: OperationImpactPreview;
  entityType: "experiment" | "experimentRun" | "resultMetric" | "fileRef";
  entityId: string;
  title: string;
  recycleSummary: string;
  refreshKeys: RefreshKey[];
  deleteAction: () => Promise<boolean | ExperimentRunLifecycleMutationResult>;
  successMessage: string;
  skippedMessage: string;
};

type ExperimentReferenceData = {
  projects: Project[];
  routes: RouteNode[];
  tasks: Task[];
};

const emptyExperimentForm: ExperimentFormState = {
  projectId: "",
  routeId: "",
  taskId: "",
  title: "",
  purposeAndQuestion: "",
  conditionSummary: "",
  methodSummary: "",
  resultSummary: "",
  conclusionAndNextSteps: "",
  status: "planned",
  rating: "",
  tags: "",
  other: "",
  usableForPaper: false,
  usableForReport: false,
  usableForPatent: false,
  dataPath: "",
  researchTraceDisplayChecked: false
};

const emptyRunForm: RunFormState = {
  title: "",
  runLabel: "",
  status: "planned",
  rating: "",
  conditionSummary: "",
  variableParameterSummary: "",
  methodSummary: "",
  resultSummary: "",
  conclusion: "",
  summaryOther: "",
  tags: "",
  researchTraceDisplayChecked: false
};

const emptyFileRefForm: FileRefFormState = {
  fileType: "other",
  path: "",
  title: "",
  description: ""
};

const emptyResultMetricForm: ResultMetricFormState = {
  name: "",
  value: "",
  unit: "",
  metricGroup: "",
  description: "",
  valueType: "text",
  isKeyResult: false
};

function resultMetricToForm(metric: ResultMetric): ResultMetricFormState {
  return {
    name: metric.name,
    value: String(metric.value),
    unit: metric.unit ?? "",
    metricGroup: metric.metricGroup ?? "",
    description: metric.description ?? "",
    valueType: metric.valueType ?? (typeof metric.value === "number" ? "number" : "text"),
    isKeyResult: isResultMetricKeyResult(metric)
  };
}

function splitTags(tags: string) {
  return tags
    .split(/[，,]/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function joinTags(tags?: string[]) {
  return tags?.join(", ") ?? "";
}

function getExperimentPurposeAndQuestion(experiment: Pick<Experiment, "purposeAndQuestion">) {
  return experiment.purposeAndQuestion?.trim() ?? "";
}

function text(value: unknown, fallback: string) {
  return value === undefined || value === null || value === "" ? fallback : String(value);
}

function matchesTimeRange(value: string | undefined, range: string) {
  if (!range || !value) {
    return true;
  }

  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    return true;
  }

  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  if (range === "today") {
    return now - timestamp <= day;
  }
  if (range === "week") {
    return now - timestamp <= day * 7;
  }
  if (range === "month") {
    return now - timestamp <= day * 30;
  }
  return true;
}

function experimentToForm(experiment: Experiment): ExperimentFormState {
  return {
    projectId: experiment.projectId,
    routeId: experiment.routeId ?? "",
    taskId: experiment.taskId ?? "",
    title: experiment.title,
    purposeAndQuestion: experiment.purposeAndQuestion ?? "",
    conditionSummary: experiment.conditionSummary ?? "",
    methodSummary: experiment.methodSummary ?? "",
    resultSummary: experiment.resultSummary,
    conclusionAndNextSteps: experiment.conclusionAndNextSteps ?? "",
    status: experiment.status,
    rating: experiment.rating ?? "",
    tags: joinTags(experiment.tags),
    other: experiment.other ?? "",
    usableForPaper: experiment.usableForPaper,
    usableForReport: experiment.usableForReport,
    usableForPatent: experiment.usableForPatent,
    dataPath: experiment.dataPath ?? "",
    researchTraceDisplayChecked: false
  };
}

function fileRefToForm(fileRef: FileRef): FileRefFormState {
  return {
    fileType: fileRef.fileType || "other",
    path: fileRef.path,
    title: fileRef.title,
    description: fileRef.description ?? ""
  };
}

function fileRefOpenKind(fileRef: FileRef): LocalFileOpenKind {
  return fileRefService.resolveFileRefOpenKind(fileRef.fileType, fileRef.path);
}

function fileTypeFromPathSelection(result: LocalFileResult) {
  return result.actionType === "select_folder" ? "data_folder" : "other";
}

function runToForm(run: ExperimentRun): RunFormState {
  return {
    title: run.title,
    runLabel: run.runLabel ?? "",
    status: run.status,
    rating: run.rating ?? "",
    conditionSummary: run.conditionSummary ?? "",
    variableParameterSummary: run.variableParameterSummary ?? "",
    methodSummary: run.methodSummary ?? "",
    resultSummary: run.resultSummary ?? "",
    conclusion: run.conclusion ?? "",
    summaryOther: run.summaryOther ?? "",
    tags: joinTags(run.tags),
    researchTraceDisplayChecked: false
  };
}

function taskBelongsToProject(task: Task | undefined, projectId: string) {
  return Boolean(task && (!projectId || task.projectId === projectId));
}

function routeBelongsToProject(route: RouteNode | undefined, projectId: string) {
  return Boolean(route && (!projectId || route.projectId === projectId));
}

function taskBelongsToRoute(task: Task | undefined, routeId: string) {
  return Boolean(task && (!routeId || !task.routeNodeId || task.routeNodeId === routeId));
}

function sanitizeRouteIdForProject(routeId: string, projectId: string, routes: RouteNode[]) {
  const route = routeId ? routes.find((item) => item.id === routeId) : undefined;
  return routeBelongsToProject(route, projectId) ? routeId : "";
}

function sanitizeTaskIdForProjectAndRoute(
  taskId: string,
  projectId: string,
  routeId: string,
  tasks: Task[]
) {
  const task = taskId ? tasks.find((item) => item.id === taskId) : undefined;
  return taskBelongsToProject(task, projectId) && taskBelongsToRoute(task, routeId) ? taskId : "";
}

function hasActiveFilters(filters: ExperimentFilterSnapshot) {
  return Boolean(
    filters.keyword.trim() ||
      filters.projectId ||
      filters.routeId ||
      filters.taskId ||
      filters.status ||
      filters.tags.trim() ||
      filters.timeRange
  );
}

function unknownErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function ExperimentsPage() {
  const { language, t } = useI18n();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const queryProjectId = searchParams.get("projectId");
  const queryTaskId = searchParams.get("taskId");
  const queryExperimentId = searchParams.get("experimentId") || searchParams.get("focus");
  const queryRunId = searchParams.get("runId");
  const queryFocusKey = [
    queryProjectId ?? "",
    queryTaskId ?? "",
    queryExperimentId ?? "",
    queryRunId ?? ""
  ].join("|");
  const ui = (source: string) => nonPlanningUi(language, source);
  const enumLabel = (value: string | undefined) =>
    nonPlanningEnumLabel(language, value, ui("未设置"));
  const displayText = (value: unknown, fallback = ui("未填写")) => text(value, fallback);
  const formatBool = (value: boolean) => ui(value ? "是" : "否");
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [routes, setRoutes] = useState<RouteNode[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedExperimentId, setSelectedExperimentId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [detailContext, setDetailContext] = useState<ExperimentDetailContext | null>(null);
  const [runContext, setRunContext] = useState<ExperimentRunContext | null>(null);
  const experimentSummaryFields = detailContext
    ? [
        {
          key: "purposeAndQuestion",
          label: ui("实验目的与问题"),
          content: getExperimentPurposeAndQuestion(detailContext.experiment)
        },
        {
          key: "conditionSummary",
          label: ui("条件摘要"),
          content: detailContext.experiment.conditionSummary
        },
        {
          key: "methodSummary",
          label: ui("方法摘要"),
          content: detailContext.experiment.methodSummary
        },
        {
          key: "resultSummary",
          label: ui("结果摘要"),
          content: detailContext.experiment.resultSummary
        },
        {
          key: "conclusionAndNextSteps",
          label: ui("结论与下一步"),
          content: detailContext.experiment.conclusionAndNextSteps
        },
        {
          key: "other",
          label: ui("其他"),
          content: detailContext.experiment.other
        }
      ]
    : [];
  const experimentStructuredSummary = detailContext
    ? createExperimentStructuredSummaryDto(detailContext.experiment)
    : null;
  const experimentManuscriptOutlineItems = experimentStructuredSummary
    ? createExperimentStructuredSummaryItems(experimentStructuredSummary, ui)
    : [];
  const runSummaryFields = runContext
    ? [
        {
          key: "conditionSummary",
          label: ui("运行条件摘要"),
          content: runContext.run.conditionSummary
        },
        {
          key: "variableParameterSummary",
          label: ui("变量与参数摘要"),
          content: runContext.run.variableParameterSummary
        },
        {
          key: "methodSummary",
          label: ui("运行方法摘要"),
          content: runContext.run.methodSummary
        },
        {
          key: "resultSummary",
          label: ui("运行结果摘要"),
          content: runContext.run.resultSummary
        },
        {
          key: "conclusion",
          label: ui("结论说明"),
          content: runContext.run.conclusion
        },
        {
          key: "other",
          label: ui("其他"),
          content: runContext.run.summaryOther
        }
      ]
    : [];
  const runManuscriptOutlineItems = runContext
    ? [
        { label: ui("运行条件摘要"), value: runContext.run.conditionSummary?.trim() || ui("未填写") },
        { label: ui("变量与参数摘要"), value: runContext.run.variableParameterSummary?.trim() || ui("未填写") },
        { label: ui("运行方法摘要"), value: runContext.run.methodSummary?.trim() || ui("未填写") },
        { label: ui("运行结果摘要"), value: runContext.run.resultSummary?.trim() || ui("未填写") },
        { label: ui("结论说明"), value: runContext.run.conclusion?.trim() || ui("未填写") },
        { label: ui("其他"), value: runContext.run.summaryOther?.trim() || ui("未填写") }
      ]
    : [];
  const [runMarkdown, setRunMarkdown] = useState("");
  const [experimentForm, setExperimentForm] = useState<ExperimentFormState>(emptyExperimentForm);
  const [runForm, setRunForm] = useState<RunFormState>(emptyRunForm);
  const [
    experimentResearchTraceDisplayCheckedSnapshot,
    setExperimentResearchTraceDisplayCheckedSnapshot
  ] = useState(false);
  const [
    runResearchTraceDisplayCheckedSnapshot,
    setRunResearchTraceDisplayCheckedSnapshot
  ] = useState(false);
  const [fileRefEditor, setFileRefEditor] = useState<FileRefEditorState | null>(null);
  const [isExperimentFileRefPanelOpen, setIsExperimentFileRefPanelOpen] = useState(false);
  const [isRunFileRefPanelOpen, setIsRunFileRefPanelOpen] = useState(false);
  const [resultMetricEditor, setResultMetricEditor] = useState<ResultMetricEditorState | null>(null);
  const [generatedResultItemsByMetricId, setGeneratedResultItemsByMetricId] = useState<
    Record<string, ResultItem>
  >({});
  const [outputGenerationDraft, setOutputGenerationDraft] = useState<OutputGenerationDraftState | null>(null);
  const [isMetricSaving, setIsMetricSaving] = useState(false);
  const [isOutputGenerationPending, setIsOutputGenerationPending] = useState(false);
  const [editingExperimentId, setEditingExperimentId] = useState<string | null>(null);
  const [editingRunId, setEditingRunId] = useState<string | null>(null);
  const [experimentPanelMode, setExperimentPanelMode] = useState<ExperimentPanelMode>("view");
  const [runPanelMode, setRunPanelMode] = useState<RunPanelMode>("view");
  const [keyword, setKeyword] = useState("");
  const [filterProjectId, setFilterProjectId] = useState(
    () => readSharedCurrentProjectSelection() ?? ""
  );
  const [filterRouteId, setFilterRouteId] = useState("");
  const [filterTimeRange, setFilterTimeRange] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [filterTags, setFilterTags] = useState("");
  const [runFilterTimeRange, setRunFilterTimeRange] = useState("");
  const [runFilterStatus, setRunFilterStatus] = useState("");
  const [runKeyword, setRunKeyword] = useState("");
  const [, setMessage] = useState("");
  const [experimentProvisioningIssue, setExperimentProvisioningIssue] =
    useState<ExperimentManuscriptProvisioningIssue | null>(null);
  const [isExperimentProvisioningRecovering, setIsExperimentProvisioningRecovering] =
    useState(false);
  const [hasLoadedPage, setHasLoadedPage] = useState(false);
  const [isPageLoading, setIsPageLoading] = useState(false);
  const [loadErrorMessage, setLoadErrorMessage] = useState("");
  const consumedQueryFocusRef = useRef<string | null>(null);
  const isExperimentPageMountedRef = useRef(false);
  const loadRequestIdRef = useRef(0);
  const detailRequestIdRef = useRef(0);
  const runRequestIdRef = useRef(0);
  const selectedExperimentIdRef = useRef<string | null>(selectedExperimentId);
  selectedExperimentIdRef.current = selectedExperimentId;
  const previousFilterKeyRef = useRef("");
  const projectSelectionInitializedRef = useRef(false);
  const lastLocationKeyRef = useRef(location.key);
  const feedbackContext = useMemo(() => ({
    page: "experiments",
    projectId: detailContext?.experiment.projectId || filterProjectId || undefined,
    ownerKeys: [
      ...(selectedExperimentId ? [`experiment:${selectedExperimentId}:primary`] : []),
      ...(selectedRunId ? [`experimentRun:${selectedRunId}:primary`] : [])
    ]
  }), [detailContext?.experiment.projectId, filterProjectId, selectedExperimentId, selectedRunId]);
  const feedbackCenter = useWriteFeedbackCenter(feedbackContext);
  const operationConfirm = useOperationConfirm();
  const projectMap = useMemo(
    () => new Map(projects.map((project) => [project.id, project.title])),
    [projects]
  );
  const availableRoutes = useMemo(
    () => routes.filter((route) => !filterProjectId || route.projectId === filterProjectId),
    [filterProjectId, routes]
  );
  const availableExperimentRoutes = useMemo(
    () => routes.filter((route) => !experimentForm.projectId || route.projectId === experimentForm.projectId),
    [experimentForm.projectId, routes]
  );
  const availableTasks = useMemo(
    () =>
      tasks.filter(
        (task) =>
          (!experimentForm.projectId || task.projectId === experimentForm.projectId) &&
          taskBelongsToRoute(task, experimentForm.routeId)
      ),
    [experimentForm.projectId, experimentForm.routeId, tasks]
  );
  const activeFilterSnapshot: ExperimentFilterSnapshot = {
    keyword,
    projectId: filterProjectId,
    routeId: filterRouteId,
    status: filterStatus,
    tags: filterTags,
    timeRange: filterTimeRange
  };
  const activeFilterKey = [
    keyword,
    filterProjectId,
    filterRouteId,
    filterStatus,
    filterTags,
    filterTimeRange
  ].join("|");
  const activeFiltersEnabled = hasActiveFilters(activeFilterSnapshot);
  const experimentEmptyMessage = loadErrorMessage
    ? ui("实验列表加载失败，请稍后重试。")
    : !hasLoadedPage
      ? ui("正在加载实验记录。")
      : filterProjectId && !keyword.trim() && !filterRouteId && !filterStatus && !filterTags.trim() && !filterTimeRange
        ? ui("当前课题下暂无实验。")
        : activeFiltersEnabled
          ? ui("当前筛选下暂无实验。")
          : t("experimentEmpty");

  function showPageFeedback(
    severity: "success" | "warning" | "error" | "info",
    title: string,
    operation?: string,
    dedupeKey?: string,
    scope?: WriteFeedbackDisplayScope
  ) {
    setMessage(title);
    feedbackCenter.pushPageFeedback({ severity, title, operation, dedupeKey, scope });
  }

  function experimentProvisioningFeedbackKey(ownerId: string) {
    return `experiment:${ownerId}:manuscript-incomplete`;
  }

  function experimentProvisioningIssueSummary(issue: ExperimentManuscriptProvisioningIssue) {
    if (issue.causeCode === "PATH_TOO_LONG") {
      return ui("当前文稿根目录与课题目录组合超过安全路径预算。请调整正式文稿根目录或课题命名策略。");
    }
    return ui("文稿工作区仍未完成，请查看错误分类后重试。");
  }

  function experimentOwnerFeedbackScope(ownerId: string): WriteFeedbackDisplayScope {
    return {
      classification: "owner",
      page: "experiments",
      projectId:
        experiments.find((experiment) => experiment.id === ownerId)?.projectId ??
        detailContext?.experiment.projectId,
      ownerType: "experiment",
      ownerId
    };
  }

  function pushExperimentProvisioningIssueFeedback(
    issue: ExperimentManuscriptProvisioningIssue,
    operation: string,
    dedupeKey = experimentProvisioningFeedbackKey(issue.ownerId)
  ) {
    feedbackCenter.pushPageFeedback({
      severity: issue.retryable ? "warning" : "error",
      title: issue.causeCode === "PATH_TOO_LONG"
        ? ui("路径配置无法创建文稿工作区")
        : ui("文稿工作区尚未建立"),
      summary: experimentProvisioningIssueSummary(issue),
      operation,
      operationLabel: ui("文稿工作区"),
      dedupeKey,
      scope: experimentOwnerFeedbackScope(issue.ownerId),
      details: [
        `${ui("阶段")}: ${issue.stage}`,
        `${ui("错误分类")}: ${issue.code}`,
        ...(issue.causeCode ? [`${ui("原因")}: ${issue.causeCode}`] : []),
        `${ui("元数据类型")}: ${issue.metadataKind}`,
        `${ui("操作号")}: ${issue.operationId}`,
        `${ui("恢复建议")}: ${issue.recoverability}`
      ]
    });
  }

  async function recoverSelectedExperimentManuscript() {
    const ownerId = detailContext?.experiment.id;
    if (!ownerId || isExperimentProvisioningRecovering) {
      return;
    }
    setIsExperimentProvisioningRecovering(true);
    setExperimentProvisioningIssue((current) =>
      current?.ownerId === ownerId ? { ...current, requestState: "retrying" } : current
    );
    showPageFeedback(
      "info",
      ui("正在准备文稿工作区…"),
      "experiment.manuscript.recover",
      experimentProvisioningFeedbackKey(ownerId),
      experimentOwnerFeedbackScope(ownerId)
    );
    try {
      const result = await recoverExperimentManuscriptProvisioning(ownerId);
      if (!isExperimentPageMountedRef.current) {
        return;
      }
      if (result.completionState !== "complete") {
        const issue = experimentProvisioningIssueFromResult(ownerId, result);
        setExperimentProvisioningIssue(issue);
        pushExperimentProvisioningIssueFeedback(issue, "experiment.manuscript.recover");
        return;
      }
      if (selectedExperimentIdRef.current !== ownerId) {
        return;
      }
      await loadExperimentContext(ownerId, { autoSelectFirstRun: false });
      feedbackCenter.clearFeedbackByDedupeKey(experimentProvisioningFeedbackKey(ownerId));
      showPageFeedback(
        "success",
        result.status === "skipped" ? ui("文稿工作区已就绪") : ui("文稿工作区准备完成"),
        "experiment.manuscript.recover"
      );
    } catch (error) {
      if (isExperimentPageMountedRef.current) {
        feedbackCenter.consumeWriteError(error, "experiment.manuscript.recover");
      }
    } finally {
      if (isExperimentPageMountedRef.current) {
        setIsExperimentProvisioningRecovering(false);
        setExperimentProvisioningIssue((current) =>
          current?.ownerId === ownerId ? { ...current, requestState: "idle" } : current
        );
      }
    }
  }

  const manuscriptEditor = useExperimentManuscriptEditor({
    experimentId: selectedExperimentId ?? undefined,
    ui,
    ratingLabel: (rating) => enumLabel(rating),
    onFeedback: (severity, title, operation) =>
      showPageFeedback(
        severity,
        title,
        operation,
        undefined,
        selectedExperimentId
          ? experimentOwnerFeedbackScope(selectedExperimentId)
          : undefined
      )
  });
  const runManuscriptEditor = useExperimentRunManuscriptEditor({
    runId: selectedRunId ?? undefined,
    ui,
    onFeedback: (severity, title, operation) =>
      showPageFeedback(
        severity,
        title,
        operation,
        selectedRunId ? `experimentRun:${selectedRunId}:manuscript-feedback` : undefined,
        selectedRunId
          ? {
              classification: "owner",
              page: "experiments",
              projectId: runContext?.run.projectId ?? detailContext?.experiment.projectId,
              ownerType: "experimentRun",
              ownerId: selectedRunId
            }
          : undefined
      ),
    onSwitched: (runId) => loadRunContext(runId)
  });

  useEffect(() => {
    const key = selectedRunId
      ? `experimentRun:${selectedRunId}:manuscript-feedback`
      : undefined;
    return () => {
      if (key) feedbackCenter.clearFeedbackByDedupeKey(key);
    };
  }, [feedbackCenter.clearFeedbackByDedupeKey, selectedRunId]);

  function handleFileRefLocalResult(result: LocalFileResult) {
    const feedback = fileRefService.toFileRefActionFeedback(result);
    if (!feedback) return;
    showPageFeedback(feedback.severity, ui(feedback.message), feedback.operation);
  }

  async function fetchReferenceData(): Promise<ExperimentReferenceData> {
    const [projectRows, routeRows, taskRows] = await Promise.all([
      planningService.queryProjects(),
      planningService.queryRouteNodes(),
      planningService.queryTasks()
    ]);
    return { projects: projectRows, routes: routeRows, tasks: taskRows };
  }

  function applyReferenceData(referenceData: ExperimentReferenceData) {
    const { projects: projectRows, routes: routeRows, tasks: taskRows } = referenceData;
    setProjects(projectRows);
    setRoutes(routeRows);
    setTasks(taskRows);

  }

  async function loadExperiments(options: LoadExperimentsOptions = {}) {
    const requestId = options.requestId ?? loadRequestIdRef.current + 1;
    loadRequestIdRef.current = requestId;
    const shouldSetLoading = options.setLoading !== false;
    if (shouldSetLoading) {
      setIsPageLoading(true);
    }
    setLoadErrorMessage("");

    try {
      const activeFilters = options.filters ?? activeFilterSnapshot;
      const queriedRows = await queryExperiments({
        keyword: activeFilters.keyword.trim() || undefined,
        projectId: activeFilters.projectId || undefined,
        routeId: activeFilters.routeId || undefined,
        taskId: activeFilters.taskId || undefined,
        status: activeFilters.status ? (activeFilters.status as ExperimentStatus) : undefined,
        tags: splitTags(activeFilters.tags)
      });
      const rows = queriedRows.filter((experiment) =>
        matchesTimeRange(experiment.updatedAt ?? experiment.createdAt, activeFilters.timeRange)
      );
      if (!isExperimentPageMountedRef.current || requestId !== loadRequestIdRef.current) {
        return;
      }

      setHasLoadedPage(true);
      setExperiments(rows);

      const preferredExperimentId = options.preferredExperimentId ?? selectedExperimentId;
      if (preferredExperimentId && rows.some((row) => row.id === preferredExperimentId)) {
        setSelectedExperimentId(preferredExperimentId);
        await loadExperimentContext(preferredExperimentId, {
          preferredRunId: options.preferredRunId,
          autoSelectFirstRun: options.autoSelectFirstRun
        });
        return;
      }

      if (options.preserveSelection) {
        if (preferredExperimentId) {
          clearSelection();
        }
        return;
      }

      if (rows.length > 0) {
        await selectExperiment(rows[0].id);
        return;
      }

      clearSelection();
    } catch (error) {
      if (!isExperimentPageMountedRef.current || requestId !== loadRequestIdRef.current) {
        return;
      }
      setHasLoadedPage(true);
      setLoadErrorMessage(unknownErrorMessage(error));
      feedbackCenter.consumeWriteError(error, "experiment.queryExperiments");
    } finally {
      if (
        shouldSetLoading &&
        isExperimentPageMountedRef.current &&
        requestId === loadRequestIdRef.current
      ) {
        setIsPageLoading(false);
      }
    }
  }

  async function loadExperimentContext(
    experimentId: string,
    options: LoadExperimentContextOptions = {}
  ) {
    const requestId = detailRequestIdRef.current + 1;
    detailRequestIdRef.current = requestId;
    const previousExperimentId = detailContext?.experiment.id ?? null;
    try {
      const [context, provisioningInspection] = await Promise.all([
        getExperimentDetailContext(experimentId),
        inspectExperimentManuscriptProvisioning(experimentId)
      ]);
      if (!isExperimentPageMountedRef.current || requestId !== detailRequestIdRef.current) {
        return;
      }

      setDetailContext(context);

      if (context) {
        if (provisioningInspection.status === "incomplete") {
          setExperimentProvisioningIssue(provisioningInspection.issue);
          pushExperimentProvisioningIssueFeedback(
            provisioningInspection.issue,
            "experiment.manuscript.inspectIncomplete"
          );
        } else {
          setExperimentProvisioningIssue((current) =>
            current?.ownerId === context.experiment.id ? null : current
          );
          feedbackCenter.clearFeedbackByDedupeKey(
            experimentProvisioningFeedbackKey(context.experiment.id)
          );
        }
        if (context.experiment.id !== previousExperimentId) {
          setIsExperimentFileRefPanelOpen(false);
        }
        const researchTraceDisplayChecked = await getResearchTraceDisplayChecked({
          projectId: context.experiment.projectId,
          targetType: "experiment",
          targetId: context.experiment.id,
          defaultDisplayed: false
        });
        setExperimentForm((current) =>
          experimentPanelMode === "create" ||
          (experimentPanelMode === "edit" && editingExperimentId === context.experiment.id)
            ? current
            : { ...experimentToForm(context.experiment), researchTraceDisplayChecked }
        );
        setExperimentResearchTraceDisplayCheckedSnapshot(researchTraceDisplayChecked);
        setEditingExperimentId(context.experiment.id);
        const preferredRunId = options.preferredRunId ?? selectedRunId;
        const nextRunId =
          preferredRunId && context.runs.some((run) => run.id === preferredRunId)
            ? preferredRunId
            : options.autoSelectFirstRun === false
              ? null
              : context.runs[0]?.id ?? null;
        if (nextRunId !== selectedRunId) {
          setIsRunFileRefPanelOpen(false);
        }
        setSelectedRunId(nextRunId);
        if (nextRunId) {
          await loadRunContext(nextRunId);
        } else {
          setRunContext(null);
          setRunMarkdown("");
          setRunForm(emptyRunForm);
          setRunResearchTraceDisplayCheckedSnapshot(false);
          setEditingRunId(null);
          setRunPanelMode("view");
          setIsRunFileRefPanelOpen(false);
        }
      } else {
        setIsExperimentFileRefPanelOpen(false);
        clearSelection();
      }
    } catch (error) {
      if (!isExperimentPageMountedRef.current || requestId !== detailRequestIdRef.current) {
        return;
      }
      feedbackCenter.consumeWriteError(error, "experiment.getExperimentDetailContext");
    }
  }

  async function loadRunContext(runId: string) {
    const requestId = runRequestIdRef.current + 1;
    runRequestIdRef.current = requestId;
    try {
      const [context, markdownText] = await Promise.all([
        getExperimentRunContext(runId),
        buildExperimentRunMarkdown(runId)
      ]);
      const generatedItems = context
        ? await experimentOutputGenerationService.getGeneratedResultItemsByMetricIds(
            context.metrics.map((metric) => metric.id)
          )
        : {};
      if (!isExperimentPageMountedRef.current || requestId !== runRequestIdRef.current) {
        return;
      }

      setRunContext(context);
      setGeneratedResultItemsByMetricId(generatedItems);
      setRunMarkdown(context ? markdownText : "");
      if (context) {
        const researchTraceDisplayChecked = context.run.projectId
          ? await getResearchTraceDisplayChecked({
              projectId: context.run.projectId,
              targetType: "experimentRun",
              targetId: context.run.id,
              defaultDisplayed: false
            })
          : false;
        setRunForm({
          ...runToForm(context.run),
          researchTraceDisplayChecked
        });
        setRunResearchTraceDisplayCheckedSnapshot(researchTraceDisplayChecked);
        setEditingRunId(context.run.id);
      } else {
        setSelectedRunId(null);
        setGeneratedResultItemsByMetricId({});
        setRunForm(emptyRunForm);
        setRunResearchTraceDisplayCheckedSnapshot(false);
        setEditingRunId(null);
      }
    } catch (error) {
      if (!isExperimentPageMountedRef.current || requestId !== runRequestIdRef.current) {
        return;
      }
      feedbackCenter.consumeWriteError(error, "experiment.getExperimentRunContext");
    }
  }

  async function selectExperiment(experimentId: string) {
    setSelectedExperimentId(experimentId);
    setFileRefEditor(null);
    setResultMetricEditor(null);
    setOutputGenerationDraft(null);
    setExperimentPanelMode("view");
    setRunPanelMode("view");
    setMessage("");
    await loadExperimentContext(experimentId);
  }

  async function selectRun(runId: string) {
    setSelectedRunId(runId);
    setFileRefEditor(null);
    setIsRunFileRefPanelOpen(false);
    setResultMetricEditor(null);
    setOutputGenerationDraft(null);
    setRunPanelMode("view");
    setMessage("");
    await loadRunContext(runId);
  }

  function clearSelection() {
    setSelectedExperimentId(null);
    setSelectedRunId(null);
    setDetailContext(null);
    setRunContext(null);
    setGeneratedResultItemsByMetricId({});
    setResultMetricEditor(null);
    setOutputGenerationDraft(null);
    setRunMarkdown("");
    setEditingExperimentId(null);
    setEditingRunId(null);
    setExperimentPanelMode("view");
    setRunPanelMode("view");
    setExperimentForm(emptyExperimentForm);
    setRunForm(emptyRunForm);
    setExperimentResearchTraceDisplayCheckedSnapshot(false);
    setRunResearchTraceDisplayCheckedSnapshot(false);
    setFileRefEditor(null);
    setIsExperimentFileRefPanelOpen(false);
    setIsRunFileRefPanelOpen(false);
  }

  async function refreshCurrent() {
    await loadExperiments({
      preferredExperimentId: selectedExperimentId,
      preferredRunId: selectedRunId,
      preserveSelection: true
    });
  }

  async function loadPageData() {
    const requestId = loadRequestIdRef.current + 1;
    loadRequestIdRef.current = requestId;
    setIsPageLoading(true);
    setLoadErrorMessage("");

    try {
      const referenceData = await fetchReferenceData();
      if (!isExperimentPageMountedRef.current || requestId !== loadRequestIdRef.current) {
        return;
      }
      const currentProjectId = activeFilterSnapshot.projectId;
      const preservePageLocalAll =
        projectSelectionInitializedRef.current && !currentProjectId;
      const nextProjectId = preservePageLocalAll
        ? ""
        : referenceData.projects.some((project) => project.id === currentProjectId)
          ? currentProjectId
          : resolveSharedCurrentProjectSelection(referenceData.projects);
      const nextFilters: ExperimentFilterSnapshot = {
        ...activeFilterSnapshot,
        projectId: nextProjectId,
        routeId: nextProjectId === currentProjectId ? activeFilterSnapshot.routeId : ""
      };
      projectSelectionInitializedRef.current = true;
      previousFilterKeyRef.current = [
        nextFilters.keyword,
        nextFilters.projectId,
        nextFilters.routeId,
        nextFilters.status,
        nextFilters.tags,
        nextFilters.timeRange
      ].join("|");
      if (nextProjectId !== currentProjectId) {
        setFilterProjectId(nextProjectId);
        setFilterRouteId("");
      }
      applyReferenceData(referenceData);
      await loadExperiments({
        filters: nextFilters,
        requestId,
        setLoading: false,
        preferredExperimentId: selectedExperimentId,
        preferredRunId: selectedRunId
      });
    } catch (error) {
      if (!isExperimentPageMountedRef.current || requestId !== loadRequestIdRef.current) {
        return;
      }
      setHasLoadedPage(true);
      setLoadErrorMessage(unknownErrorMessage(error));
      feedbackCenter.consumeWriteError(error, "experiment.loadPageData");
    } finally {
      if (isExperimentPageMountedRef.current && requestId === loadRequestIdRef.current) {
        setIsPageLoading(false);
      }
    }
  }

  async function reloadCurrentPage(_event?: RefreshEvent) {
    await loadPageData();
  }

  const refreshByKeys = reloadCurrentPage;

  useRefreshEventReload({
    pageName: "experiments",
    watchedKeys: EXPERIMENTS_REFRESH_KEYS,
    reload: refreshByKeys,
    onRefreshFeedback: feedbackCenter.pushRefreshEventFeedback,
    onReloadError: (error, event) =>
      feedbackCenter.pushReloadErrorFeedback(error, event, "experiments")
  });

  useEffect(() => {
    isExperimentPageMountedRef.current = true;
    previousFilterKeyRef.current = activeFilterKey;
    void loadPageData();
    return () => {
      isExperimentPageMountedRef.current = false;
      loadRequestIdRef.current += 1;
      detailRequestIdRef.current += 1;
      runRequestIdRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!hasLoadedPage || loadErrorMessage) {
      previousFilterKeyRef.current = activeFilterKey;
      return;
    }
    if (previousFilterKeyRef.current === activeFilterKey) {
      return;
    }
    previousFilterKeyRef.current = activeFilterKey;
    void loadExperiments();
  }, [activeFilterKey, hasLoadedPage, loadErrorMessage]);

  useEffect(() => {
    if (location.pathname !== "/experiments" || location.key === lastLocationKeyRef.current) {
      return;
    }
    lastLocationKeyRef.current = location.key;
    void loadPageData();
  }, [location.key, location.pathname]);

  useEffect(() => {
    const hasQueryFocus = Boolean(queryProjectId || queryTaskId || queryExperimentId || queryRunId);
    if (
      !hasQueryFocus ||
      !hasLoadedPage ||
      loadErrorMessage ||
      consumedQueryFocusRef.current === queryFocusKey
    ) {
      return;
    }

    consumedQueryFocusRef.current = queryFocusKey;
    const emptyFocusedFilters = (projectId = "", routeId = ""): ExperimentFilterSnapshot => ({
      keyword: "",
      projectId,
      routeId,
      status: "",
      tags: "",
      timeRange: ""
    });

    async function applyQueryFocus() {
      if (queryRunId) {
        const context = await getExperimentRunContext(queryRunId);
        if (context) {
          const filters = emptyFocusedFilters(context.experiment.projectId, context.route?.id ?? "");
          setKeyword("");
          setFilterProjectId(filters.projectId);
          setFilterRouteId(filters.routeId);
          setFilterStatus("");
          setFilterTags("");
          setFilterTimeRange("");
          setRunFilterTimeRange("");
          setRunFilterStatus("");
          setRunKeyword("");
          await loadExperiments({
            filters,
            preferredExperimentId: context.experiment.id,
            preferredRunId: context.run.id,
            preserveSelection: true,
            autoSelectFirstRun: false
          });
          setMessage(ui("已定位到指定 Run。"));
          return;
        }
        showPageFeedback("info", ui("未找到 query 指定的 Run。"), "experiment.queryFocus");
        return;
      }

      if (queryExperimentId) {
        const context = await getExperimentDetailContext(queryExperimentId);
        if (context) {
          const filters = emptyFocusedFilters(context.experiment.projectId, context.route?.id ?? "");
          setKeyword("");
          setFilterProjectId(filters.projectId);
          setFilterRouteId(filters.routeId);
          setFilterStatus("");
          setFilterTags("");
          setFilterTimeRange("");
          await loadExperiments({
            filters,
            preferredExperimentId: context.experiment.id,
            preserveSelection: true
          });
          setMessage(ui("已定位到指定实验。"));
          return;
        }
        showPageFeedback("info", ui("未找到 query 指定的实验。"), "experiment.queryFocus");
        return;
      }

      if (queryTaskId) {
        const task = tasks.find((item) => item.id === queryTaskId);
        if (task) {
          const taskExperiments = await queryExperiments({ taskId: task.id });
          const filters = emptyFocusedFilters(task.projectId, task.routeNodeId ?? "");
          setKeyword("");
          setFilterProjectId(filters.projectId);
          setFilterRouteId(filters.routeId);
          setFilterStatus("");
          setFilterTags("");
          setFilterTimeRange("");
          await loadExperiments({
            filters,
            preferredExperimentId: taskExperiments[0]?.id,
            preserveSelection: taskExperiments.length === 0
          });
          setMessage(
            taskExperiments.length > 0
              ? ui("已定位到关联任务的实验。")
              : ui("该任务暂无关联实验。")
          );
          return;
        }
        showPageFeedback("info", ui("未找到 query 指定的任务。"), "experiment.queryFocus");
        return;
      }

      if (queryProjectId) {
        const project = projects.find((item) => item.id === queryProjectId);
        if (project) {
          const filters = emptyFocusedFilters(project.id);
          setKeyword("");
          setFilterProjectId(project.id);
          setFilterRouteId("");
          setFilterStatus("");
          setFilterTags("");
          setFilterTimeRange("");
          await loadExperiments({ filters });
          setMessage(ui("已定位到指定课题。"));
          return;
        }
        showPageFeedback("info", ui("未找到 query 指定的课题。"), "experiment.queryFocus");
      }
    }

    void applyQueryFocus().catch((error) => {
      feedbackCenter.consumeWriteError(error, "experiment.queryFocus");
    });
  }, [
    hasLoadedPage,
    loadErrorMessage,
    projects,
    queryExperimentId,
    queryFocusKey,
    queryProjectId,
    queryRunId,
    queryTaskId,
    tasks
  ]);

  function validateExperimentForm(form = experimentForm) {
    const operation = editingExperimentId
      ? "experiment.updateExperiment"
      : "experiment.createExperiment";
    const reject = (message: string) => {
      showPageFeedback("warning", message, "experiment.validate");
      publishFormalBusinessAttemptFailure(operation);
      return false;
    };
    if (!form.projectId || !form.title.trim()) {
      return reject(ui("请先选择课题并填写实验名称。"));
    }

    return true;
  }

  function validateRunForm(
    experimentId: string | null,
    form = runForm
  ): experimentId is string {
    const operation = editingRunId
      ? "experimentRun.updateExperimentRun"
      : "experimentRun.createExperimentRun";
    const reject = (message: string) => {
      showPageFeedback("warning", message, "experimentRun.validate");
      publishFormalBusinessAttemptFailure(operation);
      return false;
    };
    if (!experimentId || !form.title.trim()) {
      return reject(ui("请先选择实验并填写 Run 名称。"));
    }

    if (!detailContext?.experiment || detailContext.experiment.id !== experimentId) {
      return reject(ui("请等待实验详情加载完成后再保存 Run。"));
    }

    return true;
  }

  async function saveExperiment(form: ExperimentFormState) {
    if (!validateExperimentForm(form)) {
      return false;
    }

    const input = {
      projectId: form.projectId,
      routeId: form.routeId || null,
      taskId: form.taskId || null,
      title: form.title.trim(),
      purposeAndQuestion: form.purposeAndQuestion.trim() || undefined,
      conditionSummary: form.conditionSummary.trim() || undefined,
      methodSummary: form.methodSummary.trim() || undefined,
      resultSummary: form.resultSummary.trim(),
      conclusionAndNextSteps: form.conclusionAndNextSteps.trim() || undefined,
      other: form.other.trim() || undefined,
      status: form.status,
      rating: form.rating || undefined,
      tags: splitTags(form.tags),
      usableForPaper: form.usableForPaper,
      usableForReport: form.usableForReport,
      usableForPatent: form.usableForPatent,
      problemNotes: undefined,
      nextAction: undefined,
      dataPath: form.dataPath.trim(),
      customFields:
        editingExperimentId && detailContext?.experiment.id === editingExperimentId
          ? detailContext.experiment.customFields
          : []
    };

    const operation = editingExperimentId ? "experiment.updateExperiment" : "experiment.createExperiment";
    try {
      const saved = editingExperimentId
        ? await experimentService.updateExperiment(editingExperimentId, input)
        : await experimentService.createExperiment(input);

      if (saved) {
        setExperimentProvisioningIssue(null);
        feedbackCenter.clearFeedbackByDedupeKey(
          `experiment:create:${form.projectId}:manuscript-preflight`
        );
        try {
          await saveResearchTraceDisplayPreference({
            projectId: saved.projectId,
            targetType: "experiment",
            targetId: saved.id,
            defaultDisplayed: false,
            checked: form.researchTraceDisplayChecked
          });
        } catch (preferenceError) {
          feedbackCenter.consumeWriteError(
            preferenceError,
            "researchTrace.preference.save"
          );
        }
        const visibleFilters: ExperimentFilterSnapshot = {
          keyword: "",
          projectId: saved.projectId,
          routeId: "",
          status: "",
          tags: "",
          timeRange: ""
        };
        setKeyword("");
        setFilterProjectId(saved.projectId);
        setFilterRouteId("");
        setFilterStatus("");
        setFilterTags("");
        setFilterTimeRange("");
        setSelectedExperimentId(saved.id);
        setEditingExperimentId(saved.id);
        setMessage("");
        try {
          applyReferenceData(await fetchReferenceData());
        } catch (error) {
          feedbackCenter.consumeWriteError(error, "experiment.references.refresh");
        }
        await loadExperiments({
          filters: visibleFilters,
          preferredExperimentId: saved.id,
          preserveSelection: true,
          autoSelectFirstRun: false
        });
        setSelectedExperimentId(saved.id);
        await loadExperimentContext(saved.id, { autoSelectFirstRun: false });
        setExperimentPanelMode("view");
        return true;
      }
      publishFormalBusinessAttemptFailure(operation);
    } catch (error) {
      if (error instanceof ExperimentManuscriptProvisioningPreflightError) {
        publishFormalBusinessAttemptFailure(operation);
        pushExperimentProvisioningIssueFeedback(
          error.issue,
          "experiment.manuscript.createPreflight",
          `experiment:create:${form.projectId}:manuscript-preflight`
        );
        return false;
      }
      if (error instanceof ExperimentManuscriptProvisioningIncompleteError) {
        const retained = error.experiment;
        const issue = experimentProvisioningIssueFromResult(
          retained.id,
          error.provisioningResult
        );
        setExperimentProvisioningIssue(issue);
        setSelectedExperimentId(retained.id);
        setEditingExperimentId(retained.id);
        setExperimentPanelMode("view");
        applyReferenceData(await fetchReferenceData());
        await loadExperiments({
          filters: {
            keyword: "",
            projectId: retained.projectId,
            routeId: "",
            status: "",
            tags: "",
            timeRange: ""
          },
          preferredExperimentId: retained.id,
          preserveSelection: true,
          autoSelectFirstRun: false
        });
        pushExperimentProvisioningIssueFeedback(
          issue,
          "experiment.manuscript.provisioningIncomplete"
        );
        return true;
      }
      feedbackCenter.consumeWriteError(error, operation);
    }
    return false;
  }

  async function submitExperiment(event: FormEvent) {
    event.preventDefault();
    await saveExperiment(experimentForm);
  }

  async function saveRun(form: RunFormState) {
    const experimentId = selectedExperimentId;
    if (!validateRunForm(experimentId, form)) {
      return false;
    }

    const activeExperimentId = experimentId;
    const input = {
      title: form.title.trim(),
      runLabel: form.runLabel.trim() || undefined,
      status: form.status,
      rating: form.rating || undefined,
      conditionSummary: form.conditionSummary.trim() || undefined,
      variableParameterSummary: form.variableParameterSummary.trim() || undefined,
      methodSummary: form.methodSummary.trim() || undefined,
      resultSummary: form.resultSummary.trim() || undefined,
      conclusion: form.conclusion.trim() || undefined,
      summaryOther: form.summaryOther.trim() || undefined,
      tags: splitTags(form.tags)
    };

    const operation = editingRunId
      ? "experimentRun.updateExperimentRun"
      : "experimentRun.createExperimentRun";
    try {
      const saved = editingRunId
        ? await experimentRunService.updateExperimentRun(editingRunId, input)
        : await experimentRunService.createExperimentRun({
            ...input,
            experimentId: activeExperimentId
          });

      if (saved) {
        if (saved.projectId) {
          try {
            await saveResearchTraceDisplayPreference({
              projectId: saved.projectId,
              targetType: "experimentRun",
              targetId: saved.id,
              defaultDisplayed: false,
              checked: form.researchTraceDisplayChecked
            });
          } catch (preferenceError) {
            feedbackCenter.consumeWriteError(
              preferenceError,
              "researchTrace.preference.save"
            );
          }
        }
        setRunFilterTimeRange("");
        setRunFilterStatus("");
        setRunKeyword("");
        setSelectedRunId(saved.id);
        setEditingRunId(saved.id);
        setMessage("");
        await loadExperimentContext(activeExperimentId, {
          preferredRunId: saved.id,
          autoSelectFirstRun: false
        });
        setSelectedRunId(saved.id);
        await loadRunContext(saved.id);
        setRunPanelMode("view");
        return true;
      }
      publishFormalBusinessAttemptFailure(operation);
    } catch (error) {
      if (error instanceof ExperimentRunManuscriptProvisioningIncompleteError) {
        const retained = error.run;
        setSelectedRunId(retained.id);
        setEditingRunId(retained.id);
        setRunPanelMode("view");
        await loadExperimentContext(activeExperimentId, {
          preferredRunId: retained.id,
          autoSelectFirstRun: false
        });
        setSelectedRunId(retained.id);
        await loadRunContext(retained.id);
        feedbackCenter.consumeWriteError(
          error,
          "experimentRun.manuscript.provisioningIncomplete"
        );
        return false;
      }
      feedbackCenter.consumeWriteError(error, operation);
    }
    return false;
  }

  async function submitRun(event: FormEvent) {
    event.preventDefault();
    await saveRun(runForm);
  }

  async function runAuditedSoftDelete(
    input: AuditedExperimentDeleteInput
  ): Promise<boolean> {
    const confirmed = await operationConfirm.requestConfirmation(input.preview);
    if (!confirmed) {
      feedbackCenter.pushWriteFeedback(
        createOperationCancelledFeedback(input.preview, ui("删除操作已取消。"))
      );
      return false;
    }

    const actionResult = await input.deleteAction();
    if (typeof actionResult !== "boolean" && actionResult.status === "error") {
      throw new Error(`${actionResult.error.code}: ${actionResult.error.message}`);
    }
    const deleted = typeof actionResult === "boolean" ? actionResult : actionResult.changed;
    const lifecycleWarnings = typeof actionResult === "boolean"
      ? []
      : actionResult.warnings ?? [];
    const deletedAt = typeof actionResult === "boolean"
      ? new Date().toISOString()
      : actionResult.occurredAt ?? new Date().toISOString();
    let authoritativeOperationLogId = typeof actionResult === "boolean"
      ? undefined
      : actionResult.operationLogId;
    let feedback: WriteFeedbackResult<boolean> = createWriteFeedbackResult({
      status: deleted ? "success" : "skipped",
      operation: input.preview.operationId,
      data: deleted,
      affectedEntities: [
        {
          type: input.entityType,
          id: input.entityId,
          relation: deleted ? "deleted" : "skipped",
          label: input.title
        }
      ],
      affectedScopes: [{ module: "experiment" }],
      refreshKeys: [
        ...input.refreshKeys,
        "operationLog.changed",
        "recycleBin.changed",
        "reviewContext.changed",
        "aiContext.changed"
      ],
      skipped: deleted ? [] : ["entity_not_found_or_already_deleted"],
      messages: [
        {
          severity: deleted ? "success" : "warning",
          message: deleted ? input.successMessage : input.skippedMessage
        }
      ]
    });

    for (const warning of lifecycleWarnings) {
      feedback = addWriteFeedbackWarning(
        feedback,
        warning,
        "experiment_lifecycle_companion_warning"
      );
    }

    if (deleted) {
      if (!authoritativeOperationLogId) {
        try {
          const operationLogFeedback = await createOperationLog({
            operationType: "delete",
            source: "user",
            module: "experiment",
            status: feedback.status,
            riskLevel: input.preview.riskLevel,
            target: {
              entityType: input.entityType,
              entityId: input.entityId,
              title: input.title
            },
            summary: input.successMessage,
            relatedEntities: feedback.affectedEntities,
            impactSummary: summarizeImpactPreviewForOperationLog(input.preview),
            confirmation: {
              required: true,
              confirmedByUser: true,
              confirmedAt: deletedAt
            },
            feedback: summarizeFeedbackForOperationLog(feedback),
            isRecoverable: true
          });
          authoritativeOperationLogId = operationLogFeedback.data?.id;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          feedback = addWriteFeedbackWarning(
            feedback,
            `${ui("删除已完成，但操作日志写入失败：")}${message}`,
            "experiment_delete_operation_log_failed"
          );
        }
      }
      try {
        await recordRecycleEntry({
          entityType: input.entityType,
          entityId: input.entityId,
          title: input.title,
          summary: input.recycleSummary,
          module: "experiment",
          deletedAt,
          deletedBy: "user",
          operationLogId: authoritativeOperationLogId,
          canRestore: true,
          restoreStatus: "not_started",
          knownImpactSummary: summarizeImpactPreviewForOperationLog(input.preview),
          refreshKeys: feedback.refreshKeys
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        feedback = addWriteFeedbackWarning(
          feedback,
          `${ui("删除已完成，但回收记录写入失败：")}${message}`,
          "experiment_delete_recycle_entry_failed"
        );
      }
    }

    publishWriteFeedbackRefresh(feedback, {
      source: "service.write",
      reason: `${input.entityType} soft deleted from Experiments page`
    });
    feedbackCenter.pushWriteFeedback(feedback);
    return deleted;
  }

  function buildExperimentDeletePreview(): OperationImpactPreview | null {
    if (!detailContext) return null;
    const experiment = detailContext.experiment;
    const metricCount = Object.values(detailContext.metricsByRunId).reduce(
      (count, metrics) => count + metrics.length,
      0
    );
    return createOperationImpactPreview({
      operationId: "experiment.deleteExperiment.safe",
      operation: "delete",
      target: { type: "experiment", id: experiment.id, title: experiment.title },
      summary: ui("该实验将被移入回收区，并从默认实验列表中隐藏。"),
      riskLevel: "critical",
      executionKind: "soft-delete",
      isRecoverable: true,
      hasRestoreEntry: true,
      requiresUserConfirmation: true,
      canProceed: true,
      deepScanPerformed: false,
      confirmLabel: ui("移入回收区"),
      affectedItems: [
        {
          entityType: "experimentRun",
          title: `${ui("关联 Run")}: ${detailContext.runs.length}`,
          description: ui("Run 元数据不会级联删除，但将不再从该实验详情进入。"),
          severity: "warning"
        },
        {
          entityType: "resultMetric",
          title: `${ui("关联指标")}: ${metricCount}`,
          description: ui("指标和已提升 ResultItem 不会自动删除。"),
          severity: "warning"
        },
        {
          entityType: "fileRef",
          title: `${ui("文件引用")}: ${detailContext.relatedFileRefs.length}`,
          description: ui("文件引用元数据不会级联删除，磁盘真实文件不会被删除。"),
          severity: "warning"
        }
      ],
      warnings: [
        ui("不会永久删除 SciLoom 元数据。"),
        ui("不会删除已提升 ResultItem、Finding 或 OutputCandidate。"),
        ui("不会删除或读取路径指向的本地文件。")
      ]
    });
  }

  function buildRunDeletePreview(): OperationImpactPreview | null {
    if (!runContext) return null;
    const run = runContext.run;
    const generatedCount = runContext.metrics.filter(
      (metric) => Boolean(generatedResultItemsByMetricId[metric.id])
    ).length;
    return createOperationImpactPreview({
      operationId: "experimentRun.deleteExperimentRun.safe",
      operation: "delete",
      target: { type: "experimentRun", id: run.id, title: run.title || run.runLabel || run.id },
      summary: ui("该 Run 将被移入回收区，并从当前实验详情中隐藏。"),
      riskLevel: "high",
      executionKind: "soft-delete",
      isRecoverable: true,
      hasRestoreEntry: true,
      requiresUserConfirmation: true,
      canProceed: true,
      deepScanPerformed: false,
      confirmLabel: ui("移入回收区"),
      affectedItems: [
        {
          entityType: "resultMetric",
          title: `${ui("Run 下指标")}: ${runContext.metrics.length}`,
          description: ui("指标元数据不会级联删除，但将不再从该 Run 详情显示。"),
          severity: "warning"
        },
        {
          entityType: "fileRef",
          title: `${ui("Run 下文件引用")}: ${runContext.fileRefs.length}`,
          description: ui("文件引用元数据不会级联删除，磁盘真实文件不会被删除。"),
          severity: "warning"
        },
        {
          entityType: "resultItem",
          title: `${ui("已生成 ResultItem")}: ${generatedCount}`,
          description: ui("已生成成果项不会自动删除或覆盖。"),
          severity: "warning"
        }
      ],
      warnings: [
        ui("不会永久删除 SciLoom 元数据。"),
        ui("不会删除 Experiment 或已提升成果项。"),
        ui("不会删除或读取路径指向的本地文件。")
      ]
    });
  }

  function buildResultMetricDeletePreview(metric: ResultMetric) {
    const generated = generatedResultItemsByMetricId[metric.id];
    return createOperationImpactPreview({
      operationId: "resultMetric.deleteResultMetric.safe",
      operation: "delete",
      target: { type: "resultMetric", id: metric.id, title: metric.name },
      summary: ui("该指标将被移入回收区，并从当前 Run 指标列表中隐藏。"),
      riskLevel: generated ? "high" : "medium",
      executionKind: "soft-delete",
      isRecoverable: true,
      hasRestoreEntry: true,
      requiresUserConfirmation: true,
      canProceed: true,
      deepScanPerformed: false,
      confirmLabel: ui("移入回收区"),
      affectedItems: generated
        ? [
            {
              entityType: "resultItem",
              entityId: generated.id,
              title: generated.title,
              description: ui("关联 ResultItem 保留，不会自动删除或同步。"),
              severity: "warning"
            }
          ]
        : [],
      warnings: [
        ui("不会永久删除 SciLoom 元数据。"),
        ui("不会删除 EntityLink、Finding 或 OutputCandidate。"),
        ui("不会触发 AI 或成果转化重算。")
      ]
    });
  }

  function buildFileRefDeletePreview(fileRef: FileRef) {
    const title =
      fileRef.title && fileRef.title !== fileRef.path
        ? fileRef.title
        : getFileRefPathName(fileRef.path);
    return createOperationImpactPreview({
      operationId: "fileRef.deleteFileRef.safe",
      operation: "delete",
      target: { type: "fileRef", id: fileRef.id, title },
      summary: ui("仅将 SciLoom 中的文件引用记录移入回收区。"),
      riskLevel: "medium",
      executionKind: "soft-delete",
      isRecoverable: true,
      hasRestoreEntry: true,
      requiresUserConfirmation: true,
      canProceed: true,
      deepScanPerformed: false,
      confirmLabel: ui("移入回收区"),
      affectedItems: [
        {
          entityType: fileRef.ownerType,
          entityId: fileRef.ownerId,
          title: ui("所属实验记录将失去该路径引用"),
          severity: "info"
        }
      ],
      warnings: [
        ui("不会删除或移动磁盘上的真实文件。"),
        ui("不会读取文件内容，也不会上传文件。"),
        ui("不会永久删除 SciLoom 元数据。")
      ]
    });
  }

  async function deleteCurrentExperiment() {
    const preview = buildExperimentDeletePreview();
    if (!preview || !detailContext) return;
    const experiment = detailContext.experiment;
    try {
      const deleted = await runAuditedSoftDelete({
        preview,
        entityType: "experiment",
        entityId: experiment.id,
        title: experiment.title,
        recycleSummary: "Experiment metadata soft-deleted from the Experiments page.",
        refreshKeys: ["experiment.changed", "experimentRun.changed", "resultMetric.changed", "fileRef.changed"],
        deleteAction: () =>
          experimentRunLifecycleService.softDeleteExperimentMetadata(experiment.id),
        successMessage: ui("实验已移入回收区。"),
        skippedMessage: ui("实验不存在或已被删除。")
      });
      if (!deleted) return;
      clearSelection();
      await loadExperiments({
        filters: activeFilterSnapshot,
        preferredExperimentId: "",
        preferredRunId: "",
        preserveSelection: false
      });
    } catch (error) {
      feedbackCenter.consumeWriteError(error, preview.operationId);
    }
  }

  async function deleteCurrentRun() {
    const preview = buildRunDeletePreview();
    if (!preview || !runContext) return;
    const run = runContext.run;
    const experimentId = runContext.experiment.id;
    try {
      const deleted = await runAuditedSoftDelete({
        preview,
        entityType: "experimentRun",
        entityId: run.id,
        title: run.title || run.runLabel || run.id,
        recycleSummary: `ExperimentRun metadata for experiment ${experimentId} was soft-deleted.`,
        refreshKeys: ["experimentRun.changed", "experiment.changed", "resultMetric.changed", "fileRef.changed"],
        deleteAction: () =>
          experimentRunLifecycleService.softDeleteExperimentRunMetadata(run.id),
        successMessage: ui("Run 已移入回收区。"),
        skippedMessage: ui("Run 不存在或已被删除。")
      });
      if (!deleted) return;
      setSelectedRunId(null);
      setRunContext(null);
      setEditingRunId(null);
      setRunPanelMode("view");
      setGeneratedResultItemsByMetricId({});
      setResultMetricEditor(null);
      setFileRefEditor(null);
      setIsRunFileRefPanelOpen(false);
      await loadExperimentContext(experimentId, {
        preferredRunId: "",
        autoSelectFirstRun: false
      });
    } catch (error) {
      feedbackCenter.consumeWriteError(error, preview.operationId);
    }
  }

  async function deleteResultMetric(metric: ResultMetric) {
    const preview = buildResultMetricDeletePreview(metric);
    const activeRun = runContext;
    if (!activeRun) return;
    try {
      const deleted = await runAuditedSoftDelete({
        preview,
        entityType: "resultMetric",
        entityId: metric.id,
        title: metric.name,
        recycleSummary: `ResultMetric metadata for Run ${metric.runId} was soft-deleted.`,
        refreshKeys: ["resultMetric.changed", "experimentRun.changed", "experiment.changed"],
        deleteAction: () => resultMetricService.deleteResultMetric(metric.id),
        successMessage: ui("指标已移入回收区。"),
        skippedMessage: ui("指标不存在或已被删除。")
      });
      if (!deleted) return;
      if (resultMetricEditor?.metricId === metric.id) {
        setResultMetricEditor(null);
      }
      await reloadCurrentMetricContext(activeRun.run.id, activeRun.experiment.id);
    } catch (error) {
      feedbackCenter.consumeWriteError(error, preview.operationId);
    }
  }

  async function deleteFileRef(fileRef: FileRef) {
    const preview = buildFileRefDeletePreview(fileRef);
    const experimentId =
      detailContext?.experiment.id ??
      (fileRef.ownerType === "experiment" ? fileRef.ownerId : undefined);
    if (!experimentId) return;
    try {
      if (!(await operationConfirm.requestConfirmation(preview))) return;
      const feedback = await fileRefService.deleteFileRefWithAudit({
        id: fileRef.id,
        title: preview.target.title,
        summary: `FileRef metadata for ${fileRef.ownerType}/${fileRef.ownerId} was soft-deleted. No local file was read, moved, or deleted.`,
        impactSummary: preview,
        refreshKeys: ["fileRef.changed", "experiment.changed", "experimentRun.changed"]
      });
      feedbackCenter.consumeWriteResult(feedback, {
        operation: preview.operationId,
        successMessage: ui("文件引用已移入回收区，磁盘文件未被删除。"),
        skippedMessage: ui("文件引用不存在或已被删除。")
      });
      const deleted = feedback.status === "success" && feedback.data === true;
      if (!deleted) return;
      if (fileRefEditor?.fileRefId === fileRef.id) {
        setFileRefEditor(null);
      }
      await loadExperimentContext(experimentId, {
        preferredRunId:
          fileRef.ownerType === "experimentRun" ? fileRef.ownerId : selectedRunId,
        autoSelectFirstRun: false
      });
    } catch (error) {
      feedbackCenter.consumeWriteError(error, preview.operationId);
    }
  }

  function startCreateResultMetric() {
    if (!runContext) {
      showPageFeedback("warning", ui("请先选择 Run。"), "resultMetric.create");
      return;
    }
    setResultMetricEditor({ metricId: null, form: emptyResultMetricForm });
  }

  function startEditResultMetric(metric: ResultMetric) {
    setResultMetricEditor({ metricId: metric.id, form: resultMetricToForm(metric) });
  }

  async function reloadCurrentMetricContext(runId: string, experimentId: string) {
    await loadExperimentContext(experimentId, {
      preferredRunId: runId,
      autoSelectFirstRun: false
    });
  }

  async function submitResultMetric(event: FormEvent) {
    event.preventDefault();
    if (!resultMetricEditor || !runContext) {
      return;
    }
    const form = resultMetricEditor.form;
    if (!form.name.trim()) {
      showPageFeedback("warning", ui("指标名称不能为空。"), "resultMetric.validate");
      return;
    }

    let value: string | number = form.value;
    if (form.valueType === "number" || form.valueType === "percentage") {
      const numericValue = Number(form.value);
      if (form.value.trim() && !Number.isFinite(numericValue)) {
        showPageFeedback("warning", ui("请输入有效的数值。"), "resultMetric.validate");
        return;
      }
      value = form.value.trim() ? numericValue : "";
    }

    const operation = resultMetricEditor.metricId
      ? "resultMetric.updateResultMetric"
      : "resultMetric.createResultMetric";
    const existing = resultMetricEditor.metricId
      ? runContext.metrics.find((metric) => metric.id === resultMetricEditor.metricId)
      : undefined;

    setIsMetricSaving(true);
    try {
      const commonInput = {
        name: form.name.trim(),
        value,
        unit: form.unit.trim() || undefined,
        metricGroup: form.metricGroup.trim() || undefined,
        description: form.description.trim() || undefined,
        valueType: form.valueType,
        customFields: withResultMetricKeyResult(existing?.customFields, form.isKeyResult)
      };
      const saved = resultMetricEditor.metricId
        ? await resultMetricService.updateResultMetric(resultMetricEditor.metricId, commonInput)
        : await resultMetricService.createResultMetric({
            ...commonInput,
            runId: runContext.run.id,
            experimentId: runContext.experiment.id
          });

      if (!saved) {
        showPageFeedback("error", ui("指标保存失败。"), operation);
        return;
      }
      const wasEditing = Boolean(resultMetricEditor.metricId);
      setResultMetricEditor(null);
      await reloadCurrentMetricContext(runContext.run.id, runContext.experiment.id);
      showPageFeedback(
        "success",
        wasEditing ? ui("指标已更新。") : ui("指标已添加。"),
        operation
      );
    } catch (error) {
      feedbackCenter.consumeWriteError(error, operation);
      showPageFeedback("error", ui("指标保存失败。"), operation);
    } finally {
      setIsMetricSaving(false);
    }
  }

  async function toggleResultMetricKeyResult(metric: ResultMetric) {
    const nextValue = !isResultMetricKeyResult(metric);
    const operation = "resultMetric.setKeyResult";
    try {
      await resultMetricService.setResultMetricKeyResult(metric.id, nextValue);
      if (runContext) {
        await reloadCurrentMetricContext(runContext.run.id, runContext.experiment.id);
      }
      showPageFeedback(
        "success",
        nextValue ? ui("已标记为关键结果。") : ui("已取消关键结果标记。"),
        operation
      );
    } catch (error) {
      feedbackCenter.consumeWriteError(error, operation);
      showPageFeedback("error", ui("关键结果状态更新失败。"), operation);
    }
  }

  async function openExperimentOutputGeneration() {
    if (!detailContext) {
      showPageFeedback("warning", t("experimentGenerateResultInvalidSource"), "experimentOutputGeneration.open");
      return;
    }
    try {
      const draft = await experimentOutputGenerationService.buildExperimentResultItemDraft(
        detailContext.experiment.id
      );
      setOutputGenerationDraft(draft);
    } catch (error) {
      feedbackCenter.consumeWriteError(error, "experimentOutputGeneration.buildExperimentDraft");
      showPageFeedback("error", t("experimentGenerateResultFailed"), "experimentOutputGeneration.buildExperimentDraft");
    }
  }

  async function openRunOutputGeneration() {
    if (!runContext) {
      showPageFeedback("warning", t("experimentGenerateResultInvalidSource"), "experimentOutputGeneration.open");
      return;
    }
    try {
      const draft = await experimentOutputGenerationService.buildRunResultItemDraft(runContext.run.id);
      setOutputGenerationDraft(draft);
    } catch (error) {
      feedbackCenter.consumeWriteError(error, "experimentOutputGeneration.buildRunDraft");
      showPageFeedback("error", t("experimentGenerateResultFailed"), "experimentOutputGeneration.buildRunDraft");
    }
  }

  async function openMetricOutputGeneration(metric: ResultMetric) {
    try {
      const draft = await experimentOutputGenerationService.buildMetricResultItemDraft(metric.id);
      setOutputGenerationDraft(draft);
    } catch (error) {
      feedbackCenter.consumeWriteError(error, "experimentOutputGeneration.buildMetricDraft");
      showPageFeedback("error", t("experimentGenerateResultInvalidSource"), "experimentOutputGeneration.buildMetricDraft");
    }
  }

  async function submitOutputGeneration(event: FormEvent) {
    event.preventDefault();
    const draft = outputGenerationDraft;
    if (!draft || isOutputGenerationPending) {
      return;
    }
    setIsOutputGenerationPending(true);
    setOutputGenerationDraft({ ...draft, error: undefined });
    try {
      const input = {
        confirmedByUser: true,
        resultItemTitle: draft.resultItemTitle,
        summary: draft.summary,
        sourceNote: draft.sourceNote,
        resultType: draft.resultType
      };
      const result =
        draft.trigger === "experiment"
          ? await experimentOutputGenerationService.createResultItemFromExperiment(
              draft.triggerId,
              input
            )
          : draft.trigger === "experimentRun"
            ? await experimentOutputGenerationService.createResultItemFromExperimentRun(
                draft.triggerId,
                input
              )
            : await experimentOutputGenerationService.createResultItemFromResultMetric(
                draft.triggerId,
                input
              );

      setOutputGenerationDraft(null);
      if (runContext) {
        await reloadCurrentMetricContext(runContext.run.id, runContext.experiment.id);
      } else if (detailContext) {
        await loadExperimentContext(detailContext.experiment.id, {
          preferredRunId: selectedRunId,
          autoSelectFirstRun: false
        });
      }
      showPageFeedback(
        "success",
        `${t("experimentGenerateResultSuccess")} ${result.resultItem.title}`,
        "experimentOutputGeneration.createResultItem"
      );
    } catch (error) {
      const message = unknownErrorMessage(error) || t("experimentGenerateResultFailed");
      feedbackCenter.consumeWriteError(error, "experimentOutputGeneration.createResultItem");
      setOutputGenerationDraft({ ...draft, error: message });
      showPageFeedback("error", t("experimentGenerateResultFailed"), "experimentOutputGeneration.createResultItem");
    } finally {
      setIsOutputGenerationPending(false);
    }
  }

  function startCreateFileRef(ownerType: FileRefOwnerType) {
    if (ownerType === "experiment") {
      setIsExperimentFileRefPanelOpen(true);
    }
    if (ownerType === "experimentRun") {
      setIsRunFileRefPanelOpen(true);
    }
    setFileRefEditor({
      ownerType,
      fileRefId: null,
      form: emptyFileRefForm
    });
  }

  function startEditFileRef(fileRef: FileRef) {
    if (fileRef.ownerType === "experiment") {
      setIsExperimentFileRefPanelOpen(true);
    }
    if (fileRef.ownerType === "experimentRun") {
      setIsRunFileRefPanelOpen(true);
    }
    setFileRefEditor({
      ownerType: fileRef.ownerType,
      fileRefId: fileRef.id,
      form: fileRefToForm(fileRef)
    });
  }

  async function submitFileRef(event: FormEvent, ownerType: FileRefOwnerType) {
    event.preventDefault();
    if (!fileRefEditor || fileRefEditor.ownerType !== ownerType) {
      return;
    }

    const path = fileRefEditor.form.path.trim();
    const fileType = fileRefEditor.form.fileType || "other";
    if (!path) {
      showPageFeedback(
        "warning",
        ui("请填写路径。"),
        "fileRef.validate"
      );
      return;
    }

    const experimentId = detailContext?.experiment.id;
    const runId = ownerType === "experimentRun" ? runContext?.run.id : null;
    const ownerId = ownerType === "experiment" ? experimentId : runId;
    if (!experimentId || !ownerId) {
      showPageFeedback(
        "warning",
        ui("请先选择有效的实验或 Run。"),
        "fileRef.validate"
      );
      return;
    }

    const operation = fileRefEditor.fileRefId
      ? "fileRef.updateFileRef"
      : "fileRef.registerFileRef";
    const values = {
      fileType,
      path,
      title: fileRefEditor.form.title.trim() || getFileRefPathName(path),
      description: fileRefEditor.form.description.trim() || undefined
    };

    try {
      const saved = fileRefEditor.fileRefId
        ? (
            await fileRefService.replaceFileRefPath(fileRefEditor.fileRefId, values)
          ).fileRef
        : (
            await fileRefService.registerFileRef({
              ownerType,
              ownerId,
              ...values
            })
          ).fileRef;
      if (!saved) {
        showPageFeedback("error", ui("路径记录保存失败。"), operation);
        return;
      }

      setFileRefEditor(null);
      await loadExperimentContext(experimentId, {
        preferredRunId: runId ?? selectedRunId,
        autoSelectFirstRun: false
      });
    } catch (error) {
      feedbackCenter.consumeWriteError(error, operation);
    }
  }

  function startCreateExperiment() {
    const projectId = filterProjectId || projects[0]?.id || "";
    const routeId = sanitizeRouteIdForProject(filterRouteId, projectId, routes);
    setEditingExperimentId(null);
    setExperimentPanelMode("create");
    setExperimentForm({
      ...emptyExperimentForm,
      projectId,
      routeId,
      taskId: ""
    });
    setMessage(ui("正在新建实验。"));
  }

  function startCreateRun() {
    if (!selectedExperimentId) {
      showPageFeedback("warning", t("selectExperimentBeforeRun"), "experimentRun.create");
      return;
    }
    setEditingRunId(null);
    setRunPanelMode("create");
    setRunForm(emptyRunForm);
    setMessage(ui("正在新建 Run。"));
  }

  function startEditExperiment() {
    if (!detailContext) {
      return;
    }
    setEditingExperimentId(detailContext.experiment.id);
    setExperimentForm({
      ...experimentToForm(detailContext.experiment),
      researchTraceDisplayChecked: experimentResearchTraceDisplayCheckedSnapshot
    });
    setExperimentPanelMode("edit");
  }

  function startEditRun() {
    if (!runContext) {
      return;
    }
    setEditingRunId(runContext.run.id);
    setRunForm({
      ...runToForm(runContext.run),
      researchTraceDisplayChecked: runResearchTraceDisplayCheckedSnapshot
    });
    setRunPanelMode("edit");
  }

  function cancelExperimentPanel() {
    if (detailContext) {
      setExperimentForm({
        ...experimentToForm(detailContext.experiment),
        researchTraceDisplayChecked: experimentResearchTraceDisplayCheckedSnapshot
      });
      setEditingExperimentId(detailContext.experiment.id);
    } else {
      setExperimentForm(emptyExperimentForm);
      setEditingExperimentId(null);
    }
    setExperimentPanelMode("view");
  }

  function cancelRunPanel() {
    if (runContext) {
      setRunForm({
        ...runToForm(runContext.run),
        researchTraceDisplayChecked: runResearchTraceDisplayCheckedSnapshot
      });
      setEditingRunId(runContext.run.id);
    } else {
      setRunForm(emptyRunForm);
      setEditingRunId(null);
    }
    setRunPanelMode("view");
  }

  function clearExperimentPanelForm() {
    setExperimentForm((current) => ({
      ...current,
      title: "",
      purposeAndQuestion: "",
      conditionSummary: "",
      methodSummary: "",
      resultSummary: "",
      conclusionAndNextSteps: "",
      rating: "",
      tags: "",
      other: "",
      researchTraceDisplayChecked: false
    }));
  }

  function clearRunPanelForm() {
    setRunForm((current) => ({
      ...current,
      title: "",
      runLabel: "",
      conditionSummary: "",
      variableParameterSummary: "",
      methodSummary: "",
      resultSummary: "",
      conclusion: "",
      summaryOther: "",
      rating: "",
      tags: "",
      researchTraceDisplayChecked: false
    }));
  }

  async function copyRunMarkdown() {
    await navigator.clipboard.writeText(runMarkdown);
    setMessage(ui("Markdown 已复制到剪贴板。"));
  }

  const filteredRuns = useMemo(() => {
    const lowerKeyword = runKeyword.trim().toLowerCase();
    return (detailContext?.runs ?? []).filter((run) => {
      const searchable = [
        run.title,
        run.runLabel,
        run.conditionSummary,
        run.methodSummary,
        run.resultSummary,
        run.conclusion,
        joinTags(run.tags)
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return (
        (!runFilterStatus || run.status === runFilterStatus) &&
        matchesTimeRange(run.completedAt ?? run.startedAt ?? run.updatedAt ?? run.createdAt, runFilterTimeRange) &&
        (!lowerKeyword || searchable.includes(lowerKeyword))
      );
    });
  }, [detailContext?.runs, runFilterStatus, runFilterTimeRange, runKeyword]);

  function renderFileRefPanel(ownerType: FileRefOwnerType, fileRefs: FileRef[]) {
    const editor = fileRefEditor?.ownerType === ownerType ? fileRefEditor : null;
    const isExperimentPanel = ownerType === "experiment";
    const isRunPanel = ownerType === "experimentRun";
    const isPanelOpen = isExperimentPanel
      ? isExperimentFileRefPanelOpen || Boolean(editor)
      : isRunPanel
        ? isRunFileRefPanelOpen || Boolean(editor)
        : true;
    const pathRecords =
      isExperimentPanel && detailContext
        ? partitionExperimentPathRecords(
            fileRefs,
            detailContext.experiment.id,
            detailContext.manuscriptBinding?.defaultFolderFileRefId ?? undefined
          )
        : isRunPanel && runContext
          ? partitionExperimentRunPathRecords(fileRefs, runContext.run.id)
          : { workspaceFolder: undefined, attachmentFileRefs: fileRefs };
    const togglePanel = () => {
      if (isExperimentPanel) {
        setIsExperimentFileRefPanelOpen((current) => !current);
      }
      if (isRunPanel) {
        setIsRunFileRefPanelOpen((current) => !current);
      }
    };
    return (
      <div className="file-ref-panel">
        <div className="file-ref-panel-header">
          {isExperimentPanel || isRunPanel ? (
            <button
              type="button"
              className="file-ref-panel-toggle"
              aria-expanded={isPanelOpen}
              onClick={togglePanel}
            >
              <span className="file-ref-panel-toggle-icon" aria-hidden="true">
                {isPanelOpen ? "v" : ">"}
              </span>
              <span>{ui("路径记录")}</span>
            </button>
          ) : (
            <div className="file-ref-panel-title">
              <h4>{ui("路径记录")}</h4>
            </div>
          )}
          {!editor && (
            <button type="button" onClick={() => startCreateFileRef(ownerType)}>
              {ui("添加路径记录")}
            </button>
          )}
        </div>

        {isPanelOpen && (
          <>
            <div
              className={`file-ref-list${isExperimentPanel ? " experiment-path-record-list" : ""}`}
            >
              {pathRecords.workspaceFolder ? (
                <article className="file-ref-item experiment-workspace-path-card">
                  <div className="file-ref-item-heading">
                    <strong>{ui("工作目录")}</strong>
                    <span title={pathRecords.workspaceFolder.path}>
                      <strong>{ui("路径摘要")}：</strong>
                      {summarizeFileRefPath(pathRecords.workspaceFolder.path)}
                    </span>
                  </div>
                  <div className="file-ref-item-actions">
                    <FileRefPathActions
                      path={pathRecords.workspaceFolder.path}
                      resourceKind="folder"
                      openKind="folder"
                      labels={{
                        open: ui("打开"),
                        reveal: ui("打开文件夹"),
                        copy: ui("复制文件夹路径")
                      }}
                      onResult={handleFileRefLocalResult}
                    />
                  </div>
                </article>
              ) : null}
              {pathRecords.attachmentFileRefs.map((fileRef) => {
                const displayTitle =
                  fileRef.title && fileRef.title !== fileRef.path
                    ? fileRef.title
                    : getFileRefPathName(fileRef.path);
                return (
                  <article className="file-ref-item" key={fileRef.id}>
                    <div className="file-ref-item-heading">
                      <strong>{displayTitle}</strong>
                      <span>
                        <strong>{ui("路径摘要")}：</strong>
                        {summarizeFileRefPath(fileRef.path)}
                      </span>
                    </div>
                    <div className="file-ref-item-actions">
                      <FileRefPathActions
                        path={fileRef.path}
                        resourceKind={fileRef.resourceKind}
                        openKind={fileRefOpenKind(fileRef)}
                        labels={{
                          open: ui("打开"),
                          reveal:
                            fileRef.resourceKind === "folder"
                              ? ui("打开文件夹")
                              : ui("打开所在文件夹"),
                          copy:
                            fileRef.resourceKind === "folder"
                              ? ui("复制文件夹路径")
                              : ui("复制路径")
                        }}
                        onResult={handleFileRefLocalResult}
                      />
                      <button type="button" onClick={() => startEditFileRef(fileRef)}>
                        {ui("编辑路径记录")}
                      </button>
                      <button
                        type="button"
                        className="danger-button"
                        onClick={() => void deleteFileRef(fileRef)}
                      >
                        {ui("删除路径记录")}
                      </button>
                    </div>
                  </article>
                );
              })}
              {!pathRecords.workspaceFolder && pathRecords.attachmentFileRefs.length === 0 && (
                <p>{ui("暂无文件路径引用。")}</p>
              )}
            </div>

            {editor && (
              <form
                className="module-form file-ref-editor"
                onSubmit={(event) => void submitFileRef(event, ownerType)}
              >
                <h4>{editor.fileRefId ? ui("编辑路径记录") : ui("添加路径记录")}</h4>
                <label>
                  {ui("标题")}
                  <input
                    value={editor.form.title}
                    onChange={(event) =>
                      setFileRefEditor((current) =>
                        current
                          ? {
                              ...current,
                              form: { ...current.form, title: event.target.value }
                            }
                          : current
                      )
                    }
                    placeholder={ui("可选；留空时使用路径尾部名称")}
                  />
                </label>
                <label>
                  {ui("路径")}
                  <div className="file-ref-path-input-row">
                    <input
                      value={editor.form.path}
                      onChange={(event) =>
                        setFileRefEditor((current) =>
                          current
                            ? {
                                ...current,
                                form: {
                                  ...current.form,
                                  path: event.target.value,
                                  fileType: "other"
                                }
                              }
                            : current
                        )
                      }
                      placeholder={ui("手动输入文件或文件夹路径")}
                    />
                    <FileRefPathPicker
                      labels={{
                        selectFile: ui("选择文件"),
                        selectFolder: ui("选择文件夹")
                      }}
                      onResult={(result) => {
                        if (result.status === "success" && result.path) {
                          setFileRefEditor((current) =>
                            current
                              ? {
                                  ...current,
                                  form: {
                                    ...current.form,
                                    path: result.path ?? current.form.path,
                                    fileType: fileTypeFromPathSelection(result)
                                  }
                                }
                              : current
                          );
                        }
                        handleFileRefLocalResult(result);
                      }}
                    />
                  </div>
                </label>
                <label>
                  {ui("备注")}
                  <textarea
                    rows={2}
                    value={editor.form.description}
                    onChange={(event) =>
                      setFileRefEditor((current) =>
                        current
                          ? {
                              ...current,
                              form: { ...current.form, description: event.target.value }
                            }
                          : current
                      )
                    }
                  />
                </label>
                <div className="button-row">
                  <button type="submit">
                    {editor.fileRefId ? ui("保存路径记录") : ui("添加路径记录")}
                  </button>
                  <button type="button" onClick={() => setFileRefEditor(null)}>
                    {t("cancel")}
                  </button>
                </div>
              </form>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <div className="app-page experiments-page">
      <PageHeader
        title={t("experiments")}
        description={t("experimentsDescription")}
      />
      <section className="experiments-page-feedback-region" aria-label={ui("操作反馈")}>
        <WriteFeedbackPanel
          entries={feedbackCenter.entries}
          onDismiss={feedbackCenter.dismissFeedback}
          presentation="primary-page"
        />
      </section>
      <OperationConfirmDialog
        preview={operationConfirm.preview}
        onConfirm={operationConfirm.confirm}
        onCancel={operationConfirm.cancel}
      />

      <section className="experiments-overview-card">
        <div className="experiments-filter-stack">
          <label className="experiments-project-row project-context-selector">
            <span className="project-context-selector__label">{t("project")}</span>
            <select
              className="project-context-selector__control"
              value={filterProjectId}
              onChange={(event) => {
                const projectId = event.target.value;
                if (projectId) {
                  writeSharedCurrentProjectSelection(projectId);
                }
                setFilterProjectId(projectId);
                setFilterRouteId("");
              }}
            >
              <option value="">{ui("全部课题")}</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.title}
                  </option>
                ))}
              </select>
          </label>

          <div className="experiments-filter-row experiments-secondary-filter-row">
            <label className="experiments-inline-field">
              <span>{t("routeFilter")}</span>
              <select value={filterRouteId} onChange={(event) => setFilterRouteId(event.target.value)}>
                <option value="">{t("allRoutes")}</option>
                {availableRoutes.map((route) => (
                  <option key={route.id} value={route.id}>
                    {route.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="experiments-inline-field">
              <span>{t("timeRange")}</span>
              <select value={filterTimeRange} onChange={(event) => setFilterTimeRange(event.target.value)}>
                <option value="">{t("allTime")}</option>
                <option value="today">{t("today")}</option>
                <option value="week">{t("thisWeek")}</option>
                <option value="month">{t("thisMonth")}</option>
              </select>
            </label>
          </div>

          <div className="experiments-filter-row experiments-tertiary-filter-row">
            <label className="experiments-inline-field">
              <span>{ui("状态")}</span>
            <select value={filterStatus} onChange={(event) => setFilterStatus(event.target.value)}>
              <option value="">{ui("全部状态")}</option>
              {experimentStatuses.map((status) => (
                <option key={status} value={status}>
                  {enumLabel(status)}
                </option>
              ))}
            </select>
            </label>
            <label className="experiments-inline-field">
              <span>{ui("标签")}</span>
              <input
                value={filterTags}
                onChange={(event) => setFilterTags(event.target.value)}
                placeholder={ui("逗号分隔，任一匹配")}
              />
            </label>
            <label className="experiments-inline-field">
              <span>{ui("关键词")}</span>
              <input
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                placeholder={ui("名称、目的、方法、结果、结论")}
              />
            </label>
          </div>
        </div>
      </section>

      <section className="experiments-section">
        <div className="experiments-section-header">
          <h2>{t("experimentListTitle")}</h2>
          <button
            type="button"
            className="primary-page-action primary-page-action--primary"
            onClick={startCreateExperiment}
          >
            {t("newAction")}
          </button>
        </div>

        <div className="experiments-list-detail-layout">
          <div className="experiments-list-column">
            <div className="experiment-list-body">
              {isPageLoading && !hasLoadedPage && (
                <p className="experiment-empty-box">{ui("正在加载实验记录。")}</p>
              )}
              {loadErrorMessage && (
                <p className="experiment-empty-box">{experimentEmptyMessage}</p>
              )}
              {!loadErrorMessage && experiments.map((experiment) => (
                <button
                  className={`experiment-card${selectedExperimentId === experiment.id ? " experiment-card-active" : ""}`}
                  key={experiment.id}
                  type="button"
                  onClick={() => void selectExperiment(experiment.id)}
                >
                  <strong>{experiment.title}</strong>
                  <span>{projectMap.get(experiment.projectId) ?? ui("未关联课题")}</span>
                  <span className="experiment-card-meta">
                    <span>{enumLabel(experiment.status)}</span>
                    {experiment.tags.slice(0, 3).map((tag) => (
                      <span key={tag}>{tag}</span>
                    ))}
                  </span>
                </button>
              ))}
              {!isPageLoading && !loadErrorMessage && experiments.length === 0 && (
                <p className="experiment-empty-box">{experimentEmptyMessage}</p>
              )}
            </div>
          </div>

          <div className="experiments-detail-column">
            <div className="experiments-detail-toolbar">
              <h3>{t("experimentDetailTitle")}</h3>
              {experimentPanelMode === "view" && detailContext && (
                <div className="experiments-detail-actions">
                  <button
                    type="button"
                    className="primary-page-action primary-page-action--secondary"
                    onClick={startEditExperiment}
                  >
                    {t("edit")}
                  </button>
                </div>
              )}
            </div>

            <div className="experiment-detail-shell">
            {experimentPanelMode === "view" && detailContext && (
              <>
                <div className="experiment-detail-summary experiment-intro-card">
                  <strong>{detailContext.experiment.title}</strong>
                  <dl className="experiment-description-list">
                    <div className="experiment-description-row">
                      <dt>{t("project")}</dt>
                      <dd>{displayText(projectMap.get(detailContext.experiment.projectId) ?? detailContext.project?.title, t("unlinkedProject"))}</dd>
                    </div>
                    <div className="experiment-description-row">
                      <dt>{t("linkedRoute")}</dt>
                      <dd>{displayText(detailContext.route?.title, t("unlinkedRoute"))}</dd>
                    </div>
                    <div className="experiment-description-row">
                      <dt>{t("linkedTask")}</dt>
                      <dd>{displayText(detailContext.task?.title, ui("未关联"))}</dd>
                    </div>
                    <div className="experiment-description-row">
                      <dt>{ui("标签")}</dt>
                      <dd>{displayText(joinTags(detailContext.experiment.tags))}</dd>
                    </div>
                    <div className="experiment-description-row">
                      <dt>{ui("当前文稿")}</dt>
                      <dd>
                        {manuscriptEditor.mainCurrentFileName ||
                          manuscriptEditor.currentDescriptorError ||
                          ui("未建立")}
                      </dd>
                    </div>
                  </dl>
                </div>

                {experimentProvisioningIssue?.ownerId === detailContext.experiment.id ? (
                  <ExperimentProvisioningIssueCard
                    issue={experimentProvisioningIssue}
                    language={language}
                    pending={isExperimentProvisioningRecovering}
                    onRecover={() => void recoverSelectedExperimentManuscript()}
                  />
                ) : null}

                <div className="experiment-detail-body experiment-summary-card">
                  <StructuredSummaryDisplay
                    fields={experimentSummaryFields}
                    emptyText={ui("暂无内容")}
                    className="experiment-summary-content"
                  />
                  <div className="experiment-summary-actions">
                    <button type="button" onClick={() => void openExperimentOutputGeneration()}>
                      {t("experimentGenerateResultFromExperiment")}
                    </button>
                    <ExperimentQuickAnalysisButton
                      experimentId={detailContext.experiment.id}
                      projectId={detailContext.experiment.projectId}
                      experimentTitle={detailContext.experiment.title}
                      ui={ui}
                    />
                    <button
                      type="button"
                      disabled={
                        isExperimentProvisioningRecovering ||
                        experimentProvisioningIssue?.ownerId === detailContext.experiment.id
                      }
                      onClick={() => void manuscriptEditor.openCurrent()}
                    >
                      {ui("打开编辑器")}
                    </button>
                  </div>
                </div>

                {renderFileRefPanel("experiment", detailContext.experimentFileRefs)}

              </>
            )}

            {experimentPanelMode === "view" && !detailContext && (
              <p className="experiment-empty-box">{t("selectExperimentHint")}</p>
            )}

            {experimentPanelMode !== "view" && (
              <div className="experiment-form-modal-overlay" role="presentation">
              <form
                className="module-form experiment-maintenance-form experiment-edit-panel experiment-form-modal"
                onSubmit={(event) => void submitExperiment(event)}
                role="dialog"
                aria-modal="true"
                aria-labelledby="experiment-form-modal-title"
              >
                <div className="experiment-form-header">
                  <h4 id="experiment-form-modal-title">
                    {experimentPanelMode === "create" ? t("experimentCreateTitle") : t("experimentEditTitle")}
                  </h4>
                  <button
                    type="button"
                    className="secondary-button experiment-form-close"
                    onClick={cancelExperimentPanel}
                    aria-label={ui("关闭")}
                  >
                    {ui("关闭")}
                  </button>
                </div>

                <section className="experiment-form-section">
                  <h5>{ui("实验基础信息")}</h5>
                  <div className="experiment-form-grid">
                    <label className="experiment-form-field-full">
                      {ui("实验名称")}
                      <input
                        value={experimentForm.title}
                        onChange={(event) =>
                          setExperimentForm((current) => ({ ...current, title: event.target.value }))
                        }
                      />
                    </label>
                    <label>
                      {ui("所属课题")}
                      <select
                        value={experimentForm.projectId}
                        onChange={(event) =>
                          setExperimentForm((current) => {
                            const projectId = event.target.value;
                            const routeId = sanitizeRouteIdForProject(current.routeId, projectId, routes);
                            return {
                              ...current,
                              projectId,
                              routeId,
                              taskId: sanitizeTaskIdForProjectAndRoute(
                                current.taskId,
                                projectId,
                                routeId,
                                tasks
                              )
                            };
                          })
                        }
                      >
                        <option value="">{ui("请选择课题")}</option>
                        {projects.map((project) => (
                          <option key={project.id} value={project.id}>
                            {project.title}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      {ui("状态")}
                      <select
                        value={experimentForm.status}
                        onChange={(event) =>
                          setExperimentForm((current) => ({
                            ...current,
                            status: event.target.value as ExperimentStatus
                          }))
                        }
                      >
                        {experimentStatuses.map((status) => (
                          <option key={status} value={status}>
                            {enumLabel(status)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      {ui("关联路线")}
                      <select
                        value={experimentForm.routeId}
                        onChange={(event) =>
                          setExperimentForm((current) => {
                            const routeId = event.target.value;
                            return {
                              ...current,
                              routeId
                            };
                          })
                        }
                      >
                        <option value="">{ui("不关联路线")}</option>
                        {experimentForm.routeId && !availableExperimentRoutes.some((route) => route.id === experimentForm.routeId) && (
                          <option value={experimentForm.routeId}>{experimentForm.routeId}</option>
                        )}
                        {availableExperimentRoutes.map((route) => (
                          <option key={route.id} value={route.id}>
                            {route.title}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      {ui("关联任务")}
                      <select
                        value={experimentForm.taskId}
                        onChange={(event) =>
                          setExperimentForm((current) => {
                            const taskId = event.target.value;
                            const task = taskId ? tasks.find((item) => item.id === taskId) : undefined;
                            const taskRouteId =
                              task?.routeNodeId &&
                              routeBelongsToProject(
                                routes.find((route) => route.id === task.routeNodeId),
                                current.projectId
                              )
                                ? task.routeNodeId
                                : current.routeId;
                            return { ...current, routeId: taskRouteId, taskId };
                          })
                        }
                      >
                        <option value="">{ui("不关联任务")}</option>
                        {experimentForm.taskId && !availableTasks.some((task) => task.id === experimentForm.taskId) && (
                          <option value={experimentForm.taskId}>{experimentForm.taskId}</option>
                        )}
                        {availableTasks.map((task) => (
                          <option key={task.id} value={task.id}>
                            {task.title}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      {ui("评级")}
                      <select
                        value={experimentForm.rating}
                        onChange={(event) =>
                          setExperimentForm((current) => ({
                            ...current,
                            rating: event.target.value as ExperimentRating | ""
                          }))
                        }
                      >
                        {ratings.map((rating) => (
                          <option key={rating || "empty"} value={rating}>
                            {rating ? enumLabel(rating) : ui("未评级")}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      {ui("标签")}
                      <input
                        value={experimentForm.tags}
                        onChange={(event) =>
                          setExperimentForm((current) => ({ ...current, tags: event.target.value }))
                        }
                        placeholder={ui("逗号分隔")}
                      />
                    </label>
                    <label className="checkbox-row research-trace-preference-row experiment-research-trace-checkbox">
                      <input
                        type="checkbox"
                        checked={experimentForm.researchTraceDisplayChecked}
                        onChange={(event) =>
                          setExperimentForm((current) => ({
                            ...current,
                            researchTraceDisplayChecked: event.target.checked
                          }))
                        }
                      />
                      <span>{ui("显示在课题研究脉络中")}</span>
                    </label>
                  </div>
                </section>

                <section className="experiment-form-section">
                  <h5>{ui("实验摘要")}</h5>
                  <StructuredEditFieldGrid className="experiment-summary-form-fields">
                    <div className="experiment-summary-field" role="group" aria-label={ui("实验目的与问题")}>
                      <span>{ui("实验目的与问题")}</span>
                      <textarea
                        value={experimentForm.purposeAndQuestion}
                        onChange={(event) =>
                          setExperimentForm((current) => ({ ...current, purposeAndQuestion: event.target.value }))
                        }
                        aria-label={ui("实验目的与问题")}
                        placeholder={ui("实验目的与问题")}
                      />
                    </div>
                    <label>
                      {ui("条件摘要")}
                      <textarea
                        value={experimentForm.conditionSummary}
                        onChange={(event) =>
                          setExperimentForm((current) => ({
                            ...current,
                            conditionSummary: event.target.value
                          }))
                        }
                      />
                    </label>
                    <label>
                      {ui("方法摘要")}
                      <textarea
                        value={experimentForm.methodSummary}
                        onChange={(event) =>
                          setExperimentForm((current) => ({
                            ...current,
                            methodSummary: event.target.value
                          }))
                        }
                      />
                    </label>
                    <label>
                      {ui("结果摘要")}
                      <textarea
                        value={experimentForm.resultSummary}
                        onChange={(event) =>
                          setExperimentForm((current) => ({
                            ...current,
                            resultSummary: event.target.value
                          }))
                        }
                      />
                    </label>
                    <label>
                      {ui("结论与下一步")}
                      <textarea
                        value={experimentForm.conclusionAndNextSteps}
                        onChange={(event) =>
                          setExperimentForm((current) => ({ ...current, conclusionAndNextSteps: event.target.value }))
                        }
                      />
                    </label>
                    <label>
                      {ui("其他")}
                      <textarea
                        value={experimentForm.other}
                        onChange={(event) =>
                          setExperimentForm((current) => ({ ...current, other: event.target.value }))
                        }
                      />
                    </label>
                  </StructuredEditFieldGrid>
                </section>

                <DataClearFooterRow
                  className="button-row experiment-form-actions"
                  contextKey={`experiment:${experimentPanelMode}:${editingExperimentId ?? "new"}`}
                  regionLabel={ui("数据清除")}
                  clearLabel={t("clear")}
                  deleteLabel={ui("删除")}
                  onClear={clearExperimentPanelForm}
                  onDelete={
                    experimentPanelMode === "edit" && detailContext
                      ? () => void deleteCurrentExperiment()
                      : undefined
                  }
                >
                  <button type="submit">{t("save")}</button>
                  <button type="button" onClick={cancelExperimentPanel}>
                    {t("cancel")}
                  </button>
                </DataClearFooterRow>
              </form>
              </div>
            )}
            </div>
          </div>
        </div>
      </section>

      <section className="experiments-section runs-section">
        <div className="experiments-section-header">
          <h2>{t("runListTitle")}</h2>
        </div>

        <div className="experiments-list-detail-layout">
          <div className="experiments-list-column">
            <div className="runs-filter-grid">
              <select
                className="compact-list-toolbar-control"
                value={runFilterTimeRange}
                onChange={(event) => setRunFilterTimeRange(event.target.value)}
              >
                <option value="">{t("allTime")}</option>
                <option value="today">{t("today")}</option>
                <option value="week">{t("thisWeek")}</option>
                <option value="month">{t("thisMonth")}</option>
              </select>
              <select
                className="compact-list-toolbar-control"
                value={runFilterStatus}
                onChange={(event) => setRunFilterStatus(event.target.value)}
              >
                <option value="">{ui("全部状态")}</option>
                {runStatuses.map((status) => (
                  <option key={status} value={status}>
                    {enumLabel(status)}
                  </option>
                ))}
              </select>
              <input
                className="compact-list-toolbar-control"
                value={runKeyword}
                onChange={(event) => setRunKeyword(event.target.value)}
                placeholder={t("runKeywordPlaceholder")}
              />
              <button
                type="button"
                className="primary-page-action primary-page-action--primary"
                onClick={startCreateRun}
                disabled={!selectedExperimentId}
                title={!selectedExperimentId ? t("selectExperimentBeforeRun") : undefined}
              >
                {t("newAction")}
              </button>
            </div>
            <div className="run-list-body">
              {!selectedExperimentId && (
                <p className="run-empty-box">{t("selectExperimentBeforeRun")}</p>
              )}

              {selectedExperimentId && filteredRuns.map((run) => (
                <button
                  className={`run-card${selectedRunId === run.id ? " run-card-active" : ""}`}
                  key={run.id}
                  type="button"
                  onClick={() => void selectRun(run.id)}
                >
                  <strong>{run.title || run.runLabel || run.id}</strong>
                  <span>{detailContext?.experiment.title ?? t("noExperiment")}</span>
                  <span className="experiment-card-meta">
                    <span>{enumLabel(run.status)}</span>
                    {run.tags.slice(0, 3).map((tag) => (
                      <span key={tag}>{tag}</span>
                    ))}
                  </span>
                </button>
              ))}
              {selectedExperimentId && filteredRuns.length === 0 && (
                <p className="run-empty-box">{t("runEmpty")}</p>
              )}
            </div>
          </div>

          <div className="experiments-detail-column">
            <div className="experiments-detail-toolbar">
              <h3>{t("runDetailTitle")}</h3>
              {runPanelMode === "view" && runContext && (
                <div className="experiments-detail-actions">
                  <button
                    type="button"
                    className="primary-page-action primary-page-action--secondary"
                    onClick={startEditRun}
                  >
                    {t("edit")}
                  </button>
                </div>
              )}
            </div>

            <div className="run-detail-shell">
            {runPanelMode === "view" && runContext && (
              <>
                <div className="run-detail-summary" aria-label={ui("Run 简介")}>
                  <strong>{runContext.run.title || runContext.run.runLabel || runContext.run.id}</strong>
                  <dl className="experiment-description-list">
                    <div className="experiment-description-row">
                      <dt>{t("project")}</dt>
                      <dd>{displayText(projectMap.get(runContext.run.projectId ?? "") ?? runContext.project?.title, t("unlinkedProject"))}</dd>
                    </div>
                    <div className="experiment-description-row">
                      <dt>{t("experimentRunExperiment")}</dt>
                      <dd>{runContext.experiment.title}</dd>
                    </div>
                    <div className="experiment-description-row">
                      <dt>{ui("标签")}</dt>
                      <dd>{displayText(joinTags(runContext.run.tags))}</dd>
                    </div>
                  </dl>
                </div>

                <section className="experiment-detail-body run-detail-body run-summary-card">
                  <StructuredSummaryDisplay
                    fields={runSummaryFields}
                    emptyText={ui("暂无内容")}
                    className="run-summary-content"
                  />
                  <div className="experiment-summary-actions run-summary-actions">
                    <button type="button" onClick={() => void openRunOutputGeneration()}>
                      {t("experimentGenerateResultFromRun")}
                    </button>
                    <ExperimentRunQuickAnalysisButton
                      projectId={runContext.run.projectId ?? runContext.experiment.projectId}
                      runId={runContext.run.id}
                      runTitle={runContext.run.title || runContext.run.runLabel || runContext.run.id}
                    />
                    <button
                      type="button"
                      disabled={runManuscriptEditor.busy}
                      onClick={() => void runManuscriptEditor.openCurrent()}
                    >
                      {ui("打开编辑器")}
                    </button>
                  </div>
                </section>

                <section className="result-metric-panel">
                  <div className="result-metric-panel-header">
                    <h4>{ui("结果指标")}</h4>
                    <button
                      type="button"
                      className="primary-page-action primary-page-action--primary"
                      onClick={startCreateResultMetric}
                    >
                      {ui("新增指标")}
                    </button>
                  </div>

                  {resultMetricEditor && (
                    <form className="result-metric-form" onSubmit={(event) => void submitResultMetric(event)}>
                      <h5>
                        {resultMetricEditor.metricId ? ui("编辑指标") : ui("新增指标")}
                      </h5>
                      {resultMetricEditor.metricId &&
                        generatedResultItemsByMetricId[resultMetricEditor.metricId] && (
                          <p className="result-metric-sync-warning">
                            {ui("该指标已生成 ResultItem；修改指标不会自动同步成果项。")}
                          </p>
                        )}
                      <div className="form-row">
                        <label>
                          {ui("指标名称")}
                          <input
                            value={resultMetricEditor.form.name}
                            onChange={(event) =>
                              setResultMetricEditor((current) =>
                                current
                                  ? {
                                      ...current,
                                      form: { ...current.form, name: event.target.value }
                                    }
                                  : current
                              )
                            }
                          />
                        </label>
                        <label>
                          {ui("指标值")}
                          <input
                            value={resultMetricEditor.form.value}
                            onChange={(event) =>
                              setResultMetricEditor((current) =>
                                current
                                  ? {
                                      ...current,
                                      form: { ...current.form, value: event.target.value }
                                    }
                                  : current
                              )
                            }
                          />
                        </label>
                      </div>
                      <div className="form-row">
                        <label>
                          {ui("单位")}
                          <input
                            value={resultMetricEditor.form.unit}
                            onChange={(event) =>
                              setResultMetricEditor((current) =>
                                current
                                  ? {
                                      ...current,
                                      form: { ...current.form, unit: event.target.value }
                                    }
                                  : current
                              )
                            }
                          />
                        </label>
                        <label>
                          {ui("值类型")}
                          <select
                            value={resultMetricEditor.form.valueType}
                            onChange={(event) =>
                              setResultMetricEditor((current) =>
                                current
                                  ? {
                                      ...current,
                                      form: {
                                        ...current.form,
                                        valueType: event.target.value as ResultMetricValueType
                                      }
                                    }
                                  : current
                              )
                            }
                          >
                            <option value="text">{ui("文本")}</option>
                            <option value="number">{ui("数值")}</option>
                            <option value="percentage">{ui("百分比")}</option>
                            <option value="boolean">{ui("布尔值")}</option>
                            <option value="json">JSON</option>
                          </select>
                        </label>
                      </div>
                      <div className="form-row">
                        <label>
                          {ui("指标分组")}
                          <input
                            value={resultMetricEditor.form.metricGroup}
                            onChange={(event) =>
                              setResultMetricEditor((current) =>
                                current
                                  ? {
                                      ...current,
                                      form: { ...current.form, metricGroup: event.target.value }
                                    }
                                  : current
                              )
                            }
                          />
                        </label>
                        <label>
                          {ui("指标说明")}
                          <input
                            value={resultMetricEditor.form.description}
                            onChange={(event) =>
                              setResultMetricEditor((current) =>
                                current
                                  ? {
                                      ...current,
                                      form: { ...current.form, description: event.target.value }
                                    }
                                  : current
                              )
                            }
                          />
                        </label>
                      </div>
                      <div className="result-metric-form-footer">
                        <label className="result-metric-key-toggle">
                          <span>{ui("关键结果")}</span>
                          <input
                            type="checkbox"
                            checked={resultMetricEditor.form.isKeyResult}
                            onChange={(event) =>
                              setResultMetricEditor((current) =>
                                current
                                  ? {
                                      ...current,
                                      form: {
                                        ...current.form,
                                        isKeyResult: event.target.checked
                                      }
                                    }
                                  : current
                              )
                            }
                          />
                        </label>
                        <div className="button-row result-metric-form-actions">
                          <button type="submit" disabled={isMetricSaving}>
                            {isMetricSaving ? ui("正在保存…") : ui("保存指标")}
                          </button>
                          <button
                            type="button"
                            disabled={isMetricSaving}
                            onClick={() => setResultMetricEditor(null)}
                          >
                            {t("cancel")}
                          </button>
                        </div>
                      </div>
                    </form>
                  )}

                  <div className="result-metric-list">
                    {runContext.metrics.map((metric) => {
                      const keyResult = isResultMetricKeyResult(metric);
                      const generatedResultItem = generatedResultItemsByMetricId[metric.id];
                      return (
                        <article className="result-metric-card" key={metric.id}>
                          <div className="result-metric-card-line">
                            <div className="result-metric-title-row">
                              <strong>{metric.name}</strong>
                              {keyResult && (
                                <span className="result-metric-badge result-metric-badge-key">
                                  {ui("关键结果")}
                                </span>
                              )}
                              {generatedResultItem && (
                                <span className="result-metric-badge result-metric-badge-promoted">
                                  {ui("已生成结果")}
                                </span>
                              )}
                            </div>
                            <span className="result-metric-value">
                              {String(metric.value)}
                              {metric.unit ? ` ${metric.unit}` : ""}
                            </span>
                            {metric.description?.trim() && (
                              <span className="result-metric-description">
                                {metric.description}
                              </span>
                            )}
                          </div>
                          <div className="result-metric-actions">
                            <button type="button" onClick={() => startEditResultMetric(metric)}>
                              {ui("编辑")}
                            </button>
                            <button
                              type="button"
                              onClick={() => void toggleResultMetricKeyResult(metric)}
                            >
                              {keyResult ? ui("取消关键结果") : ui("标记为关键结果")}
                            </button>
                            <button
                              type="button"
                              onClick={() => void openMetricOutputGeneration(metric)}
                            >
                              {generatedResultItem
                                ? ui("再次生成结果")
                                : t("experimentGenerateResultFromMetric")}
                            </button>
                            <button
                              type="button"
                              className="danger-button"
                              onClick={() => void deleteResultMetric(metric)}
                            >
                              {ui("删除")}
                            </button>
                          </div>
                        </article>
                      );
                    })}
                    {runContext.metrics.length === 0 && (
                      <p className="run-empty-box">{ui("当前 Run 暂无结果指标。")}</p>
                    )}
                  </div>
                </section>

                {renderFileRefPanel("experimentRun", runContext.fileRefs)}

              </>
            )}

            {runPanelMode === "view" && !runContext && (
              <p className="run-empty-box">{t("selectRunHint")}</p>
            )}

            {selectedExperimentId && runPanelMode !== "view" && (
              <div className="experiment-form-modal-overlay" role="presentation">
              <form
                className="module-form experiment-maintenance-form run-edit-panel experiment-form-modal"
                onSubmit={(event) => void submitRun(event)}
                role="dialog"
                aria-modal="true"
                aria-labelledby="run-form-modal-title"
              >
                <div className="experiment-form-header">
                  <h4 id="run-form-modal-title">
                    {runPanelMode === "create" ? t("runCreateTitle") : t("runEditTitle")}
                  </h4>
                  <button
                    type="button"
                    className="experiment-form-close"
                    onClick={cancelRunPanel}
                    aria-label={ui("关闭")}
                  >
                    ×
                  </button>
                </div>

                <section className="experiment-form-section">
                  <h5>{ui("Run 基础信息")}</h5>
                  <div className="experiment-form-grid run-basic-form-grid">
                    <label>
                      {ui("Run 名称")}
                      <input
                        value={runForm.title}
                        onChange={(event) =>
                          setRunForm((current) => ({ ...current, title: event.target.value }))
                        }
                      />
                    </label>
                    <label>
                      {ui("编号")}
                      <input
                        value={runForm.runLabel}
                        onChange={(event) =>
                          setRunForm((current) => ({ ...current, runLabel: event.target.value }))
                        }
                      />
                    </label>
                    <label>
                      {ui("所属实验")}
                      <input
                        className="run-parent-experiment-field"
                        value={detailContext?.experiment.title ?? ui("未命名实验")}
                        readOnly
                      />
                    </label>
                    <label>
                      {ui("状态")}
                      <select
                        value={runForm.status}
                        onChange={(event) =>
                          setRunForm((current) => ({
                            ...current,
                            status: event.target.value as ExperimentRunStatus
                          }))
                        }
                      >
                        {runStatuses.map((status) => (
                          <option key={status} value={status}>
                            {enumLabel(status)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      {ui("评级")}
                      <select
                        value={runForm.rating}
                        onChange={(event) =>
                          setRunForm((current) => ({
                            ...current,
                            rating: event.target.value as ExperimentRating | ""
                          }))
                        }
                      >
                        {ratings.map((rating) => (
                          <option key={rating || "empty"} value={rating}>
                            {rating ? enumLabel(rating) : ui("未评级")}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      {ui("标签")}
                      <input
                        value={runForm.tags}
                        onChange={(event) =>
                          setRunForm((current) => ({ ...current, tags: event.target.value }))
                        }
                      />
                    </label>
                    <label className="checkbox-row research-trace-preference-row experiment-research-trace-checkbox">
                      <input
                        type="checkbox"
                        checked={runForm.researchTraceDisplayChecked}
                        onChange={(event) =>
                          setRunForm((current) => ({
                            ...current,
                            researchTraceDisplayChecked: event.target.checked
                          }))
                        }
                      />
                      <span>{ui("显示在课题研究脉络中")}</span>
                    </label>
                  </div>
                </section>

                <section className="experiment-form-section run-summary-form-section">
                  <h5>{ui("Run 摘要")}</h5>
                  <StructuredEditFieldGrid className="experiment-summary-form-fields run-summary-form-fields">
                    <label className="experiment-summary-field">
                      {ui("运行条件摘要")}
                      <textarea
                        value={runForm.conditionSummary}
                        onChange={(event) =>
                          setRunForm((current) => ({
                            ...current,
                            conditionSummary: event.target.value
                          }))
                        }
                      />
                    </label>
                    <label className="experiment-summary-field">
                      {ui("变量与参数摘要")}
                      <textarea
                        value={runForm.variableParameterSummary}
                        onChange={(event) =>
                          setRunForm((current) => ({
                            ...current,
                            variableParameterSummary: event.target.value
                          }))
                        }
                      />
                    </label>
                    <label className="experiment-summary-field">
                      {ui("运行方法摘要")}
                      <textarea
                        value={runForm.methodSummary}
                        onChange={(event) =>
                          setRunForm((current) => ({ ...current, methodSummary: event.target.value }))
                        }
                      />
                    </label>
                    <label className="experiment-summary-field">
                      {ui("运行结果摘要")}
                      <textarea
                        value={runForm.resultSummary}
                        onChange={(event) =>
                          setRunForm((current) => ({ ...current, resultSummary: event.target.value }))
                        }
                      />
                    </label>
                    <label className="experiment-summary-field">
                      {ui("结论说明")}
                      <textarea
                        value={runForm.conclusion}
                        onChange={(event) =>
                          setRunForm((current) => ({ ...current, conclusion: event.target.value }))
                        }
                      />
                    </label>
                    <label className="experiment-summary-field">
                      {ui("其他")}
                      <textarea
                        value={runForm.summaryOther}
                        onChange={(event) =>
                          setRunForm((current) => ({ ...current, summaryOther: event.target.value }))
                        }
                      />
                    </label>
                  </StructuredEditFieldGrid>
                </section>

                <DataClearFooterRow
                  className="button-row experiment-form-actions"
                  contextKey={`experimentRun:${runPanelMode}:${editingRunId ?? "new"}`}
                  regionLabel={ui("数据清除")}
                  clearLabel={t("clear")}
                  deleteLabel={ui("删除")}
                  onClear={clearRunPanelForm}
                  onDelete={
                    runPanelMode === "edit" && runContext
                      ? () => void deleteCurrentRun()
                      : undefined
                  }
                >
                  <button type="submit">{t("save")}</button>
                  <button type="button" onClick={cancelRunPanel}>
                    {t("cancel")}
                  </button>
                </DataClearFooterRow>
            </form>
              </div>
            )}
            </div>
          </div>
        </div>
      </section>

      {outputGenerationDraft && (
        <div className="modal-backdrop" role="presentation">
          <form
            className="experiment-output-generation-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="experiment-output-generation-title"
            onSubmit={(event) => void submitOutputGeneration(event)}
          >
            <div className="operation-confirm-header experiment-output-generation-header">
              <div>
                <h2 id="experiment-output-generation-title">
                  {t("experimentGenerateResult")}
                </h2>
                <p>{outputGenerationDraft.sourceTitle}</p>
              </div>
            </div>

            <div className="experiment-output-generation-source">
              <div>
                <span>{t("experimentGenerateResultSource")}</span>
                <strong>
                  {outputGenerationDraft.sourceType === "experimentRun"
                    ? t("outputSourceTypeExperimentRun")
                    : t("outputSourceTypeExperiment")}
                </strong>
              </div>
              {outputGenerationDraft.duplicateHint && (
                <p className="experiment-output-generation-warning">
                  {t("experimentGenerateResultDuplicateHint")}
                </p>
              )}
            </div>

            {outputGenerationDraft.metricContext && (
              <div className="experiment-output-generation-metric-context">
                <strong>{t("experimentGenerateResultMetricContext")}</strong>
                <p>{t("experimentGenerateResultMetricAsContext")}</p>
                <dl>
                  <div>
                    <dt>{ui("指标名称")}</dt>
                    <dd>{outputGenerationDraft.metricContext.name}</dd>
                  </div>
                  <div>
                    <dt>{ui("指标值")}</dt>
                    <dd>{outputGenerationDraft.metricContext.value}</dd>
                  </div>
                  {outputGenerationDraft.metricContext.description && (
                    <div>
                      <dt>{ui("指标说明")}</dt>
                      <dd>{outputGenerationDraft.metricContext.description}</dd>
                    </div>
                  )}
                </dl>
              </div>
            )}

            <div className="experiment-output-generation-fields">
              <label>
                {t("experimentGenerateResultTitle")}
                <input
                  value={outputGenerationDraft.resultItemTitle}
                  onChange={(event) =>
                    setOutputGenerationDraft((current) =>
                      current ? { ...current, resultItemTitle: event.target.value } : current
                    )
                  }
                />
              </label>
              <label>
                {t("experimentGenerateResultSummary")}
                <textarea
                  value={outputGenerationDraft.summary}
                  onChange={(event) =>
                    setOutputGenerationDraft((current) =>
                      current ? { ...current, summary: event.target.value } : current
                    )
                  }
                />
              </label>
              <label className="result-generation-source-note">
                {t("experimentGenerateResultSourceNote")}
                <textarea
                  value={outputGenerationDraft.sourceNote}
                  onChange={(event) =>
                    setOutputGenerationDraft((current) =>
                      current ? { ...current, sourceNote: event.target.value } : current
                    )
                  }
                />
              </label>
            </div>

            {outputGenerationDraft.error && (
              <p className="experiment-output-generation-error">
                {outputGenerationDraft.error}
              </p>
            )}

            <div className="button-row experiment-output-generation-actions result-generation-modal-actions">
              <button
                type="submit"
                disabled={isOutputGenerationPending}
              >
                {isOutputGenerationPending
                  ? t("experimentGenerateResultSaving")
                  : t("experimentGenerateResultConfirm")}
              </button>
              <button
                type="button"
                disabled={isOutputGenerationPending}
                onClick={() => setOutputGenerationDraft(null)}
              >
                {t("cancel")}
              </button>
            </div>
          </form>
        </div>
      )}

      <ExperimentCurrentManuscriptEditor
        editor={manuscriptEditor}
        entityTitle={detailContext?.experiment.title}
        outlineItems={experimentManuscriptOutlineItems}
        ui={ui}
      />

      <ExperimentIndependentManuscriptEditor
        editor={manuscriptEditor}
        entityTitle={detailContext?.experiment.title}
        outlineItems={experimentManuscriptOutlineItems}
        ui={ui}
      />

      {manuscriptEditor.choiceDialog?.kind === "formal-switch" ? (
        <FormalSwitchConfirmationDialog
          dialogId="experiment-manuscript-choice-title"
          title={manuscriptEditor.choiceDialog.title}
          message={manuscriptEditor.choiceDialog.message}
          confirmLabel={
            manuscriptEditor.choiceDialog.options.find((option) => option.value === "confirm")?.label
              ?? ui("设为当前稿")
          }
          cancelLabel={
            manuscriptEditor.choiceDialog.options.find((option) => option.value === "cancel")?.label
              ?? ui("取消")
          }
          onConfirm={() => manuscriptEditor.resolveChoice("confirm")}
          onCancel={() => manuscriptEditor.resolveChoice("cancel")}
        />
      ) : manuscriptEditor.choiceDialog ? (
        <ModalPortal>
          <div className="modal-backdrop review-manuscript-choice-backdrop" role="presentation">
            <section
              className="operation-confirm-dialog review-manuscript-choice-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="experiment-manuscript-choice-title"
            >
              <h2 id="experiment-manuscript-choice-title">
                {manuscriptEditor.choiceDialog.title}
              </h2>
              <p style={{ whiteSpace: "pre-line" }}>{manuscriptEditor.choiceDialog.message}</p>
              <div className="button-row">
                {manuscriptEditor.choiceDialog.options.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={
                      option.emphasis === "danger"
                        ? "danger-button"
                        : option.emphasis === "primary"
                          ? "primary-button"
                          : "secondary-button"
                    }
                    onClick={() => manuscriptEditor.resolveChoice(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </section>
          </div>
        </ModalPortal>
      ) : null}

      <ExperimentRunCurrentManuscriptEditor
        editor={runManuscriptEditor}
        entityTitle={runContext?.run.title}
        outlineItems={runManuscriptOutlineItems}
        ui={ui}
      />

      <ExperimentRunIndependentManuscriptEditor
        editor={runManuscriptEditor}
        entityTitle={runContext?.run.title}
        outlineItems={runManuscriptOutlineItems}
        ui={ui}
      />

      {runManuscriptEditor.choiceDialog?.kind === "formal-switch-confirm" ? (
        <FormalSwitchConfirmationDialog
          dialogId="experiment-run-manuscript-choice-title"
          title={runManuscriptEditor.choiceDialog.title}
          message={runManuscriptEditor.choiceDialog.message}
          confirmLabel={
            runManuscriptEditor.choiceDialog.options.find((option) => option.value === "confirm")?.label
              ?? ui("确认切换")
          }
          cancelLabel={
            runManuscriptEditor.choiceDialog.options.find((option) => option.value === "cancel")?.label
              ?? ui("取消")
          }
          onConfirm={() => void runManuscriptEditor.resolveChoice("confirm")}
          onCancel={() => void runManuscriptEditor.resolveChoice("cancel")}
        />
      ) : runManuscriptEditor.choiceDialog ? (
        <ModalPortal>
          <div className="modal-backdrop review-manuscript-choice-backdrop" role="presentation">
            <section
              className="operation-confirm-dialog review-manuscript-choice-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="experiment-run-manuscript-choice-title"
            >
              <h2 id="experiment-run-manuscript-choice-title">
                {runManuscriptEditor.choiceDialog.title}
              </h2>
              <p style={{ whiteSpace: "pre-line" }}>{runManuscriptEditor.choiceDialog.message}</p>
              <div className="button-row">
                {runManuscriptEditor.choiceDialog.options.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={
                      option.emphasis === "danger"
                        ? "danger-button"
                        : option.emphasis === "primary"
                          ? "primary-button"
                          : "secondary-button"
                    }
                    onClick={() => void runManuscriptEditor.resolveChoice(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </section>
          </div>
        </ModalPortal>
      ) : null}
    </div>
  );
}
