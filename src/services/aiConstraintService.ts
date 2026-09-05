import type { AICallAttemptPurpose } from "../types/aiConversation";
import type { AIContextSourceRef } from "../types/aiContext";
import type {
  AIActiveConstraintDescriptor,
  AIConstraintCategory,
  AIConstraintDescriptor,
  AIConstraintLegacySourceMarker,
  AIConstraintResolutionRequest,
  AIConstraintSemanticSegments,
  AIExecutableBoundedPolicyIdentity
} from "../types/aiConstraint";
import { resolveAIConstraintContent } from "./aiConstraintContentService";

const NORMAL_QA_CONSTRAINT_REF = "labpod.ai.constraint.normal_qa";
const SHARED_INVARIANT_REF = "labpod.ai.constraint.shared_invariant";
const NORMAL_QA_POLICY_REF = "labpod.ai.policy.normal_qa.presentation";
export const AI_CONTEXT_REQUEST_BOUNDED_POLICY = Object.freeze({
  documentId: "labpod.ai.policy.context_request",
  semanticVersion: 5
}) satisfies AIExecutableBoundedPolicyIdentity;
export const AI_LITERATURE_OBJECTIVE_OUTLINE_BOUNDED_POLICY = Object.freeze({
  documentId: "labpod.ai.policy.literature_objective_outline",
  semanticVersion: 1
}) satisfies AIExecutableBoundedPolicyIdentity;
export const AI_PARSE_SEMANTIC_CORRECTION_BOUNDED_POLICY = Object.freeze({
  documentId: "labpod.ai.policy.parse_semantic_correction",
  semanticVersion: 1
}) satisfies AIExecutableBoundedPolicyIdentity;
const CONSTRAINT_DESCRIPTOR_FIELD = "constraintDescriptor";

const NORMAL_QA_DESCRIPTOR: AIActiveConstraintDescriptor = Object.freeze({
  category: "NORMAL_QA",
  lifecycle: "ACTIVE",
  constraintRef: NORMAL_QA_CONSTRAINT_REF,
  constraintVersion: 16,
  sharedInvariantRef: SHARED_INVARIANT_REF,
  sharedInvariantVersion: 2,
  boundedPolicyRefs: [NORMAL_QA_POLICY_REF]
});

const PARSE_DRAFT_DESCRIPTOR: AIActiveConstraintDescriptor = Object.freeze({
  category: "PARSE_DRAFT",
  lifecycle: "ACTIVE",
  constraintRef: "labpod.ai.constraint.parse_draft",
  constraintVersion: 26,
  sharedInvariantRef: SHARED_INVARIANT_REF,
  sharedInvariantVersion: 2,
  boundedPolicyRefs: []
});

export const QUICK_ANALYSIS_GENERAL_MANUSCRIPT_DESCRIPTOR: AIActiveConstraintDescriptor = Object.freeze({
  category: "QUICK_ANALYSIS",
  lifecycle: "ACTIVE",
  constraintRef: "labpod.ai.constraint.quick_analysis",
  constraintVersion: 3,
  sharedInvariantRef: SHARED_INVARIANT_REF,
  sharedInvariantVersion: 2,
  boundedPolicyRefs: []
});

export const QUICK_ANALYSIS_LITERATURE_OBJECTIVE_OUTLINE_DESCRIPTOR: AIActiveConstraintDescriptor = Object.freeze({
  category: "QUICK_ANALYSIS",
  lifecycle: "ACTIVE",
  constraintRef: "labpod.ai.constraint.quick_analysis",
  constraintVersion: 4,
  sharedInvariantRef: SHARED_INVARIANT_REF,
  sharedInvariantVersion: 2,
  boundedPolicyRefs: []
});

const LEGACY_QUICK_ANALYSIS_DESCRIPTOR_V2: AIActiveConstraintDescriptor = Object.freeze({
  category: "QUICK_ANALYSIS",
  lifecycle: "ACTIVE",
  constraintRef: "labpod.ai.constraint.quick_analysis",
  constraintVersion: 2,
  sharedInvariantRef: SHARED_INVARIANT_REF,
  sharedInvariantVersion: 2,
  boundedPolicyRefs: []
});

