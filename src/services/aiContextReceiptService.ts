import type { AICallAttempt, AIConversationReadback } from "../types/aiConversation";
import type {
  AIApprovedContextRequestContribution,
  AIContextMode,
  AILevel4IncludedItem,
  AILevel4Snapshot,
  AIResearchObjectSelection,
  AIResearchObjectType
} from "../types/aiContext";
import {
  hasAIConstraintProvenance,
  readAIConstraintFromSourceRefs,
  type AIConstraintReadback
} from "./aiConstraintService";
import { readExperimentRunParentRelations } from "./experimentRunAIResearchObjectAdapter";
import { readLiteratureAssociationTuples } from "./literatureAIResearchObjectAdapter";
import { PROJECT_LEVEL4_RELATION_INDEX_POLICY } from "./projectLevel4RelationIndexProjection";
import { normalizeAIContextMode } from "./aiContextBuilderService";

export type AIFrozenContextSelection = {
  projectId: string;
  contextMode: AIContextMode;
  researchObjects: AIResearchObjectSelection[];
};

export type AILatestAssistantMessageContextCustody = {
  assistantMessageId: string;
  sourceCallAttemptId: string;
  selection: AIFrozenContextSelection;
};

/**
 * Restart-readable custody for identity Context that was supplied by one
 * approved foreground request and then preserved unchanged by later ordinary
 * Chat calls. It carries no FileRef body or material authorization.
 */
export type AILatestAssistantAttachedContextCustody =
  AILatestAssistantMessageContextCustody & {
    contextRequestId: string;
    approvalActionMessageId: string;
    followupCallAttemptId: string;
    baseSelection: AIFrozenContextSelection;
    approvedContextRequestContributions: AIApprovedContextRequestContribution[];
  };

export type AIContextReceipt = {
  attemptId: string;
  contextPackageId: string;
  project: { id: string; label?: string };
  primaryRoutes: Array<{ id: string; label?: string }>;
  primaryTasks: Array<{ id: string; label?: string }>;
  primaryReviews: Array<{ id: string; label?: string }>;
  primaryExperiments: Array<{ id: string; label?: string }>;
  primaryExperimentRuns: Array<{
    id: string;
    label?: string;
    parentExperimentId: string;
    projectId: string;
    selectionOrder: number;
  }>;
  primaryLiterature: Array<{
    id: string;
    label?: string;
    projectAssociationKind: "assigned" | "projectless";
    canonicalProjectId: string | null;
    lifecycleEligibility: "eligible";
    conversationProjectEligibilityDisposition: "allowed_same_project" | "allowed_global_projectless";
    selectionOrder: number;
    normalizedProjectionFingerprint: string;
  }>;
  primaryFindings: Array<{ id: string; label?: string }>;
  primaryOutputObjects: Array<{
    objectType: "resultItem" | "outputCandidate" | "outputGap" | "researchOutput";
    id: string;
    label?: string;
  }>;
  literatureSelectionAggregateEligibility: "ALLOWED";
  contextMode: AIContextMode;
  includedSourceCount: number;
  excludedSourceCount: number;
  warningCount: number;
  warningCodes: string[];
  authorizedMaterials: Array<{ fileRefId: string; displayName: string }>;
  constraint: AIConstraintReadback;
  level4Snapshot?: AILevel4Snapshot;
};

const LEVEL4_OBJECT_RANK = new Map(
  PROJECT_LEVEL4_RELATION_INDEX_POLICY.objectOrder.map((objectType, index) => [objectType, index])
);

function primaryResearchObjectType(entityType: string): AIResearchObjectType | undefined {
  if (entityType === "routeNode") return "route";
  if (
    entityType === "task" ||
    entityType === "review" ||
    entityType === "experiment" ||
    entityType === "experimentRun" ||
    entityType === "literature" ||
    entityType === "finding" ||
    entityType === "resultItem" ||
    entityType === "outputCandidate" ||
    entityType === "outputGap" ||
    entityType === "researchOutput"
  ) return entityType;
  return undefined;
}

