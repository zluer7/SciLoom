import { createRepositoryEntityId } from "../repositories/entityId";
import { aiConversationRepository } from "../repositories/aiConversationRepository";
import type { AIConversationReadback } from "../types/aiConversation";
import type {
  AIMaterialFreshnessReceipt,
  AIContextMaterialSelection,
  AIContextSourceRef
} from "../types/aiContext";
import type { ManuscriptBinding } from "../types";
import type {
  AIStandardResult,
  AIStandardResultEffectReceipt
} from "../types/aiStandardResult";
import {
  buildAIContext,
  resolveAIContextCompositionPolicyForQuickTarget
} from "./aiContextBuilderService";
import { assertAIParseDraftDiscussionStillCurrent } from "./aiParseDraftService";
import {
  canonicalAIStandardResultFingerprint,
  internalAIStandardResultManuscriptEffectId,
  readAIStandardResultBlockingValidationIssues,
  readAIStandardResultManuscriptEffects,
  readAIStandardResultProposalMetadata
} from "./aiStandardResultService";
import {
  invokeAIStandardResultFormalEffect,
  isAIStandardResultContinuable,
  readAIStandardResultFormalEffect,
  validateAIStandardResultProposal
} from "./aiStandardResultAdapterService";
import {
  releaseAIExperimentManuscriptTargetAcceptance
} from "./aiExperimentManuscriptStandardResultAdapter";
import {
  releaseAIExperimentRunManuscriptTargetAcceptance
} from "./aiExperimentRunManuscriptStandardResultAdapter";
import { literatureValidationHasStructuralDrift } from "./aiLiteratureStandardResultAdapter";
import {
  literatureManuscriptValidationHasStructuralDrift,
  releaseAILiteratureManuscriptTargetAcceptance
} from "./aiLiteratureOutlineManuscriptStandardResultAdapter";
import { candidateManuscriptService } from "./candidateManuscriptService";
import { fileRefService } from "./fileRefService";
import { manuscriptBindingService } from "./manuscriptBindingService";
import { manuscriptIoService } from "./manuscriptIoService";
import { parseLabPodMarkdownDocument } from "./labPodMarkdownDocumentService";
import { buildLiteratureManuscriptView } from "./literatureManuscriptAdapterService";
import type { QuickAnalysisOwnerType, QuickAnalysisChannel } from "./quickAnalysisCapabilityBinding";
import { resolveQuickAnalysisCapabilityBinding } from "./quickAnalysisCapabilityBinding";
import { saveQuickAnalysisCandidateThroughLocalPort } from "./quickAnalysisCandidateApplicationPorts";
import { planningService } from "./planningService";

async function releaseManuscriptTargetAcceptance(result: AIStandardResult) {
  const effectIds = result.action === "NEW_MANUSCRIPT"
    ? []
    : readAIStandardResultManuscriptEffects(result.visiblePayload, {
        action: result.action,
        target: result.target
      }).map((effect) => internalAIStandardResultManuscriptEffectId(result.id, effect.channel));
  await Promise.all([
    ...[result.id, ...effectIds].map(async (resultId) => {
      await Promise.all([
        releaseAIExperimentManuscriptTargetAcceptance(resultId),
        releaseAIExperimentRunManuscriptTargetAcceptance(resultId),
        releaseAILiteratureManuscriptTargetAcceptance(resultId)
      ]);
    })
  ]);
}

export class AIStandardResultDecisionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly authoritativeReadback?: AIConversationReadback
  ) {
    super(message);
    this.name = "AIStandardResultDecisionError";
  }
}

function requireResult(readback: AIConversationReadback, resultId: string): AIStandardResult {
  const result = readback.standardResults.find((candidate) => candidate.id === resultId);
  if (!result) {
    throw new AIStandardResultDecisionError(
      "STANDARD_RESULT_NOT_FOUND",
      "The canonical Standard Result is unavailable.",
      readback
    );
  }
  return result;
}

function assertPending(result: AIStandardResult) {
  if (result.disposition !== "PENDING" || result.confirmationStartedAt) {
    throw new AIStandardResultDecisionError(
      "STANDARD_RESULT_TERMINAL_CONFLICT",
      "This Standard Result already has a terminal or in-flight decision."
    );
  }
}

const EXPERIMENT_STALE_VALIDATION_CODES = new Set([
  "EXPERIMENT_SOURCE_SCOPE_REQUIRED",
  "EXPERIMENT_SOURCE_SCOPE_MISMATCH",
  "EXPERIMENT_TARGET_OUTSIDE_FROZEN_SCOPE",
  "EXPERIMENT_SOURCE_UNAVAILABLE",
  "EXPERIMENT_SCOPE_MISMATCH",
  "EXPERIMENT_PROJECT_UNAVAILABLE",
  "EXPERIMENT_TARGET_UNAVAILABLE",
  "EXPERIMENT_TARGET_LIFECYCLE_UNSUPPORTED",
  "EXPERIMENT_TARGET_STALE",
  "EXPERIMENT_ROUTE_SCOPE_MISMATCH",
  "EXPERIMENT_TASK_SCOPE_MISMATCH",
  "EXPERIMENT_RELATION_CONFLICT",
  "EXPERIMENT_MANUSCRIPT_OWNER_UNAVAILABLE",
  "EXPERIMENT_MANUSCRIPT_SCOPE_MISMATCH",
  "EXPERIMENT_MANUSCRIPT_PROJECT_UNAVAILABLE",
  "EXPERIMENT_MANUSCRIPT_LIFECYCLE_INELIGIBLE",
  "EXPERIMENT_MANUSCRIPT_BINDING_CONFLICT",
  "EXPERIMENT_MANUSCRIPT_BINDING_UNAVAILABLE",
  "EXPERIMENT_MANUSCRIPT_BINDING_INCOMPLETE",
  "EXPERIMENT_MANUSCRIPT_BINDING_IDENTITY_DRIFT",
  "EXPERIMENT_MANUSCRIPT_TARGET_STALE",
  "EXPERIMENT_RUN_SOURCE_SCOPE_REQUIRED",
  "EXPERIMENT_RUN_SOURCE_SCOPE_MISMATCH",
  "EXPERIMENT_RUN_SOURCE_UNAVAILABLE",
  "EXPERIMENT_RUN_PARENT_RELATION_MISMATCH",
  "EXPERIMENT_RUN_CREATE_PARENT_AMBIGUOUS",
  "EXPERIMENT_RUN_PARENT_UNAVAILABLE",
  "EXPERIMENT_RUN_PARENT_PROJECT_MISMATCH",
  "EXPERIMENT_RUN_PROJECT_UNAVAILABLE",
  "EXPERIMENT_RUN_TARGET_OUTSIDE_FROZEN_SCOPE",
  "EXPERIMENT_RUN_TARGET_UNAVAILABLE",
  "EXPERIMENT_RUN_TARGET_PARENT_PROJECT_MISMATCH",
  "EXPERIMENT_RUN_RESOLVED_TARGET_STALE",
  "EXPERIMENT_RUN_TARGET_STALE",
  "EXPERIMENT_RUN_MANUSCRIPT_OWNER_UNAVAILABLE",
  "EXPERIMENT_RUN_MANUSCRIPT_SCOPE_MISMATCH",
  "EXPERIMENT_RUN_MANUSCRIPT_PARENT_UNAVAILABLE",
  "EXPERIMENT_RUN_MANUSCRIPT_PARENT_SCOPE_MISMATCH",
  "EXPERIMENT_RUN_MANUSCRIPT_PROJECT_UNAVAILABLE",
  "EXPERIMENT_RUN_MANUSCRIPT_LIFECYCLE_INELIGIBLE",
  "EXPERIMENT_RUN_MANUSCRIPT_BINDING_CONFLICT",
  "EXPERIMENT_RUN_MANUSCRIPT_BINDING_UNAVAILABLE",
  "EXPERIMENT_RUN_MANUSCRIPT_BINDING_INCOMPLETE",
  "EXPERIMENT_RUN_MANUSCRIPT_BINDING_IDENTITY_DRIFT",
  "EXPERIMENT_RUN_MANUSCRIPT_TARGET_STALE"
]);

