import type {
  AIParseDraftSourceSnapshot,
  AIStandardResult,
  AIStandardResultAction,
  AIStandardResultEffectReceipt,
  AIStandardResultTarget,
  AIStandardResultValidationIssue
} from "../types/aiStandardResult";
import type { AIContextSourceRef } from "../types/aiContext";
import type { StructuredSummary, StructuredSummaryEntityType } from "../types/outputStructuredSummary";
import type { ResultItem, Finding, OutputCandidate, OutputGap } from "../types/outputConversion";
import type { ResearchOutput } from "../types/output";
import {
  createDefaultStructuredSummary,
  getStructuredSummaryDefinition,
  normalizeStructuredSummary
} from "../types/outputStructuredSummary";
import { canonicalAIStandardResultFingerprint, readAIStandardResultBlockingValidationIssues } from "./aiStandardResultService";
import { outputConversionService } from "./outputConversionService";
import { outputService } from "./outputService";
import { planningService } from "./planningService";

export type AIOutputsModule = StructuredSummaryEntityType;
type OutputEntity = ResultItem | Finding | OutputCandidate | OutputGap | ResearchOutput;
type OutputTarget = Extract<AIStandardResultTarget, { module: AIOutputsModule }>;

const OUTPUT_MODULES = new Set<AIOutputsModule>([
  "resultItem", "finding", "outputCandidate", "outputGap", "researchOutput"
]);
const MAX_TITLE_CHARS = 200;
const MAX_TEXT_CHARS = 4_000;
const MAX_TAGS = 12;
const MAX_TAG_CHARS = 80;

const CONFIG = Object.freeze({
  resultItem: {
    briefField: "summary",
    briefAliases: ["summary"],
    structuredKeys: ["keyPhenomenon", "conditionBrief", "initialJudgement", "conversionValue", "other"]
  },
  finding: {
    briefField: "summary",
    briefAliases: ["summary", "content"],
    structuredKeys: ["supportingEvidence", "noveltyDifference", "reliabilityJudgement", "boundaryOrMissingEvidence", "other"]
  },
  outputCandidate: {
    briefField: "description",
    briefAliases: ["description", "coreClaim"],
    structuredKeys: ["outputType", "innovationContribution", "evidenceSummary", "risksAndGaps", "other"]
  },
  outputGap: {
    briefField: "description",
    briefAliases: ["description", "gapDescription"],
    structuredKeys: ["gapType", "affectedObject", "strengtheningPlan", "completionCriteria", "other"]
  },
  researchOutput: {
    briefField: "description",
    briefAliases: ["description", "summary"],
    structuredKeys: ["outputType", "coreContribution", "sourceChainSummary", "archiveUsage", "other"]
  }
} satisfies Record<AIOutputsModule, {
  briefField: "summary" | "description";
  briefAliases: readonly string[];
  structuredKeys: readonly string[];
}>);

const ENUMS = Object.freeze({
  resultType: new Set(["data", "figure", "table", "metric", "code", "model", "log", "text", "sample", "case", "document", "other"]),
  resultStatus: new Set(["pending_review", "marked", "ignored"]),
  assetQuality: new Set(["high", "medium", "low", "uncertain"]),
  usableFor: new Set(["paper", "patent", "report", "dataset", "software", "presentation", "futureProject", "other"]),
  findingType: new Set(["phenomenon", "comparison", "method", "limitation", "evidence", "hypothesis", "negative_result", "other"]),
  findingStatus: new Set(["pending_confirmation", "confirmed", "needs_evidence", "abandoned"]),
  confidence: new Set(["high", "medium", "low", "uncertain"]),
  findingMaturity: new Set(["high", "medium", "low", "uncertain"]),
  candidateType: new Set(["paper", "patent", "report", "dataset", "software", "method", "model", "caseStudy", "presentation", "futureProject", "other"]),
  candidateStatus: new Set(["pending_evaluation", "needs_gap_resolution", "ready_for_formal", "converted"]),
  candidateMaturity: new Set(["low", "medium", "high"]),
  priority: new Set(["high", "medium", "low"]),
  gapType: new Set(["data", "analysis", "validation", "figure", "theory", "literature", "writing", "experiment", "code", "other"]),
  gapStatus: new Set(["pending", "task_created", "route_feedback_created", "resolved", "abandoned"]),
  outputType: new Set(["figure", "table", "dataset", "result", "note", "report", "paper_draft", "presentation", "code", "other"]),
  outputStatus: new Set(["draft", "organizing", "archived"])
});

