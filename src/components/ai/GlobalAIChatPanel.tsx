import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import { buildAIContext } from "../../services/aiContextBuilderService";
import { buildAIContextHumanReadablePreview } from "../../services/aiContextPreviewDisplayService";
import {
  AI_RESEARCH_OBJECT_SELECTION_MAX,
  listAIResearchObjectsForProject
} from "../../services/aiResearchObjectService";
import {
  readLatestAssistantMessageAttachedContextCustody,
  readLatestAssistantMessageContextCustody,
  readFrozenContextSelection,
  type AILatestAssistantAttachedContextCustody,
  type AIFrozenContextSelection
} from "../../services/aiContextReceiptService";
import { normalizeAIError, projectAIErrorForDisplay } from "../../services/aiErrorService";
import { buildAIActionDraftGenerationPrompt } from "../../services/aiActionDraftGenerationPromptService";
import {
  constraintDescriptorsEqual,
  resolveRetryConstraintRequest
} from "../../services/aiConstraintService";
import { planningService } from "../../services/planningService";
import type {
  AIConversationReadback,
  AIConversationSummary,
  ActionDraftGenerationReadback,
  AIProviderConfigurationStatus,
  AISelectableFileRef,
  DurableAIInvocationResult,
  AIContextRequest
} from "../../types";
import type {
  AIContextMaterialSelection,
  AIContextMode,
  AIContextPackage,
  AIApprovedContextRequestContribution,
  AIOutputDetailPreference,
  AIPromptPackage,
  AIResearchObjectDescriptor,
  AIResearchObjectType
} from "../../types/aiContext";
import type { Project } from "../../types/planning";
import type { AIChatLaunchIntent } from "./AIChatLaunchContext";
import { AIActionDraftPanel } from "./AIActionDraftPanel";
import { AIContextDiscardDialog } from "./AIContextDiscardDialog";
import { AIContextPreviewPanel } from "./AIContextPreviewPanel";
import {
  AIParseDraftPanel,
  type AIParseDraftScopeReview,
  type AIParseDraftTerminal
} from "./AIParseDraftPanel";
import { AssistantUIChatSurface, type AssistantUIComposerOutcome } from "./AssistantUIChatSurface";
import { buildAIChatContextCompactPresentation } from "./aiChatCompactPresentation";
import {
  AI_LAST_SELECTED_PROJECT_PREFERENCE_KEY,
  AI_RESEARCH_OBJECT_CATEGORIES,
  filterAIResearchObjectsByCategory,
  groupAIConversationHistory,
  resolvePreferredAIProjectId,
  type AIResearchObjectCategory
} from "./aiPanelProductizationModel";
import { useFloatingAIPanel } from "./useFloatingAIPanel";
import {
  createAIStandardResultWorkspaceMutation,
  releaseAIStandardResultWorkspaceMutation,
  type AIStandardResultWorkspaceMutation
} from "./aiStandardResultUXModel";
import "./GlobalAIChatPanel.productized.css";
import {
  AI_CHAT_OTHER_SCOPE_VALUE,
  createAIChatContextBudget,
  isTechnicalCapacityWarning,
  resolveAIChatScopeSelection
} from "./aiChatContextUIModel";
import {
  AI_AUTO_PULL_CONTEXT_DEFAULT_PERCENT,
  AI_PROVIDER_PROMPT_TECHNICAL_MAX_CHARS,
  resolveAIAutoPullContextBudget
} from "../../services/aiPromptBudgetService";
import {
  AI_NEW_CONVERSATION_STRATEGY,
  AIAttachmentAuthorizationError,
  aiConversationApplicationService,
  buildConversationPromptPackage,
  buildDurableAIInvocationTrace,
  createDurableAIInvocationRequestId,
  createDurablePromptIdentity,
  effectiveDurableResultFromReadback,
  type AIChatRetryRegenerateActionIntent,
  type DurableAIStreamingInvocationHandle,
  isAIDurablePersistenceError,
  isAIAttachmentAuthorizationError,
  isAIProviderConfigurationPreGateError,
  isAIContextRequestPrepareError,
  isAIRetryRegeneratePrepareError,
  runDurableAIInvocation,
  startDurableAIStreamingInvocation
} from "../../services/aiConversationApplicationService";
import {
  AIContextRequestApprovalValidationError,
  approvalReviewsEqual,
  buildAIContextRequestApprovalReview,
  markAIContextRequestStale,
  rejectAIContextRequest,
  type AIContextRequestApprovalReview
} from "../../services/aiContextRequestApprovalService";
import { getAIProviderConfigurationStatus } from "../../services/aiProviderConfigurationClient";
import { readCanonicalActionDraftGeneration } from "../../services/actionDraftConfirmApplicationService";
import {
  beginAIStreamingPresentation,
  failAIStreamingPresentation,
  INITIAL_AI_STREAMING_PRESENTATION_STATE,
  reduceAIStreamingPresentation,
  requestAIStreamingStop
} from "./aiStreamingPresentationModel";
import {
  assertAIParseDraftSourceSnapshotStillCurrentAndEligible,
  buildAIParseDraftPromptPackage,
  deriveAIParseDraftRetryRange,
  isAIParseDraftBoundaryNoNewContentError,
  isAIParseDraftSourceSnapshotError,
  PARSE_DRAFT_USER_INSTRUCTION
} from "../../services/aiParseDraftService";
import { isAIParseDraftEligibilityError } from "../../services/aiConversationHistoryService";
import { aiStandardResultApplicationService } from "../../services/aiStandardResultApplicationService";
import type { AIStandardResult } from "../../types/aiStandardResult";
import { getResearcherProfile } from "../../services/researcherProfileService";
import {
  resolveAIAssociatedCurrentManuscripts,
  type AIAssociatedCurrentManuscript
} from "../../services/aiAssociatedCurrentManuscriptService";
import {
  AI_ONE_SHOT_LOCAL_ATTACHMENT_ACCEPT,
  applyAIOneShotLocalAttachmentToPromptPackage,
  isAIOneShotLocalAttachmentError,
  readAIOneShotLocalAttachment,
  validateAIOneShotLocalAttachmentSelection
} from "../../services/aiOneShotLocalAttachmentService";

type GlobalAIChatPanelProps = {
  onClose: (intent?: "panel" | "settings") => boolean | void;
  onContextDirtyChange?: (dirty: boolean) => void;
  launchIntent?: AIChatLaunchIntent | null;
};
type AIPanelWorkspace = "chat" | "context-preview" | "context-edit" | "context-builder" | "operations";
type AIOperationsMode = "standard-results" | "action-drafts";
type PanelError = { title: string; message: string };
type AIParseDraftPreparedReview = AIParseDraftScopeReview & {
  retryContextSelection?: AIFrozenContextSelection;
  attachedContextCustody?: AILatestAssistantAttachedContextCustody;
  frozenManualAttachmentIds: string[];
};
type ChatSendReviewGateCode =
  | "ready"
  | "conversation_missing"
  | "conversation_readback_mismatch"
  | "project_scope_missing"
  | "question_missing"
  | "context_editor_dirty"
  | "busy"
  | "context_request_review_active"
  | "blocking_prompt_warning";
type ChatProviderBoundaryCode =
  | "eligible"
  | "provider_status_unavailable"
  | "missing_api_key"
  | "invalid_provider_configuration"
  | "secure_store_unavailable"
  | "provider_configuration_blocked";

function compactLine(value: string | undefined, maxChars: number): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  const chars = Array.from(normalized);
  return chars.length <= maxChars ? normalized : `${chars.slice(0, maxChars - 1).join("")}…`;
}

function conversationTitle(summary: AIConversationSummary): string {
  return compactLine(summary.firstUserMessage, 52) ?? "新对话";
}

function hasCanonicalMaterialFreshnessReceipt(candidate: AISelectableFileRef): boolean {
  const receipt = candidate.materialFreshnessReceipt;
  return Boolean(
    receipt && receipt.fileRefId === candidate.fileRefId &&
    receipt.receiptVersion === "material-source-v1" &&
    /^[a-f0-9]{64}$/.test(receipt.sourceToken)
  );
}

function isMaterialSourceFreshnessFailure(error: unknown): boolean {
  return normalizeAIError(error).code === "material_source_changed_since_review";
}

function uniqueCanonicalIds(ids: readonly string[]): string[] {
  return [...new Set(ids.filter(Boolean))];
}

function canonicalIdsEqual(left: readonly string[], right: readonly string[]): boolean {
  const leftSorted = uniqueCanonicalIds(left).sort();
  const rightSorted = uniqueCanonicalIds(right).sort();
  return leftSorted.length === rightSorted.length &&
    leftSorted.every((id, index) => id === rightSorted[index]);
}

function readLastSelectedAIProjectPreference(): string | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage.getItem(AI_LAST_SELECTED_PROJECT_PREFERENCE_KEY)?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function writeLastSelectedAIProjectPreference(projectId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(AI_LAST_SELECTED_PROJECT_PREFERENCE_KEY, projectId);
  } catch {
    // UI preference persistence must never block the AI workspace.
  }
}

function clearLastSelectedAIProjectPreference(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(AI_LAST_SELECTED_PROJECT_PREFERENCE_KEY);
  } catch {
    // The safe fallback below remains available when preference storage is unavailable.
  }
}

