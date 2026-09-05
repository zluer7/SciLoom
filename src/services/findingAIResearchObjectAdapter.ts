import type {
  AIContextExcludedItem,
  AIContextItem,
  AIContextMode,
  AIContextRequestableRef,
  AIContextSourceRef,
  AIResearchObjectDescriptor
} from "../types/aiContext";
import type { Finding, ResultItem } from "../types/outputConversion";
import type { RouteNode, Task } from "../types/planning";
import type { Experiment } from "../types/experiment";
import { experimentService } from "./experimentService";
import { outputConversionRelationService } from "./outputConversionRelationService";
import { outputConversionService } from "./outputConversionService";
import { planningService } from "./planningService";

const FINDING_TITLE_MAX_CHARS = 200;
const FINDING_SUMMARY_MAX_CHARS = 600;
const FINDING_STRUCTURED_SUMMARY_MAX_CHARS = 900;
const FINDING_STRUCTURED_FIELD_MAX_CHARS = 180;
const FINDING_TAG_MAX = 12;
const FINDING_TAG_MAX_CHARS = 80;
const FINDING_EVIDENCE_CONTEXT_MAX = 8;

const FORBIDDEN_TEXT_PATTERNS = [
  /[A-Za-z]:[\\/](?:[^\\/\s|]+[\\/]?)+/gu,
  /\\\\[^\s|]+/gu,
  /file:\/\/[^\s|]+/giu,
  /\/(?:Users|home|mnt|tmp|var)\/[^\s|]+/gu,
  /\bsk-[A-Za-z0-9_-]{16,}\b/gu,
  /\bBearer\s+[A-Za-z0-9._-]+\b/giu,
  /\b(?:api[_-]?key|token|secret)\s*[:=]\s*[^\s|]+/giu
];

function bounded(value: string | undefined, maxChars: number): string | undefined {
  if (!value) return undefined;
  let normalized = value.replace(/[\0-\x1F\x7F]/gu, " ").replace(/\s+/gu, " ").trim();
  for (const pattern of FORBIDDEN_TEXT_PATTERNS) {
    normalized = normalized.replace(pattern, "[local or secret value omitted]");
  }
  if (!normalized) return undefined;
  const characters = Array.from(normalized);
  return characters.length <= maxChars
    ? normalized
    : `${characters.slice(0, Math.max(0, maxChars - 1)).join("")}…`;
}

function safeTitle(value: string | undefined, fallback: string): string {
  const normalized = bounded(value, FINDING_TITLE_MAX_CHARS) ?? fallback;
  const parts = normalized.split(/[\\/]/u).filter(Boolean);
  return bounded(parts[parts.length - 1], FINDING_TITLE_MAX_CHARS) ?? fallback;
}

function safeTags(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).flatMap((value) => {
    const normalized = bounded(value, FINDING_TAG_MAX_CHARS);
    return normalized ? [normalized] : [];
  }))].sort((left, right) => left.localeCompare(right)).slice(0, FINDING_TAG_MAX);
}

function structuredSummaryProjection(finding: Finding): string | undefined {
  const fields = [...finding.structuredSummary]
    .sort((left, right) => left.order - right.order || left.key.localeCompare(right.key))
    .flatMap((section) => {
      const value = bounded(section.value, FINDING_STRUCTURED_FIELD_MAX_CHARS);
      return value ? [`${section.key}=${value}`] : [];
    });
  return bounded(fields.join("; "), FINDING_STRUCTURED_SUMMARY_MAX_CHARS);
}

export type FindingAIResearchObjectResolutionErrorCode =
  | "FINDING_ID_REQUIRED"
  | "FINDING_NOT_FOUND"
  | "FINDING_UNAVAILABLE"
  | "FINDING_PROJECT_MISMATCH"
  | "FINDING_PROJECT_UNAVAILABLE"
  | "FINDING_RELATION_UNAVAILABLE"
  | "FINDING_RELATION_PROJECT_MISMATCH";

export class FindingAIResearchObjectResolutionError extends Error {
  constructor(
    readonly code: FindingAIResearchObjectResolutionErrorCode,
    message: string
  ) {
    super(message);
    this.name = "FindingAIResearchObjectResolutionError";
  }
}

type ResolvedFindingRelation =
  | { kind: "route"; value: RouteNode }
  | { kind: "task"; value: Task }
  | { kind: "experiment"; value: Experiment }
  | { kind: "resultItem"; value: ResultItem };

type ResolvedFindingState = {
  finding: Finding;
  safeTitle: string;
  safeSummary?: string;
  safeTags: string[];
  relations: ResolvedFindingRelation[];
};

