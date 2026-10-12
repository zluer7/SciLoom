import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const directory = path.dirname(fileURLToPath(import.meta.url));
const serviceNames = [
  "entityLinkService", "experimentRunService", "experimentService", "literatureService",
  "outputConversionRelationService", "outputConversionService", "outputService", "planningService"
];
const bundle = await build({
  stdin: {
    contents: `export * from "./projectExportV1Service.ts";
      export { fromSQLiteRecord, toSQLiteRecord } from "../repositories/sqliteRepository.ts";`,
    resolveDir: directory,
    sourcefile: "project-export-v1-behavior-harness.ts"
  },
  plugins: [{
    name: "project-export-v1-production-port-stubs",
    setup(api) {
      for (const serviceName of serviceNames) {
        api.onResolve({ filter: new RegExp(`^\\./${serviceName}$`, "u") }, () => ({
          path: serviceName,
          namespace: "export-v1-port"
        }));
        api.onLoad({ filter: /.*/, namespace: "export-v1-port" }, (args) => ({
          loader: "js",
          contents: `export const ${args.path} = {};`
        }));
      }
      api.onResolve({ filter: /^\.\/exportService$/u }, () => ({
        path: "exportService",
        namespace: "export-v1-save"
      }));
      api.onLoad({ filter: /.*/, namespace: "export-v1-save" }, () => ({
        loader: "js",
        contents: `
          export function sanitizeFileName(value) { return value.replace(/[\\\\/:*?"<>|]+/g, "-"); }
          export async function saveTextFile() { throw new Error("production save port not injected"); }
        `
      }));
    }
  }],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  target: "es2022"
});
const subject = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

test("persisted ResearchOutput SQLite flags remain booleans in a valid Project exchange document", async () => {
  for (const stored of [0, 1]) {
    const data = canonicalFixture();
    const row = { id: "sqlite-output", project_id: data.project.id, output_name: "Persisted output Ω", output_type: "report", status: "draft", structured_summary: "[]", usable_for_paper: stored };
    const before = JSON.stringify(row);
    const output = subject.fromSQLiteRecord("outputs", row);
    data.outputs = [output];
    const prepared = await subject.prepareProjectExportV1(data.project.id, dependencies(data));
    assert.equal(typeof output.usableForPaper, "boolean");
    assert.equal(prepared.document.objects.researchOutputs[0].usableForPaper, Boolean(stored));
    assert.equal(prepared.importPreflight.ok, true);
    assert.equal(subject.toSQLiteRecord("outputs", output).usable_for_paper, stored);
    assert.equal(JSON.stringify(row), before);
  }
});

