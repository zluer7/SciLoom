import type { Language } from "../i18n/translations";
import type { Literature, ManuscriptChannel } from "../types";
import type {
  LiteratureKnowledgeDepositSummary,
  LiteratureLinkSummary,
  LiteratureStructuredOutlineSummary
} from "../types/literatureContext";
import {
  buildLiteratureKnowledgeDepositSummary,
  buildLiteratureStructuredOutlineSummary
} from "./literatureFieldMappingService";
import {
  buildLiteratureMetaV2Data,
  type LiteratureMetaV2Data
} from "./literatureMarkdownCodecService";
import { formatManuscriptContextSummaryMarkdown } from "./manuscriptPresentationNormalization";

export type LiteratureContextInsertChannel = Extract<
  ManuscriptChannel,
  "literature_outline" | "dedicated_notes"
>;

export interface LiteratureContextInsertDto {
  manuscriptChannel: LiteratureContextInsertChannel;
  meta: LiteratureMetaV2Data;
  outline: LiteratureStructuredOutlineSummary | LiteratureKnowledgeDepositSummary;
  markdown: string;
}

function requireChannel(channel: ManuscriptChannel): LiteratureContextInsertChannel {
  if (channel !== "literature_outline" && channel !== "dedicated_notes") {
    throw new Error(`Unsupported Literature context insert channel: ${channel}.`);
  }
  return channel;
}

function labels(language: Language) {
  return language === "zh-CN"
    ? {
        intro: "文献上下文摘要",
        title: "标题",
        authors: "作者",
        year: "年份",
        publicationType: "类型",
        venue: "来源",
        doi: "DOI",
        url: "URL",
        importance: "重要性",
        keywords: "关键词",
        summary: "摘要",
        researchProblem: "研究问题",
        applicationObject: "应用对象",
        method: "方法概要",
        conclusion: "主要结论",
        limitations: "局限性",
        projectRelevance: "课题相关度建议",
        relatedObjects: "关联对象",
        reusableMethods: "可借鉴方法",
        comparableConclusions: "可对比结论",
        other: "其他",
        empty: "未填写"
      }
    : {
        intro: "Literature context summary",
        title: "Title",
        authors: "Authors",
        year: "Year",
        publicationType: "Type",
        venue: "Source",
        doi: "DOI",
        url: "URL",
        importance: "Importance",
        keywords: "Keywords",
        summary: "Summary",
        researchProblem: "Research question",
        applicationObject: "Application object",
        method: "Method overview",
        conclusion: "Main conclusions",
        limitations: "Limitations",
        projectRelevance: "Project relevance",
        relatedObjects: "Related objects",
        reusableMethods: "Reusable methods",
        comparableConclusions: "Comparable conclusions",
        other: "Other",
        empty: "Not filled in"
      };
}

function formatLine(label: string, value: unknown, empty: string, language: Language) {
  const normalized = value === undefined || value === null ? "" : String(value).trim();
  const separator = language === "zh-CN" ? "：" : ": ";
  return `- ${label}${separator}${normalized || empty}`;
}

function formatMeta(meta: LiteratureMetaV2Data, language: Language) {
  const text = labels(language);
  return [
    formatLine(text.title, meta.title, text.empty, language),
    formatLine(text.authors, meta.authors, text.empty, language),
    formatLine(text.year, meta.year, text.empty, language),
    formatLine(text.publicationType, meta.publicationType, text.empty, language),
    formatLine(text.venue, meta.venue, text.empty, language),
    formatLine(text.doi, meta.doi, text.empty, language),
    formatLine(text.url, meta.url, text.empty, language),
    formatLine(text.importance, meta.importance, text.empty, language),
    formatLine(text.keywords, meta.keywords, text.empty, language)
  ];
}

export function buildLiteratureContextInsert(input: {
  literature: Literature;
  linkSummaries: LiteratureLinkSummary[];
  manuscriptChannel: ManuscriptChannel;
  language: Language;
}): LiteratureContextInsertDto {
  const manuscriptChannel = requireChannel(input.manuscriptChannel);
  const meta = buildLiteratureMetaV2Data(input.literature);
  const outline = manuscriptChannel === "dedicated_notes"
    ? buildLiteratureKnowledgeDepositSummary(input.literature, input.linkSummaries)
    : buildLiteratureStructuredOutlineSummary(input.literature);
  const text = labels(input.language);
  const structuredValues = manuscriptChannel === "dedicated_notes"
    ? {
        summary: (outline as LiteratureKnowledgeDepositSummary).projectSummary,
        project_relevance: (outline as LiteratureKnowledgeDepositSummary).projectRelevance,
        related_objects: (outline as LiteratureKnowledgeDepositSummary).relatedObjectNotes,
        reusable_methods: (outline as LiteratureKnowledgeDepositSummary).reusableMethods,
        comparable_conclusions: (outline as LiteratureKnowledgeDepositSummary).comparableConclusions,
        other: (outline as LiteratureKnowledgeDepositSummary).other
      }
    : {
        summary: (outline as LiteratureStructuredOutlineSummary).abstract,
        research_problem: (outline as LiteratureStructuredOutlineSummary).researchProblem,
        application_object: (outline as LiteratureStructuredOutlineSummary).applicationObject,
        method_overview: (outline as LiteratureStructuredOutlineSummary).methodOverview,
        main_conclusion: (outline as LiteratureStructuredOutlineSummary).mainConclusion,
        limitations: (outline as LiteratureStructuredOutlineSummary).limitations,
        other: (outline as LiteratureStructuredOutlineSummary).other
      };
  const fieldLabels: Readonly<Record<string, string>> = manuscriptChannel === "dedicated_notes"
    ? {
        summary: text.summary,
        project_relevance: text.projectRelevance,
        related_objects: text.relatedObjects,
        reusable_methods: text.reusableMethods,
        comparable_conclusions: text.comparableConclusions,
        other: text.other
      }
    : {
        summary: text.summary,
        research_problem: text.researchProblem,
        application_object: text.applicationObject,
        method_overview: text.method,
        main_conclusion: text.conclusion,
        limitations: text.limitations,
        other: text.other
      };
  const markdown = formatManuscriptContextSummaryMarkdown({
    heading: text.intro,
    bodyGroups: [formatMeta(meta, input.language)],
    descriptorLookupIdentity: {
      ownerType: "literature",
      channel: manuscriptChannel
    },
    structuredValues,
    emptyValue: text.empty,
    resolveLabel: (field) => fieldLabels[field.stableKey] ?? field.displayLabel
  });

  return { manuscriptChannel, meta, outline, markdown };
}

export const literatureContextInsertService = {
  build: buildLiteratureContextInsert
};
