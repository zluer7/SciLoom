import type { ExperimentContextSummaryInput } from "../types/experimentManuscriptAdapter";

function safe(value: string) {
  return value
    .replace(/[\r\n]+/gu, " ")
    .replace(/(?:file:\/\/\/?|\\\\)[^\s)]+/giu, "[local path]")
    .replace(/[A-Za-z]:[\\/][^\s)]+/gu, "[local path]")
    .replace(/(^|[\s(])\/(?:[^/\s)]+\/)*[^/\s)]+/gu, "$1[local path]");
}

function listSummary(
  items: readonly unknown[],
  fields: readonly string[]
) {
  const values = items.slice(0, 6).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const value = fields
      .map((field) => record[field])
      .find((candidate) => typeof candidate === "string");
    return typeof value === "string" && value.trim() ? [safe(value)] : [];
  });
  return values.length > 0 ? values.join("；") : "未记录";
}

export function buildExperimentContextSummary(
  input: ExperimentContextSummaryInput
) {
  const profile = input.profile;
  return [
    "## 实验上下文摘要",
    "",
    `- 记录时间：${safe(input.occurredAt)}`,
    `- 操作：${safe(input.operationLabel)}`,
    `- 实验：${safe(profile.title)}`,
    `- 课题：${safe(profile.project.title)}`,
    `- 路线：${safe(profile.route?.title ?? "未关联")}`,
    `- 任务：${safe(profile.task?.title ?? "未关联")}`,
    `- 状态：${safe(profile.status)}`,
    `- 评级：${safe(profile.rating ?? "未设置")}`,
    `- 标签：${profile.tags.length > 0 ? profile.tags.map(safe).join("、") : "未设置"}`,
    `- 条件：${listSummary(profile.conditionItems, ["name", "title", "description", "value"])}`,
    `- 方法：${listSummary(profile.methodSteps, ["title", "name", "description", "content"])}`,
    `- 变量：${listSummary(profile.variables, ["name", "title", "description"])}`,
    `- 材料：${listSummary(profile.materials, ["name", "title", "description"])}`
  ].join("\n");
}

export const experimentContextSummaryBuilder = Object.freeze({
  build: buildExperimentContextSummary
});
