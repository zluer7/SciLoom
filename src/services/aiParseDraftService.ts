import { aiConversationRepository } from "../repositories/aiConversationRepository";
import type {
  AICallAttempt,
  AIConversationReadback,
  AIMessage
} from "../types/aiConversation";
import type {
  AIContextPackage,
  AIContextRequestFollowupState,
  AIContextSourceRef,
  AIOutputDetailPreference,
  AIProviderPromptEnvelope,
  AIPromptPackage,
  AIQuickAnalysisContextCapability,
  AIResearchObjectDescriptor,
  AIResearchObjectSelection
} from "../types/aiContext";
import type { AIParseDraftSourceSnapshot } from "../types/aiStandardResult";
import { createAIContextRequestResponseContract } from "./aiContextRequestService";
import {
  assertAIParseDraftCompletedAnswerEligibility,
  selectCanonicalPromptHistory,
  selectRelevantEffectiveDiscussion,
  type AIParseDraftEligibleCompletedAnswer,
  type RelevantEffectiveDiscussion
} from "./aiConversationHistoryService";
import { resolveAIActiveConstraintRequest } from "./aiConstraintService";
import { buildAIPromptPackage } from "./aiPromptPackageService";
import {
  AIStandardResultContractError,
  createAIStandardResultResponseContract,
  type AIStandardResultContractErrorCode
} from "./aiStandardResultService";
import { readExperimentRunParentRelations } from "./experimentRunAIResearchObjectAdapter";
import { readLiteratureAssociationTuples } from "./literatureAIResearchObjectAdapter";
import {
  MANUSCRIPT_OUTLINE_DESCRIPTOR_REGISTRY,
  type ManuscriptOutlineDescriptor
} from "./manuscriptOutlineDescriptorRegistry";
import { resolveQuickAnalysisCapabilityBinding } from "./quickAnalysisCapabilityBinding";
import { buildCanonicalStructuredManuscriptTargetTemplate } from "./structuredManuscriptAIGuidance";

export const PARSE_DRAFT_USER_INSTRUCTION =
  "Parse the exact frozen CURRENT PARSE DELTA, durable Conversation context, selected Context, and currently authorized materials into one current typed Parse Draft outcome. Follow the active PARSE_DRAFT category policy, injected typed response contracts, and run-scoped directive as the sole semantic and machine-shape authorities; this instruction does not redefine them. Natural Chat is ordinary content, never write authority. Preserve every explicit currently supported business-object intent in original order, use only frozen Context and authorized material, and never guess identities or silently drop a supported intent. If the paired Context Request capability is active, Phase A may request context once only under the sole canonical Context Request policy; after the correlated continuation, return the final outcome and never request again. Return exactly one typed outcome without Markdown, prose, or extra carrier keys. The user retains the final decision, and every write still requires the existing explicit confirmation flow." as const;

export const PARSE_DRAFT_STANDARD_RESULT_ONLY_DIRECTIVE =
  "For each explicit supported business-object intent, create one separate parent Standard Result in original order; never silently omit, merge, substitute, or renumber a supported business object. If any intended object cannot be resolved under current exact P0 and supplemental rules, do not return only the other objects as a successful batch: the entire attempt must fail closed, with no fabricated identity, action conversion, or report-ledger wire field. Literature identity redline has higher priority than channel count: one source Literature, one intended Literature object, or an explicit same-Literature request is exactly one business-object intent and must produce exactly one Literature parent proposal. literature_outline and dedicated_notes are 0/1/2 subordinate effects under that parent; different bodies, headings, title suffixes, or shared material never justify peer Literature parents or post-hoc merging. Explicit outline-only intent yields outline only, notes-only yields notes only, explicit both yields both, and only genuinely ambiguous channel intent permits AI to choose one or both. Keep the parent title as the source Literature identity/title and keep channel-specific headings inside effect bodies. Select exactly one whole formal allowedCapabilityTuple and copy its DATA_OPERATION category, CREATE/UPDATE/DELETE action, and entityType without cross-combination; omit target.module because LabPod derives it from entityType. Use frozen current Project scope; existing entityId is required only for UPDATE or DELETE. CREATE never requires an unrelated selected object. Every payload must carry exact labpod-standard-result-proposal-v1 _labpod metadata with its true 1-based ordinal and a unique proposalRef. A same-batch ExperimentRun may use parentProposalRef only for an earlier Experiment CREATE. For an eligible CREATE/UPDATE with a canonical managed-manuscript capability tuple, include one substantive Markdown manuscriptEffects child by default (Literature remains 0/1/2 by exact intent) unless the current delta explicitly requires business-only/DB-only/no-manuscript. Explicit formal-manuscript intent also requires the matching effect. Generate each admitted body now and place it directly inside the same parent payload as one or two exact {channel, body} manuscriptEffects selected from the current child-effect capability tuples. The exact Provider nested-effect body is authoritative at the parser boundary: never substitute a Chat draft, legacy carrier body, compact notice, summary, or post-Provider regeneration. Do not emit NEW_MANUSCRIPT, MANUSCRIPT_RESULT, intentRef, compositeRole, or a second peer Result. A manuscript effect never changes the parent object type; every owner/channel must be copied from the current child-effect capability tuples. P1/P2 incompleteness is nonblocking. Retain the exact V2 outcome/batch/version/results envelope and only complete, conserved parent results." as const;

export const PARSE_DRAFT_PHASE_A_CONTEXT_OR_FINAL_DIRECTIVE = [
  "Phase A uses the paired outcome contract. If an UPDATE, DELETE, or manuscript effect requires an exact existing target, owner, channel, or authorization that is absent from frozen supplied Context but appears only in requestableRefs, return one batched AI_CONTEXT_REQUEST for the exact eligible refs. Missing upstream Chat carrier/body is never a mechanical gap because Parse generates requested nested-effect body directly. requestableRefs are candidate inventory, not final target authority; never copy their identities into a final operation as if already supplied. Otherwise return the final STANDARD_RESULT_BATCH directly. After a supplemental projection this Phase-A branch is exhausted and a second Context Request is forbidden.",
  PARSE_DRAFT_STANDARD_RESULT_ONLY_DIRECTIVE
].join("\n\n");

export const AI_PARSE_DRAFT_NO_NEW_CONTENT_MESSAGE = "暂无新的对话内容需要解析" as const;
/** Aligned with Rust's final Provider envelope authority. */
export const AI_PARSE_DRAFT_PROVIDER_HISTORY_MAX_MESSAGES = 12;
export const AI_PARSE_DRAFT_PROVIDER_HISTORY_MAX_CHARS = 4_000;
export const AI_PARSE_DRAFT_STRUCTURED_MANUSCRIPT_GUIDANCE_MAX_VARIANTS = 4;

export type AIParseDraftStructuredManuscriptGuidance = Readonly<{
  mode: "EXACT_QUICK_TARGET" | "BOUNDED_SELECTED_VARIANTS" | "GENERIC_PATH";
  text: string;
  descriptorIdentities: readonly string[];
  omittedVariantCount: number;
}>;

