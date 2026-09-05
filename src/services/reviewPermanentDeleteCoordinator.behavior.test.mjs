import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const bundle = await build({
  stdin: {
    contents: `
      export * from "./reviewPermanentDeleteCoordinator.ts";
      export * from "./planningRepository.ts";
    `,
    resolveDir: directory,
    sourcefile: "review-permanent-delete-coordinator-harness.ts"
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  target: "es2022"
});
const module = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

const time = "2026-08-07T01:00:00.000Z";

function harness(options = {}) {
  const counters = { prepare: 0, planning: 0, recordPlanning: 0, finalize: 0 };
  const envelope = {
    repositoryEpoch: "11111111-1111-4111-8111-111111111111",
    revision: "7",
    snapshot: module.createEmptyPlanningData(time)
  };
  envelope.snapshot.projects.push({
    id: "project-1", title: "Project", tags: [], createdAt: time, updatedAt: time,
    source: "user", schemaVersion: 1, status: "active", priority: "medium", orderIndex: 0
  });
  envelope.snapshot.reviews.push({
    id: "review-1", projectId: "project-1", title: "Review", tags: [],
    createdAt: time, updatedAt: "review-v2", deletedAt: "deleted-at", source: "user",
    schemaVersion: 1, reviewType: "custom", outlineSections: []
  });
  envelope.snapshot.entityLinks.push({
    id: "link-1", sourceType: "review", sourceId: "review-1", targetType: "task",
    targetId: "task-1", relationType: "related_to", createdAt: time,
    updatedAt: "link-v2", schemaVersion: 1
  });
  envelope.snapshot.changeLogs.push(
    { id: "log-a", entityType: "review", entityId: "review-1", action: "updated", before: { title: "content" }, createdBy: "user", createdAt: "log-v1", schemaVersion: 1 },
    { id: "log-b", entityType: "review", entityId: "review-1", action: "updated", note: "content", createdBy: "user", createdAt: "log-v2", schemaVersion: 1 },
    { id: "log-c", entityType: "review", entityId: "review-1", action: "deleted", note: "Review lifecycle deleted; lifecycleActionId=delete-action", createdBy: "system", createdAt: "log-v3", schemaVersion: 1 }
  );
  const inventory = {
    reviewId: "review-1",
    bindings: [{ id: "binding-1", revision: 0, ownerType: "review", ownerId: "review-1", manuscriptChannel: "primary", deletedAt: null, permanentDeleteStatus: null }],
    fileRefs: [{ id: "file-1", revision: 0, ownerType: "review", ownerId: "review-1", manuscriptChannel: "primary", deletedAt: null, permanentDeleteStatus: null }]
  };
  const entry = {
    id: "entry-1", entityType: "review", entityId: "review-1", title: "Review",
    module: "review", entityDeletedAt: "deleted-at", deletedBy: "user",
    canRestore: true, restoreStatus: "not_started", refreshKeys: [], schemaVersion: 1,
    createdAt: time, updatedAt: time, createdByLifecycleActionId: "delete-action",
    terminalLifecycleActionId: null, revision: 0
  };
  let stored = null;
  let losePlanningResponse = options.losePlanningResponse === true;
  let loseRecordPlanningResponse = options.loseRecordPlanningResponse === true;
  let loseFinalizationResponse = options.loseFinalizationResponse === true;

  function targetsFromPlan(plan) {
    return [
      ...plan.bindingTargets.map((target) => ({ ...target, targetKind: "binding" })),
      ...plan.fileRefTargets.map((target) => ({ ...target, targetKind: "file_ref" })),
      ...plan.entityLinkTargets.map((target) => ({ ...target, targetKind: "entity_link" })),
      ...plan.changeLogTargets.map((target) => ({ ...target, targetKind: "change_log" }))
    ];
  }

  const dependencies = {
    assertRuntimeAdmission() {
      if (options.runtimeUnavailable) throw new Error("review_permanent_delete_durable_store_required");
    },
    now: () => time,
    createLifecycleActionId: () => "permanent-action",
    readPlanningEnvelope: async () => envelope,
    readRecycleEntry: async (id) => id === entry.id ? entry : undefined,
    readMetadataInventory: async () => inventory,
    readPendingOrdinary: async () => options.pendingOrdinary ?? null,
    readPendingPermanent: async () => stored && !stored.action.terminalResult ? stored : null,
    async prepare(input) {
      counters.prepare += 1;
      const plan = JSON.parse(input.impactPlanJson);
      const action = {
        ...input, revision: 0, operationType: "review_permanent_delete",
        committedPlanningEpoch: null, committedPlanningRevision: null,
        currentStage: "prepared", terminalResult: null, lastErrorCode: null,
        lastErrorRetryable: false, createdAt: time, updatedAt: time, terminalAt: null
      };
      stored = { action, targets: targetsFromPlan(plan) };
      if (options.driftAfterPrepare) inventory.fileRefs[0].revision += 1;
      return action;
    },
    readback: async (id) => stored?.action.lifecycleActionId === id ? stored : null,
    async recordPlanningCommit(input) {
      counters.recordPlanning += 1;
      stored.action = {
        ...stored.action, revision: stored.action.revision + 1,
        committedPlanningEpoch: input.committedPlanningEpoch,
        committedPlanningRevision: input.committedPlanningRevision,
        currentStage: "planning_committed", updatedAt: time
      };
      if (loseRecordPlanningResponse) {
        loseRecordPlanningResponse = false;
        throw new Error("injected_planning_stage_response_loss");
      }
      return stored.action;
    },
    async commitPlanning(action, targets, observedEnvelope) {
      counters.planning += 1;
      envelope.snapshot = module.buildReviewPermanentDeletePlanningCandidate({
        context: observedEnvelope, action, targets
      });
      envelope.revision = action.plannedCommittedPlanningRevision;
      const result = {
        committedPlanningEpoch: envelope.repositoryEpoch,
        committedPlanningRevision: envelope.revision,
        snapshot: envelope.snapshot,
        planningEffectId: action.planningEffectId
      };
      if (losePlanningResponse) {
        losePlanningResponse = false;
        throw new Error("injected_planning_response_loss");
      }
      return result;
    },
    async finalize(input) {
      if (stored.action.currentStage === "completed") {
        return {
          action: stored.action, deletedBindingIds: ["binding-1"], terminalFileRefIds: ["file-1"],
          operationLogId: stored.action.operationLogEffectId, recycleEntryId: "entry-1", priorSuccess: true
        };
      }
      counters.finalize += 1;
      stored.action = {
        ...stored.action, revision: stored.action.revision + 1, currentStage: "completed",
        terminalResult: "completed", terminalAt: input.terminalAt, updatedAt: input.terminalAt
      };
      const result = {
        action: stored.action, deletedBindingIds: ["binding-1"], terminalFileRefIds: ["file-1"],
        operationLogId: stored.action.operationLogEffectId, recycleEntryId: "entry-1", priorSuccess: false
      };
      if (loseFinalizationResponse) {
        loseFinalizationResponse = false;
        throw new Error("injected_sqlite_commit_response_loss");
      }
      return result;
    }
  };
  return {
    coordinator: module.createReviewPermanentDeleteCoordinator(dependencies),
    dependencies, counters, envelope, inventory, entry,
    get stored() { return stored; }
  };
}

function executeInput(preview, patch = {}) {
  return {
    lifecycleActionId: preview.lifecycleActionId, reviewId: "review-1", projectId: "project-1",
    exactRecycleEntryId: "entry-1", sourceDeleteActionId: "delete-action",
    expectedRecycleEntryRevision: 0, confirmedImpactPlanVersion: 1,
    confirmedImpactDigest: preview.impactDigest, userConfirmed: true, ...patch
  };
}

test("preview is read-only and confirmation, digest, runtime, and pending gates prepare zero actions", async () => {
  const current = harness();
  const preview = await current.coordinator.preview({
    reviewId: "review-1", projectId: "project-1", exactRecycleEntryId: "entry-1",
    sourceDeleteActionId: "delete-action", expectedRecycleEntryRevision: 0
  });
  assert.equal(preview.physicalFilesPreserved, true);
  assert.deepEqual(current.counters, { prepare: 0, planning: 0, recordPlanning: 0, finalize: 0 });
  await assert.rejects(
    current.coordinator.execute(executeInput(preview, { userConfirmed: false })),
    (error) => error.code === "review_permanent_delete_confirmation_required"
  );
  await assert.rejects(
    current.coordinator.execute(executeInput(preview, { confirmedImpactDigest: "0".repeat(64) })),
    (error) => error.code === "review_permanent_delete_confirmation_stale"
  );
  assert.equal(current.counters.prepare, 0);

  const unavailable = harness({ runtimeUnavailable: true });
  await assert.rejects(
    unavailable.coordinator.execute(executeInput(preview)),
    (error) => error.code === "review_permanent_delete_durable_store_required"
  );
  assert.equal(unavailable.counters.prepare, 0);

  const pending = harness({ pendingOrdinary: { lifecycleActionId: "restore-action", operationType: "review_restore", currentStage: "prepared" } });
  const pendingPreview = await pending.coordinator.preview({
    lifecycleActionId: "permanent-action", reviewId: "review-1", projectId: "project-1",
    exactRecycleEntryId: "entry-1", sourceDeleteActionId: "delete-action", expectedRecycleEntryRevision: 0
  });
  await assert.rejects(
    pending.coordinator.execute(executeInput(pendingPreview)),
    (error) => error.code === "review_lifecycle_pending_conflict"
  );
  assert.equal(pending.counters.prepare, 0);
});

test("Planning response loss, new coordinator instance, completed replay, and duplicate click converge exactly once", async () => {
  const current = harness({ losePlanningResponse: true });
  const preview = await current.coordinator.preview({
    lifecycleActionId: "permanent-action", reviewId: "review-1", projectId: "project-1",
    exactRecycleEntryId: "entry-1", sourceDeleteActionId: "delete-action", expectedRecycleEntryRevision: 0
  });
  const input = executeInput(preview);
  await assert.rejects(current.coordinator.execute(input), /injected_planning_response_loss/);
  assert.equal(current.stored.action.currentStage, "prepared");
  assert.equal(current.envelope.snapshot.reviews.length, 0, "Planning CAS committed before response loss");

  const restarted = module.createReviewPermanentDeleteCoordinator(current.dependencies);
  const completed = await restarted.execute(input);
  assert.equal(completed.status, "completed");
  assert.deepEqual(current.counters, { prepare: 1, planning: 1, recordPlanning: 1, finalize: 1 });
  const duplicate = await restarted.execute(input);
  assert.equal(duplicate.priorSuccess, true);
  assert.deepEqual(current.counters, { prepare: 1, planning: 1, recordPlanning: 1, finalize: 1 });
  await assert.rejects(
    restarted.execute({ ...input, projectId: "project-other" }),
    (error) => error.code === "review_permanent_delete_identity_conflict"
  );
});

test("metadata target drift after prepare blocks Planning and SQLite effects", async () => {
  const current = harness({ driftAfterPrepare: true });
  const preview = await current.coordinator.preview({
    lifecycleActionId: "permanent-action", reviewId: "review-1", projectId: "project-1",
    exactRecycleEntryId: "entry-1", sourceDeleteActionId: "delete-action", expectedRecycleEntryRevision: 0
  });
  await assert.rejects(
    current.coordinator.execute(executeInput(preview)),
    (error) => error.code === "review_permanent_delete_impact_plan_stale"
  );
  assert.deepEqual(current.counters, { prepare: 1, planning: 0, recordPlanning: 0, finalize: 0 });
  assert.equal(current.envelope.snapshot.reviews.length, 1);
});

test("SQLite commit response loss returns prior success on same-action readback without a second effect", async () => {
  const current = harness({ loseFinalizationResponse: true });
  const preview = await current.coordinator.preview({
    lifecycleActionId: "permanent-action", reviewId: "review-1", projectId: "project-1",
    exactRecycleEntryId: "entry-1", sourceDeleteActionId: "delete-action", expectedRecycleEntryRevision: 0
  });
  const input = executeInput(preview);
  await assert.rejects(current.coordinator.execute(input), /injected_sqlite_commit_response_loss/);
  assert.equal(current.stored.action.currentStage, "completed");
  const replay = await current.coordinator.execute(input);
  assert.equal(replay.priorSuccess, true);
  assert.deepEqual(current.counters, { prepare: 1, planning: 1, recordPlanning: 1, finalize: 1 });
});

test("planning_committed stage response loss resumes from durable action without another Planning CAS", async () => {
  const current = harness({ loseRecordPlanningResponse: true });
  const preview = await current.coordinator.preview({
    lifecycleActionId: "permanent-action", reviewId: "review-1", projectId: "project-1",
    exactRecycleEntryId: "entry-1", sourceDeleteActionId: "delete-action", expectedRecycleEntryRevision: 0
  });
  const input = executeInput(preview);
  await assert.rejects(current.coordinator.execute(input), /injected_planning_stage_response_loss/);
  assert.equal(current.stored.action.currentStage, "planning_committed");
  const replay = await module.createReviewPermanentDeleteCoordinator(current.dependencies).execute(input);
  assert.equal(replay.status, "completed");
  assert.deepEqual(current.counters, { prepare: 1, planning: 1, recordPlanning: 1, finalize: 1 });
});
