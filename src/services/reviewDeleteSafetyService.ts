import type { EntityId, ISODateString } from "../types/common";
import type { FileRef } from "../types/experiment";
import type { EntityLink, PlanningData, Review } from "../types/planning";
import type { OperationImpactPreview } from "../types/operationSafety";
import type { DeletedEntitySummary, RecycleEntry } from "../types/recycleBin";
import type { RefreshKey, WriteFeedbackResult } from "../types/writeFeedback";
import type { OperationImpactSummary } from "../types/operationLog";
import type { WriteFeedbackMessage, WriteFeedbackSeverity } from "../types/writeFeedback";
import {
  commitReviewLifecyclePlanningSnapshot,
  getPlanningRepositoryEnvelope,
  getPlanningData
} from "./planningRepository";
import type {
  PlanningAuthorityEnvelopeView,
  PlanningOwnerAuthorityRequest,
  ValidatedPlanningAuthorityHandle
} from "./planningOwnerAuthorityPort";
import { authorityWriterGuard } from "./authorityWriterGuard";
import {
  getRecycleEntry,
  listRecycleEntries
} from "./recycleBinService";
import {
  assertReviewLifecycleRuntimeAdmission,
  buildReviewLifecycleEffectIds,
  buildSoftDeleteRecycleEntryId,
  continueReviewLifecycleAction,
  ReviewLifecycleExecutionError,
  reviewLifecycleActionPort
} from "./reviewLifecycleActionService";
import type {
  PrepareReviewLifecycleActionInput,
  ReviewLifecycleActionRecord,
  ReviewLifecyclePlanningEnvelope
} from "./reviewLifecycleActionService";
import { publishWriteFeedbackRefresh } from "./refreshEventService";
import { reviewFileRefService } from "./reviewFileRefService";

export type ReviewDeleteMode = "soft_delete" | "permanent_delete";

export interface ReviewDeleteSafetyFileRef {
  id: EntityId;
  ownerType: string;
  ownerId: EntityId;
  title?: string;
  path?: string;
  fileType?: string;
  deletedAt?: ISODateString | null;
  updatedAt?: ISODateString;
  [key: string]: unknown;
}

export interface ReviewDeleteImpactPreviewInput {
  data: PlanningData;
  reviewId: EntityId;
  fileRefs?: ReviewDeleteSafetyFileRef[];
  mode?: ReviewDeleteMode;
}

export interface ReviewDeleteSnapshotMutationInput extends ReviewDeleteImpactPreviewInput {
  deletedAt: ISODateString;
  operationLogId?: EntityId;
  lifecycleActionId?: EntityId;
  planningEffectId?: EntityId;
}

export interface ReviewRestoreSnapshotMutationInput {
  data: PlanningData;
  reviewId: EntityId;
  restoredAt: ISODateString;
  recycleEntry?: RecycleEntry;
  expectedOperationLogId?: EntityId;
  lifecycleActionId?: EntityId;
  planningEffectId?: EntityId;
}

export interface ReviewDeleteSnapshotMutationResult {
  data: PlanningData;
  review?: Review;
  preview?: OperationImpactPreview;
  fileRefs: ReviewDeleteSafetyFileRef[];
  recycleEntry?: RecycleEntry;
  removedEntityLinkCount: number;
  removedFileRefCount: number;
  skipped: string[];
}

export interface ReviewDeleteOperationResult {
  review?: Review;
  preview?: OperationImpactPreview;
  recycleEntry?: RecycleEntry | DeletedEntitySummary;
  removedEntityLinkCount: number;
  removedFileRefCount: number;
  removedBinding?: boolean;
  metadataCleanupComplete?: boolean;
  failedStep?: "binding" | "fileRefs" | "reviewRecord";
  retryable?: boolean;
}

export type ReviewLifecycleOperation = "soft_delete" | "restore";

export type ReviewRestoreCapabilityReasonCode =
  | "ready"
  | "review_not_found"
  | "already_restored"
  | "recycle_entry_unavailable"
  | "recycle_entry_terminal"
  | "parent_project_unavailable"
  | "planning_unavailable";

export interface ReviewRestoreCapability {
  canRestore: boolean;
  reasonCode: ReviewRestoreCapabilityReasonCode;
  userMessage: string;
}

export interface ReviewRestoreCapabilityDependencies {
  readPlanningData(): Promise<PlanningData>;
  readRecycleEntry(
    reviewId: EntityId
  ): Promise<Pick<RecycleEntry, "canRestore" | "restoreStatus"> | undefined>;
}

export type ReviewLifecycleErrorReason =
  | "planning_unavailable"
  | "state_changed"
  | "authority_unavailable";

const REVIEW_DELETE_REFRESH_KEYS: RefreshKey[] = [
  "review.changed",
  "reviewContext.changed",
  "entityLink.changed",
  "fileRef.changed",
  "operationLog.changed",
  "recycleBin.changed",
  "aiContext.changed"
];

function now() {
  return new Date().toISOString();
}

