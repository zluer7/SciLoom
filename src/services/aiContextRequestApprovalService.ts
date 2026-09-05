import { createRepositoryEntityId } from "../repositories/entityId";
import { aiConversationRepository } from "../repositories/aiConversationRepository";
import type {
  AIConversationReadback,
  AISelectableFileRef
} from "../types/aiConversation";
import type {
  AIApprovedContextRequestContribution,
  AIContextMaterialSelection,
  AIContextPackage,
  AIContextSourceRef,
  AIPromptPackage,
  AIQuickAnalysisContextCapability,
  AIQuickFollowupBodyAuthorizationEntry,
  AIQuickFollowupMetadataReferenceEntry
} from "../types/aiContext";
import type {
  AIContextRequest,
  AIContextRequestCandidate
} from "../types/aiContextRequest";
import { buildAIContext } from "./aiContextBuilderService";
import {
  buildConversationPromptPackage
} from "./aiConversationApplicationService";
import {
  contextRequestCandidateFingerprint,
  requestedBodyFileRefIds,
  resolveAIContextRequestCandidates
} from "./aiContextRequestService";
import { AI_RESEARCH_OBJECT_SELECTION_MAX } from "./aiResearchObjectService";
import {
  PARSE_DRAFT_USER_INSTRUCTION,
  buildAIParseDraftPromptPackage,
  readAIParseDraftSourceRef
} from "./aiParseDraftService";
import { resolveRetryConstraintRequest } from "./aiConstraintService";
import { selectRelevantEffectiveDiscussion } from "./aiConversationHistoryService";
import type { AIParseDraftSourceSnapshot } from "../types/aiStandardResult";
import { AI_PROVIDER_PROMPT_TECHNICAL_MAX_CHARS } from "./aiPromptBudgetService";

export type AIContextRequestApprovalValidationCode =
  | "CONTEXT_REQUEST_NOT_PENDING"
  | "CONTEXT_REQUEST_SOURCE_STALE"
  | "CONTEXT_REQUEST_CANDIDATE_CHANGED"
  | "CONTEXT_REQUEST_BODY_AUTHORIZATION_REQUIRED"
  | "CONTEXT_REQUEST_SELECTION_LIMIT_EXCEEDED"
  | "CONTEXT_REQUEST_CANONICAL_BUILD_FAILED";

export class AIContextRequestApprovalValidationError extends Error {
  constructor(
    readonly code: AIContextRequestApprovalValidationCode,
    message: string
  ) {
    super(message);
    this.name = "AIContextRequestApprovalValidationError";
  }

  get shouldMarkStale(): boolean {
    return this.code !== "CONTEXT_REQUEST_BODY_AUTHORIZATION_REQUIRED";
  }
}

export interface AIContextRequestApprovalReview {
  contextRequestId: string;
  sourceMessageId: string;
  originalUserQuestion: string;
  reviewedCandidates: AIContextRequestCandidate[];
  candidateFingerprint: string;
  contextPackage: AIContextPackage;
  promptPackage: AIPromptPackage;
  authorizedBodyFileRefIds: string[];
  followupPurpose: "chat_response" | "parse_draft";
  parseDraftSource?: AIParseDraftSourceSnapshot;
}

function canonicalIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right));
}

