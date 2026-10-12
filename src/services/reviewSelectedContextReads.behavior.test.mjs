import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

const ports = new Set(["planningService", "planningRepository", "experimentService", "experimentRunService",
  "fileRefService", "literatureService", "resultMetricService", "outputConversionService", "outputService",
  "reviewFileRefService", "entityContextService", "experimentSelectorService", "literatureSelectorService",
  "outputConversionSelectorService"]);
const bundle = await build({
  stdin: { contents: 'export * from "./reviewSelectorService"; export * from "./planningSelectorService";', resolveDir: import.meta.dirname },
  bundle: true, write: false, platform: "node", format: "esm", target: "es2022", logLevel: "silent",
  plugins: [{ name: "canonical-read-ports", setup(api) {
    api.onResolve({ filter: /^\.\// }, args => {
      const name = args.path.slice(2);
      if (ports.has(name) && /(?:reviewSelectorService|planningSelectorService)\.ts$/.test(args.importer))
        return { path: name, namespace: "read-port" };
    });
    api.onLoad({ filter: /.*/, namespace: "read-port" }, ({ path: name }) => ({ contents: name === "planningRepository"
      ? 'export const getPlanningFirstLayerData = (...args) => globalThis.__reviewRead("planningRepository.getPlanningFirstLayerData", args);'
      : `export const ${name} = new Proxy({}, {get: (_, method) => (...args) => globalThis.__reviewRead(${JSON.stringify(name)}+"."+method,args)});` }));
  } }]
});
const service = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const stamp = "2026-10-09T00:00:00.000Z";
const project = { id: "p", title: "Project", status: "active", tags: [], createdAt: stamp, updatedAt: stamp };
const review = id => ({ id, projectId: "p", title: id, reviewType: "custom", tags: [],
  outlineSections: [{key: "custom_summary", content: "Recorded summary"}], structuredRevision: 7,
  descriptorIdentity: "review/primary/custom/v1", structuredLifecycleEvidence: "review-lifecycle/v1:none",
  createdAt: stamp, updatedAt: stamp });
const summary = (entityType, entityId) => ({ entityType, entityId, title: entityId,
  sourceAvailable: true, sourceModule: "test", createdAt: stamp, updatedAt: stamp });
const missing = { targetType: "literature", targetId: "absent", reason: "target_not_found" };
function fixture({ fail, empty = false, gate, version = "fresh", projectMissing = false } = {}) {
  const calls = [];
  globalThis.__reviewRead = async (name, args) => {
    calls.push({name, args});
    if (name === fail) throw Error("CANONICAL_READ_FAILED");
    if (name === "planningService.getReviewById") return review(args[0]);
    if (name === "planningService.queryReviewTargets") {
      if (gate) await gate(args[0]);
      return empty ? [] : [{targetType: "task", targetId: `task-${args[0]}`, title: version}];
    }
    if (name === "planningRepository.getPlanningFirstLayerData") return {
      projects: [project], routeNodes: [], tasks: ["a", "b"].map(id => ({id: `task-${id}`, projectId: "p", title: version, status: "doing"}))
    };
    if (name === "planningService.getProjectById") return projectMissing ? undefined : {...project, title: version, customFields: {methodSummary: version}};
    if (name === "planningService.queryRouteNodes" || name === "planningService.queryTasks" ||
        name === "planningService.queryReviewFirstLayerIdentities" || name === "planningService.queryResearchRoutines") return [];
    if (name === "planningService.queryRoutineCheckInsByRoutines") return {};
    if (name === "entityContextService.getEntityTargetSummary") return summary(args[0], args[1]);
    if (name === "entityContextService.getEntityCrossModuleContext") return {
      outgoingLinks: [], incomingLinks: [], warnings: ["Canonical source notice"], missingReferences: [missing], partial: true
    };
    if (name === "experimentSelectorService.getExperimentsByProjectContext") return [{
      experiment: {id: "exp", projectId: "p", title: "Experiment"}, runs: [], metricsByRunId: {}, relatedFileRefs: []
    }];
    if (name === "literatureSelectorService.getProjectLiteratureContext") return {
      literatures: [{id: "lit", primaryProjectId: "p", title: "Literature"}], warnings: ["Literature notice"], missingReferences: [missing], partial: true
    };
    if (name === "outputConversionSelectorService.getOutputConversionProjectContext") return {
      findings: [{id: "finding", projectId: "p", title: "Finding"}], candidates: [{id: "candidate", projectId: "p", title: "Candidate"}]
    };
    if (name === "outputConversionService.listResultItems") return [{id: "result", projectId: "p", title: "Result"}];
    if (name === "outputConversionService.listOutputGaps") return [{id: "gap", projectId: "p", title: "Gap", status: "open"}];
    if (name === "outputService.listOutputs") return [{id: "output", projectId: "p", title: "Output"}];
    if (name === "reviewFileRefService.queryReviewFileRefPathMaterialSummaries") return [{fileRefId: `attachment-${args[0]}`, title: "Attachment"}];
    if (name === "reviewFileRefService.queryReviewFileRefs") return [{id: `attachment-${args[0]}`, ownerType: "review", ownerId: args[0], fileRole: "attachment"}];
    if (["experimentService.getExperiments", "experimentRunService.list", "literatureService.queryLiteratures",
      "resultMetricService.list", "fileRefService.list", "outputConversionService.listFindings", "outputConversionService.listOutputCandidates"].includes(name)) return [];
    throw Error(`Unexpected read/writer ${name}`);
  };
  return calls;
}
const count = (calls, name) => calls.filter(x => x.name === name).length;
function deferred() { let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve}; }

