import { experimentService } from "./experimentService";
import { experimentRunService } from "./experimentRunService";
import { fileRefService } from "./fileRefService";
import { outputService } from "./outputService";
import { planningService } from "./planningService";
import { resultMetricService } from "./resultMetricService";
import { getControlledExperimentRunAccess } from "./experimentRunGuard";
import { manuscriptBindingService } from "./manuscriptBindingService";
import type { EntityId } from "../types";
import type { Experiment, ExperimentRating, ExperimentStatus, FileRef, ResultMetric } from "../types";
import type {
  ExperimentDetailContext,
  ExperimentQueryOptions,
  ExperimentRunContext,
  ExperimentSummaryInfo
} from "../types/experimentContext";
import type { Project, RouteNode, Task } from "../types/planning";

type ReferenceData = {
  projects: Project[];
  routes: RouteNode[];
  tasks: Task[];
};

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function normalizeText(value: unknown) {
  return value === undefined || value === null ? "" : String(value).toLowerCase();
}

async function loadReferenceData(): Promise<ReferenceData> {
  const [projects, routes, tasks] = await Promise.all([
    planningService.queryProjects(),
    planningService.queryRouteNodes(),
    planningService.queryTasks()
  ]);

  return { projects, routes, tasks };
}

function resolveProject(projects: Project[], projectId?: EntityId | null) {
  return projectId ? projects.find((project) => project.id === projectId) ?? null : null;
}

function resolveTask(tasks: Task[], taskId?: EntityId | null) {
  return taskId ? tasks.find((task) => task.id === taskId) ?? null : null;
}

function resolveRoute(
  routes: RouteNode[],
  routeId?: EntityId | null
) {
  const actualRouteId = routeId;
  return actualRouteId ? routes.find((route) => route.id === actualRouteId) ?? null : null;
}

function buildSummaryInfo(
  experiment: Experiment,
  runsLength: number,
  metricCount: number,
  fileRefCount: number,
  outputCount: number
): ExperimentSummaryInfo {
  return {
    title: experiment.title,
    purposeAndQuestion: experiment.purposeAndQuestion,
    status: experiment.status,
    rating: experiment.rating,
    runCount: runsLength,
    metricCount,
    fileRefCount,
    outputCount,
    tags: experiment.tags,
    usableForPaper: experiment.usableForPaper,
    usableForReport: experiment.usableForReport,
    usableForPatent: experiment.usableForPatent
  };
}

function experimentMatchesKeyword(experiment: Experiment, keyword: string) {
  const normalizedKeyword = keyword.trim().toLowerCase();
  if (!normalizedKeyword) {
    return true;
  }

  const fields = [
    experiment.title,
    experiment.experimentName,
    experiment.purposeAndQuestion,
    experiment.conditionSummary,
    experiment.methodSummary,
    experiment.resultSummary,
    experiment.conclusionAndNextSteps,
    experiment.other,
    experiment.machineObject,
    experiment.sensorConfig,
    experiment.problemNotes,
    experiment.nextAction,
    experiment.dataPath,
    ...experiment.customFields.map((field) => `${field.name} ${String(field.value)}`)
  ];

  return fields.some((field) => normalizeText(field).includes(normalizedKeyword));
}

function experimentMatchesTags(experiment: Experiment, tags: string[] | undefined, matchAll = false) {
  if (!tags || tags.length === 0) {
    return true;
  }

  const normalizedExperimentTags = new Set(experiment.tags.map((tag) => tag.toLowerCase()));
  const normalizedQueryTags = tags.map((tag) => tag.toLowerCase());

  // Current LabPod tag filters use "any" matching by default for exploratory retrieval.
  // Callers can opt into "all" matching with ExperimentQueryOptions.tagMatch = "all".
  return matchAll
    ? normalizedQueryTags.every((tag) => normalizedExperimentTags.has(tag))
    : normalizedQueryTags.some((tag) => normalizedExperimentTags.has(tag));
}

function experimentMatchesOptions(
  experiment: Experiment,
  options: ExperimentQueryOptions,
  outputExperimentId: EntityId | undefined
) {
  const statuses = toArray<ExperimentStatus>(options.status);
  const ratings = toArray<ExperimentRating>(options.rating);

  return (
    (!options.projectId || experiment.projectId === options.projectId) &&
    (!options.taskId || experiment.taskId === options.taskId) &&
    (!options.routeId || experiment.routeId === options.routeId) &&
    (!options.outputId || experiment.id === outputExperimentId) &&
    (statuses.length === 0 || statuses.includes(experiment.status)) &&
    (ratings.length === 0 || (experiment.rating !== undefined && ratings.includes(experiment.rating))) &&
    experimentMatchesTags(experiment, options.tags, options.tagMatch === "all") &&
    (!options.keyword || experimentMatchesKeyword(experiment, options.keyword)) &&
    (options.usableForPaper === undefined ||
      experiment.usableForPaper === options.usableForPaper) &&
    (options.usableForReport === undefined ||
      experiment.usableForReport === options.usableForReport) &&
    (options.usableForPatent === undefined ||
      experiment.usableForPatent === options.usableForPatent)
  );
}