export type AIOutputsStandardResultValidation = {
  executable: boolean;
  normalizedPayload: Record<string, unknown>;
  validationIssues: AIStandardResultValidationIssue[];
  targetSnapshotFingerprint?: string;
  resolvedTarget?: OutputTarget;
};

export type AIOutputsStandardResultDependencies = {
  getProjectById: typeof planningService.getProjectById;
  getResultItemById: typeof outputConversionService.getResultItemById;
  getFindingById: typeof outputConversionService.getFindingById;
  getOutputCandidateById: typeof outputConversionService.getOutputCandidateById;
  getOutputGapById: typeof outputConversionService.getOutputGapById;
  getResearchOutputById: typeof outputService.getById;
  listResearchOutputs: typeof outputService.list;
  createResultItem: typeof outputConversionService.createResultItem;
  updateResultItem: typeof outputConversionService.updateResultItem;
  createFinding: typeof outputConversionService.createFinding;
  updateFinding: typeof outputConversionService.updateFinding;
  createOutputCandidate: typeof outputConversionService.createOutputCandidate;
  updateOutputCandidate: typeof outputConversionService.updateOutputCandidate;
  createOutputGapForDeposition: typeof outputConversionService.createOutputGapForDeposition;
  updateOutputGap: typeof outputConversionService.updateOutputGap;
  createResearchOutput: typeof outputService.create;
  updateResearchOutput: typeof outputService.update;
};

const DEFAULT_DEPENDENCIES: AIOutputsStandardResultDependencies = {
  getProjectById: planningService.getProjectById,
  getResultItemById: outputConversionService.getResultItemById,
  getFindingById: outputConversionService.getFindingById,
  getOutputCandidateById: outputConversionService.getOutputCandidateById,
  getOutputGapById: outputConversionService.getOutputGapById,
  getResearchOutputById: outputService.getById,
  listResearchOutputs: outputService.list,
  createResultItem: outputConversionService.createResultItem,
  updateResultItem: outputConversionService.updateResultItem,
  createFinding: outputConversionService.createFinding,
  updateFinding: outputConversionService.updateFinding,
  createOutputCandidate: outputConversionService.createOutputCandidate,
  updateOutputCandidate: outputConversionService.updateOutputCandidate,
  createOutputGapForDeposition: outputConversionService.createOutputGapForDeposition,
  updateOutputGap: outputConversionService.updateOutputGap,
  createResearchOutput: outputService.create,
  updateResearchOutput: outputService.update
};

function issue(code: string, message: string, field?: string): AIStandardResultValidationIssue {
  return { code, message, ...(field ? { field } : {}) };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function characters(value: string) {
  return Array.from(value).length;
}

function requiredTitle(value: unknown, issues: AIStandardResultValidationIssue[]) {
  if (
    typeof value !== "string" || !value.trim() || value.includes("\0") ||
    characters(value.trim()) > MAX_TITLE_CHARS
  ) {
    issues.push(issue("OUTPUT_P0_TITLE_INVALID", `title must contain 1-${MAX_TITLE_CHARS} safe characters.`, "title"));
    return undefined;
  }
  return value.trim();
}

function optionalText(
  value: unknown,
  field: string,
  tier: "P1" | "P2",
  issues: AIStandardResultValidationIssue[]
) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number" || typeof value === "boolean") value = String(value);
  if (
    typeof value !== "string" || value.includes("\0") ||
    characters(value.trim()) > MAX_TEXT_CHARS
  ) {
    issues.push(issue(
      tier === "P1" ? "P1_MAJOR_UNREADABLE_NONBLOCKING" : "P2_UNREADABLE_NONBLOCKING",
      `${field} was omitted because it is not bounded safe text.`,
      field
    ));
    return undefined;
  }
  return value.trim() || undefined;
}

function optionalEnum(
  value: unknown,
  field: string,
  values: ReadonlySet<string>,
  issues: AIStandardResultValidationIssue[]
) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !values.has(value)) {
    issues.push(issue("P2_UNREADABLE_NONBLOCKING", `${field} is unsupported and was omitted.`, field));
    return undefined;
  }
  return value;
}

function optionalBoolean(value: unknown, field: string, issues: AIStandardResultValidationIssue[]) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    issues.push(issue("P2_UNREADABLE_NONBLOCKING", `${field} is not boolean and was omitted.`, field));
    return undefined;
  }
  return value;
}

function tags(value: unknown, issues: AIStandardResultValidationIssue[]) {
  if (value === undefined || value === null) return undefined;
  if (
    !Array.isArray(value) || value.length > MAX_TAGS ||
    value.some((item) => typeof item !== "string" || !item.trim() || item.includes("\0") || characters(item.trim()) > MAX_TAG_CHARS)
  ) {
    issues.push(issue("P2_UNREADABLE_NONBLOCKING", "tags were omitted because they are not a bounded string list.", "tags"));
    return undefined;
  }
  return [...new Set(value.map((item) => (item as string).trim()))];
}

