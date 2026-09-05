import type {
  EntityId,
  LabPodMarkdownDiagnostic,
  LabPodMarkdownDocumentStatus,
  Literature
} from "../types";
import type { LiteratureStructuredOutlineSummary } from "../types/literatureContext";
import { literatureRepository } from "../repositories/literatureRepository";
import {
  buildLiteratureStructuredOutlineSummary,
  LITERATURE_CUSTOM_FIELD_KEYS,
  mergeLiteratureCustomFields
} from "./literatureFieldMappingService";
import {
  parseLabPodMarkdownDocument,
  upsertLabPodStandardBlocks
} from "./labPodMarkdownDocumentService";
import {
  assertLiteratureDocumentV2,
  buildLiteratureMetaSnapshotV2,
  canonicalizeLiteratureDocumentV2,
  literatureCodecDiagnosticFromUnknown,
  parseLiteratureOutlineForRuntime,
  serializeLiteratureDedicatedNotesV2,
  serializeLiteratureOutlineV2,
  type LiteratureDedicatedNotesSummary
} from "./literatureMarkdownCodecService";
import { literatureService } from "./literatureService";
import type { LiteratureManuscriptChannel } from "./literatureRawManuscriptService";

export interface LiteratureManuscriptBlocks {
  metaSnapshot: string;
  outline: string;
  body: string;
  parseStatus: LabPodMarkdownDocumentStatus;
  diagnostics: LabPodMarkdownDiagnostic[];
}

export type LiteratureManuscriptBlocksResult =
  | { status: "success"; blocks: LiteratureManuscriptBlocks }
  | {
      status: "error";
      error: { code: string; message: string };
      diagnostics: string[];
    };

function value(literature: Literature, key: string) {
  const field = literature.customFields?.find((item) => item.name === key)?.value;
  return typeof field === "string" ? field : undefined;
}

function buildDedicatedNotes(
  literature: Literature
): LiteratureDedicatedNotesSummary {
  return {
    projectSummary: value(
      literature,
      LITERATURE_CUSTOM_FIELD_KEYS.knowledgeProjectSummary
    ),
    projectRelevance: value(
      literature,
      LITERATURE_CUSTOM_FIELD_KEYS.knowledgeProjectRelevance
    ),
    relatedObjectNotes: value(
      literature,
      LITERATURE_CUSTOM_FIELD_KEYS.knowledgeRelatedObjectNotes
    ),
    reusableMethods: value(
      literature,
      LITERATURE_CUSTOM_FIELD_KEYS.knowledgeReusableMethods
    ),
    comparableConclusions: value(
      literature,
      LITERATURE_CUSTOM_FIELD_KEYS.knowledgeComparableConclusions
    ),
    other: value(literature, LITERATURE_CUSTOM_FIELD_KEYS.knowledgeOther)
  };
}

async function getActiveLiterature(literatureId: EntityId) {
  const literature = await literatureRepository.getById(literatureId);
  if (!literature) {
    throw new Error(`Literature not found or inactive: ${literatureId}.`);
  }
  return literature;
}

export function serializeLiteratureStructuredState(
  literature: Literature,
  channel: LiteratureManuscriptChannel
) {
  return channel === "dedicated_notes"
    ? serializeLiteratureDedicatedNotesV2(buildDedicatedNotes(literature))
    : serializeLiteratureOutlineV2(
        buildLiteratureStructuredOutlineSummary(literature)
      );
}