async function metricsByRun(runIds: EntityId[]) {
  const entries = await Promise.all(
    runIds.map(async (runId) => [runId, await resultMetricService.getMetricsByRun(runId)] as const)
  );

  return entries.reduce<Record<EntityId, ResultMetric[]>>((record, [runId, metrics]) => {
    record[runId] = metrics;
    return record;
  }, {});
}

async function fileRefsByRun(runIds: EntityId[]) {
  const entries = await Promise.all(
    runIds.map(async (runId) => [
      runId,
      await fileRefService.getFileRefsByOwner("experimentRun", runId)
    ] as const)
  );

  return entries.reduce<Record<EntityId, FileRef[]>>((record, [runId, fileRefs]) => {
    record[runId] = fileRefs;
    return record;
  }, {});
}

export async function getExperimentDetailContext(
  experimentId: EntityId
): Promise<ExperimentDetailContext | null> {
  const experiment = await experimentService.getExperimentById(experimentId);
  if (!experiment) {
    return null;
  }

  const [
    { projects, routes, tasks },
    outputs,
    runs,
    experimentFileRefs,
    manuscriptIdentity
  ] = await Promise.all([
    loadReferenceData(),
    outputService.listOutputs(),
    experimentRunService.getRunsByExperiment(experiment.id),
    fileRefService.getFileRefsByOwner("experiment", experiment.id),
    manuscriptBindingService.resolveIdentity({
      ownerType: "experiment",
      ownerId: experiment.id,
      manuscriptChannel: "primary"
    })
  ]);

  const task = resolveTask(tasks, experiment.taskId);
  const project = resolveProject(projects, experiment.projectId);
  const route = resolveRoute(routes, experiment.routeId);
  const linkedOutputs = outputs.filter((output) => output.experimentId === experiment.id);
  const runIds = runs.map((run) => run.id);
  const [metricsByRunId, fileRefsByRunId] = await Promise.all([
    metricsByRun(runIds),
    fileRefsByRun(runIds)
  ]);
  const runFileRefs = Object.values(fileRefsByRunId).flat();
  const metricCount = Object.values(metricsByRunId).reduce(
    (count, metrics) => count + metrics.length,
    0
  );
  const relatedFileRefs = [...experimentFileRefs, ...runFileRefs];

  return {
    experiment,
    project,
    route,
    task,
    outputs: linkedOutputs,
    runs,
    metricsByRunId,
    fileRefsByRunId,
    experimentFileRefs,
    manuscriptBinding: manuscriptIdentity.binding,
    relatedFileRefs,
    summaryInfo: buildSummaryInfo(
      experiment,
      runs.length,
      metricCount,
      relatedFileRefs.length,
      linkedOutputs.length
    )
  };
}

export async function getExperimentRunContext(
  runId: EntityId
): Promise<ExperimentRunContext | null> {
  const run = await experimentRunService.getRunById(runId);
  if (!run) {
    return null;
  }

  const experiment = await experimentService.getExperimentById(run.experimentId);
  if (!experiment) {
    return null;
  }

  const [{ projects, routes, tasks }, metrics, fileRefs, parentExperimentFileRefs] =
    await Promise.all([
      loadReferenceData(),
      resultMetricService.getMetricsByRun(run.id),
      fileRefService.getFileRefsByOwner("experimentRun", run.id),
      fileRefService.getFileRefsByOwner("experiment", experiment.id)
    ]);

  const task = resolveTask(tasks, run.taskId);
  const project = resolveProject(projects, run.projectId);
  const route = resolveRoute(routes, run.routeId);

  return {
    run,
    experiment,
    project,
    route,
    task,
    metrics,
    fileRefs,
    parentExperimentFileRefs
  };
}

export async function queryExperiments(options: ExperimentQueryOptions = {}) {
  const [experiments, output] = await Promise.all([
    experimentService.getExperiments(),
    options.outputId ? outputService.getById(options.outputId) : Promise.resolve(undefined)
  ]);

  if (options.outputId && !output?.experimentId) {
    return [];
  }

  return experiments.filter((experiment) =>
    experimentMatchesOptions(experiment, options, output?.experimentId)
  );
}

export async function getExperimentsByProjectContext(projectId: EntityId) {
  const experiments = await queryExperiments({ projectId });
  const contexts = await Promise.all(
    experiments.map((experiment) => getExperimentDetailContext(experiment.id))
  );
  return contexts.filter((context): context is ExperimentDetailContext => Boolean(context));
}

export async function getExperimentsByTaskContext(taskId: EntityId) {
  const experiments = await queryExperiments({ taskId });
  const contexts = await Promise.all(
    experiments.map((experiment) => getExperimentDetailContext(experiment.id))
  );
  return contexts.filter((context): context is ExperimentDetailContext => Boolean(context));
}

export async function getExperimentsByOutputContext(outputId: EntityId) {
  const experiments = await queryExperiments({ outputId });
  const contexts = await Promise.all(
    experiments.map((experiment) => getExperimentDetailContext(experiment.id))
  );
  return contexts.filter((context): context is ExperimentDetailContext => Boolean(context));
}

export const experimentSelectorService = {
  getExperimentDetailContext,
  getExperimentRunContext,
  getControlledExperimentRunAccess,
  queryExperiments,
  getExperimentsByProjectContext,
  getExperimentsByTaskContext,
  getExperimentsByOutputContext
};