function currentTitle(module: AIOutputsModule, entity: OutputEntity) {
  return module === "researchOutput"
    ? (entity as ResearchOutput).outputName
    : (entity as ResultItem | Finding | OutputCandidate | OutputGap).title;
}

function currentBrief(module: AIOutputsModule, entity: OutputEntity) {
  if (module === "resultItem") return (entity as ResultItem).summary ?? "";
  if (module === "finding") return (entity as Finding).summary ?? "";
  if (module === "researchOutput") return (entity as ResearchOutput).description ?? "";
  return (entity as OutputCandidate | OutputGap).description ?? "";
}

function currentStructured(entity: OutputEntity): StructuredSummary {
  return entity.structuredSummary ?? [];
}

function parseStructuredValues(
  module: AIOutputsModule,
  payload: Record<string, unknown>,
  issues: AIStandardResultValidationIssue[]
) {
  const config = CONFIG[module];
  const topLevelP2Conflict = module === "outputGap"
    ? "gapType"
    : module === "researchOutput"
      ? "outputType"
      : undefined;
  const values = new Map<string, string>();
  const raw = payload.structuredSummary;
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const record = asRecord(item);
      if (!record || typeof record.key !== "string" || !config.structuredKeys.includes(record.key)) continue;
      const text = optionalText(record.value, `structuredSummary.${record.key}`, "P1", issues);
      if (text !== undefined) values.set(record.key, text);
    }
  } else if (raw !== undefined) {
    const record = asRecord(raw);
    if (!record) {
      issues.push(issue("P1_MAJOR_UNREADABLE_NONBLOCKING", "structuredSummary was omitted because it is not an object.", "structuredSummary"));
    } else {
      for (const key of config.structuredKeys) {
        if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
        const text = optionalText(record[key], `structuredSummary.${key}`, "P1", issues);
        if (text !== undefined) values.set(key, text);
      }
    }
  }
  for (const key of config.structuredKeys) {
    // OutputGap.gapType and ResearchOutput.outputType are existing P2 enums at
    // the entity top level. Their richer P1 text is accepted only inside the
    // exact structuredSummary namespace so one tier cannot overwrite another.
    if (key === topLevelP2Conflict) continue;
    if (!Object.prototype.hasOwnProperty.call(payload, key)) continue;
    const text = optionalText(payload[key], key, "P1", issues);
    if (text !== undefined) values.set(key, text);
  }
  return values;
}

function normalizedStructuredSummary(
  module: AIOutputsModule,
  values: Map<string, string>,
  existing?: OutputEntity
) {
  if (values.size === 0 && !existing) return undefined;
  const base = new Map((existing ? currentStructured(existing) : createDefaultStructuredSummary(module))
    .map((section) => [section.key, section.value]));
  for (const [key, value] of values) base.set(key, value);
  const input = getStructuredSummaryDefinition(module).sections.map((definition) => ({
    ...definition,
    value: base.get(definition.key) ?? ""
  }));
  return normalizeStructuredSummary(module, input);
}

function allowedPayloadKeys(module: AIOutputsModule) {
  const common = ["title", "name", "outputName", "structuredSummary", ...CONFIG[module].briefAliases, ...CONFIG[module].structuredKeys];
  const p2 = module === "resultItem"
    ? ["resultType", "status", "value", "unit", "isAsset", "assetReason", "assetQuality", "usableFor", "tags"]
    : module === "finding"
      ? ["findingType", "status", "confidence", "maturity", "tags"]
      : module === "outputCandidate"
        ? ["candidateType", "status", "maturity", "priority", "tags"]
        : module === "outputGap"
          ? ["gapType", "status", "priority"]
          : ["outputType", "status", "usableForPaper"];
  return new Set([...common, ...p2]);
}

