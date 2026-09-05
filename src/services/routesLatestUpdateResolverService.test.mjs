import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveRoutesLatestUpdatedAt } from "./routesLatestUpdateResolverService.ts";

const formatDate = (value) => value.slice(0, 10);
const projectId = "project-current";

function resolve(routes, projectUpdatedAt = "2026-06-30T08:00:00+08:00") {
  return resolveRoutesLatestUpdatedAt({
    projectId,
    routes,
    projectUpdatedAt,
    formatDate
  });
}

const multipleRoutes = [
  { projectId, updatedAt: "2026-07-01T09:00:00+08:00" },
  { projectId, updatedAt: "2026-07-12T09:00:00+08:00" },
  { projectId, updatedAt: "2026-07-08T09:00:00+08:00" }
];
assert.deepEqual(resolve(multipleRoutes), {
  updatedAt: "2026-07-12T09:00:00+08:00",
  displayText: "2026-07-12"
});

assert.equal(
  resolve([
    {
      projectId,
      updatedAt: "2026-07-01T09:00:00+08:00",
      startDate: "2026-01-01",
      timeLabel: "month"
    },
    {
      projectId,
      updatedAt: "2026-07-12T09:00:00+08:00",
      startDate: "2026-12-01",
      timeLabel: "week"
    }
  ]).displayText,
  "2026-07-12"
);

for (const timeLabel of ["month", "week", "Unscheduled"]) {
  assert.equal(
    resolve([{ projectId, updatedAt: "2026-07-12T09:00:00+08:00", timeLabel }]).displayText,
    "2026-07-12"
  );
}

assert.equal(
  resolve([
    { projectId, updatedAt: "2026-07-10T09:00:00+08:00" },
    { projectId: "project-other", updatedAt: "2026-07-20T09:00:00+08:00" }
  ]).displayText,
  "2026-07-10"
);

assert.equal(
  resolve([
    { projectId, updatedAt: "2026-07-10T09:00:00+08:00" },
    { projectId, updatedAt: "2026-07-20T09:00:00+08:00", archivedAt: "2026-07-20" },
    { projectId, updatedAt: "2026-07-21T09:00:00+08:00", deletedAt: "2026-07-21" },
    { projectId, updatedAt: "2026-07-22T09:00:00+08:00", status: "archived" },
    { projectId, updatedAt: "2026-07-23T09:00:00+08:00", captureState: "archived" }
  ]).displayText,
  "2026-07-10"
);

assert.equal(resolve([], "2026-07-05T09:00:00+08:00").displayText, "2026-07-05");
assert.equal(
  resolve([{ projectId, updatedAt: "invalid" }], "2026-07-05T09:00:00+08:00").displayText,
  "2026-07-05"
);
assert.deepEqual(resolve([{ projectId, updatedAt: "invalid" }], "also-invalid"), {
  updatedAt: undefined,
  displayText: "—"
});

const routeSnapshot = [
  Object.freeze({
    projectId,
    updatedAt: "2026-07-12T09:00:00+08:00",
    showInGantt: false,
    researchTraceDisplayChecked: false
  }),
  Object.freeze({ projectId, updatedAt: "2026-07-08T09:00:00+08:00" })
];
const frozenRoutes = Object.freeze(routeSnapshot);
const before = JSON.stringify(frozenRoutes);
const baseline = resolve(frozenRoutes).displayText;
assert.equal(baseline, "2026-07-12");
assert.equal(
  resolve(
    frozenRoutes.map((route) => ({
      ...route,
      showInGantt: !route.showInGantt,
      researchTraceDisplayChecked: !route.researchTraceDisplayChecked
    }))
  ).displayText,
  baseline
);
assert.equal(JSON.stringify(frozenRoutes), before);

const routesPage = readFileSync(
  new URL("../pages/Routes/RoutesPage.tsx", import.meta.url),
  "utf8"
);
assert.match(routesPage, /resolveRoutesLatestUpdatedAt\(\{[\s\S]*routes: routeItems,[\s\S]*projectUpdatedAt: selectedProject\?\.updatedAt,[\s\S]*formatDate/);
assert.match(routesPage, /<strong>\{latestProjectUpdate\.displayText\}<\/strong>/);
assert.doesNotMatch(routesPage, /selectedProjectItems\[0\]\?\.(timeLabel|startDate|endDate)/);
assert.doesNotMatch(routesPage, /latestProjectActivity/);

console.log("Routes latest update resolver contract passed.");