function unavailableRelation(kind: ResolvedFindingRelation["kind"], id: string): never {
  throw new FindingAIResearchObjectResolutionError(
    "FINDING_RELATION_UNAVAILABLE",
    `Selected Finding relation is missing or unavailable: ${kind}:${id}`
  );
}

function mismatchedRelation(kind: ResolvedFindingRelation["kind"], id: string, projectId: string): never {
  throw new FindingAIResearchObjectResolutionError(
    "FINDING_RELATION_PROJECT_MISMATCH",
    `Selected Finding relation ${kind}:${id} does not belong to Project ${projectId}.`
  );
}

async function resolveFindingState(
  findingId: string,
  expectedProjectId: string
): Promise<ResolvedFindingState> {
  const normalizedFindingId = findingId.trim();
  const normalizedProjectId = expectedProjectId.trim();
  if (!normalizedFindingId) {
    throw new FindingAIResearchObjectResolutionError(
      "FINDING_ID_REQUIRED",
      "A canonical Finding identity is required."
    );
  }
  const finding = await outputConversionService.getFindingById(normalizedFindingId);
  if (!finding) {
    throw new FindingAIResearchObjectResolutionError(
      "FINDING_NOT_FOUND",
      `Selected Finding is missing or deleted: ${normalizedFindingId}`
    );
  }
  if (finding.status === "abandoned") {
    throw new FindingAIResearchObjectResolutionError(
      "FINDING_UNAVAILABLE",
      `Selected Finding is abandoned and unavailable for new AI context: ${normalizedFindingId}`
    );
  }
  if (!normalizedProjectId || finding.projectId !== normalizedProjectId) {
    throw new FindingAIResearchObjectResolutionError(
      "FINDING_PROJECT_MISMATCH",
      `Selected Finding ${normalizedFindingId} does not belong to Project ${normalizedProjectId || "(missing)"}.`
    );
  }
  const project = await planningService.getProjectById(normalizedProjectId);
  if (!project || project.status === "archived") {
    throw new FindingAIResearchObjectResolutionError(
      "FINDING_PROJECT_UNAVAILABLE",
      `Selected Finding Project is missing or archived: ${normalizedProjectId}`
    );
  }

  const relations: ResolvedFindingRelation[] = [];
  if (finding.routeId) {
    const route = await planningService.getRouteNodeById(finding.routeId);
    if (!route || route.status === "archived") unavailableRelation("route", finding.routeId);
    if (route.projectId !== normalizedProjectId) mismatchedRelation("route", route.id, normalizedProjectId);
    relations.push({ kind: "route", value: route });
  }
  if (finding.taskId) {
    const task = await planningService.getTaskById(finding.taskId);
    if (!task || task.status === "archived" || task.captureState === "archived" || task.archivedAt) {
      unavailableRelation("task", finding.taskId);
    }
    if (task.projectId !== normalizedProjectId) mismatchedRelation("task", task.id, normalizedProjectId);
    relations.push({ kind: "task", value: task });
  }
  if (finding.experimentId) {
    const experiment = await experimentService.getExperimentById(finding.experimentId);
    if (!experiment || experiment.status === "archived") {
      unavailableRelation("experiment", finding.experimentId);
    }
    if (experiment.projectId !== normalizedProjectId) {
      mismatchedRelation("experiment", experiment.id, normalizedProjectId);
    }
    relations.push({ kind: "experiment", value: experiment });
  }

  const evidenceRelations = await outputConversionRelationService.queryOutputConversionRelations({
    targetType: "finding",
    targetId: finding.id,
    sourceType: "resultItem",
    relationType: "evidence_for"
  });
  const evidenceIds = [...new Set(evidenceRelations.map((relation) => {
    if (relation.projectId && relation.projectId !== normalizedProjectId) {
      mismatchedRelation("resultItem", relation.sourceId, normalizedProjectId);
    }
    return relation.sourceId;
  }))].sort((left, right) => left.localeCompare(right));
  for (const resultItemId of evidenceIds) {
    const resultItem = await outputConversionService.getResultItemById(resultItemId);
    if (!resultItem) unavailableRelation("resultItem", resultItemId);
    if (resultItem.projectId !== normalizedProjectId) {
      mismatchedRelation("resultItem", resultItem.id, normalizedProjectId);
    }
    relations.push({ kind: "resultItem", value: resultItem });
  }

  return {
    finding,
    safeTitle: safeTitle(finding.title, finding.id),
    safeSummary: bounded(finding.summary, FINDING_SUMMARY_MAX_CHARS),
    safeTags: safeTags(finding.tags),
    relations
  };
}

