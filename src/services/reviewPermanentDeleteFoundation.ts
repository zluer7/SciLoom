import { invoke } from "@tauri-apps/api/core";
import type { PlanningData } from "../types/planning";
import { isTauriRuntime, resolveDataSourceMode } from "../repositories/dataSourceMode";

export const REVIEW_PERMANENT_DELETE_IMPACT_PLAN_VERSION = 1 as const;
export type ReviewPermanentDeleteDisposition =
  | "DELETE"
  | "SANITIZE"
  | "KEEP_AUDIT_ONLY"
  | "PERMANENTLY_TERMINALIZE";

export interface ReviewPermanentDeleteMetadataRecord {
  id: string;
  revision: number;
  ownerType: "review";
  ownerId: string;
  manuscriptChannel: string;
  deletedAt: string | null;
  permanentDeleteStatus: "permanently_deleted" | null;
}

export interface ReviewPermanentDeleteMetadataInventory {
  reviewId: string;
  bindings: ReviewPermanentDeleteMetadataRecord[];
  fileRefs: ReviewPermanentDeleteMetadataRecord[];
}

export interface ReviewPermanentDeleteTarget {
  targetId: string;
  expectedRevision: string;
  ownerType: "review" | null;
  ownerId: string | null;
  manuscriptChannel: string | null;
  disposition: ReviewPermanentDeleteDisposition;
  reason: string;
}

export interface ReviewPermanentDeleteImpactPlan {
  impactPlanVersion: 1;
  lifecycleActionId: string;
  reviewId: string;
  projectId: string;
  exactRecycleEntryId: string;
  sourceDeleteActionId: string;
  expectedRecycleEntryRevision: number;
  expectedPlanningEpoch: string;
  expectedPlanningRevision: string;
  expectedReviewUpdatedAt: string;
  expectedReviewDeletedAt: string;
  bindingTargets: ReviewPermanentDeleteTarget[];
  fileRefTargets: ReviewPermanentDeleteTarget[];
  entityLinkTargets: ReviewPermanentDeleteTarget[];
  changeLogTargets: ReviewPermanentDeleteTarget[];
  physicalFilesPreserved: true;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)])
    );
  }
  return value;
}

export function canonicalizeReviewPermanentDeleteImpactPlan(plan: ReviewPermanentDeleteImpactPlan) {
  return JSON.stringify(canonicalValue(plan));
}