const FINDING_STALE_VALIDATION_CODES = new Set([
  "FINDING_PROJECT_UNAVAILABLE",
  "FINDING_PROJECT_SCOPE_MISMATCH",
  "FINDING_ROUTE_UNAVAILABLE",
  "FINDING_ROUTE_PROJECT_MISMATCH",
  "FINDING_TASK_UNAVAILABLE",
  "FINDING_TASK_PROJECT_MISMATCH",
  "FINDING_EXPERIMENT_UNAVAILABLE",
  "FINDING_EXPERIMENT_PROJECT_MISMATCH",
  "FINDING_RESULT_ITEM_UNAVAILABLE",
  "FINDING_RESULT_ITEM_PROJECT_MISMATCH"
]);

function experimentValidationHasStructuralDrift(result: AIStandardResult, validation: {
  validationIssues: Array<{ code: string }>;
}): boolean {
  return (result.target.module === "experiment" || result.target.module === "experimentRun") && validation.validationIssues.some(
    (candidate) => EXPERIMENT_STALE_VALIDATION_CODES.has(candidate.code)
  );
}

function validationHasStructuralDrift(result: AIStandardResult, validation: {
  validationIssues: Array<{ code: string }>;
}): boolean {
  return experimentValidationHasStructuralDrift(result, validation) ||
    result.target.module === "literature" && (
      literatureValidationHasStructuralDrift(validation) ||
      literatureManuscriptValidationHasStructuralDrift(validation)
    ) || result.target.module === "finding" && validation.validationIssues.some(
      (candidate) => FINDING_STALE_VALIDATION_CODES.has(candidate.code)
    );
}

const FROZEN_OUTPUT_CONTEXT_OBJECT_TYPES = new Set([
  "resultItem",
  "outputCandidate",
  "outputGap",
  "researchOutput"
]);

export function isAIStandardResultFrozenOutputContextSourceRef(
  sourceRef: AIContextSourceRef
): boolean {
  const expectedModule = sourceRef.entityType === "researchOutput"
    ? "output"
    : "outputConversion";
  return sourceRef.contextDisposition === "included" &&
    sourceRef.contextRole === "primary" &&
    sourceRef.module === expectedModule &&
    sourceRef.isVerified === true &&
    FROZEN_OUTPUT_CONTEXT_OBJECT_TYPES.has(sourceRef.entityType) &&
    typeof sourceRef.entityId === "string" && Boolean(sourceRef.entityId.trim());
}

function frozenOutputContextObjects(
  result: AIStandardResult,
  readback: AIConversationReadback
) {
  const parseAttempt = readback.callAttempts.find((attempt) =>
    attempt.id === result.parseCallAttemptId &&
    attempt.conversationId === result.conversationId &&
    attempt.purpose === "parse_draft" &&
    attempt.status === "succeeded"
  );
  if (!parseAttempt) return [];
  const seen = new Set<string>();
  return parseAttempt.contextSourceRefs.flatMap((sourceRef) => {
    if (!isAIStandardResultFrozenOutputContextSourceRef(sourceRef)) {
      return [];
    }
    const identity = `${sourceRef.entityType}\u0000${sourceRef.entityId}`;
    if (seen.has(identity)) return [];
    seen.add(identity);
    return [{
      objectType: sourceRef.entityType as "resultItem" | "outputCandidate" | "outputGap" | "researchOutput",
      objectId: sourceRef.entityId
    }];
  });
}

export function hasAIStandardResultConfirmedCreateSiblingBaseline(
  result: AIStandardResult,
  readback: AIConversationReadback
): boolean {
  return result.action === "CREATE" && readback.standardResults.some((candidate) => (
    candidate.id !== result.id &&
    candidate.batchId === result.batchId &&
    candidate.parseCallAttemptId === result.parseCallAttemptId &&
    candidate.disposition === "CONFIRMED" &&
    Boolean(candidate.effectReceipt) &&
    candidate.source.projectId === result.source.projectId &&
    candidate.source.discussionFingerprint === result.source.discussionFingerprint &&
    candidate.source.contextReviewFingerprint === result.source.contextReviewFingerprint
  ));
}

/**
 * A confirmed same-batch business effect is an admitted evolution of the
 * frozen multi-object Context, not an unrelated external drift. UPDATE
 * siblings additionally require their own frozen target snapshot so the
 * owner-local adapter remains the stale authority at execution time.
 */
export function hasAIStandardResultConfirmedSiblingBaseline(
  result: AIStandardResult,
  readback: AIConversationReadback
): boolean {
  if (
    result.action !== "CREATE" &&
    (result.action !== "UPDATE" || !result.targetSnapshotFingerprint)
  ) return false;
  return readback.standardResults.some((candidate) => {
    const receipt = candidate.effectReceipt;
    const receiptMatchesCandidate = Boolean(
      receipt && receipt.entityId && receipt.operation === candidate.action &&
      receipt.module === candidate.target.module &&
      receipt.entityType === candidate.target.entityType &&
      (candidate.action === "CREATE" || candidate.target.entityId === receipt.entityId)
    );
    return candidate.id !== result.id &&
      candidate.batchId === result.batchId &&
      candidate.parseCallAttemptId === result.parseCallAttemptId &&
      candidate.disposition === "CONFIRMED" && receiptMatchesCandidate &&
      candidate.source.projectId === result.source.projectId &&
      candidate.source.discussionFingerprint === result.source.discussionFingerprint &&
      candidate.source.contextReviewFingerprint === result.source.contextReviewFingerprint;
  });
}

