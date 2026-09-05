import type {
  Finding,
  FindingStatus,
  OutputCandidate,
  OutputCandidateStatus,
  OutputGap,
  OutputGapStatus,
  ResultItem,
  ResultItemStatus
} from "../types/outputConversion";
import type { ResearchOutput, ResearchOutputStatus } from "../types/output";
import {
  normalizeStructuredSummary,
  type StructuredSummaryEntityType
} from "../types/outputStructuredSummary";

export { normalizeStructuredSummary } from "../types/outputStructuredSummary";

type FiveLayerEntity =
  | ResultItem
  | Finding
  | OutputCandidate
  | OutputGap
  | ResearchOutput;

const resultItemStatuses = new Set<ResultItemStatus>(["pending_review", "marked", "ignored"]);
const findingStatuses = new Set<FindingStatus>([
  "pending_confirmation",
  "confirmed",
  "needs_evidence",
  "abandoned"
]);
const candidateStatuses = new Set<OutputCandidateStatus>([
  "pending_evaluation",
  "needs_gap_resolution",
  "ready_for_formal",
  "converted"
]);
const gapStatuses = new Set<OutputGapStatus>([
  "pending",
  "task_created",
  "route_feedback_created",
  "resolved",
  "abandoned"
]);
const researchOutputStatuses = new Set<ResearchOutputStatus>(["draft", "organizing", "archived"]);

export function normalizeStatus(
  entityType: StructuredSummaryEntityType,
  input: unknown
):
  | ResultItemStatus
  | FindingStatus
  | OutputCandidateStatus
  | OutputGapStatus
  | ResearchOutputStatus {
  if (typeof input === "string") {
    if (entityType === "resultItem" && resultItemStatuses.has(input as ResultItemStatus)) {
      return input as ResultItemStatus;
    }
    if (entityType === "finding" && findingStatuses.has(input as FindingStatus)) {
      return input as FindingStatus;
    }
    if (entityType === "outputCandidate" && candidateStatuses.has(input as OutputCandidateStatus)) {
      return input as OutputCandidateStatus;
    }
    if (entityType === "outputGap" && gapStatuses.has(input as OutputGapStatus)) {
      return input as OutputGapStatus;
    }
    if (entityType === "researchOutput" && researchOutputStatuses.has(input as ResearchOutputStatus)) {
      return input as ResearchOutputStatus;
    }
  }

  if (entityType === "finding") {
    if (input === "validated" || input === "ready_for_output") return "confirmed";
    if (input === "ignored") return "abandoned";
    return "pending_confirmation";
  }
  if (entityType === "outputCandidate") {
    if (input === "ready") return "ready_for_formal";
    if (input === "converted") return "converted";
    return "pending_evaluation";
  }
  if (entityType === "outputGap") {
    if (input === "linked_to_task") return "task_created";
    if (input === "linked_to_route") return "route_feedback_created";
    if (input === "resolved") return "resolved";
    if (input === "ignored") return "abandoned";
    return "pending";
  }
  if (entityType === "researchOutput") {
    return "draft";
  }
  if (entityType === "resultItem") {
    if (input === "ignored") return "ignored";
    if (input === "marked") return "marked";
    return "pending_review";
  }
  return "pending_review";
}

export function normalizeFiveLayerEntity<T extends Partial<FiveLayerEntity>>(
  entityType: StructuredSummaryEntityType,
  entity: T
): T {
  const normalized = {
    ...entity,
    status: normalizeStatus(entityType, (entity as { status?: unknown }).status),
    structuredSummary: normalizeStructuredSummary(
      entityType,
      (entity as { structuredSummary?: unknown }).structuredSummary
    )
  };
  return normalized as T;
}

export const outputFiveLayerContractService = {
  normalizeStatus,
  normalizeStructuredSummary,
  normalizeFiveLayerEntity
};
