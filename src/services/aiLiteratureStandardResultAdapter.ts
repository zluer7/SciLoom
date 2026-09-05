import type {
  AIParseDraftSourceSnapshot,
  AIStandardResult,
  AIStandardResultAction,
  AIStandardResultEffectReceipt,
  AIStandardResultTarget,
  AIStandardResultValidationIssue
} from "../types/aiStandardResult";
import type {
  Literature,
  LiteratureAuthor,
  LiteratureImportance,
  LiteratureReadingStatus,
  LiteratureType
} from "../types/literature";
import {
  LiteratureOperationConflictError,
  literatureService,
  type CreateLiteratureWithOperationInput,
  type LiteratureStandardResultOperationInput,
  type UpdateLiteratureWithOperationInput
} from "./literatureService";
import {
  getLiteratureCustomStringField,
  LITERATURE_CUSTOM_FIELD_KEYS,
  mergeLiteratureCustomFields,
  type LiteratureCustomFieldPatch
} from "./literatureFieldMappingService";
import { getProjectById } from "./planningService";
import {
  canonicalAIStandardResultFingerprint,
  readAIStandardResultBlockingValidationIssues
} from "./aiStandardResultService";

export const AI_LITERATURE_TITLE_MAX_CHARS = 300;
export const AI_LITERATURE_TEXT_MAX_CHARS = 4_000;
export const AI_LITERATURE_SHORT_TEXT_MAX_CHARS = 500;
export const AI_LITERATURE_AUTHOR_MAX = 32;
export const AI_LITERATURE_AUTHOR_MAX_CHARS = 200;
export const AI_LITERATURE_LIST_MAX = 32;
export const AI_LITERATURE_LIST_ITEM_MAX_CHARS = 160;

const PUBLICATION_TYPES = new Set<LiteratureType>([
  "journal_article", "conference_paper", "review", "book", "book_chapter",
  "thesis", "patent", "standard", "technical_report", "preprint", "dataset",
  "software", "webpage", "other"
]);
const READING_STATUSES = new Set<LiteratureReadingStatus>([
  "unread", "skimmed", "reading", "intensive_read", "summarized", "reused",
  "discarded", "archived"
]);
const IMPORTANCE_VALUES = new Set<LiteratureImportance>([
  "core", "important", "useful", "background", "low", "uncertain"
]);
const EDITABLE_FIELDS = new Set([
  "title", "authors", "year", "venue", "publicationType", "abstract", "keywords",
  "doi", "readingStatus", "importance", "tags", "literature_outline", "dedicated_notes"
]);
const LITERATURE_OUTLINE_STRUCTURED_FIELDS = new Set([
  "summary", "research_problem", "application_object", "method_overview",
  "main_conclusion", "limitations", "other"
]);
const DEDICATED_NOTES_STRUCTURED_FIELDS = new Set([
  "summary", "project_relevance", "related_objects", "reusable_methods",
  "comparable_conclusions", "other"
]);
const STRUCTURAL_CODES = new Set([
  "LITERATURE_SOURCE_SCOPE_REQUIRED",
  "LITERATURE_SOURCE_SCOPE_MISMATCH",
  "LITERATURE_SOURCE_UNAVAILABLE",
  "LITERATURE_SOURCE_ASSOCIATION_MISMATCH",
  "LITERATURE_PROJECT_UNAVAILABLE",
  "LITERATURE_TARGET_OUTSIDE_FROZEN_SCOPE",
  "LITERATURE_TARGET_UNAVAILABLE",
  "LITERATURE_TARGET_LIFECYCLE_UNSUPPORTED",
  "LITERATURE_TARGET_ASSOCIATION_STALE",
  "LITERATURE_TARGET_STALE"
]);

type LiteratureTarget = Extract<AIStandardResultTarget, { module: "literature" }>;
type LiteratureServices = Pick<
  typeof literatureService,
  | "createLiteratureWithOperation"
  | "updateLiteratureWithExpectedUpdatedAtAndOperation"
  | "getLiteratureById"
  | "getLiteratureByStandardResultOperation"
>;

export type AILiteratureStandardResultDependencies = {
  literature: LiteratureServices;
  getProject: typeof getProjectById;
};

const defaultDependencies: AILiteratureStandardResultDependencies = {
  literature: literatureService,
  getProject: getProjectById
};

export type AILiteratureStandardResultValidation = {
  executable: boolean;
  normalizedPayload: Record<string, unknown>;
  validationIssues: AIStandardResultValidationIssue[];
  targetSnapshotFingerprint?: string;
  resolvedTarget?: LiteratureTarget;
};

