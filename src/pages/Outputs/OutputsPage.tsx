import { useEffect, useMemo, useRef, useState } from "react";
import { FileRefPathActions } from "../../components/common/FileRefPathActions";
import { FileRefPathPicker } from "../../components/common/FileRefPathPicker";
import { PageHeader } from "../../components/common/PageHeader";
import { LazyManuscriptSegmentEditorWindow } from "../../components/common/LazyManuscriptSegmentEditorWindow";
import type { ManuscriptSegmentDraftSnapshot } from "../../types/manuscriptSegmentProjection";
import { formatOutputManuscriptContextInsert } from "../../services/outputManuscriptPresentationService";
import { ModalPortal } from "../../components/common/ModalPortal";
import { StructuredSummaryDisplay } from "../../components/common/StructuredSummaryDisplay";
import { WriteFeedbackPanel } from "../../components/feedback/WriteFeedbackPanel";
import { OperationConfirmDialog } from "../../components/safety/OperationConfirmDialog";
import { useOperationConfirm } from "../../hooks/useOperationConfirm";
import { useRefreshEventReload } from "../../hooks/useRefreshEventReload";
import { useWriteFeedbackCenter } from "../../hooks/useWriteFeedbackCenter";
import { useI18n } from "../../i18n/I18nProvider";
import { nonPlanningEnumLabel, nonPlanningUi } from "../../i18n/nonPlanningI18n";
import { outputConversionService } from "../../services/outputConversionService";
import { publishFormalBusinessAttemptFailure } from "../../services/businessOperationFeedbackService";
import { projectFormalSwitchFailure } from "../../services/manuscriptFormalSwitchPresentation";
import {
  outputDepositionService,
  type OutputDepositionInput,
  type OutputDepositionSourceLayer,
  type OutputDepositionTargetLayer
} from "../../services/outputDepositionService";
import {
  confirmOutputDeleteImpactPreview,
  getOutputDeleteImpactPreview,
  softDeleteOutputEntity,
  toOperationImpactPreview
} from "../../services/outputDeleteSafetyService";
import { outputFileRefService } from "../../services/outputFileRefService";
import { fileRefService } from "../../services/fileRefService";
import { outputFiveLayerSelectorService } from "../../services/outputFiveLayerSelectorService";
import {
  outputGapFeedbackCardService
} from "../../services/outputGapFeedbackCardService";
import {
  outputGapFeedbackCardSelectorService,
  type OutputGapFeedbackCardSummary
} from "../../services/outputGapFeedbackCardSelectorService";
import {
  getResearchTraceDisplayChecked,
  saveResearchTraceDisplayPreference
} from "../../services/projectResearchTracePreferenceUiService";
import { buildOutputCanonicalPresentationSummary } from "../../services/outputCanonicalValueCoherenceService";
import { buildOutputFileRefPathRecordViews } from "../../services/outputFileRefPathRecordModel";
import { outputService } from "../../services/outputService";
import { getOutputSourceSummary } from "../../services/outputSourceSelectorService";
import {
  createOperationCancelledFeedback,
  createOperationImpactPreview
} from "../../services/operationImpactPreviewService";
import { planningService } from "../../services/planningService";
import {
  readSharedCurrentProjectSelection,
  resolveSharedCurrentProjectSelection,
  writeSharedCurrentProjectSelection
} from "../../services/sharedCurrentProjectSelection";
import type { FileRef } from "../../types/experiment";
import type { LocalFileResult } from "../../types/localFile";
import type { OutputDeleteSafetyLayer } from "../../types/outputDeleteSafety";
import type {
  Finding,
  OutputCandidate,
  OutputGap,
  OutputGapFeedbackCard,
  OutputGapFeedbackCardPriority,
  OutputGapFeedbackCardStatus,
  OutputGapFeedbackCardType,
  OutputSourceSummary,
  OutputSourceType,
  ResultItem
} from "../../types/outputConversion";
import type { ResearchOutput } from "../../types/output";
import type {
  OutputEntity,
  OutputEntityDetailDto,
  OutputEntityLayer,
  OutputEntityListItemDto
} from "../../types/outputSelector";
import {
  createDefaultStructuredSummary,
  normalizeStructuredSummary
} from "../../types/outputStructuredSummary";
import type { RefreshEvent, RefreshKeyPattern } from "../../types/refresh";
import {
  OutputDepositionModal,
} from "./components/OutputDepositionModal";
import {
  OutputEntityFormModal,
  type OutputEntityFormDraft
} from "./components/OutputEntityFormModal";
import { useOutputsManuscriptEditor } from "./useOutputsManuscriptEditor";
import { SaveAsInterruptedReconciliationNotice } from "../../components/common/SaveAsInterruptedReconciliationNotice";
import { FormalSwitchConfirmationDialog } from "../../components/common/FormalSwitchConfirmationDialog";
import { buildFormalSwitchConfirmationCopy } from "../../services/manuscriptFormalSwitchPresentation";
import { getOutputManuscriptStaticDescriptor } from "../../services/outputManuscriptDescriptorService";
import { OutputQuickAnalysisButton } from "./OutputQuickAnalysisButton";

type Selection = { layer: OutputEntityLayer; id: string };
type LayerLists = Record<OutputEntityLayer, OutputEntityListItemDto[]>;
type LayerSelections = Record<OutputEntityLayer, string | null>;
type LayerDetails = Record<OutputEntityLayer, OutputEntityDetailDto | null>;
type LayerFileRefs = Record<OutputEntityLayer, FileRef[]>;
type LayerSourceSummaries = Record<OutputEntityLayer, OutputSourceSummary | null>;
type LayerFilters = Record<OutputEntityLayer, { status: string; keyword: string }>;
type LayerFoldState = Record<OutputEntityLayer, boolean>;
type PathRecordDraft = {
  layer: OutputEntityLayer;
  ownerId: string;
  fileRefId?: string;
  title: string;
  path: string;
  fileType: string;
  description: string;
};
type OutputProjectOption = {
  id: string;
  title: string;
  status?: string;
};
type OutputGapFeedbackCardFormDraft = {
  title: string;
  description: string;
  status: OutputGapFeedbackCardStatus;
  priority: OutputGapFeedbackCardPriority;
};
type OutputGapFeedbackCardEditorState = {
  mode: "create" | "edit";
  type: OutputGapFeedbackCardType;
  outputGapId: string;
  outputGapTitle: string;
  cardId?: string;
};

const LAYERS: OutputEntityLayer[] = [
  "resultItem",
  "finding",
  "outputCandidate",
  "outputGap",
  "researchOutput"
];

const EMPTY_LISTS: LayerLists = {
  resultItem: [],
  finding: [],
  outputCandidate: [],
  outputGap: [],
  researchOutput: []
};

const EMPTY_SELECTIONS: LayerSelections = {
  resultItem: null,
  finding: null,
  outputCandidate: null,
  outputGap: null,
  researchOutput: null
};

const EMPTY_DETAILS: LayerDetails = {
  resultItem: null,
  finding: null,
  outputCandidate: null,
  outputGap: null,
  researchOutput: null
};

const EMPTY_FILE_REFS: LayerFileRefs = {
  resultItem: [],
  finding: [],
  outputCandidate: [],
  outputGap: [],
  researchOutput: []
};

const EMPTY_SOURCE_SUMMARIES: LayerSourceSummaries = {
  resultItem: null,
  finding: null,
  outputCandidate: null,
  outputGap: null,
  researchOutput: null
};

const EMPTY_FILTERS: LayerFilters = {
  resultItem: { status: "", keyword: "" },
  finding: { status: "", keyword: "" },
  outputCandidate: { status: "", keyword: "" },
  outputGap: { status: "", keyword: "" },
  researchOutput: { status: "", keyword: "" }
};

const CLOSED_FOLDS: LayerFoldState = {
  resultItem: false,
  finding: false,
  outputCandidate: false,
  outputGap: false,
  researchOutput: false
};

const DEFAULT_FORM_TYPE: Record<OutputEntityLayer, string> = {
  resultItem: "other",
  finding: "other",
  outputCandidate: "paper",
  outputGap: "analysis",
  researchOutput: "other"
};

const DEFAULT_FORM_STATUS: Record<OutputEntityLayer, string> = {
  resultItem: "marked",
  finding: "pending_confirmation",
  outputCandidate: "pending_evaluation",
  outputGap: "pending",
  researchOutput: "draft"
};

const STATUS_OPTIONS_BY_LAYER: Record<OutputEntityLayer, readonly string[]> = {
  resultItem: ["pending_review", "marked", "ignored"],
  finding: ["pending_confirmation", "confirmed", "needs_evidence", "abandoned"],
  outputCandidate: [
    "pending_evaluation",
    "needs_gap_resolution",
    "ready_for_formal",
    "converted"
  ],
  outputGap: ["pending", "task_created", "route_feedback_created", "resolved", "abandoned"],
  researchOutput: ["draft", "organizing", "archived"]
};

function isResearchTraceOutputPreferenceLayer(
  layer: OutputEntityLayer
) {
  return (
    layer === "resultItem" ||
    layer === "finding" ||
    layer === "outputCandidate" ||
    layer === "outputGap" ||
    layer === "researchOutput"
  );
}

function defaultResearchTraceDisplayCheckedForOutputLayer(layer: OutputEntityLayer) {
  return layer === "outputCandidate" || layer === "researchOutput";
}

const OUTPUTS_REFRESH_KEYS: RefreshKeyPattern[] = [
  "output.*",
  "outputConversion.*",
  "entityLink.changed",
  "fileRef.changed",
  "recycleBin.changed"
];

const ZH_STATUS_LABELS: Record<string, string> = {
  pending_review: "待复核",
  marked: "已标记",
  ignored: "已忽略",
  pending_confirmation: "待确认",
  confirmed: "已确认",
  needs_evidence: "需补证据",
  abandoned: "已放弃",
  pending_evaluation: "待评估",
  needs_gap_resolution: "需补缺口",
  ready_for_formal: "可转正式成果",
  converted: "已转化",
  pending: "待处理",
  task_created: "已生成任务",
  route_feedback_created: "已反馈路线",
  resolved: "已解决",
  draft: "草稿",
  organizing: "整理中",
  archived: "已归档"
};

