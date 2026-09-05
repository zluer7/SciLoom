import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { LazyManuscriptSegmentEditorWindow } from "../../components/common/LazyManuscriptSegmentEditorWindow";
import { ModalPortal } from "../../components/common/ModalPortal";
import { FormalSwitchConfirmationDialog } from "../../components/common/FormalSwitchConfirmationDialog";
import { StructuredEditFieldGrid } from "../../components/common/StructuredEditFieldGrid";
import { DataClearFooterRow } from "../../components/common/DataClearRow";
import { StructuredSummaryDisplay } from "../../components/common/StructuredSummaryDisplay";
import { FileRefPathActions } from "../../components/common/FileRefPathActions";
import { FileRefPathPicker } from "../../components/common/FileRefPathPicker";
import { PageHeader } from "../../components/common/PageHeader";
import { useRef } from "react";
import { WriteFeedbackPanel } from "../../components/feedback/WriteFeedbackPanel";
import { OperationConfirmDialog } from "../../components/safety/OperationConfirmDialog";
import { useRefreshEventReload } from "../../hooks/useRefreshEventReload";
import { useOperationConfirm } from "../../hooks/useOperationConfirm";
import { useWriteFeedbackCenter } from "../../hooks/useWriteFeedbackCenter";
import type { WriteFeedbackDisplayScope } from "../../services/writeFeedbackDisplayService";
import { useI18n } from "../../i18n/I18nProvider";
import { nonPlanningEnumLabel, nonPlanningUi } from "../../i18n/nonPlanningI18n";
import { priorityLabel } from "../../i18n/planningLabels";
import {
  planningService,
  type CreateReviewResult,
  type ReviewCatalogEntry,
  type ReviewTargetSummary
} from "../../services/planningService";
import { publishFormalBusinessAttemptFailure } from "../../services/businessOperationFeedbackService";
import { experimentService } from "../../services/experimentService";
import { experimentRunService } from "../../services/experimentRunService";
import { getProjectLiteratureContext } from "../../services/literatureSelectorService";
import {
  createDefaultReviewOutlineSections,
  reconcileReviewOutlineSections
} from "../../services/reviewCoreContractService";
import { reviewFileRefService } from "../../services/reviewFileRefService";
import {
  getReviewDetailContext,
  type ReviewDetailContext
} from "../../services/reviewSelectorService";
import { fileRefService, summarizeFileRefPath } from "../../services/fileRefService";
import {
  literatureReviewOutputGenerationService,
  type LiteratureReviewOutputGenerationDraft
} from "../../services/literatureReviewOutputGenerationService";
import {
  classifyReviewLifecycleError,
  reviewDeleteSafetyService
} from "../../services/reviewDeleteSafetyService";
import {
  planningPageAdapterService,
  type PlanningProjectPageProject,
  type PlanningProjectPlanRouteEntry,
  type PlanningProjectPlanTaskEntry
} from "../../services/planningPageAdapterService";
import {
  readSharedCurrentProjectSelection,
  resolveSharedCurrentProjectSelection,
  writeSharedCurrentProjectSelection
} from "../../services/sharedCurrentProjectSelection";
import {
  getResearchTraceDisplayChecked,
  isStageReviewDefaultDisplayed,
  saveResearchTraceDisplayPreference
} from "../../services/projectResearchTracePreferenceUiService";
import { buildReviewPathOpenActionModel } from "./reviewsPagePathOpenKindModel";
import { useReviewManuscriptEditor } from "./useReviewManuscriptEditor";
import { sharedEditorLifecycleController } from "../../services/sharedEditorLifecycleController";
import {
  canOpenReviewEditModal,
  createCollapsedReviewTargetSections,
  closeReviewEditorModal,
  completeReviewEditorModalSave,
  expandReviewComparisonTargetSections,
  getReviewEditorModalTitle,
  openCreateReviewEditorModal,
  openEditReviewEditorModal,
  toggleReviewTargetSection,
  type ReviewEditorTargetSectionKey,
  type ReviewEditorModalMode
} from "./reviewsPageEditorModalModel";
import {
  buildReviewFormTargetState,
  buildReviewProjectTargetOptions,
  buildReviewTargets,
  EMPTY_REVIEW_FORM_TARGET_STATE,
  getReviewComparisonValidationMessage,
  mapReviewTargetContractError,
  type ReviewFormTargetState,
  type ReviewTargetOptionModel
} from "./reviewsPageReviewFormTargetModel";
import {
  buildReviewRelationFilterSummary,
  buildReviewRelationTagOptions,
  createDefaultReviewRelationFilters,
  filterReviewExperimentOptions,
  filterReviewLiteratureOptions,
  filterReviewRouteOptions,
  filterReviewRunOptions,
  filterReviewTaskOptions,
  isReviewRelationFilterActive,
  resetReviewRelationFilter,
  type ReviewExperimentRelationFilter,
  type ReviewLiteratureRelationFilter,
  type ReviewRelationFilterKey,
  type ReviewRelationFilters,
  type ReviewRelationTimeFilter,
  type ReviewRouteRelationFilter,
  type ReviewRunRelationFilter,
  type ReviewTaskRelationFilter
} from "./reviewsPageRelationFilterModel";
import {
  buildReviewFormalObjectCardModel,
  buildReviewFormalObjectGroups,
  buildReviewFormalOutlineDisplaySections,
  buildReviewFormalPathFormModel,
  buildReviewFormalPathRecordView,
  buildReviewFormalPathSectionModel,
  getReviewFormalDetailHeaderActions,
  buildReviewFormalSummaryCardModel,
  isReviewFormalDetailBlocked,
  type ReviewFormalObjectType
} from "./reviewsPageFormalDetailModel";
import { ReviewQuickAnalysisButton } from "./ReviewQuickAnalysisButton";
import type { ReviewFileRefPathMaterialSummary } from "../../services/reviewFileRefPathMaterialModel";
import type {
  Review,
  ReviewOutlineSection,
  ReviewOutlineSectionKey,
  ReviewType
} from "../../types";
import type { FileRef } from "../../types/experiment";
import type { LocalFileResult } from "../../types/localFile";
import type { OperationImpactPreview } from "../../types/operationSafety";
import type { RefreshEvent, RefreshKeyPattern } from "../../types/refresh";

type ReviewTypeFilter = ReviewType | "all";
type ReviewTimeFilter = "this_week" | "this_month" | "last_30_days" | "this_quarter" | "all";
type Project = PlanningProjectPageProject;
type PlanningRouteEntry = PlanningProjectPlanRouteEntry;
type PlanningTaskEntry = PlanningProjectPlanTaskEntry;
type OutputGenerationDraftState = LiteratureReviewOutputGenerationDraft & {
  error?: string;
};

type ReviewFormState = ReviewFormTargetState & {
  title: string;
  description: string;
  projectId: string;
  reviewType: ReviewType;
  periodStart: string;
  periodEnd: string;
  periodLabel: string;
  researchTraceDisplayChecked: boolean;
  outlineSections: ReviewOutlineSection[];
};

const emptyForm: ReviewFormState = {
  title: "",
  description: "",
  projectId: "",
  reviewType: "stage",
  periodStart: "",
  periodEnd: "",
  periodLabel: "",
  researchTraceDisplayChecked: true,
  outlineSections: createDefaultReviewOutlineSections("stage"),
  ...EMPTY_REVIEW_FORM_TARGET_STATE
};

const REVIEWS_REFRESH_KEYS: RefreshKeyPattern[] = [
  "review.changed",
  "reviewContext.changed",
  "fileRef.changed",
  "project.changed",
  "route.changed",
  "task.changed",
  "experiment.changed",
  "literature.changed",
  "output.*",
  "entityLink.changed",
  "literatureLink.changed",
  "aiContext.changed",
  "global.changed"
];

const ROUTE_FILTER_STATUSES: ReviewRouteRelationFilter["status"][] = [
  "",
  "planned",
  "in_progress",
  "blocked",
  "completed",
  "archived"
];
const TASK_FILTER_STATUSES: ReviewTaskRelationFilter["status"][] = [
  "",
  "todo",
  "doing",
  "delayed",
  "blocked",
  "done",
  "cancelled",
  "archived"
];
const EXPERIMENT_FILTER_STATUSES: ReviewExperimentRelationFilter["status"][] = [
  "",
  "planned",
  "running",
  "completed",
  "paused",
  "failed",
  "archived"
];
const EXPERIMENT_FILTER_RATINGS: ReviewExperimentRelationFilter["rating"][] = [
  "",
  "excellent",
  "good",
  "usable",
  "inconclusive",
  "failed",
  "unrated"
];
const RUN_FILTER_STATUSES: ReviewRunRelationFilter["status"][] = [
  "",
  "planned",
  "running",
  "completed",
  "paused",
  "failed",
  "cancelled"
];
const LITERATURE_FILTER_READING_STATUSES: ReviewLiteratureRelationFilter["readingStatus"][] = [
  "",
  "unread",
  "skimmed",
  "reading",
  "intensive_read",
  "summarized",
  "reused",
  "discarded",
  "archived"
];
const LITERATURE_FILTER_IMPORTANCE: ReviewLiteratureRelationFilter["importance"][] = [
  "",
  "core",
  "important",
  "useful",
  "background",
  "low",
  "uncertain",
  "unset"
];
const RELATION_TIME_FILTERS: ReviewRelationTimeFilter[] = [
  "all",
  "this_month",
  "this_quarter",
  "unscheduled"
];

function toDateInput(value?: string) {
  return value ? value.slice(0, 10) : "";
}

function toReviewForm(review: Review, targetLinks: ReviewTargetSummary[]): ReviewFormState {
  return {
    title: review.title,
    description: review.description ?? "",
    projectId: review.projectId,
    reviewType: review.reviewType,
    periodStart: toDateInput(review.periodStart),
    periodEnd: toDateInput(review.periodEnd),
    periodLabel: review.periodLabel ?? "",
    researchTraceDisplayChecked: isStageReviewDefaultDisplayed(review.reviewType),
    outlineSections: review.outlineSections,
    ...buildReviewFormTargetState(targetLinks)
  };
}

function reviewReferenceDate(review: Review | ReviewCatalogEntry) {
  return review.periodEnd || review.periodStart || review.updatedAt || review.createdAt;
}

function rangeForFilter(filter: ReviewTimeFilter) {
  if (filter === "all") {
    return null;
  }

  const now = new Date();
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);

  if (filter === "last_30_days") {
    start.setDate(start.getDate() - 29);
  } else if (filter === "this_month") {
    start.setDate(1);
  } else if (filter === "this_quarter") {
    start.setMonth(Math.floor(now.getMonth() / 3) * 3, 1);
  } else {
    const day = start.getDay();
    start.setDate(start.getDate() - (day === 0 ? 6 : day - 1));
  }

  return { start, end };
}

function reviewMatchesTime(review: Review | ReviewCatalogEntry, filter: ReviewTimeFilter) {
  const range = rangeForFilter(filter);
  if (!range) {
    return true;
  }

  const reviewStart = new Date(review.periodStart || reviewReferenceDate(review));
  const reviewEnd = new Date(review.periodEnd || reviewReferenceDate(review));
  if (Number.isNaN(reviewStart.getTime()) || Number.isNaN(reviewEnd.getTime())) {
    return false;
  }
  return reviewStart <= range.end && reviewEnd >= range.start;
}

function taskRouteId(task: PlanningTaskEntry) {
  return task.routeNodeId || task.milestoneId || "";
}

function sanitizeReviewForm(
  form: ReviewFormState,
  routes: PlanningRouteEntry[],
  tasks: PlanningTaskEntry[],
  targetOptions: ReviewTargetOptionModel
): ReviewFormState {
  const routeNodeIds = [...new Set(form.routeNodeIds)];
  const taskIds = [...new Set(form.taskIds)];

  return {
    ...form,
    routeNodeIds: routeNodeIds.filter((routeId) =>
      routes.some((route) => route.id === routeId && route.projectId === form.projectId)
    ),
    taskIds: taskIds.filter((taskId) =>
      tasks.some((task) => task.id === taskId && task.projectId === form.projectId)
    ),
    experimentIds: [...new Set(form.experimentIds)].filter((experimentId) =>
      targetOptions.experiments.some((experiment) => experiment.id === experimentId)
    ),
    experimentRunIds: [...new Set(form.experimentRunIds)].filter((runId) =>
      targetOptions.experimentRuns.some((run) => run.id === runId)
    ),
    literatureIds: [...new Set(form.literatureIds)].filter((literatureId) =>
      targetOptions.literatures.some((literature) => literature.id === literatureId)
    )
  };
}

