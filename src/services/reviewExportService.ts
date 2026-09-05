import {
  buildReviewAggregationAiContext,
  buildReviewEvidenceBoundarySection,
  buildReviewEvidenceLimitationsSection,
  buildReviewEvidencePromptSection,
  buildReviewPeriodAiContext
} from "./reviewAiContextService";
import type { EntityId } from "../types";
import type { MissingEntityReference } from "../types/entityReference";
import type {
  ReviewAiContext,
  ReviewAiEvidenceLine,
  ReviewEvidenceContext,
  ReviewEvidenceLimitations,
  ReviewPeriodContextOptions
} from "../types/planningContext";

function valueOrUnset(value: unknown) {
  return value === undefined || value === null || value === "" ? "unset" : String(value);
}

function markdownList(items: string[], emptyText = "None") {
  const visibleItems = items.filter((item) => item.trim().length > 0);
  return visibleItems.length > 0
    ? visibleItems.map((item) => `- ${item}`).join("\n")
    : `- ${emptyText}`;
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

function formatScope(context: ReviewAiContext) {
  const scope = context.scopeSummary;
  return [
    `- Context kind: ${context.kind}`,
    `- Review ID: ${valueOrUnset(scope.reviewId)}`,
    `- Project ID: ${valueOrUnset(scope.projectId)}`,
    `- Scope: ${scope.scope}`,
    `- Period start: ${valueOrUnset(scope.period.start)}`,
    `- Period end: ${valueOrUnset(scope.period.end)}`,
    `- Period label: ${valueOrUnset(scope.period.label)}`,
    `- Target project IDs: ${scope.targetProjectIds.length > 0 ? scope.targetProjectIds.join(", ") : "none"}`,
    `- Target route node IDs: ${scope.targetRouteNodeIds.length > 0 ? scope.targetRouteNodeIds.join(", ") : "none"}`,
    `- Target task IDs: ${scope.targetTaskIds.length > 0 ? scope.targetTaskIds.join(", ") : "none"}`,
    `- Partial: ${context.partial ? "yes" : "no"}`,
    `- Source context missing: ${context.sourceContextMissing ? "yes" : "no"}`
  ].join("\n");
}

function formatEvidenceLine(line: ReviewAiEvidenceLine) {
  const base = [
    `${valueOrUnset(line.entityType)}:${valueOrUnset(line.entityId)}`,
    `sourceKind=${line.sourceKind}`,
    `role=${line.role}`,
    line.relationType ? `relation=${line.relationType}` : undefined,
    line.partial ? "partial=true" : undefined
  ].filter(Boolean);
  return [
    `${line.title} (${base.join(", ")})`,
    line.summary ? `  - summary: ${line.summary}` : undefined,
    `  - boundary: ${line.sourceBoundary}`,
    line.scopeSensitivity.length > 0
      ? `  - scopeSensitivity: ${line.scopeSensitivity.join(", ")}`
      : undefined,
    line.warnings.length > 0 ? `  - warnings: ${line.warnings.join("; ")}` : undefined,
    line.missingReferences.length > 0
      ? `  - missingReferences: ${line.missingReferences.map(missingReferenceText).join("; ")}`
      : undefined
  ]
    .filter((linePart): linePart is string => Boolean(linePart))
    .join("\n");
}

function formatEvidenceLines(lines: ReviewAiEvidenceLine[], emptyText = "No evidence records") {
  return markdownList(lines.map(formatEvidenceLine), emptyText);
}

export function formatReviewEvidenceContextMarkdown(evidenceContext: ReviewEvidenceContext): string {
  return [
    buildReviewEvidencePromptSection(evidenceContext),
    "",
    buildReviewEvidenceBoundarySection(evidenceContext),
    "",
    buildReviewEvidenceLimitationsSection(evidenceContext)
  ].join("\n");
}

export function formatReviewAiContextMarkdown(context: ReviewAiContext): string {
  return [
    `# ${context.title}`,
    "",
    "## Scope",
    "",
    formatScope(context),
    "",
    "## Evidence Boundary",
    "",
    `- Source kinds: ${context.evidenceBoundary.sourceKinds.join(", ")}`,
    `- Scope sensitivity: ${context.evidenceBoundary.scopeSensitivity.join(", ")}`,
    `- Source boundary: ${context.evidenceBoundary.sourceBoundary}`,
    `- Excludes local file bodies: ${context.evidenceBoundary.excludesLocalFileBodies ? "yes" : "no"}`,
    `- Excludes PDF full text: ${context.evidenceBoundary.excludesPdfFullText ? "yes" : "no"}`,
    `- Excludes experiment raw data: ${context.evidenceBoundary.excludesExperimentRawData ? "yes" : "no"}`,
    "",
    "## Direct Target Evidence",
    "",
    formatEvidenceLines(context.directTargetEvidence, "No direct target evidence"),
    "",
    "## Period Evidence",
    "",
    formatEvidenceLines(context.periodEvidence, "No period evidence"),
    "",
    "## Indirect Cross-Module Evidence",
    "",
    formatEvidenceLines(context.indirectCrossModuleEvidence, "No indirect cross-module evidence"),
    "",
    "## Derived Output Evidence",
    "",
    formatEvidenceLines(context.derivedOutputEvidence, "No derived output evidence"),
    "",
    "## Existing Review Content",
    "",
    formatEvidenceLines(context.existingReviewContentEvidence, "No existing Review content evidence"),
    "",
    "## Warnings And Missing References",
    "",
    "### Warnings",
    "",
    markdownList(context.warnings, "No warnings"),
    "",
    "### Missing References",
    "",
    markdownList(context.missingReferences.map(missingReferenceText), "No missing references"),
    "",
    "## Partial State And Limitations",
    "",
    `- Partial: ${context.partial ? "yes" : "no"}`,
    `- Partial reasons: ${context.partialReasons.length > 0 ? context.partialReasons.join(", ") : "none"}`,
    "",
    "### Limitations",
    "",
    markdownList(context.limitations.map(limitationText), "No limitations"),
    "",
    "## AI Usage Notes",
    "",
    markdownList(context.aiUsageNotes, "No AI usage notes")
  ].join("\n");
}

export async function exportReviewAggregationContextMarkdown(reviewId: EntityId): Promise<string> {
  const context = await buildReviewAggregationAiContext(reviewId);
  if (!context) {
    return "# Review Aggregation AI Context\n\nReview aggregation context was not found.";
  }
  return formatReviewAiContextMarkdown(context);
}

export async function exportReviewPeriodContextMarkdown(
  options: ReviewPeriodContextOptions = {}
): Promise<string> {
  return formatReviewAiContextMarkdown(await buildReviewPeriodAiContext(options));
}

export const reviewExportService = {
  exportReviewAggregationContextMarkdown,
  exportReviewPeriodContextMarkdown,
  formatReviewEvidenceContextMarkdown,
  formatReviewAiContextMarkdown
};

export type ReviewExportService = typeof reviewExportService;
