import type {
  ActionDraftSourceTuple,
  AIActionDraft,
  AIActionDraftBatch,
  AIActionDraftCapability,
  AIActionDraftPayload,
  AIActionDraftSourceConfidence,
  AIActionDraftSourceRef,
  AIActionDraftSourceType,
  AIActionDraftTarget,
  AIActionDraftTargetEntityType,
  AIActionDraftTargetModule,
  AIActionDraftType,
  AIActionDraftUnion,
  AIDeferredActionDraftType,
  AIEntityLinkCreateDraftPayload,
  AIFindingCreateDraftPayload,
  AILiteratureLinkCreateDraftPayload,
  AIOutputCandidateCreateDraftPayload,
  AIOutputGapCreateDraftPayload,
  AIPlannedActionDraftType,
  AIReviewCandidateDraftPayload,
  AISupportedActionDraftType,
  AITaskCreateDraftPayload,
  DraftInstanceId
} from "../types/aiDraft";
import { createRepositoryEntityId } from "../repositories/entityId";
import { assertCompleteActionDraftSourceTuple } from "./actionDraftSourceTupleService";
import type { AIContextEntityType, AIContextModule, AIContextSourceRef } from "../types/aiContext";
import type { EntityType, Priority, RelationType, TaskStatus, TaskType, TimeBucket } from "../types/planning";
import type {
  FindingConfidence,
  FindingMaturity,
  FindingStatus,
  FindingType,
  OutputCandidateStatus,
  OutputCandidateType,
  OutputGapStatus,
  OutputGapType
} from "../types/outputConversion";
import type {
  LinkConfidence,
  LinkStrength,
  LiteratureEvidenceRole,
  LiteratureLinkTargetType,
  LiteratureRelationType
} from "../types/literature";

export type AIDraftWarningSeverity = "info" | "warning" | "error";

export type AIDraftWarningCode =
  | "parse_failed"
  | "no_drafts_found"
  | "input_truncated"
  | "unsupported_draft_type"
  | "postponed_draft_type"
  | "forbidden_draft_type"
  | "missing_required_field"
  | "invalid_payload"
  | "source_refs_missing"
  | "writeback_not_enabled";

export interface AIActionDraftParseWarning {
  code: AIDraftWarningCode;
  message: string;
  severity: AIDraftWarningSeverity;
  draftIndex?: number;
  draftType?: string;
}

export interface AIActionDraftParseOptions {
  sourceTuple: ActionDraftSourceTuple;
  batchId?: string;
  question?: string;
  sourceContextSummary?: string;
  sourceRefs?: AIActionDraftSourceRef[];
  now?: string;
  maxInputChars?: number;
}

export interface AIParsedActionDraftBatch extends AIActionDraftBatch {
  warnings: AIActionDraftParseWarning[];
  parseSucceeded: boolean;
  rawTextFallback?: string;
}

type NormalizedDraft = {
  draft?: AIActionDraftUnion;
  warnings: AIActionDraftParseWarning[];
};

type ParsedCandidate = {
  items: Record<string, unknown>[];
  sourceRefs: AIActionDraftSourceRef[];
};

const DEFAULT_MAX_INPUT_CHARS = 60_000;
const FALLBACK_MAX_CHARS = 6_000;

const SUPPORTED_DRAFT_TYPES = ["task_create"] as const satisfies readonly AISupportedActionDraftType[];
const PLANNED_DRAFT_TYPES = [
  "review_candidate",
  "output_gap_create",
  "finding_create",
  "output_candidate_create",
  "entity_link_create",
  "literature_link_create"
] as const satisfies readonly AIPlannedActionDraftType[];
const DEFERRED_DRAFT_TYPES = [
  "task_update",
  "route_update",
  "review_overwrite",
  "output_gap_update",
  "output_gap_close",
  "finding_verify",
  "finding_verified_create",
  "output_candidate_to_formal_output",
  "formal_output_create",
  "bulk_link_create",
  "bulk_accept_all",
  "bulk_write_all",
  "auto_execute_all"
] as const satisfies readonly AIDeferredActionDraftType[];
const PROHIBITED_DEFERRED_TYPES = new Set<AIActionDraftType>([
  "bulk_accept_all",
  "bulk_write_all",
  "auto_execute_all"
]);
const ALL_DRAFT_TYPES = [
  ...SUPPORTED_DRAFT_TYPES,
  ...PLANNED_DRAFT_TYPES,
  ...DEFERRED_DRAFT_TYPES
] as const satisfies readonly AIActionDraftType[];