export class AILiteratureEffectUnknownError extends Error {
  readonly effectMayExist = true;
  constructor(message: string, readonly causeValue?: unknown) {
    super(message);
    this.name = "AILiteratureEffectUnknownError";
  }
}

export class AILiteratureEffectNoEffectError extends Error {
  readonly effectProvenAbsent = true;
  constructor(readonly code: string, message: string, readonly causeValue?: unknown) {
    super(message);
    this.name = "AILiteratureEffectNoEffectError";
  }
}

function issue(code: string, message: string, field?: string): AIStandardResultValidationIssue {
  return { code, message, ...(field ? { field } : {}) };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function boundedRequiredText(
  value: unknown,
  field: string,
  maxChars: number,
  issues: AIStandardResultValidationIssue[]
): string | undefined {
  if (
    typeof value !== "string" || !value.trim() || value.includes("\0") ||
    Array.from(value.trim()).length > maxChars
  ) {
    issues.push(issue("LITERATURE_FIELD_INVALID", `${field} must contain 1-${maxChars} characters.`, field));
    return undefined;
  }
  return value.trim();
}

function boundedOptionalText(
  value: unknown,
  field: string,
  maxChars: number,
  issues: AIStandardResultValidationIssue[]
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  return boundedRequiredText(value, field, maxChars, issues);
}

function normalizeAuthors(
  value: unknown,
  issues: AIStandardResultValidationIssue[]
): Array<{ name: string }> | undefined {
  if (!Array.isArray(value) || value.length > AI_LITERATURE_AUTHOR_MAX) {
    issues.push(issue(
      "LITERATURE_AUTHORS_INVALID",
      `authors must be an array of at most ${AI_LITERATURE_AUTHOR_MAX} exact name objects.`,
      "authors"
    ));
    return undefined;
  }
  const normalized: Array<{ name: string }> = [];
  for (const [index, candidate] of value.entries()) {
    const author = asRecord(candidate);
    if (!author || Object.keys(author).length !== 1 || !hasOwn(author, "name")) {
      issues.push(issue(
        "LITERATURE_AUTHORS_INVALID",
        "Each author accepts exactly one visible name field in A16.",
        `authors.${index}`
      ));
      continue;
    }
    const name = boundedRequiredText(
      author.name,
      `authors.${index}.name`,
      AI_LITERATURE_AUTHOR_MAX_CHARS,
      issues
    );
    if (name) normalized.push({ name });
  }
  return normalized;
}

function normalizeStringList(
  value: unknown,
  field: "keywords" | "tags",
  issues: AIStandardResultValidationIssue[]
): string[] | undefined {
  if (
    !Array.isArray(value) || value.length > AI_LITERATURE_LIST_MAX ||
    value.some((item) => (
      typeof item !== "string" || !item.trim() || item.includes("\0") ||
      Array.from(item.trim()).length > AI_LITERATURE_LIST_ITEM_MAX_CHARS
    ))
  ) {
    issues.push(issue(
      "LITERATURE_LIST_INVALID",
      `${field} must contain at most ${AI_LITERATURE_LIST_MAX} bounded non-empty strings.`,
      field
    ));
    return undefined;
  }
  const normalized = value.map((item) => (item as string).trim());
  if (new Set(normalized).size !== normalized.length) {
    issues.push(issue("LITERATURE_LIST_INVALID", `${field} must not contain duplicates.`, field));
    return undefined;
  }
  return normalized;
}

function normalizeStructuredPayloadGroup(
  payload: Record<string, unknown>,
  groupKey: "literature_outline" | "dedicated_notes",
  allowedFields: ReadonlySet<string>,
  issues: AIStandardResultValidationIssue[]
): Record<string, unknown> | undefined {
  if (!hasOwn(payload, groupKey)) return undefined;
  const group = asRecord(payload[groupKey]);
  if (!group) {
    issues.push(issue(
      "LITERATURE_STRUCTURED_GROUP_INVALID",
      `${groupKey} must be one structured JSON object.`,
      groupKey
    ));
    return undefined;
  }
  const normalized: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(group)) {
    if (!allowedFields.has(key)) {
      issues.push(issue(
        "LITERATURE_STRUCTURED_FIELD_UNSUPPORTED",
        `${groupKey}.${key} is not a canonical structured Literature field.`,
        `${groupKey}.${key}`
      ));
      continue;
    }
    const value = boundedOptionalText(raw, `${groupKey}.${key}`, AI_LITERATURE_TEXT_MAX_CHARS, issues);
    if (value !== undefined) normalized[key] = value;
  }
  return normalized;
}

