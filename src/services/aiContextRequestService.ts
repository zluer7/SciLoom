import { createRepositoryEntityId } from "../repositories/entityId";
import { aiConversationRepository } from "../repositories/aiConversationRepository";
import type {
  AIContextPackage,
  AIContextRequestableRef,
  AIRequestedContributionKind
} from "../types/aiContext";
import type {
  AIContextRequestCandidate,
  AIContextRequestAlreadySuppliedRef,
  AIContextRequestResponseContract,
  AIContextRequestWirePayload,
  AIContextRequestWireRef,
  ParsedAIContextRequestResult
} from "../types/aiContextRequest";
import { resolveTaskResearchObjectDescriptor } from "./taskAIResearchObjectAdapter";
import { resolveReviewResearchObjectDescriptor } from "./reviewAIResearchObjectAdapter";
import { resolveExperimentResearchObjectDescriptor } from "./experimentAIResearchObjectAdapter";
import { resolveExperimentRunResearchObjectDescriptor } from "./experimentRunAIResearchObjectAdapter";
import { resolveLiteratureResearchObjectDescriptor } from "./literatureAIResearchObjectAdapter";
import { resolveFindingResearchObjectDescriptor } from "./findingAIResearchObjectAdapter";
import {
  resolveOutputsResearchObjectDescriptor,
  type OutputsAIResearchObjectType
} from "./outputsAIResearchObjectAdapter";

export const AI_CONTEXT_REQUEST_WIRE_START = "<labpod_context_request>" as const;
export const AI_CONTEXT_REQUEST_WIRE_END = "</labpod_context_request>" as const;
export const AI_CONTEXT_REQUEST_MAX_REFS = 8;
export const AI_CONTEXT_REQUEST_MAX_REASON_CHARS = 600;
export const AI_CONTEXT_REQUEST_MAX_ASSISTANT_TEXT_CHARS = 2_000;
export const AI_CONTEXT_REQUEST_MAX_SERIALIZED_CHARS = 12_000;
export const AI_CONTEXT_REQUEST_MAX_REQUESTABLE_REFS = 64;

export type AIContextRequestValidationErrorCode =
  | "CONTEXT_REQUEST_PAYLOAD_TOO_LARGE"
  | "CONTEXT_REQUEST_PAYLOAD_INVALID"
  | "CONTEXT_REQUEST_REASON_INVALID"
  | "CONTEXT_REQUEST_ASSISTANT_TEXT_INVALID"
  | "CONTEXT_REQUEST_REF_COUNT_INVALID"
  | "CONTEXT_REQUEST_REF_INVALID"
  | "CONTEXT_REQUEST_REF_AMBIGUOUS"
  | "CONTEXT_REQUEST_REF_OUT_OF_SCOPE"
  | "CONTEXT_REQUEST_CONTRIBUTION_UNSUPPORTED";

export class AIContextRequestValidationError extends Error {
  constructor(
    readonly code: AIContextRequestValidationErrorCode,
    message: string
  ) {
    super(message);
    this.name = "AIContextRequestValidationError";
  }
}

function chars(value: string): number {
  return Array.from(value).length;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonicalExpected = [...expected].sort();
  return actual.length === canonicalExpected.length &&
    actual.every((key, index) => key === canonicalExpected[index]);
}

function boundedText(
  value: unknown,
  maxChars: number,
  code: AIContextRequestValidationErrorCode,
  field: string
): string {
  if (typeof value !== "string") {
    throw new AIContextRequestValidationError(code, `${field} must be text.`);
  }
  const normalized = value.replace(/\0/gu, "").trim();
  if (!normalized || chars(normalized) > maxChars) {
    throw new AIContextRequestValidationError(
      code,
      `${field} must contain 1-${maxChars} characters without truncation.`
    );
  }
  return normalized;
}

