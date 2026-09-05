import type { EntityId } from "../types";
import type { OutputExportRequest } from "../types/outputExportBundle";
import {
  exportOutputConversionBundle,
  exportOutputEntityAsMarkdown
} from "./outputExportBundleService";

type LegacySummaryOptions = {
  projectId?: EntityId;
  includeArchived?: boolean;
  limit?: number;
};

function withDefaults(request: OutputExportRequest): OutputExportRequest {
  const commonRequest = {
    id: request.id,
    format: request.format,
    includeEvidenceChain: request.includeEvidenceChain,
    includeSourceChain: request.includeSourceChain,
    includeStructuredSummary: request.includeStructuredSummary,
    includeFileRefs: request.includeFileRefs,
    includeRelations: request.includeRelations,
    includeDeleted: false as const
  };
  return { ...commonRequest, layer: request.layer };
}

export async function buildFindingMarkdown(findingId: EntityId) {
  return exportOutputEntityAsMarkdown(
    withDefaults({
      layer: "finding",
      id: findingId,
      includeEvidenceChain: true
    })
  );
}

export async function buildOutputCandidateMarkdown(candidateId: EntityId) {
  return exportOutputEntityAsMarkdown(
    withDefaults({
      layer: "outputCandidate",
      id: candidateId,
      includeEvidenceChain: true,
      includeSourceChain: true
    })
  );
}

export async function buildEvidenceChainMarkdown(candidateId: EntityId) {
  return exportOutputEntityAsMarkdown(
    withDefaults({
      layer: "outputCandidate",
      id: candidateId,
      includeEvidenceChain: true,
      includeSourceChain: false,
      includeStructuredSummary: false,
      includeFileRefs: true,
      includeRelations: true
    })
  );
}

export async function buildOutputConversionSummaryMarkdown(
  options: LegacySummaryOptions = {}
) {
  const filterLines = [
    options.projectId ? `- Project ID: ${options.projectId}` : undefined,
    options.includeArchived === true ? "- Archived records: included by caller filter" : undefined,
    options.limit === undefined ? undefined : `- Requested limit: ${options.limit}`
  ].filter((line): line is string => Boolean(line));
  return [
    "# Output Conversion Summary",
    "",
    "This legacy summary facade no longer performs a separate export query.",
    "Use outputExportBundleService with an explicit five-layer entity id for Markdown or bundle payloads.",
    "",
    "## Filters",
    "",
    filterLines.length > 0 ? filterLines.join("\n") : "- No filters",
    "",
    "## Safety",
    "",
    "- Uses LP8-7-B export service for entity exports",
    "- Does not read file bodies",
    "- Does not expose complete path fields",
    "- Does not call AI providers"
  ].join("\n");
}

export const outputConversionExportService = {
  buildFindingMarkdown,
  buildOutputCandidateMarkdown,
  buildEvidenceChainMarkdown,
  buildOutputConversionSummaryMarkdown,
  exportOutputConversionBundle
};

export type OutputConversionExportService = typeof outputConversionExportService;
