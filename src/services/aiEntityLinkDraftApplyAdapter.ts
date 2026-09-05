import type {
  AIActionDraft,
  AIActionDraftApplyResult,
  AIEntityLinkCreateDraftPayload
} from "../types/aiDraft";
import type { EntityType, RelationType } from "../types/planning";
import { entityLinkService } from "./entityLinkService";
import { experimentService } from "./experimentService";
import { literatureService } from "./literatureService";
import { outputConversionService } from "./outputConversionService";
import { planningService } from "./planningService";

type ResolvedEntity = { id: string };
type GetEntityByTypeService = (
  entityType: EntityType,
  entityId: string
) => Promise<ResolvedEntity | undefined>;
type EnsureEntityLinkService = typeof entityLinkService.ensureEntityLink;

export interface ApplyAIEntityLinkDraftOptions {
  draft: AIActionDraft<"entity_link_create">;
  appliedAt?: string;
  getEntityByType?: GetEntityByTypeService;
  ensureEntityLink?: EnsureEntityLinkService;
}

const RELATION_TYPES = new Set<RelationType>([
  "belongs_to",
  "depends_on",
  "blocks",
  "supports",
  "supported_by",
  "produces",
  "references",
  "cites",
  "derived_from",
  "evidence_for",
  "contradicts",
  "uses",
  "requires",
  "supplements",
  "extends",
  "converted_to",
  "generates_finding",
  "supports_output",
  "needs_followup_task",
  "adjusts",
  "summarizes",
  "related_to"
]);
const SUPPORTED_ENTITY_TYPES = new Set<EntityType>([
  "project",
  "routeNode",
  "task",
  "review",
  "experiment",
  "resultItem",
  "finding",
  "outputCandidate",
  "outputGap",
  "literature"
]);

const OUTPUT_CONVERSION_INTERNAL_ENTITY_TYPES = new Set<string>([
  "resultItem",
  "finding",
  "outputCandidate",
  "outputGap",
  "researchOutput",
  "output"
]);

const OUTPUT_CONVERSION_INTERNAL_RELATION_TYPES = new Set<string>([
  "evidence_for",
  "supports",
  "uses",
  "blocks",
  "converted_to",
  "resolves",
  "extends",
  "contradicts",
  "derived_from"
]);

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function payloadValue(
  draft: AIActionDraft<"entity_link_create">
): AIEntityLinkCreateDraftPayload | undefined {
  const payload: unknown = draft.proposedPayload;
  return typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? (payload as AIEntityLinkCreateDraftPayload)
    : undefined;
}

function failedResult(
  draftId: string,
  appliedAt: string,
  errorCode: string,
  message: string
): AIActionDraftApplyResult {
  return {
    success: false,
    result: "failed",
    message,
    errorCode,
    errorMessage: message,
    sourceDraftId: draftId,
    appliedAt
  };
}

function isOutputConversionInternalEntityType(entityType: unknown) {
  return (
    typeof entityType === "string" &&
    OUTPUT_CONVERSION_INTERNAL_ENTITY_TYPES.has(entityType)
  );
}

function isOutputConversionInternalEntityLink(sourceType: unknown, targetType: unknown) {
  return (
    isOutputConversionInternalEntityType(sourceType) &&
    isOutputConversionInternalEntityType(targetType)
  );
}

async function getEntityByType(
  entityType: EntityType,
  entityId: string
): Promise<ResolvedEntity | undefined> {
  if (entityType === "project") return planningService.getProjectById(entityId);
  if (entityType === "routeNode") return planningService.getRouteNodeById(entityId);
  if (entityType === "task") return planningService.getTaskById(entityId);
  if (entityType === "review") return planningService.getReviewById(entityId);
  if (entityType === "experiment") return experimentService.getExperimentById(entityId);
  if (entityType === "resultItem") return outputConversionService.getResultItemById(entityId);
  if (entityType === "finding") return outputConversionService.getFindingById(entityId);
  if (entityType === "outputCandidate") {
    return outputConversionService.getOutputCandidateById(entityId);
  }
  if (entityType === "outputGap") return outputConversionService.getOutputGapById(entityId);
  if (entityType === "literature") return literatureService.getLiteratureById(entityId);
  return undefined;
}

