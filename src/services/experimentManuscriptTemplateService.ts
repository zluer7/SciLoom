import type { Experiment } from "../types/experiment";
import { getManuscriptOutlineDescriptor } from "./manuscriptOutlineDescriptorRegistry";
import { serializeCanonicalManuscriptOutline } from "./manuscriptOutlineSerializer";

function oneLineTitle(value: string) {
  return value.replace(/[\r\n]+/gu, " ").trim() || "未命名实验";
}

export function buildExperimentNaturalMarkdownTemplate(experiment: Experiment) {
  const descriptor = getManuscriptOutlineDescriptor({ ownerType: "experiment", channel: "primary" });
  const outline = serializeCanonicalManuscriptOutline(descriptor, experiment);
  return [
    `# 实验记录：${oneLineTitle(experiment.title)}`,
    "",
    outline,
    "",
    "## 实验正文",
    "",
    "请在此记录实验过程、观察与分析。",
    ""
  ].join("\n");
}

export const experimentManuscriptTemplateService = Object.freeze({
  buildDefault: buildExperimentNaturalMarkdownTemplate
});
