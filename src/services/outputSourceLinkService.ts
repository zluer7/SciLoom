import { createRepository } from "../repositories/repositoryFactory";
import { outputSourceLinkRepositoryConfig } from "../repositories/entityConfig";
import type {
  CreateOutputSourceLinkInput,
  EntityId,
  OutputSourceLink,
  OutputSourceOwnerType,
  OutputSourceRelationType,
  OutputSourceType,
  QueryOutputSourceLinksInput,
  UpdateOutputSourceLinkInput
} from "../types";

export const OUTPUT_SOURCE_LINK_SCHEMA_VERSION = 1;

export const OUTPUT_SOURCE_LINK_OWNER_TYPES = [
  "resultItem",
  "finding",
  "outputCandidate",
  "outputGap",
  "researchOutput"
] as const satisfies readonly OutputSourceOwnerType[];

export const OUTPUT_SOURCE_LINK_SOURCE_TYPES = [
  "experiment",
  "experimentRun",
  "literature",
  "review",
  "other",
  "resultItem",
  "finding",
  "outputCandidate"
] as const satisfies readonly OutputSourceType[];

export const OUTPUT_SOURCE_RELATION_TYPES = [
  "primary",
  "supporting",
  "manual",
  "context"
] as const satisfies readonly OutputSourceRelationType[];

export const OUTPUT_SOURCE_ALLOWED_MATRIX = {
  resultItem: ["experiment", "experimentRun", "literature", "review", "other"],
  finding: ["resultItem", "other"],
  outputCandidate: ["finding", "resultItem", "other"],
  outputGap: ["outputCandidate", "finding"],
  researchOutput: ["outputCandidate", "other"]
} as const satisfies Record<OutputSourceOwnerType, readonly OutputSourceType[]>;

const outputSourceLinkRepository = createRepository<OutputSourceLink>(outputSourceLinkRepositoryConfig);

const LOCAL_PATH_PATTERN = /(?:[A-Za-z]:[\\/]|\\\\|file:\/\/\/?)[^\s"'<>|]+/gi;

function normalizeText(value: string | null | undefined) {
  const trimmed = (value ?? "").replace(/\s+/g, " ").trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function redactPathLikeText(value: string) {
  return value.replace(LOCAL_PATH_PATTERN, "[local path]");
}

export function normalizeSourceTitleSnapshot(value: string | null | undefined) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }
  return redactPathLikeText(normalized).trim();
}

function normalizeOptionalSnapshot(value: string | null | undefined) {
  const normalized = normalizeText(value);
  return normalized ? redactPathLikeText(normalized) : null;
}

function normalizeDuplicateKey(value: string | null | undefined) {
  return normalizeSourceTitleSnapshot(value).toLocaleLowerCase();
}

function isOutputSourceOwnerType(value: string): value is OutputSourceOwnerType {
  return OUTPUT_SOURCE_LINK_OWNER_TYPES.includes(value as OutputSourceOwnerType);
}

function isOutputSourceType(value: string): value is OutputSourceType {
  return OUTPUT_SOURCE_LINK_SOURCE_TYPES.includes(value as OutputSourceType);
}

function isOutputSourceRelationType(value: string): value is OutputSourceRelationType {
  return OUTPUT_SOURCE_RELATION_TYPES.includes(value as OutputSourceRelationType);
}

function ensureAllowedMatrix(ownerType: OutputSourceOwnerType, sourceType: OutputSourceType) {
  const allowedSources = OUTPUT_SOURCE_ALLOWED_MATRIX[ownerType] as readonly OutputSourceType[];
  if (!allowedSources.includes(sourceType)) {
    throw new Error(`Unsupported output source relation: ${ownerType} cannot use ${sourceType}.`);
  }
}

function validateRequiredId(value: string | null | undefined, fieldName: string) {
  if (!normalizeText(value)) {
    throw new Error(`${fieldName} is required.`);
  }
}

