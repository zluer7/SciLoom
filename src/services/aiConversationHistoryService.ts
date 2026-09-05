import type { AIConversationReadback, AIMessage } from "../types";
import type {
  AIContextMode,
  AIExperimentRunParentRelation,
  AILiteratureAssociationTuple,
  AILiteratureSelectionAggregateEligibility
} from "../types/aiContext";

export type CanonicalPromptHistoryOptions = {
  beforeMessageId?: string;
};

export type RelevantEffectiveDiscussionOptions = {
  maxMessages?: number;
  maxChars?: number;
  /** Exact Conversation-local incremental boundary. */
  afterMessageSequence?: number;
  /** Exact frozen end captured when Parse Draft is prepared. */
  throughMessageSequence?: number;
};

export function selectCanonicalPromptHistory(
  readback: AIConversationReadback,
  options: CanonicalPromptHistoryOptions = {}
): AIMessage[] {
  const beforeSequence = options.beforeMessageId
    ? readback.messages.find((message) => (
        message.id === options.beforeMessageId && message.role === "user"
      ))?.sequence
    : undefined;
  if (options.beforeMessageId && beforeSequence === undefined) {
    throw new Error("The canonical history boundary Message is unavailable.");
  }
  return [...readback.projectedMessages]
    .filter((message) => beforeSequence === undefined || message.sequence < beforeSequence)
    .sort((left, right) => (
      left.sequence - right.sequence ||
      left.createdAt.localeCompare(right.createdAt) ||
      left.id.localeCompare(right.id)
    ));
}

export const AI_RELEVANT_DISCUSSION_MAX_MESSAGES = 12;
export const AI_RELEVANT_DISCUSSION_MAX_CHARS = 4_000;

export type RelevantEffectiveDiscussionScope = {
  projectId: string;
  selectedRouteIds?: readonly string[];
  selectedTaskIds: readonly string[];
  selectedReviewIds: readonly string[];
  selectedExperimentIds: readonly string[];
  selectedExperimentRunIds: readonly string[];
  experimentRunParentRelations: readonly AIExperimentRunParentRelation[];
  selectedLiteratureIds?: readonly string[];
  selectedFindingIds?: readonly string[];
  literatureAssociationTuples?: readonly AILiteratureAssociationTuple[];
  literatureSelectionAggregateEligibility?: AILiteratureSelectionAggregateEligibility;
  contextMode: AIContextMode;
  contextReviewFingerprint: string;
  authorizedMaterialFileRefIds: readonly string[];
};

export type RelevantEffectiveDiscussion = {
  messages: AIMessage[];
  fingerprint: string;
  firstMessageId: string;
  lastMessageId: string;
  triggerMessageId: string;
  summary: string;
  selectedCharacters: number;
};

export type AIParseDraftCompletedAnswerEvidence = {
  messageId: string;
  messageSequence: number;
  callAttemptId: string;
  callAttemptSequence: number;
};

export type AIParseDraftCompletedAnswerEligibility =
  | {
      eligible: true;
      code: "eligible";
      selectedMessageIds: string[];
      completedAnswers: AIParseDraftCompletedAnswerEvidence[];
    }
  | {
      eligible: false;
      code: "completed_assistant_answer_missing";
      selectedMessageIds: string[];
      completedAnswers: [];
    };

export type AIParseDraftEligibleCompletedAnswer = Extract<
  AIParseDraftCompletedAnswerEligibility,
  { eligible: true }
>;

export class AIParseDraftEligibilityError extends Error {
  readonly code = "parse_draft_completed_answer_required" as const;

  constructor(readonly eligibility: AIParseDraftCompletedAnswerEligibility) {
    super("当前暂无可解析的已完成 AI 回答。");
    this.name = "AIParseDraftEligibilityError";
  }
}

export function isAIParseDraftEligibilityError(
  error: unknown
): error is AIParseDraftEligibilityError {
  return error instanceof AIParseDraftEligibilityError;
}

function orderedUnique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()))].sort((left, right) => left.localeCompare(right));
}

function orderedUniqueRunIds(values: readonly string[] = []): string[] {
  const unique = new Set<string>();
  const ordered: string[] = [];
  for (const value of values) {
    if (!value.trim() || unique.has(value)) continue;
    unique.add(value);
    ordered.push(value);
  }
  return ordered;
}

function orderedRunRelations(
  values: readonly AIExperimentRunParentRelation[] = []
): AIExperimentRunParentRelation[] {
  const sorted = [...values].sort((left, right) =>
    left.selectionOrder - right.selectionOrder || left.runId.localeCompare(right.runId));
  const unique = new Map<string, AIExperimentRunParentRelation>();
  for (const relation of sorted) {
    const key = `experimentRun:${relation.runId}`;
    if (!unique.has(key)) {
      unique.set(key, {
        runId: relation.runId,
        parentExperimentId: relation.parentExperimentId,
        projectId: relation.projectId,
        selectionOrder: relation.selectionOrder
      });
    }
  }
  return [...unique.values()];
}