function normalizePayload(
  module: AIOutputsModule,
  action: "CREATE" | "UPDATE",
  raw: unknown,
  existing: OutputEntity | undefined,
  issues: AIStandardResultValidationIssue[]
) {
  const payload = asRecord(raw);
  if (!payload) {
    issues.push(issue("OUTPUT_PAYLOAD_INVALID", "The Outputs payload must be one JSON object."));
    return {};
  }
  const normalized: Record<string, unknown> = {};
  const hasTitle = ["title", "name", "outputName"].some((key) => Object.prototype.hasOwnProperty.call(payload, key));
  if (action === "CREATE" || hasTitle) {
    const title = requiredTitle(payload.title ?? payload.name ?? payload.outputName, issues);
    if (title) normalized.title = title;
  }
  const config = CONFIG[module];
  const briefKey = config.briefAliases.find((key) => Object.prototype.hasOwnProperty.call(payload, key));
  if (briefKey) {
    const brief = optionalText(payload[briefKey], briefKey, "P1", issues);
    if (brief !== undefined) normalized[config.briefField] = brief;
  }
  const structuredValues = parseStructuredValues(module, payload, issues);
  const unknownSafeText: string[] = [];
  const allowed = allowedPayloadKeys(module);
  for (const [key, value] of Object.entries(payload)) {
    if (allowed.has(key)) continue;
    const text = optionalText(value, key, "P2", issues);
    if (text) unknownSafeText.push(`${key}: ${text}`);
  }
  if (unknownSafeText.length > 0) {
    const previous = structuredValues.get("other") ?? "";
    structuredValues.set("other", [previous, ...unknownSafeText].filter(Boolean).join("\n"));
  }
  const structuredSummary = normalizedStructuredSummary(module, structuredValues, action === "UPDATE" ? existing : undefined);
  if (structuredValues.size > 0 && structuredSummary) normalized.structuredSummary = structuredSummary;

  const setEnum = (field: string, set: ReadonlySet<string>) => {
    const value = optionalEnum(payload[field], field, set, issues);
    if (value !== undefined) normalized[field] = value;
  };
  const setText = (field: string) => {
    const value = optionalText(payload[field], field, "P2", issues);
    if (value !== undefined) normalized[field] = value;
  };
  const setBoolean = (field: string) => {
    const value = optionalBoolean(payload[field], field, issues);
    if (value !== undefined) normalized[field] = value;
  };

  if (module === "resultItem") {
    setEnum("resultType", ENUMS.resultType);
    setEnum("status", ENUMS.resultStatus);
    setText("unit"); setText("assetReason"); setEnum("assetQuality", ENUMS.assetQuality);
    setBoolean("isAsset");
    if (payload.value !== undefined && (typeof payload.value === "string" || typeof payload.value === "number" || typeof payload.value === "boolean")) {
      normalized.value = payload.value;
    } else if (payload.value !== undefined) {
      issues.push(issue("P2_UNREADABLE_NONBLOCKING", "value was omitted because it is not a safe scalar.", "value"));
    }
    if (payload.usableFor !== undefined) {
      if (Array.isArray(payload.usableFor) && payload.usableFor.every((value) => typeof value === "string" && ENUMS.usableFor.has(value))) {
        normalized.usableFor = [...new Set(payload.usableFor)];
      } else issues.push(issue("P2_UNREADABLE_NONBLOCKING", "usableFor was omitted because it contains unsupported values.", "usableFor"));
    }
    const normalizedTags = tags(payload.tags, issues);
    if (normalizedTags) normalized.tags = normalizedTags;
    if (action === "CREATE") {
      normalized.resultType ??= "other";
      normalized.status ??= "pending_review";
      normalized.isAsset ??= false;
      normalized.tags ??= [];
    }
  } else if (module === "finding") {
    setEnum("findingType", ENUMS.findingType); setEnum("status", ENUMS.findingStatus);
    setEnum("confidence", ENUMS.confidence); setEnum("maturity", ENUMS.findingMaturity);
    const normalizedTags = tags(payload.tags, issues); if (normalizedTags) normalized.tags = normalizedTags;
    if (action === "CREATE") { normalized.status ??= "pending_confirmation"; normalized.tags ??= []; }
  } else if (module === "outputCandidate") {
    setEnum("candidateType", ENUMS.candidateType); setEnum("status", ENUMS.candidateStatus);
    setEnum("maturity", ENUMS.candidateMaturity); setEnum("priority", ENUMS.priority);
    const normalizedTags = tags(payload.tags, issues); if (normalizedTags) normalized.tags = normalizedTags;
    if (action === "CREATE") { normalized.candidateType ??= "other"; normalized.status ??= "pending_evaluation"; normalized.tags ??= []; }
  } else if (module === "outputGap") {
    setEnum("gapType", ENUMS.gapType); setEnum("status", ENUMS.gapStatus); setEnum("priority", ENUMS.priority);
    if (action === "CREATE") { normalized.gapType ??= "other"; normalized.status ??= "pending"; }
  } else {
    setEnum("outputType", ENUMS.outputType); setEnum("status", ENUMS.outputStatus); setBoolean("usableForPaper");
    if (action === "CREATE") { normalized.outputType ??= "other"; normalized.status ??= "draft"; normalized.usableForPaper ??= false; }
  }
  if (action === "UPDATE" && Object.keys(normalized).length === 0) {
    issues.push(issue("OUTPUT_UPDATE_EMPTY", "UPDATE requires at least one recognized changed field."));
  }
  return normalized;
}