function validateBaseLink(input: {
  projectId: EntityId;
  ownerType: OutputSourceOwnerType;
  ownerId: EntityId;
  sourceType: OutputSourceType;
  sourceId?: EntityId | null;
  sourceTitleSnapshot: string;
  relationType: OutputSourceRelationType;
  orderIndex: number;
}) {
  const { ownerType, ownerId, sourceType, sourceId } = input;

  validateRequiredId(input.projectId, "projectId");
  validateRequiredId(ownerId, "ownerId");

  if (!isOutputSourceOwnerType(ownerType)) {
    throw new Error(`Unsupported output source owner type: ${ownerType}.`);
  }
  if (!isOutputSourceType(sourceType)) {
    throw new Error(`Unsupported output source type: ${sourceType}.`);
  }
  if (!isOutputSourceRelationType(input.relationType)) {
    throw new Error(`Unsupported output source relation type: ${input.relationType}.`);
  }

  ensureAllowedMatrix(ownerType, sourceType);

  if (sourceType === "other" && !input.sourceTitleSnapshot) {
    throw new Error("sourceTitleSnapshot is required for other output sources.");
  }
  if (sourceType !== "other" && !normalizeText(sourceId)) {
    throw new Error("sourceId is required for non-other output sources.");
  }
  if (ownerType === sourceType && ownerId === sourceId) {
    throw new Error("Output source link cannot point to itself.");
  }
  if (!Number.isInteger(input.orderIndex) || input.orderIndex < 0) {
    throw new Error("orderIndex must be a non-negative integer.");
  }
}

function toComparableDuplicate(link: Pick<OutputSourceLink, "sourceType" | "sourceId" | "sourceTitleSnapshot">) {
  if (link.sourceType === "other") {
    return `other:${normalizeDuplicateKey(link.sourceTitleSnapshot)}`;
  }
  return `${link.sourceType}:${link.sourceId ?? ""}`;
}

async function findDuplicateActiveLink(
  link: Pick<OutputSourceLink, "ownerType" | "ownerId" | "sourceType" | "sourceId" | "sourceTitleSnapshot">,
  excludeId?: EntityId
) {
  const activeLinks = await queryOutputSourceLinksByOwner(link.ownerType, link.ownerId);
  const duplicateKey = toComparableDuplicate(link);
  return activeLinks.find((candidate) => {
    if (candidate.id === excludeId) {
      return false;
    }
    return toComparableDuplicate(candidate) === duplicateKey;
  });
}

async function getNextOrderIndex(ownerType: OutputSourceOwnerType, ownerId: EntityId) {
  const activeLinks = await queryOutputSourceLinksByOwner(ownerType, ownerId);
  const maxOrderIndex = Math.max(-1, ...activeLinks.map((link) => link.orderIndex ?? 0));
  return maxOrderIndex + 1;
}

async function ensureNoDuplicateActiveLink(
  link: Pick<OutputSourceLink, "ownerType" | "ownerId" | "sourceType" | "sourceId" | "sourceTitleSnapshot">,
  excludeId?: EntityId
) {
  const duplicate = await findDuplicateActiveLink(link, excludeId);
  if (duplicate) {
    throw new Error("Active output source link already exists for this owner and source.");
  }
}

function matchesQuery(link: OutputSourceLink, query: QueryOutputSourceLinksInput) {
  if (query.projectId !== undefined && link.projectId !== query.projectId) {
    return false;
  }
  if (query.ownerType !== undefined && link.ownerType !== query.ownerType) {
    return false;
  }
  if (query.ownerId !== undefined && link.ownerId !== query.ownerId) {
    return false;
  }
  if (query.sourceType !== undefined && link.sourceType !== query.sourceType) {
    return false;
  }
  if (query.sourceId !== undefined && link.sourceId !== query.sourceId) {
    return false;
  }
  if (query.relationType !== undefined && link.relationType !== query.relationType) {
    return false;
  }
  return true;
}

function toCreateInput(
  input: CreateOutputSourceLinkInput,
  orderIndex: number
): Omit<OutputSourceLink, "id" | "createdAt" | "updatedAt" | "deletedAt"> {
  const sourceTitleSnapshot = normalizeSourceTitleSnapshot(input.sourceTitleSnapshot).trim();
  const relationType = input.relationType ?? "supporting";
  const sourceId = input.sourceType === "other" ? null : input.sourceId ?? null;
  const normalized = {
    projectId: input.projectId,
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    sourceType: input.sourceType,
    sourceId,
    sourceTitleSnapshot,
    sourceSummarySnapshot: normalizeOptionalSnapshot(input.sourceSummarySnapshot),
    sourceNote: normalizeOptionalSnapshot(input.sourceNote),
    relationType,
    orderIndex,
    schemaVersion: OUTPUT_SOURCE_LINK_SCHEMA_VERSION
  };

  validateBaseLink(normalized);
  return normalized;
}

