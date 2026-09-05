import {
  FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { FileRefPathActions } from "../../components/common/FileRefPathActions";
import { FileRefPathPicker } from "../../components/common/FileRefPathPicker";
import { LazyManuscriptSegmentEditorWindow } from "../../components/common/LazyManuscriptSegmentEditorWindow";
import { buildLiteratureContextInsert } from "../../services/literatureContextInsertService";
import { ModalPortal } from "../../components/common/ModalPortal";
import { StructuredSummaryDisplay } from "../../components/common/StructuredSummaryDisplay";
import { PageHeader } from "../../components/common/PageHeader";
import { WriteFeedbackPanel } from "../../components/feedback/WriteFeedbackPanel";
import { OperationConfirmDialog } from "../../components/safety/OperationConfirmDialog";
import { useOperationConfirm } from "../../hooks/useOperationConfirm";
import { useRefreshEventReload } from "../../hooks/useRefreshEventReload";
import { useWriteFeedbackCenter } from "../../hooks/useWriteFeedbackCenter";
import type { WriteFeedbackDisplayScope } from "../../services/writeFeedbackDisplayService";
import { useI18n } from "../../i18n/I18nProvider";
import { nonPlanningEnumLabel, nonPlanningUi } from "../../i18n/nonPlanningI18n";
import {
  getLiteratureDetailContext,
  getLiteratureWorkloadOverview
} from "../../services/literatureSelectorService";
import {
  getLiteratureCustomStringField,
  LITERATURE_CUSTOM_FIELD_KEYS,
  mergeLiteratureCustomFields
} from "../../services/literatureFieldMappingService";
import {
  fileRefService,
  getFileRefPathName,
  summarizeFileRefPath
} from "../../services/fileRefService";
import { literatureService } from "../../services/literatureService";
import { publishFormalBusinessAttemptFailure } from "../../services/businessOperationFeedbackService";
import {
  resolveLiteratureSelection,
  type LiteratureSelectionFailureCode,
  type LiteratureSelectionResolution
} from "../../services/literatureSelectionService";
import {
  loadLiteratureManagementDetail,
  loadLiteratureProjectCatalog,
  type LiteratureManagementDetail,
  type LiteratureProjectCatalog
} from "../../services/literatureManagementDetailService";
import {
  preserveProjectlessPreferredLiteratureForMountedQuickScope,
  resolveLiteratureMountedQuickAnalysisScope
} from "../../services/literatureQuickAnalysisMountedScopeAdapter";
import {
  createLiteratureManuscriptHandleProtectionRegistry
} from "../../services/literatureManuscriptHandleProtectionRegistry";
import {
  literatureReviewOutputGenerationService,
  type LiteratureReviewOutputGenerationDraft
} from "../../services/literatureReviewOutputGenerationService";
import {
  createOperationCancelledFeedback,
  createOperationImpactPreview
} from "../../services/operationImpactPreviewService";
import {
  getResearchTraceDisplayChecked,
  saveResearchTraceDisplayPreference
} from "../../services/projectResearchTracePreferenceUiService";
import {
  readSharedCurrentProjectSelection,
  resolveSharedCurrentProjectSelection,
  writeSharedCurrentProjectSelection
} from "../../services/sharedCurrentProjectSelection";
import type {
  FileRefResourceKind,
  Literature,
  LiteratureExternalId,
  LiteratureImportance,
  LiteratureReadingStatus,
  LiteratureType
} from "../../types";
import type { LiteratureArchiveStatus } from "../../types/literature";
import type { LocalFileResult } from "../../types/localFile";
import type { Project } from "../../types/planning";
import type { OperationImpactPreview } from "../../types/operationSafety";
import type {
  LiteratureDetailContext,
  LiteratureFileRefSummary,
  LiteratureWorkloadOverview
} from "../../types/literatureContext";
import type { RefreshEvent, RefreshKeyPattern } from "../../types/refresh";
import { useLiteratureManuscriptEditor } from "./useLiteratureManuscriptEditor";
import { sharedEditorLifecycleController } from "../../services/sharedEditorLifecycleController";
import { SaveAsInterruptedReconciliationNotice } from "../../components/common/SaveAsInterruptedReconciliationNotice";
import { FormalSwitchConfirmationDialog } from "../../components/common/FormalSwitchConfirmationDialog";
import { StructuredEditFieldGrid } from "../../components/common/StructuredEditFieldGrid";
import { DataClearFooterRow } from "../../components/common/DataClearRow";
import { LiteratureQuickAnalysisButton } from "../../components/ai/LiteratureQuickAnalysisButton";

type LiteratureFormState = {
  title: string;
  authors: string;
  year: string;
  venue: string;
  publicationType: LiteratureType | "";
  doi: string;
  url: string;
  pdfPath: string;
  localFilePath: string;
  bibtexKey: string;
  citationKey: string;
  externalIdsText: string;
  keywords: string;
  tags: string;
  importance: LiteratureImportance | "";
  readingStatus: LiteratureReadingStatus;
  primaryProjectId: string;
  abstract: string;
  outlineResearchProblem: string;
  outlineApplicationObject: string;
  outlineMethodOverview: string;
  outlineMainConclusion: string;
  outlineLimitations: string;
  outlineOther: string;
  researchTraceDisplayChecked: boolean;
};

type LiteratureFileRefFormState = {
  resourceKind: FileRefResourceKind;
  fileType: string;
  path: string;
  title: string;
  description: string;
};

type ProjectSpecificNotesFormState = {
  projectSummary: string;
  projectRelevance: string;
  relatedObjectNotes: string;
  reusableMethods: string;
  comparableConclusions: string;
  other: string;
  researchTraceDisplayChecked: boolean;
};

type FilterState = {
  primaryProjectId: string;
  keyword: string;
  readingStatus: LiteratureReadingStatus | "";
  importance: LiteratureImportance | "";
  tag: string;
  archiveStatus: LiteratureArchiveStatus;
};

type LiteraturePanelMode = "view" | "create" | "edit";

type OutputGenerationDraftState = LiteratureReviewOutputGenerationDraft & {
  error?: string;
};

const emptyLiteratureForm: LiteratureFormState = {
  title: "",
  authors: "",
  year: "",
  venue: "",
  publicationType: "",
  doi: "",
  url: "",
  pdfPath: "",
  localFilePath: "",
  bibtexKey: "",
  citationKey: "",
  externalIdsText: "",
  keywords: "",
  tags: "",
  importance: "",
  readingStatus: "unread",
  primaryProjectId: "",
  abstract: "",
  outlineResearchProblem: "",
  outlineApplicationObject: "",
  outlineMethodOverview: "",
  outlineMainConclusion: "",
  outlineLimitations: "",
  outlineOther: "",
  researchTraceDisplayChecked: false
};

const emptyLiteratureFileRefForm: LiteratureFileRefFormState = {
  resourceKind: "file",
  fileType: "other",
  path: "",
  title: "",
  description: ""
};

const emptyProjectSpecificNotesForm: ProjectSpecificNotesFormState = {
  projectSummary: "",
  projectRelevance: "",
  relatedObjectNotes: "",
  reusableMethods: "",
  comparableConclusions: "",
  other: "",
  researchTraceDisplayChecked: false
};

const emptyFilters: FilterState = {
  primaryProjectId: "",
  keyword: "",
  readingStatus: "",
  importance: "",
  tag: "",
  archiveStatus: "active"
};

const publicationTypes: LiteratureType[] = [
  "journal_article",
  "conference_paper",
  "review",
  "book",
  "book_chapter",
  "thesis",
  "patent",
  "standard",
  "technical_report",
  "preprint",
  "dataset",
  "software",
  "webpage",
  "other"
];

const readingStatuses: LiteratureReadingStatus[] = [
  "unread",
  "skimmed",
  "reading",
  "intensive_read",
  "summarized",
  "reused",
  "discarded",
  "archived"
];

const importanceOptions: LiteratureImportance[] = [
  "core",
  "important",
  "useful",
  "background",
  "low",
  "uncertain"
];

const archiveStatusOptions: LiteratureArchiveStatus[] = ["active", "all", "archived"];

const LITERATURE_REFRESH_KEYS: RefreshKeyPattern[] = [
  "literature.changed",
  "fileRef.changed",
  "literatureLink.changed",
  "entityLink.changed",
  "project.changed",
  "task.changed",
  "reviewContext.changed",
  "aiContext.changed",
  "global.changed"
];

const externalIdSources: LiteratureExternalId["source"][] = [
  "zotero",
  "doi",
  "bibtex",
  "ris",
  "endnote",
  "mendeley",
  "readpaper",
  "cnki",
  "manual",
  "other"
];

function splitText(value: string) {
  return value
    .split(/[,，\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function joinText(values?: string[]) {
  return values?.join(", ") ?? "";
}

function text(value: unknown, fallback: string) {
  return value === undefined || value === null || value === "" ? fallback : String(value);
}

function optionalText(value: string) {
  const trimmed = value.trim();
  return trimmed || undefined;
}

function optionalId(value: string) {
  const trimmed = value.trim();
  return trimmed || null;
}

export function getLiteraturePrimaryProjectDisplayName(
  literature: Pick<Literature, "primaryProjectId"> | null | undefined,
  projects: Array<Pick<Project, "id" | "title">>,
  noProjectLabel: string,
  orphanedProjectLabel: string
) {
  const projectId = literature?.primaryProjectId?.trim();
  if (!projectId) {
    return noProjectLabel;
  }
  return projects.find((project) => project.id === projectId)?.title ?? orphanedProjectLabel;
}

function parseAuthors(value: string) {
  return value
    .split(/[,，;；\n]/)
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => ({ name }));
}

function formatShortAuthors(literature: Literature, fallback: string) {
  const authors = literature.authors.slice(0, 2).map((author) => author.name).filter(Boolean);
  return authors.join(", ") || fallback;
}

function literatureHasKeyword(literature: Literature, keyword: string) {
  const needle = keyword.trim().toLowerCase();
  if (!needle) {
    return true;
  }
  return [
    literature.title,
    literature.abstract,
    literature.doi,
    literature.venue,
    literature.authors.map((author) => author.name).join(" "),
    (literature.keywords ?? []).join(" ")
  ]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(needle));
}

function tagFilterMatches(literature: Literature, tag: string) {
  const needle = tag.trim();
  return !needle || literature.tags.includes(needle);
}

function filtersForSavedLiterature(literature: Literature, current: FilterState): FilterState {
  return {
    ...current,
    primaryProjectId:
      !current.primaryProjectId || literature.primaryProjectId === current.primaryProjectId
        ? current.primaryProjectId
        : literature.primaryProjectId ?? "",
    keyword: literatureHasKeyword(literature, current.keyword) ? current.keyword : "",
    readingStatus:
      !current.readingStatus || literature.readingStatus === current.readingStatus
        ? current.readingStatus
        : "",
    importance:
      !current.importance || literature.importance === current.importance ? current.importance : "",
    tag: tagFilterMatches(literature, current.tag) ? current.tag : "",
    archiveStatus:
      literature.isArchived && current.archiveStatus === "active"
        ? "all"
        : !literature.isArchived && current.archiveStatus === "archived"
          ? "active"
          : current.archiveStatus
  };
}

function parseExternalIds(value: string): LiteratureExternalId[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [rawSource, rawId, rawUrl] = line.split("|").map((part) => part.trim());
      const source = externalIdSources.includes(rawSource as LiteratureExternalId["source"])
        ? (rawSource as LiteratureExternalId["source"])
        : "other";
      return {
        source,
        id: rawId || rawSource,
        url: rawUrl || undefined
      };
    })
    .filter((externalId) => externalId.id);
}

function formatExternalIds(externalIds?: LiteratureExternalId[]) {
  return (
    externalIds
      ?.map((externalId) =>
        [externalId.source, externalId.id, externalId.url].filter(Boolean).join("|")
      )
      .join("\n") ?? ""
  );
}

