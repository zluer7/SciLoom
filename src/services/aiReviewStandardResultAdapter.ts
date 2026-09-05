import type {
  AIStandardResultAction,
  AIStandardResultEffectReceipt,
  AIStandardResultTarget,
  AIStandardResultValidationIssue
} from "../types/aiStandardResult";
import type {
  Review,
  ReviewOutlineSection,
  ReviewOutlineSectionKey,
  ReviewType,
  UpdateEntityInput
} from "../types/planning";
import { manuscriptBindingService } from "./manuscriptBindingService";
import { REVIEW_OUTLINE_TEMPLATES } from "./reviewCoreContractService";
import type { ReviewTargetInput, ReviewTargetType } from "./planningService";
import { planningService } from "./planningService";
import {
  canonicalAIStandardResultFingerprint,
  readAIStandardResultBlockingValidationIssues
} from "./aiStandardResultService";

export const AI_REVIEW_CREATE_TITLE_MAX_CHARS = 200;
export const AI_REVIEW_CREATE_DESCRIPTION_MAX_CHARS = 4_000;
export const AI_REVIEW_CREATE_PERIOD_LABEL_MAX_CHARS = 200;
export const AI_REVIEW_CREATE_OUTLINE_CONTENT_MAX_CHARS = 4_000;
export const AI_REVIEW_CREATE_TARGET_DESCRIPTION_MAX_CHARS = 1_000;
export const AI_REVIEW_CREATE_TARGET_MAX = 20;

const REVIEW_TYPES = new Set<ReviewType>([
  "stage",
  "periodic",
  "experiment_comparison",
  "literature_comparison",
  "custom"
]);
const REVIEW_TARGET_TYPES = new Set<ReviewTargetType>([
  "routeNode",
  "task",
  "experiment",
  "experimentRun",
  "literature"
]);
const REVIEW_OUTLINE_KEYS = new Set<ReviewOutlineSectionKey>(
  Object.values(REVIEW_OUTLINE_TEMPLATES).flat()
);
const REVIEW_CREATE_EDITABLE_FIELDS = new Set([
  "title",
  "description",
  "reviewType",
  "periodStart",
  "periodEnd",
  "periodLabel",
  "outlineSections",
  "targets",
  "tags"
]);
const REVIEW_UPDATE_EDITABLE_FIELDS = new Set(REVIEW_CREATE_EDITABLE_FIELDS);
const REVIEW_CREATE_RESULT_MARKER = "LP13_B1_A7_STANDARD_RESULT_REVIEW_CREATE";
const REVIEW_UPDATE_RESULT_MARKER = "LP14_A1_B6_STANDARD_RESULT_REVIEW_UPDATE";

export type AIReviewStandardResultValidation = {
  executable: boolean;
  normalizedPayload: Record<string, unknown>;
  validationIssues: AIStandardResultValidationIssue[];
  targetSnapshotFingerprint?: string;
};

export class AIReviewCreateEffectUnknownError extends Error {
  readonly effectMayExist = true;

  constructor(message: string, readonly causeValue?: unknown) {
    super(message);
    this.name = "AIReviewCreateEffectUnknownError";
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

export class AIReviewUpdateEffectUnknownError extends Error {
  readonly effectMayExist = true;

  constructor(message: string, readonly causeValue?: unknown) {
    super(message);
    this.name = "AIReviewUpdateEffectUnknownError";
  }
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, issues: AIStandardResultValidationIssue[]) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      issues.push(issue("REVIEW_FIELD_UNSUPPORTED", `${key} is not an editable Review CREATE field.`, key));
    }
  }
}

function boundedRequiredText(
  value: unknown,
  field: string,
  maxChars: number,
  issues: AIStandardResultValidationIssue[]
): string | undefined {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || Array.from(value.trim()).length > maxChars) {
    issues.push(issue("REVIEW_FIELD_INVALID", `${field} must contain 1-${maxChars} characters.`, field));
    return undefined;
  }
  return value.trim();
}

function boundedOptionalText(
  value: unknown,
  field: string,
  maxChars: number,
  issues: AIStandardResultValidationIssue[]
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return boundedRequiredText(value, field, maxChars, issues);
}