export function ReviewsPage() {
  const { t, language } = useI18n();
  const [projects, setProjects] = useState<Project[]>([]);
  const [routes, setRoutes] = useState<PlanningRouteEntry[]>([]);
  const [tasks, setTasks] = useState<PlanningTaskEntry[]>([]);
  const [reviews, setReviews] = useState<ReviewCatalogEntry[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState(
    () => readSharedCurrentProjectSelection() ?? ""
  );
  const [reviewTypeFilter, setReviewTypeFilter] = useState<ReviewTypeFilter>("all");
  const [timeFilter, setTimeFilter] = useState<ReviewTimeFilter>("all");
  const [selectedReviewId, setSelectedReviewId] = useState<string | null>(null);
  const [selectedReview, setSelectedReview] = useState<Review | null>(null);
  const selectedReviewIdRef = useRef<string | null>(null);
  const [targetLinks, setTargetLinks] = useState<ReviewTargetSummary[]>([]);
  const [isTargetLinksLoading, setIsTargetLinksLoading] = useState(false);
  const [pathMaterialSummaries, setPathMaterialSummaries] = useState<
    ReviewFileRefPathMaterialSummary[]
  >([]);
  const [reviewPathFileRefs, setReviewPathFileRefs] = useState<FileRef[]>([]);
  const [reviewDetailContext, setReviewDetailContext] = useState<ReviewDetailContext>();
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [editorMode, setEditorMode] = useState<ReviewEditorModalMode | null>(null);
  const [editingReviewId, setEditingReviewId] = useState<string | null>(null);
  const [form, setForm] = useState<ReviewFormState>(emptyForm);
  const [saveError, setSaveError] = useState("");
  const [expandedTargetSections, setExpandedTargetSections] = useState(
    createCollapsedReviewTargetSections
  );
  const [relationFilters, setRelationFilters] = useState(
    createDefaultReviewRelationFilters
  );
  const [detailReloadVersion, setDetailReloadVersion] = useState(0);
  const [editingPathMaterialId, setEditingPathMaterialId] = useState<string | null>(null);
  const [isPathRecordsOpen, setIsPathRecordsOpen] = useState(false);
  const [isPathRecordFormOpen, setIsPathRecordFormOpen] = useState(false);
  const [outputGenerationDraft, setOutputGenerationDraft] =
    useState<OutputGenerationDraftState | null>(null);
  const [isOutputGenerationPending, setIsOutputGenerationPending] = useState(false);
  const [reviewTargetOptions, setReviewTargetOptions] = useState<ReviewTargetOptionModel>({
    experiments: [],
    experimentRuns: [],
    literatures: []
  });
  const [isReviewTargetOptionsLoading, setIsReviewTargetOptionsLoading] = useState(false);
  const [reviewTargetOptionsError, setReviewTargetOptionsError] = useState("");
  const [pathMaterialForm, setPathMaterialForm] = useState({
    title: "",
    path: "",
    fileType: "review_material",
    description: ""
  });
  const [pathMaterialError, setPathMaterialError] = useState("");
  const feedbackContext = useMemo(() => ({
    page: "reviews",
    projectId: selectedProjectId || undefined,
    ownerKeys: selectedReviewId ? [`review:${selectedReviewId}:primary`] : []
  }), [selectedProjectId, selectedReviewId]);
  const feedbackCenter = useWriteFeedbackCenter(feedbackContext);
  const operationConfirm = useOperationConfirm();
  const researchTracePreferenceRequestRef = useRef("");

  const loadReviews = useCallback(async (preferredReviewId?: string) => {
    const nextReviews = await planningService.queryReviewCatalog();
    setReviews(nextReviews);
    if (preferredReviewId) {
      setSelectedReviewId(preferredReviewId);
    }
  }, []);

  const loadPageData = useCallback(async () => {
    const [targetModel, nextReviews] = await Promise.all([
      planningPageAdapterService.getPlanningReviewTargetsModel(),
      planningService.queryReviewCatalog()
    ]);
    setProjects(targetModel.projects);
    setRoutes(targetModel.routeNodes);
    setTasks(targetModel.tasks);
    setReviews(nextReviews);
    setSelectedProjectId((current) => {
      const currentProjectIds = new Set(targetModel.projects.map((project) => project.id));
      return current && currentProjectIds.has(current)
        ? current
        : resolveSharedCurrentProjectSelection(targetModel.projects);
    });
  }, []);

  const loadSelectedReviewTargets = useCallback(async (reviewId: string) => {
    return planningService.queryReviewTargets(reviewId);
  }, []);

  const loadSelectedReviewPathMaterials = useCallback(async (reviewId: string) => {
    return reviewFileRefService.queryReviewFileRefPathMaterialSummaries(reviewId);
  }, []);

  const loadSelectedReviewFileRefs = useCallback(async (reviewId: string) => {
    return reviewFileRefService.queryReviewFileRefs(reviewId);
  }, []);

  const loadSelectedReviewDetailContext = useCallback(async (reviewId: string) => {
    return getReviewDetailContext(reviewId);
  }, []);

  function clearSelectedReviewDetailState() {
    setTargetLinks([]);
    setPathMaterialSummaries([]);
    setReviewPathFileRefs([]);
    setReviewDetailContext(undefined);
    setEditingPathMaterialId(null);
    setIsPathRecordsOpen(false);
    setIsPathRecordFormOpen(false);
    setPathMaterialForm({
      title: "",
      path: "",
      fileType: "review_material",
      description: ""
    });
    setPathMaterialError("");
  }

  useEffect(() => {
    selectedReviewIdRef.current = selectedReviewId;
  }, [selectedReviewId]);

  useEffect(() => {
    if (!isEditorOpen || !form.projectId) {
      setReviewTargetOptions({ experiments: [], experimentRuns: [], literatures: [] });
      setReviewTargetOptionsError("");
      setIsReviewTargetOptionsLoading(false);
      return;
    }

    let cancelled = false;
    setIsReviewTargetOptionsLoading(true);
    setReviewTargetOptionsError("");
    Promise.all([
      experimentService.getExperimentsByProject(form.projectId),
      experimentRunService.list(),
      getProjectLiteratureContext(form.projectId)
    ])
      .then(([experiments, runs, literatureContext]) => {
        if (!cancelled) {
          setReviewTargetOptions(
            buildReviewProjectTargetOptions(
              form.projectId,
              experiments,
              runs,
              literatureContext.literatures
            )
          );
        }
      })
      .catch((error) => {
        console.warn("Failed to load Review target options.", error);
        if (!cancelled) {
          setReviewTargetOptions({ experiments: [], experimentRuns: [], literatures: [] });
          setReviewTargetOptionsError(
            language === "zh-CN"
              ? "实验、Run 或文献选项加载失败，请重试。"
              : "Experiment, run, or literature options could not be loaded. Try again."
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsReviewTargetOptionsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [form.projectId, isEditorOpen, language]);

  const reloadCurrentPage = useCallback(
    async (_event?: RefreshEvent) => {
      await loadPageData();
      if (selectedReviewId) {
        const reviewId = selectedReviewId;
        setIsTargetLinksLoading(true);
        setSelectedReview(null);
        setTargetLinks([]);
        setPathMaterialSummaries([]);
        setReviewPathFileRefs([]);
        setReviewDetailContext(undefined);
        try {
          const [nextTargets, nextPathMaterials, nextPathFileRefs, nextDetailContext] = await Promise.all([
            loadSelectedReviewTargets(reviewId),
            loadSelectedReviewPathMaterials(reviewId),
            loadSelectedReviewFileRefs(reviewId),
            loadSelectedReviewDetailContext(reviewId)
          ]);
          if (selectedReviewIdRef.current === reviewId) {
            setTargetLinks(nextTargets);
            setPathMaterialSummaries(nextPathMaterials);
            setReviewPathFileRefs(nextPathFileRefs.filter((fileRef) => !fileRef.deletedAt));
            setReviewDetailContext(nextDetailContext);
            setSelectedReview(nextDetailContext?.review ?? null);
          }
        } catch (error) {
          console.warn("Failed to reload Review targets.", error);
          if (selectedReviewIdRef.current === reviewId) {
            feedbackCenter.pushPageFeedback({
              severity: "warning",
              title: "Review targets could not be refreshed.",
              summary: error instanceof Error ? error.message : String(error),
              operation: "reviewTargets.reload"
            });
            setTargetLinks([]);
            setPathMaterialSummaries([]);
            setReviewPathFileRefs([]);
            setReviewDetailContext(undefined);
            setSelectedReview(null);
          }
        } finally {
          if (selectedReviewIdRef.current === reviewId) {
            setIsTargetLinksLoading(false);
          }
        }
      }
    },
    [
      loadPageData,
      loadSelectedReviewDetailContext,
      loadSelectedReviewFileRefs,
      loadSelectedReviewPathMaterials,
      loadSelectedReviewTargets,
      selectedReviewId
    ]
  );

  const refreshByKeys = reloadCurrentPage;

  useRefreshEventReload({
    pageName: "reviews",
    watchedKeys: REVIEWS_REFRESH_KEYS,
    reload: refreshByKeys,
    onRefreshFeedback: feedbackCenter.pushRefreshEventFeedback,
    onReloadError: (error, event) =>
      feedbackCenter.pushReloadErrorFeedback(error, event, "reviews")
  });

  useEffect(() => {
    loadPageData().catch((error) => {
      console.warn("Failed to load Review page data.", error);
      feedbackCenter.pushPageFeedback({
        severity: "error",
        title: "Review page data could not be loaded.",
        summary: error instanceof Error ? error.message : String(error),
        operation: "reviews.load"
      });
    });
  }, [feedbackCenter.pushPageFeedback, loadPageData]);

  const filteredReviews = useMemo(() => {
    return reviews
      .filter(
        (review) =>
          (!selectedProjectId || review.projectId === selectedProjectId) &&
          (reviewTypeFilter === "all" || review.reviewType === reviewTypeFilter) &&
          reviewMatchesTime(review, timeFilter)
      )
      .sort((left, right) =>
        reviewReferenceDate(right).localeCompare(reviewReferenceDate(left))
      );
  }, [reviews, reviewTypeFilter, selectedProjectId, timeFilter]);

  useEffect(() => {
    if (
      isEditorOpen &&
      editingReviewId &&
      !reviews.some((review) => review.id === editingReviewId && !review.deletedAt)
    ) {
      setIsEditorOpen(false);
      setEditorMode(null);
      setEditingReviewId(null);
      setSaveError("");
      setForm(emptyForm);
      setExpandedTargetSections(createCollapsedReviewTargetSections());
      return;
    }
    if (isEditorOpen && !editingReviewId) {
      return;
    }
    if (!filteredReviews.some((review) => review.id === selectedReviewId)) {
      setSelectedReviewId(
        filteredReviews.find((review) => review.structuredStateStatus === "available")?.id ?? null
      );
    }
  }, [editingReviewId, filteredReviews, isEditorOpen, reviews, selectedReviewId]);

  useEffect(() => {
    if (!selectedReviewId) {
      setSelectedReview(null);
      clearSelectedReviewDetailState();
      return;
    }

    let cancelled = false;
    setTargetLinks([]);
    setPathMaterialSummaries([]);
    setReviewPathFileRefs([]);
    setReviewDetailContext(undefined);
    setSelectedReview(null);
    setEditingPathMaterialId(null);
    setIsPathRecordsOpen(false);
    setIsPathRecordFormOpen(false);
    setPathMaterialForm({
      title: "",
      path: "",
      fileType: "review_material",
      description: ""
    });
    setPathMaterialError("");
    setIsTargetLinksLoading(true);
    Promise.all([
      loadSelectedReviewTargets(selectedReviewId),
      loadSelectedReviewPathMaterials(selectedReviewId),
      loadSelectedReviewFileRefs(selectedReviewId),
      loadSelectedReviewDetailContext(selectedReviewId)
    ])
      .then(([nextTargets, nextPathMaterials, nextPathFileRefs, nextDetailContext]) => {
        if (!cancelled) {
          setTargetLinks(nextTargets);
          setPathMaterialSummaries(nextPathMaterials);
          setReviewPathFileRefs(nextPathFileRefs.filter((fileRef) => !fileRef.deletedAt));
          setReviewDetailContext(nextDetailContext);
          setSelectedReview(nextDetailContext?.review ?? null);
        }
      })
      .catch((error) => {
        console.warn("Failed to load Review targets.", error);
        if (!cancelled) {
          feedbackCenter.pushPageFeedback({
            severity: "warning",
            title: "Review targets could not be loaded.",
            summary: error instanceof Error ? error.message : String(error),
            operation: "reviewTargets.load"
          });
          setTargetLinks([]);
          setPathMaterialSummaries([]);
          setReviewPathFileRefs([]);
          setReviewDetailContext(undefined);
          setSelectedReview(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsTargetLinksLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    feedbackCenter.pushPageFeedback,
    loadSelectedReviewDetailContext,
    loadSelectedReviewFileRefs,
    loadSelectedReviewPathMaterials,
    loadSelectedReviewTargets,
    detailReloadVersion,
    selectedReviewId
  ]);

  const ui = useCallback((source: string) => nonPlanningUi(language, source), [language]);
  const pushManuscriptFeedback = useCallback(
    (severity: "success" | "warning" | "error" | "info", title: string, operation: string) => {
      const scope: WriteFeedbackDisplayScope | undefined = selectedReview
        ? {
            classification: "owner",
            page: "reviews",
            projectId: selectedReview.projectId,
            ownerType: "review",
            ownerId: selectedReview.id
          }
        : undefined;
      feedbackCenter.pushPageFeedback({ severity, title, operation, scope });
    },
    [feedbackCenter.pushPageFeedback, selectedReview]
  );
  const refreshReviewManuscriptDetail = useCallback(async () => {
    setDetailReloadVersion((current) => current + 1);
  }, []);
  const manuscriptEditor = useReviewManuscriptEditor({
    reviewId: selectedReview?.id,
    reviewType: selectedReview?.reviewType,
    refreshSignal: reviewDetailContext
      ? `${reviewDetailContext.review.updatedAt}:${reviewDetailContext.manuscriptSummary.manuscriptFileCount}:${reviewDetailContext.manuscriptSummary.hasManagedWorkspace}`
      : undefined,
    ui,
    onFeedback: pushManuscriptFeedback,
    onRefreshDetail: refreshReviewManuscriptDetail
  });
  const isSelectedReviewBlocked = isReviewFormalDetailBlocked(selectedReview);
  const formalObjectGroups = buildReviewFormalObjectGroups(reviewDetailContext);
  const formalObjectCard = buildReviewFormalObjectCardModel(formalObjectGroups);
  const formalPathRecordViews = pathMaterialSummaries.map((summary) =>
    buildReviewFormalPathRecordView(summary, {
      open: language === "zh-CN" ? "打开" : "Open",
      reveal: language === "zh-CN" ? "打开所在文件夹" : "Reveal",
      copy: language === "zh-CN" ? "复制路径" : "Copy path",
      edit: language === "zh-CN" ? "编辑路径记录" : "Edit path record",
      delete: language === "zh-CN" ? "删除路径记录" : "Delete path record"
    })
  );
  const formalPathFileRefById = new Map(
    reviewPathFileRefs.map((fileRef) => [fileRef.id, fileRef])
  );
  const projectRoutes = routes.filter((route) => route.projectId === form.projectId);
  const projectTasks = tasks.filter((task) => task.projectId === form.projectId);
  const routeScopedTargetTasks = form.routeNodeIds.length
    ? projectTasks.filter(
        (task) =>
          form.routeNodeIds.includes(taskRouteId(task)) || form.taskIds.includes(task.id)
      )
    : projectTasks;
  const visibleRouteOptions = filterReviewRouteOptions(
    projectRoutes,
    relationFilters.routeNode,
    form.routeNodeIds
  );
  const visibleTaskOptions = filterReviewTaskOptions(
    routeScopedTargetTasks,
    relationFilters.task,
    form.taskIds
  );
  const visibleExperimentOptions = filterReviewExperimentOptions(
    reviewTargetOptions.experiments,
    relationFilters.experiment,
    form.experimentIds
  );
  const visibleRunOptions = filterReviewRunOptions(
    reviewTargetOptions.experimentRuns,
    relationFilters.experimentRun,
    form.experimentRunIds
  );
  const visibleLiteratureOptions = filterReviewLiteratureOptions(
    reviewTargetOptions.literatures,
    relationFilters.literature,
    form.literatureIds
  );
  const experimentTagOptions = buildReviewRelationTagOptions(
    reviewTargetOptions.experiments
  );
  const runTagOptions = buildReviewRelationTagOptions(
    reviewTargetOptions.experimentRuns
  );
  const targetExperimentById = new Map(
    reviewTargetOptions.experiments.map((experiment) => [experiment.id, experiment])
  );
  const reviewTypeLabels: Record<ReviewType, string> = {
    stage: t("reviewTypeStage"),
    periodic: t("reviewTypePeriodic"),
    experiment_comparison: t("reviewTypeExperimentComparison"),
    literature_comparison: t("reviewTypeLiteratureComparison"),
    custom: t("reviewTypeCustom")
  };

  const outlineLabels: Record<ReviewOutlineSectionKey, string> = {
    stage_summary: t("reviewOutlineStageSummary"),
    key_progress: t("reviewOutlineKeyProgress"),
    completed_items: t("reviewOutlineCompletedItems"),
    major_problems: t("reviewOutlineMajorProblems"),
    cause_analysis: t("reviewOutlineCauseAnalysis"),
    next_plan: t("reviewOutlineNextPlan"),
    other: t("reviewOutlineOther"),
    period_summary: t("reviewOutlinePeriodSummary"),
    period_completed: t("reviewOutlinePeriodCompleted"),
    period_pending: t("reviewOutlinePeriodPending"),
    next_period_plan: t("reviewOutlineNextPeriodPlan"),
    comparison_summary: t("reviewOutlineComparisonSummary"),
    comparison_targets: t("reviewOutlineComparisonTargets"),
    key_differences: t("reviewOutlineKeyDifferences"),
    main_conclusions: t("reviewOutlineMainConclusions"),
    anomalies_and_problems: t("reviewOutlineAnomaliesAndProblems"),
    next_experiment_plan: t("reviewOutlineNextExperimentPlan"),
    literature_overview: t("reviewOutlineLiteratureOverview"),
    literature_scope: t("reviewOutlineLiteratureScope"),
    method_differences: t("reviewOutlineMethodDifferences"),
    consensus_and_divergence: t("reviewOutlineConsensusAndDivergence"),
    research_gaps_and_references: t("reviewOutlineResearchGapsAndReferences"),
    next_reading_or_research_plan: t("reviewOutlineNextReadingOrResearchPlan"),
    custom_summary: t("reviewOutlineCustomSummary")
  };
  const formalOutlineSections = selectedReview
    ? buildReviewFormalOutlineDisplaySections(selectedReview, outlineLabels)
    : [];
  const formalSummaryCard = buildReviewFormalSummaryCardModel(formalOutlineSections, {
    emptyContent: t("reviewNoContent"),
    aiAnalysis: "AI分析",
    openEditor: language === "zh-CN" ? "打开编辑器" : "Open editor"
  });
  const formalPathSection = buildReviewFormalPathSectionModel({
    title: language === "zh-CN" ? "路径记录" : "Path records",
    addPathRecord: language === "zh-CN" ? "添加路径记录" : "Add path record"
  });
  const formalPathForm = buildReviewFormalPathFormModel({
    title: language === "zh-CN" ? "标题" : "Title",
    path: language === "zh-CN" ? "路径" : "Path",
    notes: language === "zh-CN" ? "备注" : "Note",
    addPathRecord: language === "zh-CN" ? "添加路径记录" : "Add path record",
    cancel: t("cancel")
  });

  function openCreateEditor() {
    researchTracePreferenceRequestRef.current = "";
    const transition = openCreateReviewEditorModal(selectedReviewId, {
      ...emptyForm,
      projectId: selectedProjectId || projects[0]?.id || ""
    });
    setSelectedReviewId(transition.selectedReviewId);
    setEditingReviewId(transition.editor.editingReviewId);
    setEditorMode(transition.editor.mode);
    setSaveError(transition.editor.saveError);
    setForm(transition.editor.form);
    setExpandedTargetSections(createCollapsedReviewTargetSections());
    setRelationFilters(createDefaultReviewRelationFilters());
    setIsEditorOpen(transition.editor.isOpen);
  }

  function openEditEditor() {
    if (!canOpenReviewEditModal(selectedReview, isTargetLinksLoading) || !selectedReview) {
      return;
    }
    const requestKey = `${selectedReview.projectId}:review:${selectedReview.id}`;
    researchTracePreferenceRequestRef.current = requestKey;
    const transition = openEditReviewEditorModal(
      selectedReviewId,
      selectedReview.id,
      toReviewForm(selectedReview, targetLinks)
    );
    setSelectedReviewId(transition.selectedReviewId);
    setEditingReviewId(transition.editor.editingReviewId);
    setEditorMode(transition.editor.mode);
    setSaveError(transition.editor.saveError);
    setForm(transition.editor.form);
    setExpandedTargetSections(createCollapsedReviewTargetSections());
    setRelationFilters(createDefaultReviewRelationFilters());
    setIsEditorOpen(transition.editor.isOpen);
    void loadReviewResearchTracePreference(selectedReview, requestKey);
  }

  function closeEditor() {
    researchTracePreferenceRequestRef.current = "";
    const transition = closeReviewEditorModal(selectedReviewId, emptyForm);
    setSelectedReviewId(transition.selectedReviewId);
    setIsEditorOpen(transition.editor.isOpen);
    setEditorMode(transition.editor.mode);
    setEditingReviewId(transition.editor.editingReviewId);
    setSaveError(transition.editor.saveError);
    setForm(transition.editor.form);
    setExpandedTargetSections(createCollapsedReviewTargetSections());
    setRelationFilters(createDefaultReviewRelationFilters());
  }

  async function loadReviewResearchTracePreference(
    review: Review,
    requestKey: string
  ) {
    try {
      const checked = await getResearchTraceDisplayChecked({
        projectId: review.projectId,
        targetType: "review",
        targetId: review.id,
        defaultDisplayed: isStageReviewDefaultDisplayed(review.reviewType)
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

  async function selectReview(reviewId: string, lifecycleSettled = false) {
    if (reviewId !== selectedReviewId && !lifecycleSettled) {
      await sharedEditorLifecycleController.requestSequence({
        trigger: "owner-change",
        continuationIntent: "OWNER_CHANGE",
        surface: "application",
        continuation: () => selectReview(reviewId, true)
      });
      return;
    }
    if (reviewId !== selectedReviewId && isEditorOpen) {
      closeEditor();
    }
    if (reviewId !== selectedReviewId) {
      setOutputGenerationDraft(null);
    }
    setSelectedReviewId(reviewId);
  }

  function openReviewManuscript() {
    if (
      !manuscriptEditor.workflowReady ||
      !manuscriptEditor.pageState?.canOpenCurrent ||
      isSelectedReviewBlocked
    ) {
      return;
    }
    void manuscriptEditor.openCurrent();
  }

  async function openReviewOutputGeneration() {
    if (!selectedReview || isSelectedReviewBlocked) {
      feedbackCenter.pushPageFeedback({
        severity: "warning",
        title: t("externalGenerateResultInvalidSource"),
        operation: "review.outputGeneration.open"
      });
      return;
    }
    try {
      const draft =
        await literatureReviewOutputGenerationService.buildReviewResultItemDraft(
          selectedReview.id
        );
      setOutputGenerationDraft(draft);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      feedbackCenter.consumeWriteError(error, "review.outputGeneration.buildDraft");
      feedbackCenter.pushPageFeedback({
        severity: "error",
        title: message || t("externalGenerateResultFailed"),
        operation: "review.outputGeneration.buildDraft"
      });
    }
  }

  async function submitOutputGeneration(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!outputGenerationDraft) {
      return;
    }
    setIsOutputGenerationPending(true);
    setOutputGenerationDraft((current) => (current ? { ...current, error: undefined } : current));
    try {
      const result = await literatureReviewOutputGenerationService.createResultItemFromReview(
        outputGenerationDraft.sourceId,
        {
          confirmedByUser: true,
          resultItemTitle: outputGenerationDraft.resultItemTitle,
          summary: outputGenerationDraft.summary,
          sourceNote: outputGenerationDraft.sourceNote,
          resultType: outputGenerationDraft.resultType
        }
      );
      setOutputGenerationDraft(null);
      await reloadCurrentPage();
      feedbackCenter.pushPageFeedback({
        severity: "success",
        title: `${t("externalGenerateResultSuccess")} ${result.resultItem.title}`,
        operation: "review.outputGeneration.createResultItem"
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      feedbackCenter.consumeWriteError(error, "review.outputGeneration.createResultItem");
      setOutputGenerationDraft((current) =>
        current ? { ...current, error: message || t("externalGenerateResultFailed") } : current
      );
      feedbackCenter.pushPageFeedback({
        severity: "error",
        title: message || t("externalGenerateResultFailed"),
        operation: "review.outputGeneration.createResultItem"
      });
    } finally {
      setIsOutputGenerationPending(false);
    }
  }

  function resetPathMaterialForm() {
    setEditingPathMaterialId(null);
    setIsPathRecordFormOpen(false);
    setPathMaterialForm({
      title: "",
      path: "",
      fileType: "review_material",
      description: ""
    });
    setPathMaterialError("");
  }

  function startCreatePathRecord() {
    setEditingPathMaterialId(null);
    setPathMaterialForm({
      title: "",
      path: "",
      fileType: "review_material",
      description: ""
    });
    setPathMaterialError("");
    setIsPathRecordsOpen(true);
    setIsPathRecordFormOpen(true);
  }

  async function handleSavePathRecord() {
    if (!selectedReview || isSelectedReviewBlocked) {
      return;
    }
    const path = pathMaterialForm.path.trim();
    const title = pathMaterialForm.title.trim();
    if (!path) {
      setPathMaterialError(
        language === "zh-CN" ? "请填写路径元数据。" : "Enter path metadata."
      );
      return;
    }
    try {
      if (editingPathMaterialId) {
        const existing = reviewPathFileRefs.find((fileRef) => fileRef.id === editingPathMaterialId);
        if (existing && existing.path !== path) {
          await fileRefService.replaceFileRefPath(existing.id, {
            path,
            title,
            fileType: pathMaterialForm.fileType.trim() || "review_material",
            description: pathMaterialForm.description.trim() || undefined
          });
        } else {
          await fileRefService.updateFileRef(editingPathMaterialId, {
            title: title || undefined,
            fileType: pathMaterialForm.fileType.trim() || "review_material",
            description: pathMaterialForm.description.trim() || undefined
          });
        }
      } else {
        await reviewFileRefService.createReviewFileRef(selectedReview.id, {
          path,
          title,
          fileType: pathMaterialForm.fileType.trim() || "review_material",
          description: pathMaterialForm.description.trim() || undefined
        });
      }
      resetPathMaterialForm();
      await reloadCurrentPage();
      feedbackCenter.pushPageFeedback({
        severity: "success",
        title:
          language === "zh-CN"
            ? editingPathMaterialId
              ? "路径记录元数据已更新"
              : "路径记录元数据已添加"
            : editingPathMaterialId
              ? "Path record metadata updated"
              : "Path record metadata added",
        summary:
          language === "zh-CN"
            ? "仅保存路径与元数据，未读取或上传文件正文。"
            : "Only path metadata was saved. File contents were not read or uploaded.",
        operation: editingPathMaterialId
          ? "fileRef.updateFileRef"
          : "reviewFileRef.createReviewFileRef"
      });
    } catch (error) {
      console.warn("Failed to save Review path record.", error);
      const message = error instanceof Error ? error.message : String(error);
      setPathMaterialError(message);
      feedbackCenter.pushPageFeedback({
        severity: "error",
        title: language === "zh-CN" ? "路径记录保存失败" : "Path record save failed",
        summary: message,
        operation: editingPathMaterialId
          ? "fileRef.updateFileRef"
          : "reviewFileRef.createReviewFileRef"
      });
    }
  }

  function handleEditPathRecord(fileRefId: string) {
    const fileRef = formalPathFileRefById.get(fileRefId);
    if (!fileRef) {
      setPathMaterialError(
        language === "zh-CN" ? "未找到路径记录原始元数据。" : "Path record metadata was not found."
      );
      return;
    }
    setEditingPathMaterialId(fileRef.id);
    setPathMaterialForm({
      title: fileRef.title,
      path: fileRef.path,
      fileType: fileRef.fileType,
      description: fileRef.description ?? ""
    });
    setPathMaterialError("");
    setIsPathRecordsOpen(true);
    setIsPathRecordFormOpen(true);
  }

  async function handleDeletePathRecord(fileRefId: string) {
    const fileRef = formalPathFileRefById.get(fileRefId);
    if (!fileRef) {
      setPathMaterialError(
        language === "zh-CN" ? "未找到路径记录原始元数据。" : "Path record metadata was not found."
      );
      return;
    }
    const preview: OperationImpactPreview = {
      operationId: `review.fileRef.delete:${fileRef.id}`,
      operation: "delete",
      target: {
        type: "fileRef",
        id: fileRef.id,
        title: fileRef.title
      },
      summary: `Delete Review path metadata "${fileRef.title}". The local file will not be read, moved, uploaded, or deleted.`,
      riskLevel: "medium",
      executionKind: "soft-delete",
      isRecoverable: true,
      hasRestoreEntry: true,
      requiresUserConfirmation: true,
      canProceed: true,
      affectedEntityCount: 2,
      affectedItems: [
        {
          entityType: "fileRef",
          entityId: fileRef.id,
          title: fileRef.title,
          description: "Only the SciLoom path record is moved to the recycle area.",
          severity: "warning"
        },
        {
          entityType: "review",
          entityId: fileRef.ownerId,
          title: selectedReview?.title ?? fileRef.ownerId,
          description: "Review path record list will refresh.",
          severity: "info"
        }
      ],
      warnings: [
        "Only the SciLoom path record will be deleted.",
        "The referenced local file will not be read, uploaded, moved, or deleted."
      ],
      blockingReasons: [],
      deepScanPerformed: true,
      confirmLabel: language === "zh-CN" ? "删除路径记录" : "Delete path record",
      cancelLabel: t("cancel")
    };
    const confirmed = await operationConfirm.requestConfirmation(preview);
    if (!confirmed) {
      return;
    }
    try {
      const feedback = await fileRefService.deleteFileRefWithAudit({
        id: fileRef.id,
        title: fileRef.title,
        summary: `Review path metadata "${fileRef.title}" was soft-deleted. The local file was not touched.`,
        relatedEntities: [
          {
            type: "review",
            id: fileRef.ownerId,
            relation: "linked",
            label: selectedReview?.title
          }
        ],
        impactSummary: {
          affectedEntityCount: preview.affectedEntityCount,
          affectedItems: preview.affectedItems,
          warnings: preview.warnings,
          blockingReasons: preview.blockingReasons,
          deepScanPerformed: preview.deepScanPerformed
        },
        refreshKeys: ["fileRef.changed", "review.changed", "reviewContext.changed", "aiContext.changed"]
      });
      feedbackCenter.pushWriteFeedback(feedback);
      if (editingPathMaterialId === fileRef.id) {
        resetPathMaterialForm();
      }
      await reloadCurrentPage();
    } catch (error) {
      console.warn("Failed to delete Review path record.", error);
      feedbackCenter.pushPageFeedback({
        severity: "error",
        title: language === "zh-CN" ? "路径记录删除失败" : "Path record delete failed",
        summary: error instanceof Error ? error.message : String(error),
        operation: "fileRef.deleteFileRefWithAudit"
      });
    }
  }

  function handleLocalFileResult(result: LocalFileResult) {
    const feedback = fileRefService.toFileRefActionFeedback(result);
    if (!feedback) return;
    feedbackCenter.pushPageFeedback({
      severity: feedback.severity,
      title: feedback.message,
      operation: feedback.operation
    });
  }

  function changeReviewProject(projectId: string) {
    setSaveError("");
    setRelationFilters(createDefaultReviewRelationFilters());
    setForm((current) => ({
      ...current,
      projectId,
      routeNodeIds: current.routeNodeIds.filter((routeId) =>
        routes.some((route) => route.id === routeId && route.projectId === projectId)
      ),
      taskIds: current.taskIds.filter((taskId) => {
        const task = tasks.find((item) => item.id === taskId);
        return Boolean(task && task.projectId === projectId);
      }),
      experimentIds: [],
      experimentRunIds: [],
      literatureIds: []
    }));
  }

  function toggleRouteTarget(routeId: string) {
    setSaveError("");
    setForm((current) => {
      const selectedRoute = routes.find((route) => route.id === routeId);
      const nextRouteNodeIds = current.routeNodeIds.includes(routeId)
        ? current.routeNodeIds.filter((targetId) => targetId !== routeId)
        : [...current.routeNodeIds, routeId];
      return {
        ...current,
        projectId: selectedRoute?.projectId || current.projectId,
        routeNodeIds: nextRouteNodeIds,
        taskIds: current.taskIds
      };
    });
  }

  function toggleTaskTarget(taskId: string) {
    setSaveError("");
    setForm((current) => {
      const isSelected = current.taskIds.includes(taskId);
      if (isSelected) {
        return {
          ...current,
          taskIds: current.taskIds.filter((targetId) => targetId !== taskId)
        };
      }
      const task = tasks.find((item) => item.id === taskId);
      const projectId = task?.projectId || current.projectId;
      return {
        ...current,
        projectId,
        routeNodeIds: current.routeNodeIds.filter((routeId) =>
          routes.some((route) => route.id === routeId && route.projectId === projectId)
        ),
        taskIds: [...current.taskIds, taskId]
      };
    });
  }

  function changeReviewType(reviewType: ReviewType) {
    setSaveError("");
    setForm((current) => ({
      ...current,
      reviewType,
      researchTraceDisplayChecked: isStageReviewDefaultDisplayed(reviewType),
      outlineSections: reconcileReviewOutlineSections(
        reviewType,
        current.outlineSections
      )
    }));
  }

  function clearReviewForm() {
    setSaveError("");
    setForm((current) => ({
      ...current,
      title: "",
      description: "",
      periodStart: "",
      periodEnd: "",
      periodLabel: "",
      researchTraceDisplayChecked: isStageReviewDefaultDisplayed(current.reviewType),
      outlineSections: current.outlineSections.map((section) => ({
        ...section,
        content: ""
      }))
    }));
  }

  function updateOutlineSection(key: ReviewOutlineSectionKey, content: string) {
    setForm((current) => ({
      ...current,
      outlineSections: current.outlineSections.map((section) =>
        section.key === key ? { ...section, content } : section
      )
    }));
  }

  function validateReviewForm(nextForm: ReviewFormState): string {
    if (!nextForm.projectId || !projects.some((project) => project.id === nextForm.projectId)) {
      return t("reviewProjectRequired");
    }
    if (isReviewTargetOptionsLoading) {
      return language === "zh-CN"
        ? "复盘对象选项正在加载，请稍候。"
        : "Review target options are still loading.";
    }
    if (reviewTargetOptionsError) {
      return reviewTargetOptionsError;
    }
    const hasPeriodStart = Boolean(nextForm.periodStart);
    const hasPeriodEnd = Boolean(nextForm.periodEnd);
    if (hasPeriodStart !== hasPeriodEnd || (nextForm.periodLabel.trim() && !hasPeriodStart)) {
      return t("reviewPeriodPairRequired");
    }
    if (nextForm.periodStart && nextForm.periodEnd && nextForm.periodStart > nextForm.periodEnd) {
      return t("reviewPeriodOrderInvalid");
    }
    if (nextForm.reviewType === "periodic" && (!hasPeriodStart || !hasPeriodEnd)) {
      return t("reviewPeriodicPeriodRequired");
    }
    const comparisonError = getReviewComparisonValidationMessage(
      nextForm.reviewType,
      nextForm,
      language
    );
    if (comparisonError) {
      return comparisonError;
    }

    const hasInvalidRoute = nextForm.routeNodeIds.some((routeId) =>
      !routes.some((route) => route.id === routeId && route.projectId === nextForm.projectId)
    );
    const hasInvalidTask = nextForm.taskIds.some((taskId) =>
      !tasks.some((task) => task.id === taskId && task.projectId === nextForm.projectId)
    );
    const hasInvalidExperiment = nextForm.experimentIds.some(
      (experimentId) =>
        !reviewTargetOptions.experiments.some((experiment) => experiment.id === experimentId)
    );
    const hasInvalidRun = nextForm.experimentRunIds.some(
      (runId) => !reviewTargetOptions.experimentRuns.some((run) => run.id === runId)
    );
    const hasInvalidLiterature = nextForm.literatureIds.some(
      (literatureId) =>
        !reviewTargetOptions.literatures.some((literature) => literature.id === literatureId)
    );
    return hasInvalidRoute ||
      hasInvalidTask ||
      hasInvalidExperiment ||
      hasInvalidRun ||
      hasInvalidLiterature
      ? language === "zh-CN"
        ? "存在跨课题、已失效或不可关联的复盘对象，请重新选择。"
        : "Some review targets are cross-project, missing, or unavailable. Select them again."
      : "";
  }

  function toggleTargetSection(section: ReviewEditorTargetSectionKey) {
    setExpandedTargetSections((current) => toggleReviewTargetSection(current, section));
  }

  function updateRelationFilter<Key extends ReviewRelationFilterKey>(
    key: Key,
    patch: Partial<ReviewRelationFilters[Key]>
  ) {
    setRelationFilters(
      (current) =>
        ({
          ...current,
          [key]: { ...current[key], ...patch }
        }) as ReviewRelationFilters
    );
  }

  function resetRelationFilter(key: ReviewRelationFilterKey) {
    setRelationFilters((current) => resetReviewRelationFilter(current, key));
  }

  function relationEnumLabel(value: string) {
    if (!value) {
      return language === "zh-CN" ? "全部" : "All";
    }
    if (value === "unrated" || value === "unset") {
      return language === "zh-CN" ? "未设置" : "Not set";
    }
    return nonPlanningEnumLabel(language, value, value);
  }

  function taskStatusFilterLabel(value: ReviewTaskRelationFilter["status"]) {
    if (!value) {
      return language === "zh-CN" ? "全部状态" : "All statuses";
    }
    const labels: Record<Exclude<ReviewTaskRelationFilter["status"], "">, [string, string]> = {
      todo: ["待办", "To do"],
      doing: ["进行中", "In progress"],
      delayed: ["已延期", "Delayed"],
      blocked: ["受阻", "Blocked"],
      done: ["已完成", "Completed"],
      cancelled: ["已取消", "Cancelled"],
      archived: ["已归档", "Archived"]
    };
    return labels[value][language === "zh-CN" ? 0 : 1];
  }

  function routeStatusFilterLabel(value: ReviewRouteRelationFilter["status"]) {
    if (!value) {
      return language === "zh-CN" ? "全部状态" : "All statuses";
    }
    const labels: Partial<
      Record<Exclude<ReviewRouteRelationFilter["status"], "">, [string, string]>
    > = {
      planned: ["计划中", "Planned"],
      in_progress: ["进行中", "In progress"],
      blocked: ["受阻", "Blocked"],
      completed: ["已完成", "Completed"],
      archived: ["已归档", "Archived"]
    };
    const label = labels[value];
    return label ? label[language === "zh-CN" ? 0 : 1] : relationEnumLabel(value);
  }

  function relationTimeFilterLabel(value: ReviewRelationTimeFilter) {
    const labels: Record<ReviewRelationTimeFilter, [string, string]> = {
      all: ["全部时间", "All dates"],
      this_month: ["本月", "This month"],
      this_quarter: ["本季度", "This quarter"],
      unscheduled: ["未排期 / 未记录", "Unscheduled / unrecorded"]
    };
    return labels[value][language === "zh-CN" ? 0 : 1];
  }

  function renderRelationFilterStatus(
    key: ReviewRelationFilterKey,
    selectedIds: string[],
    visibleCount: number,
    totalCount: number
  ) {
    const summary = buildReviewRelationFilterSummary(
      selectedIds,
      visibleCount,
      totalCount
    );
    const filter = relationFilters[key];
    return (
      <div className="review-target-filter-status">
        <span>
          {language === "zh-CN"
            ? `已选 ${summary.selectedCount} 项`
            : `${summary.selectedCount} selected`}
        </span>
        <span>
          {language === "zh-CN"
            ? `显示 ${summary.visibleCount} / 共 ${summary.totalCount} 项`
            : `Showing ${summary.visibleCount} / ${summary.totalCount}`}
        </span>
        <label className="review-target-selected-only">
          <input
            type="checkbox"
            className="review-target-selected-only-checkbox"
            checked={filter.showSelectedOnly}
            onChange={(event) =>
              updateRelationFilter(key, { showSelectedOnly: event.target.checked })
            }
          />
          <span className="review-target-selected-only-text">
            {language === "zh-CN" ? "仅显示已选" : "Selected only"}
          </span>
        </label>
        <button
          type="button"
          className="review-target-filter-reset"
          disabled={!isReviewRelationFilterActive(filter)}
          onClick={() => resetRelationFilter(key)}
        >
          {language === "zh-CN" ? "重置" : "Reset"}
        </button>
      </div>
    );
  }

  function relationEmptyMessage(
    key: ReviewRelationFilterKey,
    totalCount: number,
    defaultMessage: string
  ) {
    if (totalCount === 0) {
      return defaultMessage;
    }
    if (relationFilters[key].showSelectedOnly) {
      return language === "zh-CN" ? "暂无已选对象" : "No selected objects";
    }
    return language === "zh-CN" ? "无匹配对象" : "No matching objects";
  }

  function reviewSaveErrorMessage(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const localized = (zhCN: string, enUS: string) =>
      language === "zh-CN" ? zhCN : enUS;
    const targetContractMessage = mapReviewTargetContractError(error, language);
    if (targetContractMessage) {
      return targetContractMessage;
    }
    if (message.includes("periodStart must not be later than periodEnd")) {
      return t("reviewPeriodOrderInvalid");
    }
    if (
      message.includes("PLANNING_AUTHORITY_PROJECT_") ||
      message.includes("PLANNING_AUTHORITY_OWNER_PROJECT_MISMATCH")
    ) {
      return localized(
        "所属课题不可用，请重新选择或刷新后重试。",
        "The related project is unavailable. Select it again or refresh and retry."
      );
    }
    if (message.includes("projectId") || message.includes("project target")) {
      return t("reviewProjectRequired");
    }
    if (
      message.includes("REPOSITORY_REVISION_STALE") ||
      message.includes("REPOSITORY_EPOCH_MISMATCH") ||
      message.includes("PLANNING_SNAPSHOT_REVISION_STALE") ||
      message.includes("PLANNING_SNAPSHOT_EPOCH_STALE") ||
      message.includes("PLANNING_AUTHORITY_CHANGED")
    ) {
      return localized(
        "复盘数据已发生变化，请刷新后重试。",
        "Review data changed. Refresh and try again."
      );
    }
    if (
      message.includes("PLANNING_REVIEW_TARGET_LINK_") ||
      message.includes("planning-review-target-links-replace")
    ) {
      return localized(
        "复盘主体已保存，但关联对象保存未完成。请刷新后在当前复盘中重试。",
        "The review record was saved, but its related objects were not. Refresh and retry from this review."
      );
    }
    if (message.includes("PROVISIONING_")) {
      return localized(
        "复盘已创建，但文稿初始化未完成，可稍后重试。",
        "The review was created, but manuscript initialization is incomplete. You can retry later."
      );
    }
    if (
      message.includes("PLANNING_AUTHORITY_") ||
      message.includes("AUTHORITY_LEASE_") ||
      message.includes("FILE_REF_OWNER_NOT_FOUND")
    ) {
      return localized(
        "复盘创建条件不可用，请刷新后重试。",
        "Review creation is currently unavailable. Refresh and try again."
      );
    }
    if (
      message.includes("scope contract") ||
      message.includes("target contract") ||
      message.includes("period contract")
    ) {
      return t("reviewInvalidObjects");
    }
    return localized(
      "复盘保存失败，请稍后重试。",
      "The review could not be saved. Try again later."
    );
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaveError("");

    const sanitizedForm = sanitizeReviewForm(form, routes, tasks, reviewTargetOptions);
    const validationError = validateReviewForm(sanitizedForm);
    if (validationError) {
      setForm(sanitizedForm);
      setSaveError(validationError);
      setExpandedTargetSections((current) =>
        expandReviewComparisonTargetSections(current, sanitizedForm.reviewType)
      );
      publishFormalBusinessAttemptFailure(
        editingReviewId ? "planning.updateReview" : "planning.createReviewWithTargets"
      );
      return;
    }

    const input = {
      title: sanitizedForm.title,
      description: sanitizedForm.description.trim() || undefined,
      projectId: sanitizedForm.projectId,
      reviewType: sanitizedForm.reviewType,
      periodStart: sanitizedForm.periodStart || undefined,
      periodEnd: sanitizedForm.periodEnd || undefined,
      periodLabel: sanitizedForm.periodLabel || undefined,
      outlineSections: sanitizedForm.outlineSections,
      targets: buildReviewTargets(sanitizedForm)
    };

    try {
      const wasEditing = Boolean(editingReviewId);
      const saved = editingReviewId
        ? await planningService.updateReview(editingReviewId, input)
        : await planningService.createReviewWithTargets(input);
      if (!saved) {
        throw new Error("Review was not saved.");
      }
      setSelectedProjectId(saved.projectId);
      if (reviewTypeFilter !== "all" && reviewTypeFilter !== saved.reviewType) {
        setReviewTypeFilter("all");
      }
      if (!reviewMatchesTime(saved, timeFilter)) {
        setTimeFilter("all");
      }
      try {
        await saveResearchTraceDisplayPreference({
          projectId: saved.projectId,
          targetType: "review",
          targetId: saved.id,
          defaultDisplayed: isStageReviewDefaultDisplayed(saved.reviewType),
          checked: sanitizedForm.researchTraceDisplayChecked
        });
      } catch (preferenceError) {
        feedbackCenter.consumeWriteError(
          preferenceError,
          "researchTrace.preference.save"
        );
      }
      const transition = completeReviewEditorModalSave(saved.id, emptyForm);
      await loadReviews(transition.selectedReviewId ?? saved.id);
      setSelectedReviewId(transition.selectedReviewId);
      setIsEditorOpen(transition.editor.isOpen);
      setEditorMode(transition.editor.mode);
      setEditingReviewId(transition.editor.editingReviewId);
      setSaveError(transition.editor.saveError);
      setForm(transition.editor.form);
      setExpandedTargetSections(createCollapsedReviewTargetSections());
      setRelationFilters(createDefaultReviewRelationFilters());
      setDetailReloadVersion((current) => current + 1);
      const provisioning = !wasEditing
        ? (saved as CreateReviewResult).provisioning
        : null;
      const provisioningIncomplete =
        provisioning !== null && provisioning.completionState !== "complete";
      feedbackCenter.pushPageFeedback({
        severity: provisioningIncomplete ? "warning" : "success",
        title: provisioningIncomplete
          ? language === "zh-CN"
            ? "复盘已创建，但文稿初始化未完成。"
            : "The review was created, but manuscript initialization is incomplete."
          : wasEditing ? t("editReview") : t("createReview"),
        operation: wasEditing ? "planning.updateReview" : "planning.createReviewWithTargets"
      });
    } catch (error) {
      console.warn("Failed to save Review.", error);
      const saveErrorMessage = reviewSaveErrorMessage(error);
      setSaveError(saveErrorMessage);
      feedbackCenter.pushPageFeedback({
        severity: "error",
        title: saveErrorMessage,
        summary: saveErrorMessage,
        operation: editingReviewId ? "planning.updateReview" : "planning.createReviewWithTargets"
      });
    }
  }

  async function handleDeleteSelectedReview(lifecycleSettled = false) {
    if (!selectedReview) {
      return;
    }
    if (!lifecycleSettled) {
      await sharedEditorLifecycleController.requestSequence({
        trigger: "owner-change",
        continuationIntent: "OWNER_CHANGE",
        surface: "application",
        continuation: () => handleDeleteSelectedReview(true)
      });
      return;
    }
    try {
      const preview = await reviewDeleteSafetyService.getReviewDeleteImpactPreview(
        selectedReview.id,
        "soft_delete"
      );
      const confirmed = await operationConfirm.requestConfirmation(preview);
      if (!confirmed) {
        return;
      }
      const feedback = await reviewDeleteSafetyService.softDeleteReview(selectedReview.id, {
        confirmedByUser: true
      });
      feedbackCenter.pushWriteFeedback({
        ...feedback,
        messages: feedback.status === "success"
          ? [{ message: t("reviewSoftDeleteSuccess"), severity: "success" }]
          : feedback.messages
      });
      if (feedback.status !== "success" && feedback.status !== "partial") {
        return;
      }
      setSelectedReviewId(null);
      clearSelectedReviewDetailState();
      closeEditor();
      await loadPageData();
    } catch (error) {
      console.warn("Failed to delete Review.", error);
      const reason = classifyReviewLifecycleError(error);
      const summary = reason === "planning_unavailable"
        ? t("reviewLifecyclePlanningUnavailable")
        : reason === "state_changed"
          ? t("reviewLifecycleStateChanged")
          : t("reviewLifecycleAuthorityUnavailable");
      feedbackCenter.pushPageFeedback({
        severity: "error",
        title: t("reviewSoftDeleteFailed"),
        summary,
        operation: "review.softDelete"
      });
    }
  }

  function reviewDisplayTitle(review: Review | ReviewCatalogEntry) {
    const summaryLead = ("outlineSections" in review ? review.outlineSections : [])
      .find((section) => section.content.trim())
      ?.content.split(/[。.!?\n]/)[0]
      ?.trim();
    return review.title.trim() || review.periodLabel?.trim() || summaryLead || review.id || review.createdAt || t("reviewUntitled");
  }

  function reviewLastModifiedDate(review: Review | ReviewCatalogEntry) {
    return (review.updatedAt || review.createdAt || reviewReferenceDate(review)).slice(0, 10);
  }

  function toggleTargetId(
    field: "experimentIds" | "experimentRunIds" | "literatureIds",
    targetId: string
  ) {
    setSaveError("");
    setForm((current) => ({
      ...current,
      [field]: current[field].includes(targetId)
        ? current[field].filter((id) => id !== targetId)
        : [...current[field], targetId]
    }));
  }

  function formalObjectLabel(targetType: ReviewFormalObjectType) {
    if (targetType === "routeNode") {
      return t("reviewRelatedRoutes");
    }
    if (targetType === "task") {
      return t("reviewRelatedTasks");
    }
    if (targetType === "experiment") {
      return t("reviewRelatedExperiments");
    }
    if (targetType === "experimentRun") {
      return language === "zh-CN" ? "实验 Run" : "Experiment runs";
    }
    return t("reviewRelatedLiterature");
  }

  function renderFormalObjectSection() {
    return (
      <details className="review-detail-section review-formal-objects-section">
        <summary>
          <span>{t("reviewObjects")}</span>
          <span className="review-formal-object-counts">
            {formalObjectCard.countItems.map((targetType) => (
              <span key={targetType}>
                {formalObjectLabel(targetType)} {formalObjectCard.counts[targetType]}
              </span>
            ))}
          </span>
        </summary>
        {isTargetLinksLoading ? (
          <p className="review-content-empty">{t("reviewObjectsLoading")}</p>
        ) : null}
        <div className="review-formal-object-groups">
          {formalObjectCard.countItems.map((targetType) => {
            const items = formalObjectGroups[targetType];
            return (
              <section className="review-object-group" key={targetType}>
                <h3>{formalObjectLabel(targetType)}</h3>
                {items.length > 0 ? (
                  <ul className="review-object-list">
                    {items.map((item) => (
                      <li key={`${item.targetType}:${item.id}`}>
                        <span>{item.title}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="review-content-empty">{t("reviewNoRelations")}</p>
                )}
              </section>
            );
          })}
        </div>
      </details>
    );
  }

  function renderFormalSummarySection() {
    return (
      <section className="review-detail-section review-content-section">
        <StructuredSummaryDisplay
          fields={formalSummaryCard.sections}
          emptyText={t("reviewNoContent")}
          className="review-content-section-body"
        />
        <div className="review-summary-actions">
          <button
            type="button"
            onClick={() => void openReviewOutputGeneration()}
            disabled={isSelectedReviewBlocked || isTargetLinksLoading}
          >
            {t("reviewGenerateResultFromReview")}
          </button>
          {formalSummaryCard.actions.map((action) =>
            action.id === "aiAnalysis" ? (
              selectedReview ? (
                <ReviewQuickAnalysisButton
                  key={action.id}
                  disabled={isSelectedReviewBlocked}
                  projectId={selectedReview.projectId}
                  reviewId={selectedReview.id}
                  reviewTitle={selectedReview.title}
                />
              ) : (
                <button disabled key={action.id} type="button">AI分析</button>
              )
            ) : (
              <button
                type="button"
                key={action.id}
                onClick={openReviewManuscript}
                disabled={
                  isSelectedReviewBlocked ||
                  manuscriptEditor.busy ||
                  !manuscriptEditor.pageState?.canOpenCurrent
                }
              >
                {action.label}
              </button>
            )
          )}
        </div>
        {manuscriptEditor.pageState?.issue ? (
          <div
            className="review-provisioning-issue"
            data-review-provisioning-issue={manuscriptEditor.pageState.issue.code}
          >
            <p className="review-content-empty">
              {manuscriptEditor.pageState.canRetryProvisioning
                ? language === "zh-CN"
                  ? "复盘文稿尚未准备完成，可以重试恢复已有文件与文稿身份。"
                  : "The Review manuscript is not ready. Retry can recover the existing file and manuscript identity."
                : manuscriptEditor.pageState.warning}
            </p>
            {manuscriptEditor.pageState.canRetryProvisioning ? (
              <button
                type="button"
                onClick={() => void manuscriptEditor.retryProvisioning()}
                disabled={manuscriptEditor.busy || isSelectedReviewBlocked}
              >
                {language === "zh-CN" ? "重试准备文稿" : "Retry manuscript setup"}
              </button>
            ) : null}
          </div>
        ) : null}
      </section>
    );
  }

  function renderPathRecordsSection() {
    return (
      <section className="review-detail-section review-path-records-section">
        <div className="file-ref-panel-header review-path-records-header">
          <button
            type="button"
            className="file-ref-panel-toggle"
            aria-expanded={isPathRecordsOpen}
            onClick={() => setIsPathRecordsOpen((current) => !current)}
          >
            <span className="file-ref-panel-toggle-icon" aria-hidden="true">
              {isPathRecordsOpen ? "v" : ">"}
            </span>
            <span>{formalPathSection.title}</span>
          </button>
          {!isPathRecordFormOpen ? (
            <button
              type="button"
              className="file-ref-panel-add-button"
              onClick={startCreatePathRecord}
              disabled={isSelectedReviewBlocked}
            >
              {formalPathSection.addAction.label}
            </button>
          ) : null}
        </div>
        {isPathRecordsOpen ? (
          <div className="review-path-records-body">
            {manuscriptEditor.pageState?.workspaceFolder || formalPathRecordViews.length ? (
              <div className="review-path-record-list">
                {manuscriptEditor.pageState?.workspaceFolder ? (
                  <article className="review-path-record-card review-workspace-path-card">
                    <div className="file-ref-item-heading">
                      <strong>{ui("工作目录")}</strong>
                      <span title={manuscriptEditor.pageState.workspaceFolder.path}>
                        <strong>{language === "zh-CN" ? "路径摘要" : "Path summary"}：</strong>
                        {summarizeFileRefPath(manuscriptEditor.pageState.workspaceFolder.path)}
                      </span>
                    </div>
                    <div className="file-ref-item-actions">
                      <FileRefPathActions
                        path={manuscriptEditor.pageState.workspaceFolder.path}
                        resourceKind="folder"
                        openKind="folder"
                        disabled={manuscriptEditor.busy}
                        labels={{
                          open: ui("打开"),
                          reveal: ui("打开文件夹"),
                          copy: ui("复制路径")
                        }}
                        onResult={handleLocalFileResult}
                      />
                    </div>
                  </article>
                ) : null}
                {formalPathRecordViews.map((item) => {
                  const fileRef = formalPathFileRefById.get(item.fileRefId);
                  const pathAction = buildReviewPathOpenActionModel(fileRef, item.pathSummary, {
                    resolveFileRefOpenKind: fileRefService.resolveFileRefOpenKind,
                    isWindowsFileFallbackEligible: fileRefService.isWindowsFileFallbackEligible
                  });
                  return (
                    <article className="review-path-record-card" key={item.fileRefId}>
                      <div className="file-ref-item-heading">
                        <strong>{item.title}</strong>
                        <span>
                          <strong>{language === "zh-CN" ? "路径摘要" : "Path summary"}：</strong>
                          {item.pathSummary}
                        </span>
                      </div>
                      {item.notes ? <p className="review-path-record-note">{item.notes}</p> : null}
                      <div className="file-ref-item-actions">
                        <FileRefPathActions
                          path={pathAction.actionPath}
                          resourceKind={fileRef?.resourceKind}
                          openKind={pathAction.openKind}
                          disabled={!pathAction.actionPath}
                          labels={{
                            open: item.actions[0].label,
                            reveal: item.actions[1].label,
                            copy: item.actions[2].label
                          }}
                          onResult={handleLocalFileResult}
                        />
                        <button type="button" onClick={() => handleEditPathRecord(item.fileRefId)}>
                          {item.actions[3].label}
                        </button>
                        <button
                          type="button"
                          className="danger-button"
                          onClick={() => void handleDeletePathRecord(item.fileRefId)}
                        >
                          {item.actions[4].label}
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <div className="review-path-workspace-missing">
                <p className="review-content-empty">
                  {manuscriptEditor.pageState?.warning ??
                    (language === "zh-CN" ? "工作目录尚未就绪" : "Workspace is not ready")}
                </p>
              </div>
            )}
            {isPathRecordFormOpen ? (
              <section className="review-path-record-form">
                <h3>
                  {editingPathMaterialId
                    ? language === "zh-CN" ? "编辑路径记录" : "Edit path record"
                    : formalPathSection.addAction.label}
                </h3>
                <label>
                  {formalPathForm.fields[0].label}
                  <input
                    value={pathMaterialForm.title}
                    onChange={(event) =>
                      setPathMaterialForm({ ...pathMaterialForm, title: event.target.value })
                    }
                    placeholder={
                      language === "zh-CN"
                        ? "可选；留空时使用路径尾部名称"
                        : "Optional; uses the final path segment when blank"
                    }
                  />
                </label>
                <label>
                  {formalPathForm.fields[1].label}
                  <div className="file-ref-path-input-row">
                    <input
                      value={pathMaterialForm.path}
                      onChange={(event) =>
                        setPathMaterialForm({ ...pathMaterialForm, path: event.target.value })
                      }
                      placeholder={
                        language === "zh-CN"
                          ? "手动输入文件或文件夹路径"
                          : "Enter a file or folder path"
                      }
                    />
                    <FileRefPathPicker
                      disabled={isSelectedReviewBlocked}
                      labels={{
                        selectFile: language === "zh-CN" ? "选择文件" : "Select file",
                        selectFolder: language === "zh-CN" ? "选择文件夹" : "Select folder"
                      }}
                      onResult={(result) => {
                        if (result.status === "success" && result.path) {
                          setPathMaterialForm((current) => ({
                            ...current,
                            path: result.path ?? current.path,
                            fileType:
                              result.actionType === "select_folder"
                                ? "data_folder"
                                : result.actionType === "select_file"
                                  ? "other"
                                  : current.fileType
                          }));
                        }
                        handleLocalFileResult(result);
                      }}
                    />
                  </div>
                </label>
                <label>
                  {formalPathForm.fields[2].label}
                  <textarea
                    rows={3}
                    value={pathMaterialForm.description}
                    onChange={(event) =>
                      setPathMaterialForm({
                        ...pathMaterialForm,
                        description: event.target.value
                      })
                    }
                  />
                </label>
                {pathMaterialError ? (
                  <p className="review-save-error">{pathMaterialError}</p>
                ) : null}
                <div className="reviews-detail-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => void handleSavePathRecord()}
                    disabled={isSelectedReviewBlocked}
                  >
                    {editingPathMaterialId
                      ? language === "zh-CN" ? "保存路径记录" : "Save path record"
                      : formalPathForm.actions[0].label}
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={resetPathMaterialForm}
                  >
                    {formalPathForm.actions[1].label}
                  </button>
                </div>
              </section>
            ) : null}
          </div>
        ) : null}
      </section>
    );
  }

  function renderEditor() {
    return (
      <form id="review-editor-form" className="review-editor-panel reviews-editor-scroll" onSubmit={handleSave}>
        {saveError ? (
          <p className="review-save-error" role="alert">
            {saveError}
          </p>
        ) : null}
        <section className="review-form-section">
          <div className="review-form-section-heading">
            <h3>{t("reviewBasicInformation")}</h3>
          </div>
          <div className="form-row">
            <label>
              {t("reviewTitle")}
              <input
                value={form.title}
                onChange={(event) => setForm({ ...form, title: event.target.value })}
                required
              />
            </label>
            <label>
              {t("reviewFormType")}
              <select
                value={form.reviewType}
                onChange={(event) => changeReviewType(event.target.value as ReviewType)}
              >
                <option value="stage">{reviewTypeLabels.stage}</option>
                <option value="periodic">{reviewTypeLabels.periodic}</option>
                <option value="experiment_comparison">
                  {reviewTypeLabels.experiment_comparison}
                </option>
                <option value="literature_comparison">
                  {reviewTypeLabels.literature_comparison}
                </option>
                <option value="custom">{reviewTypeLabels.custom}</option>
              </select>
            </label>
          </div>

          <div className="form-row">
            <label>
              {t("periodLabel")} {t("optional")}
              <input
                value={form.periodLabel}
                onChange={(event) => setForm({ ...form, periodLabel: event.target.value })}
              />
            </label>
            <label>
              {t("periodStart")} {form.reviewType === "periodic" ? "" : t("optional")}
              <input
                type="date"
                value={form.periodStart}
                onChange={(event) => setForm({ ...form, periodStart: event.target.value })}
              />
            </label>
            <label>
              {t("periodEnd")} {form.reviewType === "periodic" ? "" : t("optional")}
              <input
                type="date"
                value={form.periodEnd}
                onChange={(event) => setForm({ ...form, periodEnd: event.target.value })}
              />
            </label>
          </div>
          <label>
            {t("reviewRelatedProject")}
            <select
              value={form.projectId}
              onChange={(event) => changeReviewProject(event.target.value)}
              required
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <label className="review-description-field">
            {language === "zh-CN" ? "简要说明" : "Brief description"} {t("optional")}
            <textarea
              className="semantic-textarea-compact-summary"
              rows={2}
              value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
            />
          </label>
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
        </section>

        <section className="review-form-section">
          <div className="review-form-section-heading">
            <h3>{t("reviewObjectsAndRelations")}</h3>
          </div>

          <div className="review-target-layout">
            <section className="review-target-editor">
              <button
                type="button"
                className="review-target-section-toggle"
                aria-expanded={expandedTargetSections.routeNode}
                onClick={() => toggleTargetSection("routeNode")}
              >
                <span>{language === "zh-CN" ? "关联路线" : "Related routes"}</span>
                <span aria-hidden="true">{expandedTargetSections.routeNode ? "v" : ">"}</span>
              </button>
              {expandedTargetSections.routeNode ? (
                <div className="review-target-filter-body">
                  <div className="review-target-filter-row">
                    <label>
                      <span>{language === "zh-CN" ? "状态" : "Status"}</span>
                      <select
                        value={relationFilters.routeNode.status}
                        onChange={(event) =>
                          updateRelationFilter("routeNode", {
                            status: event.target.value as ReviewRouteRelationFilter["status"]
                          })
                        }
                      >
                        {ROUTE_FILTER_STATUSES.map((status) => (
                          <option key={status || "all"} value={status}>
                            {routeStatusFilterLabel(status)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>{language === "zh-CN" ? "计划时间" : "Planned date"}</span>
                      <select
                        value={relationFilters.routeNode.time}
                        onChange={(event) =>
                          updateRelationFilter("routeNode", {
                            time: event.target.value as ReviewRelationTimeFilter
                          })
                        }
                      >
                        {RELATION_TIME_FILTERS.map((time) => (
                          <option key={time} value={time}>
                            {relationTimeFilterLabel(time)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>{language === "zh-CN" ? "关键词" : "Keyword"}</span>
                      <input
                        value={relationFilters.routeNode.keyword}
                        onChange={(event) =>
                          updateRelationFilter("routeNode", {
                            keyword: event.target.value
                          })
                        }
                        placeholder={language === "zh-CN" ? "标题或说明" : "Title or description"}
                      />
                    </label>
                  </div>
                  {renderRelationFilterStatus(
                    "routeNode",
                    form.routeNodeIds,
                    visibleRouteOptions.length,
                    projectRoutes.length,
                  )}
                  <div className="review-target-options">
                    {visibleRouteOptions.map((route) => (
                      <label key={route.id}>
                        <input
                          type="checkbox"
                          checked={form.routeNodeIds.includes(route.id)}
                          onChange={() => toggleRouteTarget(route.id)}
                        />
                        {route.title}
                      </label>
                    ))}
                    {visibleRouteOptions.length === 0 ? (
                      <p>
                        {relationEmptyMessage(
                          "routeNode",
                          projectRoutes.length,
                          t("reviewNoRoutes")
                        )}
                      </p>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </section>

            <section className="review-target-editor">
              <button
                type="button"
                className="review-target-section-toggle"
                aria-expanded={expandedTargetSections.task}
                onClick={() => toggleTargetSection("task")}
              >
                <span>{language === "zh-CN" ? "关联任务" : "Related tasks"}</span>
                <span aria-hidden="true">{expandedTargetSections.task ? "v" : ">"}</span>
              </button>
              {expandedTargetSections.task ? (
                <div className="review-target-filter-body">
                  <div className="review-target-filter-row">
                    <label>
                      <span>{language === "zh-CN" ? "状态" : "Status"}</span>
                      <select
                        value={relationFilters.task.status}
                        onChange={(event) =>
                          updateRelationFilter("task", {
                            status: event.target.value as ReviewTaskRelationFilter["status"]
                          })
                        }
                      >
                        {TASK_FILTER_STATUSES.map((status) => (
                          <option key={status || "all"} value={status}>
                            {taskStatusFilterLabel(status)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>{language === "zh-CN" ? "计划 / 截止时间" : "Planned / due date"}</span>
                      <select
                        value={relationFilters.task.time}
                        onChange={(event) =>
                          updateRelationFilter("task", {
                            time: event.target.value as ReviewRelationTimeFilter
                          })
                        }
                      >
                        {RELATION_TIME_FILTERS.map((time) => (
                          <option key={time} value={time}>
                            {relationTimeFilterLabel(time)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>{language === "zh-CN" ? "优先级" : "Priority"}</span>
                      <select
                        value={relationFilters.task.priority}
                        onChange={(event) =>
                          updateRelationFilter("task", {
                            priority: event.target.value as ReviewTaskRelationFilter["priority"]
                          })
                        }
                      >
                        <option value="">{language === "zh-CN" ? "全部优先级" : "All priorities"}</option>
                        {(["high", "medium", "low"] as const).map((priority) => (
                          <option key={priority} value={priority}>
                            {priorityLabel(priority, t)}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  {renderRelationFilterStatus(
                    "task",
                    form.taskIds,
                    visibleTaskOptions.length,
                    routeScopedTargetTasks.length,
                  )}
                  <div className="review-target-options">
                    {visibleTaskOptions.map((task) => {
                      const parentRoute = routes.find((route) => route.id === taskRouteId(task));
                      return (
                        <label key={task.id}>
                          <input
                            type="checkbox"
                            checked={form.taskIds.includes(task.id)}
                            onChange={() => toggleTaskTarget(task.id)}
                          />
                          <span className="review-target-option-copy">
                            <span>{task.title}</span>
                            <small>
                              {t("reviewTaskDerivedRoute")}:{" "}
                              {parentRoute?.title || t("reviewNoRelations")}
                            </small>
                          </span>
                        </label>
                      );
                    })}
                    {visibleTaskOptions.length === 0 ? (
                      <p>
                        {relationEmptyMessage(
                          "task",
                          routeScopedTargetTasks.length,
                          t("reviewNoTasks")
                        )}
                      </p>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </section>

            <section className="review-target-editor">
              <button
                type="button"
                className="review-target-section-toggle"
                aria-expanded={expandedTargetSections.experiment}
                onClick={() => toggleTargetSection("experiment")}
              >
                <span>{language === "zh-CN" ? "关联实验" : "Related experiments"}</span>
                <span aria-hidden="true">{expandedTargetSections.experiment ? "v" : ">"}</span>
              </button>
              {expandedTargetSections.experiment ? (
                <div className="review-target-filter-body">
                  <div className="review-target-filter-row">
                    <label>
                      <span>{language === "zh-CN" ? "状态" : "Status"}</span>
                      <select
                        value={relationFilters.experiment.status}
                        onChange={(event) =>
                          updateRelationFilter("experiment", {
                            status: event.target.value as ReviewExperimentRelationFilter["status"]
                          })
                        }
                      >
                        {EXPERIMENT_FILTER_STATUSES.map((status) => (
                          <option key={status || "all"} value={status}>
                            {status
                              ? relationEnumLabel(status)
                              : language === "zh-CN" ? "全部状态" : "All statuses"}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>{language === "zh-CN" ? "评级" : "Rating"}</span>
                      <select
                        value={relationFilters.experiment.rating}
                        onChange={(event) =>
                          updateRelationFilter("experiment", {
                            rating: event.target.value as ReviewExperimentRelationFilter["rating"]
                          })
                        }
                      >
                        {EXPERIMENT_FILTER_RATINGS.map((rating) => (
                          <option key={rating || "all"} value={rating}>
                            {rating
                              ? relationEnumLabel(rating)
                              : language === "zh-CN" ? "全部评级" : "All ratings"}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>{language === "zh-CN" ? "标签" : "Tag"}</span>
                      <select
                        value={relationFilters.experiment.tag}
                        onChange={(event) =>
                          updateRelationFilter("experiment", { tag: event.target.value })
                        }
                      >
                        <option value="">{language === "zh-CN" ? "全部标签" : "All tags"}</option>
                        {experimentTagOptions.map((tag) => (
                          <option key={tag} value={tag}>{tag}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                  {renderRelationFilterStatus(
                    "experiment",
                    form.experimentIds,
                    visibleExperimentOptions.length,
                    reviewTargetOptions.experiments.length,
                  )}
                  <div className="review-target-options">
                    {visibleExperimentOptions.map((experiment) => (
                      <label key={experiment.id}>
                        <input
                          type="checkbox"
                          checked={form.experimentIds.includes(experiment.id)}
                          onChange={() => toggleTargetId("experimentIds", experiment.id)}
                        />
                        <span className="review-target-option-copy">
                          <span>{experiment.title}</span>
                          <small>
                            {relationEnumLabel(experiment.status)}
                            {experiment.rating
                              ? ` · ${relationEnumLabel(experiment.rating)}`
                              : ""}
                          </small>
                        </span>
                      </label>
                    ))}
                    {!isReviewTargetOptionsLoading && visibleExperimentOptions.length === 0 ? (
                      <p>
                        {relationEmptyMessage(
                          "experiment",
                          reviewTargetOptions.experiments.length,
                          language === "zh-CN"
                            ? "暂无可关联实验"
                            : "No related experiments available"
                        )}
                      </p>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </section>

            <section className="review-target-editor">
              <button
                type="button"
                className="review-target-section-toggle"
                aria-expanded={expandedTargetSections.experimentRun}
                onClick={() => toggleTargetSection("experimentRun")}
              >
                <span>{language === "zh-CN" ? "关联 Run" : "Related runs"}</span>
                <span aria-hidden="true">{expandedTargetSections.experimentRun ? "v" : ">"}</span>
              </button>
              {expandedTargetSections.experimentRun ? (
                <div className="review-target-filter-body">
                  <div className="review-target-filter-row">
                    <label>
                      <span>{language === "zh-CN" ? "状态" : "Status"}</span>
                      <select
                        value={relationFilters.experimentRun.status}
                        onChange={(event) =>
                          updateRelationFilter("experimentRun", {
                            status: event.target.value as ReviewRunRelationFilter["status"]
                          })
                        }
                      >
                        {RUN_FILTER_STATUSES.map((status) => (
                          <option key={status || "all"} value={status}>
                            {status
                              ? relationEnumLabel(status)
                              : language === "zh-CN" ? "全部状态" : "All statuses"}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>{language === "zh-CN" ? "运行时间" : "Run date"}</span>
                      <select
                        value={relationFilters.experimentRun.time}
                        onChange={(event) =>
                          updateRelationFilter("experimentRun", {
                            time: event.target.value as ReviewRelationTimeFilter
                          })
                        }
                      >
                        {RELATION_TIME_FILTERS.map((time) => (
                          <option key={time} value={time}>
                            {relationTimeFilterLabel(time)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>{language === "zh-CN" ? "标签" : "Tag"}</span>
                      <select
                        value={relationFilters.experimentRun.tag}
                        onChange={(event) =>
                          updateRelationFilter("experimentRun", { tag: event.target.value })
                        }
                      >
                        <option value="">{language === "zh-CN" ? "全部标签" : "All tags"}</option>
                        {runTagOptions.map((tag) => (
                          <option key={tag} value={tag}>{tag}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                  {renderRelationFilterStatus(
                    "experimentRun",
                    form.experimentRunIds,
                    visibleRunOptions.length,
                    reviewTargetOptions.experimentRuns.length,
                  )}
                  <div className="review-target-options">
                    {visibleRunOptions.map((run) => (
                      <label key={run.id}>
                        <input
                          type="checkbox"
                          checked={form.experimentRunIds.includes(run.id)}
                          onChange={() => toggleTargetId("experimentRunIds", run.id)}
                        />
                        <span className="review-target-option-copy">
                          <span>{run.title || run.runLabel || run.id}</span>
                          <small>
                            {language === "zh-CN" ? "所属实验" : "Experiment"}:{" "}
                            {targetExperimentById.get(run.experimentId)?.title || run.experimentId}
                          </small>
                        </span>
                      </label>
                    ))}
                    {!isReviewTargetOptionsLoading && visibleRunOptions.length === 0 ? (
                      <p>
                        {relationEmptyMessage(
                          "experimentRun",
                          reviewTargetOptions.experimentRuns.length,
                          language === "zh-CN"
                            ? "暂无可关联 Run"
                            : "No related runs available"
                        )}
                      </p>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </section>

            <section className="review-target-editor">
              <button
                type="button"
                className="review-target-section-toggle"
                aria-expanded={expandedTargetSections.literature}
                onClick={() => toggleTargetSection("literature")}
              >
                <span>{language === "zh-CN" ? "关联文献" : "Related literature"}</span>
                <span aria-hidden="true">{expandedTargetSections.literature ? "v" : ">"}</span>
              </button>
              {expandedTargetSections.literature ? (
                <div className="review-target-filter-body">
                  <div className="review-target-filter-row">
                    <label>
                      <span>{language === "zh-CN" ? "阅读状态" : "Reading status"}</span>
                      <select
                        value={relationFilters.literature.readingStatus}
                        onChange={(event) =>
                          updateRelationFilter("literature", {
                            readingStatus:
                              event.target.value as ReviewLiteratureRelationFilter["readingStatus"]
                          })
                        }
                      >
                        {LITERATURE_FILTER_READING_STATUSES.map((status) => (
                          <option key={status || "all"} value={status}>
                            {status
                              ? relationEnumLabel(status)
                              : language === "zh-CN" ? "全部状态" : "All statuses"}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>{language === "zh-CN" ? "重要性" : "Importance"}</span>
                      <select
                        value={relationFilters.literature.importance}
                        onChange={(event) =>
                          updateRelationFilter("literature", {
                            importance:
                              event.target.value as ReviewLiteratureRelationFilter["importance"]
                          })
                        }
                      >
                        {LITERATURE_FILTER_IMPORTANCE.map((importance) => (
                          <option key={importance || "all"} value={importance}>
                            {importance
                              ? relationEnumLabel(importance)
                              : language === "zh-CN" ? "全部重要性" : "All importance"}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>{language === "zh-CN" ? "关键词" : "Keyword"}</span>
                      <input
                        value={relationFilters.literature.keyword}
                        onChange={(event) =>
                          updateRelationFilter("literature", {
                            keyword: event.target.value
                          })
                        }
                        placeholder={
                          language === "zh-CN"
                            ? "标题、作者或关键词"
                            : "Title, author, or keyword"
                        }
                      />
                    </label>
                  </div>
                  {renderRelationFilterStatus(
                    "literature",
                    form.literatureIds,
                    visibleLiteratureOptions.length,
                    reviewTargetOptions.literatures.length,
                  )}
                  <div className="review-target-options">
                    {visibleLiteratureOptions.map((literature) => {
                      const authorText = literature.authors
                        .map((author) => author.name)
                        .filter(Boolean)
                        .slice(0, 2)
                        .join(", ");
                      return (
                        <label key={literature.id}>
                          <input
                            type="checkbox"
                            checked={form.literatureIds.includes(literature.id)}
                            onChange={() => toggleTargetId("literatureIds", literature.id)}
                          />
                          <span className="review-target-option-copy">
                            <span>{literature.title}</span>
                            {authorText || literature.year ? (
                              <small>
                                {[authorText, literature.year].filter(Boolean).join(" · ")}
                                {literature.isArchived
                                  ? language === "zh-CN" ? " · 已归档" : " · Archived"
                                  : ""}
                              </small>
                            ) : literature.isArchived ? (
                              <small>{language === "zh-CN" ? "已归档" : "Archived"}</small>
                            ) : null}
                          </span>
                        </label>
                      );
                    })}
                    {!isReviewTargetOptionsLoading &&
                    visibleLiteratureOptions.length === 0 ? (
                      <p>
                        {relationEmptyMessage(
                          "literature",
                          reviewTargetOptions.literatures.length,
                          language === "zh-CN"
                            ? "暂无可关联文献"
                            : "No related literature available"
                        )}
                      </p>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </section>
          </div>
          {isReviewTargetOptionsLoading ? (
            <p className="review-target-helper">
              {language === "zh-CN" ? "正在加载实验、Run 与文献…" : "Loading experiments, runs, and literature…"}
            </p>
          ) : null}
          {reviewTargetOptionsError ? (
            <p className="review-save-error" role="alert">{reviewTargetOptionsError}</p>
          ) : null}
        </section>

        <section className="review-form-section">
          <div className="review-form-section-heading">
            <h3>{t("reviewContent")}</h3>
          </div>
          <StructuredEditFieldGrid className="review-editor-text-list">
            {form.outlineSections.map((section) => (
              <label key={section.key}>
                {outlineLabels[section.key]}
                <textarea
                  value={section.content}
                  onChange={(event) => updateOutlineSection(section.key, event.target.value)}
                />
              </label>
            ))}
          </StructuredEditFieldGrid>
        </section>

      </form>
    );
  }

  return (
    <section className="page-section reviews-page">
      <PageHeader title={t("reviews")} description={t("reviewsDescription")} />
      <WriteFeedbackPanel
        entries={feedbackCenter.entries}
        onDismiss={feedbackCenter.dismissFeedback}
        presentation="primary-page"
      />

      <section className="review-filter-panel" aria-label={t("reviewFilterSummary")}>
        <div className="review-filter-stack">
          <label className="review-project-row project-context-selector">
            <span className="project-context-selector__label">{t("project")}</span>
            <select
              className="project-context-selector__control"
              value={selectedProjectId}
              onChange={(event) => {
                const projectId = event.target.value;
                writeSharedCurrentProjectSelection(projectId);
                setSelectedProjectId(projectId);
              }}
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <div className="review-filter-inline-row">
            <label className="review-filter-inline-field">
              <span>{t("reviewFormType")}</span>
              <select
                value={reviewTypeFilter}
                onChange={(event) =>
                  setReviewTypeFilter(event.target.value as ReviewTypeFilter)
                }
              >
                <option value="all">{t("allReviews")}</option>
                <option value="stage">{reviewTypeLabels.stage}</option>
                <option value="periodic">{reviewTypeLabels.periodic}</option>
                <option value="experiment_comparison">
                  {reviewTypeLabels.experiment_comparison}
                </option>
                <option value="literature_comparison">
                  {reviewTypeLabels.literature_comparison}
                </option>
                <option value="custom">{reviewTypeLabels.custom}</option>
              </select>
            </label>
            <label className="review-filter-inline-field">
              <span>{t("reviewTimeRange")}</span>
              <select
                value={timeFilter}
                onChange={(event) => setTimeFilter(event.target.value as ReviewTimeFilter)}
              >
                <option value="this_week">{t("thisWeek")}</option>
                <option value="this_month">{t("thisMonth")}</option>
                <option value="last_30_days">{t("last30Days")}</option>
                <option value="this_quarter">{t("reviewThisQuarter")}</option>
                <option value="all">{t("allTime")}</option>
              </select>
            </label>
          </div>
        </div>
      </section>

      <section className="reviews-workspace-shell">
        <header className="reviews-workspace-header">
          <div className="reviews-workspace-title">
            <h2>{t("reviewList")}</h2>
            <span>{filteredReviews.length}</span>
          </div>
          <button
            type="button"
            className="reviews-workspace-action primary-page-action primary-page-action--primary"
            onClick={openCreateEditor}
            disabled={projects.length === 0}
          >
            {t("reviewCreateShort")}
          </button>
        </header>

        <div className="reviews-workspace-body">
          <aside className="reviews-record-column">
          {filteredReviews.length > 0 ? (
            <div className="reviews-record-list">
              {filteredReviews.map((review) => (
                <button
                  type="button"
                  className={review.id === selectedReviewId ? "reviews-record-card is-active" : "reviews-record-card"}
                  key={review.id}
                  onClick={() => void selectReview(review.id)}
                >
                  <strong>{reviewDisplayTitle(review)}</strong>
                  <span>
                    {review.reviewType
                      ? reviewTypeLabels[review.reviewType]
                      : language === "zh-CN"
                        ? "结构化状态不可用"
                        : "Structured state unavailable"}{" \u00b7 "}{reviewLastModifiedDate(review)}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className="review-content-empty">{t("reviewEmptyTitle")}</p>
          )}
          </aside>

          <main className="reviews-detail-column">
          {selectedReview ? (
            <>
              <div className="reviews-detail-heading">
                <div>
                  <h2>{reviewDisplayTitle(selectedReview)}</h2>
                  {selectedReview.description?.trim() ? (
                    <p className="reviews-detail-description">
                      {selectedReview.description.trim()}
                    </p>
                  ) : null}
                </div>
                <div className="reviews-detail-actions">
                  {getReviewFormalDetailHeaderActions().includes("edit") ? (
                    <button
                      type="button"
                      className="secondary-button primary-page-action primary-page-action--secondary"
                      onClick={openEditEditor}
                      disabled={isTargetLinksLoading}
                    >
                      {t("edit")}
                    </button>
                  ) : null}
                </div>
              </div>

              <div className="reviews-detail-body">
                {renderFormalObjectSection()}
                {renderFormalSummarySection()}
                {renderPathRecordsSection()}
              </div>
            </>
          ) : (
            <p className="review-content-empty review-content-empty-state">{t("reviewSelectTitle")}</p>
          )}
          </main>
        </div>
      </section>

      {isEditorOpen ? (
        <div className="review-editor-modal-backdrop">
          <section
            className="review-editor-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="review-editor-modal-title"
          >
            <header className="review-editor-modal-header">
              <h2 id="review-editor-modal-title">
                {getReviewEditorModalTitle(editorMode, {
                  create: t("createReview"),
                  edit: t("editReview")
                })}
              </h2>
              <button
                type="button"
                className="review-editor-modal-close"
                onClick={closeEditor}
                aria-label={t("cancel")}
              >
                ×
              </button>
            </header>
            <div className="review-editor-modal-body">{renderEditor()}</div>
            <DataClearFooterRow
              className="review-editor-modal-footer"
              contextKey={`review:${editorMode ?? "closed"}:${editingReviewId ?? "new"}:${form.reviewType}`}
              regionLabel={language === "zh-CN" ? "数据清除" : "Data clearing"}
              clearLabel={language === "zh-CN" ? "清空" : "Clear"}
              deleteLabel={language === "zh-CN" ? "删除" : "Delete"}
              onClear={clearReviewForm}
              onDelete={
                editorMode === "edit" && selectedReview
                  ? () => void handleDeleteSelectedReview()
                  : undefined
              }
            >
              <button type="button" className="secondary-button" onClick={closeEditor}>
                {t("cancel")}
              </button>
              <button
                type="submit"
                form="review-editor-form"
                disabled={isReviewTargetOptionsLoading || Boolean(reviewTargetOptionsError)}
              >
                {t("save")}
              </button>
            </DataClearFooterRow>
          </section>
        </div>
      ) : null}

      {outputGenerationDraft ? (
        <div className="modal-backdrop" role="presentation">
          <form
            className="external-output-generation-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="review-output-generation-title"
            onSubmit={(event) => void submitOutputGeneration(event)}
          >
            <div className="operation-confirm-header external-output-generation-header">
              <div>
                <h2 id="review-output-generation-title">{t("reviewGenerateResult")}</h2>
                <p>{outputGenerationDraft.sourceTitle}</p>
              </div>
            </div>

            <div className="external-output-generation-source">
              <div>
                <span>{t("externalGenerateResultSource")}</span>
                <strong>{t("outputSourceTypeReview")}</strong>
              </div>
              {outputGenerationDraft.duplicateHint ? (
                <p className="external-output-generation-warning">
                  {t("externalGenerateResultDuplicateHint")}
                </p>
              ) : null}
            </div>

            <div className="external-output-generation-fields">
              <label>
                {t("externalGenerateResultTitle")}
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
                {t("externalGenerateResultSummary")}
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
                {t("externalGenerateResultSourceNote")}
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

            {outputGenerationDraft.error ? (
              <p className="external-output-generation-error">{outputGenerationDraft.error}</p>
            ) : null}

            <div className="button-row external-output-generation-actions result-generation-modal-actions">
              <button type="submit" disabled={isOutputGenerationPending}>
                {isOutputGenerationPending
                  ? t("externalGenerateResultSaving")
                  : t("externalGenerateResultConfirm")}
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
      ) : null}

      <LazyManuscriptSegmentEditorWindow
        isOpen={manuscriptEditor.open && Boolean(manuscriptEditor.document)}
        entryKind="current"
        descriptorLookupIdentity={{
          ownerType: "review",
          channel: "primary",
          reviewType: selectedReview?.reviewType
        }}
        disabled={Boolean(manuscriptEditor.choiceDialog) ||
          manuscriptEditor.currentSession?.accessMode === "read-only"}
        lifecycle={{
          participantId: `review-current:${manuscriptEditor.currentHandle ?? "closed"}`,
          handle: manuscriptEditor.currentHandle ?? "closed",
          presentationEpoch: manuscriptEditor.currentPresentationRevision,
          readSession: manuscriptEditor.readCurrentSession
        }}
        contentIdentity={manuscriptEditor.document
          ? `${manuscriptEditor.document.fileRefId}:${manuscriptEditor.document.request.requestToken}:${manuscriptEditor.currentPresentationRevision}`
          : undefined}
        entityTitle={selectedReview?.title}
        readonlyContextItems={selectedReview
          ? selectedReview.outlineSections.map((section) => ({
              label: outlineLabels[section.key],
              value: section.content.trim() || ui("未填写")
            }))
          : []}
        contextInsertion={{
          label: ui("插入上下文结构"),
          isAvailable: Boolean(manuscriptEditor.contextInsert.trim()),
          unavailableReason: ui("当前复盘尚无可插入的上下文结构。"),
          resolveMarkdown: async () => manuscriptEditor.contextInsert
        }}
        saveLabel={ui("保存文稿")}
        cancelLabel={ui("取消")}
        dirtyLabel={ui("有未保存更改")}
        unsavedChangesTitle={ui("当前文稿有未保存更改")}
        unsavedChangesLabel={ui("关闭前，请选择保存更改、放弃更改或取消关闭。")}
        saveChangesLabel={ui("保存并关闭")}
        discardChangesLabel={ui("放弃更改")}
        continueEditingLabel={ui("取消")}
        saveFailedLabel={ui("复盘文稿保存失败。")}
        footerLeadingActions={[
          {
            key: "review-open-manuscript",
            label: ui("打开文稿"),
            disabled: manuscriptEditor.busy,
            onClick: () => void manuscriptEditor.openTargetManuscript()
          },
          {
            key: "review-switch-manuscript",
            label: ui("切换文稿"),
            disabled: manuscriptEditor.busy,
            onClick: () => void manuscriptEditor.switchCurrent()
          },
          {
            key: "review-reload",
            label: ui("重新加载"),
            disabled: manuscriptEditor.busy,
            onClick: () => void manuscriptEditor.reloadCurrent()
          },
          {
            key: "review-current-save-as",
            intent: "save-as",
            label: ui("另存为"),
            disabled: manuscriptEditor.busy,
            onClick: (snapshot) =>
              manuscriptEditor.saveCurrentAsCurrentSession(snapshot)
          }
        ]}
        onCancel={manuscriptEditor.closeCurrent}
        onClose={manuscriptEditor.closeCurrent}
      />

      <LazyManuscriptSegmentEditorWindow
        isOpen={Boolean(manuscriptEditor.targetDocument)}
        entryKind="independent"
        descriptorLookupIdentity={{
          ownerType: "review",
          channel: "primary",
          reviewType: selectedReview?.reviewType
        }}
        disabled={Boolean(manuscriptEditor.choiceDialog)}
        lifecycle={{
          participantId: `review-independent:${manuscriptEditor.targetHandle ?? "closed"}`,
          handle: manuscriptEditor.targetHandle ?? "closed",
          presentationEpoch: manuscriptEditor.targetPresentationRevision,
          readSession: manuscriptEditor.readTargetSession
        }}
        contentIdentity={manuscriptEditor.targetDocument
          ? `${manuscriptEditor.targetDocument.fileRefId}:${manuscriptEditor.targetDocument.request.requestToken}:${manuscriptEditor.targetPresentationRevision}`
          : undefined}
        entityTitle={selectedReview?.title}
        readonlyContextItems={selectedReview
          ? selectedReview.outlineSections.map((section) => ({
              label: outlineLabels[section.key],
              value: section.content.trim() || ui("未设置")
            }))
          : []}
        saveLabel={ui("保存文稿")}
        cancelLabel={ui("取消")}
        dirtyLabel={ui("有未保存更改")}
        unsavedChangesTitle={ui("当前文稿有未保存更改")}
        unsavedChangesLabel={ui("关闭前，请选择保存更改、放弃更改或取消关闭。")}
        saveChangesLabel={ui("保存并关闭")}
        discardChangesLabel={ui("放弃更改")}
        continueEditingLabel={ui("取消")}
        footerLeadingActions={[
          {
            key: "review-independent-reload",
            label: ui("重新加载"),
            disabled: manuscriptEditor.busy,
            onClick: () => void manuscriptEditor.reloadTarget(
              manuscriptEditor.readTargetSession()?.draftRawText ?? ""
            )
          },
          {
            key: "review-independent-save-as",
            intent: "save-as",
            label: ui("另存为"),
            disabled: manuscriptEditor.busy,
            onClick: (snapshot) =>
              manuscriptEditor.saveTargetAsCurrentSession(snapshot)
          }
        ]}
        onCancel={manuscriptEditor.closeTarget}
        onClose={manuscriptEditor.closeTarget}
      />

      {manuscriptEditor.choiceDialog?.kind === "formal-switch" ? (
        <FormalSwitchConfirmationDialog
          dialogId="review-manuscript-formal-switch-title"
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
            <section className="operation-confirm-dialog review-manuscript-choice-dialog" role="dialog" aria-modal="true">
              <h2>{manuscriptEditor.choiceDialog.title}</h2>
              <p style={{ whiteSpace: "pre-line" }}>
                {manuscriptEditor.choiceDialog.message}
              </p>
              <div className="button-row">
                {manuscriptEditor.choiceDialog.options.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={option.emphasis === "danger" ? "danger-button" : option.emphasis === "primary" ? "primary-button" : "secondary-button"}
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

      <OperationConfirmDialog
        preview={operationConfirm.preview}
        onConfirm={operationConfirm.confirm}
        onCancel={operationConfirm.cancel}
      />

    </section>
  );
}
