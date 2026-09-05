import type {
  AIApprovedContextRequestContribution,
  AIContextMaterialSelection,
  AIContextPackage,
  AIContextRequestableRef,
  AIContextSourceRef,
  AIPromptPackage,
  AIResearchObjectSelection
} from "../types/aiContext";
import type {
  AIContextRequest,
  AIContextRequestCandidate,
  AIContextRequestWirePayload,
  AIContextRequestWireRef,
  AIParseSupplementalContextProjection
} from "../types/aiContextRequest";
import type { AIConversationReadback } from "../types/aiConversation";
import type { AIParseDraftSourceSnapshot } from "../types/aiStandardResult";
import { buildAIContext } from "./aiContextBuilderService";
import {
  resolveAIContextRequestCandidates,
  type AIContextRequestValidationError
} from "./aiContextRequestService";
import {
  AI_PROVIDER_PROMPT_TECHNICAL_MAX_CHARS
} from "./aiPromptBudgetService";
import {
  PARSE_DRAFT_STANDARD_RESULT_ONLY_DIRECTIVE,
  buildAIParseDraftPromptPackage
} from "./aiParseDraftService";
import { AI_RESEARCH_OBJECT_SELECTION_MAX } from "./aiResearchObjectService";

export interface AIParseSupplementalContextResolution {
  requestedRefs: AIContextRequestWireRef[];
  projections: AIParseSupplementalContextProjection[];
  providedCandidates: AIContextRequestCandidate[];
  projectionFingerprint: string;
}

export type AIParseSupplementalContextResolverDependencies = {
  resolveCandidates: typeof resolveAIContextRequestCandidates;
};

export interface AIParseSupplementalContextContinuation {
  contextPackage: AIContextPackage;
  promptPackage: AIPromptPackage;
  source: AIParseDraftSourceSnapshot;
  authorizedBodyFileRefIds: string[];
  projectionSourceRef: AIContextSourceRef;
}

const SUPPORTED_RESEARCH_OBJECT_TYPES = new Set<AIContextRequestCandidate["entityType"]>([
  "task",
  "review",
  "experiment",
  "experimentRun",
  "literature",
  "finding",
  "resultItem",
  "outputCandidate",
  "outputGap",
  "researchOutput"
]);

function canonicalIds(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function exactIds(left: readonly string[], right: readonly string[]): boolean {
  const a = canonicalIds(left);
  const b = canonicalIds(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)])
  );
}

export function parseSupplementalContextProjectionFingerprint(
  projections: readonly AIParseSupplementalContextProjection[]
): string {
  const serialized = JSON.stringify(canonicalize(projections));
  let hash = 0x811c9dc5;
  for (const character of serialized) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `lp14-a1-c5-${hash.toString(16).padStart(8, "0")}`;
}

function exactSourceIdentity(requested: AIContextRequestWireRef): string {
  return `${requested.refKind}:${requested.refId}:${requested.contributionKind}`;
}

function unavailableProjection(
  requested: AIContextRequestWireRef,
  ordinal: number,
  disposition: Exclude<AIParseSupplementalContextProjection["disposition"], "PROVIDED">,
  reasonCategory: Exclude<
    AIParseSupplementalContextProjection["reasonCategory"],
    "ALREADY_AUTHORIZED_AND_RESOLVABLE"
  >
): AIParseSupplementalContextProjection {
  return {
    requestItemId: `parse-supplement-${ordinal}`,
    ordinal,
    requestedRef: { ...requested },
    disposition,
    reasonCategory,
    exactSourceIdentity: exactSourceIdentity(requested)
  };
}