function appendUniqueSafeDescriptionSections(
  existing: string | undefined,
  sections: readonly string[] | undefined,
  issues: AIStandardResultValidationIssue[]
): string | undefined {
  let merged = existing?.trim() ?? "";
  const exactParagraphs = new Set(
    merged.split(/\n\s*\n/gu).map((paragraph) => paragraph.trim()).filter(Boolean)
  );
  for (const section of sections ?? []) {
    const text = section.replace(/\0/gu, "").trim();
    if (!text || exactParagraphs.has(text)) continue;
    const candidate = [merged, text].filter(Boolean).join(merged ? "\n\n" : "");
    if (Array.from(candidate).length > AI_REVIEW_CREATE_DESCRIPTION_MAX_CHARS) {
      issues.push(issue(
        "REVIEW_DESCRIPTION_OVERFLOW",
        "Review description cannot preserve the safe fallback text within the bounded description field.",
        "description"
      ));
      break;
    }
    merged = candidate;
    exactParagraphs.add(text);
  }
  return merged || undefined;
}

function optionalDate(
  value: unknown,
  field: string,
  issues: AIStandardResultValidationIssue[]
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (
    typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value) ||
    Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  ) {
    issues.push(issue("REVIEW_DATE_INVALID", `${field} must be a valid YYYY-MM-DD date.`, field));
    return undefined;
  }
  return value;
}

function normalizeOutlineSections(
  value: unknown,
  issues: AIStandardResultValidationIssue[]
): ReviewOutlineSection[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > REVIEW_OUTLINE_KEYS.size) {
    issues.push(issue("REVIEW_OUTLINE_INVALID", "outlineSections must be one bounded array.", "outlineSections"));
    return [];
  }
  const result: ReviewOutlineSection[] = [];
  const seen = new Set<string>();
  for (const [index, candidate] of value.entries()) {
    const row = asRecord(candidate);
    if (!row || Object.keys(row).length !== 2 || !("key" in row) || !("content" in row)) {
      issues.push(issue("REVIEW_OUTLINE_INVALID", "Each outline section requires exactly key and content.", `outlineSections.${index}`));
      continue;
    }
    if (typeof row.key !== "string" || !REVIEW_OUTLINE_KEYS.has(row.key as ReviewOutlineSectionKey) || seen.has(row.key)) {
      issues.push(issue("REVIEW_OUTLINE_KEY_INVALID", "Review outline keys must be unique canonical keys.", `outlineSections.${index}.key`));
      continue;
    }
    if (typeof row.content !== "string" || row.content.includes("\0") || Array.from(row.content).length > AI_REVIEW_CREATE_OUTLINE_CONTENT_MAX_CHARS) {
      issues.push(issue(
        "REVIEW_OUTLINE_CONTENT_INVALID",
        `Outline content must contain at most ${AI_REVIEW_CREATE_OUTLINE_CONTENT_MAX_CHARS} characters.`,
        `outlineSections.${index}.content`
      ));
      continue;
    }
    seen.add(row.key);
    result.push({ key: row.key as ReviewOutlineSectionKey, content: row.content });
  }
  return result;
}

function normalizeTargets(
  value: unknown,
  issues: AIStandardResultValidationIssue[]
): ReviewTargetInput[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > AI_REVIEW_CREATE_TARGET_MAX) {
    issues.push(issue("REVIEW_TARGETS_INVALID", `targets must contain at most ${AI_REVIEW_CREATE_TARGET_MAX} entries.`, "targets"));
    return [];
  }
  const targets: ReviewTargetInput[] = [];
  const seen = new Set<string>();
  for (const [index, candidate] of value.entries()) {
    const row = asRecord(candidate);
    if (!row || Object.keys(row).some((key) => !["targetType", "targetId", "description"].includes(key))) {
      issues.push(issue("REVIEW_TARGET_INVALID", "Each target accepts only targetType, targetId, and description.", `targets.${index}`));
      continue;
    }
    const targetType = row.targetType;
    const targetId = boundedRequiredText(row.targetId, `targets.${index}.targetId`, 200, issues);
    if (typeof targetType !== "string" || !REVIEW_TARGET_TYPES.has(targetType as ReviewTargetType)) {
      issues.push(issue("REVIEW_TARGET_TYPE_INVALID", "targetType is not a supported Review target type.", `targets.${index}.targetType`));
      continue;
    }
    if (!targetId) continue;
    const key = `${targetType}:${targetId}`;
    if (seen.has(key)) {
      issues.push(issue("REVIEW_TARGET_DUPLICATE", "Review targets must be unique.", `targets.${index}`));
      continue;
    }
    seen.add(key);
    const description = boundedOptionalText(
      row.description,
      `targets.${index}.description`,
      AI_REVIEW_CREATE_TARGET_DESCRIPTION_MAX_CHARS,
      issues
    );
    targets.push({
      targetType: targetType as ReviewTargetType,
      targetId,
      relationType: "summarizes",
      ...(description ? { description } : {})
    });
  }
  return targets;
}

