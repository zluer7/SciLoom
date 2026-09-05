import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..", "..");
const bundle = await build({
  stdin: {
    contents: `
      export * from "./services/aiStandardOperationDraftService.ts";
      export * from "./services/aiTaskStandardResultAdapter.ts";
    `,
    resolveDir: resolve(root, "src"),
    sourcefile: "lp14-a1-f9-task-route-relation-harness.ts"
  },
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  target: "es2022"
});
const harness = { exports: {} };
new Function("require", "module", "exports", bundle.outputFiles[0].text)(
  createRequire(import.meta.url), harness, harness.exports
);
const subject = harness.exports;

const projectId = "project-f9";
const routeNodeId = "route-f9";
const target = { module: "task", entityType: "task", projectId };

function task(id, input) {
  return {
    id,
    projectId,
    title: input.title,
    description: input.description,
    routeNodeId: input.routeNodeId,
    priority: input.priority,
    status: input.status,
    taskType: input.taskType,
    timeBucket: input.timeBucket,
    scheduledDate: input.scheduledDate,
    dueDate: input.dueDate,
    timeLabel: input.timeLabel,
    acceptanceCriteria: input.acceptanceCriteria,
    blockedReason: input.blockedReason,
    tags: input.tags ?? [],
    captureState: input.captureState ?? "pending",
    orderIndex: input.orderIndex ?? 0,
    source: "ai",
    schemaVersion: 1,
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z"
  };
}

test("F9 maps the proven Provider routeId alias to canonical Task.routeNodeId without a description sink", () => {
  const read = subject.readAIStandardOperationProposalPayload({
    action: "CREATE",
    target,
    payload: {
      title: "F9 route relation",
      description: "bounded Task CREATE",
      routeId: routeNodeId,
      priority: "medium",
      status: "todo"
    }
  });

  assert.equal(read.payload.routeNodeId, routeNodeId);
  assert.equal("routeId" in read.payload, false);
  assert.equal(read.payload.description, "bounded Task CREATE");
  assert.deepEqual(read.unknownSafeSections, []);
});

test("F9 preserves exact routeNodeId through validation, canonical service input, and receipt readback", async () => {
  let serviceInput;
  let created;
  const services = {
    async getProjectById(id) {
      return id === projectId ? { id, status: "active" } : undefined;
    },
    async getRouteNodeById(id) {
      return id === routeNodeId ? { id, projectId, status: "active" } : undefined;
    },
    async getTaskById(id) {
      return created?.id === id ? created : undefined;
    },
    async createTask(input) {
      serviceInput = structuredClone(input);
      created = task("task-f9", input);
      return created;
    },
    async updateTask() {
      throw new Error("UPDATE is not part of this F9 CREATE test.");
    }
  };
  const providerRead = subject.readAIStandardOperationProposalPayload({
    action: "CREATE",
    target,
    payload: {
      title: "F9 route relation",
      description: "bounded Task CREATE",
      routeId: routeNodeId,
      priority: "medium",
      status: "todo"
    }
  });
  const validation = await subject.validateAITaskStandardResultProposal({
    action: "CREATE",
    target,
    payload: providerRead.payload,
    expectedProjectId: projectId,
    services
  });

  assert.equal(validation.executable, true);
  assert.deepEqual(validation.validationIssues, []);
  assert.equal(validation.normalizedPayload.routeNodeId, routeNodeId);

  const receipt = await subject.invokeAITaskStandardResultEffect({
    action: "CREATE",
    target,
    normalizedPayload: validation.normalizedPayload,
    services
  });
  assert.equal(serviceInput.routeNodeId, routeNodeId);
  assert.equal(receipt.canonicalReadback.routeNodeId, routeNodeId);
  assert.equal(receipt.entityId, "task-f9");
});

test("F9 keeps wrong-Project route identities fail-closed", async () => {
  const validation = await subject.validateAITaskStandardResultProposal({
    action: "CREATE",
    target,
    payload: {
      title: "F9 wrong route",
      routeNodeId,
      priority: "medium",
      status: "todo",
      taskType: "other",
      timeBucket: "none"
    },
    expectedProjectId: projectId,
    services: {
      async getProjectById() { return { id: projectId, status: "active" }; },
      async getRouteNodeById() { return { id: routeNodeId, projectId: "project-other" }; },
      async getTaskById() { return undefined; },
      async createTask() { throw new Error("must not execute"); },
      async updateTask() { throw new Error("must not execute"); }
    }
  });

  assert.equal(validation.executable, false);
  assert.equal(validation.validationIssues.some((issue) =>
    issue.code === "TASK_ROUTE_SCOPE_MISMATCH" && issue.field === "routeNodeId"), true);
});