function parseRef(value: unknown): AIContextRequestWireRef {
  const candidate = record(value);
  const refKind = candidate?.refKind;
  const refId = candidate?.refId;
  const contributionKind = candidate?.contributionKind;
  if (
    !candidate || !hasExactKeys(candidate, ["refKind", "refId", "contributionKind"]) ||
    (refKind !== "AI_RESEARCH_OBJECT" && refKind !== "FILE_REF") ||
    typeof refId !== "string" || !refId.trim() || refId !== refId.trim() ||
    chars(refId) > 200 || /[\0-\x1F\x7F]/u.test(refId) ||
    (contributionKind !== "IDENTITY_METADATA" && contributionKind !== "BODY_CONTENT")
  ) {
    throw new AIContextRequestValidationError(
      "CONTEXT_REQUEST_REF_INVALID",
      "Each requested ref requires an exact supported refKind, canonical refId, and contributionKind."
    );
  }
  return { refKind, refId, contributionKind };
}

/** Shared A5 semantic validator for callers that already performed the one authorized JSON decode. */
export function validateAIContextRequestDecodedObject(value: unknown): AIContextRequestWirePayload {
  const payload = record(value);
  if (
    !payload ||
    !hasExactKeys(payload, ["version", "assistantText", "reason", "requestedRefs"]) ||
    payload.version !== 1 ||
    !Array.isArray(payload.requestedRefs)
  ) {
    throw new AIContextRequestValidationError(
      "CONTEXT_REQUEST_PAYLOAD_INVALID",
      "The Context Request payload shape or version is invalid."
    );
  }
  if (payload.requestedRefs.length < 1 || payload.requestedRefs.length > AI_CONTEXT_REQUEST_MAX_REFS) {
    throw new AIContextRequestValidationError(
      "CONTEXT_REQUEST_REF_COUNT_INVALID",
      `A Context Request requires 1-${AI_CONTEXT_REQUEST_MAX_REFS} refs without truncation.`
    );
  }
  const refs = payload.requestedRefs.map(parseRef);
  const unique = new Map<string, AIContextRequestWireRef>();
  for (const ref of refs) {
    const identity = `${ref.refKind}:${ref.refId}`;
    const prior = unique.get(identity);
    if (prior && prior.contributionKind !== ref.contributionKind) {
      throw new AIContextRequestValidationError(
        "CONTEXT_REQUEST_REF_AMBIGUOUS",
        `Requested ref ${identity} has conflicting contribution kinds.`
      );
    }
    if (!prior) unique.set(identity, ref);
  }
  const requestedRefs = [...unique.values()].sort((left, right) =>
    left.refKind.localeCompare(right.refKind) ||
    left.refId.localeCompare(right.refId) ||
    left.contributionKind.localeCompare(right.contributionKind)
  );
  return {
    version: 1,
    assistantText: boundedText(
      payload.assistantText,
      AI_CONTEXT_REQUEST_MAX_ASSISTANT_TEXT_CHARS,
      "CONTEXT_REQUEST_ASSISTANT_TEXT_INVALID",
      "assistantText"
    ),
    reason: boundedText(
      payload.reason,
      AI_CONTEXT_REQUEST_MAX_REASON_CHARS,
      "CONTEXT_REQUEST_REASON_INVALID",
      "reason"
    ),
    requestedRefs
  };
}

