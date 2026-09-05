import type {
  CustomField,
  EntityId,
  Experiment,
  ExperimentRun,
  OutputSourceSummary,
  OutputSourceType,
  ResultItem,
  ResultItemType,
  ResultMetric
} from "../types";
import type { StructuredSummary } from "../types/outputStructuredSummary";
import {
  createDefaultStructuredSummary,
  normalizeStructuredSummary
} from "../types/outputStructuredSummary";
import { experimentRunService } from "./experimentRunService";
import { experimentService } from "./experimentService";
import { outputConversionService } from "./outputConversionService";
import { createOutputSourceLink } from "./outputSourceLinkService";
import {
  countActiveResultItemsByOutputSource,
  getOutputSourceSummary
} from "./outputSourceSelectorService";
import { resultMetricService } from "./resultMetricService";

export type ExperimentOutputGenerationTrigger =
  | "experiment"
  | "experimentRun"
  | "resultMetric";

export type ExperimentOutputGenerationSourceType = Extract<
  OutputSourceType,
  "experiment" | "experimentRun"
>;

export type ExperimentOutputGenerationMetricContext = {
  metricId: EntityId;
  name: string;
  value: string;
  unit?: string;
  description?: string;
  metricGroup?: string;
  sourceResolution: "experimentRun" | "experiment";
};

export type ExperimentOutputGenerationDraft = {
  trigger: ExperimentOutputGenerationTrigger;
  triggerId: EntityId;
  sourceType: ExperimentOutputGenerationSourceType;
  sourceId: EntityId;
  sourceTitle: string;
  sourceSummarySnapshot: string;
  metricContext?: ExperimentOutputGenerationMetricContext;
  resultItemTitle: string;
  summary: string;
  structuredSummary: StructuredSummary;
  sourceNote: string;
  resultType: ResultItemType;
  duplicateHint?: string;
};

export type ExperimentOutputGenerationCreateInput = {
  confirmedByUser: boolean;
  resultItemTitle: string;
  summary?: string;
  structuredSummary?: StructuredSummary;
  sourceNote?: string;
  resultType?: ResultItemType;
};

export type ExperimentOutputGenerationResult = {
  resultItem: ResultItem;
  sourceSummary: OutputSourceSummary;
  duplicateHint?: string;
};

