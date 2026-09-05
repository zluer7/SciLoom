import { outputConversionRelationRepositoryConfig } from "../repositories/entityConfig";
import { createRepository } from "../repositories/repositoryFactory";
import type { CreateEntityInput, EntityId } from "../types/common";
import type {
  CreateOutputConversionRelationInput,
  OutputConversionEntityType,
  OutputConversionRelation,
  OutputConversionRelationType,
  QueryOutputConversionRelationsInput,
  UpdateOutputConversionRelationInput
} from "../types/outputConversion";

const OUTPUT_CONVERSION_RELATION_SCHEMA_VERSION = 1;

type RelationConstraint =
  | {
      sourceType: OutputConversionEntityType;
      targetType: OutputConversionEntityType;
      additionalPairs?: Array<{
        sourceType: OutputConversionEntityType;
        targetType: OutputConversionEntityType;
      }>;
    }
  | {
      sameType: Array<"finding" | "outputCandidate">;
    };

type ReplaceRelationsForSourceQuery = {
  sourceType: OutputConversionEntityType;
  sourceId: EntityId;
  targetType: OutputConversionEntityType;
  relationType: OutputConversionRelationType;
};

type ReplaceRelationsForTargetQuery = {
  sourceType: OutputConversionEntityType;
  targetType: OutputConversionEntityType;
  targetId: EntityId;
  relationType: OutputConversionRelationType;
};

export const OUTPUT_CONVERSION_RELATION_CONSTRAINTS: Record<
  OutputConversionRelationType,
  RelationConstraint
> = {
  evidence_for: { sourceType: "resultItem", targetType: "finding" },
  supports: { sourceType: "finding", targetType: "outputCandidate", additionalPairs: [
      { sourceType: "finding", targetType: "outputGap" },
      { sourceType: "outputCandidate", targetType: "outputGap" }
    ] },
  uses: { sourceType: "resultItem", targetType: "outputCandidate" },
  blocks: { sourceType: "outputGap", targetType: "outputCandidate" },
  converted_to: { sourceType: "outputCandidate", targetType: "researchOutput" },
  resolves: { sourceType: "resultItem", targetType: "outputGap" },
  extends: { sameType: ["finding", "outputCandidate"] },
  contradicts: { sameType: ["finding", "outputCandidate"] }
};

const relationRepository = createRepository<OutputConversionRelation>(
  outputConversionRelationRepositoryConfig
);

function nowIso() {
  return new Date().toISOString();
}

function textOrNull(value?: string | null) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function validateOutputConversionRelation(
  input: Pick<
    CreateOutputConversionRelationInput,
    "sourceType" | "sourceId" | "targetType" | "targetId" | "relationType"
  >
) {
  if (!input.sourceId || !input.targetId) {
    throw new Error("OutputConversionRelation sourceId and targetId are required.");
  }
  if (input.sourceType === input.targetType && input.sourceId === input.targetId) {
    throw new Error("OutputConversionRelation cannot point to the same entity.");
  }

  const constraint = OUTPUT_CONVERSION_RELATION_CONSTRAINTS[input.relationType];
  if ("sameType" in constraint) {
    const allowed = constraint.sameType.includes(
      input.sourceType as "finding" | "outputCandidate"
    );
    if (!allowed || input.sourceType !== input.targetType) {
      throw new Error(
        `Invalid ${input.relationType} relation: ${input.sourceType} -> ${input.targetType}.`
      );
    }
    return;
  }

  const isPrimaryPair =
    input.sourceType === constraint.sourceType && input.targetType === constraint.targetType;
  const isAdditionalPair = constraint.additionalPairs?.some(
    (pair) => input.sourceType === pair.sourceType && input.targetType === pair.targetType
  );
  if (!isPrimaryPair && !isAdditionalPair) {
    throw new Error(
      `Invalid ${input.relationType} relation: ${input.sourceType} -> ${input.targetType}.`
    );
  }
}

function relationMatches(
  relation: OutputConversionRelation,
  query: QueryOutputConversionRelationsInput
) {
  return (
    (query.includeDeleted || !relation.deletedAt) &&
    (query.projectId === undefined || relation.projectId === query.projectId) &&
    (!query.sourceType || relation.sourceType === query.sourceType) &&
    (!query.sourceId || relation.sourceId === query.sourceId) &&
    (!query.targetType || relation.targetType === query.targetType) &&
    (!query.targetId || relation.targetId === query.targetId) &&
    (!query.relationType || relation.relationType === query.relationType)
  );
}

