import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const bundle = await build({
  entryPoints: [path.join(directory, "planningRepositoryEnvelope.ts")],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  target: "es2022"
});
const contract = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

const session = Object.freeze({
  processGeneration: "process-1",
  producerSessionGeneration: 1,
  transportGeneration: 1
});

function fixture(options = {}) {
  const values = new Map();
  let writes = 0;
  let epochIndex = 0;
  const epochs = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333"
  ];
  const storage = {
    getItem(key) {
      if (options.noStorage) return null;
      if (options.readBackMismatch && writes > 0) return "mismatch";
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      writes += 1;
      if (options.writeFailure) throw new Error("quota");
      values.set(key, value);
    }
  };
  const store = contract.createPlanningRepositoryEnvelopeStore({
    storageKey: "planning",
    getStorage: () => options.noStorage ? undefined : storage,
    createInitialSnapshot: async () => ({ value: "initial", items: [] }),
    normalizeSnapshot: (snapshot) => structuredClone(snapshot),
    isSnapshot: (value) =>
      typeof value === "object" &&
      value !== null &&
      typeof value.value === "string" &&
      Array.isArray(value.items),
    createRepositoryEpoch: () => epochs[epochIndex++]
  });
  return {
    store,
    values,
    storage,
    get writes() {
      return writes;
    }
  };
}

test("missing persisted state requires the registered writer and initializes one atomic envelope", async () => {
  const unbound = fixture();
  await assert.rejects(
    unbound.store.readEnvelope(),
    (error) => error.code === "PLANNING_REPOSITORY_WRITER_NOT_ACTIVE"
  );

  const bound = fixture();
  bound.store.activateWriter(session);
  const envelope = await bound.store.readEnvelope();
  assert.deepEqual(envelope, {
    envelopeVersion: 1,
    repositoryEpoch: "11111111-1111-4111-8111-111111111111",
    revision: "0",
    snapshot: { value: "initial", items: [] }
  });
  assert.equal(bound.writes, 1);
  assert.deepEqual(JSON.parse(bound.values.get("planning")), envelope);
});

test("an exact epoch and revision commit persists once and returns the bound identities", async () => {
  const current = fixture();
  current.store.activateWriter(session);
  const initial = await current.store.readEnvelope();
  const changed = await current.store.commitSnapshot(
    {
      expectedEpoch: initial.repositoryEpoch,
      expectedRevision: initial.revision,
      nextSnapshot: { value: "changed", items: [] }
    },
    session
  );
  assert.equal(changed.status, "committed");
  assert.deepEqual(changed.expectedIdentity, {
    repositoryEpoch: initial.repositoryEpoch,
    revision: "0"
  });
  assert.equal(changed.envelope.repositoryEpoch, initial.repositoryEpoch);
  assert.equal(changed.envelope.revision, "1");
  assert.deepEqual(changed.envelope.snapshot, { value: "changed", items: [] });
  assert.equal(current.writes, 2);
});

test("an exact unchanged candidate performs no write and keeps the revision stable", async () => {
  const current = fixture();
  current.store.activateWriter(session);
  const initial = await current.store.readEnvelope();
  const unchanged = await current.store.commitSnapshot(
    {
      expectedEpoch: initial.repositoryEpoch,
      expectedRevision: initial.revision,
      nextSnapshot: initial.snapshot
    },
    session
  );
  assert.equal(unchanged.status, "unchanged");
  assert.equal(unchanged.envelope.revision, "0");
  assert.equal(current.writes, 1);
});

test("an epoch mismatch is typed and performs zero writes", async () => {
  const current = fixture();
  current.store.activateWriter(session);
  const initial = await current.store.readEnvelope();
  const result = await current.store.commitSnapshot(
    {
      expectedEpoch: "22222222-2222-4222-8222-222222222222",
      expectedRevision: initial.revision,
      nextSnapshot: { value: "rejected", items: [] }
    },
    session
  );
  assert.deepEqual(result, {
    status: "epoch_mismatch",
    expectedIdentity: {
      repositoryEpoch: "22222222-2222-4222-8222-222222222222",
      revision: "0"
    },
    currentIdentity: {
      repositoryEpoch: initial.repositoryEpoch,
      revision: "0"
    }
  });
  assert.equal(current.writes, 1);
});

