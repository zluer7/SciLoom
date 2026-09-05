import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const serviceDirectory = path.dirname(fileURLToPath(import.meta.url));
const bundle = await build({
  stdin: {
    contents: `
      export * from "./writeFeedbackDisplayService.ts";
      export * from "./quickAnalysisFeedbackService.ts";
      export * from "./quickAnalysisFeedbackPresentation.ts";
    `,
    resolveDir: serviceDirectory,
    sourcefile: "write-feedback-ownership-harness.ts"
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2022",
  plugins: [
    {
      name: "quick-analysis-coordinator-test-port",
      setup(buildContext) {
        buildContext.onResolve(
          { filter: /^\.\/quickAnalysisCoordinator$/u },
          () => ({
            path: "quick-analysis-coordinator-test-port",
            namespace: "c1-test"
          })
        );
        buildContext.onLoad(
          { filter: /.*/u, namespace: "c1-test" },
          () => ({
            contents: `
              export const quickAnalysisCoordinator = {
                subscribe() { return () => {}; }
              };
            `,
            loader: "ts"
          })
        );
      }
    }
  ]
});
const contract = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

function reset() {
  for (const entry of contract.getWriteFeedbackEntries()) {
    contract.dismissWriteFeedback(entry.id);
  }
}

function createQuickAnalysisFeedbackHarness() {
  let listener;
  const pushed = [];
  const owner = contract.createQuickAnalysisFeedbackOwner({
    coordinator: {
      subscribe(nextListener) {
        listener = nextListener;
        return () => {
          if (listener === nextListener) listener = undefined;
        };
      }
    },
    push(feedback) {
      pushed.push(feedback);
    }
  });
  owner.start();
  return {
    pushed,
    emit(snapshot) {
      assert.ok(listener, "Quick Analysis feedback owner must be subscribed");
      listener(snapshot);
    },
    stop() {
      owner.stop();
    }
  };
}

function quickAnalysisSnapshot(overrides = {}) {
  const runId = overrides.runId ?? "quick-run-a";
  return {
    key: "experiment:experiment-a:primary",
    runId,
    ownerType: "experiment",
    ownerId: "experiment-a",
    channel: "primary",
    projectId: "project-a",
    phase: "POST_PUBLISH_READBACK",
    terminalState: "RUNNING",
    startedAt: "2026-09-04T12:00:00.000Z",
    updatedAt: "2026-09-04T12:00:01.000Z",
    conversationId: `conversation-${runId}`,
    quickAnalysisCallAttemptIds: [`attempt-${runId}`],
    acquiredKeyReleaseCount: 0,
    ...overrides
  };
}

function successfulQuickAnalysisSnapshot(runId, acquiredKeyReleaseCount) {
  return quickAnalysisSnapshot({
    runId,
    phase: "TERMINAL",
    terminalState: "SUCCEEDED",
    candidateFileRefId: `candidate-${runId}`,
    candidateTerminalCommitState: "POST_PUBLISH_READBACK_CONFIRMED",
    acquiredKeyReleaseCount
  });
}

function primaryPageMessage(feedback) {
  return feedback.summary || feedback.title;
}

test("Quick Analysis internal progress remains unprojected without mutating its snapshot", () => {
  const harness = createQuickAnalysisFeedbackHarness();
  const snapshot = quickAnalysisSnapshot();
  const before = structuredClone(snapshot);

  harness.emit(snapshot);

  assert.equal(harness.pushed.length, 0);
  assert.deepEqual(snapshot, before);
  harness.stop();
});

test("Quick Analysis success is concise, once per run, and allowed for a later run", () => {
  const harness = createQuickAnalysisFeedbackHarness();
  harness.emit(successfulQuickAnalysisSnapshot("quick-run-a", 0));
  harness.emit(successfulQuickAnalysisSnapshot("quick-run-a", 1));

  assert.equal(harness.pushed.length, 1);
  assert.equal(primaryPageMessage(harness.pushed[0]), "AI分析完成，已创建候选文稿。");
  assert.equal(harness.pushed[0].severity, "success");
  assert.deepEqual(harness.pushed[0].details, []);
  assert.doesNotMatch(
    [
      harness.pushed[0].title,
      harness.pushed[0].summary ?? "",
      ...(harness.pushed[0].details ?? [])
    ].join(" "),
    /FileRef|Binding|readback|POST_PUBLISH_READBACK|quick-run|attempt-|conversation-/u
  );

  harness.emit(successfulQuickAnalysisSnapshot("quick-run-b", 0));
  harness.emit(successfulQuickAnalysisSnapshot("quick-run-b", 1));
  assert.equal(harness.pushed.length, 2);
  assert.equal(primaryPageMessage(harness.pushed[1]), "AI分析完成，已创建候选文稿。");
  harness.stop();
});

test("Quick Analysis actionable failures remain user-facing through the safe projector", () => {
  const harness = createQuickAnalysisFeedbackHarness();
  const retriableFailure = quickAnalysisSnapshot({
    phase: "TERMINAL",
    terminalState: "FAILED",
    errorCode: "NETWORK_TIMEOUT",
    errorMessage: "raw provider transport diagnostic"
  });

  harness.emit(retriableFailure);
  assert.equal(harness.pushed.length, 1);
  assert.equal(
    harness.pushed[0].summary,
    contract.projectQuickAnalysisFailureSummary(retriableFailure)
  );
  assert.match(primaryPageMessage(harness.pushed[0]), /检查网络后重试/u);
  assert.doesNotMatch(
    primaryPageMessage(harness.pushed[0]),
    /NETWORK_TIMEOUT|raw provider transport diagnostic/u
  );

  const nonRetriableReadbackFailure = quickAnalysisSnapshot({
    runId: "quick-run-readback",
    phase: "TERMINAL",
    terminalState: "SUCCEEDED"
  });
  harness.emit(nonRetriableReadbackFailure);
  assert.equal(harness.pushed.length, 2);
  assert.equal(
    harness.pushed[1].summary,
    "AI分析已停止：候选文稿的写入结果未能安全确认，请先检查本页状态。"
  );
  assert.doesNotMatch(primaryPageMessage(harness.pushed[1]), /重试/u);
  harness.stop();
});

test("Quick Analysis unknown outcome remains actionable and is never mapped to success", () => {
  const harness = createQuickAnalysisFeedbackHarness();
  const unknown = quickAnalysisSnapshot({
    phase: "TERMINAL",
    terminalState: "TERMINAL_EFFECT_OUTCOME_UNKNOWN",
    errorCode: "TERMINAL_EFFECT_OUTCOME_UNKNOWN",
    errorMessage: "raw uncertain effect diagnostic"
  });

  harness.emit(unknown);

  assert.equal(harness.pushed.length, 1);
  assert.equal(harness.pushed[0].severity, "warning");
  assert.equal(
    harness.pushed[0].summary,
    contract.projectQuickAnalysisFailureSummary(unknown)
  );
  assert.match(primaryPageMessage(harness.pushed[0]), /无法确认.*停止自动重试/u);
  assert.doesNotMatch(
    primaryPageMessage(harness.pushed[0]),
    /分析完成|已创建候选文稿|raw uncertain effect diagnostic/u
  );
  harness.stop();
});

test("owner feedback is visible only to the exact page, project, owner, and channel", () => {
  reset();
  contract.pushPageFeedback({
    severity: "error",
    title: "Outline unavailable",
    operation: "literature.outline.open",
    scope: {
      classification: "owner",
      page: "literature",
      projectId: "project-a",
      ownerType: "literature",
      ownerId: "literature-a",
      channel: "literature_outline"
    }
  });

  const exact = {
    page: "literature",
    projectId: "project-a",
    ownerKeys: ["literature:literature-a:literature_outline"]
  };
  assert.equal(contract.selectWriteFeedbackEntries(exact).length, 1);
  assert.equal(contract.selectWriteFeedbackEntries({ ...exact, page: "reviews" }).length, 0);
  assert.equal(contract.selectWriteFeedbackEntries({ ...exact, projectId: "project-b" }).length, 0);
  assert.equal(
    contract.selectWriteFeedbackEntries({
      ...exact,
      ownerKeys: ["literature:literature-b:literature_outline"]
    }).length,
    0
  );
  assert.equal(
    contract.selectWriteFeedbackEntries({
      ...exact,
      ownerKeys: ["literature:literature-a:dedicated_notes"]
    }).length,
    0
  );
});

test("canonical dedupe identity includes scope and suppresses only same-surface duplicates", () => {
  reset();
  for (const ownerId of ["experiment-a", "experiment-b"]) {
    const scope = {
      classification: "owner",
      page: "experiments",
      projectId: "project-a",
      ownerType: "experiment",
      ownerId
    };
    contract.pushPageFeedback({
      severity: "warning",
      title: "Workspace incomplete",
      operation: "experiment.manuscript.provisioningIncomplete",
      dedupeKey: "manuscript-incomplete",
      scope
    });
    contract.pushPageFeedback({
      severity: "warning",
      title: "Retry still blocked",
      operation: "experiment.manuscript.retryProvisioning",
      dedupeKey: "manuscript-incomplete",
      scope
    });
  }

  assert.equal(contract.getWriteFeedbackEntries().length, 2);
  assert.equal(
    contract.selectWriteFeedbackEntries({
      page: "experiments",
      projectId: "project-a",
      ownerKeys: ["experiment:experiment-a:"]
    }).length,
    1
  );
  assert.equal(
    contract.selectWriteFeedbackEntries({
      page: "experiments",
      projectId: "project-a",
      ownerKeys: ["experiment:experiment-b:"]
    }).length,
    1
  );
});

test("write feedback derives exact owner scope and project feedback stays project-local", () => {
  reset();
  const fallback = {
    classification: "action-local",
    page: "outputs",
    projectId: "project-a"
  };
  contract.pushWriteFeedback({
    status: "error",
    operation: "output.finding.update",
    affectedEntities: [{ type: "finding", id: "finding-a" }],
    affectedScopes: [{ module: "output", projectId: "project-a" }],
    refreshKeys: [],
    messages: [],
    warnings: [],
    errors: ["failed"],
    skipped: []
  }, fallback);
  assert.equal(
    contract.selectWriteFeedbackEntries({
      page: "outputs",
      projectId: "project-a",
      ownerKeys: ["finding:finding-a:"]
    }).length,
    1
  );
  assert.equal(
    contract.selectWriteFeedbackEntries({
      page: "outputs",
      projectId: "project-a",
      ownerKeys: ["finding:finding-b:"]
    }).length,
    0
  );

  contract.pushPageFeedback({
    severity: "warning",
    title: "Project refresh failed",
    scope: { classification: "project", page: "outputs", projectId: "project-b" }
  });
  assert.equal(
    contract.selectWriteFeedbackEntries({ page: "outputs", projectId: "project-b" }).length,
    1
  );
  assert.equal(
    contract.selectWriteFeedbackEntries({ page: "outputs", projectId: "project-a" }).length,
    0
  );
});

test("action-local feedback cannot cross pages and global typed issues remain visible", () => {
  reset();
  contract.pushPageFeedback({
    severity: "success",
    title: "Saved",
    scope: { classification: "action-local", page: "reviews", actionKind: "save" }
  });
  assert.equal(contract.selectWriteFeedbackEntries({ page: "reviews" }).length, 1);
  assert.equal(contract.selectWriteFeedbackEntries({ page: "literature" }).length, 0);

  contract.pushPageFeedback({
    severity: "error",
    title: "Database unavailable",
    scope: {
      classification: "global",
      source: "sqlite",
      systemClassification: "DATABASE_UNAVAILABLE"
    }
  });
  assert.equal(contract.selectWriteFeedbackEntries({ page: "reviews" }).length, 2);
  assert.equal(contract.selectWriteFeedbackEntries({ page: "literature" }).length, 1);
});

test("duplicate subscription delivery does not duplicate the same projection", () => {
  reset();
  const input = {
    severity: "warning",
    title: "Reload warning",
    operation: "review.reload",
    reason: "refresh",
    scope: { classification: "action-local", page: "reviews" }
  };
  contract.pushPageFeedback(input);
  contract.pushPageFeedback(input);
  assert.equal(contract.selectWriteFeedbackEntries({ page: "reviews" }).length, 1);
});

test("a successful retry resolves the prior error only for the exact action scope", () => {
  reset();
  const scopeA = {
    classification: "owner",
    page: "reviews",
    ownerType: "review",
    ownerId: "review-a"
  };
  const scopeB = { ...scopeA, ownerId: "review-b" };
  contract.pushPageFeedback({
    severity: "error",
    title: "Save failed",
    operation: "review.manuscript.save",
    scope: scopeA
  });
  contract.pushPageFeedback({
    severity: "error",
    title: "Other owner failed",
    operation: "review.manuscript.save",
    scope: scopeB
  });
  contract.pushPageFeedback({
    severity: "success",
    title: "Saved",
    operation: "review.manuscript.save",
    scope: scopeA
  });

  const ownerA = contract.selectWriteFeedbackEntries({
    page: "reviews",
    ownerKeys: ["review:review-a:"]
  });
  const ownerB = contract.selectWriteFeedbackEntries({
    page: "reviews",
    ownerKeys: ["review:review-b:"]
  });
  assert.deepEqual(ownerA.map((entry) => [entry.severity, entry.title]), [["success", "Saved"]]);
  assert.deepEqual(ownerB.map((entry) => [entry.severity, entry.title]), [["error", "Other owner failed"]]);
});

test("unrelated page traffic cannot evict an exact-owner error", () => {
  reset();
  contract.pushPageFeedback({
    severity: "error",
    title: "Owner error",
    scope: {
      classification: "owner",
      page: "experiments",
      ownerType: "experiment",
      ownerId: "experiment-a"
    }
  });
  for (let index = 0; index < 10; index += 1) {
    contract.pushPageFeedback({
      severity: "info",
      title: `Review action ${index}`,
      scope: { classification: "action-local", page: "reviews" }
    });
  }
  assert.equal(
    contract.selectWriteFeedbackEntries({
      page: "experiments",
      ownerKeys: ["experiment:experiment-a:"]
    })[0]?.title,
    "Owner error"
  );
  assert.equal(contract.selectWriteFeedbackEntries({ page: "reviews" }).length, 5);
});

test("obvious successful editor open is retained but suppressed from page panels", () => {
  reset();
  const scope = {
    classification: "owner",
    page: "reviews",
    projectId: "project-a",
    ownerType: "review",
    ownerId: "review-a",
    channel: "primary"
  };
  contract.pushPageFeedback({
    severity: "success",
    title: "复盘文稿已打开。",
    operation: "review.manuscript.openCurrent",
    scope
  });
  const [success] = contract.selectWriteFeedbackEntries({
    page: "reviews",
    projectId: "project-a",
    ownerKeys: ["review:review-a:primary"]
  });
  assert.equal(success.formalCrudTerminalPresentation, "suppress");

  contract.pushPageFeedback({
    severity: "error",
    title: "复盘文稿无法打开。",
    operation: "review.manuscript.openCurrent",
    scope
  });
  const [failure] = contract.selectWriteFeedbackEntries({
    page: "reviews",
    projectId: "project-a",
    ownerKeys: ["review:review-a:primary"]
  });
  assert.notEqual(failure.formalCrudTerminalPresentation, "suppress");
  assert.equal(failure.severity, "error");
});