function normalizeTags(value: unknown, issues: AIStandardResultValidationIssue[]): string[] {
  if (value === undefined || value === null) return [];
  if (
    !Array.isArray(value) || value.length > 12 ||
    value.some((tag) => typeof tag !== "string" || !tag.trim() || Array.from(tag.trim()).length > 60 || tag.includes("\0"))
  ) {
    issues.push(issue("REVIEW_TAGS_INVALID", "tags must contain at most 12 non-empty values of at most 60 characters.", "tags"));
    return [];
  }
  return [...new Set(value.map((tag) => (tag as string).trim()))];
}

function reviewSnapshotFingerprint(review: Review): string {
  return canonicalAIStandardResultFingerprint({
    id: review.id,
    projectId: review.projectId,
    title: review.title,
    description: review.description ?? null,
    reviewType: review.reviewType,
    periodStart: review.periodStart ?? null,
    periodEnd: review.periodEnd ?? null,
    periodLabel: review.periodLabel ?? null,
    outlineSections: review.outlineSections.map((section) => ({ ...section })),
    tags: [...review.tags],
    structuredRevision: review.structuredRevision ?? null,
    structuredLifecycleStatus: review.structuredLifecycleStatus ?? null,
    updatedAt: review.updatedAt,
    archivedAt: review.archivedAt ?? null,
    deletedAt: review.deletedAt ?? null
  });
}

async function normalizedReviewCreatePayload(
  target: Extract<AIStandardResultTarget, { module: "review" }>,
  value: unknown,
  issues: AIStandardResultValidationIssue[],
  fallbackSections?: readonly string[]
): Promise<Record<string, unknown>> {
  const payload = asRecord(value);
  if (!payload) {
    issues.push(issue("REVIEW_PAYLOAD_INVALID", "The visible Review payload must be one JSON object."));
    return {};
  }
  exactKeys(payload, REVIEW_CREATE_EDITABLE_FIELDS, issues);
  const title = boundedRequiredText(payload.title, "title", AI_REVIEW_CREATE_TITLE_MAX_CHARS, issues);
  const description = boundedOptionalText(payload.description, "description", AI_REVIEW_CREATE_DESCRIPTION_MAX_CHARS, issues);
  let normalizedDescription = appendUniqueSafeDescriptionSections(description, fallbackSections, issues);
  const reviewTypeValue = hasOwn(payload, "reviewType") ? payload.reviewType : "stage";
  const reviewType = typeof reviewTypeValue === "string" && REVIEW_TYPES.has(reviewTypeValue as ReviewType)
    ? reviewTypeValue as ReviewType
    : undefined;
  if (!reviewType) issues.push(issue("REVIEW_TYPE_INVALID", "reviewType is unsupported.", "reviewType"));
  let periodStart = optionalDate(payload.periodStart, "periodStart", issues);
  let periodEnd = optionalDate(payload.periodEnd, "periodEnd", issues);
  let periodLabel = boundedOptionalText(payload.periodLabel, "periodLabel", AI_REVIEW_CREATE_PERIOD_LABEL_MAX_CHARS, issues);
  const hasAnyPeriodPart = Boolean(periodStart || periodEnd || periodLabel);
  const hasCompletePeriodTuple = Boolean(periodStart && periodEnd);
  if (reviewType !== "periodic" && hasAnyPeriodPart && !hasCompletePeriodTuple) {
    const preservedPeriodText = [
      periodStart ? `开始日期：${periodStart}` : undefined,
      periodEnd ? `结束日期：${periodEnd}` : undefined,
      periodLabel ? `周期说明：${periodLabel}` : undefined
    ].filter(Boolean).join("；");
    const candidateDescription = [normalizedDescription, preservedPeriodText]
      .filter(Boolean)
      .join(normalizedDescription ? "\n\n" : "");
    if (Array.from(candidateDescription).length > AI_REVIEW_CREATE_DESCRIPTION_MAX_CHARS) {
      issues.push(issue(
        "REVIEW_DESCRIPTION_OVERFLOW",
        "Review description cannot preserve the incomplete period text within the bounded description field.",
        "description"
      ));
    } else {
      normalizedDescription = candidateDescription || undefined;
      periodStart = undefined;
      periodEnd = undefined;
      periodLabel = undefined;
    }
  }
  const outlineSections = normalizeOutlineSections(payload.outlineSections, issues);
  const targets = normalizeTargets(payload.targets, issues);
  const tags = normalizeTags(payload.tags, issues);
  const normalized: Record<string, unknown> = {
    ...(title ? { title } : {}),
    ...(normalizedDescription ? { description: normalizedDescription } : {}),
    ...(reviewType ? { reviewType } : {}),
    ...(periodStart ? { periodStart } : {}),
    ...(periodEnd ? { periodEnd } : {}),
    ...(periodLabel ? { periodLabel } : {}),
    outlineSections,
    targets,
    tags
  };
  if (periodStart && periodEnd && periodStart > periodEnd) {
    issues.push(issue("REVIEW_PERIOD_ORDER_INVALID", "periodEnd cannot be earlier than periodStart.", "periodEnd"));
  }
  if (reviewType === "periodic" && (!periodStart || !periodEnd)) {
    issues.push(issue("REVIEW_PERIOD_REQUIRED", "periodic Review requires periodStart and periodEnd.", "periodStart"));
  }
  if (issues.length === 0 && title && reviewType) {
    try {
      await planningService.validateReviewCreateInput({
        projectId: target.projectId,
        title,
        description: normalizedDescription,
        reviewType,
        periodStart,
        periodEnd,
        periodLabel,
        outlineSections,
        targets,
        tags
      });
    } catch (error) {
      issues.push(issue(
        "REVIEW_DOMAIN_RULE_INVALID",
        error instanceof Error ? error.message : "The canonical Review domain rejected this proposal."
      ));
    }
  }
  return normalized;
}

