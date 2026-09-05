import type { EntityId, EntityLink, EntityType, RelationType } from "../types/planning";
import type { LinkWriteValidationIssue } from "../types/entityReference";
import {
  entityLinkToSourceReference,
  entityLinkToTargetReference,
  validateEntityReferences
} from "./entityReferenceResolverService";
import {
  createEntityLink as createPlanningEntityLink,
  deleteEntityLink,
  getPlanningFirstLayerData,
  getPlanningData
} from "./planningRepository";
import {
  createCrossModuleWriteFeedback,
  publishCrossModuleWriteFeedback
} from "./crossModuleWriteFeedbackService";
import type { AffectedEntity } from "../types/writeFeedback";
import type { ExperimentManuscriptOwnerType } from "../types/experimentManuscript";
import { tryAcquireExperimentManuscriptOwnerOperation } from "./experimentManuscriptOwnerOperationGate";

export type CreateEntityLinkInput = Omit<
  EntityLink,
  "id" | "createdAt" | "updatedAt" | "schemaVersion"
> &
  Partial<Pick<EntityLink, "id" | "createdAt" | "updatedAt" | "schemaVersion">>;

export type EntityLinkQueryOptions = {
  sourceType?: EntityType;
  sourceId?: EntityId;
  targetType?: EntityType;
  targetId?: EntityId;
  relationType?: RelationType;
};