function normalizePayload(
  action: "CREATE" | "UPDATE",
  value: unknown,
  issues: AIStandardResultValidationIssue[]
): Record<string, unknown> {
  const payload = asRecord(value);
  if (!payload) {
    issues.push(issue("LITERATURE_PAYLOAD_INVALID", "The visible Literature payload must be one JSON object."));
    return {};
  }
  for (const key of Object.keys(payload)) {
    if (!EDITABLE_FIELDS.has(key)) {
      issues.push(issue(
        "LITERATURE_FIELD_UNSUPPORTED",
        `${key} is not an editable Literature Standard Result field.`,
        key
      ));
    }
  }
  if (action === "UPDATE" && Object.keys(payload).length === 0) {
    issues.push(issue("LITERATURE_UPDATE_EMPTY", "Literature UPDATE requires at least one visible field change."));
  }
  const normalized: Record<string, unknown> = {};
  if (action === "CREATE" || hasOwn(payload, "title")) {
    const title = boundedRequiredText(payload.title, "title", AI_LITERATURE_TITLE_MAX_CHARS, issues);
    if (title) normalized.title = title;
  }
  if (action === "CREATE" || hasOwn(payload, "authors")) {
    const authors = normalizeAuthors(payload.authors ?? [], issues);
    if (authors) normalized.authors = authors;
  }
  if (hasOwn(payload, "year")) {
    if (payload.year === null || payload.year === "") normalized.year = null;
    else if (!Number.isSafeInteger(payload.year) || (payload.year as number) < 0 || (payload.year as number) > 9999) {
      issues.push(issue("LITERATURE_YEAR_INVALID", "year must be an integer from 0 through 9999 or null.", "year"));
    } else normalized.year = payload.year;
  }
  for (const [field, maxChars] of [
    ["venue", AI_LITERATURE_SHORT_TEXT_MAX_CHARS],
    ["abstract", AI_LITERATURE_TEXT_MAX_CHARS],
    ["doi", AI_LITERATURE_SHORT_TEXT_MAX_CHARS]
  ] as const) {
    if (hasOwn(payload, field)) {
      const value = boundedOptionalText(payload[field], field, maxChars, issues);
      if (value !== undefined) normalized[field] = value;
    }
  }
  if (hasOwn(payload, "publicationType")) {
    const value = payload.publicationType;
    if (value === null || value === "") normalized.publicationType = null;
    else if (typeof value !== "string" || !PUBLICATION_TYPES.has(value as LiteratureType)) {
      issues.push(issue("LITERATURE_PUBLICATION_TYPE_INVALID", "publicationType is unsupported.", "publicationType"));
    } else normalized.publicationType = value;
  }
  if (action === "CREATE" || hasOwn(payload, "keywords")) {
    const keywords = normalizeStringList(payload.keywords ?? [], "keywords", issues);
    if (keywords) normalized.keywords = keywords;
  }
  if (action === "CREATE" || hasOwn(payload, "readingStatus")) {
    const value = payload.readingStatus ?? "unread";
    if (typeof value !== "string" || !READING_STATUSES.has(value as LiteratureReadingStatus)) {
      issues.push(issue("LITERATURE_READING_STATUS_INVALID", "readingStatus is unsupported and cannot be cleared.", "readingStatus"));
    } else normalized.readingStatus = value;
  }
  if (hasOwn(payload, "importance")) {
    const value = payload.importance;
    if (value === null || value === "") normalized.importance = null;
    else if (typeof value !== "string" || !IMPORTANCE_VALUES.has(value as LiteratureImportance)) {
      issues.push(issue("LITERATURE_IMPORTANCE_INVALID", "importance is unsupported.", "importance"));
    } else normalized.importance = value;
  }
  if (action === "CREATE" || hasOwn(payload, "tags")) {
    const tags = normalizeStringList(payload.tags ?? [], "tags", issues);
    if (tags) normalized.tags = tags;
  }
  const literatureOutline = normalizeStructuredPayloadGroup(
    payload,
    "literature_outline",
    LITERATURE_OUTLINE_STRUCTURED_FIELDS,
    issues
  );
  if (literatureOutline) {
    if (hasOwn(literatureOutline, "summary")) {
      if (
        hasOwn(normalized, "abstract") &&
        normalized.abstract !== literatureOutline.summary
      ) {
        issues.push(issue(
          "LITERATURE_OUTLINE_SUMMARY_CONFLICT",
          "literature_outline.summary and abstract address one canonical Literature.abstract truth and must not diverge.",
          "literature_outline.summary"
        ));
      } else {
        normalized.abstract = literatureOutline.summary;
      }
      delete literatureOutline.summary;
    }
    if (Object.keys(literatureOutline).length > 0) {
      normalized.literature_outline = literatureOutline;
    }
  }
  const dedicatedNotes = normalizeStructuredPayloadGroup(
    payload,
    "dedicated_notes",
    DEDICATED_NOTES_STRUCTURED_FIELDS,
    issues
  );
  if (dedicatedNotes && Object.keys(dedicatedNotes).length > 0) {
    normalized.dedicated_notes = dedicatedNotes;
  }
  return normalized;
}