const SOURCE_TYPES = [
  "aiContext",
  "promptPackage",
  "aiRun",
  "userQuestion",
  "manual",
  "unknown"
] as const satisfies readonly AIActionDraftSourceType[];
const SOURCE_CONFIDENCE = ["high", "medium", "low", "unknown"] as const satisfies readonly AIActionDraftSourceConfidence[];
const TARGET_MODULES = [
  "planning",
  "project",
  "route",
  "task",
  "review",
  "experiment",
  "literature",
  "output",
  "link",
  "ai",
  "unknown"
] as const satisfies readonly AIActionDraftTargetModule[];
const TARGET_ENTITY_TYPES = [
  "project",
  "routeNode",
  "task",
  "review",
  "experiment",
  "experimentRun",
  "resultMetric",
  "fileRef",
  "literature",
  "resultItem",
  "finding",
  "outputCandidate",
  "outputGap",
  "output",
  "formalOutput",
  "entityLink",
  "literatureLink",
  "aiRun",
  "unknown"
] as const satisfies readonly AIActionDraftTargetEntityType[];
const CONTEXT_MODULES = [
  "project",
  "route",
  "task",
  "review",
  "experiment",
  "literature",
  "output",
  "outputConversion",
  "entityLink",
  "ai",
  "system"
] as const satisfies readonly AIContextModule[];
const CONTEXT_ENTITY_TYPES = [
  "project",
  "routeNode",
  "task",
  "review",
  "outputGap",
  "experiment",
  "experimentRun",
  "resultMetric",
  "fileRef",
  "literature",
  "resultItem",
  "finding",
  "outputCandidate",
  "evidenceChain",
  "formalOutput",
  "entityLink",
  "aiRun",
  "system"
] as const satisfies readonly AIContextEntityType[];

const TASK_PRIORITIES = ["high", "medium", "low"] as const satisfies readonly Priority[];
const TASK_STATUSES = ["todo", "doing", "delayed", "blocked", "cancelled"] as const satisfies readonly Exclude<TaskStatus, "done" | "archived">[];
const TASK_TYPES = [
  "reading",
  "experiment",
  "coding",
  "writing",
  "analysis",
  "meeting",
  "idea",
  "review",
  "other"
] as const satisfies readonly TaskType[];
const TIME_BUCKETS = ["today", "this_week", "this_month", "long_term", "none"] as const satisfies readonly TimeBucket[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArrayValue(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.map((item) => stringValue(item)).filter((item): item is string => Boolean(item));
  return strings.length ? strings : undefined;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  const text = stringValue(value);
  return text && (allowed as readonly string[]).includes(text) ? (text as T) : undefined;
}

function warning(
  code: AIDraftWarningCode,
  message: string,
  severity: AIDraftWarningSeverity,
  draftIndex?: number,
  draftType?: string
): AIActionDraftParseWarning {
  return { code, message, severity, draftIndex, draftType };
}

function createBatchId(): string {
  return createRepositoryEntityId("ai-draft-batch");
}

function createDraftInstanceId(): DraftInstanceId {
  return createRepositoryEntityId("ai-action-draft") as DraftInstanceId;
}

function truncateText(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 1))}...`;
}

function sanitizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizeJsonValue(item));
  if (!isRecord(value)) return value;

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    result[key] = sanitizeJsonValue(item);
  }
  return result;
}

function extractFirstBalancedJson(text: string): string | undefined {
  const start = text.search(/[{\[]/);
  if (start < 0) return undefined;

  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      stack.push(char);
      continue;
    }
    if (char !== "}" && char !== "]") continue;

    const expected = char === "}" ? "{" : "[";
    if (stack.pop() !== expected) return undefined;
    if (stack.length === 0) return text.slice(start, index + 1);
  }

  return undefined;
}

export function extractAIDraftJsonBlocks(text: string): string[] {
  const blocks: string[] = [];
  const fencedBlockPattern = /```([A-Za-z0-9_-]*)\s*([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = fencedBlockPattern.exec(text))) {
    const language = match[1]?.toLowerCase() ?? "";
    const content = match[2]?.trim() ?? "";
    if (!content) continue;
    if (language === "json" || content.startsWith("{") || content.startsWith("[")) {
      blocks.push(content);
    }
  }

  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    blocks.push(trimmed);
  } else {
    const balanced = extractFirstBalancedJson(text);
    if (balanced) blocks.push(balanced);
  }

  return [...new Set(blocks)];
}

