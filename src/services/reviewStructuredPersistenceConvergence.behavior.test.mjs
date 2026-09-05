import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const bundle = await build({
  entryPoints: [path.join(directory, "planningRepository.ts")],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  target: "es2022"
});
const repository = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

function review() {
  return {
    id: "review-1",
    projectId: "project-1",
    title: "Review",
    description: "first layer",
    tags: ["tag"],
    reviewType: "custom",
    outlineSections: [
      { key: "custom_summary", content: "canonical" },
      { key: "completed_items", content: "done" },
      { key: "major_problems", content: "problem" },
      { key: "cause_analysis", content: "cause" },
      { key: "next_plan", content: "next" },
      { key: "other", content: "other" }
    ],
    structuredRevision: 7,
    descriptorIdentity: "review/primary/custom/v1",
    structuredLifecycleEvidence: "review-lifecycle/v1:none",
    structuredLifecycleStatus: "active",
    source: "user",
    schemaVersion: 3,
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z"
  };
}

const secondLayerKeys = [
  "reviewType",
  "outlineSections",
  "structuredRevision",
  "descriptorIdentity",
  "structuredLifecycleEvidence",
  "structuredLifecycleStatus"
];

test("Planning persistence sanitizer physically removes every Review second-layer field", () => {
  const persisted = repository.normalizePlanningPersistenceData({ reviews: [review()] });
  assert.equal(persisted.reviews.length, 1);
  for (const key of secondLayerKeys) {
    assert.equal(Object.hasOwn(persisted.reviews[0], key), false, key);
  }
  assert.equal(persisted.reviews[0].id, "review-1");
  assert.equal(persisted.reviews[0].projectId, "project-1");
  assert.equal(persisted.reviews[0].title, "Review");
  assert.deepEqual(persisted.reviews[0].tags, ["tag"]);
});

test("composed Review DTO and update patch cannot round-trip second-layer state into Planning", () => {
  const persistedRecord = repository.stripReviewSecondLayerFields(review());
  const persistedPatch = repository.stripReviewSecondLayerPatch({
    ...review(),
    title: "Updated first layer"
  });
  for (const value of [persistedRecord, persistedPatch]) {
    for (const key of secondLayerKeys) {
      assert.equal(Object.hasOwn(value, key), false, key);
    }
  }
  assert.equal(persistedPatch.title, "Updated first layer");
});

test("legacy second-layer bytes migrate once, are scrubbed, and SQLite remains the composed read authority", async () => {
  const values = new Map();
  const structuredStates = new Map();
  let migrationCalls = 0;
  const storage = {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    }
  };
  globalThis.window = {
    localStorage: storage,
    dispatchEvent() {},
    __TAURI_INTERNALS__: {
      async invoke(command, args) {
        if (command === "owner_authority_try_acquire_many") {
          return {
            token: `lease-${args.requestId}`,
            requestId: args.requestId,
            holderKind: "callerBound",
            registryGeneration: "f3-4-test",
            requests: structuredClone(args.requests)
          };
        }
        if (command === "owner_authority_validate") {
          return { valid: true, registryGeneration: "f3-4-test" };
        }
        if (command === "owner_authority_release") {
          return { released: true };
        }
        if (command === "migrate_review_structured_states") {
          migrationCalls += 1;
          return args.inputs.map((input) => {
            if (!structuredStates.has(input.reviewId)) {
              structuredStates.set(input.reviewId, {
                ...structuredClone(input),
                descriptorIdentity: `review/primary/${input.reviewType}/v1`,
                structuredRevision: 0,
                lifecycleEvidence: "review-lifecycle/v1:none",
                lifecycleStatus: "active",
                createdAt: "2026-08-10T00:00:00.000Z",
                updatedAt: "2026-08-10T00:00:00.000Z"
              });
            }
            return structuredClone(structuredStates.get(input.reviewId));
          });
        }
        if (command === "read_review_structured_states") {
          return args.reviewIds.flatMap((reviewId) => {
            const state = structuredStates.get(reviewId);
            return state ? [structuredClone(state)] : [];
          });
        }
        throw new Error(`unexpected Review structured command: ${command}`);
      }
    }
  };

  const timestamp = "2026-08-10T00:00:00.000Z";
  const snapshot = repository.createEmptyPlanningData(timestamp);
  snapshot.projects.push({
    id: "project-1",
    title: "Project",
    tags: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    source: "user",
    schemaVersion: 1,
    status: "active",
    priority: "medium",
    orderIndex: 0
  });
  snapshot.reviews.push(review());
  values.set(repository.PLANNING_STORAGE_KEY, JSON.stringify({
    envelopeVersion: 1,
    repositoryEpoch: "11111111-1111-4111-8111-111111111111",
    revision: "0",
    snapshot
  }));
  const session = Object.freeze({
    processGeneration: "f3-4-convergence-test",
    producerSessionGeneration: 1,
    transportGeneration: 1
  });
  repository.activatePlanningRepositoryProducerWriter(session);

  const converged = await repository.getPlanningRepositoryEnvelope();
  assert.equal(migrationCalls, 1);
  assert.equal(converged.snapshot.reviews[0].reviewType, "custom");
  assert.equal(converged.snapshot.reviews[0].outlineSections[0].content, "canonical");
  assert.equal(converged.snapshot.reviews[0].structuredRevision, 0);

  const scrubbed = JSON.parse(values.get(repository.PLANNING_STORAGE_KEY));
  assert.equal(scrubbed.revision, "1");
  for (const key of secondLayerKeys) {
    assert.equal(Object.hasOwn(scrubbed.snapshot.reviews[0], key), false, key);
  }

  await repository.updateReview("review-1", {
    title: "First layer changed",
    reviewType: "stage",
    outlineSections: [{ key: "stage_summary", content: "must not persist" }],
    structuredRevision: 99,
    descriptorIdentity: "review/primary/stage/v1",
    structuredLifecycleEvidence: "forged",
    structuredLifecycleStatus: "active"
  });
  const afterFullDtoPatch = JSON.parse(values.get(repository.PLANNING_STORAGE_KEY));
  assert.equal(afterFullDtoPatch.snapshot.reviews[0].title, "First layer changed");
  for (const key of secondLayerKeys) {
    assert.equal(Object.hasOwn(afterFullDtoPatch.snapshot.reviews[0], key), false, key);
  }
  const composedAgain = await repository.getPlanningRepositoryEnvelope();
  assert.equal(composedAgain.snapshot.reviews[0].reviewType, "custom");
  assert.equal(composedAgain.snapshot.reviews[0].outlineSections[0].content, "canonical");
  assert.equal(migrationCalls, 1, "scrubbed bytes must not trigger a second migration");
  repository.revokePlanningRepositoryProducerWriter(session);
});
