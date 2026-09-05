import type { ManuscriptChannel } from "../types";
import type { LiteratureStructuredOutlineSummary } from "../types/literatureContext";
import {
  LITERATURE_CODEC_ERROR_CODES,
  LiteratureCodecError,
  type LiteratureDedicatedNotesSummary,
  type LiteratureMetaV2Data
} from "./literatureMarkdownCodecService";

export interface LegacyLiteratureMetaV1 extends Omit<LiteratureMetaV2Data, "importance"> {
  importance: "";
  abstract?: string;
}

function normalized(raw: string) {
  return String(raw ?? "").replace(/\r\n?/gu, "\n");
}

function fail(code: (typeof LITERATURE_CODEC_ERROR_CODES)[keyof typeof LITERATURE_CODEC_ERROR_CODES], message: string): never {
  throw new LiteratureCodecError(code, message);
}

function exactLineCount(raw: string, line: string) {
  return normalized(raw).split("\n").filter((candidate) => candidate.trim() === line).length;
}

function requireExactLine(raw: string, line: string) {
  const count = exactLineCount(raw, line);
  if (count > 1) fail(LITERATURE_CODEC_ERROR_CODES.ambiguous, `Legacy Literature heading is duplicated: ${line}.`);
  if (count === 0) fail(LITERATURE_CODEC_ERROR_CODES.cutoverTargetInvalid, `Legacy Literature heading is missing: ${line}.`);
}

function legacyBullet(raw: string, label: string) {
  const matches = normalized(raw).split("\n").flatMap((line) => {
    const match = new RegExp(`^\\s*-\\s+${label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}:\\s*(.*)$`, "u").exec(line);
    return match ? [match[1].trim()] : [];
  });
  if (matches.length > 1) fail(LITERATURE_CODEC_ERROR_CODES.ambiguous, `Legacy Literature field is duplicated: ${label}.`);
  if (matches.length === 0) fail(LITERATURE_CODEC_ERROR_CODES.cutoverTargetInvalid, `Legacy Literature field is missing: ${label}.`);
  return matches[0];
}

function headingSections<T extends string>(raw: string, headings: readonly T[]) {
  const source = normalized(raw);
  headings.forEach((heading) => requireExactLine(source, `### ${heading}`));
  const headingToKey = new Map(headings.map((heading) => [heading, heading]));
  const values = new Map<T, string[]>();
  let current: T | undefined;
  source.split("\n").forEach((line) => {
    const heading = /^###\s+(.+?)\s*$/u.exec(line)?.[1] as T | undefined;
    if (heading && headingToKey.has(heading)) {
      current = heading;
      return;
    }
    if (current) (values.get(current) ?? values.set(current, []).get(current)!).push(line);
  });
  return Object.fromEntries(headings.map((heading) => [heading, (values.get(heading) ?? []).join("\n").trim()]));
}

export function parseLegacyLiteratureMetaV1(raw: string): LegacyLiteratureMetaV1 {
  requireExactLine(raw, "# Literature Metadata");
  requireExactLine(raw, "## Abstract");
  const source = normalized(raw);
  const abstractIndex = source.split("\n").findIndex((line) => line.trim() === "## Abstract");
  const abstract = source.split("\n").slice(abstractIndex + 1).join("\n").trim();
  return {
    title: legacyBullet(raw, "Title"),
    authors: legacyBullet(raw, "Authors"),
    year: legacyBullet(raw, "Year"),
    venue: legacyBullet(raw, "Venue"),
    publicationType: legacyBullet(raw, "Publication type"),
    doi: legacyBullet(raw, "DOI"),
    url: legacyBullet(raw, "URL"),
    keywords: legacyBullet(raw, "Keywords"),
    importance: "",
    abstract: abstract || undefined
  };
}

const LEGACY_OUTLINE_HEADINGS = [
  "Abstract",
  "Research Problem",
  "Application Object",
  "Method Overview",
  "Main Conclusion",
  "Limitations",
  "Other"
] as const;

export function parseLegacyLiteratureOutlineV1(raw: string): LiteratureStructuredOutlineSummary {
  const values = headingSections(raw, LEGACY_OUTLINE_HEADINGS);
  return {
    abstract: values.Abstract || undefined,
    researchProblem: values["Research Problem"] || undefined,
    applicationObject: values["Application Object"] || undefined,
    methodOverview: values["Method Overview"] || undefined,
    mainConclusion: values["Main Conclusion"] || undefined,
    limitations: values.Limitations || undefined,
    other: values.Other || undefined
  };
}

const LEGACY_NOTES_HEADINGS = [
  "Summary",
  "Project Relevance",
  "Related Objects",
  "Reusable Methods",
  "Comparable Conclusions",
  "Other"
] as const;

export function parseLegacyLiteratureDedicatedNotesV1(raw: string): LiteratureDedicatedNotesSummary {
  const values = headingSections(raw, LEGACY_NOTES_HEADINGS);
  return {
    projectSummary: values.Summary || undefined,
    projectRelevance: values["Project Relevance"] || undefined,
    relatedObjectNotes: values["Related Objects"] || undefined,
    reusableMethods: values["Reusable Methods"] || undefined,
    comparableConclusions: values["Comparable Conclusions"] || undefined,
    other: values.Other || undefined
  };
}

export function parseLegacyLiteratureDocumentV1(input: {
  metaSnapshot: string;
  outline: string;
  channel: ManuscriptChannel;
}) {
  const meta = parseLegacyLiteratureMetaV1(input.metaSnapshot);
  if (input.channel === "literature_outline") {
    return { meta, outline: parseLegacyLiteratureOutlineV1(input.outline) };
  }
  if (input.channel === "dedicated_notes") {
    return { meta, outline: parseLegacyLiteratureDedicatedNotesV1(input.outline) };
  }
  fail(LITERATURE_CODEC_ERROR_CODES.channelMismatch, `Legacy Literature channel is invalid: ${input.channel}.`);
}
