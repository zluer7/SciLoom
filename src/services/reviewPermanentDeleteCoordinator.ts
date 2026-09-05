import type { PlanningData, Review } from "../types/planning";
import type { RecycleEntry } from "../types/recycleBin";
import { createRepositoryEntityId } from "../repositories/entityId";
import { authorityWriterGuard } from "./authorityWriterGuard";
import {
  commitReviewPermanentDeletePlanningSnapshot,
  correlateReviewPermanentDeletePlanningEffect,
  getPlanningRepositoryEnvelope,
  type ReviewPermanentDeletePlanningCommitResult
} from "./planningRepository";
import type {
  PlanningAuthorityEnvelopeView,
  PlanningOwnerAuthorityRequest
} from "./planningOwnerAuthorityPort";
import { getRecycleEntry } from "./recycleBinService";
import { reviewLifecycleActionPort } from "./reviewLifecycleActionService";
import {
  assertReviewPermanentDeleteRuntimeAdmission,
  buildReviewPermanentDeleteEffectIds,
  buildReviewPermanentDeleteImpactPlan,
  canonicalizeReviewPermanentDeleteImpactPlan,
  digestReviewPermanentDeleteImpactPlan,
  readReviewPermanentDeleteMetadataInventory,
  REVIEW_PERMANENT_DELETE_IMPACT_PLAN_VERSION,
  reviewPermanentDeleteFoundationPort,
  validateReviewPermanentDeleteConfirmedPlan,
  type PersistedReviewPermanentDeleteTarget,
  type PrepareReviewPermanentDeleteActionInput,
  type ReviewPermanentDeleteActionReadback,
  type ReviewPermanentDeleteActionRecord,
  type ReviewPermanentDeleteFinalizationReadback,
  type ReviewPermanentDeleteImpactPlan,
  type ReviewPermanentDeleteMetadataInventory
} from "./reviewPermanentDeleteFoundation";

export interface ReviewPermanentDeletePreviewInput {
  lifecycleActionId?: string;
  reviewId: string;
  projectId: string;
  exactRecycleEntryId: string;
  sourceDeleteActionId: string;
  expectedRecycleEntryRevision: number;
}

export interface ReviewPermanentDeletePreview {
  lifecycleActionId: string;
  review: Pick<Review, "id" | "projectId" | "title" | "updatedAt" | "deletedAt">;
  recycleEntry: Pick<
    RecycleEntry,
    | "id"
    | "entityType"
    | "entityId"
    | "entityDeletedAt"
    | "canRestore"
    | "restoreStatus"
    | "createdByLifecycleActionId"
    | "terminalLifecycleActionId"
    | "revision"
  >;
  plan: ReviewPermanentDeleteImpactPlan;
  impactDigest: string;
  pendingLifecycleAction: {
    lifecycleActionId: string;
    operationType: string;
    currentStage: string;
  } | null;
  physicalFilesPreserved: true;
}

export interface ExecuteReviewPermanentDeleteInput {
  lifecycleActionId: string;
  reviewId: string;
  projectId: string;
  exactRecycleEntryId: string;
  sourceDeleteActionId: string;
  expectedRecycleEntryRevision: number;
  confirmedImpactPlanVersion: 1;
  confirmedImpactDigest: string;
  userConfirmed: boolean;
}

export interface ReviewPermanentDeleteExecutionResult {
  status: "completed";
  lifecycleActionId: string;
  action: ReviewPermanentDeleteActionRecord;
  finalization: ReviewPermanentDeleteFinalizationReadback;
  priorSuccess: boolean;
}

interface PendingReviewLifecycleAction {
  lifecycleActionId: string;
  operationType: string;
  currentStage: string;
}

export class ReviewPermanentDeleteExecutionError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable: boolean,
    message = code
  ) {
    super(message);
    this.name = "ReviewPermanentDeleteExecutionError";
  }
}