function primarySourceRef(
  state: ResolvedFindingState,
  mode: AIContextMode
): AIContextSourceRef {
  return {
    module: "outputConversion",
    entityType: "finding",
    entityId: state.finding.id,
    label: state.safeTitle,
    field: mode !== "MINIMAL" ? "bounded Finding projection" : "identity",
    sourceKind: "userAuthored",
    isUserAuthored: true,
    isAiGenerated: false,
    isVerified: true,
    contextMode: mode,
    contextLevel: 1,
    contextRole: "primary",
    contextDisposition: "included"
  };
}

function relationSourceRef(
  relation: ResolvedFindingRelation,
  findingId: string,
  mode: AIContextMode,
  label: string
): AIContextSourceRef {
  const entityType = relation.kind === "route" ? "routeNode" : relation.kind;
  const module = relation.kind === "route"
    ? "route"
    : relation.kind === "task"
      ? "task"
      : relation.kind === "experiment"
        ? "experiment"
        : "outputConversion";
  return {
    module,
    entityType,
    entityId: relation.value.id,
    label,
    field: "Finding application-confirmed relation",
    sourceKind: "linkedReference",
    isUserAuthored: true,
    isAiGenerated: false,
    isVerified: true,
    contextMode: mode,
    contextLevel: 2,
    contextRole: "related",
    contextDisposition: "included",
    relationHint: relation.kind === "resultItem"
      ? `evidence_for:finding=${findingId}`
      : `finding_${relation.kind}_id:finding=${findingId}`
  };
}

function item(input: {
  id: string;
  title: string;
  summary: string;
  module: AIContextItem["module"];
  entityType: AIContextItem["entityType"];
  sourceRef: AIContextSourceRef;
  contextLevel: 1 | 2;
  priority: AIContextItem["priority"];
  stableOrder: number;
  protectedFromContextBudget?: boolean;
}): AIContextItem {
  return {
    ...input,
    sourceRefs: [input.sourceRef],
    charCount: input.title.length + input.summary.length,
    sendable: true,
    truncated: false
  };
}

function primarySummary(state: ResolvedFindingState, mode: AIContextMode): string {
  const categorical = [
    `Status: ${state.finding.status}`,
    state.finding.findingType ? `Type: ${state.finding.findingType}` : undefined,
    state.finding.confidence ? `Confidence: ${state.finding.confidence}` : undefined,
    state.finding.maturity ? `Maturity: ${state.finding.maturity}` : undefined
  ].filter(Boolean);
  if (mode !== "MINIMAL") {
    if (state.safeSummary) categorical.push(`Summary: ${state.safeSummary}`);
    const structuredSummary = structuredSummaryProjection(state.finding);
    if (structuredSummary) categorical.push(`Structured fields: ${structuredSummary}`);
    if (state.safeTags.length > 0) categorical.push(`Tags: ${state.safeTags.join(", ")}`);
  }
  return categorical.join(" | ");
}

function relationPresentation(relation: ResolvedFindingRelation): {
  title: string;
  summary: string;
  module: AIContextItem["module"];
  entityType: AIContextItem["entityType"];
} {
  const title = safeTitle(relation.value.title, relation.value.id);
  if (relation.kind === "route") {
    return { title, summary: `Status: ${relation.value.status}`, module: "route", entityType: "routeNode" };
  }
  if (relation.kind === "task") {
    return {
      title,
      summary: `Status: ${relation.value.status} | Priority: ${relation.value.priority}`,
      module: "task",
      entityType: "task"
    };
  }
  if (relation.kind === "experiment") {
    return { title, summary: `Status: ${relation.value.status}`, module: "experiment", entityType: "experiment" };
  }
  return {
    title,
    summary: `Status: ${relation.value.status} | Result type: ${relation.value.resultType}`,
    module: "outputConversion",
    entityType: "resultItem"
  };
}

export async function resolveFindingResearchObjectDescriptor(
  findingId: string,
  expectedProjectId: string
): Promise<AIResearchObjectDescriptor> {
  const state = await resolveFindingState(findingId, expectedProjectId);
  return {
    objectType: "finding",
    objectId: state.finding.id,
    projectId: state.finding.projectId,
    label: state.safeTitle,
    description: state.safeSummary,
    sourceRef: {
      module: "outputConversion",
      entityType: "finding",
      entityId: state.finding.id,
      label: state.safeTitle,
      field: "identity",
      sourceKind: "userAuthored",
      isUserAuthored: true,
      isAiGenerated: false,
      isVerified: true
    },
    safeMetadata: {
      status: state.finding.status,
      findingType: state.finding.findingType ?? null,
      confidence: state.finding.confidence ?? null,
      maturity: state.finding.maturity ?? null,
      routeId: state.finding.routeId ?? null,
      taskId: state.finding.taskId ?? null,
      experimentId: state.finding.experimentId ?? null,
      updatedAt: state.finding.updatedAt
    },
    ownerModule: "outputConversion",
    channel: "global_chat"
  };
}