function parseJsonBlock(block: string): unknown | undefined {
  try {
    return sanitizeJsonValue(JSON.parse(block));
  } catch {
    return undefined;
  }
}

function normalizeSourceType(value: unknown): AIActionDraftSourceType {
  return enumValue(value, SOURCE_TYPES) ?? "unknown";
}

function normalizeSourceRef(value: unknown): AIActionDraftSourceRef | undefined {
  const raw = safeRecord(value);
  const aiContextSourceRef = normalizeAIContextSourceRef(raw.aiContextSourceRef);
  const moduleValue =
    enumValue(raw.module, CONTEXT_MODULES) ??
    enumValue(raw.module, TARGET_MODULES);
  const entityTypeValue =
    enumValue(raw.entityType, CONTEXT_ENTITY_TYPES) ??
    enumValue(raw.entityType, TARGET_ENTITY_TYPES);
  const sourceRef: AIActionDraftSourceRef = {
    sourceType: normalizeSourceType(raw.sourceType ?? raw.type),
    sourceId: stringValue(raw.sourceId ?? raw.id),
    module: moduleValue,
    entityType: entityTypeValue,
    entityId: stringValue(raw.entityId),
    label: stringValue(raw.label ?? raw.title),
    field: stringValue(raw.field),
    sectionId: stringValue(raw.sectionId),
    itemId: stringValue(raw.itemId),
    excerpt: stringValue(raw.excerpt),
    confidence: enumValue(raw.confidence, SOURCE_CONFIDENCE) ?? "unknown",
    aiContextSourceRef
  };
  if (
    !sourceRef.sourceId &&
    !sourceRef.entityId &&
    !sourceRef.label &&
    !sourceRef.excerpt &&
    !sourceRef.aiContextSourceRef
  ) {
    return undefined;
  }
  return sourceRef;
}

function normalizeAIContextSourceRef(value: unknown): AIContextSourceRef | undefined {
  const raw = safeRecord(value);
  const moduleValue = enumValue(raw.module, CONTEXT_MODULES);
  const entityTypeValue = enumValue(raw.entityType, CONTEXT_ENTITY_TYPES);
  const entityId = stringValue(raw.entityId);
  if (!moduleValue || !entityTypeValue || !entityId) return undefined;
  return {
    module: moduleValue,
    entityType: entityTypeValue,
    entityId,
    label: stringValue(raw.label),
    field: stringValue(raw.field),
    sourceKind: "derivedSummary",
    isUserAuthored: typeof raw.isUserAuthored === "boolean" ? raw.isUserAuthored : undefined,
    isAiGenerated: typeof raw.isAiGenerated === "boolean" ? raw.isAiGenerated : undefined,
    isVerified: typeof raw.isVerified === "boolean" ? raw.isVerified : undefined,
    confidenceNote: stringValue(raw.confidenceNote)
  };
}

function normalizeSourceRefs(...values: unknown[]): AIActionDraftSourceRef[] {
  const refs: AIActionDraftSourceRef[] = [];
  for (const value of values) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      const sourceRef = normalizeSourceRef(item);
      if (sourceRef) refs.push(sourceRef);
    }
  }
  const unique = new Map<string, AIActionDraftSourceRef>();
  for (const sourceRef of refs) {
    const key = [
      sourceRef.sourceType,
      sourceRef.sourceId ?? "",
      sourceRef.module ?? "",
      sourceRef.entityType ?? "",
      sourceRef.entityId ?? "",
      sourceRef.field ?? ""
    ].join(":");
    unique.set(key, sourceRef);
  }
  return [...unique.values()];
}

