import type {
  EntityReference,
  EntityReferenceModule,
  EntityReferenceResolution,
  EntityReferenceStatus,
  EntityReferenceTypeRegistryEntry,
  EntityReferenceValidationResult,
  MissingEntityReference,
  MissingEntityReferenceReason,
  ResolvedEntitySummary
} from "../types/entityReference";
import type { EntityLink } from "../types/planning";
import type { LiteratureLink } from "../types/literature";
import { getPlanningData } from "./planningRepository";
import { planningService } from "./planningService";
import { experimentService } from "./experimentService";
import { experimentRunService } from "./experimentRunService";
import { resultMetricService } from "./resultMetricService";
import { fileRefService } from "./fileRefService";
import { literatureService } from "./literatureService";
import { outputConversionService } from "./outputConversionService";
import { outputService } from "./outputService";

type EntityRecord = {
  id?: string;
  title?: string;
  name?: string;
  outputName?: string;
  experimentName?: string;
  runLabel?: string;
  description?: string;
  summary?: string;
  status?: string;
  readingStatus?: string;
  maturity?: string;
  deletedAt?: string | null;
};

type EntityResolver = (targetId: string) => Promise<ResolvedEntitySummary | undefined>;

type EntityLinkReferenceFields = Pick<
  EntityLink,
  "sourceType" | "sourceId" | "targetType" | "targetId" | "relationType"
>;

type LiteratureLinkReferenceFields = Pick<
  LiteratureLink,
  "literatureId" | "targetType" | "targetId" | "relationType"
>;

const ENTITY_REFERENCE_TYPE_REGISTRY: EntityReferenceTypeRegistryEntry[] = [
  { targetType: "researchDirection", module: "planning" },
  { targetType: "project", module: "planning" },
  { targetType: "route", module: "planning", canonicalType: "routeNode" },
  { targetType: "routeNode", module: "planning" },
  { targetType: "task", module: "planning" },
  { targetType: "review", module: "planning" },
  { targetType: "experimentSummary", module: "planning" },
  { targetType: "experiment", module: "experiment" },
  { targetType: "experimentRun", module: "experiment" },
  { targetType: "resultMetric", module: "experiment" },
  { targetType: "fileRef", module: "experiment" },
  { targetType: "literature", module: "literature" },
  { targetType: "literatureLink", module: "literature" },
  { targetType: "resultItem", module: "outputConversion" },
  { targetType: "finding", module: "outputConversion" },
  { targetType: "outputCandidate", module: "outputConversion" },
  { targetType: "outputGap", module: "outputConversion" },
  { targetType: "output", module: "output" },
  { targetType: "researchOutput", module: "output", canonicalType: "output", aliases: ["output"] }
];

const ENTITY_REFERENCE_REGISTRY_BY_TYPE = new Map(
  ENTITY_REFERENCE_TYPE_REGISTRY.map((entry) => [entry.targetType, entry])
);

function normalizeReference(reference: EntityReference): EntityReference {
  return {
    ...reference,
    targetType: reference.targetType.trim(),
    targetId: reference.targetId.trim(),
    sourceType: reference.sourceType?.trim(),
    sourceId: reference.sourceId?.trim(),
    relationType: reference.relationType?.trim()
  };
}

function isActiveRecord(record: EntityRecord | undefined): record is EntityRecord & { id: string } {
  return Boolean(record?.id && !record.deletedAt);
}

function pickStatus(record: EntityRecord): string | undefined {
  return record.status ?? record.readingStatus ?? record.maturity;
}

function buildSummary(
  type: string,
  module: EntityReferenceModule,
  record: EntityRecord | undefined
): ResolvedEntitySummary | undefined {
  if (!isActiveRecord(record)) {
    return undefined;
  }

  const title =
    record.title ??
    record.outputName ??
    record.experimentName ??
    record.runLabel ??
    record.name ??
    record.summary ??
    record.description;

  return {
    id: record.id,
    type,
    module,
    title,
    label: title ?? record.id,
    status: pickStatus(record)
  };
}