async function normalizedReviewUpdatePayload(
  target: Extract<AIStandardResultTarget, { module: "review" }>,
  value: unknown,
  existing: Review,
  issues: AIStandardResultValidationIssue[],
  fallbackSections?: readonly string[]
): Promise<Record<string, unknown>> {
  const payload = asRecord(value);
  if (!payload) {
    issues.push(issue("REVIEW_PAYLOAD_INVALID", "The visible Review UPDATE payload must be one JSON object."));
    return {};
  }
  exactKeys(payload, REVIEW_UPDATE_EDITABLE_FIELDS, issues);
  if (Object.keys(payload).length === 0) {
    issues.push(issue("REVIEW_UPDATE_EMPTY", "Review UPDATE requires at least one visible field change."));
    return {};
  }

  const normalized: Record<string, unknown> = {};
  if (hasOwn(payload, "title")) {
    const title = boundedRequiredText(payload.title, "title", AI_REVIEW_CREATE_TITLE_MAX_CHARS, issues);
    if (title !== undefined) normalized.title = title;
  }
  if (hasOwn(payload, "description")) {
    normalized.description = boundedOptionalText(
      payload.description,
      "description",
      AI_REVIEW_CREATE_DESCRIPTION_MAX_CHARS,
      issues
    );
  }
  if (fallbackSections && fallbackSections.length > 0) {
    const baseDescription = hasOwn(normalized, "description")
      ? normalized.description as string | undefined
      : existing.description;
    normalized.description = appendUniqueSafeDescriptionSections(
      baseDescription,
      fallbackSections,
      issues
    );
  }

  let reviewType = existing.reviewType;
  if (hasOwn(payload, "reviewType")) {
    if (typeof payload.reviewType !== "string" || !REVIEW_TYPES.has(payload.reviewType as ReviewType)) {
      issues.push(issue("REVIEW_TYPE_INVALID", "reviewType is unsupported.", "reviewType"));
    } else {
      reviewType = payload.reviewType as ReviewType;
      normalized.reviewType = reviewType;
    }
  }

  for (const field of ["periodStart", "periodEnd"] as const) {
    if (hasOwn(payload, field)) normalized[field] = optionalDate(payload[field], field, issues);
  }
  if (hasOwn(payload, "periodLabel")) {
    normalized.periodLabel = boundedOptionalText(
      payload.periodLabel,
      "periodLabel",
      AI_REVIEW_CREATE_PERIOD_LABEL_MAX_CHARS,
      issues
    );
  }

  if (hasOwn(payload, "outlineSections")) {
    const supplied = normalizeOutlineSections(payload.outlineSections, issues);
    const allowedKeys = new Set<ReviewOutlineSectionKey>(REVIEW_OUTLINE_TEMPLATES[reviewType]);
    for (const section of supplied) {
      if (!allowedKeys.has(section.key)) {
        issues.push(issue(
          "REVIEW_OUTLINE_KEY_INVALID",
          `${section.key} is not valid for Review type ${reviewType}.`,
          "outlineSections"
        ));
      }
    }
    const prior = new Map(existing.outlineSections.map((section) => [section.key, section.content]));
    const next = new Map(supplied.map((section) => [section.key, section.content]));
    normalized.outlineSections = REVIEW_OUTLINE_TEMPLATES[reviewType].map((key) => ({
      key,
      content: next.get(key) ?? (existing.reviewType === reviewType ? prior.get(key) ?? "" : "")
    }));
  }
  if (hasOwn(payload, "targets")) normalized.targets = normalizeTargets(payload.targets, issues);
  if (hasOwn(payload, "tags")) normalized.tags = normalizeTags(payload.tags, issues);

  const nextPeriodStart = hasOwn(normalized, "periodStart")
    ? normalized.periodStart as string | undefined
    : existing.periodStart;
  const nextPeriodEnd = hasOwn(normalized, "periodEnd")
    ? normalized.periodEnd as string | undefined
    : existing.periodEnd;
  const nextPeriodLabel = hasOwn(normalized, "periodLabel")
    ? normalized.periodLabel as string | undefined
    : existing.periodLabel;
  if (nextPeriodStart && nextPeriodEnd && nextPeriodStart > nextPeriodEnd) {
    issues.push(issue("REVIEW_PERIOD_ORDER_INVALID", "periodEnd cannot be earlier than periodStart.", "periodEnd"));
  }
  if (reviewType === "periodic" && (!nextPeriodStart || !nextPeriodEnd)) {
    issues.push(issue("REVIEW_PERIOD_REQUIRED", "periodic Review requires periodStart and periodEnd.", "periodStart"));
  }
  if (
    reviewType !== "periodic" &&
    (hasOwn(payload, "periodStart") || hasOwn(payload, "periodEnd") || hasOwn(payload, "periodLabel")) &&
    !(nextPeriodStart && nextPeriodEnd)
  ) {
    const preserved = [
      nextPeriodStart ? `开始日期：${nextPeriodStart}` : undefined,
      nextPeriodEnd ? `结束日期：${nextPeriodEnd}` : undefined,
      nextPeriodLabel ? `周期说明：${nextPeriodLabel}` : undefined
    ].filter(Boolean).join("；");
    const baseDescription = hasOwn(normalized, "description")
      ? normalized.description as string | undefined
      : existing.description;
    const nextDescription = [baseDescription, preserved]
      .filter(Boolean)
      .join(baseDescription ? "\n\n" : "");
    if (Array.from(nextDescription).length > AI_REVIEW_CREATE_DESCRIPTION_MAX_CHARS) {
      issues.push(issue(
        "REVIEW_DESCRIPTION_OVERFLOW",
        "Review description cannot preserve the incomplete period text within the bounded description field.",
        "description"
      ));
    } else {
      normalized.description = nextDescription || undefined;
      delete normalized.periodStart;
      delete normalized.periodEnd;
      delete normalized.periodLabel;
    }
  }

  if (issues.length === 0) {
    try {
      const currentTargets = await planningService.queryReviewTargets(existing.id);
      await planningService.validateReviewCreateInput({
        projectId: target.projectId,
        title: (normalized.title as string | undefined) ?? existing.title,
        description: hasOwn(normalized, "description")
          ? normalized.description as string | undefined
          : existing.description,
        reviewType,
        periodStart: hasOwn(normalized, "periodStart")
          ? normalized.periodStart as string | undefined
          : existing.periodStart,
        periodEnd: hasOwn(normalized, "periodEnd")
          ? normalized.periodEnd as string | undefined
          : existing.periodEnd,
        periodLabel: hasOwn(normalized, "periodLabel")
          ? normalized.periodLabel as string | undefined
          : existing.periodLabel,
        outlineSections: (normalized.outlineSections as ReviewOutlineSection[] | undefined) ?? existing.outlineSections,
        targets: (normalized.targets as ReviewTargetInput[] | undefined) ?? currentTargets.flatMap((candidate) =>
          REVIEW_TARGET_TYPES.has(candidate.targetType as ReviewTargetType)
            ? [{
                targetType: candidate.targetType as ReviewTargetType,
                targetId: candidate.targetId,
                relationType: "summarizes" as const
              }]
            : []),
        tags: (normalized.tags as string[] | undefined) ?? existing.tags,
        source: existing.source
      });
    } catch (error) {
      issues.push(issue(
        "REVIEW_DOMAIN_RULE_INVALID",
        error instanceof Error ? error.message : "The canonical Review domain rejected this UPDATE proposal."
      ));
    }
  }
  return normalized;
}

