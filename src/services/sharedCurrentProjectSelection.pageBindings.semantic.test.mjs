import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), "utf8");

const ownerSource = read("src/services/sharedCurrentProjectSelection.ts");
const pages = {
  Projects: read("src/pages/Projects/ProjectsPage.tsx"),
  Routes: read("src/pages/Routes/RoutesPage.tsx"),
  Tasks: read("src/pages/Tasks/TasksPage.tsx"),
  Experiments: read("src/pages/Experiments/ExperimentsPage.tsx"),
  Literature: read("src/pages/Literature/LiteraturePage.tsx"),
  Reviews: read("src/pages/Reviews/ReviewsPage.tsx"),
  Outputs: read("src/pages/Outputs/OutputsPage.tsx")
};

test("one frontend-only owner persists concrete IDs and owns deterministic validation", () => {
  assert.match(ownerSource, /researchpilot\.sharedCurrentProjectSelection/);
  assert.match(ownerSource, /if \(!concreteProjectId\)[\s\S]*readSharedCurrentProjectSelection/);
  assert.match(ownerSource, /projects\.some\(\(project\) => project\.id === sharedProjectId\)/);
  assert.match(ownerSource, /const firstValidProjectId = projects\[0\]\?\.id\.trim\(\) \|\| ""/);
  assert.match(ownerSource, /clearSharedCurrentProjectSelection\(storage\)/);
  assert.doesNotMatch(
    ownerSource,
    /planningService|Repository|queryProjects|invoke\(|sqlite|database|AI|Provider|Migration/
  );
});

test("all seven primary pages bind the shared read, validation, and concrete-write owner", () => {
  for (const [pageName, source] of Object.entries(pages)) {
    assert.match(
      source,
      /from "\.\.\/\.\.\/services\/sharedCurrentProjectSelection"/,
      `${pageName} must import the single shared owner`
    );
    assert.match(
      source,
      /readSharedCurrentProjectSelection\(\)/,
      `${pageName} must restore the preference on mount/remount/refresh`
    );
    assert.match(
      source,
      /resolveSharedCurrentProjectSelection\(/,
      `${pageName} must validate the stored ID against current projects`
    );
    assert.match(
      source,
      /writeSharedCurrentProjectSelection\(/,
      `${pageName} must write an explicitly selected concrete project`
    );
  }
});

test("Projects participates without changing its tab/card presentation", () => {
  const source = pages.Projects;
  assert.match(
    source,
    /function handleSelectProject\(projectId: string\) \{[\s\S]*writeSharedCurrentProjectSelection\(projectId\);[\s\S]*setSelectedProjectId\(projectId\);/
  );
  assert.match(source, /className=\{project\.id === selectedProjectId \? "project-tab active" : "project-tab"\}/);
});

test("Projects exposes base catalog state before nonblocking research-context summaries", () => {
  const source = pages.Projects;
  assert.match(source, /getPlanningProjectsPageBaseModel\(\)/u);
  assert.match(
    source,
    /setProjects\(projectRows\);[\s\S]*setPlanItemsByProjectId\(pageModel\.planItemsByProjectId\);[\s\S]*getPlanningProjectOverviewSummaries/u
  );
  assert.doesNotMatch(source, /getPlanningProjectsPageModel\(\)/u);
  assert.match(source, /selectedProjectIdRef\.current/u);
  assert.match(source, /initialPageLoadStartedRef\.current/u);
  assert.doesNotMatch(source, /__lp15A3ProjectsProbe/u);
});

test("ALL-capable pages preserve local ALL without writing it as shared concrete identity", () => {
  for (const [pageName, source] of [
    ["Experiments", pages.Experiments],
    ["Literature", pages.Literature]
  ]) {
    assert.match(
      source,
      /const preservePageLocalAll =[\s\S]*projectSelectionInitializedRef\.current && !currentProjectId/,
      `${pageName} must preserve an intentional page-local ALL selection`
    );
    assert.match(
      source,
      /if \(projectId\) \{\s*writeSharedCurrentProjectSelection\(projectId\);\s*\}/,
      `${pageName} must write only concrete selector values`
    );
  }
});

test("page-local first-project heuristics no longer override a valid shared identity", () => {
  assert.doesNotMatch(pages.Tasks, /chooseDefaultTaskProjectId/);
  assert.doesNotMatch(pages.Reviews, /firstCurrentReviewProjectId/);
  assert.match(
    pages.Routes,
    /queryProject\?\.id \|\|\s*resolveSharedCurrentProjectSelection\(projectRows\)/
  );
  assert.match(
    pages.Outputs,
    /options\.some\(\(project\) => project\.id === current\)[\s\S]*resolveSharedCurrentProjectSelection\(options\)/
  );
});