/** Reads the actual-sent Level-4 snapshot only from immutable CallAttempt source refs. */
export function readFrozenLevel4Snapshot(
  attempt: AICallAttempt
): AILevel4Snapshot | undefined | null {
  const projectRef = attempt.contextSourceRefs.find((sourceRef) => (
    sourceRef.contextRole === "scope" && sourceRef.entityType === "project"
  ));
  if (!projectRef?.level4SnapshotFingerprint) return undefined;
  if (
    projectRef.level4SnapshotPolicyVersion !== "lp13-b1-c3-level4-v1" ||
    !projectRef.level4SnapshotDecision ||
    typeof projectRef.level4IncludedItemCount !== "number" ||
    !Array.isArray(projectRef.level4ExclusionSummary)
  ) return null;

  const includedByIdentity = new Map<string, AILevel4IncludedItem>();
  for (const sourceRef of attempt.contextSourceRefs) {
    if (!sourceRef.level4ObjectType || sourceRef.contextLevel !== 4) continue;
    if (sourceRef.contextDisposition === "excluded") continue;
    if (
      sourceRef.contextRole !== "background" ||
      sourceRef.level4CanonicalProjectId !== projectRef.entityId ||
      !sourceRef.label ||
      !sourceRef.level4MembershipSource ||
      !sourceRef.level4RelationSource ||
      !sourceRef.level4InclusionReason ||
      !Array.isArray(sourceRef.level4RelationKeys)
    ) return null;
    const identity = `${sourceRef.level4ObjectType}:${sourceRef.entityId}`;
    if (includedByIdentity.has(identity)) return null;
    includedByIdentity.set(identity, {
      objectType: sourceRef.level4ObjectType,
      canonicalId: sourceRef.entityId,
      safeLabel: sourceRef.label,
      safeSummary: sourceRef.level4SafeSummary,
      status: sourceRef.level4Status,
      relationKeys: sourceRef.level4RelationKeys.map((relationKey) => ({ ...relationKey })),
      membershipSource: sourceRef.level4MembershipSource,
      relationSource: sourceRef.level4RelationSource,
      inclusionReason: sourceRef.level4InclusionReason
    });
  }
  if (includedByIdentity.size !== projectRef.level4IncludedItemCount) return null;
  const includedItems = [...includedByIdentity.values()].sort((left, right) =>
    (LEVEL4_OBJECT_RANK.get(left.objectType) ?? Number.MAX_SAFE_INTEGER) -
      (LEVEL4_OBJECT_RANK.get(right.objectType) ?? Number.MAX_SAFE_INTEGER) ||
    left.canonicalId.localeCompare(right.canonicalId)
  );
  const exclusionSummary = projectRef.level4ExclusionSummary.map((item) =>
    item.sampleLabels
      ? { ...item, sampleLabels: [...item.sampleLabels] }
      : { ...item }
  );
  return {
    policyVersion: projectRef.level4SnapshotPolicyVersion,
    decision: projectRef.level4SnapshotDecision,
    fingerprint: projectRef.level4SnapshotFingerprint,
    includedItems,
    exclusionSummary
  };
}

