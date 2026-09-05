import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { DataClearFooterRow } from "../../components/common/DataClearRow";
import { PageHeader } from "../../components/common/PageHeader";
import { WriteFeedbackPanel } from "../../components/feedback/WriteFeedbackPanel";
import { OperationConfirmDialog } from "../../components/safety/OperationConfirmDialog";
import { useOperationConfirm } from "../../hooks/useOperationConfirm";
import { useRefreshEventReload } from "../../hooks/useRefreshEventReload";
import { useWriteFeedbackCenter } from "../../hooks/useWriteFeedbackCenter";
import { useI18n } from "../../i18n/I18nProvider";
import type { Language } from "../../i18n/translations";
import { getProjectResearchTraceData } from "../../services/projectResearchTraceSelectorService";
import { getProjectRouteGanttData } from "../../services/projectRouteGanttSelectorService";
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
  type PlanningProjectOverviewSummary,
  type PlanningProjectPageProject,
  type PlanningProjectPlanRouteEntry,
  type PlanningProjectPlanTaskEntry,
  type PlanningProjectsPageModel
} from "../../services/planningPageAdapterService";
import { planningService } from "../../services/planningService";
import { publishWriteFeedbackRefresh } from "../../services/refreshEventService";
import { recordRecycleEntry } from "../../services/recycleBinService";
import { researcherProfileService } from "../../services/researcherProfileService";
import { publishBusinessOperationTerminal } from "../../services/businessOperationFeedbackService";
import {
  readSharedCurrentProjectSelection,
  resolveSharedCurrentProjectSelection,
  writeSharedCurrentProjectSelection
} from "../../services/sharedCurrentProjectSelection";
import {
  addWriteFeedbackWarning,
  createWriteFeedbackResult
} from "../../services/writeFeedbackService";
import type { Priority, WorkStatus } from "../../types";
import type { OperationImpactPreview } from "../../types/operationSafety";
import {
  PROJECT_RESEARCH_TRACE_REFRESH_KEYS,
  type ProjectResearchTraceData
} from "../../types/projectResearchTrace";
import type { ProjectRouteGanttData } from "../../types/projectRouteGantt";
import type {
  Priority as PlanningPriority,
  ProjectStatus
} from "../../types/planning";
import type {
  AIVisibility,
  ResearcherProfile,
  ResearcherRole,
  ResearcherStage,
  UpdateResearcherProfileInput
} from "../../types/researcherProfile";
import type { RefreshEvent, RefreshKeyPattern } from "../../types/refresh";
import { ProjectVisualizationPanel } from "./ProjectVisualizationPanel";

type Project = PlanningProjectPageProject;
type PlanningRouteEntry = PlanningProjectPlanRouteEntry;
type PlanningTaskEntry = PlanningProjectPlanTaskEntry;
type ProjectOverviewSummary = PlanningProjectOverviewSummary;

type ProjectFormState = {
  name: string;
  description: string;
  significance: string;
  objective: string;
  methodSummary: string;
  expectedOutputs: string;
  keyQuestions: string;
  priority: Priority;
  status: WorkStatus;
  progress: number;
};

type ResearcherProfileFormState = {
  nickname: string;
  role: "" | ResearcherRole;
  discipline: string;
  researchDirections: string;
  researchKeywords: string;
  researchSummary: string;
  currentFocus: string;
  methodPreferences: string;
  outputPreferences: string;
  currentStage: "" | ResearcherStage;
  aiCommunicationPreference: string;
  aiGlobalConstraints: string;
  aiVisibility: AIVisibility;
};

const emptyForm: ProjectFormState = {
  name: "",
  description: "",
  significance: "",
  objective: "",
  methodSummary: "",
  expectedOutputs: "",
  keyQuestions: "",
  priority: "medium",
  status: "planned",
  progress: 0
};

const emptyResearcherProfileForm: ResearcherProfileFormState = {
  nickname: "",
  role: "",
  discipline: "",
  researchDirections: "",
  researchKeywords: "",
  researchSummary: "",
  currentFocus: "",
  methodPreferences: "",
  outputPreferences: "",
  currentStage: "",
  aiCommunicationPreference: "",
  aiGlobalConstraints: "",
  aiVisibility: "summary_only"
};

const PROJECTS_REFRESH_KEYS: RefreshKeyPattern[] = [
  ...PROJECT_RESEARCH_TRACE_REFRESH_KEYS,
  "task.changed",
  "entityLink.changed",
  "reviewContext.changed",
  "aiContext.changed",
  "researcherProfile.changed",
  "global.changed"
];

function toForm(project: Project): ProjectFormState {
  return {
    name: project.name,
    description: project.description,
    significance: project.significance,
    objective: project.objective,
    methodSummary: project.methodSummary,
    expectedOutputs: project.expectedOutputs,
    keyQuestions: project.keyQuestions.join("\n"),
    priority: project.priority,
    status: project.status,
    progress: project.progress
  };
}

function splitProjectQuestions(value: string) {
  return value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
}

function toPlanningProjectStatus(status: WorkStatus): ProjectStatus {
  switch (status) {
    case "in_progress":
      return "active";
    case "blocked":
      return "paused";
    case "completed":
    case "archived":
      return status;
    case "not_started":
    case "planned":
    default:
      return "planning";
  }
}

function toPlanningPriority(priority: Priority): PlanningPriority {
  return priority === "critical" ? "high" : priority;
}

function buildProjectCustomFields(form: ProjectFormState, project?: Project) {
  return {
    ...(project?.customFields ?? {}),
    significance: form.significance,
    methodSummary: form.methodSummary,
    expectedOutputs: form.expectedOutputs,
    keyQuestions: splitProjectQuestions(form.keyQuestions)
  };
}