function canonicalFixture() {
  const project = {
    id: "project-source", title: "源项目 / round-trip", objective: "保留 **Markdown** 与 Unicode → Ω",
    status: "active", priority: "high", tags: ["往返"]
  };
  const routes = [
    { id: "route-1", projectId: project.id, title: "Route", nodeType: "analysis" },
    { id: "route-2", projectId: project.id, parentNodeId: "route-1", title: "Child route", nodeType: "experiment" }
  ];
  const tasks = [{ id: "task-1", projectId: project.id, routeNodeId: "route-2", title: "Task", taskType: "experiment" }];
  const experiments = [{
    id: "experiment-1", projectId: project.id, title: "Experiment", purposeAndQuestion: "Question",
    resultSummary: "", status: "planned"
  }];
  const runs = [{
    id: "run-1", projectId: project.id, experimentId: "experiment-1", title: "Run",
    conditionSummary: "Condition", status: "planned"
  }];
  const literature = [{
    id: "literature-1", primaryProjectId: project.id, title: "Paper", authors: [{ name: "Researcher" }],
    publicationType: "journal_article", readingStatus: "unread", localFilePath: "C:\\private\\paper.pdf"
  }];
  const reviews = [{
    id: "review-1", projectId: project.id, title: "Review", reviewType: "stage",
    outlineSections: [{ key: "stage_summary", content: "Structured state" }], tags: []
  }];
  const resultItems = [
    {
      id: "result-1", projectId: project.id, title: "Result", resultType: "metric",
      sourceType: "experiment", sourceId: "experiment-1", experimentId: "experiment-1",
      structuredSummary: [{ key: "keyPhenomenon", value: "Stable" }], value: 0.91, unit: "score"
    },
    {
      id: "result-unsupported", projectId: project.id, title: "Unsupported source", resultType: "metric",
      sourceType: "task", sourceId: "task-1", structuredSummary: []
    },
    {
      id: "result-structured", projectId: project.id, title: "Structured value", resultType: "metric",
      sourceType: "experiment", sourceId: "experiment-1", structuredSummary: [], value: { private: true }
    }
  ];
  const findings = [{
    id: "finding-1", projectId: project.id, title: "Finding", summary: "Summary",
    structuredSummary: [{ key: "supportingEvidence", value: "Result" }]
  }];
  const candidates = [{
    id: "candidate-1", projectId: project.id, title: "Candidate", candidateType: "paper",
    structuredSummary: [{ key: "innovationContribution", value: "Contribution" }]
  }];
  const gaps = [
    { id: "gap-1", projectId: project.id, title: "Gap", gapType: "validation", structuredSummary: [] },
    { id: "gap-unsupported", projectId: project.id, title: "Detached gap", gapType: "validation", structuredSummary: [] }
  ];
  const outputs = [{
    id: "output-1", projectId: project.id, outputName: "Formal output", outputType: "report",
    experimentId: "experiment-1", structuredSummary: [{ key: "coreContribution", value: "Core" }]
  }];
  const links = [
    { id: "target-1", sourceType: "review", sourceId: "review-1", targetType: "routeNode", targetId: "route-1", relationType: "summarizes" },
    { id: "target-2", sourceType: "review", sourceId: "review-1", targetType: "task", targetId: "task-1", relationType: "summarizes" },
    { id: "target-3", sourceType: "review", sourceId: "review-1", targetType: "experiment", targetId: "experiment-1", relationType: "summarizes" },
    { id: "target-4", sourceType: "review", sourceId: "review-1", targetType: "experimentRun", targetId: "run-1", relationType: "summarizes" },
    { id: "target-5", sourceType: "review", sourceId: "review-1", targetType: "literature", targetId: "literature-1", relationType: "summarizes" },
    { id: "explicit-1", sourceType: "task", sourceId: "task-1", targetType: "experiment", targetId: "experiment-1", relationType: "supports", description: "Task supports experiment" },
    { id: "cross-1", sourceType: "task", sourceId: "task-1", targetType: "experiment", targetId: "outside", relationType: "supports" },
    { id: "unrelated", sourceType: "task", sourceId: "outside-1", targetType: "experiment", targetId: "outside-2", relationType: "supports" }
  ];
  const outputRelations = [
    { sourceType: "resultItem", sourceId: "result-1", targetType: "finding", targetId: "finding-1", relationType: "evidence_for" },
    { sourceType: "finding", sourceId: "finding-1", targetType: "outputCandidate", targetId: "candidate-1", relationType: "supports" },
    { sourceType: "resultItem", sourceId: "result-1", targetType: "outputCandidate", targetId: "candidate-1", relationType: "uses" },
    { sourceType: "outputGap", sourceId: "gap-1", targetType: "outputCandidate", targetId: "candidate-1", relationType: "blocks" },
    { sourceType: "finding", sourceId: "finding-1", targetType: "researchOutput", targetId: "output-1", relationType: "supports" }
  ];
  return { project, routes, tasks, experiments, runs, literature, reviews, resultItems, findings, candidates, gaps, outputs, links, outputRelations };
}

function dependencies(fixture, reverse = false) {
  const list = (value) => structuredClone(reverse ? [...value].reverse() : value);
  return {
    getProject: async (id) => id === fixture.project.id ? structuredClone(fixture.project) : undefined,
    // Route and Task order is canonical semantic input and must be preserved.
    queryRoutes: async () => structuredClone(fixture.routes),
    queryTasks: async () => structuredClone(fixture.tasks),
    queryReviews: async () => list(fixture.reviews),
    getExperimentsByProject: async () => list(fixture.experiments),
    listExperimentRuns: async () => list(fixture.runs),
    queryLiteratures: async () => list(fixture.literature),
    listResultItems: async () => list(fixture.resultItems),
    listFindings: async () => list(fixture.findings),
    listOutputCandidates: async () => list(fixture.candidates),
    listOutputGaps: async () => list(fixture.gaps),
    listResearchOutputs: async () => list(fixture.outputs),
    queryEntityLinks: async () => list(fixture.links),
    queryOutputRelations: async () => list(fixture.outputRelations)
  };
}