function providedProjection(
  requested: AIContextRequestWireRef,
  candidate: AIContextRequestCandidate,
  ordinal: number
): AIParseSupplementalContextProjection {
  return {
    requestItemId: `parse-supplement-${ordinal}`,
    ordinal,
    requestedRef: { ...requested },
    disposition: "PROVIDED",
    reasonCategory: "ALREADY_AUTHORIZED_AND_RESOLVABLE",
    exactSourceIdentity: exactSourceIdentity(requested),
    providedValue: {
      refKind: candidate.refKind,
      refId: candidate.refId,
      entityType: candidate.entityType,
      projectId: candidate.projectId,
      label: candidate.label,
      contributionKind: candidate.contributionKind
    }
  };
}

function resolverErrorDisposition(error: unknown): {
  disposition: "AMBIGUOUS_TARGET" | "UNAVAILABLE" | "UNSUPPORTED_REQUEST_ITEM";
  reasonCategory:
    | "AMBIGUOUS_TARGET"
    | "ALREADY_AUTHORIZED_BUT_UNAVAILABLE"
    | "UNSUPPORTED_REQUEST_ITEM";
} {
  const code = (error as Partial<AIContextRequestValidationError> | undefined)?.code;
  if (code === "CONTEXT_REQUEST_CONTRIBUTION_UNSUPPORTED") {
    return {
      disposition: "UNSUPPORTED_REQUEST_ITEM",
      reasonCategory: "UNSUPPORTED_REQUEST_ITEM"
    };
  }
  if (code === "CONTEXT_REQUEST_REF_AMBIGUOUS" || code === "CONTEXT_REQUEST_REF_OUT_OF_SCOPE") {
    return { disposition: "AMBIGUOUS_TARGET", reasonCategory: "AMBIGUOUS_TARGET" };
  }
  return {
    disposition: "UNAVAILABLE",
    reasonCategory: "ALREADY_AUTHORIZED_BUT_UNAVAILABLE"
  };
}

/**
 * Parse-only mechanical projection. It delegates exact canonical resolution to
 * the existing Context Request resolver and never asks for or creates authority.
 */
export async function resolveAIParseSupplementalContextWithDependencies(input: {
  payload: AIContextRequestWirePayload;
  requestableRefs: readonly AIContextRequestableRef[];
  source: AIParseDraftSourceSnapshot;
}, dependencies: AIParseSupplementalContextResolverDependencies): Promise<AIParseSupplementalContextResolution> {
  const authorizedBodyIds = new Set(input.source.authorizedMaterialFileRefIds);
  const projections: AIParseSupplementalContextProjection[] = [];
  const providedCandidates: AIContextRequestCandidate[] = [];

  for (const [index, requested] of input.payload.requestedRefs.entries()) {
    const ordinal = index + 1;
    const exposedMatches = input.requestableRefs.filter((ref) => (
      ref.refKind === requested.refKind && ref.refId === requested.refId
    ));
    if (exposedMatches.length !== 1 || exposedMatches[0].projectId !== input.source.projectId) {
      projections.push(unavailableProjection(
        requested,
        ordinal,
        "AMBIGUOUS_TARGET",
        "AMBIGUOUS_TARGET"
      ));
      continue;
    }
    const exposed = exposedMatches[0];
    if (
      !exposed.allowedContributionKinds.includes(requested.contributionKind) ||
      (requested.refKind === "AI_RESEARCH_OBJECT" && requested.contributionKind !== "IDENTITY_METADATA")
    ) {
      projections.push(unavailableProjection(
        requested,
        ordinal,
        "UNSUPPORTED_REQUEST_ITEM",
        "UNSUPPORTED_REQUEST_ITEM"
      ));
      continue;
    }
    if (
      requested.refKind === "FILE_REF" && requested.contributionKind === "BODY_CONTENT" &&
      !authorizedBodyIds.has(requested.refId)
    ) {
      // Do not even query current body availability when this ParseAttempt has
      // no BODY authority. Metadata in the frozen requestable index is enough
      // to return the exact NOT_AUTHORIZED projection.
      projections.push(unavailableProjection(
        requested,
        ordinal,
        "NOT_AUTHORIZED",
        "NOT_AUTHORIZED"
      ));
      continue;
    }

    let candidates: AIContextRequestCandidate[];
    try {
      candidates = await dependencies.resolveCandidates(
        input.source.projectId,
        [exposed],
        [requested]
      );
    } catch (error) {
      const classification = resolverErrorDisposition(error);
      projections.push(unavailableProjection(
        requested,
        ordinal,
        classification.disposition,
        classification.reasonCategory
      ));
      continue;
    }
    const candidate = candidates[0];
    if (
      candidates.length !== 1 || !candidate ||
      candidate.refKind !== requested.refKind || candidate.refId !== requested.refId ||
      candidate.contributionKind !== requested.contributionKind ||
      candidate.projectId !== input.source.projectId
    ) {
      projections.push(unavailableProjection(
        requested,
        ordinal,
        "AMBIGUOUS_TARGET",
        "AMBIGUOUS_TARGET"
      ));
      continue;
    }
    if (candidate.entityType !== exposed.entityType || candidate.label !== exposed.label) {
      projections.push(unavailableProjection(
        requested,
        ordinal,
        "UNAVAILABLE",
        "ALREADY_AUTHORIZED_BUT_UNAVAILABLE"
      ));
      continue;
    }
    if (candidate.availability !== "available") {
      const exactFieldMissing = candidate.warning?.toLowerCase().includes("missing") ?? false;
      projections.push(unavailableProjection(
        requested,
        ordinal,
        exactFieldMissing ? "MISSING" : "UNAVAILABLE",
        "ALREADY_AUTHORIZED_BUT_UNAVAILABLE"
      ));
      continue;
    }
    projections.push(providedProjection(requested, candidate, ordinal));
    providedCandidates.push({ ...candidate });
  }

  if (projections.length !== input.payload.requestedRefs.length) {
    throw new Error("Every Parse supplemental request item requires exactly one projection.");
  }
  const projectionFingerprint = parseSupplementalContextProjectionFingerprint(projections);
  return {
    requestedRefs: input.payload.requestedRefs.map((ref) => ({ ...ref })),
    projections,
    providedCandidates,
    projectionFingerprint
  };
}