export function buildReviewLifecycleAuthorityRequest(
  reviewId: EntityId,
  projectId: EntityId,
  operation: ReviewLifecycleOperation
): PlanningOwnerAuthorityRequest {
  return {
    intent: operation === "soft_delete" ? "reviewSoftDelete" : "reviewRestore",
    requestId: operation === "soft_delete"
      ? `review-soft-delete-${reviewId}`
      : `review-restore-${reviewId}`,
    projectId,
    ownerType: "review",
    ownerId: reviewId,
    scope: "primary"
  };
}

export function classifyReviewLifecycleError(error: unknown): ReviewLifecycleErrorReason {
  const status = typeof error === "object" && error !== null && "status" in error
    ? String(error.status)
    : "";
  const code = typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : error instanceof Error
      ? error.message
      : String(error);
  if (
    status === "InternalFailure" ||
    status === "DataSourceUnsupported" ||
    /TRANSPORT|SNAPSHOT|DATA_SOURCE|DESKTOP_RUNTIME/u.test(code)
  ) {
    return "planning_unavailable";
  }
  if (
    status === "AuthorityChanged" ||
    status === "LeaseStale" ||
    /CHANGED|STALE|REVISION|LEASE/u.test(code)
  ) {
    return "state_changed";
  }
  return "authority_unavailable";
}

export function evaluateReviewRestoreCapability(input: {
  data: PlanningData;
  reviewId: EntityId;
  recycleEntry?: Pick<RecycleEntry, "canRestore" | "restoreStatus">;
}): ReviewRestoreCapability {
  const review = input.data.reviews.find((item) => item.id === input.reviewId);
  if (!review) {
    return {
      canRestore: false,
      reasonCode: "review_not_found",
      userMessage: "Review metadata no longer exists."
    };
  }
  if (!review.deletedAt) {
    return {
      canRestore: false,
      reasonCode: "already_restored",
      userMessage: "Review has already been restored."
    };
  }
  if (!input.recycleEntry) {
    return {
      canRestore: false,
      reasonCode: "recycle_entry_unavailable",
      userMessage: "The Review recycle entry cannot be verified."
    };
  }
  if (input.recycleEntry.restoreStatus === "restored") {
    return {
      canRestore: false,
      reasonCode: "already_restored",
      userMessage: "Review has already been restored."
    };
  }
  if (
    !input.recycleEntry.canRestore ||
    input.recycleEntry.restoreStatus !== "not_started"
  ) {
    return {
      canRestore: false,
      reasonCode: "recycle_entry_terminal",
      userMessage: "This Review recycle entry is not restorable."
    };
  }
  const project = input.data.projects.find((item) => item.id === review.projectId);
  if (
    !project ||
    project.deletedAt ||
    project.archivedAt ||
    project.status === "archived"
  ) {
    return {
      canRestore: false,
      reasonCode: "parent_project_unavailable",
      userMessage: "The parent Project is unavailable, so this Review cannot be restored."
    };
  }
  return {
    canRestore: true,
    reasonCode: "ready",
    userMessage: "Review can be restored."
  };
}

const reviewRestoreCapabilityDependencies: ReviewRestoreCapabilityDependencies = {
  readPlanningData: getPlanningData,
  async readRecycleEntry(reviewId) {
    return (await listRecycleEntries({ entityType: "review", entityId: reviewId }))[0];
  }
};

export async function resolveReviewRestoreCapability(
  reviewId: EntityId,
  dependencies: ReviewRestoreCapabilityDependencies = reviewRestoreCapabilityDependencies
): Promise<ReviewRestoreCapability> {
  try {
    const [data, recycleEntry] = await Promise.all([
      dependencies.readPlanningData(),
      dependencies.readRecycleEntry(reviewId)
    ]);
    return evaluateReviewRestoreCapability({ data, reviewId, recycleEntry });
  } catch {
    return {
      canRestore: false,
      reasonCode: "planning_unavailable",
      userMessage: "Planning data is temporarily unavailable. Try again later."
    };
  }
}

export async function resolveExactReviewRestoreCapability(
  reviewId: EntityId,
  recycleEntryId?: EntityId
): Promise<ReviewRestoreCapability> {
  if (!recycleEntryId) {
    return {
      canRestore: false,
      reasonCode: "recycle_entry_unavailable",
      userMessage: "An exact Review recycle entry is required."
    };
  }
  try {
    const [data, recycleEntry] = await Promise.all([
      getPlanningData(),
      getRecycleEntry(recycleEntryId)
    ]);
    if (
      recycleEntry?.entityType !== "review"
      || recycleEntry.entityId !== reviewId
      || !recycleEntry.createdByLifecycleActionId
    ) {
      return {
        canRestore: false,
        reasonCode: "recycle_entry_unavailable",
        userMessage: "The exact recycle entry is not bound to a Review delete action."
      };
    }
    return evaluateReviewRestoreCapability({ data, reviewId, recycleEntry });
  } catch {
    return {
      canRestore: false,
      reasonCode: "planning_unavailable",
      userMessage: "Planning data is temporarily unavailable. Try again later."
    };
  }
}