function literatureToForm(literature: Literature): LiteratureFormState {
  return {
    title: literature.title,
    authors: literature.authors.map((author) => author.name).join(", "),
    year: literature.year ? String(literature.year) : "",
    venue: literature.venue ?? "",
    publicationType: literature.publicationType ?? "",
    doi: literature.doi ?? "",
    url: literature.url ?? "",
    pdfPath: literature.pdfPath ?? "",
    localFilePath: literature.localFilePath ?? "",
    bibtexKey: literature.bibtexKey ?? "",
    citationKey: literature.citationKey ?? "",
    externalIdsText: formatExternalIds(literature.externalIds),
    keywords: joinText(literature.keywords),
    tags: joinText(literature.tags),
    importance: literature.importance ?? "",
    readingStatus: literature.readingStatus,
    primaryProjectId: literature.primaryProjectId ?? "",
    abstract: literature.abstract ?? "",
    outlineResearchProblem: getLiteratureCustomStringField(
      literature,
      LITERATURE_CUSTOM_FIELD_KEYS.outlineResearchProblem
    ),
    outlineApplicationObject: getLiteratureCustomStringField(
      literature,
      LITERATURE_CUSTOM_FIELD_KEYS.outlineApplicationObject
    ),
    outlineMethodOverview: getLiteratureCustomStringField(
      literature,
      LITERATURE_CUSTOM_FIELD_KEYS.outlineMethodOverview
    ),
    outlineMainConclusion: getLiteratureCustomStringField(
      literature,
      LITERATURE_CUSTOM_FIELD_KEYS.outlineMainConclusion
    ),
    outlineLimitations: getLiteratureCustomStringField(
      literature,
      LITERATURE_CUSTOM_FIELD_KEYS.outlineLimitations
    ),
    outlineOther: getLiteratureCustomStringField(
      literature,
      LITERATURE_CUSTOM_FIELD_KEYS.outlineOther
    ),
    researchTraceDisplayChecked: false
  };
}

function literatureFileRefToForm(fileRef: LiteratureFileRefSummary): LiteratureFileRefFormState {
  return {
    resourceKind: fileRef.resourceKind,
    fileType: fileRef.fileType || "other",
    path: fileRef.path,
    title: fileRef.title,
    description: fileRef.description ?? ""
  };
}

function fileTypeFromPathSelection(result: LocalFileResult) {
  return result.actionType === "select_folder" ? "data_folder" : "other";
}

function resourceKindFromPathSelection(result: LocalFileResult): FileRefResourceKind {
  return result.actionType === "select_folder" ? "folder" : "file";
}