/** The sole parser owner. Only an exact whole-response wrapper can create request authority. */
export function parseAIContextRequestResponse(text: string): ParsedAIContextRequestResult {
  const normalized = text.trim();
  const starts = normalized.startsWith(AI_CONTEXT_REQUEST_WIRE_START);
  const ends = normalized.endsWith(AI_CONTEXT_REQUEST_WIRE_END);
  const containsWireMarker = normalized.includes(AI_CONTEXT_REQUEST_WIRE_START) ||
    normalized.includes(AI_CONTEXT_REQUEST_WIRE_END);
  if (!starts && !ends && !containsWireMarker) {
    return { kind: "plain_text", assistantText: text };
  }
  try {
    if (!starts || !ends) {
      throw new AIContextRequestValidationError(
        "CONTEXT_REQUEST_PAYLOAD_INVALID",
        "The structured Context Request wrapper is incomplete."
      );
    }
    const serialized = normalized.slice(
      AI_CONTEXT_REQUEST_WIRE_START.length,
      normalized.length - AI_CONTEXT_REQUEST_WIRE_END.length
    ).trim();
    if (!serialized || chars(serialized) > AI_CONTEXT_REQUEST_MAX_SERIALIZED_CHARS) {
      throw new AIContextRequestValidationError(
        "CONTEXT_REQUEST_PAYLOAD_TOO_LARGE",
        `The Context Request JSON must fit within ${AI_CONTEXT_REQUEST_MAX_SERIALIZED_CHARS} characters without truncation.`
      );
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(serialized);
    } catch {
      throw new AIContextRequestValidationError(
        "CONTEXT_REQUEST_PAYLOAD_INVALID",
        "The Context Request JSON is malformed."
      );
    }
    const payload = validateAIContextRequestDecodedObject(decoded);
    return { kind: "context_request", assistantText: payload.assistantText, payload };
  } catch (error) {
    const typed = error instanceof AIContextRequestValidationError
      ? error
      : new AIContextRequestValidationError(
          "CONTEXT_REQUEST_PAYLOAD_INVALID",
          "The Context Request payload is invalid."
        );
    return {
      kind: "invalid_structured",
      assistantText: "The assistant returned an invalid Context Request. No request was created.",
      errorCode: typed.code,
      errorMessage: typed.message
    };
  }
}

function safeLabel(value: string, fallback: string): string {
  const cleaned = value.replace(/[\0-\x1F\x7F]/gu, " ").trim();
  const parts = cleaned.split(/[\\/]/u).filter(Boolean);
  const leaf = parts[parts.length - 1]?.trim();
  return Array.from(leaf || fallback).slice(0, 160).join("");
}

export function createAIContextRequestResponseContract(
  contextPackage: AIContextPackage
): AIContextRequestResponseContract | undefined {
  const projectId = contextPackage.scope.type === "project"
    ? contextPackage.scope.id?.trim()
    : undefined;
  const supplied = new Map<string, AIContextRequestAlreadySuppliedRef>();
  const addSupplied = (
    refKind: AIContextRequestAlreadySuppliedRef["refKind"],
    refId: string,
    suppliedProjectId: string,
    contributionKind: AIRequestedContributionKind
  ) => {
    const key = `${refKind}:${refId}:${contributionKind}`;
    if (!supplied.has(key)) {
      supplied.set(key, { refKind, refId, projectId: suppliedProjectId, contributionKind });
    }
  };
  for (const descriptor of contextPackage.researchObjects ?? []) {
    addSupplied(
      "AI_RESEARCH_OBJECT",
      descriptor.objectId,
      descriptor.projectId,
      "IDENTITY_METADATA"
    );
  }
  const requestableResearchObjectIdentityRefs = new Map(
    (contextPackage.requestableRefs ?? [])
      .filter((ref) => (
        ref.refKind === "AI_RESEARCH_OBJECT" &&
        ref.allowedContributionKinds.includes("IDENTITY_METADATA")
      ))
      .map((ref) => [ref.refId, ref] as const)
  );
  for (const sourceRef of contextPackage.sourceRefs ?? []) {
    if (sourceRef.contextDisposition !== "included") continue;
    const requestableRef = requestableResearchObjectIdentityRefs.get(sourceRef.entityId);
    if (!requestableRef) continue;
    addSupplied(
      "AI_RESEARCH_OBJECT",
      requestableRef.refId,
      requestableRef.projectId,
      "IDENTITY_METADATA"
    );
  }
  if (projectId) {
    for (const decision of contextPackage.materialDecisions ?? []) {
      if (!decision.selected) continue;
      addSupplied("FILE_REF", decision.fileRefId, projectId, "IDENTITY_METADATA");
      addSupplied("FILE_REF", decision.fileRefId, projectId, "BODY_CONTENT");
    }
  }
  for (const contribution of contextPackage.approvedContextRequestContributions ?? []) {
    addSupplied(
      contribution.refKind,
      contribution.refId,
      contribution.projectId,
      "IDENTITY_METADATA"
    );
    if (contribution.contributionKind === "BODY_CONTENT") {
      addSupplied(
        contribution.refKind,
        contribution.refId,
        contribution.projectId,
        "BODY_CONTENT"
      );
    }
  }
  const suppliedKinds = new Set(supplied.keys());
  const requestableRefs = [...(contextPackage.requestableRefs ?? [])]
    .map((ref) => ({
      ...ref,
      allowedContributionKinds: ref.allowedContributionKinds.filter((kind) => (
        !suppliedKinds.has(`${ref.refKind}:${ref.refId}:${kind}`)
      ))
    }))
    .filter((ref) => ref.allowedContributionKinds.length > 0)
    .sort((left, right) => left.refKind.localeCompare(right.refKind) || left.refId.localeCompare(right.refId));
  if (requestableRefs.length === 0 || requestableRefs.length > AI_CONTEXT_REQUEST_MAX_REQUESTABLE_REFS) {
    return undefined;
  }
  return {
    contract: "LABPOD_CONTEXT_REQUEST_V1",
    wrapperStart: AI_CONTEXT_REQUEST_WIRE_START,
    wrapperEnd: AI_CONTEXT_REQUEST_WIRE_END,
    requestableRefs: requestableRefs.map((ref) => ({
      ...ref,
      label: safeLabel(ref.label, ref.refId),
      allowedContributionKinds: [...ref.allowedContributionKinds]
    })),
    alreadySuppliedRefs: [...supplied.values()].sort((left, right) =>
      left.refKind.localeCompare(right.refKind) ||
      left.refId.localeCompare(right.refId) ||
      left.contributionKind.localeCompare(right.contributionKind)),
    contributionKinds: ["IDENTITY_METADATA", "BODY_CONTENT"]
  };
}

