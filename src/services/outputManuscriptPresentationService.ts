import type { OutputManuscriptStructuredSnapshot } from "../types";
import { buildOutputCanonicalPresentationSummary } from "./outputCanonicalValueCoherenceService";
import { formatManuscriptContextSummaryMarkdown } from "./manuscriptPresentationNormalization";

const EMPTY_VALUE = "未填写";

function sanitizePresentationText(value: string) {
  return value
    .replace(/<!--\s*LABPOD[^>]*-->/giu, "[内部标记已省略]")
    .replace(/[A-Za-z]:[\\/][^\s，；）)]+/gu, "[本地路径已省略]")
    .replace(/(^|\s)\/(?:[^/\s]+\/)+[^\s，；）)]*/gu, "$1[本地路径已省略]");
}

function valueOrEmpty(value: unknown) {
  const normalized = value === undefined || value === null ? "" : String(value).trim();
  return normalized ? sanitizePresentationText(normalized) : EMPTY_VALUE;
}

function line(label: string, value: unknown) {
  return `- ${label}：${valueOrEmpty(value)}`;
}

export function formatOutputManuscriptContextInsert(
  snapshot: OutputManuscriptStructuredSnapshot
) {
  const sectionsByKey = new Map(
    buildOutputCanonicalPresentationSummary(
      snapshot.ownerType,
      snapshot.briefDescription,
      snapshot.structuredSummary
    ).map((section) => [section.key, section.value] as const)
  );
  return formatManuscriptContextSummaryMarkdown({
    heading: "成果上下文摘要",
    bodyGroups: [[
      line("简要说明", snapshot.briefDescription),
      line("所属课题", snapshot.projectTitle)
    ]],
    descriptorLookupIdentity: {
      ownerType: snapshot.ownerType,
      channel: "primary"
    },
    structuredValues: Object.fromEntries(sectionsByKey),
    emptyValue: EMPTY_VALUE,
    sanitizeValue: sanitizePresentationText
  });
}

export const outputManuscriptPresentationService = {
  formatContextInsert: formatOutputManuscriptContextInsert
};