/** Reads only immutable CallAttempt facts; it never consults current UI state. */
export function readFrozenContextSelection(
  attempt: AICallAttempt
): AIFrozenContextSelection | null {
  const scopedProjectRef = attempt.contextSourceRefs.find((sourceRef) => (
    sourceRef.contextRole === "scope" && sourceRef.entityType === "project"
  ));
  const projectRef = scopedProjectRef ?? attempt.contextSourceRefs.find((sourceRef) => (
    sourceRef.entityType === "project"
  ));
  if (!projectRef?.entityId) return null;

  const modeValue = attempt.contextSourceRefs.find((sourceRef) => sourceRef.contextMode)?.contextMode;
  let normalizedMode: AIContextMode;
  try {
    normalizedMode = normalizeAIContextMode(modeValue ?? "STANDARD");
  } catch {
    return null;
  }
  const primaryObjectRefs = attempt.contextSourceRefs.filter((sourceRef) => (
    sourceRef.contextRole === "primary" &&
    primaryResearchObjectType(sourceRef.entityType) !== undefined
  ));
  // A2 Task scope must carry its explicit mode and canonical Project-scope ref.
  // The default is retained only for legacy Project-only LP13-A attempts.
  if (primaryObjectRefs.length > 0 && (!modeValue || !scopedProjectRef)) return null;
  const contextMode = normalizedMode;
  try {
    if (primaryObjectRefs.some((sourceRef) => (
      !sourceRef.entityId || normalizeAIContextMode(sourceRef.contextMode) !== contextMode
    ))) return null;
  } catch {
    return null;
  }
  const seenObjects = new Set<string>();
  const researchObjects: AIResearchObjectSelection[] = [];
  for (const sourceRef of primaryObjectRefs) {
    const objectType = primaryResearchObjectType(sourceRef.entityType);
    if (!objectType) return null;
    const identity = `${objectType}:${sourceRef.entityId}`;
    if (seenObjects.has(identity)) continue;
    seenObjects.add(identity);
    researchObjects.push({ objectType, objectId: sourceRef.entityId });
  }
  const selectedRunIds = researchObjects
    .filter((selection) => selection.objectType === "experimentRun")
    .map((selection) => selection.objectId);
  let runRelations;
  try {
    runRelations = readExperimentRunParentRelations(attempt.contextSourceRefs);
  } catch {
    return null;
  }
  const durableRunRelationTupleCount = attempt.contextSourceRefs.filter((sourceRef) => (
    sourceRef.field === "canonical ExperimentRun parent relation" &&
    sourceRef.entityType === "experimentRun"
  )).length;
  if (
    durableRunRelationTupleCount !== selectedRunIds.length ||
    runRelations.length !== selectedRunIds.length ||
    selectedRunIds.some((runId, index) => runRelations[index]?.runId !== runId) ||
    runRelations.some((relation) => relation.projectId !== projectRef.entityId)
  ) return null;
  const selectedLiteratureIds = researchObjects
    .filter((selection) => selection.objectType === "literature")
    .map((selection) => selection.objectId);
  let literatureTuples;
  try {
    literatureTuples = readLiteratureAssociationTuples(attempt.contextSourceRefs);
  } catch {
    return null;
  }
  const durableLiteratureTupleCount = attempt.contextSourceRefs.filter((sourceRef) => (
    sourceRef.field === "canonical Literature Project association" &&
    sourceRef.entityType === "literature"
  )).length;
  if (
    durableLiteratureTupleCount !== selectedLiteratureIds.length ||
    literatureTuples.length !== selectedLiteratureIds.length ||
    selectedLiteratureIds.some((literatureId, index) =>
      literatureTuples[index]?.literatureId !== literatureId) ||
    literatureTuples.some((tuple) =>
      tuple.projectAssociationKind === "assigned" && tuple.canonicalProjectId !== projectRef.entityId)
  ) return null;
  return { projectId: projectRef.entityId, contextMode, researchObjects };
}

/**
 * Restores only the non-material selection owned by the current latest durable
 * assistant Message. One-shot material authorization is intentionally absent
 * from this custody projection and must be re-authorized independently.
 */
export function readLatestAssistantMessageContextCustody(
  readback: Pick<AIConversationReadback, "projectedMessages" | "callAttempts">
): AILatestAssistantMessageContextCustody | null {
  const latestMessage = [...readback.projectedMessages]
    .filter((message) => message.messageKind === "text" && message.content.trim())
    .sort((left, right) => right.sequence - left.sequence || right.id.localeCompare(left.id))[0];
  if (!latestMessage || latestMessage.role !== "assistant") return null;
  const sourceAttempt = [...readback.callAttempts]
    .filter((attempt) => (
      attempt.purpose === "chat_response" &&
      attempt.status === "succeeded" &&
      attempt.resultMessageId === latestMessage.id
    ))
    .sort((left, right) => right.sequence - left.sequence || right.id.localeCompare(left.id))[0];
  if (!sourceAttempt) return null;
  const selection = readFrozenContextSelection(sourceAttempt);
  if (!selection) return null;
  return {
    assistantMessageId: latestMessage.id,
    sourceCallAttemptId: sourceAttempt.id,
    selection
  };
}