function orderedLiteratureTuples(
  values: readonly AILiteratureAssociationTuple[] = []
): AILiteratureAssociationTuple[] {
  const sorted = [...values].sort((left, right) =>
    left.selectionOrder - right.selectionOrder || left.literatureId.localeCompare(right.literatureId));
  const unique = new Map<string, AILiteratureAssociationTuple>();
  for (const tuple of sorted) {
    const key = `literature:${tuple.literatureId}`;
    if (!unique.has(key)) {
      unique.set(key, {
        literatureId: tuple.literatureId,
        projectAssociationKind: tuple.projectAssociationKind,
        canonicalProjectId: tuple.canonicalProjectId,
        lifecycleEligibility: tuple.lifecycleEligibility,
        conversationProjectEligibilityDisposition: tuple.conversationProjectEligibilityDisposition,
        selectionOrder: tuple.selectionOrder,
        normalizedProjectionFingerprint: tuple.normalizedProjectionFingerprint
      });
    }
  }
  return [...unique.values()];
}

function fnvIdentity(value: string): string {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `lp13-a6-discussion-${hash.toString(16).padStart(8, "0")}`;
}

function compact(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  const characters = Array.from(normalized);
  return characters.length <= maxChars
    ? normalized
    : `${characters.slice(0, Math.max(0, maxChars - 1)).join("")}…`;
}

/**
 * Sole mechanical completed-answer predicate for Parse Draft. The caller must
 * pass the exact ordered output of the canonical relevant-discussion selector.
 * It never judges answer quality or mutates/reselects the message set.
 */
export function evaluateAIParseDraftCompletedAnswerEligibility(
  readback: AIConversationReadback,
  selectedMessages: readonly AIMessage[]
): AIParseDraftCompletedAnswerEligibility {
  const selectedMessageIds = selectedMessages.map((message) => message.id);
  const selectedAssistantMessages = new Map(
    selectedMessages
      .filter((message) => (
        message.role === "assistant" &&
        message.messageKind === "text" &&
        Boolean(message.content.trim())
      ))
      .map((message) => [message.id, message])
  );
  const contextRequestSourceAttemptIds = new Set(
    (readback.contextRequests ?? []).map((request) => request.sourceCallAttemptId)
  );
  const completedAnswers = readback.callAttempts
    .filter((attempt) => (
      attempt.purpose === "chat_response" &&
      attempt.status === "succeeded" &&
      attempt.responseTruncated !== true &&
      Boolean(attempt.resultMessageId) &&
      !contextRequestSourceAttemptIds.has(attempt.id) &&
      selectedAssistantMessages.has(attempt.resultMessageId!)
    ))
    .map((attempt) => {
      const message = selectedAssistantMessages.get(attempt.resultMessageId!)!;
      return {
        messageId: message.id,
        messageSequence: message.sequence,
        callAttemptId: attempt.id,
        callAttemptSequence: attempt.sequence
      };
    })
    .sort((left, right) => (
      left.messageSequence - right.messageSequence ||
      left.callAttemptSequence - right.callAttemptSequence ||
      left.callAttemptId.localeCompare(right.callAttemptId)
    ));
  return completedAnswers.length > 0
    ? {
        eligible: true,
        code: "eligible",
        selectedMessageIds,
        completedAnswers
      }
    : {
        eligible: false,
        code: "completed_assistant_answer_missing",
        selectedMessageIds,
        completedAnswers: []
      };
}

export function assertAIParseDraftCompletedAnswerEligibility(
  readback: AIConversationReadback,
  selectedMessages: readonly AIMessage[]
): AIParseDraftEligibleCompletedAnswer {
  const eligibility = evaluateAIParseDraftCompletedAnswerEligibility(
    readback,
    selectedMessages
  );
  if (!eligibility.eligible) {
    throw new AIParseDraftEligibilityError(eligibility);
  }
  return eligibility;
}

/**
 * Canonical history read-model selector for Parse Draft. It consumes only B8's
 * effective projection: every selected user correction is preserved while only
 * the effective assistant variant can appear for an assistant turn.
 */