export function GlobalAIChatPanel({
  launchIntent,
  onClose,
  onContextDirtyChange
}: GlobalAIChatPanelProps) {
  const { language, t } = useI18n();
  const floatingPanel = useFloatingAIPanel();
  const [projects, setProjects] = useState<Project[]>([]);
  const [isLoadingProjects, setIsLoadingProjects] = useState(true);
  const [projectLoadFailed, setProjectLoadFailed] = useState(false);
  const [scopeSelection, setScopeSelection] = useState("");
  const [projectId, setProjectId] = useState("");
  const [contextMode, setContextMode] = useState<AIContextMode>("STANDARD");
  const [researchObjectOptions, setResearchObjectOptions] = useState<AIResearchObjectDescriptor[]>([]);
  const [selectedRouteIds, setSelectedRouteIds] = useState<string[]>([]);
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([]);
  const [selectedReviewIds, setSelectedReviewIds] = useState<string[]>([]);
  const [selectedExperimentIds, setSelectedExperimentIds] = useState<string[]>([]);
  const [selectedExperimentRunIds, setSelectedExperimentRunIds] = useState<string[]>([]);
  const [selectedLiteratureIds, setSelectedLiteratureIds] = useState<string[]>([]);
  const [selectedFindingIds, setSelectedFindingIds] = useState<string[]>([]);
  const [selectedResultItemIds, setSelectedResultItemIds] = useState<string[]>([]);
  const [selectedOutputCandidateIds, setSelectedOutputCandidateIds] = useState<string[]>([]);
  const [selectedOutputGapIds, setSelectedOutputGapIds] = useState<string[]>([]);
  const [selectedResearchOutputIds, setSelectedResearchOutputIds] = useState<string[]>([]);
  const [isLoadingResearchObjects, setIsLoadingResearchObjects] = useState(false);
  const [outputDetailPreference, setOutputDetailPreference] =
    useState<AIOutputDetailPreference>("STANDARD");
  const [conversationSummaries, setConversationSummaries] = useState<AIConversationSummary[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [conversationReadback, setConversationReadback] = useState<AIConversationReadback | null>(null);
  const [isLoadingConversations, setIsLoadingConversations] = useState(true);
  const [isCreatingConversation, setIsCreatingConversation] = useState(false);
  const [userQuestion, setUserQuestion] = useState("");
  const [composerDraftSeed, setComposerDraftSeed] = useState<string>();
  const [contextPackage, setContextPackage] = useState<AIContextPackage | null>(null);
  const [promptPackage, setPromptPackage] = useState<AIPromptPackage | null>(null);
  const [promptConversationId, setPromptConversationId] = useState<string | null>(null);
  const [contextMarkdown, setContextMarkdown] = useState("");
  const [defaultContextMarkdown, setDefaultContextMarkdown] = useState("");
  const [isContextModified, setIsContextModified] = useState(false);
  const [contextEditorDirty, setContextEditorDirty] = useState(false);
  const [workspaceDiscardWarningOpen, setWorkspaceDiscardWarningOpen] = useState(false);
  const [error, setError] = useState<PanelError | null>(null);
  const [isBuilding, setIsBuilding] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isGeneratingActionDraft, setIsGeneratingActionDraft] = useState(false);
  const [activeStreamReady, setActiveStreamReady] = useState(false);
  const [activeActionIntent, setActiveActionIntent] =
    useState<AIChatRetryRegenerateActionIntent | null>(null);
  const [providerConfiguration, setProviderConfiguration] =
    useState<AIProviderConfigurationStatus | null>(null);
  const [selectableFileRefs, setSelectableFileRefs] = useState<AISelectableFileRef[]>([]);
  const [effectiveReadableSelectionLimit, setEffectiveReadableSelectionLimit] = useState<number | null>(null);
  const [supportedMaterialExtensions, setSupportedMaterialExtensions] = useState<string[]>([]);
  const [selectedAttachmentIds, setSelectedAttachmentIds] = useState<string[]>([]);
  const [includeAssociatedDocuments, setIncludeAssociatedDocuments] = useState(false);
  const [associatedCurrentManuscripts, setAssociatedCurrentManuscripts] =
    useState<AIAssociatedCurrentManuscript[]>([]);
  const [builtAssociatedFileRefIds, setBuiltAssociatedFileRefIds] = useState<string[]>([]);
  const [associatedDocumentSkipCount, setAssociatedDocumentSkipCount] = useState(0);
  const [isLoadingAttachments, setIsLoadingAttachments] = useState(true);
  const [attachmentSelectorOpen, setAttachmentSelectorOpen] = useState(false);
  const [oneShotLocalAttachmentFile, setOneShotLocalAttachmentFile] = useState<File | null>(null);
  const [streamPresentation, setStreamPresentation] = useState(INITIAL_AI_STREAMING_PRESENTATION_STATE);
  const [contextRequestApprovalReview, setContextRequestApprovalReview] = useState<{
    review: AIContextRequestApprovalReview;
    followupRequestId: string;
  } | null>(null);
  const [reviewingContextRequestId, setReviewingContextRequestId] = useState<string>();
  const [decidingContextRequestId, setDecidingContextRequestId] = useState<string>();
  const [parseDraftTerminal, setParseDraftTerminal] = useState<AIParseDraftTerminal>();
  const [parseDraftEligibilityNotice, setParseDraftEligibilityNotice] = useState<string>();
  const [isPreparingParseDraft, setIsPreparingParseDraft] = useState(false);
  const [activeStandardResultMutation, setActiveStandardResultMutation] =
    useState<AIStandardResultWorkspaceMutation>();
  const [activeWorkspace, setActiveWorkspace] = useState<AIPanelWorkspace>("chat");
  const [operationsMode, setOperationsMode] = useState<AIOperationsMode>("standard-results");
  const [researcherNickname, setResearcherNickname] = useState("");
  const [historySearch, setHistorySearch] = useState("");
  const [activeResearchObjectCategory, setActiveResearchObjectCategory] =
    useState<AIResearchObjectCategory>("route");
  const [activeInvocationPurpose, setActiveInvocationPurpose] =
    useState<"chat_response" | "parse_draft">();
  const activeSendRef = useRef<DurableAIStreamingInvocationHandle | null>(null);
  const streamGenerationRef = useRef(0);
  const conversationLoadGenerationRef = useRef(0);
  const conversationSelectionIntentRef = useRef(0);
  const selectedConversationIdRef = useRef<string | null>(null);
  const createInFlightRef = useRef(false);
  const sendInFlightRef = useRef(false);
  const activeDraftGenerationRef = useRef<Promise<DurableAIInvocationResult> | null>(null);
  const contextRequestDecisionInFlightRef = useRef(false);
  const oneShotLocalAttachmentInputRef = useRef<HTMLInputElement | null>(null);
  const standardResultMutationRef = useRef<AIStandardResultWorkspaceMutation>();
  const standardResultMutationSequenceRef = useRef(0);

  const selectedResearchObjectCount = selectedRouteIds.length + selectedTaskIds.length + selectedReviewIds.length +
    selectedExperimentIds.length + selectedExperimentRunIds.length + selectedLiteratureIds.length +
    selectedFindingIds.length + selectedResultItemIds.length + selectedOutputCandidateIds.length +
    selectedOutputGapIds.length + selectedResearchOutputIds.length;

  function researchObjectIdsForType(objectType: AIResearchObjectType): string[] {
    if (objectType === "route") return selectedRouteIds;
    if (objectType === "task") return selectedTaskIds;
    if (objectType === "review") return selectedReviewIds;
    if (objectType === "experiment") return selectedExperimentIds;
    if (objectType === "experimentRun") return selectedExperimentRunIds;
    if (objectType === "literature") return selectedLiteratureIds;
    if (objectType === "finding") return selectedFindingIds;
    if (objectType === "resultItem") return selectedResultItemIds;
    if (objectType === "outputCandidate") return selectedOutputCandidateIds;
    if (objectType === "outputGap") return selectedOutputGapIds;
    return selectedResearchOutputIds;
  }

  function updateResearchObjectIds(
    objectType: AIResearchObjectType,
    update: (current: string[]) => string[]
  ) {
    if (objectType === "route") setSelectedRouteIds(update);
    else if (objectType === "task") setSelectedTaskIds(update);
    else if (objectType === "review") setSelectedReviewIds(update);
    else if (objectType === "experiment") setSelectedExperimentIds(update);
    else if (objectType === "experimentRun") setSelectedExperimentRunIds(update);
    else if (objectType === "literature") setSelectedLiteratureIds(update);
    else if (objectType === "finding") setSelectedFindingIds(update);
    else if (objectType === "resultItem") setSelectedResultItemIds(update);
    else if (objectType === "outputCandidate") setSelectedOutputCandidateIds(update);
    else if (objectType === "outputGap") setSelectedOutputGapIds(update);
    else setSelectedResearchOutputIds(update);
  }

  function clearSelectedResearchObjects() {
    setSelectedRouteIds([]);
    setSelectedTaskIds([]);
    setSelectedReviewIds([]);
    setSelectedExperimentIds([]);
    setSelectedExperimentRunIds([]);
    setSelectedLiteratureIds([]);
    setSelectedFindingIds([]);
    setSelectedResultItemIds([]);
    setSelectedOutputCandidateIds([]);
    setSelectedOutputGapIds([]);
    setSelectedResearchOutputIds([]);
  }

  function researchObjectTypeLabel(descriptor: AIResearchObjectDescriptor): string {
    if (descriptor.objectType === "route") return "研究路线";
    if (descriptor.objectType === "task") return "研究任务";
    if (descriptor.objectType === "review") return "复盘";
    if (descriptor.objectType === "experiment") return "实验";
    if (descriptor.objectType === "experimentRun") return "实验运行";
    if (descriptor.objectType === "finding") return "关键发现";
    if (descriptor.objectType === "resultItem") return "结果资产";
    if (descriptor.objectType === "outputCandidate") return "候选成果";
    if (descriptor.objectType === "outputGap") return "成果缺口";
    if (descriptor.objectType === "researchOutput") return "正式成果";
    return "文献";
  }

  const autoPullContextBudget = resolveAIAutoPullContextBudget(
    "standard",
    "100",
    AI_AUTO_PULL_CONTEXT_DEFAULT_PERCENT
  );
  const nonStandardResultBusy = isBuilding || isSending || isCreatingConversation || isLoadingConversations ||
    isGeneratingActionDraft || isPreparingParseDraft || Boolean(decidingContextRequestId);
  const isBusy = nonStandardResultBusy || Boolean(activeStandardResultMutation);
  const promptIsCurrentNormalQA = Boolean(
    promptPackage && selectedConversationId && promptConversationId === selectedConversationId &&
    promptPackage.constraintDescriptor.category === "NORMAL_QA" &&
    promptPackage.userQuestion === userQuestion.trim()
  );
  const hasBlockingPromptWarning = promptIsCurrentNormalQA && Boolean(
    promptPackage?.warnings?.some((warning) => warning.severity === "error")
  );
  const projectlessNaturalChatAllowed = Boolean(
    !isLoadingProjects && !projectLoadFailed && projects.length === 0 &&
    scopeSelection === "" && !projectId.trim()
  );
  const sendReviewGateCode: ChatSendReviewGateCode = !selectedConversationId
    ? "conversation_missing"
    : conversationReadback?.conversation.id !== selectedConversationId
      ? "conversation_readback_mismatch"
      : scopeSelection === AI_CHAT_OTHER_SCOPE_VALUE || (!projectId.trim() && !projectlessNaturalChatAllowed)
        ? "project_scope_missing"
        : !userQuestion.trim()
          ? "question_missing"
          : contextEditorDirty
            ? "context_editor_dirty"
            : isBusy
              ? "busy"
              : contextRequestApprovalReview
                ? "context_request_review_active"
                : hasBlockingPromptWarning
                    ? "blocking_prompt_warning"
                    : "ready";
  const canReachSendConfigurationBoundary = sendReviewGateCode === "ready";
  const providerBoundaryCode: ChatProviderBoundaryCode = providerConfiguration?.eligibility === "eligible"
    ? "eligible"
    : !providerConfiguration
      ? "provider_status_unavailable"
      : providerConfiguration.localConfigurationState === "secure_store_unavailable"
        ? "secure_store_unavailable"
        : providerConfiguration.localConfigurationState === "invalid_shape"
          ? "invalid_provider_configuration"
          : providerConfiguration.effectiveConfigured === false || providerConfiguration.configuredSource === "none"
            ? "missing_api_key"
            : "provider_configuration_blocked";
  const sendGateNotice = sendReviewGateCode === "ready"
    ? providerBoundaryCode === "missing_api_key"
      ? t("aiSendBoundaryMissingApiKey")
      : providerBoundaryCode === "invalid_provider_configuration"
        ? t("aiSendBoundaryInvalidConfiguration")
        : providerBoundaryCode === "secure_store_unavailable"
          ? t("aiSendBoundarySecureStoreUnavailable")
          : providerBoundaryCode === "provider_status_unavailable" || providerBoundaryCode === "provider_configuration_blocked"
            ? t("aiSendBoundaryConfigurationUnavailable")
            : undefined
    : userQuestion.trim()
      ? sendReviewGateCode === "blocking_prompt_warning"
        ? t("aiSendGateBlockingWarning")
        : sendReviewGateCode === "context_editor_dirty"
            ? t("aiUnsavedContextGateMessage")
          : sendReviewGateCode === "busy"
            ? undefined
            : sendReviewGateCode === "project_scope_missing"
              ? t("aiSendGateProjectScopeRequired")
              : sendReviewGateCode === "context_request_review_active"
                ? t("aiSendGateOtherReviewActive")
                : t("aiPreviewRequiredMessage")
      : undefined;
  const canStop = Boolean(
    isSending && activeStreamReady && !streamPresentation.terminal &&
    ["starting", "streaming", "stop_requested"].includes(streamPresentation.phase)
  );
  const selectedAttachments = selectedAttachmentIds
    .map((id) => selectableFileRefs.find((candidate) => candidate.fileRefId === id))
    .filter((candidate): candidate is AISelectableFileRef => Boolean(candidate));
  const durableResult = conversationReadback
    ? effectiveDurableResultFromReadback(conversationReadback)
    : null;
  const result = durableResult?.response ?? null;
  const displayedContextPackage = contextRequestApprovalReview?.review.contextPackage ?? contextPackage;
  const displayedPromptPackage = contextRequestApprovalReview?.review.promptPackage ?? promptPackage;
  const displayedContextMarkdown = contextRequestApprovalReview?.review.promptPackage.contextMarkdown ?? contextMarkdown;
  const reviewedContextRequestId = contextRequestApprovalReview?.review.contextRequestId;
  const normalizedHistorySearch = historySearch.trim().toLocaleLowerCase();
  const filteredConversationSummaries = normalizedHistorySearch
    ? conversationSummaries.filter((summary) => (
        `${conversationTitle(summary)} ${summary.latestMessage ?? ""}`
          .toLocaleLowerCase()
          .includes(normalizedHistorySearch)
      ))
    : conversationSummaries;
  const conversationHistoryGroups = groupAIConversationHistory(filteredConversationSummaries);
  const activeCategoryResearchObjects = filterAIResearchObjectsByCategory(
    researchObjectOptions,
    activeResearchObjectCategory
  );
  const selectedResearchObjectDescriptors = researchObjectOptions.filter((descriptor) => (
    researchObjectIdsForType(descriptor.objectType).includes(descriptor.objectId)
  ));
  const displayedResearchObjects = displayedContextPackage?.researchObjects ?? [];
  const displayedMaterials = displayedContextPackage?.materialDecisions ?? [];
  const contextEntryPresentation = displayedContextPackage
    ? buildAIChatContextCompactPresentation({
        contextMode: displayedContextPackage.contextMode,
        researchObjects: displayedResearchObjects,
        materials: displayedMaterials
      })
    : {
        title: "构建上下文",
        detail: selectedResearchObjectCount > 0
          ? `已选择 ${selectedResearchObjectCount} 个对象，尚未构建内容`
          : "尚未构建，点击选择上下文对象"
      };
  const currentStandardResults = conversationReadback?.standardResults ?? [];
  const projectNameById = useMemo<Readonly<Record<string, string>>>(() => (
    Object.fromEntries(projects.map((project) => [project.id, project.title]))
  ), [projects]);
  const objectNameByKey = useMemo<Readonly<Record<string, string>>>(() => (
    Object.fromEntries(researchObjectOptions.map((descriptor) => [
      `${descriptor.objectType}:${descriptor.objectId}`,
      descriptor.label
    ]))
  ), [researchObjectOptions]);
  const pendingOperationCount = currentStandardResults.filter((standardResult) =>
    standardResult.action !== "DELETE_SUGGESTION" && standardResult.action !== "NEW_MANUSCRIPT" &&
    standardResult.disposition === "PENDING").length;
  const operationSuggestionCount = currentStandardResults.filter((standardResult) => (
    standardResult.disposition === "PENDING" && standardResult.action === "DELETE_SUGGESTION"
  )).length;
  const emptyStateGreeting = researcherNickname
    ? `${researcherNickname}，我们从哪里继续呢`
    : "你好，我们从哪里继续呢";

  useEffect(() => {
    onContextDirtyChange?.(contextEditorDirty);
  }, [contextEditorDirty, onContextDirtyChange]);

  useEffect(() => () => {
    onContextDirtyChange?.(false);
  }, [onContextDirtyChange]);

  useEffect(() => {
    if (contextRequestApprovalReview) setActiveWorkspace("context-preview");
  }, [contextRequestApprovalReview]);

  const refreshConversationSummaries = useCallback(async () => {
    const summaries = await aiConversationApplicationService.listConversations();
    setConversationSummaries(summaries);
    return summaries;
  }, []);

  const refreshProviderConfiguration = useCallback(async () => {
    try {
      const status = await getAIProviderConfigurationStatus();
      setProviderConfiguration(status);
      return status;
    } catch {
      setProviderConfiguration(null);
      return null;
    }
  }, []);

  const openConversation = useCallback(async (
    conversationId: string,
    expectedSelectionIntent?: number
  ) => {
    if (
      expectedSelectionIntent !== undefined &&
      conversationSelectionIntentRef.current !== expectedSelectionIntent
    ) return null;
    const generation = conversationLoadGenerationRef.current + 1;
    conversationLoadGenerationRef.current = generation;
    setIsLoadingConversations(true);
    try {
      const readback = await aiConversationApplicationService.readConversation(conversationId);
      if (
        conversationLoadGenerationRef.current !== generation ||
        (expectedSelectionIntent !== undefined &&
          conversationSelectionIntentRef.current !== expectedSelectionIntent)
      ) return null;
      if (readback.conversation.id !== conversationId) throw new Error("Conversation identity mismatch.");
      selectedConversationIdRef.current = conversationId;
      setSelectedConversationId(conversationId);
      setConversationReadback(readback);
      return readback;
    } finally {
      if (conversationLoadGenerationRef.current === generation) setIsLoadingConversations(false);
    }
  }, []);

  useEffect(() => {
    void refreshProviderConfiguration();
  }, [refreshProviderConfiguration]);

  useEffect(() => {
    let cancelled = false;
    void getResearcherProfile().then((profile) => {
      if (!cancelled) setResearcherNickname(profile?.nickname?.trim() ?? "");
    });
    return () => { cancelled = true; };
  }, []);

  const refreshAttachmentOptions = useCallback(async () => {
    setIsLoadingAttachments(true);
    try {
      const catalog = await aiConversationApplicationService.listAttachmentFileRefs();
      setSelectableFileRefs(catalog.fileRefs);
      setEffectiveReadableSelectionLimit(catalog.effectiveReadableSelectionLimit);
      setSupportedMaterialExtensions(catalog.supportedExtensions);
      return catalog.fileRefs;
    } catch {
      setError({
        title: "关联材料暂不可用",
        message: "暂时无法读取可用材料列表，请稍后重试。"
      });
      return [];
    } finally {
      setIsLoadingAttachments(false);
    }
  }, []);

  useEffect(() => {
    void refreshAttachmentOptions();
  }, [refreshAttachmentOptions]);

  useEffect(() => {
    let cancelled = false;
    setIsLoadingProjects(true);
    planningService.queryProjects()
      .then((nextProjects) => {
        if (!cancelled) setProjects([...nextProjects].sort((a, b) => a.title.localeCompare(b.title)));
      })
      .catch(() => { if (!cancelled) setProjectLoadFailed(true); })
      .finally(() => { if (!cancelled) setIsLoadingProjects(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (
      isLoadingProjects || projectLoadFailed || scopeSelection !== "" || projectId.trim() ||
      projects.length === 0
    ) return;
    const storedProjectId = readLastSelectedAIProjectPreference();
    const preferredProjectId = resolvePreferredAIProjectId(projects, storedProjectId);
    if (storedProjectId && storedProjectId !== preferredProjectId) {
      clearLastSelectedAIProjectPreference();
    }
    if (!preferredProjectId) return;
    setScopeSelection(preferredProjectId);
    setProjectId(preferredProjectId);
  }, [isLoadingProjects, projectLoadFailed, projectId, projects, scopeSelection]);

  useEffect(() => {
    const normalizedProjectId = projectId.trim();
    if (
      isLoadingProjects || !normalizedProjectId ||
      !projects.some((project) => (
        project.id === normalizedProjectId &&
        !project.deletedAt && !project.archivedAt && project.status !== "archived"
      ))
    ) return;
    writeLastSelectedAIProjectPreference(normalizedProjectId);
  }, [isLoadingProjects, projectId, projects]);

  useEffect(() => {
    if (!launchIntent) return;
    const boundedResearchObjects = [...new Map(launchIntent.researchObjects.map((candidate) => [
      `${candidate.objectType}:${candidate.objectId}`,
      candidate
    ])).values()];
    setScopeSelection(launchIntent.projectId);
    setProjectId(launchIntent.projectId);
    if (boundedResearchObjects.length > AI_RESEARCH_OBJECT_SELECTION_MAX) {
      clearSelectedResearchObjects();
      setError({
        title: "已达到研究对象上限",
        message: `最多可选择 ${AI_RESEARCH_OBJECT_SELECTION_MAX} 个研究对象；本次预设已整体拒绝，不会静默截断。`
      });
      invalidatePreview();
      return;
    }
    setSelectedRouteIds(
      boundedResearchObjects
        .filter((candidate) => candidate.objectType === "route")
        .map((candidate) => candidate.objectId)
    );
    setSelectedTaskIds(
      boundedResearchObjects
        .filter((candidate) => candidate.objectType === "task")
        .map((candidate) => candidate.objectId)
    );
    setSelectedReviewIds(
      boundedResearchObjects
        .filter((candidate) => candidate.objectType === "review")
        .map((candidate) => candidate.objectId)
    );
    setSelectedExperimentIds(
      boundedResearchObjects
        .filter((candidate) => candidate.objectType === "experiment")
        .map((candidate) => candidate.objectId)
    );
    setSelectedExperimentRunIds(
      boundedResearchObjects
        .filter((candidate) => candidate.objectType === "experimentRun")
        .map((candidate) => candidate.objectId)
    );
    setSelectedLiteratureIds(
      boundedResearchObjects
        .filter((candidate) => candidate.objectType === "literature")
        .map((candidate) => candidate.objectId)
    );
    setSelectedFindingIds(
      boundedResearchObjects
        .filter((candidate) => candidate.objectType === "finding")
        .map((candidate) => candidate.objectId)
    );
    setSelectedResultItemIds(
      boundedResearchObjects
        .filter((candidate) => candidate.objectType === "resultItem")
        .map((candidate) => candidate.objectId)
    );
    setSelectedOutputCandidateIds(
      boundedResearchObjects
        .filter((candidate) => candidate.objectType === "outputCandidate")
        .map((candidate) => candidate.objectId)
    );
    setSelectedOutputGapIds(
      boundedResearchObjects
        .filter((candidate) => candidate.objectType === "outputGap")
        .map((candidate) => candidate.objectId)
    );
    setSelectedResearchOutputIds(
      boundedResearchObjects
        .filter((candidate) => candidate.objectType === "researchOutput")
        .map((candidate) => candidate.objectId)
    );
    const launchDraft = compactLine(launchIntent.draftQuestion, 2_000);
    setSelectedAttachmentIds([]);
    clearOneShotLocalAttachment();
    setIncludeAssociatedDocuments(false);
    setAttachmentSelectorOpen(false);
    setActiveWorkspace("chat");
    setUserQuestion(launchDraft ?? "");
    setComposerDraftSeed(launchDraft);
    setContextMode("STANDARD");
    invalidatePreview();
  }, [launchIntent?.requestId]);

  useEffect(() => {
    let cancelled = false;
    if (!projectId.trim() || scopeSelection === AI_CHAT_OTHER_SCOPE_VALUE) {
      setResearchObjectOptions([]);
      if (!launchIntent || scopeSelection === AI_CHAT_OTHER_SCOPE_VALUE) {
        clearSelectedResearchObjects();
      }
      setIsLoadingResearchObjects(false);
      return () => { cancelled = true; };
    }
    setIsLoadingResearchObjects(true);
    listAIResearchObjectsForProject(projectId.trim())
      .then((descriptors) => {
        if (cancelled) return;
        const ordered = [...descriptors].sort((left, right) => (
          left.label.localeCompare(right.label) || left.objectId.localeCompare(right.objectId)
        ));
        setResearchObjectOptions(ordered);
        const availableRouteIds = new Set(ordered
          .filter((descriptor) => descriptor.objectType === "route")
          .map((descriptor) => descriptor.objectId));
        const availableTaskIds = new Set(ordered
          .filter((descriptor) => descriptor.objectType === "task")
          .map((descriptor) => descriptor.objectId));
        const availableReviewIds = new Set(ordered
          .filter((descriptor) => descriptor.objectType === "review")
          .map((descriptor) => descriptor.objectId));
        const availableExperimentIds = new Set(ordered
          .filter((descriptor) => descriptor.objectType === "experiment")
          .map((descriptor) => descriptor.objectId));
        const availableExperimentRunIds = new Set(ordered
          .filter((descriptor) => descriptor.objectType === "experimentRun")
          .map((descriptor) => descriptor.objectId));
        const availableLiteratureIds = new Set(ordered
          .filter((descriptor) => descriptor.objectType === "literature")
          .map((descriptor) => descriptor.objectId));
        const availableFindingIds = new Set(ordered
          .filter((descriptor) => descriptor.objectType === "finding")
          .map((descriptor) => descriptor.objectId));
        const availableResultItemIds = new Set(ordered
          .filter((descriptor) => descriptor.objectType === "resultItem")
          .map((descriptor) => descriptor.objectId));
        const availableOutputCandidateIds = new Set(ordered
          .filter((descriptor) => descriptor.objectType === "outputCandidate")
          .map((descriptor) => descriptor.objectId));
        const availableOutputGapIds = new Set(ordered
          .filter((descriptor) => descriptor.objectType === "outputGap")
          .map((descriptor) => descriptor.objectId));
        const availableResearchOutputIds = new Set(ordered
          .filter((descriptor) => descriptor.objectType === "researchOutput")
          .map((descriptor) => descriptor.objectId));
        setSelectedRouteIds((current) => current.filter((id) => availableRouteIds.has(id)));
        setSelectedTaskIds((current) => current.filter((id) => availableTaskIds.has(id)));
        setSelectedReviewIds((current) => current.filter((id) => availableReviewIds.has(id)));
        setSelectedExperimentIds((current) => current.filter((id) => availableExperimentIds.has(id)));
        setSelectedExperimentRunIds((current) => current.filter((id) => availableExperimentRunIds.has(id)));
        setSelectedLiteratureIds((current) => current.filter((id) => availableLiteratureIds.has(id)));
        setSelectedFindingIds((current) => current.filter((id) => availableFindingIds.has(id)));
        setSelectedResultItemIds((current) => current.filter((id) => availableResultItemIds.has(id)));
        setSelectedOutputCandidateIds((current) => current.filter((id) => availableOutputCandidateIds.has(id)));
        setSelectedOutputGapIds((current) => current.filter((id) => availableOutputGapIds.has(id)));
        setSelectedResearchOutputIds((current) => current.filter((id) => availableResearchOutputIds.has(id)));
      })
      .catch(() => {
        if (!cancelled) {
          setResearchObjectOptions([]);
          clearSelectedResearchObjects();
          setError({
          title: "研究对象暂不可用",
          message: "暂时无法读取当前课题的研究对象，请稍后重试。"
          });
        }
      })
      .finally(() => { if (!cancelled) setIsLoadingResearchObjects(false); });
    return () => { cancelled = true; };
  }, [projectId, scopeSelection, launchIntent?.requestId]);

  useEffect(() => {
    let cancelled = false;
    setIsLoadingConversations(true);
    aiConversationApplicationService.listConversations()
      .then(async (summaries) => {
        if (cancelled) return;
        setConversationSummaries(summaries);
        if (summaries[0]) await openConversation(summaries[0].id);
        else setIsLoadingConversations(false);
      })
      .catch(() => {
        if (!cancelled) {
      setError({ title: "对话历史暂不可用", message: "暂时无法读取对话历史。" });
          setIsLoadingConversations(false);
        }
      });
    return () => { cancelled = true; };
  }, [openConversation]);

  useEffect(() => () => {
    streamGenerationRef.current += 1;
    conversationLoadGenerationRef.current += 1;
    conversationSelectionIntentRef.current += 1;
    selectedConversationIdRef.current = null;
    const active = activeSendRef.current;
    activeSendRef.current = null;
    if (active) void active.cancel().catch(() => undefined);
  }, []);

  function invalidatePreview() {
    setContextRequestApprovalReview(null);
    setReviewingContextRequestId(undefined);
    setParseDraftTerminal(undefined);
    setParseDraftEligibilityNotice(undefined);
    setContextPackage(null);
    setPromptPackage(null);
    setPromptConversationId(null);
    setContextMarkdown("");
    setDefaultContextMarkdown("");
    setIsContextModified(false);
    setContextEditorDirty(false);
    setAssociatedCurrentManuscripts([]);
    setBuiltAssociatedFileRefIds([]);
    setAssociatedDocumentSkipCount(0);
    setStreamPresentation(INITIAL_AI_STREAMING_PRESENTATION_STATE);
    setError(null);
  }

  async function handleCreateAndSelectConversation() {
    if (isSending || activeDraftGenerationRef.current || createInFlightRef.current) return;
    const selectionIntent = conversationSelectionIntentRef.current + 1;
    conversationSelectionIntentRef.current = selectionIntent;
    const preserveLaunchDraft = selectedConversationIdRef.current === null && Boolean(composerDraftSeed);
    createInFlightRef.current = true;
    setSelectedAttachmentIds([]);
    clearOneShotLocalAttachment();
    setIncludeAssociatedDocuments(false);
    setAttachmentSelectorOpen(false);
    setIsCreatingConversation(true);
    setError(null);
    try {
      const conversation = await aiConversationApplicationService.createConversation();
      const readback = await openConversation(conversation.id, selectionIntent);
      if (readback) {
        invalidatePreview();
        setActiveWorkspace("chat");
        if (!preserveLaunchDraft) {
          setScopeSelection("");
          setProjectId("");
          clearSelectedResearchObjects();
          setUserQuestion("");
          setComposerDraftSeed(undefined);
        }
      }
      try {
        await refreshConversationSummaries();
      } catch {
        if (conversationSelectionIntentRef.current === selectionIntent) {
          setError({
            title: "对话历史暂不可用",
            message: "新对话已打开，但历史列表暂未刷新。"
          });
        }
      }
    } catch {
      if (conversationSelectionIntentRef.current === selectionIntent) {
        setError({
          title: "新建对话失败",
          message: "暂时无法创建或打开新对话，请重试。"
        });
      }
    } finally {
      createInFlightRef.current = false;
      setIsCreatingConversation(false);
    }
  }

  async function handleSelectConversation(conversationId: string) {
    if (isSending || activeDraftGenerationRef.current || conversationId === selectedConversationId) return;
    const selectionIntent = conversationSelectionIntentRef.current + 1;
    conversationSelectionIntentRef.current = selectionIntent;
    setSelectedAttachmentIds([]);
    clearOneShotLocalAttachment();
    setIncludeAssociatedDocuments(false);
    setAttachmentSelectorOpen(false);
    setScopeSelection("");
    setProjectId("");
    clearSelectedResearchObjects();
    setActiveWorkspace("chat");
    invalidatePreview();
    setUserQuestion("");
    setComposerDraftSeed(undefined);
    try {
      const readback = await openConversation(conversationId, selectionIntent);
      if (!readback || conversationSelectionIntentRef.current !== selectionIntent) return;
      const currentAssistantCustody = readLatestAssistantMessageContextCustody(readback);
      if (currentAssistantCustody) {
        const ids = (objectType: AIResearchObjectType) => (
          currentAssistantCustody.selection.researchObjects
            .filter((selection) => selection.objectType === objectType)
            .map((selection) => selection.objectId)
        );
        setScopeSelection(currentAssistantCustody.selection.projectId);
        setProjectId(currentAssistantCustody.selection.projectId);
        setContextMode(currentAssistantCustody.selection.contextMode);
        setSelectedRouteIds(ids("route"));
        setSelectedTaskIds(ids("task"));
        setSelectedReviewIds(ids("review"));
        setSelectedExperimentIds(ids("experiment"));
        setSelectedExperimentRunIds(ids("experimentRun"));
        setSelectedLiteratureIds(ids("literature"));
        setSelectedFindingIds(ids("finding"));
        setSelectedResultItemIds(ids("resultItem"));
        setSelectedOutputCandidateIds(ids("outputCandidate"));
        setSelectedOutputGapIds(ids("outputGap"));
        setSelectedResearchOutputIds(ids("researchOutput"));
      }
    } catch {
      if (conversationSelectionIntentRef.current === selectionIntent) {
        setError({ title: "对话暂不可用", message: "暂时无法打开所选对话。" });
      }
    }
  }

  function handleScopeChange(value: string) {
    const preserveContextWorkspace = activeWorkspace === "context-builder" ||
      activeWorkspace === "context-preview" || activeWorkspace === "context-edit";
    const selection = resolveAIChatScopeSelection(value, projectId);
    setScopeSelection(value);
    setProjectId(selection.projectId);
    clearSelectedResearchObjects();
    setSelectedAttachmentIds([]);
    clearOneShotLocalAttachment();
    setIncludeAssociatedDocuments(false);
    setAttachmentSelectorOpen(false);
    invalidatePreview();
    setActiveWorkspace(preserveContextWorkspace ? "context-builder" : "chat");
  }

  function handleContextModeChange(value: AIContextMode) {
    setContextMode(value);
    invalidatePreview();
  }

  function handleOutputDetailPreferenceChange(value: AIOutputDetailPreference) {
    setOutputDetailPreference(value);
    invalidatePreview();
  }

  function toggleResearchObject(descriptor: AIResearchObjectDescriptor) {
    const selectedIds = researchObjectIdsForType(descriptor.objectType);
    if (!selectedIds.includes(descriptor.objectId) && selectedResearchObjectCount >= AI_RESEARCH_OBJECT_SELECTION_MAX) {
      setError({
        title: "已达到选择上限",
        message: `每次最多选择 ${AI_RESEARCH_OBJECT_SELECTION_MAX} 个研究对象。`
      });
      return;
    }
    invalidatePreview();
    updateResearchObjectIds(descriptor.objectType, (current) => current.includes(descriptor.objectId)
      ? current.filter((id) => id !== descriptor.objectId)
      : [...current, descriptor.objectId]);
  }

  function handleAssociatedDocumentChange(include: boolean) {
    setIncludeAssociatedDocuments(include);
    invalidatePreview();
  }

  function handleQuestionChange(value: string) {
    setUserQuestion(value);
    setComposerDraftSeed(undefined);
    setError(null);
  }

  function clearOneShotLocalAttachment() {
    setOneShotLocalAttachmentFile(null);
    if (oneShotLocalAttachmentInputRef.current) {
      oneShotLocalAttachmentInputRef.current.value = "";
    }
  }

  function handleOneShotLocalAttachmentSelection(file: File | undefined) {
    if (!file) return;
    try {
      validateAIOneShotLocalAttachmentSelection(file);
      setOneShotLocalAttachmentFile(file);
      setError(null);
    } catch (unknownError) {
      clearOneShotLocalAttachment();
      const message = isAIOneShotLocalAttachmentError(unknownError)
        ? unknownError.message
        : "文件当前无法读取";
      setError({ title: "无法添加本次附件", message });
    }
  }

  function toggleAttachment(candidate: AISelectableFileRef) {
    if (
      candidate.resourceKind !== "file" ||
      candidate.availabilityStatus !== "available" ||
      candidate.materialReadStatus !== "supported" ||
      !Number.isSafeInteger(candidate.materialPromptReservationCharacters) ||
      (candidate.materialPromptReservationCharacters ?? 0) <= 0 ||
      !hasCanonicalMaterialFreshnessReceipt(candidate)
    ) {
      setError({
        title: "附件不可用",
        message: `${candidate.displayName} 当前不可用；仅支持可读取的 .txt 或 .md 文本。`
      });
      return;
    }
    invalidatePreview();
    setSelectedAttachmentIds((current) => {
      if (current.includes(candidate.fileRefId)) {
        return current.filter((id) => id !== candidate.fileRefId);
      }
      if (
        effectiveReadableSelectionLimit === null ||
        current.length >= effectiveReadableSelectionLimit
      ) {
        setError({
          title: "已达到附件上限",
          message: effectiveReadableSelectionLimit === null
            ? "当前无法确认附件上限，请稍后重试。"
            : `每次最多选择 ${effectiveReadableSelectionLimit} 份附件。`
        });
        return current;
      }
      setError(null);
      return [...current, candidate.fileRefId];
    });
  }

  function applyPromptPackage(nextPromptPackage: AIPromptPackage, conversationId: string) {
    setPromptPackage(nextPromptPackage);
    setPromptConversationId(conversationId);
    setContextMarkdown(nextPromptPackage.contextMarkdown);
    const capacityWarning = nextPromptPackage.warnings?.find(isTechnicalCapacityWarning);
    const contextWarning = nextPromptPackage.warnings?.find(
      (warning) => warning.severity === "error" && !isTechnicalCapacityWarning(warning)
    );
    if (capacityWarning) {
      setError({ title: t("aiPromptBudgetTitle"), message: t("aiPromptBudgetMessage") });
    } else if (contextWarning) {
      setError({ title: t("aiContextBuildFailed"), message: t("aiContextBlockingWarning") });
    } else {
      setError(null);
    }
  }

  function contextMaterialSelections(
    attachmentIds: readonly string[],
    catalog: readonly AISelectableFileRef[] = selectableFileRefs
  ): AIContextMaterialSelection[] {
    return attachmentIds.map((fileRefId) => {
      const candidate = catalog.find((item) => item.fileRefId === fileRefId);
      return candidate ? {
        fileRefId: candidate.fileRefId,
        displayName: candidate.displayName,
        availabilityStatus: candidate.availabilityStatus,
        materialReadStatus: candidate.materialReadStatus,
        materialPromptReservationCharacters:
          candidate.materialPromptReservationCharacters ?? 0,
        ...(candidate.materialFreshnessReceipt
          ? { materialFreshnessReceipt: { ...candidate.materialFreshnessReceipt } }
          : {})
      } : {
        fileRefId,
        displayName: fileRefId,
        availabilityStatus: "unavailable",
        materialReadStatus: "unavailable",
        materialPromptReservationCharacters: 0
      };
    });
  }

  async function resolveAssociatedMaterialsForBuild(
    descriptors: readonly AIResearchObjectDescriptor[],
    catalog: readonly AISelectableFileRef[],
    include: boolean
  ) {
    if (!include) return { materials: [], issues: [] };
    return resolveAIAssociatedCurrentManuscripts(descriptors, catalog);
  }

  async function buildFrozenContext(input: {
    frozenProjectId: string;
    frozenMode: AIContextMode;
    frozenRouteIds: readonly string[];
    frozenTaskIds: readonly string[];
    frozenReviewIds: readonly string[];
    frozenExperimentIds: readonly string[];
    frozenExperimentRunIds: readonly string[];
    frozenLiteratureIds: readonly string[];
    frozenFindingIds: readonly string[];
    frozenResultItemIds: readonly string[];
    frozenOutputCandidateIds: readonly string[];
    frozenOutputGapIds: readonly string[];
    frozenResearchOutputIds: readonly string[];
    frozenAttachmentIds: readonly string[];
    approvedContextRequestContributions?: readonly AIApprovedContextRequestContribution[];
    maxChars: number;
  }): Promise<AIContextPackage> {
    const projectless = !input.frozenProjectId.trim();
    const selectedObjectCount = input.frozenRouteIds.length + input.frozenTaskIds.length +
      input.frozenReviewIds.length + input.frozenExperimentIds.length +
      input.frozenExperimentRunIds.length + input.frozenLiteratureIds.length +
      input.frozenFindingIds.length + input.frozenResultItemIds.length +
      input.frozenOutputCandidateIds.length + input.frozenOutputGapIds.length +
      input.frozenResearchOutputIds.length;
    if (projectless) {
      if (input.frozenMode !== "MINIMAL" || selectedObjectCount > 0 || input.frozenAttachmentIds.length > 0) {
        throw new Error("Projectless Natural Chat only supports an empty global MINIMAL context.");
      }
      return buildAIContext({
        scopeType: "global",
        contextMode: "MINIMAL",
        researchObjects: [],
        selectedMaterials: [],
        budget: createAIChatContextBudget(input.maxChars)
      });
    }
    const reviewCatalog = input.frozenAttachmentIds.length > 0
      ? await refreshAttachmentOptions()
      : selectableFileRefs;
    return buildAIContext({
      scopeType: "project",
      scopeId: input.frozenProjectId,
      contextMode: input.frozenMode,
      researchObjects: [
        ...input.frozenRouteIds.map((objectId) => ({ objectType: "route" as const, objectId })),
        ...input.frozenTaskIds.map((objectId) => ({ objectType: "task" as const, objectId })),
        ...input.frozenReviewIds.map((objectId) => ({ objectType: "review" as const, objectId })),
        ...input.frozenExperimentIds.map((objectId) => ({ objectType: "experiment" as const, objectId })),
        ...input.frozenExperimentRunIds.map((objectId) => ({ objectType: "experimentRun" as const, objectId })),
        ...input.frozenLiteratureIds.map((objectId) => ({ objectType: "literature" as const, objectId })),
        ...input.frozenFindingIds.map((objectId) => ({ objectType: "finding" as const, objectId })),
        ...input.frozenResultItemIds.map((objectId) => ({ objectType: "resultItem" as const, objectId })),
        ...input.frozenOutputCandidateIds.map((objectId) => ({ objectType: "outputCandidate" as const, objectId })),
        ...input.frozenOutputGapIds.map((objectId) => ({ objectType: "outputGap" as const, objectId })),
        ...input.frozenResearchOutputIds.map((objectId) => ({ objectType: "researchOutput" as const, objectId }))
      ],
      selectedMaterials: contextMaterialSelections(input.frozenAttachmentIds, reviewCatalog),
      approvedContextRequestContributions: input.approvedContextRequestContributions?.map(
        (contribution) => ({ ...contribution })
      ),
      budget: createAIChatContextBudget(input.maxChars)
    });
  }

  async function handleBuildPreview(): Promise<boolean> {
    const normalizedProjectId = projectId.trim();
    const normalizedQuestion = userQuestion.trim();
    const conversationId = selectedConversationId;
    if (!conversationId) {
      setError({ title: "请先选择对话", message: "新建或选择一个对话后再构建上下文。" });
      return false;
    }
    if (scopeSelection === AI_CHAT_OTHER_SCOPE_VALUE) {
      setError({ title: t("aiOtherScopeTitle"), message: t("aiOtherScopeMessage") });
      return false;
    }
    if (!normalizedProjectId) {
      setError({ title: t("aiMissingProjectTitle"), message: t("aiMissingProjectMessage") });
      return false;
    }
    setIsBuilding(true);
    setError(null);
    try {
      const reviewCatalog = await refreshAttachmentOptions();
      const associatedProjection = await resolveAssociatedMaterialsForBuild(
        selectedResearchObjectDescriptors,
        reviewCatalog,
        includeAssociatedDocuments
      );
      const associatedFileRefIds = associatedProjection.materials.map((item) => item.fileRefId);
      const combinedMaterialIds = uniqueCanonicalIds([
        ...selectedAttachmentIds,
        ...associatedFileRefIds
      ]);
      if (
        effectiveReadableSelectionLimit !== null &&
        combinedMaterialIds.length > effectiveReadableSelectionLimit
      ) {
        setError({
          title: "关联材料超过本次上限",
          message: `手动附件与关联文档去重后最多可选择 ${effectiveReadableSelectionLimit} 个，请减少选择后重试。`
        });
        return false;
      }
      const nextContextPackage = await buildFrozenContext({
        frozenProjectId: normalizedProjectId,
        frozenMode: contextMode,
        frozenRouteIds: selectedRouteIds,
        frozenTaskIds: selectedTaskIds,
        frozenReviewIds: selectedReviewIds,
        frozenExperimentIds: selectedExperimentIds,
        frozenExperimentRunIds: selectedExperimentRunIds,
        frozenLiteratureIds: selectedLiteratureIds,
        frozenFindingIds: selectedFindingIds,
        frozenResultItemIds: selectedResultItemIds,
        frozenOutputCandidateIds: selectedOutputCandidateIds,
        frozenOutputGapIds: selectedOutputGapIds,
        frozenResearchOutputIds: selectedResearchOutputIds,
        frozenAttachmentIds: combinedMaterialIds,
        maxChars: autoPullContextBudget.maxChars
      });
      if (selectedConversationIdRef.current !== conversationId) return false;
      const defaultOutboundBody = buildAIContextHumanReadablePreview({
        contextPackage: nextContextPackage,
        language: "zh-CN"
      }).markdown;
      setContextPackage(nextContextPackage);
      setAssociatedCurrentManuscripts(associatedProjection.materials);
      setBuiltAssociatedFileRefIds(associatedFileRefIds);
      setAssociatedDocumentSkipCount(associatedProjection.issues.length);
      setIsContextModified(false);
      setContextEditorDirty(false);
      setPromptPackage(null);
      setPromptConversationId(null);
      setContextMarkdown(defaultOutboundBody);
      setDefaultContextMarkdown(defaultOutboundBody);
      if (!normalizedQuestion) {
        setError(null);
        return true;
      }
      let built;
      try {
        built = await buildConversationPromptPackage({
          conversationId,
          contextPackage: nextContextPackage,
          userQuestion: normalizedQuestion,
          constraintRequest: { kind: "current", category: "NORMAL_QA" },
          options: {
            technicalCapacityChars: AI_PROVIDER_PROMPT_TECHNICAL_MAX_CHARS,
            outputDetailPreference,
            contextMarkdownOverride: defaultOutboundBody
          }
        });
      } catch {
        setError({ title: t("aiPromptBuildFailed"), message: t("aiPromptBuildFailedMessage") });
        return false;
      }
      if (selectedConversationIdRef.current !== conversationId) return false;
      setConversationReadback(built.readback);
      applyPromptPackage(built.promptPackage, conversationId);
      return true;
    } catch {
      setContextPackage(null);
      setPromptPackage(null);
      setPromptConversationId(null);
      setContextMarkdown("");
      setDefaultContextMarkdown("");
      setIsContextModified(false);
      setContextEditorDirty(false);
      setError({ title: t("aiContextBuildFailed"), message: t("aiContextBuildFailedMessage") });
      return false;
    } finally {
      setIsBuilding(false);
    }
  }

  async function rebuildPromptWithContext(savedContextMarkdown: string) {
    const conversationId = selectedConversationId;
    if (!contextPackage || !conversationId) return;
    setContextMarkdown(savedContextMarkdown);
    setIsContextModified(savedContextMarkdown !== defaultContextMarkdown);
    setContextEditorDirty(false);
    setPromptPackage(null);
    setPromptConversationId(null);
    if (!userQuestion.trim()) {
      setError(null);
      return;
    }
    setIsBuilding(true);
    try {
      const built = await buildConversationPromptPackage({
        conversationId,
        contextPackage,
        userQuestion: userQuestion.trim(),
        constraintRequest: { kind: "current", category: "NORMAL_QA" },
        options: {
          technicalCapacityChars: AI_PROVIDER_PROMPT_TECHNICAL_MAX_CHARS,
          outputDetailPreference,
          contextMarkdownOverride: savedContextMarkdown
        }
      });
      if (selectedConversationIdRef.current !== conversationId) return;
      setConversationReadback(built.readback);
      applyPromptPackage(built.promptPackage, conversationId);
    } catch {
      setError({ title: t("aiPromptBuildFailed"), message: t("aiPromptBuildFailedMessage") });
    } finally {
      setIsBuilding(false);
    }
  }

  async function refreshSelectedReadback(conversationId: string) {
    try {
      const readback = await aiConversationApplicationService.readConversation(conversationId);
      if (selectedConversationIdRef.current === conversationId && readback.conversation.id === conversationId) {
        setConversationReadback(readback);
      }
    } catch {
      // The durable persistence error already describes the authoritative readback failure.
    }
  }

  async function requireMaterialReReview(
    conversationId: string,
    frozenAttachmentIds: readonly string[]
  ) {
    await refreshSelectedReadback(conversationId);
    await refreshConversationSummaries().catch(() => undefined);
    invalidatePreview();
    setSelectedAttachmentIds([...frozenAttachmentIds]);
    setAttachmentSelectorOpen(true);
    await refreshAttachmentOptions();
    setError({
      title: "材料需要重新审阅",
      message: "所选材料已发生变化，本次请求尚未发送。请重新构建并审阅上下文。"
    });
  }

  async function handleSend(text: string): Promise<AssistantUIComposerOutcome> {
    const conversationId = selectedConversationId;
    const reviewedContextPackage = contextPackage;
    const reviewedPromptPackage = promptPackage;
    const normalizedQuestion = text.trim();
    const frozenProjectId = projectId.trim();
    const frozenProjectlessNaturalChatAllowed = projectlessNaturalChatAllowed;
    const frozenMode: AIContextMode = reviewedContextPackage
      ? contextMode
      : "MINIMAL";
    const frozenRouteIds = [...selectedRouteIds];
    const frozenTaskIds = [...selectedTaskIds];
    const frozenReviewIds = [...selectedReviewIds];
    const frozenExperimentIds = [...selectedExperimentIds];
    const frozenExperimentRunIds = [...selectedExperimentRunIds];
    const frozenLiteratureIds = [...selectedLiteratureIds];
    const frozenFindingIds = [...selectedFindingIds];
    const frozenResultItemIds = [...selectedResultItemIds];
    const frozenOutputCandidateIds = [...selectedOutputCandidateIds];
    const frozenOutputGapIds = [...selectedOutputGapIds];
    const frozenResearchOutputIds = [...selectedResearchOutputIds];
    const frozenManualAttachmentIds = [...selectedAttachmentIds];
    const frozenOneShotLocalAttachmentFile = oneShotLocalAttachmentFile;
    let materialCatalog = selectableFileRefs;
    let frozenAttachmentIds = uniqueCanonicalIds([
      ...frozenManualAttachmentIds,
      ...builtAssociatedFileRefIds
    ]);
    let frozenAttachmentOptions = frozenAttachmentIds.map((id) => (
      materialCatalog.find((candidate) => candidate.fileRefId === id)
    ));
    if (sendInFlightRef.current) {
      return { restoreDraft: true, safeErrorMessage: "当前消息正在发送，请稍候。" };
    }
    if (contextEditorDirty) {
      const message = t("aiUnsavedContextGateMessage");
      setError({ title: t("aiUnsavedContextGateTitle"), message });
      return { restoreDraft: true, safeErrorMessage: message };
    }
    if (
      !conversationId || conversationReadback?.conversation.id !== conversationId ||
      (!frozenProjectId && !frozenProjectlessNaturalChatAllowed) ||
      scopeSelection === AI_CHAT_OTHER_SCOPE_VALUE || !normalizedQuestion ||
      !canReachSendConfigurationBoundary
    ) {
      setError({ title: t("aiPreviewRequiredTitle"), message: t("aiPreviewRequiredMessage") });
      return { restoreDraft: true, safeErrorMessage: t("aiPreviewRequiredMessage") };
    }
    if (includeAssociatedDocuments) {
      materialCatalog = await refreshAttachmentOptions();
      const currentAssociated = await resolveAssociatedMaterialsForBuild(
        selectedResearchObjectDescriptors,
        materialCatalog,
        true
      );
      const currentAssociatedIds = currentAssociated.materials.map((item) => item.fileRefId);
      if (!canonicalIdsEqual(currentAssociatedIds, builtAssociatedFileRefIds)) {
        invalidatePreview();
        setError({
          title: "关联文档已变化",
          message: "当前文稿指向已变化，请重新确认并构建上下文后再发送。"
        });
        return { restoreDraft: true, safeErrorMessage: "关联文档已变化，请重新构建上下文。" };
      }
      frozenAttachmentIds = uniqueCanonicalIds([
        ...frozenManualAttachmentIds,
        ...currentAssociatedIds
      ]);
      frozenAttachmentOptions = frozenAttachmentIds.map((id) => (
        materialCatalog.find((candidate) => candidate.fileRefId === id)
      ));
    }
    sendInFlightRef.current = true;
    setIsBuilding(true);
    setError(null);
    setIsStopping(false);
    setActiveStreamReady(false);
    let generation: number | null = null;
    let providerPhaseStarted = false;
    let oneShotLocalAttachmentConsumed = false;
    try {
      // Send owns one fresh canonical snapshot. Missing Context uses the canonical MINIMAL builder path.
      const frozenContextPackage = await buildFrozenContext({
        frozenProjectId,
        frozenMode,
        frozenRouteIds,
        frozenTaskIds,
        frozenReviewIds,
        frozenExperimentIds,
        frozenExperimentRunIds,
        frozenLiteratureIds,
        frozenFindingIds,
        frozenResultItemIds,
        frozenOutputCandidateIds,
        frozenOutputGapIds,
        frozenResearchOutputIds,
        frozenAttachmentIds,
        maxChars: autoPullContextBudget.maxChars
      });
      const reviewedContextStillCurrent = Boolean(
        reviewedContextPackage?.reviewFingerprint &&
        reviewedContextPackage.reviewFingerprint === frozenContextPackage.reviewFingerprint
      );
      const freshDefaultOutboundBody = buildAIContextHumanReadablePreview({
        contextPackage: frozenContextPackage,
        language: "zh-CN"
      }).markdown;
      const outboundContextBody = reviewedContextStillCurrent
        ? contextMarkdown
        : freshDefaultOutboundBody;
      const frozenBuilt = await buildConversationPromptPackage({
        conversationId,
        contextPackage: frozenContextPackage,
        userQuestion: normalizedQuestion,
        constraintRequest: { kind: "current", category: "NORMAL_QA" },
        machineContextRequestMode: reviewedContextPackage ? "enabled" : "disabled",
        options: {
          technicalCapacityChars: AI_PROVIDER_PROMPT_TECHNICAL_MAX_CHARS,
          outputDetailPreference,
          contextMarkdownOverride: outboundContextBody
        }
      });
      if (selectedConversationIdRef.current !== conversationId) {
        return { restoreDraft: true, safeErrorMessage: "当前对话已切换，请重新确认。" };
      }
      if (!reviewedContextPackage) setContextMode("MINIMAL");
      setContextPackage(frozenContextPackage);
      setConversationReadback(frozenBuilt.readback);
      if (!reviewedContextStillCurrent) setDefaultContextMarkdown(freshDefaultOutboundBody);
      setIsContextModified(Boolean(reviewedContextStillCurrent && isContextModified));
      setContextEditorDirty(false);
      applyPromptPackage(frozenBuilt.promptPackage, conversationId);
      if (reviewedContextPackage && (
        !reviewedContextStillCurrent ||
        Boolean(reviewedPromptPackage && !constraintDescriptorsEqual(
          reviewedPromptPackage.constraintDescriptor,
          frozenBuilt.promptPackage.constraintDescriptor
        ))
      )) {
        const message = "上下文在审阅后发生变化，已刷新内容，请再次确认发送。";
        setError({ title: "上下文已刷新", message });
        return { restoreDraft: true, safeErrorMessage: message };
      }
      if (!reviewedContextPackage && frozenAttachmentIds.length > 0) {
        const message = "上下文与材料范围已准备完成，请审阅后再次确认发送。";
        setError({ title: "请先审阅材料", message });
        return { restoreDraft: true, safeErrorMessage: message };
      }
      if (
        frozenBuilt.promptPackage.warnings?.some((warning) => warning.severity === "error")
      ) {
        const message = "上下文未通过发送前检查，请根据页面提示调整后重试。";
        setError({ title: "暂时无法发送", message });
        return { restoreDraft: true, safeErrorMessage: message };
      }

      const outboundPromptPackage = frozenOneShotLocalAttachmentFile
        ? applyAIOneShotLocalAttachmentToPromptPackage(
            frozenBuilt.promptPackage,
            await readAIOneShotLocalAttachment(frozenOneShotLocalAttachmentFile)
          )
        : frozenBuilt.promptPackage;

      setIsBuilding(false);
      setIsSending(true);
      generation = streamGenerationRef.current + 1;
      streamGenerationRef.current = generation;
      const requestId = createDurableAIInvocationRequestId();
      setStreamPresentation(beginAIStreamingPresentation(generation, requestId));
      oneShotLocalAttachmentConsumed = Boolean(frozenOneShotLocalAttachmentFile);
      providerPhaseStarted = true;
      const invocation = await startDurableAIStreamingInvocation({
        conversationId,
        purpose: "chat_response",
        requestId,
        promptText: outboundPromptPackage.finalPrompt,
        promptEnvelope: outboundPromptPackage.providerPromptEnvelope,
        userMessageContent: frozenBuilt.promptPackage.userQuestion,
        authorizedFileRefIds: frozenAttachmentIds,
        validateAuthorizedFileRefSelection: () => {
          if (frozenAttachmentIds.length === 0) return;
          const invalidAttachment = frozenAttachmentOptions.find((candidate) => (
            !candidate || candidate.resourceKind !== "file" ||
            candidate.availabilityStatus !== "available" || candidate.materialReadStatus !== "supported" ||
            !Number.isSafeInteger(candidate.materialPromptReservationCharacters) ||
            (candidate.materialPromptReservationCharacters ?? 0) <= 0 ||
            !hasCanonicalMaterialFreshnessReceipt(candidate)
          ));
          if (invalidAttachment !== undefined || frozenAttachmentOptions.some((candidate) => !candidate)) {
            throw new AIAttachmentAuthorizationError(
              "AI_ATTACHMENT_ADVISORY_INVALID",
              `${invalidAttachment?.displayName ?? "所选材料"} 当前不可用；仅支持 .txt 或 .md 文本。`
            );
          }
          if (
            effectiveReadableSelectionLimit === null ||
            frozenAttachmentIds.length > effectiveReadableSelectionLimit
          ) {
            throw new AIAttachmentAuthorizationError(
              "AI_ATTACHMENT_ADVISORY_COUNT_EXCEEDED",
              effectiveReadableSelectionLimit === null
                ? "当前无法确认材料上限。"
                : `每次最多选择 ${effectiveReadableSelectionLimit} 份材料。`
            );
          }
        },
        onAuthorizationCommitted: (readback) => {
          if (
            readback.conversation.id === conversationId &&
            selectedConversationIdRef.current === conversationId
          ) {
            setSelectedAttachmentIds([]);
            setAttachmentSelectorOpen(false);
            setIncludeAssociatedDocuments(false);
            setAssociatedCurrentManuscripts([]);
            setBuiltAssociatedFileRefIds([]);
            setAssociatedDocumentSkipCount(0);
          }
        },
        onEvent: (event) => {
          if (streamGenerationRef.current === generation && selectedConversationIdRef.current === conversationId) {
            if (event.eventKind === "started") setActiveStreamReady(true);
            setStreamPresentation((current) => reduceAIStreamingPresentation(
              current,
              generation!,
              event,
              Boolean(outboundPromptPackage.providerPromptEnvelope.contextRequestResponseContract)
            ));
          }
        },
        trace: buildDurableAIInvocationTrace(
          reviewedContextPackage ?? frozenContextPackage,
          { id: frozenBuilt.promptPackage.id, createdAt: frozenBuilt.promptPackage.createdAt },
          {
            sourceRefs: outboundPromptPackage.sourceRefs,
            warnings: outboundPromptPackage.warnings,
            budgetSummary: outboundPromptPackage.budgetSummary
          }
        )
      });
      if (
        generation === null || streamGenerationRef.current !== generation || selectedConversationIdRef.current !== conversationId ||
        invocation.conversationId !== conversationId ||
        invocation.preparedReadback.conversation.id !== conversationId
      ) {
        void invocation.cancel().catch(() => undefined);
        return { restoreDraft: false };
      }
      activeSendRef.current = invocation;
      setConversationReadback(invocation.preparedReadback);
      const nextDurableResult = await invocation.completion;
      if (streamGenerationRef.current !== generation || selectedConversationIdRef.current !== conversationId) {
        return { restoreDraft: false };
      }
      if (nextDurableResult.conversation.id !== conversationId) {
        throw new Error("Durable settlement Conversation identity mismatch.");
      }
      setConversationReadback(nextDurableResult.readback);
      setParseDraftEligibilityNotice(undefined);
      setUserQuestion("");
      await refreshConversationSummaries();
      return { restoreDraft: false };
    } catch (unknownError) {
      if (generation !== null && streamGenerationRef.current !== generation) return { restoreDraft: false };
      if (generation !== null) {
        setStreamPresentation((current) => failAIStreamingPresentation(current, generation!));
      }
      const configurationPreGate = isAIProviderConfigurationPreGateError(unknownError);
      const attachmentPreGate = isAIAttachmentAuthorizationError(unknownError);
      if (isAIOneShotLocalAttachmentError(unknownError)) {
        clearOneShotLocalAttachment();
        setError({ title: "无法发送本次附件", message: unknownError.message });
        return { restoreDraft: true, safeErrorMessage: unknownError.message };
      }
      if (isMaterialSourceFreshnessFailure(unknownError)) {
        await requireMaterialReReview(conversationId, frozenManualAttachmentIds);
        return {
          restoreDraft: true,
          safeErrorMessage: "所选材料已变化，请重新构建并审阅上下文。"
        };
      }
      const preGate = !providerPhaseStarted || configurationPreGate || attachmentPreGate ||
        (isAIDurablePersistenceError(unknownError) && unknownError.phase === "pre_provider");
      if (configurationPreGate) {
        await refreshProviderConfiguration();
      }
      if (!preGate) {
        setUserQuestion("");
        await refreshSelectedReadback(conversationId);
        await refreshConversationSummaries().catch(() => undefined);
      }
      if (isAIDurablePersistenceError(unknownError)) {
        const displayError = projectAIErrorForDisplay(unknownError, language);
        setError(displayError);
        return { restoreDraft: preGate, safeErrorMessage: displayError.message };
      }
      if (attachmentPreGate) {
        setError({ title: "附件授权未通过", message: unknownError.message });
        return { restoreDraft: true, safeErrorMessage: unknownError.message };
      }
      if (!providerPhaseStarted) {
        const displayError = projectAIErrorForDisplay(unknownError, language);
        setError(displayError);
        return { restoreDraft: true, safeErrorMessage: displayError.message };
      }
      const displayError = projectAIErrorForDisplay(unknownError, language);
      if (displayError.code === "cancelled") {
        setError({ title: t("aiStoppedTitle"), message: t("aiStoppedMessage") });
      } else {
        setError(displayError);
      }
      return { restoreDraft: preGate, safeErrorMessage: displayError.message };
    } finally {
      setIsBuilding(false);
      if (generation === null || streamGenerationRef.current === generation) {
        activeSendRef.current = null;
        setActiveStreamReady(false);
        setIsStopping(false);
        setIsSending(false);
        setActiveActionIntent(null);
      }
      if (oneShotLocalAttachmentConsumed) clearOneShotLocalAttachment();
      sendInFlightRef.current = false;
    }
  }

  async function handleRetryRegenerate(actionIntent: AIChatRetryRegenerateActionIntent) {
    const conversationId = selectedConversationId;
    const sourceReadback = conversationReadback;
    const projection = sourceReadback?.retryRegenerate;
    const attachmentReauthorizationMessage =
      "该请求使用过本地材料。附件授权仅对原调用有效；请重新选择材料并重新发送。";
    if (sendInFlightRef.current) return;
    if (
      !conversationId || !sourceReadback || sourceReadback.conversation.id !== conversationId ||
      !projection?.latestTurnId
    ) {
      setError({ title: "无法重试或重新生成", message: "当前对话的最新一轮记录不可用。" });
      return;
    }
    if (projection.attachmentReauthorizationRequired) {
      setError({ title: "附件需要重新授权", message: attachmentReauthorizationMessage });
      return;
    }
    const expectedSourceAttemptId = actionIntent === "retry"
      ? projection.latestAttemptId
      : projection.effectiveSourceAttemptId;
    const expectedEffectiveMessageId = actionIntent === "regenerate"
      ? projection.effectiveAssistantMessageId
      : undefined;
    const eligible = actionIntent === "retry"
      ? projection.retryEligible
      : projection.regenerateEligible;
    const triggerMessage = sourceReadback.messages.find((message) => (
      message.id === projection.latestTurnId && message.role === "user"
    ));
    const sourceAttempt = sourceReadback.callAttempts.find((attempt) => (
      attempt.id === expectedSourceAttemptId
    ));
    const frozenSourceSelection = sourceAttempt
      ? readFrozenContextSelection(sourceAttempt)
      : null;
    if (!eligible || !expectedSourceAttemptId || !triggerMessage || (
      actionIntent === "regenerate" && !expectedEffectiveMessageId
    ) || !sourceAttempt || !frozenSourceSelection) {
      setError({
        title: actionIntent === "retry" ? "无法重试" : "无法重新生成",
        message: "原调用记录或其已冻结的上下文回执不可用。"
      });
      await refreshSelectedReadback(conversationId);
      return;
    }
    if (providerConfiguration?.eligibility !== "eligible") {
      setError({
        title: "需要配置 AI 服务",
        message: "请先完成 AI 服务配置，再执行此操作。"
      });
      return;
    }

    // One explicit action owns one proposed identity across prepare, transport and settlement.
    const requestId = createDurableAIInvocationRequestId();
    const generation = streamGenerationRef.current + 1;
    sendInFlightRef.current = true;
    streamGenerationRef.current = generation;
    setIsSending(true);
    setIsStopping(false);
    setActiveStreamReady(false);
    setActiveActionIntent(actionIntent);
    setError(null);
    setStreamPresentation(beginAIStreamingPresentation(generation, requestId));
    try {
      const sourceAutoPullBudgetChars = sourceAttempt.budgetSummary?.maxChars ??
        autoPullContextBudget.maxChars;
      const sourceOutputDetailPreference =
        sourceAttempt.budgetSummary?.outputDetailPreference ?? "STANDARD";
      const nextContextPackage = await buildFrozenContext({
        frozenProjectId: frozenSourceSelection.projectId,
        frozenMode: frozenSourceSelection.contextMode,
        frozenRouteIds: frozenSourceSelection.researchObjects
          .filter((item) => item.objectType === "route")
          .map((item) => item.objectId),
        frozenTaskIds: frozenSourceSelection.researchObjects
          .filter((item) => item.objectType === "task")
          .map((item) => item.objectId),
        frozenReviewIds: frozenSourceSelection.researchObjects
          .filter((item) => item.objectType === "review")
          .map((item) => item.objectId),
        frozenExperimentIds: frozenSourceSelection.researchObjects
          .filter((item) => item.objectType === "experiment")
          .map((item) => item.objectId),
        frozenExperimentRunIds: frozenSourceSelection.researchObjects
          .filter((item) => item.objectType === "experimentRun")
          .map((item) => item.objectId),
        frozenLiteratureIds: frozenSourceSelection.researchObjects
          .filter((item) => item.objectType === "literature")
          .map((item) => item.objectId),
        frozenFindingIds: frozenSourceSelection.researchObjects
          .filter((item) => item.objectType === "finding")
          .map((item) => item.objectId),
        frozenResultItemIds: frozenSourceSelection.researchObjects
          .filter((item) => item.objectType === "resultItem")
          .map((item) => item.objectId),
        frozenOutputCandidateIds: frozenSourceSelection.researchObjects
          .filter((item) => item.objectType === "outputCandidate")
          .map((item) => item.objectId),
        frozenOutputGapIds: frozenSourceSelection.researchObjects
          .filter((item) => item.objectType === "outputGap")
          .map((item) => item.objectId),
        frozenResearchOutputIds: frozenSourceSelection.researchObjects
          .filter((item) => item.objectType === "researchOutput")
          .map((item) => item.objectId),
        frozenAttachmentIds: [],
        maxChars: sourceAutoPullBudgetChars
      });
      const built = await buildConversationPromptPackage({
        conversationId,
        contextPackage: nextContextPackage,
        userQuestion: triggerMessage.content,
        historyBeforeMessageId: triggerMessage.id,
        constraintRequest: resolveRetryConstraintRequest(sourceAttempt),
        options: {
          technicalCapacityChars: AI_PROVIDER_PROMPT_TECHNICAL_MAX_CHARS,
          outputDetailPreference: sourceOutputDetailPreference
        }
      });
      if (
        streamGenerationRef.current !== generation ||
        selectedConversationIdRef.current !== conversationId
      ) return;
      setScopeSelection(frozenSourceSelection.projectId);
      setProjectId(frozenSourceSelection.projectId);
      setContextMode(frozenSourceSelection.contextMode);
      setOutputDetailPreference(sourceOutputDetailPreference);
      setSelectedRouteIds(frozenSourceSelection.researchObjects
        .filter((item) => item.objectType === "route")
        .map((item) => item.objectId));
      setSelectedTaskIds(frozenSourceSelection.researchObjects
        .filter((item) => item.objectType === "task")
        .map((item) => item.objectId));
      setSelectedReviewIds(frozenSourceSelection.researchObjects
        .filter((item) => item.objectType === "review")
        .map((item) => item.objectId));
      setSelectedExperimentIds(frozenSourceSelection.researchObjects
        .filter((item) => item.objectType === "experiment")
        .map((item) => item.objectId));
      setSelectedExperimentRunIds(frozenSourceSelection.researchObjects
        .filter((item) => item.objectType === "experimentRun")
        .map((item) => item.objectId));
      setSelectedLiteratureIds(frozenSourceSelection.researchObjects
        .filter((item) => item.objectType === "literature")
        .map((item) => item.objectId));
      setSelectedFindingIds(frozenSourceSelection.researchObjects
        .filter((item) => item.objectType === "finding")
        .map((item) => item.objectId));
      setSelectedResultItemIds(frozenSourceSelection.researchObjects
        .filter((item) => item.objectType === "resultItem")
        .map((item) => item.objectId));
      setSelectedOutputCandidateIds(frozenSourceSelection.researchObjects
        .filter((item) => item.objectType === "outputCandidate")
        .map((item) => item.objectId));
      setSelectedOutputGapIds(frozenSourceSelection.researchObjects
        .filter((item) => item.objectType === "outputGap")
        .map((item) => item.objectId));
      setSelectedResearchOutputIds(frozenSourceSelection.researchObjects
        .filter((item) => item.objectType === "researchOutput")
        .map((item) => item.objectId));
      setContextPackage(nextContextPackage);
      setConversationReadback(built.readback);
      setIsContextModified(false);
      applyPromptPackage(built.promptPackage, conversationId);
      if (
        built.promptPackage.warnings?.some((warning) => warning.severity === "error")
      ) {
        setStreamPresentation((current) => failAIStreamingPresentation(current, generation));
        return;
      }

      const invocation = await startDurableAIStreamingInvocation({
        conversationId,
        purpose: "chat_response",
        requestId,
        actionIntent,
        promptText: built.promptPackage.finalPrompt,
        promptEnvelope: built.promptPackage.providerPromptEnvelope,
        userMessageContent: triggerMessage.content,
        triggerMessageId: triggerMessage.id,
        expectedSourceAttemptId,
        expectedEffectiveMessageId,
        onEvent: (event) => {
          if (
            streamGenerationRef.current === generation &&
            selectedConversationIdRef.current === conversationId
          ) {
            if (event.eventKind === "started") setActiveStreamReady(true);
            setStreamPresentation((current) => (
              reduceAIStreamingPresentation(
                current,
                generation,
                event,
                Boolean(built.promptPackage.providerPromptEnvelope.contextRequestResponseContract)
              )
            ));
          }
        },
        trace: buildDurableAIInvocationTrace(
          nextContextPackage,
          { id: built.promptPackage.id, createdAt: built.promptPackage.createdAt },
          {
            sourceRefs: built.promptPackage.sourceRefs,
            warnings: built.promptPackage.warnings,
            budgetSummary: built.promptPackage.budgetSummary
          }
        )
      });
      if (
        streamGenerationRef.current !== generation ||
        selectedConversationIdRef.current !== conversationId ||
        invocation.conversationId !== conversationId ||
        invocation.triggerMessageId !== triggerMessage.id
      ) {
        void invocation.cancel().catch(() => undefined);
        return;
      }
      activeSendRef.current = invocation;
      setConversationReadback(invocation.preparedReadback);
      const settled = await invocation.completion;
      if (
        streamGenerationRef.current !== generation ||
        selectedConversationIdRef.current !== conversationId
      ) return;
      if (
        settled.conversation.id !== conversationId ||
        settled.triggerMessage.id !== triggerMessage.id
      ) {
        throw new Error("Retry/Regenerate durable settlement identity mismatch.");
      }
      setConversationReadback(settled.readback);
      setParseDraftEligibilityNotice(undefined);
      setError(null);
      await refreshConversationSummaries();
    } catch (unknownError) {
      if (streamGenerationRef.current !== generation) return;
      setStreamPresentation((current) => failAIStreamingPresentation(current, generation));
      const prepareError = isAIRetryRegeneratePrepareError(unknownError)
        ? unknownError
        : null;
      if (
        prepareError?.authoritativeReadback?.conversation.id === conversationId &&
        selectedConversationIdRef.current === conversationId
      ) {
        setConversationReadback(prepareError.authoritativeReadback);
      } else {
        await refreshSelectedReadback(conversationId);
      }
      if (isAIProviderConfigurationPreGateError(unknownError)) {
        await refreshProviderConfiguration();
      }
      if (prepareError?.code === "retry_regenerate_attachment_reauthorization_required") {
        setError({ title: "附件需要重新授权", message: attachmentReauthorizationMessage });
      } else if (prepareError) {
        setError(projectAIErrorForDisplay(prepareError, language));
      } else if (isAIDurablePersistenceError(unknownError)) {
        setError(projectAIErrorForDisplay(unknownError, language));
      } else {
        const displayError = projectAIErrorForDisplay(unknownError, language);
        setError(displayError.code === "cancelled"
          ? { title: t("aiStoppedTitle"), message: t("aiStoppedMessage") }
          : displayError);
      }
      await refreshConversationSummaries().catch(() => undefined);
    } finally {
      if (streamGenerationRef.current === generation) {
        activeSendRef.current = null;
        setActiveStreamReady(false);
        setIsStopping(false);
        setIsSending(false);
      }
      setActiveActionIntent((current) => current === actionIntent ? null : current);
      sendInFlightRef.current = false;
    }
  }

  async function buildFreshParseDraftContext(
    retryContextSelection?: AIFrozenContextSelection,
    attachedContextCustody?: AILatestAssistantAttachedContextCustody
  ): Promise<AIContextPackage> {
    const currentSelection: AIFrozenContextSelection = {
      projectId: projectId.trim(),
      contextMode,
      researchObjects: [
        ...selectedRouteIds.map((objectId) => ({ objectType: "route" as const, objectId })),
        ...selectedTaskIds.map((objectId) => ({ objectType: "task" as const, objectId })),
        ...selectedReviewIds.map((objectId) => ({ objectType: "review" as const, objectId })),
        ...selectedExperimentIds.map((objectId) => ({ objectType: "experiment" as const, objectId })),
        ...selectedExperimentRunIds.map((objectId) => ({ objectType: "experimentRun" as const, objectId })),
        ...selectedLiteratureIds.map((objectId) => ({ objectType: "literature" as const, objectId })),
        ...selectedFindingIds.map((objectId) => ({ objectType: "finding" as const, objectId })),
        ...selectedResultItemIds.map((objectId) => ({ objectType: "resultItem" as const, objectId })),
        ...selectedOutputCandidateIds.map((objectId) => ({ objectType: "outputCandidate" as const, objectId })),
        ...selectedOutputGapIds.map((objectId) => ({ objectType: "outputGap" as const, objectId })),
        ...selectedResearchOutputIds.map((objectId) => ({ objectType: "researchOutput" as const, objectId }))
      ]
    };
    const selectionKeys = (selection: AIFrozenContextSelection) => [...new Set(
      selection.researchObjects.map((candidate) => `${candidate.objectType}:${candidate.objectId}`)
    )].sort((left, right) => left.localeCompare(right));
    const selectionMatches = (left: AIFrozenContextSelection, right: AIFrozenContextSelection) => {
      const leftKeys = selectionKeys(left);
      const rightKeys = selectionKeys(right);
      return left.projectId === right.projectId && left.contextMode === right.contextMode &&
        leftKeys.length === left.researchObjects.length &&
        rightKeys.length === right.researchObjects.length &&
        leftKeys.length === rightKeys.length &&
        leftKeys.every((key, index) => key === rightKeys[index]);
    };
    const restartProjectionIsEmpty = Boolean(attachedContextCustody) &&
      currentSelection.projectId === attachedContextCustody?.selection.projectId &&
      currentSelection.researchObjects.length === 0;
    const effectiveAttachedCustody = !retryContextSelection && attachedContextCustody && (
      selectionMatches(currentSelection, attachedContextCustody.baseSelection) ||
      selectionMatches(currentSelection, attachedContextCustody.selection) ||
      restartProjectionIsEmpty
    ) ? attachedContextCustody : undefined;
    const effectiveContextSelection = retryContextSelection ??
      effectiveAttachedCustody?.selection ?? currentSelection;
    const retryObjectIds = (objectType: AIResearchObjectType) => (
      effectiveContextSelection.researchObjects
        .filter((candidate) => candidate.objectType === objectType)
        .map((candidate) => candidate.objectId)
    );
    const frozenProjectId = effectiveContextSelection.projectId;
    const frozenRouteIds = retryObjectIds("route");
    const frozenTaskIds = retryObjectIds("task");
    const frozenReviewIds = retryObjectIds("review");
    const frozenExperimentIds = retryObjectIds("experiment");
    const frozenExperimentRunIds = retryObjectIds("experimentRun");
    const frozenLiteratureIds = retryObjectIds("literature");
    const frozenFindingIds = retryObjectIds("finding");
    const frozenResultItemIds = retryObjectIds("resultItem");
    const frozenOutputCandidateIds = retryObjectIds("outputCandidate");
    const frozenOutputGapIds = retryObjectIds("outputGap");
    const frozenResearchOutputIds = retryObjectIds("researchOutput");
    const retryObjectIdentities = new Set(
      effectiveContextSelection.researchObjects.map((candidate) => (
        `${candidate.objectType}:${candidate.objectId}`
      ))
    );
    const frozenResearchObjectDescriptors = retryContextSelection || effectiveAttachedCustody
      ? researchObjectOptions.filter((candidate) => retryObjectIdentities.has(
          `${candidate.objectType}:${candidate.objectId}`
        ))
      : selectedResearchObjectDescriptors;
    const reviewCatalog = await refreshAttachmentOptions();
    const associatedProjection = await resolveAssociatedMaterialsForBuild(
      frozenResearchObjectDescriptors,
      reviewCatalog,
      includeAssociatedDocuments
    );
    const associatedFileRefIds = associatedProjection.materials.map((item) => item.fileRefId);
    const frozenAttachmentIds = uniqueCanonicalIds([
      ...selectedAttachmentIds,
      ...associatedFileRefIds
    ]);
    if (
      !frozenProjectId ||
      (!retryContextSelection && scopeSelection === AI_CHAT_OTHER_SCOPE_VALUE)
    ) {
      throw new Error("请先选择当前课题，再解析草稿。");
    }
    if (
      effectiveReadableSelectionLimit !== null &&
      frozenAttachmentIds.length > effectiveReadableSelectionLimit
    ) {
      throw new Error("手动附件与关联文档超过本次材料上限。");
    }
    setAssociatedCurrentManuscripts(associatedProjection.materials);
    setBuiltAssociatedFileRefIds(associatedFileRefIds);
    setAssociatedDocumentSkipCount(associatedProjection.issues.length);
    return buildFrozenContext({
      frozenProjectId,
      frozenMode: effectiveContextSelection.contextMode,
      frozenRouteIds,
      frozenTaskIds,
      frozenReviewIds,
      frozenExperimentIds,
      frozenExperimentRunIds,
      frozenLiteratureIds,
      frozenFindingIds,
      frozenResultItemIds,
      frozenOutputCandidateIds,
      frozenOutputGapIds,
      frozenResearchOutputIds,
      frozenAttachmentIds,
      approvedContextRequestContributions:
        effectiveAttachedCustody?.approvedContextRequestContributions,
      maxChars: autoPullContextBudget.maxChars
    });
  }

  async function buildFreshParseDraftReview(conversationId: string): Promise<AIParseDraftPreparedReview> {
    const readback = await aiConversationApplicationService.readConversation(conversationId);
    const retryRange = deriveAIParseDraftRetryRange(readback);
    const durableAttachedContextCustody =
      readLatestAssistantMessageAttachedContextCustody(readback) ?? undefined;
    const currentParseEnd = readback.projectedMessages
      .filter((message) => message.messageKind === "text" && message.content.trim())
      .reduce((maximum, message) => Math.max(maximum, message.sequence), 0);
    let retryContextSelection: AIFrozenContextSelection | undefined;
    let supersededEmptyAttachedContextAttemptId: string | undefined;
    if (retryRange && currentParseEnd === retryRange.lastSequence) {
      const sourceAttempt = readback.callAttempts.find((attempt) => attempt.id === retryRange.attemptId);
      const frozenRetrySelection = sourceAttempt
        ? readFrozenContextSelection(sourceAttempt) ?? undefined
        : undefined;
      if (!frozenRetrySelection) {
        throw new Error("上次解析的冻结上下文回执不可用，无法安全重试。");
      }
      const exactAttachedRunSourceWasOmitted =
        durableAttachedContextCustody !== undefined &&
        sourceAttempt?.purpose === "parse_draft" && sourceAttempt.status === "failed" &&
        sourceAttempt.errorMessage?.includes("EXPERIMENT_RUN_SOURCE_SCOPE_REQUIRED") &&
        sourceAttempt.triggerCallAttemptId === durableAttachedContextCustody.sourceCallAttemptId &&
        frozenRetrySelection.projectId === durableAttachedContextCustody.selection.projectId &&
        frozenRetrySelection.researchObjects.length === 0 &&
        durableAttachedContextCustody.approvedContextRequestContributions.some((contribution) =>
          durableAttachedContextCustody.selection.researchObjects.some((selection) =>
            selection.objectType === "experimentRun" && selection.objectId === contribution.refId
          )
        );
      if (exactAttachedRunSourceWasOmitted) {
        supersededEmptyAttachedContextAttemptId = sourceAttempt.id;
      } else {
        retryContextSelection = frozenRetrySelection;
      }
    }
    const attachedContextCustody = retryContextSelection
      ? undefined
      : durableAttachedContextCustody;
    const frozenManualAttachmentIds = [...selectedAttachmentIds];
    const frozenContextPackage = await buildFreshParseDraftContext(
      retryContextSelection,
      attachedContextCustody
    );
    const parsePreparationReadback = supersededEmptyAttachedContextAttemptId
      ? {
          ...readback,
          callAttempts: readback.callAttempts.filter((attempt) =>
            attempt.id !== supersededEmptyAttachedContextAttemptId
          )
        }
      : readback;
    const built = await buildAIParseDraftPromptPackage({
      conversationId,
      contextPackage: frozenContextPackage,
      technicalCapacityChars: AI_PROVIDER_PROMPT_TECHNICAL_MAX_CHARS,
      readback: parsePreparationReadback,
      outputDetailPreference
    });
    return {
      contextPackage: frozenContextPackage,
      promptPackage: built.promptPackage,
      source: built.source,
      retryContextSelection,
      attachedContextCustody,
      frozenManualAttachmentIds
    };
  }

  async function handlePrepareParseDraft() {
    const conversationId = selectedConversationId;
    if (contextEditorDirty) {
      setError({
        title: t("aiUnsavedContextGateTitle"),
        message: t("aiUnsavedContextGateMessage")
      });
      return;
    }
    if (!conversationId || isBusy || sendInFlightRef.current) return;
    setIsPreparingParseDraft(true);
    setError(null);
    setParseDraftTerminal(undefined);
    try {
      const review = await buildFreshParseDraftReview(conversationId);
      if (selectedConversationIdRef.current !== conversationId) return;
      if (review.retryContextSelection) {
        const retrySelection = review.retryContextSelection;
        const ids = (objectType: AIResearchObjectType) => retrySelection.researchObjects
          .filter((candidate) => candidate.objectType === objectType)
          .map((candidate) => candidate.objectId);
        setScopeSelection(retrySelection.projectId);
        setProjectId(retrySelection.projectId);
        setContextMode(retrySelection.contextMode);
        setSelectedRouteIds(ids("route"));
        setSelectedTaskIds(ids("task"));
        setSelectedReviewIds(ids("review"));
        setSelectedExperimentIds(ids("experiment"));
        setSelectedExperimentRunIds(ids("experimentRun"));
        setSelectedLiteratureIds(ids("literature"));
        setSelectedFindingIds(ids("finding"));
        setSelectedResultItemIds(ids("resultItem"));
        setSelectedOutputCandidateIds(ids("outputCandidate"));
        setSelectedOutputGapIds(ids("outputGap"));
        setSelectedResearchOutputIds(ids("researchOutput"));
      }
      setParseDraftEligibilityNotice(undefined);
      setConversationReadback(await aiConversationApplicationService.readConversation(conversationId));
      await handleContinueParseDraft(review);
    } catch (unknownError) {
      const message = unknownError instanceof Error ? unknownError.message : "暂时无法准备解析范围。";
      if (isAIParseDraftBoundaryNoNewContentError(unknownError)) {
        setParseDraftEligibilityNotice(undefined);
        setParseDraftTerminal({ kind: "no-new-content", message: unknownError.message });
      } else if (isAIParseDraftEligibilityError(unknownError)) {
        setParseDraftEligibilityNotice(undefined);
        setParseDraftTerminal({ kind: "failed", message });
      } else {
        setParseDraftEligibilityNotice(undefined);
        setParseDraftTerminal({ kind: "failed", message });
      }
      setError(null);
    } finally {
      if (!sendInFlightRef.current) setIsPreparingParseDraft(false);
    }
  }

  async function handleContinueParseDraft(reviewed: AIParseDraftPreparedReview) {
    const conversationId = selectedConversationId;
    if (contextEditorDirty) {
      setError({
        title: t("aiUnsavedContextGateTitle"),
        message: t("aiUnsavedContextGateMessage")
      });
      return;
    }
    if (!conversationId || isSending || sendInFlightRef.current) return;
    const frozenManualAttachmentIds = [...reviewed.frozenManualAttachmentIds];
    const frozenAttachmentIds = [...reviewed.source.authorizedMaterialFileRefIds];
    setIsPreparingParseDraft(true);
    setError(null);
    setParseDraftTerminal(undefined);
    let generation: number | null = null;
    let providerPhaseStarted = false;
    let requestId: string | undefined;
    try {
      const currentMaterialCatalog = await refreshAttachmentOptions();
      const frozenAttachmentOptions = frozenAttachmentIds.map((id) => (
        currentMaterialCatalog.find((candidate) => candidate.fileRefId === id)
      ));
      const currentContextPackage = await buildFreshParseDraftContext(
        reviewed.retryContextSelection,
        reviewed.attachedContextCustody
      );
      if (selectedConversationIdRef.current !== conversationId) return;
      if (
        currentContextPackage.reviewFingerprint !== reviewed.contextPackage.reviewFingerprint ||
        reviewed.source.contextReviewFingerprint !== reviewed.contextPackage.reviewFingerprint
      ) {
        throw new Error("上下文已变化，请重新点击解析草稿。");
      }
      const currentReadback = await aiConversationApplicationService.readConversation(conversationId);
      assertAIParseDraftSourceSnapshotStillCurrentAndEligible(
        currentReadback,
        reviewed.source
      );
      const blockingWarning = reviewed.promptPackage.warnings?.find(
        (warning) => warning.severity === "error"
      );
      if (blockingWarning) {
        throw new Error(
          blockingWarning.code === "technical_capacity_or_safety_error"
            ? "解析请求的软件动态上下文超过 45,000 字符预算，尚未调用模型；请缩小自动携带的 Context、会话历史或动态对象索引后重试。"
            : `解析请求未通过发送前机械安全检查，尚未调用模型：${blockingWarning.message}`
        );
      }
      setIsPreparingParseDraft(false);
      setIsSending(true);
      setActiveInvocationPurpose("parse_draft");
      sendInFlightRef.current = true;
      generation = streamGenerationRef.current + 1;
      streamGenerationRef.current = generation;
      requestId = createDurableAIInvocationRequestId();
      setStreamPresentation(beginAIStreamingPresentation(generation, requestId));
      const invocation = await startDurableAIStreamingInvocation({
        conversationId,
        purpose: "parse_draft",
        requestId,
        triggerMessageId: reviewed.source.triggerMessageId,
        triggerCallAttemptId: reviewed.source.triggerCallAttemptId,
        promptText: reviewed.promptPackage.finalPrompt,
        promptEnvelope: reviewed.promptPackage.providerPromptEnvelope,
        authorizedFileRefIds: frozenAttachmentIds,
        validateAuthorizedFileRefSelection: () => {
          const invalid = frozenAttachmentOptions.find((candidate) => (
            !candidate || candidate.resourceKind !== "file" ||
            candidate.availabilityStatus !== "available" || candidate.materialReadStatus !== "supported" ||
            !Number.isSafeInteger(candidate.materialPromptReservationCharacters) ||
            (candidate.materialPromptReservationCharacters ?? 0) <= 0 ||
            !hasCanonicalMaterialFreshnessReceipt(candidate)
          ));
          if (invalid !== undefined || frozenAttachmentOptions.some((candidate) => !candidate)) {
            throw new AIAttachmentAuthorizationError(
              "AI_ATTACHMENT_ADVISORY_INVALID",
              `${invalid?.displayName ?? "所选材料"} 当前不可用。`
            );
          }
          if (effectiveReadableSelectionLimit === null || frozenAttachmentIds.length > effectiveReadableSelectionLimit) {
            throw new AIAttachmentAuthorizationError(
              "AI_ATTACHMENT_ADVISORY_COUNT_EXCEEDED",
              "解析草稿所选材料超过本次上限。"
            );
          }
        },
        onAuthorizationCommitted: (readback) => {
          if (selectedConversationIdRef.current === conversationId) {
            setSelectedAttachmentIds([]);
            setAttachmentSelectorOpen(false);
            setIncludeAssociatedDocuments(false);
            setAssociatedCurrentManuscripts([]);
            setBuiltAssociatedFileRefIds([]);
            setAssociatedDocumentSkipCount(0);
            setConversationReadback(readback);
          }
        },
        onParseMechanicalRetryPrepared: (callAttemptId) => {
          if (
            generation !== null &&
            streamGenerationRef.current === generation &&
            selectedConversationIdRef.current === conversationId
          ) {
            requestId = callAttemptId;
            setActiveStreamReady(false);
            setStreamPresentation(beginAIStreamingPresentation(generation, callAttemptId));
          }
        },
        onParseSupplementalContextContinuationPrepared: (callAttemptId) => {
          if (
            generation !== null &&
            streamGenerationRef.current === generation &&
            selectedConversationIdRef.current === conversationId
          ) {
            requestId = callAttemptId;
            setActiveStreamReady(false);
            setStreamPresentation(beginAIStreamingPresentation(generation, callAttemptId));
          }
        },
        onEvent: (event) => {
          if (generation !== null && streamGenerationRef.current === generation) {
            if (event.eventKind === "started") setActiveStreamReady(true);
            setStreamPresentation((current) => reduceAIStreamingPresentation(
              current,
              generation!,
              event,
              true
            ));
          }
        },
        trace: buildDurableAIInvocationTrace(
          reviewed.contextPackage,
          { id: reviewed.promptPackage.id, createdAt: reviewed.promptPackage.createdAt },
          {
            sourceRefs: reviewed.promptPackage.sourceRefs,
            warnings: reviewed.promptPackage.warnings,
            budgetSummary: reviewed.promptPackage.budgetSummary,
            parseDraftSource: reviewed.source
          }
        )
      });
      providerPhaseStarted = true;
      if (
        generation === null || streamGenerationRef.current !== generation ||
        selectedConversationIdRef.current !== conversationId
      ) {
        void invocation.cancel().catch(() => undefined);
        return;
      }
      activeSendRef.current = invocation;
      setConversationReadback(invocation.preparedReadback);
      const settled = await invocation.completion;
      if (streamGenerationRef.current !== generation || selectedConversationIdRef.current !== conversationId) return;
      setConversationReadback(settled.readback);
      setStreamPresentation(INITIAL_AI_STREAMING_PRESENTATION_STATE);
      const currentResults = settled.readback.standardResults.filter(
        (result) => result.parseCallAttemptId === settled.callAttempt.id
      );
      setParseDraftTerminal(currentResults.length > 0
        ? { kind: "succeeded", callAttemptId: settled.callAttempt.id, resultCount: currentResults.length }
        : {
            kind: "empty",
            callAttemptId: settled.callAttempt.id,
            message: "解析调用已完成，但当前讨论没有形成可精确映射的有效操作建议。"
          });
      setActiveWorkspace("operations");
      await refreshConversationSummaries();
    } catch (unknownError) {
      if (generation !== null) {
        setStreamPresentation((current) => failAIStreamingPresentation(current, generation!));
      }
      if (providerPhaseStarted) await refreshSelectedReadback(conversationId);
      if (isAIProviderConfigurationPreGateError(unknownError)) await refreshProviderConfiguration();
      if (isMaterialSourceFreshnessFailure(unknownError)) {
        setParseDraftTerminal({
          kind: "failed",
          ...(requestId ? { callAttemptId: `ai-call-attempt-${requestId}` } : {}),
          message: "所选材料已变化，需要重新审阅材料后再解析。"
        });
        await requireMaterialReReview(conversationId, frozenManualAttachmentIds);
        return;
      }
      if (
        isAIParseDraftEligibilityError(unknownError) ||
        isAIParseDraftSourceSnapshotError(unknownError)
      ) {
        if (isAIParseDraftEligibilityError(unknownError)) {
          setParseDraftEligibilityNotice(undefined);
        } else {
          setParseDraftEligibilityNotice(undefined);
        }
        setParseDraftTerminal({
          kind: "failed",
          ...(requestId ? { callAttemptId: `ai-call-attempt-${requestId}` } : {}),
          message: unknownError.message
        });
        setError(null);
        return;
      }
      setParseDraftTerminal({
        kind: "failed",
        ...(requestId ? { callAttemptId: `ai-call-attempt-${requestId}` } : {}),
        message: projectAIErrorForDisplay(unknownError, language).message
      });
      setError(null);
    } finally {
      if (generation === null || streamGenerationRef.current === generation) {
        activeSendRef.current = null;
        setActiveStreamReady(false);
        setIsSending(false);
        setIsStopping(false);
        setActiveInvocationPurpose(undefined);
      }
      setIsPreparingParseDraft(false);
      sendInFlightRef.current = false;
    }
  }

  async function runStandardResultWorkspaceMutation<T>(
    resultId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    if (standardResultMutationRef.current) {
      throw new Error("另一条操作建议正在处理，请等待当前操作完成。");
    }
    const token = standardResultMutationSequenceRef.current + 1;
    standardResultMutationSequenceRef.current = token;
    const mutation = createAIStandardResultWorkspaceMutation(resultId, token);
    standardResultMutationRef.current = mutation;
    setActiveStandardResultMutation(mutation);
    try {
      return await operation();
    } finally {
      standardResultMutationRef.current = releaseAIStandardResultWorkspaceMutation(
        standardResultMutationRef.current,
        token
      );
      setActiveStandardResultMutation((current) => (
        releaseAIStandardResultWorkspaceMutation(current, token)
      ));
    }
  }

  async function handleSaveStandardResult(
    result: AIStandardResult,
    payload: Record<string, unknown>,
    fallbackSections: readonly string[]
  ): Promise<AIStandardResult> {
    return runStandardResultWorkspaceMutation(result.id, async () => {
      const readback = await aiStandardResultApplicationService.updateVisiblePayload({
        conversationId: result.conversationId,
        resultId: result.id,
        expectedVisiblePayloadFingerprint: result.visiblePayloadFingerprint,
        visiblePayload: payload,
        fallbackSections
      });
      if (selectedConversationIdRef.current === result.conversationId) setConversationReadback(readback);
      const updated = readback.standardResults.find((candidate) => candidate.id === result.id);
      if (!updated) throw new Error("保存后无法读取当前操作建议。");
      return updated;
    });
  }

  async function handleConfirmStandardResult(result: AIStandardResult) {
    return runStandardResultWorkspaceMutation(result.id, async () => {
      const readback = await aiStandardResultApplicationService.confirm({
        conversationId: result.conversationId,
        resultId: result.id,
        expectedVisiblePayloadFingerprint: result.visiblePayloadFingerprint
      });
      if (selectedConversationIdRef.current === result.conversationId) setConversationReadback(readback);
      await refreshConversationSummaries().catch(() => undefined);
    });
  }

  async function handleContinueStandardResult(result: AIStandardResult) {
    return runStandardResultWorkspaceMutation(result.id, async () => {
      const readback = await aiStandardResultApplicationService.continue({
        conversationId: result.conversationId,
        resultId: result.id
      });
      if (selectedConversationIdRef.current === result.conversationId) setConversationReadback(readback);
      await refreshConversationSummaries().catch(() => undefined);
    });
  }

  async function handleDismissStandardResult(result: AIStandardResult) {
    return runStandardResultWorkspaceMutation(result.id, async () => {
      const readback = await aiStandardResultApplicationService.dismiss({
        conversationId: result.conversationId,
        resultId: result.id,
        expectedVisiblePayloadFingerprint: result.visiblePayloadFingerprint
      });
      if (selectedConversationIdRef.current === result.conversationId) setConversationReadback(readback);
      await refreshConversationSummaries().catch(() => undefined);
    });
  }

  async function markContextRequestStaleAfterValidation(
    request: AIContextRequest,
    reason: string
  ) {
    try {
      const readback = await markAIContextRequestStale(
        request.conversationId,
        request.id,
        reason
      );
      if (selectedConversationIdRef.current === request.conversationId) {
        setConversationReadback(readback);
      }
    } catch {
      await refreshSelectedReadback(request.conversationId);
    }
    setContextRequestApprovalReview((current) => (
      current?.review.contextRequestId === request.id ? null : current
    ));
  }

  async function handleApproveContextRequest(request: AIContextRequest) {
    const conversationId = selectedConversationId;
    const sourceReadback = conversationReadback;
    if (
      contextRequestDecisionInFlightRef.current || sendInFlightRef.current ||
      !conversationId || !sourceReadback || sourceReadback.conversation.id !== conversationId ||
      request.conversationId !== conversationId || request.state !== "PENDING"
    ) return;
    contextRequestDecisionInFlightRef.current = true;
    setReviewingContextRequestId(request.id);
    setIsBuilding(true);
    setError(null);
    let generation: number | null = null;
    let providerPhaseStarted = false;
    const explicitlyAuthorizedFileRefIds = [...selectedAttachmentIds];
    try {
      const freshReview = await buildAIContextRequestApprovalReview({
        request,
        readback: sourceReadback,
        explicitlyAuthorizedFileRefIds
      });
      if (selectedConversationIdRef.current !== conversationId) return;
      const prior = contextRequestApprovalReview?.review.contextRequestId === request.id
        ? contextRequestApprovalReview
        : null;
      if (!prior) {
        setContextRequestApprovalReview({
          review: freshReview,
          followupRequestId: createDurableAIInvocationRequestId()
        });
        setError({
          title: "补充上下文已可审阅",
          message: "请先审阅上方刚构建的上下文，再在同一请求卡片中选择“同意并继续”。"
        });
        return;
      }
      if (!approvalReviewsEqual(prior.review, freshReview)) {
        throw new AIContextRequestApprovalValidationError(
          "CONTEXT_REQUEST_SOURCE_STALE",
          "审阅后的上下文已发生变化。本请求已标记失效，且没有发起 AI 调用。"
        );
      }
      if (
        freshReview.promptPackage.warnings?.some((warning) => warning.severity === "error")
      ) {
        throw new AIContextRequestApprovalValidationError(
          "CONTEXT_REQUEST_CANONICAL_BUILD_FAILED",
          "刚构建的上下文正文未通过发送前容量检查。"
        );
      }

      setIsBuilding(false);
      setIsSending(true);
      setActiveInvocationPurpose(freshReview.followupPurpose);
      sendInFlightRef.current = true;
      generation = streamGenerationRef.current + 1;
      streamGenerationRef.current = generation;
      setStreamPresentation(beginAIStreamingPresentation(generation, prior.followupRequestId));
      providerPhaseStarted = true;
      const invocation = await startDurableAIStreamingInvocation({
        conversationId,
        purpose: freshReview.followupPurpose,
        requestId: prior.followupRequestId,
        actionIntent: "approve_context_request",
        contextRequestId: request.id,
        expectedReviewedCandidates: freshReview.reviewedCandidates,
        approvedRefs: freshReview.reviewedCandidates,
        promptText: freshReview.promptPackage.finalPrompt,
        promptEnvelope: freshReview.promptPackage.providerPromptEnvelope,
        userMessageContent: freshReview.followupPurpose === "parse_draft"
          ? PARSE_DRAFT_USER_INSTRUCTION
          : freshReview.originalUserQuestion,
        authorizedFileRefIds: freshReview.authorizedBodyFileRefIds,
        validateAuthorizedFileRefSelection: () => {
          const expected = [...freshReview.authorizedBodyFileRefIds].sort();
          const actual = [...explicitlyAuthorizedFileRefIds].sort();
          if (expected.length !== actual.length || expected.some((id, index) => id !== actual[index])) {
            throw new AIAttachmentAuthorizationError(
              "AI_CONTEXT_REQUEST_BODY_AUTHORIZATION_REQUIRED",
              "后续调用开始前，本次文件正文授权已发生变化。"
            );
          }
        },
        onAuthorizationCommitted: (readback) => {
          if (
            readback.conversation.id === conversationId &&
            selectedConversationIdRef.current === conversationId
          ) {
            setSelectedAttachmentIds([]);
            setAttachmentSelectorOpen(false);
            setConversationReadback(readback);
          }
        },
        onEvent: (event) => {
          if (
            generation !== null && streamGenerationRef.current === generation &&
            selectedConversationIdRef.current === conversationId
          ) {
            if (event.eventKind === "started") setActiveStreamReady(true);
            setStreamPresentation((current) => reduceAIStreamingPresentation(
              current,
              generation!,
              event,
              Boolean(freshReview.promptPackage.providerPromptEnvelope.contextRequestResponseContract)
            ));
          }
        },
        trace: buildDurableAIInvocationTrace(
          prior.review.contextPackage,
          {
            id: freshReview.promptPackage.id,
            createdAt: freshReview.promptPackage.createdAt
          },
          {
            sourceRefs: freshReview.promptPackage.sourceRefs,
            warnings: freshReview.promptPackage.warnings,
            budgetSummary: freshReview.promptPackage.budgetSummary,
            ...(freshReview.parseDraftSource
              ? { parseDraftSource: freshReview.parseDraftSource }
              : {})
          }
        )
      });
      if (
        generation === null || streamGenerationRef.current !== generation ||
        selectedConversationIdRef.current !== conversationId ||
        invocation.conversationId !== conversationId
      ) {
        void invocation.cancel().catch(() => undefined);
        return;
      }
      activeSendRef.current = invocation;
      setConversationReadback(invocation.preparedReadback);
      const settled = await invocation.completion;
      if (
        streamGenerationRef.current !== generation ||
        selectedConversationIdRef.current !== conversationId
      ) return;
      setConversationReadback(settled.readback);
      setParseDraftEligibilityNotice(undefined);
      setContextRequestApprovalReview(null);
      if (
        freshReview.followupPurpose === "parse_draft" &&
        settled.readback.standardResults.length > 0
      ) setActiveWorkspace("operations");
      setError(null);
      await refreshConversationSummaries();
    } catch (unknownError) {
      if (generation !== null && streamGenerationRef.current !== generation) return;
      if (generation !== null) {
        setStreamPresentation((current) => failAIStreamingPresentation(current, generation!));
      }
      const validationError = unknownError instanceof AIContextRequestApprovalValidationError
        ? unknownError
        : null;
      const prepareError = isAIContextRequestPrepareError(unknownError) ? unknownError : null;
      const configurationPreGate = isAIProviderConfigurationPreGateError(unknownError);
      const attachmentPreGate = isAIAttachmentAuthorizationError(unknownError);
      if (isMaterialSourceFreshnessFailure(unknownError)) {
        await requireMaterialReReview(conversationId, explicitlyAuthorizedFileRefIds);
        return;
      }
      if (
        validationError?.shouldMarkStale ||
        [
          "AI_CONTEXT_REQUEST_STALE",
          "AI_CONTEXT_REQUEST_REVIEW_MISMATCH",
          "AI_CONTEXT_REQUEST_CANDIDATE_UNAVAILABLE"
        ].includes(prepareError?.code ?? "")
      ) {
        await markContextRequestStaleAfterValidation(
          request,
          validationError?.message ?? prepareError?.message ?? "补充上下文请求校验未通过。"
        );
      } else if (providerPhaseStarted) {
        await refreshSelectedReadback(conversationId);
      }
      if (configurationPreGate) await refreshProviderConfiguration();
      const message = validationError?.message || prepareError?.message ||
        projectAIErrorForDisplay(unknownError, language).message;
      setError({
        title: validationError?.code === "CONTEXT_REQUEST_BODY_AUTHORIZATION_REQUIRED"
          ? "需要本次文件授权"
          : "补充上下文请求已阻止",
        message
      });
    } finally {
      if (generation === null || streamGenerationRef.current === generation) {
        activeSendRef.current = null;
        setActiveStreamReady(false);
        setIsStopping(false);
        setIsSending(false);
        setActiveInvocationPurpose(undefined);
      }
      setIsBuilding(false);
      setReviewingContextRequestId(undefined);
      sendInFlightRef.current = false;
      contextRequestDecisionInFlightRef.current = false;
    }
  }

  async function handleRejectContextRequest(request: AIContextRequest) {
    if (
      contextRequestDecisionInFlightRef.current || isSending ||
      request.conversationId !== selectedConversationIdRef.current || request.state !== "PENDING"
    ) return;
    contextRequestDecisionInFlightRef.current = true;
    setDecidingContextRequestId(request.id);
    setError(null);
    try {
      const readback = await rejectAIContextRequest(request.conversationId, request.id);
      if (selectedConversationIdRef.current === request.conversationId) {
        setConversationReadback(readback);
      }
      setContextRequestApprovalReview((current) => (
        current?.review.contextRequestId === request.id ? null : current
      ));
      await refreshConversationSummaries();
    } catch (unknownError) {
      await refreshSelectedReadback(request.conversationId);
      const parsed = isAIContextRequestPrepareError(unknownError) ? unknownError.message :
        unknownError instanceof Error ? unknownError.message : "无法安全拒绝此补充上下文请求。";
      setError({ title: "无法拒绝补充上下文请求", message: parsed });
    } finally {
      setDecidingContextRequestId(undefined);
      contextRequestDecisionInFlightRef.current = false;
    }
  }

  async function handleStop() {
    const active = activeSendRef.current;
    if (!active || !canStop || isStopping || active.conversationId !== selectedConversationIdRef.current) return;
    const generation = streamGenerationRef.current;
    setIsStopping(true);
    setStreamPresentation((current) => requestAIStreamingStop(current, generation));
    try {
      const cancellation = await active.cancel();
      if (streamGenerationRef.current !== generation || active.conversationId !== selectedConversationIdRef.current) return;
      if (cancellation.outcome.kind === "succeeded") {
        setConversationReadback(cancellation.outcome.result.readback);
        setError(null);
      } else {
        setStreamPresentation((current) => failAIStreamingPresentation(current, generation));
        setConversationReadback(cancellation.outcome.readback);
        if (cancellation.outcome.kind === "failed" && cancellation.outcome.error.code === "cancelled") {
          setError({ title: t("aiStoppedTitle"), message: t("aiStoppedMessage") });
        } else {
          setError({ title: t("aiCallFailed"), message: t("aiStreamNotActiveMessage") });
        }
      }
      if (cancellation.status === "ACTIVE_REQUEST_NOT_FOUND") {
        streamGenerationRef.current = generation + 1;
        activeSendRef.current = null;
        setActiveStreamReady(false);
        setIsSending(false);
      }
      await refreshConversationSummaries().catch(() => undefined);
    } catch (unknownError) {
      const displayError = projectAIErrorForDisplay(unknownError, language);
      setError(displayError);
    } finally {
      setIsStopping(false);
    }
  }

  async function handleGenerateActionDraftText(): Promise<ActionDraftGenerationReadback> {
    const conversationId = selectedConversationId;
    if (
      !conversationId || !result?.text.trim() || !projectId.trim() ||
      scopeSelection === AI_CHAT_OTHER_SCOPE_VALUE || !contextPackage || !promptPackage ||
      !durableResult?.resultMessage || durableResult.conversation.id !== conversationId ||
      durableResult.triggerMessage.content.trim() !== promptPackage.userQuestion.trim()
    ) {
      throw new Error(t("aiDraftSelectProject"));
    }
    setIsGeneratingActionDraft(true);
    try {
      const generationPrompt = buildAIActionDraftGenerationPrompt({
        originalUserQuestion: durableResult.triggerMessage.content,
        ordinaryAIResponse: result.text,
        project: { id: projectId, title: contextPackage.scope.label ?? projectId },
        sourceRefs: contextPackage.sourceRefs
      });
      const invocation = activeDraftGenerationRef.current ?? runDurableAIInvocation({
        conversationId,
        purpose: "action_draft_generation",
        requestId: createDurableAIInvocationRequestId(),
        promptText: generationPrompt,
        triggerMessageId: durableResult.resultMessage.id,
        triggerCallAttemptId: durableResult.callAttempt.id,
        trace: buildDurableAIInvocationTrace(
          contextPackage,
          createDurablePromptIdentity("ai-action-draft-prompt"),
          { sourceRefs: contextPackage.sourceRefs, warnings: [] }
        )
      });
      activeDraftGenerationRef.current = invocation;
      const nextDurableResult = await invocation;
      if (nextDurableResult.conversation.id !== conversationId) throw new Error("Conversation identity mismatch.");
      if (selectedConversationIdRef.current !== conversationId) {
        throw new Error("The selected Conversation changed before durable readback completed.");
      }
      setConversationReadback(nextDurableResult.readback);
      const generationReadback = await readCanonicalActionDraftGeneration(nextDurableResult);
      if (
        selectedConversationIdRef.current !== conversationId ||
        generationReadback.sourceTuple.conversationId !== conversationId ||
        generationReadback.sourceTuple.canonicalBusinessScopeIdentity.scopeKind !== "project" ||
        generationReadback.sourceTuple.canonicalBusinessScopeIdentity.scopeId !== projectId.trim()
      ) {
        throw new Error("The mounted Action Draft context changed before canonical readback completed.");
      }
      await refreshConversationSummaries().catch(() => undefined);
      return generationReadback;
    } catch (unknownError) {
      if (isAIProviderConfigurationPreGateError(unknownError)) {
        await refreshProviderConfiguration();
      }
      throw new Error(projectAIErrorForDisplay(unknownError, language).message);
    } finally {
      activeDraftGenerationRef.current = null;
      setIsGeneratingActionDraft(false);
    }
  }

  const canPrepareParseDraft = Boolean(
    selectedConversationId && conversationReadback?.projectedMessages.some((message) => message.role === "user") &&
    projectId.trim() && scopeSelection !== AI_CHAT_OTHER_SCOPE_VALUE &&
    providerConfiguration?.eligibility === "eligible" && !contextRequestApprovalReview && !contextEditorDirty
  );
  const displayedStandardResults = conversationReadback?.standardResults ?? [];
  const parseDraftStatus: {
    state: "preparing" | "running" | "failed" | "completed";
    label: string;
    detail?: string;
  } | undefined = isPreparingParseDraft
    ? { state: "preparing", label: "准备解析" }
    : activeInvocationPurpose === "parse_draft" && isSending
      ? { state: "running", label: "解析中" }
      : parseDraftTerminal?.kind === "failed"
        ? { state: "failed", label: "解析失败", detail: parseDraftTerminal.message }
        : parseDraftTerminal?.kind === "succeeded" || parseDraftTerminal?.kind === "empty" ||
          parseDraftTerminal?.kind === "no-new-content" || displayedStandardResults.length > 0
          ? { state: "completed", label: "解析完成" }
          : undefined;

  function completeWorkspaceClose() {
    setWorkspaceDiscardWarningOpen(false);
    setContextEditorDirty(false);
    if (activeWorkspace === "operations") {
      setParseDraftTerminal(undefined);
      setParseDraftEligibilityNotice(undefined);
    }
    setActiveWorkspace("chat");
  }

  function requestWorkspaceClose() {
    if (contextEditorDirty) {
      setWorkspaceDiscardWarningOpen(true);
      return;
    }
    completeWorkspaceClose();
  }

  function openPanelWorkspace(workspace: Exclude<AIPanelWorkspace, "chat">) {
    if (workspace === activeWorkspace) return;
    setActiveWorkspace(workspace);
  }

  return (
    <aside
      aria-labelledby="global-ai-chat-panel-title"
      className={[
        "global-ai-chat-panel",
        floatingPanel.isDragging ? "is-dragging" : "",
        floatingPanel.isResizing ? "is-resizing" : ""
      ].filter(Boolean).join(" ")}
      data-floating-containment="viewport"
      data-context-editor-dirty={contextEditorDirty ? "true" : "false"}
      data-new-conversation-strategy={AI_NEW_CONVERSATION_STRATEGY}
      data-panel-rect={JSON.stringify(floatingPanel.rect)}
      data-selected-conversation-id={selectedConversationId ?? ""}
      data-workspace={activeWorkspace}
      id="global-ai-chat-panel"
      style={floatingPanel.style}
    >
      <header
        className="global-ai-chat-panel__header global-ai-chat-panel__drag-handle"
        {...floatingPanel.dragHandleProps}
      >
        <div className="global-ai-chat-panel__brand">
          <h2 id="global-ai-chat-panel-title">AI辅助</h2>
        </div>
        <div className="global-ai-chat-panel__header-actions">
          <button
            className="global-ai-chat-panel__close"
            type="button"
            onClick={() => { onClose("panel"); }}
          >
            {t("close")}
          </button>
        </div>
      </header>

      <div className="global-ai-chat-panel__body">
        <section className="global-ai-chat-panel__sidebar" aria-label="AI模型与对话管理">
          <section className="global-ai-chat-panel__model-card">
            <div className="global-ai-chat-panel__model-card-heading">
              <h3>AI模型</h3>
              <button
                className="global-ai-chat-panel__settings-link"
                onClick={() => { onClose("settings"); }}
                type="button"
              >
                设置
              </button>
            </div>
            <dl className="global-ai-chat-panel__status-list">
              <div>
                <dt>服务提供方</dt>
                <dd>{providerConfiguration?.provider ?? "不可用"}</dd>
              </div>
              <div>
                <dt>模型</dt>
                <dd>{providerConfiguration?.model ?? "不可用"}</dd>
              </div>
            </dl>
          </section>

          <section className="global-ai-chat-panel__core-controls">
            <button
              className="global-ai-chat-panel__new-conversation"
              data-first-use-action="create-conversation"
              disabled={isSending || isCreatingConversation || isGeneratingActionDraft}
              onClick={handleCreateAndSelectConversation}
              type="button"
            >
              <span aria-hidden="true">＋</span>
              {isCreatingConversation ? "创建中…" : "新建对话"}
            </button>
            <label className="global-ai-chat-panel__field" htmlFor="global-ai-project-scope">
              当前课题
              <select
                id="global-ai-project-scope"
                value={scopeSelection}
                onChange={(event) => handleScopeChange(event.target.value)}
                disabled={isBusy}
              >
                <option value="">{isLoadingProjects ? "课题加载中…" : "选择课题"}</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>{project.title}</option>
                ))}
                <option value={AI_CHAT_OTHER_SCOPE_VALUE}>{t("aiOtherScope")}</option>
              </select>
            </label>
            {projectLoadFailed ? (
              <p className="global-ai-chat-panel__field-note">{t("aiProjectsLoadFailed")}</p>
            ) : null}
            <label className="global-ai-chat-panel__field" htmlFor="global-ai-output-detail">
              AI回答详细程度
              <select
                id="global-ai-output-detail"
                value={outputDetailPreference}
                onChange={(event) => handleOutputDetailPreferenceChange(event.target.value as AIOutputDetailPreference)}
                disabled={isBusy}
              >
                <option value="CONCISE">简洁</option>
                <option value="STANDARD">标准</option>
                <option value="DETAILED">详细</option>
                <option value="UNRESTRICTED">充分展开</option>
              </select>
            </label>
          </section>

          <section className="global-ai-chat-panel__history">
            <div className="global-ai-chat-panel__section-heading">
              <h3>对话历史</h3>
              <span>{conversationSummaries.length}</span>
            </div>
            <label className="global-ai-chat-panel__history-search">
              <span className="global-ai-chat-panel__sr-only">搜索对话</span>
              <input
                aria-label="搜索对话历史"
                onChange={(event) => setHistorySearch(event.target.value)}
                placeholder="搜索对话"
                type="search"
                value={historySearch}
              />
            </label>
            <nav aria-label="对话历史" className="global-ai-chat-panel__history-list">
              {conversationHistoryGroups.map((group) => (
                <section className="global-ai-chat-panel__history-group" key={group.id}>
                  <h4>{group.label}</h4>
                  {group.conversations.map((summary) => (
                    <button
                      aria-current={summary.id === selectedConversationId ? "page" : undefined}
                      className={summary.id === selectedConversationId ? "is-active" : ""}
                      data-conversation-id={summary.id}
                      disabled={isSending || isGeneratingActionDraft}
                      key={summary.id}
                      onClick={() => { void handleSelectConversation(summary.id); }}
                      type="button"
                    >
                      <strong>{conversationTitle(summary)}</strong>
                      <small>{summary.updatedAt.slice(0, 16).replace("T", " ")}</small>
                    </button>
                  ))}
                </section>
              ))}
              {!isLoadingConversations && filteredConversationSummaries.length === 0 ? (
                <p>{conversationSummaries.length === 0 ? "新建第一个对话以开始。" : "没有匹配的对话。"}</p>
              ) : null}
            </nav>
          </section>
        </section>

        <section className="global-ai-chat-panel__main">

          <section
            aria-label="聊天工作区"
            className="global-ai-chat-panel__chat-workspace"
            hidden={activeWorkspace !== "chat"}
          >
            <nav aria-label="AI辅助工作区入口" className="global-ai-chat-panel__workspace-entries">
              <button
                className="global-ai-chat-panel__workspace-entry global-ai-chat-panel__context-entry"
                disabled={!projectId.trim()}
                onClick={() => openPanelWorkspace(displayedContextPackage ? "context-preview" : "context-builder")}
                type="button"
              >
                <span>
                  <strong>{contextEntryPresentation.title}</strong>
                  <small>{contextEntryPresentation.detail}</small>
                </span>
                <span className="global-ai-chat-panel__workspace-entry-indicator" aria-hidden="true">&gt;</span>
              </button>
              <button
                className="global-ai-chat-panel__workspace-entry global-ai-chat-panel__operations-entry"
                disabled={!projectId.trim()}
                onClick={() => {
                  setOperationsMode("standard-results");
                  openPanelWorkspace("operations");
                }}
                type="button"
              >
                <span>
                  <strong>AI操作建议</strong>
                  <small>{pendingOperationCount} 个待执行操作，{operationSuggestionCount} 个操作建议</small>
                </span>
                <span className="global-ai-chat-panel__workspace-entry-indicator" aria-hidden="true">&lt;</span>
              </button>
            </nav>

            {error ? (
              <div className="global-ai-chat-panel__error" role="alert">
                <strong>{error.title}</strong>
                <p>{error.message}</p>
              </div>
            ) : null}

            {conversationReadback && selectedConversationId === conversationReadback.conversation.id ? (
              <AssistantUIChatSurface
                key={selectedConversationId}
                readback={conversationReadback}
                initialDraft={composerDraftSeed}
                partialText={activeInvocationPurpose === "parse_draft" ? "" : streamPresentation.partialText}
                isRunning={isSending}
                isStopping={isStopping}
                composerDisabled={Boolean(
                  !selectedConversationId || isCreatingConversation || isLoadingConversations ||
                  isGeneratingActionDraft || isPreparingParseDraft
                )}
                sendDisabled={!canReachSendConfigurationBoundary}
                sendGateCode={sendReviewGateCode}
                sendGateNotice={sendGateNotice}
                providerBoundaryCode={providerBoundaryCode}
                canStop={canStop}
                attachmentComposer={(
                  <div
                    className="global-ai-chat-panel__attachments-compact"
                    data-file-body-read-or-upload="ONE_SHOT_USER_SELECTED_TEXT_FOR_THIS_CALL_ONLY"
                    data-one-shot-local-attachment-state={oneShotLocalAttachmentFile ? "selected" : "empty"}
                  >
                    {oneShotLocalAttachmentFile || selectedAttachmentIds.length > 0 ? (
                      <span className="global-ai-chat-panel__sr-only">
                        本次发送会读取所选且受支持材料的正文，并将其提供给当前 AI 服务商
                      </span>
                    ) : null}
                    <input
                      accept={AI_ONE_SHOT_LOCAL_ATTACHMENT_ACCEPT}
                      aria-label="选择一次性本地附件"
                      className="global-ai-chat-panel__one-shot-attachment-input"
                      data-one-shot-local-attachment-input="true"
                      onChange={(event) => handleOneShotLocalAttachmentSelection(event.currentTarget.files?.[0])}
                      ref={oneShotLocalAttachmentInputRef}
                      type="file"
                    />
                    <button
                      aria-label="添加一次性本地附件"
                      className="global-ai-chat-panel__attachment-add"
                      data-opens-native-file-picker="true"
                      disabled={isBusy || !selectedConversationId}
                      onClick={() => {
                        if (oneShotLocalAttachmentInputRef.current) {
                          oneShotLocalAttachmentInputRef.current.value = "";
                          oneShotLocalAttachmentInputRef.current.click();
                        }
                      }}
                      title="添加仅用于本次调用的本地文本附件"
                      type="button"
                    >
                      <span aria-hidden="true">+</span>
                    </button>
                    {oneShotLocalAttachmentFile ? (
                      <span
                        className="global-ai-chat-panel__one-shot-attachment-chip"
                        data-one-shot-local-attachment-name={oneShotLocalAttachmentFile.name}
                        title={`${oneShotLocalAttachmentFile.name} · ${oneShotLocalAttachmentFile.size} bytes · 仅本次调用`}
                      >
                        <span>{oneShotLocalAttachmentFile.name}</span>
                        <button
                          aria-label={`移除一次性附件 ${oneShotLocalAttachmentFile.name}`}
                          disabled={isBusy}
                          onClick={clearOneShotLocalAttachment}
                          type="button"
                        >×</button>
                      </span>
                    ) : null}
                    {selectedAttachmentIds.length > 0 ? (
                      <span
                        className="global-ai-chat-panel__attachment-count"
                        title={selectedAttachments.map((attachment) => attachment.displayName).join("、")}
                      >
                        受管 {selectedAttachmentIds.length} 份
                      </span>
                    ) : null}
                    {attachmentSelectorOpen ? (
                      <div className="global-ai-chat-panel__attachment-selector">
                        <div>
                          <strong>添加附件</strong>
                          <button
                            disabled={isBusy || selectedAttachmentIds.length === 0}
                            onClick={() => {
                              setSelectedAttachmentIds([]);
                              invalidatePreview();
                            }}
                            type="button"
                          >
                            清空
                          </button>
                        </div>
                        {selectableFileRefs.length === 0 && !isLoadingAttachments ? (
                          <span>当前没有可用材料。</span>
                        ) : null}
                        {selectableFileRefs.map((candidate) => {
                          const selected = selectedAttachmentIds.includes(candidate.fileRefId);
                          const supported = candidate.resourceKind === "file" &&
                            candidate.availabilityStatus === "available" &&
                            candidate.materialReadStatus === "supported";
                          return (
                            <button
                              aria-pressed={selected}
                              className={selected ? "is-selected" : ""}
                              disabled={isBusy || !supported}
                              key={candidate.fileRefId}
                              onClick={() => toggleAttachment(candidate)}
                              type="button"
                            >
                              <strong>{candidate.displayName}</strong>
                              <span>{supported ? (selected ? "已选择" : "可选择") : "当前不可用"}</span>
                            </button>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                )}
                parseDraftAction={(
                  <button
                    aria-label={canPrepareParseDraft ? "解析草稿" : "当前无法解析草稿"}
                    className="global-ai-chat-panel__parse-entry"
                    data-parse-eligible={canPrepareParseDraft ? "true" : "false"}
                    disabled={!canPrepareParseDraft || isBusy}
                    onClick={() => {
                      setOperationsMode("standard-results");
                      setActiveWorkspace("operations");
                      void handlePrepareParseDraft();
                    }}
                    title={canPrepareParseDraft ? "解析草稿" : parseDraftEligibilityNotice ?? "需要当前对话、课题和至少一条用户消息"}
                    type="button"
                  >
                    <span aria-hidden="true">析</span>
                    <small>解析草稿</small>
                  </button>
                )}
                emptyStateGreeting={emptyStateGreeting}
                onDraftChange={handleQuestionChange}
                actionsDisabled={Boolean(
                  isBusy || !projectId.trim() || scopeSelection === AI_CHAT_OTHER_SCOPE_VALUE ||
                  providerConfiguration?.eligibility !== "eligible"
                )}
                contextRequestActionsDisabled={isBusy}
                activeActionIntent={activeActionIntent}
                onRegenerate={() => { void handleRetryRegenerate("regenerate"); }}
                onRetry={() => { void handleRetryRegenerate("retry"); }}
                reviewingContextRequestId={reviewingContextRequestId}
                reviewedContextRequestId={reviewedContextRequestId}
                decidingContextRequestId={decidingContextRequestId}
                onApproveContextRequest={(request) => { void handleApproveContextRequest(request); }}
                onRejectContextRequest={(request) => { void handleRejectContextRequest(request); }}
                onSubmit={handleSend}
                onStop={() => { void handleStop(); }}
              />
            ) : isLoadingConversations ? (
              <div className="global-ai-chat-panel__placeholder" role="status">
                <p>{t("aiConversationLoading")}</p>
              </div>
            ) : (
              <div className="global-ai-chat-panel__placeholder" data-first-use-state="actionable-create">
                <strong>开始一次对话</strong>
                <p>创建对话后选择课题、构建上下文，再确认发送。</p>
                <button
                  className="global-ai-chat-panel__new-conversation"
                  data-first-use-action="create-conversation"
                  disabled={isSending || isCreatingConversation || isGeneratingActionDraft}
                  onClick={handleCreateAndSelectConversation}
                  type="button"
                >
                  {isCreatingConversation ? "创建中…" : "新建对话"}
                </button>
              </div>
            )}
          </section>

          {activeWorkspace === "context-preview" || activeWorkspace === "context-edit" ? (
            <section
              aria-label={activeWorkspace === "context-edit" ? "编辑上下文内容工作区" : "查看上下文内容工作区"}
              className="global-ai-chat-panel__workspace global-ai-chat-panel__workspace--context"
            >
              <header className="global-ai-chat-panel__workspace-header">
                <h3>构建上下文</h3>
                <button onClick={requestWorkspaceClose} type="button">返回聊天</button>
              </header>
              <div className="global-ai-chat-panel__workspace-scroll">
                {displayedContextPackage ? (
                  <AIContextPreviewPanel
                    contextPackage={displayedContextPackage}
                    promptPackage={displayedPromptPackage}
                    contextMarkdown={displayedContextMarkdown}
                    defaultContextMarkdown={contextRequestApprovalReview
                      ? displayedContextMarkdown
                      : defaultContextMarkdown}
                    isContextModified={contextRequestApprovalReview ? false : isContextModified}
                    disabled={isBusy}
                    editingDisabled={Boolean(contextRequestApprovalReview)}
                    mode={activeWorkspace === "context-edit" ? "edit" : "view"}
                    onDirtyChange={setContextEditorDirty}
                    onEdit={() => setActiveWorkspace("context-edit")}
                    onReselect={() => {
                      setContextEditorDirty(false);
                      if (contextRequestApprovalReview) {
                        setContextRequestApprovalReview(null);
                        setError(null);
                      }
                      setActiveWorkspace("context-builder");
                    }}
                    onSaveContext={(value) => {
                      setContextEditorDirty(false);
                      void rebuildPromptWithContext(value);
                    }}
                    onCancelEdit={() => {
                      setContextEditorDirty(false);
                      setActiveWorkspace("context-preview");
                    }}
                    onConfirm={() => {
                      setContextEditorDirty(false);
                      setActiveWorkspace("chat");
                    }}
                  />
                ) : (
                  <div className="global-ai-chat-panel__placeholder">
                    <strong>尚未构建上下文</strong>
                    <p>选择研究对象后即可构建。</p>
                    <button onClick={() => setActiveWorkspace("context-builder")} type="button">
                      构建上下文
                    </button>
                  </div>
                )}
              </div>
            </section>
          ) : null}

          {activeWorkspace === "context-builder" ? (
            <section
              aria-label="构建上下文工作区"
              className="global-ai-chat-panel__workspace global-ai-chat-panel__workspace--builder"
              data-context-content-state="A"
            >
              <header className="global-ai-chat-panel__workspace-header">
                <h3>构建上下文</h3>
                <button onClick={requestWorkspaceClose} type="button">返回聊天</button>
              </header>
              <div className="global-ai-chat-panel__builder-layout">
                <aside className="global-ai-chat-panel__builder-categories">
                  <label className="global-ai-chat-panel__field" htmlFor="global-ai-builder-context-mode">
                    上下文详细程度
                    <select
                      id="global-ai-builder-context-mode"
                      value={contextMode}
                      onChange={(event) => handleContextModeChange(event.target.value as AIContextMode)}
                      disabled={isBusy}
                    >
                      <option value="MINIMAL">最少必要信息</option>
                      <option value="BRIEF">简要</option>
                      <option value="STANDARD">标准</option>
                      <option value="DETAILED">详细</option>
                    </select>
                  </label>
                  <label className="global-ai-chat-panel__field" htmlFor="global-ai-builder-associated-documents">
                    关联文档
                    <select
                      id="global-ai-builder-associated-documents"
                      value={includeAssociatedDocuments ? "include" : "exclude"}
                      onChange={(event) => handleAssociatedDocumentChange(event.target.value === "include")}
                      disabled={isBusy}
                    >
                      <option value="exclude">不包含关联文档</option>
                      <option value="include">包含关联文档</option>
                    </select>
                  </label>
                  <h4>对象选择</h4>
                  {AI_RESEARCH_OBJECT_CATEGORIES.map((category) => {
                    const count = filterAIResearchObjectsByCategory(researchObjectOptions, category.id).length;
                    return (
                      <button
                        aria-pressed={activeResearchObjectCategory === category.id}
                        className={activeResearchObjectCategory === category.id ? "is-active" : ""}
                        key={category.id}
                        onClick={() => setActiveResearchObjectCategory(category.id)}
                        type="button"
                      >
                        <span>{category.label}</span>
                        <small>{count}</small>
                      </button>
                    );
                  })}
                </aside>
                <div className="global-ai-chat-panel__builder-content">
                  {!projectId ? (
                    <div className="global-ai-chat-panel__placeholder">
                      <strong>请先选择当前课题</strong>
                      <p>返回左侧选择课题后即可添加研究对象。</p>
                    </div>
                  ) : (
                    <>
                      <section className="global-ai-chat-panel__builder-selected">
                        <div className="global-ai-chat-panel__builder-selection-heading">
                          <h4>已选择对象列表</h4>
                          <strong>{selectedResearchObjectCount}/{AI_RESEARCH_OBJECT_SELECTION_MAX}</strong>
                        </div>
                        {selectedResearchObjectDescriptors.length > 0 ? (
                          <div className="global-ai-chat-panel__research-object-chips" aria-label="已选择研究对象">
                            {selectedResearchObjectDescriptors.map((descriptor) => (
                              <button
                                key={["selected", descriptor.objectType, descriptor.objectId].join(":")}
                                onClick={() => toggleResearchObject(descriptor)}
                                type="button"
                              >
                                {researchObjectTypeLabel(descriptor)} · {descriptor.label} <span aria-hidden="true">×</span>
                              </button>
                            ))}
                          </div>
                        ) : (
                          <p className="global-ai-chat-panel__builder-zero">尚未选择研究对象。</p>
                        )}
                        {associatedCurrentManuscripts.length > 0 ? (
                          <p className="global-ai-chat-panel__associated-summary">
                            已纳入 {associatedCurrentManuscripts.length} 份当前关联文档
                            {associatedDocumentSkipCount > 0 ? `，另有 ${associatedDocumentSkipCount} 项未找到可用当前文稿` : ""}。
                          </p>
                        ) : null}
                      </section>

                      <section className="global-ai-chat-panel__builder-available">
                        <div className="global-ai-chat-panel__builder-selection-heading">
                          <h4>{AI_RESEARCH_OBJECT_CATEGORIES.find((item) => item.id === activeResearchObjectCategory)?.label}</h4>
                        </div>
                        <div
                          aria-label="可选研究对象"
                          className="global-ai-chat-panel__research-object-list global-ai-chat-panel__research-object-list--builder"
                          data-zero-object-disposition={selectedResearchObjectCount === 0 ? "VISIBLE_PROJECT_ONLY" : "OBJECT_SCOPED"}
                        >
                          {activeCategoryResearchObjects.map((descriptor) => (
                            <label key={[descriptor.objectType, descriptor.objectId].join(":")}>
                              <input
                                checked={researchObjectIdsForType(descriptor.objectType).includes(descriptor.objectId)}
                                disabled={isBusy}
                                onChange={() => toggleResearchObject(descriptor)}
                                type="checkbox"
                              />
                              <span>
                                <strong>{descriptor.label}</strong>
                                <small>{researchObjectTypeLabel(descriptor)}</small>
                              </span>
                            </label>
                          ))}
                          {!isLoadingResearchObjects && activeCategoryResearchObjects.length === 0 ? (
                            <p>当前课题没有此类对象。</p>
                          ) : null}
                          {isLoadingResearchObjects ? <p>正在加载研究对象…</p> : null}
                        </div>
                      </section>
                    </>
                  )}
                </div>
              </div>
              <footer className="global-ai-chat-panel__workspace-footer">
                <button
                  className="is-primary"
                  disabled={isBusy || !projectId || scopeSelection === AI_CHAT_OTHER_SCOPE_VALUE}
                  onClick={() => {
                    void handleBuildPreview().then((built) => {
                      if (built) setActiveWorkspace("context-preview");
                    });
                  }}
                  type="button"
                >
                  {isBuilding ? "构建中…" : "确认并构建"}
                </button>
              </footer>
            </section>
          ) : null}

          {activeWorkspace === "operations" ? (
            <section
              aria-label="AI操作建议工作区"
              className="global-ai-chat-panel__workspace global-ai-chat-panel__workspace--operations"
            >
              <header className="global-ai-chat-panel__workspace-header">
                <div className="global-ai-chat-panel__operations-title">
                  <h3>AI操作建议</h3>
                  {parseDraftStatus ? (
                    <span
                      className="global-ai-chat-panel__parse-status"
                      data-parse-status={parseDraftStatus.state}
                      role={parseDraftStatus.state === "failed" ? "alert" : "status"}
                      title={parseDraftStatus.detail}
                    >
                      {parseDraftStatus.label}
                    </span>
                  ) : null}
                </div>
                <button onClick={requestWorkspaceClose} type="button">返回聊天</button>
              </header>
              <div className="global-ai-chat-panel__operations-layout">
                {operationsMode === "standard-results" ? (
                  <AIParseDraftPanel
                    terminal={parseDraftTerminal}
                    results={displayedStandardResults}
                    disabled={nonStandardResultBusy}
                    activeMutationResultId={activeStandardResultMutation?.resultId}
                    projectNameById={projectNameById}
                    objectNameByKey={objectNameByKey}
                    scopeGateNotice={contextEditorDirty
                      ? t("aiUnsavedContextGateMessage")
                      : parseDraftEligibilityNotice}
                    isPreparing={isPreparingParseDraft}
                    isRunning={activeInvocationPurpose === "parse_draft" && isSending}
                    onRetry={() => { void handlePrepareParseDraft(); }}
                    onSaveResult={handleSaveStandardResult}
                    onConfirmResult={handleConfirmStandardResult}
                    onContinueResult={handleContinueStandardResult}
                    onDismissResult={handleDismissStandardResult}
                  />
                ) : (
                  <AIActionDraftPanel
                    embedded
                    responseText={result?.text}
                    mountedConversationId={selectedConversationId ?? undefined}
                    mountedScopeIdentity={projectId.trim() ? {
                      scopeKind: "project",
                      scopeId: projectId.trim()
                    } : undefined}
                    effectiveSourceAssistantMessageId={durableResult?.resultMessage?.id}
                    effectiveSourceCallAttemptId={durableResult?.callAttempt.id}
                    userQuestion={promptPackage?.userQuestion ?? userQuestion}
                    sourceRefs={promptPackage?.sourceRefs}
                    canGenerateDrafts={Boolean(
                      providerConfiguration?.eligibility === "eligible" &&
                      selectedConversationId && result?.text.trim() && projectId.trim() &&
                      scopeSelection !== AI_CHAT_OTHER_SCOPE_VALUE && contextPackage && promptPackage &&
                      durableResult?.resultMessage && durableResult.conversation.id === selectedConversationId &&
                      durableResult.triggerMessage.content.trim() === promptPackage.userQuestion.trim()
                    )}
                    onGenerateDraftText={handleGenerateActionDraftText}
                  />
                )}
              </div>
            </section>
          ) : null}
        </section>
      </div>

      <AIContextDiscardDialog
        confirmLabel="放弃编辑并返回聊天"
        onCancel={() => setWorkspaceDiscardWarningOpen(false)}
        onConfirm={completeWorkspaceClose}
        open={workspaceDiscardWarningOpen}
      />

      <button
        aria-label="调整 AI辅助 面板大小"
        className="global-ai-chat-panel__resize-handle"
        tabIndex={-1}
        title="拖动调整面板大小"
        type="button"
        {...floatingPanel.resizeHandleProps}
      />
    </aside>
  );
}
