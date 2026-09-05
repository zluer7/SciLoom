import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const bundle = await build({
  stdin: {
    contents: `
      export {
        toLiteratureCreateInput,
        toLiteratureUpdateInput,
        validateLiteratureProject
      } from "./literatureService.ts";
    `,
    resolveDir: directory,
    sourcefile: "literature-optional-project-harness.ts"
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  target: "es2022"
});
const contract = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

const existing = {
  id: "literature-1",
  title: "Existing",
  authors: [],
  keywords: [],
  externalIds: [],
  readingStatus: "unread",
  primaryProjectId: "project-1",
  tags: [],
  isArchived: false,
  archivedAt: null,
  schemaVersion: 1,
  source: "user",
  customFields: [],
  createdAt: "2026-08-06T00:00:00.000Z",
  updatedAt: "2026-08-06T00:00:00.000Z"
};

test("create maps omitted or null Project to the formal null state", () => {
  assert.equal(
    contract.toLiteratureCreateInput({ title: "No project" }).primaryProjectId,
    null
  );
  assert.equal(
    contract.toLiteratureCreateInput({ title: "No project", primaryProjectId: null }).primaryProjectId,
    null
  );
  assert.equal(
    contract.toLiteratureCreateInput({ title: "With project", primaryProjectId: "project-1" }).primaryProjectId,
    "project-1"
  );
});

test("update distinguishes omitted Project, explicit null and a replacement Project", () => {
  assert.equal(contract.toLiteratureUpdateInput(existing, { title: "Omitted" }).primaryProjectId, "project-1");
  assert.equal(contract.toLiteratureUpdateInput(existing, { primaryProjectId: null }).primaryProjectId, null);
  assert.equal(
    contract.toLiteratureUpdateInput(existing, { primaryProjectId: "project-2" }).primaryProjectId,
    "project-2"
  );
});

test("validation accepts null/omitted, validates non-null, and rejects empty or unavailable IDs", async () => {
  let reads = 0;
  const loadProject = async (id) => {
    reads += 1;
    return id === "project-1" ? { id, deletedAt: null } : undefined;
  };
  assert.equal(await contract.validateLiteratureProject(undefined, loadProject), undefined);
  assert.equal(await contract.validateLiteratureProject(null, loadProject), undefined);
  assert.equal(reads, 0);
  assert.equal((await contract.validateLiteratureProject("project-1", loadProject)).id, "project-1");
  await assert.rejects(
    contract.validateLiteratureProject("", loadProject),
    /cannot be empty/u
  );
  await assert.rejects(
    contract.validateLiteratureProject("fake-project", loadProject),
    /Project not found/u
  );
});