const PARSE_DRAFT_STRUCTURED_MANUSCRIPT_SHARED_GUIDANCE = [
  "## Nested manuscript effect.body structure guidance",
  "Apply this guidance only after the existing Standardized Operations contract and current Parse semantics independently select a matching CREATE/UPDATE parent and admitted manuscript effect. This guidance does not select or narrow an action, target, owner, channel, review type, or allowed capability tuple.",
  "For each matching listed descriptor, write the nested manuscript effect.body value itself as one complete canonical Structured Outline Archive using that descriptor's exact supplied skeleton. Preserve every marker, display heading, stable key, and canonical order exactly once; place admitted research content below the matching headings, leave unsupported fields empty, return no format explanation, and do not append a second Archive or ordinary prose outside the Archive within that body value.",
  "The outer Parse outcome/batch/results envelope, parent business payload, manuscriptEffects array, and exact {channel, body} effect shape remain authoritative and unchanged. Never replace the outer response with bare Markdown.",
  "The variants below are structure references only. Never use them to guess a target or channel. If current semantic selection yields an unlisted descriptor variant, retain the existing generic candidate-body path for that effect instead of borrowing another variant or inventing a template."
].join("\n\n");

function parseDraftDescriptorKey(descriptor: ManuscriptOutlineDescriptor): string {
  return `${descriptor.ownerType}\u0000${descriptor.channel}\u0000${descriptor.reviewType ?? ""}`;
}

function registeredDescriptorsForResearchObject(
  object: AIResearchObjectDescriptor
): ManuscriptOutlineDescriptor[] {
  const registrations = MANUSCRIPT_OUTLINE_DESCRIPTOR_REGISTRY.filter(
    (registration) => registration.ownerType === object.objectType
  );
  if (object.objectType !== "review") {
    return registrations.flatMap((registration) => [...registration.descriptors]);
  }
  const reviewType = object.safeMetadata?.reviewType;
  if (typeof reviewType !== "string") return [];
  return registrations.flatMap((registration) =>
    registration.descriptors.filter((descriptor) => descriptor.reviewType === reviewType)
  );
}

function uniqueParseDraftDescriptors(
  descriptors: readonly ManuscriptOutlineDescriptor[]
): ManuscriptOutlineDescriptor[] {
  const unique = new Map<string, ManuscriptOutlineDescriptor>();
  for (const descriptor of descriptors) {
    const key = parseDraftDescriptorKey(descriptor);
    if (!unique.has(key)) unique.set(key, descriptor);
  }
  return [...unique.values()];
}

/**
 * Resolves only pre-Provider mechanical descriptor facts. The returned text is
 * non-authoritative guidance inside the existing Parse package; it never
 * creates a semantic router, response validator, or post-Provider repair path.
 */
export function buildAIParseDraftStructuredManuscriptGuidance(input: {
  researchObjects: readonly AIResearchObjectDescriptor[];
  quickAnalysisTarget?: AIParseDraftSourceSnapshot["quickAnalysisTarget"];
}): AIParseDraftStructuredManuscriptGuidance {
  let mode: AIParseDraftStructuredManuscriptGuidance["mode"] = "BOUNDED_SELECTED_VARIANTS";
  let candidates: ManuscriptOutlineDescriptor[];
  if (input.quickAnalysisTarget) {
    mode = "EXACT_QUICK_TARGET";
    const target = input.researchObjects.find((object) =>
      object.objectType === input.quickAnalysisTarget!.ownerType &&
      object.objectId === input.quickAnalysisTarget!.ownerId
    );
    candidates = target
      ? registeredDescriptorsForResearchObject(target).filter((descriptor) =>
          descriptor.channel === input.quickAnalysisTarget!.channel
        )
      : [];
  } else {
    candidates = input.researchObjects.flatMap(registeredDescriptorsForResearchObject);
  }
  const unique = uniqueParseDraftDescriptors(candidates);
  const admitted = unique.slice(0, AI_PARSE_DRAFT_STRUCTURED_MANUSCRIPT_GUIDANCE_MAX_VARIANTS);
  if (admitted.length === 0) {
    return Object.freeze({
      mode: "GENERIC_PATH",
      text: "",
      descriptorIdentities: Object.freeze([]),
      omittedVariantCount: unique.length
    });
  }
  const targets = admitted.map(buildCanonicalStructuredManuscriptTargetTemplate);
  const variantMap = targets.map((target, index) => [
    `### Descriptor variant ${index + 1}: ${target.descriptorIdentity}`,
    target.archiveTemplate
  ].join("\n\n"));
  return Object.freeze({
    mode,
    text: [PARSE_DRAFT_STRUCTURED_MANUSCRIPT_SHARED_GUIDANCE, ...variantMap].join("\n\n"),
    descriptorIdentities: Object.freeze(targets.map((target) => target.descriptorIdentity)),
    omittedVariantCount: Math.max(0, unique.length - admitted.length)
  });
}

/**
 * R4's only retry delta. It does not change the frozen intent, Context,
 * response contract, Provider, or Model; it asks only for a mechanically valid
 * re-emission of the same typed outcome.
 */
export const AI_PARSE_MECHANICAL_RETRY_DIRECTIVE =
  "Mechanical retry only: re-emit the same requested operations under the unchanged typed contract, correcting only the mechanical contract shape. Do not add, remove, merge, or semantically change operations, and return no explanatory prose." as const;

export const AI_PARSE_MECHANICAL_RETRYABLE_CODES = [
  "STANDARD_RESULT_COUNT_INVALID",
  "STANDARD_RESULT_MANUSCRIPT_EFFECT_INVALID"
] as const satisfies readonly AIStandardResultContractErrorCode[];

export type AIParseMechanicalRetryFailureCode =
  (typeof AI_PARSE_MECHANICAL_RETRYABLE_CODES)[number];

const AI_PARSE_MECHANICAL_RETRYABLE_CODE_SET = new Set<AIStandardResultContractErrorCode>(
  AI_PARSE_MECHANICAL_RETRYABLE_CODES
);

export type AIParseMechanicalRetryEligibility =
  | {
      eligible: true;
      code: AIParseMechanicalRetryFailureCode;
    }
  | {
      eligible: false;
    };

/**
 * Exact typed classification only. Public error codes, error text, localized
 * copy, transport status, and generic invalid_response never enter the
 * allowlist decision.
 */
export function classifyAIParseMechanicalRetryFailure(input: {
  purpose: "chat_response" | "parse_draft";
  providerResponseCompleted: boolean;
  responseTruncated: boolean;
  parserError: unknown;
  acceptedStandardResultCount: number;
  automaticRetryAlreadyUsed: boolean;
}): AIParseMechanicalRetryEligibility {
  if (
    input.purpose !== "parse_draft" ||
    !input.providerResponseCompleted ||
    input.responseTruncated ||
    input.acceptedStandardResultCount !== 0 ||
    input.automaticRetryAlreadyUsed ||
    !(input.parserError instanceof AIStandardResultContractError) ||
    !AI_PARSE_MECHANICAL_RETRYABLE_CODE_SET.has(input.parserError.code)
  ) {
    return { eligible: false };
  }
  return {
    eligible: true,
    code: input.parserError.code as AIParseMechanicalRetryFailureCode
  };
}

