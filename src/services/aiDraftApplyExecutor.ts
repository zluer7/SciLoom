import type {
  AIActionDraftApplyResult,
  AIActionDraftUnion
} from "../types/aiDraft";
import type {
  AffectedEntity,
  AffectedScope,
  RefreshKey,
  WriteFeedbackResult,
  WriteFeedbackStatus
} from "../types/writeFeedback";
import { publishWriteFeedbackRefresh } from "./refreshEventService";
import { createWriteFeedbackResult, toWriteFeedbackMessage } from "./writeFeedbackService";
const writeEnabledCapabilities = {
  task_create: "supported",
  review_candidate: "planned",
  output_gap_create: "planned",
  output_candidate_create: "planned",
  entity_link_create: "planned"
} as const;

export interface AIActionDraftApplyCapability {
  allowed: boolean;
  errorCode?: string;
  message: string;
}

function hasAppliedEntity(draft: AIActionDraftUnion): boolean {
  return Boolean(
    draft.result.applyResult?.createdEntity?.entityId ||
      draft.result.applyResult?.updatedEntity?.entityId
  );
}

export function getAIActionDraftApplyCapability(
  draft: AIActionDraftUnion
): AIActionDraftApplyCapability {
  if (draft.draftType === "finding_create") {
    return {
      allowed: false,
      errorCode: "legacy_finding_action_draft_disabled",
      message: "Finding creation is available only through the canonical Parse Draft Standard Result confirmation flow."
    };
  }
  if (!(draft.draftType in writeEnabledCapabilities)) {
    return {
      allowed: false,
      errorCode: "unsupported_draft_type",
      message: `Write-back is not enabled for draft type ${draft.draftType}.`
    };
  }
  const expectedCapability =
    writeEnabledCapabilities[draft.draftType as keyof typeof writeEnabledCapabilities];
  if (draft.capability !== expectedCapability) {
    return {
      allowed: false,
      errorCode: "draft_capability_mismatch",
      message: `${draft.draftType} requires capability ${expectedCapability} for write-back.`
    };
  }
  if (draft.result.reviewStatus === "rejected") {
    return {
      allowed: false,
      errorCode: "draft_rejected",
      message: "Rejected drafts cannot be written."
    };
  }
  if (draft.result.applyStatus === "written" || hasAppliedEntity(draft)) {
    return {
      allowed: false,
      errorCode: "draft_already_written",
      message: "This draft has already changed a business entity and cannot be written again."
    };
  }
  if (draft.handled) {
    return {
      allowed: false,
      errorCode: "draft_already_handled",
      message: "Handled drafts cannot be written."
    };
  }
  if (draft.result.reviewStatus !== "accepted") {
    return {
      allowed: false,
      errorCode: "draft_not_accepted",
      message: "The draft must be accepted before write-back."
    };
  }
  if (!draft.writePreview) {
    return {
      allowed: false,
      errorCode: "write_preview_required",
      message: "A write preview is required before write-back."
    };
  }
  return {
    allowed: true,
    message: `${draft.draftType} is eligible for explicit user-confirmed write-back.`
  };
}

export function canApplyAIActionDraft(draft: AIActionDraftUnion): boolean {
  return getAIActionDraftApplyCapability(draft).allowed;
}

function aiDraftApplyStatus(result: AIActionDraftApplyResult): WriteFeedbackStatus {
  if (result.success && result.result === "written" && !result.partialSuccess) {
    return "success";
  }
  if (result.partialSuccess || result.result === "partial") {
    return "partial";
  }
  if (!result.success || result.result === "failed") {
    return "error";
  }
  return "skipped";
}

function refreshKeysForAIEntityRef(entityType?: string): RefreshKey[] {
  if (!entityType) return [];
  if (entityType === "project") return ["project.changed"];
  if (entityType === "routeNode" || entityType === "route") return ["route.changed"];
  if (entityType === "task") return ["task.changed", "reviewContext.changed"];
  if (entityType === "review") return ["review.changed", "reviewContext.changed"];
  if (entityType === "experiment" || entityType === "experimentRun" || entityType === "resultMetric") {
    return ["experiment.changed", "reviewContext.changed", "aiContext.changed"];
  }
  if (entityType === "literature") {
    return ["literature.changed", "reviewContext.changed", "aiContext.changed"];
  }
  if (entityType === "outputGap") return ["output.gap.changed", "reviewContext.changed", "aiContext.changed"];
  if (entityType === "finding") return ["output.finding.changed", "reviewContext.changed", "aiContext.changed"];
  if (entityType === "outputCandidate") {
    return ["output.candidate.changed", "reviewContext.changed", "aiContext.changed"];
  }
  if (entityType === "output" || entityType === "formalOutput") {
    return ["output.researchOutput.changed", "reviewContext.changed", "aiContext.changed"];
  }
  if (entityType === "resultItem") {
    return ["output.resultItem.changed", "reviewContext.changed", "aiContext.changed"];
  }
  if (entityType === "entityLink") return ["entityLink.changed", "reviewContext.changed", "aiContext.changed"];
  if (entityType === "literatureLink") {
    return ["literatureLink.changed", "literature.changed", "reviewContext.changed", "aiContext.changed"];
  }
  return ["aiContext.changed"];
}

