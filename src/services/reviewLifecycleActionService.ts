import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime, resolveDataSourceMode } from "../repositories/dataSourceMode";

export type ReviewLifecycleOperationType =
  | "review_soft_delete"
  | "review_restore"
  | "review_permanent_delete";
export type OrdinaryReviewLifecycleOperationType = Exclude<
  ReviewLifecycleOperationType,
  "review_permanent_delete"
>;
export type ReviewLifecycleStage =
  | "prepared"
  | "planning_committed"
  | "operation_log_recorded"
  | "recycle_effect_recorded"
  | "completed";

export interface ReviewLifecycleActionRecord {
  lifecycleActionId: string;
  revision: number;
  operationType: ReviewLifecycleOperationType;
  reviewId: string;
  projectId: string;
  expectedReviewSourceState: "active" | "deleted";
  expectedReviewUpdatedAt: string;
  expectedReviewDeletedAt: string | null;
  targetReviewUpdatedAt: string;
  targetReviewDeletedAt: string | null;
  expectedPlanningEpoch: string;
  expectedPlanningRevision: string;
  plannedCommittedPlanningRevision: string;
  committedPlanningEpoch: string | null;
  committedPlanningRevision: string | null;
  planningEffectId: string;
  sourceDeleteActionId: string | null;
  exactRecycleEntryId: string;
  operationLogEffectId: string;
  recycleEffectId: string;
  currentStage: ReviewLifecycleStage;
  terminalResult: string | null;
  lastErrorCode?: string | null;
  lastErrorRetryable?: boolean;
  createdAt: string;
  updatedAt: string;
  terminalAt: string | null;
}

export interface ReviewLifecyclePlanningEnvelope {
  repositoryEpoch: string;
  revision: string;
  snapshot: {
    reviews: Array<{ id: string; updatedAt: string; deletedAt?: string | null }>;
    changeLogs: Array<{
      id: string;
      entityType: string;
      entityId: string;
      action: string;
      note?: string;
    }>;
  };
}

export interface ReviewLifecyclePlanningCommitResult {
  committedPlanningEpoch: string;
  committedPlanningRevision: string;
  snapshot: ReviewLifecyclePlanningEnvelope["snapshot"];
  planningEffectId: string;
}

export function evaluateReviewLifecycleRuntimeAdmission(input: {
  tauriRuntime: boolean;
  dataSourceMode: "sqlite" | "localStorage";
}) {
  return input.tauriRuntime && input.dataSourceMode === "sqlite"
    ? ({ status: "Allowed" } as const)
    : ({
        status: "DataSourceUnsupported",
        code: "review_lifecycle_durable_store_required"
      } as const);
}

export function assertReviewLifecycleRuntimeAdmission() {
  const result = evaluateReviewLifecycleRuntimeAdmission({
    tauriRuntime: isTauriRuntime(),
    dataSourceMode: resolveDataSourceMode()
  });
  if (result.status !== "Allowed") {
    throw new ReviewLifecycleExecutionError(result.code, false);
  }
  return result;
}

function assertSafeIdentity(value: string) {
  if (!/^[A-Za-z0-9:_-]+$/.test(value)) {
    throw new ReviewLifecycleExecutionError("review_lifecycle_identity_invalid", false);
  }
}

export function buildReviewLifecycleEffectIds(
  lifecycleActionId: string,
  exactRecycleEntryId: string,
  operationType: OrdinaryReviewLifecycleOperationType
) {
  assertSafeIdentity(lifecycleActionId);
  assertSafeIdentity(exactRecycleEntryId);
  const prefix = `review-lifecycle:${lifecycleActionId}`;
  return {
    planningEffectId: `${prefix}:planning`,
    operationLogEffectId: `${prefix}:operation-log`,
    recycleEffectId: operationType === "review_soft_delete"
      ? `${prefix}:recycle-create`
      : `${prefix}:recycle-terminal:${exactRecycleEntryId}`
  };
}