export async function listFindingResearchObjectDescriptors(
  projectId: string
): Promise<AIResearchObjectDescriptor[]> {
  const findings = (await outputConversionService.listFindings())
    .filter((finding) => finding.projectId === projectId && finding.status !== "abandoned")
    .sort((left, right) => left.id.localeCompare(right.id));
  const descriptors: AIResearchObjectDescriptor[] = [];
  for (const finding of findings) {
    try {
      descriptors.push(await resolveFindingResearchObjectDescriptor(finding.id, projectId));
    } catch (error) {
      if (!(error instanceof FindingAIResearchObjectResolutionError)) throw error;
    }
  }
  return descriptors;
}

export type FindingResearchObjectContextCandidates = {
  primary: AIContextItem;
  related: AIContextItem[];
  excluded: AIContextExcludedItem[];
  warnings: string[];
  requestableRefs: AIContextRequestableRef[];
};

export async function buildFindingResearchObjectContextCandidates(
  descriptor: AIResearchObjectDescriptor,
  mode: AIContextMode,
  selectionOrder: number
): Promise<FindingResearchObjectContextCandidates> {
  const state = await resolveFindingState(descriptor.objectId, descriptor.projectId);
  const primaryRef = primarySourceRef(state, mode);
  const primary = item({
    id: `primary-finding:${state.finding.id}`,
    title: state.safeTitle,
    summary: primarySummary(state, mode),
    module: "outputConversion",
    entityType: "finding",
    sourceRef: primaryRef,
    contextLevel: 1,
    priority: "critical",
    stableOrder: selectionOrder,
    protectedFromContextBudget: true
  });
  const requestableRefs: AIContextRequestableRef[] = [{
    refKind: "AI_RESEARCH_OBJECT",
    refId: state.finding.id,
    projectId: state.finding.projectId,
    label: state.safeTitle,
    entityType: "finding",
    allowedContributionKinds: ["IDENTITY_METADATA"]
  }];
  const excluded: AIContextExcludedItem[] = [];
  const warnings: string[] = [];
  const orderedRelations = [...state.relations].sort((left, right) =>
    left.kind.localeCompare(right.kind) || left.value.id.localeCompare(right.value.id));
  const directRelations = orderedRelations.filter((relation) => relation.kind !== "resultItem");
  const evidenceRelations = orderedRelations.filter((relation) => relation.kind === "resultItem");
  const boundedRelations = [...directRelations, ...evidenceRelations.slice(0, FINDING_EVIDENCE_CONTEXT_MAX)];
  if (evidenceRelations.length > FINDING_EVIDENCE_CONTEXT_MAX) {
    const omitted = evidenceRelations.length - FINDING_EVIDENCE_CONTEXT_MAX;
    excluded.push({
      reason: "notSelected",
      module: "outputConversion",
      entityType: "resultItem",
      label: `${omitted} additional Finding evidence relations were excluded by the bounded direct-relation policy.`,
      sourceRefs: []
    });
    warnings.push(`${omitted} additional Finding evidence relations were omitted from provider context.`);
  }
  if (mode === "MINIMAL") {
    for (const relation of boundedRelations) {
      const presentation = relationPresentation(relation);
      const sourceRef = relationSourceRef(relation, state.finding.id, mode, presentation.title);
      excluded.push({
        reason: "notSelected",
        module: presentation.module,
        entityType: presentation.entityType,
        entityId: relation.value.id,
        label: `${presentation.title}: Finding relation excluded by ${mode}.`,
        sourceRefs: [{ ...sourceRef, contextDisposition: "excluded" }]
      });
    }
    return { primary, related: [], excluded, warnings, requestableRefs };
  }
  const related = boundedRelations.map((relation, index) => {
    const presentation = relationPresentation(relation);
    return item({
      id: `finding-relation:${state.finding.id}:${relation.kind}:${relation.value.id}`,
      title: presentation.title,
      summary: presentation.summary,
      module: presentation.module,
      entityType: presentation.entityType,
      sourceRef: relationSourceRef(relation, state.finding.id, mode, presentation.title),
      contextLevel: 2,
      priority: "high",
      stableOrder: selectionOrder * 100 + index
    });
  });
  return { primary, related, excluded, warnings, requestableRefs };
}