export async function resolveAIStandardResultSiblingExecutionView(
  result: AIStandardResult,
  readback: AIConversationReadback
): Promise<AIStandardResult> {
  if (result.action !== "CREATE" || result.target.module !== "experimentRun") return result;
  const metadata = readAIStandardResultProposalMetadata(result.originalPayload);
  if (!metadata?.parentProposalRef) return result;
  const sibling = readback.standardResults.find((candidate) => {
    const candidateMetadata = readAIStandardResultProposalMetadata(candidate.originalPayload);
    return candidate.id !== result.id && candidate.batchId === result.batchId &&
      candidate.parseCallAttemptId === result.parseCallAttemptId &&
      candidate.ordinal < result.ordinal && candidate.category === "DATA_OPERATION" &&
      candidate.action === "CREATE" && candidate.target.module === "experiment" &&
      candidate.target.projectId === result.target.projectId &&
      candidateMetadata?.proposalRef === metadata.parentProposalRef;
  });
  if (!sibling) {
    throw new AIStandardResultDecisionError(
      "STANDARD_RESULT_SIBLING_PARENT_INVALID",
      "同批实验运行没有可验证的上游实验建议。",
      readback
    );
  }
  const receipt = sibling.effectReceipt;
  if (
    sibling.disposition !== "CONFIRMED" || !receipt || receipt.module !== "experiment" ||
    receipt.entityType !== "experiment" || receipt.operation !== "CREATE"
  ) {
    throw new AIStandardResultDecisionError(
      "STANDARD_RESULT_SIBLING_PARENT_NOT_READY",
      "请先确认并执行同批所属实验，再执行这条实验运行建议。",
      readback
    );
  }
  const project = await planningService.getProjectById(result.target.projectId);
  if (!project || project.deletedAt || project.status === "archived") {
    throw new AIStandardResultDecisionError(
      "STANDARD_RESULT_SIBLING_PARENT_STALE",
      "同批实验运行所属课题已不可用。",
      readback
    );
  }
  const parentLabel = typeof receipt.canonicalReadback.title === "string" && receipt.canonicalReadback.title.trim()
    ? receipt.canonicalReadback.title
    : typeof sibling.visiblePayload.title === "string" && sibling.visiblePayload.title.trim()
      ? sibling.visiblePayload.title
      : "同批实验";
  return {
    ...result,
    target: {
      module: "experimentRun",
      projectId: result.target.projectId,
      entityType: "experimentRun",
      parentExperimentId: receipt.entityId,
      parentExperimentLabel: parentLabel,
      projectLabel: project.title
    },
    source: {
      ...result.source,
      selectedExperimentIds: [receipt.entityId]
    }
  };
}

async function rebuildSourceContext(
  result: AIStandardResult,
  readback: AIConversationReadback
) {
  const catalog = await aiConversationRepository.listAttachmentFileRefs();
  const selectedMaterials: AIContextMaterialSelection[] = result.source.authorizedMaterialFileRefIds.map(
    (fileRefId) => {
      const fileRef = catalog.fileRefs.find((candidate) => candidate.fileRefId === fileRefId);
      if (
        !fileRef || fileRef.resourceKind !== "file" ||
        fileRef.availabilityStatus !== "available" || fileRef.materialReadStatus !== "supported" ||
        !Number.isSafeInteger(fileRef.materialPromptReservationCharacters) ||
        (fileRef.materialPromptReservationCharacters ?? 0) <= 0 ||
        !fileRef.materialFreshnessReceipt ||
        fileRef.materialFreshnessReceipt.fileRefId !== fileRefId
      ) {
        throw new AIStandardResultDecisionError(
          "STANDARD_RESULT_CONTEXT_STALE",
          "A selected FileRef is no longer available in the reviewed A2 context."
        );
      }
      return {
        fileRefId,
        displayName: fileRef.displayName,
        availabilityStatus: fileRef.availabilityStatus,
        materialReadStatus: fileRef.materialReadStatus,
        materialPromptReservationCharacters: fileRef.materialPromptReservationCharacters!,
        materialFreshnessReceipt: { ...fileRef.materialFreshnessReceipt }
      };
    }
  );
  const researchObjects = [
    ...(result.source.selectedRouteIds ?? []).map((objectId) => ({ objectType: "route" as const, objectId })),
    ...result.source.selectedTaskIds.map((objectId) => ({ objectType: "task" as const, objectId })),
    ...result.source.selectedReviewIds.map((objectId) => ({ objectType: "review" as const, objectId })),
    ...result.source.selectedExperimentIds.map((objectId) => ({ objectType: "experiment" as const, objectId })),
    ...result.source.selectedExperimentRunIds.map((objectId) => ({ objectType: "experimentRun" as const, objectId })),
    ...result.source.selectedLiteratureIds.map((objectId) => ({ objectType: "literature" as const, objectId })),
    ...(result.source.selectedFindingIds ?? []).map((objectId) => ({ objectType: "finding" as const, objectId })),
    ...frozenOutputContextObjects(result, readback),
    ...(result.source.quickAnalysisTarget?.ownerType === "resultItem"
      ? [{ objectType: "resultItem" as const, objectId: result.source.quickAnalysisTarget.ownerId }]
      : result.source.quickAnalysisTarget?.ownerType === "outputCandidate"
        ? [{ objectType: "outputCandidate" as const, objectId: result.source.quickAnalysisTarget.ownerId }]
        : result.source.quickAnalysisTarget?.ownerType === "outputGap"
          ? [{ objectType: "outputGap" as const, objectId: result.source.quickAnalysisTarget.ownerId }]
          : result.source.quickAnalysisTarget?.ownerType === "researchOutput"
            ? [{ objectType: "researchOutput" as const, objectId: result.source.quickAnalysisTarget.ownerId }]
            : [])
  ];
  if (result.source.approvedContextRequestContributions.length > 0) {
    researchObjects.sort((left, right) =>
      left.objectType.localeCompare(right.objectType) || left.objectId.localeCompare(right.objectId));
  }
  const contextPackage = await buildAIContext({
    scopeType: "project",
    scopeId: result.source.projectId,
    contextMode: result.source.contextMode,
    researchObjects,
    selectedMaterials,
    approvedContextRequestContributions: result.source.approvedContextRequestContributions.map(
      (contribution) => ({ ...contribution })
    ),
    ...(resolveAIContextCompositionPolicyForQuickTarget(result.source.quickAnalysisTarget)
      ? {
          compositionPolicy: resolveAIContextCompositionPolicyForQuickTarget(
            result.source.quickAnalysisTarget
          )
        }
      : {}),
    budget: { ...result.source.contextBudget }
  });
  const confirmedSiblingEstablishedBatchBaseline =
    hasAIStandardResultConfirmedSiblingBaseline(result, readback);
  if (
    contextPackage.reviewFingerprint !== result.source.contextReviewFingerprint &&
    !confirmedSiblingEstablishedBatchBaseline
  ) {
    throw new AIStandardResultDecisionError(
      "STANDARD_RESULT_CONTEXT_STALE",
      "The selected canonical A2 context changed after Parse Draft; re-parse is required."
    );
  }
}

function assertParseAttempt(readback: AIConversationReadback, result: AIStandardResult) {
  const attempt = readback.callAttempts.find((candidate) => candidate.id === result.parseCallAttemptId);
  if (
    !attempt || attempt.conversationId !== result.conversationId ||
    attempt.purpose !== "parse_draft" || attempt.status !== "succeeded"
  ) {
    throw new AIStandardResultDecisionError(
      "STANDARD_RESULT_PARSE_ATTEMPT_MISMATCH",
      "The source PARSE_DRAFT CallAttempt is unavailable or mismatched."
    );
  }
  const supersedingAttempt = readback.callAttempts.find((candidate) =>
    candidate.purpose === "parse_draft" && candidate.status === "succeeded" &&
    candidate.sequence > attempt.sequence && candidate.contextSourceRefs.some((sourceRef) =>
      sourceRef.parseDiscussionFingerprint === result.source.discussionFingerprint));
  if (supersedingAttempt) {
    throw new AIStandardResultDecisionError(
      "STANDARD_RESULT_PARSE_ATTEMPT_SUPERSEDED",
      "A newer terminal Parse Draft attempt superseded this Result source."
    );
  }
}

