import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const directory = path.dirname(fileURLToPath(import.meta.url));
const bundle = await build({
  stdin: {
    contents: `export * from "./formalSwitchCanonicalEnvelope.ts"; export * from "./formalSwitchRecoveryState.ts";`,
    resolveDir: directory,
    sourcefile: "formal-switch-foundation-behavior-entry.ts"
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  target: "es2022"
});
const runtime = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const golden = JSON.parse(readFileSync(path.resolve(directory, "../contracts/formalSwitchCanonicalEnvelopeEncodingV1.golden.json"), "utf8"));
const stateMatrix = JSON.parse(readFileSync(path.resolve(directory, "../contracts/formalSwitchRecoveryStateMatrixV1.json"), "utf8"));
const bytes = (hex) => Uint8Array.from(Buffer.from(hex, "hex"));
const b32 = (byte) => new Uint8Array(32).fill(byte);
const digest = (value) => createHash("sha256").update(value).digest("hex");

function fixture(kind) {
  const full = kind === "full";
  const operationId = full ? "op-科研-e\u0301-Ω" : "o";
  return {
    operationId,
    payloadVersion: 1n,
    canonicalEncodingVersion: "CanonicalEnvelopeEncodingV1",
    engineContractVersion: 1n,
    descriptorIdentity: full ? "review/primary/custom/v1" : "experiment/primary/v1",
    descriptorVersion: full ? 7n : 1n,
    descriptorHash: b32(full ? 0x11 : 0),
    candidateContractVersion: 1n,
    settlementPlanVersion: 1n,
    transactionPayloadVersion: 1n,
    recoveryPayloadVersion: 1n,
    ownerType: full ? "review" : "experiment",
    ownerId: full ? "review-科研" : "x",
    manuscriptChannel: "primary",
    entryKind: full ? "REPAIR_CONFIRMED_SWITCH" : "USER_CONFIRMED_SWITCH",
    ...(full ? { ownerSubtype: "custom" } : {}),
    oldCurrentFileRefIdentity: full ? "file-old-Ω" : "a",
    defaultFileRefIdentity: full ? "file-default-Ω" : "b",
    targetFileRefIdentity: full ? "file-target-Ω" : "c",
    oldCurrentLogicalSessionIdentity: full ? "review:old:current" : "d",
    targetLogicalSessionIdentity: full ? "review:target:current" : "e",
    candidate: {
      fileRefIdentity: full ? "file-target-Ω" : "c",
      physicalRevision: full ? "sha256:revision" : "r",
      sha256: b32(full ? 0x22 : 0),
      byteLength: full ? 4294967296n : 0n,
      encoding: "UTF-8"
    },
    replacementDto: full ? [
      { stableKey: "custom_summary", value: "科研 e\u0301 Ω" },
      { stableKey: "other", value: null }
    ] : [],
    ownerProtectedRowDigest: b32(full ? 0x33 : 0),
    bindingDigest: b32(full ? 0x44 : 0),
    lifecycleCoverageDigest: b32(full ? 0x55 : 0),
    oldCurrentExpectedPhysicalRevision: full ? "old-revision-精确" : "s",
    settlementPlan: {
      byteStart: full ? 3n : 0n,
      byteEnd: full ? 9223372036854775808n : 0n,
      expectedWholeFileHash: b32(full ? 0x66 : 0),
      expectedControlledRegionPreimageHash: b32(full ? 0x77 : 0),
      replacementBytes: full ? bytes("00ff0a0d") : new Uint8Array(),
      expectedWholeFilePostHash: b32(full ? 0x88 : 0),
      bomState: full ? "UTF8_BOM" : "ABSENT",
      lineEndingPolicy: "PRESERVE_SNAPSHOT_EXACT",
      boundaryNewlineOwnership: full ? "BOTH" : "NONE",
      writeOnceOperationId: operationId
    },
    transactionPayload: full ? bytes("010203feff") : new Uint8Array(),
    successOperationLogId: full ? "log-科研" : "l",
    formalSwitchOperationId: operationId,
    activationLogicalIdentity: full ? "activation-Ω" : "f",
    finalizationIdentity: full ? "finalization-Ω" : "g",
    operationCustodyIdentity: full ? "custody-Ω" : "h",
    createdAtEpochMs: full ? -9223372036854775808n : 0n
  };
}

test("CanonicalEnvelopeEncodingV1 TypeScript bytes and SHA match literal Rust-shared vectors", async () => {
  assert.equal(runtime.validateCanonicalEnvelopeRegistry(), true);
  for (const [index, name] of ["minimal", "full"].entries()) {
    const semantic = fixture(name);
    const encoded = runtime.encodeFormalSwitchImmutableEnvelopeV1(semantic);
    assert.equal(Buffer.from(encoded).toString("hex"), golden.envelopes[index].expectedHex);
    assert.equal(digest(encoded), golden.envelopes[index].expectedSha256Hex);
    assert.deepEqual(runtime.verifyCanonicalEnvelopeBytes(encoded), semantic);
    assert.equal(Buffer.from(await runtime.sha256CanonicalBytes(encoded)).toString("hex"), golden.envelopes[index].expectedSha256Hex);
  }
});

test("all canonical primitive, boundary, absence, null, Unicode and map-order vectors are literal", () => {
  const values = [
    { kind: "absent" }, null, false, true, "", "e\u0301科研Ω",
    { kind: "i64", value: -9223372036854775808n },
    { kind: "i64", value: 9223372036854775807n },
    { kind: "u64", value: 18446744073709551615n },
    new Uint8Array(), [],
    { kind: "map", entries: { "Ω": { kind: "u64", value: 1n }, a: "A", "é": "E" } },
    { kind: "map", entries: { "é": "E", "Ω": { kind: "u64", value: 1n }, a: "A" } },
    [null, true, "x"],
    { kind: "object", fields: [["outer", { kind: "object", fields: [["n", { kind: "u64", value: 1n }], ["z", null]] }]] }
  ];
  for (const [index, semantic] of values.entries()) {
    const encoded = runtime.encodeCanonicalValue(semantic);
    assert.equal(Buffer.from(encoded).toString("hex"), golden.values[index].expectedHex);
    assert.equal(digest(encoded), golden.values[index].expectedSha256Hex);
  }
  assert.throws(
    () => runtime.encodeCanonicalValue({ kind: "object", fields: [["x", null], ["x", null]] }),
    /CANONICAL_DUPLICATE_FIELD/u
  );
  for (const vector of golden.negative.filter((candidate) => candidate.inputHex)) {
    assert.throws(
      () => runtime.decodeFormalSwitchImmutableEnvelopeV1(bytes(vector.inputHex)),
      new RegExp(vector.expectedFailure, "u")
    );
  }
});

test("all owner/channel/review identities are representable and invalid combinations fail closed", () => {
  const identities = [
    ...["experiment", "experimentRun", "resultItem", "finding", "outputCandidate", "outputGap", "researchOutput"]
      .map((ownerType) => ({ ownerType, manuscriptChannel: "primary" })),
    { ownerType: "literature", manuscriptChannel: "literature_outline" },
    { ownerType: "literature", manuscriptChannel: "dedicated_notes" },
    ...["stage", "periodic", "experiment_comparison", "literature_comparison", "custom"]
      .map((ownerSubtype) => ({ ownerType: "review", manuscriptChannel: "primary", ownerSubtype }))
  ];
  for (const [index, identity] of identities.entries()) {
    const semantic = { ...fixture("minimal"), ...identity, operationId: `typed-${index}` };
    semantic.formalSwitchOperationId = semantic.operationId;
    semantic.settlementPlan = { ...semantic.settlementPlan, writeOnceOperationId: semantic.operationId };
    assert.deepEqual(runtime.verifyCanonicalEnvelopeBytes(runtime.encodeFormalSwitchImmutableEnvelopeV1(semantic)), semantic);
  }
  for (const invalid of [
    { ownerType: "literature", manuscriptChannel: "primary" },
    { ownerType: "experiment", manuscriptChannel: "literature_outline" },
    { ownerType: "review", manuscriptChannel: "primary" },
    { ownerType: "experiment", manuscriptChannel: "primary", ownerSubtype: "custom" },
    { ownerType: "unknown", manuscriptChannel: "primary" },
    { ownerType: "experiment", manuscriptChannel: "unknown" },
    { ownerType: "experiment", manuscriptChannel: "primary", entryKind: "UNKNOWN" }
  ]) {
    assert.throws(() => runtime.encodeFormalSwitchImmutableEnvelopeV1({ ...fixture("minimal"), ...invalid }), /CANONICAL_/u);
  }
});

test("the single recovery matrix validates transition legality and unresolved-slot policy", () => {
  assert.equal(runtime.validateFormalSwitchRecoveryStateMatrix(), true);
  const prepared = runtime.initialFormalSwitchRecoveryState();
  const cancelled = {
    phase: "cancelled_safe", settlementOutcome: "UNKNOWN", dbOutcome: "NOT_APPLIED",
    activationOutcome: "PENDING", terminalCode: "CANCELLED_SAFE"
  };
  assert.deepEqual(runtime.validateFormalSwitchRecoveryTransition(prepared, cancelled), cancelled);
  assert.equal(runtime.occupiesFormalSwitchUnresolvedSlot(prepared), true);
  assert.equal(runtime.occupiesFormalSwitchUnresolvedSlot(cancelled), false);
  assert.throws(() => runtime.validateFormalSwitchRecoveryTransition(prepared, {
    phase: "resolved", settlementOutcome: "NOT_REQUIRED", dbOutcome: "COMMITTED",
    activationOutcome: "APPLIED", terminalCode: "RESOLVED"
  }), /FORMAL_SWITCH_STATE_TRANSITION_FORBIDDEN/u);
  for (const transition of stateMatrix.transitions) {
    const settlementOutcome = transition.settlement[0];
    const dbOutcome = transition.db[0];
    const activationOutcome = transition.activation[0];
    const currentByPhase = {
      prepared,
      settlement_started: { phase: "settlement_started", settlementOutcome: "UNKNOWN", dbOutcome: "NOT_APPLIED", activationOutcome: "PENDING", terminalCode: null },
      settlement_complete: { phase: "settlement_complete", settlementOutcome, dbOutcome: "NOT_APPLIED", activationOutcome: "PENDING", terminalCode: null },
      db_pending: { phase: "db_pending", settlementOutcome, dbOutcome: "NOT_APPLIED", activationOutcome: "PENDING", terminalCode: null },
      db_complete: { phase: "db_complete", settlementOutcome, dbOutcome, activationOutcome: "PENDING", terminalCode: null },
      activation_pending: { phase: "activation_pending", settlementOutcome, dbOutcome, activationOutcome: "PENDING", terminalCode: null }
    };
    const next = {
      phase: transition.to, settlementOutcome, dbOutcome, activationOutcome,
      terminalCode: transition.terminalCode
    };
    assert.deepEqual(runtime.validateFormalSwitchRecoveryTransition(currentByPhase[transition.from], next), next);
  }
});