function customFieldValue(literature: Literature, key: keyof typeof LITERATURE_CUSTOM_FIELD_KEYS) {
  return getLiteratureCustomStringField(literature, LITERATURE_CUSTOM_FIELD_KEYS[key]) || null;
}

function literatureStructuredState(literature: Literature) {
  return {
    literature_outline: {
      research_problem: customFieldValue(literature, "outlineResearchProblem"),
      application_object: customFieldValue(literature, "outlineApplicationObject"),
      method_overview: customFieldValue(literature, "outlineMethodOverview"),
      main_conclusion: customFieldValue(literature, "outlineMainConclusion"),
      limitations: customFieldValue(literature, "outlineLimitations"),
      other: customFieldValue(literature, "outlineOther")
    },
    dedicated_notes: {
      summary: customFieldValue(literature, "knowledgeProjectSummary"),
      project_relevance: customFieldValue(literature, "knowledgeProjectRelevance"),
      related_objects: customFieldValue(literature, "knowledgeRelatedObjectNotes"),
      reusable_methods: customFieldValue(literature, "knowledgeReusableMethods"),
      comparable_conclusions: customFieldValue(literature, "knowledgeComparableConclusions"),
      other: customFieldValue(literature, "knowledgeOther")
    }
  };
}

function literatureSnapshotFingerprint(literature: Literature): string {
  return canonicalAIStandardResultFingerprint({
    id: literature.id,
    primaryProjectId: literature.primaryProjectId ?? null,
    title: literature.title,
    authorNames: literature.authors.map((author) => author.name),
    year: literature.year ?? null,
    venue: literature.venue ?? null,
    publicationType: literature.publicationType ?? null,
    abstract: literature.abstract ?? null,
    keywords: [...(literature.keywords ?? [])],
    doi: literature.doi ?? null,
    readingStatus: literature.readingStatus,
    importance: literature.importance ?? null,
    tags: [...literature.tags],
    structuredState: literatureStructuredState(literature),
    isArchived: literature.isArchived ?? false,
    deletedAt: literature.deletedAt ?? null,
    updatedAt: literature.updatedAt
  });
}