export async function validateAIReviewStandardResultProposal(input: {
  action: AIStandardResultAction;
  target: AIStandardResultTarget;
  payload: unknown;
  expectedProjectId: string;
  expectedTargetSnapshotFingerprint?: string;
  fallbackSections?: readonly string[];
}): Promise<AIReviewStandardResultValidation> {
  const issues: AIStandardResultValidationIssue[] = [];
  if (input.target.module !== "review" || input.target.entityType !== "review") {
    return {
      executable: false,
      normalizedPayload: {},
      validationIssues: [issue("REVIEW_TARGET_INVALID", "The Review adapter requires a canonical Review target descriptor.")]
    };
  }
  if (input.target.projectId !== input.expectedProjectId) {
    issues.push(issue("REVIEW_SCOPE_MISMATCH", "The proposed Review scope crosses the reviewed Project.", "target.projectId"));
  }
  const project = await planningService.getProjectById(input.expectedProjectId);
  if (!project || project.deletedAt || project.status === "archived") {
    issues.push(issue("REVIEW_PROJECT_UNAVAILABLE", "The reviewed Project is unavailable for this Review operation."));
  }
  if (input.action === "CREATE") {
    if (input.target.entityId || input.target.manuscriptChannel) {
      issues.push(issue("REVIEW_CREATE_EXISTING_ID_FORBIDDEN", "Review CREATE must not contain an existing Review owner or manuscript channel."));
    }
    const normalizedPayload = await normalizedReviewCreatePayload(
      input.target,
      input.payload,
      issues,
      input.fallbackSections
    );
    return {
      executable: readAIStandardResultBlockingValidationIssues(issues).length === 0,
      normalizedPayload,
      validationIssues: issues
    };
  }
  const review = input.target.entityId
    ? await planningService.getReviewById(input.target.entityId)
    : undefined;
  if (!review || review.deletedAt || review.archivedAt || review.projectId !== input.expectedProjectId) {
    issues.push(issue("REVIEW_TARGET_UNAVAILABLE", "The canonical Review target is unavailable in the reviewed Project."));
  }
  const targetSnapshotFingerprint = review ? reviewSnapshotFingerprint(review) : undefined;
  if (input.expectedTargetSnapshotFingerprint && targetSnapshotFingerprint !== input.expectedTargetSnapshotFingerprint) {
    issues.push(issue("REVIEW_TARGET_STALE", "The canonical Review changed after Parse Draft; re-parse is required."));
  }
  if (input.action === "DELETE_SUGGESTION") {
    const reason = boundedRequiredText(asRecord(input.payload)?.reason, "reason", 1_000, issues);
    return {
      executable: false,
      normalizedPayload: reason ? { reason } : {},
      validationIssues: readAIStandardResultBlockingValidationIssues(issues).length > 0
        ? issues
        : [issue("DELETE_SUGGESTION_INFORMATIONAL_ONLY", "DELETE_SUGGESTION has no AI executor; use the existing Review deletion flow.")],
      ...(targetSnapshotFingerprint ? { targetSnapshotFingerprint } : {})
    };
  }
  if (input.action === "UPDATE") {
    const normalizedPayload = review
      ? await normalizedReviewUpdatePayload(
          input.target,
          input.payload,
          review,
          issues,
          input.fallbackSections
        )
      : asRecord(input.payload) ?? {};
    return {
      executable: readAIStandardResultBlockingValidationIssues(issues).length === 0,
      normalizedPayload,
      validationIssues: issues,
      ...(targetSnapshotFingerprint ? { targetSnapshotFingerprint } : {})
    };
  }
  return {
    executable: false,
    normalizedPayload: asRecord(input.payload) ?? {},
    validationIssues: [
      ...issues,
      issue("REVIEW_ACTION_UNSUPPORTED", `${input.action} is not owned by the Review data-operation adapter.`)
    ],
    ...(targetSnapshotFingerprint ? { targetSnapshotFingerprint } : {})
  };
}