function mergeUpdateInput(
  current: OutputSourceLink,
  input: UpdateOutputSourceLinkInput
): OutputSourceLink {
  const sourceType = input.sourceType ?? current.sourceType;
  const sourceTitleSnapshot =
    input.sourceTitleSnapshot !== undefined
      ? normalizeSourceTitleSnapshot(input.sourceTitleSnapshot).trim()
      : current.sourceTitleSnapshot;
  const sourceId =
    sourceType === "other"
      ? null
      : input.sourceId !== undefined
        ? input.sourceId ?? null
        : current.sourceId ?? null;

  const merged: OutputSourceLink = {
    ...current,
    sourceType,
    sourceId,
    sourceTitleSnapshot,
    sourceSummarySnapshot:
      input.sourceSummarySnapshot !== undefined
        ? normalizeOptionalSnapshot(input.sourceSummarySnapshot)
        : current.sourceSummarySnapshot ?? null,
    sourceNote:
      input.sourceNote !== undefined
        ? normalizeOptionalSnapshot(input.sourceNote)
        : current.sourceNote ?? null,
    relationType: input.relationType ?? current.relationType,
    orderIndex: input.orderIndex ?? current.orderIndex,
    schemaVersion: OUTPUT_SOURCE_LINK_SCHEMA_VERSION
  };

  validateBaseLink(merged);
  return merged;
}

export async function createOutputSourceLink(input: CreateOutputSourceLinkInput) {
  const orderIndex = input.orderIndex ?? (await getNextOrderIndex(input.ownerType, input.ownerId));
  const toCreate = toCreateInput(input, orderIndex);
  await ensureNoDuplicateActiveLink(toCreate);

  const link = await outputSourceLinkRepository.create(toCreate);
  const persisted = await outputSourceLinkRepository.getById(link.id);
  if (!persisted) {
    throw new Error("Output source link was not persisted after create.");
  }
  return persisted;
}

export async function updateOutputSourceLink(id: EntityId, input: UpdateOutputSourceLinkInput) {
  const current = await outputSourceLinkRepository.getById(id);
  if (!current) {
    return undefined;
  }
  const merged = mergeUpdateInput(current, input);
  await ensureNoDuplicateActiveLink(merged, id);

  const updated = await outputSourceLinkRepository.update(id, {
    sourceType: merged.sourceType,
    sourceId: merged.sourceId,
    sourceTitleSnapshot: merged.sourceTitleSnapshot,
    sourceSummarySnapshot: merged.sourceSummarySnapshot,
    sourceNote: merged.sourceNote,
    relationType: merged.relationType,
    orderIndex: merged.orderIndex,
    schemaVersion: merged.schemaVersion
  });
  if (!updated) {
    throw new Error("Output source link update failed.");
  }
  const persisted = await outputSourceLinkRepository.getById(updated.id);
  if (!persisted) {
    throw new Error("Output source link was not persisted after update.");
  }
  return persisted;
}

export async function softDeleteOutputSourceLink(id: EntityId) {
  return outputSourceLinkRepository.softDelete(id);
}

export async function restoreOutputSourceLink(id: EntityId) {
  const deleted = await outputSourceLinkRepository.getDeletedById(id);
  if (!deleted) {
    return undefined;
  }
  await ensureNoDuplicateActiveLink(deleted, id);
  const restored = await outputSourceLinkRepository.restore(id);
  if (!restored) {
    throw new Error("Output source link restore failed.");
  }
  const persisted = await outputSourceLinkRepository.getById(restored.id);
  if (!persisted) {
    throw new Error("Output source link was not persisted after restore.");
  }
  return persisted;
}

export async function hardDeleteOutputSourceLink(id: EntityId) {
  return outputSourceLinkRepository.hardDelete(id);
}

export async function getOutputSourceLink(id: EntityId) {
  return outputSourceLinkRepository.getById(id);
}

export async function queryOutputSourceLinks(query: QueryOutputSourceLinksInput = {}) {
  const activeLinks = await outputSourceLinkRepository.list();
  const deletedLinks = query.includeDeleted ? await outputSourceLinkRepository.listDeleted() : [];
  return [...activeLinks, ...deletedLinks]
    .filter((link) => matchesQuery(link, query))
    .sort((a, b) => a.orderIndex - b.orderIndex || a.createdAt.localeCompare(b.createdAt));
}

export async function queryOutputSourceLinksByOwner(
  ownerType: OutputSourceOwnerType,
  ownerId: EntityId
) {
  return queryOutputSourceLinks({ ownerType, ownerId, includeDeleted: false });
}