async function validateFrozenSource(input: {
  source?: AIParseDraftSourceSnapshot;
  expectedProjectId: string;
  target: LiteratureTarget;
  action: AIStandardResultAction;
  dependencies: AILiteratureStandardResultDependencies;
  issues: AIStandardResultValidationIssue[];
}): Promise<Map<string, Literature>> {
  const sourceIds = input.source?.selectedLiteratureIds ?? [];
  if (!input.source) {
    input.issues.push(issue(
      "LITERATURE_SOURCE_SCOPE_REQUIRED",
      "Literature Standard Results require one frozen canonical source snapshot."
    ));
    return new Map();
  }
  if (input.action !== "CREATE" && sourceIds.length === 0) {
    input.issues.push(issue(
      "LITERATURE_SOURCE_SCOPE_REQUIRED",
      "Existing-Literature operations require a frozen A15 source with the exact selected Literature."
    ));
    return new Map();
  }
  if (
    input.source.projectId !== input.expectedProjectId ||
    input.source.conversationId.trim().length === 0 ||
    input.source.literatureSelectionAggregateEligibility !== "ALLOWED"
  ) {
    input.issues.push(issue("LITERATURE_SOURCE_SCOPE_MISMATCH", "The frozen Literature source scope is mismatched."));
  }
  if (
    input.action !== "CREATE" &&
    (!input.target.entityId || !sourceIds.includes(input.target.entityId))
  ) {
    input.issues.push(issue(
      "LITERATURE_TARGET_OUTSIDE_FROZEN_SCOPE",
      "The existing Literature target is outside the frozen selected Literature source scope.",
      "target.entityId"
    ));
  }
  const tuples = input.source.literatureAssociationTuples;
  const tupleSelectionOrders = tuples.map((tuple) => tuple.selectionOrder);
  if (
    tuples.length !== sourceIds.length ||
    new Set(tupleSelectionOrders).size !== tupleSelectionOrders.length ||
    tuples.some((tuple, index) =>
      tuple.literatureId !== sourceIds[index] ||
      !Number.isSafeInteger(tuple.selectionOrder) ||
      tuple.selectionOrder < 0
    )
  ) {
    input.issues.push(issue(
      "LITERATURE_SOURCE_ASSOCIATION_MISMATCH",
      "The frozen ordered Literature association tuples do not match the selected identities."
    ));
  }
  const resolved = await Promise.all(sourceIds.map((id) => input.dependencies.literature.getLiteratureById(id)));
  const byId = new Map<string, Literature>();
  for (const [index, literature] of resolved.entries()) {
    const tuple = tuples[index];
    if (!literature || literature.deletedAt || literature.isArchived) {
      input.issues.push(issue(
        "LITERATURE_SOURCE_UNAVAILABLE",
        `Frozen source Literature ${sourceIds[index]} is unavailable; re-parse is required.`
      ));
      continue;
    }
    byId.set(literature.id, literature);
    const canonicalProjectId = literature.primaryProjectId?.trim() || null;
    const associationMatches = tuple &&
      tuple.canonicalProjectId === canonicalProjectId &&
      tuple.lifecycleEligibility === "eligible" &&
      (canonicalProjectId
        ? tuple.projectAssociationKind === "assigned" &&
          tuple.conversationProjectEligibilityDisposition === "allowed_same_project" &&
          canonicalProjectId === input.expectedProjectId
        : tuple.projectAssociationKind === "projectless" &&
          tuple.conversationProjectEligibilityDisposition === "allowed_global_projectless");
    if (!associationMatches) {
      input.issues.push(issue(
        "LITERATURE_SOURCE_ASSOCIATION_MISMATCH",
        `Frozen source Literature ${literature.id} no longer matches its reviewed optional-Project tuple.`
      ));
    }
  }
  return byId;
}