const LOCAL_PATH_PATTERN = /(?:[A-Za-z]:[\\/]|\\\\|file:\/\/\/?)[^\s"'<>|]+/gi;
const METRIC_TRIGGER_FIELD = "experimentOutputGenerationMetricId";
const TRIGGER_KIND_FIELD = "experimentOutputGenerationTrigger";

function redactPathLikeText(value: string | null | undefined) {
  return (value ?? "").replace(LOCAL_PATH_PATTERN, "[local path]").trim();
}

function singleLine(value: string | null | undefined) {
  return redactPathLikeText(value).replace(/\s+/g, " ").trim();
}

function joinParts(parts: Array<string | undefined | null>, separator = " · ") {
  return parts.map((part) => singleLine(part)).filter(Boolean).join(separator);
}

function metricValue(metric: ResultMetric) {
  return singleLine(`${metric.value}${metric.unit ? ` ${metric.unit}` : ""}`);
}

function sourceTypeDisplayName(sourceType: ExperimentOutputGenerationSourceType) {
  return sourceType === "experimentRun" ? "实验运行" : "实验";
}

function emptyResultItemStructuredSummary() {
  return createDefaultStructuredSummary("resultItem");
}

function metricContextText(metric: ResultMetric) {
  return joinParts(
    [
      `指标名称：${metric.name}`,
      `指标值：${metricValue(metric)}`,
      metric.metricGroup ? `指标分组：${metric.metricGroup}` : undefined,
      metric.description ? `指标说明：${metric.description}` : undefined
    ],
    "\n"
  );
}

function sourceSummaryForExperiment(experiment: Experiment, runCount?: number) {
  return joinParts(
    [
      experiment.purposeAndQuestion,
      experiment.conditionSummary,
      experiment.methodSummary,
      experiment.resultSummary,
      experiment.conclusionAndNextSteps,
      runCount !== undefined ? `运行次数：${runCount}` : undefined
    ],
    "\n"
  );
}

function sourceSummaryForRun(run: ExperimentRun, experiment?: Experiment | null) {
  return joinParts(
    [
      run.runLabel ? `运行标签：${run.runLabel}` : undefined,
      experiment?.title ? `所属实验：${experiment.title}` : undefined,
      run.conditionSummary,
      run.methodSummary,
      run.resultSummary,
      run.conclusion
    ],
    "\n"
  );
}

async function duplicateHint(
  sourceType: ExperimentOutputGenerationSourceType,
  sourceId: EntityId,
  metricId?: EntityId
) {
  const activeSourceCount = await countActiveResultItemsByOutputSource(sourceType, sourceId);
  const metricItems = metricId
    ? (await outputConversionService.listResultItems()).filter((item) =>
        (item.customFields ?? []).some(
          (field) => field.name === METRIC_TRIGGER_FIELD && field.value === metricId
        )
      )
    : [];
  const count = Math.max(activeSourceCount, metricItems.length);
  if (count <= 0) {
    return undefined;
  }
  return metricId
    ? `Existing ResultItem records already reference this metric context: ${count}.`
    : `Existing ResultItem records already use this source: ${count}.`;
}

async function requireExperiment(experimentId: EntityId) {
  const experiment = await experimentService.getExperimentById(experimentId);
  if (!experiment) {
    throw new Error("Experiment was not found.");
  }
  return experiment;
}

async function requireRun(runId: EntityId) {
  const run = await experimentRunService.getRunById(runId);
  if (!run) {
    throw new Error("ExperimentRun was not found.");
  }
  return run;
}

async function resolveRunExperiment(run: ExperimentRun) {
  return experimentService.getExperimentById(run.experimentId);
}

async function resolveMetricSource(metricId: EntityId) {
  const metric = await resultMetricService.getById(metricId);
  if (!metric) {
    throw new Error("ResultMetric was not found.");
  }

  const run = metric.runId ? await experimentRunService.getRunById(metric.runId) : undefined;
  if (run) {
    const experiment = await resolveRunExperiment(run);
    return {
      metric,
      run,
      experiment,
      sourceType: "experimentRun" as const,
      sourceId: run.id,
      sourceTitle: singleLine(run.title || run.runLabel || run.id),
      sourceSummarySnapshot: sourceSummaryForRun(run, experiment),
      projectId: run.projectId ?? experiment?.projectId,
      routeId: run.routeId ?? experiment?.routeId ?? null,
      taskId: run.taskId ?? experiment?.taskId ?? null,
      experimentId: experiment?.id ?? metric.experimentId ?? run.experimentId,
      experimentRunId: run.id
    };
  }

  const experiment = metric.experimentId
    ? await experimentService.getExperimentById(metric.experimentId)
    : undefined;
  if (experiment) {
    return {
      metric,
      run: undefined,
      experiment,
      sourceType: "experiment" as const,
      sourceId: experiment.id,
      sourceTitle: singleLine(experiment.title),
      sourceSummarySnapshot: sourceSummaryForExperiment(experiment),
      projectId: experiment.projectId,
      routeId: experiment.routeId ?? null,
      taskId: experiment.taskId ?? null,
      experimentId: experiment.id,
      experimentRunId: null
    };
  }

  throw new Error("Cannot determine a legal Experiment or ExperimentRun source for this metric.");
}

export async function buildExperimentResultItemDraft(
  experimentId: EntityId
): Promise<ExperimentOutputGenerationDraft> {
  const experiment = await requireExperiment(experimentId);
  const runs = await experimentRunService.getRunsByExperiment(experiment.id);
  const sourceSummarySnapshot = sourceSummaryForExperiment(experiment, runs.length);
  return {
    trigger: "experiment",
    triggerId: experiment.id,
    sourceType: "experiment",
    sourceId: experiment.id,
    sourceTitle: singleLine(experiment.title),
    sourceSummarySnapshot,
    resultItemTitle: singleLine(`实验结果：${experiment.title}`),
    summary: "",
    structuredSummary: emptyResultItemStructuredSummary(),
    sourceNote: `来源于实验：${singleLine(experiment.title)}`,
    resultType: "data",
    duplicateHint: await duplicateHint("experiment", experiment.id)
  };
}

export async function buildRunResultItemDraft(
  runId: EntityId
): Promise<ExperimentOutputGenerationDraft> {
  const run = await requireRun(runId);
  const experiment = await resolveRunExperiment(run);
  const sourceSummarySnapshot = sourceSummaryForRun(run, experiment);
  const sourceTitle = singleLine(run.title || run.runLabel || run.id);
  return {
    trigger: "experimentRun",
    triggerId: run.id,
    sourceType: "experimentRun",
    sourceId: run.id,
    sourceTitle,
    sourceSummarySnapshot,
    resultItemTitle: singleLine(`实验运行结果：${sourceTitle}`),
    summary: "",
    structuredSummary: emptyResultItemStructuredSummary(),
    sourceNote: `来源于实验运行：${sourceTitle}`,
    resultType: "data",
    duplicateHint: await duplicateHint("experimentRun", run.id)
  };
}

export async function buildMetricResultItemDraft(
  metricId: EntityId
): Promise<ExperimentOutputGenerationDraft> {
  const resolved = await resolveMetricSource(metricId);
  const metricText = metricContextText(resolved.metric);
  return {
    trigger: "resultMetric",
    triggerId: resolved.metric.id,
    sourceType: resolved.sourceType,
    sourceId: resolved.sourceId,
    sourceTitle: resolved.sourceTitle,
    sourceSummarySnapshot: resolved.sourceSummarySnapshot,
    metricContext: {
      metricId: resolved.metric.id,
      name: singleLine(resolved.metric.name),
      value: metricValue(resolved.metric),
      unit: resolved.metric.unit,
      description: redactPathLikeText(resolved.metric.description),
      metricGroup: redactPathLikeText(resolved.metric.metricGroup),
      sourceResolution: resolved.sourceType
    },
    resultItemTitle: singleLine(`${resolved.metric.name}：${metricValue(resolved.metric)}`),
    summary: "",
    structuredSummary: emptyResultItemStructuredSummary(),
    sourceNote: joinParts(
      [
        "来源于指标上下文。",
        metricText,
        `正式来源：${sourceTypeDisplayName(resolved.sourceType)} ${resolved.sourceTitle}`
      ],
      "\n"
    ),
    resultType: "metric",
    duplicateHint: await duplicateHint(resolved.sourceType, resolved.sourceId, resolved.metric.id)
  };
}

function customFieldsFor(
  trigger: ExperimentOutputGenerationTrigger,
  metricId?: EntityId
): CustomField[] {
  return [
    {
      id: `experiment-output-generation:${TRIGGER_KIND_FIELD}`,
      name: TRIGGER_KIND_FIELD,
      value: trigger,
      valueType: "text",
      group: "outputGeneration"
    },
    ...(metricId
      ? [
          {
            id: `experiment-output-generation:${METRIC_TRIGGER_FIELD}`,
            name: METRIC_TRIGGER_FIELD,
            value: metricId,
            valueType: "text" as const,
            group: "outputGeneration",
            description:
              "Metric context that triggered ResultItem generation; not an OutputSourceType."
          }
        ]
      : [])
  ];
}

async function createFromResolvedSource(
  draft: ExperimentOutputGenerationDraft,
  input: ExperimentOutputGenerationCreateInput,
  ownership: {
    projectId: EntityId;
    routeId?: EntityId | null;
    taskId?: EntityId | null;
    experimentId?: EntityId | null;
    experimentRunId?: EntityId | null;
  }
): Promise<ExperimentOutputGenerationResult> {
  if (!input.confirmedByUser) {
    throw new Error("User confirmation is required before creating a ResultItem.");
  }

  const title = singleLine(input.resultItemTitle);
  if (!title) {
    throw new Error("结果项标题不能为空。");
  }

  const structuredSummary = normalizeStructuredSummary(
    "resultItem",
    input.structuredSummary ?? emptyResultItemStructuredSummary()
  ).map((section) => ({ ...section, value: redactPathLikeText(section.value) }));
  const sourceNote = redactPathLikeText(input.sourceNote ?? draft.sourceNote);

  const resultItem = await outputConversionService.createResultItem({
    projectId: ownership.projectId,
    routeId: ownership.routeId ?? null,
    taskId: ownership.taskId ?? null,
    experimentId: ownership.experimentId ?? null,
    experimentRunId: ownership.experimentRunId ?? null,
    sourceType: draft.sourceType,
    sourceId: draft.sourceId,
    title,
    resultType: input.resultType ?? draft.resultType,
    status: "pending_review",
    structuredSummary,
    summary: redactPathLikeText(input.summary ?? ""),
    tags: [],
    customFields: customFieldsFor(draft.trigger, draft.metricContext?.metricId)
  });

  await createOutputSourceLink({
    projectId: ownership.projectId,
    ownerType: "resultItem",
    ownerId: resultItem.id,
    sourceType: draft.sourceType,
    sourceId: draft.sourceId,
    sourceTitleSnapshot: draft.sourceTitle,
    sourceSummarySnapshot: draft.sourceSummarySnapshot,
    sourceNote,
    relationType: "primary"
  });

  const [persisted, sourceSummary] = await Promise.all([
    outputConversionService.getResultItemById(resultItem.id),
    getOutputSourceSummary("resultItem", resultItem.id)
  ]);

  if (!persisted) {
    throw new Error("ResultItem was not readable after create.");
  }
  if (
    !sourceSummary.cards.some(
      (card) => card.sourceType === draft.sourceType && card.sourceId === draft.sourceId
    )
  ) {
    throw new Error("ResultItem was created but canonical source link was not readable.");
  }

  return {
    resultItem: persisted,
    sourceSummary,
    duplicateHint: draft.duplicateHint
  };
}

export async function createResultItemFromExperiment(
  experimentId: EntityId,
  input: ExperimentOutputGenerationCreateInput
) {
  const experiment = await requireExperiment(experimentId);
  const draft = await buildExperimentResultItemDraft(experiment.id);
  return createFromResolvedSource(draft, input, {
    projectId: experiment.projectId,
    routeId: experiment.routeId ?? null,
    taskId: experiment.taskId ?? null,
    experimentId: experiment.id,
    experimentRunId: null
  });
}

export async function createResultItemFromExperimentRun(
  runId: EntityId,
  input: ExperimentOutputGenerationCreateInput
) {
  const run = await requireRun(runId);
  const experiment = await resolveRunExperiment(run);
  const projectId = run.projectId ?? experiment?.projectId;
  if (!projectId) {
    throw new Error("Cannot determine a project for this run-generated ResultItem.");
  }
  const draft = await buildRunResultItemDraft(run.id);
  return createFromResolvedSource(draft, input, {
    projectId,
    routeId: run.routeId ?? experiment?.routeId ?? null,
    taskId: run.taskId ?? experiment?.taskId ?? null,
    experimentId: experiment?.id ?? run.experimentId,
    experimentRunId: run.id
  });
}

export async function createResultItemFromResultMetric(
  metricId: EntityId,
  input: ExperimentOutputGenerationCreateInput
) {
  const resolved = await resolveMetricSource(metricId);
  if (!resolved.projectId) {
    throw new Error("Cannot determine a project for this metric-generated ResultItem.");
  }
  const draft = await buildMetricResultItemDraft(metricId);
  return createFromResolvedSource(draft, input, {
    projectId: resolved.projectId,
    routeId: resolved.routeId ?? null,
    taskId: resolved.taskId ?? null,
    experimentId: resolved.experimentId ?? null,
    experimentRunId: resolved.experimentRunId ?? null
  });
}

export async function getGeneratedResultItemsByMetricIds(metricIds: EntityId[]) {
  if (metricIds.length === 0) {
    return {};
  }
  const metricIdSet = new Set(metricIds);
  const items = await outputConversionService.listResultItems();
  return items.reduce<Record<EntityId, ResultItem>>((record, item) => {
    const metricField = (item.customFields ?? []).find(
      (field) => field.name === METRIC_TRIGGER_FIELD && metricIdSet.has(String(field.value))
    );
    if (metricField) {
      record[String(metricField.value)] = item;
    }
    return record;
  }, {});
}

export const experimentOutputGenerationService = {
  buildExperimentResultItemDraft,
  buildRunResultItemDraft,
  buildMetricResultItemDraft,
  createResultItemFromExperiment,
  createResultItemFromExperimentRun,
  createResultItemFromResultMetric,
  getGeneratedResultItemsByMetricIds
};
