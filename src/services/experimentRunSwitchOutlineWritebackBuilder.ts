import type { ExperimentRunContextSummaryDto } from "../types/experimentRunContextSummary";
import { buildExperimentRunContextSummaryMarkdown } from "./experimentRunContextSummaryService";

const MANAGED_OUTLINE_SUBHEADINGS = new Set([
  "运行条件摘要",
  "条件摘要",
  "变量与参数摘要",
  "运行方法摘要",
  "方法摘要",
  "运行结果摘要",
  "结果摘要",
  "结论说明",
  "结论与下一步",
  "其他"
]);

type LineInfo = {
  start: number;
  end: number;
  content: string;
  headingDepth?: number;
  headingLabel?: string;
  fenced: boolean;
};

function preferredNewline(rawText: string) {
  return rawText.includes("\r\n") ? "\r\n" : "\n";
}

function scanLines(rawText: string): LineInfo[] {
  const lines: LineInfo[] = [];
  const pattern = /([^\r\n]*)(\r\n|\r|\n|$)/gu;
  let fence: "`" | "~" | undefined;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(rawText)) && match[0].length > 0) {
    const content = match[1];
    const fenced = Boolean(fence);
    const fenceMatch = content.match(/^\s*(`{3,}|~{3,})/u);
    if (fenceMatch) {
      const marker = fenceMatch[1][0] as "`" | "~";
      fence = fence === marker ? undefined : fence ?? marker;
    }
    const heading = !fenced && !fenceMatch
      ? content.match(/^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/u)
      : null;
    lines.push({
      start: match.index,
      end: match.index + match[0].length,
      content,
      headingDepth: heading?.[1].length,
      headingLabel: heading?.[2].trim(),
      fenced
    });
  }
  return lines;
}

function removeExistingOutlineBlocks(rawText: string) {
  const lines = scanLines(rawText);
  const ranges: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (
      line.headingDepth !== 2 ||
      (line.headingLabel !== "结构化纲要" && line.headingLabel !== "结构化摘要")
    ) continue;
    let boundaryIndex = lines.findIndex((candidate, candidateIndex) =>
      candidateIndex > index &&
      candidate.headingDepth !== undefined &&
      candidate.headingDepth <= 2
    );
    const blockEndIndex = boundaryIndex >= 0 ? boundaryIndex : lines.length;
    const isTopOutline = rawText.slice(0, line.start).trim() === "";
    const hasManagedSubheading = lines
      .slice(index + 1, blockEndIndex)
      .some((candidate) =>
        candidate.headingDepth === 3 &&
        MANAGED_OUTLINE_SUBHEADINGS.has(candidate.headingLabel ?? "")
      );
    if (!isTopOutline && !hasManagedSubheading) continue;
    let end = boundaryIndex >= 0 ? lines[boundaryIndex].start : rawText.length;
    if (
      boundaryIndex >= 0 &&
      lines[boundaryIndex].headingDepth === 2 &&
      lines[boundaryIndex].headingLabel === "文稿正文"
    ) {
      end = lines[boundaryIndex].end;
      while (boundaryIndex + 1 < lines.length && lines[boundaryIndex + 1].content === "") {
        end = lines[boundaryIndex + 1].end;
        boundaryIndex += 1;
      }
    }
    ranges.push({ start: line.start, end });
  }
  return ranges
    .sort((left, right) => right.start - left.start)
    .reduce(
      (text, range) => `${text.slice(0, range.start)}${text.slice(range.end)}`,
      rawText
    );
}

export function buildExperimentRunSwitchOutlineWriteback(
  dto: ExperimentRunContextSummaryDto,
  newline = "\n"
) {
  const context = buildExperimentRunContextSummaryMarkdown(dto, {
    heading: "结构化纲要",
    newline
  });
  return `${context}${newline}## 文稿正文${newline}${newline}`;
}

export function applyExperimentRunSwitchOutlineWriteback(
  rawText: string,
  dto: ExperimentRunContextSummaryDto
) {
  const newline = preferredNewline(rawText);
  const remaining = removeExistingOutlineBlocks(rawText);
  return `${buildExperimentRunSwitchOutlineWriteback(dto, newline)}${remaining}`;
}

export const experimentRunSwitchOutlineWritebackBuilder = Object.freeze({
  build: buildExperimentRunSwitchOutlineWriteback,
  apply: applyExperimentRunSwitchOutlineWriteback
});
