import { planningSelectorService } from "./planningSelectorService";
import type { EntityId } from "../types";
import type { MissingEntityReference } from "../types/entityReference";
import type {
  ReviewAggregationContext,
  ReviewAiContext,
  ReviewAiContextKind,
  ReviewAiEvidenceLine,
  ReviewEvidenceBase,
  ReviewEvidenceBoundary,
  ReviewEvidenceContext,
  ReviewEvidenceLimitations,
  ReviewPeriodContext,
  ReviewPeriodContextOptions,
  ReviewScopeSummary
} from "../types/planningContext";

const REVIEW_AI_USAGE_NOTES = [
  "Use direct target evidence as the primary Review target basis.",
  "Use period evidence only as period-scoped activity, not as direct target proof unless it is also explicitly classified as direct evidence.",
  "Use indirect cross-module evidence as supporting context; do not present it as directly reviewed evidence without provenance.",
  "Use derived output evidence as output-chain summaries, not as raw experiment facts or verified scientific conclusions.",
  "Surface warnings, missing references, partial reasons, and limitations in the answer.",
  "If partial is true, avoid definitive conclusions and explain which evidence boundary is incomplete.",
  "Local paths, PDF full text, experiment raw data, images, datasets, code files, API keys, and unrelated historical records are excluded."
];

function valueOrUnset(value: unknown) {
  return value === undefined || value === null || value === "" ? "unset" : String(value);
}

function markdownList(items: string[], emptyText = "None") {
  const visibleItems = items.filter((item) => item.trim().length > 0);
  return visibleItems.length > 0
    ? visibleItems.map((item) => `- ${item}`).join("\n")
    : `- ${emptyText}`;
}

function evidenceTitle(item: ReviewEvidenceBase) {
  return item.evidence?.title ?? item.entity?.title ?? item.link?.target.title ?? "Untitled evidence";
}

function evidenceEntityType(item: ReviewEvidenceBase) {
  return item.evidence?.evidenceType ?? item.entity?.entityType ?? item.link?.target.entityType;
}

function evidenceEntityId(item: ReviewEvidenceBase) {
  return item.evidence?.evidenceId ?? item.entity?.entityId ?? item.link?.target.entityId;
}

function evidenceSummary(item: ReviewEvidenceBase) {
  return item.evidence?.contentSummary ?? item.entity?.subtitle ?? item.link?.description;
}

function evidenceRelation(item: ReviewEvidenceBase) {
  return item.evidence?.relationType ?? item.link?.relationType;
}

function missingReferenceText(reference: MissingEntityReference) {
  const source =
    reference.sourceType && reference.sourceId
      ? `${reference.sourceType}:${reference.sourceId} -> `
      : "";
  return `${source}${reference.targetType}:${reference.targetId} (${reference.reason})${reference.message ? ` - ${reference.message}` : ""}`;
}

function limitationText(limitation: ReviewEvidenceLimitations) {
  return `${limitation.code}${limitation.sourceKind ? ` [${limitation.sourceKind}]` : ""}: ${limitation.message}`;
}

function toEvidenceLine(item: ReviewEvidenceBase): ReviewAiEvidenceLine {
  return {
    sourceKind: item.sourceKind,
    role: item.role,
    title: evidenceTitle(item),
    entityType: evidenceEntityType(item),
    entityId: evidenceEntityId(item),
    relationType: evidenceRelation(item),
    summary: evidenceSummary(item),
    sourceBoundary: item.sourceBoundary,
    scopeSensitivity: item.scopeSensitivity,
    warnings: item.warnings,
    missingReferences: item.missingReferences,
    partial: item.partial
  };
}

function formatEvidenceLine(line: ReviewAiEvidenceLine) {
  const details = [
    `${valueOrUnset(line.entityType)}:${valueOrUnset(line.entityId)}`,
    `sourceKind=${line.sourceKind}`,
    `role=${line.role}`,
    line.relationType ? `relation=${line.relationType}` : undefined,
    line.partial ? "partial=true" : undefined
  ].filter(Boolean);
  const summary = line.summary ? `\n  - summary: ${line.summary}` : "";
  const boundary = `\n  - boundary: ${line.sourceBoundary}`;
  const sensitivity =
    line.scopeSensitivity.length > 0
      ? `\n  - scopeSensitivity: ${line.scopeSensitivity.join(", ")}`
      : "";
  const warnings =
    line.warnings.length > 0 ? `\n  - warnings: ${line.warnings.join("; ")}` : "";
  const missing =
    line.missingReferences.length > 0
      ? `\n  - missing: ${line.missingReferences.map(missingReferenceText).join("; ")}`
      : "";

  return `${line.title} (${details.join(", ")})${summary}${boundary}${sensitivity}${warnings}${missing}`;
}

