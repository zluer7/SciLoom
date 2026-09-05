import assert from "node:assert/strict";

const numericSchemaConstantPattern =
  /(?:pub(?:\(crate\))?\s+)?const\s+([A-Z][A-Z0-9_]*SCHEMA_VERSION):\s*i64\s*=\s*(\d+);/gu;
const currentSchemaAuthorityPattern =
  /pub\s+const\s+CURRENT_SCHEMA_VERSION:\s*i64\s*=\s*([A-Z][A-Z0-9_]*SCHEMA_VERSION);/gu;

export function assertHistoricalSchemaMilestone(
  schemaSource,
  milestoneConstant,
  milestoneVersion
) {
  const constants = new Map();
  for (const match of schemaSource.matchAll(numericSchemaConstantPattern)) {
    assert.equal(
      constants.has(match[1]),
      false,
      `schema constant must be unique: ${match[1]}`
    );
    constants.set(match[1], Number(match[2]));
  }

  assert.equal(constants.get(milestoneConstant), milestoneVersion);

  const currentAuthorities = [...schemaSource.matchAll(currentSchemaAuthorityPattern)];
  assert.equal(currentAuthorities.length, 1, "CURRENT_SCHEMA_VERSION must have one authority");
  const currentAuthority = currentAuthorities[0][1];
  assert.equal(constants.has(currentAuthority), true, "current schema authority must resolve to a declared milestone");
  const currentVersion = constants.get(currentAuthority);
  assert.ok(currentVersion >= milestoneVersion);
  assert.notEqual(
    currentAuthority,
    milestoneConstant,
    "the historical milestone must not overwrite the current schema authority"
  );

  const declaredVersions = new Set(constants.values());
  for (let version = milestoneVersion; version <= currentVersion; version += 1) {
    assert.equal(
      declaredVersions.has(version),
      true,
      `schema milestone chain must retain version ${version}`
    );
  }

  return { currentAuthority, currentVersion };
}
