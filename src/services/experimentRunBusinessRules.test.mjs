import assert from "node:assert/strict";
import test from "node:test";
import {
  assertExperimentRunCreateIdentity,
  assertExperimentRunRelationOwnership,
  assertExperimentRunUpdateIdentity,
  resolveExperimentRunCreateRelations,
  resolveExperimentRunUpdateRelations
} from "./experimentRunBusinessRules.ts";

test("create defaults Route/Task exactly once from the parent", () => {
  assert.deepEqual(
    resolveExperimentRunCreateRelations(
      { projectId: "project-a", routeId: "route-a", taskId: "task-a" },
      {}
    ),
    { projectId: "project-a", routeId: "route-a", taskId: "task-a" }
  );
  assert.deepEqual(
    resolveExperimentRunCreateRelations(
      { projectId: "project-a", routeId: null, taskId: null },
      {}
    ),
    { projectId: "project-a", routeId: null, taskId: null }
  );
  assert.deepEqual(
    resolveExperimentRunCreateRelations(
      { projectId: "project-a", routeId: "route-a", taskId: "task-a" },
      { routeId: "route-b", taskId: "task-b" }
    ),
    { projectId: "project-a", routeId: "route-b", taskId: "task-b" }
  );
});

test("update uses only Run-owned Route/Task and supports explicit clear", () => {
  const existing = {
    projectId: "project-a",
    routeId: "run-route",
    taskId: "run-task"
  };
  assert.deepEqual(
    resolveExperimentRunUpdateRelations(
      existing,
      {},
      { projectId: "project-a", routeId: "new-parent-route", taskId: "new-parent-task" }
    ),
    { projectId: "project-a", routeId: "run-route", taskId: "run-task" }
  );
  assert.deepEqual(
    resolveExperimentRunUpdateRelations(existing, { routeId: null, taskId: null }, { projectId: "project-a" }),
    { projectId: "project-a", routeId: null, taskId: null }
  );
});

test("ordinary update rejects parent/project keys and inconsistent stored Project", () => {
  assert.throws(
    () => assertExperimentRunCreateIdentity({ experimentId: "experiment-a", projectId: "project-a" }),
    /determined by the parent/
  );
  for (const patch of [
    { experimentId: "experiment-b" },
    { experimentId: "experiment-a" },
    { projectId: "project-b" },
    { projectId: "project-a" }
  ]) {
    assert.throws(() => assertExperimentRunUpdateIdentity(patch), /cannot be changed|fixed by the parent/);
  }
  assert.throws(
    () =>
      resolveExperimentRunUpdateRelations(
        { projectId: "project-wrong", routeId: null, taskId: null },
        {},
        { projectId: "project-a" }
      ),
    /does not match/
  );
});

test("Route/Task must share the parent Project and selected Route", () => {
  assert.doesNotThrow(() =>
    assertExperimentRunRelationOwnership(
      "project-a",
      { id: "route-a", projectId: "project-a" },
      { id: "task-a", projectId: "project-a", routeNodeId: "route-a" }
    )
  );
  assert.throws(
    () =>
      assertExperimentRunRelationOwnership(
        "project-a",
        { id: "route-b", projectId: "project-b" },
        undefined
      ),
    /route must belong/
  );
  assert.throws(
    () =>
      assertExperimentRunRelationOwnership(
        "project-a",
        undefined,
        { id: "task-b", projectId: "project-b", routeNodeId: null }
      ),
    /task must belong/
  );
  assert.throws(
    () =>
      assertExperimentRunRelationOwnership(
        "project-a",
        { id: "route-a", projectId: "project-a" },
        { id: "task-a", projectId: "project-a", routeNodeId: "route-b" }
      ),
    /route conflicts/
  );
});
