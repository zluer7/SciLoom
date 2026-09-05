import {
  executeReviewPermanentDelete,
  previewReviewPermanentDelete,
  type ReviewPermanentDeleteExecutionResult,
  type ReviewPermanentDeletePreview
} from "./reviewPermanentDeleteCoordinator";
import {
  canonicalizeReviewPermanentDeleteImpactPlan,
  reviewPermanentDeleteFoundationPort,
  type PersistedReviewPermanentDeleteTarget,
  type ReviewPermanentDeleteActionReadback,
  type ReviewPermanentDeleteImpactPlan
} from "./reviewPermanentDeleteFoundation";
import type { ReviewPermanentDeleteCapability } from "./reviewPermanentDeleteCapabilityService";

export type OperationCenterReviewPermanentDeletePreview = ReviewPermanentDeletePreview;
export type OperationCenterReviewPermanentDeleteImpactPlan = ReviewPermanentDeleteImpactPlan;

export type ReviewPermanentDeleteFeedbackReason =
  | "impact_plan_stale"
  | "planning_conflict"
  | "metadata_plan_conflict"
  | "recycle_entry_conflict"
  | "identity_conflict"
  | "source_state_conflict"
  | "legacy_unbound"
  | "already_permanently_deleted"
  | "durable_store_required"
  | "retryable_infrastructure_failure"
  | "non_retryable_failure";

export interface ReviewPermanentDeleteContinuation {
  mode: "continuation";
  reviewTitle: string;
  actionReadback: ReviewPermanentDeleteActionReadback;
  plan: ReviewPermanentDeleteImpactPlan;
  impactDigest: string;
  physicalFilesPreserved: true;
}

function fail(code: string): never {
  const error = new Error(code);
  Object.defineProperty(error, "code", { value: code });
  throw error;
}

function persistedTargetsFromPlan(plan: ReviewPermanentDeleteImpactPlan) {
  return [
    ...plan.bindingTargets.map((target) => ({ ...target, targetKind: "binding" as const })),
    ...plan.fileRefTargets.map((target) => ({ ...target, targetKind: "file_ref" as const })),
    ...plan.entityLinkTargets.map((target) => ({ ...target, targetKind: "entity_link" as const })),
    ...plan.changeLogTargets.map((target) => ({ ...target, targetKind: "change_log" as const }))
  ] satisfies PersistedReviewPermanentDeleteTarget[];
}

function readPersistedPlan(readback: ReviewPermanentDeleteActionReadback) {
  let plan: ReviewPermanentDeleteImpactPlan;
  try {
    plan = JSON.parse(readback.action.impactPlanJson) as ReviewPermanentDeleteImpactPlan;
  } catch {
    return fail("review_permanent_delete_persisted_plan_invalid");
  }
  if (
    canonicalizeReviewPermanentDeleteImpactPlan(plan) !== readback.action.impactPlanJson
    || plan.lifecycleActionId !== readback.action.lifecycleActionId
    || plan.reviewId !== readback.action.reviewId
    || plan.projectId !== readback.action.projectId
    || plan.exactRecycleEntryId !== readback.action.exactRecycleEntryId
    || plan.sourceDeleteActionId !== readback.action.sourceDeleteActionId
    || plan.expectedRecycleEntryRevision !== readback.action.expectedRecycleEntryRevision
    || plan.impactPlanVersion !== readback.action.impactPlanVersion
    || JSON.stringify(persistedTargetsFromPlan(plan)) !== JSON.stringify(readback.targets)
  ) {
    return fail("review_permanent_delete_persisted_plan_invalid");
  }
  return plan;
}

function assertCapabilityIdentity(
  capability: ReviewPermanentDeleteCapability
): asserts capability is ReviewPermanentDeleteCapability & {
  projectId: string;
  exactRecycleEntryId: string;
  sourceDeleteActionId: string;
  expectedRecycleEntryRevision: number;
} {
  if (
    !capability.projectId
    || !capability.exactRecycleEntryId
    || !capability.sourceDeleteActionId
    || capability.expectedRecycleEntryRevision === null
  ) {
    fail("review_permanent_delete_identity_invalid");
  }
}

export async function previewOperationCenterReviewPermanentDelete(
  capability: ReviewPermanentDeleteCapability
): Promise<ReviewPermanentDeletePreview> {
  if (!capability.canPreviewPermanentDelete) fail(capability.reasonCode);
  assertCapabilityIdentity(capability);
  return previewReviewPermanentDelete({
    reviewId: capability.reviewId,
    projectId: capability.projectId,
    exactRecycleEntryId: capability.exactRecycleEntryId,
    sourceDeleteActionId: capability.sourceDeleteActionId,
    expectedRecycleEntryRevision: capability.expectedRecycleEntryRevision
  });
}