export function selectRelevantEffectiveDiscussion(
  readback: AIConversationReadback,
  scope: RelevantEffectiveDiscussionScope,
  options: RelevantEffectiveDiscussionOptions = {}
): RelevantEffectiveDiscussion {
  if (readback.conversation.id.trim() === "" || scope.projectId.trim() === "") {
    throw new Error("Conversation and Project identities are required for Parse Draft scope.");
  }
  const maxMessages = options.maxMessages ?? AI_RELEVANT_DISCUSSION_MAX_MESSAGES;
  const maxChars = options.maxChars ?? AI_RELEVANT_DISCUSSION_MAX_CHARS;
  if (!Number.isSafeInteger(maxMessages) || maxMessages < 1 || !Number.isSafeInteger(maxChars) || maxChars < 1) {
    throw new Error("Relevant discussion bounds are invalid.");
  }
  const candidates = [...readback.projectedMessages]
    .filter((message) => (
      message.messageKind === "text" && message.content.trim() &&
      (options.afterMessageSequence === undefined || message.sequence > options.afterMessageSequence) &&
      (options.throughMessageSequence === undefined || message.sequence <= options.throughMessageSequence)
    ))
    .sort((left, right) =>
      left.sequence - right.sequence || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  const selected: AIMessage[] = [];
  let selectedCharacters = 0;
  for (let index = candidates.length - 1; index >= 0 && selected.length < maxMessages; index -= 1) {
    const candidate = candidates[index];
    const length = Array.from(candidate.content).length;
    if (length > maxChars) {
      if (selected.length === 0) {
        throw new Error("The latest relevant discussion Message exceeds the Parse Draft bound; no truncation is allowed.");
      }
      break;
    }
    if (selectedCharacters + length > maxChars) break;
    selected.unshift(candidate);
    selectedCharacters += length;
  }
  while (selected[0]?.role === "assistant") {
    selectedCharacters -= Array.from(selected[0].content).length;
    selected.shift();
  }
  const trigger = [...selected].reverse().find((message) => message.role === "user");
  if (!trigger || selected.length === 0) {
    throw new Error("Parse Draft requires at least one bounded canonical user discussion Message.");
  }
  const selectedExperimentRunIds = orderedUniqueRunIds(scope.selectedExperimentRunIds);
  const experimentRunParentRelations = orderedRunRelations(scope.experimentRunParentRelations);
  if (
    experimentRunParentRelations.length !== (scope.experimentRunParentRelations?.length ?? 0) ||
    selectedExperimentRunIds.length !== experimentRunParentRelations.length ||
    selectedExperimentRunIds.some((runId, index) =>
      experimentRunParentRelations[index]?.runId !== runId) ||
    experimentRunParentRelations.some((relation) =>
      !relation.runId.trim() || !relation.parentExperimentId.trim() ||
      relation.projectId !== scope.projectId ||
      !Number.isSafeInteger(relation.selectionOrder) || relation.selectionOrder < 0)
  ) {
    throw new Error("Parse Draft ExperimentRun scope requires one exact canonical parent relation per selected Run.");
  }
  const selectedLiteratureIds = orderedUniqueRunIds(scope.selectedLiteratureIds ?? []);
  const literatureAssociationTuples = orderedLiteratureTuples(scope.literatureAssociationTuples ?? []);
  const literatureSelectionAggregateEligibility = scope.literatureSelectionAggregateEligibility ?? "ALLOWED";
  if (
    literatureSelectionAggregateEligibility !== "ALLOWED" ||
    literatureAssociationTuples.length !== (scope.literatureAssociationTuples?.length ?? 0) ||
    selectedLiteratureIds.length !== literatureAssociationTuples.length ||
    selectedLiteratureIds.some((literatureId, index) =>
      literatureAssociationTuples[index]?.literatureId !== literatureId) ||
    new Set(literatureAssociationTuples.map((tuple) => tuple.selectionOrder)).size !== literatureAssociationTuples.length ||
    literatureAssociationTuples.some((tuple) =>
      !tuple.literatureId.trim() || !tuple.normalizedProjectionFingerprint.trim() ||
      tuple.lifecycleEligibility !== "eligible" ||
      (tuple.projectAssociationKind === "assigned"
        ? tuple.canonicalProjectId !== scope.projectId ||
          tuple.conversationProjectEligibilityDisposition !== "allowed_same_project"
        : tuple.projectAssociationKind !== "projectless" || tuple.canonicalProjectId !== null ||
          tuple.conversationProjectEligibilityDisposition !== "allowed_global_projectless"))
  ) {
    throw new Error("Parse Draft Literature scope requires exact ordered association and eligibility tuples.");
  }
  const scopeIdentity = {
    conversationId: readback.conversation.id,
    projectId: scope.projectId,
    selectedRouteIds: orderedUnique(scope.selectedRouteIds ?? []),
    selectedTaskIds: orderedUnique(scope.selectedTaskIds),
    selectedReviewIds: orderedUnique(scope.selectedReviewIds),
    selectedExperimentIds: orderedUnique(scope.selectedExperimentIds),
    selectedExperimentRunIds,
    experimentRunParentRelations,
    selectedLiteratureIds,
    selectedFindingIds: orderedUnique(scope.selectedFindingIds ?? []),
    literatureAssociationTuples,
    literatureSelectionAggregateEligibility,
    contextMode: scope.contextMode,
    contextReviewFingerprint: scope.contextReviewFingerprint,
    authorizedMaterialFileRefIds: orderedUnique(scope.authorizedMaterialFileRefIds),
    messages: selected.map((message) => ({
      id: message.id,
      sequence: message.sequence,
      role: message.role
    }))
  };
  const first = selected[0];
  const last = selected[selected.length - 1];
  return {
    messages: selected,
    fingerprint: fnvIdentity(JSON.stringify(scopeIdentity)),
    firstMessageId: first.id,
    lastMessageId: last.id,
    triggerMessageId: trigger.id,
    summary: `${compact(first.content, 100)}${first.id === last.id ? "" : ` → ${compact(last.content, 100)}`}`,
    selectedCharacters
  };
}