export function buildSoftDeleteRecycleEntryId(lifecycleActionId: string) {
  assertSafeIdentity(lifecycleActionId);
  return `review-lifecycle:${lifecycleActionId}:recycle-entry`;
}

export function buildReviewLifecycleChangeLogNote(action: ReviewLifecycleActionRecord) {
  const planningAction = action.operationType === "review_soft_delete" ? "deleted" : "restored";
  return `Review lifecycle ${planningAction}; lifecycleActionId=${action.lifecycleActionId}`;
}

export class ReviewLifecycleExecutionError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable: boolean,
    message = code
  ) {
    super(message);
    this.name = "ReviewLifecycleExecutionError";
  }
}

export function normalizePendingReviewLifecycleListError(error: unknown) {
  if (error instanceof ReviewLifecycleExecutionError) return error;
  const value = error && typeof error === "object"
    ? error as { code?: unknown; retryable?: unknown; message?: unknown }
    : undefined;
  const code = typeof value?.code === "string"
    ? value.code
    : "review_lifecycle_pending_list_unavailable";
  return new ReviewLifecycleExecutionError(
    code,
    value?.retryable === true,
    typeof value?.message === "string" ? value.message : code
  );
}

function nullableTimestamp(value: string | null | undefined) {
  return value ?? null;
}

export function correlateReviewLifecyclePlanningEffect(
  action: ReviewLifecycleActionRecord,
  envelope: ReviewLifecyclePlanningEnvelope
):
  | { status: "Proven"; result: ReviewLifecyclePlanningCommitResult }
  | { status: "NeedsCommit" }
  | { status: "Conflict"; code: string } {
  const review = envelope.snapshot.reviews.find((item) => item.id === action.reviewId);
  const expectedChangeAction = action.operationType === "review_soft_delete" ? "deleted" : "restored";
  const exactEffect = envelope.snapshot.changeLogs.find((item) => item.id === action.planningEffectId);
  if (exactEffect && (
    exactEffect.entityType !== "review"
    || exactEffect.entityId !== action.reviewId
    || exactEffect.action !== expectedChangeAction
    || exactEffect.note !== buildReviewLifecycleChangeLogNote(action)
  )) {
    return { status: "Conflict", code: "review_lifecycle_planning_effect_identity_conflict" };
  }
  const targetState = Boolean(
    review
    && review.updatedAt === action.targetReviewUpdatedAt
    && nullableTimestamp(review.deletedAt) === nullableTimestamp(action.targetReviewDeletedAt)
  );
  const sourceState = Boolean(
    review
    && review.updatedAt === action.expectedReviewUpdatedAt
    && nullableTimestamp(review.deletedAt) === nullableTimestamp(action.expectedReviewDeletedAt)
  );
  if (exactEffect && targetState) {
    try {
      if (
        envelope.repositoryEpoch === action.expectedPlanningEpoch
        && BigInt(envelope.revision) >= BigInt(action.plannedCommittedPlanningRevision)
      ) {
        return {
          status: "Proven",
          result: {
            committedPlanningEpoch: envelope.repositoryEpoch,
            committedPlanningRevision: action.plannedCommittedPlanningRevision,
            snapshot: envelope.snapshot,
            planningEffectId: action.planningEffectId
          }
        };
      }
    } catch {
      return { status: "Conflict", code: "review_lifecycle_planning_identity_invalid" };
    }
  }
  if (!exactEffect && sourceState
    && envelope.repositoryEpoch === action.expectedPlanningEpoch
    && envelope.revision === action.expectedPlanningRevision) {
    return { status: "NeedsCommit" };
  }
  if (!exactEffect && targetState) {
    return { status: "Conflict", code: "review_lifecycle_target_without_exact_effect" };
  }
  return { status: "Conflict", code: "review_lifecycle_source_state_conflict" };
}

