import type { EntityId, ISODateString } from "../types/common";
import type { ReviewOutlineSection, ReviewType } from "../types/planning";
import type { SaveCandidateManuscriptResult } from "../types/candidateManuscript";
import {
  getReviewDetailContext,
  type ReviewDetailContext,
  type ReviewObjectSummary,
  type ReviewMetricSummary,
  type ReviewDerivedEvidenceSummary
} from "./reviewSelectorService";
import { reviewCandidateService } from "./reviewCandidateService";
import { reviewCurrentFilenameService } from "./reviewCurrentFilenameService";
import { reviewManuscriptAdapterService } from "./reviewManuscriptAdapterService";
import { manuscriptRequestTokenController } from "./manuscriptRequestTokenController";

export type ReviewAiDraftType = "review_candidate";

export interface ReviewAiSafeWarning {
  code: string;
  message: string;
}

export interface ReviewAiSafeProvenance {
  sourceType: string;
  relation?: string;
  confidence: string;
}

export interface ReviewAiObjectSummary {
  type: ReviewObjectSummary["targetType"];
  title: string;
  status?: string;
  summary?: string;
  sourceBoundary: string;
  missing: boolean;
  partial: boolean;
}

export interface ReviewAiMetricSummary {
  metricName: string;
  value?: unknown;
  unit?: string;
  notePreview?: string;
  sourceBoundary: string;
}

export interface ReviewAiDerivedEvidenceSummary {
  type: ReviewDerivedEvidenceSummary["evidenceType"];
  title: string;
  status?: string;
  sourceBoundary: "contextualEvidence" | "derivedEvidence";
}

export interface ReviewAiAuthorizedCurrentBody {
  content: string;
  filename: string;
  includedPolicy: "explicit_current_body_one_shot";
  authorization: {
    userSelected: true;
    userConfirmed: true;
    persistent: false;
  };
  requestToken: number;
}

export interface ReviewAiReadyContext {
  status: "ready";
  safeForAi: true;
  generatedAt: ISODateString;
  review: {
    title: string;
    description?: string;
    reviewType: ReviewType;
    periodLabel?: string;
    periodStart?: string;
    periodEnd?: string;
    tags: string[];
    deletedState: "active";
  };
  project?: ReviewAiObjectSummary;
  formalTargets: ReviewAiObjectSummary[];
  outline: {
    sections: Array<{
      key: string;
      label: string;
      contentPreview: string;
      isEmpty: boolean;
      truncated: boolean;
    }>;
  };
  manuscript: {
    hasCurrentManuscript: boolean;
    currentFilename?: string;
    warning?: string;
    bodyIncludedByDefault: false;
  };
  authorizedCurrentBody?: ReviewAiAuthorizedCurrentBody;
  objectSummaries: ReviewAiObjectSummary[];
  metrics: ReviewAiMetricSummary[];
  derivedEvidence: ReviewAiDerivedEvidenceSummary[];
  warnings: ReviewAiSafeWarning[];
  missing: Array<{ type: string; relation?: string; message: string }>;
  partial: boolean;
  provenance: ReviewAiSafeProvenance[];
  completeness: ReviewDetailContext["completeness"];
  safetyNotes: string[];
}

export interface ReviewAiReadyContextBlocked {
  status: "blocked";
  safeForAi: false;
  generatedAt: ISODateString;
  reason:
    | "review_not_found"
    | "review_deleted"
    | "authorization_required"
    | "current_body_unavailable"
    | "stale_request";
  message: string;
  safetyNotes: string[];
}

export type ReviewAiReadyContextResult =
  | { ok: true; context: ReviewAiReadyContext }
  | { ok: false; blocked: ReviewAiReadyContextBlocked };

export interface ReviewAiDraftProposal {
  draftId: EntityId;
  reviewId: EntityId;
  draftType: "review_candidate";
  source: "ai";
  createdAt: ISODateString;
  proposedCandidate: { content: string };
  suggestions?: {
    summary?: string;
    warnings?: string[];
    nextActionsText?: string;
    questions?: string[];
    targetNotes?: string;
  };
  safetyNotes: string[];
  requiresUserConfirmation: true;
  canApplyAutomatically: false;
}