export function buildAIParseMechanicalRetryPrompt(input: {
  promptText: string;
  promptEnvelope: AIProviderPromptEnvelope;
  failureCode: AIParseMechanicalRetryFailureCode;
}): {
  promptText: string;
  promptEnvelope: AIProviderPromptEnvelope;
} {
  if (
    input.promptEnvelope.constraintDescriptor.category !== "PARSE_DRAFT" ||
    !input.promptEnvelope.standardResultResponseContract ||
    !AI_PARSE_MECHANICAL_RETRYABLE_CODE_SET.has(input.failureCode)
  ) {
    throw new Error("Parse mechanical retry requires the unchanged typed Parse Draft contract.");
  }
  const directive = `${AI_PARSE_MECHANICAL_RETRY_DIRECTIVE} Stable parser code: ${input.failureCode}.`;
  const promptEnvelope = structuredClone(input.promptEnvelope);
  promptEnvelope.runScopedDirective = [
    promptEnvelope.runScopedDirective?.trim(),
    directive
  ].filter(Boolean).join("\n\n");
  return {
    promptText: `${input.promptText.trim()}\n\n## Mechanical retry directive\n${directive}`,
    promptEnvelope
  };
}

export function buildAIParseDraftProviderMessageContent(
  message: Pick<AIMessage, "id" | "role" | "content">
): string {
  return message.content;
}

export class AIParseDraftBoundaryNoNewContentError extends Error {
  readonly code = "parse_draft_no_new_content" as const;

  constructor(
    readonly boundaryMessageSequence: number,
    readonly currentMessageSequence: number
  ) {
    super(AI_PARSE_DRAFT_NO_NEW_CONTENT_MESSAGE);
    this.name = "AIParseDraftBoundaryNoNewContentError";
  }
}

export function isAIParseDraftBoundaryNoNewContentError(
  error: unknown
): error is AIParseDraftBoundaryNoNewContentError {
  return error instanceof AIParseDraftBoundaryNoNewContentError;
}

export type AIParseDraftBoundary = {
  lastSuccessfulParseBoundarySequence: number;
  lastSuccessfulParseBoundaryMessageId?: string;
  sourceResultId?: string;
  sourceCallAttemptId?: string;
};

/**
 * Restart-safe, no-Schema Parse boundary derived only from already durable facts.
 * A failed/empty/partial Parse cannot contribute because it has no atomically
 * settled usable Standard Result tied to a succeeded parse_draft CallAttempt.
 */
export function deriveAIParseDraftBoundary(
  readback: AIConversationReadback
): AIParseDraftBoundary {
  const succeededParseAttempts = new Set(
    readback.callAttempts
      .filter((attempt) => attempt.purpose === "parse_draft" && attempt.status === "succeeded")
      .map((attempt) => attempt.id)
  );
  const durableMessages = new Map(readback.messages.map((message) => [message.id, message]));
  const candidates = readback.standardResults.flatMap((result) => {
    if (
      result.conversationId !== readback.conversation.id ||
      result.source.conversationId !== readback.conversation.id ||
      !succeededParseAttempts.has(result.parseCallAttemptId)
    ) return [];
    const last = durableMessages.get(result.source.lastMessageId);
    const sourceLast = result.source.discussionMessages[
      result.source.discussionMessages.length - 1
    ];
    if (
      !last || !sourceLast || last.sequence !== sourceLast.sequence ||
      last.id !== sourceLast.id
    ) return [];
    return [{
      sequence: last.sequence,
      messageId: last.id,
      resultId: result.id,
      callAttemptId: result.parseCallAttemptId
    }];
  }).sort((left, right) => (
    right.sequence - left.sequence ||
    right.callAttemptId.localeCompare(left.callAttemptId) ||
    right.resultId.localeCompare(left.resultId)
  ));
  const latest = candidates[0];
  return latest
    ? {
        lastSuccessfulParseBoundarySequence: latest.sequence,
        lastSuccessfulParseBoundaryMessageId: latest.messageId,
        sourceResultId: latest.resultId,
        sourceCallAttemptId: latest.callAttemptId
      }
    : { lastSuccessfulParseBoundarySequence: 0 };
}

export type AIParseDraftRetryRange = {
  attemptId: string;
  firstSequence: number;
  lastSequence: number;
  messageIds: string[];
  authorizedMaterialFileRefIds: string[];
  recordedScope: ReturnType<typeof readAIParseDraftSourceRef>;
};

/** Latest attempted Parse owns the retry range, including pre-Provider failures. */
export function deriveAIParseDraftRetryRange(
  readback: AIConversationReadback
): AIParseDraftRetryRange | undefined {
  const messages = new Map(readback.projectedMessages.map((message) => [message.id, message]));
  const attempts = [...readback.callAttempts]
    .filter((attempt) => attempt.purpose === "parse_draft")
    .sort((left, right) => right.sequence - left.sequence || right.startedAt.localeCompare(left.startedAt));
  for (const attempt of attempts) {
    try {
      const recordedScope = readAIParseDraftSourceRef(attempt.contextSourceRefs ?? []);
      const ref = (attempt.contextSourceRefs ?? []).find((candidate) =>
        candidate.field === "relevantEffectiveDiscussion" || candidate.parseDiscussionFingerprint !== undefined);
      const messageIds = ref?.parseDiscussionMessageIds;
      if (!Array.isArray(messageIds) || messageIds.length === 0) continue;
      const selected = messageIds.map((id) => messages.get(id));
      if (selected.some((message) => !message)) continue;
      const exact = selected.filter((message): message is NonNullable<typeof message> => Boolean(message));
      if (
        exact.some((message) => message.messageKind !== "text" || !message.content.trim()) ||
        exact.some((message, index) => index > 0 && message.sequence <= exact[index - 1].sequence) ||
        exact[0]?.role !== "user"
      ) continue;
      return {
        attemptId: attempt.id,
        firstSequence: exact[0].sequence,
        lastSequence: exact[exact.length - 1].sequence,
        messageIds: [...messageIds],
        authorizedMaterialFileRefIds: canonicalIds(
          (attempt.authorizedFileRefs ?? []).map((snapshot) => snapshot.fileRefId)
        ),
        recordedScope
      };
    } catch {
      // Historical/malformed attempts remain readback-only and cannot become retry authority.
    }
  }
  return undefined;
}

function exactStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function retryScopeMatches(input: {
  range: AIParseDraftRetryRange;
  projectId: string;
  selectedRouteIds: string[];
  selectedTaskIds: string[];
  selectedReviewIds: string[];
  selectedExperimentIds: string[];
  selectedExperimentRunIds: string[];
  experimentRunParentRelations: AIParseDraftSourceSnapshot["experimentRunParentRelations"];
  selectedLiteratureIds: string[];
  selectedFindingIds: string[];
  literatureAssociationTuples: AIParseDraftSourceSnapshot["literatureAssociationTuples"];
  authorizedMaterialFileRefIds: string[];
}) {
  const source = input.range.recordedScope;
  return source.projectId === input.projectId &&
    exactStringArray(source.selectedRouteIds ?? [], input.selectedRouteIds) &&
    exactStringArray(source.selectedTaskIds, input.selectedTaskIds) &&
    exactStringArray(source.selectedReviewIds, input.selectedReviewIds) &&
    exactStringArray(source.selectedExperimentIds, input.selectedExperimentIds) &&
    exactStringArray(source.selectedExperimentRunIds, input.selectedExperimentRunIds) &&
    JSON.stringify(source.experimentRunParentRelations) === JSON.stringify(input.experimentRunParentRelations) &&
    exactStringArray(source.selectedLiteratureIds, input.selectedLiteratureIds) &&
    exactStringArray(source.selectedFindingIds, input.selectedFindingIds) &&
    JSON.stringify(source.literatureAssociationTuples) === JSON.stringify(input.literatureAssociationTuples) &&
    exactStringArray(
      input.range.authorizedMaterialFileRefIds,
      input.authorizedMaterialFileRefIds
  );
}

