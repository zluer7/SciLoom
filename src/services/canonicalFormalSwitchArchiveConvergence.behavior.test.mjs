import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..", "..");
const bundle = await build({
  stdin: {
    contents: [
      'export * from "./services/canonicalFormalSwitchArchiveConvergence.ts";',
      'export * from "./services/manuscriptStructuredOutlineArchive.ts";',
      'export * from "./services/manuscriptOutlineDescriptorRegistry.ts";'
    ].join("\n"),
    resolveDir: resolve(root, "src"),
    sourcefile: "f5-5-archive-convergence-harness.ts"
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  target: "es2022"
});
const subject = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

const identity = { ownerType: "experiment", channel: "primary" };
const begin = subject.structuredOutlineArchiveBeginMarker;
const end = subject.structuredOutlineArchiveEndMarker;

test("F5-5 Formal Switch parses only a UNIQUE Archive interior and empties NONE or ambiguity", () => {
  const descriptor = subject.MANUSCRIPT_OUTLINE_DESCRIPTOR_REGISTRY[0].descriptors[0];
  const unique = subject.serializeCanonicalStructuredOutlineArchive({
    descriptor,
    values: {
      purposeAndQuestion: "inside-only",
      conditionSummary: "condition"
    },
    humanHint: "target"
  });
  const parsed = subject.buildCanonicalFormalSwitchArchiveCandidate({
    rawMarkdown: `outside must be ignored\n${unique}\noutside tail`,
    descriptorLookupIdentity: identity
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.archiveIdentityTerminal, "UNIQUE");
  assert.equal(
    parsed.orderedReplacementDto.orderedReplacements[0].value,
    "inside-only"
  );

  for (const [rawMarkdown, terminal] of [
    ["ordinary target body", "NONE"],
    [`${unique}\n${unique}`, "MULTIPLE_OR_AMBIGUOUS"]
  ]) {
    const empty = subject.buildCanonicalFormalSwitchArchiveCandidate({
      rawMarkdown,
      descriptorLookupIdentity: identity
    });
    assert.equal(empty.ok, true);
    assert.equal(empty.archiveIdentityTerminal, terminal);
    assert.ok(
      empty.orderedReplacementDto.orderedReplacements.every(
        (replacement) => replacement.action === "clear"
      )
    );
  }
});

test("F5-5 switch-away settlement preserves BODY bytes and leaves exactly one canonical Archive", () => {
  const old = [
    "\ufeffBODY-A\r\n",
    `${begin("stale")}\r\n`,
    "stale interior remains BODY\r\n",
    `${end()}\r\n`,
    "BODY-B-without-final-newline"
  ].join("");
  const settled = subject.buildCanonicalFormalSwitchOldCurrentSettlement({
    currentRawMarkdown: old,
    descriptorLookupIdentity: identity,
    currentStructuredValues: {
      purposeAndQuestion: "question",
      conditionSummary: "condition",
      methodSummary: "method",
      resultSummary: "result",
      conclusionAndNextSteps: "next",
      other: "other"
    }
  });
  assert.equal(settled.existingBodyMutationCount, 0);
  assert.equal(settled.removedStaleMarkerLineCount, 2);
  assert.ok(settled.expectedPostText.startsWith(
    "\ufeffBODY-A\r\nstale interior remains BODY\r\nBODY-B-without-final-newline\r\n"
  ));
  const archive = subject.resolveStructuredOutlineArchiveIdentity(
    new TextEncoder().encode(settled.expectedPostText)
  );
  assert.equal(archive.terminal, "UNIQUE");
  assert.equal(archive.exactBeginMarkerCount, 1);
  assert.equal(archive.exactEndMarkerCount, 1);
});

test("F5-5 target cleanup freezes exact marker-line spans and no other byte", () => {
  const rawMarkdown = `BODY-1\n${begin("target")}\narchive interior\n${end()}\nBODY-2`;
  const plan = subject.buildCanonicalFormalSwitchTargetCleanupPlan({
    rawMarkdown,
    expectedRevision: "target-r1"
  });
  assert.equal(plan.cleanupRequired, true);
  assert.equal(plan.expectedRevision, "target-r1");
  assert.deepEqual(
    plan.exactMarkerSpans.map((span) => span.markerKind),
    ["BEGIN", "END"]
  );
  assert.equal(plan.expectedPostText, "BODY-1\narchive interior\nBODY-2");
});
