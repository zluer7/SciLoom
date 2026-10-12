import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

const bundle = await build({
  stdin: { contents: 'export * from "./planningPageAdapterService";', resolveDir: import.meta.dirname, loader: "ts" },
  bundle: true, write: false, format: "esm", platform: "node", target: "es2022", logLevel: "silent",
  plugins: [{ name: "canonical-boundaries", setup(api) {
    api.onResolve({ filter: /^\.\/.*Service$/ }, args => args.importer.endsWith("planningPageAdapterService.ts")
      ? { path: args.path.slice(2), namespace: "fixture" } : undefined);
    api.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents:
      `export const ${args.path}=new Proxy({}, {get:(_,name)=>(...args)=>globalThis.__b18PageRead(${JSON.stringify(args.path)}+"."+name,args)});` }));
  } }]
});
const service = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
function fixture({ fail, title = "Fresh task" } = {}) {
  const calls = [];
  globalThis.__b18PageRead = async (name, args) => {
    calls.push({ name, args });
    if (name === fail) throw Error("CURRENT_READ_FAILED");
    if (name === "planningService.queryProjects") return [{ id: "p", title: "Project", status: "active", priority: "medium" }];
    if (name === "planningService.queryRouteNodes") return [{ id: "r", projectId: "p", title: "Route", status: "active", nodeType: "work", orderIndex: 0 }];
    if (name === "planningService.queryTasks") return [
      { id: "t", projectId: "p", routeNodeId: "r", title, status: "doing", priority: "medium", taskType: "task", dueDate: "2026-10-10" },
      { id: "archived", projectId: "p", title: "Archived", status: "archived" }
    ];
    if (name === "planningSelectorService.getProjectRoutineSummary") return { projectId: args[0], summaries: [{ routineId: "routine", title: "Current routine", isCompleted: true }] };
    if (name === "outputGapFeedbackSelectorService.getTaskOutputGapFeedbackSummary") return { outputGaps: [{ outputGapId: "gap", title: "Current gap", status: "open" }] };
    throw Error(`Unexpected boundary ${name}`);
  };
  return calls;
}
test("board opt-out skips unused gap hydration while retaining current facts, Routine summary and archived exclusion", async () => {
  const calls = fixture({ fail: "outputGapFeedbackSelectorService.getTaskOutputGapFeedbackSummary" });
  const model = await service.getPlanningTasksPageModel({ includeOutputGapSummaries: false });
  assert.deepEqual(model.tasks.map(x => [x.id, x.title, x.planningStatus, x.projectId, x.routeNodeId]), [["t", "Fresh task", "doing", "p", "r"]]);
  assert.deepEqual(model.outputGapSummariesByTaskId, {});
  assert.equal(model.projectRoutineSummariesByProjectId.p.summaries[0].isCompleted, true);
  assert.equal(calls.some(x => x.name.includes("OutputGap")), false);
  assert.deepEqual(calls.map(x => x.name).sort(), ["planningService.queryProjects", "planningService.queryRouteNodes", "planningService.queryTasks", "planningSelectorService.getProjectRoutineSummary"].sort());
});
test("default and explicit full model retain the existing gap contract and failures", async () => {
  for (const options of [undefined, { includeOutputGapSummaries: true }]) {
    fixture();
    const model = await service.getPlanningTasksPageModel(options);
    assert.equal(model.outputGapSummariesByTaskId.t[0].outputGapId, "gap");
    fixture({ fail: "outputGapFeedbackSelectorService.getTaskOutputGapFeedbackSummary" });
    await assert.rejects(service.getPlanningTasksPageModel(options), /CURRENT_READ_FAILED/);
  }
});
test("board reads remain fresh on each call and still reject required data or Routine failures", async () => {
  fixture({ title: "Before edit" });
  assert.equal((await service.getPlanningTasksPageModel({ includeOutputGapSummaries: false })).tasks[0].title, "Before edit");
  fixture({ title: "After edit" });
  assert.equal((await service.getPlanningTasksPageModel({ includeOutputGapSummaries: false })).tasks[0].title, "After edit");
  for (const fail of ["planningService.queryProjects", "planningService.queryRouteNodes", "planningService.queryTasks", "planningSelectorService.getProjectRoutineSummary"]) {
    fixture({ fail });
    await assert.rejects(service.getPlanningTasksPageModel({ includeOutputGapSummaries: false }), /CURRENT_READ_FAILED/);
  }
});