function canonicalResearchObjectKeys(
  selections: readonly AIResearchObjectSelection[]
): string[] {
  return [...new Set(selections.map((selection) => (
    `${selection.objectType}:${selection.objectId}`
  )))].sort((left, right) => left.localeCompare(right));
}

function parseSupplementalRetryScopeMatches(input: {
  range: AIParseDraftRetryRange;
  continuation: NonNullable<BuildAIParseDraftPromptInput["parseSupplementalContext"]>;
  currentResearchObjects: AIResearchObjectSelection[];
  authorizedMaterialFileRefIds: string[];
  contextRequestFollowupState?: AIContextRequestFollowupState;
}): boolean {
  const continuation = input.continuation;
  if (
    input.contextRequestFollowupState?.scope !== "SAME_PARSE_ATTEMPT_AUTOMATIC_FOLLOWUP" ||
    input.range.attemptId !== continuation.sourceCallAttemptId ||
    !continuation.projectionFingerprint.trim()
  ) return false;

  const base = continuation.baseSource;
  if (!base.conversationId.trim()) return false;
  if (
    base.contextReviewFingerprint !== input.range.recordedScope.contextReviewFingerprint ||
    base.contextMode !== input.range.recordedScope.contextMode ||
    base.discussionFingerprint !== input.range.recordedScope.discussionFingerprint
  ) return false;
  const frozenBaseMatches = retryScopeMatches({
    range: input.range,
    projectId: base.projectId,
    selectedRouteIds: [...(base.selectedRouteIds ?? [])],
    selectedTaskIds: [...base.selectedTaskIds],
    selectedReviewIds: [...base.selectedReviewIds],
    selectedExperimentIds: [...base.selectedExperimentIds],
    selectedExperimentRunIds: [...base.selectedExperimentRunIds],
    experimentRunParentRelations: base.experimentRunParentRelations.map((relation) => ({ ...relation })),
    selectedLiteratureIds: [...base.selectedLiteratureIds],
    selectedFindingIds: [...base.selectedFindingIds],
    literatureAssociationTuples: base.literatureAssociationTuples.map((tuple) => ({ ...tuple })),
    authorizedMaterialFileRefIds: [...base.authorizedMaterialFileRefIds]
  });
  if (!frozenBaseMatches || !exactStringArray(
    input.authorizedMaterialFileRefIds,
    base.authorizedMaterialFileRefIds
  )) return false;

  const baseKeys = canonicalResearchObjectKeys(continuation.baseResearchObjects);
  const providedKeys = canonicalResearchObjectKeys(continuation.providedResearchObjects);
  if (
    baseKeys.length !== continuation.baseResearchObjects.length ||
    providedKeys.length !== continuation.providedResearchObjects.length ||
    providedKeys.some((key) => baseKeys.includes(key))
  ) return false;
  const expectedExpandedKeys = [...baseKeys, ...providedKeys]
    .sort((left, right) => left.localeCompare(right));
  return exactStringArray(
    canonicalResearchObjectKeys(input.currentResearchObjects),
    expectedExpandedKeys
  );
}

export type BuildAIParseDraftPromptInput = {
  conversationId: string;
  contextPackage: AIContextPackage;
  technicalCapacityChars: number;
  readback?: AIConversationReadback;
  runScopedDirective?: string;
  parseDynamicRunScopedSegments?: readonly string[];
  quickAnalysisContextCapability?: AIQuickAnalysisContextCapability;
  contextRequestFollowupState?: AIContextRequestFollowupState;
  /**
   * C5 transient proof for the one automatic Phase-B continuation. It can
   * expand only the frozen Phase-A selection by the exact PROVIDED refs.
   */
  parseSupplementalContext?: {
    sourceCallAttemptId: string;
    baseSource: AIParseDraftSourceSnapshot;
    baseResearchObjects: AIResearchObjectSelection[];
    providedResearchObjects: AIResearchObjectSelection[];
    projectionFingerprint: string;
  };
  additionalSourceRefs?: readonly AIContextSourceRef[];
  outputDetailPreference?: AIOutputDetailPreference;
};

export type BuildAIParseDraftPromptResult = {
  promptPackage: AIPromptPackage;
  readback: AIConversationReadback;
  discussion: RelevantEffectiveDiscussion;
  eligibility: AIParseDraftEligibleCompletedAnswer;
  source: AIParseDraftSourceSnapshot;
};

export type AIParseDraftSourceSnapshotErrorCode =
  | "parse_draft_source_snapshot_stale"
  | "parse_draft_source_eligibility_proof_mismatch";

export class AIParseDraftSourceSnapshotError extends Error {
  constructor(
    readonly code: AIParseDraftSourceSnapshotErrorCode,
    message: string
  ) {
    super(message);
    this.name = "AIParseDraftSourceSnapshotError";
  }
}

export function isAIParseDraftSourceSnapshotError(
  error: unknown
): error is AIParseDraftSourceSnapshotError {
  return error instanceof AIParseDraftSourceSnapshotError;
}

function canonicalIds(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id) => id.trim()))].sort((left, right) => left.localeCompare(right));
}

function readQuickAnalysisTarget(
  sourceRefs: readonly AIContextSourceRef[],
  required: boolean
): AIParseDraftSourceSnapshot["quickAnalysisTarget"] {
  const candidates = sourceRefs.filter((sourceRef) =>
    sourceRef.field === "quickAnalysisRunAuthorization" ||
    sourceRef.quickAnalysisRunId !== undefined);
  if (candidates.length === 0 && !required) return undefined;
  if (candidates.length !== 1) {
    throw new Error("Parse Draft requires exactly one Quick Analysis authorization source.");
  }
  const candidate = candidates[0];
  const ownerType = candidate.quickAnalysisOwnerType;
  const ownerId = candidate.quickAnalysisOwnerId?.trim();
  const channel = candidate.quickAnalysisChannel;
  const projectOrScopeId = candidate.quickAnalysisProjectId?.trim();
  const sourceFileRefId = candidate.quickAnalysisSourceFileRefId?.trim();
  const sourceDirectoryFileRefId = candidate.quickAnalysisSourceDirectoryFileRefId?.trim();
  const whitelistFingerprint = candidate.quickAnalysisWhitelistFingerprint?.trim();
  if (
    !ownerType || !ownerId || !channel || !projectOrScopeId || !sourceFileRefId ||
    !sourceDirectoryFileRefId || !whitelistFingerprint ||
    candidate.quickAnalysisAuthorizationSource !== "DERIVED_FROM_QUICK_ANALYSIS_RUN_AUTHORIZATION"
  ) {
    throw new Error("The Quick Analysis Parse Draft target provenance is incomplete.");
  }
  resolveQuickAnalysisCapabilityBinding({ ownerType, channel });
  return {
    ownerType,
    ownerId,
    channel,
    projectOrScopeId,
    sourceFileRefId,
    sourceDirectoryFileRefId,
    whitelistFingerprint
  };
}

function canonicalOptionalFindingIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Finding identities must be an array.");
  const ids = value.map((candidate) => {
    if (typeof candidate !== "string" || !candidate.trim() || candidate !== candidate.trim()) {
      throw new Error("The canonical Finding identity is malformed.");
    }
    return candidate;
  });
  if (new Set(ids).size !== ids.length) {
    throw new Error("Each selected Finding identity must be unique.");
  }
  return [...ids].sort((left, right) => left.localeCompare(right));
}

function canonicalOrderedRunIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("ExperimentRun identities must be an array.");
  const ids = value.map((candidate) => {
    if (typeof candidate !== "string" || !candidate.trim() || candidate !== candidate.trim()) {
      throw new Error("The canonical ExperimentRun identity is malformed.");
    }
    return candidate;
  });
  if (new Set(ids).size !== ids.length) {
    throw new Error("Each selected ExperimentRun identity must be unique.");
  }
  return ids;
}

function canonicalRunRelations(value: unknown): AIParseDraftSourceSnapshot["experimentRunParentRelations"] {
  if (!Array.isArray(value)) throw new Error("ExperimentRun parent relations must be an array.");
  const relations = value.map((candidate) => {
    if (
      !candidate || typeof candidate !== "object" ||
      typeof candidate.runId !== "string" || !candidate.runId.trim() ||
      typeof candidate.parentExperimentId !== "string" || !candidate.parentExperimentId.trim() ||
      typeof candidate.projectId !== "string" || !candidate.projectId.trim() ||
      !Number.isSafeInteger(candidate.selectionOrder) || candidate.selectionOrder < 0
    ) {
      throw new Error("The canonical ExperimentRun parent relation is malformed.");
    }
    return {
      runId: candidate.runId,
      parentExperimentId: candidate.parentExperimentId,
      projectId: candidate.projectId,
      selectionOrder: candidate.selectionOrder
    };
  }).sort((left, right) => left.selectionOrder - right.selectionOrder || left.runId.localeCompare(right.runId));
  if (new Set(relations.map((relation) => relation.runId)).size !== relations.length) {
    throw new Error("Each ExperimentRun requires exactly one canonical parent relation.");
  }
  return relations;
}

function canonicalOrderedLiteratureIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("Literature identities must be an array.");
  const ids = value.map((candidate) => {
    if (typeof candidate !== "string" || !candidate.trim() || candidate !== candidate.trim()) {
      throw new Error("The canonical Literature identity is malformed.");
    }
    return candidate;
  });
  if (new Set(ids).size !== ids.length) {
    throw new Error("Each selected Literature identity must be unique.");
  }
  return ids;
}

function canonicalLiteratureTuples(
  value: unknown
): AIParseDraftSourceSnapshot["literatureAssociationTuples"] {
  if (!Array.isArray(value)) throw new Error("Literature association tuples must be an array.");
  const tuples = value.map((raw) => {
    const candidate = raw && typeof raw === "object"
      ? raw as Record<string, unknown>
      : null;
    if (
      !candidate || typeof candidate.literatureId !== "string" || !candidate.literatureId.trim() ||
      (candidate.projectAssociationKind !== "assigned" && candidate.projectAssociationKind !== "projectless") ||
      !(candidate.canonicalProjectId === null || typeof candidate.canonicalProjectId === "string") ||
      candidate.lifecycleEligibility !== "eligible" ||
      (candidate.conversationProjectEligibilityDisposition !== "allowed_same_project" &&
        candidate.conversationProjectEligibilityDisposition !== "allowed_global_projectless") ||
      !Number.isSafeInteger(candidate.selectionOrder) || (candidate.selectionOrder as number) < 0 ||
      typeof candidate.normalizedProjectionFingerprint !== "string" ||
      !candidate.normalizedProjectionFingerprint.trim()
    ) {
      throw new Error("The canonical Literature association tuple is malformed.");
    }
    return {
      literatureId: candidate.literatureId,
      projectAssociationKind: candidate.projectAssociationKind,
      canonicalProjectId: candidate.canonicalProjectId,
      lifecycleEligibility: candidate.lifecycleEligibility,
      conversationProjectEligibilityDisposition: candidate.conversationProjectEligibilityDisposition,
      selectionOrder: candidate.selectionOrder as number,
      normalizedProjectionFingerprint: candidate.normalizedProjectionFingerprint
    } as AIParseDraftSourceSnapshot["literatureAssociationTuples"][number];
  }).sort((left, right) => left.selectionOrder - right.selectionOrder ||
    left.literatureId.localeCompare(right.literatureId));
  if (new Set(tuples.map((tuple) => tuple.literatureId)).size !== tuples.length) {
    throw new Error("Each Literature requires exactly one canonical association tuple.");
  }
  return tuples;
}

function parseDiscussionSourceRef(source: AIParseDraftSourceSnapshot): AIContextSourceRef {
  return {
    module: "ai",
    entityType: "system",
    entityId: source.discussionFingerprint,
    label: "Relevant effective discussion",
    field: "relevantEffectiveDiscussion",
    sourceKind: "systemGenerated",
    isUserAuthored: false,
    isAiGenerated: false,
    isVerified: true,
    parseDiscussionFingerprint: source.discussionFingerprint,
    parseDiscussionMessageIds: source.discussionMessages.map((message) => message.id),
    parseProjectId: source.projectId,
    parseRouteIds: [...(source.selectedRouteIds ?? [])],
    parseTaskIds: [...source.selectedTaskIds],
    parseReviewIds: [...source.selectedReviewIds],
    parseExperimentIds: [...source.selectedExperimentIds],
    parseExperimentRunIds: [...source.selectedExperimentRunIds],
    parseExperimentRunParentRelations: source.experimentRunParentRelations.map((relation) => ({
      ...relation
    })),
    parseLiteratureIds: [...source.selectedLiteratureIds],
    parseFindingIds: [...source.selectedFindingIds],
    parseLiteratureAssociationTuples: source.literatureAssociationTuples.map((tuple) => ({ ...tuple })),
    parseLiteratureSelectionAggregateEligibility: source.literatureSelectionAggregateEligibility,
    parseContextReviewFingerprint: source.contextReviewFingerprint,
    parseContextMode: source.contextMode
  };
}

export function readAIParseDraftSourceRef(
  sourceRefs: readonly AIContextSourceRef[]
): Pick<
  AIParseDraftSourceSnapshot,
  "discussionFingerprint" | "projectId" | "selectedRouteIds" | "selectedTaskIds" | "selectedReviewIds" | "selectedExperimentIds" | "selectedExperimentRunIds" | "experimentRunParentRelations" | "selectedLiteratureIds" | "selectedFindingIds" | "literatureAssociationTuples" | "literatureSelectionAggregateEligibility" | "contextReviewFingerprint" | "contextMode"