function collectCandidate(value: unknown): ParsedCandidate {
  if (Array.isArray(value)) return { items: value.filter(isRecord), sourceRefs: [] };
  if (!isRecord(value)) return { items: [], sourceRefs: [] };

  const sourceRefs = normalizeSourceRefs(value.sourceRefs);
  const draftCollections = [value.drafts, value.actionDrafts, value.aiActionDrafts];
  for (const collection of draftCollections) {
    if (Array.isArray(collection)) return { items: collection.filter(isRecord), sourceRefs };
  }
  if (stringValue(value.draftType ?? value.type ?? value.actionType)) {
    return { items: [value], sourceRefs };
  }
  return { items: [], sourceRefs };
}

function isKnownDraftType(value: string): value is AIActionDraftType {
  return (ALL_DRAFT_TYPES as readonly string[]).includes(value);
}

function capabilityForDraftType(draftType: AIActionDraftType): AIActionDraftCapability {
  if ((SUPPORTED_DRAFT_TYPES as readonly string[]).includes(draftType)) return "supported";
  if ((PLANNED_DRAFT_TYPES as readonly string[]).includes(draftType)) return "planned";
  if (PROHIBITED_DEFERRED_TYPES.has(draftType)) return "prohibited";
  return "deferred";
}

function inferTarget(draftType: AIActionDraftType, raw: Record<string, unknown>): AIActionDraftTarget {
  const rawTarget = safeRecord(raw.target);
  const inferred: Record<AIActionDraftType, AIActionDraftTarget> = {
    task_create: { module: "task", entityType: "task" },
  review_candidate: { module: "review", entityType: "review" },
    output_gap_create: { module: "output", entityType: "outputGap" },
    finding_create: { module: "output", entityType: "finding" },
    output_candidate_create: { module: "output", entityType: "outputCandidate" },
    entity_link_create: { module: "link", entityType: "entityLink" },
    literature_link_create: { module: "literature", entityType: "literatureLink" },
    task_update: { module: "task", entityType: "task" },
    route_update: { module: "route", entityType: "routeNode" },
    review_overwrite: { module: "review", entityType: "review" },
    output_gap_update: { module: "output", entityType: "outputGap" },
    output_gap_close: { module: "output", entityType: "outputGap" },
    finding_verify: { module: "output", entityType: "finding" },
    finding_verified_create: { module: "output", entityType: "finding" },
    output_candidate_to_formal_output: { module: "output", entityType: "outputCandidate" },
    formal_output_create: { module: "output", entityType: "formalOutput" },
    bulk_link_create: { module: "link", entityType: "entityLink" },
    bulk_accept_all: { module: "ai", entityType: "unknown" },
    bulk_write_all: { module: "ai", entityType: "unknown" },
    auto_execute_all: { module: "ai", entityType: "unknown" }
  };
  return {
    module: enumValue(raw.targetModule ?? rawTarget.module, TARGET_MODULES) ?? inferred[draftType].module,
    entityType:
      enumValue(raw.targetEntityType ?? rawTarget.entityType, TARGET_ENTITY_TYPES) ??
      inferred[draftType].entityType,
    entityId: stringValue(raw.targetEntityId ?? rawTarget.entityId),
    label: stringValue(raw.targetLabel ?? rawTarget.label)
  };
}

function markMissing(
  warnings: AIActionDraftParseWarning[],
  draftIndex: number,
  draftType: string,
  field: string
): void {
  warnings.push(
    warning(
      "missing_required_field",
      `Draft ${draftIndex + 1} is missing required field: ${field}.`,
      "warning",
      draftIndex,
      draftType
    )
  );
}

function payloadText(payload: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = stringValue(payload[key]);
    if (value) return value;
  }
  return undefined;
}

