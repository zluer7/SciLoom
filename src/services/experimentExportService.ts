import {
  getExperimentDetailContext,
  getExperimentRunContext
} from "./experimentSelectorService";
import { getFileRefPathName, summarizeFileRefPath } from "./fileRefService";
import type { EntityId } from "../types";
import type { ConditionItem, FileRef, MethodStep, ResultMetric } from "../types";
import type { ExperimentOutputContext } from "../types/experimentContext";

function valueOrUnset(value: unknown) {
  return value === undefined || value === null || value === "" ? "未填写" : String(value);
}

function yesNo(value: boolean) {
  return value ? "是" : "否";
}

function markdownList(items: string[], emptyText = "无记录") {
  const visibleItems = items.filter((item) => item.trim().length > 0);
  return visibleItems.length > 0
    ? visibleItems.map((item) => `- ${item}`).join("\n")
    : `- ${emptyText}`;
}

function formatConditionItem(item: ConditionItem) {
  const unit = item.unit ? ` ${item.unit}` : "";
  const role = item.role ? ` (${item.role})` : "";
  const description = item.description ? `；${item.description}` : "";
  return `${item.name}: ${item.value}${unit}${role}${description}`;
}

function formatMethodStep(step: MethodStep) {
  const method = step.toolOrMethod ? ` [${step.toolOrMethod}]` : "";
  const description = step.description ? `；${step.description}` : "";
  return `${step.order}. ${step.title}${method}${description}`;
}

function formatMetric(metric: ResultMetric) {
  const unit = metric.unit ? ` ${metric.unit}` : "";
  const group = metric.metricGroup ? ` (${metric.metricGroup})` : "";
  const baseline =
    metric.baselineValue === undefined ? "" : `；baseline=${metric.baselineValue}`;
  const target = metric.targetValue === undefined ? "" : `；target=${metric.targetValue}`;
  const description = metric.description ? `；${metric.description}` : "";
  return `${metric.name}${group}: ${metric.value}${unit}${baseline}${target}${description}`;
}

function formatFileRef(fileRef: FileRef) {
  const title =
    fileRef.title && fileRef.title !== fileRef.path
      ? fileRef.title
      : getFileRefPathName(fileRef.path);
  const description = fileRef.description ? `；${fileRef.description}` : "";
  return `${title} (${fileRef.fileType})${description}\n  - 路径摘要: ${summarizeFileRefPath(fileRef.path)}`;
}

function groupFileRefsByType(fileRefs: FileRef[]) {
  return fileRefs.reduce<Record<string, FileRef[]>>((groups, fileRef) => {
    const key = fileRef.fileType || "other";
    groups[key] = [...(groups[key] ?? []), fileRef];
    return groups;
  }, {});
}

function buildFileRefSection(fileRefs: FileRef[], legacyDataPath?: string) {
  const grouped = groupFileRefsByType(fileRefs);
  const sections = Object.entries(grouped).map(([fileType, refs]) =>
    [`### ${fileType}`, markdownList(refs.map(formatFileRef))].join("\n\n")
  );

  if (legacyDataPath) {
    sections.unshift(
      [
        "### legacy_data_path",
        `- 旧数据路径索引\n  - 路径摘要: ${summarizeFileRefPath(legacyDataPath)}`
      ].join("\n\n")
    );
  }

  return sections.length > 0 ? sections.join("\n\n") : "无文件路径引用。";
}

export async function buildExperimentRunMarkdown(runId: EntityId) {
  const context = await getExperimentRunContext(runId);
  if (!context) {
    return "# 实验运行记录\n\n未找到实验运行记录。";
  }

  const { run, experiment } = context;

  return [
    `# ${run.title}`,
    "",
    "## 基本信息",
    "",
    `- Run ID: ${run.id}`,
    `- 所属实验: ${experiment.title}`,
    `- 所属课题: ${valueOrUnset(context.project?.title)}`,
    `- 所属路线: ${valueOrUnset(context.route?.title)}`,
    `- 所属任务: ${valueOrUnset(context.task?.title)}`,
    `- 状态: ${run.status}`,
    `- 评级: ${valueOrUnset(run.rating)}`,
    "",
    "## 工况条件与参数",
    "",
    `- 条件摘要: ${valueOrUnset(run.conditionSummary)}`,
    markdownList(run.conditionItems.map(formatConditionItem)),
    "",
    "## 方法流程",
    "",
    `- 方法摘要: ${valueOrUnset(run.methodSummary)}`,
    markdownList(run.methodSteps.map(formatMethodStep)),
    "",
    "## 指标结果",
    "",
    markdownList(context.metrics.map(formatMetric)),
    "",
    "## 文件引用",
    "",
    buildFileRefSection([...context.parentExperimentFileRefs, ...context.fileRefs]),
    "",
    "## 结论与后续",
    "",
    `- 结果摘要: ${valueOrUnset(run.resultSummary)}`,
    `- 结论: ${valueOrUnset(run.conclusion)}`,
    `- 父实验下一步动作: ${valueOrUnset(experiment.nextAction)}`
  ].join("\n");
}

export async function buildExperimentOutputContext(
  experimentId: EntityId
): Promise<ExperimentOutputContext | null> {
  const context = await getExperimentDetailContext(experimentId);
  if (!context) {
    return null;
  }

  const metrics = Object.values(context.metricsByRunId).flat();
  const fileRefs = context.relatedFileRefs;
  const runs = context.runs.map((run) => ({
    run,
    metrics: context.metricsByRunId[run.id] ?? [],
    fileRefs: context.fileRefsByRunId[run.id] ?? []
  }));
  const runFindings = context.runs.flatMap((run) =>
    [run.resultSummary, run.conclusion].filter((value): value is string => Boolean(value))
  );

  return {
    experimentBasicInfo: {
      id: context.experiment.id,
      title: context.experiment.title,
      purposeAndQuestion: context.experiment.purposeAndQuestion,
      status: context.experiment.status,
      rating: context.experiment.rating,
      tags: context.experiment.tags
    },
    relatedProject: context.project,
    relatedRoute: context.route,
    relatedTask: context.task,
    conditions: {
      summary: context.experiment.conditionSummary,
      items: context.experiment.conditionItems,
      variables: context.experiment.variables,
      materials: context.experiment.materials
    },
    methodSummary: context.experiment.methodSummary,
    runs,
    metrics,
    fileRefs,
    keyFindings: [
      context.experiment.resultSummary,
      context.experiment.conclusionAndNextSteps,
      ...runFindings
    ].filter((value): value is string => Boolean(value)),
    issues: [context.experiment.problemNotes].filter((value): value is string => Boolean(value)),
    nextActions: [context.experiment.nextAction].filter(
      (value): value is string => Boolean(value)
    ),
    usableForPaper: context.experiment.usableForPaper,
    usableForReport: context.experiment.usableForReport,
    usableForPatent: context.experiment.usableForPatent,
    outputs: context.outputs
  };
}

export const experimentExportService = {
  buildExperimentRunMarkdown,
  buildExperimentOutputContext
};
