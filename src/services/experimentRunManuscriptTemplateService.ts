import type { ExperimentRunContextSummaryDto } from "../types/experimentRunContextSummary";
import { getManuscriptOutlineDescriptor } from "./manuscriptOutlineDescriptorRegistry";
import { serializeCanonicalManuscriptOutline } from "./manuscriptOutlineSerializer";

const EXPERIMENT_RUN_OUTLINE_DESCRIPTOR = getManuscriptOutlineDescriptor({
  ownerType: "experimentRun", channel: "primary"
});

function oneLineTitle(value: string) {
  return value.replace(/[\r\n]+/gu, " ").trim() || "未命名运行";
}

function display(value: string | null) {
  return value ?? "";
}

export function buildExperimentRunNaturalMarkdownTemplate(dto: ExperimentRunContextSummaryDto) {
  const outlineValues = Object.fromEntries(
    EXPERIMENT_RUN_OUTLINE_DESCRIPTOR.fields.map((field) => {
      const segments = field.persistenceProjectorIdentity.split(".");
      const storageKey = segments[segments.length - 1] as keyof ExperimentRunContextSummaryDto["structuredSummary"];
      return [field.stableKey, dto.structuredSummary[storageKey] ?? ""];
    })
  );
  const outline = serializeCanonicalManuscriptOutline(
    EXPERIMENT_RUN_OUTLINE_DESCRIPTOR,
    outlineValues
  );
  return [
    `# 运行记录：${oneLineTitle(dto.basicInfo.runName ?? "")}`,
    "",
    "## 基本信息",
    "",
    `- 课题：${display(dto.basicInfo.projectName)}`,
    `- 实验：${display(dto.basicInfo.experimentName)}`,
    `- 运行：${display(dto.basicInfo.runName)}`,
    `- 评级：${display(dto.basicInfo.rating)}`,
    `- 标签：${dto.basicInfo.tags.length ? dto.basicInfo.tags.join("、") : ""}`,
    "",
    outline,
    "",
    "## 运行正文",
    "",
    "请在此记录本次运行过程、观察、结果与分析。",
    ""
  ].join("\n");
}

export const experimentRunManuscriptTemplateService = Object.freeze({
  buildDefault: buildExperimentRunNaturalMarkdownTemplate
});