export function resolveAIParseSupplementalContext(input: {
  payload: AIContextRequestWirePayload;
  requestableRefs: readonly AIContextRequestableRef[];
  source: AIParseDraftSourceSnapshot;
}): Promise<AIParseSupplementalContextResolution> {
  return resolveAIParseSupplementalContextWithDependencies(input, {
    resolveCandidates: resolveAIContextRequestCandidates
  });
}

function approvedContribution(
  candidate: AIContextRequestCandidate
): AIApprovedContextRequestContribution {
  return {
    refKind: candidate.refKind,
    refId: candidate.refId,
    projectId: candidate.projectId,
    label: candidate.label,
    contributionKind: candidate.contributionKind,
    availability: "available",
    fileBodyAuthorizationRequired: candidate.fileBodyAuthorizationRequired
  };
}

function uniqueApprovedContributions(
  contributions: readonly AIApprovedContextRequestContribution[]
): AIApprovedContextRequestContribution[] {
  const unique = new Map<string, AIApprovedContextRequestContribution>();
  for (const contribution of contributions) {
    const key = `${contribution.refKind}:${contribution.refId}:${contribution.contributionKind}`;
    if (!unique.has(key)) unique.set(key, { ...contribution });
  }
  return [...unique.values()].sort((left, right) => (
    left.refKind.localeCompare(right.refKind) ||
    left.refId.localeCompare(right.refId) ||
    left.contributionKind.localeCompare(right.contributionKind)
  ));
}

function materialSelections(contextPackage: AIContextPackage): AIContextMaterialSelection[] {
  return (contextPackage.materialDecisions ?? []).map((material) => ({
    fileRefId: material.fileRefId,
    displayName: material.displayName,
    availabilityStatus: material.availabilityStatus,
    materialReadStatus: material.materialReadStatus,
    materialPromptReservationCharacters: material.materialPromptReservationCharacters,
    ...(material.materialFreshnessReceipt
      ? { materialFreshnessReceipt: { ...material.materialFreshnessReceipt } }
      : {})
  }));
}

