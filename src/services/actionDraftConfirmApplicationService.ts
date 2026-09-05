import { aiConversationRepository } from "../repositories/aiConversationRepository";
import type {
  AICallAttempt,
  AIConversationReadback,
  DurableAIInvocationResult
} from "../types/aiConversation";
import type {
  ActionDraftGenerationReadback,
  ActionDraftSourceTuple,
  AIActionDraft,
  AIActionDraftApplyResult,
  AIActionDraftUnion,
  AIEntityLinkCreateDraftPayload,
  AIFindingCreateDraftPayload,
  AIOutputCandidateCreateDraftPayload,
  AIOutputGapCreateDraftPayload,
  AIReviewCandidateDraftPayload,
  AITaskCreateDraftPayload,
  CanonicalTargetScope,
  MountedSelectionSnapshot
} from "../types/aiDraft";
import type { EntityType } from "../types/planning";
import {
  actionDraftSourceTupleKey,
  assertCompleteActionDraftSourceTuple,
  isExactMountedSelectionSnapshot,
  mountedSelectionMatchesTuple
} from "./actionDraftSourceTupleService";
import { applyAIEntityLinkDraft } from "./aiEntityLinkDraftApplyAdapter";
import {
  getAIActionDraftApplyCapability,
  publishAIActionDraftApplyFeedback
} from "./aiDraftApplyExecutor";
import { applyAIFindingDraft } from "./aiFindingDraftApplyAdapter";
import { applyAIOutputCandidateDraft } from "./aiOutputCandidateDraftApplyAdapter";
import { applyAIOutputGapDraft } from "./aiOutputGapDraftApplyAdapter";
import { applyAIReviewDraft } from "./aiReviewDraftApplyAdapter";
import { applyAITaskDraft } from "./aiTaskDraftApplyAdapter";
import { experimentService } from "./experimentService";
import { literatureService } from "./literatureService";
import { outputConversionService } from "./outputConversionService";
import { planningService } from "./planningService";

export type ActionDraftContextErrorCode =
  | "action_draft_source_changed"
  | "action_draft_scope_changed"
  | "action_draft_source_not_effective"
  | "action_draft_generation_not_valid"
  | "action_draft_confirmation_required"
  | "action_draft_apply_in_progress"
  | "action_draft_context_unavailable";

export class ActionDraftContextGuardError extends Error {
  constructor(
    readonly code: ActionDraftContextErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ActionDraftContextGuardError";
  }
}

type TaskDraft = Extract<AIActionDraftUnion, { draftType: "task_create" }>;
type ReviewDraft = Extract<AIActionDraftUnion, { draftType: "review_candidate" }>;
type OutputGapDraft = Extract<AIActionDraftUnion, { draftType: "output_gap_create" }>;
type FindingDraft = Extract<AIActionDraftUnion, { draftType: "finding_create" }>;
type OutputCandidateDraft = Extract<
  AIActionDraftUnion,
  { draftType: "output_candidate_create" }
>;
type EntityLinkDraft = Extract<AIActionDraftUnion, { draftType: "entity_link_create" }>;

type VerifiedActionDraftApplyContext = {
  readonly verifiedCanonicalBusinessScope: CanonicalTargetScope;
  readonly verifiedSourceTuple: ActionDraftSourceTuple;
  readonly validatedDraft: AIActionDraftUnion;
  readonly userConfirmedWrite: true;
  readonly confirmedAt: string;
};

type FormalApplyBoundary = (
  context: VerifiedActionDraftApplyContext
) => Promise<AIActionDraftApplyResult>;

type ResolveEntityProjectId = (
  entityType: EntityType,
  entityId: string
) => Promise<string | undefined>;

export interface ActionDraftConfirmDependencies {
  readConversation: typeof aiConversationRepository.readConversation;
  getProjectById: typeof planningService.getProjectById;
  getReviewById: typeof planningService.getReviewById;
  resolveEntityProjectId: ResolveEntityProjectId;
  applyTaskDraft: typeof applyAITaskDraft;
  applyReviewDraft: typeof applyAIReviewDraft;
  applyOutputGapDraft: typeof applyAIOutputGapDraft;
  applyFindingDraft: typeof applyAIFindingDraft;
  applyOutputCandidateDraft: typeof applyAIOutputCandidateDraft;
  applyEntityLinkDraft: typeof applyAIEntityLinkDraft;
  publishFeedback: typeof publishAIActionDraftApplyFeedback;
  now: () => string;
  formalApplyBoundary?: FormalApplyBoundary;
}