function selectionKeys(selection: AIFrozenContextSelection): string[] {
  return [...new Set(selection.researchObjects.map((candidate) => (
    `${candidate.objectType}:${candidate.objectId}`
  )))].sort((left, right) => left.localeCompare(right));
}

function selectionsEqual(
  left: AIFrozenContextSelection,
  right: AIFrozenContextSelection
): boolean {
  const leftKeys = selectionKeys(left);
  const rightKeys = selectionKeys(right);
  return left.projectId === right.projectId && left.contextMode === right.contextMode &&
    leftKeys.length === left.researchObjects.length &&
    rightKeys.length === right.researchObjects.length &&
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index]);
}

function selectionMembershipEqual(
  left: AIFrozenContextSelection,
  right: AIFrozenContextSelection
): boolean {
  const leftKeys = selectionKeys(left);
  const rightKeys = selectionKeys(right);
  return left.projectId === right.projectId &&
    leftKeys.length === left.researchObjects.length &&
    rightKeys.length === right.researchObjects.length &&
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index]);
}

function contextModeRank(mode: AIContextMode): number {
  if (mode === "MINIMAL") return 0;
  if (mode === "BRIEF") return 1;
  if (mode === "STANDARD") return 2;
  return 3;
}

function exactRequestedIdentityContributions(input: {
  requestedRefs: import("../types/aiContextRequest").AIContextRequest["requestedRefs"];
  reviewedCandidates: import("../types/aiContextRequest").AIContextRequest["reviewedCandidates"];
  approvedRefs: NonNullable<import("../types/aiContextRequest").AIContextRequest["approvedRefs"]>;
}): AIApprovedContextRequestContribution[] | null {
  const requested = [...input.requestedRefs].sort((left, right) =>
    left.refKind.localeCompare(right.refKind) || left.refId.localeCompare(right.refId) ||
    left.contributionKind.localeCompare(right.contributionKind));
  const reviewed = [...input.reviewedCandidates].sort((left, right) =>
    left.refKind.localeCompare(right.refKind) || left.refId.localeCompare(right.refId) ||
    left.contributionKind.localeCompare(right.contributionKind));
  const approved = [...input.approvedRefs].sort((left, right) =>
    left.refKind.localeCompare(right.refKind) || left.refId.localeCompare(right.refId) ||
    left.contributionKind.localeCompare(right.contributionKind));
  if (
    requested.length === 0 || requested.length !== reviewed.length ||
    requested.length !== approved.length
  ) return null;
  const contributions: AIApprovedContextRequestContribution[] = [];
  for (let index = 0; index < requested.length; index += 1) {
    const wire = requested[index];
    const review = reviewed[index];
    const approval = approved[index];
    if (
      !wire || !review || !approval || wire.refKind !== "AI_RESEARCH_OBJECT" ||
      wire.contributionKind !== "IDENTITY_METADATA" ||
      review.refKind !== wire.refKind || review.refId !== wire.refId ||
      review.contributionKind !== wire.contributionKind || review.availability !== "available" ||
      review.fileBodyAuthorizationRequired ||
      approval.refKind !== review.refKind || approval.refId !== review.refId ||
      approval.projectId !== review.projectId || approval.entityType !== review.entityType ||
      approval.label !== review.label || approval.contributionKind !== review.contributionKind ||
      approval.availability !== review.availability || approval.fileBodyAuthorizationRequired ||
      approval.entityType === "fileRef"
    ) return null;
    contributions.push({
      refKind: approval.refKind,
      refId: approval.refId,
      projectId: approval.projectId,
      label: approval.label,
      contributionKind: approval.contributionKind,
      availability: "available",
      fileBodyAuthorizationRequired: false
    });
  }
  return contributions;
}