function researchObjectSelections(contextPackage: AIContextPackage): AIResearchObjectSelection[] {
  return (contextPackage.researchObjects ?? []).map((descriptor) => ({
    objectType: descriptor.objectType,
    objectId: descriptor.objectId
  }));
}

function uniqueResearchObjectSelections(
  selections: readonly AIResearchObjectSelection[]
): AIResearchObjectSelection[] {
  const unique = new Map<string, AIResearchObjectSelection>();
  for (const selection of selections) {
    const key = `${selection.objectType}:${selection.objectId}`;
    if (!unique.has(key)) unique.set(key, { ...selection });
  }
  return [...unique.values()];
}

function providedResearchObjectSelections(
  candidates: readonly AIContextRequestCandidate[]
): AIResearchObjectSelection[] {
  return candidates.flatMap((candidate): AIResearchObjectSelection[] => {
    if (
      candidate.refKind !== "AI_RESEARCH_OBJECT" ||
      !SUPPORTED_RESEARCH_OBJECT_TYPES.has(candidate.entityType) ||
      candidate.entityType === "fileRef"
    ) return [];
    return [{
      objectType: candidate.entityType as AIResearchObjectSelection["objectType"],
      objectId: candidate.refId
    }];
  });
}

export function createAIParseSupplementalContextPhaseASourceRef(
  logicalAttemptId: string
): AIContextSourceRef {
  return {
    module: "ai",
    entityType: "system",
    entityId: logicalAttemptId,
    label: "Parse supplemental context workflow",
    field: "parseSupplementalContextWorkflow",
    sourceKind: "systemGenerated",
    isUserAuthored: false,
    isAiGenerated: false,
    isVerified: true,
    parseSupplementalContextWorkflowKind: "PARSE_DRAFT",
    parseSupplementalContextPhase: "PHASE_A_ELIGIBLE",
    parseSupplementalContextLogicalAttemptId: logicalAttemptId,
    parseSupplementalContextRequestLimit: 1,
    parseSupplementalContextRequestRemaining: 1,
    parseSupplementalContextAutomaticContinuationCount: 0
  };
}

export function selectInteractiveAIContextRequests(
  readback: Pick<AIConversationReadback, "callAttempts" | "contextRequests">
): AIContextRequest[] {
  const parseCallAttemptIds = new Set(
    readback.callAttempts
      .filter((attempt) => attempt.purpose === "parse_draft")
      .map((attempt) => attempt.id)
  );
  return readback.contextRequests.filter((request) => (
    !parseCallAttemptIds.has(request.sourceCallAttemptId)
  ));
}

export function createAIParseSupplementalContextPhaseBSourceRef(input: {
  logicalAttemptId: string;
  sourceCallAttemptId: string;
  resolution: AIParseSupplementalContextResolution;
}): AIContextSourceRef {
  return {
    module: "ai",
    entityType: "system",
    entityId: input.resolution.projectionFingerprint,
    label: "Parse supplemental context projection",
    field: "parseSupplementalContextWorkflow",
    sourceKind: "systemGenerated",
    isUserAuthored: false,
    isAiGenerated: false,
    isVerified: true,
    parseSupplementalContextWorkflowKind: "PARSE_DRAFT",
    parseSupplementalContextPhase: "PHASE_B_AUTOMATIC",
    parseSupplementalContextLogicalAttemptId: input.logicalAttemptId,
    parseSupplementalContextSourceCallAttemptId: input.sourceCallAttemptId,
    parseSupplementalContextRequestLimit: 1,
    parseSupplementalContextRequestRemaining: 0,
    parseSupplementalContextAutomaticContinuationCount: 1,
    parseSupplementalContextProjectionFingerprint: input.resolution.projectionFingerprint,
    parseSupplementalContextProjections: input.resolution.projections.map((projection) => ({
      ...projection,
      requestedRef: { ...projection.requestedRef },
      ...(projection.providedValue ? { providedValue: { ...projection.providedValue } } : {})
    }))
  };
}

