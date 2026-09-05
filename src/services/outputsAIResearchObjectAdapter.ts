import type {
  AIContextExcludedItem,
  AIContextItem,
  AIContextMode,
  AIContextRequestableRef,
  AIContextSourceRef,
  AIResearchObjectDescriptor,
  AIResearchObjectType
} from "../types/aiContext";
import type { StructuredSummary } from "../types/outputStructuredSummary";
import { outputConversionService } from "./outputConversionService";
import { outputService } from "./outputService";
import { planningService } from "./planningService";

export type OutputsAIResearchObjectType = Extract<
  AIResearchObjectType,
  "resultItem" | "outputCandidate" | "outputGap" | "researchOutput"
>;

type OutputResearchEntity = {
  id: string;
  projectId: string;
  title?: string;
  outputName?: string;
  summary?: string;
  description?: string;
  structuredSummary?: StructuredSummary;
  status?: string;
  updatedAt?: string;
  deletedAt?: string | null;
};

const TITLE_MAX = 200;
const SUMMARY_MAX = 700;
const STRUCTURED_SUMMARY_MAX = 900;
const STRUCTURED_FIELD_MAX = 180;
const FORBIDDEN_TEXT_PATTERNS = [
  /[A-Za-z]:[\\/](?:[^\\/\s|]+[\\/]?)+/gu,
  /\\\\[^\s|]+/gu,
  /file:\/\/[^\s|]+/giu,
  /\/(?:Users|home|mnt|tmp|var)\/[^\s|]+/gu,
  /\bsk-[A-Za-z0-9_-]{16,}\b/gu,
  /\bBearer\s+[A-Za-z0-9._-]+\b/giu,
  /\b(?:api[_-]?key|token|secret)\s*[:=]\s*[^\s|]+/giu
];

function bounded(value: string | undefined, maxChars: number) {
  if (!value) return undefined;
  let normalized = value.replace(/[\0-\x1F\x7F]/gu, " ").replace(/\s+/gu, " ").trim();
  for (const pattern of FORBIDDEN_TEXT_PATTERNS) {
    normalized = normalized.replace(pattern, "[local or secret value omitted]");
  }
  if (!normalized) return undefined;
  const chars = Array.from(normalized);
  return chars.length <= maxChars ? normalized : `${chars.slice(0, maxChars - 1).join("")}…`;
}

function entityType(type: OutputsAIResearchObjectType): OutputsAIResearchObjectType {
  return type;
}

function structuredSummaryProjection(entity: OutputResearchEntity): string | undefined {
  const fields = [...(entity.structuredSummary ?? [])]
    .sort((left, right) => left.order - right.order || left.key.localeCompare(right.key))
    .flatMap((section) => {
      const value = bounded(section.value, STRUCTURED_FIELD_MAX);
      return value ? [`${section.key}=${value}`] : [];
    });
  return bounded(fields.join("; "), STRUCTURED_SUMMARY_MAX);
}

function moduleFor(type: OutputsAIResearchObjectType): "output" | "outputConversion" {
  return type === "researchOutput" ? "output" : "outputConversion";
}

async function readEntity(type: OutputsAIResearchObjectType, id: string): Promise<OutputResearchEntity | undefined> {
  if (type === "resultItem") return outputConversionService.getResultItemById(id);
  if (type === "outputCandidate") return outputConversionService.getOutputCandidateById(id);
  if (type === "outputGap") return outputConversionService.getOutputGapById(id);
  return outputService.getById(id);
}

async function listEntities(type: OutputsAIResearchObjectType): Promise<OutputResearchEntity[]> {
  if (type === "resultItem") return outputConversionService.listResultItems();
  if (type === "outputCandidate") return outputConversionService.listOutputCandidates();
  if (type === "outputGap") return outputConversionService.listOutputGaps();
  return outputService.listOutputs();
}

function lifecycleEligible(type: OutputsAIResearchObjectType, entity: OutputResearchEntity) {
  if (entity.deletedAt) return false;
  if (type === "outputGap") return entity.status !== "abandoned";
  if (type === "researchOutput") return entity.status !== "archived";
  return true;
}