function affectedEntityFromAIRef(
  ref: AIActionDraftApplyResult["createdEntity"],
  relation: string
): AffectedEntity | undefined {
  if (!ref?.entityId) return undefined;
  return {
    type: ref.entityType,
    id: ref.entityId,
    relation,
    label: ref.label
  };
}

function affectedScopeFromAIEntity(entity: AffectedEntity): AffectedScope {
  const scope: AffectedScope = {
    module: "ai",
    reason: `AI draft apply affected ${entity.type}.`
  };
  if (entity.type === "project") scope.projectId = entity.id;
  if (entity.type === "routeNode") scope.routeNodeId = entity.id;
  if (entity.type === "task") scope.taskId = entity.id;
  if (entity.type === "review") scope.reviewId = entity.id;
  if (entity.type === "experiment") scope.experimentId = entity.id;
  if (entity.type === "literature") scope.literatureId = entity.id;
  if (entity.type === "outputGap") scope.outputGapId = entity.id;
  if (entity.type === "outputCandidate") scope.outputCandidateId = entity.id;
  if (entity.type === "output" || entity.type === "formalOutput") scope.researchOutputId = entity.id;
  return scope;
}

export function mapAIActionDraftApplyResultToWriteFeedback(
  result: AIActionDraftApplyResult,
  operation = "aiDraft.applyAIActionDraft"
): WriteFeedbackResult<AIActionDraftApplyResult> {
  const createdEntity = affectedEntityFromAIRef(result.createdEntity, "created");
  const updatedEntity = affectedEntityFromAIRef(result.updatedEntity, "updated");
  const linkedEntities = (result.linkedEntities ?? [])
    .flatMap((link) => [
      affectedEntityFromAIRef(link.source, "linked"),
      affectedEntityFromAIRef(link.target, "linked")
    ])
    .filter((entity): entity is AffectedEntity => Boolean(entity));
  const affectedEntities = [
    createdEntity,
    updatedEntity,
    ...linkedEntities
  ].filter((entity): entity is AffectedEntity => Boolean(entity));
  const refreshKeys = [
    ...refreshKeysForAIEntityRef(result.createdEntity?.entityType),
    ...refreshKeysForAIEntityRef(result.updatedEntity?.entityType),
    ...(result.linkedEntities ?? []).flatMap((link) => [
      ...refreshKeysForAIEntityRef(link.source?.entityType),
      ...refreshKeysForAIEntityRef(link.target?.entityType),
      "entityLink.changed" as RefreshKey
    ]),
    "aiContext.changed" as RefreshKey
  ];
  return createWriteFeedbackResult({
    status: aiDraftApplyStatus(result),
    operation,
    data: result,
    affectedEntities,
    affectedScopes: [
      ...affectedEntities.map(affectedScopeFromAIEntity),
      {
        module: "ai",
        reason: "AI draft apply result changed."
      }
    ],
    refreshKeys,
    messages: [
      ...(result.message ? [toWriteFeedbackMessage(result.message, result.success ? "success" : "error")] : []),
      ...(result.errorMessage ? [toWriteFeedbackMessage(result.errorMessage, "error", result.errorCode)] : [])
    ],
    errors: result.errorMessage ? [result.errorMessage] : [],
    skipped: result.success ? [] : [result.errorCode ?? result.result],
    partial: Boolean(result.partialSuccess || result.result === "partial")
  });
}

export function publishAIActionDraftApplyFeedback(result: AIActionDraftApplyResult) {
  const feedback = mapAIActionDraftApplyResultToWriteFeedback(result);
  publishWriteFeedbackRefresh(feedback, {
    source: "ai.apply",
    reason: "aiDraft.applyAIActionDraft"
  });
}