export function LiteraturePage() {
  const { language, t } = useI18n();
  const ui = (source: string) => nonPlanningUi(language, source);
  const archiveStatusLabel = (status: LiteratureArchiveStatus) => {
    if (language === "zh-CN") {
      return status === "active" ? "活跃" : status === "all" ? "全部" : "已归档";
    }
    return status === "active" ? "Active" : status === "all" ? "All" : "Archived";
  };
  const archiveStatusFilterLabel = language === "zh-CN" ? "归档状态" : "Archive Status";
  const archivedBadgeLabel = language === "zh-CN" ? "已归档" : "Archived";
  const archiveSuccessMessage =
    language === "zh-CN"
      ? "文献已归档，可在“归档状态：已归档”中查看和恢复。"
      : "Literature archived. You can find and restore it under Archive Status: Archived.";
  const restoreSuccessMessage =
    language === "zh-CN"
      ? "文献已恢复，已回到活跃列表。"
      : "Literature restored and returned to the active list.";
  const primaryProjectLabel = ui("所属课题");
  const noProjectLabel = ui("未关联课题");
  const orphanedProjectLabel = ui("关联课题不存在或已删除");
  const unavailableProjectLabel = ui("关联课题暂时无法加载");
  const enumLabel = (value: string | undefined) =>
    nonPlanningEnumLabel(language, value, ui("未设置"));
  const displayText = (value: unknown, fallback = ui("未填写")) => text(value, fallback);
  const displayFirstAuthor = (literature: Literature) =>
    literature.authors[0]?.name || ui("未填写作者");
  const displayShortAuthors = (literature: Literature) =>
    formatShortAuthors(literature, ui("未填写作者"));
  const [filters, setFilters] = useState<FilterState>(() => ({
    ...emptyFilters,
    primaryProjectId: readSharedCurrentProjectSelection() ?? ""
  }));
  const [projectCatalog, setProjectCatalog] = useState<LiteratureProjectCatalog>({
    status: "ready",
    projects: []
  });
  const [literatures, setLiteratures] = useState<Literature[]>([]);
  const [overviewLiteratures, setOverviewLiteratures] = useState<Literature[]>([]);
  const [selectedLiteratureId, setSelectedLiteratureId] = useState<string | null>(null);
  const [detailContext, setDetailContext] = useState<LiteratureDetailContext | null>(null);
  const [managementDetail, setManagementDetail] =
    useState<LiteratureManagementDetail | null>(null);
  const [detailLoadError, setDetailLoadError] = useState<string | null>(null);
  const [workload, setWorkload] = useState<LiteratureWorkloadOverview | null>(null);
  const [literatureForm, setLiteratureForm] =
    useState<LiteratureFormState>(emptyLiteratureForm);
  const [literatureFileRefForm, setLiteratureFileRefForm] =
    useState<LiteratureFileRefFormState>(emptyLiteratureFileRefForm);
  const [isLiteratureFileRefFormOpen, setIsLiteratureFileRefFormOpen] = useState(false);
  const [editingLiteratureId, setEditingLiteratureId] = useState<string | null>(null);
  const [literaturePanelMode, setLiteraturePanelMode] =
    useState<LiteraturePanelMode>("view");
  const [editingLiteratureFileRefId, setEditingLiteratureFileRefId] = useState<string | null>(null);
  const [isProjectSpecificNotesEditorOpen, setIsProjectSpecificNotesEditorOpen] = useState(false);
  const [projectSpecificNotesForm, setProjectSpecificNotesForm] =
    useState<ProjectSpecificNotesFormState>(emptyProjectSpecificNotesForm);
  const [isPathRecordsOpen, setIsPathRecordsOpen] = useState(false);
  const [outputGenerationDraft, setOutputGenerationDraft] =
    useState<OutputGenerationDraftState | null>(null);
  const [isOutputGenerationPending, setIsOutputGenerationPending] = useState(false);
  const [message, setMessage] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const literatureProvisioningWriteInFlightRef = useRef(false);
  const selectionRequestSequenceRef = useRef(0);
  const refreshRequestSequenceRef = useRef(0);
  const projectSelectionInitializedRef = useRef(false);
  const feedbackContext = useMemo(() => ({
    page: "literature",
    projectId:
      detailContext?.literature.primaryProjectId || filters.primaryProjectId || undefined,
    ownerKeys: selectedLiteratureId
      ? [
          `literature:${selectedLiteratureId}:`,
          `literature:${selectedLiteratureId}:literature_outline`,
          `literature:${selectedLiteratureId}:dedicated_notes`
        ]
      : []
  }), [
    detailContext?.literature.primaryProjectId,
    filters.primaryProjectId,
    selectedLiteratureId
  ]);
  const feedbackCenter = useWriteFeedbackCenter(feedbackContext);
  const operationConfirm = useOperationConfirm();

  const projectOptions = projectCatalog.projects;
  const selectedLiterature = managementDetail?.baseLiterature ?? null;
  const literatureQuickAnalysisScopeId = selectedLiterature
    ? resolveLiteratureMountedQuickAnalysisScope({
        ownerPrimaryProjectId: selectedLiterature.primaryProjectId,
        explicitlySelectedProjectId: filters.primaryProjectId,
        availableProjectIds: projectOptions.map((project) => project.id)
      })
    : undefined;
  const primaryProjectName = managementDetail?.projectRelation.status === "ready"
    ? managementDetail.projectRelation.projectTitle
    : managementDetail?.projectRelation.status === "orphaned"
      ? orphanedProjectLabel
      : managementDetail?.projectRelation.status === "unavailable"
        ? unavailableProjectLabel
        : noProjectLabel;
  const orphanedProjectId = managementDetail?.projectRelation.status === "orphaned"
    ? managementDetail.projectRelation.projectId
    : null;
  const managementDegradationMessage = !managementDetail || managementDetail.status === "ready"
    ? null
    : managementDetail.projectRelation.status === "orphaned"
      ? ui("关联课题不存在或已删除。基础详情、编辑和删除仍可使用；依赖课题或文稿的功能暂不可用。")
      : managementDetail.projectRelation.status === "unavailable"
        ? ui("关联课题暂时无法加载。基础详情、编辑和删除仍可使用。")
        : managementDetail.manuscriptReadiness === "missing"
          ? ui("文稿文件缺失。基础详情、编辑和删除仍可使用，文稿功能需要单独恢复。")
          : ui("部分详情暂时无法加载。基础详情、编辑和删除仍可使用。")
  function showPageFeedback(
    severity: "success" | "warning" | "error" | "info",
    title: string,
    operation?: string,
    scope?: WriteFeedbackDisplayScope
  ) {
    setMessage(title);
    feedbackCenter.pushPageFeedback({ severity, title, operation, scope });
  }

  function detailLoadFailureMessage(
    code: LiteratureSelectionFailureCode,
    technicalMessage: string
  ) {
    if (code === "LITERATURE_SELECTION_ROW_MISSING") {
      return ui("所选文献已不在当前列表中。");
    }
    if (code === "LITERATURE_SELECTION_DETAIL_MISSING") {
      return ui("所选文献不存在或已删除。");
    }
    if (code === "LITERATURE_SELECTION_DETAIL_MISMATCH") {
      return ui("文献详情与所选记录不一致，请重新加载。");
    }
    return `${ui("文献详情加载失败：")}${technicalMessage}`;
  }

  function applySelectionResolution(resolution: LiteratureSelectionResolution) {
    setSelectedLiteratureId(resolution.selectedLiteratureId);
    setDetailContext(resolution.detailContext);
    setManagementDetail(resolution.managementDetail);
    if (resolution.status === "error") {
      const errorMessage = detailLoadFailureMessage(resolution.code, resolution.message);
      setDetailLoadError(errorMessage);
      showPageFeedback("error", errorMessage, "literature.detail.load");
      return false;
    }
    setDetailLoadError(null);
    return resolution.status === "ready" || resolution.status === "degraded";
  }

  async function resolveAndApplySelection(
    rows: Literature[],
    preferredLiteratureId: string | null,
    catalog: LiteratureProjectCatalog = projectCatalog
  ) {
    const requestSequence = ++selectionRequestSequenceRef.current;
    const resolution = await resolveLiteratureSelection({
      rows,
      preferredLiteratureId,
      loadDetail: (literature) => loadLiteratureManagementDetail({
        baseLiterature: literature,
        projectCatalog: catalog,
        loadDetail: getLiteratureDetailContext
      })
    });
    if (requestSequence !== selectionRequestSequenceRef.current) {
      return false;
    }
    return applySelectionResolution(resolution);
  }

  async function loadDetail(literatureId: string) {
    await resolveAndApplySelection(literatures, literatureId);
  }

  const [activeManuscriptChannel, setActiveManuscriptChannel] =
    useState<"literature_outline" | "dedicated_notes">("literature_outline");
  const manuscriptHandleProtectionRegistry = useMemo(
    createLiteratureManuscriptHandleProtectionRegistry,
    [detailContext?.literature.id]
  );
  const outlineManuscriptEditor = useLiteratureManuscriptEditor({
    literatureId: detailContext?.literature.id,
    manuscriptChannel: "literature_outline",
    handleProtectionRegistry:
      manuscriptHandleProtectionRegistry,
    ui,
    onFeedback: (severity, title, operation) => showPageFeedback(
      severity,
      title,
      operation,
      detailContext?.literature.id
        ? {
            classification: "owner",
            page: "literature",
            projectId: detailContext.literature.primaryProjectId ?? undefined,
            ownerType: "literature",
            ownerId: detailContext.literature.id,
            channel: "literature_outline"
          }
        : undefined
    ),
    onReloadDetail: loadDetail
  });
  const dedicatedNotesManuscriptEditor = useLiteratureManuscriptEditor({
    literatureId: detailContext?.literature.id,
    manuscriptChannel: "dedicated_notes",
    handleProtectionRegistry:
      manuscriptHandleProtectionRegistry,
    ui,
    onFeedback: (severity, title, operation) => showPageFeedback(
      severity,
      title,
      operation,
      detailContext?.literature.id
        ? {
            classification: "owner",
            page: "literature",
            projectId: detailContext.literature.primaryProjectId ?? undefined,
            ownerType: "literature",
            ownerId: detailContext.literature.id,
            channel: "dedicated_notes"
          }
        : undefined
    ),
    onReloadDetail: loadDetail
  });
  const manuscriptEditor = activeManuscriptChannel === "dedicated_notes"
    ? dedicatedNotesManuscriptEditor
    : outlineManuscriptEditor;

  async function getLiteratureResearchTraceDisplayChecked(literature: Literature | null) {
    if (!literature?.primaryProjectId) {
      return false;
    }
    if (
      managementDetail?.baseLiterature.id === literature.id &&
      managementDetail.projectRelation.status !== "ready"
    ) {
      return false;
    }
    return getResearchTraceDisplayChecked({
      projectId: literature.primaryProjectId,
      targetType: "literature",
      targetId: literature.id,
      defaultDisplayed: false
    });
  }

  async function saveLiteratureResearchTraceDisplayPreference(
    literature: Literature,
    checked: boolean
  ) {
    if (!literature.primaryProjectId) {
      return;
    }
    if (
      managementDetail?.baseLiterature.id === literature.id &&
      managementDetail.projectRelation.status !== "ready"
    ) {
      return;
    }
    await saveResearchTraceDisplayPreference({
      projectId: literature.primaryProjectId,
      targetType: "literature",
      targetId: literature.id,
      defaultDisplayed: false,
      checked
    });
  }

  const activeManuscriptTypeName = activeManuscriptChannel === "dedicated_notes"
    ? ui("专属笔记")
    : ui("文献纲要");
  const markdownSaveFailedLabel = `${activeManuscriptTypeName}${ui("保存失败。")}`;
  const readContext = detailContext?.readContext ?? null;
  const intro = readContext?.intro ?? null;
  const structuredOutline = readContext?.structuredOutline ?? null;
  const knowledgeDeposit = readContext?.knowledgeDeposit ?? null;
  const titleText = displayText(intro?.title ?? selectedLiterature?.title, ui("未命名文献"));
  const introAuthors = intro?.authors ?? selectedLiterature?.authors ?? [];
  const authorPreview = introAuthors.length
    ? `${introAuthors
        .slice(0, 2)
        .map((author) => author.name)
        .filter(Boolean)
        .join("、")}${introAuthors.length > 2 ? ui("等") : ""}`
    : ui("未填写");
  const introYear = intro?.year ?? selectedLiterature?.year;
  const introPublicationType = intro?.publicationType ?? selectedLiterature?.publicationType;
  const introVenue = intro?.venue ?? selectedLiterature?.venue;
  const introImportance = intro?.importance ?? selectedLiterature?.importance;
  const sourceText = [introPublicationType ? enumLabel(introPublicationType) : "", introVenue]
    .filter(Boolean)
    .join("        ");
  const doiOrUrlText = intro?.doi || intro?.url || selectedLiterature?.doi || selectedLiterature?.url || "";
  const introKeywords = intro?.keywords ?? selectedLiterature?.keywords ?? [];
  const keywordsText = introKeywords.length ? introKeywords.slice(0, 6).join("、") : "";

  const outlineFields = [
    { label: ui("摘要"), content: structuredOutline?.abstract },
    { label: ui("研究问题和对象"), content: [structuredOutline?.researchProblem, structuredOutline?.applicationObject].filter(Boolean).join(" / ") },
    { label: ui("方法概要"), content: structuredOutline?.methodOverview },
    { label: ui("主要结论"), content: structuredOutline?.mainConclusion },
    { label: ui("局限性"), content: structuredOutline?.limitations },
    { label: ui("其他"), content: structuredOutline?.other }
  ];
  const knowledgeFields = [
    { label: ui("摘要"), content: knowledgeDeposit?.projectSummary },
    { label: ui("课题相关度建议"), content: knowledgeDeposit?.projectRelevance },
    { label: ui("关联对象"), content: knowledgeDeposit?.relatedObjectNotes },
    { label: ui("可借鉴方法"), content: knowledgeDeposit?.reusableMethods },
    { label: ui("可对比结论"), content: knowledgeDeposit?.comparableConclusions },
    { label: ui("其他"), content: knowledgeDeposit?.other }
  ];
  const activeStructuredFields = activeManuscriptChannel === "dedicated_notes"
    ? knowledgeFields
    : outlineFields;
  const activeInsertableMarkdown = detailContext
    ? buildLiteratureContextInsert({
        literature: detailContext.literature,
        linkSummaries: detailContext.linkSummaries,
        manuscriptChannel: activeManuscriptChannel,
        language
      }).markdown
    : "";
  const outlineCurrentReady = Boolean(
    managementDetail?.capabilities.canOpenOutline
  );
  const dedicatedNotesCurrentReady = Boolean(
    managementDetail?.capabilities.canOpenNotes
  );
  const dualChannelProvisioningReady = Boolean(
    detailContext &&
      detailContext.provisioningReadiness.readiness.defaultResourceReady === "ready" &&
      detailContext.provisioningReadiness.readiness.currentResourceReady === "ready"
  );

  async function openLiteratureOutputGeneration(mode: "outline" | "projectNote" = "outline") {
    if (!detailContext) {
      showPageFeedback("warning", t("externalGenerateResultInvalidSource"), "literature.outputGeneration.open");
      return;
    }
    try {
      const draft =
        mode === "projectNote"
          ? await literatureReviewOutputGenerationService.buildLiteratureProjectNoteResultItemDraft(
              detailContext.literature.id
            )
          : await literatureReviewOutputGenerationService.buildLiteratureOutlineResultItemDraft(
              detailContext.literature.id
            );
      setOutputGenerationDraft(draft);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      feedbackCenter.consumeWriteError(error, "literature.outputGeneration.buildDraft");
      showPageFeedback(
        "error",
        errorMessage || t("externalGenerateResultFailed"),
        "literature.outputGeneration.buildDraft"
      );
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
      const input = {
        confirmedByUser: true,
        resultItemTitle: outputGenerationDraft.resultItemTitle,
        summary: outputGenerationDraft.summary,
        sourceNote: outputGenerationDraft.sourceNote,
        resultType: outputGenerationDraft.resultType
      };
      const result =
        outputGenerationDraft.trigger === "literatureProjectNote"
          ? await literatureReviewOutputGenerationService.createResultItemFromLiteratureProjectNote(
              outputGenerationDraft.sourceId,
              input
            )
          : await literatureReviewOutputGenerationService.createResultItemFromLiteratureOutline(
              outputGenerationDraft.sourceId,
              input
            );
      setOutputGenerationDraft(null);
      await refreshAll(selectedLiteratureId);
      showPageFeedback(
        "success",
        `${t("externalGenerateResultSuccess")} ${result.resultItem.title}`,
        "literature.outputGeneration.createResultItem"
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      feedbackCenter.consumeWriteError(error, "literature.outputGeneration.createResultItem");
      setOutputGenerationDraft((current) =>
        current ? { ...current, error: errorMessage || t("externalGenerateResultFailed") } : current
      );
      showPageFeedback(
        "error",
        errorMessage || t("externalGenerateResultFailed"),
        "literature.outputGeneration.createResultItem"
      );
    } finally {
      setIsOutputGenerationPending(false);
    }
  }

  const openReadingMarkdownEditor = () => {
    if (!detailContext || !outlineCurrentReady || !outlineManuscriptEditor.ready) return;
    void sharedEditorLifecycleController.requestSequence({
      trigger: "channel-change",
      continuationIntent: "CHANNEL_CHANGE",
      surface: "application",
      continuation: async () => {
        if (activeManuscriptChannel !== "literature_outline") {
          await dedicatedNotesManuscriptEditor.closeEditor();
        }
        setActiveManuscriptChannel("literature_outline");
        await outlineManuscriptEditor.openCurrent();
      }
    });
  };

  const openProjectSpecificNotesMarkdownEditor = () => {
    if (!detailContext || !dedicatedNotesCurrentReady || !dedicatedNotesManuscriptEditor.ready) return;
    void sharedEditorLifecycleController.requestSequence({
      trigger: "channel-change",
      continuationIntent: "CHANNEL_CHANGE",
      surface: "application",
      continuation: async () => {
        if (activeManuscriptChannel !== "dedicated_notes") {
          await outlineManuscriptEditor.closeEditor();
        }
        setActiveManuscriptChannel("dedicated_notes");
        await dedicatedNotesManuscriptEditor.openCurrent();
      }
    });
  };

  async function openProjectSpecificNotesEditor() {
    if (!detailContext) return;
    const literature = detailContext.literature;
    const researchTraceDisplayChecked =
      await getLiteratureResearchTraceDisplayChecked(literature);
    setProjectSpecificNotesForm({
      projectSummary: getLiteratureCustomStringField(
        literature,
        LITERATURE_CUSTOM_FIELD_KEYS.knowledgeProjectSummary
      ),
      projectRelevance: getLiteratureCustomStringField(
        literature,
        LITERATURE_CUSTOM_FIELD_KEYS.knowledgeProjectRelevance
      ),
      relatedObjectNotes: getLiteratureCustomStringField(
        literature,
        LITERATURE_CUSTOM_FIELD_KEYS.knowledgeRelatedObjectNotes
      ),
      reusableMethods: getLiteratureCustomStringField(
        literature,
        LITERATURE_CUSTOM_FIELD_KEYS.knowledgeReusableMethods
      ),
      comparableConclusions: getLiteratureCustomStringField(
        literature,
        LITERATURE_CUSTOM_FIELD_KEYS.knowledgeComparableConclusions
      ),
      other: getLiteratureCustomStringField(
        literature,
        LITERATURE_CUSTOM_FIELD_KEYS.knowledgeOther
      ),
      researchTraceDisplayChecked
    });
    setIsProjectSpecificNotesEditorOpen(true);
  }

  function closeProjectSpecificNotesEditor() {
    setIsProjectSpecificNotesEditorOpen(false);
    setProjectSpecificNotesForm(emptyProjectSpecificNotesForm);
  }

  async function submitProjectSpecificNotes(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!detailContext) return;

    const literature = detailContext.literature;
    try {
      const saved = await literatureService.updateLiterature(literature.id, {
        customFields: mergeLiteratureCustomFields(literature, {
          [LITERATURE_CUSTOM_FIELD_KEYS.knowledgeProjectSummary]:
            optionalText(projectSpecificNotesForm.projectSummary) ?? null,
          [LITERATURE_CUSTOM_FIELD_KEYS.knowledgeProjectRelevance]:
            optionalText(projectSpecificNotesForm.projectRelevance) ?? null,
          [LITERATURE_CUSTOM_FIELD_KEYS.knowledgeRelatedObjectNotes]:
            optionalText(projectSpecificNotesForm.relatedObjectNotes) ?? null,
          [LITERATURE_CUSTOM_FIELD_KEYS.knowledgeReusableMethods]:
            optionalText(projectSpecificNotesForm.reusableMethods) ?? null,
          [LITERATURE_CUSTOM_FIELD_KEYS.knowledgeComparableConclusions]:
            optionalText(projectSpecificNotesForm.comparableConclusions) ?? null,
          [LITERATURE_CUSTOM_FIELD_KEYS.knowledgeOther]:
            optionalText(projectSpecificNotesForm.other) ?? null
        })
      });
      if (!saved) {
        throw new Error(ui("专属课题笔记保存失败。"));
      }
      try {
        await saveLiteratureResearchTraceDisplayPreference(
          saved,
          projectSpecificNotesForm.researchTraceDisplayChecked
        );
      } catch (preferenceError) {
        feedbackCenter.consumeWriteError(
          preferenceError,
          "researchTrace.preference.save"
        );
      }
      closeProjectSpecificNotesEditor();
      await loadDetail(saved.id);
      showPageFeedback(
        "success",
        ui("专属课题笔记已保存。"),
        "literature.saveProjectSpecificNotes"
      );
    } catch (error) {
      showPageFeedback(
        "error",
        error instanceof Error ? error.message : String(error),
        "literature.saveProjectSpecificNotes"
      );
    }
  }

  async function refreshAll(
    preferredLiteratureId: string | null = selectedLiteratureId,
    effectiveFilters: FilterState = filters
  ) {
    const refreshSequence = ++refreshRequestSequenceRef.current;
    const requestSequence = ++selectionRequestSequenceRef.current;
    setIsLoading(true);
    try {
      const commonListFilters = {
        keyword: effectiveFilters.keyword.trim() || undefined,
        readingStatus: effectiveFilters.readingStatus || undefined,
        importance: effectiveFilters.importance || undefined,
        tag: effectiveFilters.tag.trim() || undefined,
        archiveStatus: effectiveFilters.archiveStatus
      };
      const [overview, scopedRows, overviewRows, nextProjectCatalog, unscopedMatchingRows] = await Promise.all([
        getLiteratureWorkloadOverview({
          includeArchived: effectiveFilters.archiveStatus !== "active",
          projectId: effectiveFilters.primaryProjectId || undefined
        }),
        literatureService.queryLiteratures({
          ...commonListFilters,
          primaryProjectId: effectiveFilters.primaryProjectId || undefined,
        }),
        literatureService.queryLiteratures({
          primaryProjectId: effectiveFilters.primaryProjectId || undefined,
          archiveStatus: effectiveFilters.archiveStatus
        }),
        loadLiteratureProjectCatalog(),
        effectiveFilters.primaryProjectId && preferredLiteratureId
          ? literatureService.queryLiteratures(commonListFilters)
          : Promise.resolve([] as Literature[])
      ]);
      if (
        refreshSequence !== refreshRequestSequenceRef.current ||
        requestSequence !== selectionRequestSequenceRef.current
      ) {
        return;
      }
      if (nextProjectCatalog.status === "ready") {
        const currentProjectId = effectiveFilters.primaryProjectId;
        const preservePageLocalAll =
          projectSelectionInitializedRef.current && !currentProjectId;
        const nextProjectId = preservePageLocalAll
          ? ""
          : nextProjectCatalog.projects.some((project) => project.id === currentProjectId)
            ? currentProjectId
            : resolveSharedCurrentProjectSelection(nextProjectCatalog.projects);
        projectSelectionInitializedRef.current = true;
        if (nextProjectId !== currentProjectId) {
          setProjectCatalog(nextProjectCatalog);
          setFilters((current) =>
            current.primaryProjectId === currentProjectId
              ? { ...current, primaryProjectId: nextProjectId }
              : current
          );
          return;
        }
      }
      const rows = preserveProjectlessPreferredLiteratureForMountedQuickScope({
        scopedRows,
        unscopedMatchingRows,
        preferredLiteratureId,
        explicitlySelectedProjectId: effectiveFilters.primaryProjectId,
        availableProjectIds: nextProjectCatalog.projects.map((project) => project.id)
      });

      const nextId =
        preferredLiteratureId && rows.some((row) => row.id === preferredLiteratureId)
          ? preferredLiteratureId
          : rows[0]?.id ?? null;
      const selection = await resolveLiteratureSelection({
        rows,
        preferredLiteratureId: nextId,
        loadDetail: (literature) => loadLiteratureManagementDetail({
          baseLiterature: literature,
          projectCatalog: nextProjectCatalog,
          loadDetail: getLiteratureDetailContext
        })
      });
      if (
        refreshSequence !== refreshRequestSequenceRef.current ||
        requestSequence !== selectionRequestSequenceRef.current
      ) {
        return;
      }

      setWorkload(overview);
      setProjectCatalog(nextProjectCatalog);
      setLiteratures(rows);
      setOverviewLiteratures(overviewRows);
      applySelectionResolution(selection);
    } catch (error) {
      if (
        refreshSequence !== refreshRequestSequenceRef.current ||
        requestSequence !== selectionRequestSequenceRef.current
      ) {
        return;
      }
      setSelectedLiteratureId(null);
      setDetailContext(null);
      setManagementDetail(null);
      const errorMessage = error instanceof Error ? error.message : String(error);
      setDetailLoadError(`${ui("文献列表加载失败：")}${errorMessage}`);
      showPageFeedback(
        "error",
        errorMessage,
        "literature.load"
      );
    } finally {
      if (refreshSequence === refreshRequestSequenceRef.current) {
        setIsLoading(false);
      }
    }
  }

  useEffect(() => {
    setIsPathRecordsOpen(false);
    setIsLiteratureFileRefFormOpen(false);
    setIsProjectSpecificNotesEditorOpen(false);
    setEditingLiteratureFileRefId(null);
    setLiteratureFileRefForm(emptyLiteratureFileRefForm);
    setProjectSpecificNotesForm(emptyProjectSpecificNotesForm);
    setOutputGenerationDraft(null);
  }, [selectedLiteratureId]);

  async function loadPageData() {
    await refreshAll(selectedLiteratureId);
  }

  async function reloadCurrentPage(_event?: RefreshEvent) {
    // Literature creation publishes FileRef/Binding refresh events while its
    // owner-scoped provisioning write lease is still active. The submit path
    // performs one authoritative refresh after that write returns, so an
    // event-driven detail read here would only re-enter the same authority
    // hierarchy and conflict with the in-flight write.
    if (literatureProvisioningWriteInFlightRef.current) return;
    await loadPageData();
  }

  const refreshByKeys = reloadCurrentPage;

  useRefreshEventReload({
    pageName: "literature",
    watchedKeys: LITERATURE_REFRESH_KEYS,
    reload: refreshByKeys,
    onRefreshFeedback: feedbackCenter.pushRefreshEventFeedback,
    onReloadError: (error, event) =>
      feedbackCenter.pushReloadErrorFeedback(error, event, "literature")
  });

  useEffect(() => {
    void refreshAll();
  }, [
    filters.primaryProjectId,
    filters.keyword,
    filters.readingStatus,
    filters.importance,
    filters.tag,
    filters.archiveStatus
  ]);

  async function runAction(action: () => Promise<string | null | undefined>, success: string) {
    try {
      const preferredId = await action();
      feedbackCenter.consumeWriteResult(preferredId, {
        operation: "literature.write",
        successMessage: success
      });
      // Refresh events synchronize other consumers; this reload keeps the current
      // literature selection and detail context deterministic for this page.
      await refreshAll(preferredId === undefined ? selectedLiteratureId : preferredId);
    } catch (error) {
      feedbackCenter.consumeWriteError(error, "literature.write");
    }
  }

  async function confirmAndRunDelete(
    preview: OperationImpactPreview,
    action: () => Promise<unknown>,
    successMessage: string
  ) {
    const confirmed = await operationConfirm.requestConfirmation(preview);
    if (!confirmed) {
      feedbackCenter.consumeWriteResult(
        createOperationCancelledFeedback(preview, t("operationCancelled")),
        { operation: preview.operationId }
      );
      return false;
    }

    try {
      const result = await action();
      feedbackCenter.consumeWriteResult(result, {
        operation: preview.operationId,
        successMessage,
        skippedMessage: t("outputActionSkipped")
      });
      if (result) {
        await refreshAll(selectedLiteratureId);
      }
      return Boolean(result && typeof result === "object" && "status" in result && (
        (result as { status?: unknown }).status === "success" ||
        (result as { status?: unknown }).status === "partial"
      ));
    } catch (error) {
      feedbackCenter.consumeWriteError(error, preview.operationId);
      return false;
    }
  }

  async function selectLiterature(literatureId: string, lifecycleSettled = false) {
    if (literatureId !== selectedLiteratureId && !lifecycleSettled) {
      await sharedEditorLifecycleController.requestSequence({
        trigger: "owner-change",
        continuationIntent: "OWNER_CHANGE",
        surface: "application",
        continuation: () => selectLiterature(literatureId, true)
      });
      return;
    }
    setMessage("");
    await loadDetail(literatureId);
  }

  function startCreateLiterature() {
    setEditingLiteratureId(null);
    setLiteratureForm(emptyLiteratureForm);
    setLiteraturePanelMode("create");
    setMessage("");
  }

  async function startEditLiterature(literature: Literature) {
    setEditingLiteratureId(literature.id);
    const researchTraceDisplayChecked =
      await getLiteratureResearchTraceDisplayChecked(literature);
    setLiteratureForm({
      ...literatureToForm(literature),
      researchTraceDisplayChecked
    });
    setLiteraturePanelMode("edit");
    setMessage("");
    await loadDetail(literature.id);
  }

  function cancelLiteratureForm() {
    setEditingLiteratureId(null);
    setLiteratureForm(emptyLiteratureForm);
    setLiteraturePanelMode("view");
  }

  function clearLiteratureForm() {
    setLiteratureForm((current) => ({
      ...current,
      title: "",
      authors: "",
      year: "",
      venue: "",
      doi: "",
      url: "",
      keywords: "",
      tags: "",
      importance: "",
      abstract: "",
      outlineResearchProblem: "",
      outlineApplicationObject: "",
      outlineMethodOverview: "",
      outlineMainConclusion: "",
      outlineLimitations: "",
      outlineOther: "",
      researchTraceDisplayChecked: false
    }));
  }

  function clearProjectSpecificNotesForm() {
    setProjectSpecificNotesForm((current) => ({
      ...current,
      projectSummary: "",
      projectRelevance: "",
      relatedObjectNotes: "",
      reusableMethods: "",
      comparableConclusions: "",
      other: "",
      researchTraceDisplayChecked: false
    }));
  }

  function resetLiteratureFileRefForm() {
    setEditingLiteratureFileRefId(null);
    setLiteratureFileRefForm(emptyLiteratureFileRefForm);
    setIsLiteratureFileRefFormOpen(false);
  }

  function handleFileRefLocalResult(result: LocalFileResult) {
    const feedback = fileRefService.toFileRefActionFeedback(result);
    if (!feedback) return;
    showPageFeedback(feedback.severity, ui(feedback.message), feedback.operation);
  }

  async function handleOpenFirstPathRecord() {
    if (!detailContext) {
      showPageFeedback(
        "warning",
        ui("路径详情暂时无法加载；基础文献详情和删除仍可使用。"),
        "literature.openFirstPathRecord"
      );
      return;
    }

    if (detailContext.fileRefs.length === 0) {
      setIsPathRecordsOpen(true);
      showPageFeedback(
        "info",
        ui("尚未添加路径记录，请先添加文件或文件夹路径。"),
        "literature.openFirstPathRecord"
      );
      return;
    }

    const firstPathRecord = detailContext.fileRefs.find((fileRef) => fileRef.path.trim());
    if (!firstPathRecord) {
      setIsPathRecordsOpen(true);
      showPageFeedback(
        "warning",
        ui("当前路径记录没有有效路径。"),
        "literature.openFirstPathRecord"
      );
      return;
    }

    const openKind = firstPathRecord.resourceKind === "folder" ? "folder" : "file";
    const result =
      openKind === "folder"
        ? await fileRefService.openFolder(firstPathRecord.path)
        : await fileRefService.openFile(firstPathRecord.path);
    handleFileRefLocalResult(result);
  }

  async function submitLiterature(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const businessOperation = editingLiteratureId
      ? "literature.updateLiterature"
      : "literature.createLiterature";
    if (!literatureForm.title.trim()) {
      publishFormalBusinessAttemptFailure(businessOperation);
      showPageFeedback("warning", ui("请先填写文献标题。"), "literature.validate");
      return;
    }
    const numericYear = Number(literatureForm.year);
    const customFieldsSource =
      editingLiteratureId && selectedLiterature?.id === editingLiteratureId
        ? selectedLiterature
        : { customFields: [] };
    const projectAssignmentChanged =
      !editingLiteratureId ||
      optionalId(literatureForm.primaryProjectId) !== (selectedLiterature?.primaryProjectId ?? null);
    const input = {
      title: literatureForm.title.trim(),
      authors: parseAuthors(literatureForm.authors),
      year: Number.isFinite(numericYear) && literatureForm.year.trim() ? numericYear : undefined,
      venue: optionalText(literatureForm.venue),
      publicationType: literatureForm.publicationType || undefined,
      doi: optionalText(literatureForm.doi),
      url: optionalText(literatureForm.url),
      pdfPath: optionalText(literatureForm.pdfPath),
      localFilePath: optionalText(literatureForm.localFilePath),
      bibtexKey: optionalText(literatureForm.bibtexKey),
      citationKey: optionalText(literatureForm.citationKey),
      externalIds: parseExternalIds(literatureForm.externalIdsText),
      keywords: splitText(literatureForm.keywords),
      tags: splitText(literatureForm.tags),
      importance: literatureForm.importance || undefined,
      readingStatus: literatureForm.readingStatus,
      ...(projectAssignmentChanged
        ? { primaryProjectId: optionalId(literatureForm.primaryProjectId) }
        : {}),
      abstract: optionalText(literatureForm.abstract),
      customFields: mergeLiteratureCustomFields(customFieldsSource, {
        [LITERATURE_CUSTOM_FIELD_KEYS.outlineResearchProblem]:
          optionalText(literatureForm.outlineResearchProblem) ?? null,
        [LITERATURE_CUSTOM_FIELD_KEYS.outlineApplicationObject]:
          optionalText(literatureForm.outlineApplicationObject) ?? null,
        [LITERATURE_CUSTOM_FIELD_KEYS.outlineMethodOverview]:
          optionalText(literatureForm.outlineMethodOverview) ?? null,
        [LITERATURE_CUSTOM_FIELD_KEYS.outlineMainConclusion]:
          optionalText(literatureForm.outlineMainConclusion) ?? null,
        [LITERATURE_CUSTOM_FIELD_KEYS.outlineLimitations]:
          optionalText(literatureForm.outlineLimitations) ?? null,
        [LITERATURE_CUSTOM_FIELD_KEYS.outlineOther]:
          optionalText(literatureForm.outlineOther) ?? null
      })
    };

    try {
      const createResult = editingLiteratureId
        ? null
        : await (async () => {
            literatureProvisioningWriteInFlightRef.current = true;
            try {
              return await literatureService.createLiterature(input);
            } finally {
              literatureProvisioningWriteInFlightRef.current = false;
            }
          })();
      const saved = editingLiteratureId
        ? await literatureService.updateLiterature(editingLiteratureId, input)
        : createResult?.literature;
      if (!saved) {
        showPageFeedback(
          "error",
          createResult?.errors.join("；") || (
            editingLiteratureId ? ui("文献修改失败。") : ui("文献创建失败。")
          ),
          businessOperation
        );
        await refreshAll(selectedLiteratureId);
        return;
      }

      const nextFilters = filtersForSavedLiterature(saved, filters);
      setFilters(nextFilters);
      setEditingLiteratureId(null);
      setLiteraturePanelMode("view");
      try {
        await saveLiteratureResearchTraceDisplayPreference(
          saved,
          literatureForm.researchTraceDisplayChecked
        );
      } catch (preferenceError) {
        feedbackCenter.consumeWriteError(
          preferenceError,
          "researchTrace.preference.save"
        );
      }
      showPageFeedback(
        createResult?.status === "partial" ? "warning" : "success",
        editingLiteratureId
          ? ui("文献已更新。")
          : createResult?.status === "partial"
            ? ui("文献已创建，但文稿初始化未完成；可在路径记录区重试。")
            : ui("文献已创建。"),
        businessOperation
      );
      await refreshAll(saved.id, nextFilters);
    } catch (error) {
      showPageFeedback(
        "error",
        error instanceof Error ? error.message : String(error),
        businessOperation
      );
    }
  }

  async function archiveSelectedLiterature() {
    if (!selectedLiterature) {
      return;
    }

    const isRestoring = selectedLiterature.isArchived === true;
    await runAction(async () => {
      const saved = selectedLiterature.isArchived
        ? await literatureService.restoreLiterature(selectedLiterature.id)
        : await literatureService.archiveLiterature(selectedLiterature.id);
      if (!saved) {
        return null;
      }
      if (filters.archiveStatus === "all") {
        return saved.id;
      }
      return saved.isArchived === (filters.archiveStatus === "archived") ? saved.id : null;
    }, isRestoring ? restoreSuccessMessage : archiveSuccessMessage);
  }

  async function deleteSelectedLiterature() {
    if (!selectedLiterature) {
      return;
    }
    const linkCount = detailContext?.links.length ?? 0;
    const affectedItems = [
      ...(linkCount
        ? [
            {
              entityType: "literatureLink",
              title: ui("关联文献关系"),
              description: String(linkCount),
              severity: "info" as const
            }
          ]
        : [])
    ];
    const preview = createOperationImpactPreview({
      operationId: "literature.delete",
      operation: "delete",
      target: {
        type: "literature",
        id: selectedLiterature.id,
        title: selectedLiterature.title
      },
      summary: ui("文献记录将移入回收站，并从默认文献列表隐藏。"),
      riskLevel: "high",
      executionKind: "soft-delete",
      isRecoverable: true,
      hasRestoreEntry: true,
      requiresUserConfirmation: true,
      canProceed: true,
      affectedItems,
      deepScanPerformed: false,
      confirmLabel: t("delete"),
      warnings: [
        ui("不会删除本地 PDF 或路径指向的真实文件。"),
        ui("不会读取、解析或上传本地文件正文。"),
        ui("文献关联关系不会级联删除。")
      ]
    });
    const deleted = await confirmAndRunDelete(
      preview,
      () => literatureService.deleteLiterature(selectedLiterature.id),
      ui("文献已移入回收站。")
    );
    if (deleted) {
      cancelLiteratureForm();
      closeProjectSpecificNotesEditor();
    }
  }

  async function submitLiteratureFileRef(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const literatureId = selectedLiteratureId;
    const path = literatureFileRefForm.path.trim();
    if (!literatureId || !path) {
      showPageFeedback("warning", ui("请先选择文献，并填写路径。"), "literatureFileRef.validate");
      return;
    }

    const input = {
      ownerType: "literature" as const,
      ownerId: literatureId,
      resourceKind: literatureFileRefForm.resourceKind,
      fileRole: "attachment" as const,
      locationMode: "external" as const,
      fileType: literatureFileRefForm.fileType || "other",
      path,
      title: literatureFileRefForm.title.trim() || getFileRefPathName(path),
      description: optionalText(literatureFileRefForm.description)
    };

    await runAction(async () => {
      const saved = editingLiteratureFileRefId
        ? (
            await fileRefService.replaceFileRefPath(editingLiteratureFileRefId, input)
          ).fileRef
        : (await fileRefService.registerFileRef(input)).fileRef;
      resetLiteratureFileRefForm();
      return saved?.ownerId ?? literatureId;
    }, editingLiteratureFileRefId ? ui("路径记录已更新。") : ui("路径记录已新增。"));
  }

  async function deleteLiteratureFileRef(fileRef: LiteratureFileRefSummary) {
    if (
      fileRef.resourceKind === "folder" &&
      fileRef.fileRole === "defaultFolder" &&
      fileRef.locationMode === "managed"
    ) {
      showPageFeedback(
        "warning",
        ui("工作目录由 SciLoom 托管，不可编辑或删除。"),
        "literature.fileRef.delete.defaultFolderBlocked"
      );
      return;
    }
    const title = fileRef.title || getFileRefPathName(fileRef.path) || fileRef.id;
    const literatureTitle = detailContext?.literature.title ?? selectedLiterature?.title ?? selectedLiteratureId ?? "";
    const preview = createOperationImpactPreview({
      operationId: "literature.fileRef.delete",
      operation: "delete",
      target: {
        type: "fileRef",
        id: fileRef.id,
        title
      },
      summary: ui("文献路径记录将移入回收站，并从当前文献详情中隐藏。"),
      riskLevel: "medium",
      executionKind: "soft-delete",
      isRecoverable: true,
      hasRestoreEntry: true,
      requiresUserConfirmation: true,
      canProceed: true,
      deepScanPerformed: false,
      confirmLabel: t("delete"),
      affectedItems: [
        {
          entityType: "literature",
          entityId: selectedLiteratureId ?? undefined,
          title: literatureTitle || ui("所属文献"),
          description: ui("文献本体不会被删除。"),
          severity: "info"
        },
        {
          entityType: "fileRef",
          entityId: fileRef.id,
          title,
          description: enumLabel(fileRef.fileType),
          severity: "warning"
        }
      ],
      warnings: [
        ui("删除后该路径记录不再出现在文献详情。"),
        ui("不会删除文献本体。"),
        ui("不会删除本地真实文件。"),
        ui("不会读取或上传文件正文。"),
        ui("可从回收站恢复路径记录元数据。")
      ]
    });
    await confirmAndRunDelete(
      preview,
      () =>
        fileRefService.deleteFileRefWithAudit({
          id: fileRef.id,
          title,
          summary: `Literature FileRef metadata for ${selectedLiteratureId ?? "unknown literature"} was soft-deleted. No local file was read, moved, or deleted.`,
          relatedEntities: selectedLiteratureId
            ? [
                {
                  type: "literature",
                  id: selectedLiteratureId,
                  relation: "linked",
                  label: literatureTitle
                }
              ]
            : [],
          impactSummary: preview,
          refreshKeys: ["fileRef.changed", "literature.changed", "reviewContext.changed", "aiContext.changed"]
        }),
      ui("路径记录已移入回收站。")
    );
  }

  return (
    <div className="app-page literature-page">
      <PageHeader
        title={ui("文献")}
        description={t("literatureFocusedDescription")}
      />
      <SaveAsInterruptedReconciliationNotice
        ownerKeys={selectedLiteratureId ? [`literature:${selectedLiteratureId}`] : []}
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

      {message ? <div className="literature-message">{message}</div> : null}

      <section className="literature-compact-stat-grid" aria-label={ui("阅读工作量概览")}>
        <div className="literature-compact-stat-card lightweight-stat-surface">
          <span className="literature-compact-stat-label">{t("literatureStatsCount")}</span>
          <strong className="literature-compact-stat-value">{overviewLiteratures.length}</strong>
        </div>
        <div className="literature-compact-stat-card lightweight-stat-surface">
          <span className="literature-compact-stat-label">
            {t("literatureStatsReadingActivity")}
          </span>
          <strong className="literature-compact-stat-value">
            {workload?.totalReadingActivityCount ?? 0}
          </strong>
        </div>
        <div className="literature-compact-stat-card lightweight-stat-surface">
          <span className="literature-compact-stat-label">{t("literatureStatsProgress")}</span>
          <strong className="literature-compact-stat-value">
            {[
              overviewLiteratures.filter((item) => item.readingStatus === "intensive_read").length,
              overviewLiteratures.filter((item) => item.readingStatus === "summarized").length,
              overviewLiteratures.filter((item) => item.readingStatus === "reused").length
            ].join("/")}
          </strong>
        </div>
      </section>

      <section className="literature-toolbar" aria-label={t("literatureFilters")}>
        <div className="literature-filter-row literature-filter-row-primary">
          <label className="literature-inline-field">
            <span>{t("literatureRelatedProject")}</span>
            <select
              value={filters.primaryProjectId}
              onChange={(event) => {
                const projectId = event.target.value;
                if (projectId) {
                  writeSharedCurrentProjectSelection(projectId);
                }
                setFilters((current) => ({ ...current, primaryProjectId: projectId }));
              }}
            >
              <option value="">{t("literatureAllProjects")}</option>
              {projectOptions.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.title}
                </option>
              ))}
            </select>
          </label>
          <label className="literature-inline-field">
            <span>{ui("重要性")}</span>
            <select
              value={filters.importance}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  importance: event.target.value as LiteratureImportance | ""
                }))
              }
            >
              <option value="">{ui("全部")}</option>
              {importanceOptions.map((importance) => (
                <option key={importance} value={importance}>
                  {enumLabel(importance)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="literature-filter-row literature-filter-row-secondary">
          <label className="literature-inline-field">
            <span>{archiveStatusFilterLabel}</span>
            <select
              value={filters.archiveStatus}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  archiveStatus: event.target.value as LiteratureArchiveStatus
                }))
              }
            >
              {archiveStatusOptions.map((status) => (
                <option key={status} value={status}>
                  {archiveStatusLabel(status)}
                </option>
              ))}
            </select>
          </label>
          <label className="literature-inline-field">
            <span>{ui("关键词")}</span>
            <input
              value={filters.keyword}
              onChange={(event) =>
                setFilters((current) => ({ ...current, keyword: event.target.value }))
              }
              placeholder={ui("标题、作者、摘要、DOI")}
            />
          </label>
          <label className="literature-inline-field">
            <span>{ui("标签")}</span>
            <input
              value={filters.tag}
              onChange={(event) =>
                setFilters((current) => ({ ...current, tag: event.target.value }))
              }
              placeholder={ui("单个标签")}
            />
          </label>
        </div>
      </section>

      <section className="literature-workspace-panel">
        <header className="literature-workspace-header">
          <h2>{t("literatureListTitle")}</h2>
          <div className="literature-list-actions">
            {isLoading ? <span className="status-pill">{ui("加载中")}</span> : null}
            <button
              className="literature-primary-action-button primary-page-action primary-page-action--primary"
              type="button"
              onClick={startCreateLiterature}
            >
              {t("newAction")}
            </button>
          </div>
        </header>

        <div className="literature-workspace-body">
          <div className="literature-workspace-list-column">
            <div className="literature-list-body">
              {literatures.length === 0 ? (
                <p className="literature-list-empty">
                  {filters.primaryProjectId
                    ? t("literatureProjectEmpty")
                    : filters.keyword.trim() ||
                        filters.readingStatus ||
                        filters.importance ||
                        filters.archiveStatus !== "active" ||
                        filters.tag.trim()
                      ? t("literatureFilterEmpty")
                      : t("literatureEmpty")}
                </p>
              ) : (
                literatures.map((literature) => (
                  <button
                    type="button"
                    className={
                      literature.id === selectedLiteratureId
                        ? "literature-list-card literature-selected-card"
                        : "literature-list-card"
                    }
                    key={literature.id}
                    onClick={() => void selectLiterature(literature.id)}
                  >
                    <span className="literature-list-card-title">{literature.title}</span>
                    <span className="literature-list-card-meta">
                      <span>{displayFirstAuthor(literature)}</span>
                      <span className="literature-list-card-tags">
                        {literature.isArchived ? (
                          <span className="literature-archived-badge">{archivedBadgeLabel}</span>
                        ) : null}
                        <span>
                          {literature.importance
                            ? enumLabel(literature.importance)
                            : ui("未评级")}
                        </span>
                      </span>
                    </span>
                  </button>
                ))
              )}
            </div>

          {literaturePanelMode !== "view" ? (
          <div className="literature-editor-backdrop">
          <form
            aria-labelledby="literature-editor-title"
            aria-modal="true"
            className="literature-editor-shell"
            onSubmit={(event) => void submitLiterature(event)}
            role="dialog"
          >
            <header className="literature-editor-header">
              <h2 id="literature-editor-title">
                {editingLiteratureId ? t("literatureEditTitle") : t("literatureNewTitle")}
              </h2>
              <button
                type="button"
                className="literature-editor-close-button"
                onClick={cancelLiteratureForm}
              >
                {ui("关闭")}
              </button>
            </header>
            <div className="literature-editor-body">
              <section className="literature-editor-section">
                <h3>{ui("文献基础信息")}</h3>

                <div className="literature-editor-row literature-editor-row-title-status">
                  <label>
                    {ui("标题")}
                    <input
                      value={literatureForm.title}
                      onChange={(event) =>
                        setLiteratureForm((current) => ({ ...current, title: event.target.value }))
                      }
                      required
                    />
                  </label>
                  <label>
                    {ui("阅读状态")}
                    <select
                      value={literatureForm.readingStatus}
                      onChange={(event) =>
                        setLiteratureForm((current) => ({
                          ...current,
                          readingStatus: event.target.value as LiteratureReadingStatus
                        }))
                      }
                    >
                      {readingStatuses.map((status) => (
                        <option key={status} value={status}>
                          {enumLabel(status)}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <div className="literature-editor-row literature-editor-row-author-year">
                  <label>
                    {ui("作者")}
                    <input
                      value={literatureForm.authors}
                      onChange={(event) =>
                        setLiteratureForm((current) => ({ ...current, authors: event.target.value }))
                      }
                      placeholder={ui("逗号或分号分隔")}
                    />
                  </label>
                  <label>
                    {ui("年份")}
                    <input
                      value={literatureForm.year}
                      onChange={(event) =>
                        setLiteratureForm((current) => ({ ...current, year: event.target.value }))
                      }
                    />
                  </label>
                </div>

                <div className="literature-editor-row literature-editor-row-primary-project">
                  <label>
                    {primaryProjectLabel}
                    <select
                      value={literatureForm.primaryProjectId}
                      onChange={(event) =>
                        setLiteratureForm((current) => ({
                          ...current,
                          primaryProjectId: event.target.value
                        }))
                      }
                    >
                      <option value="">{noProjectLabel}</option>
                      {orphanedProjectId &&
                      !projectOptions.some(
                        (project) => project.id === orphanedProjectId
                      ) ? (
                        <option value={orphanedProjectId}>
                          {orphanedProjectLabel}
                        </option>
                      ) : null}
                      {projectOptions.map((project) => (
                        <option key={project.id} value={project.id}>
                          {project.title}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <div className="literature-editor-row literature-editor-row-type-venue">
                  <label>
                    {ui("类型")}
                    <select
                      value={literatureForm.publicationType}
                      onChange={(event) =>
                        setLiteratureForm((current) => ({
                          ...current,
                          publicationType: event.target.value as LiteratureType | ""
                        }))
                      }
                    >
                      <option value="">{ui("未设置")}</option>
                      {publicationTypes.map((type) => (
                        <option key={type} value={type}>
                          {enumLabel(type)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    {ui("来源 / 期刊会议")}
                    <input
                      value={literatureForm.venue}
                      onChange={(event) =>
                        setLiteratureForm((current) => ({ ...current, venue: event.target.value }))
                      }
                    />
                  </label>
                </div>

                <div className="literature-editor-row literature-editor-row-doi-url">
                  <label>
                    DOI
                    <input
                      value={literatureForm.doi}
                      onChange={(event) =>
                        setLiteratureForm((current) => ({ ...current, doi: event.target.value }))
                      }
                    />
                  </label>
                  <label>
                    URL
                    <input
                      value={literatureForm.url}
                      onChange={(event) =>
                        setLiteratureForm((current) => ({ ...current, url: event.target.value }))
                      }
                    />
                  </label>
                </div>

                <div className="literature-editor-row literature-editor-row-classification">
                  <label>
                    {ui("重要性")}
                    <select
                      value={literatureForm.importance}
                      onChange={(event) =>
                        setLiteratureForm((current) => ({
                          ...current,
                          importance: event.target.value as LiteratureImportance | ""
                        }))
                      }
                    >
                      <option value="">{ui("未设置")}</option>
                      {importanceOptions.map((importance) => (
                        <option key={importance} value={importance}>
                          {enumLabel(importance)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    {ui("关键词")}
                    <input
                      value={literatureForm.keywords}
                      onChange={(event) =>
                        setLiteratureForm((current) => ({ ...current, keywords: event.target.value }))
                      }
                      placeholder={ui("逗号分隔")}
                    />
                  </label>
                  <label>
                    {ui("标签")}
                    <input
                      value={literatureForm.tags}
                      onChange={(event) =>
                        setLiteratureForm((current) => ({ ...current, tags: event.target.value }))
                      }
                      placeholder={ui("逗号分隔")}
                    />
                  </label>
                </div>
                <div className="literature-editor-row literature-editor-row-research-trace">
                  <label className="checkbox-row research-trace-preference-row">
                    <input
                      type="checkbox"
                      checked={literatureForm.researchTraceDisplayChecked}
                      onChange={(event) =>
                        setLiteratureForm((current) => ({
                          ...current,
                          researchTraceDisplayChecked: event.target.checked
                        }))
                      }
                    />
                    <span>{ui("显示在课题研究脉络中")}</span>
                  </label>
                </div>
              </section>

              <section className="literature-editor-section literature-editor-outline-section">
                <h3>{ui("文献纲要")}</h3>
                <StructuredEditFieldGrid>
                  <label className="semantic-textarea-field-full">
                    {language === "zh-CN" ? "摘要" : "Abstract"}
                    <textarea
                      className="semantic-textarea-compact-summary"
                      rows={2}
                      value={literatureForm.abstract}
                      onChange={(event) =>
                        setLiteratureForm((current) => ({ ...current, abstract: event.target.value }))
                      }
                    />
                  </label>
                  <div
                    className="literature-outline-field-group"
                    role="group"
                    aria-labelledby="literature-outline-problem-object-group"
                  >
                    <strong id="literature-outline-problem-object-group">
                      {ui("研究问题和对象")}
                    </strong>
                    <label>
                      {ui("研究问题")}
                      <textarea
                        value={literatureForm.outlineResearchProblem}
                        onChange={(event) =>
                          setLiteratureForm((current) => ({
                            ...current,
                            outlineResearchProblem: event.target.value
                          }))
                        }
                      />
                    </label>
                    <label>
                      {ui("应用对象")}
                      <textarea
                        value={literatureForm.outlineApplicationObject}
                        onChange={(event) =>
                          setLiteratureForm((current) => ({
                            ...current,
                            outlineApplicationObject: event.target.value
                          }))
                        }
                      />
                    </label>
                  </div>
                  <label>
                    {ui("方法概要")}
                    <textarea
                      value={literatureForm.outlineMethodOverview}
                      onChange={(event) =>
                        setLiteratureForm((current) => ({
                          ...current,
                          outlineMethodOverview: event.target.value
                        }))
                      }
                    />
                  </label>
                  <label>
                    {ui("主要结论")}
                    <textarea
                      value={literatureForm.outlineMainConclusion}
                      onChange={(event) =>
                        setLiteratureForm((current) => ({
                          ...current,
                          outlineMainConclusion: event.target.value
                        }))
                      }
                    />
                  </label>
                  <label>
                    {ui("局限性")}
                    <textarea
                      value={literatureForm.outlineLimitations}
                      onChange={(event) =>
                        setLiteratureForm((current) => ({
                          ...current,
                          outlineLimitations: event.target.value
                        }))
                      }
                    />
                  </label>
                  <label>
                    {ui("其他")}
                    <textarea
                      value={literatureForm.outlineOther}
                      onChange={(event) =>
                        setLiteratureForm((current) => ({
                          ...current,
                          outlineOther: event.target.value
                        }))
                      }
                    />
                  </label>
                </StructuredEditFieldGrid>
              </section>

            </div>
            <DataClearFooterRow
              className="literature-editor-footer"
              contextKey={`literature:outline:${literaturePanelMode}:${editingLiteratureId ?? "new"}`}
              regionLabel={ui("数据清除")}
              clearLabel={t("clear")}
              deleteLabel={ui("删除")}
              onClear={clearLiteratureForm}
              onDelete={
                literaturePanelMode === "edit" && selectedLiterature
                  ? () => void deleteSelectedLiterature()
                  : undefined
              }
              deleteDisabled={!managementDetail?.capabilities.canDelete}
            >
              <button type="submit">{t("save")}</button>
              {literaturePanelMode === "edit" && selectedLiterature ? (
                <button type="button" onClick={() => void archiveSelectedLiterature()}>
                  {selectedLiterature.isArchived ? ui("恢复") : ui("归档")}
                </button>
              ) : null}
            </DataClearFooterRow>
          </form>
          </div>
          ) : null}

          {isProjectSpecificNotesEditorOpen && detailContext ? (
            <div className="literature-editor-backdrop">
              <form
                aria-labelledby="project-specific-notes-editor-title"
                aria-modal="true"
                className="literature-editor-shell"
                onSubmit={(event) => void submitProjectSpecificNotes(event)}
                role="dialog"
              >
                <header className="literature-editor-header">
                  <h2 id="project-specific-notes-editor-title">{ui("编辑专属笔记")}</h2>
                  <button
                    type="button"
                    className="literature-editor-close-button"
                    onClick={closeProjectSpecificNotesEditor}
                  >
                    {ui("关闭")}
                  </button>
                </header>
                <div className="literature-editor-body literature-project-notes-editor-body">
                  <StructuredEditFieldGrid>
                  <label className="semantic-textarea-field-full">
                    {ui("摘要")}
                    <textarea
                      className="semantic-textarea-compact-summary"
                      rows={2}
                      value={projectSpecificNotesForm.projectSummary}
                      onChange={(event) =>
                        setProjectSpecificNotesForm((current) => ({
                          ...current,
                          projectSummary: event.target.value
                        }))
                      }
                    />
                  </label>
                  <label>
                    {ui("课题相关度建议")}
                    <textarea
                      value={projectSpecificNotesForm.projectRelevance}
                      onChange={(event) =>
                        setProjectSpecificNotesForm((current) => ({
                          ...current,
                          projectRelevance: event.target.value
                        }))
                      }
                    />
                  </label>
                  <label>
                    {ui("关联对象")}
                    <textarea
                      value={projectSpecificNotesForm.relatedObjectNotes}
                      onChange={(event) =>
                        setProjectSpecificNotesForm((current) => ({
                          ...current,
                          relatedObjectNotes: event.target.value
                        }))
                      }
                    />
                  </label>
                  <label>
                    {ui("可借鉴方法")}
                    <textarea
                      value={projectSpecificNotesForm.reusableMethods}
                      onChange={(event) =>
                        setProjectSpecificNotesForm((current) => ({
                          ...current,
                          reusableMethods: event.target.value
                        }))
                      }
                    />
                  </label>
                  <label>
                    {ui("可对比结论")}
                    <textarea
                      value={projectSpecificNotesForm.comparableConclusions}
                      onChange={(event) =>
                        setProjectSpecificNotesForm((current) => ({
                          ...current,
                          comparableConclusions: event.target.value
                        }))
                      }
                    />
                  </label>
                  <label>
                    {ui("其他")}
                    <textarea
                      value={projectSpecificNotesForm.other}
                      onChange={(event) =>
                        setProjectSpecificNotesForm((current) => ({
                          ...current,
                          other: event.target.value
                        }))
                      }
                    />
                  </label>
                  </StructuredEditFieldGrid>
                  <label className="checkbox-row research-trace-preference-row literature-project-notes-research-trace">
                    <input
                      type="checkbox"
                      checked={projectSpecificNotesForm.researchTraceDisplayChecked}
                      onChange={(event) =>
                        setProjectSpecificNotesForm((current) => ({
                          ...current,
                          researchTraceDisplayChecked: event.target.checked
                        }))
                      }
                    />
                    <span>{ui("显示在课题研究脉络中")}</span>
                  </label>
                </div>
                <DataClearFooterRow
                  className="literature-editor-footer"
                  contextKey={`literature:notes:${detailContext.literature.id}`}
                  regionLabel={ui("数据清除")}
                  clearLabel={t("clear")}
                  deleteLabel={ui("删除")}
                  onClear={clearProjectSpecificNotesForm}
                  onDelete={() => void deleteSelectedLiterature()}
                  deleteDisabled={!managementDetail?.capabilities.canDelete}
                >
                  <button type="submit">{t("save")}</button>
                </DataClearFooterRow>
              </form>
            </div>
          ) : null}
        </div>

          <div className="literature-workspace-detail-column">
            {selectedLiterature ? (
            <>
            <header className="literature-detail-header">
              <h2>{t("literatureDetailsTitle")}</h2>
              <div className="literature-detail-actions">
                <button
                  className="literature-view-action-button primary-page-action primary-page-action--secondary"
                  type="button"
                  disabled={!managementDetail?.capabilities.canViewBaseDetail}
                  title={ui("打开第一条路径记录")}
                  onClick={() => void handleOpenFirstPathRecord()}
                >
                  {t("view")}
                </button>
                {selectedLiterature?.isArchived ? (
                  <button
                    className="literature-restore-action-button"
                    type="button"
                    onClick={() => void archiveSelectedLiterature()}
                  >
                    {language === "zh-CN" ? "恢复" : "Restore"}
                  </button>
                ) : null}
                <button
                  className="literature-edit-action-button primary-page-action primary-page-action--secondary"
                  type="button"
                  disabled={!managementDetail?.capabilities.canEditMetadata}
                  onClick={() =>
                    selectedLiterature ? void startEditLiterature(selectedLiterature) : undefined
                  }
                >
                  {t("edit")}
                </button>
              </div>
            </header>

            <div className="literature-detail-shell">
              <section className="literature-detail-intro">
                <h3>{titleText}</h3>
                {detailLoadError ? (
                  <p className="literature-detail-load-error" role="alert">
                    {detailLoadError}
                  </p>
                ) : null}
                {managementDegradationMessage ? (
                  <p className="literature-detail-degradation-notice" role="status">
                    {managementDegradationMessage}
                  </p>
                ) : null}
                {selectedLiterature?.isArchived ? (
                  <span className="literature-detail-archive-status">
                    {archiveStatusFilterLabel}: {archivedBadgeLabel}
                  </span>
                ) : null}
                <div className="literature-intro-line">
                  <span>
                    <strong>{ui("作者")}：</strong>
                    {selectedLiterature ? authorPreview : ui("未填写")}
                  </span>
                  <span>
                    <strong>{ui("年份")}：</strong>
                    {displayText(introYear)}
                  </span>
                </div>
                <div className="literature-intro-line">
                  <span>
                    <strong>{primaryProjectLabel}：</strong>
                    {selectedLiterature ? primaryProjectName : noProjectLabel}
                  </span>
                </div>
                <div className="literature-intro-line">
                  <span>
                    <strong>{ui("类型")}：</strong>
                    {displayText(sourceText)}
                  </span>
                </div>
                <div className="literature-intro-line literature-intro-long-line">
                  <span>
                    <strong>{ui("DOI / URL")}：</strong>
                    {displayText(doiOrUrlText)}
                  </span>
                </div>
                <div className="literature-intro-line">
                  <span>
                    <strong>{ui("重要性")}：</strong>
                    {introImportance ? enumLabel(introImportance) : ui("未填写")}
                  </span>
                  <span>
                    <strong>{ui("关键词")}：</strong>
                    {displayText(keywordsText)}
                  </span>
                </div>
              </section>

              <section className="literature-detail-body-card">
                <StructuredSummaryDisplay
                  fields={outlineFields}
                  emptyText={ui("暂无内容")}
                  className="literature-detail-scroll-body"
                />
                <div className="literature-detail-fixed-actions">
                  <button
                    className="literature-generate-result-button"
                    type="button"
                    disabled={!detailContext || selectedLiterature?.isArchived}
                    onClick={() => void openLiteratureOutputGeneration("outline")}
                  >
                    {t("literatureGenerateResultFromOutline")}
                  </button>
                  <LiteratureQuickAnalysisButton
                    className="literature-ai-analysis-button"
                    literatureId={selectedLiterature.id}
                    literatureTitle={selectedLiterature.title}
                    channel="literature_outline"
                    disabled={selectedLiterature.isArchived}
                    expectedProjectOrScopeId={literatureQuickAnalysisScopeId}
                  />
                  <button
                    type="button"
                    className="literature-open-editor-button"
                    disabled={!outlineCurrentReady || !outlineManuscriptEditor.ready || outlineManuscriptEditor.busy}
                    onClick={openReadingMarkdownEditor}
                  >
                    {ui("打开编辑器")}
                  </button>
                </div>
              </section>

              <section className="literature-detail-body-card literature-knowledge-deposit-card">
                <div className="literature-knowledge-deposit-header">
                  <h3>{ui("专属课题笔记")}</h3>
                  <button
                    type="button"
                    disabled={!detailContext}
                    onClick={() => void openProjectSpecificNotesEditor()}
                  >
                    {ui("编辑")}
                  </button>
                </div>
                <StructuredSummaryDisplay
                  fields={knowledgeFields}
                  emptyText={ui("暂无内容")}
                  className="literature-detail-scroll-body"
                />
                <div className="literature-detail-fixed-actions">
                  <button
                    className="literature-generate-result-button"
                    type="button"
                    disabled={!detailContext || selectedLiterature?.isArchived}
                    onClick={() => void openLiteratureOutputGeneration("projectNote")}
                  >
                    {t("literatureGenerateResultFromProjectNote")}
                  </button>
                  <LiteratureQuickAnalysisButton
                    className="literature-ai-analysis-button"
                    literatureId={selectedLiterature.id}
                    literatureTitle={selectedLiterature.title}
                    channel="dedicated_notes"
                    disabled={selectedLiterature.isArchived}
                    expectedProjectOrScopeId={literatureQuickAnalysisScopeId}
                  />
                  <button
                    type="button"
                    className="literature-open-editor-button"
                    disabled={!dedicatedNotesCurrentReady || !dedicatedNotesManuscriptEditor.ready || dedicatedNotesManuscriptEditor.busy}
                    onClick={openProjectSpecificNotesMarkdownEditor}
                  >
                    {ui("打开编辑器")}
                  </button>
                </div>
              </section>

              <section className="literature-path-section file-ref-panel">
                <div className="file-ref-panel-header">
                  <button
                    type="button"
                    className="file-ref-panel-toggle"
                    aria-expanded={isPathRecordsOpen}
                    onClick={() => setIsPathRecordsOpen((current) => !current)}
                  >
                    <span className="file-ref-panel-toggle-icon" aria-hidden="true">
                      {isPathRecordsOpen ? "v" : ">"}
                    </span>
                    <span>{ui("路径记录")}</span>
                  </button>
                  <button
                    type="button"
                    className="file-ref-panel-add-button"
                    disabled={!detailContext}
                    onClick={() => {
                      setIsPathRecordsOpen(true);
                      setEditingLiteratureFileRefId(null);
                      setLiteratureFileRefForm(emptyLiteratureFileRefForm);
                      setIsLiteratureFileRefFormOpen(true);
                    }}
                  >
                    {ui("添加路径记录")}
                  </button>
                </div>
                {isPathRecordsOpen ? (
                  <div className="literature-path-section-body">
                    {detailContext && !dualChannelProvisioningReady ? (
                      <div className="button-row literature-manuscript-actions">
                        <button
                          type="button"
                          disabled={manuscriptEditor.busy}
                          onClick={() => void manuscriptEditor.retryProvisioning()}
                        >
                          {ui("重试初始化文稿")}
                        </button>
                      </div>
                    ) : null}
                    {!detailContext ? (
                      <p className="literature-detail-empty">
                        {ui("路径详情暂时无法加载；基础文献详情和删除仍可使用。")}
                      </p>
                    ) : detailContext.fileRefs.length === 0 ? (
                      <p className="literature-detail-empty">{ui("暂无路径记录")}</p>
                    ) : (
                      <div className="literature-path-list">
                        {detailContext.fileRefs.map((fileRef) => {
                          const isDefaultManagedFolder =
                            fileRef.resourceKind === "folder" &&
                            fileRef.fileRole === "defaultFolder" &&
                            fileRef.locationMode === "managed";
                          const displayTitle = displayText(
                            isDefaultManagedFolder ? ui("工作目录") : fileRef.title,
                            getFileRefPathName(fileRef.path)
                          );
                          const description = isDefaultManagedFolder
                            ? ""
                            : fileRef.description?.trim();
                          return (
                            <article className="literature-path-card file-ref-item" key={fileRef.id}>
                              <div className="file-ref-item-heading">
                                <strong>{displayTitle}</strong>
                                <span>
                                  <strong>{ui("路径摘要")}：</strong>
                                  {fileRef.pathSummary || summarizeFileRefPath(fileRef.path)}
                                </span>
                              </div>
                              {description ? (
                                <p className="literature-path-card-note">{description}</p>
                              ) : null}
                              <div className="file-ref-item-actions literature-path-card-actions">
                                <FileRefPathActions
                                  path={fileRef.path}
                                  resourceKind={fileRef.resourceKind}
                                  openKind={
                                    fileRef.resourceKind === "folder"
                                      ? "folder"
                                      : fileRefService.resolveFileRefOpenKind(fileRef.fileType, fileRef.path)
                                  }
                                  labels={{
                                    open: ui("打开"),
                                    reveal: fileRef.resourceKind === "folder"
                                      ? ui("打开文件夹")
                                      : ui("打开所在文件夹"),
                                    copy: ui("复制路径")
                                  }}
                                  onResult={handleFileRefLocalResult}
                                />
                                {!isDefaultManagedFolder ? (
                                  <>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setEditingLiteratureFileRefId(fileRef.id);
                                        setLiteratureFileRefForm(literatureFileRefToForm(fileRef));
                                        setIsLiteratureFileRefFormOpen(true);
                                      }}
                                    >
                                      {ui("编辑路径记录")}
                                    </button>
                                    <button
                                      type="button"
                                      className="danger-button"
                                      onClick={() => void deleteLiteratureFileRef(fileRef)}
                                    >
                                      {ui("删除路径记录")}
                                    </button>
                                  </>
                                ) : null}
                              </div>
                            </article>
                          );
                        })}
                      </div>
                    )}
                    {detailContext && isLiteratureFileRefFormOpen ? (
                      <form
                        className="module-form file-ref-editor literature-file-ref-form"
                        onSubmit={(event) => void submitLiteratureFileRef(event)}
                      >
                        <h4>
                          {editingLiteratureFileRefId ? ui("编辑路径记录") : ui("添加路径记录")}
                        </h4>
                        <label>
                          {ui("标题")}
                          <input
                            value={literatureFileRefForm.title}
                            onChange={(event) =>
                              setLiteratureFileRefForm((current) => ({
                                ...current,
                                title: event.target.value
                              }))
                            }
                            placeholder={ui("可选；留空时使用路径尾部名称")}
                          />
                        </label>
                        <label>
                          {ui("路径")}
                          <div className="file-ref-path-input-row">
                            <input
                              value={literatureFileRefForm.path}
                              onChange={(event) =>
                                setLiteratureFileRefForm((current) => ({
                                  ...current,
                                  path: event.target.value,
                                  fileType: "other",
                                  resourceKind: current.resourceKind
                                }))
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
                                  setLiteratureFileRefForm((current) => ({
                                    ...current,
                                    path: result.path ?? current.path,
                                    title: current.title || getFileRefPathName(result.path ?? current.path),
                                    fileType: fileTypeFromPathSelection(result),
                                    resourceKind: resourceKindFromPathSelection(result)
                                  }));
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
                            value={literatureFileRefForm.description}
                            onChange={(event) =>
                              setLiteratureFileRefForm((current) => ({
                                ...current,
                                description: event.target.value
                              }))
                            }
                          />
                        </label>
                        <div className="button-row">
                          <button type="submit">
                            {editingLiteratureFileRefId ? ui("保存路径记录") : ui("添加路径记录")}
                          </button>
                          <button
                            type="button"
                            className="secondary-button"
                            onClick={resetLiteratureFileRefForm}
                          >
                            {ui("取消")}
                          </button>
                        </div>
                      </form>
                    ) : null}
                  </div>
                ) : null}
              </section>


            </div>
            </>
            ) : (
              <p className="literature-detail-empty literature-canonical-empty-state">
                {t("literatureSelectEmpty")}
              </p>
            )}
          </div>
        </div>
      </section>

      {outputGenerationDraft && (
        <div className="modal-backdrop" role="presentation">
          <form
            className="external-output-generation-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="literature-output-generation-title"
            onSubmit={(event) => void submitOutputGeneration(event)}
          >
            <div className="operation-confirm-header external-output-generation-header">
              <div>
                <h2 id="literature-output-generation-title">
                  {t("literatureGenerateResult")}
                </h2>
                <p>{outputGenerationDraft.sourceTitle}</p>
              </div>
            </div>

            <div className="external-output-generation-source">
              <div>
                <span>{t("externalGenerateResultSource")}</span>
                <strong>{t("outputSourceTypeLiterature")}</strong>
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
      )}

      <LazyManuscriptSegmentEditorWindow
        isOpen={manuscriptEditor.open}
        entryKind="current"
        loading={!manuscriptEditor.ready || !manuscriptEditor.document}
        descriptorLookupIdentity={{
          ownerType: "literature",
          channel: activeManuscriptChannel
        }}
        disabled={manuscriptEditor.currentSession?.accessMode === "read-only"}
        lifecycle={{
          participantId: `literature-current:${manuscriptEditor.currentHandle ?? "closed"}`,
          handle: manuscriptEditor.currentHandle ?? "closed",
          presentationEpoch: manuscriptEditor.currentPresentationRevision,
          readSession: manuscriptEditor.readCurrentSession
        }}
        contentIdentity={
          manuscriptEditor.document
            ? `${manuscriptEditor.document.fileRefId}:${manuscriptEditor.document.requestToken}`
            : undefined
        }
        entityTitle={detailContext?.literature.title}
        readonlyContextItems={activeStructuredFields.map((field) => ({
          label: field.label,
          value: field.content?.trim() || ui("未填写")
        }))}
        contextInsertion={{
          label: ui("插入上下文结构"),
          isAvailable: Boolean(activeInsertableMarkdown),
          unavailableReason: ui("当前文献尚无可插入的上下文结构。"),
          resolveMarkdown: async () => activeInsertableMarkdown
        }}
        saveLabel={ui("保存文稿")}
        cancelLabel={ui("取消")}
        closeLabel={ui("关闭 Markdown 编辑器")}
        dirtyLabel={ui("有未保存更改")}
        unsavedChangesTitle={ui("当前文稿有未保存更改")}
        unsavedChangesLabel={ui("关闭前，请选择保存更改、放弃更改或取消关闭。")}
        saveChangesLabel={ui("保存并关闭")}
        discardChangesLabel={ui("放弃更改")}
        continueEditingLabel={ui("取消")}
        savingLabel={ui("正在保存…")}
        saveFailedLabel={markdownSaveFailedLabel}
        footerLeadingActions={[
          {
            key: "open-manuscript",
            label: ui("打开文稿"),
            disabled: manuscriptEditor.busy,
            onClick: () => void manuscriptEditor.openTargetManuscript()
          },
          {
            key: "switch-manuscript",
            label: ui("切换文稿"),
            disabled: manuscriptEditor.busy,
            onClick: () => void manuscriptEditor.switchCurrent()
          },
          {
            key: "reload-manuscript",
            label: ui("重新加载"),
            disabled: manuscriptEditor.busy,
            onClick: () => void manuscriptEditor.reloadCurrent()
          },
          {
            key: "literature-current-save-as",
            intent: "save-as",
            label: ui("另存为"),
            disabled: manuscriptEditor.busy,
            onClick: (snapshot) =>
              manuscriptEditor.saveCurrentAsCurrentSession(snapshot)
          }
        ]}
        onCancel={manuscriptEditor.closeEditor}
        onClose={manuscriptEditor.closeEditor}
      />

      <LazyManuscriptSegmentEditorWindow
        isOpen={Boolean(manuscriptEditor.targetDocument)}
        entryKind="independent"
        descriptorLookupIdentity={{
          ownerType: "literature",
          channel: activeManuscriptChannel
        }}
        lifecycle={{
          participantId: `literature-independent:${manuscriptEditor.targetHandle ?? "closed"}`,
          handle: manuscriptEditor.targetHandle ?? "closed",
          presentationEpoch: manuscriptEditor.targetPresentationRevision,
          readSession: manuscriptEditor.readTargetSession
        }}
        contentIdentity={
          manuscriptEditor.targetDocument
            ? `${manuscriptEditor.targetDocument.fileRefId}:${manuscriptEditor.targetDocument.requestToken}:${manuscriptEditor.targetPresentationRevision}`
            : undefined
        }
        entityTitle={detailContext?.literature.title}
        readonlyContextItems={activeStructuredFields.map((field) => ({
          label: field.label,
          value: field.content?.trim() || ui("未设置")
        }))}
        saveLabel={ui("保存文稿")}
        cancelLabel={ui("取消")}
        closeLabel={ui("关闭独立编辑器")}
        dirtyLabel={ui("有未保存更改")}
        unsavedChangesTitle={ui("当前文稿有未保存更改")}
        unsavedChangesLabel={ui("关闭前，请选择保存更改、放弃更改或取消关闭。")}
        saveChangesLabel={ui("保存并关闭")}
        discardChangesLabel={ui("放弃更改")}
        continueEditingLabel={ui("取消")}
        savingLabel={ui("正在保存…")}
        saveFailedLabel={ui("独立编辑文稿保存失败。")}
        footerLeadingActions={[
          {
            key: "literature-independent-reload",
            label: ui("重新加载"),
            disabled: manuscriptEditor.busy,
            onClick: () => void manuscriptEditor.reloadTarget(
              manuscriptEditor.readTargetSession()?.draftRawText ?? ""
            )
          },
          {
            key: "literature-independent-save-as",
            intent: "save-as",
            label: ui("另存为"),
            disabled: manuscriptEditor.busy,
            onClick: (snapshot) =>
              manuscriptEditor.saveTargetAsCurrentSession(snapshot)
          }
        ]}
        onCancel={manuscriptEditor.closeTargetEditor}
        onClose={manuscriptEditor.closeTargetEditor}
      />

      {manuscriptEditor.choiceDialog ? (
        <FormalSwitchConfirmationDialog
          dialogId={`literature-formal-switch-${activeManuscriptChannel}`}
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
      ) : null}
    </div>
  );
}
