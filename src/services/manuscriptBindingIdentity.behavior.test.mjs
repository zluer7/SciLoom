import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const bundle = await build({
  stdin: {
    contents: `
      export * from "./manuscriptBindingIdentityResolver.ts";
      export * from "../types/manuscriptBindingIdentity.ts";
    `,
    resolveDir: directory,
    sourcefile: "manuscript-binding-identity-harness.ts"
  },
  plugins: [{
    name: "stub-tauri-core",
    setup(esbuild) {
      esbuild.onResolve(
        { filter: /^@tauri-apps\/api\/core$/u },
        () => ({ path: "tauri-core", namespace: "stub" })
      );
      esbuild.onLoad(
        { filter: /.*/u, namespace: "stub" },
        () => ({
          contents: "export async function invoke() { throw new Error('UNEXPECTED_TAURI_CALL'); }"
        })
      );
    }
  }],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  target: "es2022"
});
const contract = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

const {
  MANUSCRIPT_BINDING_IDENTITY_ERROR_CODES,
  createManuscriptBindingIdentityResolver
} = contract;

const ownerCases = [
  ["experiment", "primary"],
  ["experimentRun", "primary"],
  ["review", "primary"],
  ["literature", "literature_outline"],
  ["literature", "dedicated_notes"],
  ["resultItem", "primary"],
  ["finding", "primary"],
  ["outputCandidate", "primary"],
  ["outputGap", "primary"],
  ["researchOutput", "primary"]
];

function records(ownerType = "review", manuscriptChannel = "primary") {
  const ownerId = `${ownerType}-owner`;
  const binding = {
    id: `${ownerType}-${manuscriptChannel}-binding`,
    ownerType,
    ownerId,
    manuscriptChannel,
    defaultFolderFileRefId: `${ownerType}-folder`,
    defaultManuscriptFileRefId: `${ownerType}-${manuscriptChannel}-default`,
    currentFileRefId: `${ownerType}-${manuscriptChannel}-current`,
    schemaVersion: 2,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    deletedAt: null
  };
  return {
    binding,
    fileRefs: [
      {
        id: binding.defaultFolderFileRefId,
        ownerType,
        ownerId,
        manuscriptChannel: ownerType === "literature" ? "literature_outline" : manuscriptChannel,
        resourceKind: "folder",
        fileRole: "defaultFolder",
        locationMode: "managed",
        deletedAt: null
      },
      {
        id: binding.defaultManuscriptFileRefId,
        ownerType,
        ownerId,
        manuscriptChannel,
        resourceKind: "file",
        fileRole: "manuscript",
        locationMode: "managed",
        deletedAt: null
      },
      {
        id: binding.currentFileRefId,
        ownerType,
        ownerId,
        manuscriptChannel,
        resourceKind: "file",
        fileRole: "manuscript",
        locationMode: "external",
        deletedAt: null
      }
    ]
  };
}

function resolverFor(readIdentityRecords) {
  return createManuscriptBindingIdentityResolver({ readIdentityRecords });
}

test("one authoritative read resolves every frozen owner/channel without path or FS", async () => {
  for (const [ownerType, manuscriptChannel] of ownerCases) {
    let reads = 0;
    const fixture = records(ownerType, manuscriptChannel);
    const resolve = resolverFor(async () => {
      reads += 1;
      return fixture;
    });
    const result = await resolve({
      ownerType,
      ownerId: fixture.binding.ownerId,
      manuscriptChannel,
      ownerScope: { status: "active", source: "test-owner" }
    });
    assert.equal(result.status, "resolved");
    assert.equal(result.identityResolved, true);
    assert.equal(result.provenance.readMode, "authoritative-read-only");
    assert.equal(result.provenance.availability, "not-checked");
    assert.equal(result.provenance.fallback, "none");
    assert.equal(reads, 1);
    assert.equal("path" in result.slots.currentFileRefId.fileRef, false);
    assert.equal("availabilityStatus" in result.slots.currentFileRefId.fileRef, false);
  }
});

test("missing physical resource cannot affect identity because resolver never receives path state", async () => {
  const fixture = records();
  const resolve = resolverFor(async () => fixture);
  const result = await resolve({
    ownerType: "review",
    ownerId: "review-owner",
    manuscriptChannel: "primary",
    ownerScope: { status: "active", source: "test-owner" }
  });
  assert.equal(result.identityResolved, true);
  assert.equal(result.provenance.availability, "not-checked");
});

