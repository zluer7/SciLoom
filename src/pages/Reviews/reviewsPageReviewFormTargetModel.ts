import type { ReviewTargetInput, ReviewTargetSummary } from "../../services/planningService";
import type { Experiment, ExperimentRun } from "../../types/experiment";
import type { Literature } from "../../types/literature";
import type { ReviewType } from "../../types/planning";

export type ReviewFormTargetState = {
  routeNodeIds: string[];
  taskIds: string[];
  experimentIds: string[];
  experimentRunIds: string[];
  literatureIds: string[];
};

export type ReviewTargetOptionModel = {
  experiments: Experiment[];
  experimentRuns: ExperimentRun[];
  literatures: Literature[];
};

export const EMPTY_REVIEW_FORM_TARGET_STATE: ReviewFormTargetState = {
  routeNodeIds: [],
  taskIds: [],
  experimentIds: [],
  experimentRunIds: [],
  literatureIds: []
};

function uniqueIds(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function buildReviewFormTargetState(
  targets: ReviewTargetSummary[]
): ReviewFormTargetState {
  const activeTargets = targets.filter((target) => !target.missing);
  return {
    routeNodeIds: uniqueIds(
      activeTargets
        .filter((target) => target.targetType === "routeNode")
        .map((target) => target.targetId)
    ),
    taskIds: uniqueIds(
      activeTargets
        .filter((target) => target.targetType === "task")
        .map((target) => target.targetId)
    ),
    experimentIds: uniqueIds(
      activeTargets
        .filter((target) => target.targetType === "experiment")
        .map((target) => target.targetId)
    ),
    experimentRunIds: uniqueIds(
      activeTargets
        .filter((target) => target.targetType === "experimentRun")
        .map((target) => target.targetId)
    ),
    literatureIds: uniqueIds(
      activeTargets
        .filter((target) => target.targetType === "literature")
        .map((target) => target.targetId)
    )
  };
}

export function buildReviewTargets(
  form: ReviewFormTargetState
): ReviewTargetInput[] {
  return [
    ...uniqueIds(form.routeNodeIds).map((targetId) => ({
      targetType: "routeNode" as const,
      targetId
    })),
    ...uniqueIds(form.taskIds).map((targetId) => ({
      targetType: "task" as const,
      targetId
    })),
    ...uniqueIds(form.experimentIds).map((targetId) => ({
      targetType: "experiment" as const,
      targetId
    })),
    ...uniqueIds(form.experimentRunIds).map((targetId) => ({
      targetType: "experimentRun" as const,
      targetId
    })),
    ...uniqueIds(form.literatureIds).map((targetId) => ({
      targetType: "literature" as const,
      targetId
    }))
  ];
}

export function buildReviewProjectTargetOptions(
  projectId: string,
  experiments: Experiment[],
  runs: ExperimentRun[],
  projectScopedLiteratures: Literature[]
): ReviewTargetOptionModel {
  const projectExperiments = experiments.filter(
    (experiment) => experiment.projectId === projectId && !experiment.deletedAt
  );
  const experimentIds = new Set(projectExperiments.map((experiment) => experiment.id));
  return {
    experiments: projectExperiments,
    experimentRuns: runs.filter(
      (run) =>
        !run.deletedAt &&
        experimentIds.has(run.experimentId) &&
        (!run.projectId || run.projectId === projectId)
    ),
    literatures: projectScopedLiteratures.filter(
      (literature) =>
        !literature.deletedAt &&
        (!literature.primaryProjectId || literature.primaryProjectId === projectId)
    )
  };
}

export function getReviewComparisonValidationMessage(
  reviewType: ReviewType,
  form: ReviewFormTargetState,
  language: "zh-CN" | "en-US"
) {
  if (
    reviewType === "experiment_comparison" &&
    uniqueIds([...form.experimentIds, ...form.experimentRunIds]).length < 2
  ) {
    return language === "zh-CN"
      ? "实验对比复盘至少需要选择 2 个实验或 Run。"
      : "Experiment comparison reviews require at least 2 experiments or runs.";
  }
  if (reviewType === "literature_comparison" && uniqueIds(form.literatureIds).length < 2) {
    return language === "zh-CN"
      ? "文献对比复盘至少需要选择 2 篇文献。"
      : "Literature comparison reviews require at least 2 literature records.";
  }
  return "";
}

export function mapReviewTargetContractError(
  error: unknown,
  language: "zh-CN" | "en-US"
) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("experiment_comparison requires at least 2")) {
    return language === "zh-CN"
      ? "实验对比复盘至少需要选择 2 个实验或 Run。"
      : "Experiment comparison reviews require at least 2 experiments or runs.";
  }
  if (message.includes("literature_comparison requires at least 2")) {
    return language === "zh-CN"
      ? "文献对比复盘至少需要选择 2 篇文献。"
      : "Literature comparison reviews require at least 2 literature records.";
  }
  if (
    message.includes("must belong to project") ||
    message.includes("target is missing") ||
    message.includes("target contract violation")
  ) {
    return language === "zh-CN"
      ? "存在跨课题、已失效或不可关联的复盘对象，请重新选择。"
      : "Some review targets are cross-project, missing, or unavailable. Select them again.";
  }
  return "";
}