async function markDecisionFailure(
  result: AIStandardResult,
  error: unknown,
  authorizationId?: string
): Promise<AIConversationReadback> {
  const typed = error instanceof AIStandardResultDecisionError ? error : undefined;
  const stale = typed?.code.includes("STALE") || typed?.code.includes("MISMATCH") || typed?.code.includes("SUPERSEDED");
  return aiConversationRepository.failStandardResult({
    conversationId: result.conversationId,
    resultId: result.id,
    ...(authorizationId ? { authorizationId } : {}),
    failureCode: typed?.code ?? "STANDARD_RESULT_EFFECT_FAILED",
    failureMessage: error instanceof Error ? error.message : "The Standard Result effect failed safely.",
    disposition: stale ? "STALE" : "FAILED",
    failedAt: new Date().toISOString()
  });
}

export async function updateAIStandardResultVisiblePayload(input: {
  conversationId: string;
  resultId: string;
  expectedVisiblePayloadFingerprint: string;
  visiblePayload: Record<string, unknown>;
  fallbackSections?: readonly string[];
}): Promise<AIConversationReadback> {
  const readback = await aiConversationRepository.readConversation(input.conversationId);
  const result = requireResult(readback, input.resultId);
  assertPending(result);
  if (result.visiblePayloadFingerprint !== input.expectedVisiblePayloadFingerprint) {
    throw new AIStandardResultDecisionError(
      "STANDARD_RESULT_VISIBLE_PAYLOAD_STALE",
      "The visible payload changed before this edit was saved.",
      readback
    );
  }
  await releaseManuscriptTargetAcceptance(result);
  const executionResult = await resolveAIStandardResultSiblingExecutionView(result, readback);
  const validation = await validateAIStandardResultProposal({
    action: executionResult.action,
    target: executionResult.target,
    source: executionResult.source,
    payload: input.visiblePayload,
    expectedProjectId: result.source.projectId,
    expectedTargetSnapshotFingerprint: result.targetSnapshotFingerprint,
    fallbackSections: input.fallbackSections
  });
  const visiblePayload = structuredClone(validation.normalizedPayload);
  const fingerprint = canonicalAIStandardResultFingerprint(visiblePayload);
  return aiConversationRepository.updateStandardResultDraft({
    conversationId: input.conversationId,
    resultId: result.id,
    expectedVisiblePayloadFingerprint: result.visiblePayloadFingerprint,
    visiblePayload,
    visiblePayloadFingerprint: fingerprint,
    validationIssues: validation.validationIssues,
    updatedAt: new Date().toISOString()
  });
}

export async function dismissAIStandardResult(input: {
  conversationId: string;
  resultId: string;
  expectedVisiblePayloadFingerprint: string;
}): Promise<AIConversationReadback> {
  const current = await aiConversationRepository.readConversation(input.conversationId);
  const result = requireResult(current, input.resultId);
  const readback = await aiConversationRepository.dismissStandardResult({
    conversationId: input.conversationId,
    resultId: input.resultId,
    expectedVisiblePayloadFingerprint: input.expectedVisiblePayloadFingerprint,
    decidedAt: new Date().toISOString()
  });
  await releaseManuscriptTargetAcceptance(result);
  return readback;
}

async function confirmAIStandardResultOnce(input: {
  conversationId: string;
  resultId: string;
  expectedVisiblePayloadFingerprint: string;
}): Promise<AIConversationReadback> {
  let readback = await aiConversationRepository.readConversation(input.conversationId);
  let result = requireResult(readback, input.resultId);
  assertPending(result);
  if (result.visiblePayloadFingerprint !== input.expectedVisiblePayloadFingerprint) {
    throw new AIStandardResultDecisionError(
      "STANDARD_RESULT_VISIBLE_PAYLOAD_STALE",
      "Confirm requires the latest visible edited payload fingerprint.",
      readback
    );
  }
  let formalEffectStarted = false;
  try {
    assertParseAttempt(readback, result);
    try {
      assertAIParseDraftDiscussionStillCurrent(readback, result.source);
    } catch (error) {
      throw new AIStandardResultDecisionError(
        "STANDARD_RESULT_DISCUSSION_STALE",
        error instanceof Error
          ? error.message
          : "The selected semantic discussion changed after Parse Draft."
      );
    }
    await rebuildSourceContext(result, readback);
    let executionResult = await resolveAIStandardResultSiblingExecutionView(result, readback);
    let validation = await validateAIStandardResultProposal({
      action: executionResult.action,
      target: executionResult.target,
      source: executionResult.source,
      payload: result.visiblePayload,
      expectedProjectId: result.source.projectId,
      expectedTargetSnapshotFingerprint: result.targetSnapshotFingerprint
    });
    if (!validation.executable || readAIStandardResultBlockingValidationIssues(validation.validationIssues).length > 0) {
      if (validationHasStructuralDrift(result, validation)) {
        throw new AIStandardResultDecisionError(
          result.target.module === "literature"
            ? "STANDARD_RESULT_LITERATURE_SCOPE_STALE"
            : result.target.module === "finding"
              ? "STANDARD_RESULT_FINDING_SCOPE_STALE"
              : "STANDARD_RESULT_EXPERIMENT_SCOPE_STALE",
          validation.validationIssues.map((candidate) => candidate.message).join(" ") ||
            "The frozen source or target changed after Parse Draft."
        );
      }
      if (
        result.target.module === "experiment" ||
        result.target.module === "experimentRun" ||
        result.target.module === "literature" ||
        result.target.module === "finding"
      ) {
        return aiConversationRepository.updateStandardResultDraft({
          conversationId: input.conversationId,
          resultId: result.id,
          expectedVisiblePayloadFingerprint: result.visiblePayloadFingerprint,
          visiblePayload: structuredClone(result.visiblePayload),
          visiblePayloadFingerprint: result.visiblePayloadFingerprint,
          validationIssues: validation.validationIssues,
          updatedAt: new Date().toISOString()
        });
      }
      throw new AIStandardResultDecisionError(
        "STANDARD_RESULT_VISIBLE_PAYLOAD_INVALID",
        validation.validationIssues.map((candidate) => candidate.message).join(" ") ||
          "The visible Standard Result payload is not executable."
      );
    }
    const exactVisibleFingerprint = canonicalAIStandardResultFingerprint(result.visiblePayload);
    if (exactVisibleFingerprint !== result.visiblePayloadFingerprint) {
      throw new AIStandardResultDecisionError(
        "STANDARD_RESULT_VISIBLE_PAYLOAD_STALE",
        "The visible payload fingerprint does not match canonical readback."
      );
    }
    // Nested manuscript effects settle through the frozen managed Candidate
    // writer. A native Save-As target is not part of this execution contract.
    const authorizationId = createRepositoryEntityId("ai-standard-result-authorization");
    readback = await aiConversationRepository.beginStandardResultConfirmation({
      conversationId: input.conversationId,
      resultId: result.id,
      parseCallAttemptId: result.parseCallAttemptId,
      expectedVisiblePayloadFingerprint: result.visiblePayloadFingerprint,
      authorizationId,
      confirmedPayload: structuredClone(result.visiblePayload),
      confirmedPayloadFingerprint: exactVisibleFingerprint,
      startedAt: new Date().toISOString()
    });
    result = requireResult(readback, result.id);
    if (!result.authorizationId || !result.confirmationStartedAt || !result.confirmedPayload) {
      throw new AIStandardResultDecisionError(
        "STANDARD_RESULT_CONFIRM_GUARD_FAILED",
        "The durable confirmation claim is incomplete at the formal-effect boundary."
      );
    }
    executionResult = await resolveAIStandardResultSiblingExecutionView(result, readback);
    validation = await validateAIStandardResultProposal({
      action: executionResult.action,
      target: executionResult.target,
      source: executionResult.source,
      payload: result.confirmedPayload,
      expectedProjectId: result.source.projectId,
      expectedTargetSnapshotFingerprint: result.targetSnapshotFingerprint
    });
    if (!validation.executable || readAIStandardResultBlockingValidationIssues(validation.validationIssues).length > 0) {
      throw new AIStandardResultDecisionError(
        result.target.module === "experiment" || result.target.module === "experimentRun" ||
        result.target.module === "literature" || result.target.module === "finding"
          ? result.target.module === "literature"
            ? "STANDARD_RESULT_LITERATURE_SCOPE_STALE"
            : result.target.module === "finding"
              ? "STANDARD_RESULT_FINDING_SCOPE_STALE"
              : "STANDARD_RESULT_EXPERIMENT_SCOPE_STALE"
          : "STANDARD_RESULT_CONFIRM_GUARD_FAILED",
        "The proposal changed or became invalid at the formal-effect boundary."
      );
    }
    formalEffectStarted = true;
    const effect = await invokeAIStandardResultFormalEffect({
      result: executionResult,
      durableParentResult: result,
      normalizedPayload: validation.normalizedPayload,
      invocationMode: "initial"
    });
    if (effect.kind === "pending") {
      const recoveredEffect = await readAIStandardResultFormalEffect(executionResult, result);
      if (!recoveredEffect) {
        return aiConversationRepository.readConversation(input.conversationId);
      }
      return aiConversationRepository.settleStandardResultEffect({
        conversationId: input.conversationId,
        resultId: result.id,
        authorizationId,
        effectReceipt: recoveredEffect,
        settledAt: new Date().toISOString()
      });
    }
    if (effect.kind === "no_effect_failure") {
      return markDecisionFailure(
        result,
        new AIStandardResultDecisionError(effect.code, effect.message),
        result.authorizationId
      );
    }
    return await aiConversationRepository.settleStandardResultEffect({
      conversationId: input.conversationId,
      resultId: result.id,
      authorizationId,
      effectReceipt: effect.receipt,
      settledAt: new Date().toISOString()
    });
  } catch (error) {
    if (
      error instanceof AIStandardResultDecisionError &&
      error.code === "STANDARD_RESULT_SIBLING_PARENT_NOT_READY"
    ) {
      throw error;
    }
    if (
      formalEffectStarted &&
      (
        result.target.module === "review" ||
        result.target.module === "experiment" ||
        result.target.module === "experimentRun" ||
        result.target.module === "literature" ||
        result.target.module === "finding"
      )
    ) {
      return aiConversationRepository.readConversation(input.conversationId);
    }
    const authorizationId = result.authorizationId;
    try {
      return await markDecisionFailure(result, error, authorizationId);
    } catch {
      throw error;
    }
  }
}