function createTaskPayload(
  rawPayload: Record<string, unknown>,
  rawDraft: Record<string, unknown>,
  title: string,
  sourceRefs: AIActionDraftSourceRef[],
  warnings: AIActionDraftParseWarning[],
  draftIndex: number,
  draftType: string
): AITaskCreateDraftPayload {
  const projectId = payloadText(rawPayload, "projectId", "targetProjectId") ?? stringValue(rawDraft.projectId) ?? "";
  const taskTitle = payloadText(rawPayload, "title", "taskTitle") ?? title;
  if (!projectId) markMissing(warnings, draftIndex, draftType, "proposedPayload.projectId");
  if (!taskTitle) markMissing(warnings, draftIndex, draftType, "proposedPayload.title");
  return {
    projectId,
    routeNodeId: payloadText(rawPayload, "routeNodeId", "targetRouteNodeId"),
    title: taskTitle || "Untitled task draft",
    description: payloadText(rawPayload, "description", "detail"),
    priority: enumValue(rawPayload.priority, TASK_PRIORITIES),
    status: enumValue(rawPayload.status, TASK_STATUSES),
    taskType: enumValue(rawPayload.taskType, TASK_TYPES),
    timeBucket: enumValue(rawPayload.timeBucket, TIME_BUCKETS),
    scheduledDate: payloadText(rawPayload, "scheduledDate"),
    dueDate: payloadText(rawPayload, "dueDate"),
    tags: stringArrayValue(rawPayload.tags),
    sourceOutputGapId: payloadText(rawPayload, "sourceOutputGapId", "outputGapId"),
    sourceRefs,
    reason: payloadText(rawPayload, "reason")
  };
}