export async function applyAIEntityLinkDraft({
  draft,
  appliedAt = new Date().toISOString(),
  getEntityByType: resolveEntity = getEntityByType,
  ensureEntityLink = entityLinkService.ensureEntityLink
}: ApplyAIEntityLinkDraftOptions): Promise<AIActionDraftApplyResult> {
  const draftType: string = draft.draftType;
  if (draftType !== "entity_link_create") {
    return failedResult(
      draft.draftInstanceId,
      appliedAt,
      "unsupported_draft_type",
      `EntityLink adapter does not support draft type ${draftType}.`
    );
  }

  const payload = payloadValue(draft);
  const sourceId = payload ? textValue(payload.sourceId) : undefined;
  const targetId = payload ? textValue(payload.targetId) : undefined;
  const sourceType = payload?.sourceType;
  const targetType = payload?.targetType;
  const relationType = payload?.relationType;
  if (!payload || !sourceType || !sourceId || !targetType || !targetId || !relationType) {
    return failedResult(
      draft.draftInstanceId,
      appliedAt,
      "invalid_entity_link_payload",
      "entity_link_create requires sourceType/sourceId, targetType/targetId, and relationType."
    );
  }
  if (isOutputConversionInternalEntityLink(sourceType, targetType)) {
    const relationBoundary = OUTPUT_CONVERSION_INTERNAL_RELATION_TYPES.has(relationType)
      ? ` Relation type ${relationType} belongs to the OutputConversion internal relation contract.`
      : "";
    return failedResult(
      draft.draftInstanceId,
      appliedAt,
      "output_conversion_internal_relation_forbidden",
      `entity_link_create cannot write EntityLink between OutputConversion internal entities: ${sourceType} -> ${targetType}.${relationBoundary} Use outputConversionRelationService/output_conversion_relations instead.`
    );
  }
  if (!SUPPORTED_ENTITY_TYPES.has(sourceType) || !SUPPORTED_ENTITY_TYPES.has(targetType)) {
    return failedResult(
      draft.draftInstanceId,
      appliedAt,
      "unsupported_entity_type",
      `EntityLink type is not safely verifiable: ${sourceType} -> ${targetType}.`
    );
  }
  if (!RELATION_TYPES.has(relationType)) {
    return failedResult(
      draft.draftInstanceId,
      appliedAt,
      "invalid_relation_type",
      `EntityLink relationType is not supported: ${relationType}.`
    );
  }
  if (sourceType === targetType && sourceId === targetId) {
    return failedResult(
      draft.draftInstanceId,
      appliedAt,
      "invalid_entity_link_payload",
      "EntityLink source and target must identify different entities."
    );
  }

  try {
    const source = await resolveEntity(sourceType, sourceId);
    if (!source) {
      return failedResult(
        draft.draftInstanceId,
        appliedAt,
        "entity_link_source_not_found",
        `EntityLink source was not found: ${sourceType}:${sourceId}.`
      );
    }
    const target = await resolveEntity(targetType, targetId);
    if (!target) {
      return failedResult(
        draft.draftInstanceId,
        appliedAt,
        "entity_link_target_not_found",
        `EntityLink target was not found: ${targetType}:${targetId}.`
      );
    }

    const link = await ensureEntityLink({
      sourceType,
      sourceId,
      targetType,
      targetId,
      relationType,
      description: textValue(payload.reason)
    });
    return {
      success: true,
      result: "written",
      message: `Ensured one EntityLink ${link.id} from AI draft ${draft.draftInstanceId}.`,
      createdEntity: {
        module: "link",
        entityType: "entityLink",
        entityId: link.id,
        label: `${sourceType}:${sourceId} ${relationType} ${targetType}:${targetId}`
      },
      sourceDraftId: draft.draftInstanceId,
      appliedAt
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown EntityLink creation error.";
    return failedResult(
      draft.draftInstanceId,
      appliedAt,
      "entity_link_create_failed",
      `EntityLink creation failed: ${message}`
    );
  }
}