export async function validateAILiteratureStandardResultProposal(input: {
  action: AIStandardResultAction;
  target: AIStandardResultTarget;
  source?: AIParseDraftSourceSnapshot;
  payload: unknown;
  expectedProjectId: string;
  expectedTargetSnapshotFingerprint?: string;
  dependencies?: AILiteratureStandardResultDependencies;
}): Promise<AILiteratureStandardResultValidation> {
  const dependencies = input.dependencies ?? defaultDependencies;
  const issues: AIStandardResultValidationIssue[] = [];
  if (input.target.module !== "literature" || input.target.entityType !== "literature") {
    return {
      executable: false,
      normalizedPayload: {},
      validationIssues: [issue("LITERATURE_TARGET_INVALID", "The Literature adapter requires one exact Literature target.")]
    };
  }
  const target = input.target;
  if (target.projectId !== input.expectedProjectId) {
    issues.push(issue("LITERATURE_SOURCE_SCOPE_MISMATCH", "The proposed Literature scope crosses the reviewed Conversation Project."));
  }
  const sourceLiterature = await validateFrozenSource({
    source: input.source,
    expectedProjectId: input.expectedProjectId,
    target,
    action: input.action,
    dependencies,
    issues
  });
  const project = await dependencies.getProject(input.expectedProjectId);
  if (!project || project.deletedAt || project.status === "archived") {
    issues.push(issue("LITERATURE_PROJECT_UNAVAILABLE", "The reviewed Conversation Project is unavailable."));
  }

  let existing: Literature | undefined;
  if (input.action !== "CREATE") {
    existing = target.entityId ? sourceLiterature.get(target.entityId) : undefined;
    if (!existing) {
      issues.push(issue("LITERATURE_TARGET_UNAVAILABLE", "The canonical Literature target is missing or unavailable."));
    } else if (existing.deletedAt || existing.isArchived) {
      issues.push(issue("LITERATURE_TARGET_LIFECYCLE_UNSUPPORTED", "Archived or deleted Literature cannot be changed by A16."));
    }
  }
  const currentTargetFingerprint = existing ? literatureSnapshotFingerprint(existing) : undefined;
  if (
    input.expectedTargetSnapshotFingerprint &&
    currentTargetFingerprint !== input.expectedTargetSnapshotFingerprint
  ) {
    issues.push(issue("LITERATURE_TARGET_STALE", "The canonical Literature changed after Parse Draft; re-review is required."));
  }

  const resolvedTarget: LiteratureTarget | undefined = input.action === "CREATE"
    ? {
        module: "literature",
        projectId: input.expectedProjectId,
        entityType: "literature",
        primaryProjectId: null
      }
    : existing
      ? {
          module: "literature",
          projectId: input.expectedProjectId,
          entityType: "literature",
          entityId: existing.id,
          primaryProjectId: existing.primaryProjectId?.trim() || null,
          ...(input.action === "UPDATE" ? { expectedUpdatedAt: existing.updatedAt } : {})
        }
      : undefined;
  if (
    resolvedTarget &&
    (target.primaryProjectId !== undefined && target.primaryProjectId !== resolvedTarget.primaryProjectId ||
      target.expectedUpdatedAt !== undefined && target.expectedUpdatedAt !== resolvedTarget.expectedUpdatedAt)
  ) {
    issues.push(issue(
      "LITERATURE_TARGET_ASSOCIATION_STALE",
      "The application-owned Literature association or reviewed atomic token changed."
    ));
  }

  if (input.action === "DELETE_SUGGESTION") {
    const payload = asRecord(input.payload);
    if (!payload || Object.keys(payload).some((key) => key !== "reason")) {
      issues.push(issue("LITERATURE_DELETE_SUGGESTION_INVALID", "DELETE_SUGGESTION accepts exactly one reason field."));
    }
    const reason = boundedRequiredText(payload?.reason, "reason", 1_000, issues);
    return {
      executable: false,
      normalizedPayload: reason ? { reason } : {},
      validationIssues: readAIStandardResultBlockingValidationIssues(issues).length > 0
        ? issues
        : [issue(
            "DELETE_SUGGESTION_INFORMATIONAL_ONLY",
            "DELETE_SUGGESTION is informational only; use the existing Literature deletion flow."
          )],
      ...(resolvedTarget ? { resolvedTarget } : {}),
      ...(currentTargetFingerprint ? { targetSnapshotFingerprint: currentTargetFingerprint } : {})
    };
  }
  if (input.action === "NEW_MANUSCRIPT") {
    return {
      executable: false,
      normalizedPayload: asRecord(input.payload) ?? {},
      validationIssues: [
        ...issues,
        issue(
          "LITERATURE_NEW_MANUSCRIPT_NOT_ENABLED_IN_A16",
          "Both Literature manuscript channels remain outside A16."
        )
      ],
      ...(resolvedTarget ? { resolvedTarget } : {}),
      ...(currentTargetFingerprint ? { targetSnapshotFingerprint: currentTargetFingerprint } : {})
    };
  }
  if (input.action !== "CREATE" && input.action !== "UPDATE") {
    return {
      executable: false,
      normalizedPayload: {},
      validationIssues: [...issues, issue("LITERATURE_ACTION_UNSUPPORTED", "The Literature action is unsupported.")]
    };
  }
  const normalizedPayload = normalizePayload(input.action, input.payload, issues);
  return {
    executable: readAIStandardResultBlockingValidationIssues(issues).length === 0,
    normalizedPayload,
    validationIssues: issues,
    ...(resolvedTarget ? { resolvedTarget } : {}),
    ...(currentTargetFingerprint ? { targetSnapshotFingerprint: currentTargetFingerprint } : {})
  };
}

function operationInput(result: AIStandardResult): LiteratureStandardResultOperationInput {
  if (
    result.target.module !== "literature" ||
    (result.action !== "CREATE" && result.action !== "UPDATE") ||
    !result.authorizationId || !result.confirmedPayloadFingerprint || !result.confirmationStartedAt
  ) {
    throw new AILiteratureEffectNoEffectError(
      "LITERATURE_OPERATION_BINDING_INVALID",
      "The claimed Literature Result has no exact operation/authorization/payload binding."
    );
  }
  return {
    version: 1,
    action: result.action,
    operationKey: `a16-lit-${result.action.toLowerCase()}:${result.id}:${result.authorizationId}`,
    resultId: result.id,
    authorizationId: result.authorizationId,
    confirmedPayloadFingerprint: result.confirmedPayloadFingerprint,
    occurredAt: result.confirmationStartedAt
  };
}

function optionalDomainValue<T>(value: unknown): T | undefined {
  return value === null ? undefined : value as T;
}