function projectionPromptDelta(resolution: AIParseSupplementalContextResolution): string {
  const items = resolution.projections.map((projection) => JSON.stringify({
    requestItemId: projection.requestItemId,
    ordinal: projection.ordinal,
    requestedRef: projection.requestedRef,
    projection: projection.disposition,
    reasonCategory: projection.reasonCategory,
    exactSourceIdentity: projection.exactSourceIdentity,
    ...(projection.providedValue ? { providedValue: projection.providedValue } : {})
  }));
  return [
    "LP14-A1-C5 automatic Parse supplemental-context projection:",
    `ProjectionFingerprint: ${resolution.projectionFingerprint}`,
    `RequestItemCount: ${resolution.requestedRefs.length}`,
    `ProjectionItemCount: ${resolution.projections.length}`,
    "Each JSON line below corresponds to exactly one Phase-A request item. PROVIDED values are also present through the canonical ContextPackage/material channel; other dispositions are truthful non-values and must not be guessed or substituted.",
    ...items,
    "This is Phase B. Return the final LABPOD_STANDARD_RESULT_OUTCOME_V2 object now. A second AI_CONTEXT_REQUEST, free-text waiting state, or user-approval request is forbidden."
  ].join("\n");
}

export async function prepareAIParseSupplementalContextContinuation(input: {
  conversationId: string;
  logicalAttemptId: string;
  sourceCallAttemptId: string;
  baseContextPackage: AIContextPackage;
  baseSource: AIParseDraftSourceSnapshot;
  resolution: AIParseSupplementalContextResolution;
  readback: AIConversationReadback;
  outputDetailPreference?: import("../types/aiContext").AIOutputDetailPreference;
  technicalCapacityChars?: number;
}): Promise<AIParseSupplementalContextContinuation> {
  const sourceAttempt = input.readback.callAttempts.find((attempt) => (
    attempt.id === input.sourceCallAttemptId
  ));
  if (
    !sourceAttempt || sourceAttempt.purpose !== "parse_draft" ||
    sourceAttempt.status !== "succeeded" || sourceAttempt.resultMessageId ||
    sourceAttempt.triggerMessageId !== input.baseSource.triggerMessageId ||
    sourceAttempt.conversationId !== input.conversationId ||
    input.logicalAttemptId !== input.sourceCallAttemptId
  ) {
    throw new Error("The automatic Parse supplemental continuation lost its exact Phase-A lineage.");
  }
  if (
    input.baseContextPackage.scope.type !== "project" ||
    input.baseContextPackage.scope.id !== input.baseSource.projectId ||
    input.baseContextPackage.reviewFingerprint !== input.baseSource.contextReviewFingerprint ||
    input.resolution.projections.length !== input.resolution.requestedRefs.length ||
    parseSupplementalContextProjectionFingerprint(input.resolution.projections) !==
      input.resolution.projectionFingerprint
  ) {
    throw new Error("The automatic Parse supplemental projection does not match the frozen Phase-A snapshot.");
  }

  const baseResearchObjects = researchObjectSelections(input.baseContextPackage);
  const providedResearchObjects = providedResearchObjectSelections(
    input.resolution.providedCandidates
  );
  const expandedResearchObjects = uniqueResearchObjectSelections([
    ...baseResearchObjects,
    ...providedResearchObjects
  ]);
  if (expandedResearchObjects.length > AI_RESEARCH_OBJECT_SELECTION_MAX) {
    throw new Error(
      `The automatic Parse supplemental object set exceeds the canonical ${AI_RESEARCH_OBJECT_SELECTION_MAX}-object bound.`
    );
  }
  const selectedMaterials = materialSelections(input.baseContextPackage);
  if (!exactIds(
    selectedMaterials.map((material) => material.fileRefId),
    input.baseSource.authorizedMaterialFileRefIds
  )) {
    throw new Error("The frozen Parse material authorization snapshot changed before Phase B.");
  }
  const approvedContributions = uniqueApprovedContributions([
    ...(input.baseContextPackage.approvedContextRequestContributions ?? []),
    ...input.resolution.providedCandidates.map(approvedContribution)
  ]);
  const contextPackage = await buildAIContext({
    scopeType: "project",
    scopeId: input.baseSource.projectId,
    contextMode: input.baseSource.contextMode,
    researchObjects: expandedResearchObjects,
    selectedMaterials,
    approvedContextRequestContributions: approvedContributions,
    budget: { ...input.baseSource.contextBudget }
  });
  const rebuiltSelections = uniqueResearchObjectSelections(
    researchObjectSelections(contextPackage)
  );
  if (
    contextPackage.scope.id !== input.baseSource.projectId ||
    rebuiltSelections.length !== expandedResearchObjects.length ||
    !exactIds(
      rebuiltSelections.map((selection) => `${selection.objectType}:${selection.objectId}`),
      expandedResearchObjects.map((selection) => `${selection.objectType}:${selection.objectId}`)
    ) ||
    contextPackage.warnings?.some((warning) => warning.severity === "error")
  ) {
    throw new Error("The canonical Context Builder could not preserve the exact Parse supplemental scope.");
  }

  const projectionSourceRef = createAIParseSupplementalContextPhaseBSourceRef({
    logicalAttemptId: input.logicalAttemptId,
    sourceCallAttemptId: input.sourceCallAttemptId,
    resolution: input.resolution
  });
  const contextRequestFollowupState = {
    scope: "SAME_PARSE_ATTEMPT_AUTOMATIC_FOLLOWUP",
    limit: 1,
    remaining: 0,
    state: "CONTEXT_EXHAUSTED"
  } as const;
  const built = await buildAIParseDraftPromptPackage({
    conversationId: input.conversationId,
    contextPackage,
    technicalCapacityChars: input.technicalCapacityChars ?? AI_PROVIDER_PROMPT_TECHNICAL_MAX_CHARS,
    readback: input.readback,
    runScopedDirective: PARSE_DRAFT_STANDARD_RESULT_ONLY_DIRECTIVE,
    parseDynamicRunScopedSegments: [projectionPromptDelta(input.resolution)],
    contextRequestFollowupState,
    parseSupplementalContext: {
      sourceCallAttemptId: input.sourceCallAttemptId,
      baseSource: structuredClone(input.baseSource),
      baseResearchObjects: baseResearchObjects.map((selection) => ({ ...selection })),
      providedResearchObjects: providedResearchObjects.map((selection) => ({ ...selection })),
      projectionFingerprint: input.resolution.projectionFingerprint
    },
    additionalSourceRefs: [projectionSourceRef],
    outputDetailPreference: input.outputDetailPreference ?? "STANDARD"
  });
  if (
    built.promptPackage.providerPromptEnvelope.contextRequestResponseContract ||
    built.promptPackage.providerPromptEnvelope.contextRequestFollowupState?.scope !==
      "SAME_PARSE_ATTEMPT_AUTOMATIC_FOLLOWUP" ||
    built.promptPackage.budgetSummary?.technicalCapacity?.status ===
      "TECHNICAL_CAPACITY_OR_SAFETY_ERROR" ||
    built.promptPackage.warnings?.some((warning) => warning.severity === "error")
  ) {
    throw new Error("The automatic Parse Phase-B PromptPackage failed its no-second-request guard.");
  }
  return {
    contextPackage,
    promptPackage: built.promptPackage,
    source: built.source,
    authorizedBodyFileRefIds: [...input.baseSource.authorizedMaterialFileRefIds],
    projectionSourceRef
  };
}