export function extractLiteratureManuscriptBlocks(
  rawMarkdown: string,
  channel: LiteratureManuscriptChannel
): LiteratureManuscriptBlocksResult {
  const parsed = parseLabPodMarkdownDocument(rawMarkdown);
  if (parsed.status === "invalid" || parsed.status === "ambiguous") {
    return {
      status: "error",
      error: {
        code: "LITERATURE_MANUSCRIPT_STANDARD_BLOCKS_INVALID",
        message:
          "The Literature manuscript has invalid or ambiguous standard blocks."
      },
      diagnostics: parsed.diagnostics.map((item) => item.code)
    };
  }
  if (parsed.status === "missing") {
    return {
      status: "success",
      blocks: {
        metaSnapshot: "",
        outline: "",
        body: rawMarkdown,
        parseStatus: parsed.status,
        diagnostics: parsed.diagnostics
      }
    };
  }
  try {
    assertLiteratureDocumentV2({
      metaSnapshot: parsed.metaSnapshot ?? "",
      outline: parsed.outline ?? "",
      channel
    });
  } catch (error) {
    const diagnostics = literatureCodecDiagnosticFromUnknown(error);
    return {
      status: "error",
      error: {
        code:
          diagnostics[0]?.code ??
          "LITERATURE_MANUSCRIPT_CODEC_INVALID",
        message:
          diagnostics[0]?.message ??
          "The Literature manuscript codec is invalid."
      },
      diagnostics: diagnostics.map((item) => item.code)
    };
  }
  return {
    status: "success",
    blocks: {
      metaSnapshot: parsed.metaSnapshot ?? "",
      outline: parsed.outline ?? "",
      body: parsed.body ?? "",
      parseStatus: parsed.status,
      diagnostics: parsed.diagnostics
    }
  };
}

export async function buildLiteratureManuscriptView(
  literatureId: EntityId,
  channel: LiteratureManuscriptChannel,
  rawMarkdown: string
): Promise<LiteratureManuscriptBlocksResult> {
  const extracted = extractLiteratureManuscriptBlocks(
    rawMarkdown,
    channel
  );
  if (
    extracted.status === "error" ||
    extracted.blocks.parseStatus !== "missing"
  ) {
    return extracted;
  }
  const literature = await getActiveLiterature(literatureId);
  return {
    status: "success",
    blocks: {
      ...extracted.blocks,
      metaSnapshot: buildLiteratureMetaSnapshotV2(literature),
      outline: serializeLiteratureStructuredState(literature, channel)
    }
  };
}

export function replaceLiteratureManuscriptSections(input: {
  existingMarkdown: string;
  channel: LiteratureManuscriptChannel;
  metaSnapshot: string;
  outline: string;
  body: string;
}): LiteratureManuscriptBlocksResult & { markdown?: string } {
  let canonical;
  try {
    canonical = canonicalizeLiteratureDocumentV2({
      metaSnapshot: input.metaSnapshot,
      outline: input.outline,
      channel: input.channel
    });
  } catch (error) {
    const diagnostics = literatureCodecDiagnosticFromUnknown(error);
    return {
      status: "error",
      error: {
        code:
          diagnostics[0]?.code ??
          "LITERATURE_MANUSCRIPT_CODEC_INVALID",
        message:
          diagnostics[0]?.message ??
          "The Literature manuscript codec is invalid."
      },
      diagnostics: diagnostics.map((item) => item.code)
    };
  }
  const parsed = parseLabPodMarkdownDocument(input.existingMarkdown);
  if (parsed.status === "invalid" || parsed.status === "ambiguous") {
    return {
      status: "error",
      error: {
        code: "LITERATURE_MANUSCRIPT_STANDARD_BLOCKS_INVALID",
        message:
          "The Literature manuscript has invalid or ambiguous standard blocks."
      },
      diagnostics: parsed.diagnostics.map((item) => item.code)
    };
  }
  const serialized = upsertLabPodStandardBlocks(
    input.existingMarkdown,
    {
      metaSnapshot: canonical.metaSnapshot,
      outline: canonical.outline,
      body: input.body
    },
    parsed.status === "missing"
      ? { mode: "normalize", preserveOutsideContent: true }
      : { mode: "strict", preserveOutsideContent: true }
  );
  if (serialized.status === "error") {
    return {
      status: "error",
      error: {
        code: "LITERATURE_MANUSCRIPT_SERIALIZE_FAILED",
        message: "The Literature manuscript could not be serialized safely."
      },
      diagnostics: serialized.diagnostics.map((item) => item.code)
    };
  }
  const next = extractLiteratureManuscriptBlocks(
    serialized.markdown,
    input.channel
  );
  return next.status === "success"
    ? { ...next, markdown: serialized.markdown }
    : next;
}

