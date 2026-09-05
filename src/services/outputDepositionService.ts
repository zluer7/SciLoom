import { outputConversionRelationService } from "./outputConversionRelationService";
import { outputConversionService } from "./outputConversionService";
import {
  createOutputSourceLink,
  queryOutputSourceLinksByOwner,
  softDeleteOutputSourceLink
} from "./outputSourceLinkService";
import { getOutputSourceSummary } from "./outputSourceSelectorService";
import { outputService } from "./outputService";
import type {
  Finding,
  OutputCandidate,
  OutputConversionEntityType,
  OutputConversionRelation,
  OutputConversionRelationType,
  OutputGap,
  OutputSourceSummary,
  ResultItem
} from "../types/outputConversion";
import type { ResearchOutput } from "../types/output";
import type { StructuredSummary } from "../types/outputStructuredSummary";
import type { OutputEntity } from "../types/outputSelector";

export type OutputDepositionSourceLayer = "resultItem" | "finding" | "outputCandidate";
export type OutputDepositionTargetLayer =
  | "finding"
  | "outputCandidate"
  | "outputGap"
  | "researchOutput";
export type OutputDepositionMode = "createNew" | "addExisting";

export type OutputDepositionPath = {
  sourceLayer: OutputDepositionSourceLayer;
  targetLayer: OutputDepositionTargetLayer;
  relationType: OutputConversionRelationType;
};

export type CreateOutputDepositionInput = {
  mode: "createNew";
  projectId: string;
  sourceLayer: OutputDepositionSourceLayer;
  sourceId: string;
  targetLayer: OutputDepositionTargetLayer;
  title: string;
  description?: string;
  entityType: string;
  structuredSummary?: StructuredSummary;
  sourceNote?: string;
  confirmedByUser: boolean;
};

export type AddExistingOutputDepositionInput = {
  mode: "addExisting";
  projectId: string;
  sourceLayer: OutputDepositionSourceLayer;
  sourceId: string;
  targetLayer: OutputDepositionTargetLayer;
  targetId: string;
  sourceNote?: string;
  confirmedByUser: boolean;
};

export type OutputDepositionInput =
  | CreateOutputDepositionInput
  | AddExistingOutputDepositionInput;

export type OutputDepositionResult = {
  mode: OutputDepositionMode;
  sourceLayer: OutputDepositionSourceLayer;
  sourceId: string;
  targetLayer: OutputDepositionTargetLayer;
  targetId: string;
  target: OutputEntity;
  relation: OutputConversionRelation;
  sourceSummary: OutputSourceSummary;
};

export const OUTPUT_DEPOSITION_PATHS = [
  { sourceLayer: "resultItem", targetLayer: "finding", relationType: "evidence_for" },
  { sourceLayer: "resultItem", targetLayer: "outputCandidate", relationType: "uses" },
  { sourceLayer: "finding", targetLayer: "outputCandidate", relationType: "supports" },
  { sourceLayer: "finding", targetLayer: "outputGap", relationType: "supports" },
  { sourceLayer: "outputCandidate", targetLayer: "outputGap", relationType: "supports" },
  {
    sourceLayer: "outputCandidate",
    targetLayer: "researchOutput",
    relationType: "converted_to"
  }
] as const satisfies readonly OutputDepositionPath[];

