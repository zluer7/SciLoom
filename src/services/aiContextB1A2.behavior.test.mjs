import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..", "..");
const bundle = await build({
  stdin: {
    contents: `
      export * from "./services/aiContextBuilderService.ts";
      export * from "./services/aiResearchObjectService.ts";
      export * from "./services/taskAIResearchObjectAdapter.ts";
    `,
    resolveDir: resolve(root, "src"),
    sourcefile: "lp13-b1-a2-context-harness.ts"
  },
  plugins: [{
    name: "canonical-planning-owner-stubs",
    setup(api) {
      api.onResolve({ filter: /planningService$/u }, () => ({ path: "planning-service", namespace: "stub" }));
      api.onLoad({ filter: /^planning-service$/u, namespace: "stub" }, () => ({
        contents: `
          export async function getProjectById(id){
            const project = globalThis.__lp13A2.projectContext?.project;
            return project?.entityId === id ? project : undefined;
          }
          export const planningService = {
            getProjectById,
            async getTaskById(id){ return globalThis.__lp13A2.tasks.get(id); },
            async queryTasks({ projectId } = {}){
              return [...globalThis.__lp13A2.tasks.values()].filter((task) => !projectId || task.projectId === projectId);
            }
          };
        `
      }));
      api.onResolve({ filter: /planningSelectorService$/u }, () => ({ path: "planning-selector", namespace: "stub" }));
      api.onLoad({ filter: /^planning-selector$/u, namespace: "stub" }, () => ({
        contents: `
          export const planningSelectorService = {
            async getProjectResearchContext(projectId){
              globalThis.__lp13A2.projectReads += 1;
              return globalThis.__lp13A2.projectContext?.project.entityId === projectId
                ? globalThis.__lp13A2.projectContext
                : null;
            },
            async getTaskExecutionContext(taskId){
              globalThis.__lp13A2.taskContextReads += 1;
              return globalThis.__lp13A2.taskContexts.get(taskId) ?? null;
            }
          };
        `
      }));
      api.onResolve({ filter: /experimentService$/u }, () => ({ path: "experiment-service", namespace: "stub" }));
      api.onLoad({ filter: /^experiment-service$/u, namespace: "stub" }, () => ({
        contents: `export function toNullableString(value){
          return typeof value === "string" && value.trim() ? value.trim() : undefined;
        }
        export const experimentService = {
          async getExperimentById(){ return undefined; },
          async getExperimentsByProject(){ return []; }
        };`
      }));
      api.onResolve({ filter: /experimentSelectorService$/u }, () => ({ path: "experiment-selector", namespace: "stub" }));
      api.onLoad({ filter: /^experiment-selector$/u, namespace: "stub" }, () => ({
        contents: `export async function getExperimentDetailContext(){ return null; }
          export const experimentSelectorService = { getExperimentDetailContext };`
      }));
      api.onResolve({ filter: /experimentRunAIResearchObjectAdapter$/u }, () => ({ path: "experiment-run-adapter", namespace: "stub" }));
      api.onLoad({ filter: /^experiment-run-adapter$/u, namespace: "stub" }, () => ({
        contents: `
          export async function listExperimentRunResearchObjectDescriptors(){ return []; }
          export async function resolveExperimentRunResearchObjectDescriptor(){ throw new Error("ExperimentRun is outside the A2 fixture"); }
          export async function buildExperimentRunResearchObjectContextCandidates(){ throw new Error("ExperimentRun is outside the A2 fixture"); }
        `
      }));
      api.onResolve({ filter: /literatureAIResearchObjectAdapter$/u }, () => ({ path: "literature-adapter", namespace: "stub" }));
      api.onLoad({ filter: /^literature-adapter$/u, namespace: "stub" }, () => ({
        contents: `
          export async function listLiteratureResearchObjectDescriptors(){ return []; }
          export async function resolveLiteratureResearchObjectDescriptor(){ throw new Error("Literature is outside the A2 fixture"); }
          export async function resolveLiteratureObjectiveOutlineResearchObjectDescriptor(){ throw new Error("Literature objective outline is outside the A2 fixture"); }
          export function buildLiteratureResearchObjectContextCandidates(){ throw new Error("Literature is outside the A2 fixture"); }
          export function finalizeLiteraturePromptVisibleProjectionFingerprints(sections){ return sections; }
        `
      }));
      api.onResolve({ filter: /findingAIResearchObjectAdapter$/u }, () => ({ path: "finding-adapter", namespace: "stub" }));
      api.onLoad({ filter: /^finding-adapter$/u, namespace: "stub" }, () => ({
        contents: `
          export async function listFindingResearchObjectDescriptors(){ return []; }
          export async function resolveFindingResearchObjectDescriptor(){ throw new Error("Finding is outside the A2 fixture"); }
          export async function buildFindingResearchObjectContextCandidates(){ throw new Error("Finding is outside the A2 fixture"); }
        `
      }));
    }
  }],
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

function entity(entityId, title, status = "active", subtitle = `${title} summary`) {
  return {
    entityId, entityType: entityId.startsWith("task") ? "task" : "project",
    title, subtitle, status, sourceAvailable: true,
    createdAt: "2026-08-14T10:00:00.000Z", updatedAt: "2026-08-14T11:00:00.000Z"
  };
}

function evidence(evidenceId, title, contentSummary = `${title} evidence`, relationType = "related_output_gap") {
  return {
    evidenceId, title, contentSummary, relationType,
    source: { ...entity(evidenceId, title, "pending"), entityType: "outputGap" }
  };
}

function fixture() {
  const project = entity("project-1", "Project One", "active", "Project summary");
  project.entityType = "project";
  const taskOne = {
    id: "task-1", projectId: "project-1", routeNodeId: "route-1",
    title: "Task One", description: "Task one description", status: "doing", priority: "high",
    updatedAt: "2026-08-14T11:00:00.000Z"
  };
  const taskTwo = {
    id: "task-2", projectId: "project-1", title: "Task Two",
    description: "Task two description", status: "todo", priority: "medium",
    updatedAt: "2026-08-14T11:00:00.000Z"
  };
  const route = entity("route-1", "Route One", "active", "Route summary");
  route.entityType = "routeNode";
  const taskOneSummary = entity("task-1", "Task One", "doing", "Task one description");
  const taskTwoSummary = entity("task-2", "Task Two", "todo", "Task two description");
  const projectContext = {
    project,
    projectFieldContract: { methodSummary: "Bounded method", expectedOutputs: "Bounded output" },
    routeNodes: [route], tasks: [taskOneSummary, taskTwoSummary], reviews: [],
    experiments: [], experimentRuns: [], literatures: [], resultItems: [], findings: [],
    outputCandidates: [], outputGaps: [evidence("gap-1", "Gap One")], outputs: [],
    taskStats: { total: 2, completed: 0, archived: 0, unscheduled: 0, blocked: 0, delayed: 0, open: 2 },
    researchProgressSummary: {
      completedTaskCount: 0, experimentEvidenceCount: 0, literatureEvidenceCount: 0,
      findingCount: 0, outputCandidateCount: 0, unresolvedOutputGapCount: 1,
      partiallyResolvedOutputGapCount: 0, resolvedOutputGapCount: 0
    },
    linkedEntities: [], warnings: [], missingReferences: [], partial: false,
    level4RelationIndex: [{
      objectType: "experiment", canonicalId: "experiment-l4", projectId: "project-1",
      safeLabel: "Level-4 Experiment", safeSummary: "Bounded Level-4 experiment content",
      status: "completed", relationKeys: [], membershipSource: "direct_project_id",
      relationSource: "none"
    }],
    level4RelationIndexExclusions: []
  };
  const taskContext = (taskSummary, routeNode = null) => ({
    task: taskSummary, project, routeNode,
    experiments: [], experimentRuns: [], resultMetrics: [], fileRefs: [], literatures: [],
    resultItems: [], findings: [], outputCandidates: [], outputGaps: [evidence("gap-1", "Gap One")],
    outputs: [], sourceOutputGaps: [], partiallyResolvedOutputGaps: [], resolvedOutputGaps: [],
    linkedEntities: [{ relationType: "cycle_to_task", sourceId: taskSummary.entityId, targetId: taskSummary.entityId }],
    warnings: [], missingReferences: [], partial: false
  });
  const runtime = {
    projectReads: 0,
    taskContextReads: 0,
    tasks: new Map([[taskOne.id, taskOne], [taskTwo.id, taskTwo]]),
    projectContext,
    taskContexts: new Map([
      [taskOne.id, taskContext(taskOneSummary, route)],
      [taskTwo.id, taskContext(taskTwoSummary)]
    ])
  };
  globalThis.__lp13A2 = runtime;
  return runtime;
}

function options(mode, taskIds = ["task-1"], extra = {}) {
  return {
    scopeType: "project", scopeId: "project-1", contextMode: mode,
    researchObjects: taskIds.map((objectId) => ({ objectType: "task", objectId })),
    budget: {
      maxChars: 4_000, reservedForUserQuestion: 0, reservedForSystemInstruction: 0,
      maxItemChars: 500, strategy: "priorityFirst"
    },
    ...extra
  };
}

test("four exact Context modes share one builder and enforce the cumulative level matrix", async () => {
  fixture();
  const minimal = await subject.buildAIContext(options("MINIMAL"));
  const brief = await subject.buildAIContext(options("BRIEF"));
  const standard = await subject.buildAIContext(options("STANDARD"));
  const detailed = await subject.buildAIContext(options("DETAILED"));

  assert.deepEqual(subject.AI_CONTEXT_MODE_VALUES, [
    "MINIMAL", "BRIEF", "STANDARD", "DETAILED"
  ]);
  assert.deepEqual(minimal.sections.map(({ id }) => id), ["project", "primary-tasks"]);
  assert.equal(brief.sections.some(({ id }) => id === "project-profile"), true);
  assert.equal(brief.sections.some(({ id }) => id === "task-relations"), true);
  assert.equal(minimal.excluded.some(({ label }) => /bounded Task payload excluded/u.test(label ?? "")), true);
  assert.equal(standard.sections.some(({ id }) => id === "task-relations"), true);
  assert.equal(standard.sections.flatMap(({ items }) => items).some(({ contextLevel }) => contextLevel === 3), true);
  assert.equal(standard.sections.flatMap(({ items }) => items).some(({ contextLevel }) => contextLevel === 4), false);
  assert.equal(detailed.sections.flatMap(({ items }) => items).some(({ contextLevel }) => contextLevel === 4), true);
  assert.equal(detailed.level4Snapshot.includedItems.some(({ canonicalId }) => canonicalId === "experiment-l4"), true);
  const standardItemsById = new Map(standard.sections
    .flatMap(({ items }) => items)
    .map((item) => [item.id, item]));
  for (const inherited of brief.sections.flatMap(({ items }) => items)) {
    const preserved = standardItemsById.get(inherited.id);
    assert.ok(preserved, `STANDARD must retain BRIEF item ${inherited.id}`);
    assert.equal(preserved.contextLevel, inherited.contextLevel, `${inherited.id} must keep its canonical level`);
  }
  assert.equal(
    brief.sections.some(({ id }) => ["routes", "tasks", "reviews", "output-gaps"].includes(id)),
    false,
    "BRIEF must not relabel broad Project background as Level 2"
  );
  assert.equal(subject.normalizeAIContextMode("LIGHT"), "BRIEF");
  assert.equal(subject.normalizeAIContextMode("STANDARD_CONTEXT"), "STANDARD");
  for (const packageValue of [minimal, brief, standard, detailed]) {
    assert.equal(packageValue.contextMode, packageValue.sourceRefs[0].contextMode);
    assert.equal(packageValue.budgetSummary.maxChars, 4_000);
    assert.equal(packageValue.researchObjects.length, 1);
    assert.ok(packageValue.reviewFingerprint.startsWith("lp13-a2-"));
  }
});

test("zero Task is an explicit visible Project-only disposition and ordinary wrapper remains canonical", async () => {
  fixture();
  const projectOnly = await subject.buildAIContext(options("STANDARD", []));
  const wrapper = await subject.buildProjectAIContext("project-1", { budget: options("STANDARD", []).budget });
  assert.deepEqual(projectOnly.researchObjects, []);
  assert.equal(projectOnly.scope.id, "project-1");
  assert.equal(projectOnly.sections.some(({ id }) => id === "primary-tasks"), false);
  assert.equal(wrapper.contextMode, "STANDARD");
  assert.equal(wrapper.version, projectOnly.version);
});

test("Task selection preserves user order, deduplicates deterministically, and fails closed across Project scope", async () => {
  const runtime = fixture();
  const selected = await subject.buildAIContext(options("STANDARD", ["task-2", "task-1", "task-2"]));
  assert.deepEqual(selected.researchObjects.map(({ objectId }) => objectId), ["task-2", "task-1"]);
  assert.match(selected.warnings.find(({ code }) => code === "duplicate_research_object_deduplicated").message, /task-2/u);
  assert.deepEqual(
    selected.sections.find(({ id }) => id === "primary-tasks").items.map(({ sourceRefs }) => sourceRefs[0].entityId),
    ["task-2", "task-1"]
  );
  runtime.tasks.set("task-cross", { ...runtime.tasks.get("task-1"), id: "task-cross", projectId: "project-2" });
  await assert.rejects(
    subject.buildAIContext(options("STANDARD", ["task-cross"])),
    (error) => error.code === "TASK_PROJECT_MISMATCH"
  );
  await assert.rejects(
    subject.buildAIContext(options("STANDARD", ["missing-task"])),
    (error) => error.code === "TASK_NOT_FOUND"
  );
  await assert.rejects(
    subject.resolveAIResearchObjects("project-1", Array.from({ length: 6 }, (_, index) => ({ objectType: "task", objectId: `task-${index}` }))),
    (error) => error.code === "SELECTION_LIMIT_EXCEEDED"
  );
  const duplicateHeavy = await subject.resolveAIResearchObjects(
    "project-1",
    Array.from({ length: 6 }, () => ({ objectType: "task", objectId: "task-1" }))
  );
  assert.deepEqual(duplicateHeavy.descriptors.map(({ objectId }) => objectId), ["task-1"]);
  assert.equal(duplicateHeavy.duplicateObjectIds.length, 5);
  runtime.tasks.get("task-1").status = "archived";
  await assert.rejects(
    subject.buildAIContext(options("STANDARD", ["task-1"])),
    (error) => error.code === "TASK_UNAVAILABLE"
  );
});

test("unknown Task relation kinds are excluded with a visible deterministic reason", async () => {
  const runtime = fixture();
  runtime.taskContexts.get("task-1").outputGaps.push(
    evidence("gap-unknown", "Unknown Gap", "Unknown relation evidence", "unknown_cycle_edge")
  );
  const packageValue = await subject.buildAIContext(options("STANDARD"));
  assert.equal(packageValue.sections.flatMap(({ items }) => items).some(({ id }) => id.includes("gap-unknown")), false);
  assert.equal(packageValue.excluded.some(({ entityId, reason }) => (
    entityId === "gap-unknown" && reason === "unsupported"
  )), true);
  assert.equal(packageValue.warnings.some(({ message }) => /unknown_cycle_edge.*excluded/u.test(message)), true);
  assert.equal(subject.isRecognizedTaskRelationType("needs_followup_task"), true);
  assert.equal(subject.isRecognizedTaskRelationType("unknown_cycle_edge"), false);
});

test("budget protects Level 1 and degrades 4 then 3 then 2 without relation traversal", async () => {
  const runtime = fixture();
  runtime.projectContext.routeNodes = Array.from({ length: 8 }, (_, index) => ({
    ...entity(`route-${index + 2}`, `Route ${index + 2}`, "active", "x".repeat(220)),
    entityType: "routeNode"
  }));
  const budgeted = await subject.buildAIContext(options("DETAILED", ["task-1"], {
    budget: { maxChars: 240, reservedForUserQuestion: 0, reservedForSystemInstruction: 0, maxItemChars: 120, strategy: "priorityFirst" }
  }));
  const levelOne = budgeted.sections.flatMap(({ items }) => items).filter(({ contextLevel }) => contextLevel === 1);
  assert.equal(budgeted.contextMode, "DETAILED");
  assert.equal(budgeted.budgetSummary.maxChars, 240);
  assert.equal(levelOne.length, 2);
  assert.ok(levelOne.every(({ protectedFromContextBudget }) => protectedFromContextBudget));
  assert.equal(budgeted.warnings.some(({ code }) => code === "budget_degraded"), true);
  assert.equal(runtime.taskContextReads, 1);
  await assert.rejects(
    subject.buildAIContext(options("DETAILED", ["task-1"], {
      budget: { maxChars: 10, reservedForUserQuestion: 0, reservedForSystemInstruction: 0, maxItemChars: 120, strategy: "priorityFirst" }
    })),
    (error) => error instanceof subject.AIContextProtectedBudgetError
  );
});

test("FileRef decisions are orthogonal, pending authorization is visible, and invalid selection blocks", async () => {
  fixture();
  const packageValue = await subject.buildAIContext(options("STANDARD", ["task-1"], {
    selectedMaterials: [{
      fileRefId: "file-1", displayName: "notes.md",
      availabilityStatus: "available", materialReadStatus: "supported",
      materialPromptReservationCharacters: 1_000,
      materialFreshnessReceipt: {
        fileRefId: "file-1",
        receiptVersion: "material-source-v1",
        sourceToken: "4".repeat(64)
      }
    }]
  }));
  assert.deepEqual(packageValue.materialDecisions.map(({ authorizationStatus }) => authorizationStatus), [
    "pending_per_call_authorization"
  ]);
  assert.equal(packageValue.sourceRefs.some(({ contextRole }) => contextRole === "explicitMaterial"), true);
  const invalid = await subject.buildAIContext(options("STANDARD", ["task-1"], {
    selectedMaterials: [{
      fileRefId: "file-2", displayName: "raw.bin",
      availabilityStatus: "available", materialReadStatus: "unsupported_type",
      materialPromptReservationCharacters: 0
    }]
  }));
  assert.equal(invalid.warnings.some(({ code, severity }) => code === "material_selection_not_authorizable" && severity === "error"), true);
  const filteredPrimary = await subject.buildAIContext(options("STANDARD", ["task-1"], {
    excludeModules: ["task"]
  }));
  assert.equal(filteredPrimary.warnings.some(({ code, severity }) => (
    code === "protected_source_excluded_by_build_options" && severity === "error"
  )), true);
});

test("review fingerprint is deterministic, changes with canonical facts, and sensitive paths are redacted", async () => {
  const runtime = fixture();
  runtime.taskContexts.get("task-1").task.subtitle = "Read C:\\private\\secret.txt before analysis";
  const first = await subject.buildAIContext(options("STANDARD"));
  const second = await subject.buildAIContext(options("STANDARD"));
  assert.equal(first.reviewFingerprint, second.reviewFingerprint);
  assert.doesNotMatch(JSON.stringify(first.sections), /C:\\\\private/u);
  assert.doesNotMatch(JSON.stringify(first.sourceRefs), /C:\\\\private/u);
  assert.match(JSON.stringify(first.sections), /sensitive value omitted/u);
  runtime.taskContexts.get("task-1").task.title = "Task One changed";
  runtime.tasks.get("task-1").title = "Task One changed";
  const changed = await subject.buildAIContext(options("STANDARD"));
  assert.notEqual(changed.reviewFingerprint, first.reviewFingerprint);
});