export interface ReviewLifecycleExecutionDependencies {
  readPlanningEnvelope(): Promise<ReviewLifecyclePlanningEnvelope>;
  commitPlanning(
    action: ReviewLifecycleActionRecord,
    envelope: ReviewLifecyclePlanningEnvelope
  ): Promise<ReviewLifecyclePlanningCommitResult>;
  recordPlanningCommit(
    action: ReviewLifecycleActionRecord,
    result: ReviewLifecyclePlanningCommitResult
  ): Promise<ReviewLifecycleActionRecord>;
  recordOperationLog(action: ReviewLifecycleActionRecord): Promise<ReviewLifecycleActionRecord>;
  recordRecycleEffect(action: ReviewLifecycleActionRecord): Promise<ReviewLifecycleActionRecord>;
  complete(action: ReviewLifecycleActionRecord): Promise<ReviewLifecycleActionRecord>;
  recordRetryableFailure(
    action: ReviewLifecycleActionRecord,
    error: unknown
  ): Promise<ReviewLifecycleActionRecord>;
  recordTerminalFailure?(
    action: ReviewLifecycleActionRecord,
    error: ReviewLifecycleExecutionError
  ): Promise<ReviewLifecycleActionRecord>;
}

export async function continueReviewLifecycleAction(
  initialAction: ReviewLifecycleActionRecord,
  dependencies: ReviewLifecycleExecutionDependencies
) {
  if (initialAction.operationType === "review_permanent_delete") {
    throw new ReviewLifecycleExecutionError(
      "review_lifecycle_operation_requires_dedicated_authority",
      false
    );
  }
  let action = initialAction;
  if (action.terminalResult) return action;
  try {
    if (action.currentStage === "prepared") {
      const envelope = await dependencies.readPlanningEnvelope();
      const correlation = correlateReviewLifecyclePlanningEffect(action, envelope);
      if (correlation.status === "Conflict") {
        throw new ReviewLifecycleExecutionError(correlation.code, false);
      }
      const result = correlation.status === "Proven"
        ? correlation.result
        : await dependencies.commitPlanning(action, envelope);
      if (result.planningEffectId !== action.planningEffectId) {
        throw new ReviewLifecycleExecutionError("review_lifecycle_planning_effect_identity_conflict", false);
      }
      action = await dependencies.recordPlanningCommit(action, result);
    }
    if (action.currentStage === "planning_committed") {
      action = await dependencies.recordOperationLog(action);
    }
    if (action.currentStage === "operation_log_recorded") {
      action = await dependencies.recordRecycleEffect(action);
    }
    if (action.currentStage === "recycle_effect_recorded") {
      action = await dependencies.complete(action);
    }
    return action;
  } catch (error) {
    if (error instanceof ReviewLifecycleExecutionError && !error.retryable) {
      await dependencies.recordTerminalFailure?.(action, error).catch(() => undefined);
    } else {
      await dependencies.recordRetryableFailure(action, error).catch(() => undefined);
    }
    throw error;
  }
}

export interface PrepareReviewLifecycleActionInput {
  lifecycleActionId: string;
  operationType: OrdinaryReviewLifecycleOperationType;
  reviewId: string;
  projectId: string;
  expectedReviewSourceState: "active" | "deleted";
  expectedReviewUpdatedAt: string;
  expectedReviewDeletedAt: string | null;
  targetReviewUpdatedAt: string;
  targetReviewDeletedAt: string | null;
  expectedPlanningEpoch: string;
  expectedPlanningRevision: string;
  plannedCommittedPlanningRevision: string;
  planningEffectId: string;
  sourceDeleteActionId: string | null;
  exactRecycleEntryId: string;
  operationLogEffectId: string;
  recycleEffectId: string;
}