> {
  const candidates = sourceRefs.filter((sourceRef) =>
    sourceRef.field === "relevantEffectiveDiscussion" || sourceRef.parseDiscussionFingerprint !== undefined);
  if (candidates.length !== 1) {
    throw new Error("Exactly one canonical Parse Draft discussion source is required.");
  }
  const candidate = candidates[0];
  if (
    !candidate.parseDiscussionFingerprint?.trim() || !candidate.parseProjectId?.trim() ||
    !candidate.parseContextReviewFingerprint?.trim() || !candidate.parseContextMode ||
    !(candidate.parseRouteIds === undefined || Array.isArray(candidate.parseRouteIds)) ||
    !Array.isArray(candidate.parseTaskIds) || !Array.isArray(candidate.parseReviewIds) ||
    !Array.isArray(candidate.parseExperimentIds) ||
    !Array.isArray(candidate.parseExperimentRunIds) ||
    !Array.isArray(candidate.parseExperimentRunParentRelations) ||
    !Array.isArray(candidate.parseLiteratureIds) ||
    !Array.isArray(candidate.parseLiteratureAssociationTuples) ||
    candidate.parseLiteratureSelectionAggregateEligibility !== "ALLOWED"
  ) {
    throw new Error("The canonical Parse Draft discussion source is incomplete.");
  }
  const selectedExperimentRunIds = canonicalOrderedRunIds(candidate.parseExperimentRunIds);
  const experimentRunParentRelations = canonicalRunRelations(candidate.parseExperimentRunParentRelations);
  if (
    selectedExperimentRunIds.length !== experimentRunParentRelations.length ||
    selectedExperimentRunIds.some((runId, index) =>
      experimentRunParentRelations[index]?.runId !== runId) ||
    new Set(experimentRunParentRelations.map((relation) => relation.selectionOrder)).size !== experimentRunParentRelations.length ||
    experimentRunParentRelations.some((relation) => relation.projectId !== candidate.parseProjectId)
  ) {
    throw new Error("Parse Draft ExperimentRun identities and parent relations do not match.");
  }
  const selectedLiteratureIds = canonicalOrderedLiteratureIds(candidate.parseLiteratureIds);
  const selectedFindingIds = canonicalOptionalFindingIds(candidate.parseFindingIds);
  const literatureAssociationTuples = canonicalLiteratureTuples(candidate.parseLiteratureAssociationTuples);
  if (
    selectedLiteratureIds.length !== literatureAssociationTuples.length ||
    selectedLiteratureIds.some((literatureId, index) =>
      literatureAssociationTuples[index]?.literatureId !== literatureId) ||
    new Set(literatureAssociationTuples.map((tuple) => tuple.selectionOrder)).size !== literatureAssociationTuples.length ||
    literatureAssociationTuples.some((tuple) => tuple.projectAssociationKind === "assigned"
      ? tuple.canonicalProjectId !== candidate.parseProjectId ||
        tuple.conversationProjectEligibilityDisposition !== "allowed_same_project"
      : tuple.canonicalProjectId !== null ||
        tuple.conversationProjectEligibilityDisposition !== "allowed_global_projectless")
  ) {
    throw new Error("Parse Draft Literature identities and association tuples do not match.");
  }
  return {
    discussionFingerprint: candidate.parseDiscussionFingerprint,
    projectId: candidate.parseProjectId,
    selectedRouteIds: canonicalIds(candidate.parseRouteIds ?? []),
    selectedTaskIds: canonicalIds(candidate.parseTaskIds),
    selectedReviewIds: canonicalIds(candidate.parseReviewIds),
    selectedExperimentIds: canonicalIds(candidate.parseExperimentIds),
    selectedExperimentRunIds,
    experimentRunParentRelations,
    selectedLiteratureIds,
    selectedFindingIds,
    literatureAssociationTuples,
    literatureSelectionAggregateEligibility: "ALLOWED",
    contextReviewFingerprint: candidate.parseContextReviewFingerprint,
    contextMode: candidate.parseContextMode
  };
}

