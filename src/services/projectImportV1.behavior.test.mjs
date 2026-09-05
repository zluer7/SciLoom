import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const directory = path.dirname(fileURLToPath(import.meta.url));
const bundle = await build({
  stdin: {
    contents: `
      export * from "./projectImportV1Authority.ts";
      export { executeProjectImportV1 } from "./projectImportV1Service.ts";
    `,
    resolveDir: directory,
    sourcefile: "project-import-v1-behavior-harness.ts"
  },
  plugins: [{
    name: "project-import-v1-canonical-port-stubs",
    setup(api) {
      const ports = new Map([
        ["planningService", [
          "createProject", "getProjectById", "createRouteNode", "getRouteNodeById",
          "createTask", "getTaskById", "createReviewWithTargets", "getReviewById"
        ]],
        ["experimentService", ["createExperiment", "getExperimentById"]],
        ["experimentRunService", ["createExperimentRun", "getRunById"]],
        ["literatureService", ["createLiterature", "getLiteratureById"]],
        ["outputConversionService", [
          "createResultItem", "getResultItemById", "createFinding", "getFindingById",
          "createOutputCandidate", "getOutputCandidateById", "createOutputGap", "getOutputGapById"
        ]],
        ["outputService", ["create", "getById"]],
        ["entityLinkService", ["createEntityLink", "queryLinksBetween"]]
      ]);
      for (const [serviceName, methods] of ports) {
        api.onResolve({ filter: new RegExp(`^\\./${serviceName}$`, "u") }, () => ({
          path: serviceName,
          namespace: "import-v1-port"
        }));
        api.onLoad({ filter: new RegExp(`^${serviceName}$`, "u"), namespace: "import-v1-port" }, () => ({
          loader: "js",
          contents: `export const ${serviceName} = {${methods.map((method) => `${method}(){ throw new Error("production port not injected: ${serviceName}.${method}"); }`).join(",")}};`
        }));
      }
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

function representativeDocument() {
  return {
    schema: "sciloom.project-import",
    version: 1,
    project: {
      ref: "project_main",
      title: "Import v1 representative project",
      objective: "Prove every admitted manifest branch",
      status: "active",
      priority: "high",
      tags: ["import-v1"]
    },
    objects: {
      routes: [
        { ref: "route_parent", title: "Parent route", nodeType: "analysis" },
        { ref: "route_child", title: "Child route", parentRef: "route_parent", nodeType: "experiment" }
      ],
      tasks: [{ ref: "task_main", title: "Task", routeRef: "route_child", taskType: "experiment" }],
      experiments: [{
        ref: "experiment_main",
        title: "Experiment",
        purposeAndQuestion: "Question",
        resultSummary: "",
        status: "planned"
      }],
      experimentRuns: [{
        ref: "run_main",
        experimentRef: "experiment_main",
        title: "Run",
        conditionSummary: "Condition",
        status: "planned"
      }],
      literature: [{
        ref: "literature_main",
        title: "Paper",
        authors: [{ name: "Researcher" }],
        publicationType: "journal_article",
        readingStatus: "unread"
      }],
      reviews: [{
        ref: "review_main",
        title: "Review",
        reviewType: "stage",
        outlineSections: [
          { key: "stage_summary", content: "Structured state" },
          { key: "next_plan", content: "Next" }
        ],
        targets: [
          { type: "route", ref: "route_child" },
          { type: "task", ref: "task_main" },
          { type: "experiment", ref: "experiment_main" },
          { type: "experimentRun", ref: "run_main" },
          { type: "literature", ref: "literature_main" }
        ]
      }],
      resultItems: [{
        ref: "result_main",
        title: "Result",
        resultType: "metric",
        source: { type: "experiment", ref: "experiment_main" },
        experimentRef: "experiment_main",
        structuredSummary: { keyPhenomenon: "Stable", conditionBrief: "Condition A" },
        value: 0.91,
        unit: "score"
      }],
      findings: [{
        ref: "finding_main",
        title: "Finding",
        summary: "Finding summary",
        experimentRef: "experiment_main",
        resultItemRefs: ["result_main"],
        structuredSummary: { supportingEvidence: "Result" }
      }],
      outputCandidates: [{
        ref: "candidate_main",
        title: "Candidate",
        candidateType: "paper",
        findingRefs: ["finding_main"],
        resultItemRefs: ["result_main"],
        structuredSummary: { innovationContribution: "Contribution" }
      }],
      outputGaps: [{
        ref: "gap_main",
        title: "Gap",
        gapType: "validation",
        outputCandidateRef: "candidate_main",
        structuredSummary: { completionCriteria: "Replicate" }
      }],
      researchOutputs: [{
        ref: "output_main",
        outputName: "Formal output",
        outputType: "report",
        experimentRef: "experiment_main",
        description: "Output description",
        usableForPaper: true,
        structuredSummary: { coreContribution: "Core" }
      }]
    },
    relations: [{
      source: { type: "task", ref: "task_main" },
      target: { type: "experiment", ref: "experiment_main" },
      relationType: "supports",
      description: "Task supports experiment"
    }]
  };
}

function createCanonicalHarness(failAt) {
  const records = new Map();
  const relations = [];
  const calls = [];
  let serial = 0;
  function persist(type, input, labelField = "title") {
    calls.push({ type, input: structuredClone(input) });
    if (failAt === type) throw new Error(`deterministic ${type} failure`);
    const id = `${type}-id-${++serial}`;
    const entity = {
      ...structuredClone(input),
      id,
      title: input[labelField],
      outputName: input.outputName,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z"
    };
    records.set(`${type}:${id}`, entity);
    return entity;
  }
  function read(type, id) {
    calls.push({ type: `${type}:read`, id });
    return structuredClone(records.get(`${type}:${id}`));
  }
  const dependencies = {
    createProject: async (input) => persist("project", input),
    getProjectById: async (id) => read("project", id),
    createRoute: async (input) => persist("route", input),
    getRouteById: async (id) => read("route", id),
    createTask: async (input) => persist("task", input),
    getTaskById: async (id) => read("task", id),
    createExperiment: async (input) => persist("experiment", input),
    getExperimentById: async (id) => read("experiment", id),
    createExperimentRun: async (input) => persist("experimentRun", {
      ...input,
      projectId: records.get(`experiment:${input.experimentId}`).projectId
    }),
    getExperimentRunById: async (id) => read("experimentRun", id),
    createLiterature: async (input) => {
      const literature = persist("literature", input);
      return { status: "success", literature, literatureId: literature.id, completedSteps: ["literature"], retryable: false, warnings: [], errors: [] };
    },
    getLiteratureById: async (id) => read("literature", id),
    createReview: async (input) => ({ ...persist("review", input), provisioning: { completionState: "complete" } }),
    getReviewById: async (id) => read("review", id),
    createResultItem: async (input) => persist("resultItem", input),
    getResultItemById: async (id) => read("resultItem", id),
    createFinding: async (input) => persist("finding", input),
    getFindingById: async (id) => read("finding", id),
    createOutputCandidate: async (input) => persist("outputCandidate", input),
    getOutputCandidateById: async (id) => read("outputCandidate", id),
    createOutputGap: async (input) => persist("outputGap", input),
    getOutputGapById: async (id) => read("outputGap", id),
    createResearchOutput: async (input) => persist("researchOutput", input, "outputName"),
    getResearchOutputById: async (id) => read("researchOutput", id),
    createEntityLink: async (input) => {
      calls.push({ type: "relation", input: structuredClone(input) });
      if (failAt === "relation") throw new Error("deterministic relation failure");
      const relation = { id: `relation-${relations.length + 1}`, ...structuredClone(input) };
      relations.push(relation);
      return relation;
    },
    queryLinksBetween: async (sourceType, sourceId, targetType, targetId, relationType) => relations.filter((entry) =>
      entry.sourceType === sourceType && entry.sourceId === sourceId &&
      entry.targetType === targetType && entry.targetId === targetId &&
      entry.relationType === relationType
    )
  };
  return { dependencies, calls, records, relations };
}

test("Import v1 preflight accepts the manifest-wide representative document and reports exact counts", () => {
  const result = subject.preflightProjectImportV1(JSON.stringify(representativeDocument()));
  assert.equal(result.ok, true);
  assert.equal(result.preview.projectCount, 1);
  assert.equal(result.preview.totalObjectCount, 13);
  assert.equal(result.preview.relationCount, 1);
  assert.deepEqual(
    subject.IMPORT_V1_SUPPORTED_OBJECT_MANIFEST.map((entry) => entry.type),
    subject.IMPORT_V1_OBJECT_TYPES
  );
  assert.equal(subject.IMPORT_V1_SUPPORTED_OBJECT_TYPE_COUNT, 12);
  assert.deepEqual(result.preview.skippedCounts, { fields: 0, objects: 0, relations: 0 });
  assert.equal(result.warnings.length, 0);
  assert.match(result.inputIdentity.contentHash, /^fnv1a64:[0-9a-f]{16}$/u);
});

test("LP15-B2 canonical bundled Demo executes one frozen preflight plan with exact durable readback counts", async () => {
  const raw = readFileSync(
    path.resolve(directory, "../../demo/west-lake-vinegar-fish/project-import.json"),
    "utf8"
  );
  const plan = subject.preflightProjectImportV1(raw, {
    selectedMode: "auto",
    effectiveMode: "sqlite"
  });
  assert.equal(plan.ok, true);
  const harness = createCanonicalHarness();
  const outcome = await subject.executeProjectImportV1(plan, {
    confirmed: true,
    selectedMode: "auto",
    effectiveMode: "sqlite"
  }, harness.dependencies);
  assert.equal(outcome.status, "success");
  assert.deepEqual(outcome.createdCounts, plan.preview.objectCounts);
  assert.equal(outcome.createdRelationCount, plan.preview.relationCount);
  assert.equal(outcome.created.length, plan.preview.totalObjectCount);
  assert.equal(harness.records.size, plan.preview.totalObjectCount);
  assert.equal(harness.relations.length, plan.preview.relationCount);
  const projectCall = harness.calls.find((entry) => entry.type === "project");
  assert.match(plan.document.project.background, /欢迎来杭州游西湖品醋鱼！/u);
  assert.equal(
    projectCall.input.customFields.significance,
    plan.document.project.background
  );
  assert.equal(
    outcome.created.every((identity) =>
      harness.records.has(`${identity.type}:${identity.id}`)
    ),
    true
  );
});

test("Import v1 mechanically rejects version, root, type, P0, unknown, forbidden, ref, relation, and route-cycle failures", () => {
  const cases = [
    ["invalid JSON", "{", "INVALID_JSON"],
    ["unsupported version", { ...representativeDocument(), version: 2 }, "UNSUPPORTED_VERSION"],
    ["missing Project", (({ project: _project, ...rest }) => rest)(representativeDocument()), "MISSING_REQUIRED_FIELD"],
    ["multiple Project roots", { ...representativeDocument(), project: [representativeDocument().project, representativeDocument().project] }, "INVALID_FIELD_TYPE"],
    ["unsupported object type", { ...representativeDocument(), objects: { ...representativeDocument().objects, datasets: [] } }, "UNKNOWN_FIELD"],
    ["missing P0", { ...representativeDocument(), project: { ref: "project_main" } }, "MISSING_REQUIRED_FIELD"],
    ["unknown object field", { ...representativeDocument(), project: { ...representativeDocument().project, invented: true } }, "UNKNOWN_FIELD"],
    ["forbidden id", { ...representativeDocument(), project: { ...representativeDocument().project, id: "existing-id" } }, "FORBIDDEN_SYSTEM_FIELD"],
    ["duplicate ref", { ...representativeDocument(), objects: { ...representativeDocument().objects, tasks: [{ ref: "route_parent", title: "Duplicate" }] } }, "DUPLICATE_TEMP_REF"],
    ["unresolved ref", { ...representativeDocument(), objects: { ...representativeDocument().objects, tasks: [{ ref: "task_main", title: "Task", routeRef: "missing_route" }] } }, "UNRESOLVED_TEMP_REF"],
    ["wrong ref type", { ...representativeDocument(), objects: { ...representativeDocument().objects, tasks: [{ ref: "task_main", title: "Task", routeRef: "experiment_main" }] } }, "WRONG_TEMP_REF_TYPE"],
    ["duplicate relation", { ...representativeDocument(), relations: [representativeDocument().relations[0], representativeDocument().relations[0]] }, "DUPLICATE_RELATION"],
    ["invalid relation", { ...representativeDocument(), relations: [{ ...representativeDocument().relations[0], relationType: "invented" }] }, "INVALID_RELATION"],
    ["route cycle", { ...representativeDocument(), objects: { ...representativeDocument().objects, routes: [{ ref: "route_a", title: "A", parentRef: "route_b" }, { ref: "route_b", title: "B", parentRef: "route_a" }] } }, "DEPENDENCY_CYCLE"]
  ];
  for (const [name, input, code] of cases) {
    const result = subject.preflightProjectImportV1(typeof input === "string" ? input : JSON.stringify(input));
    assert.equal(result.ok, false, name);
    assert.equal(result.issues.some((entry) => entry.code === code), true, `${name}: expected ${code}, got ${result.issues.map((entry) => entry.code).join(",")}`);
  }
});

test("Import v1 omits an unrepresentable optional Review periodLabel and executes the exact warned preflight settlement", async () => {
  const document = representativeDocument();
  document.objects.reviews[0].periodLabel = "Current phase";
  const preflight = subject.preflightProjectImportV1(JSON.stringify(document), {
    selectedMode: "auto",
    effectiveMode: "sqlite"
  });
  assert.equal(preflight.ok, true, JSON.stringify(preflight));
  assert.equal(preflight.document.objects.reviews[0].periodLabel, undefined);
  assert.deepEqual(preflight.preview.skippedCounts, { fields: 1, objects: 0, relations: 0 });
  assert.deepEqual(preflight.warnings.map((warning) => warning.code), ["OPTIONAL_FIELD_SKIPPED"]);
  assert.equal(preflight.preview.totalObjectCount, 13);
  assert.equal(preflight.inputIdentity.selectedMode, "auto");
  assert.equal(preflight.inputIdentity.effectiveMode, "sqlite");
  assert.equal(preflight.inputIdentity.targetIdentity, "new-project:project_main");

  const harness = createCanonicalHarness();
  const outcome = await subject.executeProjectImportV1(preflight, {
    confirmed: true,
    selectedMode: "auto",
    effectiveMode: "sqlite"
  }, harness.dependencies);
  assert.equal(outcome.status, "success", JSON.stringify(outcome));
  assert.equal(outcome.created.length, preflight.preview.totalObjectCount);
  assert.deepEqual(outcome.skippedCounts, preflight.preview.skippedCounts);
  assert.deepEqual(outcome.warnings, preflight.preview.warnings);
  assert.equal(harness.calls.find((entry) => entry.type === "review").input.periodLabel, undefined);
});

test("Import v1 refuses a stale preflight plan after the data-source mode changes", async () => {
  const preflight = subject.preflightProjectImportV1(representativeDocument(), {
    selectedMode: "auto",
    effectiveMode: "sqlite"
  });
  assert.equal(preflight.ok, true);
  const harness = createCanonicalHarness();
  const outcome = await subject.executeProjectImportV1(preflight, {
    confirmed: true,
    selectedMode: "localStorage",
    effectiveMode: "localStorage"
  }, harness.dependencies);
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.failedAt.type, "preflight");
  assert.match(outcome.failedAt.message, /mode changed after preflight/u);
  assert.deepEqual(harness.calls, []);
});

test("confirmed Import v1 calls every admitted canonical CREATE/readback branch once and maps only new real IDs", async () => {
  const preflight = subject.preflightProjectImportV1(representativeDocument());
  assert.equal(preflight.ok, true);
  const harness = createCanonicalHarness();
  const outcome = await subject.executeProjectImportV1(preflight, { confirmed: true }, harness.dependencies);
  assert.equal(outcome.status, "success", JSON.stringify(outcome));
  assert.equal(outcome.project.title, "Import v1 representative project");
  assert.equal(outcome.created.length, 13);
  assert.equal(outcome.createdRelationCount, 1);
  for (const type of subject.IMPORT_V1_OBJECT_TYPES) {
    const expected = type === "route" ? 2 : 1;
    assert.equal(outcome.createdCounts[type], expected, `${type} deterministic branch count`);
    assert.equal(harness.calls.filter((entry) => entry.type === type).length, expected, `${type} canonical CREATE count`);
    assert.equal(harness.calls.filter((entry) => entry.type === `${type}:read`).length, expected, `${type} readback count`);
  }
  const taskCall = harness.calls.find((entry) => entry.type === "task");
  const childRoute = outcome.created.find((entry) => entry.ref === "route_child");
  assert.equal(taskCall.input.routeNodeId, childRoute.id);
  assert.equal(taskCall.input.ref, undefined);
  const runCall = harness.calls.find((entry) => entry.type === "experimentRun");
  assert.equal(runCall.input.experimentId, outcome.created.find((entry) => entry.ref === "experiment_main").id);
  const gapCall = harness.calls.find((entry) => entry.type === "outputGap");
  assert.equal(gapCall.input.confirmedByUser, true);
  assert.equal(gapCall.input.outputCandidateId, outcome.created.find((entry) => entry.ref === "candidate_main").id);
  assert.equal(harness.relations.length, 1);
  assert.equal(harness.relations[0].sourceType, "task");
  assert.equal(harness.relations[0].targetType, "experiment");
});

test("cancel is a deterministic zero-write outcome", async () => {
  const preflight = subject.preflightProjectImportV1(representativeDocument());
  const harness = createCanonicalHarness();
  const outcome = await subject.executeProjectImportV1(preflight, { confirmed: false }, harness.dependencies);
  assert.equal(outcome.status, "canceled");
  assert.equal(outcome.created.length, 0);
  assert.deepEqual(harness.calls, []);
});

test("unexpected canonical failure truthfully stops all later calls and preserves known created identities", async () => {
  const preflight = subject.preflightProjectImportV1(representativeDocument());
  const harness = createCanonicalHarness("task");
  const outcome = await subject.executeProjectImportV1(preflight, { confirmed: true }, harness.dependencies);
  assert.equal(outcome.status, "partial");
  assert.equal(outcome.failedAt.type, "task");
  assert.match(outcome.failedAt.message, /deterministic task failure/u);
  assert.equal(outcome.createdCounts.project, 1);
  assert.equal(outcome.createdCounts.route, 2);
  assert.equal(outcome.createdCounts.task, 0);
  assert.equal(harness.calls.some((entry) => entry.type === "experiment"), false);
  assert.match(outcome.warnings.join(" "), /do not blindly retry/u);
});