export interface ReviewPermanentDeleteCoordinatorDependencies {
  assertRuntimeAdmission(): void;
  now(): string;
  createLifecycleActionId(): string;
  readPlanningEnvelope(): Promise<PlanningAuthorityEnvelopeView>;
  readRecycleEntry(id: string): Promise<RecycleEntry | undefined>;
  readMetadataInventory(reviewId: string): Promise<ReviewPermanentDeleteMetadataInventory>;
  readPendingOrdinary(reviewId: string): Promise<PendingReviewLifecycleAction | null>;
  readPendingPermanent(reviewId: string): Promise<ReviewPermanentDeleteActionReadback | null>;
  prepare(input: PrepareReviewPermanentDeleteActionInput): Promise<ReviewPermanentDeleteActionRecord>;
  readback(lifecycleActionId: string): Promise<ReviewPermanentDeleteActionReadback | null>;
  recordPlanningCommit(input: {
    lifecycleActionId: string;
    expectedRevision: number;
    impactDigest: string;
    committedPlanningEpoch: string;
    committedPlanningRevision: string;
  }): Promise<ReviewPermanentDeleteActionRecord>;
  commitPlanning(
    action: ReviewPermanentDeleteActionRecord,
    targets: PersistedReviewPermanentDeleteTarget[],
    observedEnvelope: PlanningAuthorityEnvelopeView
  ): Promise<ReviewPermanentDeletePlanningCommitResult>;
  finalize(input: {
    lifecycleActionId: string;
    expectedRevision: number;
    impactDigest: string;
    terminalAt: string;
  }): Promise<ReviewPermanentDeleteFinalizationReadback>;
}

function stableErrorCode(error: unknown) {
  if (error instanceof ReviewPermanentDeleteExecutionError) return error.code;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const value = error as { code?: unknown; message?: unknown };
    if (typeof value.code === "string") return value.code;
    if (typeof value.message === "string") return value.message;
  }
  return "review_permanent_delete_internal_failure";
}

function normalizeExecutionError(error: unknown) {
  if (error instanceof ReviewPermanentDeleteExecutionError) return error;
  const code = stableErrorCode(error);
  const retryable = code.includes("retryable")
    || code.includes("database")
    || code.includes("busy")
    || code.includes("locked")
    || code.includes("metadata_plan_conflict");
  return new ReviewPermanentDeleteExecutionError(code, retryable);
}

function fail(code: string, retryable = false): never {
  throw new ReviewPermanentDeleteExecutionError(code, retryable);
}

function assertSafeExecutionInput(input: ExecuteReviewPermanentDeleteInput) {
  if (input.userConfirmed !== true) fail("review_permanent_delete_confirmation_required");
  if (
    input.confirmedImpactPlanVersion !== REVIEW_PERMANENT_DELETE_IMPACT_PLAN_VERSION
    || !/^[0-9a-f]{64}$/.test(input.confirmedImpactDigest)
  ) {
    fail("review_permanent_delete_confirmation_stale");
  }
  if (
    !/^[A-Za-z0-9:_-]+$/.test(input.lifecycleActionId)
    || !input.reviewId.trim()
    || !input.projectId.trim()
    || !/^[A-Za-z0-9:_-]+$/.test(input.exactRecycleEntryId)
    || !/^[A-Za-z0-9:_-]+$/.test(input.sourceDeleteActionId)
    || !Number.isSafeInteger(input.expectedRecycleEntryRevision)
    || input.expectedRecycleEntryRevision < 0
  ) {
    fail("review_permanent_delete_identity_invalid");
  }
}

function assertRecycleEntry(
  entry: RecycleEntry | undefined,
  input: ReviewPermanentDeletePreviewInput,
  review: Review
): asserts entry is RecycleEntry {
  if (
    !entry
    || entry.id !== input.exactRecycleEntryId
    || entry.entityType !== "review"
    || entry.entityId !== input.reviewId
    || entry.createdByLifecycleActionId !== input.sourceDeleteActionId
    || entry.revision !== input.expectedRecycleEntryRevision
    || entry.canRestore !== true
    || entry.restoreStatus !== "not_started"
    || entry.terminalLifecycleActionId
    || entry.deletedAt
    || entry.entityDeletedAt !== review.deletedAt
  ) {
    fail("review_permanent_delete_recycle_entry_conflict");
  }
}

function parseConfirmedPlan(action: ReviewPermanentDeleteActionRecord) {
  try {
    const plan = JSON.parse(action.impactPlanJson) as ReviewPermanentDeleteImpactPlan;
    if (
      canonicalizeReviewPermanentDeleteImpactPlan(plan) !== action.impactPlanJson
      || plan.lifecycleActionId !== action.lifecycleActionId
      || plan.reviewId !== action.reviewId
      || plan.projectId !== action.projectId
    ) {
      fail("review_permanent_delete_persisted_plan_invalid");
    }
    return plan;
  } catch (error) {
    if (error instanceof ReviewPermanentDeleteExecutionError) throw error;
    return fail("review_permanent_delete_persisted_plan_invalid");
  }
}

function targetsFromPlan(plan: ReviewPermanentDeleteImpactPlan) {
  return [
    ...plan.bindingTargets.map((target) => ({ ...target, targetKind: "binding" as const })),
    ...plan.fileRefTargets.map((target) => ({ ...target, targetKind: "file_ref" as const })),
    ...plan.entityLinkTargets.map((target) => ({ ...target, targetKind: "entity_link" as const })),
    ...plan.changeLogTargets.map((target) => ({ ...target, targetKind: "change_log" as const }))
  ];
}

