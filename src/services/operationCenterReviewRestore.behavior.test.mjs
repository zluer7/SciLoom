import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const bundle = await build({
  entryPoints: [path.join(directory, "operationCenterService.ts")],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  target: "es2022"
});
const contract = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

function deletedItem(overrides = {}) {
  return {
    entityType: "review",
    entityId: "review-1",
    title: "Stage review",
    module: "review",
    deletedAt: "2026-08-07T00:00:00.000Z",
    operationLogId: "operation-log-1",
    recycleEntryId: "recycle-entry-1",
    createdByLifecycleActionId: "delete-action-1",
    canRestore: true,
    restoreStatus: "not_started",
    refreshKeys: ["review.changed", "recycleBin.changed"],
    ...overrides
  };
}

function pendingAction(overrides = {}) {
  return {
    lifecycleActionId: "pending-delete-1",
    revision: 2,
    operationType: "review_soft_delete",
    reviewId: "review-1",
    projectId: "project-1",
    expectedReviewSourceState: "active",
    expectedReviewUpdatedAt: "2026-08-07T00:00:00.000Z",
    expectedReviewDeletedAt: null,
    targetReviewUpdatedAt: "2026-08-07T00:01:00.000Z",
    targetReviewDeletedAt: "2026-08-07T00:01:00.000Z",
    expectedPlanningEpoch: "epoch-1",
    expectedPlanningRevision: "1",
    plannedCommittedPlanningRevision: "2",
    committedPlanningEpoch: "epoch-1",
    committedPlanningRevision: "2",
    planningEffectId: "planning-effect-1",
    sourceDeleteActionId: null,
    exactRecycleEntryId: "planned-entry-1",
    operationLogEffectId: "log-effect-1",
    recycleEffectId: "recycle-effect-1",
    currentStage: "planning_committed",
    terminalResult: null,
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:02:00.000Z",
    terminalAt: null,
    ...overrides
  };
}

test("Operation Center independently discovers a pending delete without inventing a recycle row", async () => {
  const rows = await contract.composeOperationCenterItems(
    {
      genericDeletedItems: [],
      reviewRecycleEntries: [],
      pendingReviewActions: [pendingAction()],
      reviewMetadata: [{
        id: "review-1",
        title: "Restart review",
        updatedAt: "2026-08-07T00:01:00.000Z",
        deletedAt: "2026-08-07T00:01:00.000Z"
      }]
    },
    async () => assert.fail("no recycle row capability should be resolved")
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "review_pending_lifecycle_action");
  assert.equal(rows[0].rowKey, "review-lifecycle-action:pending-delete-1");
  assert.equal(rows[0].lifecycleActionId, "pending-delete-1");
  assert.equal(rows[0].exactRecycleEntryId, null);
  assert.equal(rows[0].canContinue, true);
  assert.equal("item" in rows[0], false, "pending-only discovery must not synthesize a recycle item");
});

test("Operation Center preserves multiple exact Review entries and attaches one pending restore once", async () => {
  const entryA = deletedItem({
    recycleEntryId: "entry-a",
    createdByLifecycleActionId: null,
    title: "Legacy entry",
    deletedAt: "2026-08-07T00:03:00.000Z"
  });
  const entryB = deletedItem({
    recycleEntryId: "entry-b",
    createdByLifecycleActionId: "delete-action-b",
    title: "Bound entry",
    deletedAt: "2026-08-07T00:04:00.000Z"
  });
  const restore = pendingAction({
    lifecycleActionId: "restore-action-b",
    operationType: "review_restore",
    expectedReviewSourceState: "deleted",
    sourceDeleteActionId: "delete-action-b",
    exactRecycleEntryId: "entry-b",
    currentStage: "operation_log_recorded",
    updatedAt: "2026-08-07T00:05:00.000Z"
  });
  const rows = await contract.composeOperationCenterItems(
    {
      genericDeletedItems: [deletedItem({
        entityType: "literature",
        entityId: "literature-1",
        module: "literature",
        recycleEntryId: undefined,
        deletedAt: "2026-08-07T00:02:00.000Z"
      })],
      reviewRecycleEntries: [entryA, entryB],
      pendingReviewActions: [restore],
      reviewMetadata: []
    },
    async (_reviewId, item) => item.recycleEntryId === "entry-a"
      ? { canRestore: false, reasonCode: "recycle_entry_unavailable", userMessage: "Legacy unbound entry." }
      : { canRestore: true, reasonCode: "ready", userMessage: "Ready." }
  );

  assert.equal(rows.length, 3, "matching pending restore must not create a duplicate action row");
  assert.deepEqual(
    rows.map((row) => row.rowKey),
    [
      "review-recycle-entry:entry-b",
      "review-recycle-entry:entry-a",
      "generic-deleted:literature:literature-1"
    ],
    "effective timestamp ordering must be stable before kind and exact identity ties"
  );
  const reviewRows = rows.filter((row) => row.kind === "review_recycle_entry");
  assert.deepEqual(reviewRows.map((row) => row.recycleEntryId).sort(), ["entry-a", "entry-b"]);
  assert.equal(new Set(reviewRows.map((row) => row.rowKey)).size, 2);
  const legacy = reviewRows.find((row) => row.recycleEntryId === "entry-a");
  const bound = reviewRows.find((row) => row.recycleEntryId === "entry-b");
  assert.equal(legacy.item.canRestore, false);
  assert.equal(legacy.item.cannotRestoreReason, "Legacy unbound entry.");
  assert.equal(bound.pendingLifecycleActionId, "restore-action-b");
  assert.equal(bound.canContinue, true);
  assert.equal(rows.some((row) => row.kind === "generic_deleted_entity"), true);
});

