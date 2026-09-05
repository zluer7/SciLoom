import type {
  AIStandardResultEffectReceipt,
  AIStandardResultTarget,
  AIStandardResultValidationIssue
} from "../types/aiStandardResult";
import type { ManuscriptBinding } from "../types";
import type { SaveCandidateManuscriptResult } from "../types/candidateManuscript";
import { canonicalAIStandardResultFingerprint, AI_STANDARD_RESULT_MAX_PAYLOAD_CHARS } from "./aiStandardResultService";
import { fileRefService } from "./fileRefService";
import { resolveMountedManuscriptLifecycleDecision } from "./fileRefOwnerValidator";
import { parseLabPodMarkdownDocument } from "./labPodMarkdownDocumentService";
import { manuscriptBindingService } from "./manuscriptBindingService";
import { manuscriptIoService } from "./manuscriptIoService";
import { manuscriptListService } from "./manuscriptListService";
import { manuscriptRequestTokenController } from "./manuscriptRequestTokenController";
import { planningService } from "./planningService";
import { reviewCandidateService } from "./reviewCandidateService";
import { reviewManuscriptStructuredDataService } from "./reviewManuscriptStructuredDataService";

export const AI_REVIEW_NEW_MANUSCRIPT_BODY_MAX_CHARS = 6_000;
export const AI_REVIEW_NEW_MANUSCRIPT_ENCODING = "utf-8" as const;
export const AI_REVIEW_NEW_MANUSCRIPT_LINE_ENDING = "LF" as const;
export const AI_REVIEW_NEW_MANUSCRIPT_TERMINAL_NEWLINE = "one LF for the complete LabPod Markdown document" as const;

export type AIReviewManuscriptValidation = {
  executable: boolean;
  normalizedPayload: Record<string, unknown>;
  validationIssues: AIStandardResultValidationIssue[];
  targetSnapshotFingerprint?: string;
};

export type AIReviewManuscriptEffectOutcome =
  | { kind: "settled"; receipt: AIStandardResultEffectReceipt }
  | { kind: "pending"; code: string; message: string }
  | { kind: "no_effect_failure"; code: string; message: string };

