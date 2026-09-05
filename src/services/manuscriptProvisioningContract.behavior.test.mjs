import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const directory = path.dirname(fileURLToPath(import.meta.url));
const bundle = await build({
  stdin: {
    contents: `
      export * from "./manuscriptProvisioningContract.ts";
      export * from "../types/manuscriptProvisioning.ts";
    `,
    resolveDir: directory,
    sourcefile: "manuscript-provisioning-contract-harness.ts"
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

const {
  FILE_REF_DELETED_IDENTITY_ERROR_CODE,
  MANUSCRIPT_PROVISIONING_OWNER_CHANNEL_CONTRACTS,
  MANUSCRIPT_PROVISIONING_PHASES,
  buildManuscriptProvisioningKey,
  classifyManuscriptProvisioningIssue,
  combineManuscriptReadiness,
  createCompletedManuscriptProvisioningResult,
  createOwnerCreateFailed,
  createOwnerCreated,
  evaluateExperimentRunParentPlacementReadiness,
  evaluateLiteratureProvisioningAggregate,
  evaluateManuscriptResourceReadiness,
  isManuscriptProvisioningMutationIntent
} = contract;

const checkedAt = "2026-07-23T00:00:00.000Z";

function fact(kind, state = "ready") {
  return {
    kind,
    state,
    checkedAt,
    provenance: {
      source: "contract-test",
      mode: "authoritative-read-only",
      contentReadScope: "metadata-only",
      markdownBytesRead: 0
    }
  };
}

function allReadyFacts(descriptor) {
  const kinds = new Set(Object.values(descriptor.mandatoryFacts).flat());
  return Object.fromEntries([...kinds].map((kind) => [kind, fact(kind)]));
}

function completedProvisioning(key, readiness) {
  return createCompletedManuscriptProvisioningResult({
    operationId: "operation-1",
    key,
    intent: "create-default",
    verifiedCapability: "default-resource",
    readiness,
    presentationStale: false,
    provenance: ["contract-test"],
    startedAt: checkedAt,
    updatedAt: checkedAt
  });
}

test("the owner/channel matrix freezes all ten contracts in migration order", () => {
  assert.equal(MANUSCRIPT_PROVISIONING_OWNER_CHANNEL_CONTRACTS.length, 10);
  assert.deepEqual(
    MANUSCRIPT_PROVISIONING_OWNER_CHANNEL_CONTRACTS.map((item) => [
      item.ownerType,
      item.manuscriptChannel,
      item.defaultFilename,
      item.migrationOrder
    ]),
    [
      ["experiment", "primary", "experiment.md", 1],
      ["experimentRun", "primary", "experiment-run.md", 2],
      ["review", "primary", "review.md", 3],
      ["resultItem", "primary", "result-item.md", 4],
      ["finding", "primary", "finding.md", 4],
      ["outputCandidate", "primary", "output-candidate.md", 4],
      ["outputGap", "primary", "output-gap.md", 4],
      ["researchOutput", "primary", "research-output.md", 4],
      ["literature", "literature_outline", "literature-outline.md", 5],
      ["literature", "dedicated_notes", "dedicated-notes.md", 5]
    ]
  );
  const run = MANUSCRIPT_PROVISIONING_OWNER_CHANNEL_CONTRACTS[1];
  assert.equal(run.parentPlacement, "experiment-default-folder");
  assert.doesNotMatch(JSON.stringify(run.mandatoryFacts), /parent-default-manuscript/u);
  const literature = MANUSCRIPT_PROVISIONING_OWNER_CHANNEL_CONTRACTS.slice(-2);
  assert.ok(literature.every((item) => item.sharedFolderGroup === "literature"));
  assert.ok(MANUSCRIPT_PROVISIONING_OWNER_CHANNEL_CONTRACTS.every(
    (item) => item.trigger === "create-time"
  ));
});

test("resource keys reject owner/channel mismatch and mutation intents exclude inspection", () => {
  assert.deepEqual(buildManuscriptProvisioningKey({
    ownerType: "review",
    ownerId: "review-1",
    manuscriptChannel: "primary"
  }), {
    ownerType: "review",
    ownerId: "review-1",
    manuscriptChannel: "primary"
  });
  assert.throws(
    () => buildManuscriptProvisioningKey({
      ownerType: "literature",
      ownerId: "literature-1",
      manuscriptChannel: "primary"
    }),
    /LITERATURE_MANUSCRIPT_CHANNEL_REQUIRED/u
  );
  assert.equal(isManuscriptProvisioningMutationIntent("inspect-readiness"), false);
  assert.equal(isManuscriptProvisioningMutationIntent("create-default"), true);
  assert.equal(isManuscriptProvisioningMutationIntent("retry"), true);
  assert.equal(isManuscriptProvisioningMutationIntent("repair"), true);
  assert.equal(isManuscriptProvisioningMutationIntent("recover"), true);
});

test("readiness preserves not-verified and keeps default/current/read/write separate", () => {
  assert.equal(combineManuscriptReadiness([]), "not-verified");
  assert.equal(combineManuscriptReadiness([fact("a")]), "ready");
  assert.equal(
    combineManuscriptReadiness([fact("a"), fact("b", "not-verified")]),
    "not-verified"
  );
  assert.equal(
    combineManuscriptReadiness([fact("a", "not-ready"), fact("b", "not-verified")]),
    "not-ready"
  );

  const descriptor = MANUSCRIPT_PROVISIONING_OWNER_CHANNEL_CONTRACTS.find(
    (item) => item.ownerType === "review"
  );
  const facts = allReadyFacts(descriptor);
  facts["write-permission"] = fact("write-permission", "not-verified");
  facts["current-manuscript-exists"] = fact("current-manuscript-exists", "not-ready");
  const readiness = evaluateManuscriptResourceReadiness(
    descriptor,
    "inspect-readiness",
    facts
  );
  assert.deepEqual(readiness, {
    intent: "inspect-readiness",
    readReady: "not-ready",
    writeReady: "not-verified",
    defaultResourceReady: "ready",
    currentResourceReady: "not-ready"
  });
  assert.equal(facts["write-permission"].provenance.markdownBytesRead, 0);
});

test("completed requires the intent-specific verified capability to be ready", () => {
  const key = buildManuscriptProvisioningKey({
    ownerType: "review",
    ownerId: "review-1",
    manuscriptChannel: "primary"
  });
  const base = {
    operationId: "operation-completion",
    key,
    intent: "create-default",
    verifiedCapability: "default-resource",
    presentationStale: false,
    provenance: ["contract-test"],
    startedAt: checkedAt,
    updatedAt: checkedAt
  };
  assert.throws(
    () => createCompletedManuscriptProvisioningResult({
      ...base,
      readiness: {
        intent: "create-default",
        readReady: "ready",
        writeReady: "not-verified",
        defaultResourceReady: "not-verified",
        currentResourceReady: "ready"
      }
    }),
    /MANUSCRIPT_PROVISIONING_REQUIRED_CAPABILITY_NOT_READY/u
  );
  assert.throws(
    () => createCompletedManuscriptProvisioningResult({
      ...base,
      readiness: {
        intent: "inspect-readiness",
        readReady: "ready",
        writeReady: "ready",
        defaultResourceReady: "ready",
        currentResourceReady: "ready"
      }
    }),
    /MANUSCRIPT_PROVISIONING_READINESS_INTENT_MISMATCH/u
  );
  const completed = createCompletedManuscriptProvisioningResult({
    ...base,
    readiness: {
      intent: "create-default",
      readReady: "ready",
      writeReady: "not-verified",
      defaultResourceReady: "ready",
      currentResourceReady: "not-ready"
    }
  });
  assert.equal(completed.status, "completed");
  assert.equal(completed.verifiedCapability, "default-resource");
  assert.equal(completed.verifiedCapabilityReadiness, "ready");
});

test("error taxonomy preserves cause codes and never repairs blocked or lifecycle facts", () => {
  const deleted = classifyManuscriptProvisioningIssue({
    kind: "deleted-file-ref-identity",
    causeCode: FILE_REF_DELETED_IDENTITY_ERROR_CODE
  });
  assert.deepEqual(deleted, {
    classification: "lifecycle-decision-required",
    code: FILE_REF_DELETED_IDENTITY_ERROR_CODE,
    originalCauseCode: FILE_REF_DELETED_IDENTITY_ERROR_CODE,
    retryable: false,
    nextAction: "lifecycle-decision"
  });
  assert.equal(
    classifyManuscriptProvisioningIssue({
      kind: "canonical-resource-missing",
      causeCode: "DEFAULT_MANUSCRIPT_MISSING"
    }).classification,
    "repair-required"
  );
  for (const kind of [
    "wrong-type",
    "path-conflict",
    "symlink-escape",
    "unknown-existing-file",
    "non-empty-existing-file",
    "ownership-unconfirmed",
    "non-canonical-artifact"
  ]) {
    const issue = classifyManuscriptProvisioningIssue({ kind, causeCode: `CAUSE_${kind}` });
    assert.equal(issue.classification, "blocked", kind);
    assert.equal(issue.retryable, false, kind);
    assert.equal(issue.nextAction, "stop", kind);
  }
  assert.equal(
    classifyManuscriptProvisioningIssue({
      kind: "physical-only-partial",
      causeCode: "PHYSICAL_CREATED"
    }).classification,
    "provisioning-recovery-required"
  );
  assert.equal(
    classifyManuscriptProvisioningIssue({
      kind: "transient",
      causeCode: "TEMPORARY_BUSY"
    }).classification,
    "retryable"
  );
});

test("create outcome first discriminates owner creation from provisioning", () => {
  const ownerFailure = createOwnerCreateFailed({
    code: "OWNER_CREATE_FAILED",
    message: "owner was not committed"
  });
  assert.deepEqual(ownerFailure, {
    status: "owner-create-failed",
    error: { code: "OWNER_CREATE_FAILED", message: "owner was not committed" }
  });
  assert.equal("owner" in ownerFailure, false);
  assert.equal("provisioning" in ownerFailure, false);

  const descriptor = MANUSCRIPT_PROVISIONING_OWNER_CHANNEL_CONTRACTS[2];
  const facts = allReadyFacts(descriptor);
  const readiness = evaluateManuscriptResourceReadiness(
    descriptor,
    "create-default",
    facts
  );
  const key = buildManuscriptProvisioningKey({
    ownerType: "review",
    ownerId: "review-1",
    manuscriptChannel: "primary"
  });
  const owner = { id: "review-1", title: "review" };
  const created = createOwnerCreated(owner, completedProvisioning(key, readiness));
  assert.equal(created.status, "owner-created");
  assert.equal(created.owner, owner);
  assert.equal(created.provisioning.status, "completed");
});

test("Run parent placement readiness never depends on the parent manuscript", () => {
  const run = MANUSCRIPT_PROVISIONING_OWNER_CHANNEL_CONTRACTS.find(
    (item) => item.ownerType === "experimentRun"
  );
  const facts = allReadyFacts(run);
  assert.equal(evaluateExperimentRunParentPlacementReadiness(facts), "ready");
  facts["parent-default-folder-no-escape"] = fact(
    "parent-default-folder-no-escape",
    "not-verified"
  );
  assert.equal(evaluateExperimentRunParentPlacementReadiness(facts), "not-verified");
  facts["parent-default-folder-actual-type"] = fact(
    "parent-default-folder-actual-type",
    "not-ready"
  );
  assert.equal(evaluateExperimentRunParentPlacementReadiness(facts), "not-ready");
});

function literatureChild(channel, overrides = {}) {
  return {
    channel,
    state: "completed",
    operationId: `operation-${channel}`,
    defaultResourceReadiness: "ready",
    finalVerification: "passed",
    issues: [],
    ...overrides
  };
}

test("Literature aggregate keeps child state independent and retries only unfinished channels", () => {
  const base = {
    aggregateOperationId: "literature-operation",
    ownerId: "literature-1",
    sharedFolderIdentity: fact("shared-folder-identity-match"),
    children: {
      literature_outline: literatureChild("literature_outline"),
      dedicated_notes: literatureChild("dedicated_notes")
    }
  };
  assert.deepEqual(evaluateLiteratureProvisioningAggregate(base), {
    status: "completed",
    retryChannels: [],
    issues: []
  });

  const notesIssue = classifyManuscriptProvisioningIssue({
    kind: "multi-channel-partial",
    causeCode: "NOTES_INCOMPLETE"
  });
  const partial = evaluateLiteratureProvisioningAggregate({
    ...base,
    children: {
      ...base.children,
      dedicated_notes: literatureChild("dedicated_notes", {
        state: "failed",
        defaultResourceReadiness: "not-ready",
        finalVerification: "not-passed",
        issues: [notesIssue]
      })
    }
  });
  assert.equal(partial.status, "provisioning-recovery-required");
  assert.deepEqual(partial.retryChannels, ["dedicated_notes"]);
  assert.deepEqual(partial.issues, [notesIssue]);

  const lifecycleIssue = classifyManuscriptProvisioningIssue({
    kind: "owner-deleted",
    causeCode: "PROVISIONING_OWNER_DELETED"
  });
  const lifecycle = evaluateLiteratureProvisioningAggregate({
    ...base,
    children: {
      ...base.children,
      literature_outline: literatureChild("literature_outline", {
        state: "failed",
        issues: [lifecycleIssue]
      })
    }
  });
  assert.equal(lifecycle.status, "lifecycle-decision-required");
  assert.deepEqual(lifecycle.issues, [lifecycleIssue]);
});

test("phase vocabulary is unique and contains no schema or executor phase", () => {
  assert.deepEqual(MANUSCRIPT_PROVISIONING_PHASES, [
    "preflight",
    "inspection",
    "physical-create-or-reuse",
    "file-ref-register",
    "binding-write",
    "authoritative-readback",
    "final-verification",
    "completed",
    "blocked",
    "partial",
    "failed"
  ]);
  assert.doesNotMatch(JSON.stringify(MANUSCRIPT_PROVISIONING_PHASES), /schema|migration|enable/u);
});