test("production projection emits an exact Import v1 payload with supported scope and omissions", async () => {
  const fixture = canonicalFixture();
  const prepared = await subject.prepareProjectExportV1(fixture.project.id, dependencies(fixture));
  assert.equal(prepared.importPreflight.ok, true);
  assert.equal(prepared.document.schema, "sciloom.project-import");
  assert.equal(prepared.document.version, 1);
  assert.equal(prepared.scope.supportedEntityTypeCount, 12);
  assert.equal(prepared.scope.totalObjectCount, 14);
  assert.deepEqual(prepared.scope.exportedObjectCounts, {
    project: 1, route: 2, task: 1, experiment: 1, experimentRun: 1, literature: 1,
    review: 1, resultItem: 2, finding: 1, outputCandidate: 1, outputGap: 1, researchOutput: 1
  });
  assert.equal(prepared.scope.supportedRelationshipTypeCount, 12);
  assert.equal(prepared.scope.relationshipInstanceCounts.routeParent, 1);
  assert.equal(prepared.scope.relationshipInstanceCounts.reviewTarget, 5);
  assert.equal(prepared.scope.relationshipInstanceCounts.gapCandidate, 1);
  assert.equal(prepared.scope.relationshipInstanceCounts.explicitEntityLink, 1);
  assert.equal(Object.values(prepared.scope.relationshipInstanceCounts).every((count) => count > 0), true);
  assert.equal(prepared.scope.totalRelationshipInstanceCount, 29);
  assert.equal(prepared.scope.omittedEntityCounts.resultItems, 1);
  assert.equal(prepared.scope.omittedEntityCounts.outputGaps, 1);
  assert.equal(prepared.scope.omittedSourceFactCount, 5);
  assert.equal(prepared.document.objects.outputGaps[0].outputCandidateRef, "outputCandidate_1");
  assert.equal(prepared.document.objects.reviews[0].targets.length, 5);
  assert.equal(prepared.document.relations.length, 1);
  assert.match(prepared.serialized, /保留 \*\*Markdown\*\* 与 Unicode → Ω/u);
  assert.doesNotMatch(prepared.serialized, /localFilePath|C:\\\\private|createdAt|updatedAt/u);
});

test("the smallest canonical Project produces a legal one-object Import v1 document", async () => {
  const fixture = canonicalFixture();
  for (const key of [
    "routes", "tasks", "experiments", "runs", "literature", "reviews", "resultItems",
    "findings", "candidates", "gaps", "outputs", "links", "outputRelations"
  ]) fixture[key] = [];
  const prepared = await subject.prepareProjectExportV1(fixture.project.id, dependencies(fixture));
  assert.equal(prepared.importPreflight.ok, true);
  assert.equal(prepared.scope.totalObjectCount, 1);
  assert.equal(prepared.scope.totalRelationshipInstanceCount, 0);
  assert.deepEqual(prepared.document.objects, {
    routes: [], tasks: [], experiments: [], experimentRuns: [], literature: [], reviews: [],
    resultItems: [], findings: [], outputCandidates: [], outputGaps: [], researchOutputs: []
  });
});

test("projection is deterministic and save uses the frozen reviewed bytes", async () => {
  const fixture = canonicalFixture();
  const first = await subject.prepareProjectExportV1(fixture.project.id, dependencies(fixture));
  const second = await subject.prepareProjectExportV1(fixture.project.id, dependencies(fixture, true));
  assert.equal(second.serialized, first.serialized);
  fixture.project.title = "mutated after preview";
  let saved;
  const outcome = await subject.savePreparedProjectExportV1(first, {
    saveTextFile: async (name, contents, mimeType) => {
      saved = { name, contents, mimeType };
      return { saved: true, filePath: "N:\\evidence\\roundtrip.json", message: "saved" };
    }
  });
  assert.equal(outcome.saved, true);
  assert.equal(saved.contents, first.serialized);
  assert.equal(saved.mimeType, "application/json");
  assert.match(saved.name, /import-v1\.json$/u);
  assert.doesNotMatch(saved.contents, /mutated after preview/u);
});

test("save cancellation and failure remain explicit", async () => {
  const fixture = canonicalFixture();
  const prepared = await subject.prepareProjectExportV1(fixture.project.id, dependencies(fixture));
  const canceled = await subject.savePreparedProjectExportV1(prepared, {
    saveTextFile: async () => ({ saved: false, message: "canceled" })
  });
  assert.equal(canceled.saved, false);
  await assert.rejects(
    subject.savePreparedProjectExportV1(prepared, { saveTextFile: async () => { throw new Error("disk full"); } }),
    /disk full/u
  );
});

test("missing Project selection and lookup fail before projection", async () => {
  const fixture = canonicalFixture();
  await assert.rejects(subject.prepareProjectExportV1(" ", dependencies(fixture)), /Select one Project/u);
  await assert.rejects(subject.prepareProjectExportV1("missing", dependencies(fixture)), /unavailable or deleted/u);
});