function formatEvidenceLines(lines: ReviewAiEvidenceLine[], emptyText = "No evidence records") {
  return markdownList(lines.map(formatEvidenceLine), emptyText);
}

function formatScopeSummary(scope: ReviewScopeSummary) {
  return [
    `- Review ID: ${valueOrUnset(scope.reviewId)}`,
    `- Project ID: ${valueOrUnset(scope.projectId)}`,
    `- Scope: ${scope.scope}`,
    `- Period start: ${valueOrUnset(scope.period.start)}`,
    `- Period end: ${valueOrUnset(scope.period.end)}`,
    `- Period label: ${valueOrUnset(scope.period.label)}`,
    `- Target project IDs: ${scope.targetProjectIds.length > 0 ? scope.targetProjectIds.join(", ") : "none"}`,
    `- Target route node IDs: ${scope.targetRouteNodeIds.length > 0 ? scope.targetRouteNodeIds.join(", ") : "none"}`,
    `- Target task IDs: ${scope.targetTaskIds.length > 0 ? scope.targetTaskIds.join(", ") : "none"}`,
    `- Has explicit targets: ${scope.hasExplicitTargets ? "yes" : "no"}`,
    `- Has period: ${scope.hasPeriod ? "yes" : "no"}`
  ].join("\n");
}

function formatBoundary(boundary: ReviewEvidenceBoundary) {
  return [
    `- Source kinds: ${boundary.sourceKinds.join(", ")}`,
    `- Scope sensitivity: ${boundary.scopeSensitivity.join(", ")}`,
    `- Source boundary: ${boundary.sourceBoundary}`,
    `- Excludes local file bodies: ${boundary.excludesLocalFileBodies ? "yes" : "no"}`,
    `- Excludes PDF full text: ${boundary.excludesPdfFullText ? "yes" : "no"}`,
    `- Excludes experiment raw data: ${boundary.excludesExperimentRawData ? "yes" : "no"}`,
    `- Aggregation wiring deferred: ${boundary.aggregationWiringDeferred ? "yes" : "no"}`
  ].join("\n");
}

function contextTitle(kind: ReviewAiContextKind, context: ReviewAggregationContext | ReviewPeriodContext) {
  if (kind === "review_aggregation") {
    return `Review Aggregation AI Context: ${(context as ReviewAggregationContext).review.title}`;
  }
  return "Review Period AI Context";
}