const confirmationFlights = new Map<string, Promise<AIConversationReadback>>();

export type QuickAnalysisCandidateApplicationOutcome =
  | {
      kind: "settled";
      readback: AIConversationReadback;
      receipt: AIStandardResultEffectReceipt;
      candidateFileRefId: string;
    }
  | {
      kind: "no_effect_failure";
      readback: AIConversationReadback;
      code: string;
      message: string;
    }
  | {
      kind: "terminal_effect_outcome_unknown";
      readback: AIConversationReadback;
      code: "TERMINAL_EFFECT_OUTCOME_UNKNOWN";
      message: string;
      candidateFileRefId?: string;
    };

function exactBindingProjection(binding: ManuscriptBinding) {
  return {
    id: binding.id,
    ownerType: binding.ownerType,
    ownerId: binding.ownerId,
    manuscriptChannel: binding.manuscriptChannel,
    defaultFolderFileRefId: binding.defaultFolderFileRefId ?? null,
    defaultManuscriptFileRefId: binding.defaultManuscriptFileRefId ?? null,
    currentFileRefId: binding.currentFileRefId ?? null,
    updatedAt: binding.updatedAt
  };
}

function exactRecord(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function readQuickAnalysisConversationOrFallback(
  conversationId: string,
  fallback: AIConversationReadback
) {
  try {
    return await aiConversationRepository.readConversation(conversationId);
  } catch {
    return fallback;
  }
}

async function readActiveQuickAnalysisCandidateRefs(
  ownerType: QuickAnalysisOwnerType,
  ownerId: string,
  requestId: string
) {
  try {
    return (await fileRefService.getCandidateFileRefsByRequestId(
      ownerType,
      ownerId,
      requestId
    )).filter((candidate) => !candidate.deletedAt);
  } catch {
    return undefined;
  }
}

/**
 * A6 derived effect entry inside the existing StandardResult application owner.
 * It calls the sole candidate service at most once; all later work is readback only.
 */
export async function applyCanonicalQuickAnalysisCandidateStandardResult(input: {
  runId: string;
  conversationId: string;
  resultId: string;
  parseCallAttemptId: string;
  ownerType: QuickAnalysisOwnerType;
  ownerId: string;
  channel: QuickAnalysisChannel;
  projectId: string;
  sourceFileRefId: string;
  sourceDirectoryFileRefId: string;
  sourceDirectoryPathIdentityKey: string;
  sourceFreshnessReceipt: AIMaterialFreshnessReceipt;
  bindingBaseline: ManuscriptBinding;
}): Promise<QuickAnalysisCandidateApplicationOutcome> {
  const capabilityBinding = resolveQuickAnalysisCapabilityBinding({
    ownerType: input.ownerType,
    channel: input.channel
  });
  let readback = await aiConversationRepository.readConversation(input.conversationId);
  let result = requireResult(readback, input.resultId);
  assertPending(result);
  const exactParseResults = readback.standardResults.filter((candidate) =>
    candidate.parseCallAttemptId === input.parseCallAttemptId);
  if (
    exactParseResults.length !== 1 || exactParseResults[0]?.id !== result.id ||
    result.parseCallAttemptId !== input.parseCallAttemptId ||
    result.category !== "MANUSCRIPT_RESULT" || result.action !== "NEW_MANUSCRIPT" ||
    result.target.module !== input.ownerType || result.target.entityType !== input.ownerType ||
    result.target.entityId !== input.ownerId || result.target.projectId !== input.projectId ||
    result.target.manuscriptChannel !== input.channel ||
    !result.source.quickAnalysisTarget ||
    result.source.quickAnalysisTarget.ownerType !== input.ownerType ||
    result.source.quickAnalysisTarget.ownerId !== input.ownerId ||
    result.source.quickAnalysisTarget.channel !== input.channel ||
    result.source.quickAnalysisTarget.projectOrScopeId !== input.projectId ||
    result.source.quickAnalysisTarget.sourceFileRefId !== input.sourceFileRefId ||
    result.source.quickAnalysisTarget.sourceDirectoryFileRefId !== input.sourceDirectoryFileRefId
  ) {
    throw new AIStandardResultDecisionError(
      "QUICK_ANALYSIS_CANDIDATE_RESULT_NOT_EXACT",
      "Quick Analysis requires exactly one NEW_MANUSCRIPT result for its frozen exact owner/channel Parse Draft target.",
      readback
    );
  }
  assertParseAttempt(readback, result);
  try {
    assertAIParseDraftDiscussionStillCurrent(readback, result.source);
  } catch (error) {
    throw new AIStandardResultDecisionError(
      "STANDARD_RESULT_DISCUSSION_STALE",
      error instanceof Error ? error.message : "The Quick Analysis discussion changed before publication."
    );
  }
  await rebuildSourceContext(result, readback);
  let validation = await validateAIStandardResultProposal({
    action: result.action,
    target: result.target,
    source: result.source,
    payload: result.visiblePayload,
    expectedProjectId: result.source.projectId,
    expectedTargetSnapshotFingerprint: result.targetSnapshotFingerprint
  });
  if (!validation.executable || readAIStandardResultBlockingValidationIssues(validation.validationIssues).length > 0 ||
    typeof validation.normalizedPayload.body !== "string") {
    const message = validation.validationIssues.map((candidate) => candidate.message).join(" ") ||
      "The canonical manuscript result is not executable.";
    const failed = await markDecisionFailure(
      result,
      new AIStandardResultDecisionError("QUICK_ANALYSIS_CANDIDATE_RESULT_INVALID", message)
    );
    return { kind: "no_effect_failure", readback: failed, code: "QUICK_ANALYSIS_CANDIDATE_RESULT_INVALID", message };
  }
  const beforeBinding = await manuscriptBindingService.getBindingByOwner(
    input.ownerType,
    input.ownerId,
    input.channel
  );
  const literatureSiblingChannel = input.ownerType === "literature"
    ? input.channel === "literature_outline" ? "dedicated_notes" as const : "literature_outline" as const
    : undefined;
  const literatureSiblingBindingBefore = literatureSiblingChannel
    ? await manuscriptBindingService.getBindingByOwner("literature", input.ownerId, literatureSiblingChannel)
    : undefined;
  if (!beforeBinding || !exactRecord(
    exactBindingProjection(beforeBinding),
    exactBindingProjection(input.bindingBaseline)
  )) {
    const message = "The exact owner/channel Binding changed after Quick Analysis preflight.";
    const failed = await markDecisionFailure(
      result,
      new AIStandardResultDecisionError("QUICK_ANALYSIS_BINDING_STALE", message)
    );
    return { kind: "no_effect_failure", readback: failed, code: "QUICK_ANALYSIS_BINDING_STALE", message };
  }
  const exactVisibleFingerprint = canonicalAIStandardResultFingerprint(result.visiblePayload);
  if (exactVisibleFingerprint !== result.visiblePayloadFingerprint) {
    throw new AIStandardResultDecisionError(
      "STANDARD_RESULT_VISIBLE_PAYLOAD_STALE",
      "The Quick Analysis candidate payload fingerprint changed before publication."
    );
  }
  const authorizationId = `quick-analysis-run-authorization:${input.runId}`;
  readback = await aiConversationRepository.beginStandardResultConfirmation({
    conversationId: input.conversationId,
    resultId: result.id,
    parseCallAttemptId: result.parseCallAttemptId,
    expectedVisiblePayloadFingerprint: result.visiblePayloadFingerprint,
    authorizationId,
    confirmedPayload: structuredClone(result.visiblePayload),
    confirmedPayloadFingerprint: exactVisibleFingerprint,
    startedAt: new Date().toISOString()
  });
  result = requireResult(readback, result.id);
  if (
    result.authorizationId !== authorizationId || !result.confirmationStartedAt ||
    !result.confirmedPayload || result.confirmedPayloadFingerprint !== exactVisibleFingerprint
  ) {
    throw new AIStandardResultDecisionError(
      "QUICK_ANALYSIS_DERIVED_AUTHORIZATION_GUARD_FAILED",
      "The durable derived Quick Analysis authorization correlation is incomplete."
    );
  }
  validation = await validateAIStandardResultProposal({
    action: result.action,
    target: result.target,
    source: result.source,
    payload: result.confirmedPayload,
    expectedProjectId: result.source.projectId,
    expectedTargetSnapshotFingerprint: result.targetSnapshotFingerprint
  });
  if (!validation.executable || readAIStandardResultBlockingValidationIssues(validation.validationIssues).length > 0 ||
    typeof validation.normalizedPayload.body !== "string") {
    const message = "The candidate proposal changed at the derived effect boundary.";
    const failed = await markDecisionFailure(
      result,
      new AIStandardResultDecisionError("QUICK_ANALYSIS_CANDIDATE_BOUNDARY_STALE", message),
      authorizationId
    );
    return { kind: "no_effect_failure", readback: failed, code: "QUICK_ANALYSIS_CANDIDATE_BOUNDARY_STALE", message };
  }
  const normalizedBody = validation.normalizedPayload.body;
  let candidateMetaSnapshot = "";
  let candidateOutline = "";
  if (input.ownerType === "literature") {
    const literatureChannel = input.channel === "literature_outline" ||
      input.channel === "dedicated_notes"
      ? input.channel
      : undefined;
    const sourceDocument = literatureChannel
      ? await manuscriptIoService.readManuscriptByFileRef(
          "literature",
          input.ownerId,
          input.sourceFileRefId,
          { manuscriptChannel: literatureChannel }
        )
      : undefined;
    const view = sourceDocument?.status === "success" && literatureChannel
      ? await buildLiteratureManuscriptView(
          input.ownerId,
          literatureChannel,
          sourceDocument.content
        )
      : undefined;
    if (!view || view.status !== "success") {
      const message = view?.status === "error"
        ? view.error.message
        : "The exact Literature source could not produce canonical candidate descriptors.";
      const failed = await markDecisionFailure(
        result,
        new AIStandardResultDecisionError(
          "QUICK_ANALYSIS_LITERATURE_CANDIDATE_DESCRIPTOR_UNAVAILABLE",
          message
        ),
        authorizationId
      );
      return {
        kind: "no_effect_failure",
        readback: failed,
        code: "QUICK_ANALYSIS_LITERATURE_CANDIDATE_DESCRIPTOR_UNAVAILABLE",
        message
      };
    }
    candidateMetaSnapshot = view.blocks.metaSnapshot;
    candidateOutline = view.blocks.outline;
  }
  let saved: Awaited<ReturnType<typeof candidateManuscriptService.saveCandidate>>;
  try {
    saved = await saveQuickAnalysisCandidateThroughLocalPort(
      capabilityBinding.domainCandidateApplicationPort,
      {
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      manuscriptChannel: input.channel,
      requestId: result.id,
      occurredAt: new Date().toISOString(),
      candidateTitle: "Quick Analysis candidate",
      source: "ai",
      authorization: {
        source: "DERIVED_FROM_QUICK_ANALYSIS_RUN_AUTHORIZATION",
        runId: input.runId,
        conversationId: input.conversationId,
        parseCallAttemptId: input.parseCallAttemptId,
        sourceFileRefId: input.sourceFileRefId,
        sourceDirectoryFileRefId: input.sourceDirectoryFileRefId
      },
      frozenWorkspace: {
        folderFileRefId: input.sourceDirectoryFileRefId,
        directoryPathIdentityKey: input.sourceDirectoryPathIdentityKey
      },
      metaSnapshot: candidateMetaSnapshot,
      outline: candidateOutline,
      body: normalizedBody,
      // Derived run authorization is not a UI request and must not invalidate
      // unrelated editor/candidate request tokens.
        requestToken: 0
      }
    );
  } catch {
    const uncertainRefs = await readActiveQuickAnalysisCandidateRefs(input.ownerType, input.ownerId, result.id);
    return {
      kind: "terminal_effect_outcome_unknown",
      readback: await readQuickAnalysisConversationOrFallback(input.conversationId, readback),
      code: "TERMINAL_EFFECT_OUTCOME_UNKNOWN",
      message: "Candidate service completion is uncertain; automatic create retry is forbidden.",
      ...(uncertainRefs?.length === 1 ? { candidateFileRefId: uncertainRefs[0].id } : {})
    };
  }
  const candidateRefs = await readActiveQuickAnalysisCandidateRefs(input.ownerType, input.ownerId, result.id);
  if (!candidateRefs) {
    return {
      kind: "terminal_effect_outcome_unknown",
      readback: await readQuickAnalysisConversationOrFallback(input.conversationId, readback),
      code: "TERMINAL_EFFECT_OUTCOME_UNKNOWN",
      message: "Candidate FileRef readback is unavailable after the create boundary; automatic create retry is forbidden."
    };
  }
  const provenNoEffect = candidateRefs.length === 0 && !saved.createdFile && !saved.reusedFile &&
    !saved.completedSteps.includes("candidate-file") &&
    !saved.completedSteps.includes("filesystem-outcome-unknown") &&
    (saved.status === "error" || saved.status === "conflict");
  if (provenNoEffect) {
    const message = saved.errors.map((error) => error.message).join(" ") ||
      "The candidate service proved that no candidate was published.";
    const failed = await markDecisionFailure(
      result,
      new AIStandardResultDecisionError("QUICK_ANALYSIS_CANDIDATE_CREATE_FAILED", message),
      authorizationId
    );
    return { kind: "no_effect_failure", readback: failed, code: "QUICK_ANALYSIS_CANDIDATE_CREATE_FAILED", message };
  }
  const candidate = candidateRefs.length === 1 ? candidateRefs[0] : undefined;
  if (!candidate || (saved.status !== "success" && saved.status !== "skipped")) {
    return {
      kind: "terminal_effect_outcome_unknown",
      readback: await readQuickAnalysisConversationOrFallback(input.conversationId, readback),
      code: "TERMINAL_EFFECT_OUTCOME_UNKNOWN",
      message: "Candidate publication may have crossed the effect boundary; automatic create retry is forbidden.",
      ...(candidate ? { candidateFileRefId: candidate.id } : {})
    };
  }
  const postPublishReadback = await Promise.all([
    manuscriptIoService.readManuscriptByFileRef(input.ownerType, input.ownerId, candidate.id, {
      manuscriptChannel: input.channel
    }),
    manuscriptBindingService.getBindingByOwner(input.ownerType, input.ownerId, input.channel),
    aiConversationRepository.listAttachmentFileRefs(),
    literatureSiblingChannel
      ? manuscriptBindingService.getBindingByOwner("literature", input.ownerId, literatureSiblingChannel)
      : Promise.resolve(undefined)
  ]).then(
    (value) => ({ kind: "read" as const, value }),
    () => ({ kind: "unavailable" as const })
  );
  if (postPublishReadback.kind === "unavailable") {
    return {
      kind: "terminal_effect_outcome_unknown",
      readback: await readQuickAnalysisConversationOrFallback(input.conversationId, readback),
      code: "TERMINAL_EFFECT_OUTCOME_UNKNOWN",
      message: "Post-publish physical, source, or Binding readback is unavailable; automatic create retry is forbidden.",
      candidateFileRefId: candidate.id
    };
  }
  const [physical, afterBinding, afterCatalog, literatureSiblingBindingAfter] = postPublishReadback.value;
  const parsed = physical.status === "success"
    ? parseLabPodMarkdownDocument(physical.content)
    : undefined;
  const afterSource = afterCatalog.fileRefs.find((fileRef) => fileRef.fileRefId === input.sourceFileRefId);
  const candidateParentIdentity = candidate.pathIdentityKey.replace(/[\\/][^\\/]+$/u, "");
  const bindingPreserved = Boolean(afterBinding) && exactRecord(
    exactBindingProjection(afterBinding!),
    exactBindingProjection(input.bindingBaseline)
  );
  const sourceFreshnessPreserved = afterSource?.materialFreshnessReceipt?.sourceToken ===
    input.sourceFreshnessReceipt.sourceToken;
  const literatureSiblingBindingPreserved = !literatureSiblingChannel || Boolean(
    literatureSiblingBindingBefore && literatureSiblingBindingAfter &&
    exactRecord(
      exactBindingProjection(literatureSiblingBindingBefore),
      exactBindingProjection(literatureSiblingBindingAfter)
    )
  );
  const readbackConfirmed = saved.fileRefId === candidate.id &&
    candidate.ownerType === input.ownerType && candidate.ownerId === input.ownerId &&
    candidate.manuscriptChannel === input.channel && candidate.resourceKind === "file" &&
    candidate.fileRole === "manuscript" && candidate.locationMode === "managed" &&
    candidate.candidateRequestId === result.id && candidateParentIdentity === input.sourceDirectoryPathIdentityKey &&
    physical.status === "success" && parsed && (parsed.status === "valid" || parsed.status === "valid-empty") &&
    parsed.body === normalizedBody && physical.encoding === "utf-8" &&
    bindingPreserved && sourceFreshnessPreserved && literatureSiblingBindingPreserved;
  if (!readbackConfirmed) {
    return {
      kind: "terminal_effect_outcome_unknown",
      readback: await readQuickAnalysisConversationOrFallback(input.conversationId, readback),
      code: "TERMINAL_EFFECT_OUTCOME_UNKNOWN",
      message: "The published candidate lacks complete post-publish source, Binding, or physical readback evidence.",
      candidateFileRefId: candidate.id
    };
  }
  const confirmedBodyFingerprint = canonicalAIStandardResultFingerprint(normalizedBody);
  const receipt: AIStandardResultEffectReceipt = {
    module: input.ownerType,
    entityType: "fileRef",
    entityId: candidate.id,
    operation: "NEW_MANUSCRIPT",
    service: "candidateManuscriptService.saveCandidate",
    canonicalReadback: {
      projectId: input.projectId,
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      manuscriptChannel: input.channel,
      resultId: result.id,
      authorizationId,
      authorizationSource: "DERIVED_FROM_QUICK_ANALYSIS_RUN_AUTHORIZATION",
      quickAnalysisRunId: input.runId,
      operationId: `qa-candidate:${result.id}:${authorizationId}`,
      candidateRequestId: result.id,
      fileRefId: candidate.id,
      resourceKind: candidate.resourceKind,
      fileRole: candidate.fileRole,
      locationMode: candidate.locationMode,
      sourceFileRefId: input.sourceFileRefId,
      sourceDirectoryFileRefId: input.sourceDirectoryFileRefId,
      candidateDirectoryPathIdentityKey: candidateParentIdentity,
      sourceDirectoryPathIdentityKey: input.sourceDirectoryPathIdentityKey,
      candidateDirectoryAgreement: true,
      sourceFreshnessTokenBefore: input.sourceFreshnessReceipt.sourceToken,
      sourceFreshnessTokenAfter: afterSource!.materialFreshnessReceipt!.sourceToken,
      sourceFreshnessPreserved: true,
      bindingBefore: exactBindingProjection(input.bindingBaseline),
      bindingAfter: exactBindingProjection(afterBinding!),
      bindingPreserved: true,
      literatureSiblingChannel: literatureSiblingChannel ?? null,
      literatureSiblingBindingBefore: literatureSiblingBindingBefore
        ? exactBindingProjection(literatureSiblingBindingBefore)
        : null,
      literatureSiblingBindingAfter: literatureSiblingBindingAfter
        ? exactBindingProjection(literatureSiblingBindingAfter)
        : null,
      literatureSiblingBindingPreserved,
      currentChanged: false,
      defaultChanged: false,
      formalSwitchInvoked: false,
      confirmedPayloadFingerprint: result.confirmedPayloadFingerprint,
      confirmedBodyFingerprint,
      physicalBodyFingerprint: canonicalAIStandardResultFingerprint(parsed!.body),
      physicalEncoding: physical.encoding,
      physicalSizeBytes: physical.sizeBytes,
      candidateTerminalCommitState: "POST_PUBLISH_READBACK_CONFIRMED",
      readbackState: "CANDIDATE_FILE_REF_PHYSICAL_BODY_SOURCE_AND_BINDING_PRESERVED"
    }
  };
  try {
    const settled = await aiConversationRepository.settleStandardResultEffect({
      conversationId: input.conversationId,
      resultId: result.id,
      authorizationId,
      effectReceipt: receipt,
      settledAt: new Date().toISOString()
    });
    const settledResult = requireResult(settled, result.id);
    if (settledResult.disposition !== "CONFIRMED" || settledResult.effectReceipt?.entityId !== candidate.id) {
      throw new Error("Durable candidate effect readback is incomplete.");
    }
    return { kind: "settled", readback: settled, receipt, candidateFileRefId: candidate.id };
  } catch {
    return {
      kind: "terminal_effect_outcome_unknown",
      readback: await readQuickAnalysisConversationOrFallback(input.conversationId, readback),
      code: "TERMINAL_EFFECT_OUTCOME_UNKNOWN",
      message: "Candidate exists, but durable StandardResult settlement is uncertain; automatic create retry is forbidden.",
      candidateFileRefId: candidate.id
    };
  }
}

export function confirmAIStandardResult(input: {
  conversationId: string;
  resultId: string;
  expectedVisiblePayloadFingerprint: string;
}): Promise<AIConversationReadback> {
  const key = `${input.conversationId}\u0000${input.resultId}`;
  const existing = confirmationFlights.get(key);
  if (existing) return existing;
  const flight = confirmAIStandardResultOnce(input).finally(() => {
    if (confirmationFlights.get(key) === flight) confirmationFlights.delete(key);
  });
  confirmationFlights.set(key, flight);
  return flight;
}

async function continueAIStandardResultOnce(input: {
  conversationId: string;
  resultId: string;
}): Promise<AIConversationReadback> {
  let readback = await aiConversationRepository.readConversation(input.conversationId);
  let result = requireResult(readback, input.resultId);
  if (result.authorizationId?.startsWith("quick-analysis-run-authorization:")) {
    throw new AIStandardResultDecisionError(
      "TERMINAL_EFFECT_OUTCOME_UNKNOWN",
      "A Quick Analysis candidate outcome requires promoter review and cannot enter automatic continuation.",
      readback
    );
  }
  if (!isAIStandardResultContinuable(result)) {
    throw new AIStandardResultDecisionError(
      "STANDARD_RESULT_CONTINUATION_UNAVAILABLE",
      "Only a durably claimed in-flight canonical operation with a bounded same-operation readback can continue.",
      readback
    );
  }
  if (
    !result.authorizationId || !result.confirmationStartedAt || !result.confirmedPayload ||
    !result.confirmedPayloadFingerprint ||
    canonicalAIStandardResultFingerprint(result.confirmedPayload) !== result.confirmedPayloadFingerprint
  ) {
    throw new AIStandardResultDecisionError(
      "STANDARD_RESULT_CONTINUATION_CORRELATION_INVALID",
      "The durable in-flight Result has no exact confirmed payload/authorization binding.",
      readback
    );
  }
  let executionResult = await resolveAIStandardResultSiblingExecutionView(result, readback);
  const recoveredEffect = await readAIStandardResultFormalEffect(executionResult, result);
  if (recoveredEffect) {
    return aiConversationRepository.settleStandardResultEffect({
      conversationId: input.conversationId,
      resultId: result.id,
      authorizationId: result.authorizationId,
      effectReceipt: recoveredEffect,
      settledAt: new Date().toISOString()
    });
  }
  const requestedManuscriptEffects = result.action === "NEW_MANUSCRIPT"
    ? []
    : readAIStandardResultManuscriptEffects(result.confirmedPayload, {
        action: result.action,
        target: result.target
      });
  if (requestedManuscriptEffects.length > 0) {
    throw new AIStandardResultDecisionError(
      "TERMINAL_EFFECT_OUTCOME_UNKNOWN",
      "No exact durable aggregate readback proves every requested effect; automatic business or candidate replay is forbidden.",
      readback
    );
  }
  const validation = await validateAIStandardResultProposal({
    action: executionResult.action,
    target: executionResult.target,
    source: executionResult.source,
    payload: result.confirmedPayload,
    expectedProjectId: result.source.projectId
  });
  if (!validation.executable || readAIStandardResultBlockingValidationIssues(validation.validationIssues).length > 0) {
    throw new AIStandardResultDecisionError(
      "STANDARD_RESULT_CONTINUATION_GUARD_FAILED",
      validation.validationIssues.map((candidate) => candidate.message).join(" ") ||
        "The bound formal operation is no longer eligible for safe continuation.",
      readback
    );
  }
  const effect = await invokeAIStandardResultFormalEffect({
    result: executionResult,
    durableParentResult: result,
    normalizedPayload: validation.normalizedPayload,
    invocationMode: "continuation"
  });
  if (effect.kind === "pending") {
    return aiConversationRepository.readConversation(input.conversationId);
  }
  if (effect.kind === "no_effect_failure") {
    return markDecisionFailure(
      result,
      new AIStandardResultDecisionError(effect.code, effect.message),
      result.authorizationId
    );
  }
  readback = await aiConversationRepository.settleStandardResultEffect({
    conversationId: input.conversationId,
    resultId: result.id,
    authorizationId: result.authorizationId,
    effectReceipt: effect.receipt,
    settledAt: new Date().toISOString()
  });
  result = requireResult(readback, result.id);
  return readback;
}

export function continueAIStandardResult(input: {
  conversationId: string;
  resultId: string;
}): Promise<AIConversationReadback> {
  const key = `${input.conversationId}\u0000${input.resultId}`;
  const existing = confirmationFlights.get(key);
  if (existing) return existing;
  const flight = continueAIStandardResultOnce(input).finally(() => {
    if (confirmationFlights.get(key) === flight) confirmationFlights.delete(key);
  });
  confirmationFlights.set(key, flight);
  return flight;
}

export const aiStandardResultApplicationService = {
  updateVisiblePayload: updateAIStandardResultVisiblePayload,
  dismiss: dismissAIStandardResult,
  confirm: confirmAIStandardResult,
  continue: continueAIStandardResult,
  applyQuickAnalysisCandidate: applyCanonicalQuickAnalysisCandidateStandardResult
};