export async function buildAIParseDraftPromptPackage(
  input: BuildAIParseDraftPromptInput
): Promise<BuildAIParseDraftPromptResult> {
  const conversationId = input.conversationId.trim();
  const projectId = input.contextPackage.scope.id?.trim() ?? "";
  if (
    !conversationId || input.contextPackage.scope.type !== "project" || !projectId ||
    !input.contextPackage.contextMode || !input.contextPackage.reviewFingerprint ||
    !input.contextPackage.budget
  ) {
    throw new Error("Parse Draft requires one reviewed Project/object-scoped A2 ContextPackage.");
  }
  const readback = input.readback ?? await aiConversationRepository.readConversation(conversationId);
  if (readback.conversation.id !== conversationId) {
    throw new Error("The canonical Parse Draft Conversation identity changed.");
  }
  const selectedRouteIds = canonicalIds(
    (input.contextPackage.researchObjects ?? [])
      .filter((descriptor) => descriptor.objectType === "route")
      .map((descriptor) => descriptor.objectId)
  );
  const selectedTaskIds = canonicalIds(
    (input.contextPackage.researchObjects ?? [])
      .filter((descriptor) => descriptor.objectType === "task")
      .map((descriptor) => descriptor.objectId)
  );
  const selectedReviewIds = canonicalIds(
    (input.contextPackage.researchObjects ?? [])
      .filter((descriptor) => descriptor.objectType === "review")
      .map((descriptor) => descriptor.objectId)
  );
  const selectedExperimentIds = canonicalIds(
    (input.contextPackage.researchObjects ?? [])
      .filter((descriptor) => descriptor.objectType === "experiment")
      .map((descriptor) => descriptor.objectId)
  );
  const experimentRunParentRelations = readExperimentRunParentRelations(
    input.contextPackage.sourceRefs
  );
  const selectedExperimentRunIds = experimentRunParentRelations.map((relation) => relation.runId);
  const descriptorRunIds = (input.contextPackage.researchObjects ?? [])
    .filter((descriptor) => descriptor.objectType === "experimentRun")
    .map((descriptor) => descriptor.objectId);
  if (
    descriptorRunIds.length !== selectedExperimentRunIds.length ||
    descriptorRunIds.some((runId, index) => selectedExperimentRunIds[index] !== runId)
  ) {
    throw new Error("Parse Draft requires one canonical parent relation tuple per selected ExperimentRun.");
  }
  const literatureAssociationTuples = readLiteratureAssociationTuples(
    input.contextPackage.sourceRefs
  );
  const selectedLiteratureIds = literatureAssociationTuples.map((tuple) => tuple.literatureId);
  const descriptorLiteratureIds = (input.contextPackage.researchObjects ?? [])
    .filter((descriptor) => descriptor.objectType === "literature")
    .map((descriptor) => descriptor.objectId);
  if (
    descriptorLiteratureIds.length !== selectedLiteratureIds.length ||
    descriptorLiteratureIds.some((literatureId, index) =>
      selectedLiteratureIds[index] !== literatureId)
  ) {
    throw new Error("Parse Draft requires one canonical association tuple per selected Literature ref.");
  }
  const selectedFindingIds = canonicalIds(
    (input.contextPackage.researchObjects ?? [])
      .filter((descriptor) => descriptor.objectType === "finding")
      .map((descriptor) => descriptor.objectId)
  );
  const authorizedMaterialFileRefIds = canonicalIds(
    (input.contextPackage.materialDecisions ?? []).map((material) => material.fileRefId)
  );
  const currentResearchObjects = (input.contextPackage.researchObjects ?? []).map((descriptor) => ({
    objectType: descriptor.objectType,
    objectId: descriptor.objectId
  }));
  if (
    Boolean(input.parseSupplementalContext) !==
      (input.contextRequestFollowupState?.scope === "SAME_PARSE_ATTEMPT_AUTOMATIC_FOLLOWUP")
  ) {
    throw new Error(
      "Parse supplemental continuation requires one explicit automatic follow-up scope and proof."
    );
  }
  const boundary = deriveAIParseDraftBoundary(readback);
  const currentParseEnd = [...readback.projectedMessages]
    .filter((message) => message.messageKind === "text" && message.content.trim())
    .reduce((maximum, message) => Math.max(maximum, message.sequence), 0);
  const latestAttemptedRange = deriveAIParseDraftRetryRange(readback);
  const actionableBoundarySequence = Math.max(
    boundary.lastSuccessfulParseBoundarySequence,
    latestAttemptedRange?.lastSequence ?? 0
  );
  const retryWindow = latestAttemptedRange && currentParseEnd === latestAttemptedRange.lastSequence
    ? latestAttemptedRange
    : undefined;
  const ordinaryRetryScopeMatches = retryWindow && retryScopeMatches({
      range: retryWindow,
      projectId,
      selectedRouteIds,
      selectedTaskIds,
      selectedReviewIds,
      selectedExperimentIds,
      selectedExperimentRunIds,
      experimentRunParentRelations,
      selectedLiteratureIds,
      selectedFindingIds,
      literatureAssociationTuples,
      authorizedMaterialFileRefIds
    });
  const automaticSupplementalRetryScopeMatches = retryWindow && input.parseSupplementalContext
    ? parseSupplementalRetryScopeMatches({
        range: retryWindow,
        continuation: input.parseSupplementalContext,
        currentResearchObjects,
        authorizedMaterialFileRefIds,
        contextRequestFollowupState: input.contextRequestFollowupState
      })
    : false;
  const retryRange = retryWindow && (
    ordinaryRetryScopeMatches || automaticSupplementalRetryScopeMatches
  ) ? retryWindow : undefined;
  if (retryWindow && !retryRange) {
    throw new AIParseDraftSourceSnapshotError(
      "parse_draft_source_snapshot_stale",
      "No-new-message Parse retry requires the exact previously recorded Project, object, relation, and material scope."
    );
  }
  if (!retryRange && currentParseEnd <= actionableBoundarySequence) {
    throw new AIParseDraftBoundaryNoNewContentError(
      actionableBoundarySequence,
      currentParseEnd
    );
  }
  const discussion = selectRelevantEffectiveDiscussion(readback, {
    projectId,
    selectedRouteIds,
    selectedTaskIds,
    selectedReviewIds,
    selectedExperimentIds,
    selectedExperimentRunIds,
    experimentRunParentRelations,
    selectedLiteratureIds,
    selectedFindingIds,
    literatureAssociationTuples,
    literatureSelectionAggregateEligibility: "ALLOWED",
    contextMode: input.contextPackage.contextMode,
    contextReviewFingerprint: input.contextPackage.reviewFingerprint,
    authorizedMaterialFileRefIds
  }, {
    afterMessageSequence: retryRange
      ? retryRange.firstSequence - 1
      : actionableBoundarySequence,
    throughMessageSequence: retryRange?.lastSequence ?? currentParseEnd
  });
  if (
    retryRange &&
    !exactStringArray(discussion.messages.map((message) => message.id), retryRange.messageIds)
  ) {
    throw new Error("The exact previous Parse Draft source range is no longer available for retry.");
  }
  const eligibility = assertAIParseDraftCompletedAnswerEligibility(
    readback,
    discussion.messages
  );
  const completedAnswer = eligibility.completedAnswers[eligibility.completedAnswers.length - 1];
  const quickAnalysisTarget = readQuickAnalysisTarget(
    input.additionalSourceRefs ?? [],
    Boolean(input.quickAnalysisContextCapability)
  );
  if (quickAnalysisTarget && quickAnalysisTarget.projectOrScopeId !== projectId) {
    throw new Error("The Quick Analysis target Project/scope changed before Parse Draft.");
  }
  const structuredManuscriptGuidance = buildAIParseDraftStructuredManuscriptGuidance({
    researchObjects: input.contextPackage.researchObjects ?? [],
    ...(quickAnalysisTarget ? { quickAnalysisTarget } : {})
  });
  const source: AIParseDraftSourceSnapshot = {
    conversationId,
    projectId,
    selectedRouteIds,
    selectedTaskIds,
    selectedReviewIds,
    selectedExperimentIds,
    selectedExperimentRunIds,
    experimentRunParentRelations: experimentRunParentRelations.map((relation) => ({ ...relation })),
    selectedLiteratureIds,
    selectedFindingIds,
    literatureAssociationTuples: literatureAssociationTuples.map((tuple) => ({ ...tuple })),
    literatureSelectionAggregateEligibility: "ALLOWED",
    contextMode: input.contextPackage.contextMode,
    contextBudget: { ...input.contextPackage.budget },
    contextReviewFingerprint: input.contextPackage.reviewFingerprint,
    authorizedMaterialFileRefIds,
    approvedContextRequestContributions: (input.contextPackage.approvedContextRequestContributions ?? [])
      .map((contribution) => ({ ...contribution })),
    discussionFingerprint: discussion.fingerprint,
    discussionMessages: discussion.messages.map((message) => ({
      id: message.id,
      sequence: message.sequence,
      role: message.role
    })),
    firstMessageId: discussion.firstMessageId,
    lastMessageId: discussion.lastMessageId,
    triggerMessageId: discussion.triggerMessageId,
    triggerCallAttemptId: completedAnswer.callAttemptId,
    ...(quickAnalysisTarget ? { quickAnalysisTarget } : {})
  };
  const candidateContextRequestResponseContract = createAIContextRequestResponseContract(input.contextPackage);
  const contextRequestCapabilityEligible = Boolean(candidateContextRequestResponseContract) &&
    input.quickAnalysisContextCapability?.state !== "CONTEXT_EXHAUSTED" &&
    !input.contextRequestFollowupState;
  const contextRequestResponseContract = contextRequestCapabilityEligible
    ? candidateContextRequestResponseContract
    : undefined;
  const constraint = resolveAIActiveConstraintRequest({
    request: { kind: "current", category: "PARSE_DRAFT" },
    purpose: "parse_draft",
    contextRequestCapabilityEligible
  });
  const providerDiscussionMessages = (retryRange
    ? discussion.messages
    : selectCanonicalPromptHistory(readback).filter((message) => message.sequence <= currentParseEnd))
    .filter((message) => message.messageKind === "text" && message.content.trim())
    .map((message) => ({
      ...message,
      content: [
        automaticSupplementalRetryScopeMatches
          ? "[CURRENT PARSE SUPPLEMENTAL CONTINUATION RANGE — exact frozen Phase-A intent; supplied projections add facts but no new operation intent]"
          : retryRange
          ? "[CURRENT PARSE RETRY RANGE — the exact previous source range and the only source of operation intent]"
          : message.sequence <= actionableBoundarySequence
            ? "[BACKGROUND HISTORY — use only when the current Parse delta explicitly refers to it]"
            : "[CURRENT PARSE DELTA — the only source of new operation intent]",
        buildAIParseDraftProviderMessageContent(message)
      ].join("\n")
    }));
  const parseRangeDirective = automaticSupplementalRetryScopeMatches
    ? `This is the one automatic Phase-B continuation of Parse CallAttempt ${input.parseSupplementalContext!.sourceCallAttemptId}. Reorganize only the exact frozen source range from sequence ${retryRange!.firstSequence} through ${retryRange!.lastSequence}; the correlated supplement projection is mechanical context only and introduces no new operation intent. A second Context Request is forbidden.`
    : retryRange
      ? `This is an explicit no-new-message Parse retry. Reorganize only the exact previous source range from sequence ${retryRange.firstSequence} through ${retryRange.lastSequence}. No earlier or later Conversation message is actionable and no old object may be replayed merely because it exists in history.`
      : `The CURRENT PARSE DELTA starts after the latest durable attempted Parse boundary at Conversation Message sequence ${actionableBoundarySequence} and ends at sequence ${currentParseEnd}; only that delta may introduce new operation intent. Earlier projected messages are explicitly marked BACKGROUND HISTORY and may be used only when the current user message explicitly refers to prior discussion (for example, "the one above" or "change the previous task"). Never replay or re-emit an older operation merely because its background text is visible. Resolve owner, target, channel, action, and canonical identity only from frozen Context/allowed tuples; if identity is not unique, return the bounded Context Request outcome instead of guessing.`;
  const built = buildAIPromptPackage(
    input.contextPackage,
    PARSE_DRAFT_USER_INSTRUCTION,
    {
      constraintDescriptor: constraint.descriptor,
      technicalCapacityChars: input.technicalCapacityChars,
      conversationMessages: providerDiscussionMessages,
      maxConversationHistoryChars: AI_PARSE_DRAFT_PROVIDER_HISTORY_MAX_CHARS,
      maxConversationHistoryMessages: AI_PARSE_DRAFT_PROVIDER_HISTORY_MAX_MESSAGES,
      ...(contextRequestResponseContract ? { contextRequestResponseContract } : {}),
      standardResultResponseContract: createAIStandardResultResponseContract(),
      runScopedDirective: input.runScopedDirective ?? (contextRequestCapabilityEligible
        ? PARSE_DRAFT_PHASE_A_CONTEXT_OR_FINAL_DIRECTIVE
        : PARSE_DRAFT_STANDARD_RESULT_ONLY_DIRECTIVE),
      parseDynamicRunScopedSegments: [
        ...(input.parseDynamicRunScopedSegments ?? []),
        ...(structuredManuscriptGuidance.text ? [structuredManuscriptGuidance.text] : []),
        parseRangeDirective
      ],
      quickAnalysisContextCapability: input.quickAnalysisContextCapability,
      contextRequestFollowupState: input.contextRequestFollowupState,
      additionalSourceRefs: input.additionalSourceRefs,
      includeSourceRefs: input.contextPackage.compositionPolicy !== "LITERATURE_OBJECTIVE_OUTLINE",
      outputDetailPreference: input.outputDetailPreference ?? "STANDARD"
    }
  );
  return {
    promptPackage: {
      ...built,
      sourceRefs: [...built.sourceRefs, parseDiscussionSourceRef(source)]
    },
    readback,
    discussion,
    eligibility,
    source
  };
}