async function readEntity(
  module: AIOutputsModule,
  id: string,
  dependencies: AIOutputsStandardResultDependencies
): Promise<OutputEntity | undefined> {
  if (module === "resultItem") return dependencies.getResultItemById(id);
  if (module === "finding") return dependencies.getFindingById(id);
  if (module === "outputCandidate") return dependencies.getOutputCandidateById(id);
  if (module === "outputGap") return dependencies.getOutputGapById(id);
  return dependencies.getResearchOutputById(id);
}

function frozenPrimaryOutputTargetIds(
  sourceRefs: readonly AIContextSourceRef[],
  module: AIOutputsModule
): string[] {
  const sourceModule = module === "researchOutput" ? "output" : "outputConversion";
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const sourceRef of sourceRefs) {
    if (
      sourceRef.contextDisposition !== "included" ||
      sourceRef.contextRole !== "primary" ||
      sourceRef.module !== sourceModule ||
      sourceRef.entityType !== module ||
      sourceRef.isVerified !== true ||
      !sourceRef.entityId.trim() ||
      seen.has(sourceRef.entityId)
    ) {
      continue;
    }
    seen.add(sourceRef.entityId);
    ids.push(sourceRef.entityId);
  }
  return ids;
}

export function isAIOutputsModule(value: unknown): value is AIOutputsModule {
  return typeof value === "string" && OUTPUT_MODULES.has(value as AIOutputsModule);
}

export async function validateAIOutputsStandardResultProposal(
  input: {
    action: AIStandardResultAction;
    target: AIStandardResultTarget;
    source?: AIParseDraftSourceSnapshot;
    frozenContextSourceRefs?: readonly AIContextSourceRef[];
    payload: unknown;
    expectedProjectId: string;
    expectedTargetSnapshotFingerprint?: string;
  },
  dependencies: AIOutputsStandardResultDependencies = DEFAULT_DEPENDENCIES
): Promise<AIOutputsStandardResultValidation> {
  const issues: AIStandardResultValidationIssue[] = [];
  if (!isAIOutputsModule(input.target.module) || input.target.entityType !== input.target.module) {
    return { executable: false, normalizedPayload: {}, validationIssues: [issue("OUTPUT_TARGET_INVALID", "An exact Outputs target is required.")] };
  }
  const module = input.target.module;
  const target = input.target as OutputTarget;
  if (target.projectId !== input.expectedProjectId || !input.source || input.source.projectId !== input.expectedProjectId) {
    issues.push(issue("OUTPUT_SCOPE_MISMATCH", "The Outputs target must remain in the frozen Parse Project.", "target.projectId"));
  }
  const project = await dependencies.getProjectById(input.expectedProjectId);
  if (!project || project.deletedAt || project.status === "archived") {
    issues.push(issue("OUTPUT_PROJECT_UNAVAILABLE", "The reviewed Project is unavailable."));
  }
  const frozenTargetIds = input.action === "CREATE" || input.frozenContextSourceRefs === undefined
    ? undefined
    : frozenPrimaryOutputTargetIds(input.frozenContextSourceRefs, module);
  let canonicalTargetId = target.entityId;
  if (frozenTargetIds !== undefined) {
    if (frozenTargetIds.length === 0) {
      issues.push(issue(
        "OUTPUT_FROZEN_TARGET_REQUIRED",
        "An existing Outputs operation requires one exact frozen primary target.",
        "target.entityId"
      ));
      canonicalTargetId = undefined;
    } else if (frozenTargetIds.length > 1) {
      issues.push(issue(
        "OUTPUT_FROZEN_TARGET_AMBIGUOUS",
        "The frozen primary Outputs scope contains more than one target of this operation type.",
        "target.entityId"
      ));
      canonicalTargetId = undefined;
    } else {
      canonicalTargetId = frozenTargetIds[0];
      if (target.entityId !== canonicalTargetId) {
        issues.push(issue(
          "OUTPUT_TARGET_OUTSIDE_FROZEN_SCOPE",
          "The proposed Outputs target does not match the exact frozen primary target.",
          "target.entityId"
        ));
      }
    }
  }
  let existing: OutputEntity | undefined;
  if (input.action !== "CREATE") {
    existing = canonicalTargetId ? await readEntity(module, canonicalTargetId, dependencies) : undefined;
    if (!existing || existing.deletedAt) issues.push(issue("OUTPUT_TARGET_UNAVAILABLE", "The exact Outputs target is missing or deleted."));
    else if (existing.projectId !== input.expectedProjectId) issues.push(issue("OUTPUT_SCOPE_MISMATCH", "The Outputs target crosses Project scope."));
  }
  const targetSnapshotFingerprint = existing
    ? canonicalAIStandardResultFingerprint({
        module,
        id: existing.id,
        projectId: existing.projectId,
        title: currentTitle(module, existing),
        updatedAt: existing.updatedAt,
        deletedAt: existing.deletedAt ?? null
      })
    : undefined;
  if (input.expectedTargetSnapshotFingerprint && input.expectedTargetSnapshotFingerprint !== targetSnapshotFingerprint) {
    issues.push(issue("OUTPUT_TARGET_STALE", "The canonical Outputs target changed after Parse Draft."));
  }
  const resolvedTarget: OutputTarget | undefined = input.action === "CREATE"
    ? {
        module,
        projectId: input.expectedProjectId,
        entityType: module
      } as OutputTarget
    : canonicalTargetId
      ? {
          module,
          projectId: input.expectedProjectId,
          entityType: module,
          entityId: canonicalTargetId
        } as OutputTarget
      : undefined;
  if (input.action === "DELETE_SUGGESTION") {
    const payload = asRecord(input.payload);
    const reason = optionalText(payload?.reason, "reason", "P1", issues);
    if (!reason) issues.push(issue("OUTPUT_DELETE_REASON_REQUIRED", "DELETE suggestion requires a user-readable reason.", "reason"));
    return {
      executable: false,
      normalizedPayload: reason ? { reason } : {},
      validationIssues: readAIStandardResultBlockingValidationIssues(issues).length > 0
        ? issues
        : [...issues, issue("DELETE_SUGGESTION_INFORMATIONAL_ONLY", "DELETE_SUGGESTION has no AI executor; use the business item deletion flow.")],
      ...(targetSnapshotFingerprint ? { targetSnapshotFingerprint } : {}),
      ...(resolvedTarget ? { resolvedTarget } : {})
    };
  }
  if (input.action !== "CREATE" && input.action !== "UPDATE") {
    return { executable: false, normalizedPayload: {}, validationIssues: [...issues, issue("OUTPUT_ACTION_UNSUPPORTED", "The Outputs business adapter supports CREATE, UPDATE and advisory DELETE only.")] };
  }
  const normalizedPayload = normalizePayload(module, input.action, input.payload, existing, issues);
  return {
    executable: readAIStandardResultBlockingValidationIssues(issues).length === 0,
    normalizedPayload,
    validationIssues: issues,
    ...(targetSnapshotFingerprint ? { targetSnapshotFingerprint } : {}),
    ...(resolvedTarget ? { resolvedTarget } : {})
  };
}

