import type {
  AIConversationReadback,
  AITextStreamCompletedEvent
} from "../types";
import type {
  AIContextPackage,
  AIProviderPromptEnvelope,
  AIPromptPackage
} from "../types/aiContext";
import type {
  AIParseDraftSourceSnapshot,
  AIStandardResultWireProposal
} from "../types/aiStandardResult";
import {
  AI_PARSE_SEMANTIC_CORRECTION_BOUNDED_POLICY,
  hasAIConstraintProvenance,
  resolveAIActiveConstraintRequest
} from "./aiConstraintService";
import { buildAIPromptPackage } from "./aiPromptPackageService";
import {
  createAIStandardResultResponseContract,
  parseAIParseDraftOutcome,
  parseAIStandardResultBatchDecodedObject,
  readAIStandardResultManuscriptEffects,
  readAIStandardResultProposalMetadata,
  stripAIStandardResultManuscriptEffects,
  stripAIStandardResultProposalMetadata
} from "./aiStandardResultService";
import { validateAIStandardResultProposal } from "./aiStandardResultAdapterService";

export const AI_PARSE_SEMANTIC_CORRECTION_POLICY_ID =
  "PARSE_SEMANTIC_CORRECTION_V1" as const;

export const AI_PARSE_SEMANTIC_CORRECTION_IMPLEMENTATION_REVISION =
  "LP14_A1_C4_R1_THREE_ACTION_NESTED_EFFECT" as const;

export const AI_PARSE_SEMANTIC_CORRECTION_ELIGIBLE_REASON =
  "MISSING_CANONICAL_TOP_LEVEL_OUTCOME_DISCRIMINATOR" as const;

export type AIParseSemanticCorrectionIneligibleReason =
  | "NOT_PARSE_DRAFT_FIRST_ATTEMPT"
  | "PROVIDER_COMPLETION_INELIGIBLE"
  | "RAW_OUTPUT_UNAVAILABLE_OR_INVALID"
  | "MISSING_OUTCOME_NOT_SOLE_DEFECT"
  | "PROPOSAL_SEMANTICS_INCOMPLETE_OR_UNSAFE"
  | "DURABLE_FIRST_ATTEMPT_NOT_TRUTHFULLY_TERMINAL"
  | "PRIOR_CORRECTION_OR_RESULT_EXISTS";

export type AIParseSemanticCorrectionEligibility =
  | {
      eligible: true;
      reason: typeof AI_PARSE_SEMANTIC_CORRECTION_ELIGIBLE_REASON;
      firstProposalText: string;
    }
  | {
      eligible: false;
      reason: AIParseSemanticCorrectionIneligibleReason;
    };

type ProposalValidator = typeof validateAIStandardResultProposal;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return actual.length === canonical.length &&
    actual.every((key, index) => key === canonical[index]);
}

function expectedQuickParent(source: AIParseDraftSourceSnapshot): {
  target: Record<string, unknown>;
  channel: string;
} | null {
  const target = source.quickAnalysisTarget;
  if (!target || target.projectOrScopeId !== source.projectId) return null;
  const channelAllowed = target.ownerType === "literature"
    ? target.channel === "literature_outline" || target.channel === "dedicated_notes"
    : (target.ownerType === "review" || target.ownerType === "experiment" ||
      target.ownerType === "experimentRun") && target.channel === "primary";
  if (!channelAllowed) return null;
  return {
    target: {
      module: target.ownerType,
      projectId: source.projectId,
      entityType: target.ownerType,
      entityId: target.ownerId
    },
    channel: target.channel
  };
}