export const reviewLifecycleActionPort = {
  prepare(input: PrepareReviewLifecycleActionInput) {
    return invoke<ReviewLifecycleActionRecord>("prepare_review_lifecycle_action", { input });
  },
  readback(lifecycleActionId: string) {
    return invoke<ReviewLifecycleActionRecord | null>("readback_review_lifecycle_action", {
      lifecycleActionId
    });
  },
  readPending(reviewId: string) {
    return invoke<ReviewLifecycleActionRecord | null>("read_pending_review_lifecycle_action", {
      reviewId
    });
  },
  async listPending() {
    assertReviewLifecycleRuntimeAdmission();
    try {
      return await invoke<ReviewLifecycleActionRecord[]>("list_pending_review_lifecycle_actions");
    } catch (error) {
      throw normalizePendingReviewLifecycleListError(error);
    }
  },
  recordPlanningCommit(action: ReviewLifecycleActionRecord, result: ReviewLifecyclePlanningCommitResult) {
    return invoke<ReviewLifecycleActionRecord>("record_review_lifecycle_planning_commit", {
      input: {
        lifecycleActionId: action.lifecycleActionId,
        expectedRevision: action.revision,
        expectedStage: action.currentStage,
        committedPlanningEpoch: result.committedPlanningEpoch,
        committedPlanningRevision: result.committedPlanningRevision
      }
    });
  },
  recordOperationLog(action: ReviewLifecycleActionRecord, input: {
    targetTitle: string;
    summary: string;
    impactSummary?: unknown;
    confirmation?: unknown;
    feedback?: unknown;
    createdAt: string;
  }) {
    return invoke<ReviewLifecycleActionRecord>("record_review_lifecycle_operation_log", {
      input: {
        lifecycleActionId: action.lifecycleActionId,
        expectedRevision: action.revision,
        expectedStage: action.currentStage,
        targetTitle: input.targetTitle,
        summary: input.summary,
        impactSummaryJson: input.impactSummary ? JSON.stringify(input.impactSummary) : null,
        confirmationJson: input.confirmation ? JSON.stringify(input.confirmation) : null,
        feedbackJson: input.feedback ? JSON.stringify(input.feedback) : null,
        createdAt: input.createdAt
      }
    });
  },
  recordRecycleCreate(action: ReviewLifecycleActionRecord, input: {
    title: string;
    summary?: string;
    knownImpactSummary?: unknown;
    deletedAt: string;
  }) {
    return invoke<ReviewLifecycleActionRecord>("record_review_lifecycle_recycle_create", {
      input: {
        lifecycleActionId: action.lifecycleActionId,
        expectedRevision: action.revision,
        expectedStage: action.currentStage,
        title: input.title,
        summary: input.summary ?? null,
        knownImpactSummaryJson: input.knownImpactSummary
          ? JSON.stringify(input.knownImpactSummary)
          : null,
        deletedAt: input.deletedAt
      }
    });
  },
  recordRecycleRestore(action: ReviewLifecycleActionRecord, input: {
    expectedEntryRevision: number;
    restoredAt: string;
  }) {
    return invoke<ReviewLifecycleActionRecord>("record_review_lifecycle_recycle_restore", {
      input: {
        lifecycleActionId: action.lifecycleActionId,
        expectedActionRevision: action.revision,
        expectedActionStage: action.currentStage,
        exactRecycleEntryId: action.exactRecycleEntryId,
        expectedEntryRevision: input.expectedEntryRevision,
        sourceDeleteActionId: action.sourceDeleteActionId,
        restoredAt: input.restoredAt
      }
    });
  },
  recordFailure(action: ReviewLifecycleActionRecord, input: {
    errorCode: string;
    retryable: boolean;
    terminalResult?: string;
  }) {
    return invoke<ReviewLifecycleActionRecord>("record_review_lifecycle_action_failure", {
      input: {
        lifecycleActionId: action.lifecycleActionId,
        expectedRevision: action.revision,
        expectedStage: action.currentStage,
        errorCode: input.errorCode,
        retryable: input.retryable,
        terminalResult: input.terminalResult ?? null
      }
    });
  },
  complete(action: ReviewLifecycleActionRecord) {
    return invoke<ReviewLifecycleActionRecord>("complete_review_lifecycle_action", {
      input: {
        lifecycleActionId: action.lifecycleActionId,
        expectedRevision: action.revision,
        expectedStage: action.currentStage
      }
    });
  }
};
