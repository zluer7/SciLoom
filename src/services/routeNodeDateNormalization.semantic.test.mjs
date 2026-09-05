import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function read(path) {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

const planningRepository = read("src/services/planningRepository.ts");
assert.match(planningRepository, /export function normalizeRouteDate\(value: unknown\)/);
assert.match(planningRepository, /value\.trim\(\)/);
assert.match(planningRepository, /\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\/\.test\(trimmed\)/);
assert.match(planningRepository, /return undefined;/);
assert.match(planningRepository, /normalizeRouteNodeFields\(\{[\s\S]*routeNode[\s\S]*\}\)/);
assert.match(planningRepository, /startDate: normalizeRouteDate\(routeNode\.startDate\)/);
assert.match(planningRepository, /endDate: normalizeRouteDate\(routeNode\.endDate\)/);
assert.match(planningRepository, /normalizeRouteNodePatch\(patch\)/);

const planningService = read("src/services/planningService.ts");
assert.match(planningService, /normalizeRouteDate,/);
assert.match(planningService, /function validateRouteDateRange\(startDate\?: string, endDate\?: string\)/);
assert.match(planningService, /if \(startDate && endDate && startDate > endDate\)/);
assert.match(planningService, /throw new Error\("RouteNode startDate cannot be later than endDate\."\)/);
assert.match(planningService, /const startDate = normalizeRouteDate\(input\.startDate\)/);
assert.match(planningService, /const endDate = normalizeRouteDate\(input\.endDate\)/);
assert.match(planningService, /validateRouteDateRange\(startDate, endDate\)/);
assert.match(planningService, /validateRouteDateRange\(\s*hasStartDate \? normalized\.startDate : existing\.startDate,\s*hasEndDate \? normalized\.endDate : existing\.endDate\s*\)/);

const routesPage = read("src/pages/Routes/RoutesPage.tsx");
assert.match(routesPage, /function resolveDateFallback\(dateText: string\) \{\s*return dateText \|\| undefined;\s*\}/);
assert.match(routesPage, /startDate,\s*endDate,/);
assert.doesNotMatch(routesPage, /resolveDateFallback\(dateText: string\) \{\s*return dateText \|\| "";\s*\}/);

const routeSubmitBlock = routesPage.match(
  /async function handleSubmit[\s\S]*?const operation = editingId \? "planning\.updateRouteNode"/
)?.[0] ?? "";
assert.doesNotMatch(routeSubmitBlock, /createdAt|updatedAt|completedAt/);
assert.doesNotMatch(routeSubmitBlock, /timeLabel[^,\n]*\?\?[^,\n]*startDate|timeLabel[^,\n]*\|\|[^,\n]*startDate/);

const planningPageAdapterService = read("src/services/planningPageAdapterService.ts");
const routeEntryBlock = planningPageAdapterService.match(
  /function routeToPlanningRouteEntry[\s\S]*?\n\}/
)?.[0] ?? "";
assert.match(routeEntryBlock, /startDate: routeNode\.startDate \?\? ""/);
assert.match(routeEntryBlock, /endDate: routeNode\.endDate \?\? ""/);
assert.doesNotMatch(routeEntryBlock, /startDate: routeNode\.timeLabel|endDate: routeNode\.timeLabel/);
assert.doesNotMatch(routeEntryBlock, /createdAt|completedAt/);

console.log("RouteNode date normalization semantic checks passed.");
