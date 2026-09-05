import { invoke } from "@tauri-apps/api/core";
import type {
  EntityId,
  ReviewOutlineSection,
  ReviewType
} from "../types/planning";
import {
  normalizeReviewType,
  reconcileReviewOutlineSections
} from "./reviewCoreContractService";

export type ReviewStructuredLifecycleStatus =
  | "active"
  | "deleted"
  | "permanently_deleted"
  | "transition_pending";

export interface ReviewStructuredStateRecord {
  reviewId: EntityId;
  reviewType: ReviewType;
  descriptorIdentity: string;
  outlineSections: ReviewOutlineSection[];
  structuredRevision: number;
  lifecycleEvidence: string;
  lifecycleStatus: ReviewStructuredLifecycleStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewStructuredStateSeed {
  reviewId: EntityId;
  reviewType: ReviewType;
  outlineSections: ReviewOutlineSection[];
}

export interface ReplaceReviewStructuredStateInput
  extends ReviewStructuredStateSeed {
  expectedStructuredRevision: number;
  expectedDescriptorIdentity: string;
  expectedLifecycleEvidence: string;
}

export class ReviewStructuredStateError extends Error {
  constructor(readonly code: string, cause?: unknown) {
    super(code);
    this.name = "ReviewStructuredStateError";
    if (cause !== undefined) {
      Object.defineProperty(this, "cause", { configurable: true, value: cause });
    }
  }
}

const REVIEW_DESCRIPTOR_IDENTITY_PATTERN =
  /^review\/primary\/(?:stage|periodic|experiment_comparison|literature_comparison|custom)\/v1$/u;
const REVIEW_STRUCTURED_LIFECYCLE_STATUSES = new Set<ReviewStructuredLifecycleStatus>([
  "active",
  "deleted",
  "permanently_deleted",
  "transition_pending"
]);

export function reviewDescriptorIdentity(reviewType: ReviewType) {
  return `review/primary/${reviewType}/v1` as const;
}

function seed(input: ReviewStructuredStateSeed): ReviewStructuredStateSeed {
  const reviewType = normalizeReviewType(input.reviewType);
  return {
    reviewId: input.reviewId,
    reviewType,
    outlineSections: reconcileReviewOutlineSections(
      reviewType,
      input.outlineSections
    )
  };
}

function stableError(error: unknown) {
  return typeof error === "string"
    ? error
    : error instanceof Error
      ? error.message
      : String(error);
}

async function invokeStructured<T>(
  command: string,
  args: Record<string, unknown>
): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    const message = stableError(error);
    const code = message.split(":", 1)[0] || "REVIEW_STRUCTURED_STATE_UNAVAILABLE";
    throw new ReviewStructuredStateError(code, error);
  }
}

function assertRecord(record: ReviewStructuredStateRecord) {
  const expectedType = normalizeReviewType(record.reviewType);
  const expectedSections = reconcileReviewOutlineSections(
    expectedType,
    record.outlineSections
  );
  if (
    record.reviewType !== expectedType ||
    !record.reviewId?.trim() ||
    record.descriptorIdentity !== reviewDescriptorIdentity(expectedType) ||
    !Number.isSafeInteger(record.structuredRevision) ||
    record.structuredRevision < 0 ||
    JSON.stringify(record.outlineSections) !== JSON.stringify(expectedSections) ||
    !record.lifecycleEvidence ||
    !REVIEW_STRUCTURED_LIFECYCLE_STATUSES.has(record.lifecycleStatus) ||
    !record.createdAt ||
    !record.updatedAt
  ) {
    throw new ReviewStructuredStateError("REVIEW_STRUCTURED_STATE_READBACK_INVALID");
  }
  return record;
}

export async function migrateLegacyReviewStructuredStates(
  inputs: ReviewStructuredStateSeed[]
): Promise<ReviewStructuredStateRecord[]> {
  if (inputs.length === 0) return [];
  const records = await invokeStructured<ReviewStructuredStateRecord[]>(
    "migrate_review_structured_states",
    { inputs: inputs.map(seed) }
  );
  return records.map(assertRecord);
}

export async function provisionReviewStructuredState(
  input: ReviewStructuredStateSeed
): Promise<ReviewStructuredStateRecord> {
  return assertRecord(
    await invokeStructured<ReviewStructuredStateRecord>(
      "provision_review_structured_state",
      { input: seed(input) }
    )
  );
}

export async function readReviewStructuredStates(
  reviewIds: EntityId[]
): Promise<ReviewStructuredStateRecord[]> {
  if (reviewIds.length === 0) return [];
  const records = await invokeStructured<ReviewStructuredStateRecord[]>(
    "read_review_structured_states",
    { reviewIds }
  );
  return records.map(assertRecord);
}

export async function replaceReviewStructuredState(
  input: ReplaceReviewStructuredStateInput
): Promise<ReviewStructuredStateRecord> {
  if (
    !Number.isSafeInteger(input.expectedStructuredRevision) ||
    input.expectedStructuredRevision < 0 ||
    !REVIEW_DESCRIPTOR_IDENTITY_PATTERN.test(input.expectedDescriptorIdentity) ||
    !input.expectedLifecycleEvidence
  ) {
    throw new ReviewStructuredStateError("REVIEW_STRUCTURED_EXPECTED_EVIDENCE_INVALID");
  }
  const normalized = seed(input);
  return assertRecord(
    await invokeStructured<ReviewStructuredStateRecord>(
      "replace_review_structured_state",
      {
        input: {
          ...normalized,
          expectedStructuredRevision: input.expectedStructuredRevision,
          expectedDescriptorIdentity: input.expectedDescriptorIdentity,
          expectedLifecycleEvidence: input.expectedLifecycleEvidence
        }
      }
    )
  );
}

export const reviewStructuredStateService = {
  migrateLegacyReviewStructuredStates,
  provisionReviewStructuredState,
  readReviewStructuredStates,
  replaceReviewStructuredState
};
