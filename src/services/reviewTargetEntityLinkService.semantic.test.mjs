import {
  queryReviewTargetSummariesFromSnapshot,
  replaceReviewTargetLinksInSnapshot,
  validateReviewTargetContractInSnapshot
} from "./reviewTargetEntityLinkService.ts";

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Review target EntityLink semantic test failed: ${message}`);
  }
}

function assertRejects(action, expectedMessage, message) {
  try {
    action();
  } catch (error) {
    const actual = error instanceof Error ? error.message : String(error);
    assert(
      actual.includes(expectedMessage),
      `${message}; expected "${expectedMessage}", got "${actual}"`
    );
    return;
  }
  throw new Error(`Review target EntityLink semantic test failed: ${message}; action did not reject`);
}

function snapshot() {
  const timestamp = "2026-07-02T00:00:00.000Z";
  return {
    review: {
      id: "review-1",
      projectId: "project-1",
      title: "Review",
      reviewType: "stage",
      outlineSections: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      tags: [],
      source: "user",
      schemaVersion: 1
    },
    summaries: {
      project: {
        "project-1": { title: "Project 1", status: "active" }
      },
      routeNode: {
        "route-1": { title: "Route 1", status: "active", projectId: "project-1" }
      },
      task: {
        "task-1": { title: "Task 1", status: "doing", projectId: "project-1" }
      },
      experiment: {
        "experiment-1": { title: "Experiment 1", status: "running", projectId: "project-1" },
        "experiment-other": { title: "Experiment Other", status: "running", projectId: "project-2" }
      },
      experimentRun: {
        "run-1": {
          title: "Run 1",
          status: "completed",
          projectId: "project-1",
          experimentId: "experiment-1"
        }
      },
      literature: {
        "literature-1": { title: "Literature 1", status: "reading", projectId: "project-1" },
        "literature-2": { title: "Literature 2", status: "summarized", projectId: "project-1" }
      }
    },
    links: [
      {
        id: "old-task-link",
        sourceType: "review",
        sourceId: "review-1",
        targetType: "task",
        targetId: "task-1",
        relationType: "summarizes",
        createdAt: timestamp,
        updatedAt: timestamp,
        schemaVersion: 1
      },
      {
        id: "non-target-link",
        sourceType: "review",
        sourceId: "review-1",
        targetType: "outputGap",
        targetId: "gap-1",
        relationType: "related_to",
        createdAt: timestamp,
        updatedAt: timestamp,
        schemaVersion: 1
      }
    ],
    timestamp
  };
}

const base = snapshot();

assertRejects(
  () =>
    validateReviewTargetContractInSnapshot(base.review, [
      { targetType: "project", targetId: "project-1" }
    ], base.summaries),
  "Project target must be expressed by Review.projectId",
  "project targets must be rejected by the EntityLink writer"
);
assertRejects(
  () =>
    validateReviewTargetContractInSnapshot(base.review, [
      { targetType: "route_node", targetId: "route-1" }
    ], base.summaries),
  "not supported",
  "route_node alias must be rejected"
);
assertRejects(
  () =>
    validateReviewTargetContractInSnapshot(base.review, [
      { targetType: "outputGap", targetId: "gap-1" }
    ], base.summaries),
  "not supported",
  "OutputGap must be rejected as a formal target"
);
assertRejects(
  () =>
    validateReviewTargetContractInSnapshot(base.review, [
      { targetType: "experiment", targetId: "experiment-other" }
    ], base.summaries),
  "must belong to project project-1",
  "cross-project targets must be rejected"
);
assertRejects(
  () =>
    validateReviewTargetContractInSnapshot(
      { ...base.review, reviewType: "experiment_comparison" },
      [{ targetType: "experiment", targetId: "experiment-1" }],
      base.summaries
    ),
  "at least 2 Experiment or ExperimentRun targets",
  "experiment_comparison must require at least two experiment-like targets"
);
assertRejects(
  () =>
    validateReviewTargetContractInSnapshot(
      { ...base.review, reviewType: "literature_comparison" },
      [{ targetType: "literature", targetId: "literature-1" }],
      base.summaries
    ),
  "at least 2 Literature targets",
  "literature_comparison must require at least two literature targets"
);

const validTargets = [
  { targetType: "routeNode", targetId: "route-1" },
  { targetType: "task", targetId: "task-1" },
  { targetType: "experiment", targetId: "experiment-1" },
  { targetType: "experimentRun", targetId: "run-1" },
  { targetType: "literature", targetId: "literature-1" },
  { targetType: "literature", targetId: "literature-2" },
  { targetType: "task", targetId: "task-1" }
];
const validation = validateReviewTargetContractInSnapshot(
  { ...base.review, reviewType: "custom" },
  validTargets,
  base.summaries
);
assert(validation.normalizedTargets.length === 6, "writer validation must deduplicate targets");

const replacedLinks = replaceReviewTargetLinksInSnapshot(
  base.links,
  base.review.id,
  validation.normalizedTargets,
  base.timestamp
);
assert(
  replacedLinks.some((link) => link.id === "non-target-link"),
  "replacement must preserve non-formal links"
);
assert(
  !replacedLinks.some(
    (link) =>
      link.sourceType === "review" &&
      link.sourceId === base.review.id &&
      link.targetType === "project"
  ),
  "replacement must never write a Review -> Project summarizes EntityLink"
);
assert(
  replacedLinks.filter(
    (link) =>
      link.sourceType === "review" &&
      link.sourceId === base.review.id &&
      link.relationType === "summarizes"
  ).length === 6,
  "replacement must create one summarizes link per normalized non-project target"
);

const summaries = queryReviewTargetSummariesFromSnapshot(
  base.review,
  replacedLinks,
  base.summaries
);
assert(
  summaries.some((target) => target.targetType === "project" && target.targetId === "project-1"),
  "query must synthesize Project from Review.projectId"
);
assert(
  summaries.filter((target) => target.targetType === "task" && target.targetId === "task-1")
    .length === 1,
  "query must deduplicate formal target summaries"
);
assert(
  !summaries.some((target) => target.targetType === "outputGap"),
  "query must not expose OutputGap as a formal target"
);