function toResearcherProfileForm(
  profile: ResearcherProfile | null | undefined
): ResearcherProfileFormState {
  return {
    nickname: profile?.nickname ?? "",
    role: profile?.role ?? "",
    discipline: profile?.discipline ?? "",
    researchDirections: profile?.researchDirections.join("\n") ?? "",
    researchKeywords: profile?.researchKeywords.join("\n") ?? "",
    researchSummary: profile?.researchSummary ?? "",
    currentFocus: profile?.currentFocus ?? "",
    methodPreferences: profile?.methodPreferences ?? "",
    outputPreferences: profile?.outputPreferences ?? "",
    currentStage: profile?.currentStage ?? "",
    aiCommunicationPreference: profile?.aiCommunicationPreference ?? "",
    aiGlobalConstraints: profile?.aiGlobalConstraints ?? "",
    aiVisibility: profile?.aiVisibility ?? "summary_only"
  };
}

function splitTextList(value: string) {
  return value
    .split(/[\n,，、]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function toResearcherProfileInput(
  form: ResearcherProfileFormState
): UpdateResearcherProfileInput {
  return {
    nickname: form.nickname,
    role: form.role || undefined,
    discipline: form.discipline,
    researchDirections: splitTextList(form.researchDirections),
    researchKeywords: splitTextList(form.researchKeywords),
    researchSummary: form.researchSummary,
    currentFocus: form.currentFocus,
    methodPreferences: form.methodPreferences,
    outputPreferences: form.outputPreferences,
    currentStage: form.currentStage || undefined,
    aiCommunicationPreference: form.aiCommunicationPreference,
    aiGlobalConstraints: form.aiGlobalConstraints,
    aiVisibility: form.aiVisibility
  };
}

function formatDate(dateText?: string) {
  if (!dateText) {
    return "-";
  }

  return new Date(dateText).toLocaleDateString();
}

function formatList(items: string[], language: Language) {
  if (items.length === 0) {
    return "";
  }

  return items.join(language === "zh-CN" ? "、" : ", ");
}

function displayProjectName(
  project: Project | undefined,
  emptyLabel: string
) {
  return project?.name || emptyLabel;
}

function displayProjectObjective(
  project: Project | undefined,
  emptyLabel: string
) {
  return project?.objective || project?.description || emptyLabel;
}

function nextProjectIdAfterDelete(projects: Project[], deletedProjectId: string) {
  const visibleProjects = projects.filter((project) => project.id !== deletedProjectId);
  return visibleProjects[0]?.id ?? "";
}

export function ProjectsPage() {
  const { t, language } = useI18n();
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);
  const [planItemsByProjectId, setPlanItemsByProjectId] = useState<
    PlanningProjectsPageModel["planItemsByProjectId"]
  >({});
  const [projectSummariesByProjectId, setProjectSummariesByProjectId] = useState<
    PlanningProjectsPageModel["projectSummariesByProjectId"]
  >({});
  const [researcherProfile, setResearcherProfile] = useState<ResearcherProfile | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState(
    () => readSharedCurrentProjectSelection() ?? ""
  );
  const selectedProjectIdRef = useRef(selectedProjectId);
  const projectPageDataRequestIdRef = useRef(0);
  const projectSummaryLoadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);
  const initialPageLoadStartedRef = useRef(false);
  const projectRouteGanttRequestIdRef = useRef(0);
  const [projectRouteGanttData, setProjectRouteGanttData] =
    useState<ProjectRouteGanttData | null>(null);
  const [projectRouteGanttLoading, setProjectRouteGanttLoading] = useState(false);
  const [projectRouteGanttError, setProjectRouteGanttError] = useState<string | undefined>();
  const [projectResearchTraceData, setProjectResearchTraceData] =
    useState<ProjectResearchTraceData | null>(null);
  const [projectResearchTraceLoading, setProjectResearchTraceLoading] = useState(false);
  const [projectResearchTraceError, setProjectResearchTraceError] =
    useState<string | undefined>();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showProjectModal, setShowProjectModal] = useState(false);
  const [isProfileEditing, setIsProfileEditing] = useState(false);
  const [form, setForm] = useState<ProjectFormState>(emptyForm);
  const [profileForm, setProfileForm] =
    useState<ResearcherProfileFormState>(emptyResearcherProfileForm);
  const feedbackContext = useMemo(() => ({
    page: "projects",
    projectId: selectedProjectId || undefined,
    ownerKeys: selectedProjectId ? [`project:${selectedProjectId}:`] : []
  }), [selectedProjectId]);
  const feedbackCenter = useWriteFeedbackCenter(feedbackContext);
  const operationConfirm = useOperationConfirm();

  const loadProjectRouteGanttData = useCallback(async (projectId: string) => {
    const requestId = ++projectRouteGanttRequestIdRef.current;
    if (!projectId) {
      setProjectRouteGanttData(null);
      setProjectRouteGanttError(undefined);
      setProjectRouteGanttLoading(false);
      return null;
    }

    setProjectRouteGanttLoading(true);
    setProjectRouteGanttError(undefined);
    try {
      const ganttData = await getProjectRouteGanttData(projectId);
      if (requestId !== projectRouteGanttRequestIdRef.current) {
        return null;
      }
      setProjectRouteGanttData(ganttData);
      return ganttData;
    } catch (error) {
      if (requestId !== projectRouteGanttRequestIdRef.current) {
        return null;
      }
      setProjectRouteGanttData(null);
      setProjectRouteGanttError(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      if (requestId === projectRouteGanttRequestIdRef.current) {
        setProjectRouteGanttLoading(false);
      }
    }
  }, []);

  const loadProjectResearchTraceData = useCallback(async (projectId: string) => {
    if (!projectId) {
      setProjectResearchTraceData(null);
      setProjectResearchTraceError(undefined);
      setProjectResearchTraceLoading(false);
      return null;
    }

    setProjectResearchTraceLoading(true);
    setProjectResearchTraceError(undefined);
    try {
      const traceData = await getProjectResearchTraceData(projectId);
      setProjectResearchTraceData(traceData);
      return traceData;
    } catch (error) {
      setProjectResearchTraceData(null);
      setProjectResearchTraceError(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      setProjectResearchTraceLoading(false);
    }
  }, []);

  const loadPageData = useCallback(async () => {
    const requestId = ++projectPageDataRequestIdRef.current;
    const pageModel = await planningPageAdapterService.getPlanningProjectsPageBaseModel();
    if (!isMountedRef.current || requestId !== projectPageDataRequestIdRef.current) {
      return null;
    }
    const projectRows = pageModel.projects;
    const currentSelectedProjectId = selectedProjectIdRef.current;
    const nextSelectedProjectId = projectRows.some(
      (project) => project.id === currentSelectedProjectId
    )
      ? currentSelectedProjectId
      : resolveSharedCurrentProjectSelection(projectRows);

    setProjects(projectRows);
    setPlanItemsByProjectId(pageModel.planItemsByProjectId);
    selectedProjectIdRef.current = nextSelectedProjectId;
    setSelectedProjectId(nextSelectedProjectId);
    if (projectSummaryLoadTimerRef.current !== null) {
      clearTimeout(projectSummaryLoadTimerRef.current);
    }
    projectSummaryLoadTimerRef.current = setTimeout(() => {
      projectSummaryLoadTimerRef.current = null;
      if (!isMountedRef.current || requestId !== projectPageDataRequestIdRef.current) {
        return;
      }
      void planningPageAdapterService
        .getPlanningProjectOverviewSummaries(pageModel.planItemsByProjectId)
        .then((summaries) => {
          if (isMountedRef.current && requestId === projectPageDataRequestIdRef.current) {
            setProjectSummariesByProjectId(summaries);
          }
        });
    }, 200);
    return nextSelectedProjectId;
  }, []);

  const loadResearcherProfile = useCallback(async () => {
    const profile = await researcherProfileService.getResearcherProfile();
    setResearcherProfile(profile);
    setProfileForm(toResearcherProfileForm(profile));
  }, []);

  const reloadCurrentPage = useCallback(
    async (_event?: RefreshEvent) => {
      const [nextSelectedProjectId] = await Promise.all([
        loadPageData(),
        loadResearcherProfile()
      ]);
      if (nextSelectedProjectId === null) {
        return;
      }
      await Promise.all([
        loadProjectRouteGanttData(nextSelectedProjectId),
        loadProjectResearchTraceData(nextSelectedProjectId)
      ]);
    },
    [
      loadPageData,
      loadProjectResearchTraceData,
      loadProjectRouteGanttData,
      loadResearcherProfile
    ]
  );

  const refreshByKeys = reloadCurrentPage;

  useRefreshEventReload({
    pageName: "projects",
    watchedKeys: PROJECTS_REFRESH_KEYS,
    reload: refreshByKeys,
    onRefreshFeedback: feedbackCenter.pushRefreshEventFeedback,
    onReloadError: (error, event) =>
      feedbackCenter.pushReloadErrorFeedback(error, event, "projects")
  });

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (projectSummaryLoadTimerRef.current !== null) {
        clearTimeout(projectSummaryLoadTimerRef.current);
        projectSummaryLoadTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (initialPageLoadStartedRef.current) {
      return;
    }
    initialPageLoadStartedRef.current = true;
    void Promise.all([loadPageData(), loadResearcherProfile()]);
  }, [loadPageData, loadResearcherProfile]);

  useEffect(() => {
    if (!selectedProjectId) {
      void loadProjectRouteGanttData("");
      void loadProjectResearchTraceData("");
      return;
    }
    const timer = setTimeout(() => {
      void loadProjectRouteGanttData(selectedProjectId);
      void loadProjectResearchTraceData(selectedProjectId);
    }, 200);
    return () => clearTimeout(timer);
  }, [loadProjectResearchTraceData, loadProjectRouteGanttData, selectedProjectId]);

  function startProfileEdit() {
    setProfileForm(toResearcherProfileForm(researcherProfile));
    setIsProfileEditing(true);
  }

  function cancelProfileEdit() {
    setProfileForm(toResearcherProfileForm(researcherProfile));
    setIsProfileEditing(false);
  }

  async function handleProfileSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const savedProfile = await researcherProfileService.updateResearcherProfile(
        toResearcherProfileInput(profileForm)
      );
      setResearcherProfile(savedProfile);
      setProfileForm(toResearcherProfileForm(savedProfile));
      setIsProfileEditing(false);
      feedbackCenter.entries
        .filter((entry) => entry.operation === "researcherProfile.update")
        .forEach((entry) => feedbackCenter.dismissFeedback(entry.id));
    } catch (error) {
      feedbackCenter.consumeWriteError(error, "researcherProfile.update");
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const editingProject = projects.find((project) => project.id === editingId);
    const keyQuestions = splitProjectQuestions(form.keyQuestions);
    const baseInput = {
      title: form.name,
      description: form.description,
      objective: form.objective,
      purposeAndQuestion: keyQuestions[0] ?? undefined,
      priority: toPlanningPriority(form.priority),
      status: toPlanningProjectStatus(form.status),
      progress: Number(form.progress),
      customFields: buildProjectCustomFields(form, editingProject)
    };

    try {
      if (editingId) {
        const updatedProject = await planningService.updateProject(editingId, baseInput);
        feedbackCenter.consumeWriteResult(updatedProject, {
          operation: "planning.updateProject",
          successMessage: t("projectSaved"),
          skippedMessage: t("projectSaveSkipped"),
          affectedEntities: [
            {
              type: "project",
              id: editingId,
              relation: "updated",
              label: form.name
            }
          ],
          affectedScopes: [{ module: "planning", projectId: editingId }],
          refreshKeys: ["project.changed", "aiContext.changed", "global.changed"],
          voidIsSuccess: false
        });
      } else {
        const createdProject = await planningService.createProject({
          ...baseInput,
          orderIndex: projects.length
        });
        selectedProjectIdRef.current = createdProject.id;
        setSelectedProjectId(createdProject.id);
        feedbackCenter.consumeWriteResult(createdProject, {
          operation: "planning.createProject",
          successMessage: t("projectCreated"),
          affectedEntities: [
            {
              type: "project",
              id: createdProject.id,
              relation: "created",
              label: createdProject.title
            }
          ],
          affectedScopes: [{ module: "planning", projectId: createdProject.id }],
          refreshKeys: ["project.changed", "aiContext.changed", "global.changed"]
        });
      }

      setForm(emptyForm);
      setEditingId(null);
      setShowProjectModal(false);
      await loadPageData();
    } catch (error) {
      feedbackCenter.consumeWriteError(
        error,
        editingId ? "planning.updateProject" : "planning.createProject"
      );
    }
  }

  function buildProjectDeletePreview(project: Project): OperationImpactPreview {
    const planItems = planItemsByProjectId[project.id];
    const summary = projectSummariesByProjectId[project.id];
    const progress = summary?.progress;
    const researchContext = summary?.researchContext;
    const routeCount = progress?.routeTotal ?? planItems?.routeNodes.length ?? 0;
    const taskCount = progress?.taskTotal ?? planItems?.tasks.length ?? 0;
    const reviewCount = progress?.reviewTotal ?? researchContext?.reviewCount ?? 0;
    const evidenceCount =
      (researchContext?.experimentEvidenceCount ?? 0) +
      (researchContext?.literatureEvidenceCount ?? 0) +
      (researchContext?.outputEvidenceCount ?? 0) +
      (researchContext?.outputGapCount ?? 0);

    return createOperationImpactPreview({
      operationId: "planning.project.delete",
      operation: "delete",
      target: {
        type: "project",
        id: project.id,
        title: project.name
      },
      summary: t("deleteProjectConfirmBody"),
      riskLevel: "critical",
      executionKind: "soft-delete",
      isRecoverable: false,
      hasRestoreEntry: false,
      requiresUserConfirmation: true,
      canProceed: true,
      deepScanPerformed: false,
      confirmLabel: t("deleteProject"),
      affectedItems: [
        routeCount > 0
          ? {
              entityType: "routeNode",
              title: `${t("projectDeleteAffectedRoutes")}: ${routeCount}`,
              severity: "warning" as const
            }
          : null,
        taskCount > 0
          ? {
              entityType: "task",
              title: `${t("projectDeleteAffectedTasks")}: ${taskCount}`,
              severity: "warning" as const
            }
          : null,
        reviewCount > 0
          ? {
              entityType: "review",
              title: `${t("projectDeleteAffectedReviews")}: ${reviewCount}`,
              severity: "warning" as const
            }
          : null,
        evidenceCount > 0
          ? {
              entityType: "projectContext",
              title: `${t("projectDeleteAffectedContext")}: ${evidenceCount}`,
              severity: "warning" as const
            }
          : null,
        (researchContext?.warningCount ?? 0) > 0
          ? {
              entityType: "projectContext",
              title: `${t("projectDeleteContextWarnings")}: ${researchContext?.warningCount ?? 0}`,
              severity: "warning" as const
            }
          : null
      ].filter((item): item is NonNullable<typeof item> => item !== null),
      warnings: [
        t("deleteProjectRestoreUnsupportedHint"),
        t("projectDeleteCrossModuleWarning")
      ]
    });
  }

  async function handleDeleteProject(project: Project) {
    const preview = buildProjectDeletePreview(project);
    const confirmed = await operationConfirm.requestConfirmation(preview);

    if (!confirmed) {
      feedbackCenter.pushWriteFeedback(
        createOperationCancelledFeedback(preview, t("projectDeleteCancelled"))
      );
      return;
    }

    try {
      const deletedAt = new Date().toISOString();
      const deleted = await planningService.deleteProject(project.id, {
        note: "Deleted from Projects page after explicit user confirmation."
      });
      let feedback = createWriteFeedbackResult<Project>({
        status: deleted ? "success" : "skipped",
        operation: "planning.deleteProject",
        data: project,
        affectedEntities: [
          {
            type: "project",
            id: project.id,
            relation: deleted ? "deleted" : "skipped",
            label: project.name
          }
        ],
        affectedScopes: [{ module: "planning", projectId: project.id }],
        refreshKeys: [
          "project.changed",
          "route.changed",
          "task.changed",
          "review.changed",
          "reviewContext.changed",
          "aiContext.changed",
          "recycleBin.changed",
          "operationLog.changed",
          "global.changed"
        ],
        skipped: deleted ? [] : ["project_not_found_or_already_deleted"],
        warnings: deleted ? [t("deleteProjectRestoreUnsupportedHint")] : [],
        messages: [
          {
            severity: deleted ? "success" : "warning",
            message: deleted ? t("deleteProjectSuccess") : t("deleteProjectSkipped")
          }
        ]
      });

      if (deleted) {
        try {
          const operationLogFeedback = await createOperationLog({
            operationType: "delete",
            source: "user",
            module: "planning",
            status: feedback.status,
            riskLevel: preview.riskLevel,
            target: {
              entityType: "project",
              entityId: project.id,
              title: project.name
            },
            summary: t("deleteProjectSuccess"),
            relatedEntities: feedback.affectedEntities,
            impactSummary: summarizeImpactPreviewForOperationLog(preview),
            confirmation: {
              required: true,
              confirmedByUser: true,
              confirmedAt: deletedAt
            },
            feedback: summarizeFeedbackForOperationLog(feedback),
            isRecoverable: false
          });
          await recordRecycleEntry({
            entityType: "project",
            entityId: project.id,
            title: project.name,
            summary: project.description,
            module: "planning",
            deletedAt,
            deletedBy: "user",
            operationLogId: operationLogFeedback.data?.id,
            canRestore: false,
            cannotRestoreReason: t("deleteProjectRestoreUnsupportedHint"),
            restoreStatus: "unsupported",
            knownImpactSummary: summarizeImpactPreviewForOperationLog(preview),
            refreshKeys: feedback.refreshKeys
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          feedback = addWriteFeedbackWarning(
            feedback,
            `${t("projectDeleteAuditTrailWarning")}: ${message}`,
            "project_delete_audit_trail_failed"
          );
        }

        publishBusinessOperationTerminal({
          objectType: "project",
          action: "delete",
          result: "success"
        });

        const nextSelectedProjectId = nextProjectIdAfterDelete(projects, project.id);
        selectedProjectIdRef.current = nextSelectedProjectId;
        setSelectedProjectId(nextSelectedProjectId);
        setEditingId(null);
        setForm(emptyForm);
        setShowProjectModal(false);
      }

      publishWriteFeedbackRefresh(feedback, {
        source: "service.write",
        reason: "project deleted from Projects page"
      });
      feedbackCenter.pushWriteFeedback(feedback);
      await loadPageData();
    } catch (error) {
      feedbackCenter.consumeWriteError(error, "planning.deleteProject");
    }
  }

  function startCreate() {
    setEditingId(null);
    setForm(emptyForm);
    setShowProjectModal(true);
  }

  function startEdit(project: Project) {
    setEditingId(project.id);
    setForm(toForm(project));
    setShowProjectModal(true);
  }

  function clearProjectForm() {
    setForm((current) => ({
      ...current,
      name: "",
      description: "",
      significance: "",
      objective: "",
      methodSummary: "",
      expectedOutputs: "",
      keyQuestions: ""
    }));
  }

  function handleSelectProject(projectId: string) {
    writeSharedCurrentProjectSelection(projectId);
    selectedProjectIdRef.current = projectId;
    setSelectedProjectId(projectId);
  }

  const selectedProject = projects.find((project) => project.id === selectedProjectId);
  const selectedProjectSummary: ProjectOverviewSummary | undefined =
    projectSummariesByProjectId[selectedProjectId];
  const selectedProjectPlanItems = useMemo(
    () => {
      const planItems = planItemsByProjectId[selectedProjectId];
      return {
        routeItems: (planItems?.routeNodes ?? []) as PlanningRouteEntry[],
        taskItems: (planItems?.tasks ?? []) as PlanningTaskEntry[]
      };
    },
    [planItemsByProjectId, selectedProjectId]
  );
  const roleLabels: Record<ResearcherRole, string> = {
    master: t("researcherRoleMaster"),
    phd: t("researcherRolePhd"),
    engineer: t("researcherRoleEngineer"),
    teacher: t("researcherRoleTeacher"),
    industry_researcher: t("researcherRoleIndustryResearcher"),
    other: t("researcherRoleOther")
  };
  const notProvided = t("notProvided");
  const profileDirections = researcherProfile
    ? formatList(researcherProfile.researchDirections, language)
    : "";
  const profileKeywordTags = researcherProfile?.researchKeywords.slice(0, 4) ?? [];
  const profileKeywords = formatList(profileKeywordTags, language);
  const allProfileKeywords = researcherProfile
    ? formatList(researcherProfile.researchKeywords, language)
    : "";
  const workStatusLabels: Record<WorkStatus, string> = {
    not_started: t("not_started"),
    planned: t("planned"),
    in_progress: t("in_progress"),
    blocked: t("blocked"),
    completed: t("completed"),
    archived: t("archived")
  };
  const priorityLabels: Record<Priority, string> = {
    low: t("low"),
    medium: t("medium"),
    high: t("high"),
    critical: t("critical")
  };
  const progressSummary = selectedProjectSummary?.progress;
  const researchContextSummary = selectedProjectSummary?.researchContext;

  function openProjectRoutes(routeNodeId?: string) {
    if (!selectedProjectId) {
      return;
    }

    const params = new URLSearchParams({ projectId: selectedProjectId });
    if (routeNodeId) {
      params.set("routeNodeId", routeNodeId);
    }
    navigate(`/routes?${params.toString()}`);
  }

  function openProjectTasks(taskId?: string) {
    if (!selectedProjectId) {
      return;
    }

    const params = new URLSearchParams({ projectId: selectedProjectId });
    if (taskId) {
      params.set("taskId", taskId);
    }
    navigate(`/tasks?${params.toString()}`);
  }

  function openProjectReviews() {
    if (!selectedProjectId) {
      return;
    }

    const params = new URLSearchParams({ projectId: selectedProjectId });
    navigate(`/reviews?${params.toString()}`);
  }

  return (
    <section className="page-section project-plan-page">
      <PageHeader
        title={t("projects")}
        description={t("projectsDescription")}
      />
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

      <section className="researcher-profile-panel">
        <div className="card-heading">
          <div>
            <h2>{t("researcherProfileTitle")}</h2>
          </div>
          <button
            type="button"
            className="primary-page-action primary-page-action--secondary"
            onClick={startProfileEdit}
          >
            {researcherProfile ? t("editResearcherProfile") : t("completeResearcherProfile")}
          </button>
        </div>

        {isProfileEditing ? (
          <form className="researcher-profile-form" onSubmit={handleProfileSubmit}>
            <div className="form-row">
              <label>
                {t("nickname")}
                <input
                  value={profileForm.nickname}
                  onChange={(event) =>
                    setProfileForm({ ...profileForm, nickname: event.target.value })
                  }
                />
              </label>
              <label>
                {t("role")}
                <select
                  value={profileForm.role}
                  onChange={(event) =>
                    setProfileForm({
                      ...profileForm,
                      role: event.target.value as ResearcherProfileFormState["role"]
                    })
                  }
                >
                  <option value="">{t("notProvided")}</option>
                  <option value="master">{t("researcherRoleMaster")}</option>
                  <option value="phd">{t("researcherRolePhd")}</option>
                  <option value="engineer">{t("researcherRoleEngineer")}</option>
                  <option value="teacher">{t("researcherRoleTeacher")}</option>
                  <option value="industry_researcher">
                    {t("researcherRoleIndustryResearcher")}
                  </option>
                  <option value="other">{t("researcherRoleOther")}</option>
                </select>
              </label>
              <label>
                {t("discipline")}
                <input
                  value={profileForm.discipline}
                  onChange={(event) =>
                    setProfileForm({ ...profileForm, discipline: event.target.value })
                  }
                />
              </label>
            </div>
            <div className="form-row">
              <label>
                {t("researchDirections")}
                <textarea
                  value={profileForm.researchDirections}
                  onChange={(event) =>
                    setProfileForm({ ...profileForm, researchDirections: event.target.value })
                  }
                  placeholder={t("oneItemPerLine")}
                />
              </label>
              <label>
                {t("researchKeywords")}
                <textarea
                  value={profileForm.researchKeywords}
                  onChange={(event) =>
                    setProfileForm({ ...profileForm, researchKeywords: event.target.value })
                  }
                  placeholder={t("oneItemPerLine")}
                />
              </label>
            </div>
            <label>
              {t("researchSummary")}
              <textarea
                className="semantic-textarea-compact-summary"
                rows={2}
                value={profileForm.researchSummary}
                onChange={(event) =>
                  setProfileForm({ ...profileForm, researchSummary: event.target.value })
                }
              />
            </label>
            <div className="form-row">
              <label>
                {t("currentFocus")}
                <textarea
                  value={profileForm.currentFocus}
                  onChange={(event) =>
                    setProfileForm({ ...profileForm, currentFocus: event.target.value })
                  }
                />
              </label>
              <label>
                {t("methodPreferences")}
                <textarea
                  value={profileForm.methodPreferences}
                  onChange={(event) =>
                    setProfileForm({ ...profileForm, methodPreferences: event.target.value })
                  }
                />
              </label>
            </div>
            <div className="form-row">
              <label>
                {t("outputPreferences")}
                <textarea
                  value={profileForm.outputPreferences}
                  onChange={(event) =>
                    setProfileForm({ ...profileForm, outputPreferences: event.target.value })
                  }
                />
              </label>
              <label>
                {t("currentStage")}
                <select
                  value={profileForm.currentStage}
                  onChange={(event) =>
                    setProfileForm({
                      ...profileForm,
                      currentStage: event.target.value as ResearcherProfileFormState["currentStage"]
                    })
                  }
                >
                  <option value="">{t("notProvided")}</option>
                  <option value="exploration">{t("researcherStageExploration")}</option>
                  <option value="experiment_validation">
                    {t("researcherStageExperimentValidation")}
                  </option>
                  <option value="method_refinement">
                    {t("researcherStageMethodRefinement")}
                  </option>
                  <option value="paper_writing">{t("researcherStagePaperWriting")}</option>
                  <option value="patent_preparation">
                    {t("researcherStagePatentPreparation")}
                  </option>
                  <option value="project_review">{t("researcherStageProjectReview")}</option>
                  <option value="paused">{t("researcherStagePaused")}</option>
                  <option value="other">{t("researcherStageOther")}</option>
                </select>
              </label>
            </div>
            <div className="form-row">
              <label>
                {t("aiCommunicationPreference")}
                <textarea
                  value={profileForm.aiCommunicationPreference}
                  onChange={(event) =>
                    setProfileForm({
                      ...profileForm,
                      aiCommunicationPreference: event.target.value
                    })
                  }
                />
              </label>
              <label>
                {t("aiGlobalConstraints")}
                <textarea
                  value={profileForm.aiGlobalConstraints}
                  onChange={(event) =>
                    setProfileForm({ ...profileForm, aiGlobalConstraints: event.target.value })
                  }
                />
              </label>
              <label>
                {t("aiVisibility")}
                <select
                  value={profileForm.aiVisibility}
                  onChange={(event) =>
                    setProfileForm({
                      ...profileForm,
                      aiVisibility: event.target.value as AIVisibility
                    })
                  }
                >
                  <option value="private">{t("aiVisibilityPrivate")}</option>
                  <option value="summary_only">{t("aiVisibilitySummaryOnly")}</option>
                  <option value="allow_context">{t("aiVisibilityAllowContext")}</option>
                </select>
              </label>
            </div>
            <div className="project-form-actions">
              <button type="button" className="secondary-button" onClick={cancelProfileEdit}>
                {t("cancel")}
              </button>
              <button type="submit">{t("saveResearcherProfile")}</button>
            </div>
          </form>
        ) : researcherProfile ? (
          <div className="researcher-profile-content">
            <div className="researcher-profile-summary">
              <div className="researcher-profile-identity-row">
                <strong>{researcherProfile.nickname || notProvided}</strong>
                <span className="researcher-profile-meta-item researcher-profile-role">
                  <span className="researcher-profile-field-label">{t("role")}:</span>
                  <span
                    className="researcher-profile-field-value"
                    title={researcherProfile.role ? roleLabels[researcherProfile.role] : notProvided}
                  >
                    {researcherProfile.role ? roleLabels[researcherProfile.role] : notProvided}
                  </span>
                </span>
              </div>
              <div className="researcher-profile-meta-row">
                <span className="researcher-profile-meta-item">
                  <span className="researcher-profile-field-label">{t("discipline")}:</span>
                  <span
                    className="researcher-profile-field-value"
                    title={researcherProfile.discipline || notProvided}
                  >
                    {researcherProfile.discipline || notProvided}
                  </span>
                </span>
                <span className="researcher-profile-meta-item">
                  <span className="researcher-profile-field-label">{t("researchDirections")}:</span>
                  <span
                    className="researcher-profile-field-value"
                    title={profileDirections || notProvided}
                  >
                    {profileDirections || notProvided}
                  </span>
                </span>
                <span className="researcher-profile-meta-item">
                  <span className="researcher-profile-field-label">{t("researchKeywords")}:</span>
                  <span
                    className="researcher-profile-field-value"
                    title={allProfileKeywords || notProvided}
                  >
                    {profileKeywords || notProvided}
                  </span>
                </span>
              </div>
              <p>
                <span>{t("researchSummary")}</span>
                {researcherProfile.researchSummary || notProvided}
              </p>
              <p>
                <span>{t("currentFocus")}</span>
                {researcherProfile.currentFocus || notProvided}
              </p>
            </div>
          </div>
        ) : (
          <div className="project-empty-state researcher-profile-empty">
            <h3>{t("researcherProfileEmptyTitle")}</h3>
            <p>{t("researcherProfileEmptyDescription")}</p>
            <button
              type="button"
              className="primary-page-action primary-page-action--secondary"
              onClick={startProfileEdit}
            >
              {t("completeResearcherProfile")}
            </button>
          </div>
        )}
      </section>

      <section className="topic-planner-header project-tabs-panel">
        <div className="project-tabs-toolbar">
          <div>
            <h2>{t("projectOverview")}</h2>
          </div>
          <div className="project-tabs-actions">
            <button
              type="button"
              className="primary-page-action primary-page-action--primary"
              onClick={startCreate}
            >
              + {t("createProject")}
            </button>
            {selectedProject ? (
              <button
                type="button"
                className="secondary-button primary-page-action primary-page-action--secondary"
                onClick={() => startEdit(selectedProject)}
              >
                {t("editProject")}
              </button>
            ) : null}
          </div>
        </div>

        {projects.length > 0 ? (
          <>
            <div className="project-tab-list" role="tablist" aria-label={t("projectTabs")}>
              {projects.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  className={project.id === selectedProjectId ? "project-tab active" : "project-tab"}
                  role="tab"
                  aria-selected={project.id === selectedProjectId}
                  onClick={() => handleSelectProject(project.id)}
                >
                  <strong>{displayProjectName(project, t("noProjectSelected"))}</strong>
                </button>
              ))}
            </div>

            {selectedProject ? (
              <div className="project-summary-layout">
                <div className="project-summary-main">
                  <h2>{displayProjectName(selectedProject, t("noProjectSelected"))}</h2>
                  <dl>
                    <div>
                      <dt>{t("projectIntroduction")}</dt>
                      <dd>{selectedProject.description || notProvided}</dd>
                    </div>
                    <div>
                      <dt>{t("researchObjective")}</dt>
                      <dd>
                        {displayProjectObjective(
                          selectedProject,
                          t("noObjectiveAvailable")
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>{t("significance")}</dt>
                      <dd>{selectedProject.significance || notProvided}</dd>
                    </div>
                    <div>
                      <dt>{t("keyQuestions")}</dt>
                      <dd>
                        {selectedProject.keyQuestions.length > 0
                          ? formatList(selectedProject.keyQuestions, language)
                          : notProvided}
                      </dd>
                    </div>
                  </dl>
                </div>
                <div className="project-stat-grid" aria-label={t("projectStats")}>
                  <div>
                    <span>{t("projectStatus")}</span>
                    <strong>{workStatusLabels[selectedProject.status]}</strong>
                  </div>
                  <div>
                    <span>{t("projectPriority")}</span>
                    <strong>{priorityLabels[selectedProject.priority]}</strong>
                  </div>
                  <div>
                    <span>{t("progress")}</span>
                    <strong>{selectedProject.progress ?? 0}%</strong>
                  </div>
                  <div>
                    <span>{t("routeNodeCount")}</span>
                    <strong>
                      {progressSummary?.routeTotal ?? selectedProjectPlanItems.routeItems.length}
                    </strong>
                  </div>
                  <div>
                    <span>{t("createdAt")}</span>
                    <strong>{formatDate(selectedProject.createdAt)}</strong>
                  </div>
                  <div>
                    <span>{t("updatedAt")}</span>
                    <strong>{formatDate(selectedProject.updatedAt)}</strong>
                  </div>
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <div className="project-empty-state">
            <h3>{t("noProjectsTitle")}</h3>
            <p>{t("noProjectsDescription")}</p>
            <button
              type="button"
              className="primary-page-action primary-page-action--primary"
              onClick={startCreate}
            >
              {t("createFirstProject")}
            </button>
          </div>
        )}
      </section>

      <section className="topic-plan-main project-planning-preview">
        <div className="research-plan-heading">
          <div>
            <h2>{t("projectResearchPlanning")}</h2>
            <strong>{displayProjectName(selectedProject, t("noProjectSelected"))}</strong>
          </div>
          <div className="planning-header-actions">
            <button
              type="button"
              className="secondary-button primary-page-action primary-page-action--secondary"
              onClick={() => void reloadCurrentPage()}
            >
              {t("refresh")}
            </button>
          </div>
        </div>
        {selectedProject && progressSummary && researchContextSummary ? (
          <div className="project-progress-overview">
            <div className="project-overview-card-grid" aria-label={t("projectResearchPlanning")}>
              <section className="project-overview-card">
                <h3>{t("routeNodeCount")}</h3>
                <div className="project-overview-card-metrics">
                  <span>
                    {t("routeNodeCount")}: <strong>{progressSummary.routeTotal}</strong>
                  </span>
                  <span>
                    {t("activeRoutes")}: <strong>{progressSummary.routeActive}</strong>
                  </span>
                </div>
                <button
                  type="button"
                  className="secondary-button primary-page-action primary-page-action--secondary"
                  onClick={() => openProjectRoutes()}
                  disabled={progressSummary.routeTotal === 0}
                >
                  {t("viewRoutes")}
                </button>
              </section>
              <section className="project-overview-card">
                <h3>{t("projectOverviewTasksTitle")}</h3>
                <div className="project-overview-card-metrics">
                  <span>
                    {t("taskCount")}: <strong>{progressSummary.taskTotal}</strong>
                  </span>
                  <span>
                    {t("activeTasks")}: <strong>{progressSummary.taskActive}</strong>
                  </span>
                </div>
                <button
                  type="button"
                  className="secondary-button primary-page-action primary-page-action--secondary"
                  onClick={() => openProjectTasks()}
                  disabled={progressSummary.taskTotal === 0}
                >
                  {t("viewTasks")}
                </button>
              </section>
              <section className="project-overview-card">
                <h3>{t("reviews")}</h3>
                <div className="project-overview-card-metrics">
                  <span>
                    {t("reviewCount")}: <strong>{progressSummary.reviewTotal}</strong>
                  </span>
                  <span>
                    {t("latestReview")}:{" "}
                    <strong>{progressSummary.latestReviewTitle || t("noLatestReview")}</strong>
                  </span>
                </div>
                <button
                  type="button"
                  className="secondary-button primary-page-action primary-page-action--secondary"
                  onClick={openProjectReviews}
                >
                  {t("viewReviews")}
                </button>
              </section>
              <section className="project-overview-card">
                <h3>{t("projectOverviewAssetsTitle")}</h3>
                <div className="project-overview-card-metrics">
                  <span>
                    {t("experimentEvidence")}:{" "}
                    <strong>{researchContextSummary.experimentEvidenceCount}</strong>
                  </span>
                  <span>
                    {t("literatureEvidence")}:{" "}
                    <strong>{researchContextSummary.literatureEvidenceCount}</strong>
                  </span>
                  <span>
                    {t("outputEvidence")}:{" "}
                    <strong>{researchContextSummary.outputEvidenceCount}</strong>
                  </span>
                  <span>
                    {t("outputGaps")}: <strong>{researchContextSummary.outputGapCount}</strong>
                  </span>
                </div>
              </section>
            </div>
            <ProjectVisualizationPanel
              projectId={selectedProjectId}
              ganttData={projectRouteGanttData}
              isGanttLoading={projectRouteGanttLoading}
              ganttErrorMessage={projectRouteGanttError}
              researchTraceData={projectResearchTraceData}
              isResearchTraceLoading={projectResearchTraceLoading}
              researchTraceErrorMessage={projectResearchTraceError}
            />
          </div>
        ) : null}
        {!selectedProject || !progressSummary || !researchContextSummary ? (
          <div className="project-empty-state">
            <h3>
              {selectedProject ? t("emptyPlanningTitle") : t("noProjectsTitle")}
            </h3>
            <p>
              {selectedProject ? t("emptyPlanningDescription") : t("noProjectsDescription")}
            </p>
          </div>
        ) : null}
      </section>

      {showProjectModal ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={() => setShowProjectModal(false)}
        >
          <form
            className="project-modal-form"
            onSubmit={handleSubmit}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="card-heading project-modal-heading">
              <h2>{editingId ? t("editProject") : t("createProject")}</h2>
              <button
                type="button"
                className="secondary-button"
                onClick={() => setShowProjectModal(false)}
              >
                {t("close")}
              </button>
            </div>
            <label>
              {t("name")}
              <input
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                required
              />
            </label>
            <label>
              {t("description")}
              <textarea
                className="semantic-textarea-compact-summary"
                rows={2}
                value={form.description}
                onChange={(event) => setForm({ ...form, description: event.target.value })}
              />
            </label>
            <div className="project-modal-long-fields">
              <label>
                {t("significance")}
                <textarea
                  value={form.significance}
                  onChange={(event) => setForm({ ...form, significance: event.target.value })}
                />
              </label>
              <label>
                {t("objective")}
                <textarea
                  value={form.objective}
                  onChange={(event) => setForm({ ...form, objective: event.target.value })}
                />
              </label>
              <label>
                {t("methodSummary")}
                <textarea
                  value={form.methodSummary}
                  onChange={(event) => setForm({ ...form, methodSummary: event.target.value })}
                  placeholder={t("methodSummaryPlaceholder")}
                />
              </label>
              <label>
                {t("keyQuestions")}
                <textarea
                  value={form.keyQuestions}
                  onChange={(event) => setForm({ ...form, keyQuestions: event.target.value })}
                  placeholder={t("oneQuestionPerLine")}
                />
              </label>
            </div>
            <label>
              {t("expectedOutputs")}
              <textarea
                className="project-modal-expected-outputs"
                value={form.expectedOutputs}
                onChange={(event) => setForm({ ...form, expectedOutputs: event.target.value })}
                placeholder={t("expectedOutputsPlaceholder")}
              />
            </label>
            <div className="form-row">
              <label>
                {t("priority")}
                <select
                  value={form.priority}
                  onChange={(event) =>
                    setForm({ ...form, priority: event.target.value as Priority })
                  }
                >
                  <option value="low">{t("low")}</option>
                  <option value="medium">{t("medium")}</option>
                  <option value="high">{t("high")}</option>
                  <option value="critical">{t("critical")}</option>
                </select>
              </label>
              <label>
                {t("stage")}
                <select
                  value={form.status}
                  onChange={(event) =>
                    setForm({ ...form, status: event.target.value as WorkStatus })
                  }
                >
                  <option value="planned">{t("planned")}</option>
                  <option value="in_progress">{t("in_progress")}</option>
                  <option value="blocked">{t("blocked")}</option>
                  <option value="completed">{t("completed")}</option>
                  <option value="archived">{t("archived")}</option>
                </select>
              </label>
              <label>
                {t("progress")}
                <input
                  max={100}
                  min={0}
                  type="number"
                  value={form.progress}
                  onChange={(event) =>
                    setForm({ ...form, progress: Number(event.target.value) })
                  }
                />
              </label>
            </div>
            <DataClearFooterRow
              className="project-form-actions"
              contextKey={`project:${editingId ?? "new"}`}
              regionLabel={t("dataClearing")}
              clearLabel={t("clear")}
              deleteLabel={t("delete")}
              onClear={clearProjectForm}
              onDelete={
                editingId
                  ? () => {
                      const project = projects.find((item) => item.id === editingId);
                      if (project) void handleDeleteProject(project);
                    }
                  : undefined
              }
            >
              <button type="submit">{t("save")}</button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => setShowProjectModal(false)}
              >
                {t("cancel")}
              </button>
            </DataClearFooterRow>
          </form>
        </div>
      ) : null}
    </section>
  );
}