async function correlatedReviews(projectId: string, resultId: string): Promise<Review[]> {
  const firstLayerIdentities = await planningService.queryReviewFirstLayerIdentities({
    projectId,
    includeArchived: true,
    includeDeleted: true
  });
  const correlatedIdentities = firstLayerIdentities.filter((review) =>
    review.aiMetadata?.lastAiAction === REVIEW_CREATE_RESULT_MARKER &&
    review.aiMetadata.sourceEntityIds?.includes(resultId));
  return Promise.all(correlatedIdentities.map(async (identity) => {
    if (identity.deletedAt) {
      throw new AIReviewCreateEffectUnknownError(
        "The exact operation-correlated Review is deleted; its prior CREATE cannot be treated as absent."
      );
    }
    const review = await planningService.getReviewById(identity.id);
    if (!review) {
      throw new AIReviewCreateEffectUnknownError(
        "The exact operation-correlated Review lacks its canonical structured readback."
      );
    }
    return review;
  }));
}

async function canonicalReviewEffectReceipt(
  review: Review,
  resultId: string,
  operation: "CREATE" | "UPDATE",
  provisioning?: unknown
): Promise<AIStandardResultEffectReceipt> {
  const [readback, targets, binding] = await Promise.all([
    planningService.getReviewById(review.id),
    planningService.queryReviewTargets(review.id),
    manuscriptBindingService.getBindingByOwner("review", review.id, "primary")
  ]);
  if (!readback || readback.projectId !== review.projectId || readback.deletedAt) {
    throw new AIReviewCreateEffectUnknownError("The canonical Review CREATE readback is unavailable after the domain effect.");
  }
  return {
    module: "review",
    entityType: "review",
    entityId: readback.id,
    operation,
    service: operation === "CREATE"
      ? "planningService.createReviewWithTargets"
      : "planningService.updateReview",
    canonicalReadback: {
      id: readback.id,
      projectId: readback.projectId,
      title: readback.title,
      description: readback.description ?? null,
      reviewType: readback.reviewType,
      periodStart: readback.periodStart ?? null,
      periodEnd: readback.periodEnd ?? null,
      periodLabel: readback.periodLabel ?? null,
      outlineSections: readback.outlineSections.map((section) => ({ ...section })),
      tags: [...readback.tags],
      source: readback.source,
      structuredRevision: readback.structuredRevision ?? null,
      structuredLifecycleStatus: readback.structuredLifecycleStatus ?? null,
      targets: targets.map((target) => ({
        targetType: target.targetType,
        targetId: target.targetId,
        missing: target.missing
      })),
      resultCorrelationId: resultId,
      serviceOwnedProvisioning: provisioning ?? {
        completionState: binding ? "complete_readback" : "incomplete_readback",
        bindingId: binding?.id ?? null,
        defaultManuscriptFileRefId: binding?.defaultManuscriptFileRefId ?? null,
        currentFileRefId: binding?.currentFileRefId ?? null
      }
    }
  };
}