test("a stale revision is typed even when the candidate equals current persisted content", async () => {
  const current = fixture();
  current.store.activateWriter(session);
  const initial = await current.store.readEnvelope();
  const winner = await current.store.commitSnapshot(
    {
      expectedEpoch: initial.repositoryEpoch,
      expectedRevision: initial.revision,
      nextSnapshot: { value: "winner", items: [] }
    },
    session
  );
  assert.equal(winner.status, "committed");
  const stale = await current.store.commitSnapshot(
    {
      expectedEpoch: initial.repositoryEpoch,
      expectedRevision: initial.revision,
      nextSnapshot: { value: "winner", items: [] }
    },
    session
  );
  assert.equal(stale.status, "revision_stale");
  assert.deepEqual(stale.currentIdentity, {
    repositoryEpoch: initial.repositoryEpoch,
    revision: "1"
  });
  assert.equal(current.writes, 2);
});

test("concurrent calls serialize persisted revision admission", async () => {
  const current = fixture();
  current.store.activateWriter(session);
  const initial = await current.store.readEnvelope();
  const [first, second] = await Promise.all([
    current.store.commitSnapshot({
      expectedEpoch: initial.repositoryEpoch,
      expectedRevision: initial.revision,
      nextSnapshot: { value: "first", items: [] }
    }, session),
    current.store.commitSnapshot({
      expectedEpoch: initial.repositoryEpoch,
      expectedRevision: initial.revision,
      nextSnapshot: { value: "second", items: [] }
    }, session)
  ]);
  assert.deepEqual([first.status, second.status].sort(), ["committed", "revision_stale"]);
  const committed = first.status === "committed" ? first : second;
  const persisted = await current.store.readEnvelope();
  assert.equal(persisted.revision, "1");
  assert.deepEqual(persisted.snapshot, committed.envelope.snapshot);
  assert.equal(current.writes, 2);
});

test("legacy snapshots are not dual-read and malformed envelopes fail closed", async () => {
  const legacy = fixture();
  legacy.values.set("planning", JSON.stringify({ value: "legacy", items: ["old"] }));
  legacy.store.activateWriter(session);
  const rebuilt = await legacy.store.readEnvelope();
  assert.equal(rebuilt.snapshot.value, "initial");
  assert.equal(rebuilt.revision, "0");

  const malformed = fixture();
  malformed.values.set(
    "planning",
    JSON.stringify({
      envelopeVersion: 1,
      repositoryEpoch: "not-an-epoch",
      revision: "9",
      snapshot: { value: "untrusted", items: [] }
    })
  );
  malformed.store.activateWriter(session);
  await assert.rejects(
    malformed.store.readEnvelope(),
    (error) => error.code === "PLANNING_REPOSITORY_ENVELOPE_MALFORMED"
  );
});

test("storage absence, failed writes, and read-back mismatch never become memory authority", async () => {
  const unavailable = fixture({ noStorage: true });
  unavailable.store.activateWriter(session);
  await assert.rejects(
    unavailable.store.readEnvelope(),
    (error) => error.code === "PLANNING_REPOSITORY_STORAGE_UNAVAILABLE"
  );

  const writeFailure = fixture({ writeFailure: true });
  writeFailure.store.activateWriter(session);
  await assert.rejects(
    writeFailure.store.readEnvelope(),
    (error) => error.code === "PLANNING_REPOSITORY_WRITE_FAILED"
  );

  const mismatch = fixture({ readBackMismatch: true });
  mismatch.store.activateWriter(session);
  await assert.rejects(
    mismatch.store.readEnvelope(),
    (error) => error.code === "PLANNING_REPOSITORY_READ_BACK_MISMATCH"
  );
  await assert.rejects(
    mismatch.store.readEnvelope(),
    (error) => error.code === "PLANNING_REPOSITORY_ENVELOPE_MALFORMED"
  );
});

test("a replaced producer session rejects stale writer credentials", async () => {
  const { store } = fixture();
  store.activateWriter(session);
  await store.readEnvelope();
  const replacement = Object.freeze({
    processGeneration: "process-1",
    producerSessionGeneration: 2,
    transportGeneration: 2
  });
  store.activateWriter(replacement);
  await assert.rejects(
    store.commitSnapshot({
      expectedEpoch: "11111111-1111-4111-8111-111111111111",
      expectedRevision: "0",
      nextSnapshot: { value: "stale", items: [] }
    }, session),
    (error) => error.code === "PLANNING_REPOSITORY_WRITER_STALE"
  );
});