export async function loadOperationCenterReviewPermanentDeleteContinuation(
  capability: ReviewPermanentDeleteCapability,
  reviewTitle: string
): Promise<ReviewPermanentDeleteContinuation> {
  if (!capability.canContinuePermanentDelete || !capability.lifecycleActionId) {
    fail(capability.reasonCode);
  }
  assertCapabilityIdentity(capability);
  const readback = await reviewPermanentDeleteFoundationPort.readback(
    capability.lifecycleActionId
  );
  if (!readback) fail("review_permanent_delete_action_readback_missing");
  const action = readback.action;
  if (
    action.lifecycleActionId !== capability.lifecycleActionId
    || action.operationType !== "review_permanent_delete"
    || action.reviewId !== capability.reviewId
    || action.projectId !== capability.projectId
    || action.exactRecycleEntryId !== capability.exactRecycleEntryId
    || action.sourceDeleteActionId !== capability.sourceDeleteActionId
    || action.expectedRecycleEntryRevision !== capability.expectedRecycleEntryRevision
    || (action.currentStage !== "prepared" && action.currentStage !== "planning_committed")
    || action.terminalResult !== null
  ) {
    fail("review_permanent_delete_identity_conflict");
  }
  return {
    mode: "continuation",
    reviewTitle,
    actionReadback: readback,
    plan: readPersistedPlan(readback),
    impactDigest: action.impactDigest,
    physicalFilesPreserved: true
  };
}

export function executeOperationCenterReviewPermanentDeletePreview(
  preview: ReviewPermanentDeletePreview
): Promise<ReviewPermanentDeleteExecutionResult> {
  return executeReviewPermanentDelete({
    lifecycleActionId: preview.lifecycleActionId,
    reviewId: preview.review.id,
    projectId: preview.review.projectId,
    exactRecycleEntryId: preview.recycleEntry.id,
    sourceDeleteActionId: preview.plan.sourceDeleteActionId,
    expectedRecycleEntryRevision: preview.recycleEntry.revision,
    confirmedImpactPlanVersion: preview.plan.impactPlanVersion,
    confirmedImpactDigest: preview.impactDigest,
    userConfirmed: true
  });
}

export function continueOperationCenterReviewPermanentDelete(
  continuation: ReviewPermanentDeleteContinuation
): Promise<ReviewPermanentDeleteExecutionResult> {
  const action = continuation.actionReadback.action;
  return executeReviewPermanentDelete({
    lifecycleActionId: action.lifecycleActionId,
    reviewId: action.reviewId,
    projectId: action.projectId,
    exactRecycleEntryId: action.exactRecycleEntryId,
    sourceDeleteActionId: action.sourceDeleteActionId,
    expectedRecycleEntryRevision: action.expectedRecycleEntryRevision,
    confirmedImpactPlanVersion: action.impactPlanVersion,
    confirmedImpactDigest: action.impactDigest,
    userConfirmed: true
  });
}

function errorCode(error: unknown) {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const value = error as { code?: unknown; message?: unknown };
    if (typeof value.code === "string") return value.code;
    if (typeof value.message === "string") return value.message;
  }
  return "review_permanent_delete_unknown_failure";
}

export function classifyReviewPermanentDeleteOperationCenterError(
  error: unknown
): ReviewPermanentDeleteFeedbackReason {
  const code = errorCode(error).toLowerCase();
  if (code.includes("confirmation_stale") || code.includes("impact_plan_stale")) {
    return "impact_plan_stale";
  }
  if (code.includes("metadata_plan_conflict")) return "metadata_plan_conflict";
  if (code.includes("planning") && code.includes("conflict")) return "planning_conflict";
  if (code.includes("recycle") && code.includes("conflict")) return "recycle_entry_conflict";
  if (code.includes("legacy_unbound")) return "legacy_unbound";
  if (code.includes("already") && code.includes("permanent")) {
    return "already_permanently_deleted";
  }
  if (code.includes("durable_store") || code.includes("data_source") || code.includes("runtime")) {
    return "durable_store_required";
  }
  if (code.includes("source_state")) return "source_state_conflict";
  if (code.includes("identity") || code.includes("persisted_plan")) return "identity_conflict";
  const retryable = error && typeof error === "object"
    && "retryable" in error
    && (error as { retryable?: unknown }).retryable === true;
  if (retryable || /database|busy|locked|transport|unavailable/u.test(code)) {
    return "retryable_infrastructure_failure";
  }
  return "non_retryable_failure";
}

export function reviewPermanentDeleteErrorRequiresNewPreview(
  reason: ReviewPermanentDeleteFeedbackReason
) {
  return reason === "impact_plan_stale"
    || reason === "planning_conflict"
    || reason === "metadata_plan_conflict"
    || reason === "recycle_entry_conflict";
}