export interface ConfirmAIActionDraftInput {
  readonly draft: AIActionDraftUnion;
  readonly sourceTuple: ActionDraftSourceTuple;
  readonly mountedSelectionSnapshot: MountedSelectionSnapshot;
  readonly readCurrentMountedSelection: () => MountedSelectionSnapshot;
  readonly userConfirmedWrite: boolean;
}

const CONTEXT_CHANGED_MESSAGE =
  "The Action Draft context changed. Regenerate the Action Draft before confirming.";
const ACTION_DRAFT_CONTEXT_ERROR_CODES = new Set<ActionDraftContextErrorCode>([
  "action_draft_source_changed",
  "action_draft_scope_changed",
  "action_draft_source_not_effective",
  "action_draft_generation_not_valid",
  "action_draft_confirmation_required",
  "action_draft_apply_in_progress",
  "action_draft_context_unavailable"
]);

function fail(
  code: ActionDraftContextErrorCode,
  message = CONTEXT_CHANGED_MESSAGE
): never {
  throw new ActionDraftContextGuardError(code, message);
}

function requiredText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredIdentity(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value === value.trim()
    ? value
    : undefined;
}

function projectScopeFromAttempt(attempt: AICallAttempt): CanonicalTargetScope {
  const projectIds = [...new Set(
    attempt.contextSourceRefs
      .filter((sourceRef) => (
        sourceRef.module === "project" && sourceRef.entityType === "project"
      ))
      .map((sourceRef) => requiredIdentity(sourceRef.entityId))
      .filter((projectId): projectId is string => Boolean(projectId))
  )];
  if (projectIds.length !== 1) {
    fail("action_draft_scope_changed");
  }
  return Object.freeze({ scopeKind: "project", scopeId: projectIds[0] });
}

async function deriveCanonicalSourceTuple(
  readback: AIConversationReadback,
  actionDraftGenerationCallAttemptId: string,
  getProjectById: ActionDraftConfirmDependencies["getProjectById"]
): Promise<ActionDraftSourceTuple> {
  const generationAttemptId = requiredIdentity(actionDraftGenerationCallAttemptId);
  if (!generationAttemptId) fail("action_draft_generation_not_valid");
  const conversationId = requiredIdentity(readback.conversation?.id);
  if (!conversationId) fail("action_draft_context_unavailable");
  const effectiveMessageId = requiredIdentity(
    readback.retryRegenerate.effectiveAssistantMessageId
  );
  const sourceAttemptId = requiredIdentity(
    readback.retryRegenerate.effectiveSourceAttemptId
  );
  if (!effectiveMessageId || !sourceAttemptId) {
    fail("action_draft_source_not_effective");
  }
  const sourceMessage = readback.messages.find((message) => (
    message.id === effectiveMessageId &&
    message.conversationId === conversationId &&
    message.role === "assistant"
  ));
  if (!sourceMessage) fail("action_draft_source_not_effective");
  const sourceAttempt = readback.callAttempts.find((attempt) => (
    attempt.id === sourceAttemptId
  ));
  if (
    !sourceAttempt ||
    sourceAttempt.purpose !== "chat_response" ||
    sourceAttempt.status !== "succeeded" ||
    sourceAttempt.conversationId !== conversationId ||
    sourceAttempt.resultMessageId !== effectiveMessageId
  ) {
    fail("action_draft_source_changed");
  }
  const actionDraftAttempt = readback.callAttempts.find((attempt) => (
    attempt.id === generationAttemptId
  ));
  if (
    !actionDraftAttempt ||
    actionDraftAttempt.purpose !== "action_draft_generation" ||
    actionDraftAttempt.status !== "succeeded" ||
    actionDraftAttempt.conversationId !== conversationId ||
    actionDraftAttempt.triggerMessageId !== effectiveMessageId ||
    actionDraftAttempt.triggerCallAttemptId !== sourceAttemptId
  ) {
    fail("action_draft_generation_not_valid");
  }
  const sourceScope = projectScopeFromAttempt(sourceAttempt);
  const actionDraftScope = projectScopeFromAttempt(actionDraftAttempt);
  if (sourceScope.scopeId !== actionDraftScope.scopeId) {
    fail("action_draft_scope_changed");
  }
  const project = await getProjectById(sourceScope.scopeId);
  if (!project || project.id !== sourceScope.scopeId || project.deletedAt) {
    fail("action_draft_scope_changed");
  }
  return Object.freeze({
    conversationId,
    canonicalBusinessScopeIdentity: sourceScope,
    effectiveSourceAssistantMessageId: effectiveMessageId,
    sourceOrdinaryChatCallAttemptId: sourceAttemptId,
    actionDraftGenerationCallAttemptId: generationAttemptId
  });
}