test("no binding and unknown owner scope are explicit and do not write or fallback", async () => {
  let reads = 0;
  const resolve = resolverFor(async () => {
    reads += 1;
    return { binding: undefined, fileRefs: [] };
  });
  const result = await resolve({
    ownerType: "review",
    ownerId: "missing",
    manuscriptChannel: "primary"
  });
  assert.equal(result.status, "not-found");
  assert.equal(result.identityResolved, false);
  assert.deepEqual(result.errors, [MANUSCRIPT_BINDING_IDENTITY_ERROR_CODES.bindingNotFound]);
  assert.deepEqual(result.warnings, [MANUSCRIPT_BINDING_IDENTITY_ERROR_CODES.ownerScopeUnknown]);
  assert.equal(reads, 1);
});

test("caller lifecycle scope is ignored and never becomes identity authority", async () => {
  const fixture = records();
  const resolve = resolverFor(async () => fixture);
  for (const status of ["active", "deleted", "unknown"]) {
    const result = await resolve({
      ownerType: "review",
      ownerId: "review-owner",
      manuscriptChannel: "primary",
      ownerScope: { status, source: "caller" }
    });
    assert.equal(result.identityResolved, true);
    assert.equal(result.ownerScope.status, "unknown");
    assert.deepEqual(
      result.warnings,
      [MANUSCRIPT_BINDING_IDENTITY_ERROR_CODES.ownerScopeUnknown]
    );
  }
});

test("required slots and each FileRef identity dimension return stable errors", async () => {
  const cases = [
    ["required slot", (fixture) => { fixture.binding.currentFileRefId = null; }, "requiredSlotMissing"],
    ["metadata missing", (fixture) => { fixture.fileRefs.pop(); }, "fileRefNotFound"],
    ["metadata deleted", (fixture) => { fixture.fileRefs[2].deletedAt = "2026-01-02"; }, "fileRefDeleted"],
    ["owner", (fixture) => { fixture.fileRefs[2].ownerId = "other"; }, "ownerMismatch"],
    ["channel", (fixture) => { fixture.fileRefs[2].manuscriptChannel = "dedicated_notes"; }, "channelMismatch"],
    ["kind", (fixture) => { fixture.fileRefs[2].resourceKind = "folder"; }, "resourceKindMismatch"],
    ["role", (fixture) => { fixture.fileRefs[2].fileRole = "attachment"; }, "fileRoleMismatch"],
    ["location", (fixture) => { fixture.fileRefs[1].locationMode = "external"; }, "locationModeMismatch"]
  ];
  for (const [label, mutate, codeKey] of cases) {
    const fixture = records();
    mutate(fixture);
    const resolve = resolverFor(async () => fixture);
    const result = await resolve({
      ownerType: "review",
      ownerId: "review-owner",
      manuscriptChannel: "primary",
      ownerScope: { status: "active", source: "test" }
    });
    assert.equal(result.status, "invalid", label);
    assert.equal(result.identityResolved, false, label);
    assert.ok(result.errors.includes(MANUSCRIPT_BINDING_IDENTITY_ERROR_CODES[codeKey]), label);
  }
});

test("Literature channels remain independent while a managed folder may be shared", async () => {
  const outline = records("literature", "literature_outline");
  const notes = records("literature", "dedicated_notes");
  notes.binding.defaultFolderFileRefId = outline.binding.defaultFolderFileRefId;
  notes.fileRefs[0] = outline.fileRefs[0];
  const resolve = resolverFor(async (_ownerType, _ownerId, channel) =>
    channel === "literature_outline" ? outline : notes
  );
  const [outlineResult, notesResult] = await Promise.all([
    resolve({ ownerType: "literature", ownerId: "literature-owner", manuscriptChannel: "literature_outline" }),
    resolve({ ownerType: "literature", ownerId: "literature-owner", manuscriptChannel: "dedicated_notes" })
  ]);
  assert.equal(outlineResult.identityResolved, true);
  assert.equal(notesResult.identityResolved, true);
  assert.equal(
    outlineResult.slots.defaultFolderFileRefId.fileRefId,
    notesResult.slots.defaultFolderFileRefId.fileRefId
  );
  assert.notEqual(
    outlineResult.slots.currentFileRefId.fileRefId,
    notesResult.slots.currentFileRefId.fileRefId
  );
});