function structuredCustomFieldPatch(payload: Record<string, unknown>): LiteratureCustomFieldPatch {
  const outline = asRecord(payload.literature_outline) ?? {};
  const notes = asRecord(payload.dedicated_notes) ?? {};
  return {
    outlineResearchProblem: outline.research_problem as string | null | undefined,
    outlineApplicationObject: outline.application_object as string | null | undefined,
    outlineMethodOverview: outline.method_overview as string | null | undefined,
    outlineMainConclusion: outline.main_conclusion as string | null | undefined,
    outlineLimitations: outline.limitations as string | null | undefined,
    outlineOther: outline.other as string | null | undefined,
    knowledgeProjectSummary: notes.summary as string | null | undefined,
    knowledgeProjectRelevance: notes.project_relevance as string | null | undefined,
    knowledgeRelatedObjectNotes: notes.related_objects as string | null | undefined,
    knowledgeReusableMethods: notes.reusable_methods as string | null | undefined,
    knowledgeComparableConclusions: notes.comparable_conclusions as string | null | undefined,
    knowledgeOther: notes.other as string | null | undefined
  };
}

function hasStructuredCarrier(payload: Record<string, unknown>) {
  return hasOwn(payload, "literature_outline") || hasOwn(payload, "dedicated_notes");
}

function toCreateInput(payload: Record<string, unknown>): CreateLiteratureWithOperationInput {
  return {
    title: payload.title as string,
    authors: payload.authors as LiteratureAuthor[],
    year: optionalDomainValue<number>(payload.year),
    venue: optionalDomainValue<string>(payload.venue),
    publicationType: optionalDomainValue<LiteratureType>(payload.publicationType),
    abstract: optionalDomainValue<string>(payload.abstract),
    keywords: payload.keywords as string[],
    doi: optionalDomainValue<string>(payload.doi),
    readingStatus: payload.readingStatus as LiteratureReadingStatus,
    importance: optionalDomainValue<LiteratureImportance>(payload.importance),
    tags: payload.tags as string[],
    customFields: mergeLiteratureCustomFields(
      { customFields: [] },
      structuredCustomFieldPatch(payload)
    )
  };
}

function toUpdateInput(
  payload: Record<string, unknown>,
  existing: Literature
): UpdateLiteratureWithOperationInput {
  const patch: UpdateLiteratureWithOperationInput = {};
  for (const field of EDITABLE_FIELDS) {
    if (field === "literature_outline" || field === "dedicated_notes") continue;
    if (!hasOwn(payload, field)) continue;
    (patch as Record<string, unknown>)[field] = optionalDomainValue(payload[field]);
  }
  if (hasStructuredCarrier(payload)) {
    patch.customFields = mergeLiteratureCustomFields(existing, structuredCustomFieldPatch(payload));
  }
  return patch;
}

function canonicalReadback(
  literature: Literature,
  target: LiteratureTarget,
  operation: LiteratureStandardResultOperationInput
): Record<string, unknown> {
  const correlation = literature.aiMetadata?.standardResultOperation;
  return {
    id: literature.id,
    projectId: target.projectId,
    primaryProjectId: literature.primaryProjectId ?? null,
    title: literature.title,
    authorNames: literature.authors.map((author) => author.name),
    year: literature.year ?? null,
    venue: literature.venue ?? null,
    publicationType: literature.publicationType ?? null,
    abstract: literature.abstract ?? null,
    keywords: [...(literature.keywords ?? [])],
    doi: literature.doi ?? null,
    readingStatus: literature.readingStatus,
    importance: literature.importance ?? null,
    tags: [...literature.tags],
    structuredState: literatureStructuredState(literature),
    updatedAt: literature.updatedAt,
    operationKey: operation.operationKey,
    resultId: operation.resultId,
    authorizationId: operation.authorizationId,
    confirmedPayloadFingerprint: operation.confirmedPayloadFingerprint,
    appliedUpdatedAt: correlation?.appliedUpdatedAt
  };
}

async function canonicalReceipt(input: {
  result: AIStandardResult;
  operation: LiteratureStandardResultOperationInput;
  dependencies: AILiteratureStandardResultDependencies;
}): Promise<AIStandardResultEffectReceipt | undefined> {
  if (input.result.target.module !== "literature") return undefined;
  const literature = await input.dependencies.literature.getLiteratureByStandardResultOperation({
    operation: input.operation,
    entityId: input.result.target.entityId
  });
  if (!literature || literature.deletedAt || literature.isArchived) return undefined;
  const primaryProjectId = literature.primaryProjectId?.trim() || null;
  if (
    input.operation.action === "CREATE" && primaryProjectId !== null ||
    input.operation.action === "UPDATE" &&
      (literature.id !== input.result.target.entityId || primaryProjectId !== (input.result.target.primaryProjectId ?? null))
  ) return undefined;
  return {
    module: "literature",
    entityType: "literature",
    entityId: literature.id,
    operation: input.operation.action,
    service: input.operation.action === "CREATE"
      ? "literatureService.createLiteratureWithOperation"
      : "literatureService.updateLiteratureWithExpectedUpdatedAtAndOperation",
    canonicalReadback: canonicalReadback(literature, input.result.target, input.operation)
  };
}

