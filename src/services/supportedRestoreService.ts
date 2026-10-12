import type { OperationImpactPreview } from "../types/operationSafety";
import type { OutputDeleteImpactPreview, OutputDeleteSafetyLayer } from "../types/outputDeleteSafety";
import type { DeletedEntitySummary } from "../types/recycleBin";
import { getPlanningFirstLayerData } from "./planningRepository";
import { planningService } from "./planningService";
import { listRecentlyDeleted, restoreDeletedEntity } from "./recycleBinService";
import { queryReviewRecycleEntries, resolveExactReviewRestoreCapability, restoreDeletedReview } from "./reviewDeleteSafetyService";
import { reviewLifecycleActionPort } from "./reviewLifecycleActionService";
import { createRestoreDeletedEntityPreview, dispatchOperationCenterRestore } from "./operationCenterService";
import { confirmOutputDeleteImpactPreview, getOutputDeleteImpactPreview, restoreOutputEntity } from "./outputDeleteSafetyService";
import { resolveMountedManuscriptLifecycleDecision } from "./fileRefOwnerValidator";

export const SUPPORTED_RESTORE_TYPES = ["task", "routeNode", "review", "experiment", "experimentRun", "literature", "resultItem", "finding", "outputCandidate", "outputGap", "output"] as const;
export type SupportedRestoreType = typeof SUPPORTED_RESTORE_TYPES[number];
const OUTPUT_LAYERS: Partial<Record<SupportedRestoreType, OutputDeleteSafetyLayer>> = {
  resultItem: "resultItem", finding: "finding", outputCandidate: "outputCandidate", outputGap: "outputGap", output: "researchOutput"
};

export interface SupportedRestoreItem {
  key: string;
  entityType: SupportedRestoreType;
  entityId: string;
  title?: string;
  intent: "archive_reactivation" | "soft_delete_restore";
  occurredAt?: string;
  stateToken: string;
  recycleItem?: DeletedEntitySummary;
}

export interface PreparedSupportedRestore {
  item: SupportedRestoreItem;
  outputPreview?: OutputDeleteImpactPreview;
}

function isArchived(item: { status?: string; archivedAt?: string; captureState?: string }) {
  return Boolean(item.archivedAt || item.status === "archived" || item.captureState === "archived");
}

function safeTitle(title: string | undefined, id: string) {
  return title?.trim() && title.trim() !== id ? title : undefined;
}

/** A read-only support projection. Restore authority stays in the existing services. */
export async function listSupportedRestores(): Promise<SupportedRestoreItem[]> {
  const [planning, deleted, reviews, pending] = await Promise.all([
    getPlanningFirstLayerData(), listRecentlyDeleted(), queryReviewRecycleEntries(), reviewLifecycleActionPort.listPending()
  ]);
  const projectAvailable = (id: string) => planning.projects.some(project => project.id === id && !project.deletedAt && !isArchived(project));
  const items: SupportedRestoreItem[] = [];
  for (const [entityType, rows] of [["task", planning.tasks], ["routeNode", planning.routeNodes]] as const) {
    for (const row of rows) {
      if (row.deletedAt || !isArchived(row) || !projectAvailable(row.projectId)) continue;
      if ("routeNodeId" in row && row.routeNodeId && !planning.routeNodes.some(route => route.id === row.routeNodeId && !route.deletedAt && route.projectId === row.projectId)) continue;
      items.push({
        key: `archive:${entityType}:${row.id}`, entityType, entityId: row.id,
        title: safeTitle(row.title, row.id), intent: "archive_reactivation", occurredAt: row.archivedAt,
        stateToken: JSON.stringify([row.id, row.updatedAt, row.status, row.archivedAt, row.captureState, row.projectId, "routeNodeId" in row ? row.routeNodeId : null])
      });
    }
  }
  const pendingReviews = new Set(pending.map(action => action.reviewId));
  for (const item of reviews) {
    if (!item.recycleEntryId || !item.canRestore || item.restoreStatus !== "not_started" || pendingReviews.has(item.entityId)) continue;
    const review = planning.reviews.find(row => row.id === item.entityId && row.deletedAt);
    if (!review || isArchived(review)) continue;
    const capability = await resolveExactReviewRestoreCapability(item.entityId, item.recycleEntryId);
    if (capability.reasonCode === "planning_unavailable") throw new Error("SUPPORTED_RESTORE_READ_UNAVAILABLE");
    if (!capability.canRestore) continue;
    items.push(recycleItem(item, "review", [review.updatedAt, review.deletedAt]));
  }
  for (const item of deleted) {
    if (item.entityType === "review" || !SUPPORTED_RESTORE_TYPES.includes(item.entityType as SupportedRestoreType) || !item.canRestore || item.restoreStatus !== "not_started") continue;
    const entityType = item.entityType as SupportedRestoreType;
    if (entityType === "task" || entityType === "routeNode") continue; // deletion is not archive reactivation.
    const layer = OUTPUT_LAYERS[entityType];
    if (layer) {
      if (!item.recycleEntryId) continue;
      const [preview, lifecycle] = await Promise.all([
        getOutputDeleteImpactPreview({ layer, id: item.entityId, mode: "restore", recycleBinId: item.recycleEntryId }),
        resolveMountedManuscriptLifecycleDecision({ ownerType: layer, ownerId: item.entityId, manuscriptChannel: "primary" })
      ]);
      if (preview.canDelete && lifecycle.canRestore) items.push(recycleItem(item, entityType, [preview.previewHash, lifecycle.entity.deletedAt]));
    } else if (entityType === "experiment" || entityType === "experimentRun" || entityType === "literature") {
      const primary = await resolveMountedManuscriptLifecycleDecision({ ownerType: entityType, ownerId: item.entityId, manuscriptChannel: entityType === "literature" ? "literature_outline" : "primary" });
      const notes = entityType === "literature" ? await resolveMountedManuscriptLifecycleDecision({ ownerType: entityType, ownerId: item.entityId, manuscriptChannel: "dedicated_notes" }) : primary;
      if (primary.canRestore && notes.canRestore) items.push(recycleItem(item, entityType, [primary.entity.deletedAt]));
    }
  }
  return items.sort((left, right) => (right.occurredAt ?? "").localeCompare(left.occurredAt ?? "") || left.key.localeCompare(right.key)).slice(0, 50);
}

