import { resolveAIResearchObjects } from "./aiResearchObjectService";
import { buildRouteResearchObjectContextCandidates } from "./routeAIResearchObjectAdapter";
import { planningSelectorService } from "./planningSelectorService";
import {
  buildTaskResearchObjectContextCandidates,
  orderTaskContextCandidates
} from "./taskAIResearchObjectAdapter";
import { buildReviewResearchObjectContextCandidates } from "./reviewAIResearchObjectAdapter";
import { buildExperimentResearchObjectContextCandidates } from "./experimentAIResearchObjectAdapter";
import { buildExperimentRunResearchObjectContextCandidates } from "./experimentRunAIResearchObjectAdapter";
import {
  buildLiteratureResearchObjectContextCandidates,
  finalizeLiteraturePromptVisibleProjectionFingerprints,
  listLiteratureResearchObjectDescriptors,
  resolveLiteratureObjectiveOutlineResearchObjectDescriptor
} from "./literatureAIResearchObjectAdapter";
import {
  buildFindingResearchObjectContextCandidates,
  listFindingResearchObjectDescriptors
} from "./findingAIResearchObjectAdapter";
import { buildOutputsResearchObjectContextCandidates } from "./outputsAIResearchObjectAdapter";
import { PROJECT_LEVEL4_RELATION_INDEX_POLICY } from "./projectLevel4RelationIndexProjection";
import type {
  AIContextBudget,
  AIContextBudgetSummary,
  AIContextBuildOptions,
  AIContextCompositionPolicy,
  AIContextEntityType,
  AIContextExcludedItem,
  AIContextItem,
  AIContextLevel,
  AIContextMaterialDecision,
  AIContextMode,
  AIContextModule,
  AIContextPackage,
  AIContextPriority,
  AIContextRequestableRef,
  AIContextSection,
  AIContextSourceRef,
  AIContextWarning,
  AILevel4ExclusionSummary,
  AILevel4IncludedItem,
  AILevel4ObjectType,
  AILevel4Snapshot,
  AIResearchObjectDescriptor
} from "../types/aiContext";
import type { EntitySummary, EvidenceSummary } from "../types/entityContext";
import type {
  ProjectLevel4RelationIndexEntry,
  ProjectResearchContext
} from "../types/planningContext";

const PACKAGE_VERSION = "ai-lp13-d1-a23-v1";
export const AI_CONTEXT_MODE_VALUES: readonly AIContextMode[] = Object.freeze([
  "MINIMAL",
  "BRIEF",
  "STANDARD",
  "DETAILED"
]);

/**
 * Single canonical mapping for the one A7 channel-specific composition policy.
 * The structural input keeps the Context Builder independent of Quick runtime types.
 */
export function resolveAIContextCompositionPolicyForQuickTarget(target?: {
  ownerType?: string;
  channel?: string;
}): AIContextCompositionPolicy | undefined {
  return target?.ownerType === "literature" && target.channel === "literature_outline"
    ? "LITERATURE_OBJECTIVE_OUTLINE"
    : undefined;
}

const DEFAULT_BUDGET: AIContextBudget = {
  maxChars: 15_000,
  reservedForUserQuestion: 0,
  reservedForSystemInstruction: 0,
  maxSectionChars: 4_000,
  maxItemChars: 1_200,
  strategy: "priorityFirst"
};

const PRIORITY_RANK: Record<AIContextPriority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  background: 4
};

const PROJECT_BACKGROUND_LIMITS = Object.freeze({
  routes: 8,
  tasks: 12,
  reviews: 4,
  experiments: 4,
  experimentRuns: 4,
  literatures: 4,
  findings: 4,
  outputGaps: 4
});

const LEVEL4_POLICY_VERSION = "lp13-b1-c3-level4-v1" as const;
const LEVEL4_MAX_ITEMS = 32;

const LEVEL4_OBJECT_RANK = new Map(
  PROJECT_LEVEL4_RELATION_INDEX_POLICY.objectOrder.map((objectType, index) => [objectType, index])
);

function level4TypedIdentity(objectType: AILevel4ObjectType, canonicalId: string): string {
  return `${objectType}:${canonicalId}`;
}

function level4Module(objectType: AILevel4ObjectType): AIContextModule {
  if (objectType === "route") return "route";
  if (objectType === "task") return "task";
  if (objectType === "review") return "review";
  if (objectType === "experiment" || objectType === "experimentRun") return "experiment";
  if (objectType === "literature") return "literature";
  if (objectType === "researchOutput") return "output";
  return "outputConversion";
}

function level4EntityType(objectType: AILevel4ObjectType): AIContextEntityType {
  if (objectType === "route") return "routeNode";
  if (objectType === "researchOutput") return "formalOutput";
  return objectType;
}

function level4ObjectTypeFromEntityType(
  entityType: AIContextEntityType
): AILevel4ObjectType | undefined {
  if (entityType === "routeNode") return "route";
  if (entityType === "formalOutput") return "researchOutput";
  return PROJECT_LEVEL4_RELATION_INDEX_POLICY.objectOrder.includes(entityType as AILevel4ObjectType)
    ? entityType as AILevel4ObjectType
    : undefined;
}

export class AIContextProtectedBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AIContextProtectedBudgetError";
  }
}