function createPayload(
  draftType: AIActionDraftType,
  rawPayload: Record<string, unknown>,
  rawDraft: Record<string, unknown>,
  title: string,
  sourceRefs: AIActionDraftSourceRef[],
  warnings: AIActionDraftParseWarning[],
  draftIndex: number
): AIActionDraftPayload {
  if (draftType === "task_create") {
    return createTaskPayload(rawPayload, rawDraft, title, sourceRefs, warnings, draftIndex, draftType);
  }
  if (draftType === "review_candidate") {
    return {
      reviewId: payloadText(rawPayload, "reviewId"),
      projectId: payloadText(rawPayload, "projectId"),
      candidateMarkdown: payloadText(rawPayload, "candidateMarkdown", "draftMarkdown"),
      suggestedSummary: payloadText(rawPayload, "suggestedSummary", "summary"),
      suggestedWarnings: stringArrayValue(rawPayload.suggestedWarnings),
      suggestedNextActionsText: payloadText(rawPayload, "suggestedNextActionsText"),
      suggestedQuestions: stringArrayValue(rawPayload.suggestedQuestions),
      suggestedTargetNotes: payloadText(rawPayload, "suggestedTargetNotes"),
      sourceRefs,
      reason: payloadText(rawPayload, "reason")
    } satisfies AIReviewCandidateDraftPayload;
  }
  if (draftType === "output_gap_create") {
    const titleValue = payloadText(rawPayload, "title", "gapTitle") ?? title;
    if (!titleValue) markMissing(warnings, draftIndex, draftType, "proposedPayload.title");
    return {
      projectId: payloadText(rawPayload, "projectId"),
      routeNodeId: payloadText(rawPayload, "routeNodeId"),
      taskId: payloadText(rawPayload, "taskId"),
      reviewId: payloadText(rawPayload, "reviewId"),
      outputCandidateId: payloadText(rawPayload, "outputCandidateId"),
      title: titleValue || "Untitled output gap draft",
      description: payloadText(rawPayload, "description"),
      gapType: stringValue(rawPayload.gapType) as OutputGapType | undefined,
      priority: enumValue(rawPayload.priority, TASK_PRIORITIES),
      status: stringValue(rawPayload.status) as Extract<OutputGapStatus, "pending"> | undefined,
      sourceRefs,
      reason: payloadText(rawPayload, "reason")
    } satisfies AIOutputGapCreateDraftPayload;
  }
  if (draftType === "finding_create") {
    const titleValue = payloadText(rawPayload, "title", "findingTitle") ?? title;
    if (!titleValue) markMissing(warnings, draftIndex, draftType, "proposedPayload.title");
    return {
      projectId: payloadText(rawPayload, "projectId"),
      routeNodeId: payloadText(rawPayload, "routeNodeId"),
      taskId: payloadText(rawPayload, "taskId"),
      experimentId: payloadText(rawPayload, "experimentId"),
      resultItemIds: stringArrayValue(rawPayload.resultItemIds),
      linkedResultItemIds: stringArrayValue(rawPayload.linkedResultItemIds),
      linkedAssetIds: stringArrayValue(rawPayload.linkedAssetIds),
      title: titleValue || "Untitled finding draft",
      summary: payloadText(rawPayload, "summary"),
      evidenceSummary: payloadText(rawPayload, "evidenceSummary"),
      findingType: stringValue(rawPayload.findingType) as FindingType | undefined,
      confidence: stringValue(rawPayload.confidence) as FindingConfidence | undefined,
      confidenceLabel: payloadText(rawPayload, "confidenceLabel"),
      status: stringValue(rawPayload.status) as FindingStatus | undefined,
      maturity: stringValue(rawPayload.maturity) as FindingMaturity | undefined,
      sourceRefs,
      reason: payloadText(rawPayload, "reason")
    } satisfies AIFindingCreateDraftPayload;
  }
  if (draftType === "output_candidate_create") {
    const titleValue = payloadText(rawPayload, "title", "candidateTitle") ?? title;
    if (!titleValue) markMissing(warnings, draftIndex, draftType, "proposedPayload.title");
    return {
      projectId: payloadText(rawPayload, "projectId"),
      routeNodeId: payloadText(rawPayload, "routeNodeId"),
      taskId: payloadText(rawPayload, "taskId"),
      findingIds: stringArrayValue(rawPayload.findingIds),
      linkedFindingIds: stringArrayValue(rawPayload.linkedFindingIds),
      resultItemIds: stringArrayValue(rawPayload.resultItemIds),
      linkedResultItemIds: stringArrayValue(rawPayload.linkedResultItemIds),
      linkedAssetIds: stringArrayValue(rawPayload.linkedAssetIds),
      title: titleValue || "Untitled output candidate draft",
      summary: payloadText(rawPayload, "summary"),
      description: payloadText(rawPayload, "description"),
      candidateType: stringValue(rawPayload.candidateType) as OutputCandidateType | undefined,
      status: stringValue(rawPayload.status) as Exclude<OutputCandidateStatus, "converted"> | undefined,
      noveltyNotes: payloadText(rawPayload, "noveltyNotes"),
      sourceRefs,
      reason: payloadText(rawPayload, "reason")
    } satisfies AIOutputCandidateCreateDraftPayload;
  }
  if (draftType === "entity_link_create") {
    const payload = {
      sourceType: (payloadText(rawPayload, "sourceType") ?? "other") as EntityType,
      sourceId: payloadText(rawPayload, "sourceId") ?? "",
      targetType: (payloadText(rawPayload, "targetType") ?? "other") as EntityType,
      targetId: payloadText(rawPayload, "targetId") ?? "",
      relationType: (payloadText(rawPayload, "relationType") ?? "related_to") as RelationType,
      sourceRefs,
      reason: payloadText(rawPayload, "reason")
    } satisfies AIEntityLinkCreateDraftPayload;
    if (!payload.sourceId) markMissing(warnings, draftIndex, draftType, "proposedPayload.sourceId");
    if (!payload.targetId) markMissing(warnings, draftIndex, draftType, "proposedPayload.targetId");
    return payload;
  }
  if (draftType === "literature_link_create") {
    const payload = {
      literatureId: payloadText(rawPayload, "literatureId") ?? "",
      targetType: (payloadText(rawPayload, "targetType") ?? "project") as LiteratureLinkTargetType,
      targetId: payloadText(rawPayload, "targetId") ?? "",
      relationType: (payloadText(rawPayload, "relationType") ?? "related") as LiteratureRelationType,
      role: stringValue(rawPayload.role) as LiteratureEvidenceRole | undefined,
      strength: stringValue(rawPayload.strength) as LinkStrength | undefined,
      confidence: stringValue(rawPayload.confidence) as LinkConfidence | undefined,
      sourceRefs,
      reason: payloadText(rawPayload, "reason")
    } satisfies AILiteratureLinkCreateDraftPayload;
    if (!payload.literatureId) markMissing(warnings, draftIndex, draftType, "proposedPayload.literatureId");
    if (!payload.targetId) markMissing(warnings, draftIndex, draftType, "proposedPayload.targetId");
    return payload;
  }
  return {
    reason: payloadText(rawPayload, "reason") ?? "This draft type is deferred in the current AI-D boundary.",
    deferredReason:
      payloadText(rawPayload, "deferredReason") ??
      "AI-D2 can retain this draft locally, but it cannot be written back.",
    sourceRefs
  };
}