function assertActionIdentity(
  readback: ReviewPermanentDeleteActionReadback,
  input: ExecuteReviewPermanentDeleteInput
) {
  const { action, targets } = readback;
  if (
    action.lifecycleActionId !== input.lifecycleActionId
    || action.operationType !== "review_permanent_delete"
    || action.reviewId !== input.reviewId
    || action.projectId !== input.projectId
    || action.exactRecycleEntryId !== input.exactRecycleEntryId
    || action.sourceDeleteActionId !== input.sourceDeleteActionId
    || action.expectedRecycleEntryRevision !== input.expectedRecycleEntryRevision
    || action.impactPlanVersion !== input.confirmedImpactPlanVersion
    || action.impactDigest !== input.confirmedImpactDigest
  ) {
    fail("review_permanent_delete_identity_conflict");
  }
  const expectedTargets = targetsFromPlan(parseConfirmedPlan(action));
  if (JSON.stringify(targets) !== JSON.stringify(expectedTargets)) {
    fail("review_permanent_delete_target_readback_conflict");
  }
  return readback;
}

export function buildReviewPermanentDeleteAuthorityRequest(
  action: ReviewPermanentDeleteActionRecord
): PlanningOwnerAuthorityRequest {
  return {
    intent: "reviewPermanentDelete",
    requestId: `review-permanent-delete-${action.lifecycleActionId}`,
    projectId: action.projectId,
    ownerType: "review",
    ownerId: action.reviewId,
    scope: "primary",
    lifecycleActionId: action.lifecycleActionId,
    exactRecycleEntryId: action.exactRecycleEntryId,
    sourceDeleteActionId: action.sourceDeleteActionId,
    impactPlanVersion: action.impactPlanVersion,
    impactDigest: action.impactDigest,
    expectedPlanningEpoch: action.expectedPlanningEpoch,
    expectedPlanningRevision: action.expectedPlanningRevision
  };
}