export class AIOutputsEffectUnknownError extends Error {
  readonly effectMayExist = true;
  constructor(message: string) { super(message); this.name = "AIOutputsEffectUnknownError"; }
}

export class AIOutputsEffectNoEffectError extends Error {
  readonly effectProvenAbsent = true;
  constructor(readonly code: string, message: string) { super(message); this.name = "AIOutputsEffectNoEffectError"; }
}

async function writeEntity(
  module: AIOutputsModule,
  action: "CREATE" | "UPDATE",
  result: AIStandardResult,
  payload: Record<string, unknown>,
  dependencies: AIOutputsStandardResultDependencies
): Promise<OutputEntity | undefined> {
  const projectId = result.target.projectId;
  const title = payload.title as string | undefined;
  const structuredSummary = payload.structuredSummary as StructuredSummary | undefined;
  if (module === "resultItem") {
    return action === "CREATE"
      ? dependencies.createResultItem({
          projectId, sourceType: "manual", sourceId: `manual:ai-standard-result:${result.id}`,
          title: title as string, resultType: payload.resultType as ResultItem["resultType"],
          status: payload.status as ResultItem["status"], summary: payload.summary as string | undefined,
          value: payload.value as ResultItem["value"], unit: payload.unit as string | undefined,
          isAsset: payload.isAsset as boolean, assetReason: payload.assetReason as string | undefined,
          assetQuality: payload.assetQuality as ResultItem["assetQuality"],
          usableFor: payload.usableFor as ResultItem["usableFor"], tags: payload.tags as string[],
          structuredSummary
        })
      : dependencies.updateResultItem(result.target.entityId as string, payload);
  }
  if (module === "finding") {
    return action === "CREATE"
      ? dependencies.createFinding({
          projectId, title: title as string, summary: payload.summary as string ?? "",
          status: payload.status as Finding["status"], findingType: payload.findingType as Finding["findingType"],
          confidence: payload.confidence as Finding["confidence"], maturity: payload.maturity as Finding["maturity"],
          tags: payload.tags as string[], structuredSummary
        })
      : dependencies.updateFinding(result.target.entityId as string, payload);
  }
  if (module === "outputCandidate") {
    return action === "CREATE"
      ? dependencies.createOutputCandidate({
          projectId, title: title as string, description: payload.description as string | undefined,
          candidateType: payload.candidateType as OutputCandidate["candidateType"], status: payload.status as OutputCandidate["status"],
          maturity: payload.maturity as OutputCandidate["maturity"], priority: payload.priority as OutputCandidate["priority"],
          tags: payload.tags as string[], structuredSummary
        })
      : dependencies.updateOutputCandidate(result.target.entityId as string, payload);
  }
  if (module === "outputGap") {
    return action === "CREATE"
      ? dependencies.createOutputGapForDeposition({
          projectId, confirmedByUser: true, title: title as string,
          description: payload.description as string | undefined, gapType: payload.gapType as OutputGap["gapType"],
          status: payload.status as OutputGap["status"], priority: payload.priority as OutputGap["priority"], structuredSummary
        })
      : dependencies.updateOutputGap(result.target.entityId as string, payload);
  }
  if (action === "CREATE") {
    return dependencies.createResearchOutput({
      projectId, outputName: title as string, description: payload.description as string ?? "",
      outputType: payload.outputType as ResearchOutput["outputType"], status: payload.status as ResearchOutput["status"],
      usableForPaper: payload.usableForPaper as boolean, structuredSummary,
      provenance: { sourceType: "manual", confirmedByUser: true, note: `AI Standard Result ${result.id}` }
    });
  }
  const { title: updatedTitle, ...patch } = payload;
  return dependencies.updateResearchOutput(result.target.entityId as string, {
    ...patch,
    ...(updatedTitle ? { outputName: updatedTitle as string } : {})
  });
}