function textField(entity: OutputEntity | null, ...names: string[]) {
  if (!entity) return "";
  const row = entity as unknown as Record<string, unknown>;
  for (const name of names) {
    const value = row[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function entityTitle(detail: OutputEntityDetailDto | null) {
  return textField(detail?.entity ?? null, "title", "outputName") || detail?.id || "";
}

function entitySummary(detail: OutputEntityDetailDto | null) {
  const entity = detail?.entity ?? null;
  if (entity && "resultType" in entity) {
    return textField(entity, "summary");
  }
  return textField(detail?.entity ?? null, "summary", "description", "sourceSummary");
}

function entityTitleDescription(layer: OutputEntityLayer, detail: OutputEntityDetailDto | null) {
  if (layer === "resultItem") {
    return textField(detail?.entity ?? null, "summary");
  }
  return textField(
    detail?.entity ?? null,
    "titleDescription",
    "description",
    "summary",
    "note"
  );
}

function createManualResultSourceId() {
  const suffix =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `manual:${suffix}`;
}

export function OutputsPage() {
  const { t, language } = useI18n();
  const ui = (source: string) => nonPlanningUi(language, source);
  const operationConfirm = useOperationConfirm();
  const researchTracePreferenceRequestRef = useRef("");
  const outputsManuscriptEditorHost = useOutputsManuscriptEditor();
  const [projects, setProjects] = useState<OutputProjectOption[]>([]);
  const [projectId, setProjectId] = useState(
    () => readSharedCurrentProjectSelection() ?? ""
  );
  const [lists, setLists] = useState<LayerLists>(EMPTY_LISTS);
  const [selections, setSelections] = useState<LayerSelections>(EMPTY_SELECTIONS);
  const feedbackContext = useMemo(() => ({
    page: "outputs",
    projectId: projectId || undefined,
    ownerKeys: Object.entries(selections).flatMap(([ownerType, ownerId]) =>
      ownerId ? [`${ownerType}:${ownerId}:primary`] : []
    )
  }), [projectId, selections]);
  const feedbackCenter = useWriteFeedbackCenter(feedbackContext);
  const [details, setDetails] = useState<LayerDetails>(EMPTY_DETAILS);
  const [pathFileRefs, setPathFileRefs] = useState<LayerFileRefs>(EMPTY_FILE_REFS);
  const [sourceSummaries, setSourceSummaries] =
    useState<LayerSourceSummaries>(EMPTY_SOURCE_SUMMARIES);
  const [outputGapFeedbackCardSummary, setOutputGapFeedbackCardSummary] =
    useState<OutputGapFeedbackCardSummary | null>(null);
  const [feedbackCardArchiveOpen, setFeedbackCardArchiveOpen] =
    useState<Record<string, boolean>>({});
  const [pendingArchiveFeedbackCard, setPendingArchiveFeedbackCard] =
    useState<OutputGapFeedbackCard | null>(null);
  const [feedbackCardEditor, setFeedbackCardEditor] =
    useState<OutputGapFeedbackCardEditorState | null>(null);
  const [feedbackCardFormDraft, setFeedbackCardFormDraft] =
    useState<OutputGapFeedbackCardFormDraft>({
      title: "",
      description: "",
      status: "pending",
      priority: "medium"
  });
  const [feedbackCardSaving, setFeedbackCardSaving] = useState(false);
  const [feedbackCardError, setFeedbackCardError] = useState("");
  const [sourceFolds, setSourceFolds] = useState<LayerFoldState>(CLOSED_FOLDS);
  const [filters, setFilters] = useState<LayerFilters>(EMPTY_FILTERS);
  const [pathFolds, setPathFolds] = useState<LayerFoldState>(CLOSED_FOLDS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const manuscriptEditorState = outputsManuscriptEditorHost.state;
  const [pendingManuscriptSwitch, setPendingManuscriptSwitch] = useState<{
    fileRefId: string;
    fileName: string;
    locationMode: "managed" | "external";
    preview?: {
      currentFilename: string;
      targetFilename: string;
      importedFieldCount: number;
      missingFieldCount: number;
      missingFieldKeys: string[];
      warnings: string[];
    };
  } | null>(null);
  const [pathDraft, setPathDraft] = useState<PathRecordDraft | null>(null);
  const [pathDraftError, setPathDraftError] = useState("");
  const [entityFormDraft, setEntityFormDraft] = useState<OutputEntityFormDraft | null>(null);
  const [entityFormSaving, setEntityFormSaving] = useState(false);
  const [entityFormError, setEntityFormError] = useState("");
  const [depositionSource, setDepositionSource] = useState<{
    layer: OutputDepositionSourceLayer;
    detail: OutputEntityDetailDto;
    targetLayer: OutputDepositionTargetLayer;
  } | null>(null);
  const [depositionSaving, setDepositionSaving] = useState(false);
  const [depositionError, setDepositionError] = useState("");

  function statusLabel(value?: string) {
    if (!value) return t("notSet");
    if (language === "zh-CN" && ZH_STATUS_LABELS[value]) return ZH_STATUS_LABELS[value];
    return nonPlanningEnumLabel(language, value, t("notSet"));
  }

  function sourceTypeLabel(sourceType: OutputSourceType) {
    const labels: Record<OutputSourceType, string> = {
      experiment: t("outputSourceTypeExperiment"),
      experimentRun: t("outputSourceTypeExperimentRun"),
      literature: t("outputSourceTypeLiterature"),
      review: t("outputSourceTypeReview"),
      other: t("outputSourceTypeOther"),
      resultItem: t("outputSourceTypeResultItem"),
      finding: t("outputSourceTypeFinding"),
      outputCandidate: t("outputSourceTypeOutputCandidate")
    };
    return labels[sourceType];
  }

  function layerLabel(layer: OutputEntityLayer) {
    if (layer === "resultItem") return t("outputAssetLibrary");
    if (layer === "finding") return t("outputFinding");
    if (layer === "outputCandidate") return t("outputCandidate");
    if (layer === "outputGap") return t("outputGap");
    return t("outputLayerResearchOutput");
  }

  function layerShortLabel(layer: OutputEntityLayer) {
    if (layer === "resultItem") return t("outputResultItems");
    return layerLabel(layer);
  }

  function scrollToLayer(layer: OutputEntityLayer) {
    document.getElementById(`outputs-layer-${layer}`)?.scrollIntoView({ block: "start" });
  }

  function selectPrompt(layer: OutputEntityLayer) {
    if (layer === "resultItem") return t("outputSelectAsset");
    if (layer === "finding") return t("outputSelectFinding");
    if (layer === "outputCandidate") return t("outputSelectCandidate");
    if (layer === "outputGap") return t("outputSelectGap");
    return t("outputSelectFormalOutput");
  }

  function outlineLabel(layer: OutputEntityLayer, key: string) {
    const labels: Record<OutputEntityLayer, Record<string, string>> = {
      resultItem: {
        summary: t("outputOutlineResultSummary"),
        keyPhenomenon: t("outputOutlineKeyPhenomenon"),
        conditionBrief: t("outputOutlineConditionBrief"),
        initialJudgement: t("outputOutlineInitialJudgement"),
        conversionValue: t("outputOutlineConversionValue"),
        other: t("outputOutlineOther")
      },
      finding: {
        content: t("outputOutlineFindingContent"),
        supportingEvidence: t("outputOutlineSupportingEvidence"),
        noveltyDifference: t("outputOutlineNoveltyDifference"),
        reliabilityJudgement: t("outputOutlineReliability"),
        boundaryOrMissingEvidence: t("outputOutlineBoundaryEvidence"),
        other: t("outputOutlineOther")
      },
      outputCandidate: {
        coreClaim: t("outputOutlineCoreClaim"),
        outputType: t("outputOutlineOutputType"),
        innovationContribution: t("outputOutlineInnovationContribution"),
        evidenceSummary: t("outputOutlineEvidenceSummary"),
        risksAndGaps: t("outputOutlineRisksAndGaps"),
        other: t("outputOutlineOther")
      },
      outputGap: {
        gapDescription: t("outputOutlineGapDescription"),
        gapType: t("outputOutlineGapType"),
        affectedObject: t("outputOutlineAffectedObject"),
        strengtheningPlan: t("outputOutlineStrengtheningPlan"),
        completionCriteria: t("outputOutlineCompletionCriteria"),
        other: t("outputOutlineOther")
      },
      researchOutput: {
        summary: t("outputOutlineFormalSummary"),
        outputType: t("outputOutlineOutputType"),
        coreContribution: t("outputOutlineCoreContribution"),
        sourceChainSummary: t("outputOutlineSourceChainSummary"),
        archiveUsage: t("outputOutlineArchiveUsage"),
        other: t("outputOutlineOther")
      }
    };
    return labels[layer][key] ?? key;
  }

  function getDefaultOutputGapCandidateId() {
    const selectedCandidate = selections.outputCandidate;
    if (
      selectedCandidate &&
      lists.outputCandidate.some((candidate) => candidate.id === selectedCandidate)
    ) {
      return selectedCandidate;
    }
    return lists.outputCandidate[0]?.id ?? "";
  }

  function createEmptyEntityFormDraft(layer: OutputEntityLayer): OutputEntityFormDraft {
    return {
      mode: "create",
      layer,
      title: "",
      description: "",
      entityType: DEFAULT_FORM_TYPE[layer],
      status: DEFAULT_FORM_STATUS[layer],
      confidence: "",
      maturity: "",
      priority: "",
      resultSummary: "",
      value: "",
      unit: "",
      candidateId: layer === "outputGap" ? getDefaultOutputGapCandidateId() : "",
      usableForPaper: false,
      researchTraceDisplayChecked: defaultResearchTraceDisplayCheckedForOutputLayer(layer),
      structuredSummary: createDefaultStructuredSummary(layer)
    };
  }

  function createEditEntityFormDraft(
    layer: OutputEntityLayer,
    detail: OutputEntityDetailDto
  ): OutputEntityFormDraft {
    const entity = detail.entity;
    if (!entity) return createEmptyEntityFormDraft(layer);
    const base = {
      mode: "edit" as const,
      layer,
      id: entity.id,
      title: entityTitle(detail),
      description: "",
      entityType: DEFAULT_FORM_TYPE[layer],
      status: entity.status,
      confidence: "",
      maturity: "",
      priority: "",
      resultSummary: "",
      value: "",
      unit: "",
      candidateId: "",
      usableForPaper: false,
      researchTraceDisplayChecked: defaultResearchTraceDisplayCheckedForOutputLayer(layer),
      structuredSummary: normalizeStructuredSummary(layer, detail.structuredSummary)
    };
    if (layer === "resultItem") {
      const item = entity as ResultItem;
      return {
        ...base,
        description: "",
        entityType: item.resultType,
        resultSummary: item.summary ?? "",
        value:
          item.value === undefined
            ? ""
            : typeof item.value === "object"
              ? JSON.stringify(item.value)
              : String(item.value),
        unit: item.unit ?? ""
      };
    }
    if (layer === "finding") {
      const finding = entity as Finding;
      return {
        ...base,
        description: finding.summary,
        entityType: finding.findingType ?? "other",
        confidence: finding.confidence ?? "",
        maturity: finding.maturity ?? ""
      };
    }
    if (layer === "outputCandidate") {
      const candidate = entity as OutputCandidate;
      return {
        ...base,
        description: candidate.description ?? "",
        entityType: candidate.candidateType,
        maturity: candidate.maturity ?? "",
        priority: candidate.priority ?? ""
      };
    }
    if (layer === "outputGap") {
      const gap = entity as OutputGap;
      const candidateRelation = detail.relationSummary.find(
        (relation) =>
          (relation.sourceType === "outputGap" &&
            relation.targetType === "outputCandidate" &&
            relation.sourceId === detail.id) ||
          (relation.sourceType === "outputCandidate" &&
            relation.targetType === "outputGap" &&
            relation.targetId === detail.id)
      );
      return {
        ...base,
        description: gap.description ?? "",
        entityType: gap.gapType,
        priority: gap.priority ?? "",
        candidateId:
          candidateRelation?.sourceType === "outputGap"
            ? candidateRelation.targetId
            : candidateRelation?.sourceId ?? ""
      };
    }
    const output = entity as ResearchOutput;
    return {
      ...base,
      description: output.description,
      entityType: output.outputType,
      usableForPaper: output.usableForPaper
    };
  }

  function openCreateEntityForm(layer: OutputEntityLayer) {
    if (!projectId) {
      setError(language === "zh-CN" ? "请先选择课题。" : "Select a project first.");
      return;
    }
    researchTracePreferenceRequestRef.current = "";
    const draft = createEmptyEntityFormDraft(layer);
    setEntityFormError(
      layer === "outputGap" && lists.outputCandidate.length === 0
        ? language === "zh-CN"
          ? "成果缺口必须关联候选成果，请先创建或选择候选成果。"
          : "An output gap must be linked to an output candidate. Create or select a candidate first."
        : ""
    );
    setEntityFormDraft(draft);
  }

  function openEditEntityForm(layer: OutputEntityLayer, detail: OutputEntityDetailDto) {
    if (!detail.entity) return;
    const requestKey = `${detail.entity.projectId}:${layer}:${detail.id}`;
    researchTracePreferenceRequestRef.current = isResearchTraceOutputPreferenceLayer(layer)
      ? requestKey
      : "";
    setEntityFormError("");
    setEntityFormDraft(createEditEntityFormDraft(layer, detail));
    if (isResearchTraceOutputPreferenceLayer(layer)) {
      void loadOutputResearchTracePreference(layer, detail, requestKey);
    }
  }

  function closeEntityForm() {
    if (entityFormSaving) return;
    researchTracePreferenceRequestRef.current = "";
    setEntityFormDraft(null);
    setEntityFormError("");
    setDepositionSource(null);
    setDepositionError("");
  }

  async function loadOutputResearchTracePreference(
    layer: OutputEntityLayer,
    detail: OutputEntityDetailDto,
    requestKey: string
  ) {
    if (!detail.entity) {
      return;
    }
    try {
      const checked = await getResearchTraceDisplayChecked({
        projectId: detail.entity.projectId,
        targetType: layer,
        targetId: detail.id,
        defaultDisplayed: defaultResearchTraceDisplayCheckedForOutputLayer(layer)
      });
      if (researchTracePreferenceRequestRef.current !== requestKey) {
        return;
      }
      setEntityFormDraft((current) =>
        current && current.layer === layer && current.id === detail.id
          ? {
              ...current,
              researchTraceDisplayChecked: checked
            }
          : current
      );
    } catch (cause) {
      feedbackCenter.consumeWriteError(cause, "researchTrace.preference.load");
    }
  }

  async function saveEntityForm(draft: OutputEntityFormDraft) {
    const title = draft.title.trim();
    const description = draft.description.trim();
    const operation = `output.${draft.layer}.${draft.mode}`;
    if (!projectId || !title) {
      setEntityFormError(
        language === "zh-CN" ? "所属课题和标题为必填项。" : "Project and title are required."
      );
      publishFormalBusinessAttemptFailure(operation);
      return;
    }
    if (draft.mode === "create" && draft.layer === "outputGap" && !draft.candidateId) {
      setEntityFormError(
        language === "zh-CN"
          ? "成果缺口必须关联候选成果，请先创建或选择候选成果。"
          : "An output gap must be linked to an output candidate."
      );
      publishFormalBusinessAttemptFailure(operation);
      return;
    }

    setEntityFormSaving(true);
    setEntityFormError("");
    try {
      const structuredSummary = normalizeStructuredSummary(
        draft.layer,
        draft.structuredSummary
      );
      let saved: OutputEntity | undefined;
      if (draft.mode === "create") {
        if (draft.layer === "resultItem") {
          saved = await outputConversionService.createResultItem({
            projectId,
            sourceType: "manual",
            sourceId: createManualResultSourceId(),
            title,
            resultType: draft.entityType as ResultItem["resultType"],
            status: draft.status as ResultItem["status"],
            summary: draft.resultSummary.trim() || undefined,
            value: draft.value.trim() || undefined,
            unit: draft.unit.trim() || undefined,
            isAsset: true,
            structuredSummary
          });
        } else if (draft.layer === "finding") {
          saved = await outputConversionService.createFinding({
            projectId,
            title,
            summary: description,
            findingType: draft.entityType as Finding["findingType"],
            status: draft.status as Finding["status"],
            confidence: (draft.confidence || undefined) as Finding["confidence"],
            maturity: (draft.maturity || undefined) as Finding["maturity"],
            structuredSummary
          });
        } else if (draft.layer === "outputCandidate") {
          saved = await outputConversionService.createOutputCandidate({
            projectId,
            title,
            description: description || undefined,
            candidateType: draft.entityType as OutputCandidate["candidateType"],
            status: draft.status as OutputCandidate["status"],
            maturity: (draft.maturity || undefined) as OutputCandidate["maturity"],
            priority: (draft.priority || undefined) as OutputCandidate["priority"],
            structuredSummary
          });
        } else if (draft.layer === "outputGap") {
          saved = await outputConversionService.createOutputGap({
            projectId,
            outputCandidateId: draft.candidateId,
            confirmedByUser: true,
            title,
            description: description || undefined,
            gapType: draft.entityType as OutputGap["gapType"],
            status: draft.status as OutputGap["status"],
            priority: (draft.priority || undefined) as OutputGap["priority"],
            structuredSummary
          });
        } else {
          saved = await outputService.create({
            projectId,
            outputName: title,
            outputType: draft.entityType as ResearchOutput["outputType"],
            status: draft.status as ResearchOutput["status"],
            usableForPaper: draft.usableForPaper,
            description,
            structuredSummary,
            provenance: {
              sourceType: "manual",
              confirmedByUser: true
            }
          });
        }
      } else if (draft.id) {
        if (draft.layer === "resultItem") {
          saved = await outputConversionService.updateResultItem(draft.id, {
            title,
            summary: draft.resultSummary.trim() || undefined,
            resultType: draft.entityType as ResultItem["resultType"],
            status: draft.status as ResultItem["status"],
            value: draft.value.trim() || undefined,
            unit: draft.unit.trim() || undefined,
            structuredSummary
          });
        } else if (draft.layer === "finding") {
          saved = await outputConversionService.updateFinding(draft.id, {
            title,
            summary: description,
            findingType: draft.entityType as Finding["findingType"],
            status: draft.status as Finding["status"],
            confidence: (draft.confidence || undefined) as Finding["confidence"],
            maturity: (draft.maturity || undefined) as Finding["maturity"],
            structuredSummary
          });
        } else if (draft.layer === "outputCandidate") {
          saved = await outputConversionService.updateOutputCandidate(draft.id, {
            title,
            description: description || undefined,
            candidateType: draft.entityType as OutputCandidate["candidateType"],
            status: draft.status as OutputCandidate["status"],
            maturity: (draft.maturity || undefined) as OutputCandidate["maturity"],
            priority: (draft.priority || undefined) as OutputCandidate["priority"],
            structuredSummary
          });
        } else if (draft.layer === "outputGap") {
          saved = await outputConversionService.updateOutputGap(draft.id, {
            title,
            description: description || undefined,
            gapType: draft.entityType as OutputGap["gapType"],
            status: draft.status as OutputGap["status"],
            priority: (draft.priority || undefined) as OutputGap["priority"],
            structuredSummary
          });
        } else {
          saved = await outputService.update(draft.id, {
            outputName: title,
            outputType: draft.entityType as ResearchOutput["outputType"],
            status: draft.status as ResearchOutput["status"],
            usableForPaper: draft.usableForPaper,
            description,
            structuredSummary
          });
        }
      }
      if (!saved) {
        throw new Error(
          language === "zh-CN" ? "成果对象不存在或保存失败。" : "The output object was not found or could not be saved."
        );
      }
      if (isResearchTraceOutputPreferenceLayer(draft.layer)) {
        try {
          await saveResearchTraceDisplayPreference({
            projectId: saved.projectId,
            targetType: draft.layer,
            targetId: saved.id,
            defaultDisplayed: defaultResearchTraceDisplayCheckedForOutputLayer(draft.layer),
            checked: draft.researchTraceDisplayChecked
          });
        } catch (preferenceError) {
          feedbackCenter.consumeWriteError(
            preferenceError,
            "researchTrace.preference.save"
          );
        }
      }
      const selection = { layer: draft.layer, id: saved.id };
      const refreshedLists = await loadWorkspace(selection);
      if (!refreshedLists?.[draft.layer].some((item) => item.id === saved.id)) {
        throw new Error(
          language === "zh-CN"
            ? "成果对象已提交，但无法从当前正式列表源读取，请检查持久化链路。"
            : "The output object was submitted but could not be read from the current list source."
        );
      }
      feedbackCenter.pushPageFeedback({
        severity: "success",
        title:
          language === "zh-CN"
            ? draft.mode === "create"
              ? "成果对象已创建。"
              : "成果对象已更新。"
            : draft.mode === "create"
              ? "Output object created."
              : "Output object updated.",
        operation: `output.${draft.layer}.${draft.mode}`
      });
      setEntityFormDraft(null);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setEntityFormError(message);
      feedbackCenter.consumeWriteError(cause, operation);
    } finally {
      setEntityFormSaving(false);
    }
  }

  async function loadProjects() {
    try {
      const rows = await planningService.queryProjects();
      const options = rows.map((project) => ({
        id: project.id,
        title: project.title,
        status: project.status
      }));
      setProjects(options);
      setProjectId((current) =>
        options.some((project) => project.id === current)
          ? current
          : resolveSharedCurrentProjectSelection(options)
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function resetWorkspaceForProjectChange() {
    setLists(EMPTY_LISTS);
    setSelections(EMPTY_SELECTIONS);
    setDetails(EMPTY_DETAILS);
    setPathFileRefs(EMPTY_FILE_REFS);
    setSourceSummaries(EMPTY_SOURCE_SUMMARIES);
    setOutputGapFeedbackCardSummary(null);
    setFeedbackCardArchiveOpen({});
    setPendingArchiveFeedbackCard(null);
    setFeedbackCardEditor(null);
    setFeedbackCardError("");
    setSourceFolds(CLOSED_FOLDS);
    setPathFolds(CLOSED_FOLDS);
    setPathDraft(null);
    setPathDraftError("");
    setEntityFormDraft(null);
    setEntityFormError("");
  }

  async function handleProjectChange(nextProjectId: string) {
    if (nextProjectId === projectId) {
      return;
    }
    await outputsManuscriptEditorHost.requestProjectSwitch(nextProjectId, () => {
      resetWorkspaceForProjectChange();
      writeSharedCurrentProjectSelection(nextProjectId);
      setProjectId(nextProjectId);
    });
  }

  async function loadWorkspace(preferred?: Selection, clearLayer?: OutputEntityLayer): Promise<LayerLists | undefined> {
    if (!projectId) {
      setLists(EMPTY_LISTS);
      setSelections(EMPTY_SELECTIONS);
      setDetails(EMPTY_DETAILS);
      setPathFileRefs(EMPTY_FILE_REFS);
      setSourceSummaries(EMPTY_SOURCE_SUMMARIES);
      setOutputGapFeedbackCardSummary(null);
      setFeedbackCardArchiveOpen({});
      setPendingArchiveFeedbackCard(null);
      setFeedbackCardEditor(null);
      setFeedbackCardError("");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const rows = await Promise.all(
        LAYERS.map((layer) =>
          outputFiveLayerSelectorService.listOutputEntities({
            layer,
            projectId,
            includeArchived: false,
            includeDeleted: false
          })
        )
      );
      const nextLists = Object.fromEntries(
        LAYERS.map((layer, index) => [layer, rows[index]])
      ) as LayerLists;
      const nextSelections = { ...selections };
      for (const layer of LAYERS) {
        if (clearLayer === layer) {
          nextSelections[layer] = null;
          continue;
        }
        if (preferred?.layer === layer) {
          nextSelections[layer] = nextLists[layer].some((item) => item.id === preferred.id)
            ? preferred.id
            : null;
          continue;
        }
        const current = nextSelections[layer];
        if (current && !nextLists[layer].some((item) => item.id === current)) {
          nextSelections[layer] = null;
        }
      }
      const detailRows = await Promise.all(
        LAYERS.map(async (layer) => {
          const id = nextSelections[layer];
          if (!id) return null;
          const detail = await outputFiveLayerSelectorService.getOutputEntityDetail({
            layer,
            id,
            includeDeleted: false
          });
          return detail.entity ? detail : null;
        })
      );
      const outputGapDetail = detailRows[LAYERS.indexOf("outputGap")];
      const [fileRefRows, sourceSummaryRows, nextOutputGapFeedbackCardSummary] = await Promise.all([
        Promise.all(
          LAYERS.map((layer, index) => {
            const detail = detailRows[index];
            return detail
              ? outputFileRefService.listOutputFileRefs(layer, detail.id)
              : Promise.resolve([]);
          })
        ),
        Promise.all(
          LAYERS.map((layer, index) => {
            const detail = detailRows[index];
            return detail
              ? getOutputSourceSummary(layer, detail.id)
              : Promise.resolve(null);
          })
        ),
        outputGapDetail?.entity && outputGapDetail.id
          ? outputGapFeedbackCardSelectorService.getOutputGapFeedbackCardSummary(outputGapDetail.id)
          : Promise.resolve(null)
      ]);
      setLists(nextLists);
      setSelections(nextSelections);
      setDetails(
        Object.fromEntries(LAYERS.map((layer, index) => [layer, detailRows[index]])) as LayerDetails
      );
      setPathFileRefs(
        Object.fromEntries(LAYERS.map((layer, index) => [layer, fileRefRows[index]])) as LayerFileRefs
      );
      setSourceSummaries(
        Object.fromEntries(
          LAYERS.map((layer, index) => [layer, sourceSummaryRows[index]])
        ) as LayerSourceSummaries
      );
      setOutputGapFeedbackCardSummary(nextOutputGapFeedbackCardSummary);
      return nextLists;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return undefined;
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadProjects();
  }, []);

  useEffect(() => {
    resetWorkspaceForProjectChange();
    void loadWorkspace();
  }, [projectId]);

  useEffect(() => {
    if (!pendingArchiveFeedbackCard) return;
    const summary = outputGapFeedbackCardSummary;
    const stillActive = summary?.activeCards.some((card) => card.id === pendingArchiveFeedbackCard.id);
    if (!stillActive) {
      setPendingArchiveFeedbackCard(null);
    }
  }, [outputGapFeedbackCardSummary, pendingArchiveFeedbackCard]);

  async function reloadCurrentPage(_event?: RefreshEvent) {
    await loadWorkspace();
  }

  useRefreshEventReload({
    pageName: "outputs",
    watchedKeys: OUTPUTS_REFRESH_KEYS,
    reload: reloadCurrentPage,
    onRefreshFeedback: feedbackCenter.pushRefreshEventFeedback,
    onReloadError: (cause, event) =>
      feedbackCenter.pushReloadErrorFeedback(cause, event, "outputs")
  });

  async function selectEntityImmediately(
    layer: OutputEntityLayer,
    id: string
  ) {
    setError("");
    setSelections((current) => ({ ...current, [layer]: id }));
    setPathFolds((current) => ({ ...current, [layer]: false }));
    setSourceFolds((current) => ({ ...current, [layer]: false }));
    setPathDraft(null);
    setPathDraftError("");
    try {
      const [detail, fileRefs, sourceSummary, feedbackCardSummary] = await Promise.all([
        outputFiveLayerSelectorService.getOutputEntityDetail({
          layer,
          id,
          includeDeleted: false
        }),
        outputFileRefService.listOutputFileRefs(layer, id),
        getOutputSourceSummary(layer, id),
        layer === "outputGap"
          ? outputGapFeedbackCardSelectorService.getOutputGapFeedbackCardSummary(id)
          : Promise.resolve(null)
      ]);
      setDetails((current) => ({ ...current, [layer]: detail.entity ? detail : null }));
      setPathFileRefs((current) => ({ ...current, [layer]: fileRefs }));
      setSourceSummaries((current) => ({ ...current, [layer]: sourceSummary }));
      if (layer === "outputGap") {
        setOutputGapFeedbackCardSummary(feedbackCardSummary);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPathFileRefs((current) => ({ ...current, [layer]: [] }));
      setSourceSummaries((current) => ({ ...current, [layer]: null }));
      if (layer === "outputGap") {
        setOutputGapFeedbackCardSummary(null);
      }
    }
  }

  async function selectEntity(layer: OutputEntityLayer, id: string) {
    const activeOwner = manuscriptEditorState.session?.owner;
    if (
      activeOwner &&
      (activeOwner.ownerType !== layer || activeOwner.ownerId !== id)
    ) {
      const result =
        await outputsManuscriptEditorHost.requestSelectionChange(
          { ownerType: layer, ownerId: id },
          () => selectEntityImmediately(layer, id)
        );
      if (result.status === "error") {
        feedbackCenter.consumeWriteError(
          new Error(result.error),
          "output.markdown.selectionChange"
        );
      }
      return;
    }
    await selectEntityImmediately(layer, id);
  }

  async function refreshSourceSummary(layer: OutputEntityLayer, id: string) {
    const sourceSummary = await getOutputSourceSummary(layer, id);
    setSourceSummaries((current) => ({ ...current, [layer]: sourceSummary }));
  }

  async function refreshOutputGapFeedbackCardSummary(outputGapId: string) {
    const summary =
      await outputGapFeedbackCardSelectorService.getOutputGapFeedbackCardSummary(
        outputGapId
      );
    setOutputGapFeedbackCardSummary(summary);
    return summary;
  }

  async function openOutputManuscript(ownerType: OutputEntityLayer, ownerId: string) {
    try {
      const result = await outputsManuscriptEditorHost.openOutputManuscript(
        ownerType,
        ownerId
      );
      if (result.status === "error") throw new Error(result.error);
    } catch (cause) {
      feedbackCenter.consumeWriteError(cause, "output.markdown.load");
    }
  }

  async function saveMarkdownAs(
    sourceWindowRole: "current" | "independent",
    snapshot?: ManuscriptSegmentDraftSnapshot
  ) {
    try {
      const result =
        sourceWindowRole === "current"
          ? await outputsManuscriptEditorHost.saveCurrentAs(snapshot)
          : await outputsManuscriptEditorHost.saveIndependentAs(snapshot);
      if (result.status === "error") throw new Error(result.error);
      if (result.status === "skipped") return;
      feedbackCenter.pushPageFeedback({
        severity: "success",
        title: t("outputsManuscriptCopySaved"),
        operation: "output.markdown.saveAs"
      });
    } catch (cause) {
      feedbackCenter.consumeWriteError(cause, "output.markdown.saveAs");
    }
  }

  async function reloadMarkdown() {
    const result = await outputsManuscriptEditorHost.requestReload();
    if (result.status === "error") {
      feedbackCenter.consumeWriteError(new Error(result.error), "output.markdown.reload");
    }
  }

  async function openIndependentMarkdown() {
    const result = await outputsManuscriptEditorHost.openIndependentManuscript();
    if (result.status === "error") {
      feedbackCenter.consumeWriteError(new Error(result.error), "output.markdown.openIndependent");
    }
  }

  function confirmAndSwitchMarkdown(selection: {
    fileRefId: string;
    fileName: string;
    locationMode: "managed" | "external";
    preview?: {
      currentFilename: string;
      targetFilename: string;
      importedFieldCount: number;
      missingFieldCount: number;
      missingFieldKeys: string[];
      warnings: string[];
    };
  }) {
    setPendingManuscriptSwitch(selection);
  }

  async function executePendingManuscriptSwitch() {
    const selection = pendingManuscriptSwitch;
    if (!selection) return;
    const result = await outputsManuscriptEditorHost.requestFormalSwitch(
      selection.fileRefId
    );
    if (result.status === "error") {
      feedbackCenter.consumeWriteError(new Error(result.error), "output.markdown.switch");
      return;
    }
    if (result.status === "success") {
      feedbackCenter.pushPageFeedback({
        severity: "success",
        title: t("outputsManuscriptSwitched"),
        operation: "output.markdown.switch"
      });
      setPendingManuscriptSwitch(null);
      return;
    }
    if (result.status === "decision-required" || result.status === "skipped") {
      setPendingManuscriptSwitch(null);
    }
  }

  async function switchMarkdownManuscript() {
    const result = await outputsManuscriptEditorHost.requestSelectForFormalSwitch();
    if (result.status === "error") {
      feedbackCenter.consumeWriteError(new Error(projectFormalSwitchFailure(result, ui).summary), "output.markdown.selectSwitch");
      return;
    }
    if (result.status === "success" && result.selection) {
      confirmAndSwitchMarkdown(result.selection);
    }
  }

  async function closeMarkdownEditor() {
    await outputsManuscriptEditorHost.requestClose();
  }

  async function executeConfirmedSoftDelete(layer: OutputEntityLayer, id: string) {
    try {
      const deletePreview = await getOutputDeleteImpactPreview({
        layer: layer as OutputDeleteSafetyLayer,
        id,
        mode: "softDelete"
      });
      const impactPreview = toOperationImpactPreview(deletePreview);
      if (!(await operationConfirm.requestConfirmation(impactPreview))) {
        feedbackCenter.consumeWriteResult(
          createOperationCancelledFeedback(impactPreview, t("operationCancelled")),
          { operation: impactPreview.operationId }
        );
        return "skipped" as const;
      }
      const confirmation = confirmOutputDeleteImpactPreview(deletePreview);
      const result = await softDeleteOutputEntity({ confirmation });
      feedbackCenter.consumeWriteResult(result, {
        operation: impactPreview.operationId,
        successMessage: t("outputDeleteSuccess"),
        skippedMessage: t("outputActionSkipped")
      });
      if (!result.ok) return "skipped" as const;
      await loadWorkspace(undefined, layer);
      return result.status;
    } catch (cause) {
      feedbackCenter.consumeWriteError(cause, `output.${layer}.softDelete`);
      return "skipped" as const;
    }
  }

  async function confirmAndSoftDelete(layer: OutputEntityLayer, id: string) {
    const deleteTerminal = { status: undefined as "success" | "partial" | "skipped" | undefined };
    const lifecycleResult = await outputsManuscriptEditorHost.requestDeleteOwner(
      layer,
      id,
      async () => {
        deleteTerminal.status = await executeConfirmedSoftDelete(layer, id);
        return deleteTerminal.status === "success" || deleteTerminal.status === "partial";
      }
    );
    return lifecycleResult.status === "success" && deleteTerminal.status === "partial"
      ? { ...lifecycleResult, status: "partial" as const }
      : lifecycleResult;
  }

  function openDeposition(
    layer: OutputDepositionSourceLayer,
    detail: OutputEntityDetailDto,
    targetLayer: OutputDepositionTargetLayer
  ) {
    if (!detail.entity) return;
    setDepositionError("");
    setDepositionSource({ layer, detail, targetLayer });
  }

  function closeDeposition() {
    if (depositionSaving) return;
    setDepositionSource(null);
    setDepositionError("");
  }

  function depositionErrorMessage(cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (message.includes("already exists")) return t("outputDepositionDuplicate");
    if (message.includes("another project")) return t("outputDepositionCrossProject");
    if (message.includes("Invalid output deposition path")) {
      return t("outputDepositionInvalidPath");
    }
    if (message.includes("requires explicit user confirmation")) {
      return t("outputDepositionConfirmationRequired");
    }
    return t("outputDepositionWriteFailed");
  }

  async function submitDeposition(input: OutputDepositionInput) {
    setDepositionSaving(true);
    setDepositionError("");
    try {
      const result = await outputDepositionService.executeOutputDeposition(input);
      const refreshedLists = await loadWorkspace({
        layer: result.targetLayer,
        id: result.targetId
      });
      if (!refreshedLists?.[result.targetLayer].some((item) => item.id === result.targetId)) {
        throw new Error("Output deposition target is missing after workspace refresh.");
      }
      feedbackCenter.pushPageFeedback({
        severity: "success",
        title:
          result.mode === "createNew"
            ? t("outputDepositionCreateSuccess")
            : t("outputDepositionAddSuccess"),
        operation: `output.deposition.${result.mode}`
      });
      setDepositionSource(null);
    } catch (cause) {
      setDepositionError(depositionErrorMessage(cause));
      feedbackCenter.consumeWriteError(cause, `output.deposition.${input.mode}`);
    } finally {
      setDepositionSaving(false);
    }
  }

  function feedbackCardTypeLabel(type: OutputGapFeedbackCardType) {
    return type === "route"
      ? t("outputGapFeedbackCardRoute")
      : t("outputGapFeedbackCardTask");
  }

  function feedbackCardStatusLabel(status: OutputGapFeedbackCardStatus) {
    return status === "pending"
      ? t("outputGapFeedbackCardPending")
      : t("outputGapFeedbackCardResolved");
  }

  function feedbackCardPriorityLabel(priority: OutputGapFeedbackCardPriority) {
    if (priority === "high") return t("outputGapFeedbackCardPriorityHigh");
    if (priority === "low") return t("outputGapFeedbackCardPriorityLow");
    return t("outputGapFeedbackCardPriorityMedium");
  }

  function feedbackCardDefaultDescription(outputGapTitle: string) {
    return t("outputGapFeedbackCardDescriptionDefault").replace(
      "{title}",
      outputGapTitle
    );
  }

  function feedbackCardErrorMessage(cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (message.includes("title is required")) return t("outputGapFeedbackCardTitleRequired");
    if (message.includes("OutputGap not found")) return t("outputGapFeedbackCardGapMissing");
    return t("outputGapFeedbackCardWriteFailed");
  }

  function openFeedbackCardCreate(type: OutputGapFeedbackCardType, detail: OutputEntityDetailDto) {
    if (!detail.entity) return;
    const outputGapTitle = entityTitle(detail);
    setFeedbackCardEditor({
      mode: "create",
      type,
      outputGapId: detail.id,
      outputGapTitle
    });
    setFeedbackCardFormDraft({
      title:
        type === "route"
          ? t("outputGapFeedbackCardDefaultRouteTitle")
          : t("outputGapFeedbackCardDefaultTaskTitle"),
      description: feedbackCardDefaultDescription(outputGapTitle),
      status: "pending",
      priority: "medium"
    });
    setFeedbackCardError("");
  }

  function openFeedbackCardEdit(card: OutputGapFeedbackCard, outputGapTitle: string) {
    setFeedbackCardEditor({
      mode: "edit",
      type: card.type,
      outputGapId: card.outputGapId,
      outputGapTitle,
      cardId: card.id
    });
    setFeedbackCardFormDraft({
      title: card.title,
      description: card.description ?? "",
      status: card.status,
      priority: card.priority
    });
    setFeedbackCardError("");
  }

  function closeFeedbackCardEditor() {
    if (feedbackCardSaving) return;
    setFeedbackCardEditor(null);
    setFeedbackCardError("");
  }

  async function submitFeedbackCardForm() {
    if (!feedbackCardEditor) return;
    const title = feedbackCardFormDraft.title.trim();
    const description = feedbackCardFormDraft.description.trim();
    if (!title) {
      setFeedbackCardError(t("outputGapFeedbackCardTitleRequired"));
      return;
    }
    setFeedbackCardSaving(true);
    setFeedbackCardError("");
    try {
      if (feedbackCardEditor.mode === "create") {
        await outputGapFeedbackCardService.createOutputGapFeedbackCard({
          outputGapId: feedbackCardEditor.outputGapId,
          type: feedbackCardEditor.type,
          title,
          description: description || feedbackCardDefaultDescription(
            feedbackCardEditor.outputGapTitle
          ),
          status: feedbackCardFormDraft.status,
          priority: feedbackCardFormDraft.priority
        });
      } else if (feedbackCardEditor.cardId) {
        await outputGapFeedbackCardService.updateOutputGapFeedbackCard(
          feedbackCardEditor.cardId,
          {
            title,
            description: description || null,
            status: feedbackCardFormDraft.status,
            priority: feedbackCardFormDraft.priority
          }
        );
      }
      await refreshOutputGapFeedbackCardSummary(feedbackCardEditor.outputGapId);
      feedbackCenter.pushPageFeedback({
        severity: "success",
        title:
          feedbackCardEditor.mode === "create"
            ? t("outputGapFeedbackCardCreated")
            : t("outputGapFeedbackCardUpdated"),
        operation: `output.feedbackCard.${feedbackCardEditor.mode}`
      });
      setFeedbackCardEditor(null);
    } catch (cause) {
      setFeedbackCardError(feedbackCardErrorMessage(cause));
      feedbackCenter.consumeWriteError(cause, "output.feedbackCard.save");
    } finally {
      setFeedbackCardSaving(false);
    }
  }

  async function setFeedbackCardStatus(
    card: OutputGapFeedbackCard,
    status: OutputGapFeedbackCardStatus
  ) {
    try {
      await outputGapFeedbackCardService.setOutputGapFeedbackCardStatus(card.id, status);
      await refreshOutputGapFeedbackCardSummary(card.outputGapId);
      feedbackCenter.pushPageFeedback({
        severity: "success",
        title: t("outputGapFeedbackCardStatusUpdated"),
        operation: "output.feedbackCard.status"
      });
    } catch (cause) {
      feedbackCenter.consumeWriteError(cause, "output.feedbackCard.status");
    }
  }

  async function executeArchiveFeedbackCard(card: OutputGapFeedbackCard) {
    try {
      await outputGapFeedbackCardService.archiveOutputGapFeedbackCard(card.id);
      await refreshOutputGapFeedbackCardSummary(card.outputGapId);
      feedbackCenter.pushPageFeedback({
        severity: "success",
        title: t("outputGapFeedbackCardArchivedSuccess"),
        operation: "output.feedbackCard.archive"
      });
    } catch (cause) {
      feedbackCenter.consumeWriteError(cause, "output.feedbackCard.archive");
    }
  }

  async function archiveFeedbackCard(card: OutputGapFeedbackCard) {
    if (card.status === "pending") {
      setPendingArchiveFeedbackCard(card);
      return;
    }
    await executeArchiveFeedbackCard(card);
  }

  function cancelPendingArchiveFeedbackCard() {
    setPendingArchiveFeedbackCard(null);
  }

  async function confirmPendingArchiveFeedbackCard() {
    const card = pendingArchiveFeedbackCard;
    if (!card) return;
    setPendingArchiveFeedbackCard(null);
    await executeArchiveFeedbackCard(card);
  }

  async function restoreFeedbackCard(card: OutputGapFeedbackCard) {
    try {
      await outputGapFeedbackCardService.restoreOutputGapFeedbackCard(card.id);
      await refreshOutputGapFeedbackCardSummary(card.outputGapId);
      feedbackCenter.pushPageFeedback({
        severity: "success",
        title: t("outputGapFeedbackCardRestored"),
        operation: "output.feedbackCard.restore"
      });
    } catch (cause) {
      feedbackCenter.consumeWriteError(cause, "output.feedbackCard.restore");
    }
  }

  async function deleteArchivedFeedbackCard(card: OutputGapFeedbackCard) {
    const impactPreview = createOperationImpactPreview({
      operationId: `output.feedbackCard.deleteArchived.${card.id}`,
      operation: "delete",
      target: {
        type: "outputGapFeedbackCard",
        id: card.id,
        title: card.title
      },
      summary: t("outputGapFeedbackCardConfirmDelete"),
      riskLevel: "medium",
      executionKind: "other",
      isRecoverable: false,
      hasRestoreEntry: false,
      requiresUserConfirmation: true,
      canProceed: true,
      affectedItems: [
        {
          entityType: "outputGapFeedbackCard",
          entityId: card.id,
          title: card.title,
          description: t("outputGapFeedbackCardConfirmDelete"),
          severity: "warning"
        }
      ],
      warnings: [t("outputGapFeedbackCardConfirmDelete")],
      blockingReasons: [],
      deepScanPerformed: false
    });
    if (!(await operationConfirm.requestConfirmation(impactPreview))) {
      feedbackCenter.consumeWriteResult(
        createOperationCancelledFeedback(impactPreview, t("operationCancelled")),
        { operation: impactPreview.operationId }
      );
      return;
    }
    try {
      await outputGapFeedbackCardService.deleteOutputGapFeedbackCard(card.id);
      await refreshOutputGapFeedbackCardSummary(card.outputGapId);
      feedbackCenter.pushPageFeedback({
        severity: "success",
        title: t("outputGapFeedbackCardDeleted"),
        operation: "output.feedbackCard.deleteArchived"
      });
    } catch (cause) {
      feedbackCenter.consumeWriteError(cause, "output.feedbackCard.deleteArchived");
    }
  }

  function renderListButton(layer: OutputEntityLayer, item: OutputEntityListItemDto) {
    return (
      <button
        type="button"
        key={item.id}
        className={
          selections[layer] === item.id
            ? "outputs-formal-list-card is-active"
            : "outputs-formal-list-card"
        }
        onClick={() => void selectEntity(layer, item.id)}
      >
        <strong>{item.title}</strong>
        <span>
          {statusLabel(item.status)} · {new Date(item.updatedAt).toLocaleDateString()}
        </span>
      </button>
    );
  }

  function startAddPathRecord(layer: OutputEntityLayer, ownerId: string) {
    setPathFolds((current) => ({ ...current, [layer]: true }));
    setPathDraft({
      layer,
      ownerId,
      title: "",
      path: "",
      fileType: "other",
      description: ""
    });
    setPathDraftError("");
  }

  function startEditPathRecord(layer: OutputEntityLayer, ownerId: string, fileRef: FileRef) {
    setPathFolds((current) => ({ ...current, [layer]: true }));
    setPathDraft({
      layer,
      ownerId,
      fileRefId: fileRef.id,
      title: fileRef.title,
      path: fileRef.path,
      fileType: fileRef.fileType,
      description: fileRef.description ?? ""
    });
    setPathDraftError("");
  }

  function closePathRecordForm() {
    setPathDraft(null);
    setPathDraftError("");
  }

  function handleSelectedPath(path: string) {
    setPathDraft((current) =>
      current
        ? {
            ...current,
            path,
            title: current.title.trim() || fileRefService.getPathDisplayName(path)
          }
        : current
    );
    setPathDraftError("");
  }

  function handleLocalFileResult(result: LocalFileResult) {
    const feedback = fileRefService.toFileRefActionFeedback(result);
    if (!feedback) return;
    if (result.status === "failed") {
      setPathDraftError(result.errorMessage ?? t("outputPathActionFailed"));
    }
    feedbackCenter.pushPageFeedback({
      severity: feedback.severity,
      title: feedback.message,
      operation: feedback.operation
    });
  }

  async function savePathRecord() {
    if (!pathDraft) return;
    const path = pathDraft.path.trim();
    if (!path) {
      setPathDraftError(t("outputPathRequired"));
      return;
    }
    const title =
      pathDraft.title.trim() || fileRefService.getPathDisplayName(path) || undefined;
    const operation = pathDraft.fileRefId ? "output.fileRef.update" : "output.fileRef.add";
    setPathDraftError("");
    try {
      const result = pathDraft.fileRefId
        ? await outputFileRefService.updateOutputFileRefMetadata({
            fileRefId: pathDraft.fileRefId,
            ownerType: pathDraft.layer,
            ownerId: pathDraft.ownerId,
            title,
            path,
            description: pathDraft.description.trim() || null,
            fileType: pathDraft.fileType || "other",
            source: "user"
          })
        : await outputFileRefService.addOutputFileRefMetadata({
            ownerType: pathDraft.layer,
            ownerId: pathDraft.ownerId,
            title,
            path,
            description: pathDraft.description.trim() || undefined,
            fileType: pathDraft.fileType || "other",
            source: "user"
          });
      feedbackCenter.consumeWriteResult(result, {
        operation,
        successMessage: pathDraft.fileRefId
          ? t("outputPathRecordUpdated")
          : t("outputPathRecordAdded"),
        skippedMessage: t("outputActionSkipped")
      });
      if (result.ok) {
        const selection = { layer: pathDraft.layer, id: pathDraft.ownerId };
        closePathRecordForm();
        await loadWorkspace(selection);
      } else {
        setPathDraftError(result.warnings.join(" ") || t("outputPathActionFailed"));
      }
    } catch (cause) {
      setPathDraftError(cause instanceof Error ? cause.message : String(cause));
      feedbackCenter.consumeWriteError(cause, operation);
    }
  }

  async function deletePathRecord(layer: OutputEntityLayer, ownerId: string, fileRefId: string, title: string) {
    const impactPreview = createOperationImpactPreview({
      operationId: `output.fileRef.remove.${fileRefId}`,
      operation: "detach",
      target: { type: "fileRef", id: fileRefId, title },
      summary: t("outputDeletePathRecordPreview"),
      riskLevel: "medium",
      executionKind: "detach",
      isRecoverable: true,
      hasRestoreEntry: true,
      requiresUserConfirmation: true,
      canProceed: true,
      affectedItems: [],
      warnings: [],
      blockingReasons: [],
      deepScanPerformed: false
    });
    if (!(await operationConfirm.requestConfirmation(impactPreview))) return;
    try {
      const result = await outputFileRefService.removeOutputFileRefMetadata({
        fileRefId,
        confirmedMetadataOnly: true
      });
      feedbackCenter.consumeWriteResult(result, {
        operation: impactPreview.operationId,
        successMessage: t("outputPathRecordDeleted"),
        skippedMessage: t("outputActionSkipped")
      });
      if (result.ok) {
        if (pathDraft?.fileRefId === fileRefId) {
          closePathRecordForm();
        }
        await loadWorkspace({ layer, id: ownerId });
      }
    } catch (cause) {
      feedbackCenter.consumeWriteError(cause, impactPreview.operationId);
    }
  }

  const filteredLists = useMemo(() => {
    return Object.fromEntries(
      LAYERS.map((layer) => {
        const filter = filters[layer];
        const rows = lists[layer].filter((item) => {
          const statusMatches = !filter.status || item.status === filter.status;
          const keyword = filter.keyword.trim().toLocaleLowerCase();
          const keywordMatches =
            !keyword ||
            [item.title, item.structuredSummaryPreview ?? ""].some((value) =>
              value.toLocaleLowerCase().includes(keyword)
            );
          return statusMatches && keywordMatches;
        });
        return [layer, rows];
      })
    ) as LayerLists;
  }, [filters, lists]);

  function renderSourceSummary(layer: OutputEntityLayer) {
    const summary = sourceSummaries[layer];
    const isOpen = sourceFolds[layer];
    const counts = summary
      ? (Object.entries(summary.countsBySourceType) as Array<[OutputSourceType, number]>)
          .filter(([, count]) => count > 0)
      : [];
    const summaryText =
      summary && summary.total > 0
        ? `${t("outputSourceSummary")}：${counts
            .map(([sourceType, count]) => `${sourceTypeLabel(sourceType)} ${count}`)
            .join(" · ")}`
        : t("outputSourceEmpty");

    return (
      <div className="outputs-formal-source-summary">
        <button
          type="button"
          className="outputs-formal-source-toggle"
          aria-expanded={isOpen}
          disabled={!summary?.total}
          onClick={() =>
            setSourceFolds((current) => ({ ...current, [layer]: !current[layer] }))
          }
        >
          <span>{summary?.total ? summaryText : t("outputSourceEmpty")}</span>
          {summary?.hasMissingSources ? (
            <small>{t("outputSourceHasMissing")}</small>
          ) : null}
          {summary?.total ? <span aria-hidden="true">{isOpen ? "v" : ">"}</span> : null}
        </button>
        {isOpen && summary?.total ? (
          <section className="outputs-formal-source-cards" aria-label={t("outputSourceCards")}>
            {summary.cards.map((card) => (
              <article
                className={`outputs-formal-source-card${card.sourceStatus === "missing" ? " is-missing" : ""}`}
                key={card.id}
              >
                <div className="outputs-formal-source-card-header">
                  <strong>
                    {card.sourceStatus === "missing"
                      ? card.sourceTitleSnapshot
                      : card.sourceTitle}
                  </strong>
                  <span>{sourceTypeLabel(card.sourceType)}</span>
                </div>
                {card.sourceNote ? (
                  <p className="outputs-formal-source-note">{card.sourceNote}</p>
                ) : null}
                {card.sourceSummarySnapshot ? (
                  <p className="outputs-formal-source-snapshot">
                    {card.sourceSummarySnapshot}
                  </p>
                ) : null}
                {card.sourceStatus === "missing" ? (
                  <p className="outputs-formal-source-warning">
                    {t("outputSourceMissing")}
                  </p>
                ) : null}
              </article>
            ))}
          </section>
        ) : null}
      </div>
    );
  }

  function renderLayerActions(layer: OutputEntityLayer, detail: OutputEntityDetailDto) {
    const id = detail.id;
    const title = entityTitle(detail);
    return (
      <div className="outputs-formal-actions">
        {layer === "resultItem" ? (
          <button
            type="button"
            className="outputs-formal-action-button"
            onClick={() => openDeposition(layer, detail, "finding")}
          >
            {t("outputMarkAsFinding")}
          </button>
        ) : null}
        {layer === "finding" ? (
          <button
            type="button"
            className="outputs-formal-action-button"
            onClick={() => openDeposition(layer, detail, "outputCandidate")}
          >
            {t("outputPromoteCandidate")}
          </button>
        ) : null}
        {layer === "outputCandidate" ? (
          <>
            <button
              type="button"
              className="outputs-formal-action-button"
              onClick={() => openDeposition(layer, detail, "outputGap")}
            >
              {t("outputCheckGap")}
            </button>
            <button
              type="button"
              className="outputs-formal-action-button"
              onClick={() => openDeposition(layer, detail, "researchOutput")}
            >
              {t("outputConvertFormal")}
            </button>
          </>
        ) : null}
        {layer === "outputGap" ? (
          <>
            <button
              type="button"
              className="outputs-formal-action-button"
              onClick={() => openFeedbackCardCreate("route", detail)}
            >
              {t("outputGapFeedbackCardCreateRoute")}
            </button>
            <button
              type="button"
              className="outputs-formal-action-button"
              onClick={() => openFeedbackCardCreate("task", detail)}
            >
              {t("outputGapFeedbackCardCreateTask")}
            </button>
          </>
        ) : null}
        <OutputQuickAnalysisButton
          className="outputs-formal-action-button is-primary"
          disabled={!projectId}
          ownerId={id}
          ownerTitle={title}
          ownerType={layer}
          projectId={projectId}
        />
        <button
          type="button"
          className="outputs-formal-action-button"
          disabled={manuscriptEditorState.status === "opening"}
          onClick={() => void openOutputManuscript(layer, id)}
        >
          {t("outputOpenEditor")}
        </button>
      </div>
    );
  }

  function depositionTitle(targetLayer: OutputDepositionTargetLayer) {
    if (targetLayer === "finding") return t("outputDepositionMarkFindingTitle");
    if (targetLayer === "outputCandidate") return t("outputDepositionPromoteCandidateTitle");
    if (targetLayer === "outputGap") return t("outputDepositionCheckGapTitle");
    return t("outputDepositionConvertFormalTitle");
  }

  function depositionCreateLabel(targetLayer: OutputDepositionTargetLayer) {
    if (targetLayer === "finding") return t("outputDepositionConfirmMarkFinding");
    if (targetLayer === "outputCandidate") return t("outputDepositionConfirmPromoteCandidate");
    if (targetLayer === "outputGap") return t("outputDepositionConfirmCheckGap");
    return t("outputDepositionConfirmConvertFormal");
  }

  function depositionAddLabel(targetLayer: OutputDepositionTargetLayer) {
    if (targetLayer === "finding") return t("outputDepositionConfirmAddFinding");
    if (targetLayer === "outputCandidate") return t("outputDepositionConfirmAddCandidate");
    if (targetLayer === "outputGap") return t("outputDepositionConfirmAddGap");
    return t("outputDepositionConfirmAddFormal");
  }

  function renderOutputGapFeedbackCard(
    card: OutputGapFeedbackCard,
    outputGapTitle: string,
    archived: boolean
  ) {
    const nextStatus: OutputGapFeedbackCardStatus =
      card.status === "pending" ? "resolved" : "pending";
    return (
      <article
        className={`outputs-gap-feedback-card${archived ? " is-archived" : ""}`}
        key={card.id}
      >
        <div className="outputs-gap-feedback-card__meta">
          <span>{feedbackCardTypeLabel(card.type)}</span>
          <time dateTime={card.createdAt}>
            {new Date(card.createdAt).toLocaleDateString()}
          </time>
        </div>
        <strong>{card.title}</strong>
        {card.description ? <p>{card.description}</p> : null}
        <div className="outputs-gap-feedback-card__footer">
          <span>
            {feedbackCardStatusLabel(card.status)} ·{" "}
            {feedbackCardPriorityLabel(card.priority)}
          </span>
          {archived ? (
            <div className="outputs-gap-feedback-card__actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => void restoreFeedbackCard(card)}
              >
                {t("outputGapFeedbackCardRestore")}
              </button>
              <button
                type="button"
                className="secondary-button outputs-gap-feedback-card__delete"
                onClick={() => void deleteArchivedFeedbackCard(card)}
              >
                {t("outputGapFeedbackCardDelete")}
              </button>
            </div>
          ) : (
            <div className="outputs-gap-feedback-card__actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => openFeedbackCardEdit(card, outputGapTitle)}
              >
                {t("outputGapFeedbackCardEdit")}
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => void setFeedbackCardStatus(card, nextStatus)}
              >
                {nextStatus === "resolved"
                  ? t("outputGapFeedbackCardMarkResolved")
                  : t("outputGapFeedbackCardMarkPending")}
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => void archiveFeedbackCard(card)}
              >
                {t("outputGapFeedbackCardArchive")}
              </button>
            </div>
          )}
        </div>
      </article>
    );
  }

  function renderOutputGapFeedbackCardSection(detail: OutputEntityDetailDto) {
    const outputGapTitle = entityTitle(detail);
    const summary =
      outputGapFeedbackCardSummary?.outputGapId === detail.id
        ? outputGapFeedbackCardSummary
        : null;
    const activeCards = summary?.activeCards ?? [];
    const archivedCards = summary?.archivedCards ?? [];
    const archiveOpen = Boolean(feedbackCardArchiveOpen[detail.id]);
    return (
      <section
        className="outputs-gap-feedback-card-section"
        aria-label={t("outputGapFeedbackCards")}
      >
        <div className="outputs-gap-feedback-card-section__header">
          <div>
            <strong>{t("outputGapFeedbackCards")}</strong>
          </div>
        </div>
        {pendingArchiveFeedbackCard?.outputGapId === detail.id ? (
          <div
            className="outputs-gap-feedback-card-archive-confirm"
            role="dialog"
            aria-label={t("outputGapFeedbackCardArchivePendingConfirm")}
          >
            <p>{t("outputGapFeedbackCardArchivePendingConfirm")}</p>
            <div className="outputs-gap-feedback-card-archive-confirm__actions">
              <button
                type="button"
                className="primary-button"
                onClick={() => void confirmPendingArchiveFeedbackCard()}
              >
                {t("outputGapFeedbackCardConfirm")}
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={cancelPendingArchiveFeedbackCard}
              >
                {t("outputGapFeedbackCardCancel")}
              </button>
            </div>
          </div>
        ) : null}
        <div className="outputs-gap-feedback-card-list">
          {activeCards.length ? (
            activeCards.map((card) =>
              renderOutputGapFeedbackCard(card, outputGapTitle, false)
            )
          ) : (
            <p className="outputs-gap-feedback-card-empty">
              {t("outputGapFeedbackCardActiveEmpty")}
            </p>
          )}
        </div>
        <button
          type="button"
          className="outputs-gap-feedback-card-archive-toggle"
          aria-expanded={archiveOpen}
          onClick={() =>
            setFeedbackCardArchiveOpen((current) => ({
              ...current,
              [detail.id]: !current[detail.id]
            }))
          }
        >
          <span aria-hidden="true">{archiveOpen ? "v" : ">"}</span>
          {t("outputGapFeedbackCardArchivedCount").replace(
            "{count}",
            String(archivedCards.length)
          )}
        </button>
        {archiveOpen ? (
          <div className="outputs-gap-feedback-card-archive-list">
            {archivedCards.length ? (
              archivedCards.map((card) =>
                renderOutputGapFeedbackCard(card, outputGapTitle, true)
              )
            ) : (
              <p className="outputs-gap-feedback-card-empty">
                {t("outputGapFeedbackCardArchivedEmpty")}
              </p>
            )}
          </div>
        ) : null}
      </section>
    );
  }

  function feedbackCardEditorTitle() {
    if (!feedbackCardEditor) return "";
    if (feedbackCardEditor.mode === "edit") return t("outputGapFeedbackCardEdit");
    return feedbackCardEditor.type === "route"
      ? t("outputGapFeedbackCardCreateRouteTitle")
      : t("outputGapFeedbackCardCreateTaskTitle");
  }

  function renderFeedbackCardEditor() {
    if (!feedbackCardEditor) return null;
    return (
      <div className="outputs-gap-feedback-card-modal-backdrop" role="presentation">
        <section
          className="outputs-gap-feedback-card-modal"
          role="dialog"
          aria-modal="true"
          aria-label={feedbackCardEditorTitle()}
        >
          <header>
            <div>
              <h3>{feedbackCardEditorTitle()}</h3>
            </div>
            <button
              type="button"
              className="outputs-gap-feedback-card-modal__close secondary-button"
              onClick={closeFeedbackCardEditor}
              disabled={feedbackCardSaving}
            >
              {t("cancel")}
            </button>
          </header>
          <label className="outputs-gap-feedback-card-modal__field">
            <span>{t("title")}</span>
            <input
              value={feedbackCardFormDraft.title}
              onChange={(event) =>
                setFeedbackCardFormDraft((current) => ({
                  ...current,
                  title: event.target.value
                }))
              }
            />
          </label>
          <label className="outputs-gap-feedback-card-modal__field">
            <span>{t("description")}</span>
            <textarea
              rows={4}
              value={feedbackCardFormDraft.description}
              onChange={(event) =>
                setFeedbackCardFormDraft((current) => ({
                  ...current,
                  description: event.target.value
                }))
              }
            />
          </label>
          <div className="outputs-gap-feedback-card-modal__grid">
            <label className="outputs-gap-feedback-card-modal__field">
              <span>{t("status")}</span>
              <select
                value={feedbackCardFormDraft.status}
                onChange={(event) =>
                  setFeedbackCardFormDraft((current) => ({
                    ...current,
                    status: event.target.value as OutputGapFeedbackCardStatus
                  }))
                }
              >
                <option value="pending">{t("outputGapFeedbackCardPending")}</option>
                <option value="resolved">{t("outputGapFeedbackCardResolved")}</option>
              </select>
            </label>
            <label className="outputs-gap-feedback-card-modal__field">
              <span>{t("priority")}</span>
              <select
                value={feedbackCardFormDraft.priority}
                onChange={(event) =>
                  setFeedbackCardFormDraft((current) => ({
                    ...current,
                    priority: event.target.value as OutputGapFeedbackCardPriority
                  }))
                }
              >
                <option value="high">{t("outputGapFeedbackCardPriorityHigh")}</option>
                <option value="medium">{t("outputGapFeedbackCardPriorityMedium")}</option>
                <option value="low">{t("outputGapFeedbackCardPriorityLow")}</option>
              </select>
            </label>
          </div>
          {feedbackCardError ? (
            <p className="outputs-gap-feedback-card-error" role="alert">
              {feedbackCardError}
            </p>
          ) : null}
          <footer className="outputs-gap-feedback-card-modal__actions">
            <button
              type="button"
              className="primary-button"
              onClick={() => void submitFeedbackCardForm()}
              disabled={feedbackCardSaving}
            >
              {feedbackCardSaving ? t("outputDepositionSaving") : t("save")}
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={closeFeedbackCardEditor}
              disabled={feedbackCardSaving}
            >
              {t("cancel")}
            </button>
          </footer>
        </section>
      </div>
    );
  }

  function renderPathRecords(layer: OutputEntityLayer, detail: OutputEntityDetailDto) {
    const isOpen = pathFolds[layer];
    const isAdding = pathDraft?.layer === layer && pathDraft.ownerId === detail.id;
    const pathRecords = buildOutputFileRefPathRecordViews(
      pathFileRefs[layer].filter((fileRef) => fileRef.ownerId === detail.id),
      { workspace: t("outputsManuscriptWorkspace") }
    );
    return (
      <section className="outputs-formal-path-section">
        <div className="outputs-formal-fold-header">
          <button
            type="button"
            className="outputs-formal-fold-toggle"
            aria-expanded={isOpen}
            onClick={() =>
              setPathFolds((current) => ({ ...current, [layer]: !current[layer] }))
            }
          >
            <span aria-hidden="true">{isOpen ? "v" : ">"}</span>
            {t("outputPathRecords")}
          </button>
          <button
            type="button"
            className="outputs-formal-path-add-button"
            onClick={() => startAddPathRecord(layer, detail.id)}
          >
            {t("outputAddPathRecord")}
          </button>
        </div>
        {isOpen ? (
          <div className="outputs-formal-path-body">
            {pathRecords.map((record) => {
              const fullFileRef = record.fileRef;
              return (
                <article
                  className={`outputs-formal-path-card${record.kind === "workspace" ? " outputs-workspace-path-card" : ""}`}
                  key={fullFileRef.id}
                >
                  <div className="outputs-formal-path-heading">
                    <strong>{record.title}</strong>
                    <span>
                      {t("outputPathSummaryLabel")}：{record.pathSummary}
                    </span>
                  </div>
                  {fullFileRef.description ? (
                    <p className="outputs-formal-path-note">{fullFileRef.description}</p>
                  ) : null}
                  <div className="outputs-formal-path-actions file-ref-item-actions">
                    <FileRefPathActions
                      path={fullFileRef.path}
                      resourceKind={record.canOpen ? fullFileRef.resourceKind : "folder"}
                      openKind={record.kind === "workspace"
                        ? "folder"
        : fileRefService.resolveFileRefOpenKind(
                            fullFileRef.fileType,
                            fullFileRef.path
                          )}
                      disabled={!fullFileRef.path}
                      labels={{
                        open: t("outputOpen"),
                        reveal: record.kind === "file"
                          ? t("outputOpenContainingFolder")
                          : t("outputOpenFolder"),
                        copy: t("outputCopyPath")
                      }}
                      onResult={handleLocalFileResult}
                    />
                    {record.canEdit ? (
                      <button
                        type="button"
                        onClick={() => startEditPathRecord(layer, detail.id, fullFileRef)}
                      >
                        {t("outputEditPathRecord")}
                      </button>
                    ) : null}
                    {record.canDelete ? (
                      <button
                        type="button"
                        className="danger-button"
                        onClick={() =>
                          void deletePathRecord(
                            layer,
                            detail.id,
                            fullFileRef.id,
                            record.title
                          )
                        }
                      >
                        {t("outputDeletePathRecord")}
                      </button>
                    ) : null}
                  </div>
                </article>
              );
            })}
            {!pathRecords.length && !isAdding ? (
              <p className="outputs-formal-empty-inline">{t("outputNoPathRecords")}</p>
            ) : null}
            {isAdding && pathDraft ? (
              <div className="outputs-formal-path-form">
                <h4>
                  {pathDraft.fileRefId
                    ? t("outputEditPathRecord")
                    : t("outputAddPathRecord")}
                </h4>
                <label>
                  <span>{t("title")}</span>
                  <input
                    value={pathDraft.title}
                    placeholder={t("outputPathTitlePlaceholder")}
                    onChange={(event) =>
                      setPathDraft({ ...pathDraft, title: event.target.value })
                    }
                  />
                </label>
                <label>
                  <span>{t("outputPathField")}</span>
                  <div className="outputs-formal-path-input-row file-ref-path-input-row">
                    <input
                      value={pathDraft.path}
                      placeholder={t("outputPathInputPlaceholder")}
                      onChange={(event) =>
                        setPathDraft({ ...pathDraft, path: event.target.value })
                      }
                    />
                    <FileRefPathPicker
                      labels={{
                        selectFile: t("outputSelectFile"),
                        selectFolder: t("outputSelectFolder")
                      }}
                      onResult={(result) => {
                        if (result.status === "success" && result.path) {
                          handleSelectedPath(result.path);
                          setPathDraft((current) =>
                            current
                              ? {
                                  ...current,
                                  fileType:
                                    result.actionType === "select_folder"
                                      ? "data_folder"
                                      : "other"
                                }
                              : current
                          );
                        }
                        handleLocalFileResult(result);
                      }}
                    />
                  </div>
                </label>
                <label>
                  <span>{t("outputNotesField")}</span>
                  <textarea
                    rows={3}
                    value={pathDraft.description}
                    onChange={(event) =>
                      setPathDraft({ ...pathDraft, description: event.target.value })
                    }
                  />
                </label>
                {pathDraftError ? (
                  <p className="outputs-formal-path-error">{pathDraftError}</p>
                ) : null}
                <div className="button-row">
                  <button type="button" disabled={!pathDraft.path.trim()} onClick={() => void savePathRecord()}>
                    {pathDraft.fileRefId
                      ? t("outputSavePathRecord")
                      : t("outputAddPathRecord")}
                  </button>
                  <button type="button" className="secondary-button" onClick={closePathRecordForm}>
                    {t("cancel")}
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>
    );
  }

  function renderLayerDetail(layer: OutputEntityLayer) {
    const detail = details[layer];
    if (!detail?.entity) {
      return <div className="outputs-formal-detail-empty">{selectPrompt(layer)}</div>;
    }
    const titleDescription = entityTitleDescription(layer, detail);
    return (
      <div className="outputs-formal-detail-content">
        <section className="outputs-formal-intro">
          <div className="outputs-formal-intro-copy">
            <h3>{entityTitle(detail)}</h3>
            {titleDescription ? (
              <p className="outputs-formal-title-description">{titleDescription}</p>
            ) : null}
            {renderSourceSummary(layer)}
          </div>
          <button
            type="button"
            className="outputs-formal-edit-button secondary-button primary-page-action primary-page-action--secondary"
            onClick={() => openEditEntityForm(layer, detail)}
          >
            {language === "zh-CN" ? "编辑" : "Edit"}
          </button>
        </section>
        <section className="outputs-formal-outline">
          <StructuredSummaryDisplay
            fields={detail.structuredSummary.map((section) => ({
              key: section.key,
              label: outlineLabel(layer, section.key),
              content: section.value
            }))}
            emptyText={t("outputNoContent")}
            className={`outputs-formal-summary-panel${
              layer === "outputGap" ? " is-output-gap" : ""
            }`}
          />
          {renderLayerActions(layer, detail)}
        </section>
        {layer === "outputGap" ? renderOutputGapFeedbackCardSection(detail) : null}
        {renderPathRecords(layer, detail)}
      </div>
    );
  }

  function renderLayerSection(layer: OutputEntityLayer) {
    const filter = filters[layer];
    return (
      <section
        className={`outputs-formal-layer is-${layer}`}
        id={`outputs-layer-${layer}`}
        key={layer}
      >
        <header className="outputs-formal-layer-header">
          <div>
            <h2>{layerLabel(layer)}</h2>
            <span>{lists[layer].length}</span>
          </div>
          <button
            type="button"
            className="outputs-formal-create-button primary-page-action primary-page-action--primary"
            disabled={!projectId || loading}
            title={
              projectId
                ? language === "zh-CN"
                  ? `新建${layerLabel(layer)}`
                  : `Create ${layerLabel(layer)}`
                : language === "zh-CN"
                  ? "请先选择课题"
                  : "Select a project first"
            }
            onClick={() => openCreateEntityForm(layer)}
          >
            {t("new")}
          </button>
        </header>
        <div className="outputs-formal-layer-body">
          <aside className="outputs-formal-list-pane">
            <div className="outputs-formal-filters outputs-formal-filter-row">
              <select
                className="outputs-formal-filter-control outputs-formal-status-filter compact-list-toolbar-control"
                aria-label={t("outputStatusFilter")}
                value={filter.status}
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    [layer]: { ...current[layer], status: event.target.value }
                  }))
                }
              >
                <option value="">{t("outputAllStatuses")}</option>
                {STATUS_OPTIONS_BY_LAYER[layer].map((status) => (
                  <option key={status} value={status}>
                    {statusLabel(status)}
                  </option>
                ))}
              </select>
              <input
                className="outputs-formal-filter-control compact-list-toolbar-control"
                aria-label={t("outputKeywordFilter")}
                placeholder={t("outputKeywordFilter")}
                value={filter.keyword}
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    [layer]: { ...current[layer], keyword: event.target.value }
                  }))
                }
              />
            </div>
            <div className="outputs-formal-list">
              {filteredLists[layer].length ? (
                filteredLists[layer].map((item) => renderListButton(layer, item))
              ) : (
                <p>{loading ? t("outputsLoading") : t("outputLayerEmpty")}</p>
              )}
            </div>
          </aside>
          <div className="outputs-formal-detail-pane">{renderLayerDetail(layer)}</div>
        </div>
      </section>
    );
  }

  const manuscriptSession = manuscriptEditorState.session;
  const independentManuscriptSession = manuscriptEditorState.independentSession;
  const manuscriptBusy = [
    "opening",
    "saving",
    "reloading",
    "save-as",
    "switching",
    "closing"
  ].includes(manuscriptEditorState.status);
  const manuscriptOutlineItems = manuscriptSession
    ? buildOutputCanonicalPresentationSummary(
        manuscriptSession.owner.ownerType,
        manuscriptSession.document.snapshot.briefDescription,
        manuscriptSession.document.snapshot.structuredSummary
      ).map((section) => ({
        label: outlineLabel(manuscriptSession.owner.ownerType, section.key),
        value: section.value.trim() || t("notSet")
      }))
    : [];
  const manuscriptContextInsert = manuscriptSession
    ? formatOutputManuscriptContextInsert(manuscriptSession.document.snapshot)
    : "";
  const pendingManuscriptSwitchCopy = pendingManuscriptSwitch
    ? buildFormalSwitchConfirmationCopy({
        targetFileName: pendingManuscriptSwitch.fileName,
        ownerDisplayName: manuscriptSession
          ? ui(getOutputManuscriptStaticDescriptor(
              manuscriptSession.owner.ownerType
            ).presentationLabel.replace(/副本$/u, ""))
          : ui("成果文稿"),
        descriptorLookupIdentity: {
          ownerType: manuscriptSession?.owner.ownerType ?? "resultItem",
          channel: "primary"
        },
        translate: ui,
        resolveLabel: (field) => ui(field.displayLabel),
        ...(pendingManuscriptSwitch.preview
          ? { missingStableKeys: pendingManuscriptSwitch.preview.missingFieldKeys }
          : { fieldActions: [] })
      })
    : null;
  return (
    <section className="page-section outputs-page outputs-formal-page">
      <PageHeader title={t("outputs")} description={t("outputsDescription")} />
      <SaveAsInterruptedReconciliationNotice
        ownerKeys={Object.entries(selections).flatMap(([ownerType, ownerId]) =>
          ownerId ? [`${ownerType}:${ownerId}`] : []
        )}
      />
      <WriteFeedbackPanel
        entries={feedbackCenter.entries}
        onDismiss={feedbackCenter.dismissFeedback}
        presentation="primary-page"
      />

      <section className="outputs-formal-guide">
        <label className="outputs-formal-project-filter">
          <span>{t("project")}</span>
          <select
            className="outputs-formal-project-select"
            value={projectId}
            onChange={(event) => handleProjectChange(event.target.value)}
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.title}
              </option>
            ))}
          </select>
        </label>
        <p className="outputs-formal-flow">
          <strong>{t("outputConversionFlow")}：</strong>
          {t("outputFormalFlow")}
        </p>
        <div className="outputs-formal-stats">
          {LAYERS.map((layer) => (
            <button
              type="button"
              className="outputs-formal-stat-pill lightweight-stat-surface"
              key={layer}
              aria-label={
                language === "zh-CN"
                  ? `定位到${layerShortLabel(layer)}`
                  : `Go to ${layerShortLabel(layer)}`
              }
              onClick={() => scrollToLayer(layer)}
            >
              {layerShortLabel(layer)}：{lists[layer].length}
            </button>
          ))}
        </div>
      </section>

      {error ? <div className="outputs-workspace-error" role="alert">{error}</div> : null}
      {manuscriptEditorState.status === "opening" ? (
        <div className="outputs-workspace-status" role="status">
          {t("outputsManuscriptOpening")}
        </div>
      ) : null}

      <main className="outputs-formal-layers">
        {LAYERS.map((layer) => renderLayerSection(layer))}
      </main>

      {entityFormDraft ? (
        <OutputEntityFormModal
          draft={entityFormDraft}
          language={language}
          projectId={projectId}
          projectName={projects.find((project) => project.id === projectId)?.title ?? ""}
          candidates={lists.outputCandidate}
          outputLists={lists}
          sourceSummary={
            entityFormDraft.id ? sourceSummaries[entityFormDraft.layer] : null
          }
          onSourcesChanged={() =>
            entityFormDraft.id
              ? refreshSourceSummary(entityFormDraft.layer, entityFormDraft.id)
              : Promise.resolve()
          }
          saving={entityFormSaving}
          error={entityFormError}
          onChange={setEntityFormDraft}
          onSave={saveEntityForm}
          onClose={closeEntityForm}
          onDelete={entityFormDraft.id
            ? async () => {
                const result = await confirmAndSoftDelete(
                  entityFormDraft.layer,
                  entityFormDraft.id as string
                );
                if (result.status === "success" || result.status === "partial") {
                  setEntityFormDraft(null);
                }
              }
            : undefined}
        />
      ) : null}

      {depositionSource?.detail.entity ? (
        <OutputDepositionModal
          projectId={depositionSource.detail.entity.projectId}
          sourceLayer={depositionSource.layer}
          sourceId={depositionSource.detail.id}
          sourceTitle={entityTitle(depositionSource.detail)}
          sourceDescription={entitySummary(depositionSource.detail)}
          sourceStructuredSummary={depositionSource.detail.structuredSummary}
          fixedTargetLayer={depositionSource.targetLayer}
          actionTitle={depositionTitle(depositionSource.targetLayer)}
          confirmCreateLabel={depositionCreateLabel(depositionSource.targetLayer)}
          confirmAddLabel={depositionAddLabel(depositionSource.targetLayer)}
          outputLists={lists}
          saving={depositionSaving}
          error={depositionError}
          onSubmit={submitDeposition}
          onClose={closeDeposition}
        />
      ) : null}

      {renderFeedbackCardEditor()}

      <LazyManuscriptSegmentEditorWindow
        isOpen={Boolean(manuscriptSession)}
        entryKind="current"
        descriptorLookupIdentity={{
          ownerType: manuscriptSession?.owner.ownerType ?? "resultItem",
          channel: "primary"
        }}
        lifecycle={{
          participantId: `outputs-current:${outputsManuscriptEditorHost.currentHandle ?? "closed"}`,
          handle: outputsManuscriptEditorHost.currentHandle ?? "closed",
          presentationEpoch: outputsManuscriptEditorHost.currentPresentationRevision,
          readSession: outputsManuscriptEditorHost.readCurrentSession
        }}
        readonlyContextItems={manuscriptOutlineItems}
        leftPanelTitle={t("outputsManuscriptOutlineHeading")}
        contextInsertion={{
          label: ui("插入上下文结构"),
          isAvailable: Boolean(manuscriptContextInsert),
          unavailableReason: ui("当前成果对象尚无可插入的上下文结构。"),
          resolveMarkdown: async () => manuscriptContextInsert
        }}
        contentIdentity={
          manuscriptSession
            ? `${manuscriptSession.owner.ownerType}:${manuscriptSession.owner.ownerId}:${manuscriptSession.actualEditTarget.fileRefId}`
            : undefined
        }
        entityTitle={
          manuscriptSession &&
          details[manuscriptSession.owner.ownerType]?.id === manuscriptSession.owner.ownerId
            ? textField(
                details[manuscriptSession.owner.ownerType]?.entity ?? null,
                "title",
                "outputName"
              )
            : undefined
        }
        disabled={
          manuscriptBusy ||
          Boolean(pendingManuscriptSwitch) ||
          manuscriptSession?.accessMode === "read-only"
        }
        headerNotice={manuscriptEditorState.error ?? undefined}
        footerLeadingActions={[
          {
            key: "open-manuscript",
            label: t("outputsManuscriptOpen"),
            disabled:
              manuscriptBusy ||
              manuscriptSession?.accessMode === "read-only",
            onClick: () => void openIndependentMarkdown()
          },
          {
            key: "switch-manuscript",
            label: t("outputsManuscriptSwitch"),
            disabled:
              manuscriptBusy ||
              manuscriptSession?.accessMode === "read-only",
            onClick: () => void switchMarkdownManuscript()
          },
          {
            key: "reload",
            label: t("outputsManuscriptReload"),
            disabled:
              manuscriptBusy ||
              manuscriptSession?.accessMode === "read-only",
            onClick: () => void reloadMarkdown()
          },
          {
            key: "save-as",
            intent: "save-as",
            label: t("outputsManuscriptSaveAs"),
            disabled:
              manuscriptBusy ||
              manuscriptSession?.accessMode === "read-only",
            onClick: (snapshot) => saveMarkdownAs("current", snapshot)
          }
        ]}
        saveLabel={ui("保存文稿")}
        dirtyLabel={t("outputsManuscriptUnsaved")}
        cancelLabel={t("cancel")}
        closeLabel={t("outputsManuscriptCloseEditor")}
        saveFailedLabel={t("outputsManuscriptSaveFailed")}
        onCancel={() => void closeMarkdownEditor()}
        onClose={() => void closeMarkdownEditor()}
      />

      <LazyManuscriptSegmentEditorWindow
        isOpen={Boolean(independentManuscriptSession)}
        entryKind="independent"
        descriptorLookupIdentity={{
          ownerType: independentManuscriptSession?.owner.ownerType ?? "resultItem",
          channel: "primary"
        }}
        lifecycle={{
          participantId: `outputs-independent:${outputsManuscriptEditorHost.independentHandle ?? "closed"}`,
          handle: outputsManuscriptEditorHost.independentHandle ?? "closed",
          presentationEpoch: outputsManuscriptEditorHost.independentPresentationRevision,
          readSession: outputsManuscriptEditorHost.readIndependentSession
        }}
        contentIdentity={independentManuscriptSession
          ? `${independentManuscriptSession.owner.ownerType}:${independentManuscriptSession.owner.ownerId}:${independentManuscriptSession.document.fileRefId}:${outputsManuscriptEditorHost.independentPresentationRevision}`
          : undefined}
        entityTitle={
          independentManuscriptSession &&
          details[independentManuscriptSession.owner.ownerType]?.id ===
            independentManuscriptSession.owner.ownerId
            ? textField(
                details[independentManuscriptSession.owner.ownerType]?.entity ?? null,
                "title",
                "outputName"
              )
            : undefined
        }
        readonlyContextItems={manuscriptOutlineItems}
        disabled={
          manuscriptBusy ||
          independentManuscriptSession?.accessMode === "read-only"
        }
        footerLeadingActions={[
          {
            key: "reload-independent",
            label: t("outputsManuscriptReload"),
            disabled:
              manuscriptBusy ||
              independentManuscriptSession?.accessMode === "read-only",
            onClick: () => void outputsManuscriptEditorHost.requestIndependentReload()
          },
          {
            key: "save-independent-as",
            intent: "save-as",
            label: t("outputsManuscriptSaveAs"),
            disabled:
              manuscriptBusy ||
              independentManuscriptSession?.accessMode === "read-only",
            onClick: (snapshot) => saveMarkdownAs("independent", snapshot)
          }
        ]}
        saveLabel={ui("保存文稿")}
        cancelLabel={t("cancel")}
        closeLabel={t("outputsManuscriptCloseEditor")}
        dirtyLabel={ui("有未保存更改")}
        unsavedChangesTitle={ui("当前文稿有未保存更改")}
        unsavedChangesLabel={ui("关闭前，请选择保存更改、放弃更改或取消关闭。")}
        saveChangesLabel={ui("保存并关闭")}
        discardChangesLabel={ui("放弃更改")}
        continueEditingLabel={ui("取消")}
        saveFailedLabel={t("outputsManuscriptSaveFailed")}
        onCancel={() => outputsManuscriptEditorHost.closeIndependent()}
        onClose={() => outputsManuscriptEditorHost.closeIndependent()}
      />

      {pendingManuscriptSwitch ? (
        <FormalSwitchConfirmationDialog
          dialogId="outputs-manuscript-switch-title"
          title={t("outputsManuscriptSetCurrentTitle")}
          semanticBlocks={pendingManuscriptSwitchCopy?.semanticBlocks}
          confirmLabel={t("outputsManuscriptSetCurrentConfirm")}
          cancelLabel={t("cancel")}
          onConfirm={() => void executePendingManuscriptSwitch()}
          onCancel={() => setPendingManuscriptSwitch(null)}
          backdropClassName="outputs-manuscript-switch-backdrop"
          dialogClassName="outputs-manuscript-switch-dialog"
        />
      ) : null}

      <OperationConfirmDialog
        preview={operationConfirm.preview}
        onConfirm={operationConfirm.confirm}
        onCancel={operationConfirm.cancel}
      />
    </section>
  );
}