export function createReviewPermanentDeleteCoordinator(
  dependencies: ReviewPermanentDeleteCoordinatorDependencies
) {
  async function preview(input: ReviewPermanentDeletePreviewInput): Promise<ReviewPermanentDeletePreview> {
    dependencies.assertRuntimeAdmission();
    const lifecycleActionId = input.lifecycleActionId ?? dependencies.createLifecycleActionId();
    buildReviewPermanentDeleteEffectIds(lifecycleActionId, input.exactRecycleEntryId);
    const [envelope, entry, inventory, pendingOrdinary, pendingPermanent] = await Promise.all([
      dependencies.readPlanningEnvelope(),
      dependencies.readRecycleEntry(input.exactRecycleEntryId),
      dependencies.readMetadataInventory(input.reviewId),
      dependencies.readPendingOrdinary(input.reviewId),
      dependencies.readPendingPermanent(input.reviewId)
    ]);
    const review = envelope.snapshot.reviews.find((item) => item.id === input.reviewId);
    if (
      !review
      || review.projectId !== input.projectId
      || !review.deletedAt
      || inventory.reviewId !== input.reviewId
    ) {
      fail("review_permanent_delete_source_state_conflict");
    }
    assertRecycleEntry(entry, input, review);
    const plan = buildReviewPermanentDeleteImpactPlan({
      lifecycleActionId,
      reviewId: review.id,
      projectId: review.projectId,
      exactRecycleEntryId: entry.id,
      sourceDeleteActionId: input.sourceDeleteActionId,
      expectedRecycleEntryRevision: entry.revision,
      expectedPlanningEpoch: envelope.repositoryEpoch,
      expectedPlanningRevision: envelope.revision,
      expectedReviewUpdatedAt: review.updatedAt,
      expectedReviewDeletedAt: review.deletedAt,
      metadataInventory: inventory,
      planning: envelope.snapshot
    });
    const impactDigest = await digestReviewPermanentDeleteImpactPlan(plan);
    const pending = pendingPermanent?.action ?? pendingOrdinary;
    return {
      lifecycleActionId,
      review: {
        id: review.id,
        projectId: review.projectId,
        title: review.title,
        updatedAt: review.updatedAt,
        deletedAt: review.deletedAt
      },
      recycleEntry: {
        id: entry.id,
        entityType: entry.entityType,
        entityId: entry.entityId,
        entityDeletedAt: entry.entityDeletedAt,
        canRestore: entry.canRestore,
        restoreStatus: entry.restoreStatus,
        createdByLifecycleActionId: entry.createdByLifecycleActionId,
        terminalLifecycleActionId: entry.terminalLifecycleActionId,
        revision: entry.revision
      },
      plan,
      impactDigest,
      pendingLifecycleAction: pending
        ? {
            lifecycleActionId: pending.lifecycleActionId,
            operationType: pending.operationType,
            currentStage: pending.currentStage
          }
        : null,
      physicalFilesPreserved: true
    };
  }

  async function validatePreparedSource(
    readback: ReviewPermanentDeleteActionReadback,
    envelope: PlanningAuthorityEnvelopeView
  ) {
    const plan = parseConfirmedPlan(readback.action);
    const [inventory, entry] = await Promise.all([
      dependencies.readMetadataInventory(readback.action.reviewId),
      dependencies.readRecycleEntry(readback.action.exactRecycleEntryId)
    ]);
    const review = envelope.snapshot.reviews.find((item) => item.id === readback.action.reviewId);
    if (!review) fail("review_permanent_delete_source_state_conflict");
    assertRecycleEntry(entry, {
      reviewId: readback.action.reviewId,
      projectId: readback.action.projectId,
      lifecycleActionId: readback.action.lifecycleActionId,
      exactRecycleEntryId: readback.action.exactRecycleEntryId,
      sourceDeleteActionId: readback.action.sourceDeleteActionId,
      expectedRecycleEntryRevision: readback.action.expectedRecycleEntryRevision
    }, review);
    const validation = validateReviewPermanentDeleteConfirmedPlan({
      confirmedPlan: plan,
      currentInventory: inventory,
      currentPlanning: envelope.snapshot
    });
    if (validation.status !== "Valid") fail(validation.code);
  }

  async function continueAction(
    initial: ReviewPermanentDeleteActionReadback
  ): Promise<ReviewPermanentDeleteExecutionResult> {
    let readback = initial;
    let envelope = await dependencies.readPlanningEnvelope();
    let correlation = correlateReviewPermanentDeletePlanningEffect({
      envelope,
      action: readback.action,
      targets: readback.targets
    });

    if (readback.action.currentStage === "prepared") {
      let planningResult: ReviewPermanentDeletePlanningCommitResult;
      if (correlation.status === "Proven") {
        planningResult = correlation.result;
      } else if (correlation.status === "NeedsCommit") {
        await validatePreparedSource(readback, envelope);
        planningResult = await dependencies.commitPlanning(
          readback.action,
          readback.targets,
          envelope
        );
      } else {
        fail(correlation.code);
      }
      const action = await dependencies.recordPlanningCommit({
        lifecycleActionId: readback.action.lifecycleActionId,
        expectedRevision: readback.action.revision,
        impactDigest: readback.action.impactDigest,
        committedPlanningEpoch: planningResult.committedPlanningEpoch,
        committedPlanningRevision: planningResult.committedPlanningRevision
      });
      readback = { action, targets: readback.targets };
      envelope = await dependencies.readPlanningEnvelope();
      correlation = correlateReviewPermanentDeletePlanningEffect({
        envelope,
        action: readback.action,
        targets: readback.targets
      });
    }

    if (correlation.status !== "Proven") {
      fail(
        correlation.status === "Conflict"
          ? correlation.code
          : "review_permanent_delete_planning_effect_missing"
      );
    }
    if (
      readback.action.currentStage !== "planning_committed"
      && readback.action.currentStage !== "completed"
    ) {
      fail("review_permanent_delete_stage_invalid");
    }
    const finalization = await dependencies.finalize({
      lifecycleActionId: readback.action.lifecycleActionId,
      expectedRevision: readback.action.revision,
      impactDigest: readback.action.impactDigest,
      terminalAt: dependencies.now()
    });
    if (
      finalization.action.currentStage !== "completed"
      || finalization.action.terminalResult !== "completed"
      || finalization.action.lifecycleActionId !== readback.action.lifecycleActionId
    ) {
      fail("review_permanent_delete_completed_readback_invalid");
    }
    return {
      status: "completed",
      lifecycleActionId: finalization.action.lifecycleActionId,
      action: finalization.action,
      finalization,
      priorSuccess: finalization.priorSuccess
    };
  }

  async function execute(
    input: ExecuteReviewPermanentDeleteInput
  ): Promise<ReviewPermanentDeleteExecutionResult> {
    assertSafeExecutionInput(input);
    try {
      dependencies.assertRuntimeAdmission();
      const existing = await dependencies.readback(input.lifecycleActionId);
      if (existing) return continueAction(assertActionIdentity(existing, input));

      const currentPreview = await preview({
        lifecycleActionId: input.lifecycleActionId,
        reviewId: input.reviewId,
        projectId: input.projectId,
        exactRecycleEntryId: input.exactRecycleEntryId,
        sourceDeleteActionId: input.sourceDeleteActionId,
        expectedRecycleEntryRevision: input.expectedRecycleEntryRevision
      });
      if (
        currentPreview.impactDigest !== input.confirmedImpactDigest
        || currentPreview.plan.impactPlanVersion !== input.confirmedImpactPlanVersion
      ) {
        fail("review_permanent_delete_confirmation_stale");
      }
      if (currentPreview.pendingLifecycleAction) {
        fail("review_lifecycle_pending_conflict");
      }
      const effectIds = buildReviewPermanentDeleteEffectIds(
        input.lifecycleActionId,
        input.exactRecycleEntryId
      );
      const prepared = await dependencies.prepare({
        lifecycleActionId: input.lifecycleActionId,
        reviewId: input.reviewId,
        projectId: input.projectId,
        expectedReviewUpdatedAt: currentPreview.plan.expectedReviewUpdatedAt,
        expectedReviewDeletedAt: currentPreview.plan.expectedReviewDeletedAt,
        expectedPlanningEpoch: currentPreview.plan.expectedPlanningEpoch,
        expectedPlanningRevision: currentPreview.plan.expectedPlanningRevision,
        plannedCommittedPlanningRevision:
          (BigInt(currentPreview.plan.expectedPlanningRevision) + 1n).toString(),
        sourceDeleteActionId: input.sourceDeleteActionId,
        exactRecycleEntryId: input.exactRecycleEntryId,
        expectedRecycleEntryRevision: input.expectedRecycleEntryRevision,
        impactPlanVersion: REVIEW_PERMANENT_DELETE_IMPACT_PLAN_VERSION,
        impactDigest: currentPreview.impactDigest,
        impactPlanJson: canonicalizeReviewPermanentDeleteImpactPlan(currentPreview.plan),
        confirmedAt: dependencies.now(),
        ...effectIds
      });
      const exactReadback = await dependencies.readback(prepared.lifecycleActionId);
      if (!exactReadback) fail("review_permanent_delete_action_readback_missing", true);
      return continueAction(assertActionIdentity(exactReadback, input));
    } catch (error) {
      throw normalizeExecutionError(error);
    }
  }

  return { preview, execute };
}