export interface ReviewAiDraftPreview {
  draftId: EntityId;
  reviewId: EntityId;
  draftType: "review_candidate";
  candidateContent: string;
  affectedArtifacts: ["reviewCandidate"] | [];
  canApply: boolean;
  requiresUserConfirmation: true;
  canApplyAutomatically: false;
  willNotModify: string[];
  safetyNotes: string[];
}

export interface ReviewAiDraftApplyResult {
  success: boolean;
  result: "written" | "blocked" | "failed";
  reviewId: EntityId;
  message: string;
  createdArtifacts: string[];
  skipped: string[];
  appliedAt: ISODateString;
  candidate?: SaveCandidateManuscriptResult;
}

const OUTLINE_PREVIEW_LIMIT = 360;
const SUMMARY_LIMIT = 240;
const LIST_LIMIT = 20;
const SAFETY_NOTES = [
  "Default Review AI context contains structured selector data and manuscript metadata only.",
  "No manuscript BODY, attachment content, PDF content, local path, FileRef ID, Binding ID, or managed root is included by default.",
  "Current BODY can be included only by an explicit one-shot selection and confirmation.",
  "AI output is a previewable Candidate and cannot update Review fields or current manuscript automatically."
];

function nowIso() {
  return new Date().toISOString();
}

function redact(value: unknown, maxChars: number) {
  const raw = (typeof value === "string" ? value : "")
    .replace(/[A-Za-z]:[\\/](?:[^\\/\s|`\"'<>]+[\\/]?)+/g, "[local path omitted]")
    .replace(/\/(?:Users|home)\/[^\s|`\"'<>]+/g, "[local path omitted]")
    .trim();
  const chars = Array.from(raw);
  return {
    value: chars.length > maxChars ? `${chars.slice(0, maxChars).join("")}...` : raw,
    truncated: chars.length > maxChars
  };
}

function safeObject(item: ReviewObjectSummary): ReviewAiObjectSummary {
  return {
    type: item.targetType,
    title: redact(item.title, SUMMARY_LIMIT).value,
    status: item.status,
    summary: redact(item.description, SUMMARY_LIMIT).value || undefined,
    sourceBoundary: item.sourceBoundary,
    missing: item.missing,
    partial: item.partial
  };
}

function safeMetric(item: ReviewMetricSummary): ReviewAiMetricSummary {
  return {
    metricName: redact(item.name, SUMMARY_LIMIT).value,
    value: item.value,
    unit: item.unit,
    notePreview: redact(item.description, SUMMARY_LIMIT).value || undefined,
    sourceBoundary: item.sourceBoundary
  };
}

function safeEvidence(item: ReviewDerivedEvidenceSummary): ReviewAiDerivedEvidenceSummary {
  return {
    type: item.evidenceType,
    title: redact(item.title, SUMMARY_LIMIT).value,
    status: item.status,
    sourceBoundary: item.sourceBoundary === "contextualEvidence" ? "contextualEvidence" : "derivedEvidence"
  };
}

function safeOutline(section: ReviewOutlineSection) {
  const content = redact(section.content, OUTLINE_PREVIEW_LIMIT);
  return {
    key: section.key,
    label: section.key.replace(/_/g, " "),
    contentPreview: content.value,
    isEmpty: !section.content.trim(),
    truncated: content.truncated
  };
}

function safeProvenance(context: ReviewDetailContext): ReviewAiSafeProvenance[] {
  const source = [
    ...(context.projectSummary?.provenance ?? []),
    ...context.directTargets.flatMap((item) => item.provenance),
    ...context.derivedEvidence.flatMap((item) => item.provenance)
  ];
  const seen = new Set<string>();
  return source.map((item) => ({
    sourceType: item.sourceType,
    relation: item.relation,
    confidence: item.confidence
  })).filter((item) => {
    const key = `${item.sourceType}:${item.relation ?? ""}:${item.confidence}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function blocked(
  reason: ReviewAiReadyContextBlocked["reason"],
  message: string,
  generatedAt = nowIso()
): ReviewAiReadyContextResult {
  return { ok: false, blocked: { status: "blocked", safeForAi: false, generatedAt, reason, message, safetyNotes: SAFETY_NOTES } };
}

export function buildReviewAiReadyContextFromDetailContext(
  context: ReviewDetailContext,
  options: {
    generatedAt?: ISODateString;
    manuscriptState?: ReviewAiReadyContext["manuscript"];
  } = {}
): ReviewAiReadyContextResult {
  const generatedAt = options.generatedAt ?? nowIso();
  if (context.review.deletedAt) return blocked("review_deleted", "Deleted Review is blocked from AI context.", generatedAt);
  const objectSummaries = context.directTargets.slice(0, LIST_LIMIT).map(safeObject);
  const metrics = context.directTargets.flatMap((item) => item.metrics ?? []).slice(0, LIST_LIMIT).map(safeMetric);
  return {
    ok: true,
    context: {
      status: "ready",
      safeForAi: true,
      generatedAt,
      review: {
        title: redact(context.review.title, SUMMARY_LIMIT).value,
        description: redact(context.review.description, SUMMARY_LIMIT).value || undefined,
        reviewType: context.review.reviewType,
        periodLabel: context.review.periodLabel,
        periodStart: context.review.periodStart,
        periodEnd: context.review.periodEnd,
        tags: context.review.tags.map((tag) => redact(tag, 80).value),
        deletedState: "active"
      },
      project: context.projectSummary ? safeObject(context.projectSummary) : undefined,
      formalTargets: objectSummaries,
      outline: { sections: context.review.outlineSections.map(safeOutline) },
      manuscript: options.manuscriptState ?? {
        hasCurrentManuscript: false,
        warning: "Current manuscript metadata was not resolved.",
        bodyIncludedByDefault: false
      },
      objectSummaries,
      metrics,
      derivedEvidence: context.derivedEvidence.slice(0, LIST_LIMIT).map(safeEvidence),
      warnings: context.warnings.map((item) => ({ code: item.code, message: redact(item.message, SUMMARY_LIMIT).value })),
      missing: context.missing.map((item) => ({
        type: item.refType,
        relation: item.source,
        message: redact(item.message, SUMMARY_LIMIT).value
      })),
      partial: context.partial,
      provenance: safeProvenance(context),
      completeness: context.completeness,
      safetyNotes: SAFETY_NOTES
    }
  };
}

export async function buildReviewAiReadyContext(reviewId: EntityId): Promise<ReviewAiReadyContextResult> {
  const context = await getReviewDetailContext(reviewId);
  if (!context) return blocked("review_not_found", "Review was not found or is deleted.");
  const current = await reviewCurrentFilenameService.get(reviewId);
  return buildReviewAiReadyContextFromDetailContext(context, {
    manuscriptState: current.status === "ready"
      ? { hasCurrentManuscript: true, currentFilename: current.filename, bodyIncludedByDefault: false }
      : { hasCurrentManuscript: false, warning: current.error.message, bodyIncludedByDefault: false }
  });
}

export async function buildReviewAiContextWithExplicitCurrentBody(input: {
  reviewId: EntityId;
  userSelectedCurrentBody: boolean;
  userConfirmed: boolean;
  requestToken: number;
  readCurrent?: typeof reviewManuscriptAdapterService.readCurrentForContext;
  isRequestCurrent?: (token: number) => boolean;
  buildBase?: (reviewId: EntityId) => Promise<ReviewAiReadyContextResult>;
}): Promise<ReviewAiReadyContextResult> {
  if (!input.userSelectedCurrentBody || !input.userConfirmed) {
    return blocked("authorization_required", "Current BODY requires explicit selection and confirmation for this request.");
  }
  const base = await (input.buildBase ?? buildReviewAiReadyContext)(input.reviewId);
  if (!base.ok) return base;
  const isCurrent = input.isRequestCurrent ?? manuscriptRequestTokenController.isCurrent;
  if (!isCurrent(input.requestToken)) return blocked("stale_request", "Current BODY authorization request is stale.");
    const read = await (
      input.readCurrent ?? reviewManuscriptAdapterService.readCurrentForContext
    )(input.reviewId, input.requestToken);
  if (read.status === "error") return blocked("current_body_unavailable", read.error.message);
  if (!isCurrent(input.requestToken)) return blocked("stale_request", "Current BODY read completed for a stale request.");
  return {
    ok: true,
    context: {
      ...base.context,
      manuscript: {
        hasCurrentManuscript: true,
        currentFilename: read.document.filename,
        bodyIncludedByDefault: false
      },
      authorizedCurrentBody: {
        content: read.document.body,
        filename: read.document.filename,
        includedPolicy: "explicit_current_body_one_shot",
        authorization: { userSelected: true, userConfirmed: true, persistent: false },
        requestToken: input.requestToken
      }
    }
  };
}

export function createReviewAiDraftProposal(
  input: Omit<ReviewAiDraftProposal, "source" | "createdAt" | "requiresUserConfirmation" | "canApplyAutomatically" | "safetyNotes"> & {
    createdAt?: ISODateString;
    safetyNotes?: string[];
  }
): ReviewAiDraftProposal {
  return {
    ...input,
    source: "ai",
    createdAt: input.createdAt ?? nowIso(),
    safetyNotes: input.safetyNotes ?? SAFETY_NOTES,
    requiresUserConfirmation: true,
    canApplyAutomatically: false
  };
}

export function buildReviewAiDraftPreview(proposal: ReviewAiDraftProposal): ReviewAiDraftPreview {
  const canApply = Boolean(proposal.proposedCandidate.content.trim());
  return {
    draftId: proposal.draftId,
    reviewId: proposal.reviewId,
    draftType: "review_candidate",
    candidateContent: proposal.proposedCandidate.content,
    affectedArtifacts: canApply ? ["reviewCandidate"] : [],
    canApply,
    requiresUserConfirmation: true,
    canApplyAutomatically: false,
    willNotModify: [
      "Review fields", "outlineSections", "formal targets", "default manuscript",
      "current manuscript", "attachments", "physical existing files"
    ],
    safetyNotes: proposal.safetyNotes
  };
}

export async function applyReviewAiDraftProposal(input: {
  proposal: ReviewAiDraftProposal;
  userConfirmed: boolean;
  requestToken: number;
  appliedAt?: ISODateString;
  saveCandidate?: typeof reviewCandidateService.saveCandidate;
}): Promise<ReviewAiDraftApplyResult> {
  const appliedAt = input.appliedAt ?? nowIso();
  const preview = buildReviewAiDraftPreview(input.proposal);
  if (!input.userConfirmed || !preview.canApply) {
    return {
      success: false,
      result: "blocked",
      reviewId: input.proposal.reviewId,
      message: input.userConfirmed ? "Review Candidate content is empty." : "User confirmation is required before Candidate save.",
      createdArtifacts: [],
      skipped: [input.userConfirmed ? "candidate_empty" : "user_confirmation_required"],
      appliedAt
    };
  }
  const candidate = await (input.saveCandidate ?? reviewCandidateService.saveCandidate)({
    reviewId: input.proposal.reviewId,
    source: "ai",
    occurredAt: input.proposal.createdAt,
    candidateRequestId: input.proposal.draftId,
    content: input.proposal.proposedCandidate.content,
    confirmedByUser: true,
    requestToken: input.requestToken
  });
  const success = candidate.status === "success" || candidate.status === "skipped";
  return {
    success,
    result: success ? "written" : candidate.status === "partial" ? "failed" : "failed",
    reviewId: input.proposal.reviewId,
    message: success
      ? `Review AI Candidate saved as ${candidate.fileName}; current manuscript was not changed.`
      : candidate.errors.map((error) => error.message).join("; ") || "Review AI Candidate save failed.",
    createdArtifacts: success ? ["reviewCandidate"] : [],
    skipped: success ? ["review_update", "current_switch"] : [],
    appliedAt,
    candidate
  };
}

export const reviewAiReadyContextService = {
  buildReviewAiReadyContext,
  buildReviewAiReadyContextFromDetailContext,
  buildReviewAiContextWithExplicitCurrentBody,
  createReviewAiDraftProposal,
  buildReviewAiDraftPreview,
  applyReviewAiDraftProposal
};