/**
 * Reads only exact durable request/decision/follow-up and CallAttempt facts.
 * The approved identity set must be the complete and only expansion from the
 * request's base selection to the follow-up selection. Later successful Chat
 * attempts may retain that same selection, but any selection change closes the
 * custody chain. Failed Parse attempts grant nothing and cannot expand it.
 */
export function readLatestAssistantMessageAttachedContextCustody(
  readback: Pick<
    AIConversationReadback,
    "messages" | "projectedMessages" | "callAttempts" | "contextRequests"
  >
): AILatestAssistantAttachedContextCustody | null {
  const latest = readLatestAssistantMessageContextCustody(readback);
  if (!latest) return null;
  const latestAttempt = readback.callAttempts.find((attempt) =>
    attempt.id === latest.sourceCallAttemptId);
  if (!latestAttempt) return null;

  const candidates = readback.contextRequests.flatMap((request) => {
    if (
      request.state !== "APPROVED" || request.decisionType !== "APPROVE" ||
      !request.decisionActionMessageId || !request.followupCallAttemptId ||
      !request.approvedRefs || request.source.projectId !== latest.selection.projectId
    ) return [];
    const sourceAttempt = readback.callAttempts.find((attempt) =>
      attempt.id === request.sourceCallAttemptId);
    const followupAttempt = readback.callAttempts.find((attempt) =>
      attempt.id === request.followupCallAttemptId);
    const decisionMessage = readback.messages.find((message) =>
      message.id === request.decisionActionMessageId);
    if (
      !sourceAttempt || sourceAttempt.purpose !== "chat_response" || sourceAttempt.status !== "succeeded" ||
      sourceAttempt.resultMessageId !== request.sourceMessageId ||
      !followupAttempt || followupAttempt.purpose !== "chat_response" || followupAttempt.status !== "succeeded" ||
      followupAttempt.triggerCallAttemptId !== sourceAttempt.id ||
      followupAttempt.triggerMessageId !== decisionMessage?.id ||
      decisionMessage?.role !== "user" || decisionMessage.messageKind !== "context_request_action" ||
      decisionMessage.actionType !== "APPROVE_CONTEXT_REQUEST" || decisionMessage.actionRefId !== request.id ||
      followupAttempt.sequence > latestAttempt.sequence
    ) return [];
    const baseSelection = readFrozenContextSelection(sourceAttempt);
    const followupSelection = readFrozenContextSelection(followupAttempt);
    const contributions = exactRequestedIdentityContributions({
      requestedRefs: request.requestedRefs,
      reviewedCandidates: request.reviewedCandidates,
      approvedRefs: request.approvedRefs
    });
    if (
      !baseSelection || !followupSelection || !contributions ||
      !selectionsEqual(baseSelection, {
        projectId: request.source.projectId,
        contextMode: request.source.contextMode,
        researchObjects: request.source.researchObjects
      }) || !selectionMembershipEqual(followupSelection, latest.selection) ||
      contextModeRank(latest.selection.contextMode) > contextModeRank(followupSelection.contextMode)
    ) return [];
    const baseKeys = selectionKeys(baseSelection);
    const contributionKeys = contributions.map((contribution) => (
      `${contribution.refKind === "AI_RESEARCH_OBJECT" ? request.approvedRefs?.find((candidate) =>
        candidate.refId === contribution.refId)?.entityType : "fileRef"}:${contribution.refId}`
    )).sort((left, right) => left.localeCompare(right));
    const expandedKeys = selectionKeys(followupSelection);
    const expectedExpandedKeys = [...new Set([...baseKeys, ...contributionKeys])]
      .sort((left, right) => left.localeCompare(right));
    if (
      contributionKeys.length !== contributions.length ||
      contributions.some((contribution) => contribution.projectId !== baseSelection.projectId) ||
      expandedKeys.length !== expectedExpandedKeys.length ||
      expandedKeys.some((key, index) => key !== expectedExpandedKeys[index])
    ) return [];
    const laterSuccessfulChatAttempts = readback.callAttempts.filter((attempt) =>
      attempt.purpose === "chat_response" && attempt.status === "succeeded" &&
      attempt.sequence >= followupAttempt.sequence && attempt.sequence <= latestAttempt.sequence);
    if (laterSuccessfulChatAttempts.some((attempt) => {
      const selection = readFrozenContextSelection(attempt);
      return !selection || !selectionMembershipEqual(selection, followupSelection) ||
        contextModeRank(selection.contextMode) > contextModeRank(followupSelection.contextMode);
    })) return [];
    return [{
      request,
      followupAttempt,
      baseSelection,
      contributions
    }];
  }).sort((left, right) =>
    right.followupAttempt.sequence - left.followupAttempt.sequence ||
    right.followupAttempt.id.localeCompare(left.followupAttempt.id));
  const resolved = candidates[0];
  if (!resolved) return null;
  return {
    ...latest,
    contextRequestId: resolved.request.id,
    approvalActionMessageId: resolved.request.decisionActionMessageId!,
    followupCallAttemptId: resolved.followupAttempt.id,
    baseSelection: {
      ...resolved.baseSelection,
      researchObjects: resolved.baseSelection.researchObjects.map((selection) => ({ ...selection }))
    },
    approvedContextRequestContributions: resolved.contributions.map((contribution) => ({
      ...contribution
    }))
  };
}