function uniqueText(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function operationItemKey(item: OperationImpactPreview["affectedItems"][number]) {
  return [item.entityType, item.entityId ?? "", item.title, item.severity].join(":");
}

function createReviewOperationImpactPreview(
  input: Omit<
    OperationImpactPreview,
    "affectedEntityCount" | "warnings" | "blockingReasons" | "affectedItems"
  > & {
    affectedItems?: OperationImpactPreview["affectedItems"];
    warnings?: string[];
    blockingReasons?: string[];
  }
): OperationImpactPreview {
  const seen = new Set<string>();
  const affectedItems = (input.affectedItems ?? []).filter((item) => {
    const key = operationItemKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const blockingReasons = uniqueText(input.blockingReasons ?? []);
  return {
    ...input,
    affectedItems,
    affectedEntityCount: affectedItems.length,
    warnings: uniqueText(input.warnings ?? []),
    blockingReasons,
    canProceed: input.canProceed && blockingReasons.length === 0
  };
}

function toReviewWriteFeedbackMessage(
  message: string,
  severity: WriteFeedbackSeverity = "info",
  code?: string
): WriteFeedbackMessage {
  return { message, severity, code };
}

function summarizeImpactPreviewForReviewLog(
  preview?: OperationImpactPreview
): OperationImpactSummary | undefined {
  if (!preview) return undefined;
  return {
    affectedEntityCount: preview.affectedEntityCount,
    affectedItems: preview.affectedItems,
    warnings: preview.warnings,
    blockingReasons: preview.blockingReasons,
    deepScanPerformed: preview.deepScanPerformed
  };
}

function normalizeReviewWriteFeedback<T>(
  input: Omit<WriteFeedbackResult<T>, "affectedScopes" | "warnings" | "errors" | "messages" | "partial" | "createdAt"> &
    Partial<
      Pick<
        WriteFeedbackResult<T>,
        "affectedScopes" | "warnings" | "errors" | "messages" | "partial" | "createdAt"
      >
    >
): WriteFeedbackResult<T> {
  const warnings = input.warnings ?? [];
  const errors = input.errors ?? [];
  const skipped = input.skipped ?? [];
  const status = errors.length > 0
    ? "error"
    : input.status === "success" && (warnings.length > 0 || input.partial)
      ? "partial"
      : input.status;
  return {
    ...input,
    status,
    affectedScopes: input.affectedScopes ?? [],
    refreshKeys: [...new Set(input.refreshKeys)],
    messages: input.messages ?? [],
    warnings,
    errors,
    skipped,
    partial: status === "partial" || input.partial === true,
    createdAt: input.createdAt ?? now()
  };
}

function createId(prefix: string) {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function changeLog(
  entityId: EntityId,
  action: "deleted" | "restored",
  timestamp: ISODateString,
  note?: string,
  id?: EntityId
) {
  return {
    id: id ?? createId("change"),
    entityType: "review" as const,
    entityId,
    action,
    note,
    createdBy: "user" as const,
    createdAt: timestamp,
    schemaVersion: 1
  };
}

function activeReviewFileRefs(fileRefs: ReviewDeleteSafetyFileRef[] = [], reviewId: EntityId) {
  return fileRefs.filter(
    (fileRef) =>
      fileRef.ownerType === "review" && fileRef.ownerId === reviewId && !fileRef.deletedAt
  );
}

function reviewLinks(entityLinks: EntityLink[], reviewId: EntityId) {
  return entityLinks.filter(
    (link) =>
      (link.sourceType === "review" && link.sourceId === reviewId) ||
      (link.targetType === "review" && link.targetId === reviewId)
  );
}

function reviewSummary(review: Review) {
  const outlineCount = review.outlineSections.filter((section) => section.content.trim()).length;
  return `${outlineCount} outline sections with content`;
}

function recycleEntryForReview(
  review: Review,
  preview: OperationImpactPreview,
  deletedAt: ISODateString,
  operationLogId?: EntityId
) {
  const timestamp = now();
  return {
    id: createId("recycle-entry"),
    entityType: "review",
    entityId: review.id,
    title: review.title,
    summary: `Review metadata moved to recycle bin. Stored content summary: ${reviewSummary(review)}.`,
    module: "review",
    entityDeletedAt: deletedAt,
    deletedBy: "user",
    operationLogId,
    canRestore: true,
    knownImpactSummary: summarizeImpactPreviewForReviewLog(preview),
    restoreStatus: "not_started",
    refreshKeys: REVIEW_DELETE_REFRESH_KEYS,
    schemaVersion: 1,
    revision: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    deletedAt: null
  } satisfies RecycleEntry;
}

function closedRecycleEntry(
  entry: RecycleEntry | undefined,
  status: "restored" | "permanently_deleted",
  summary: string
) {
  if (!entry) return undefined;
  return {
    ...entry,
    canRestore: false,
    cannotRestoreReason:
      status === "restored"
        ? "Review has already been restored."
        : "Review metadata has been permanently deleted from SciLoom.",
    restoreStatus: status,
    summary,
    updatedAt: now()
  };
}

function activeReview(data: PlanningData, reviewId: EntityId) {
  return data.reviews.find((review) => review.id === reviewId && !review.deletedAt);
}

function deletedReview(data: PlanningData, reviewId: EntityId) {
  return data.reviews.find((review) => review.id === reviewId && Boolean(review.deletedAt));
}

export function buildReviewDeleteImpactPreviewFromSnapshot({
  data,
  reviewId,
  fileRefs = [],
  mode = "soft_delete"
}: ReviewDeleteImpactPreviewInput): OperationImpactPreview {
  const review = data.reviews.find((item) => item.id === reviewId);
  const links = reviewLinks(data.entityLinks, reviewId);
  const reviewFileRefs = activeReviewFileRefs(fileRefs, reviewId);
  const project = review ? data.projects.find((item) => item.id === review.projectId) : undefined;
  const permanent = mode === "permanent_delete";

  return createReviewOperationImpactPreview({
    operationId: permanent
      ? `review.permanentlyDelete:${reviewId}`
      : `review.softDelete:${reviewId}`,
    operation: "delete",
    target: {
      type: "review",
      id: reviewId,
      title: review?.title ?? reviewId
    },
    summary: review
      ? permanent
        ? `Permanently delete Review metadata "${review.title}" from SciLoom. Local file bodies are not touched.`
        : `Move Review "${review.title}" to recycle bin. It will be hidden from Review lists, context, Markdown editing, and AI context until restored.`
      : `Review ${reviewId} was not found.`,
    riskLevel: permanent ? "critical" : "high",
    executionKind: permanent ? "other" : "soft-delete",
    isRecoverable: !permanent,
    hasRestoreEntry: !permanent,
    requiresUserConfirmation: true,
    canProceed: Boolean(review),
    affectedItems: [
      ...(project
        ? [
            {
              entityType: "project",
              entityId: project.id,
              title: project.title,
              description: "Project is retained; Review context link is hidden with the Review.",
              severity: "info" as const
            }
          ]
        : []),
      ...(links.length > 0
        ? [
            {
              entityType: "entityLink",
              title: `${links.length} Review EntityLink records`,
              description: permanent
                ? "Review EntityLinks will be removed to prevent dangling references."
                : "EntityLinks are preserved so restore can recover Review context.",
              severity: permanent ? ("warning" as const) : ("info" as const)
            }
          ]
        : []),
      ...(reviewFileRefs.length > 0
        ? [
            {
              entityType: "fileRef",
              title: `${reviewFileRefs.length} Review FileRef metadata records`,
              description: permanent
                ? "FileRef metadata will be soft-deleted; referenced local files will not be read, moved, uploaded, or deleted."
                : "FileRef metadata is retained; referenced local files will not be read, moved, uploaded, or deleted.",
              severity: "warning" as const
            }
          ]
        : []),
      ...(review
        ? [
            {
              entityType: "review",
              entityId: review.id,
              title: "Review content summary",
              description: reviewSummary(review),
              severity: "info" as const
            }
          ]
        : [])
    ],
    warnings: [
      "Only SciLoom structured Review metadata is changed. Local file body content is not read, moved, uploaded, or deleted.",
      ...(permanent
        ? ["Permanent delete removes Review metadata and Review EntityLinks; restore is no longer available."]
        : ["Soft-deleted Review metadata remains available from the Review recycle area."])
    ],
    blockingReasons: review ? [] : ["review_not_found"],
    deepScanPerformed: true,
    confirmLabel: permanent ? "Permanently delete" : "Delete Review",
    cancelLabel: "Cancel"
  });
}

export function softDeleteReviewInSnapshot({
  data,
  reviewId,
  fileRefs = [],
  deletedAt,
  operationLogId,
  lifecycleActionId,
  planningEffectId
}: ReviewDeleteSnapshotMutationInput): ReviewDeleteSnapshotMutationResult {
  const storedReview = data.reviews.find((item) => item.id === reviewId);
  if (!storedReview || storedReview.deletedAt) {
    return {
      data,
      fileRefs,
      removedEntityLinkCount: 0,
      removedFileRefCount: 0,
      skipped: [storedReview ? "review_already_deleted" : "review_not_found"]
    };
  }
  const review = storedReview;

  const preview = buildReviewDeleteImpactPreviewFromSnapshot({
    data,
    reviewId,
    fileRefs,
    mode: "soft_delete"
  });
  const deletedReviewItem: Review = {
    ...review,
    deletedAt,
    updatedAt: deletedAt
  };
  const nextData: PlanningData = {
    ...data,
    reviews: data.reviews.map((item) => (item.id === reviewId ? deletedReviewItem : item)),
    changeLogs: [
      ...(data.changeLogs ?? []),
      changeLog(
        reviewId,
        "deleted",
        deletedAt,
        lifecycleActionId
          ? `Review lifecycle deleted; lifecycleActionId=${lifecycleActionId}`
          : "Review soft-deleted through LP7-7 safety service.",
        planningEffectId
      )
    ],
    exportedAt: deletedAt
  };

  return {
    data: nextData,
    review: deletedReviewItem,
    preview,
    fileRefs,
    recycleEntry: recycleEntryForReview(review, preview, deletedAt, operationLogId),
    removedEntityLinkCount: 0,
    removedFileRefCount: 0,
    skipped: []
  };
}

export function restoreReviewInSnapshot({
  data,
  reviewId,
  restoredAt,
  recycleEntry,
  expectedOperationLogId,
  lifecycleActionId,
  planningEffectId
}: ReviewRestoreSnapshotMutationInput): ReviewDeleteSnapshotMutationResult {
  if (
    expectedOperationLogId &&
    recycleEntry?.operationLogId !== expectedOperationLogId
  ) {
    return {
      data,
      fileRefs: [],
      recycleEntry,
      removedEntityLinkCount: 0,
      removedFileRefCount: 0,
      skipped: ["review_restore_entry_identity_mismatch"]
    };
  }
  const capability = evaluateReviewRestoreCapability({ data, reviewId, recycleEntry });
  if (!capability.canRestore) {
    const skipped = capability.reasonCode === "already_restored"
      ? "review_already_restored"
      : capability.reasonCode === "parent_project_unavailable"
        ? "review_restore_parent_unavailable"
        : capability.reasonCode === "recycle_entry_unavailable"
          ? "review_restore_entry_unavailable"
          : "review_not_found_or_not_deleted";
    return {
      data,
      fileRefs: [],
      recycleEntry,
      removedEntityLinkCount: 0,
      removedFileRefCount: 0,
      skipped: [skipped]
    };
  }
  const review = deletedReview(data, reviewId)!;

  const restoredReview: Review = {
    ...review,
    deletedAt: null,
    updatedAt: restoredAt
  };
  return {
    data: {
      ...data,
      reviews: data.reviews.map((item) => (item.id === reviewId ? restoredReview : item)),
      changeLogs: [
        ...(data.changeLogs ?? []),
        changeLog(
          reviewId,
          "restored",
          restoredAt,
          lifecycleActionId
            ? `Review lifecycle restored; lifecycleActionId=${lifecycleActionId}`
            : "Review restored through LP7-7 safety service.",
          planningEffectId
        )
      ],
      exportedAt: restoredAt
    },
    review: restoredReview,
    fileRefs: [],
    recycleEntry: closedRecycleEntry(
      recycleEntry,
      "restored",
      "Review metadata restored from recycle bin."
    ),
    removedEntityLinkCount: 0,
    removedFileRefCount: 0,
    skipped: []
  };
}

async function queryReviewFileRefs(reviewId: EntityId): Promise<FileRef[]> {
  return reviewFileRefService.queryAllReviewFileRefs(reviewId);
}

function feedbackForReviewOperation(
  operation: string,
  status: WriteFeedbackResult["status"],
  result: ReviewDeleteOperationResult,
  skipped: string[] = [],
  diagnostics: { warnings?: string[]; errors?: string[] } = {}
) {
  const reviewId = result.review?.id ?? result.preview?.target.id ?? "";
  const title = result.review?.title ?? result.preview?.target.title ?? reviewId;
  return normalizeReviewWriteFeedback<ReviewDeleteOperationResult>({
    status,
    operation,
    data: result,
    affectedEntities: reviewId
      ? [
          {
            type: "review",
            id: reviewId,
            relation: status === "success" ? "deleted" : status === "skipped" ? "skipped" : "updated",
            label: title
          }
        ]
      : [],
    affectedScopes: reviewId
      ? [
          {
            module: "review",
            reviewId,
            reason: operation
          },
          {
            module: "ai",
            reviewId,
            reason: "Review context and AI context must be refreshed after Review deletion safety operation."
          }
        ]
      : [],
    refreshKeys: REVIEW_DELETE_REFRESH_KEYS,
    skipped,
    warnings: diagnostics.warnings,
    errors: diagnostics.errors,
    partial: status === "partial",
    messages: [
      toReviewWriteFeedbackMessage(
        status === "success"
          ? `${title} updated by Review delete safety service.`
          : status === "skipped"
            ? "Review delete safety operation skipped."
            : `${title} metadata cleanup is incomplete and can be retried.`,
        status === "success" ? "success" : status === "error" ? "error" : "warning"
      )
    ]
  });
}

async function publishReviewDeleteFeedback(feedback: WriteFeedbackResult<ReviewDeleteOperationResult>) {
  publishWriteFeedbackRefresh(feedback, {
    source: "service.write",
    reason: feedback.operation
  });
  return feedback;
}

export async function getReviewDeleteImpactPreview(
  reviewId: EntityId,
  mode: ReviewDeleteMode = "soft_delete"
) {
  const [data, fileRefs] = await Promise.all([getPlanningData(), queryReviewFileRefs(reviewId)]);
  return buildReviewDeleteImpactPreviewFromSnapshot({ data, reviewId, fileRefs, mode });
}

function nextPlanningRevision(revision: string) {
  return (BigInt(revision) + 1n).toString();
}

function lifecycleTerminalFor(code: string) {
  if (code.includes("planning")) return "planning_conflict";
  if (code.includes("target_without_exact") || code.includes("identity")) return "identity_conflict";
  if (code.includes("recycle")) return "recycle_entry_conflict";
  return "source_state_conflict";
}

async function executeDurableReviewLifecycleAction(
  initialAction: ReviewLifecycleActionRecord,
  initialAuthority?: {
    permit: ValidatedPlanningAuthorityHandle;
    context: PlanningAuthorityEnvelopeView;
  }
) {
  let initial = initialAuthority;
  return continueReviewLifecycleAction(initialAction, {
    readPlanningEnvelope: async () => getPlanningRepositoryEnvelope() as Promise<ReviewLifecyclePlanningEnvelope>,
    commitPlanning: async (action, observedEnvelope) => {
      const commitWithAuthority = async (
        permit: ValidatedPlanningAuthorityHandle,
        context: PlanningAuthorityEnvelopeView
      ) => {
        if (
          context.repositoryEpoch !== observedEnvelope.repositoryEpoch
          || context.revision !== observedEnvelope.revision
          || context.repositoryEpoch !== action.expectedPlanningEpoch
          || context.revision !== action.expectedPlanningRevision
        ) {
          throw new ReviewLifecycleExecutionError("review_lifecycle_planning_conflict", false);
        }
        const recycleEntry = action.operationType === "review_restore"
          ? await getRecycleEntry(action.exactRecycleEntryId)
          : undefined;
        const mutation = action.operationType === "review_soft_delete"
          ? softDeleteReviewInSnapshot({
              data: context.snapshot,
              reviewId: action.reviewId,
              deletedAt: action.targetReviewUpdatedAt,
              lifecycleActionId: action.lifecycleActionId,
              planningEffectId: action.planningEffectId
            })
          : restoreReviewInSnapshot({
              data: context.snapshot,
              reviewId: action.reviewId,
              restoredAt: action.targetReviewUpdatedAt,
              recycleEntry,
              lifecycleActionId: action.lifecycleActionId,
              planningEffectId: action.planningEffectId
            });
        if (!mutation.review) {
          throw new ReviewLifecycleExecutionError("review_lifecycle_source_state_conflict", false);
        }
        return commitReviewLifecyclePlanningSnapshot({
          context,
          authorityPermit: permit,
          reviewId: action.reviewId,
          projectId: action.projectId,
          action: action.operationType === "review_soft_delete" ? "soft_delete" : "restore",
          lifecycleActionId: action.lifecycleActionId,
          planningEffectId: action.planningEffectId,
          nextSnapshot: mutation.data
        });
      };
      if (initial) {
        const authority = initial;
        initial = undefined;
        return commitWithAuthority(authority.permit, authority.context);
      }
      return authorityWriterGuard.run({
        request: buildReviewLifecycleAuthorityRequest(
          action.reviewId,
          action.projectId,
          action.operationType === "review_soft_delete" ? "soft_delete" : "restore"
        ),
        invalidation: {
          domain: "planning",
          projectId: action.projectId,
          ownerType: "review",
          ownerId: action.reviewId
        },
        write: commitWithAuthority
      });
    },
    recordPlanningCommit: (action, result) =>
      reviewLifecycleActionPort.recordPlanningCommit(action, result),
    recordOperationLog: async (action) => {
      const planning = await getPlanningData();
      const review = planning.reviews.find((item) => item.id === action.reviewId);
      return reviewLifecycleActionPort.recordOperationLog(action, {
        targetTitle: review?.title ?? action.reviewId,
        summary: action.operationType === "review_soft_delete"
          ? `${review?.title ?? action.reviewId} moved to Review recycle area.`
          : `${review?.title ?? action.reviewId} restored from Review recycle area.`,
        confirmation: { required: true, confirmedByUser: true },
        createdAt: action.targetReviewUpdatedAt
      });
    },
    recordRecycleEffect: async (action) => {
      if (action.operationType === "review_restore") {
        const entry = await getRecycleEntry(action.exactRecycleEntryId);
        if (!entry || entry.createdByLifecycleActionId !== action.sourceDeleteActionId) {
          throw new ReviewLifecycleExecutionError("recycle_entry_conflict", false);
        }
        return reviewLifecycleActionPort.recordRecycleRestore(action, {
          expectedEntryRevision: entry.revision,
          restoredAt: action.targetReviewUpdatedAt
        });
      }
      const planning = await getPlanningData();
      const review = planning.reviews.find((item) => item.id === action.reviewId);
      return reviewLifecycleActionPort.recordRecycleCreate(action, {
        title: review?.title ?? action.reviewId,
        summary: "Review metadata moved to recycle bin.",
        deletedAt: action.targetReviewDeletedAt ?? action.targetReviewUpdatedAt
      });
    },
    complete: (action) => reviewLifecycleActionPort.complete(action),
    recordRetryableFailure: (action, error) => reviewLifecycleActionPort.recordFailure(action, {
      errorCode: error instanceof Error ? error.message : "review_lifecycle_retryable_failure",
      retryable: true
    }),
    recordTerminalFailure: (action, error) => reviewLifecycleActionPort.recordFailure(action, {
      errorCode: error.code,
      retryable: false,
      terminalResult: lifecycleTerminalFor(error.code)
    })
  });
}

function successFeedbackForCompletedAction(action: ReviewLifecycleActionRecord, review?: Review) {
  return feedbackForReviewOperation(
    action.operationType === "review_soft_delete" ? "review.softDelete" : "review.restoreDeleted",
    "success",
    {
      review,
      removedEntityLinkCount: 0,
      removedFileRefCount: 0
    }
  );
}

export async function softDeleteReview(
  reviewId: EntityId,
  options: { confirmedByUser: boolean; lifecycleActionId?: EntityId } = { confirmedByUser: false }
): Promise<WriteFeedbackResult<ReviewDeleteOperationResult>> {
  if (options.confirmedByUser !== true) {
    const preview = await getReviewDeleteImpactPreview(reviewId, "soft_delete");
    return publishReviewDeleteFeedback(
      feedbackForReviewOperation(
        "review.softDelete",
        "skipped",
        { preview, removedEntityLinkCount: 0, removedFileRefCount: 0 },
        ["review_delete_requires_user_confirmation"]
      )
    );
  }
  try {
    assertReviewLifecycleRuntimeAdmission();
  } catch {
    return publishReviewDeleteFeedback(
      feedbackForReviewOperation(
        "review.softDelete",
        "skipped",
        { removedEntityLinkCount: 0, removedFileRefCount: 0 },
        ["review_lifecycle_durable_store_required"]
      )
    );
  }
  const pending = options.lifecycleActionId
    ? await reviewLifecycleActionPort.readback(options.lifecycleActionId)
    : await reviewLifecycleActionPort.readPending(reviewId);
  if (pending) {
    if (pending.reviewId !== reviewId || pending.operationType !== "review_soft_delete") {
      return publishReviewDeleteFeedback(feedbackForReviewOperation(
        "review.softDelete", "skipped",
        { removedEntityLinkCount: 0, removedFileRefCount: 0 },
        ["review_lifecycle_pending_conflict"]
      ));
    }
    const completed = await executeDurableReviewLifecycleAction(pending);
    const review = (await getPlanningData()).reviews.find((item) => item.id === reviewId);
    return publishReviewDeleteFeedback(successFeedbackForCompletedAction(completed, review));
  }
  const review = (await getPlanningData()).reviews.find((item) => item.id === reviewId);
  if (!review || review.deletedAt) {
    return publishReviewDeleteFeedback(feedbackForReviewOperation(
      "review.softDelete", "skipped",
      { review, removedEntityLinkCount: 0, removedFileRefCount: 0 },
      [review ? "review_already_deleted_without_recoverable_action" : "review_not_found"]
    ));
  }
  const lifecycleActionId = options.lifecycleActionId ?? createId("review-lifecycle-action");
  return authorityWriterGuard.run({
    request: buildReviewLifecycleAuthorityRequest(reviewId, review.projectId, "soft_delete"),
    invalidation: { domain: "planning", projectId: review.projectId, ownerType: "review", ownerId: reviewId },
    write: async (permit, context) => {
      const source = context.snapshot.reviews.find((item) => item.id === reviewId && !item.deletedAt);
      if (!source) throw new ReviewLifecycleExecutionError("review_lifecycle_source_state_conflict", false);
      const targetAt = now();
      const exactRecycleEntryId = buildSoftDeleteRecycleEntryId(lifecycleActionId);
      const ids = buildReviewLifecycleEffectIds(lifecycleActionId, exactRecycleEntryId, "review_soft_delete");
      const preparedInput: PrepareReviewLifecycleActionInput = {
        lifecycleActionId, operationType: "review_soft_delete", reviewId, projectId: source.projectId,
        expectedReviewSourceState: "active", expectedReviewUpdatedAt: source.updatedAt,
        expectedReviewDeletedAt: null, targetReviewUpdatedAt: targetAt, targetReviewDeletedAt: targetAt,
        expectedPlanningEpoch: context.repositoryEpoch, expectedPlanningRevision: context.revision,
        plannedCommittedPlanningRevision: nextPlanningRevision(context.revision),
        ...ids, sourceDeleteActionId: null, exactRecycleEntryId
      };
      const prepared = await reviewLifecycleActionPort.prepare(preparedInput);
      const completed = await executeDurableReviewLifecycleAction(prepared, { permit, context });
      const stored = (await getPlanningData()).reviews.find((item) => item.id === reviewId);
      return publishReviewDeleteFeedback(successFeedbackForCompletedAction(completed, stored));
    }
  });
}

export async function restoreDeletedReview(
  reviewId: EntityId,
  options: {
    confirmedByUser: boolean;
    operationLogId?: EntityId;
    recycleEntryId?: EntityId;
    lifecycleActionId?: EntityId;
    sourceDeleteActionId?: EntityId;
  } = {
    confirmedByUser: false
  }
): Promise<WriteFeedbackResult<ReviewDeleteOperationResult>> {
  if (options.confirmedByUser !== true) {
    return publishReviewDeleteFeedback(
      feedbackForReviewOperation(
        "review.restoreDeleted",
        "skipped",
        { removedEntityLinkCount: 0, removedFileRefCount: 0 },
        ["review_restore_requires_user_confirmation"]
      )
    );
  }
  try {
    assertReviewLifecycleRuntimeAdmission();
  } catch {
    return publishReviewDeleteFeedback(
      feedbackForReviewOperation("review.restoreDeleted", "skipped",
        { removedEntityLinkCount: 0, removedFileRefCount: 0 },
        ["review_lifecycle_durable_store_required"])
    );
  }
  const pending = options.lifecycleActionId
    ? await reviewLifecycleActionPort.readback(options.lifecycleActionId)
    : await reviewLifecycleActionPort.readPending(reviewId);
  if (pending) {
    if (pending.reviewId !== reviewId || pending.operationType !== "review_restore") {
      return publishReviewDeleteFeedback(feedbackForReviewOperation(
        "review.restoreDeleted", "skipped",
        { removedEntityLinkCount: 0, removedFileRefCount: 0 },
        ["review_lifecycle_pending_conflict"]));
    }
    const completed = await executeDurableReviewLifecycleAction(pending);
    const stored = (await getPlanningData()).reviews.find((item) => item.id === reviewId);
    return publishReviewDeleteFeedback(successFeedbackForCompletedAction(completed, stored));
  }
  const review = (await getPlanningData()).reviews.find((item) => item.id === reviewId);
  if (!review || !review.deletedAt) {
    return publishReviewDeleteFeedback(feedbackForReviewOperation(
      "review.restoreDeleted", "skipped",
      { review, removedEntityLinkCount: 0, removedFileRefCount: 0 },
      [review ? "review_already_restored_without_recoverable_action" : "review_not_found"]));
  }
  if (!options.recycleEntryId) {
    return publishReviewDeleteFeedback(feedbackForReviewOperation(
      "review.restoreDeleted", "skipped",
      { review, removedEntityLinkCount: 0, removedFileRefCount: 0 },
      ["review_restore_exact_recycle_entry_required"]));
  }
  const entry = await getRecycleEntry(options.recycleEntryId);
  const sourceDeleteActionId = options.sourceDeleteActionId ?? entry?.createdByLifecycleActionId ?? undefined;
  if (!entry || !sourceDeleteActionId) {
    return publishReviewDeleteFeedback(feedbackForReviewOperation(
      "review.restoreDeleted", "skipped",
      { review, removedEntityLinkCount: 0, removedFileRefCount: 0 },
      [entry ? "recycle_entry_legacy_unbound" : "recycle_entry_conflict"]));
  }
  const lifecycleActionId = options.lifecycleActionId ?? createId("review-lifecycle-action");
  return authorityWriterGuard.run({
    request: buildReviewLifecycleAuthorityRequest(reviewId, review.projectId, "restore"),
    invalidation: { domain: "planning", projectId: review.projectId, ownerType: "review", ownerId: reviewId },
    write: async (permit, context) => {
      const source = context.snapshot.reviews.find((item) => item.id === reviewId && item.deletedAt);
      if (!source) throw new ReviewLifecycleExecutionError("review_lifecycle_source_state_conflict", false);
      const targetAt = now();
      const ids = buildReviewLifecycleEffectIds(lifecycleActionId, entry.id, "review_restore");
      const prepared = await reviewLifecycleActionPort.prepare({
        lifecycleActionId, operationType: "review_restore", reviewId, projectId: source.projectId,
        expectedReviewSourceState: "deleted", expectedReviewUpdatedAt: source.updatedAt,
        expectedReviewDeletedAt: source.deletedAt ?? null, targetReviewUpdatedAt: targetAt,
        targetReviewDeletedAt: null, expectedPlanningEpoch: context.repositoryEpoch,
        expectedPlanningRevision: context.revision,
        plannedCommittedPlanningRevision: nextPlanningRevision(context.revision),
        ...ids, sourceDeleteActionId, exactRecycleEntryId: entry.id
      });
      const completed = await executeDurableReviewLifecycleAction(prepared, { permit, context });
      const stored = (await getPlanningData()).reviews.find((item) => item.id === reviewId);
      return publishReviewDeleteFeedback(successFeedbackForCompletedAction(completed, stored));
    }
  });
}

export async function queryDeletedReviews() {
  const data = await getPlanningData();
  return data.reviews
    .filter((review) => Boolean(review.deletedAt))
    .sort((left, right) => (right.deletedAt ?? "").localeCompare(left.deletedAt ?? ""));
}

export async function queryReviewRecycleEntries(): Promise<DeletedEntitySummary[]> {
  return (await listRecycleEntries({ entityType: "review" }))
    .filter((entry) => entry.restoreStatus !== "permanently_deleted");
}

export const reviewDeleteSafetyService = {
  buildReviewDeleteImpactPreviewFromSnapshot,
  softDeleteReviewInSnapshot,
  restoreReviewInSnapshot,
  resolveReviewRestoreCapability,
  getReviewDeleteImpactPreview,
  softDeleteReview,
  restoreDeletedReview,
  queryDeletedReviews,
  queryReviewRecycleEntries
};