function createPackageId(): string {
  return `ai-context-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function estimateChars(...values: Array<string | undefined>): number {
  return values.reduce<number>((total, value) => total + (value?.length ?? 0), 0);
}

function sourceKey(sourceRef: AIContextSourceRef): string {
  return [
    sourceRef.module,
    sourceRef.entityType,
    sourceRef.entityId,
    sourceRef.field ?? "",
    sourceRef.contextRole ?? ""
  ].join(":");
}

function uniqueSourceRefs(sourceRefs: AIContextSourceRef[]): AIContextSourceRef[] {
  const unique = new Map<string, AIContextSourceRef>();
  for (const sourceRef of sourceRefs) {
    const key = sourceKey(sourceRef);
    if (!unique.has(key)) unique.set(key, sourceRef);
  }
  return [...unique.values()];
}

function createSourceRef(
  module: AIContextModule,
  entityType: AIContextEntityType,
  entityId: string,
  label: string,
  mode: AIContextMode,
  level: AIContextLevel,
  role: AIContextSourceRef["contextRole"],
  field = "summary"
): AIContextSourceRef {
  return {
    module,
    entityType,
    entityId,
    label,
    field,
    sourceKind: "derivedSummary",
    isUserAuthored: true,
    isAiGenerated: false,
    isVerified: false,
    contextMode: mode,
    contextLevel: level,
    contextRole: role,
    contextDisposition: "included"
  };
}

function summaryText(summary: EntitySummary): string {
  return [summary.subtitle, summary.status ? `Status: ${summary.status}` : undefined]
    .filter(Boolean)
    .join(" | ");
}

function evidenceText(summary: EvidenceSummary): string {
  return [
    summary.contentSummary,
    summary.source?.status ? `Status: ${summary.source.status}` : undefined,
    summary.relationType ? `Relation: ${summary.relationType}` : undefined
  ].filter(Boolean).join(" | ");
}

function redactSensitiveText(value: string): { text: string; redacted: boolean } {
  const patterns = [
    /[A-Za-z]:[\\/](?:[^\\/\s|]+[\\/]?)+/g,
    /\\\\[^\s|]+/g,
    /file:\/\/[^\s|]+/gi,
    /\/(?:Users|home|mnt|tmp|var)\/[^\s|]+/g,
    /\bsk-[A-Za-z0-9_-]{16,}\b/g,
    /\bBearer\s+[A-Za-z0-9._-]+\b/gi
  ];
  let text = value;
  for (const pattern of patterns) text = text.replace(pattern, "[sensitive value omitted]");
  return { text, redacted: text !== value };
}

function createItem(input: {
  id: string;
  title: string;
  summary: string;
  module: AIContextModule;
  entityType: AIContextEntityType;
  sourceRef: AIContextSourceRef;
  priority: AIContextPriority;
  level: AIContextLevel;
  stableOrder: number;
  protectedFromContextBudget?: boolean;
  sendable?: boolean;
  createdAt?: string;
  updatedAt?: string;
  metadata?: AIContextItem["metadata"];
}): AIContextItem {
  return {
    id: input.id,
    title: input.title,
    summary: input.summary || input.title,
    module: input.module,
    entityType: input.entityType,
    sourceRefs: [input.sourceRef],
    priority: input.priority,
    contextLevel: input.level,
    stableOrder: input.stableOrder,
    protectedFromContextBudget: input.protectedFromContextBudget,
    charCount: estimateChars(input.title, input.summary || input.title),
    sendable: input.sendable ?? true,
    truncated: false,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    metadata: input.metadata
  };
}

function createEntityItem(
  summary: EntitySummary,
  module: AIContextModule,
  entityType: AIContextEntityType,
  mode: AIContextMode,
  level: AIContextLevel,
  role: AIContextSourceRef["contextRole"],
  priority: AIContextPriority,
  stableOrder: number,
  protectedFromContextBudget = false
): AIContextItem {
  return createItem({
    id: `${entityType}:${summary.entityId}:${role ?? "context"}`,
    title: summary.title,
    summary: summaryText(summary),
    module,
    entityType,
    sourceRef: createSourceRef(module, entityType, summary.entityId, summary.title, mode, level, role),
    priority,
    level,
    stableOrder,
    protectedFromContextBudget,
    sendable: summary.sourceAvailable,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    metadata: summary.status ? { status: summary.status } : undefined
  });
}

function createEvidenceItem(
  summary: EvidenceSummary,
  mode: AIContextMode,
  level: AIContextLevel,
  stableOrder: number
): AIContextItem {
  return createItem({
    id: `outputGap:${summary.evidenceId}:background`,
    title: summary.title,
    summary: evidenceText(summary),
    module: "outputConversion",
    entityType: "outputGap",
    sourceRef: createSourceRef(
      "outputConversion",
      "outputGap",
      summary.evidenceId,
      summary.title,
      mode,
      level,
      "background"
    ),
    priority: "background",
    level,
    stableOrder,
    sendable: summary.source?.sourceAvailable !== false,
    createdAt: summary.source?.createdAt,
    updatedAt: summary.source?.updatedAt
  });
}

function createLevel4Item(
  entry: ProjectLevel4RelationIndexEntry,
  mode: AIContextMode,
  stableOrder: number
): AIContextItem {
  const objectType = entry.objectType as AILevel4ObjectType;
  const relationText = entry.relationKeys.length > 0
    ? `Relations: ${entry.relationKeys.map((relationKey) =>
        `${relationKey.relationType}:${relationKey.targetType}:${relationKey.targetId}`
      ).join(", ")}`
    : "Relations: none";
  const coreSummary = [
    `Type: ${objectType}`,
    entry.status ? `Status: ${entry.status}` : undefined,
    relationText
  ].filter((value): value is string => Boolean(value)).join(" | ");
  const summary = entry.safeSummary
    ? `${coreSummary} | Metadata: ${entry.safeSummary}`
    : coreSummary;
  const module = level4Module(objectType);
  const entityType = level4EntityType(objectType);
  const sourceRef: AIContextSourceRef = {
    ...createSourceRef(
      module,
      entityType,
      entry.canonicalId,
      entry.safeLabel,
      mode,
      4,
      "background",
      "confirmed project-member relation index"
    ),
    isVerified: true,
    level4ObjectType: objectType,
    level4CanonicalProjectId: entry.projectId,
    level4SafeSummary: entry.safeSummary,
    level4Status: entry.status,
    level4MembershipSource: entry.membershipSource,
    level4RelationSource: entry.relationSource,
    level4RelationKeys: entry.relationKeys,
    level4InclusionReason: "confirmed_current_project_member",
    level4SummaryDisposition: "included"
  };
  return createItem({
    id: `level4:${objectType}:${entry.canonicalId}`,
    title: entry.safeLabel,
    summary,
    module,
    entityType,
    sourceRef,
    priority: "background",
    level: 4,
    stableOrder,
    metadata: {
      ...(entry.status ? { status: entry.status } : {}),
      level4ObjectType: objectType,
      level4CoreSummary: coreSummary,
      ...(entry.safeSummary ? { level4OptionalSummary: entry.safeSummary } : {})
    }
  });
}

function higherLevelTypedIdentities(sections: AIContextSection[]): Set<string> {
  const identities = new Set<string>();
  for (const item of sections.flatMap((section) => section.items)) {
    if ((item.contextLevel ?? 4) >= 4) continue;
    for (const sourceRef of item.sourceRefs) {
      const objectType = level4ObjectTypeFromEntityType(sourceRef.entityType);
      if (objectType && sourceRef.entityId) {
        identities.add(level4TypedIdentity(objectType, sourceRef.entityId));
      }
    }
  }
  return identities;
}

function createProjectIdentityItem(
  context: ProjectResearchContext,
  mode: AIContextMode
): AIContextItem {
  const minimalSummary = context.project.status
    ? `Status: ${context.project.status}`
    : "Selected Project identity.";
  return createItem({
    id: `project:${context.project.entityId}:scope`,
    title: context.project.title,
    summary: mode === "MINIMAL" ? minimalSummary : summaryText(context.project),
    module: "project",
    entityType: "project",
    sourceRef: createSourceRef(
      "project",
      "project",
      context.project.entityId,
      context.project.title,
      mode,
      1,
      "scope",
      mode === "MINIMAL" ? "identity" : "bounded project summary"
    ),
    priority: "critical",
    level: 1,
    stableOrder: -1,
    protectedFromContextBudget: true,
    sendable: context.project.sourceAvailable,
    updatedAt: context.project.updatedAt,
    metadata: context.project.status ? { status: context.project.status } : undefined
  });
}

function createProjectProfileItem(
  context: ProjectResearchContext,
  mode: AIContextMode,
  level: AIContextLevel
): AIContextItem | null {
  const lines = [
    context.projectFieldContract.methodSummary
      ? `Method summary: ${context.projectFieldContract.methodSummary}`
      : undefined,
    context.projectFieldContract.expectedOutputs
      ? `Expected outputs: ${context.projectFieldContract.expectedOutputs}`
      : undefined
  ].filter((line): line is string => Boolean(line));
  if (lines.length === 0) return null;
  return createItem({
    id: `project-profile:${context.project.entityId}`,
    title: "Project method and expected outputs",
    summary: lines.join("\n"),
    module: "project",
    entityType: "project",
    sourceRef: createSourceRef(
      "project",
      "project",
      context.project.entityId,
      context.project.title,
      mode,
      level,
      level === 4 ? "background" : "scope",
      "method and expected outputs"
    ),
    priority: level === 4 ? "low" : "high",
    level,
    stableOrder: 1,
    sendable: context.project.sourceAvailable,
    updatedAt: context.project.updatedAt
  });
}

function createSection(
  id: string,
  title: string,
  module: AIContextModule,
  priority: AIContextPriority,
  items: AIContextItem[]
): AIContextSection {
  const ordered = orderTaskContextCandidates(items);
  return {
    id,
    title,
    module,
    items: ordered,
    priority,
    charCount: ordered.reduce((total, item) => total + item.charCount, 0),
    budgetUsed: ordered.reduce((total, item) => total + item.charCount, 0),
    truncated: ordered.some((item) => item.truncated),
    sourceRefs: uniqueSourceRefs(ordered.flatMap((item) => item.sourceRefs))
  };
}

function requestableRefKey(ref: AIContextRequestableRef): string {
  return `${ref.refKind}:${ref.refId}`;
}

function uniqueRequestableRefs(refs: AIContextRequestableRef[]): AIContextRequestableRef[] {
  const unique = new Map<string, AIContextRequestableRef>();
  for (const ref of refs) {
    if (!unique.has(requestableRefKey(ref))) unique.set(requestableRefKey(ref), ref);
  }
  return [...unique.values()].sort((left, right) =>
    left.refKind.localeCompare(right.refKind) || left.refId.localeCompare(right.refId)
  );
}

function approvedContextRequestSection(
  options: AIContextBuildOptions,
  mode: AIContextMode
): AIContextSection | null {
  const contributions = [...(options.approvedContextRequestContributions ?? [])]
    .filter((candidate) => candidate.refKind === "FILE_REF")
    .sort((left, right) => left.refId.localeCompare(right.refId));
  if (contributions.length === 0) return null;
  return createSection(
    "approved-context-request",
    "Approved request-scoped context",
    "experiment",
    "critical",
    contributions.map((candidate, index) => createItem({
      id: `context-request:${candidate.refKind}:${candidate.refId}:${candidate.contributionKind}`,
      title: candidate.label,
      summary: candidate.contributionKind === "BODY_CONTENT"
        ? "Approved FileRef identity; body remains gated by explicit per-call authorization."
        : "Approved FileRef identity metadata only; no file body is read.",
      module: "experiment",
      entityType: "fileRef",
      sourceRef: {
        module: "experiment",
        entityType: "fileRef",
        entityId: candidate.refId,
        label: candidate.label,
        field: candidate.contributionKind === "BODY_CONTENT"
          ? "approved request-scoped FileRef identity; body authorization pending"
          : "approved request-scoped FileRef identity metadata",
        sourceKind: "linkedReference",
        isUserAuthored: true,
        isAiGenerated: false,
        isVerified: true,
        contextMode: mode,
        contextLevel: 1,
        contextRole: "explicitMaterial",
        contextDisposition: "included"
      },
      priority: "critical",
      level: 1,
      stableOrder: -100 + index,
      protectedFromContextBudget: true,
      metadata: {
        requestedContributionKind: candidate.contributionKind,
        fileBodyAuthorizationRequired: candidate.fileBodyAuthorizationRequired
      }
    }))
  );
}

function moduleIncluded(module: AIContextModule, options: AIContextBuildOptions): boolean {
  if (options.excludeModules?.includes(module)) return false;
  return !options.includeModules || options.includeModules.includes(module);
}

function prepareItem(
  item: AIContextItem,
  maxChars: number,
  warnings: AIContextWarning[],
  excluded: AIContextExcludedItem[]
): AIContextItem | null {
  if (!item.sendable) {
    excluded.push({
      reason: "notSendable",
      module: item.module,
      entityType: item.entityType,
      entityId: item.sourceRefs[0]?.entityId,
      label: item.title,
      sourceRefs: item.sourceRefs.map((ref) => ({ ...ref, contextDisposition: "excluded" })),
      ...(item.sourceRefs[0]?.level4ObjectType ? {
        level4ObjectType: item.sourceRefs[0].level4ObjectType,
        level4Reason: "canonical_source_unavailable",
        level4Disposition: "excluded" as const,
        aggregateCount: 1
      } : {})
    });
    warnings.push({
      code: "source_not_sendable",
      message: `${item.title} was excluded because its canonical source is unavailable.`,
      severity: item.protectedFromContextBudget ? "error" : "warning",
      sourceRefs: item.sourceRefs
    });
    return null;
  }

  const redactedTitle = redactSensitiveText(item.title);
  const redactedSummary = redactSensitiveText(item.summary);
  const sourceRefs = item.sourceRefs.map((sourceRef) => {
    if (!sourceRef.label) return sourceRef;
    const redactedLabel = redactSensitiveText(sourceRef.label);
    return redactedLabel.redacted ? { ...sourceRef, label: redactedLabel.text } : sourceRef;
  });
  const wasRedacted = redactedTitle.redacted || redactedSummary.redacted ||
    sourceRefs.some((sourceRef, index) => sourceRef !== item.sourceRefs[index]);
  let next: AIContextItem = wasRedacted
    ? {
        ...item,
        title: redactedTitle.text,
        summary: redactedSummary.text,
        sourceRefs,
        charCount: estimateChars(redactedTitle.text, redactedSummary.text),
        redactionNote: "Local path or secret-like content was removed."
      }
    : item;
  if (wasRedacted) {
    warnings.push({
      code: "sensitive_content_redacted",
      message: `Sensitive path or secret-like content was removed from ${item.id}.`,
      severity: "warning",
      sourceRefs
    });
  }

  if (next.charCount > maxChars) {
    const available = Math.max(0, maxChars - next.title.length - 1);
    const summary = available > 1 ? `${next.summary.slice(0, available - 1)}…` : "";
    next = {
      ...next,
      summary,
      charCount: estimateChars(next.title, summary),
      truncated: true
    };
    warnings.push({
      code: "item_truncated",
      message: `${next.title} was truncated to the per-item context budget.`,
      severity: "warning",
      sourceRefs: item.sourceRefs
    });
  }
  return next;
}

function budgetSections(
  sections: AIContextSection[],
  budget: AIContextBudget,
  warnings: AIContextWarning[],
  excluded: AIContextExcludedItem[]
): AIContextSection[] {
  const contextLimit = Math.max(0, budget.maxChars);
  let workingSections = sections;
  let allItems = workingSections.flatMap((section) => section.items);
  const protectedChars = allItems
    .filter((item) => item.protectedFromContextBudget)
    .reduce((total, item) => total + item.charCount, 0);
  if (protectedChars > contextLimit) {
    throw new AIContextProtectedBudgetError(
      `Protected Level 1 context requires ${protectedChars} characters but only ${contextLimit} are available.`
    );
  }

  let usedChars = allItems.reduce((total, item) => total + item.charCount, 0);
  if (usedChars > contextLimit) {
    const reducedCounts = new Map<AILevel4ObjectType, number>();
    const reducedSourceRefs: AIContextSourceRef[] = [];
    workingSections = workingSections.map((section) => {
      let changed = false;
      const items = section.items.map((item) => {
        const optionalSummary = item.metadata?.level4OptionalSummary;
        const coreSummary = item.metadata?.level4CoreSummary;
        const objectType = item.sourceRefs[0]?.level4ObjectType;
        if (
          item.contextLevel !== 4 ||
          !objectType ||
          typeof optionalSummary !== "string" ||
          typeof coreSummary !== "string"
        ) return item;
        changed = true;
        reducedCounts.set(objectType, (reducedCounts.get(objectType) ?? 0) + 1);
        const sourceRefs = item.sourceRefs.map((sourceRef) => ({
          ...sourceRef,
          level4SafeSummary: undefined,
          level4SummaryDisposition: "omitted_for_budget" as const
        }));
        reducedSourceRefs.push(...sourceRefs);
        const metadata = { ...(item.metadata ?? {}) };
        delete metadata.level4OptionalSummary;
        metadata.level4SummaryDisposition = "omitted_for_budget";
        return {
          ...item,
          summary: coreSummary,
          sourceRefs,
          charCount: estimateChars(item.title, coreSummary),
          truncated: true,
          metadata
        };
      });
      if (!changed) return section;
      const next = createSection(section.id, section.title, section.module, section.priority, items);
      next.truncated = true;
      return next;
    });
    for (const [objectType, count] of [...reducedCounts.entries()].sort((left, right) =>
      (LEVEL4_OBJECT_RANK.get(left[0]) ?? Number.MAX_SAFE_INTEGER) -
        (LEVEL4_OBJECT_RANK.get(right[0]) ?? Number.MAX_SAFE_INTEGER)
    )) {
      excluded.push({
        reason: "budget",
        module: level4Module(objectType),
        entityType: level4EntityType(objectType),
        label: `${count} ${objectType} optional Level-4 summaries were omitted before item removal.`,
        sourceRefs: [],
        level4ObjectType: objectType,
        level4Reason: "optional_summary_omitted_for_budget",
        level4Disposition: "degraded",
        aggregateCount: count
      });
    }
    if (reducedCounts.size > 0) {
      warnings.push({
        code: "level4_optional_summary_degraded",
        message: "Optional Level-4 summaries were omitted before any Level-4 item was removed.",
        severity: "warning",
        sourceRefs: uniqueSourceRefs(reducedSourceRefs)
      });
    }
    allItems = workingSections.flatMap((section) => section.items);
    usedChars = allItems.reduce((total, item) => total + item.charCount, 0);
  }

  const dropped = new Set<string>();
  const dropOrder = allItems
    .filter((item) => !item.protectedFromContextBudget)
    .sort((left, right) =>
      (right.contextLevel ?? 4) - (left.contextLevel ?? 4) ||
      PRIORITY_RANK[right.priority] - PRIORITY_RANK[left.priority] ||
      (right.stableOrder ?? 0) - (left.stableOrder ?? 0) ||
      right.entityType.localeCompare(left.entityType) ||
      right.id.localeCompare(left.id)
    );

  for (const item of dropOrder) {
    if (usedChars <= contextLimit) break;
    dropped.add(item.id);
    usedChars -= item.charCount;
    excluded.push({
      reason: "budget",
      module: item.module,
      entityType: item.entityType,
      entityId: item.sourceRefs[0]?.entityId,
      label: item.title,
      sourceRefs: item.sourceRefs.map((ref) => ({ ...ref, contextDisposition: "excluded" })),
      ...(item.sourceRefs[0]?.level4ObjectType ? {
        level4ObjectType: item.sourceRefs[0].level4ObjectType,
        level4Reason: "context_budget",
        level4Disposition: "excluded" as const,
        aggregateCount: 1
      } : {})
    });
  }

  if (dropped.size > 0) {
    warnings.push({
      code: "budget_degraded",
      message: "Context budget degraded Level 4, then Level 3, then Level 2 items; Level 1 was preserved.",
      severity: "warning",
      sourceRefs: uniqueSourceRefs(
        excluded.filter((item) => item.reason === "budget").flatMap((item) => item.sourceRefs)
      )
    });
  }

  return workingSections.flatMap((section) => {
    const kept = section.items.filter((item) => !dropped.has(item.id));
    if (kept.length === 0) return [];
    const next = createSection(section.id, section.title, section.module, section.priority, kept);
    next.truncated = section.truncated || kept.length !== section.items.length;
    return [next];
  });
}

function addDeferredModules(
  context: ProjectResearchContext,
  selectedExperimentIds: Set<string>,
  selectedExperimentRunIds: Set<string>,
  selectedLiteratureIds: Set<string>,
  selectedFindingIds: Set<string>,
  excluded: AIContextExcludedItem[]
): void {
  const unselectedExperiments = context.experiments.filter((summary) => (
    !selectedExperimentIds.has(summary.evidenceId)
  ));
  if (unselectedExperiments.length) {
    excluded.push({
      reason: "notSelected",
      module: "experiment",
      entityType: "experiment",
      label: `${unselectedExperiments.length} unselected Experiment summaries are outside the current Research Object scope.`,
      sourceRefs: []
    });
  }
  const unselectedExperimentRuns = context.experimentRuns.filter((summary) => (
    !selectedExperimentRunIds.has(summary.evidenceId)
  ));
  if (unselectedExperimentRuns.length) {
    excluded.push({
      reason: "notSelected",
      module: "experiment",
      entityType: "experimentRun",
      label: `${unselectedExperimentRuns.length} unselected ExperimentRun summaries are outside the current Research Object scope.`,
      sourceRefs: []
    });
  }
  const unselectedLiterature = context.literatures.filter((summary) => (
    !selectedLiteratureIds.has(summary.evidenceId)
  ));
  if (unselectedLiterature.length) {
    excluded.push({
      reason: "notSelected",
      module: "literature",
      entityType: "literature",
      label: `${unselectedLiterature.length} unselected Literature summaries are outside the current Research Object scope.`,
      sourceRefs: []
    });
  }
  if (
    context.findings.some((summary) => !selectedFindingIds.has(summary.evidenceId)) ||
    context.outputCandidates.length || context.resultItems.length
  ) {
    excluded.push({ reason: "unsupported", module: "outputConversion", entityType: "outputCandidate", label: "Detailed output-conversion evidence is deferred.", sourceRefs: [] });
  }
  if (context.outputs.length) {
    excluded.push({ reason: "unsupported", module: "output", entityType: "formalOutput", label: "Formal output details and paths are deferred.", sourceRefs: [] });
  }
}

function addProjectIndexModeExclusions(
  context: ProjectResearchContext,
  mode: AIContextMode,
  selectedTaskIds: Set<string>,
  selectedReviewIds: Set<string>,
  excluded: AIContextExcludedItem[]
): void {
  const groups: Array<{
    count: number;
    module: AIContextModule;
    entityType: AIContextEntityType;
    label: string;
  }> = [
    { count: context.routeNodes.length, module: "route", entityType: "routeNode", label: "Project route index" },
    { count: context.tasks.filter((summary) => !selectedTaskIds.has(summary.entityId)).length, module: "task", entityType: "task", label: "Other Project Task index" },
    { count: context.reviews.filter((summary) => !selectedReviewIds.has(summary.entityId)).length, module: "review", entityType: "review", label: "Other Project Review index" },
    {
      count: context.outputGaps.filter((summary) => !["resolved", "abandoned"].includes(summary.source?.status ?? "")).length,
      module: "outputConversion",
      entityType: "outputGap",
      label: "Unresolved Project output-gap index"
    }
  ];
  for (const group of groups) {
    if (group.count === 0) continue;
    excluded.push({
      reason: "notSelected",
      module: group.module,
      entityType: group.entityType,
      label: `${group.label} (${group.count}) excluded by ${mode}.`,
      sourceRefs: []
    });
  }
}

function materialDecisions(
  options: AIContextBuildOptions,
  mode: AIContextMode,
  warnings: AIContextWarning[]
): AIContextMaterialDecision[] {
  const result: AIContextMaterialDecision[] = [];
  const seen = new Set<string>();
  for (const material of options.selectedMaterials ?? []) {
    if (seen.has(material.fileRefId)) continue;
    seen.add(material.fileRefId);
    result.push({
      ...material,
      selected: true,
      authorizationStatus: "pending_per_call_authorization",
      contextRole: "explicitMaterial",
      contextLevel: 1
    });
    if (
      material.availabilityStatus !== "available" ||
      material.materialReadStatus !== "supported" ||
      !Number.isSafeInteger(material.materialPromptReservationCharacters) ||
      material.materialPromptReservationCharacters <= 0 ||
      !material.materialFreshnessReceipt ||
      material.materialFreshnessReceipt.fileRefId !== material.fileRefId ||
      material.materialFreshnessReceipt.receiptVersion !== "material-source-v1" ||
      !/^[a-f0-9]{64}$/.test(material.materialFreshnessReceipt.sourceToken)
    ) {
      warnings.push({
        code: "material_selection_not_authorizable",
        message: `${material.displayName} is selected but does not have a current canonical reservation and metadata-only freshness baseline for this review.`,
        severity: "error",
        sourceRefs: [{
          module: "experiment",
          entityType: "fileRef",
          entityId: material.fileRefId,
          label: material.displayName,
          field: "explicit per-call material selection",
          sourceKind: "linkedReference",
          contextMode: mode,
          contextLevel: 1,
          contextRole: "explicitMaterial",
          contextDisposition: "included"
        }]
      });
    }
  }
  return result;
}

function materialSourceRefs(
  decisions: AIContextMaterialDecision[],
  mode: AIContextMode
): AIContextSourceRef[] {
  return decisions.map((decision) => ({
    module: "experiment",
    entityType: "fileRef",
    entityId: decision.fileRefId,
    label: decision.displayName,
    field: "explicit per-call material selection; body supplied only by the final provider authorization gate",
    sourceKind: "linkedReference",
    isUserAuthored: true,
    isAiGenerated: false,
    isVerified: false,
    contextMode: mode,
    contextLevel: 1,
    contextRole: "explicitMaterial",
    contextDisposition: "included"
  }));
}

function createBudgetSummary(
  budget: AIContextBudget,
  sections: AIContextSection[],
  excluded: AIContextExcludedItem[],
  warnings: AIContextWarning[]
): AIContextBudgetSummary {
  const usedChars = sections.reduce((total, section) => total + section.charCount, 0);
  const contextLimit = Math.max(0, budget.maxChars);
  return {
    maxChars: budget.maxChars,
    usedChars,
    remainingChars: Math.max(0, contextLimit - usedChars),
    truncatedSections: sections.filter((section) => section.truncated).length,
    truncatedItems: sections.flatMap((section) => section.items).filter((item) => item.truncated).length,
    excludedItems: excluded.length,
    budgetScope: "AUTO_PULLED_RESEARCH_CONTEXT",
    notes: [
      "Only allowlisted automatically pulled research context is counted here.",
      "User input/material, conversation continuity, constraints/protocols, and transport overhead are excluded.",
      "Level 1 research-object identity is protected; lower levels degrade in 4 → 3 → 2 order.",
      "Explicit FileRef bodies remain owned by the existing per-call material reader and final prompt gate.",
      ...(warnings.some((warning) => warning.code === "budget_degraded")
        ? ["Lower-level context was excluded by the context budget."]
        : [])
    ]
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)])
    );
  }
  return value;
}

function deterministicHash(value: unknown): string {
  const text = JSON.stringify(stableValue(value));
  let hash = 0x811c9dc5;
  for (const char of text) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `lp13-a2-${hash.toString(16).padStart(8, "0")}`;
}

function buildLevel4ExclusionSummary(
  excluded: AIContextExcludedItem[]
): AILevel4ExclusionSummary[] {
  const grouped = new Map<string, AILevel4ExclusionSummary>();
  for (const item of excluded) {
    const objectType = item.level4ObjectType ??
      item.sourceRefs.map((sourceRef) => sourceRef.level4ObjectType).find(Boolean);
    if (!objectType) continue;
    const reason = item.level4Reason ?? item.reason;
    const disposition = item.level4Disposition ?? "excluded";
    const key = `${objectType}:${disposition}:${reason}`;
    const current = grouped.get(key);
    grouped.set(key, {
      objectType,
      reason,
      disposition,
      count: (current?.count ?? 0) + (item.aggregateCount ?? 1)
    });
  }
  return [...grouped.values()].sort((left, right) =>
    (LEVEL4_OBJECT_RANK.get(left.objectType) ?? Number.MAX_SAFE_INTEGER) -
      (LEVEL4_OBJECT_RANK.get(right.objectType) ?? Number.MAX_SAFE_INTEGER) ||
    left.disposition.localeCompare(right.disposition) ||
    left.reason.localeCompare(right.reason)
  );
}

function buildLevel4Snapshot(
  sections: AIContextSection[],
  excluded: AIContextExcludedItem[]
): AILevel4Snapshot {
  const includedByIdentity = new Map<string, AILevel4IncludedItem>();
  for (const item of sections.flatMap((section) => section.items)) {
    const sourceRef = item.sourceRefs.find((candidate) => Boolean(candidate.level4ObjectType));
    if (item.contextLevel !== 4 || !sourceRef?.level4ObjectType) continue;
    const included: AILevel4IncludedItem = {
      objectType: sourceRef.level4ObjectType,
      canonicalId: sourceRef.entityId,
      safeLabel: sourceRef.label ?? item.title,
      safeSummary: sourceRef.level4SafeSummary,
      status: sourceRef.level4Status,
      relationKeys: (sourceRef.level4RelationKeys ?? []).map((relationKey) => ({ ...relationKey })),
      membershipSource: sourceRef.level4MembershipSource ?? "direct_project_id",
      relationSource: sourceRef.level4RelationSource ?? "none",
      inclusionReason: "confirmed_current_project_member"
    };
    includedByIdentity.set(
      level4TypedIdentity(included.objectType, included.canonicalId),
      included
    );
  }
  const includedItems = [...includedByIdentity.values()].sort((left, right) =>
    (LEVEL4_OBJECT_RANK.get(left.objectType) ?? Number.MAX_SAFE_INTEGER) -
      (LEVEL4_OBJECT_RANK.get(right.objectType) ?? Number.MAX_SAFE_INTEGER) ||
    left.canonicalId.localeCompare(right.canonicalId)
  );
  const exclusionSummary = buildLevel4ExclusionSummary(excluded);
  const decision: AILevel4Snapshot["decision"] = includedItems.length === 0 && exclusionSummary.length > 0
    ? "excluded"
    : exclusionSummary.length > 0
      ? "degraded"
      : "included";
  const snapshotValue = {
    policyVersion: LEVEL4_POLICY_VERSION,
    decision,
    includedItems,
    exclusionSummary
  };
  return {
    ...snapshotValue,
    fingerprint: deterministicHash(snapshotValue)
  };
}

function attachLevel4SnapshotMetadata(
  sourceRefs: AIContextSourceRef[],
  snapshot: AILevel4Snapshot
): AIContextSourceRef[] {
  let attached = false;
  return sourceRefs.map((sourceRef) => {
    if (
      attached ||
      sourceRef.entityType !== "project" ||
      sourceRef.contextRole !== "scope"
    ) return sourceRef;
    attached = true;
    return {
      ...sourceRef,
      level4SnapshotPolicyVersion: snapshot.policyVersion,
      level4SnapshotDecision: snapshot.decision,
      level4SnapshotFingerprint: snapshot.fingerprint,
      level4IncludedItemCount: snapshot.includedItems.length,
      level4ExclusionSummary: snapshot.exclusionSummary.map((item) =>
        item.sampleLabels
          ? { ...item, sampleLabels: [...item.sampleLabels] }
          : { ...item }
      )
    };
  });
}

function reviewFingerprint(input: {
  mode: AIContextMode;
  projectId: string;
  compositionPolicy?: AIContextBuildOptions["compositionPolicy"];
  descriptors: AIResearchObjectDescriptor[];
  sections: AIContextSection[];
  excluded: AIContextExcludedItem[];
  warnings: AIContextWarning[];
  budget: AIContextBudget;
  materials: AIContextMaterialDecision[];
  requestableRefs: AIContextRequestableRef[];
  approvedContributions: AIContextBuildOptions["approvedContextRequestContributions"];
  level4Snapshot?: AILevel4Snapshot;
}): string {
  return deterministicHash({
    policyVersion: PACKAGE_VERSION,
    mode: input.mode,
    projectId: input.projectId,
    compositionPolicy: input.compositionPolicy ?? null,
    researchObjects: input.descriptors.map((descriptor) => ({
      objectType: descriptor.objectType,
      objectId: descriptor.objectId,
      projectId: descriptor.projectId,
      label: descriptor.label,
      safeMetadata: descriptor.safeMetadata
    })),
    sections: input.sections.map((section) => ({
      id: section.id,
      items: section.items.map((item) => ({
        id: item.id,
        title: item.title,
        summary: item.summary,
        level: item.contextLevel,
        sourceRefs: item.sourceRefs
      }))
    })),
    excluded: input.excluded.map((item) => ({
      reason: item.reason,
      module: item.module,
      entityType: item.entityType,
      entityId: item.entityId,
      label: item.label
    })),
    warnings: input.warnings.map((warning) => ({ code: warning.code, message: warning.message, severity: warning.severity })),
    budget: input.budget,
    materials: input.materials,
    requestableRefs: input.requestableRefs,
    approvedContributions: input.approvedContributions ?? [],
    level4Snapshot: input.level4Snapshot
  });
}

function projectBackgroundSections(
  context: ProjectResearchContext,
  mode: AIContextMode,
  selectedRouteIds: Set<string>,
  selectedTaskIds: Set<string>,
  selectedReviewIds: Set<string>,
  level: AIContextLevel,
  excluded: AIContextExcludedItem[],
  higherLevelIdentities: Set<string>,
  profileLevel: AIContextLevel = level,
  includeProjectBackground = true
): AIContextSection[] {
  let order = 1_000;
  const sections: AIContextSection[] = [];
  const profile = createProjectProfileItem(context, mode, profileLevel);
  if (profile && level !== 4) {
    sections.push(createSection("project-profile", "Project profile", "project", "high", [profile]));
  }
  if (!includeProjectBackground) return sections;

  if (level === 4) {
    for (const aggregate of context.level4RelationIndexExclusions ?? []) {
      excluded.push({
        reason: "notSelected",
        module: level4Module(aggregate.objectType),
        entityType: level4EntityType(aggregate.objectType),
        label: `${aggregate.count} ${aggregate.objectType} items excluded: ${aggregate.reason}.`,
        sourceRefs: [],
        level4ObjectType: aggregate.objectType,
        level4Reason: aggregate.reason,
        level4Disposition: "excluded",
        aggregateCount: aggregate.count
      });
    }

    const validObjectTypes = new Set(PROJECT_LEVEL4_RELATION_INDEX_POLICY.objectOrder);
    const membershipMismatchCounts = new Map<AILevel4ObjectType, number>();
    const orderedCandidates = [...(context.level4RelationIndex ?? [])]
      .filter((entry) => {
        if (!validObjectTypes.has(entry.objectType)) return false;
        if (entry.projectId === context.project.entityId) return true;
        membershipMismatchCounts.set(
          entry.objectType,
          (membershipMismatchCounts.get(entry.objectType) ?? 0) + 1
        );
        return false;
      })
      .sort((left, right) =>
        (LEVEL4_OBJECT_RANK.get(left.objectType) ?? Number.MAX_SAFE_INTEGER) -
          (LEVEL4_OBJECT_RANK.get(right.objectType) ?? Number.MAX_SAFE_INTEGER) ||
        left.canonicalId.localeCompare(right.canonicalId)
      );
    for (const [objectType, count] of [...membershipMismatchCounts.entries()].sort((left, right) =>
      (LEVEL4_OBJECT_RANK.get(left[0]) ?? Number.MAX_SAFE_INTEGER) -
        (LEVEL4_OBJECT_RANK.get(right[0]) ?? Number.MAX_SAFE_INTEGER)
    )) {
      excluded.push({
        reason: "notSelected",
        module: level4Module(objectType),
        entityType: level4EntityType(objectType),
        label: `${count} ${objectType} items excluded: membership_mismatch.`,
        sourceRefs: [],
        level4ObjectType: objectType,
        level4Reason: "membership_mismatch",
        level4Disposition: "excluded",
        aggregateCount: count
      });
    }

    const deduplicated = new Map<string, ProjectLevel4RelationIndexEntry>();
    const duplicateCounts = new Map<AILevel4ObjectType, number>();
    const selectedDuplicateCounts = new Map<AILevel4ObjectType, number>();
    for (const entry of orderedCandidates) {
      const objectType = entry.objectType as AILevel4ObjectType;
      const identity = level4TypedIdentity(objectType, entry.canonicalId);
      if (higherLevelIdentities.has(identity)) {
        selectedDuplicateCounts.set(objectType, (selectedDuplicateCounts.get(objectType) ?? 0) + 1);
        continue;
      }
      if (deduplicated.has(identity)) {
        duplicateCounts.set(objectType, (duplicateCounts.get(objectType) ?? 0) + 1);
        continue;
      }
      deduplicated.set(identity, entry);
    }

    const appendSuppressionAggregates = (
      counts: Map<AILevel4ObjectType, number>,
      reason: string,
      disposition: "excluded" | "degraded"
    ) => {
      for (const [objectType, count] of [...counts.entries()].sort((left, right) =>
        (LEVEL4_OBJECT_RANK.get(left[0]) ?? Number.MAX_SAFE_INTEGER) -
          (LEVEL4_OBJECT_RANK.get(right[0]) ?? Number.MAX_SAFE_INTEGER)
      )) {
        excluded.push({
          reason: "notSelected",
          module: level4Module(objectType),
          entityType: level4EntityType(objectType),
          label: `${count} ${objectType} Level-4 representations suppressed: ${reason}.`,
          sourceRefs: [],
          level4ObjectType: objectType,
          level4Reason: reason,
          level4Disposition: disposition,
          aggregateCount: count
        });
      }
    };
    appendSuppressionAggregates(
      selectedDuplicateCounts,
      "higher_level_representation_wins",
      "degraded"
    );
    appendSuppressionAggregates(duplicateCounts, "typed_duplicate_suppressed", "degraded");

    const boundedCandidates = [...deduplicated.values()].slice(0, LEVEL4_MAX_ITEMS);
    const overflowCounts = new Map<AILevel4ObjectType, number>();
    for (const entry of [...deduplicated.values()].slice(LEVEL4_MAX_ITEMS)) {
      const objectType = entry.objectType as AILevel4ObjectType;
      overflowCounts.set(objectType, (overflowCounts.get(objectType) ?? 0) + 1);
    }
    appendSuppressionAggregates(overflowCounts, "bounded_item_limit", "excluded");

    let level4Order = 2_000;
    for (const objectType of PROJECT_LEVEL4_RELATION_INDEX_POLICY.objectOrder) {
      const items = boundedCandidates
        .filter((entry) => entry.objectType === objectType)
        .map((entry) => createLevel4Item(entry, mode, level4Order++));
      if (items.length === 0) continue;
      sections.push(createSection(
        `level4-${objectType}`,
        `Level-4 confirmed ${objectType} index`,
        level4Module(objectType),
        "background",
        items
      ));
    }
    return sections;
  }

  const orderedRoutes = context.routeNodes
    .filter((summary) => !selectedRouteIds.has(summary.entityId))
    .sort((left, right) => left.entityId.localeCompare(right.entityId));
  const orderedTasks = context.tasks
    .filter((summary) => !selectedTaskIds.has(summary.entityId))
    .sort((left, right) => left.entityId.localeCompare(right.entityId));
  const orderedReviews = context.reviews.filter((summary) => !selectedReviewIds.has(summary.entityId)).sort((left, right) =>
    (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "") ||
    left.entityId.localeCompare(right.entityId)
  );
  const orderedOutputGaps = context.outputGaps
    .filter((summary) => !["resolved", "abandoned"].includes(summary.source?.status ?? ""))
    .sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
  const boundedGroups: Array<{
    values: unknown[];
    limit: number;
    module: AIContextModule;
    entityType: AIContextEntityType;
    label: string;
  }> = [
    { values: orderedRoutes, limit: PROJECT_BACKGROUND_LIMITS.routes, module: "route", entityType: "routeNode", label: "Project routes" },
    { values: orderedTasks, limit: PROJECT_BACKGROUND_LIMITS.tasks, module: "task", entityType: "task", label: "Other project Tasks" },
    { values: orderedReviews, limit: PROJECT_BACKGROUND_LIMITS.reviews, module: "review", entityType: "review", label: "Recent project reviews" },
    { values: orderedOutputGaps, limit: PROJECT_BACKGROUND_LIMITS.outputGaps, module: "outputConversion", entityType: "outputGap", label: "Unresolved project output gaps" }
  ];
  for (const group of boundedGroups) {
    if (group.values.length <= group.limit) continue;
    excluded.push({
      reason: "notSelected",
      module: group.module,
      entityType: group.entityType,
      label: `${group.values.length - group.limit} additional ${group.label} were excluded by the bounded Project-background policy.`,
      sourceRefs: []
    });
  }

  const candidates: Array<[string, string, AIContextModule, AIContextPriority, AIContextItem[]]> = [
    ["routes", "Project routes", "route", "background", orderedRoutes
      .slice(0, PROJECT_BACKGROUND_LIMITS.routes).map((summary) =>
      createEntityItem(summary, "route", "routeNode", mode, level, "background", "background", order++)
    )],
    ["tasks", "Other project tasks", "task", "background", orderedTasks
      .slice(0, PROJECT_BACKGROUND_LIMITS.tasks)
      .map((summary) => createEntityItem(summary, "task", "task", mode, level, "background", "background", order++))],
    ["reviews", "Recent project reviews", "review", "background", orderedReviews
      .slice(0, PROJECT_BACKGROUND_LIMITS.reviews)
      .map((summary) => createEntityItem(summary, "review", "review", mode, level, "background", "background", order++))],
    ["output-gaps", "Unresolved project output gaps", "outputConversion", "background", orderedOutputGaps
      .slice(0, PROJECT_BACKGROUND_LIMITS.outputGaps)
      .map((summary) => createEvidenceItem(summary, mode, level, order++))]
  ];
  for (const [id, title, module, priority, items] of candidates) {
    if (items.length > 0) sections.push(createSection(id, title, module, priority, items));
  }
  return sections;
}

export function normalizeAIContextMode(mode: unknown): AIContextMode {
  if (AI_CONTEXT_MODE_VALUES.includes(mode as AIContextMode)) return mode as AIContextMode;
  if (mode === "MINIMUM_BACKGROUND") return "MINIMAL";
  if (mode === "PROJECT_BACKGROUND" || mode === "LIGHT") return "BRIEF";
  if (mode === "STANDARD_CONTEXT") return "STANDARD";
  throw new Error(`Unsupported AI Context mode: ${String(mode)}`);
}

function normalizedBudget(input?: AIContextBudget): AIContextBudget {
  const budget = {
    ...DEFAULT_BUDGET,
    ...input,
    reservedForUserQuestion: 0,
    reservedForSystemInstruction: 0
  };
  if (!Number.isFinite(budget.maxChars) || budget.maxChars <= 0) {
    throw new Error("AI context budget maxChars must be a positive finite number.");
  }
  return budget;
}

function emptyPackage(
  options: AIContextBuildOptions,
  mode: AIContextMode,
  warning: AIContextWarning
): AIContextPackage {
  const budget = normalizedBudget(options.budget);
  const excluded: AIContextExcludedItem[] = [{
    reason: "notSendable",
    module: "project",
    entityType: "project",
    entityId: options.scopeId,
    label: warning.message,
    sourceRefs: []
  }];
  const budgetSummary = createBudgetSummary(budget, [], excluded, [warning]);
  const fingerprint = deterministicHash({ mode, scopeId: options.scopeId, warning: warning.code, budget });
  return {
    id: createPackageId(),
    version: PACKAGE_VERSION,
    createdAt: new Date().toISOString(),
    scope: { type: options.scopeType, id: options.scopeId },
    sections: [],
    sourceRefs: [],
    budget,
    budgetSummary,
    warnings: [warning],
    excluded,
    contextMode: mode,
    researchObjects: [],
    materialDecisions: [],
    requestableRefs: [],
    reviewFingerprint: fingerprint,
    preview: { sections: [], sourceRefs: [], budgetSummary, excluded, warnings: [warning], estimatedChars: 0 }
  };
}

/** The single ContextPackage finalizer, including isolated Literature objective-outline Quick. */
export async function buildAIContext(options: AIContextBuildOptions): Promise<AIContextPackage> {
  const mode = normalizeAIContextMode(options.contextMode ?? "STANDARD");
  const objectiveOutline = options.compositionPolicy === "LITERATURE_OBJECTIVE_OUTLINE";
  const projectlessGlobalMinimal = Boolean(
    options.scopeType === "global" && mode === "MINIMAL" && !options.scopeId?.trim() &&
    (options.researchObjects?.length ?? 0) === 0 &&
    (options.selectedMaterials?.length ?? 0) === 0 &&
    (options.approvedContextRequestContributions?.length ?? 0) === 0
  );
  if (projectlessGlobalMinimal) {
    return emptyPackage(options, mode, {
      code: "global_minimal_no_project",
      message: "No active Project exists; Natural Chat is using an empty global MINIMAL context.",
      severity: "info",
      sourceRefs: []
    });
  }
  if (!objectiveOutline && options.scopeType !== "project") {
    return emptyPackage(options, mode, {
      code: "unsupported_scope",
      message: `Scope type ${options.scopeType} is not supported by the canonical builder.`,
      severity: "error",
      sourceRefs: []
    });
  }
  let projectId = objectiveOutline ? "" : options.scopeId?.trim() ?? "";
  if (!objectiveOutline && !projectId) {
    throw new Error("[AI Context] scopeId is required for Project context.");
  }
  if (
    objectiveOutline &&
    (
      options.scopeType !== "literature" ||
      options.researchObjects?.length !== 1 ||
      options.researchObjects[0]?.objectType !== "literature" ||
      !options.researchObjects[0].objectId.trim() ||
      options.scopeId?.trim() !== options.researchObjects[0].objectId.trim()
    )
  ) {
    throw new Error(
      "[LP13-F1-A3] LITERATURE_OBJECTIVE_OUTLINE requires one exact Literature scope and selection."
    );
  }
  if (objectiveOutline && (options.approvedContextRequestContributions?.length ?? 0) > 0) {
    throw new Error(
      "[LP13-E1-A7] Objective outline cannot import approved Project Research Context contributions."
    );
  }

  let context: ProjectResearchContext | undefined;
  if (!objectiveOutline) {
    try {
      context = await planningSelectorService.getProjectResearchContext(projectId) ?? undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`[AI Context] Failed to read canonical Project context: ${message}`);
    }
    if (!context || context.project.entityId !== projectId) {
      return emptyPackage(options, mode, {
        code: "project_not_found",
        message: `Project ${projectId} was not found or its identity changed.`,
        severity: "error",
        sourceRefs: []
      });
    }
  }

  const resolved = objectiveOutline
    ? {
        descriptors: [await resolveLiteratureObjectiveOutlineResearchObjectDescriptor(
          options.researchObjects![0].objectId
        )],
        duplicateObjectIds: []
      }
    : await resolveAIResearchObjects(projectId, options.researchObjects ?? []);
  if (objectiveOutline) projectId = resolved.descriptors[0].projectId;
  if (
    objectiveOutline &&
    (resolved.descriptors.length !== 1 || resolved.descriptors[0].objectType !== "literature")
  ) {
    throw new Error(
      "[LP13-E1-A7] Objective outline canonical Literature resolution is missing or ambiguous."
    );
  }
  const selectedRouteIds = new Set(resolved.descriptors
    .filter((descriptor) => descriptor.objectType === "route")
    .map((descriptor) => descriptor.objectId));
  const selectedTaskIds = new Set(resolved.descriptors
    .filter((descriptor) => descriptor.objectType === "task")
    .map((descriptor) => descriptor.objectId));
  const selectedReviewIds = new Set(resolved.descriptors
    .filter((descriptor) => descriptor.objectType === "review")
    .map((descriptor) => descriptor.objectId));
  const selectedExperimentIds = new Set(resolved.descriptors
    .filter((descriptor) => descriptor.objectType === "experiment")
    .map((descriptor) => descriptor.objectId));
  const selectedExperimentRunIds = new Set(resolved.descriptors
    .filter((descriptor) => descriptor.objectType === "experimentRun")
    .map((descriptor) => descriptor.objectId));
  const selectedLiteratureIds = new Set(resolved.descriptors
    .filter((descriptor) => descriptor.objectType === "literature")
    .map((descriptor) => descriptor.objectId));
  const selectedFindingIds = new Set(resolved.descriptors
    .filter((descriptor) => descriptor.objectType === "finding")
    .map((descriptor) => descriptor.objectId));
  const warnings: AIContextWarning[] = (context ? [...context.warnings].sort() : []).map((message) => ({
    code: "source_context_warning",
    message,
    severity: "warning",
    sourceRefs: []
  }));
  if (resolved.duplicateObjectIds.length > 0) {
    warnings.push({
      code: "duplicate_research_object_deduplicated",
      message: `Duplicate research-object selections were deterministically removed: ${resolved.duplicateObjectIds.join(", ")}.`,
      severity: "warning",
      sourceRefs: []
    });
  }
  if (!objectiveOutline && context!.partial) {
    warnings.push({
      code: "partial_context",
      message: "Project context is partial because some canonical references could not be resolved.",
      severity: "warning",
      sourceRefs: []
    });
  }
  const orderedMissingReferences = [...(context?.missingReferences ?? [])].sort((left, right) =>
    `${left.targetType}:${left.targetId}:${left.reason}`.localeCompare(
      `${right.targetType}:${right.targetId}:${right.reason}`
    )
  );
  for (const reference of objectiveOutline ? [] : orderedMissingReferences) {
    warnings.push({
      code: "missing_reference",
      message: `${reference.targetType}:${reference.targetId} | reason=${reference.reason}`,
      severity: "warning",
      sourceRefs: []
    });
  }

  const excluded: AIContextExcludedItem[] = [];
  const usesCompletedLevel4Index = !objectiveOutline && mode === "DETAILED";
  if (!objectiveOutline && !usesCompletedLevel4Index) {
    addDeferredModules(
      context!,
      selectedExperimentIds,
      selectedExperimentRunIds,
      selectedLiteratureIds,
      selectedFindingIds,
      excluded
    );
  }
  const budget = normalizedBudget(options.budget);
  const maxItemChars = budget.maxItemChars ?? DEFAULT_BUDGET.maxItemChars ?? 1_200;
  const sections: AIContextSection[] = [];
  const requestableRefs: AIContextRequestableRef[] = [];
  if (!objectiveOutline) {
    const projectIdentity = createProjectIdentityItem(context!, mode);
    sections.push(createSection("project", "Current project", "project", "critical", [projectIdentity]));
  }

  const primaryRouteItems: AIContextItem[] = [];
  const primaryTaskItems: AIContextItem[] = [];
  const primaryReviewItems: AIContextItem[] = [];
  const primaryExperimentItems: AIContextItem[] = [];
  const primaryExperimentRunItems: AIContextItem[] = [];
  const primaryLiteratureItems: AIContextItem[] = [];
  const primaryFindingItems: AIContextItem[] = [];
  const primaryOutputItems: AIContextItem[] = [];
  const relatedTaskItems: AIContextItem[] = [];
  const relatedReviewItems: AIContextItem[] = [];
  const relatedExperimentItems: AIContextItem[] = [];
  const relatedExperimentRunItems: AIContextItem[] = [];
  const relatedFindingItems: AIContextItem[] = [];
  const parentExperimentProvenanceItems = new Map<string, AIContextItem>();
  for (const [index, descriptor] of resolved.descriptors.entries()) {
    if (descriptor.objectType === "route") {
      const candidates = await buildRouteResearchObjectContextCandidates(descriptor, mode, index);
      primaryRouteItems.push(candidates.primary);
      excluded.push(...candidates.excluded);
      requestableRefs.push(...candidates.requestableRefs);
      for (const message of candidates.warnings) warnings.push({
        code: `${descriptor.objectType}_context_warning`, message: `${descriptor.label}: ${message}`,
        severity: "warning", sourceRefs: [descriptor.sourceRef]
      });
    } else if (descriptor.objectType === "task") {
      const candidates = await buildTaskResearchObjectContextCandidates(descriptor, mode, index);
      primaryTaskItems.push(candidates.primary);
      relatedTaskItems.push(...candidates.related);
      excluded.push(...candidates.excluded);
      requestableRefs.push(...candidates.requestableRefs);
      for (const message of candidates.warnings) warnings.push({
        code: `${descriptor.objectType}_context_warning`, message: `${descriptor.label}: ${message}`,
        severity: "warning", sourceRefs: [descriptor.sourceRef]
      });
    } else if (descriptor.objectType === "review") {
      const candidates = await buildReviewResearchObjectContextCandidates(descriptor, mode, index);
      primaryReviewItems.push(candidates.primary);
      relatedReviewItems.push(...candidates.related);
      excluded.push(...candidates.excluded);
      requestableRefs.push(...candidates.requestableRefs);
      for (const message of candidates.warnings) warnings.push({
        code: `${descriptor.objectType}_context_warning`, message: `${descriptor.label}: ${message}`,
        severity: "warning", sourceRefs: [descriptor.sourceRef]
      });
    } else if (descriptor.objectType === "experiment") {
      const candidates = await buildExperimentResearchObjectContextCandidates(descriptor, mode, index);
      primaryExperimentItems.push(candidates.primary);
      relatedExperimentItems.push(...candidates.related);
      excluded.push(...candidates.excluded);
      requestableRefs.push(...candidates.requestableRefs);
      for (const message of candidates.warnings) warnings.push({
        code: `${descriptor.objectType}_context_warning`,
        message: `${descriptor.label}: ${message}`,
        severity: "warning",
        sourceRefs: [descriptor.sourceRef]
      });
    } else if (descriptor.objectType === "experimentRun") {
      const candidates = await buildExperimentRunResearchObjectContextCandidates(descriptor, mode, index);
      primaryExperimentRunItems.push(candidates.primary);
      relatedExperimentRunItems.push(...candidates.related);
      if (
        mode !== "MINIMAL" &&
        !selectedExperimentIds.has(candidates.parentRelation.parentExperimentId) &&
        !parentExperimentProvenanceItems.has(candidates.parentRelation.parentExperimentId)
      ) {
        parentExperimentProvenanceItems.set(
          candidates.parentRelation.parentExperimentId,
          candidates.parentProvenance
        );
      }
      excluded.push(...candidates.excluded);
      requestableRefs.push(...candidates.requestableRefs);
      for (const message of candidates.warnings) warnings.push({
        code: `${descriptor.objectType}_context_warning`, message: `${descriptor.label}: ${message}`,
        severity: "warning", sourceRefs: [descriptor.sourceRef]
      });
    } else if (descriptor.objectType === "literature") {
      const candidates = buildLiteratureResearchObjectContextCandidates(descriptor, mode, index, {
        includeProjectAssociationInPrompt: !objectiveOutline
      });
      primaryLiteratureItems.push(candidates.primary);
      excluded.push(...candidates.excluded);
      if (!objectiveOutline) requestableRefs.push(...candidates.requestableRefs);
      for (const message of candidates.warnings) warnings.push({
        code: `${descriptor.objectType}_context_warning`, message: `${descriptor.label}: ${message}`,
        severity: "warning", sourceRefs: [descriptor.sourceRef]
      });
    } else if (descriptor.objectType === "finding") {
      const candidates = await buildFindingResearchObjectContextCandidates(descriptor, mode, index);
      primaryFindingItems.push(candidates.primary);
      relatedFindingItems.push(...candidates.related);
      excluded.push(...candidates.excluded);
      requestableRefs.push(...candidates.requestableRefs);
      for (const message of candidates.warnings) warnings.push({
        code: `${descriptor.objectType}_context_warning`, message: `${descriptor.label}: ${message}`,
        severity: "warning", sourceRefs: [descriptor.sourceRef]
      });
    } else {
      const candidates = await buildOutputsResearchObjectContextCandidates(descriptor, mode, index);
      primaryOutputItems.push(candidates.primary);
      excluded.push(...candidates.excluded);
      requestableRefs.push(...candidates.requestableRefs);
      for (const message of candidates.warnings) warnings.push({
        code: `${descriptor.objectType}_context_warning`, message: `${descriptor.label}: ${message}`,
        severity: "warning", sourceRefs: [descriptor.sourceRef]
      });
    }
  }
  if (!objectiveOutline) {
    requestableRefs.push(...context!.tasks
    .filter((summary) => summary.sourceAvailable !== false)
    .sort((left, right) => left.entityId.localeCompare(right.entityId))
    .slice(0, PROJECT_BACKGROUND_LIMITS.tasks)
    .map((summary) => ({
      refKind: "AI_RESEARCH_OBJECT" as const,
      refId: summary.entityId,
      projectId,
      label: summary.title,
      entityType: "task" as const,
      allowedContributionKinds: ["IDENTITY_METADATA" as const]
    })));
  requestableRefs.push(...context!.reviews
    .filter((summary) => summary.sourceAvailable !== false)
    .sort((left, right) => left.entityId.localeCompare(right.entityId))
    .slice(0, PROJECT_BACKGROUND_LIMITS.reviews)
    .map((summary) => ({
      refKind: "AI_RESEARCH_OBJECT" as const,
      refId: summary.entityId,
      projectId,
      label: summary.title,
      entityType: "review" as const,
      allowedContributionKinds: ["IDENTITY_METADATA" as const]
    })));
  requestableRefs.push(...context!.experiments
    .filter((summary) => summary.source?.sourceAvailable !== false)
    .sort((left, right) => left.evidenceId.localeCompare(right.evidenceId))
    .slice(0, PROJECT_BACKGROUND_LIMITS.experiments)
    .map((summary) => ({
      refKind: "AI_RESEARCH_OBJECT" as const,
      refId: summary.evidenceId,
      projectId,
      label: summary.title,
      entityType: "experiment" as const,
      allowedContributionKinds: ["IDENTITY_METADATA" as const]
    })));
  requestableRefs.push(...context!.experimentRuns
    .filter((summary) => summary.source?.sourceAvailable !== false)
    .sort((left, right) => left.evidenceId.localeCompare(right.evidenceId))
    .slice(0, PROJECT_BACKGROUND_LIMITS.experimentRuns)
    .map((summary) => ({
      refKind: "AI_RESEARCH_OBJECT" as const,
      refId: summary.evidenceId,
      projectId,
      label: summary.title,
      entityType: "experimentRun" as const,
      allowedContributionKinds: ["IDENTITY_METADATA" as const]
    })));
  const requestableLiterature = await listLiteratureResearchObjectDescriptors(
    projectId,
    PROJECT_BACKGROUND_LIMITS.literatures
  );
  requestableRefs.push(...requestableLiterature.map((descriptor) => ({
    refKind: "AI_RESEARCH_OBJECT" as const,
    refId: descriptor.objectId,
    projectId,
    label: descriptor.label,
    entityType: "literature" as const,
    allowedContributionKinds: ["IDENTITY_METADATA" as const]
  })));
  const requestableFindings = await listFindingResearchObjectDescriptors(projectId);
    requestableRefs.push(...requestableFindings.slice(0, PROJECT_BACKGROUND_LIMITS.findings).map((descriptor) => ({
      refKind: "AI_RESEARCH_OBJECT" as const,
      refId: descriptor.objectId,
      projectId,
      label: descriptor.label,
      entityType: "finding" as const,
      allowedContributionKinds: ["IDENTITY_METADATA" as const]
    })));
  }
  const canonicalRequestableRefs = objectiveOutline ? [] : uniqueRequestableRefs(requestableRefs);
  if (primaryRouteItems.length > 0) {
    sections.push(createSection("primary-routes", "Selected Routes", "route", "critical", primaryRouteItems));
  }
  if (primaryTaskItems.length > 0) {
    sections.push(createSection("primary-tasks", "Selected Tasks", "task", "critical", primaryTaskItems));
  }
  if (primaryReviewItems.length > 0) {
    sections.push(createSection("primary-reviews", "Selected Reviews", "review", "critical", primaryReviewItems));
  }
  if (primaryExperimentItems.length > 0) {
    sections.push(createSection("primary-experiments", "Selected Experiments", "experiment", "critical", primaryExperimentItems));
  }
  if (primaryExperimentRunItems.length > 0) {
    sections.push(createSection("primary-experiment-runs", "Selected Experiment Runs", "experiment", "critical", primaryExperimentRunItems));
  }
  if (primaryLiteratureItems.length > 0) {
    sections.push(createSection("primary-literature", "Selected Literature", "literature", "critical", primaryLiteratureItems));
  }
  if (primaryFindingItems.length > 0) {
    sections.push(createSection("primary-findings", "Selected Findings", "outputConversion", "critical", primaryFindingItems));
  }
  if (primaryOutputItems.length > 0) {
    sections.push(createSection("primary-outputs", "Selected Outputs", "outputConversion", "critical", primaryOutputItems));
  }
  if (relatedTaskItems.length > 0) {
    sections.push(createSection("task-relations", "Task-scoped direct relations", "task", "high", relatedTaskItems));
  }
  if (relatedReviewItems.length > 0) {
    sections.push(createSection("review-relations", "Review-scoped direct relations", "review", "high", relatedReviewItems));
  }
  if (relatedExperimentItems.length > 0) {
    sections.push(createSection("experiment-relations", "Experiment-scoped direct relations", "experiment", "high", relatedExperimentItems));
  }
  if (parentExperimentProvenanceItems.size > 0) {
    sections.push(createSection(
      "experiment-run-parent-provenance",
      "ExperimentRun parent provenance",
      "experiment",
      "high",
      [...parentExperimentProvenanceItems.values()]
    ));
  }
  if (relatedExperimentRunItems.length > 0) {
    sections.push(createSection("experiment-run-relations", "ExperimentRun-scoped direct relations", "experiment", "high", relatedExperimentRunItems));
  }
  if (relatedFindingItems.length > 0) {
    sections.push(createSection("finding-relations", "Finding-scoped confirmed relations", "outputConversion", "high", relatedFindingItems));
  }
  if (!objectiveOutline) {
    const requestScopedSection = approvedContextRequestSection(options, mode);
    if (requestScopedSection) sections.push(requestScopedSection);

  if (mode === "MINIMAL") {
    if (
      context!.projectFieldContract.methodSummary ||
      context!.projectFieldContract.expectedOutputs
    ) {
      excluded.push({
        reason: "notSelected",
        module: "project",
        entityType: "project",
        entityId: projectId,
        label: "Project profile/background excluded by MINIMAL.",
        sourceRefs: []
      });
    }
    addProjectIndexModeExclusions(
      context!,
      mode,
      selectedTaskIds,
      selectedReviewIds,
      excluded
    );
  } else if (mode === "BRIEF") {
    sections.push(...projectBackgroundSections(
      context!,
      mode,
      selectedRouteIds,
      selectedTaskIds,
      selectedReviewIds,
      2,
      excluded,
      higherLevelTypedIdentities(sections),
      2,
      false
    ));
  } else if (mode === "STANDARD") {
    sections.push(...projectBackgroundSections(
      context!,
      mode,
      selectedRouteIds,
      selectedTaskIds,
      selectedReviewIds,
      3,
      excluded,
      new Set<string>(),
      2
    ));
  } else if (mode === "DETAILED") {
    sections.push(...projectBackgroundSections(
      context!,
      mode,
      selectedRouteIds,
      selectedTaskIds,
      selectedReviewIds,
      3,
      excluded,
      new Set<string>(),
      2
    ));
    sections.push(...projectBackgroundSections(
      context!,
      mode,
      selectedRouteIds,
      selectedTaskIds,
      selectedReviewIds,
      4,
      excluded,
      higherLevelTypedIdentities(sections)
    ));
  }
  }

  const preparedSections = sections.flatMap((section) => {
    if (!moduleIncluded(section.module, options)) {
      const protectedItems = section.items.filter((item) => item.protectedFromContextBudget);
      const excludedRefs = section.sourceRefs.map((sourceRef) => ({
        ...sourceRef,
        contextDisposition: "excluded" as const
      }));
      const level4ObjectType = section.items[0]?.sourceRefs[0]?.level4ObjectType;
      excluded.push({
        reason: "notSelected",
        module: section.module,
        entityType: section.items[0]?.entityType ?? "system",
        label: `${section.title} excluded by build options.`,
        sourceRefs: excludedRefs,
        ...(level4ObjectType ? {
          level4ObjectType,
          level4Reason: "module_excluded_by_build_options",
          level4Disposition: "excluded" as const,
          aggregateCount: section.items.length
        } : {})
      });
      if (protectedItems.length > 0) {
        warnings.push({
          code: "protected_source_excluded_by_build_options",
          message: `${section.title} contains required Level 1 context and cannot be excluded safely.`,
          severity: "error",
          sourceRefs: excludedRefs
        });
      }
      return [];
    }
    const prepared = section.items
      .map((candidate) => prepareItem(candidate, maxItemChars, warnings, excluded))
      .filter((candidate): candidate is AIContextItem => candidate !== null);
    return prepared.length > 0
      ? [createSection(section.id, section.title, section.module, section.priority, prepared)]
      : [];
  });
  const finalSections = finalizeLiteraturePromptVisibleProjectionFingerprints(
    budgetSections(preparedSections, budget, warnings, excluded)
  );
  const level4Snapshot = usesCompletedLevel4Index
    ? buildLevel4Snapshot(finalSections, excluded)
    : undefined;
  const decisions = materialDecisions(options, mode, warnings);
  const baseSourceRefs = uniqueSourceRefs([
    ...finalSections.flatMap((section) => section.sourceRefs),
    ...materialSourceRefs(decisions, mode)
  ]);
  const sourceRefs = level4Snapshot
    ? attachLevel4SnapshotMetadata(baseSourceRefs, level4Snapshot)
    : baseSourceRefs;
  if (sourceRefs.length === 0) {
    warnings.push({ code: "missing_source_refs", message: "No source references were available.", severity: "error", sourceRefs: [] });
  }
  const budgetSummary = createBudgetSummary(budget, finalSections, excluded, warnings);
  const fingerprint = reviewFingerprint({
    mode,
    projectId,
    compositionPolicy: options.compositionPolicy,
    descriptors: resolved.descriptors,
    sections: finalSections,
    excluded,
    warnings,
    budget,
    materials: decisions,
    requestableRefs: canonicalRequestableRefs,
    approvedContributions: options.approvedContextRequestContributions,
    level4Snapshot
  });

  return {
    id: createPackageId(),
    version: PACKAGE_VERSION,
    createdAt: new Date().toISOString(),
    scope: {
      type: objectiveOutline ? "literature" : "project",
      id: objectiveOutline ? resolved.descriptors[0].objectId : projectId,
      label: objectiveOutline
        ? `Objective Literature: ${resolved.descriptors[0].label}`
        : context!.project.title,
      description: objectiveOutline
        ? "Current Literature only; Project Research Context is neither required nor admitted."
        : context!.project.subtitle
    },
    sections: finalSections,
    sourceRefs,
    budget,
    budgetSummary,
    warnings,
    excluded,
    contextMode: mode,
    ...(options.compositionPolicy ? { compositionPolicy: options.compositionPolicy } : {}),
    researchObjects: resolved.descriptors,
    materialDecisions: decisions,
    requestableRefs: canonicalRequestableRefs,
    approvedContextRequestContributions: (options.approvedContextRequestContributions ?? []).map(
      (contribution) => ({ ...contribution })
    ),
    level4Snapshot,
    reviewFingerprint: fingerprint,
    preview: {
      sections: finalSections,
      sourceRefs,
      budgetSummary,
      excluded,
      warnings,
      estimatedChars: budgetSummary.usedChars
    }
  };
}

/** Compatibility entrypoint; it delegates to the single canonical finalizer. */
export async function buildProjectAIContext(
  projectId: string,
  options: Partial<AIContextBuildOptions> = {}
): Promise<AIContextPackage> {
  return buildAIContext({
    ...options,
    scopeType: "project",
    scopeId: projectId,
    contextMode: normalizeAIContextMode(options.contextMode ?? "STANDARD")
  });
}