export async function buildCurrentLiteratureManuscriptRaw(input: {
  literatureId: EntityId;
  channel: LiteratureManuscriptChannel;
  existingMarkdown: string;
  body: string;
}) {
  const literature = await getActiveLiterature(input.literatureId);
  return replaceLiteratureManuscriptSections({
    existingMarkdown: input.existingMarkdown,
    channel: input.channel,
    metaSnapshot: buildLiteratureMetaSnapshotV2(literature),
    outline: serializeLiteratureStructuredState(literature, input.channel),
    body: input.body
  });
}

async function applyDedicatedNotes(
  literatureId: EntityId,
  outlineMarkdown: string
) {
  const literature = await getActiveLiterature(literatureId);
  const notes = parseLiteratureOutlineForRuntime(
    outlineMarkdown,
    "dedicated_notes"
  ) as LiteratureDedicatedNotesSummary;
  const customFields = mergeLiteratureCustomFields(literature, {
    [LITERATURE_CUSTOM_FIELD_KEYS.knowledgeProjectSummary]:
      notes.projectSummary ?? null,
    [LITERATURE_CUSTOM_FIELD_KEYS.knowledgeProjectRelevance]:
      notes.projectRelevance ?? null,
    [LITERATURE_CUSTOM_FIELD_KEYS.knowledgeRelatedObjectNotes]:
      notes.relatedObjectNotes ?? null,
    [LITERATURE_CUSTOM_FIELD_KEYS.knowledgeReusableMethods]:
      notes.reusableMethods ?? null,
    [LITERATURE_CUSTOM_FIELD_KEYS.knowledgeComparableConclusions]:
      notes.comparableConclusions ?? null,
    [LITERATURE_CUSTOM_FIELD_KEYS.knowledgeOther]: notes.other ?? null
  });
  const updated = await literatureService.updateLiterature(literatureId, {
    customFields
  });
  if (!updated) {
    throw new Error(`Literature dedicated notes update failed: ${literatureId}.`);
  }
}

async function applyOutline(
  literatureId: EntityId,
  outlineMarkdown: string
) {
  const literature = await getActiveLiterature(literatureId);
  const outline = parseLiteratureOutlineForRuntime(
    outlineMarkdown,
    "literature_outline"
  ) as LiteratureStructuredOutlineSummary;
  const customFields = mergeLiteratureCustomFields(literature, {
    [LITERATURE_CUSTOM_FIELD_KEYS.outlineResearchProblem]:
      outline.researchProblem ?? null,
    [LITERATURE_CUSTOM_FIELD_KEYS.outlineApplicationObject]:
      outline.applicationObject ?? null,
    [LITERATURE_CUSTOM_FIELD_KEYS.outlineMethodOverview]:
      outline.methodOverview ?? null,
    [LITERATURE_CUSTOM_FIELD_KEYS.outlineMainConclusion]:
      outline.mainConclusion ?? null,
    [LITERATURE_CUSTOM_FIELD_KEYS.outlineLimitations]:
      outline.limitations ?? null,
    [LITERATURE_CUSTOM_FIELD_KEYS.outlineOther]: outline.other ?? null
  });
  const updated = await literatureService.updateLiterature(literatureId, {
    abstract: outline.abstract,
    customFields
  });
  if (!updated) {
    throw new Error(`Literature outline update failed: ${literatureId}.`);
  }
}

export const literatureManuscriptAdapterService = Object.freeze({
  extract: extractLiteratureManuscriptBlocks,
  buildView: buildLiteratureManuscriptView,
  replaceSections: replaceLiteratureManuscriptSections,
  buildCurrentRaw: buildCurrentLiteratureManuscriptRaw,
  async applyOutlineForFormalSwitch(
    literatureId: EntityId,
    channel: LiteratureManuscriptChannel,
    outlineMarkdown: string
  ) {
    assertLiteratureDocumentV2({
      metaSnapshot: buildLiteratureMetaSnapshotV2(
        await getActiveLiterature(literatureId)
      ),
      outline: outlineMarkdown,
      channel
    });
    return channel === "dedicated_notes"
      ? applyDedicatedNotes(literatureId, outlineMarkdown)
      : applyOutline(literatureId, outlineMarkdown);
  }
});