test("missing Review metadata uses the canonical fallback without blocking pending delete", async () => {
  const rows = await contract.composeOperationCenterItems(
    {
      genericDeletedItems: [],
      reviewRecycleEntries: [],
      pendingReviewActions: [pendingAction({ lifecycleActionId: "fallback-action" })],
      reviewMetadata: []
    },
    async () => assert.fail("no capability lookup expected")
  );
  assert.equal(rows[0].title, "Unnamed Review");
  assert.equal(rows[0].degradedReasonCode, "review_metadata_unavailable");
  assert.equal(rows[0].canContinue, true);
});

test("pending delete attaches only to its exact persisted effect and identity conflicts fail closed", async () => {
  const deleteAction = pendingAction({
    lifecycleActionId: "delete-attached",
    exactRecycleEntryId: "entry-attached",
    currentStage: "recycle_effect_recorded"
  });
  const matching = deletedItem({
    recycleEntryId: "entry-attached",
    createdByLifecycleActionId: "delete-attached"
  });
  const attached = await contract.composeOperationCenterItems(
    { genericDeletedItems: [], reviewRecycleEntries: [matching], pendingReviewActions: [deleteAction], reviewMetadata: [] },
    async () => ({ canRestore: true, reasonCode: "ready", userMessage: "ready" })
  );
  assert.equal(attached.length, 1);
  assert.equal(attached[0].kind, "review_recycle_entry");
  assert.equal(attached[0].pendingLifecycleActionId, "delete-attached");

  const conflict = await contract.composeOperationCenterItems(
    {
      genericDeletedItems: [],
      reviewRecycleEntries: [{ ...matching, createdByLifecycleActionId: "other-delete" }],
      pendingReviewActions: [deleteAction],
      reviewMetadata: []
    },
    async () => ({ canRestore: true, reasonCode: "ready", userMessage: "ready" })
  );
  assert.equal(conflict.length, 2);
  const conflictAction = conflict.find((row) => row.kind === "review_pending_lifecycle_action");
  assert.equal(conflictAction.canContinue, false);
  assert.equal(conflictAction.reasonCode, "pending_action_exact_entry_conflict");
});

test("Operation Center routes Review restore only to the Review-specific typed adapter", async () => {
  assert.equal(
    typeof contract.dispatchOperationCenterRestore,
    "function",
    "typed restore dispatch must be available"
  );
  const calls = [];
  const result = await contract.dispatchOperationCenterRestore(
    {
      item: deletedItem(),
      confirmedByUser: true
    },
    {
      restoreReview: async (input) => {
        calls.push({ adapter: "review", input });
        return { status: "success", operation: "review.restoreDeleted" };
      },
      restoreGeneric: async (input) => {
        calls.push({ adapter: "generic", input });
        return { status: "skipped", operation: "recycleBin.restore" };
      }
    }
  );

  assert.equal(result.status, "success");
  assert.deepEqual(calls, [{
    adapter: "review",
    input: {
      reviewId: "review-1",
      confirmedByUser: true,
      operationLogId: "operation-log-1",
      recycleEntryId: "recycle-entry-1",
      lifecycleActionId: undefined,
      sourceDeleteActionId: "delete-action-1"
    }
  }]);
});

test("Operation Center retains the generic restore adapter for non-Review owners", async () => {
  assert.equal(
    typeof contract.dispatchOperationCenterRestore,
    "function",
    "typed restore dispatch must be available"
  );
  const calls = [];
  await contract.dispatchOperationCenterRestore(
    {
      item: deletedItem({ entityType: "literature", entityId: "literature-1", module: "literature" }),
      confirmedByUser: true
    },
    {
      restoreReview: async () => {
        calls.push("review");
      },
      restoreGeneric: async (input) => {
        calls.push(input);
        return { status: "success" };
      }
    }
  );

  assert.deepEqual(calls, [{
    entityType: "literature",
    entityId: "literature-1",
    confirmedByUser: true,
    operationLogId: "operation-log-1",
    recycleEntryId: "recycle-entry-1",
    lifecycleActionId: undefined,
    sourceDeleteActionId: "delete-action-1"
  }]);
});

test("Operation Center Review button state comes from the Review restore capability", async () => {
  assert.equal(
    typeof contract.resolveOperationCenterRestoreCapabilities,
    "function",
    "restore capability enrichment must be available"
  );
  const literature = deletedItem({
    entityType: "literature",
    entityId: "literature-1",
    module: "literature"
  });
  const items = await contract.resolveOperationCenterRestoreCapabilities(
    [deletedItem(), literature],
    async (reviewId) => {
      assert.equal(reviewId, "review-1");
      return {
        canRestore: false,
        reasonCode: "parent_project_unavailable",
        userMessage: "The parent Project is unavailable."
      };
    }
  );

  assert.equal(items[0].canRestore, false);
  assert.equal(items[0].cannotRestoreReason, "The parent Project is unavailable.");
  assert.equal(items[1], literature, "non-Review capability must remain unchanged");
});