/** The sole category registry and version-selection authority. */
const CONSTRAINT_REGISTRY = Object.freeze({
  NORMAL_QA: NORMAL_QA_DESCRIPTOR,
  PARSE_DRAFT: PARSE_DRAFT_DESCRIPTOR,
  QUICK_ANALYSIS: QUICK_ANALYSIS_GENERAL_MANUSCRIPT_DESCRIPTOR
});

export const ACTIVE_PRODUCTION_QUICK_CONSTRAINT_SELECTIONS = Object.freeze([
  Object.freeze({
    selection: "GENERAL" as const,
    descriptor: QUICK_ANALYSIS_GENERAL_MANUSCRIPT_DESCRIPTOR,
    channelCount: 9
  }),
  Object.freeze({
    selection: "OBJECTIVE_OUTLINE" as const,
    descriptor: QUICK_ANALYSIS_LITERATURE_OBJECTIVE_OUTLINE_DESCRIPTOR,
    channelCount: 1
  })
]);

export const AI_CONSTRAINT_CATEGORIES = Object.freeze(
  Object.keys(CONSTRAINT_REGISTRY) as AIConstraintCategory[]
);

export type AIConstraintContractErrorCode =
  | "constraint_category_unknown"
  | "constraint_descriptor_missing"
  | "constraint_descriptor_invalid"
  | "constraint_version_unknown"
  | "constraint_descriptor_reserved"
  | "constraint_purpose_incompatible";

export class AIConstraintContractError extends Error {
  constructor(
    readonly code: AIConstraintContractErrorCode,
    message: string
  ) {
    super(message);
    this.name = "AIConstraintContractError";
  }
}

function cloneActiveDescriptor(
  descriptor: AIActiveConstraintDescriptor
): AIActiveConstraintDescriptor {
  return {
    ...descriptor,
    boundedPolicyRefs: descriptor.boundedPolicyRefs
      ? [...descriptor.boundedPolicyRefs]
      : undefined,
    executableBoundedPolicies: descriptor.executableBoundedPolicies
      ? descriptor.executableBoundedPolicies.map((identity) => ({ ...identity }))
      : undefined
  };
}

function cloneDescriptor(descriptor: AIConstraintDescriptor): AIConstraintDescriptor {
  return cloneActiveDescriptor(descriptor);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new AIConstraintContractError(
      "constraint_descriptor_invalid",
      "Constraint boundedPolicyRefs must be a bounded array of stable references."
    );
  }
  return [...value];
}

function executableBoundedPolicies(value: unknown): AIExecutableBoundedPolicyIdentity[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 1) {
    throw new AIConstraintContractError(
      "constraint_descriptor_invalid",
      "At most one exact executable bounded policy may be selected for a covered invocation."
    );
  }
  const policies = value.map((item) => {
    const record = asRecord(item);
    if (
      !record || typeof record.documentId !== "string" || !record.documentId.trim() ||
      !Number.isSafeInteger(record.semanticVersion) || Number(record.semanticVersion) <= 0
    ) {
      throw new AIConstraintContractError(
        "constraint_descriptor_invalid",
        "Executable bounded policies require exact documentId and semanticVersion fields."
      );
    }
    return {
      documentId: record.documentId,
      semanticVersion: Number(record.semanticVersion)
    };
  });
  const knownPolicy = (identity: AIExecutableBoundedPolicyIdentity) => [
    AI_CONTEXT_REQUEST_BOUNDED_POLICY,
    AI_LITERATURE_OBJECTIVE_OUTLINE_BOUNDED_POLICY,
    AI_PARSE_SEMANTIC_CORRECTION_BOUNDED_POLICY
  ].some((candidate) =>
    identity.documentId === candidate.documentId &&
    identity.semanticVersion === candidate.semanticVersion
  );
  if (policies.length === 1 && !knownPolicy(policies[0])) {
    throw new AIConstraintContractError(
      "constraint_descriptor_invalid",
      "The selected executable bounded policy is unknown or unsupported."
    );
  }
  return policies;
}

