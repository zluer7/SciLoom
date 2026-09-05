import type { ExperimentContextSummaryDto } from "../types/experimentEditorContextSummary";
import { getManuscriptOutlineDescriptor } from "./manuscriptOutlineDescriptorRegistry";
import { serializeCanonicalManuscriptOutline } from "./manuscriptOutlineSerializer";

const MANAGED_TOP_HEADINGS = new Set(["实验上下文摘要", "结构化纲要", "结构化摘要", "文稿正文"]);

function newlineOf(rawText: string) {
  return rawText.includes("\r\n") ? "\r\n" : "\n";
}

function display(value: string | null) {
  return value ?? "未填写";
}

export function buildExperimentSwitchContextWriteback(
  dto: Readonly<ExperimentContextSummaryDto>,
  newline = "\n"
) {
  const summary = dto.structuredSummary;
  const outline = serializeCanonicalManuscriptOutline(
    getManuscriptOutlineDescriptor({ ownerType: "experiment", channel: "primary" }),
    summary
  ).replace(/\n/gu, newline);
  return [
    "## 实验上下文摘要", "",
    `- 课题：${display(dto.basicInfo.projectName)}`,
    `- 实验：${display(dto.basicInfo.experimentName)}`,
    `- 评级：${display(dto.basicInfo.rating)}`,
    `- 标签：${dto.basicInfo.tags.length ? dto.basicInfo.tags.join("、") : "未填写"}`,
    "", outline, "",
    "## 文稿正文", "", ""
  ].join(newline);
}

function stripManagedTop(rawText: string) {
  const newline = newlineOf(rawText);
  const lines = rawText.split(/\r\n|\n|\r/u);
  let index = 0;
  while (index < lines.length && !lines[index].trim()) index += 1;
  let consumed = index;
  while (consumed < lines.length) {
    const match = lines[consumed].match(/^##\s+(.+?)\s*$/u);
    if (!match || !MANAGED_TOP_HEADINGS.has(match[1])) break;
    const heading = match[1];
    consumed += 1;
    if (heading === "文稿正文") {
      while (consumed < lines.length && !lines[consumed].trim()) consumed += 1;
      break;
    }
    while (consumed < lines.length && !/^##\s+/u.test(lines[consumed])) consumed += 1;
  }
  return { remaining: lines.slice(consumed).join(newline), newline };
}

export function applyExperimentSwitchContextWriteback(
  rawText: string,
  dto: Readonly<ExperimentContextSummaryDto>
) {
  const { remaining, newline } = stripManagedTop(rawText);
  return `${buildExperimentSwitchContextWriteback(dto, newline)}${remaining}`;
}

export const experimentSwitchContextWritebackBuilder = Object.freeze({
  build: buildExperimentSwitchContextWriteback,
  apply: applyExperimentSwitchContextWriteback
});