export async function readAILiteratureStandardResultEffect(input: {
  result: AIStandardResult;
  dependencies?: AILiteratureStandardResultDependencies;
}): Promise<AIStandardResultEffectReceipt | undefined> {
  if (
    input.result.target.module !== "literature" ||
    (input.result.action !== "CREATE" && input.result.action !== "UPDATE")
  ) return undefined;
  return canonicalReceipt({
    result: input.result,
    operation: operationInput(input.result),
    dependencies: input.dependencies ?? defaultDependencies
  });
}

export async function invokeAILiteratureStandardResultEffect(input: {
  result: AIStandardResult;
  normalizedPayload: Record<string, unknown>;
  dependencies?: AILiteratureStandardResultDependencies;
}): Promise<AIStandardResultEffectReceipt> {
  const dependencies = input.dependencies ?? defaultDependencies;
  if (
    input.result.target.module !== "literature" ||
    (input.result.action !== "CREATE" && input.result.action !== "UPDATE")
  ) {
    throw new AILiteratureEffectNoEffectError(
      "LITERATURE_TARGET_INVALID",
      "The Literature effect adapter received a non-executable target/action."
    );
  }
  const prior = await readAILiteratureStandardResultEffect({ result: input.result, dependencies });
  if (prior) return prior;
  const operation = operationInput(input.result);
  try {
    if (input.result.action === "CREATE") {
      const created = await dependencies.literature.createLiteratureWithOperation(
        toCreateInput(input.normalizedPayload),
        operation
      );
      if (!created.literature) {
        throw new AILiteratureEffectNoEffectError(
          "LITERATURE_CREATE_ZERO_EFFECT",
          created.errors.join(" ") || "The canonical Literature service proved CREATE had no effect."
        );
      }
    } else {
      const entityId = input.result.target.entityId;
      const expectedUpdatedAt = input.result.target.expectedUpdatedAt;
      if (!entityId || !expectedUpdatedAt) {
        throw new AILiteratureEffectNoEffectError(
          "LITERATURE_UPDATE_TARGET_INVALID",
          "Literature UPDATE requires the exact target and reviewed atomic token."
        );
      }
      const existing = await dependencies.literature.getLiteratureById(entityId);
      if (!existing || existing.deletedAt || existing.isArchived) {
        throw new AILiteratureEffectNoEffectError(
          "LITERATURE_UPDATE_TARGET_UNAVAILABLE",
          "The exact Literature UPDATE target is no longer available."
        );
      }
      const updated = await dependencies.literature.updateLiteratureWithExpectedUpdatedAtAndOperation(
        entityId,
        toUpdateInput(input.normalizedPayload, existing),
        expectedUpdatedAt,
        operation
      );
      if (!updated) {
        throw new AILiteratureEffectNoEffectError(
          "LITERATURE_UPDATE_ZERO_EFFECT",
          "The canonical Literature service proved UPDATE had no effect."
        );
      }
    }
    const receipt = await canonicalReceipt({ result: input.result, operation, dependencies });
    if (receipt) return receipt;
    throw new AILiteratureEffectUnknownError(
      "The Literature effect lacks its exact operation-bound authoritative readback."
    );
  } catch (error) {
    if (error instanceof AILiteratureEffectNoEffectError || error instanceof AILiteratureEffectUnknownError) {
      throw error;
    }
    if (error instanceof LiteratureOperationConflictError) {
      if (
        input.result.action === "UPDATE" &&
        (error.code.includes("STALE") || error.code.includes("CONFLICT"))
      ) {
        throw new AILiteratureEffectNoEffectError(error.code, error.message, error);
      }
    }
    const readback = await readAILiteratureStandardResultEffect({
      result: input.result,
      dependencies
    }).catch(() => undefined);
    if (readback) return readback;
    throw new AILiteratureEffectUnknownError(
      "The Literature operation may have started but has no exact same-operation readback; keep the claimed Result pending.",
      error
    );
  }
}

export function literatureValidationHasStructuralDrift(
  validation: { validationIssues: Array<{ code: string }> }
) {
  return validation.validationIssues.some((candidate) => STRUCTURAL_CODES.has(candidate.code));
}

export const aiLiteratureStandardResultAdapter = {
  validate: validateAILiteratureStandardResultProposal,
  invoke: invokeAILiteratureStandardResultEffect,
  readEffect: readAILiteratureStandardResultEffect
};
