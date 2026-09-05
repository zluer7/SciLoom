import assert from "node:assert/strict";
import test from "node:test";
import {
  EXPERIMENT_RUN_GUARD_ERROR_CODES,
  ExperimentRunGuardError,
  createExperimentRunGuard
} from "./experimentRunGuardRules.ts";

const activeRun = {
  id: "run-a",
  experimentId: "experiment-a",
  projectId: "project-a",
  title: "Run A"
};
const activeParent = {
  id: "experiment-a",
  projectId: "project-a",
  title: "Experiment A"
};

function createStatefulGuard(initial = {}) {
  const state = {
    run: Object.hasOwn(initial, "run") ? initial.run : activeRun,
    deletedRun: initial.deletedRun,
    parent: Object.hasOwn(initial, "parent") ? initial.parent : activeParent,
    deletedParent: initial.deletedParent
  };
  return {
    state,
    guard: createExperimentRunGuard({
      loadRun: async () => state.run,
      loadDeletedRun: async () => state.deletedRun,
      loadParent: async () => state.parent,
      loadDeletedParent: async () => state.deletedParent
    })
  };
}

async function expectCode(action, code) {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof ExperimentRunGuardError);
    assert.equal(error.code, code);
    return true;
  });
}

test("active Run with active parent is writable", async () => {
  const { guard } = createStatefulGuard();
  const access = await guard.assertWritable("run-a");
  assert.equal(access.run.id, "run-a");
  assert.equal(access.parent.id, "experiment-a");
  assert.equal(access.readOnly, false);
  assert.equal(access.parentDeleted, false);
});

test("parent-deleted Run is controlled read-only with a stable error code", async () => {
  const { guard } = createStatefulGuard({
    parent: undefined,
    deletedParent: { ...activeParent, deletedAt: "2026-07-17T10:00:00Z" }
  });
  const access = await guard.getControlledAccess("run-a");
  assert.equal(access.run.id, "run-a");
  assert.equal(access.parentDeleted, true);
  assert.equal(access.readOnly, true);
  assert.equal(access.reason, EXPERIMENT_RUN_GUARD_ERROR_CODES.parentDeleted);
  await expectCode(
    () => guard.assertWritable("run-a"),
    EXPERIMENT_RUN_GUARD_ERROR_CODES.parentDeleted
  );
});

test("missing, deleted, missing-parent, and project-mismatch states remain distinct", async () => {
  const missing = createStatefulGuard({ run: undefined, parent: undefined }).guard;
  await expectCode(
    () => missing.assertWritable("run-a"),
    EXPERIMENT_RUN_GUARD_ERROR_CODES.notFound
  );

  const deleted = createStatefulGuard({
    run: undefined,
    deletedRun: { ...activeRun, deletedAt: "2026-07-17T10:00:00Z" }
  }).guard;
  await expectCode(
    () => deleted.assertWritable("run-a"),
    EXPERIMENT_RUN_GUARD_ERROR_CODES.deleted
  );

  const missingParent = createStatefulGuard({ parent: undefined }).guard;
  await expectCode(
    () => missingParent.assertWritable("run-a"),
    EXPERIMENT_RUN_GUARD_ERROR_CODES.parentNotFound
  );

  const mismatch = createStatefulGuard({
    parent: { ...activeParent, projectId: "project-b" }
  }).guard;
  await expectCode(
    () => mismatch.assertWritable("run-a"),
    EXPERIMENT_RUN_GUARD_ERROR_CODES.projectMismatch
  );
});

test("parent restore re-enables only a Run that was not independently deleted", async () => {
  const { state, guard } = createStatefulGuard({
    parent: undefined,
    deletedParent: { ...activeParent, deletedAt: "2026-07-17T10:00:00Z" }
  });
  await expectCode(
    () => guard.assertWritable("run-a"),
    EXPERIMENT_RUN_GUARD_ERROR_CODES.parentDeleted
  );

  state.parent = activeParent;
  state.deletedParent = undefined;
  assert.equal((await guard.assertWritable("run-a")).readOnly, false);

  state.run = undefined;
  state.deletedRun = { ...activeRun, deletedAt: "2026-07-17T11:00:00Z" };
  await expectCode(
    () => guard.assertWritable("run-a"),
    EXPERIMENT_RUN_GUARD_ERROR_CODES.deleted
  );
});

test("restoring Run metadata while parent remains deleted keeps it read-only", async () => {
  const { state, guard } = createStatefulGuard({
    run: undefined,
    deletedRun: { ...activeRun, deletedAt: "2026-07-17T11:00:00Z" },
    parent: undefined,
    deletedParent: { ...activeParent, deletedAt: "2026-07-17T10:00:00Z" }
  });
  await expectCode(
    () => guard.assertWritable("run-a"),
    EXPERIMENT_RUN_GUARD_ERROR_CODES.deleted
  );

  state.run = activeRun;
  state.deletedRun = undefined;
  const access = await guard.getControlledAccess("run-a");
  assert.equal(access.parentDeleted, true);
  assert.equal(access.readOnly, true);
});
