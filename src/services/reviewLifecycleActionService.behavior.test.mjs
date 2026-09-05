import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const bundle = await build({
  entryPoints: [path.join(directory, "reviewLifecycleActionService.ts")],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  target: "es2022"
});
const lifecycle = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

test("runtime admission and deterministic identities fail closed outside desktop SQLite", () => {
  assert.deepEqual(
    lifecycle.evaluateReviewLifecycleRuntimeAdmission({ tauriRuntime: true, dataSourceMode: "sqlite" }),
    { status: "Allowed" }
  );
  for (const input of [
    { tauriRuntime: false, dataSourceMode: "localStorage" },
    { tauriRuntime: true, dataSourceMode: "localStorage" }
  ]) {
    assert.equal(
      lifecycle.evaluateReviewLifecycleRuntimeAdmission(input).code,
      "review_lifecycle_durable_store_required"
    );
  }
  assert.deepEqual(lifecycle.buildReviewLifecycleEffectIds("action-1", "entry-1", "review_restore"), {
    planningEffectId: "review-lifecycle:action-1:planning",
    operationLogEffectId: "review-lifecycle:action-1:operation-log",
    recycleEffectId: "review-lifecycle:action-1:recycle-terminal:entry-1"
  });
});

test("pending action list failures retain a typed degraded reason", () => {
  const normalized = lifecycle.normalizePendingReviewLifecycleListError({
    code: "review_lifecycle_storage_failure",
    retryable: true,
    message: "task-owned read failure"
  });
  assert.equal(normalized.name, "ReviewLifecycleExecutionError");
  assert.equal(normalized.code, "review_lifecycle_storage_failure");
  assert.equal(normalized.retryable, true);
  assert.equal(normalized.message, "task-owned read failure");
  assert.equal(
    lifecycle.normalizePendingReviewLifecycleListError(new Error("unknown")).code,
    "review_lifecycle_pending_list_unavailable"
  );
});

function scenario(operationType, failAt, ackLost) {
  const actionId = `${operationType}-${failAt}-${ackLost ? "ack" : "failure"}`;
  const ids = lifecycle.buildReviewLifecycleEffectIds(actionId, "entry-1", operationType);
  let action = {
    lifecycleActionId: actionId,
    revision: 0,
    operationType,
    reviewId: "review-1",
    projectId: "project-1",
    expectedReviewSourceState: operationType === "review_soft_delete" ? "active" : "deleted",
    expectedReviewUpdatedAt: "source-at",
    expectedReviewDeletedAt: operationType === "review_restore" ? "source-at" : null,
    targetReviewUpdatedAt: "target-at",
    targetReviewDeletedAt: operationType === "review_soft_delete" ? "target-at" : null,
    expectedPlanningEpoch: "epoch-1",
    expectedPlanningRevision: "7",
    plannedCommittedPlanningRevision: "8",
    committedPlanningEpoch: null,
    committedPlanningRevision: null,
    planningEffectId: ids.planningEffectId,
    sourceDeleteActionId: operationType === "review_restore" ? "delete-source" : null,
    exactRecycleEntryId: "entry-1",
    operationLogEffectId: ids.operationLogEffectId,
    recycleEffectId: ids.recycleEffectId,
    currentStage: "prepared",
    terminalResult: null
  };
  let planningMutations = 0;
  let logEffects = 0;
  let recycleEffects = 0;
  let failed = false;
  let snapshot = {
    reviews: [{
      id: "review-1",
      updatedAt: "source-at",
      deletedAt: operationType === "review_restore" ? "source-at" : null
    }],
    changeLogs: []
  };
  const envelope = () => ({ repositoryEpoch: "epoch-1", revision: String(7 + planningMutations), snapshot });
  const promote = (stage, extra = {}) => {
    action = { ...action, ...extra, revision: action.revision + 1, currentStage: stage };
    return action;
  };
  const dependencies = () => ({
    readPlanningEnvelope: async () => envelope(),
    commitPlanning: async () => {
      planningMutations += 1;
      snapshot = {
        reviews: [{ id: "review-1", updatedAt: "target-at", deletedAt: action.targetReviewDeletedAt }],
        changeLogs: [{
          id: action.planningEffectId,
          entityType: "review",
          entityId: "review-1",
          action: operationType === "review_soft_delete" ? "deleted" : "restored",
          note: lifecycle.buildReviewLifecycleChangeLogNote(action)
        }]
      };
      return { committedPlanningEpoch: "epoch-1", committedPlanningRevision: "8", snapshot, planningEffectId: action.planningEffectId };
    },
    recordPlanningCommit: async (_action, result) => promote("planning_committed", {
      committedPlanningEpoch: result.committedPlanningEpoch,
      committedPlanningRevision: result.committedPlanningRevision
    }),
    recordOperationLog: async () => {
      if (failAt === "log" && !failed) {
        failed = true;
        if (ackLost) { logEffects = 1; promote("operation_log_recorded"); }
        throw new Error("injected log failure");
      }
      if (logEffects === 0) logEffects = 1;
      return action.currentStage === "operation_log_recorded" ? action : promote("operation_log_recorded");
    },
    recordRecycleEffect: async () => {
      if (failAt === "recycle" && !failed) {
        failed = true;
        if (ackLost) { recycleEffects = 1; promote("recycle_effect_recorded"); }
        throw new Error("injected recycle failure");
      }
      if (recycleEffects === 0) recycleEffects = 1;
      return action.currentStage === "recycle_effect_recorded" ? action : promote("recycle_effect_recorded");
    },
    complete: async () => promote("completed", { terminalResult: "completed" }),
    recordRetryableFailure: async () => action
  });
  return { get action() { return action; }, dependencies, counts: () => ({ planningMutations, logEffects, recycleEffects }) };
}

for (const operationType of ["review_soft_delete", "review_restore"]) {
  for (const failAt of ["log", "recycle"]) {
    for (const ackLost of [false, true]) {
      test(`${operationType} ${failAt} ${ackLost ? "ack loss" : "failure"} converges after explicit restart retry`, async () => {
        const current = scenario(operationType, failAt, ackLost);
        await assert.rejects(
          lifecycle.continueReviewLifecycleAction(current.action, current.dependencies()),
          /injected/
        );
        const completed = await lifecycle.continueReviewLifecycleAction(
          current.action,
          current.dependencies()
        );
        assert.equal(completed.currentStage, "completed");
        assert.equal(completed.terminalResult, "completed");
        assert.deepEqual(current.counts(), { planningMutations: 1, logEffects: 1, recycleEffects: 1 });
      });
    }
  }
}

test("target Review state without exact Planning effect is never claimed", () => {
  const action = scenario("review_soft_delete", "log", false).action;
  const result = lifecycle.correlateReviewLifecyclePlanningEffect(action, {
    repositoryEpoch: "epoch-1",
    revision: "8",
    snapshot: { reviews: [{ id: "review-1", updatedAt: "target-at", deletedAt: "target-at" }], changeLogs: [] }
  });
  assert.equal(result.status, "Conflict");
  assert.equal(result.code, "review_lifecycle_target_without_exact_effect");
});