export async function digestReviewPermanentDeleteImpactPlan(plan: ReviewPermanentDeleteImpactPlan) {
  const bytes = new TextEncoder().encode(canonicalizeReviewPermanentDeleteImpactPlan(plan));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function metadataTargets(
  records: ReviewPermanentDeleteMetadataRecord[],
  disposition: "DELETE" | "PERMANENTLY_TERMINALIZE",
  reason: string
) {
  return records
    .filter((record) => record.permanentDeleteStatus !== "permanently_deleted")
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((record): ReviewPermanentDeleteTarget => ({
      targetId: record.id,
      expectedRevision: String(record.revision),
      ownerType: "review",
      ownerId: record.ownerId,
      manuscriptChannel: record.manuscriptChannel,
      disposition,
      reason
    }));
}

export function buildReviewPermanentDeleteImpactPlan(input: {
  lifecycleActionId: string;
  reviewId: string;
  projectId: string;
  exactRecycleEntryId: string;
  sourceDeleteActionId: string;
  expectedRecycleEntryRevision: number;
  expectedPlanningEpoch: string;
  expectedPlanningRevision: string;
  expectedReviewUpdatedAt: string;
  expectedReviewDeletedAt: string;
  metadataInventory: ReviewPermanentDeleteMetadataInventory;
  planning: Pick<PlanningData, "entityLinks" | "changeLogs">;
}): ReviewPermanentDeleteImpactPlan {
  if (input.metadataInventory.reviewId !== input.reviewId) {
    throw new Error("review_permanent_delete_inventory_identity_mismatch");
  }
  const entityLinkTargets = input.planning.entityLinks
    .filter((link) =>
      (link.sourceType === "review" && link.sourceId === input.reviewId)
      || (link.targetType === "review" && link.targetId === input.reviewId)
    )
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((link): ReviewPermanentDeleteTarget => ({
      targetId: link.id,
      expectedRevision: link.updatedAt,
      ownerType: null,
      ownerId: null,
      manuscriptChannel: null,
      disposition: "DELETE",
      reason: "Remove the exact Planning relation whose endpoint is the Review."
    }));
  const changeLogTargets = input.planning.changeLogs
    .filter((log) => log.entityType === "review" && log.entityId === input.reviewId)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((log): ReviewPermanentDeleteTarget => {
      const containsRecoverableSnapshot = log.before !== undefined || log.after !== undefined;
      const contentFreeLifecycleNote = typeof log.note === "string"
        && /^Review lifecycle (?:deleted|restored); lifecycleActionId=[A-Za-z0-9:_-]+$/.test(log.note);
      const disposition: ReviewPermanentDeleteDisposition = containsRecoverableSnapshot
        ? "DELETE"
        : log.note && !contentFreeLifecycleNote
          ? "SANITIZE"
          : "KEEP_AUDIT_ONLY";
      return {
        targetId: log.id,
        expectedRevision: log.createdAt,
        ownerType: null,
        ownerId: null,
        manuscriptChannel: null,
        disposition,
        reason: disposition === "DELETE"
          ? "Delete the exact recoverable Review history snapshot."
          : disposition === "SANITIZE"
            ? "Remove Review content while preserving the minimum audit shell."
            : "Retain the content-free audit shell for deterministic lifecycle evidence."
      };
    });
  return {
    impactPlanVersion: REVIEW_PERMANENT_DELETE_IMPACT_PLAN_VERSION,
    lifecycleActionId: input.lifecycleActionId,
    reviewId: input.reviewId,
    projectId: input.projectId,
    exactRecycleEntryId: input.exactRecycleEntryId,
    sourceDeleteActionId: input.sourceDeleteActionId,
    expectedRecycleEntryRevision: input.expectedRecycleEntryRevision,
    expectedPlanningEpoch: input.expectedPlanningEpoch,
    expectedPlanningRevision: input.expectedPlanningRevision,
    expectedReviewUpdatedAt: input.expectedReviewUpdatedAt,
    expectedReviewDeletedAt: input.expectedReviewDeletedAt,
    bindingTargets: metadataTargets(input.metadataInventory.bindings, "DELETE", "Delete exact owner-scoped Binding metadata."),
    fileRefTargets: metadataTargets(input.metadataInventory.fileRefs, "PERMANENTLY_TERMINALIZE", "Terminalize metadata only; preserve every physical file."),
    entityLinkTargets,
    changeLogTargets,
    physicalFilesPreserved: true
  };
}

export function validateReviewPermanentDeleteConfirmedPlan(input: {
  confirmedPlan: ReviewPermanentDeleteImpactPlan;
  currentInventory: ReviewPermanentDeleteMetadataInventory;
  currentPlanning: Pick<PlanningData, "entityLinks" | "changeLogs">;
}) {
  const plan = input.confirmedPlan;
  const rebuilt = buildReviewPermanentDeleteImpactPlan({
    ...plan,
    metadataInventory: input.currentInventory,
    planning: input.currentPlanning
  });
  return canonicalizeReviewPermanentDeleteImpactPlan(plan)
    === canonicalizeReviewPermanentDeleteImpactPlan(rebuilt)
    ? ({ status: "Valid" } as const)
    : ({ status: "Conflict", code: "review_permanent_delete_impact_plan_stale" } as const);
}

export function evaluateReviewPermanentDeleteRuntimeAdmission(input: {
  tauriRuntime: boolean;
  dataSourceMode: "sqlite" | "localStorage";
}) {
  return input.tauriRuntime && input.dataSourceMode === "sqlite"
    ? ({ status: "Allowed" } as const)
    : ({ status: "DataSourceUnsupported", code: "review_permanent_delete_durable_store_required" } as const);
}

export function assertReviewPermanentDeleteRuntimeAdmission() {
  const result = evaluateReviewPermanentDeleteRuntimeAdmission({
    tauriRuntime: isTauriRuntime(),
    dataSourceMode: resolveDataSourceMode()
  });
  if (result.status !== "Allowed") throw new Error(result.code);
  return result;
}

export async function readReviewPermanentDeleteMetadataInventory(reviewId: string) {
  assertReviewPermanentDeleteRuntimeAdmission();
  return invoke<ReviewPermanentDeleteMetadataInventory>(
    "read_review_permanent_delete_metadata_inventory",
    { reviewId }
  );
}

export function buildReviewPermanentDeleteEffectIds(lifecycleActionId: string, exactRecycleEntryId: string) {
  if (!/^[A-Za-z0-9:_-]+$/.test(lifecycleActionId) || !/^[A-Za-z0-9:_-]+$/.test(exactRecycleEntryId)) {
    throw new Error("review_permanent_delete_identity_invalid");
  }
  const prefix = `review-lifecycle:${lifecycleActionId}`;
  return {
    planningEffectId: `${prefix}:planning`,
    operationLogEffectId: `${prefix}:operation-log`,
    bindingCleanupEffectId: `${prefix}:binding-cleanup`,
    fileRefCleanupEffectId: `${prefix}:file-ref-terminalize`,
    recycleTerminalEffectId: `${prefix}:recycle-terminal:${exactRecycleEntryId}`
  };
}

export interface PrepareReviewPermanentDeleteActionInput {
  lifecycleActionId: string;
  reviewId: string;
  projectId: string;
  expectedReviewUpdatedAt: string;
  expectedReviewDeletedAt: string;
  expectedPlanningEpoch: string;
  expectedPlanningRevision: string;
  plannedCommittedPlanningRevision: string;
  sourceDeleteActionId: string;
  exactRecycleEntryId: string;
  expectedRecycleEntryRevision: number;
  impactPlanVersion: 1;
  impactDigest: string;
  impactPlanJson: string;
  confirmedAt: string;
  planningEffectId: string;
  operationLogEffectId: string;
  bindingCleanupEffectId: string;
  fileRefCleanupEffectId: string;
  recycleTerminalEffectId: string;
}

export interface ReviewPermanentDeleteActionRecord extends PrepareReviewPermanentDeleteActionInput {
  revision: number;
  operationType: "review_permanent_delete";
  committedPlanningEpoch: string | null;
  committedPlanningRevision: string | null;
  currentStage: "prepared" | "planning_committed" | "completed";
  terminalResult: string | null;
  lastErrorCode: string | null;
  lastErrorRetryable: boolean;
  createdAt: string;
  updatedAt: string;
  terminalAt: string | null;
}

export interface PersistedReviewPermanentDeleteTarget extends ReviewPermanentDeleteTarget {
  targetKind: "binding" | "file_ref" | "entity_link" | "change_log";
}

export interface ReviewPermanentDeleteActionReadback {
  action: ReviewPermanentDeleteActionRecord;
  targets: PersistedReviewPermanentDeleteTarget[];
}

export interface ReviewPermanentDeleteFinalizationReadback {
  action: ReviewPermanentDeleteActionRecord;
  deletedBindingIds: string[];
  terminalFileRefIds: string[];
  operationLogId: string;
  recycleEntryId: string;
  priorSuccess: boolean;
}

export const reviewPermanentDeleteFoundationPort = {
  async prepare(input: PrepareReviewPermanentDeleteActionInput) {
    assertReviewPermanentDeleteRuntimeAdmission();
    return invoke<ReviewPermanentDeleteActionRecord>("prepare_review_permanent_delete_action", { input });
  },
  async readback(lifecycleActionId: string) {
    assertReviewPermanentDeleteRuntimeAdmission();
    return invoke<ReviewPermanentDeleteActionReadback | null>("readback_review_permanent_delete_action", {
      lifecycleActionId
    });
  },
  async readPending(reviewId: string) {
    assertReviewPermanentDeleteRuntimeAdmission();
    return invoke<ReviewPermanentDeleteActionReadback | null>(
      "read_pending_review_permanent_delete_action",
      { reviewId }
    );
  },
  async recordPlanningCommit(input: {
    lifecycleActionId: string;
    expectedRevision: number;
    impactDigest: string;
    committedPlanningEpoch: string;
    committedPlanningRevision: string;
  }) {
    assertReviewPermanentDeleteRuntimeAdmission();
    return invoke<ReviewPermanentDeleteActionRecord>(
      "record_review_permanent_delete_planning_commit",
      { input }
    );
  },
  async finalize(input: {
    lifecycleActionId: string;
    expectedRevision: number;
    impactDigest: string;
    terminalAt: string;
  }) {
    assertReviewPermanentDeleteRuntimeAdmission();
    return invoke<ReviewPermanentDeleteFinalizationReadback>(
      "finalize_review_permanent_delete_metadata",
      { input }
    );
  }
};