function exactRecord(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function hasCorrectionPolicy(readback: AIConversationReadback): boolean {
  return readback.callAttempts.some((attempt) =>
    attempt.contextSourceRefs.some((sourceRef) =>
      sourceRef.boundedPolicyDocuments?.some((identity) =>
        identity.documentId === AI_PARSE_SEMANTIC_CORRECTION_BOUNDED_POLICY.documentId &&
        identity.semanticVersion === AI_PARSE_SEMANTIC_CORRECTION_BOUNDED_POLICY.semanticVersion
      ) ?? false
    )
  );
}

async function proposalIsCompleteAndSafe(
  proposal: AIStandardResultWireProposal,
  source: AIParseDraftSourceSnapshot,
  validateProposal: ProposalValidator
): Promise<boolean> {
  const expectedParent = expectedQuickParent(source);
  const metadata = readAIStandardResultProposalMetadata(proposal.payload);
  const payload = stripAIStandardResultProposalMetadata(proposal.payload);
  const effects = readAIStandardResultManuscriptEffects(payload, {
    action: proposal.action,
    target: proposal.target
  });
  if (
    !expectedParent ||
    proposal.category !== "DATA_OPERATION" ||
    proposal.action !== "UPDATE" ||
    !exactRecord(proposal.target, expectedParent.target) ||
    !metadata || metadata.originalOrdinal !== 1 || Boolean(metadata.parentProposalRef) ||
    !exactKeys(payload, ["manuscriptEffects"]) ||
    effects.length !== 1 || effects[0].channel !== expectedParent.channel ||
    !effects[0].body.trim()
  ) {
    return false;
  }
  try {
    const validation = await validateProposal({
      action: proposal.action,
      target: proposal.target,
      source,
      payload,
      expectedProjectId: source.projectId
    });
    const normalizedEffects = readAIStandardResultManuscriptEffects(validation.normalizedPayload, {
      action: proposal.action,
      target: proposal.target
    });
    return validation.executable && validation.validationIssues.length === 0 &&
      Object.keys(stripAIStandardResultManuscriptEffects(validation.normalizedPayload)).length === 0 &&
      normalizedEffects.length === 1 &&
      normalizedEffects[0].channel === expectedParent.channel &&
      normalizedEffects[0].body === effects[0].body;
  } catch {
    return false;
  }
}

/**
 * The sole deterministic eligibility predicate for the bounded correction. It validates but never
 * rewrites the first proposal and never creates a Standard Result or effect.
 */
export async function assessAIParseSemanticCorrectionEligibility(input: {
  event: AITextStreamCompletedEvent;
  readback: AIConversationReadback;
  firstAttemptId: string;
  source?: AIParseDraftSourceSnapshot;
  validateProposal?: ProposalValidator;
}): Promise<AIParseSemanticCorrectionEligibility> {
  const source = input.source;
  const firstAttempt = input.readback.callAttempts.find((attempt) =>
    attempt.id === input.firstAttemptId);
  const parseAttempts = input.readback.callAttempts.filter((attempt) =>
    attempt.purpose === "parse_draft");
  if (!source || parseAttempts.length !== 1 || parseAttempts[0]?.id !== input.firstAttemptId) {
    return { eligible: false, reason: "NOT_PARSE_DRAFT_FIRST_ATTEMPT" };
  }
  if (
    input.event.truncated === true ||
    !input.event.finishReason.trim() ||
    input.event.finishReason.trim().toLowerCase() === "length"
  ) {
    return { eligible: false, reason: "PROVIDER_COMPLETION_INELIGIBLE" };
  }
  if (
    !firstAttempt || firstAttempt.status !== "failed" ||
    firstAttempt.errorCode !== "invalid_response" || !firstAttempt.settledAt
  ) {
    return { eligible: false, reason: "DURABLE_FIRST_ATTEMPT_NOT_TRUTHFULLY_TERMINAL" };
  }
  if (
    hasCorrectionPolicy(input.readback) ||
    input.readback.standardResults.some((result) =>
      result.parseCallAttemptId === input.firstAttemptId || Boolean(result.effectReceipt))
  ) {
    return { eligible: false, reason: "PRIOR_CORRECTION_OR_RESULT_EXISTS" };
  }
  const normalized = input.event.text.trim();
  if (!normalized) {
    return { eligible: false, reason: "RAW_OUTPUT_UNAVAILABLE_OR_INVALID" };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(normalized);
  } catch {
    return { eligible: false, reason: "RAW_OUTPUT_UNAVAILABLE_OR_INVALID" };
  }
  const root = asRecord(decoded);
  if (!root || Object.prototype.hasOwnProperty.call(root, "outcome")) {
    return { eligible: false, reason: "MISSING_OUTCOME_NOT_SOLE_DEFECT" };
  }
  if (!exactKeys(root, ["batch"])) {
    return { eligible: false, reason: "MISSING_OUTCOME_NOT_SOLE_DEFECT" };
  }
  let batch;
  try {
    batch = parseAIStandardResultBatchDecodedObject(root.batch);
  } catch {
    return { eligible: false, reason: "PROPOSAL_SEMANTICS_INCOMPLETE_OR_UNSAFE" };
  }
  if (
    batch.results.length !== 1 ||
    !await proposalIsCompleteAndSafe(
      batch.results[0],
      source,
      input.validateProposal ?? validateAIStandardResultProposal
    )
  ) {
    return { eligible: false, reason: "PROPOSAL_SEMANTICS_INCOMPLETE_OR_UNSAFE" };
  }
  return {
    eligible: true,
    reason: AI_PARSE_SEMANTIC_CORRECTION_ELIGIBLE_REASON,
    firstProposalText: normalized
  };
}

/**
 * The correction may add only the canonical top-level outcome envelope. This
 * transient guard prevents a Provider from changing any proposal semantics
 * while still producing an otherwise valid Standard Result batch.
 */
export function assertAIParseSemanticCorrectionPreservesProposal(input: {
  firstProposalText: string;
  correctedText: string;
}): void {
  let firstDecoded: unknown;
  try {
    firstDecoded = JSON.parse(input.firstProposalText.trim());
  } catch {
    throw new Error("PARSE_SEMANTIC_CORRECTION_SOURCE_PROPOSAL_INVALID");
  }
  const firstRoot = asRecord(firstDecoded);
  if (!firstRoot || !exactKeys(firstRoot, ["batch"])) {
    throw new Error("PARSE_SEMANTIC_CORRECTION_SOURCE_PROPOSAL_INVALID");
  }
  const firstBatch = parseAIStandardResultBatchDecodedObject(firstRoot.batch);
  const corrected = parseAIParseDraftOutcome(input.correctedText);
  if (
    corrected.kind !== "standard_result_batch" ||
    canonicalJson(corrected.payload) !== canonicalJson(firstBatch)
  ) {
    throw new Error("PARSE_SEMANTIC_CORRECTION_PROPOSAL_CHANGED");
  }
}

function minimalCorrectionContextPackage(contextPackage: AIContextPackage): AIContextPackage {
  return {
    ...structuredClone(contextPackage),
    sections: [],
    sourceRefs: [],
    warnings: [],
    excluded: [],
    materialDecisions: [],
    requestableRefs: []
  };
}

function correctionSourceRef(firstAttemptId: string) {
  return {
    module: "ai" as const,
    entityType: "system" as const,
    entityId: firstAttemptId,
    label: "Bounded Parse semantic correction source attempt",
    field: "parseSemanticCorrectionSourceAttempt",
    sourceKind: "systemGenerated" as const,
    isUserAuthored: false,
    isAiGenerated: false,
    isVerified: true
  };
}

/** Builds the correction through the ordinary PARSE_DRAFT machine-contract renderer. */
export function buildAIParseSemanticCorrectionPromptPackage(input: {
  contextPackage: AIContextPackage;
  originalSourceRefs: AIConversationReadback["callAttempts"][number]["contextSourceRefs"];
  originalPromptEnvelope: AIProviderPromptEnvelope;
  firstAttemptId: string;
  firstProposalText: string;
}): AIPromptPackage {
  const constraint = resolveAIActiveConstraintRequest({
    request: { kind: "current", category: "PARSE_DRAFT" },
    purpose: "parse_draft",
    parseSemanticCorrectionEligible: true
  });
  const durableRefs = input.originalSourceRefs
    .filter((sourceRef) => !hasAIConstraintProvenance(sourceRef))
    .map((sourceRef) => structuredClone(sourceRef));
  const proposalContext = [
    "# Parse Semantic Correction Input",
    "The following is the complete first Provider proposal. Preserve it exactly.",
    input.firstProposalText
  ].join("\n\n");
  const built = buildAIPromptPackage(
    minimalCorrectionContextPackage(input.contextPackage),
    "Re-express the supplied first proposal exactly once in the canonical typed Parse Draft outcome envelope. Do not change any proposal semantics or request additional context.",
    {
      constraintDescriptor: constraint.descriptor,
      technicalCapacityChars: input.originalPromptEnvelope.finalPromptHardBudget,
      includeSourceRefs: false,
      includeWarnings: false,
      contextMarkdownOverride: proposalContext,
      conversationMessages: [],
      maxConversationHistoryChars: 0,
      maxConversationHistoryMessages: 0,
      standardResultResponseContract: createAIStandardResultResponseContract(),
      additionalSourceRefs: [
        ...durableRefs,
        correctionSourceRef(input.firstAttemptId)
      ],
      ...(input.originalPromptEnvelope.quickAnalysisContextCapability
        ? {
            quickAnalysisContextCapability: {
              ...input.originalPromptEnvelope.quickAnalysisContextCapability
            }
          }
        : {}),
      outputDetailPreference: input.originalPromptEnvelope.outputDetailPreference
    }
  );
  if (
    !built.contextMarkdown.includes(input.firstProposalText) ||
    built.contextMarkdown.split(input.firstProposalText).length !== 2
  ) {
    throw new Error("PARSE_SEMANTIC_CORRECTION_FIRST_PROPOSAL_NOT_PRESERVED");
  }
  return built;
}

export function traceSelectsAIParseSemanticCorrectionPolicy(
  sourceRefs: readonly AIConversationReadback["callAttempts"][number]["contextSourceRefs"][number][]
): boolean {
  return sourceRefs.some((sourceRef) =>
    sourceRef.boundedPolicyDocuments?.some((identity) =>
      identity.documentId === AI_PARSE_SEMANTIC_CORRECTION_BOUNDED_POLICY.documentId &&
      identity.semanticVersion === AI_PARSE_SEMANTIC_CORRECTION_BOUNDED_POLICY.semanticVersion
    ) ?? false
  );
}