function buildSourceContextMissingContext(
  kind: ReviewAiContextKind,
  context: ReviewAggregationContext | ReviewPeriodContext
): ReviewAiContext {
  const scopeSummary: ReviewScopeSummary =
    kind === "review_aggregation"
      ? {
          reviewId: (context as ReviewAggregationContext).review.entityId,
          projectId: (context as ReviewAggregationContext).project?.entityId,
          scope: (context as ReviewAggregationContext).scope,
          period: (context as ReviewAggregationContext).period,
          targetProjectIds: (context as ReviewAggregationContext).project
            ? [(context as ReviewAggregationContext).project!.entityId]
            : [],
          targetRouteNodeIds: (context as ReviewAggregationContext).routeNodes.map(
            (routeNode) => routeNode.entityId
          ),
          targetTaskIds: [],
          hasExplicitTargets: (context as ReviewAggregationContext).targets.length > 0,
          hasPeriod: Boolean(
            (context as ReviewAggregationContext).period.start &&
              (context as ReviewAggregationContext).period.end
          )
        }
      : {
          projectId: (context as ReviewPeriodContext).options.projectId,
          scope: (context as ReviewPeriodContext).options.routeNodeId ? "route" : "project",
          period: {
            start: (context as ReviewPeriodContext).options.startDate,
            end: (context as ReviewPeriodContext).options.endDate
          },
          targetProjectIds: (context as ReviewPeriodContext).options.projectId
            ? [(context as ReviewPeriodContext).options.projectId!]
            : [],
          targetRouteNodeIds: (context as ReviewPeriodContext).options.routeNodeId
            ? [(context as ReviewPeriodContext).options.routeNodeId!]
            : [],
          targetTaskIds: [],
          hasExplicitTargets: Boolean(
            (context as ReviewPeriodContext).options.projectId ||
              (context as ReviewPeriodContext).options.routeNodeId
          ),
          hasPeriod: Boolean(
            (context as ReviewPeriodContext).options.startDate ||
              (context as ReviewPeriodContext).options.endDate
          )
        };
  const warning = "Review evidenceContext is missing; AI/export must not treat legacy aggregation arrays as complete evidence.";
  const evidenceBoundary: ReviewEvidenceBoundary = {
    sourceKinds: ["warning_only"],
    scopeSensitivity: ["warning_only"],
    sourceBoundary: warning,
    excludesLocalFileBodies: true,
    excludesPdfFullText: true,
    excludesExperimentRawData: true,
    aggregationWiringDeferred: true
  };

  return {
    kind,
    title: contextTitle(kind, context),
    scopeSummary,
    evidenceBoundary,
    evidenceStats: {
      directTargetEvidenceCount: 0,
      periodEvidenceCount: 0,
      indirectEvidenceCount: 0,
      derivedOutputEvidenceCount: 0,
      existingReviewContentEvidenceCount: 0,
      taskEvidenceCount: 0,
      experimentEvidenceCount: 0,
      literatureEvidenceCount: 0,
      outputEvidenceCount: 0,
      warningCount: 1,
      missingReferenceCount: context.missingReferences.length,
      partialEvidenceCount: 0
    },
    directTargetEvidence: [],
    periodEvidence: [],
    indirectCrossModuleEvidence: [],
    derivedOutputEvidence: [],
    existingReviewContentEvidence: [],
    taskEvidence: [],
    experimentEvidence: [],
    literatureEvidence: [],
    outputEvidence: [],
    warnings: [warning, ...context.warnings],
    missingReferences: context.missingReferences,
    partial: true,
    partialReasons: ["missing_review_evidence_context"],
    limitations: [
      {
        code: "warning_only",
        message: warning,
        sourceKind: "warning_only"
      }
    ],
    aiUsageNotes: REVIEW_AI_USAGE_NOTES,
    promptSections: [],
    sourceContextMissing: true
  };
}

function buildReviewAiContext(
  kind: ReviewAiContextKind,
  context: ReviewAggregationContext | ReviewPeriodContext,
  evidenceContext: ReviewEvidenceContext
): ReviewAiContext {
  const aiContext: ReviewAiContext = {
    kind,
    title: contextTitle(kind, context),
    scopeSummary: evidenceContext.scopeSummary,
    evidenceBoundary: evidenceContext.boundary,
    evidenceStats: evidenceContext.stats,
    directTargetEvidence: evidenceContext.directTargetEvidence.map(toEvidenceLine),
    periodEvidence: evidenceContext.periodEvidence.map(toEvidenceLine),
    indirectCrossModuleEvidence: evidenceContext.indirectEvidence.map(toEvidenceLine),
    derivedOutputEvidence: evidenceContext.derivedOutputEvidence.map(toEvidenceLine),
    existingReviewContentEvidence: evidenceContext.existingReviewContentEvidence.map(toEvidenceLine),
    taskEvidence: evidenceContext.taskEvidence.map(toEvidenceLine),
    experimentEvidence: evidenceContext.experimentEvidence.map(toEvidenceLine),
    literatureEvidence: evidenceContext.literatureEvidence.map(toEvidenceLine),
    outputEvidence: evidenceContext.outputEvidence.map(toEvidenceLine),
    warnings: evidenceContext.warnings,
    missingReferences: evidenceContext.missingReferences,
    partial: evidenceContext.partial,
    partialReasons: evidenceContext.partialReasons,
    limitations: evidenceContext.limitations,
    aiUsageNotes: REVIEW_AI_USAGE_NOTES,
    promptSections: [],
    sourceContextMissing: false
  };

  return {
    ...aiContext,
    promptSections: [
      buildReviewEvidenceBoundarySection(evidenceContext),
      buildReviewEvidencePromptSection(evidenceContext),
      buildReviewEvidenceLimitationsSection(evidenceContext),
      ["## AI Usage Notes", "", markdownList(REVIEW_AI_USAGE_NOTES)].join("\n")
    ]
  };
}

export function buildReviewEvidenceBoundarySection(evidenceContext: ReviewEvidenceContext): string {
  return [
    "## Evidence Boundary",
    "",
    "Review evidence is source-classified before AI usage. Do not collapse indirect, period, or derived evidence into direct target proof.",
    "",
    formatBoundary(evidenceContext.boundary)
  ].join("\n");
}