export async function readAIReviewCreateStandardResultEffect(input: {
  target: Extract<AIStandardResultTarget, { module: "review" }>;
  resultId: string;
}): Promise<AIStandardResultEffectReceipt | undefined> {
  const matches = await correlatedReviews(input.target.projectId, input.resultId);
  if (matches.length > 1) {
    throw new AIReviewCreateEffectUnknownError("One Review Standard Result correlation resolved to multiple domain Reviews.");
  }
  return matches[0]
    ? canonicalReviewEffectReceipt(matches[0], input.resultId, "CREATE")
    : undefined;
}

export async function invokeAIReviewCreateStandardResultEffect(input: {
  target: Extract<AIStandardResultTarget, { module: "review" }>;
  normalizedPayload: Record<string, unknown>;
  resultId: string;
  authorizationId: string;
}): Promise<AIStandardResultEffectReceipt> {
  const prior = await readAIReviewCreateStandardResultEffect({ target: input.target, resultId: input.resultId });
  if (prior) return prior;
  const payload = input.normalizedPayload;
  try {
    const created = await planningService.createReviewWithTargets({
      projectId: input.target.projectId,
      title: payload.title as string,
      description: payload.description as string | undefined,
      reviewType: payload.reviewType as ReviewType,
      periodStart: payload.periodStart as string | undefined,
      periodEnd: payload.periodEnd as string | undefined,
      periodLabel: payload.periodLabel as string | undefined,
      outlineSections: payload.outlineSections as ReviewOutlineSection[],
      targets: payload.targets as ReviewTargetInput[],
      tags: payload.tags as string[],
      source: "ai",
      aiMetadata: {
        generatedBy: "LabPod LP13 Standard Result",
        sourceEntityIds: [input.resultId],
        promptId: input.authorizationId,
        needsReview: false,
        lastAiAction: REVIEW_CREATE_RESULT_MARKER,
        lastAiUpdatedAt: new Date().toISOString()
      }
    });
    return canonicalReviewEffectReceipt(created, input.resultId, "CREATE", created.provisioning);
  } catch (error) {
    const readback = await readAIReviewCreateStandardResultEffect({ target: input.target, resultId: input.resultId }).catch(() => undefined);
    if (readback) return readback;
    throw new AIReviewCreateEffectUnknownError(
      "Review CREATE did not reach an authoritative correlated readback; the claimed Result must remain non-confirmable for same-operation continuation.",
      error
    );
  }
}