export type AIContextRequestCandidateResolverDependencies = {
  resolveTask: typeof resolveTaskResearchObjectDescriptor;
  resolveReview?: typeof resolveReviewResearchObjectDescriptor;
  resolveExperiment?: typeof resolveExperimentResearchObjectDescriptor;
  resolveExperimentRun?: typeof resolveExperimentRunResearchObjectDescriptor;
  resolveLiterature?: typeof resolveLiteratureResearchObjectDescriptor;
  resolveFinding?: typeof resolveFindingResearchObjectDescriptor;
  resolveOutputs?: typeof resolveOutputsResearchObjectDescriptor;
  listFileRefs: typeof aiConversationRepository.listAttachmentFileRefs;
};

export async function resolveAIContextRequestCandidatesWithDependencies(
  projectId: string,
  requestableRefs: readonly AIContextRequestableRef[],
  requestedRefs: readonly AIContextRequestWireRef[],
  dependencies: AIContextRequestCandidateResolverDependencies
): Promise<AIContextRequestCandidate[]> {
  const index = new Map(requestableRefs.map((ref) => [`${ref.refKind}:${ref.refId}`, ref]));
  const fileCatalog = requestedRefs.some((ref) => ref.refKind === "FILE_REF")
    ? await dependencies.listFileRefs()
    : undefined;
  const candidates: AIContextRequestCandidate[] = [];
  for (const requested of [...requestedRefs].sort((left, right) =>
    left.refKind.localeCompare(right.refKind) || left.refId.localeCompare(right.refId)
  )) {
    const exposed = index.get(`${requested.refKind}:${requested.refId}`);
    if (!exposed || exposed.projectId !== projectId) {
      throw new AIContextRequestValidationError(
        "CONTEXT_REQUEST_REF_OUT_OF_SCOPE",
        `Requested ref ${requested.refKind}:${requested.refId} is not in the current canonical requestable index.`
      );
    }
    if (!exposed.allowedContributionKinds.includes(requested.contributionKind)) {
      throw new AIContextRequestValidationError(
        "CONTEXT_REQUEST_CONTRIBUTION_UNSUPPORTED",
        `Requested contribution ${requested.contributionKind} is not allowed for ${requested.refKind}:${requested.refId}.`
      );
    }
    if (requested.refKind === "AI_RESEARCH_OBJECT") {
      if (
        exposed.entityType !== "task" &&
        exposed.entityType !== "review" &&
        exposed.entityType !== "experiment" &&
        exposed.entityType !== "experimentRun" &&
        exposed.entityType !== "literature" &&
        exposed.entityType !== "finding" &&
        exposed.entityType !== "resultItem" &&
        exposed.entityType !== "outputCandidate" &&
        exposed.entityType !== "outputGap" &&
        exposed.entityType !== "researchOutput"
      ) {
        throw new AIContextRequestValidationError(
          "CONTEXT_REQUEST_REF_OUT_OF_SCOPE",
          `Requested research object ${requested.refId} has no canonical object type.`
        );
      }
      const descriptor = exposed.entityType === "task"
        ? await dependencies.resolveTask(requested.refId, projectId)
        : exposed.entityType === "review"
          ? await (dependencies.resolveReview ?? resolveReviewResearchObjectDescriptor)(requested.refId, projectId)
          : exposed.entityType === "experiment"
            ? await (dependencies.resolveExperiment ?? resolveExperimentResearchObjectDescriptor)(requested.refId, projectId)
            : exposed.entityType === "experimentRun"
              ? await (dependencies.resolveExperimentRun ?? resolveExperimentRunResearchObjectDescriptor)(requested.refId, projectId)
              : exposed.entityType === "literature"
                ? await (dependencies.resolveLiterature ?? resolveLiteratureResearchObjectDescriptor)(requested.refId, projectId)
                : exposed.entityType === "finding"
                  ? await (dependencies.resolveFinding ?? resolveFindingResearchObjectDescriptor)(requested.refId, projectId)
                  : await (dependencies.resolveOutputs ?? resolveOutputsResearchObjectDescriptor)(
                      exposed.entityType as OutputsAIResearchObjectType,
                      requested.refId,
                      projectId
                    );
      const literatureMetadata = descriptor.objectType === "literature"
        ? {
            literatureProjectAssociationKind: descriptor.safeMetadata?.projectAssociationKind === "assigned"
              ? "assigned" as const
              : "projectless" as const,
            literatureCanonicalProjectId: typeof descriptor.safeMetadata?.canonicalProjectId === "string"
              ? descriptor.safeMetadata.canonicalProjectId
              : null,
            literatureConversationProjectEligibilityDisposition:
              descriptor.safeMetadata?.conversationProjectEligibilityDisposition === "allowed_same_project"
                ? "allowed_same_project" as const
                : "allowed_global_projectless" as const,
            literatureNormalizedProjectionFingerprint:
              typeof descriptor.safeMetadata?.normalizedProjectionFingerprint === "string"
                ? descriptor.safeMetadata.normalizedProjectionFingerprint
                : ""
          }
        : {};
      if (descriptor.objectType === "route") {
        throw new AIContextRequestValidationError(
          "CONTEXT_REQUEST_CONTRIBUTION_UNSUPPORTED",
          "Route is available as explicitly selected Level-1 context, not as a new Context Request authority."
        );
      }
      candidates.push({
        refKind: requested.refKind,
        refId: descriptor.objectId,
        entityType: descriptor.objectType,
        projectId: descriptor.projectId,
        label: descriptor.label,
        contributionKind: requested.contributionKind,
        availability: "available",
        fileBodyAuthorizationRequired: false,
        proposedContribution: `${descriptor.objectType === "task"
          ? "Task"
          : descriptor.objectType === "review"
            ? "Review"
            : descriptor.objectType === "experiment"
              ? "Experiment"
              : descriptor.objectType === "experimentRun"
                ? "ExperimentRun"
                : descriptor.objectType === "literature"
                  ? "Literature"
                  : "Finding"} identity and A2-governed object-scoped context for one follow-up call.`,
        ...literatureMetadata
      });
      continue;
    }
    const fileRef = fileCatalog?.fileRefs.find((candidate) => candidate.fileRefId === requested.refId);
    if (!fileRef) {
      candidates.push({
        refKind: requested.refKind,
        refId: requested.refId,
        entityType: "fileRef",
        projectId,
        label: exposed.label,
        contributionKind: requested.contributionKind,
        availability: "unavailable",
        fileBodyAuthorizationRequired: requested.contributionKind === "BODY_CONTENT",
        proposedContribution: "No contribution; the canonical FileRef is unavailable.",
        warning: "The canonical FileRef is missing or inactive."
      });
      continue;
    }
    const bodyAvailable = fileRef.resourceKind === "file" &&
      fileRef.availabilityStatus === "available" && fileRef.materialReadStatus === "supported";
    const available = requested.contributionKind === "IDENTITY_METADATA" || bodyAvailable;
    candidates.push({
      refKind: requested.refKind,
      refId: fileRef.fileRefId,
      entityType: "fileRef",
      projectId,
      label: fileRef.displayName,
      contributionKind: requested.contributionKind,
      availability: available ? "available" : "unavailable",
      fileBodyAuthorizationRequired: requested.contributionKind === "BODY_CONTENT",
      proposedContribution: requested.contributionKind === "BODY_CONTENT"
        ? "FileRef identity plus explicitly authorized, bounded UTF-8 text body for one follow-up call."
        : "FileRef identity metadata only; no file body read.",
      ...(!available ? { warning: "The FileRef body is unavailable or unsupported for the authorized material reader." } : {})
    });
  }
  return candidates;
}