export async function queryOutputConversionRelations(
  query: QueryOutputConversionRelationsInput = {}
) {
  return (await relationRepository.list()).filter((relation) => relationMatches(relation, query));
}

async function findActiveDuplicate(input: CreateOutputConversionRelationInput) {
  const existing = await queryOutputConversionRelations({
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    targetType: input.targetType,
    targetId: input.targetId,
    relationType: input.relationType
  });
  return existing[0];
}

function toCreateInput(
  input: CreateOutputConversionRelationInput
): CreateEntityInput<OutputConversionRelation> {
  return {
    projectId: input.projectId ?? null,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    targetType: input.targetType,
    targetId: input.targetId,
    relationType: input.relationType,
    note: textOrNull(input.note),
    schemaVersion: OUTPUT_CONVERSION_RELATION_SCHEMA_VERSION
  };
}

export async function ensureOutputConversionRelation(input: CreateOutputConversionRelationInput) {
  validateOutputConversionRelation(input);
  const existing = await findActiveDuplicate(input);
  if (existing) {
    return existing;
  }
  const relation = await relationRepository.create(toCreateInput(input));
  const persisted = await relationRepository.getById(relation.id);
  if (!persisted) {
    throw new Error(
      "OutputConversionRelation was submitted but is not readable from the current persistence source."
    );
  }
  return persisted;
}

export async function updateOutputConversionRelation(
  id: EntityId,
  patch: UpdateOutputConversionRelationInput
) {
  return relationRepository.update(id, {
    note: textOrNull(patch.note)
  });
}

export async function deleteOutputConversionRelation(id: EntityId) {
  return relationRepository.update(id, { deletedAt: nowIso() });
}

export async function deleteOutputConversionRelationsByQuery(
  query: QueryOutputConversionRelationsInput
) {
  const relations = await queryOutputConversionRelations(query);
  await Promise.all(relations.map((relation) => deleteOutputConversionRelation(relation.id)));
  return relations.length;
}

export async function replaceOutputConversionRelationsForSource(
  query: ReplaceRelationsForSourceQuery,
  targets: Array<Pick<CreateOutputConversionRelationInput, "projectId" | "targetType" | "targetId" | "relationType" | "note">>
) {
  const active = await queryOutputConversionRelations(query);
  const targetKeys = new Set(
    targets.map((target) => `${target.targetType}:${target.targetId}:${target.relationType}`)
  );
  await Promise.all(
    active
      .filter((relation) => !targetKeys.has(`${relation.targetType}:${relation.targetId}:${relation.relationType}`))
      .map((relation) => deleteOutputConversionRelation(relation.id))
  );
  return Promise.all(
    targets.map((target) =>
      ensureOutputConversionRelation({
        projectId: target.projectId,
        sourceType: query.sourceType,
        sourceId: query.sourceId,
        targetType: target.targetType,
        targetId: target.targetId,
        relationType: target.relationType,
        note: target.note
      })
    )
  );
}

export async function replaceOutputConversionRelationsForTarget(
  query: ReplaceRelationsForTargetQuery,
  sources: Array<Pick<CreateOutputConversionRelationInput, "projectId" | "sourceType" | "sourceId" | "relationType" | "note">>
) {
  const active = await queryOutputConversionRelations(query);
  const sourceKeys = new Set(
    sources.map((source) => `${source.sourceType}:${source.sourceId}:${source.relationType}`)
  );
  await Promise.all(
    active
      .filter((relation) => !sourceKeys.has(`${relation.sourceType}:${relation.sourceId}:${relation.relationType}`))
      .map((relation) => deleteOutputConversionRelation(relation.id))
  );
  return Promise.all(
    sources.map((source) =>
      ensureOutputConversionRelation({
        projectId: source.projectId,
        sourceType: source.sourceType,
        sourceId: source.sourceId,
        targetType: query.targetType,
        targetId: query.targetId,
        relationType: source.relationType,
        note: source.note
      })
    )
  );
}

export const outputConversionRelationService = {
  queryOutputConversionRelations,
  ensureOutputConversionRelation,
  updateOutputConversionRelation,
  deleteOutputConversionRelation,
  deleteOutputConversionRelationsByQuery,
  replaceOutputConversionRelationsForSource,
  replaceOutputConversionRelationsForTarget,
  validateOutputConversionRelation
};

export type OutputConversionRelationService = typeof outputConversionRelationService;