function normalizeDraft(
  rawDraft: Record<string, unknown>,
  draftIndex: number,
  options: Required<Pick<AIActionDraftParseOptions, "now">> & AIActionDraftParseOptions,
  batchId: string,
  inheritedSourceRefs: AIActionDraftSourceRef[]
): NormalizedDraft {
  const warnings: AIActionDraftParseWarning[] = [];
  const rawType = stringValue(rawDraft.draftType ?? rawDraft.type ?? rawDraft.actionType);
  if (!rawType) {
    warnings.push(warning("missing_required_field", "Draft is missing draftType.", "error", draftIndex));
    return { warnings };
  }
  if (!isKnownDraftType(rawType)) {
    warnings.push(
      warning(
        "unsupported_draft_type",
        `Draft type ${rawType} is not in the AI-D1 whitelist and was kept out of writable drafts.`,
        "error",
        draftIndex,
        rawType
      )
    );
    return { warnings };
  }

  const capability = capabilityForDraftType(rawType);
  if (capability === "planned") {
    warnings.push(
      warning(
        "writeback_not_enabled",
        `Draft type ${rawType} is planned but not write-back enabled in AI-D2.`,
        "warning",
        draftIndex,
        rawType
      )
    );
  }
  if (capability === "deferred") {
    warnings.push(
      warning(
        "postponed_draft_type",
        `Draft type ${rawType} is deferred and cannot be written in AI-D2.`,
        "warning",
        draftIndex,
        rawType
      )
    );
  }
  if (capability === "prohibited") {
    warnings.push(
      warning(
        "forbidden_draft_type",
        `Draft type ${rawType} is prohibited for automatic execution.`,
        "error",
        draftIndex,
        rawType
      )
    );
  }

  const rawPayload = safeRecord(rawDraft.proposedPayload ?? rawDraft.payload ?? rawDraft.data);
  if (!isRecord(rawDraft.proposedPayload ?? rawDraft.payload ?? rawDraft.data)) {
    warnings.push(
      warning(
        "invalid_payload",
        `Draft ${draftIndex + 1} has no structured proposedPayload; a limited payload was inferred.`,
        "warning",
        draftIndex,
        rawType
      )
    );
  }
  const sourceRefs = normalizeSourceRefs(inheritedSourceRefs, options.sourceRefs, rawDraft.sourceRefs, rawPayload.sourceRefs);
  if (sourceRefs.length === 0) {
    warnings.push(
      warning(
        "source_refs_missing",
        `Draft ${draftIndex + 1} has no sourceRefs; provenance should be reviewed before write-back.`,
        "warning",
        draftIndex,
        rawType
      )
    );
  }

  const target = inferTarget(rawType, rawDraft);
  const title =
    stringValue(rawDraft.title) ??
    payloadText(rawPayload, "title", "taskTitle", "gapTitle", "findingTitle", "candidateTitle") ??
    `${rawType} draft`;
  const proposedPayload = createPayload(rawType, rawPayload, rawDraft, title, sourceRefs, warnings, draftIndex);
  const message =
    capability === "supported"
      ? "Draft parsed locally. Real write-back still requires a later executor and user confirmation."
      : capability === "planned"
        ? "Draft parsed locally. This draft type is planned for a later AI-D stage."
        : capability === "deferred"
          ? "Draft parsed locally as deferred; write-back is not enabled."
          : "Draft parsed locally as prohibited; automatic execution is forbidden.";

  const draft = {
    draftInstanceId: createDraftInstanceId(),
    batchId,
    draftType: rawType,
    capability,
    targetModule: target.module,
    targetEntityType: target.entityType,
    targetEntityId: target.entityId,
    target,
    title,
    summary: stringValue(rawDraft.summary),
    detail: stringValue(rawDraft.detail ?? rawDraft.description),
    sourceRefs,
    proposedPayload,
    handled: false,
    result: {
      reviewStatus: "pending",
      applyStatus: "none",
      message,
      updatedAt: options.now
    },
    createdAt: stringValue(rawDraft.createdAt) ?? options.now,
    updatedAt: stringValue(rawDraft.updatedAt) ?? options.now
  } as AIActionDraft<AIActionDraftType> as AIActionDraftUnion;

  return { draft, warnings };
}