const productionDependencies: ReviewPermanentDeleteCoordinatorDependencies = {
  assertRuntimeAdmission: assertReviewPermanentDeleteRuntimeAdmission,
  now: () => new Date().toISOString(),
  createLifecycleActionId: () => createRepositoryEntityId("review-lifecycle-action"),
  readPlanningEnvelope: () => getPlanningRepositoryEnvelope(),
  readRecycleEntry: (id) => getRecycleEntry(id),
  readMetadataInventory: readReviewPermanentDeleteMetadataInventory,
  readPendingOrdinary: (reviewId) => reviewLifecycleActionPort.readPending(reviewId),
  readPendingPermanent: (reviewId) => reviewPermanentDeleteFoundationPort.readPending(reviewId),
  prepare: (input) => reviewPermanentDeleteFoundationPort.prepare(input),
  readback: (lifecycleActionId) => reviewPermanentDeleteFoundationPort.readback(lifecycleActionId),
  recordPlanningCommit: (input) => reviewPermanentDeleteFoundationPort.recordPlanningCommit(input),
  commitPlanning: (action, targets, observedEnvelope) => authorityWriterGuard.run({
    request: buildReviewPermanentDeleteAuthorityRequest(action),
    invalidation: {
      domain: "planning",
      projectId: action.projectId,
      ownerType: "review",
      ownerId: action.reviewId,
      scope: "primary"
    },
    write: async (permit, context) => {
      if (
        context.repositoryEpoch !== observedEnvelope.repositoryEpoch
        || context.revision !== observedEnvelope.revision
        || context.repositoryEpoch !== action.expectedPlanningEpoch
        || context.revision !== action.expectedPlanningRevision
      ) {
        fail("review_permanent_delete_planning_conflict");
      }
      return commitReviewPermanentDeletePlanningSnapshot({
        context,
        authorityPermit: permit,
        action,
        targets
      });
    }
  }),
  finalize: (input) => reviewPermanentDeleteFoundationPort.finalize(input)
};

export const reviewPermanentDeleteCoordinator =
  createReviewPermanentDeleteCoordinator(productionDependencies);

export const previewReviewPermanentDelete = reviewPermanentDeleteCoordinator.preview;
export const executeReviewPermanentDelete = reviewPermanentDeleteCoordinator.execute;