function canonicalReadback(module: AIOutputsModule, entity: OutputEntity, result: AIStandardResult) {
  return {
    id: entity.id,
    projectId: entity.projectId,
    title: currentTitle(module, entity),
    brief: currentBrief(module, entity),
    structuredSummary: currentStructured(entity),
    updatedAt: entity.updatedAt,
    resultId: result.id,
    authorizationId: result.authorizationId,
    confirmedPayloadFingerprint: result.confirmedPayloadFingerprint
  };
}

function matchesConfirmedOutputReadback(
  module: AIOutputsModule,
  entity: OutputEntity,
  normalizedPayload: Record<string, unknown>
) {
  const config = CONFIG[module];
  return !(
    normalizedPayload.title !== undefined && currentTitle(module, entity) !== normalizedPayload.title ||
    normalizedPayload[config.briefField] !== undefined &&
      currentBrief(module, entity) !== normalizedPayload[config.briefField] ||
    normalizedPayload.structuredSummary !== undefined &&
      JSON.stringify(currentStructured(entity)) !== JSON.stringify(normalizedPayload.structuredSummary)
  );
}

function serviceName(module: AIOutputsModule, action: "CREATE" | "UPDATE") {
  if (module === "resultItem") return action === "CREATE" ? "outputConversionService.createResultItem" : "outputConversionService.updateResultItem";
  if (module === "finding") return action === "CREATE" ? "outputConversionService.createFinding" : "outputConversionService.updateFinding";
  if (module === "outputCandidate") return action === "CREATE" ? "outputConversionService.createOutputCandidate" : "outputConversionService.updateOutputCandidate";
  if (module === "outputGap") return action === "CREATE" ? "outputConversionService.createOutputGapForDeposition" : "outputConversionService.updateOutputGap";
  return action === "CREATE" ? "outputService.create" : "outputService.update";
}