export function createFallbackDraftBatch(
  text: string,
  options: AIActionDraftParseOptions,
  warnings: AIActionDraftParseWarning[] = []
): AIParsedActionDraftBatch {
  assertCompleteActionDraftSourceTuple(options.sourceTuple);
  const now = options.now ?? new Date().toISOString();
  const batchId = options.batchId ?? createBatchId();
  return {
    id: batchId,
    sourceTuple: options.sourceTuple,
    question: options.question,
    drafts: [],
    createdAt: now,
    sourceContextSummary: options.sourceContextSummary,
    sourceRefs: normalizeSourceRefs(options.sourceRefs),
    warnings: warnings.length
      ? warnings
      : [warning("parse_failed", "No structured AI action drafts could be parsed.", "error")],
    parseSucceeded: false,
    rawTextFallback: truncateText(text.trim(), FALLBACK_MAX_CHARS)
  };
}

export function createAIActionDraftBatch(
  rawDrafts: Record<string, unknown>[],
  options: AIActionDraftParseOptions,
  inheritedSourceRefs: AIActionDraftSourceRef[] = []
): AIParsedActionDraftBatch {
  assertCompleteActionDraftSourceTuple(options.sourceTuple);
  const now = options.now ?? new Date().toISOString();
  const batchId = options.batchId ?? createBatchId();
  const normalized = rawDrafts.map((rawDraft, index) =>
    normalizeDraft(rawDraft, index, { ...options, now }, batchId, inheritedSourceRefs)
  );
  const drafts = normalized.map((item) => item.draft).filter((draft): draft is AIActionDraftUnion => Boolean(draft));
  const warnings = normalized.flatMap((item) => item.warnings);
  const sourceRefs = normalizeSourceRefs(options.sourceRefs, inheritedSourceRefs, ...drafts.map((draft) => draft.sourceRefs));
  return {
    id: batchId,
    sourceTuple: options.sourceTuple,
    question: options.question,
    drafts,
    createdAt: now,
    sourceContextSummary: options.sourceContextSummary,
    sourceRefs,
    warnings,
    parseSucceeded: drafts.length > 0
  };
}

export function parseAIActionDraftsFromText(
  text: string,
  options: AIActionDraftParseOptions
): AIParsedActionDraftBatch {
  assertCompleteActionDraftSourceTuple(options.sourceTuple);
  const maxInputChars = options.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS;
  const truncated = text.length > maxInputChars;
  const input = truncated ? text.slice(0, maxInputChars) : text;
  const preWarnings = truncated
    ? [warning("input_truncated", "AI draft response was truncated before parsing.", "warning")]
    : [];
  const blocks = extractAIDraftJsonBlocks(input);
  if (blocks.length === 0) {
    return createFallbackDraftBatch(input, options, [
      ...preWarnings,
      warning("no_drafts_found", "No JSON draft block was found in the AI response.", "error")
    ]);
  }

  const rawDrafts: Record<string, unknown>[] = [];
  const inheritedSourceRefs: AIActionDraftSourceRef[] = [];
  const parseWarnings: AIActionDraftParseWarning[] = [];

  for (const block of blocks) {
    const parsed = parseJsonBlock(block);
    if (parsed === undefined) {
      parseWarnings.push(warning("parse_failed", "A candidate JSON draft block could not be parsed.", "warning"));
      continue;
    }
    const candidate = collectCandidate(parsed);
    rawDrafts.push(...candidate.items);
    inheritedSourceRefs.push(...candidate.sourceRefs);
  }

  if (rawDrafts.length === 0) {
    return createFallbackDraftBatch(input, options, [
      ...preWarnings,
      ...parseWarnings,
      warning("no_drafts_found", "Parsed JSON did not contain action draft objects.", "error")
    ]);
  }

  const batch = createAIActionDraftBatch(rawDrafts, options, inheritedSourceRefs);
  const warnings = [...preWarnings, ...parseWarnings, ...batch.warnings];
  if (batch.drafts.length === 0) {
    return createFallbackDraftBatch(input, options, warnings);
  }
  return {
    ...batch,
    warnings,
    parseSucceeded: true
  };
}