function assertTupleExact(
  expected: ActionDraftSourceTuple,
  actual: ActionDraftSourceTuple
): void {
  if (actionDraftSourceTupleKey(expected) !== actionDraftSourceTupleKey(actual)) {
    if (
      expected.canonicalBusinessScopeIdentity.scopeId !==
      actual.canonicalBusinessScopeIdentity.scopeId
    ) {
      fail("action_draft_scope_changed");
    }
    if (
      expected.actionDraftGenerationCallAttemptId !==
      actual.actionDraftGenerationCallAttemptId
    ) {
      fail("action_draft_generation_not_valid");
    }
    fail("action_draft_source_changed");
  }
}

async function defaultResolveEntityProjectId(
  entityType: EntityType,
  entityId: string
): Promise<string | undefined> {
  if (entityType === "project") {
    const project = await planningService.getProjectById(entityId);
    return project?.id;
  }
  const entity = entityType === "routeNode"
    ? await planningService.getRouteNodeById(entityId)
    : entityType === "task"
      ? await planningService.getTaskById(entityId)
      : entityType === "review"
        ? await planningService.getReviewById(entityId)
        : entityType === "experiment"
          ? await experimentService.getExperimentById(entityId)
          : entityType === "resultItem"
            ? await outputConversionService.getResultItemById(entityId)
            : entityType === "finding"
              ? await outputConversionService.getFindingById(entityId)
              : entityType === "outputCandidate"
                ? await outputConversionService.getOutputCandidateById(entityId)
                : entityType === "outputGap"
                  ? await outputConversionService.getOutputGapById(entityId)
                  : entityType === "literature"
                    ? await literatureService.getLiteratureById(entityId)
                    : undefined;
  return entity && "projectId" in entity && typeof entity.projectId === "string"
    ? entity.projectId
    : undefined;
}

async function bindDraftToVerifiedScope(
  draft: AIActionDraftUnion,
  scope: CanonicalTargetScope,
  dependencies: ActionDraftConfirmDependencies
): Promise<AIActionDraftUnion> {
  const payload = draft.proposedPayload as Record<string, unknown>;
  if (
    draft.draftType === "task_create" ||
    draft.draftType === "output_gap_create" ||
    draft.draftType === "finding_create" ||
    draft.draftType === "output_candidate_create"
  ) {
    return {
      ...draft,
      proposedPayload: { ...payload, projectId: scope.scopeId }
    } as AIActionDraftUnion;
  }
  if (draft.draftType === "review_candidate") {
    const reviewId = requiredText(payload.reviewId);
    const review = reviewId
      ? await dependencies.getReviewById(reviewId)
      : undefined;
    if (!review || review.projectId !== scope.scopeId || review.deletedAt) {
      fail("action_draft_scope_changed");
    }
    return {
      ...draft,
      proposedPayload: { ...payload, projectId: scope.scopeId }
    } as AIActionDraftUnion;
  }
  if (draft.draftType === "entity_link_create") {
    const sourceType = payload.sourceType as EntityType;
    const sourceId = requiredText(payload.sourceId);
    const targetType = payload.targetType as EntityType;
    const targetId = requiredText(payload.targetId);
    if (!sourceType || !sourceId || !targetType || !targetId) {
      fail("action_draft_scope_changed");
    }
    const [sourceProjectId, targetProjectId] = await Promise.all([
      dependencies.resolveEntityProjectId(sourceType, sourceId),
      dependencies.resolveEntityProjectId(targetType, targetId)
    ]);
    if (sourceProjectId !== scope.scopeId || targetProjectId !== scope.scopeId) {
      fail("action_draft_scope_changed");
    }
  }
  return draft;
}

function applyFailure(
  draft: AIActionDraftUnion,
  appliedAt: string,
  errorCode: string,
  message: string
): AIActionDraftApplyResult {
  return {
    success: false,
    result: "failed",
    message,
    errorCode,
    errorMessage: message,
    sourceDraftId: draft.draftInstanceId,
    appliedAt
  };
}