/** Compact, restart-readable projection; no prompt body or second receipt store is created. */
export function buildAIContextReceipt(attempt: AICallAttempt): AIContextReceipt | null {
  if (attempt.purpose !== "chat_response" || attempt.status !== "succeeded") return null;
  const frozen = readFrozenContextSelection(attempt);
  if (!frozen) return null;
  const level4Snapshot = readFrozenLevel4Snapshot(attempt);
  if (level4Snapshot === null) return null;
  const projectRef = attempt.contextSourceRefs.find((sourceRef) => (
    sourceRef.contextRole === "scope" && sourceRef.entityType === "project"
  )) ?? attempt.contextSourceRefs.find((sourceRef) => sourceRef.entityType === "project");
  const primaryTasks = frozen.researchObjects.flatMap((selection) => {
    if (selection.objectType !== "task") return [];
    const sourceRef = attempt.contextSourceRefs.find((candidate) => (
      candidate.contextRole === "primary" &&
      candidate.entityType === "task" &&
      candidate.entityId === selection.objectId
    ));
    return [{ id: selection.objectId, label: sourceRef?.label }];
  });
  const primaryRoutes = frozen.researchObjects.flatMap((selection) => {
    if (selection.objectType !== "route") return [];
    const sourceRef = attempt.contextSourceRefs.find((candidate) => (
      candidate.contextRole === "primary" &&
      candidate.entityType === "routeNode" &&
      candidate.entityId === selection.objectId
    ));
    return [{ id: selection.objectId, label: sourceRef?.label }];
  });
  const primaryReviews = frozen.researchObjects.flatMap((selection) => {
    if (selection.objectType !== "review") return [];
    const sourceRef = attempt.contextSourceRefs.find((candidate) => (
      candidate.contextRole === "primary" &&
      candidate.entityType === "review" &&
      candidate.entityId === selection.objectId
    ));
    return [{ id: selection.objectId, label: sourceRef?.label }];
  });
  const primaryExperiments = frozen.researchObjects.flatMap((selection) => {
    if (selection.objectType !== "experiment") return [];
    const sourceRef = attempt.contextSourceRefs.find((candidate) => (
      candidate.contextRole === "primary" &&
      candidate.entityType === "experiment" &&
      candidate.entityId === selection.objectId
    ));
    return [{ id: selection.objectId, label: sourceRef?.label }];
  });
  const runRelations = readExperimentRunParentRelations(attempt.contextSourceRefs);
  const primaryExperimentRuns = frozen.researchObjects.flatMap((selection) => {
    if (selection.objectType !== "experimentRun") return [];
    const sourceRef = attempt.contextSourceRefs.find((candidate) => (
      candidate.contextRole === "primary" &&
      candidate.entityType === "experimentRun" &&
      candidate.entityId === selection.objectId
    ));
    const relation = runRelations.find((candidate) => candidate.runId === selection.objectId);
    if (!relation) return [];
    return [{
      id: selection.objectId,
      label: sourceRef?.label,
      parentExperimentId: relation.parentExperimentId,
      projectId: relation.projectId,
      selectionOrder: relation.selectionOrder
    }];
  }).sort((left, right) => left.selectionOrder - right.selectionOrder || left.id.localeCompare(right.id));
  const literatureTuples = readLiteratureAssociationTuples(attempt.contextSourceRefs);
  const primaryLiterature = frozen.researchObjects.flatMap((selection) => {
    if (selection.objectType !== "literature") return [];
    const sourceRef = attempt.contextSourceRefs.find((candidate) => (
      candidate.contextRole === "primary" &&
      candidate.entityType === "literature" &&
      candidate.entityId === selection.objectId
    ));
    const tuple = literatureTuples.find((candidate) =>
      candidate.literatureId === selection.objectId);
    if (!tuple) return [];
    return [{ id: selection.objectId, label: sourceRef?.label, ...tuple }];
  }).sort((left, right) => left.selectionOrder - right.selectionOrder || left.id.localeCompare(right.id));
  const primaryFindings = frozen.researchObjects.flatMap((selection) => {
    if (selection.objectType !== "finding") return [];
    const sourceRef = attempt.contextSourceRefs.find((candidate) => (
      candidate.contextRole === "primary" &&
      candidate.entityType === "finding" &&
      candidate.entityId === selection.objectId
    ));
    return [{ id: selection.objectId, label: sourceRef?.label }];
  });
  const primaryOutputObjects = frozen.researchObjects.flatMap((selection) => {
    if (
      selection.objectType !== "resultItem" &&
      selection.objectType !== "outputCandidate" &&
      selection.objectType !== "outputGap" &&
      selection.objectType !== "researchOutput"
    ) return [];
    const sourceRef = attempt.contextSourceRefs.find((candidate) => (
      candidate.contextRole === "primary" &&
      candidate.entityType === selection.objectType &&
      candidate.entityId === selection.objectId
    ));
    return [{ objectType: selection.objectType, id: selection.objectId, label: sourceRef?.label }];
  });
  const warningCodes = Array.from(new Set(attempt.warnings.map((warning) => warning.code))).sort();
  let constraint: AIConstraintReadback;
  try {
    constraint = readAIConstraintFromSourceRefs(attempt.contextSourceRefs);
  } catch {
    // A partial or contradictory historical descriptor is never relabeled or fabricated.
    return null;
  }
  return {
    attemptId: attempt.id,
    contextPackageId: attempt.contextPackageId,
    project: { id: frozen.projectId, label: projectRef?.label },
    primaryRoutes,
    primaryTasks,
    primaryReviews,
    primaryExperiments,
    primaryExperimentRuns,
    primaryLiterature,
    primaryFindings,
    primaryOutputObjects,
    literatureSelectionAggregateEligibility: "ALLOWED",
    contextMode: frozen.contextMode,
    includedSourceCount: attempt.contextSourceRefs.filter((sourceRef) => (
      sourceRef.contextDisposition !== "excluded" &&
      sourceRef.contextRole !== "explicitMaterial" &&
      !hasAIConstraintProvenance(sourceRef)
    )).length,
    excludedSourceCount: attempt.budgetSummary?.excludedItems ?? 0,
    warningCount: attempt.warnings.length,
    warningCodes,
    authorizedMaterials: attempt.authorizedFileRefs.map((snapshot) => ({
      fileRefId: snapshot.fileRefId,
      displayName: snapshot.displayName
    })),
    constraint,
    ...(level4Snapshot ? { level4Snapshot } : {})
  };
}