async function resolveState(
  type: OutputsAIResearchObjectType,
  id: string,
  expectedProjectId: string
) {
  const objectId = id.trim();
  const projectId = expectedProjectId.trim();
  if (!objectId || !projectId) throw new Error("OUTPUT_RESEARCH_OBJECT_IDENTITY_REQUIRED");
  const entity = await readEntity(type, objectId);
  if (!entity || !lifecycleEligible(type, entity)) {
    throw new Error(`OUTPUT_RESEARCH_OBJECT_UNAVAILABLE: ${type}:${objectId}`);
  }
  if (entity.projectId !== projectId) {
    throw new Error(`OUTPUT_RESEARCH_OBJECT_PROJECT_MISMATCH: ${type}:${objectId}`);
  }
  const project = await planningService.getProjectById(projectId);
  if (!project || project.deletedAt || project.status === "archived") {
    throw new Error(`OUTPUT_RESEARCH_OBJECT_PROJECT_UNAVAILABLE: ${projectId}`);
  }
  const label = bounded(entity.title ?? entity.outputName, TITLE_MAX) ?? objectId;
  const summary = bounded(entity.summary ?? entity.description, SUMMARY_MAX);
  return { entity, label, summary };
}

export async function resolveOutputsResearchObjectDescriptor(
  type: OutputsAIResearchObjectType,
  objectId: string,
  expectedProjectId: string
): Promise<AIResearchObjectDescriptor> {
  const state = await resolveState(type, objectId, expectedProjectId);
  return {
    objectType: type,
    objectId: state.entity.id,
    projectId: state.entity.projectId,
    label: state.label,
    ...(state.summary ? { description: state.summary } : {}),
    sourceRef: {
      module: moduleFor(type),
      entityType: entityType(type),
      entityId: state.entity.id,
      label: state.label,
      field: "identity",
      sourceKind: "userAuthored",
      isUserAuthored: true,
      isAiGenerated: false,
      isVerified: true
    },
    safeMetadata: {
      status: state.entity.status ?? null,
      updatedAt: state.entity.updatedAt ?? null
    },
    ownerModule: moduleFor(type),
    channel: "global_chat"
  };
}

export async function listOutputsResearchObjectDescriptors(
  type: OutputsAIResearchObjectType,
  projectId: string
): Promise<AIResearchObjectDescriptor[]> {
  const entities = (await listEntities(type))
    .filter((entity) => entity.projectId === projectId && lifecycleEligible(type, entity))
    .sort((left, right) => left.id.localeCompare(right.id));
  const descriptors: AIResearchObjectDescriptor[] = [];
  for (const entity of entities) {
    descriptors.push(await resolveOutputsResearchObjectDescriptor(type, entity.id, projectId));
  }
  return descriptors;
}

export type OutputsResearchObjectContextCandidates = {
  primary: AIContextItem;
  related: AIContextItem[];
  excluded: AIContextExcludedItem[];
  warnings: string[];
  requestableRefs: AIContextRequestableRef[];
};

export async function buildOutputsResearchObjectContextCandidates(
  descriptor: AIResearchObjectDescriptor,
  mode: AIContextMode,
  selectionOrder: number
): Promise<OutputsResearchObjectContextCandidates> {
  const type = descriptor.objectType as OutputsAIResearchObjectType;
  const state = await resolveState(type, descriptor.objectId, descriptor.projectId);
  const sourceRef: AIContextSourceRef = {
    ...descriptor.sourceRef,
    field: mode !== "MINIMAL" ? "bounded output projection" : "identity",
    contextMode: mode,
    contextLevel: 1,
    contextRole: "primary",
    contextDisposition: "included"
  };
  const structuredSummary = mode !== "MINIMAL"
    ? structuredSummaryProjection(state.entity)
    : undefined;
  const summary = [
    state.entity.status ? `Status: ${state.entity.status}` : undefined,
    mode !== "MINIMAL" ? state.summary : undefined,
    structuredSummary ? `Structured fields: ${structuredSummary}` : undefined
  ].filter(Boolean).join(" | ") || "Canonical output identity.";
  return {
    primary: {
      id: `primary-${type}:${state.entity.id}`,
      title: state.label,
      summary,
      module: moduleFor(type),
      entityType: entityType(type),
      sourceRefs: [sourceRef],
      contextLevel: 1,
      priority: "critical",
      stableOrder: selectionOrder,
      charCount: state.label.length + summary.length,
      sendable: true,
      truncated: false,
      protectedFromContextBudget: true
    },
    related: [],
    excluded: [],
    warnings: [],
    requestableRefs: [{
      refKind: "AI_RESEARCH_OBJECT",
      refId: state.entity.id,
      projectId: state.entity.projectId,
      label: state.label,
      entityType: entityType(type),
      allowedContributionKinds: ["IDENTITY_METADATA"]
    }]
  };
}