function createFormalApplyBoundary(
  dependencies: ActionDraftConfirmDependencies
): FormalApplyBoundary {
  return async (context) => {
    const draft = context.validatedDraft;
    if (draft.draftType === "task_create") {
      return dependencies.applyTaskDraft({
        draft: draft as TaskDraft & { proposedPayload: AITaskCreateDraftPayload },
        appliedAt: context.confirmedAt
      });
    }
    if (draft.draftType === "review_candidate") {
      return dependencies.applyReviewDraft({
        draft: draft as ReviewDraft & { proposedPayload: AIReviewCandidateDraftPayload },
        appliedAt: context.confirmedAt
      });
    }
    if (draft.draftType === "output_gap_create") {
      return dependencies.applyOutputGapDraft({
        draft: draft as OutputGapDraft & { proposedPayload: AIOutputGapCreateDraftPayload },
        appliedAt: context.confirmedAt
      });
    }
    if (draft.draftType === "finding_create") {
      return dependencies.applyFindingDraft({
        draft: draft as FindingDraft & { proposedPayload: AIFindingCreateDraftPayload },
        appliedAt: context.confirmedAt
      });
    }
    if (draft.draftType === "output_candidate_create") {
      return dependencies.applyOutputCandidateDraft({
        draft: draft as OutputCandidateDraft & {
          proposedPayload: AIOutputCandidateCreateDraftPayload;
        },
        appliedAt: context.confirmedAt
      });
    }
    return dependencies.applyEntityLinkDraft({
      draft: draft as EntityLinkDraft & { proposedPayload: AIEntityLinkCreateDraftPayload },
      appliedAt: context.confirmedAt
    });
  };
}

export function isActionDraftContextGuardErrorCode(
  value: string | undefined
): value is ActionDraftContextErrorCode {
  return ACTION_DRAFT_CONTEXT_ERROR_CODES.has(value as ActionDraftContextErrorCode);
}