test("one selected request shares canonical targets while preserving context, attachments and default callers", async () => {
  let calls = fixture();
  const [targets, paths, files, context] = await service.loadReviewSelectedDetail("a");
  assert.equal(count(calls, "planningService.queryReviewTargets"), 1);
  assert.equal(targets[0].targetId, "task-a");
  assert.equal(context.review.structuredRevision, 7);
  assert.equal(context.directTargets.find(x => x.targetType === "task").targetId, targets[0].targetId);
  assert.equal(context.sourceBoundary, "metadata_and_structured_context_only");
  assert.equal(paths[0].fileRefId, files[0].id);
  calls = fixture();
  assert.deepEqual(await service.getReviewDetailContext("a"), context);
  assert.equal(count(calls, "planningService.queryReviewTargets"), 1);
  assert.equal(count(calls, "reviewFileRefService.queryReviewFileRefs"), 0);
});
test("successful empty targets stay empty; required target/context/attachment failures still reject", async () => {
  fixture({empty: true});
  const [targets, , , context] = await service.loadReviewSelectedDetail("a");
  assert.deepEqual(targets, []);
  assert.deepEqual(context.directTargets.map(x => [x.targetType, x.targetId]), [["project", "p"]]);
  for (const fail of ["planningService.queryReviewTargets", "planningService.getReviewById",
    "planningRepository.getPlanningFirstLayerData", "experimentService.getExperiments",
    "reviewFileRefService.queryReviewFileRefs", "reviewFileRefService.queryReviewFileRefPathMaterialSummaries"]) {
    fixture({fail}); await assert.rejects(service.loadReviewSelectedDetail("a"), /CANONICAL_READ_FAILED/);
  }
});
test("overlapping owners and refresh never reuse another request's targets or stale facts", async () => {
  const delayed = deferred(), calls = fixture({gate: id => id === "a" ? delayed.promise : Promise.resolve()});
  const a = service.loadReviewSelectedDetail("a");
  const b = await service.loadReviewSelectedDetail("b");
  assert.equal(b[3].review.id, "b"); assert.equal(b[0][0].targetId, "task-b");
  delayed.resolve(); const old = await a;
  assert.equal(old[3].review.id, "a"); assert.equal(old[0][0].targetId, "task-a");
  assert.equal(count(calls, "planningService.queryReviewTargets"), 2);
  fixture({version: "refreshed"}); const fresh = await service.loadReviewSelectedDetail("a");
  assert.equal(fresh[0][0].title, "refreshed"); assert.equal(fresh[3].directTargets.find(x => x.targetType === "task").title, "refreshed");
});
test("Review aggregation reads one Project detail and retains all evidence, warnings, missing references and Routine reads", async () => {
  const calls = fixture(); const context = await service.getReviewAggregationContext("a");
  assert.equal(count(calls, "experimentSelectorService.getExperimentsByProjectContext"), 1);
  assert.equal(count(calls, "literatureSelectorService.getProjectLiteratureContext"), 1);
  assert.equal(count(calls, "outputConversionSelectorService.getOutputConversionProjectContext"), 1);
  assert.equal(count(calls, "planningService.queryResearchRoutines"), 1);
  assert.equal(count(calls, "planningService.queryRoutineCheckInsByRoutines"), 1);
  for (const key of ["experiments", "literatures", "resultItems", "findings", "outputCandidates", "outputGaps", "outputs"])
    assert.equal(context[key].length, 1, key);
  assert.ok(context.warnings.includes("Canonical source notice"));
  assert.ok(context.warnings.includes("Literature notice"));
  assert.ok(context.missingReferences.some(x => x.targetId === "absent"));
  assert.equal(context.partial, true);
  assert.equal(context.evidenceContext.boundary.excludesLocalFileBodies, true);
});
test("standalone Project caller remains fresh and failures in either shared detail or Routine propagate", async () => {
  for (const fail of ["planningService.getProjectById", "experimentSelectorService.getExperimentsByProjectContext",
    "literatureSelectorService.getProjectLiteratureContext", "planningService.queryResearchRoutines", "planningService.queryRoutineCheckInsByRoutines"]) {
    fixture({fail}); await assert.rejects(service.getReviewAggregationContext("a"), /CANONICAL_READ_FAILED/);
  }
  fixture({version: "first"}); const first = await service.getProjectResearchContext("p");
  fixture({version: "second"}); const second = await service.getProjectResearchContext("p");
  assert.notDeepEqual(first.projectFieldContract, second.projectFieldContract);
  fixture({projectMissing: true}); assert.equal(await service.getProjectResearchContext("p"), null);
});