async function resolvePlanningDataItem(
  type: string,
  collectionName: "researchDirections" | "experimentSummaries",
  targetId: string
) {
  const data = await getPlanningData();
  return buildSummary(
    type,
    "planning",
    data[collectionName].find((item) => item.id === targetId)
  );
}

async function resolveLiteratureLinkQueryItem(targetId: string) {
  const records = await literatureService.queryLiteratureLinks();
  return buildSummary(
    "literatureLink",
    "literature",
    records.find((record) => record.id === targetId)
  );
}

async function resolveOutput(targetId: string) {
  const researchOutput = await outputService.getById(targetId);
  return buildSummary("output", "output", researchOutput);
}

const ENTITY_RESOLVERS: Record<string, EntityResolver> = {
  researchDirection: (targetId) =>
    resolvePlanningDataItem("researchDirection", "researchDirections", targetId),
  project: async (targetId) => buildSummary("project", "planning", await planningService.getProjectById(targetId)),
  route: async (targetId) => buildSummary("route", "planning", await planningService.getRouteNodeById(targetId)),
  routeNode: async (targetId) =>
    buildSummary("routeNode", "planning", await planningService.getRouteNodeById(targetId)),
  task: async (targetId) => buildSummary("task", "planning", await planningService.getTaskById(targetId)),
  review: async (targetId) => buildSummary("review", "planning", await planningService.getReviewById(targetId)),
  experimentSummary: (targetId) =>
    resolvePlanningDataItem("experimentSummary", "experimentSummaries", targetId),
  experiment: async (targetId) =>
    buildSummary("experiment", "experiment", await experimentService.getExperimentById(targetId)),
  experimentRun: async (targetId) =>
    buildSummary("experimentRun", "experiment", await experimentRunService.getRunById(targetId)),
  resultMetric: async (targetId) =>
    buildSummary("resultMetric", "experiment", await resultMetricService.getById(targetId)),
  fileRef: async (targetId) => buildSummary("fileRef", "experiment", await fileRefService.getById(targetId)),
  literature: async (targetId) =>
    buildSummary("literature", "literature", await literatureService.getLiteratureById(targetId)),
  literatureLink: resolveLiteratureLinkQueryItem,
  resultItem: async (targetId) =>
    buildSummary("resultItem", "outputConversion", await outputConversionService.getResultItemById(targetId)),
  finding: async (targetId) =>
    buildSummary("finding", "outputConversion", await outputConversionService.getFindingById(targetId)),
  outputCandidate: async (targetId) =>
    buildSummary(
      "outputCandidate",
      "outputConversion",
      await outputConversionService.getOutputCandidateById(targetId)
    ),
  outputGap: async (targetId) =>
    buildSummary("outputGap", "outputConversion", await outputConversionService.getOutputGapById(targetId)),
  output: resolveOutput,
  researchOutput: async (targetId) => {
    const resolved = await resolveOutput(targetId);
    return resolved ? { ...resolved, type: "researchOutput" } : undefined;
  }
};

function buildResolution(
  reference: EntityReference,
  status: EntityReferenceStatus,
  options: {
    exists?: boolean;
    supported?: boolean;
    resolved?: ResolvedEntitySummary;
    warningCode?: string;
    message?: string;
  } = {}
): EntityReferenceResolution {
  return {
    reference,
    status,
    exists: options.exists ?? false,
    supported: options.supported ?? true,
    resolved: options.resolved,
    warningCode: options.warningCode,
    message: options.message
  };
}

export function listSupportedEntityReferenceTypes(): string[] {
  return ENTITY_REFERENCE_TYPE_REGISTRY.map((entry) => entry.targetType);
}

export function getEntityReferenceTypeRegistry(): EntityReferenceTypeRegistryEntry[] {
  return ENTITY_REFERENCE_TYPE_REGISTRY.map((entry) => ({
    ...entry,
    aliases: entry.aliases ? [...entry.aliases] : undefined
  }));
}

export function isSupportedEntityReferenceType(targetType: string): boolean {
  return ENTITY_REFERENCE_REGISTRY_BY_TYPE.has(targetType.trim());
}