export class AIReviewManuscriptReadbackPendingError extends Error {
  readonly effectMayExist = true;

  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AIReviewManuscriptReadbackPendingError";
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

function charCount(value: string): number {
  return Array.from(value).length;
}

/** LP12's serializer uses LF; CRLF is the only accepted, disclosed normalization. */
export function normalizeAIReviewCandidateBody(value: string): string {
  return value.replace(/\r\n/gu, "\n");
}

function bindingReadback(binding: ManuscriptBinding | undefined) {
  return binding ? {
    id: binding.id,
    ownerType: binding.ownerType,
    ownerId: binding.ownerId,
    manuscriptChannel: binding.manuscriptChannel,
    defaultFolderFileRefId: binding.defaultFolderFileRefId ?? null,
    defaultManuscriptFileRefId: binding.defaultManuscriptFileRefId ?? null,
    currentFileRefId: binding.currentFileRefId ?? null,
    updatedAt: binding.updatedAt
  } : null;
}

async function targetState(input: {
  target: Extract<AIStandardResultTarget, { module: "review" }>;
  expectedProjectId: string;
  issues: AIStandardResultValidationIssue[];
}) {
  const review = input.target.entityId
    ? await planningService.getReviewById(input.target.entityId)
    : undefined;
  if (!review || review.deletedAt || review.structuredLifecycleStatus === "deleted" ||
      review.structuredLifecycleStatus === "permanently_deleted") {
    input.issues.push(issue("REVIEW_MANUSCRIPT_OWNER_UNAVAILABLE", "The canonical Review owner is missing or deleted."));
    return { review: undefined, binding: undefined };
  }
  if (review.projectId !== input.expectedProjectId || input.target.projectId !== input.expectedProjectId) {
    input.issues.push(issue("REVIEW_MANUSCRIPT_SCOPE_MISMATCH", "The Review manuscript target crosses the reviewed Project."));
  }
  const project = await planningService.getProjectById(input.expectedProjectId);
  if (!project || project.deletedAt || project.status === "archived") {
    input.issues.push(issue("REVIEW_MANUSCRIPT_PROJECT_UNAVAILABLE", "The Review Project is unavailable for a new candidate."));
  }
  try {
    const lifecycle = await resolveMountedManuscriptLifecycleDecision({
      ownerType: "review",
      ownerId: review.id,
      manuscriptChannel: "primary"
    });
    if (!lifecycle.canProvision || !lifecycle.canSaveAs || lifecycle.readOnly) {
      input.issues.push(issue("REVIEW_MANUSCRIPT_LIFECYCLE_INELIGIBLE", "The current Review lifecycle does not allow candidate creation."));
    }
  } catch (error) {
    input.issues.push(issue(
      "REVIEW_MANUSCRIPT_LIFECYCLE_INELIGIBLE",
      error instanceof Error ? error.message : "The Review manuscript lifecycle could not be resolved."
    ));
  }
  const structured = await reviewManuscriptStructuredDataService.get(review.id);
  if (structured.status === "error") {
    input.issues.push(issue("REVIEW_MANUSCRIPT_STRUCTURED_OWNER_INVALID", structured.error.message));
  }
  let binding: ManuscriptBinding | undefined;
  try {
    binding = await manuscriptBindingService.getBindingByOwner("review", review.id, "primary");
  } catch (error) {
    input.issues.push(issue(
      "REVIEW_MANUSCRIPT_BINDING_CONFLICT",
      error instanceof Error ? error.message : "The canonical Review/primary Binding is ambiguous."
    ));
  }
  return { review, binding };
}

function targetFingerprint(input: {
  review: NonNullable<Awaited<ReturnType<typeof planningService.getReviewById>>>;
  binding: ManuscriptBinding | undefined;
}) {
  return canonicalAIStandardResultFingerprint({
    review: {
      id: input.review.id,
      projectId: input.review.projectId,
      reviewType: input.review.reviewType,
      structuredRevision: input.review.structuredRevision ?? null,
      structuredLifecycleStatus: input.review.structuredLifecycleStatus ?? null,
      updatedAt: input.review.updatedAt,
      deletedAt: input.review.deletedAt ?? null
    },
    binding: bindingReadback(input.binding)
  });
}

export async function validateAIReviewManuscriptStandardResultProposal(input: {
  target: AIStandardResultTarget;
  payload: unknown;
  expectedProjectId: string;
  expectedTargetSnapshotFingerprint?: string;
}): Promise<AIReviewManuscriptValidation> {
  const issues: AIStandardResultValidationIssue[] = [];
  if (input.target.module !== "review" || input.target.entityType !== "review") {
    return {
      executable: false,
      normalizedPayload: {},
      validationIssues: [issue("NEW_MANUSCRIPT_TARGET_UNSUPPORTED", "NEW_MANUSCRIPT is executable only for an existing canonical Review/primary target.")]
    };
  }
  if (!input.target.entityId) {
    issues.push(issue("NEW_MANUSCRIPT_REVIEW_REQUIRED", "NEW_MANUSCRIPT requires an existing canonical Review identity.", "target.entityId"));
  }
  if (input.target.manuscriptChannel !== "primary") {
    issues.push(issue("NEW_MANUSCRIPT_CHANNEL_INVALID", "Review NEW_MANUSCRIPT requires the fixed primary channel.", "target.manuscriptChannel"));
  }
  const payload = asRecord(input.payload);
  let body: string | undefined;
  if (!payload || Object.keys(payload).length !== 1 || !("body" in payload)) {
    issues.push(issue("NEW_MANUSCRIPT_PAYLOAD_INVALID", "The visible manuscript payload requires exactly one editable body field."));
  } else if (
    typeof payload.body !== "string" || !payload.body.trim() || payload.body.includes("\0") ||
    payload.body.replace(/\r\n/gu, "").includes("\r") ||
    charCount(payload.body) > AI_REVIEW_NEW_MANUSCRIPT_BODY_MAX_CHARS
  ) {
    issues.push(issue(
      "NEW_MANUSCRIPT_BODY_INVALID",
      `body must contain 1-${AI_REVIEW_NEW_MANUSCRIPT_BODY_MAX_CHARS} Unicode characters, no NUL, and only LF/CRLF line endings.`,
      "body"
    ));
  } else {
    body = normalizeAIReviewCandidateBody(payload.body);
    if (charCount(JSON.stringify({ body })) > AI_STANDARD_RESULT_MAX_PAYLOAD_CHARS) {
      issues.push(issue(
        "NEW_MANUSCRIPT_SHARED_PAYLOAD_LIMIT",
        `The serialized visible payload exceeds the shared ${AI_STANDARD_RESULT_MAX_PAYLOAD_CHARS}-character Standard Result bound.`,
        "body"
      ));
    }
  }
  const state = await targetState({
    target: input.target,
    expectedProjectId: input.expectedProjectId,
    issues
  });
  const currentFingerprint = state.review
    ? targetFingerprint({ review: state.review, binding: state.binding })
    : undefined;
  if (input.expectedTargetSnapshotFingerprint && currentFingerprint !== input.expectedTargetSnapshotFingerprint) {
    issues.push(issue("REVIEW_MANUSCRIPT_TARGET_STALE", "The Review/primary lifecycle or Binding changed after Parse Draft; re-parse is required."));
  }
  return {
    executable: issues.length === 0,
    normalizedPayload: body === undefined ? {} : { body },
    validationIssues: issues,
    ...(currentFingerprint ? { targetSnapshotFingerprint: currentFingerprint } : {})
  };
}

async function readCurrentIfPresent(reviewId: string, binding: ManuscriptBinding | undefined) {
  if (!binding?.currentFileRefId) return undefined;
  const current = await manuscriptIoService.readCurrentManuscript("review", reviewId, {
    manuscriptChannel: "primary"
  });
  if (current.status === "error") {
    throw new AIReviewManuscriptReadbackPendingError(
      "NEW_MANUSCRIPT_CURRENT_READBACK_UNAVAILABLE",
      "The existing current manuscript could not be read for preservation verification."
    );
  }
  return {
    fileRefId: current.fileRefId,
    content: current.content,
    encoding: current.encoding
  };
}

async function candidateReceipt(input: {
  target: Extract<AIStandardResultTarget, { module: "review" }>;
  resultId: string;
  normalizedBody: string;
  beforeBinding?: ManuscriptBinding;
  beforeCurrent?: Awaited<ReturnType<typeof readCurrentIfPresent>>;
  candidateResult?: SaveCandidateManuscriptResult;
}): Promise<AIStandardResultEffectReceipt | undefined> {
  const reviewId = input.target.entityId!;
  const requestRefs = await fileRefService.getCandidateFileRefsByRequestId("review", reviewId, input.resultId);
  const activeRefs = requestRefs.filter((fileRef) => !fileRef.deletedAt);
  if (requestRefs.length === 0) return undefined;
  if (requestRefs.length !== 1 || activeRefs.length !== 1) {
    throw new AIReviewManuscriptReadbackPendingError(
      "NEW_MANUSCRIPT_CANDIDATE_IDENTITY_CONFLICT",
      "The bound candidate request does not resolve to exactly one active FileRef."
    );
  }
  const fileRef = activeRefs[0];
  if (
    fileRef.ownerType !== "review" || fileRef.ownerId !== reviewId ||
    fileRef.resourceKind !== "file" || fileRef.fileRole !== "manuscript" ||
    fileRef.manuscriptChannel !== "primary" || fileRef.locationMode !== "managed" ||
    fileRef.candidateRequestId !== input.resultId || fileRef.source !== "ai"
  ) {
    throw new AIReviewManuscriptReadbackPendingError(
      "NEW_MANUSCRIPT_FILE_REF_MISMATCH",
      "The candidate FileRef does not match the canonical Review/primary operation identity."
    );
  }
  const available = await manuscriptListService.getAvailableManuscripts("review", reviewId, "primary");
  if (available.status !== "success" || !available.items.some((item) => item.fileRefId === fileRef.id)) {
    throw new AIReviewManuscriptReadbackPendingError(
      "NEW_MANUSCRIPT_NOT_DISCOVERABLE",
      "The physical/FileRef candidate is not visible through the canonical manuscript read model."
    );
  }
  const physical = await manuscriptIoService.readManuscriptByFileRef("review", reviewId, fileRef.id, {
    manuscriptChannel: "primary"
  });
  if (physical.status === "error") {
    throw new AIReviewManuscriptReadbackPendingError(
      "NEW_MANUSCRIPT_PHYSICAL_READBACK_UNAVAILABLE",
      "The candidate physical Markdown could not be read through the canonical manuscript reader."
    );
  }
  const parsed = parseLabPodMarkdownDocument(physical.content);
  if ((parsed.status !== "valid" && parsed.status !== "valid-empty") || parsed.body !== input.normalizedBody) {
    throw new AIReviewManuscriptReadbackPendingError(
      "NEW_MANUSCRIPT_BODY_CORRELATION_FAILED",
      "The canonical candidate BODY does not match the latest confirmed visible Markdown body."
    );
  }
  const afterBinding = await manuscriptBindingService.getBindingByOwner("review", reviewId, "primary");
  if (!afterBinding) {
    throw new AIReviewManuscriptReadbackPendingError(
      "NEW_MANUSCRIPT_BINDING_READBACK_UNAVAILABLE",
      "The canonical Review/primary Binding is unavailable after candidate creation."
    );
  }
  let firstProvisioningDisposition = "NOT_APPLICABLE_WITH_EXISTING_BINDING";
  if (input.beforeBinding) {
    if (
      afterBinding.id !== input.beforeBinding.id ||
      afterBinding.defaultFolderFileRefId !== input.beforeBinding.defaultFolderFileRefId ||
      afterBinding.defaultManuscriptFileRefId !== input.beforeBinding.defaultManuscriptFileRefId ||
      afterBinding.currentFileRefId !== input.beforeBinding.currentFileRefId ||
      afterBinding.updatedAt !== input.beforeBinding.updatedAt
    ) {
      throw new AIReviewManuscriptReadbackPendingError(
        "NEW_MANUSCRIPT_BINDING_MUTATED",
        "Candidate creation unexpectedly changed the existing Review/primary Binding."
      );
    }
  } else {
    firstProvisioningDisposition = "LP12_CANONICAL_FIRST_PROVISIONING_INITIALIZATION";
    if (
      afterBinding.currentFileRefId === fileRef.id ||
      afterBinding.defaultManuscriptFileRefId === fileRef.id
    ) {
      throw new AIReviewManuscriptReadbackPendingError(
        "NEW_MANUSCRIPT_CANDIDATE_BECAME_CURRENT_OR_DEFAULT",
        "The new candidate must remain separate from LP12 first-provisioning current/default initialization."
      );
    }
  }
  if (input.beforeCurrent) {
    const afterCurrent = await readCurrentIfPresent(reviewId, afterBinding);
    if (
      !afterCurrent || afterCurrent.fileRefId !== input.beforeCurrent.fileRefId ||
      afterCurrent.content !== input.beforeCurrent.content
    ) {
      throw new AIReviewManuscriptReadbackPendingError(
        "NEW_MANUSCRIPT_CURRENT_BODY_MUTATED",
        "Candidate creation unexpectedly changed the existing current manuscript body."
      );
    }
  }
  return {
    module: "review",
    entityType: "fileRef",
    entityId: fileRef.id,
    operation: "NEW_MANUSCRIPT",
    service: "reviewCandidateService.saveCandidate",
    canonicalReadback: {
      projectId: input.target.projectId,
      reviewId,
      manuscriptChannel: "primary",
      operationId: input.resultId,
      candidateRequestId: fileRef.candidateRequestId,
      fileRefId: fileRef.id,
      resourceKind: fileRef.resourceKind,
      fileRole: fileRef.fileRole,
      locationMode: fileRef.locationMode,
      pathIdentityKey: fileRef.pathIdentityKey,
      displayName: available.items.find((item) => item.fileRefId === fileRef.id)?.displayName ?? fileRef.title,
      physicalEncoding: physical.encoding,
      physicalSizeBytes: physical.sizeBytes,
      physicalBodyFingerprint: canonicalAIStandardResultFingerprint(parsed.body),
      confirmedBodyFingerprint: canonicalAIStandardResultFingerprint(input.normalizedBody),
      bodyNormalization: "CRLF_TO_LF",
      documentLineEnding: AI_REVIEW_NEW_MANUSCRIPT_LINE_ENDING,
      documentTerminalNewline: AI_REVIEW_NEW_MANUSCRIPT_TERMINAL_NEWLINE,
      bindingBefore: bindingReadback(input.beforeBinding),
      bindingAfter: bindingReadback(afterBinding),
      firstProvisioningDisposition,
      candidateStatus: input.candidateResult?.status ?? "restart_readback",
      currentChanged: false,
      formalSwitchInvoked: false
    }
  };
}

function noEffectFailure(result: SaveCandidateManuscriptResult): boolean {
  return result.status === "error" && !result.retryable && !result.createdFile &&
    !result.createdFileRef && result.completedSteps.length === 0;
}

export async function readAIReviewManuscriptStandardResultEffect(input: {
  target: Extract<AIStandardResultTarget, { module: "review" }>;
  resultId: string;
  normalizedBody: string;
}): Promise<AIStandardResultEffectReceipt | undefined> {
  return candidateReceipt({
    target: input.target,
    resultId: input.resultId,
    normalizedBody: input.normalizedBody
  });
}

export async function invokeAIReviewManuscriptStandardResultEffect(input: {
  target: Extract<AIStandardResultTarget, { module: "review" }>;
  normalizedPayload: Record<string, unknown>;
  resultId: string;
  occurredAt: string;
}): Promise<AIReviewManuscriptEffectOutcome> {
  const normalizedBody = input.normalizedPayload.body as string;
  try {
    const prior = await readAIReviewManuscriptStandardResultEffect({
      target: input.target,
      resultId: input.resultId,
      normalizedBody
    });
    if (prior) return { kind: "settled", receipt: prior };
  } catch (error) {
    if (error instanceof AIReviewManuscriptReadbackPendingError) {
      return { kind: "pending", code: error.code, message: error.message };
    }
    return {
      kind: "pending",
      code: "NEW_MANUSCRIPT_READBACK_UNKNOWN",
      message: error instanceof Error ? error.message : "The bound candidate readback is unknown."
    };
  }
  const reviewId = input.target.entityId!;
  const beforeBinding = await manuscriptBindingService.getBindingByOwner("review", reviewId, "primary");
  let beforeCurrent: Awaited<ReturnType<typeof readCurrentIfPresent>>;
  try {
    beforeCurrent = await readCurrentIfPresent(reviewId, beforeBinding);
  } catch (error) {
    return {
      kind: "pending",
      code: error instanceof AIReviewManuscriptReadbackPendingError ? error.code : "NEW_MANUSCRIPT_CURRENT_READBACK_UNKNOWN",
      message: error instanceof Error ? error.message : "The current manuscript preservation baseline is unavailable."
    };
  }
  const candidate = await reviewCandidateService.saveCandidate({
    reviewId,
    source: "ai",
    occurredAt: input.occurredAt,
    candidateRequestId: input.resultId,
    content: normalizedBody,
    confirmedByUser: true,
    requestToken: manuscriptRequestTokenController.begin()
  });
  if (candidate.status !== "success" && candidate.status !== "skipped") {
    const message = candidate.errors.map((error) => error.message).join("; ") ||
      "The canonical LP12 candidate operation did not reach success readback.";
    return noEffectFailure(candidate)
      ? { kind: "no_effect_failure", code: candidate.errors[0]?.code ?? "NEW_MANUSCRIPT_NO_EFFECT", message }
      : { kind: "pending", code: candidate.errors[0]?.code ?? "NEW_MANUSCRIPT_EFFECT_PENDING", message };
  }
  try {
    const receipt = await candidateReceipt({
      target: input.target,
      resultId: input.resultId,
      normalizedBody,
      beforeBinding,
      beforeCurrent,
      candidateResult: candidate
    });
    return receipt
      ? { kind: "settled", receipt }
      : { kind: "pending", code: "NEW_MANUSCRIPT_READBACK_MISSING", message: "The canonical candidate result has no complete authoritative readback yet." };
  } catch (error) {
    return {
      kind: "pending",
      code: error instanceof AIReviewManuscriptReadbackPendingError ? error.code : "NEW_MANUSCRIPT_READBACK_UNKNOWN",
      message: error instanceof Error ? error.message : "The canonical candidate readback is incomplete."
    };
  }
}