export function resolveAIContextRequestCandidates(
  projectId: string,
  requestableRefs: readonly AIContextRequestableRef[],
  requestedRefs: readonly AIContextRequestWireRef[]
): Promise<AIContextRequestCandidate[]> {
  return resolveAIContextRequestCandidatesWithDependencies(projectId, requestableRefs, requestedRefs, {
    resolveTask: resolveTaskResearchObjectDescriptor,
    resolveReview: resolveReviewResearchObjectDescriptor,
    resolveExperiment: resolveExperimentResearchObjectDescriptor,
    resolveExperimentRun: resolveExperimentRunResearchObjectDescriptor,
    resolveLiterature: resolveLiteratureResearchObjectDescriptor,
    resolveFinding: resolveFindingResearchObjectDescriptor,
    resolveOutputs: resolveOutputsResearchObjectDescriptor,
    listFileRefs: aiConversationRepository.listAttachmentFileRefs
  });
}

export function createAIContextRequestId(): string {
  return createRepositoryEntityId("ai-context-request");
}

export function contextRequestCandidateFingerprint(
  candidates: readonly AIContextRequestCandidate[]
): string {
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)])
    );
  };
  const canonical = JSON.stringify(canonicalize([...candidates].sort((left, right) =>
    left.refKind.localeCompare(right.refKind) ||
    left.refId.localeCompare(right.refId) ||
    left.contributionKind.localeCompare(right.contributionKind)
  )));
  let hash = 0x811c9dc5;
  for (const character of canonical) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `lp13-a5-${hash.toString(16).padStart(8, "0")}`;
}

export function requestedBodyFileRefIds(
  candidates: readonly AIContextRequestCandidate[]
): string[] {
  return candidates
    .filter((candidate) => candidate.refKind === "FILE_REF" && candidate.contributionKind === "BODY_CONTENT")
    .map((candidate) => candidate.refId)
    .sort();
}

export function contributionKindLabel(kind: AIRequestedContributionKind): string {
  return kind === "BODY_CONTENT" ? "body content" : "identity metadata";
}