function reviewMatchesUpdatePayload(
  review: Review,
  targets: readonly { targetType: string; targetId: string }[],
  payload: Record<string, unknown>
): boolean {
  for (const [field, value] of Object.entries(payload)) {
    if (field === "targets") {
      const expected = (value as ReviewTargetInput[]).map((target) =>
        `${target.targetType}:${target.targetId}`).sort();
      const actual = targets.map((target) => `${target.targetType}:${target.targetId}`).sort();
      if (JSON.stringify(expected) !== JSON.stringify(actual)) return false;
      continue;
    }
    if (field === "outlineSections" || field === "tags") {
      if (JSON.stringify(review[field]) !== JSON.stringify(value)) return false;
      continue;
    }
    if ((review as unknown as Record<string, unknown>)[field] !== value) return false;
  }
  return true;
}

export async function readAIReviewUpdateStandardResultEffect(input: {
  target: Extract<AIStandardResultTarget, { module: "review" }>;
  resultId: string;
  normalizedPayload: Record<string, unknown>;
}): Promise<AIStandardResultEffectReceipt | undefined> {
  if (!input.target.entityId) return undefined;
  const [review, targets] = await Promise.all([
    planningService.getReviewById(input.target.entityId),
    planningService.queryReviewTargets(input.target.entityId)
  ]);
  if (
    !review || review.projectId !== input.target.projectId || review.deletedAt || review.archivedAt ||
    review.aiMetadata?.lastAiAction !== REVIEW_UPDATE_RESULT_MARKER ||
    !review.aiMetadata.sourceEntityIds?.includes(input.resultId) ||
    !reviewMatchesUpdatePayload(review, targets, input.normalizedPayload)
  ) return undefined;
  return canonicalReviewEffectReceipt(review, input.resultId, "UPDATE");
}

export async function invokeAIReviewUpdateStandardResultEffect(input: {
  target: Extract<AIStandardResultTarget, { module: "review" }>;
  normalizedPayload: Record<string, unknown>;
  resultId: string;
  authorizationId: string;
}): Promise<AIStandardResultEffectReceipt> {
  const prior = await readAIReviewUpdateStandardResultEffect(input);
  if (prior) return prior;
  if (!input.target.entityId) {
    throw new AIReviewUpdateEffectUnknownError("Review UPDATE requires one exact canonical target identity.");
  }
  const existing = await planningService.getReviewById(input.target.entityId);
  if (!existing || existing.projectId !== input.target.projectId || existing.deletedAt || existing.archivedAt) {
    throw new AIReviewUpdateEffectUnknownError("The exact Review UPDATE target is unavailable.");
  }
  try {
    const updated = await planningService.updateReview(input.target.entityId, {
      ...(input.normalizedPayload as UpdateEntityInput<Review>),
      aiMetadata: {
        ...existing.aiMetadata,
        generatedBy: "LabPod LP14 Standard Result",
        sourceEntityIds: [
          ...new Set([...(existing.aiMetadata?.sourceEntityIds ?? []), input.resultId])
        ],
        promptId: input.authorizationId,
        needsReview: false,
        lastAiAction: REVIEW_UPDATE_RESULT_MARKER,
        lastAiUpdatedAt: new Date().toISOString()
      }
    });
    if (!updated) throw new Error("Review UPDATE returned no canonical entity.");
    const receipt = await readAIReviewUpdateStandardResultEffect(input);
    if (receipt) return receipt;
    throw new Error("Review UPDATE did not match its exact confirmed payload on readback.");
  } catch (error) {
    const readback = await readAIReviewUpdateStandardResultEffect(input).catch(() => undefined);
    if (readback) return readback;
    throw new AIReviewUpdateEffectUnknownError(
      "Review UPDATE did not reach an authoritative correlated exact-target readback.",
      error
    );
  }
}
