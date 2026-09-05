import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

const relationService = read("src/services/outputConversionRelationService.ts");
const selectorService = read("src/services/outputFiveLayerSelectorService.ts");
const sqliteRepository = read("src/repositories/sqliteRepository.ts");
const rustDb = read("src-tauri/src/db/mod.rs");
const rustSchema = read("src-tauri/src/db/schema.rs");
const outputConversionService = read("src/services/outputConversionService.ts");

const allowlist =
  rustDb.match(/"output_conversion_relations"\s*=>\s*Some\(&\[([\s\S]*?)\]\),/)?.[1] ?? "";
const mapper =
  sqliteRepository.match(/output_conversion_relations:\s*\{([\s\S]*?)\n\s*\},/)?.[1] ?? "";
const createTable =
  rustSchema.match(/CREATE TABLE IF NOT EXISTS output_conversion_relations \(([\s\S]*?)\n\);/)?.[1] ??
  "";

for (const column of [
  "id",
  "project_id",
  "source_type",
  "source_id",
  "target_type",
  "target_id",
  "relation_type",
  "note",
  "schema_version",
  "created_at",
  "updated_at",
  "deleted_at"
]) {
  assert.match(allowlist, new RegExp(`"${column}"`), `${column} missing from relation allowlist`);
  assert.match(createTable, new RegExp(`\\b${column}\\b`), `${column} missing from relation CREATE`);
}

for (const field of ["projectId", "sourceType", "sourceId", "targetType", "targetId", "relationType", "schemaVersion"]) {
  assert.match(mapper, new RegExp(`${field}:`), `${field} missing from relation mapper`);
}

assert.match(
  relationService,
  /const relation = await relationRepository\.create\(toCreateInput\(input\)\);[\s\S]*?const persisted = await relationRepository\.getById\(relation\.id\);[\s\S]*?if \(!persisted\)/
);
assert.match(relationService, /evidence_for:\s*\{ sourceType: "resultItem", targetType: "finding" \}/);
assert.match(relationService, /blocks:\s*\{ sourceType: "outputGap", targetType: "outputCandidate" \}/);
assert.match(relationService, /converted_to:\s*\{ sourceType: "outputCandidate", targetType: "researchOutput" \}/);
assert.match(outputConversionService, /sourceType:\s*"outputGap"[\s\S]*?targetType:\s*"outputCandidate"[\s\S]*?relationType:\s*"blocks"/);
assert.match(outputConversionService, /sourceType:\s*"resultItem"[\s\S]*?targetType:\s*"finding"[\s\S]*?relationType:\s*"evidence_for"/);
assert.match(selectorService, /outputConversionRelationService\.queryOutputConversionRelations/);
assert.doesNotMatch(sqliteRepository, /linked_finding_ids|linked_result_item_ids|formal_output_id|source_candidate_id/);

console.log("outputConversionRelationsPersistenceContract semantic test passed");
