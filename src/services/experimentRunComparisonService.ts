import { getExperimentRunContext } from "./experimentSelectorService";
import { experimentOutputGenerationService } from "./experimentOutputGenerationService";
import { getFileRefPathName } from "./fileRefService";
import { isResultMetricKeyResult } from "./resultMetricService";
import type { ExperimentRunContext } from "../types/experimentContext";

export const EXPERIMENT_RUN_COMPARISON_MAX = 5;
export type ComparisonCell = { kind: "value" | "missing" | "not_applicable"; text: string };
export type RunComparisonColumn = { id: string; title: string; error?: string; facts: Record<string, ComparisonCell> };
export type RunComparisonRow = { key: string; label: string; cells: ComparisonCell[]; differs: boolean };

const missing: ComparisonCell = { kind: "missing", text: "" };
function displayValue(value: unknown): string {
  if (value === "") return "(empty)";
  if (Array.isArray(value) && value.length === 0) return "[]";
  return typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
}
function cell(value: unknown): ComparisonCell {
  return value === undefined || value === null ? missing : { kind: "value", text: displayValue(value) };
}

/** Exact current keys; duplicate observations remain visible, with type/unit intact. */
export function projectRunComparison(context: ExperimentRunContext, promotedMetricIds: ReadonlySet<string>): RunComparisonColumn {
  const { run } = context;
  const facts: Record<string, ComparisonCell> = Object.create(null);
  const add = (key: string, value: unknown) => { facts[key] = cell(value); };
  const observe = (key: string, text: string) => {
    const previous = facts[key];
    facts[key] = { kind: "value", text: previous?.kind === "value" ? previous.text + "\n" + text : text };
  };
  add("Name", run.title);
  add("Run label", run.runLabel);
  add("Experiment", context.experiment.title);
  add("Project", context.project?.title);
  for (const [label, value] of [["Route", context.route], ["Task", context.task]] as const) {
    facts[label] = value ? cell(value.title) : { kind: "not_applicable", text: "" };
  }
  for (const [key, value] of Object.entries({
    Status: run.status, Rating: run.rating, Tags: run.tags, Created: run.createdAt,
    Updated: run.updatedAt, Started: run.startedAt, Completed: run.completedAt,
    "Conditions": run.conditionSummary, "Variables / parameters": run.variableParameterSummary,
    Method: run.methodSummary, "Recorded result summary": run.resultSummary,
    "Recorded conclusion": run.conclusion, "Other recorded summary": run.summaryOther
  })) add(key, value);
  for (const [category, entries] of [["Condition", run.conditionItems], ["Variable", run.variables], ["Material", run.materials], ["Custom", run.customFields]] as const) {
    for (const entry of entries) {
      const record = entry as unknown as Record<string, unknown>;
      const key = JSON.stringify([category, record.name, record.group ?? ""]);
      const details = Object.fromEntries(Object.entries(record).filter(([field]) => field !== "id" && field !== "name" && field !== "group"));
      observe(key, displayValue(details));
    }
  }
  for (const step of run.methodSteps) {
    observe(JSON.stringify(["Method step", step.title, ""]), displayValue({ order: step.order, description: step.description, toolOrMethod: step.toolOrMethod, parameters: step.parameters }));
  }
  for (const metric of context.metrics) {
    observe(JSON.stringify(["Metric", metric.name, metric.metricGroup ?? ""]), displayValue({
      value: metric.value, valueType: metric.valueType, unit: metric.unit, description: metric.description,
      baseline: metric.baselineValue, target: metric.targetValue,
      keyResult: isResultMetricKeyResult(metric), promotedToResultItem: promotedMetricIds.has(metric.id)
    }));
  }
  add("File count", context.fileRefs.length);
  add("File metadata", context.fileRefs.map(file => ({
    name: getFileRefPathName(file.path), title: file.title, type: file.fileType,
    resourceKind: file.resourceKind, role: file.fileRole
  })));
  return { id: run.id, title: run.title, facts };
}

export async function readRunComparison(experimentId: string, runIds: readonly string[]): Promise<RunComparisonColumn[]> {
  if (runIds.length < 2 || runIds.length > EXPERIMENT_RUN_COMPARISON_MAX || new Set(runIds).size !== runIds.length) {
    throw new Error("Select 2–5 distinct Runs from one Experiment.");
  }
  return Promise.all(runIds.map(async id => {
    try {
      const context = await getExperimentRunContext(id);
      if (!context || context.run.experimentId !== experimentId || context.experiment.id !== experimentId) {
        return { id, title: id, error: "unavailable", facts: {} };
      }
      const generated = await experimentOutputGenerationService.getGeneratedResultItemsByMetricIds(context.metrics.map(metric => metric.id));
      const promoted = new Set(Object.keys(generated));
      return projectRunComparison(context, promoted);
    } catch {
      return { id, title: id, error: "read_failed", facts: {} };
    }
  }));
}

export function runComparisonRows(columns: readonly RunComparisonColumn[]): RunComparisonRow[] {
  const keys = [...new Set(columns.flatMap(column => Object.keys(column.facts)))];
  return keys.map(key => {
    const cells = columns.map(column => column.facts[key] ?? missing);
    let label = key;
    if (key.startsWith("[")) {
      const [category, name, group] = JSON.parse(key) as string[];
      label = `${category}: ${name}${group ? ` (${group})` : ""}`;
    }
    return { key, label, cells, differs: new Set(cells.map(value => JSON.stringify(value))).size > 1 };
  });
}