const LOCAL_PATH_PATTERN = /(?:[A-Za-z]:[\\/]|\\\\|file:\/\/\/?)[^\s"'<>|]+/gi;

function safeText(value: string | null | undefined) {
  return (value ?? "").replace(LOCAL_PATH_PATTERN, "[local path]").trim();
}

function safeStructuredSummary(summary: StructuredSummary | undefined) {
  return summary?.map((section) => ({ ...section, value: safeText(section.value) }));
}

function pathFor(
  sourceLayer: OutputDepositionSourceLayer,
  targetLayer: OutputDepositionTargetLayer
) {
  const path = OUTPUT_DEPOSITION_PATHS.find(
    (candidate) =>
      candidate.sourceLayer === sourceLayer && candidate.targetLayer === targetLayer
  );
  if (!path) {
    throw new Error(`Invalid output deposition path: ${sourceLayer} -> ${targetLayer}.`);
  }
  return path;
}

async function getEntity(layer: OutputConversionEntityType, id: string) {
  switch (layer) {
    case "resultItem":
      return outputConversionService.getResultItemById(id);
    case "finding":
      return outputConversionService.getFindingById(id);
    case "outputCandidate":
      return outputConversionService.getOutputCandidateById(id);
    case "outputGap":
      return outputConversionService.getOutputGapById(id);
    case "researchOutput":
      return outputService.getById(id);
    default:
      layer satisfies never;
      return undefined;
  }
}

function entityTitle(entity: OutputEntity) {
  return safeText("outputName" in entity ? entity.outputName : entity.title);
}

function entitySummary(entity: OutputEntity) {
  if ("description" in entity && typeof entity.description === "string") {
    return safeText(entity.description);
  }
  if ("summary" in entity && typeof entity.summary === "string") {
    return safeText(entity.summary);
  }
  return "";
}

function assertProject(entity: OutputEntity, projectId: string, label: string) {
  if (entity.projectId !== projectId) {
    throw new Error(`${label} belongs to another project.`);
  }
}

async function requireSource(input: OutputDepositionInput) {
  const source = await getEntity(input.sourceLayer, input.sourceId);
  if (!source) throw new Error("Output deposition source was not found.");
  assertProject(source, input.projectId, "Output deposition source");
  return source;
}

async function requireTarget(input: AddExistingOutputDepositionInput) {
  const target = await getEntity(input.targetLayer, input.targetId);
  if (!target) throw new Error("Output deposition target was not found.");
  assertProject(target, input.projectId, "Output deposition target");
  return target;
}

async function assertNoExistingDeposition(
  input: OutputDepositionInput,
  path: OutputDepositionPath,
  targetId: string
) {
  if (input.sourceLayer === input.targetLayer && input.sourceId === targetId) {
    throw new Error("Output deposition cannot point to itself.");
  }
  const [relations, sourceLinks] = await Promise.all([
    outputConversionRelationService.queryOutputConversionRelations({
      sourceType: input.sourceLayer,
      sourceId: input.sourceId,
      targetType: input.targetLayer,
      targetId,
      relationType: path.relationType
    }),
    queryOutputSourceLinksByOwner(input.targetLayer, targetId)
  ]);
  if (
    relations.length > 0 ||
    sourceLinks.some(
      (link) => link.sourceType === input.sourceLayer && link.sourceId === input.sourceId
    )
  ) {
    throw new Error("This output deposition already exists.");
  }
}

async function createTarget(
  input: CreateOutputDepositionInput
): Promise<OutputEntity> {
  const title = safeText(input.title);
  if (!title) throw new Error("Output deposition title is required.");
  const description = safeText(input.description);
  const structuredSummary = safeStructuredSummary(input.structuredSummary);

  switch (input.targetLayer) {
    case "finding":
      return outputConversionService.createFinding({
        projectId: input.projectId,
        title,
        summary: description,
        findingType: input.entityType as Finding["findingType"],
        status: "pending_confirmation",
        structuredSummary
      });
    case "outputCandidate":
      return outputConversionService.createOutputCandidate({
        projectId: input.projectId,
        title,
        description: description || undefined,
        candidateType: input.entityType as OutputCandidate["candidateType"],
        status: "pending_evaluation",
        structuredSummary
      });
    case "outputGap":
      return outputConversionService.createOutputGapForDeposition({
        projectId: input.projectId,
        title,
        description: description || undefined,
        gapType: input.entityType as OutputGap["gapType"],
        status: "pending",
        structuredSummary,
        confirmedByUser: true
      });
    case "researchOutput":
      return outputService.create({
        projectId: input.projectId,
        outputName: title,
        description,
        outputType: input.entityType as ResearchOutput["outputType"],
        status: "draft",
        usableForPaper: input.entityType === "paper_draft",
        provenance: {
          sourceType: "output_candidate",
          sourceCandidateId: input.sourceId,
          confirmedByUser: true
        }
      });
    default:
      input.targetLayer satisfies never;
      throw new Error("Unsupported output deposition target.");
  }
}

async function ensureLegacyGapCandidateRelation(
  input: OutputDepositionInput,
  targetId: string
) {
  if (input.sourceLayer !== "outputCandidate" || input.targetLayer !== "outputGap") {
    return;
  }
  await outputConversionRelationService.ensureOutputConversionRelation({
    projectId: input.projectId,
    sourceType: "outputGap",
    sourceId: targetId,
    targetType: "outputCandidate",
    targetId: input.sourceId,
    relationType: "blocks",
    note: "OutputGap blocks its source OutputCandidate"
  });
}

async function readPersistedResult(
  input: OutputDepositionInput,
  path: OutputDepositionPath,
  targetId: string
): Promise<OutputDepositionResult> {
  const [target, relations, sourceSummary] = await Promise.all([
    getEntity(input.targetLayer, targetId),
    outputConversionRelationService.queryOutputConversionRelations({
      sourceType: input.sourceLayer,
      sourceId: input.sourceId,
      targetType: input.targetLayer,
      targetId,
      relationType: path.relationType
    }),
    getOutputSourceSummary(input.targetLayer, targetId)
  ]);
  const relation = relations[0];
  const hasSource = sourceSummary.cards.some(
    (card) => card.sourceType === input.sourceLayer && card.sourceId === input.sourceId
  );
  if (!target || !relation || !hasSource) {
    throw new Error("Output deposition was written but failed read-after-write verification.");
  }
  return {
    mode: input.mode,
    sourceLayer: input.sourceLayer,
    sourceId: input.sourceId,
    targetLayer: input.targetLayer,
    targetId,
    target,
    relation,
    sourceSummary
  };
}

export async function executeOutputDeposition(
  input: OutputDepositionInput
): Promise<OutputDepositionResult> {
  if (input.confirmedByUser !== true) {
    throw new Error("Output deposition requires explicit user confirmation.");
  }
  const path = pathFor(input.sourceLayer, input.targetLayer);
  const source = await requireSource(input);
  const target =
    input.mode === "createNew" ? await createTarget(input) : await requireTarget(input);
  const targetId = target.id;
  await assertNoExistingDeposition(input, path, targetId);

  const sourceLink = await createOutputSourceLink({
    projectId: input.projectId,
    ownerType: input.targetLayer,
    ownerId: targetId,
    sourceType: input.sourceLayer,
    sourceId: input.sourceId,
    sourceTitleSnapshot: entityTitle(source),
    sourceSummarySnapshot: entitySummary(source),
    sourceNote: safeText(input.sourceNote),
    relationType: "supporting"
  });

  try {
    await outputConversionRelationService.ensureOutputConversionRelation({
      projectId: input.projectId,
      sourceType: input.sourceLayer,
      sourceId: input.sourceId,
      targetType: input.targetLayer,
      targetId,
      relationType: path.relationType,
      note: safeText(input.sourceNote)
    });
    await ensureLegacyGapCandidateRelation(input, targetId);
  } catch (cause) {
    await softDeleteOutputSourceLink(sourceLink.id);
    throw cause;
  }

  return readPersistedResult(input, path, targetId);
}

export const outputDepositionService = {
  executeOutputDeposition
};