export async function invokeAIOutputsStandardResultEffect(
  input: { result: AIStandardResult; normalizedPayload: Record<string, unknown> },
  dependencies: AIOutputsStandardResultDependencies = DEFAULT_DEPENDENCIES
): Promise<AIStandardResultEffectReceipt> {
  const { result } = input;
  if (
    result.category !== "DATA_OPERATION" ||
    (result.action !== "CREATE" && result.action !== "UPDATE") ||
    !isAIOutputsModule(result.target.module) || result.target.entityType !== result.target.module
  ) {
    throw new AIOutputsEffectNoEffectError("OUTPUT_EFFECT_UNSUPPORTED", "Only confirmed Outputs CREATE/UPDATE can reach this formal effect.");
  }
  if (!result.confirmationStartedAt || !result.authorizationId || !result.confirmedPayload || !result.confirmedPayloadFingerprint) {
    throw new AIOutputsEffectNoEffectError("OUTPUT_CONFIRMATION_REQUIRED", "Durable explicit confirmation is required before an Outputs write.");
  }
  const validation = await validateAIOutputsStandardResultProposal({
    action: result.action,
    target: result.target,
    source: result.source,
    payload: input.normalizedPayload,
    expectedProjectId: result.source.projectId,
    expectedTargetSnapshotFingerprint: result.targetSnapshotFingerprint
  }, dependencies);
  if (!validation.executable || readAIStandardResultBlockingValidationIssues(validation.validationIssues).length > 0) {
    throw new AIOutputsEffectNoEffectError("OUTPUT_EFFECT_VALIDATION_FAILED", validation.validationIssues.map((item) => item.message).join(" "));
  }
  let crossedBoundary = false;
  try {
    crossedBoundary = true;
    const written = await writeEntity(result.target.module, result.action, result, validation.normalizedPayload, dependencies);
    if (!written) throw new Error("The canonical service returned no business entity.");
    const readback = await readEntity(result.target.module, written.id, dependencies);
    if (!readback || readback.projectId !== result.target.projectId) throw new Error("Canonical Outputs readback is unavailable or out of scope.");
    if (
      (result.action === "CREATE" && currentTitle(result.target.module, readback) !== validation.normalizedPayload.title) ||
      !matchesConfirmedOutputReadback(result.target.module, readback, validation.normalizedPayload)
    ) {
      throw new Error("Canonical Outputs readback does not match the confirmed P0/P1 payload.");
    }
    return {
      module: result.target.module,
      entityType: result.target.module,
      entityId: readback.id,
      operation: result.action,
      service: serviceName(result.target.module, result.action),
      canonicalReadback: canonicalReadback(result.target.module, readback, result)
    } as AIStandardResultEffectReceipt;
  } catch (error) {
    if (!crossedBoundary) {
      throw new AIOutputsEffectNoEffectError("OUTPUT_EFFECT_NOT_STARTED", "The Outputs write did not start.");
    }
    throw new AIOutputsEffectUnknownError(
      `The Outputs ${result.action} crossed the canonical business-effect boundary; automatic retry is disabled. ${error instanceof Error ? error.message : "Authoritative outcome is unknown."}`
    );
  }
}

/** Read-only same-operation receipt reconstruction; it never dispatches an Outputs write. */
export async function readAIOutputsStandardResultEffect(
  input: { result: AIStandardResult; normalizedPayload: Record<string, unknown> },
  dependencies: AIOutputsStandardResultDependencies = DEFAULT_DEPENDENCIES
): Promise<AIStandardResultEffectReceipt | undefined> {
  const { result } = input;
  if (
    result.category !== "DATA_OPERATION" ||
    (result.action !== "CREATE" && result.action !== "UPDATE") ||
    !isAIOutputsModule(result.target.module) || result.target.entityType !== result.target.module ||
    !result.confirmationStartedAt || !result.authorizationId ||
    !result.confirmedPayload || !result.confirmedPayloadFingerprint
  ) return undefined;
  const validation = await validateAIOutputsStandardResultProposal({
    action: result.action,
    target: result.target,
    source: result.source,
    payload: input.normalizedPayload,
    expectedProjectId: result.source.projectId,
    expectedTargetSnapshotFingerprint: undefined
  }, dependencies);
  if (!validation.executable || readAIStandardResultBlockingValidationIssues(validation.validationIssues).length > 0) {
    return undefined;
  }
  let entity: OutputEntity | undefined;
  if (result.action === "UPDATE" && result.target.entityId) {
    entity = await readEntity(result.target.module, result.target.entityId, dependencies);
  } else if (result.action === "CREATE" && result.target.module === "researchOutput") {
    const matches = (await dependencies.listResearchOutputs()).filter((candidate) =>
      candidate.projectId === result.target.projectId &&
      candidate.provenance?.note === `AI Standard Result ${result.id}`
    );
    entity = matches.length === 1 ? matches[0] : undefined;
  }
  if (
    !entity || entity.projectId !== result.target.projectId ||
    !matchesConfirmedOutputReadback(result.target.module, entity, validation.normalizedPayload)
  ) return undefined;
  return {
    module: result.target.module,
    entityType: result.target.module,
    entityId: entity.id,
    operation: result.action,
    service: serviceName(result.target.module, result.action),
    canonicalReadback: canonicalReadback(result.target.module, entity, result)
  } as AIStandardResultEffectReceipt;
}