function exactDiscussionIdentity(
  left: readonly { id: string; sequence: number; role: "user" | "assistant" }[],
  right: readonly { id: string; sequence: number; role: "user" | "assistant" }[]
): boolean {
  return left.length === right.length && left.every((message, index) => (
    message.id === right[index]?.id &&
    message.sequence === right[index]?.sequence &&
    message.role === right[index]?.role
  ));
}

export function assertAIParseDraftDiscussionStillCurrent(
  readback: AIConversationReadback,
  source: AIParseDraftSourceSnapshot
): RelevantEffectiveDiscussion {
  if (readback.conversation.id !== source.conversationId) {
    throw new Error("The Parse Draft Conversation identity changed.");
  }
  const frozenFirst = source.discussionMessages[0];
  const frozenLast = source.discussionMessages[source.discussionMessages.length - 1];
  if (!frozenFirst || !frozenLast) {
    throw new AIParseDraftSourceSnapshotError(
      "parse_draft_source_snapshot_stale",
      "The frozen Parse Draft discussion is empty."
    );
  }
  const laterEffectiveMessageExists = readback.projectedMessages.some((message) => (
    message.messageKind === "text" && message.content.trim() &&
    message.sequence > frozenLast.sequence
  ));
  if (laterEffectiveMessageExists) {
    throw new AIParseDraftSourceSnapshotError(
      "parse_draft_source_snapshot_stale",
      "The selected semantic discussion changed after Parse Draft."
    );
  }
  const discussion = selectRelevantEffectiveDiscussion(readback, {
    projectId: source.projectId,
    selectedRouteIds: source.selectedRouteIds ?? [],
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
    authorizedMaterialFileRefIds: source.authorizedMaterialFileRefIds
  }, {
    afterMessageSequence: Math.max(0, frozenFirst.sequence - 1),
    throughMessageSequence: frozenLast.sequence
  });
  if (
    discussion.fingerprint !== source.discussionFingerprint ||
    !exactDiscussionIdentity(discussion.messages, source.discussionMessages)
  ) {
    throw new AIParseDraftSourceSnapshotError(
      "parse_draft_source_snapshot_stale",
      "The selected semantic discussion changed; review the Parse Draft scope again."
    );
  }
  return discussion;
}

/**
 * Confirm-time/application preflight. It verifies the reviewed source without
 * replacing it with a newly selected live-history set.
 */
export function assertAIParseDraftSourceSnapshotStillCurrentAndEligible(
  readback: AIConversationReadback,
  source: AIParseDraftSourceSnapshot
): {
  discussion: RelevantEffectiveDiscussion;
  eligibility: AIParseDraftEligibleCompletedAnswer;
} {
  const discussion = assertAIParseDraftDiscussionStillCurrent(readback, source);
  const eligibility = assertAIParseDraftCompletedAnswerEligibility(
    readback,
    discussion.messages
  );
  const completedAnswer = eligibility.completedAnswers[eligibility.completedAnswers.length - 1];
  if (
    !source.triggerCallAttemptId ||
    source.triggerCallAttemptId !== completedAnswer?.callAttemptId
  ) {
    throw new AIParseDraftSourceSnapshotError(
      "parse_draft_source_eligibility_proof_mismatch",
      "The frozen completed-answer proof changed; review the Parse Draft scope again."
    );
  }
  return { discussion, eligibility };
}