export function buildReviewEvidenceLimitationsSection(evidenceContext: ReviewEvidenceContext): string {
  return [
    "## Partial State And Limitations",
    "",
    `- Partial: ${evidenceContext.partial ? "yes" : "no"}`,
    `- Partial reasons: ${evidenceContext.partialReasons.length > 0 ? evidenceContext.partialReasons.join(", ") : "none"}`,
    "",
    "### Limitations",
    "",
    markdownList(evidenceContext.limitations.map(limitationText), "No limitations"),
    "",
    "### Warnings",
    "",
    markdownList(evidenceContext.warnings, "No warnings"),
    "",
    "### Missing References",
    "",
    markdownList(evidenceContext.missingReferences.map(missingReferenceText), "No missing references")
  ].join("\n");
}

export function buildReviewEvidencePromptSection(evidenceContext: ReviewEvidenceContext): string {
  const direct = evidenceContext.directTargetEvidence.map(toEvidenceLine);
  const period = evidenceContext.periodEvidence.map(toEvidenceLine);
  const indirect = evidenceContext.indirectEvidence.map(toEvidenceLine);
  const derived = evidenceContext.derivedOutputEvidence.map(toEvidenceLine);
  const existing = evidenceContext.existingReviewContentEvidence.map(toEvidenceLine);

  return [
    "## Review Evidence Context",
    "",
    "### Scope",
    "",
    formatScopeSummary(evidenceContext.scopeSummary),
    "",
    "### Evidence Stats",
    "",
    markdownList([
      `directTargetEvidenceCount: ${evidenceContext.stats.directTargetEvidenceCount}`,
      `periodEvidenceCount: ${evidenceContext.stats.periodEvidenceCount}`,
      `indirectEvidenceCount: ${evidenceContext.stats.indirectEvidenceCount}`,
      `derivedOutputEvidenceCount: ${evidenceContext.stats.derivedOutputEvidenceCount}`,
      `existingReviewContentEvidenceCount: ${evidenceContext.stats.existingReviewContentEvidenceCount}`,
      `taskEvidenceCount: ${evidenceContext.stats.taskEvidenceCount}`,
      `experimentEvidenceCount: ${evidenceContext.stats.experimentEvidenceCount}`,
      `literatureEvidenceCount: ${evidenceContext.stats.literatureEvidenceCount}`,
      `outputEvidenceCount: ${evidenceContext.stats.outputEvidenceCount}`,
      `warningCount: ${evidenceContext.stats.warningCount}`,
      `missingReferenceCount: ${evidenceContext.stats.missingReferenceCount}`,
      `partialEvidenceCount: ${evidenceContext.stats.partialEvidenceCount}`
    ]),
    "",
    "### Direct Target Evidence",
    "",
    formatEvidenceLines(direct, "No direct target evidence"),
    "",
    "### Period Evidence",
    "",
    formatEvidenceLines(period, "No period evidence"),
    "",
    "### Indirect Cross-Module Evidence",
    "",
    formatEvidenceLines(indirect, "No indirect cross-module evidence"),
    "",
    "### Derived Output Evidence",
    "",
    formatEvidenceLines(derived, "No derived output evidence"),
    "",
    "### Existing Review Content",
    "",
    formatEvidenceLines(existing, "No existing Review content evidence")
  ].join("\n");
}

export async function buildReviewAggregationAiContext(
  reviewId: EntityId
): Promise<ReviewAiContext | null> {
  const context = await planningSelectorService.getReviewAggregationContext(reviewId);
  if (!context) return null;
  if (!context.evidenceContext) return buildSourceContextMissingContext("review_aggregation", context);
  return buildReviewAiContext("review_aggregation", context, context.evidenceContext);
}

export async function buildReviewPeriodAiContext(
  options: ReviewPeriodContextOptions = {}
): Promise<ReviewAiContext> {
  const context = await planningSelectorService.getReviewPeriodContext(options);
  if (!context.evidenceContext) return buildSourceContextMissingContext("review_period", context);
  return buildReviewAiContext("review_period", context, context.evidenceContext);
}

export const reviewAiContextService = {
  buildReviewAggregationAiContext,
  buildReviewPeriodAiContext,
  buildReviewEvidencePromptSection,
  buildReviewEvidenceBoundarySection,
  buildReviewEvidenceLimitationsSection
};

export type ReviewAiContextService = typeof reviewAiContextService;