export async function resolveEntityReference(
  reference: EntityReference
): Promise<EntityReferenceResolution> {
  const normalizedReference = normalizeReference(reference);

  if (!normalizedReference.targetId) {
    return buildResolution(normalizedReference, "invalid_id", {
      warningCode: "invalid_target_id",
      message: "Entity reference targetId is empty."
    });
  }

  if (!isSupportedEntityReferenceType(normalizedReference.targetType)) {
    return buildResolution(normalizedReference, "unsupported_type", {
      supported: false,
      warningCode: "unsupported_target_type",
      message: `Unsupported entity reference type: ${normalizedReference.targetType}`
    });
  }

  try {
    const resolved = await ENTITY_RESOLVERS[normalizedReference.targetType](normalizedReference.targetId);
    if (!resolved) {
      return buildResolution(normalizedReference, "missing", {
        warningCode: "target_not_found",
        message: `Entity reference target not found: ${normalizedReference.targetType}/${normalizedReference.targetId}`
      });
    }

    return buildResolution(normalizedReference, "valid", {
      exists: true,
      resolved
    });
  } catch (error) {
    return buildResolution(normalizedReference, "error", {
      warningCode: "resolver_error",
      message: error instanceof Error ? error.message : "Failed to resolve entity reference."
    });
  }
}

function reasonFromStatus(status: EntityReferenceStatus): MissingEntityReferenceReason {
  if (status === "unsupported_type") {
    return "unsupported_target_type";
  }
  if (status === "invalid_id") {
    return "invalid_target_id";
  }
  if (status === "type_mismatch") {
    return "type_mismatch";
  }
  if (status === "error") {
    return "resolver_error";
  }
  return "target_not_found";
}

function toMissingReference(resolution: EntityReferenceResolution): MissingEntityReference | undefined {
  if (resolution.status === "valid") {
    return undefined;
  }

  const { reference } = resolution;
  return {
    sourceType: reference.sourceType,
    sourceId: reference.sourceId,
    targetType: reference.targetType,
    targetId: reference.targetId,
    relationType: reference.relationType,
    reason: reasonFromStatus(resolution.status),
    message: resolution.message
  };
}

export async function validateEntityReference(
  reference: EntityReference
): Promise<EntityReferenceValidationResult> {
  const resolution = await resolveEntityReference(reference);
  const missingReference = toMissingReference(resolution);
  const warnings = missingReference ? [resolution.message ?? resolution.warningCode ?? resolution.status] : [];

  return {
    valid: resolution.status === "valid",
    resolution,
    missingReference,
    warnings
  };
}

export async function validateEntityReferences(
  references: EntityReference[]
): Promise<EntityReferenceValidationResult[]> {
  return Promise.all(references.map((reference) => validateEntityReference(reference)));
}

export function entityLinkToSourceReference(link: EntityLinkReferenceFields): EntityReference {
  return {
    targetType: link.sourceType,
    targetId: link.sourceId,
    sourceType: link.sourceType,
    sourceId: link.sourceId,
    relationType: link.relationType,
    origin: "entityLink"
  };
}

export function entityLinkToTargetReference(link: EntityLinkReferenceFields): EntityReference {
  return {
    targetType: link.targetType,
    targetId: link.targetId,
    sourceType: link.sourceType,
    sourceId: link.sourceId,
    relationType: link.relationType,
    origin: "entityLink"
  };
}

export function literatureLinkToTargetReference(link: LiteratureLinkReferenceFields): EntityReference {
  return {
    targetType: link.targetType,
    targetId: link.targetId,
    sourceType: "literature",
    sourceId: link.literatureId,
    relationType: link.relationType,
    origin: "literatureLink"
  };
}

export const entityReferenceResolverService = {
  getEntityReferenceTypeRegistry,
  listSupportedEntityReferenceTypes,
  isSupportedEntityReferenceType,
  resolveEntityReference,
  validateEntityReference,
  validateEntityReferences,
  entityLinkToSourceReference,
  entityLinkToTargetReference,
  literatureLinkToTargetReference
};