function sameStrings(left?: readonly string[], right?: readonly string[]): boolean {
  const a = left ?? [];
  const b = right ?? [];
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function isLiteratureObjectiveOutlineTarget(target?: { ownerType: string; channel: string }) {
  return target?.ownerType === "literature" && target.channel === "literature_outline";
}

export function resolveAIQuickConstraintDescriptor(
  target?: { ownerType: string; channel: string }
): AIActiveConstraintDescriptor {
  return cloneActiveDescriptor(isLiteratureObjectiveOutlineTarget(target)
    ? QUICK_ANALYSIS_LITERATURE_OBJECTIVE_OUTLINE_DESCRIPTOR
    : QUICK_ANALYSIS_GENERAL_MANUSCRIPT_DESCRIPTOR);
}

function supportedExecutableDescriptor(value: Record<string, unknown>) {
  if (value.category === "QUICK_ANALYSIS") {
    if (value.constraintRef !== "labpod.ai.constraint.quick_analysis") return undefined;
    if (value.constraintVersion === 2) return LEGACY_QUICK_ANALYSIS_DESCRIPTOR_V2;
    if (value.constraintVersion === 3) return QUICK_ANALYSIS_GENERAL_MANUSCRIPT_DESCRIPTOR;
    if (value.constraintVersion === 4) return QUICK_ANALYSIS_LITERATURE_OBJECTIVE_OUTLINE_DESCRIPTOR;
    return undefined;
  }
  return value.category === "NORMAL_QA"
    ? NORMAL_QA_DESCRIPTOR
    : value.category === "PARSE_DRAFT"
      ? PARSE_DRAFT_DESCRIPTOR
      : undefined;
}

export function isAIConstraintCategory(value: unknown): value is AIConstraintCategory {
  return typeof value === "string" && AI_CONSTRAINT_CATEGORIES.includes(value as AIConstraintCategory);
}

export function resolveAIConstraintDescriptor(
  category: unknown,
  requestedVersion?: unknown
): AIConstraintDescriptor {
  if (!isAIConstraintCategory(category)) {
    throw new AIConstraintContractError(
      "constraint_category_unknown",
      `Unknown AI constraint category: ${String(category)}`
    );
  }
  const canonical = category === "QUICK_ANALYSIS" && requestedVersion === 4
    ? QUICK_ANALYSIS_LITERATURE_OBJECTIVE_OUTLINE_DESCRIPTOR
    : CONSTRAINT_REGISTRY[category];
  const canonicalVersion = canonical.constraintVersion;
  if (requestedVersion !== undefined && requestedVersion !== canonicalVersion) {
    throw new AIConstraintContractError(
      "constraint_version_unknown",
      `Unsupported ${category} constraint contract version: ${String(requestedVersion)}`
    );
  }
  return cloneDescriptor(canonical);
}

export function validateAIActiveConstraintDescriptor(
  candidate: unknown
): AIActiveConstraintDescriptor {
  const value = asRecord(candidate);
  if (
    !value ||
    (value.category !== "NORMAL_QA" && value.category !== "PARSE_DRAFT" &&
      value.category !== "QUICK_ANALYSIS") ||
    value.lifecycle !== "ACTIVE"
  ) {
    if (value?.lifecycle === "RESERVED") {
      throw new AIConstraintContractError(
        "constraint_descriptor_reserved",
        "Reserved AI constraint categories cannot be assembled for a production provider call."
      );
    }
    throw new AIConstraintContractError(
      "constraint_descriptor_invalid",
      "A complete supported ACTIVE constraint descriptor is required."
    );
  }
  const boundedPolicyRefs = stringArray(value.boundedPolicyRefs);
  const selectedBoundedPolicies = executableBoundedPolicies(value.executableBoundedPolicies);
  const canonical = supportedExecutableDescriptor(value);
  if (
    !canonical ||
    value.constraintVersion !== canonical.constraintVersion ||
    value.constraintRef !== canonical.constraintRef ||
    value.sharedInvariantRef !== canonical.sharedInvariantRef ||
    value.sharedInvariantVersion !== canonical.sharedInvariantVersion ||
    !sameStrings(boundedPolicyRefs, canonical.boundedPolicyRefs)
  ) {
    throw new AIConstraintContractError(
      "constraint_descriptor_invalid",
      "The frozen AI constraint descriptor does not match a supported canonical contract."
    );
  }
  return cloneActiveDescriptor({
    category: value.category,
    lifecycle: "ACTIVE",
    constraintRef: value.constraintRef as string,
    constraintVersion: value.constraintVersion as number,
    sharedInvariantRef: value.sharedInvariantRef as string,
    sharedInvariantVersion: value.sharedInvariantVersion as number,
    boundedPolicyRefs,
    ...(selectedBoundedPolicies?.length
      ? { executableBoundedPolicies: selectedBoundedPolicies }
      : {})
  });
}

/**
 * Historical provenance reader. It accepts exact packaged historical shared-
 * invariant and category-policy versions for readback only; production execution
 * continues to require validateAIActiveConstraintDescriptor and the sole current
 * descriptor.
 */
function validateAIRecordedConstraintDescriptor(
  candidate: unknown
): AIActiveConstraintDescriptor {
  const value = asRecord(candidate);
  if (
    !value ||
    (value.category !== "NORMAL_QA" && value.category !== "PARSE_DRAFT" &&
      value.category !== "QUICK_ANALYSIS") ||
    value.lifecycle !== "ACTIVE" ||
    !Number.isSafeInteger(value.constraintVersion) ||
    Number(value.constraintVersion) <= 0 ||
    !Number.isSafeInteger(value.sharedInvariantVersion) ||
    Number(value.sharedInvariantVersion) <= 0
  ) {
    throw new AIConstraintContractError(
      "constraint_descriptor_invalid",
      "A recorded constraint descriptor requires one exact supported historical identity."
    );
  }
  const boundedPolicyRefs = stringArray(value.boundedPolicyRefs);
  const selectedBoundedPolicies = executableBoundedPolicies(value.executableBoundedPolicies);
  const current = resolveAIConstraintDescriptor(value.category);
  if (
    current.lifecycle !== "ACTIVE" ||
    value.constraintRef !== current.constraintRef ||
    value.sharedInvariantRef !== current.sharedInvariantRef ||
    !sameStrings(boundedPolicyRefs, current.boundedPolicyRefs)
  ) {
    throw new AIConstraintContractError(
      "constraint_descriptor_invalid",
      "The recorded constraint descriptor does not match the canonical owner identity."
    );
  }
  try {
    resolveAIConstraintContent({
      documentId: value.sharedInvariantRef,
      semanticVersion: Number(value.sharedInvariantVersion),
      role: "SHARED_INVARIANT",
      lifecycle: "ACTIVE"
    });
  } catch {
    throw new AIConstraintContractError(
      "constraint_version_unknown",
      `Unsupported recorded shared invariant version: ${String(value.sharedInvariantVersion)}`
    );
  }
  try {
    resolveAIConstraintContent({
      documentId: value.constraintRef,
      semanticVersion: Number(value.constraintVersion),
      role: "CATEGORY_POLICY",
      lifecycle: "ACTIVE"
    });
  } catch {
    throw new AIConstraintContractError(
      "constraint_version_unknown",
      `Unsupported recorded ${value.category} constraint version: ${String(value.constraintVersion)}`
    );
  }
  return cloneActiveDescriptor({
    category: value.category,
    lifecycle: "ACTIVE",
    constraintRef: value.constraintRef as string,
    constraintVersion: Number(value.constraintVersion),
    sharedInvariantRef: value.sharedInvariantRef as string,
    sharedInvariantVersion: Number(value.sharedInvariantVersion),
    boundedPolicyRefs,
    ...(selectedBoundedPolicies?.length
      ? { executableBoundedPolicies: selectedBoundedPolicies }
      : {})
  });
}

export function resolveAIActiveConstraintRequest(input: {
  request: AIConstraintResolutionRequest;
  purpose: AICallAttemptPurpose;
  contextRequestCapabilityEligible?: boolean;
  quickAnalysisTarget?: { ownerType: string; channel: string };
  parseSemanticCorrectionEligible?: boolean;
}): {
  descriptor: AIActiveConstraintDescriptor;
  legacySourceMarker?: AIConstraintLegacySourceMarker;
} {
  let descriptor = input.request.kind === "current"
    ? input.request.category === "QUICK_ANALYSIS"
      ? resolveAIQuickConstraintDescriptor(input.quickAnalysisTarget)
      : resolveAIConstraintDescriptor(input.request.category)
    : validateAIActiveConstraintDescriptor(input.request.descriptor);
  const purposeCompatible =
    (input.purpose === "chat_response" &&
      (descriptor.category === "NORMAL_QA" || descriptor.category === "QUICK_ANALYSIS")) ||
    (input.purpose === "parse_draft" && descriptor.category === "PARSE_DRAFT");
  if (!purposeCompatible) {
    throw new AIConstraintContractError(
      "constraint_purpose_incompatible",
      `${input.purpose} is not compatible with ${descriptor.category} in LP13-B1-A3.`
    );
  }
  const capabilityEligible = input.contextRequestCapabilityEligible === true;
  const semanticCorrectionEligible = input.parseSemanticCorrectionEligible === true;
  const objectiveOutlineTarget =
    descriptor.category === "QUICK_ANALYSIS" &&
    input.purpose === "chat_response" &&
    isLiteratureObjectiveOutlineTarget(input.quickAnalysisTarget);
  const simpleQuick = descriptor.category === "QUICK_ANALYSIS" &&
    (descriptor.constraintVersion === 3 || descriptor.constraintVersion === 4);
  if (simpleQuick && capabilityEligible) {
    throw new AIConstraintContractError(
      "constraint_descriptor_invalid",
      "Simple Quick Analysis cannot expose machine Context Request capability."
    );
  }
  if (simpleQuick && (
    descriptor.constraintVersion === 4 !== objectiveOutlineTarget
  )) {
    throw new AIConstraintContractError(
      "constraint_descriptor_invalid",
      "The active Quick constraint version does not match the exact frozen owner/channel."
    );
  }
  if (
    semanticCorrectionEligible &&
    (input.request.kind !== "current" || input.purpose !== "parse_draft" ||
      descriptor.category !== "PARSE_DRAFT" || capabilityEligible || objectiveOutlineTarget)
  ) {
    throw new AIConstraintContractError(
      "constraint_descriptor_invalid",
      "Parse semantic correction requires one current PARSE_DRAFT call with no Context Request or owner-specific bounded policy."
    );
  }
  if (input.request.kind === "current" && semanticCorrectionEligible) {
    descriptor = {
      ...descriptor,
      executableBoundedPolicies: [{ ...AI_PARSE_SEMANTIC_CORRECTION_BOUNDED_POLICY }]
    };
  } else if (
    input.request.kind === "current" && capabilityEligible &&
    descriptor.category !== "QUICK_ANALYSIS"
  ) {
    descriptor = {
      ...descriptor,
      executableBoundedPolicies: [{ ...AI_CONTEXT_REQUEST_BOUNDED_POLICY }]
    };
  }
  const hasContextRequestPolicy = descriptor.executableBoundedPolicies?.some((identity) =>
    identity.documentId === AI_CONTEXT_REQUEST_BOUNDED_POLICY.documentId &&
    identity.semanticVersion === AI_CONTEXT_REQUEST_BOUNDED_POLICY.semanticVersion
  ) ?? false;
  const hasObjectiveOutlinePolicy = descriptor.executableBoundedPolicies?.some((identity) =>
    identity.documentId === AI_LITERATURE_OBJECTIVE_OUTLINE_BOUNDED_POLICY.documentId &&
    identity.semanticVersion === AI_LITERATURE_OBJECTIVE_OUTLINE_BOUNDED_POLICY.semanticVersion
  ) ?? false;
  const hasParseSemanticCorrectionPolicy = descriptor.executableBoundedPolicies?.some((identity) =>
    identity.documentId === AI_PARSE_SEMANTIC_CORRECTION_BOUNDED_POLICY.documentId &&
    identity.semanticVersion === AI_PARSE_SEMANTIC_CORRECTION_BOUNDED_POLICY.semanticVersion
  ) ?? false;
  const legacyObjectiveOutlinePolicyExpected = !simpleQuick && objectiveOutlineTarget;
  if (hasObjectiveOutlinePolicy !== legacyObjectiveOutlinePolicyExpected) {
    throw new AIConstraintContractError(
      "constraint_descriptor_invalid",
      "The Literature objective-outline bounded-policy selection does not match the exact Quick owner/channel."
    );
  }
  const contextRequestPolicyExpected = capabilityEligible && !simpleQuick;
  if (hasContextRequestPolicy !== contextRequestPolicyExpected) {
    throw new AIConstraintContractError(
      "constraint_descriptor_invalid",
      "The frozen Context Request bounded-policy selection does not match canonical Task-scoped capability eligibility for this purpose."
    );
  }
  if (hasParseSemanticCorrectionPolicy !== semanticCorrectionEligible) {
    throw new AIConstraintContractError(
      "constraint_descriptor_invalid",
      "The bounded Parse semantic-correction policy does not match the exact eligible correction invocation."
    );
  }
  return {
    descriptor: cloneActiveDescriptor(descriptor),
    ...(input.request.kind === "frozen" && input.request.legacySourceMarker
      ? { legacySourceMarker: input.request.legacySourceMarker }
      : {})
  };
}

export function buildAIConstraintSemanticSegments(
  descriptorInput: unknown
): AIConstraintSemanticSegments {
  const descriptor = validateAIActiveConstraintDescriptor(descriptorInput);
  const sharedInvariant = resolveAIConstraintContent({
    documentId: descriptor.sharedInvariantRef,
    semanticVersion: descriptor.sharedInvariantVersion,
    role: "SHARED_INVARIANT",
    lifecycle: descriptor.lifecycle
  });
  const categoryPolicy = resolveAIConstraintContent({
    documentId: descriptor.constraintRef,
    semanticVersion: descriptor.constraintVersion,
    role: "CATEGORY_POLICY",
    lifecycle: descriptor.lifecycle
  });
  const base = [
    {
      kind: "shared_invariant",
      ref: descriptor.sharedInvariantRef,
      version: descriptor.sharedInvariantVersion,
      text: sharedInvariant.content
    },
    {
      kind: "category_policy",
      category: descriptor.category,
      ref: descriptor.constraintRef,
      version: descriptor.constraintVersion,
      boundedPolicyRefs: descriptor.boundedPolicyRefs
        ? [...descriptor.boundedPolicyRefs]
        : undefined,
      text: categoryPolicy.content
    }
  ] as AIConstraintSemanticSegments;
  const boundedPolicy = descriptor.executableBoundedPolicies?.[0];
  if (!boundedPolicy) return base;
  const resolved = resolveAIConstraintContent({
    documentId: boundedPolicy.documentId,
    semanticVersion: boundedPolicy.semanticVersion,
    role: "BOUNDED_POLICY",
    lifecycle: descriptor.lifecycle
  });
  return [
    base[0],
    base[1],
    {
      kind: "bounded_policy",
      ref: boundedPolicy.documentId,
      version: boundedPolicy.semanticVersion,
      text: resolved.content
    }
  ];
}

export function assertAIConstraintSemanticSegments(
  descriptorInput: unknown,
  segmentsInput: unknown
): AIConstraintSemanticSegments {
  const canonical = buildAIConstraintSemanticSegments(descriptorInput);
  if (!Array.isArray(segmentsInput) || segmentsInput.length !== canonical.length) {
    throw new AIConstraintContractError(
      "constraint_descriptor_invalid",
      "A covered PromptPackage requires the exact A3-selected constraint segment tuple."
    );
  }
  if (JSON.stringify(segmentsInput) !== JSON.stringify(canonical)) {
    throw new AIConstraintContractError(
      "constraint_descriptor_invalid",
      "PromptPackage constraint segments do not match the canonical descriptor contract."
    );
  }
  return canonical;
}

export function createAIConstraintSourceRef(
  descriptorInput: unknown,
  legacySourceMarker?: AIConstraintLegacySourceMarker
): AIContextSourceRef {
  const descriptor = validateAIActiveConstraintDescriptor(descriptorInput);
  const shared = resolveAIConstraintContent({
    documentId: descriptor.sharedInvariantRef,
    semanticVersion: descriptor.sharedInvariantVersion,
    role: "SHARED_INVARIANT",
    lifecycle: descriptor.lifecycle
  });
  const category = resolveAIConstraintContent({
    documentId: descriptor.constraintRef,
    semanticVersion: descriptor.constraintVersion,
    role: "CATEGORY_POLICY",
    lifecycle: descriptor.lifecycle
  });
  const bounded = descriptor.executableBoundedPolicies?.[0]
    ? resolveAIConstraintContent({
        documentId: descriptor.executableBoundedPolicies[0].documentId,
        semanticVersion: descriptor.executableBoundedPolicies[0].semanticVersion,
        role: "BOUNDED_POLICY",
        lifecycle: descriptor.lifecycle
      })
    : undefined;
  return {
    module: "ai",
    entityType: "system",
    entityId: descriptor.constraintRef,
    label: `${descriptor.category} constraint contract`,
    field: CONSTRAINT_DESCRIPTOR_FIELD,
    sourceKind: "systemGenerated",
    isUserAuthored: false,
    isAiGenerated: false,
    isVerified: true,
    constraintCategory: descriptor.category,
    constraintLifecycle: descriptor.lifecycle,
    constraintRef: descriptor.constraintRef,
    constraintVersion: descriptor.constraintVersion,
    constraintContentHash: category.contentHash,
    sharedInvariantRef: descriptor.sharedInvariantRef,
    sharedInvariantVersion: descriptor.sharedInvariantVersion,
    sharedInvariantContentHash: shared.contentHash,
    boundedPolicyRefs: descriptor.boundedPolicyRefs
      ? [...descriptor.boundedPolicyRefs]
      : undefined,
    boundedPolicyDocuments: descriptor.executableBoundedPolicies
      ? descriptor.executableBoundedPolicies.map((identity) => ({ ...identity }))
      : undefined,
    boundedPolicyContentHash: bounded?.contentHash,
    legacySourceMarker
  };
}

const CONSTRAINT_SOURCE_KEYS = [
  "constraintCategory",
  "constraintLifecycle",
  "constraintRef",
  "constraintVersion",
  "constraintContentHash",
  "sharedInvariantRef",
  "sharedInvariantVersion",
  "sharedInvariantContentHash",
  "boundedPolicyRefs",
  "boundedPolicyDocuments",
  "boundedPolicyContentHash",
  "legacySourceMarker"
] as const;

export function hasAIConstraintProvenance(sourceRef: AIContextSourceRef): boolean {
  return sourceRef.field === CONSTRAINT_DESCRIPTOR_FIELD ||
    CONSTRAINT_SOURCE_KEYS.some((key) => sourceRef[key] !== undefined);
}

export type AIConstraintReadback =
  | { state: "legacy_unversioned" }
  | {
      state: "recorded";
      descriptor: AIActiveConstraintDescriptor;
      legacySourceMarker?: AIConstraintLegacySourceMarker;
    };

export function readAIConstraintFromSourceRefs(
  sourceRefs: readonly AIContextSourceRef[]
): AIConstraintReadback {
  const candidates = sourceRefs.filter(hasAIConstraintProvenance);
  if (candidates.length === 0) return { state: "legacy_unversioned" };
  if (candidates.length !== 1) {
    throw new AIConstraintContractError(
      "constraint_descriptor_invalid",
      "Exactly one frozen AI constraint descriptor is required for a covered call."
    );
  }
  const sourceRef = candidates[0];
  const descriptor = validateAIRecordedConstraintDescriptor({
    category: sourceRef.constraintCategory,
    lifecycle: sourceRef.constraintLifecycle,
    constraintRef: sourceRef.constraintRef,
    constraintVersion: sourceRef.constraintVersion,
    sharedInvariantRef: sourceRef.sharedInvariantRef,
    sharedInvariantVersion: sourceRef.sharedInvariantVersion,
    boundedPolicyRefs: sourceRef.boundedPolicyRefs,
    executableBoundedPolicies: sourceRef.boundedPolicyDocuments
  });
  const sharedContent = resolveAIConstraintContent({
    documentId: descriptor.sharedInvariantRef,
    semanticVersion: descriptor.sharedInvariantVersion,
    role: "SHARED_INVARIANT",
    lifecycle: descriptor.lifecycle
  });
  const categoryContent = resolveAIConstraintContent({
    documentId: descriptor.constraintRef,
    semanticVersion: descriptor.constraintVersion,
    role: "CATEGORY_POLICY",
    lifecycle: descriptor.lifecycle
  });
  const hashRequired = descriptor.category === "QUICK_ANALYSIS" &&
    (descriptor.constraintVersion === 3 || descriptor.constraintVersion === 4);
  if (
    (hashRequired || sourceRef.constraintContentHash !== undefined) &&
      sourceRef.constraintContentHash !== categoryContent.contentHash ||
    (hashRequired || sourceRef.sharedInvariantContentHash !== undefined) &&
      sourceRef.sharedInvariantContentHash !== sharedContent.contentHash
  ) {
    throw new AIConstraintContractError(
      "constraint_descriptor_invalid",
      "Recorded constraint content hashes do not match the exact packaged resources."
    );
  }
  const marker = sourceRef.legacySourceMarker;
  if (marker !== undefined && marker !== "PRE_A3_ORDINARY_CHAT_SOURCE") {
    throw new AIConstraintContractError(
      "constraint_descriptor_invalid",
      "Unknown legacy source marker on the frozen AI constraint descriptor."
    );
  }
  return {
    state: "recorded",
    descriptor,
    ...(marker ? { legacySourceMarker: marker } : {})
  };
}

export function constraintDescriptorsEqual(
  left: unknown,
  right: unknown
): boolean {
  try {
    const a = validateAIActiveConstraintDescriptor(left);
    const b = validateAIActiveConstraintDescriptor(right);
    return a.category === b.category &&
      a.lifecycle === b.lifecycle &&
      a.constraintRef === b.constraintRef &&
      a.constraintVersion === b.constraintVersion &&
      a.sharedInvariantRef === b.sharedInvariantRef &&
      a.sharedInvariantVersion === b.sharedInvariantVersion &&
      sameStrings(a.boundedPolicyRefs, b.boundedPolicyRefs) &&
      JSON.stringify(a.executableBoundedPolicies ?? []) ===
        JSON.stringify(b.executableBoundedPolicies ?? []);
  } catch {
    return false;
  }
}

export function assertAIInvocationConstraint(input: {
  purpose: AICallAttemptPurpose;
  sourceRefs: readonly AIContextSourceRef[];
  promptDescriptor?: unknown;
}): AIActiveConstraintDescriptor | null {
  const readback = readAIConstraintFromSourceRefs(input.sourceRefs);
  if (input.purpose === "action_draft_generation") {
    if (readback.state !== "legacy_unversioned" || input.promptDescriptor !== undefined) {
      throw new AIConstraintContractError(
        "constraint_purpose_incompatible",
        "Action Draft generation is outside A3 descriptor coverage and must not receive a category."
      );
    }
    return null;
  }
  if (readback.state === "legacy_unversioned") {
    throw new AIConstraintContractError(
      "constraint_descriptor_missing",
      "A new chat_response call requires one frozen ACTIVE constraint descriptor."
    );
  }
  const executableDescriptor = validateAIActiveConstraintDescriptor(readback.descriptor);
  const purposeCompatible = input.purpose === "parse_draft"
    ? executableDescriptor.category === "PARSE_DRAFT"
    : executableDescriptor.category === "NORMAL_QA" ||
      executableDescriptor.category === "QUICK_ANALYSIS";
  if (!purposeCompatible) {
    throw new AIConstraintContractError(
      "constraint_purpose_incompatible",
      `${input.purpose} received an incompatible ACTIVE ${executableDescriptor.category} descriptor.`
    );
  }
  if (
    input.promptDescriptor !== undefined &&
    !constraintDescriptorsEqual(executableDescriptor, input.promptDescriptor)
  ) {
    throw new AIConstraintContractError(
      "constraint_descriptor_invalid",
      "PromptPackage and CallAttempt constraint descriptors do not match."
    );
  }
  return executableDescriptor;
}

export function resolveRetryConstraintRequest(input: {
  purpose: AICallAttemptPurpose;
  contextSourceRefs: readonly AIContextSourceRef[];
}): AIConstraintResolutionRequest {
  if (input.purpose !== "chat_response") {
    throw new AIConstraintContractError(
      "constraint_purpose_incompatible",
      "Only an ordinary chat_response source can supply an A3 retry descriptor."
    );
  }
  const readback = readAIConstraintFromSourceRefs(input.contextSourceRefs);
  if (readback.state === "legacy_unversioned") {
    const descriptor = resolveAIConstraintDescriptor("NORMAL_QA");
    return {
      kind: "frozen",
      descriptor,
      legacySourceMarker: "PRE_A3_ORDINARY_CHAT_SOURCE"
    };
  }
  return {
    kind: "frozen",
    descriptor: cloneActiveDescriptor(readback.descriptor)
  };
}