function recycleItem(item: DeletedEntitySummary, entityType: SupportedRestoreType, facts: unknown[]): SupportedRestoreItem {
  return {
    key: `recycle:${entityType}:${item.entityId}:${item.recycleEntryId ?? "owner"}`,
    entityType, entityId: item.entityId, title: safeTitle(item.title, item.entityId), intent: "soft_delete_restore", occurredAt: item.deletedAt,
    stateToken: JSON.stringify([item.entityId, item.recycleEntryId, item.createdByLifecycleActionId, item.revision, item.restoreStatus, item.deletedAt, ...facts]), recycleItem: item
  };
}

export async function prepareSupportedRestore(item: SupportedRestoreItem): Promise<PreparedSupportedRestore> {
  const fresh = (await listSupportedRestores()).find(row => row.key === item.key && row.stateToken === item.stateToken);
  if (!fresh) throw new Error("SUPPORTED_RESTORE_STATE_CHANGED");
  const layer = OUTPUT_LAYERS[fresh.entityType];
  const outputPreview = layer ? await getOutputDeleteImpactPreview({ layer, id: fresh.entityId, mode: "restore", recycleBinId: fresh.recycleItem?.recycleEntryId }) : undefined;
  if (outputPreview && !outputPreview.canDelete) throw new Error("SUPPORTED_RESTORE_STATE_CHANGED");
  return { item: fresh, outputPreview };
}

export function supportedRestoreConfirmationPreview(prepared: PreparedSupportedRestore, copy: { title: string; summary: string; warning: string; confirmLabel: string; cancelLabel: string }): OperationImpactPreview {
  // Product copy is a presentation of the exact intent, not raw diagnostic impact.
  // The original output preview/hash remains frozen separately for its formal service.
  return createRestoreDeletedEntityPreview({
    entityType: prepared.item.entityType, entityId: prepared.item.entityId, title: copy.title,
    module: "global", deletedAt: prepared.item.occurredAt ?? "", canRestore: true, restoreStatus: "not_started", refreshKeys: []
  }, copy);
}

/** Confirmation is a product gate; every existing canonical guard still runs. */
export async function executeSupportedRestore(prepared: PreparedSupportedRestore, confirmedByUser: boolean): Promise<{ status: "success" | "partial" | "skipped" | "error" }> {
  if (confirmedByUser !== true) return { status: "skipped" };
  const { item } = prepared;
  const fresh = (await listSupportedRestores()).find(row => row.key === item.key && row.stateToken === item.stateToken);
  if (!fresh) throw new Error("SUPPORTED_RESTORE_STATE_CHANGED");
  if (item.intent === "archive_reactivation") {
    const restored = item.entityType === "task" ? await planningService.restoreTask(item.entityId) : await planningService.restoreRouteNode(item.entityId);
    return { status: restored ? "success" : "skipped" };
  }
  if (prepared.outputPreview) {
    return restoreOutputEntity({ confirmation: confirmOutputDeleteImpactPreview(prepared.outputPreview) });
  }
  if (!fresh.recycleItem) throw new Error("SUPPORTED_RESTORE_STATE_CHANGED");
  return dispatchOperationCenterRestore({ item: fresh.recycleItem, confirmedByUser: true }, {
    restoreReview: input => restoreDeletedReview(input.reviewId, input), restoreGeneric: restoreDeletedEntity
  });
}

export const supportedRestoreService = { list: listSupportedRestores, prepare: prepareSupportedRestore, confirmationPreview: supportedRestoreConfirmationPreview, execute: executeSupportedRestore };