export function createActionDraftConfirmApplicationService(
  overrides: Partial<ActionDraftConfirmDependencies> = {}
) {
  const dependencies: ActionDraftConfirmDependencies = {
    readConversation: aiConversationRepository.readConversation,
    getProjectById: planningService.getProjectById,
    getReviewById: planningService.getReviewById,
    resolveEntityProjectId: defaultResolveEntityProjectId,
    applyTaskDraft: applyAITaskDraft,
    applyReviewDraft: applyAIReviewDraft,
    applyOutputGapDraft: applyAIOutputGapDraft,
    applyFindingDraft: applyAIFindingDraft,
    applyOutputCandidateDraft: applyAIOutputCandidateDraft,
    applyEntityLinkDraft: applyAIEntityLinkDraft,
    publishFeedback: publishAIActionDraftApplyFeedback,
    now: () => new Date().toISOString(),
    ...overrides
  };
  const formalApplyBoundary =
    dependencies.formalApplyBoundary ?? createFormalApplyBoundary(dependencies);
  const inFlight = new Map<string, Promise<AIActionDraftApplyResult>>();
  const written = new Set<string>();

  async function readGeneration(
    durableResult: DurableAIInvocationResult
  ): Promise<ActionDraftGenerationReadback> {
    if (
      durableResult.callAttempt.purpose !== "action_draft_generation" ||
      durableResult.callAttempt.status !== "succeeded" ||
      durableResult.conversation.id !== durableResult.readback.conversation.id
    ) {
      fail("action_draft_generation_not_valid");
    }
    let readback: AIConversationReadback;
    try {
      readback = await dependencies.readConversation(durableResult.conversation.id);
    } catch {
      fail("action_draft_context_unavailable");
    }
    if (readback.conversation.id !== durableResult.conversation.id) {
      fail("action_draft_source_changed");
    }
    const sourceTuple = await deriveCanonicalSourceTuple(
      readback,
      durableResult.callAttempt.id,
      dependencies.getProjectById
    );
    if (
      durableResult.triggerMessage.id !== sourceTuple.effectiveSourceAssistantMessageId ||
      durableResult.callAttempt.triggerMessageId !==
        sourceTuple.effectiveSourceAssistantMessageId ||
      durableResult.callAttempt.triggerCallAttemptId !==
        sourceTuple.sourceOrdinaryChatCallAttemptId
    ) {
      fail("action_draft_generation_not_valid");
    }
    return Object.freeze({
      generatedText: durableResult.response.text,
      sourceTuple
    });
  }

  function confirm(input: ConfirmAIActionDraftInput): Promise<AIActionDraftApplyResult> {
    const confirmedAt = dependencies.now();
    const capability = getAIActionDraftApplyCapability(input.draft);
    if (!capability.allowed) {
      const result = applyFailure(
        input.draft,
        confirmedAt,
        capability.errorCode ?? "action_draft_context_unavailable",
        capability.message
      );
      dependencies.publishFeedback(result);
      return Promise.resolve(result);
    }
    if (input.userConfirmedWrite !== true) {
      const result = applyFailure(
        input.draft,
        confirmedAt,
        "action_draft_confirmation_required",
        "Explicit user confirmation is required before business write-back."
      );
      dependencies.publishFeedback(result);
      return Promise.resolve(result);
    }
    try {
      assertCompleteActionDraftSourceTuple(input.sourceTuple);
      if (!mountedSelectionMatchesTuple(input.mountedSelectionSnapshot, input.sourceTuple)) {
        const code = input.mountedSelectionSnapshot.scopeIdentity.scopeId !==
          input.sourceTuple.canonicalBusinessScopeIdentity.scopeId
          ? "action_draft_scope_changed"
          : "action_draft_source_changed";
        fail(code);
      }
    } catch (error) {
      const guarded = error instanceof ActionDraftContextGuardError
        ? error
        : new ActionDraftContextGuardError(
            "action_draft_context_unavailable",
            CONTEXT_CHANGED_MESSAGE
          );
      const result = applyFailure(input.draft, confirmedAt, guarded.code, guarded.message);
      dependencies.publishFeedback(result);
      return Promise.resolve(result);
    }

    const operationKey = `${actionDraftSourceTupleKey(input.sourceTuple)}|${
      input.draft.draftInstanceId.length
    }:${input.draft.draftInstanceId}`;
    const current = inFlight.get(operationKey);
    if (current) return current;
    if (written.has(operationKey)) {
      const result = applyFailure(
        input.draft,
        confirmedAt,
        "action_draft_apply_in_progress",
        "This Action Draft has already been written in the current mounted session."
      );
      dependencies.publishFeedback(result);
      return Promise.resolve(result);
    }

    const operation = (async () => {
      try {
        let canonicalReadback: AIConversationReadback;
        try {
          canonicalReadback = await dependencies.readConversation(
            input.sourceTuple.conversationId
          );
        } catch {
          fail("action_draft_context_unavailable");
        }
        const verifiedTuple = await deriveCanonicalSourceTuple(
          canonicalReadback,
          input.sourceTuple.actionDraftGenerationCallAttemptId,
          dependencies.getProjectById
        );
        assertTupleExact(input.sourceTuple, verifiedTuple);
        const validatedDraft = await bindDraftToVerifiedScope(
          input.draft,
          verifiedTuple.canonicalBusinessScopeIdentity,
          dependencies
        );
        const currentMountedSelection = input.readCurrentMountedSelection();
        if (
          !isExactMountedSelectionSnapshot(
            input.mountedSelectionSnapshot,
            currentMountedSelection
          ) ||
          !mountedSelectionMatchesTuple(currentMountedSelection, verifiedTuple)
        ) {
          const code = currentMountedSelection.scopeIdentity.scopeId !==
            verifiedTuple.canonicalBusinessScopeIdentity.scopeId
            ? "action_draft_scope_changed"
            : "action_draft_source_changed";
          fail(code);
        }

        const verifiedContext: VerifiedActionDraftApplyContext = {
          verifiedCanonicalBusinessScope:
            verifiedTuple.canonicalBusinessScopeIdentity,
          verifiedSourceTuple: verifiedTuple,
          validatedDraft,
          userConfirmedWrite: true,
          confirmedAt
        };

        // ActionDraftConfirmAuthorizationLinearizationPoint: every guard is complete,
        // the one-shot verified context is owned by this operation, and formal apply starts now.
        const result = await formalApplyBoundary(verifiedContext);
        if (
          result.success &&
          result.result === "written"
        ) {
          written.add(operationKey);
        }
        dependencies.publishFeedback(result);
        return result;
      } catch (error) {
        const guarded = error instanceof ActionDraftContextGuardError
          ? error
          : new ActionDraftContextGuardError(
              "action_draft_context_unavailable",
              "Action Draft apply failed before a verified formal write could complete."
            );
        const result = applyFailure(
          input.draft,
          confirmedAt,
          guarded.code,
          guarded.message
        );
        dependencies.publishFeedback(result);
        return result;
      } finally {
        inFlight.delete(operationKey);
      }
    })();
    inFlight.set(operationKey, operation);
    return operation;
  }

  return Object.freeze({ readGeneration, confirm });
}

export const actionDraftConfirmApplicationService =
  createActionDraftConfirmApplicationService();

export const readCanonicalActionDraftGeneration =
  actionDraftConfirmApplicationService.readGeneration;

export const confirmAIActionDraft = actionDraftConfirmApplicationService.confirm;
