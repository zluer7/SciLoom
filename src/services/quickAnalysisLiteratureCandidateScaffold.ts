import type { Literature, ManuscriptChannel } from "../types";
import {
  buildLiteratureStructuredOutlineSummary,
  getLiteratureCustomStringField,
  LITERATURE_CUSTOM_FIELD_KEYS
} from "./literatureFieldMappingService";
import {
  buildLiteratureMetaSnapshotV2,
  serializeLiteratureDedicatedNotesV2,
  serializeLiteratureOutlineV2,
  type LiteratureDedicatedNotesSummary
} from "./literatureMarkdownCodecService";

function buildDedicatedNotes(
  literature: Literature
): LiteratureDedicatedNotesSummary {
  return {
    projectSummary: getLiteratureCustomStringField(
      literature,
      LITERATURE_CUSTOM_FIELD_KEYS.knowledgeProjectSummary
    ),
    projectRelevance: getLiteratureCustomStringField(
      literature,
      LITERATURE_CUSTOM_FIELD_KEYS.knowledgeProjectRelevance
    ),
    relatedObjectNotes: getLiteratureCustomStringField(
      literature,
      LITERATURE_CUSTOM_FIELD_KEYS.knowledgeRelatedObjectNotes
    ),
    reusableMethods: getLiteratureCustomStringField(
      literature,
      LITERATURE_CUSTOM_FIELD_KEYS.knowledgeReusableMethods
    ),
    comparableConclusions: getLiteratureCustomStringField(
      literature,
      LITERATURE_CUSTOM_FIELD_KEYS.knowledgeComparableConclusions
    ),
    other: getLiteratureCustomStringField(
      literature,
      LITERATURE_CUSTOM_FIELD_KEYS.knowledgeOther
    )
  };
}

/**
 * Pure candidate-document scaffolding. This consumes the canonical Literature
 * entity already resolved by the runtime source port; it performs no read,
 * eligibility decision, filesystem scan, or write.
 */
export function buildQuickAnalysisLiteratureCandidateScaffold(
  literature: Literature,
  channel: Extract<ManuscriptChannel, "literature_outline" | "dedicated_notes">
) {
  return {
    metaSnapshot: buildLiteratureMetaSnapshotV2(literature),
    outline: channel === "dedicated_notes"
      ? serializeLiteratureDedicatedNotesV2(buildDedicatedNotes(literature))
      : serializeLiteratureOutlineV2(
          buildLiteratureStructuredOutlineSummary(literature)
        )
  };
}