function exactIds(left: readonly string[], right: readonly string[]): boolean {
  const a = canonicalIds(left);
  const b = canonicalIds(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function cloneMaterialSelection(
  selection: AIContextMaterialSelection
): AIContextMaterialSelection {
  return {
    fileRefId: selection.fileRefId,
    displayName: selection.displayName,
    availabilityStatus: selection.availabilityStatus,
    materialReadStatus: selection.materialReadStatus,
    materialPromptReservationCharacters: selection.materialPromptReservationCharacters,
    ...(selection.materialFreshnessReceipt
      ? { materialFreshnessReceipt: { ...selection.materialFreshnessReceipt } }
      : {})
  };
}

function sameMaterialSelection(
  left: AIContextMaterialSelection,
  right: AIContextMaterialSelection
): boolean {
  return left.fileRefId === right.fileRefId &&
    left.displayName === right.displayName &&
    left.availabilityStatus === right.availabilityStatus &&
    left.materialReadStatus === right.materialReadStatus &&
    left.materialPromptReservationCharacters === right.materialPromptReservationCharacters &&
    left.materialFreshnessReceipt?.fileRefId === right.materialFreshnessReceipt?.fileRefId &&
    left.materialFreshnessReceipt?.receiptVersion === right.materialFreshnessReceipt?.receiptVersion &&
    left.materialFreshnessReceipt?.sourceToken === right.materialFreshnessReceipt?.sourceToken;
}

function mergeContextRequestMaterialSelections(
  runScopedTaskMaterials: readonly AIContextMaterialSelection[],
  requestedMaterials: readonly AIContextMaterialSelection[]
): AIContextMaterialSelection[] {
  const merged = new Map<string, AIContextMaterialSelection>();
  for (const selection of [...runScopedTaskMaterials, ...requestedMaterials]) {
    const cloned = cloneMaterialSelection(selection);
    const existing = merged.get(cloned.fileRefId);
    if (existing && !sameMaterialSelection(existing, cloned)) {
      throw new AIContextRequestApprovalValidationError(
        "CONTEXT_REQUEST_SOURCE_STALE",
        "A run-scoped task material changed while the Context Request supplement was being prepared."
      );
    }
    merged.set(cloned.fileRefId, existing ?? cloned);
  }
  return [...merged.values()].sort((left, right) =>
    left.fileRefId.localeCompare(right.fileRefId));
}

const QUICK_ANALYSIS_OWNER_TYPES = new Set([
  "experiment",
  "experimentRun",
  "literature",
  "review",
  "resultItem",
  "finding",
  "outputCandidate",
  "outputGap",
  "researchOutput"
]);
const QUICK_ANALYSIS_CHANNELS = new Set(["primary", "literature_outline", "dedicated_notes"]);

function requiredQuickRunScope(
  sourceAttempt: AIConversationReadback["callAttempts"][number],
  additionalSourceRefs: readonly AIContextSourceRef[]
) {
  const frozenReceipts = sourceAttempt.contextSourceRefs.filter((sourceRef) =>
    sourceRef.field === "quickAnalysisRunAuthorization");
  const derivedReceipts = additionalSourceRefs.filter((sourceRef) =>
    sourceRef.field === "quickAnalysisRunAuthorization");
  if (frozenReceipts.length !== 1 || derivedReceipts.length !== 1) {
    throw new AIContextRequestApprovalValidationError(
      "CONTEXT_REQUEST_SOURCE_STALE",
      "The Quick Analysis follow-up does not have one exact frozen and derived run authorization receipt."
    );
  }
  const frozen = frozenReceipts[0];
  const derived = derivedReceipts[0];
  const requiredStrings = [
    frozen.quickAnalysisRunId,
    frozen.quickAnalysisProjectId,
    frozen.quickAnalysisOwnerType,
    frozen.quickAnalysisOwnerId,
    frozen.quickAnalysisChannel,
    frozen.quickAnalysisSourceFileRefId,
    frozen.quickAnalysisSourceDirectoryFileRefId,
    frozen.quickAnalysisWhitelistFingerprint
  ];
  if (
    requiredStrings.some((value) => typeof value !== "string" || !value.trim()) ||
    !QUICK_ANALYSIS_OWNER_TYPES.has(frozen.quickAnalysisOwnerType!) ||
    !QUICK_ANALYSIS_CHANNELS.has(frozen.quickAnalysisChannel!) ||
    ![
      "USER_CLICKED_AI_ANALYSIS",
      "DERIVED_FROM_QUICK_ANALYSIS_RUN_AUTHORIZATION"
    ].includes(frozen.quickAnalysisAuthorizationSource ?? "") ||
    frozen.quickAnalysisAutoContextBudgetLimit !== 1 ||
    frozen.quickAnalysisAutoContextBudgetRemaining !== 1 ||
    frozen.quickAnalysisContextCapabilityState !== "CONTEXT_ALLOWED" ||
    derived.quickAnalysisRunId !== frozen.quickAnalysisRunId ||
    derived.quickAnalysisProjectId !== frozen.quickAnalysisProjectId ||
    derived.quickAnalysisOwnerType !== frozen.quickAnalysisOwnerType ||
    derived.quickAnalysisOwnerId !== frozen.quickAnalysisOwnerId ||
    derived.quickAnalysisChannel !== frozen.quickAnalysisChannel ||
    derived.quickAnalysisSourceFileRefId !== frozen.quickAnalysisSourceFileRefId ||
    derived.quickAnalysisSourceDirectoryFileRefId !== frozen.quickAnalysisSourceDirectoryFileRefId ||
    derived.quickAnalysisWhitelistFingerprint !== frozen.quickAnalysisWhitelistFingerprint ||
    derived.quickAnalysisAuthorizationSource !== "DERIVED_FROM_QUICK_ANALYSIS_RUN_AUTHORIZATION" ||
    derived.quickAnalysisAutoContextBudgetLimit !== 1 ||
    derived.quickAnalysisAutoContextBudgetRemaining !== 0 ||
    derived.quickAnalysisContextCapabilityState !== "CONTEXT_EXHAUSTED"
  ) {
    throw new AIContextRequestApprovalValidationError(
      "CONTEXT_REQUEST_SOURCE_STALE",
      "The derived Quick Analysis run scope does not exactly match its durable frozen source."
    );
  }
  return {
    runId: frozen.quickAnalysisRunId!,
    projectId: frozen.quickAnalysisProjectId!,
    ownerType: frozen.quickAnalysisOwnerType!,
    ownerId: frozen.quickAnalysisOwnerId!,
    channel: frozen.quickAnalysisChannel!,
    sourceFileRefId: frozen.quickAnalysisSourceFileRefId!
  };
}

/**
 * Produces the single typed BODY/metadata provenance receipt for a run-scoped
 * Quick follow-up. It grants no authority: Rust validates it against the
 * original CallAttempt, Context Request and current material freshness before
 * committing the follow-up CallAttempt.
 */
export function buildQuickAnalysisFollowupAuthorizationSourceRef(input: {
  request: AIContextRequest;
  sourceAttempt: AIConversationReadback["callAttempts"][number];
  selectedMaterials: readonly AIContextMaterialSelection[];
  approvedCandidates: readonly AIContextRequestCandidate[];
  additionalSourceRefs: readonly AIContextSourceRef[];
}): AIContextSourceRef {
  const scope = requiredQuickRunScope(input.sourceAttempt, input.additionalSourceRefs);
  if (
    input.request.source.projectId !== scope.projectId ||
    input.approvedCandidates.some((candidate) => candidate.projectId !== scope.projectId)
  ) {
    throw new AIContextRequestApprovalValidationError(
      "CONTEXT_REQUEST_SOURCE_STALE",
      "The Context Request Project no longer matches the frozen Quick Analysis scope."
    );
  }
  const frozenIds = new Set(input.sourceAttempt.authorizedFileRefs.map((fileRef) => fileRef.fileRefId));
  const supplementalIds = new Set(requestedBodyFileRefIds(input.approvedCandidates));
  if (!frozenIds.has(scope.sourceFileRefId)) {
    throw new AIContextRequestApprovalValidationError(
      "CONTEXT_REQUEST_SOURCE_STALE",
      "The frozen Quick source is absent from the source CallAttempt authorization receipt."
    );
  }
  const bodyEntries: AIQuickFollowupBodyAuthorizationEntry[] = input.selectedMaterials.map((material): AIQuickFollowupBodyAuthorizationEntry => {
    const receipt = material.materialFreshnessReceipt;
    if (!receipt || receipt.fileRefId !== material.fileRefId) {
      throw new AIContextRequestApprovalValidationError(
        "CONTEXT_REQUEST_SOURCE_STALE",
        "A Quick follow-up BODY entry is missing its canonical freshness identity."
      );
    }
    const authorizationOrigins: AIQuickFollowupBodyAuthorizationEntry["authorizationOrigins"] = [];
    if (frozenIds.has(material.fileRefId)) authorizationOrigins.push("RUN_SCOPED_FROZEN_SOURCE");
    if (supplementalIds.has(material.fileRefId)) authorizationOrigins.push("CONTEXT_REQUEST_APPROVAL");
    if (authorizationOrigins.length === 0) {
      throw new AIContextRequestApprovalValidationError(
        "CONTEXT_REQUEST_BODY_AUTHORIZATION_REQUIRED",
        "A Quick follow-up contains a BODY entry outside the frozen source and approved supplement union."
      );
    }
    return {
      fileRefId: material.fileRefId,
      materialUse: "BODY_CONTENT",
      authorizationOrigins,
      projectId: scope.projectId,
      ownerType: scope.ownerType,
      ownerId: scope.ownerId,
      channel: scope.channel,
      sourceFreshnessIdentity: { ...receipt },
      contextRequestIds: supplementalIds.has(material.fileRefId) ? [input.request.id] : []
    };
  }).sort((left, right) =>
    left.fileRefId.localeCompare(right.fileRefId) ||
    left.sourceFreshnessIdentity.sourceToken.localeCompare(right.sourceFreshnessIdentity.sourceToken));
  const metadataEntries: AIQuickFollowupMetadataReferenceEntry[] = input.approvedCandidates
    .filter((candidate) => candidate.contributionKind === "IDENTITY_METADATA")
    .map((candidate): AIQuickFollowupMetadataReferenceEntry => ({
      refKind: candidate.refKind,
      refId: candidate.refId,
      contributionKind: "IDENTITY_METADATA",
      projectId: candidate.projectId,
      contextRequestId: input.request.id
    }))
    .sort((left, right) =>
      left.refKind.localeCompare(right.refKind) || left.refId.localeCompare(right.refId));
  return {
    module: "ai",
    entityType: "system",
    entityId: input.request.id,
    label: "Quick Analysis Context follow-up authorization",
    field: "quickAnalysisContextFollowupAuthorization",
    sourceKind: "systemGenerated",
    isUserAuthored: false,
    isAiGenerated: false,
    isVerified: true,
    quickAnalysisRunId: scope.runId,
    quickAnalysisProjectId: scope.projectId,
    quickAnalysisOwnerType: scope.ownerType,
    quickAnalysisOwnerId: scope.ownerId,
    quickAnalysisChannel: scope.channel,
    quickAnalysisFollowupContextRequestId: input.request.id,
    quickAnalysisFollowupBodyAuthorizationEntries: bodyEntries,
    quickAnalysisFollowupMetadataReferenceEntries: metadataEntries
  };
}

export function resolveContextRequestOriginalUserQuestion(
  readback: AIConversationReadback,
  request: AIContextRequest
): string {
  let attemptId = request.sourceCallAttemptId;
  for (let depth = 0; depth < 8; depth += 1) {
    const attempt = readback.callAttempts.find((candidate) => candidate.id === attemptId);
    const trigger = attempt?.triggerMessageId
      ? readback.messages.find((message) => message.id === attempt.triggerMessageId)
      : undefined;
    if (
      !attempt || attempt.status !== "succeeded" ||
      (attempt.purpose !== "chat_response" && attempt.purpose !== "parse_draft") || !trigger
    ) {
      break;
    }
    if (trigger.role === "user" && trigger.messageKind === "text" && trigger.content.trim()) {
      return trigger.content;
    }
    if (
      trigger.messageKind !== "context_request_action" ||
      trigger.actionType !== "APPROVE_CONTEXT_REQUEST" || !trigger.actionRefId
    ) {
      break;
    }
    const priorRequest = readback.contextRequests.find((candidate) => (
      candidate.id === trigger.actionRefId &&
      candidate.decisionActionMessageId === trigger.id &&
      candidate.followupCallAttemptId === attempt.id &&
      candidate.state === "APPROVED"
    ));
    if (!priorRequest) break;
    attemptId = priorRequest.sourceCallAttemptId;
  }
  throw new AIContextRequestApprovalValidationError(
    "CONTEXT_REQUEST_SOURCE_STALE",
    "The original canonical user question cannot be recovered from this Context Request chain."
  );
}

function assertEffectiveSource(
  readback: AIConversationReadback,
  request: AIContextRequest
) {
  const sourceAttempt = readback.callAttempts.find((attempt) => attempt.id === request.sourceCallAttemptId);
  if (sourceAttempt?.purpose === "parse_draft") {
    if (
      sourceAttempt.status !== "succeeded" ||
      sourceAttempt.resultMessageId !== request.sourceMessageId ||
      sourceAttempt.conversationId !== request.conversationId
    ) {
      throw new AIContextRequestApprovalValidationError(
        "CONTEXT_REQUEST_SOURCE_STALE",
        "The Parse Draft Context Request source is no longer a valid terminal attempt."
      );
    }
    let source;
    try {
      source = readAIParseDraftSourceRef(sourceAttempt.contextSourceRefs);
      const current = selectRelevantEffectiveDiscussion(readback, {
        projectId: source.projectId,
        selectedTaskIds: source.selectedTaskIds,
        selectedReviewIds: source.selectedReviewIds,
        selectedExperimentIds: source.selectedExperimentIds,
        selectedExperimentRunIds: source.selectedExperimentRunIds,
        experimentRunParentRelations: source.experimentRunParentRelations,
        selectedLiteratureIds: source.selectedLiteratureIds,
        selectedFindingIds: source.selectedFindingIds,
        literatureAssociationTuples: source.literatureAssociationTuples,
        literatureSelectionAggregateEligibility: source.literatureSelectionAggregateEligibility,
        contextMode: source.contextMode,
        contextReviewFingerprint: source.contextReviewFingerprint,
        authorizedMaterialFileRefIds: sourceAttempt.authorizedFileRefs.map((fileRef) => fileRef.fileRefId)
      });
      if (current.fingerprint !== source.discussionFingerprint) throw new Error("discussion changed");
    } catch {
      throw new AIContextRequestApprovalValidationError(
        "CONTEXT_REQUEST_SOURCE_STALE",
        "The selected Parse Draft discussion or scope changed before approval."
      );
    }
    return;
  }
  if (
    readback.conversation.id !== request.conversationId ||
    readback.retryRegenerate.effectiveAssistantMessageId !== request.sourceMessageId ||
    readback.retryRegenerate.effectiveSourceAttemptId !== request.sourceCallAttemptId
  ) {
    throw new AIContextRequestApprovalValidationError(
      "CONTEXT_REQUEST_SOURCE_STALE",
      "The request source is no longer the effective latest Assistant result in this Conversation."
    );
  }
}

function materialSelections(
  bodyIds: readonly string[],
  catalog: readonly AISelectableFileRef[]
): AIContextMaterialSelection[] {
  return bodyIds.map((fileRefId) => {
    const fileRef = catalog.find((candidate) => candidate.fileRefId === fileRefId);
    if (
      !fileRef || fileRef.resourceKind !== "file" ||
      fileRef.availabilityStatus !== "available" || fileRef.materialReadStatus !== "supported" ||
      !Number.isSafeInteger(fileRef.materialPromptReservationCharacters) ||
      (fileRef.materialPromptReservationCharacters ?? 0) <= 0 ||
      !fileRef.materialFreshnessReceipt ||
      fileRef.materialFreshnessReceipt.fileRefId !== fileRefId
    ) {
      throw new AIContextRequestApprovalValidationError(
        "CONTEXT_REQUEST_CANDIDATE_CHANGED",
        "A requested FileRef body is no longer available to the authorized material reader."
      );
    }
    return {
      fileRefId: fileRef.fileRefId,
      displayName: fileRef.displayName,
      availabilityStatus: fileRef.availabilityStatus,
      materialReadStatus: fileRef.materialReadStatus,
      materialPromptReservationCharacters: fileRef.materialPromptReservationCharacters!,
      materialFreshnessReceipt: { ...fileRef.materialFreshnessReceipt }
    };
  });
}

function approvedContributions(
  candidates: readonly AIContextRequestCandidate[]
): AIApprovedContextRequestContribution[] {
  return candidates.map((candidate) => ({
    refKind: candidate.refKind,
    refId: candidate.refId,
    projectId: candidate.projectId,
    label: candidate.label,
    contributionKind: candidate.contributionKind,
    availability: "available",
    fileBodyAuthorizationRequired: candidate.fileBodyAuthorizationRequired
  }));
}

export async function buildAIContextRequestApprovalReview(input: {
  request: AIContextRequest;
  readback: AIConversationReadback;
  explicitlyAuthorizedFileRefIds: readonly string[];
  runScopedTaskMaterialSelections?: readonly AIContextMaterialSelection[];
  runScopedDirective?: string;
  quickAnalysisContextCapability?: AIQuickAnalysisContextCapability;
  additionalSourceRefs?: readonly AIContextSourceRef[];
}): Promise<AIContextRequestApprovalReview> {
  const { request, readback } = input;
  if (request.state !== "PENDING") {
    throw new AIContextRequestApprovalValidationError(
      "CONTEXT_REQUEST_NOT_PENDING",
      "This Context Request already has a terminal decision."
    );
  }
  assertEffectiveSource(readback, request);
  const sourceAttempt = readback.callAttempts.find((attempt) => attempt.id === request.sourceCallAttemptId);
  const followupPurpose = sourceAttempt?.purpose === "parse_draft" ? "parse_draft" : "chat_response";
  const isRunScopedQuickAnalysis = Boolean(input.runScopedDirective?.trim()) &&
    Boolean(input.quickAnalysisContextCapability) &&
    Boolean(input.additionalSourceRefs?.some((sourceRef) => sourceRef.quickAnalysisRunId));
  const runScopedTaskMaterials = (input.runScopedTaskMaterialSelections ?? [])
    .map(cloneMaterialSelection)
    .sort((left, right) => left.fileRefId.localeCompare(right.fileRefId));
  if (
    isRunScopedQuickAnalysis
      ? runScopedTaskMaterials.length === 0 || !exactIds(
          runScopedTaskMaterials.map((selection) => selection.fileRefId),
          sourceAttempt?.authorizedFileRefs.map((fileRef) => fileRef.fileRefId) ?? []
        )
      : runScopedTaskMaterials.length > 0
  ) {
    throw new AIContextRequestApprovalValidationError(
      "CONTEXT_REQUEST_SOURCE_STALE",
      "The run-scoped task material no longer matches the exact authorized source CallAttempt."
    );
  }
  const originalUserQuestion = followupPurpose === "parse_draft"
    ? PARSE_DRAFT_USER_INSTRUCTION
    : resolveContextRequestOriginalUserQuestion(readback, request);
  const catalog = await aiConversationRepository.listAttachmentFileRefs();
  const candidates = await resolveAIContextRequestCandidates(
    request.source.projectId,
    request.source.requestableRefs,
    request.requestedRefs
  ).catch(() => {
    throw new AIContextRequestApprovalValidationError(
      "CONTEXT_REQUEST_CANDIDATE_CHANGED",
      "The requested canonical refs can no longer be resolved in the reviewed Project scope."
    );
  });
  if (candidates.some((candidate) => candidate.availability !== "available")) {
    throw new AIContextRequestApprovalValidationError(
      "CONTEXT_REQUEST_CANDIDATE_CHANGED",
      "One or more requested refs are no longer available."
    );
  }
  if (
    contextRequestCandidateFingerprint(candidates) !==
    contextRequestCandidateFingerprint(request.reviewedCandidates)
  ) {
    throw new AIContextRequestApprovalValidationError(
      "CONTEXT_REQUEST_CANDIDATE_CHANGED",
      "Canonical Context Request candidates changed after the request was reviewed."
    );
  }
  const requiredBodyIds = requestedBodyFileRefIds(candidates);
  if (!exactIds(requiredBodyIds, input.explicitlyAuthorizedFileRefIds)) {
    throw new AIContextRequestApprovalValidationError(
      "CONTEXT_REQUEST_BODY_AUTHORIZATION_REQUIRED",
      requiredBodyIds.length > 0
        ? "Select exactly the requested FileRefs in the existing attachment control to authorize their bodies for this follow-up call."
        : "Clear staged attachments; this Context Request does not authorize any FileRef body."
    );
  }
  const researchObjects = [...request.source.researchObjects];
  for (const candidate of candidates.filter((item) => item.refKind === "AI_RESEARCH_OBJECT")) {
    if (
      candidate.entityType !== "task" &&
      candidate.entityType !== "review" &&
      candidate.entityType !== "experiment" &&
      candidate.entityType !== "experimentRun" &&
      candidate.entityType !== "literature" &&
      candidate.entityType !== "finding" &&
      candidate.entityType !== "resultItem" &&
      candidate.entityType !== "outputCandidate" &&
      candidate.entityType !== "outputGap" &&
      candidate.entityType !== "researchOutput"
    ) {
      throw new AIContextRequestApprovalValidationError(
        "CONTEXT_REQUEST_CANDIDATE_CHANGED",
        "A requested research object no longer has a supported canonical type."
      );
    }
    researchObjects.push({ objectType: candidate.entityType, objectId: candidate.refId });
  }
  const uniqueResearchObjects = [...new Map(researchObjects.map((selection) => [
    `${selection.objectType}:${selection.objectId}`,
    selection
  ])).values()].sort((left, right) =>
    left.objectType.localeCompare(right.objectType) || left.objectId.localeCompare(right.objectId));
  if (uniqueResearchObjects.length > AI_RESEARCH_OBJECT_SELECTION_MAX) {
    throw new AIContextRequestApprovalValidationError(
      "CONTEXT_REQUEST_SELECTION_LIMIT_EXCEEDED",
      `The approved research-object set exceeds the canonical ${AI_RESEARCH_OBJECT_SELECTION_MAX}-object A2 bound; no truncation is allowed.`
    );
  }
  const selectedMaterials = mergeContextRequestMaterialSelections(
    runScopedTaskMaterials,
    materialSelections(requiredBodyIds, catalog.fileRefs)
  );
  const callerAdditionalSourceRefs = input.additionalSourceRefs ?? [];
  if (callerAdditionalSourceRefs.some((sourceRef) =>
    sourceRef.field === "quickAnalysisContextFollowupAuthorization")) {
    throw new AIContextRequestApprovalValidationError(
      "CONTEXT_REQUEST_SOURCE_STALE",
      "The canonical Quick follow-up authorization receipt cannot be supplied by a caller."
    );
  }
  const followupAdditionalSourceRefs = isRunScopedQuickAnalysis
    ? [
        ...callerAdditionalSourceRefs,
        buildQuickAnalysisFollowupAuthorizationSourceRef({
          request,
          sourceAttempt: sourceAttempt!,
          selectedMaterials,
          approvedCandidates: candidates,
          additionalSourceRefs: callerAdditionalSourceRefs
        })
      ]
    : callerAdditionalSourceRefs;
  let contextPackage: AIContextPackage;
  try {
    contextPackage = await buildAIContext({
      scopeType: "project",
      scopeId: request.source.projectId,
      contextMode: request.source.contextMode,
      researchObjects: uniqueResearchObjects,
      selectedMaterials,
      approvedContextRequestContributions: approvedContributions(candidates),
      budget: { ...request.source.contextBudget }
    });
  } catch (error) {
    if (error instanceof AIContextRequestApprovalValidationError) throw error;
    throw new AIContextRequestApprovalValidationError(
      "CONTEXT_REQUEST_CANONICAL_BUILD_FAILED",
      "The existing A2 ContextPackage finalizer rejected the expanded context safely."
    );
  }
  const contextRequestFollowupState = {
    scope: "SAME_CONVERSATION_APPROVED_FOLLOWUP",
    limit: 1,
    remaining: 0,
    state: "CONTEXT_EXHAUSTED"
  } as const;
  const sourceConstraint = isRunScopedQuickAnalysis
    ? resolveRetryConstraintRequest({
        purpose: "chat_response",
        contextSourceRefs: sourceAttempt?.contextSourceRefs ?? []
      })
    : undefined;
  const outputDetailPreference = sourceAttempt?.budgetSummary?.outputDetailPreference ?? "STANDARD";
  const built = followupPurpose === "parse_draft"
    ? await buildAIParseDraftPromptPackage({
        conversationId: request.conversationId,
        contextPackage,
        technicalCapacityChars: AI_PROVIDER_PROMPT_TECHNICAL_MAX_CHARS,
        readback,
        runScopedDirective: input.runScopedDirective,
        quickAnalysisContextCapability: input.quickAnalysisContextCapability,
        contextRequestFollowupState,
        additionalSourceRefs: followupAdditionalSourceRefs,
        outputDetailPreference
      })
    : await buildConversationPromptPackage({
        conversationId: request.conversationId,
        contextPackage,
        userQuestion: originalUserQuestion,
        constraintRequest: {
          kind: "current",
          category: sourceConstraint
            ? sourceConstraint.kind === "frozen"
              ? sourceConstraint.descriptor.category
              : sourceConstraint.category
            : "NORMAL_QA"
        },
        options: {
          technicalCapacityChars: AI_PROVIDER_PROMPT_TECHNICAL_MAX_CHARS,
          runScopedDirective: input.runScopedDirective,
          quickAnalysisContextCapability: input.quickAnalysisContextCapability,
          contextRequestFollowupState,
          additionalSourceRefs: followupAdditionalSourceRefs,
          outputDetailPreference
        }
      });
  if (
    built.promptPackage.budgetSummary?.technicalCapacity?.status ===
      "TECHNICAL_CAPACITY_OR_SAFETY_ERROR" ||
    built.promptPackage.warnings?.some((warning) =>
      warning.code === "technical_capacity_or_safety_error")
  ) {
    throw new AIContextRequestApprovalValidationError(
      "CONTEXT_REQUEST_CANONICAL_BUILD_FAILED",
      "The approved Context Request exceeds its applicable shared capacity or Parse dynamic-context guard; no input was truncated and no Provider call was allowed."
    );
  }
  assertEffectiveSource(built.readback, request);
  return {
    contextRequestId: request.id,
    sourceMessageId: request.sourceMessageId,
    originalUserQuestion,
    reviewedCandidates: candidates,
    candidateFingerprint: contextRequestCandidateFingerprint(candidates),
    contextPackage,
    promptPackage: built.promptPackage,
    authorizedBodyFileRefIds: selectedMaterials.map((selection) => selection.fileRefId),
    followupPurpose,
    ...(followupPurpose === "parse_draft" && "source" in built
      ? { parseDraftSource: built.source as AIParseDraftSourceSnapshot }
      : {})
  };
}

export function approvalReviewsEqual(
  reviewed: AIContextRequestApprovalReview,
  fresh: AIContextRequestApprovalReview
): boolean {
  return reviewed.contextRequestId === fresh.contextRequestId &&
    reviewed.sourceMessageId === fresh.sourceMessageId &&
    reviewed.originalUserQuestion === fresh.originalUserQuestion &&
    reviewed.candidateFingerprint === fresh.candidateFingerprint &&
    reviewed.followupPurpose === fresh.followupPurpose &&
    Boolean(reviewed.contextPackage.reviewFingerprint) &&
    reviewed.contextPackage.reviewFingerprint === fresh.contextPackage.reviewFingerprint &&
    JSON.stringify(reviewed.promptPackage.constraintDescriptor) ===
      JSON.stringify(fresh.promptPackage.constraintDescriptor) &&
    exactIds(reviewed.authorizedBodyFileRefIds, fresh.authorizedBodyFileRefIds) &&
    (reviewed.parseDraftSource?.discussionFingerprint ?? "") ===
      (fresh.parseDraftSource?.discussionFingerprint ?? "");
}

export function rejectAIContextRequest(
  conversationId: string,
  contextRequestId: string
): Promise<AIConversationReadback> {
  return aiConversationRepository.rejectContextRequest({
    conversationId,
    contextRequestId,
    actionMessageId: createRepositoryEntityId("ai-context-request-reject"),
    decidedAt: new Date().toISOString()
  });
}

export function markAIContextRequestStale(
  conversationId: string,
  contextRequestId: string,
  reason: string
): Promise<AIConversationReadback> {
  return aiConversationRepository.markContextRequestStale({
    conversationId,
    contextRequestId,
    reason,
    decidedAt: new Date().toISOString()
  });
}