const RELATION_TYPES = new Set<string>([
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

export class LinkWriteValidationError extends Error {
  constructor(public readonly issues: LinkWriteValidationIssue[]) {
    super(
      `EntityLink validation failed: ${issues
        .map((issue) => `${issue.code}: ${issue.message}`)
        .join("; ")}`
    );
    this.name = "LinkWriteValidationError";
  }
}

function now() {
  return new Date().toISOString();
}

export function isValidRelationType(value: unknown): value is RelationType {
  return typeof value === "string" && RELATION_TYPES.has(value);
}

function matchesQuery(link: EntityLink, query: EntityLinkQueryOptions) {
  return (
    (!query.sourceType || link.sourceType === query.sourceType) &&
    (!query.sourceId || link.sourceId === query.sourceId) &&
    (!query.targetType || link.targetType === query.targetType) &&
    (!query.targetId || link.targetId === query.targetId) &&
    (!query.relationType || link.relationType === query.relationType)
  );
}

function buildEntityLinkIssue(
  code: LinkWriteValidationIssue["code"],
  message: string,
  input: Partial<CreateEntityLinkInput>
): LinkWriteValidationIssue {
  return {
    code,
    message,
    sourceType: typeof input.sourceType === "string" ? input.sourceType : undefined,
    sourceId: typeof input.sourceId === "string" ? input.sourceId : undefined,
    targetType: typeof input.targetType === "string" ? input.targetType : undefined,
    targetId: typeof input.targetId === "string" ? input.targetId : undefined,
    relationType: typeof input.relationType === "string" ? input.relationType : undefined
  };
}

function normalizeEntityLinkInput(input: CreateEntityLinkInput): CreateEntityLinkInput {
  return {
    ...input,
    sourceType: (typeof input.sourceType === "string" ? input.sourceType.trim() : "") as EntityType,
    sourceId: typeof input.sourceId === "string" ? input.sourceId.trim() : "",
    targetType: (typeof input.targetType === "string" ? input.targetType.trim() : "") as EntityType,
    targetId: typeof input.targetId === "string" ? input.targetId.trim() : "",
    relationType: (typeof input.relationType === "string" ? input.relationType.trim() : "") as RelationType
  };
}

function lifecycleOwner(type: EntityType, id: EntityId) {
  return type === "experiment" || type === "experimentRun"
    ? { ownerType: type as ExperimentManuscriptOwnerType, ownerId: id }
    : undefined;
}

function acquireEntityLinkOwnerGates(link: Pick<EntityLink, "sourceType" | "sourceId" | "targetType" | "targetId">) {
  const owners = [
    lifecycleOwner(link.sourceType, link.sourceId),
    lifecycleOwner(link.targetType, link.targetId)
  ].filter((owner): owner is { ownerType: ExperimentManuscriptOwnerType; ownerId: string } => Boolean(owner));
  const unique = [...new Map(owners.map((owner) => [`${owner.ownerType}\u0000${owner.ownerId}`, owner])).values()]
    .sort((a, b) => `${a.ownerType}:${a.ownerId}`.localeCompare(`${b.ownerType}:${b.ownerId}`));
  const releases: Array<() => void> = [];
  for (const owner of unique) {
    const release = tryAcquireExperimentManuscriptOwnerOperation(
      owner.ownerType,
      owner.ownerId,
      "businessDependencyWrite"
    );
    if (!release) {
      releases.reverse().forEach((item) => item());
      throw new Error("LIFECYCLE_SESSION_SAVING: EntityLink owner hard delete is active.");
    }
    releases.push(release);
  }
  return () => releases.reverse().forEach((release) => release());
}

async function withEntityLinkOwnerGates<T>(
  link: Pick<EntityLink, "sourceType" | "sourceId" | "targetType" | "targetId">,
  action: () => Promise<T>
) {
  const release = acquireEntityLinkOwnerGates(link);
  try {
    return await action();
  } finally {
    release();
  }
}

function entityLinkAffectedEntities(
  link: EntityLink,
  relation: AffectedEntity["relation"] = "updated"
): AffectedEntity[] {
  return [
    {
      type: "entityLink",
      id: link.id,
      relation
    },
    {
      type: link.sourceType,
      id: link.sourceId,
      relation: "linked"
    },
    {
      type: link.targetType,
      id: link.targetId,
      relation: "linked"
    }
  ];
}

function publishEntityLinkFeedback(
  operation: string,
  link: EntityLink | undefined,
  options: {
    linkId?: EntityId;
    relation?: AffectedEntity["relation"];
    warnings?: string[];
    errors?: string[];
    skipped?: string[];
  } = {}
) {
  publishCrossModuleWriteFeedback(
    createCrossModuleWriteFeedback({
      operation,
      primaryEntity: link
        ? {
            type: "entityLink",
            id: link.id,
            relation: options.relation ?? "updated"
          }
        : options.linkId
          ? {
              type: "entityLink",
              id: options.linkId,
              relation: "skipped"
            }
          : undefined,
      affectedEntities: link ? entityLinkAffectedEntities(link, options.relation).slice(1) : [],
      affectedScopes: [
        {
          module: "global",
          reason: `${operation} changes cross-module entity references.`
        },
        {
          module: "review",
          reason: "Review context can include EntityLink source or target references."
        },
        {
          module: "ai",
          reason: "AI context can include EntityLink source or target references."
        }
      ],
      refreshKeys: ["entityLink.changed", "reviewContext.changed", "aiContext.changed"],
      warnings: options.warnings,
      errors: options.errors,
      skipped: options.skipped
    }),
    operation
  );
}

function publishEntityLinkValidationFailure(
  operation: string,
  input: Partial<CreateEntityLinkInput>,
  error: unknown
) {
  const message = error instanceof Error ? error.message : "EntityLink validation failed.";
  publishCrossModuleWriteFeedback(
    createCrossModuleWriteFeedback({
      operation,
      errors: [message],
      affectedEntities: [
        ...(typeof input.sourceId === "string" && input.sourceId.trim()
          ? [
              {
                type: typeof input.sourceType === "string" ? input.sourceType : "other",
                id: input.sourceId.trim(),
                relation: "skipped"
              }
            ]
          : []),
        ...(typeof input.targetId === "string" && input.targetId.trim()
          ? [
              {
                type: typeof input.targetType === "string" ? input.targetType : "other",
                id: input.targetId.trim(),
                relation: "skipped"
              }
            ]
          : [])
      ],
      affectedScopes: [
        {
          module: "link",
          reason: `${operation} validation failed before EntityLink write.`
        },
        {
          module: "global",
          reason: "Failed EntityLink writes can affect downstream refresh feedback."
        }
      ],
      refreshKeys: ["entityLink.changed", "reviewContext.changed", "aiContext.changed"]
    }),
    operation
  );
}

async function validateEntityLinkWriteInput(
  input: CreateEntityLinkInput
): Promise<CreateEntityLinkInput> {
  const normalized = normalizeEntityLinkInput(input);
  const issues: LinkWriteValidationIssue[] = [];

  if (!normalized.sourceType || !normalized.sourceId) {
    issues.push(
      buildEntityLinkIssue(
        "invalid_source",
        "EntityLink sourceType and sourceId are required.",
        normalized
      )
    );
  }
  if (!normalized.targetType || !normalized.targetId) {
    issues.push(
      buildEntityLinkIssue(
        "invalid_target",
        "EntityLink targetType and targetId are required.",
        normalized
      )
    );
  }
  if (!isValidRelationType(normalized.relationType)) {
    issues.push(
      buildEntityLinkIssue(
        "invalid_relation_type",
        `EntityLink relationType is not supported: ${normalized.relationType}`,
        normalized
      )
    );
  }

  if (issues.length === 0) {
    const [sourceValidation, targetValidation] = await validateEntityReferences([
      entityLinkToSourceReference(normalized),
      entityLinkToTargetReference(normalized)
    ]);

    if (!sourceValidation.valid) {
      issues.push(
        buildEntityLinkIssue(
          sourceValidation.resolution.status === "unsupported_type"
            ? "unsupported_source_type"
            : "invalid_source",
          sourceValidation.resolution.message ??
            `EntityLink source is invalid: ${normalized.sourceType}/${normalized.sourceId}`,
          normalized
        )
      );
    }
    if (!targetValidation.valid) {
      issues.push(
        buildEntityLinkIssue(
          targetValidation.resolution.status === "unsupported_type"
            ? "unsupported_target_type"
            : "invalid_target",
          targetValidation.resolution.message ??
            `EntityLink target is invalid: ${normalized.targetType}/${normalized.targetId}`,
          normalized
        )
      );
    }
  }

  if (issues.length > 0) {
    throw new LinkWriteValidationError(issues);
  }

  return normalized;
}

async function createEntityLinkWithinOwnerGates(input: CreateEntityLinkInput): Promise<EntityLink> {
  let normalized: CreateEntityLinkInput;
  try {
    normalized = await validateEntityLinkWriteInput(input);
  } catch (error) {
    publishEntityLinkValidationFailure("entityLink.createEntityLink", input, error);
    throw error;
  }
  const existing = await queryLinksBetween(
    normalized.sourceType,
    normalized.sourceId,
    normalized.targetType,
    normalized.targetId,
    normalized.relationType
  );
  if (existing.length > 0) {
    publishEntityLinkFeedback("entityLink.createEntityLink", existing[0], {
      relation: "reused",
      skipped: ["entity_link_already_exists"]
    });
    return existing[0];
  }

  const created = await createPlanningEntityLink(normalized);
  publishEntityLinkFeedback("entityLink.createEntityLink", created, { relation: "created" });
  return created;
}

export async function createEntityLink(input: CreateEntityLinkInput): Promise<EntityLink> {
  return withEntityLinkOwnerGates(normalizeEntityLinkInput(input), () => createEntityLinkWithinOwnerGates(input));
}

async function removeEntityLinkWithinOwnerGates(linkId: EntityId): Promise<boolean> {
  const data = await getPlanningData();
  const existing = data.entityLinks.find((link) => link.id === linkId);
  const removed = await deleteEntityLink(linkId);
  publishEntityLinkFeedback("entityLink.removeEntityLink", existing, {
    linkId,
    relation: removed ? "deleted" : "skipped",
    skipped: removed ? [] : ["entity_link_not_found"]
  });
  return removed;
}

export async function removeEntityLink(linkId: EntityId): Promise<boolean> {
  const existing = (await getPlanningData()).entityLinks.find((link) => link.id === linkId);
  return existing
    ? withEntityLinkOwnerGates(existing, () => removeEntityLinkWithinOwnerGates(linkId))
    : removeEntityLinkWithinOwnerGates(linkId);
}

export async function queryEntityLinks(
  query: EntityLinkQueryOptions = {}
): Promise<EntityLink[]> {
  const data = await getPlanningFirstLayerData();
  return data.entityLinks.filter((link) => matchesQuery(link, query));
}

export async function queryLinksBySource(
  sourceType: EntityType,
  sourceId: EntityId
): Promise<EntityLink[]> {
  return queryEntityLinks({ sourceType, sourceId });
}

export async function queryLinksByTarget(
  targetType: EntityType,
  targetId: EntityId
): Promise<EntityLink[]> {
  return queryEntityLinks({ targetType, targetId });
}

export async function queryLinksBetween(
  sourceType: EntityType,
  sourceId: EntityId,
  targetType: EntityType,
  targetId: EntityId,
  relationType?: RelationType
): Promise<EntityLink[]> {
  return queryEntityLinks({
    sourceType,
    sourceId,
    targetType,
    targetId,
    relationType
  });
}

async function ensureEntityLinkWithinOwnerGates(input: CreateEntityLinkInput): Promise<EntityLink> {
  let normalized: CreateEntityLinkInput;
  try {
    normalized = await validateEntityLinkWriteInput(input);
  } catch (error) {
    publishEntityLinkValidationFailure("entityLink.ensureEntityLink", input, error);
    throw error;
  }
  const existing = await queryLinksBetween(
    normalized.sourceType,
    normalized.sourceId,
    normalized.targetType,
    normalized.targetId,
    normalized.relationType
  );

  if (existing.length > 0) {
    publishEntityLinkFeedback("entityLink.ensureEntityLink", existing[0], {
      relation: "reused",
      skipped: ["entity_link_already_exists"]
    });
    return existing[0];
  }

  const created = await createPlanningEntityLink(normalized);
  publishEntityLinkFeedback("entityLink.ensureEntityLink", created, { relation: "created" });
  return created;
}

export async function ensureEntityLink(input: CreateEntityLinkInput): Promise<EntityLink> {
  return withEntityLinkOwnerGates(normalizeEntityLinkInput(input), () => ensureEntityLinkWithinOwnerGates(input));
}

export async function queryLinkedEntities(
  entityType: EntityType,
  entityId: EntityId
): Promise<EntityLink[]> {
  const data = await getPlanningData();
  return data.entityLinks.filter(
    (link) =>
      (link.sourceType === entityType && link.sourceId === entityId) ||
      (link.targetType === entityType && link.targetId === entityId)
  );
}

export const entityLinkService = {
  createEntityLink,
  removeEntityLink,
  queryEntityLinks,
  queryLinksBySource,
  queryLinksByTarget,
  queryLinksBetween,
  ensureEntityLink,
  queryLinkedEntities
};

export type EntityLinkService = typeof entityLinkService;
