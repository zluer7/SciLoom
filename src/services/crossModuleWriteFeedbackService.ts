import type {
  AffectedEntity,
  AffectedScope,
  RefreshKey,
  WriteFeedbackMessage,
  WriteFeedbackResult,
  WriteFeedbackStatus
} from "../types/writeFeedback";
import { publishWriteFeedbackRefresh } from "./refreshEventService";
import { createWriteFeedbackResult, toWriteFeedbackMessage } from "./writeFeedbackService";

export interface CreateCrossModuleWriteFeedbackInput<T = unknown> {
  operation: string;
  data?: T;
  status?: WriteFeedbackStatus;
  primaryEntity?: AffectedEntity;
  affectedEntities?: AffectedEntity[];
  affectedScopes?: AffectedScope[];
  refreshKeys?: RefreshKey[];
  messages?: WriteFeedbackMessage[];
  warnings?: string[];
  errors?: string[];
  skipped?: string[];
  partial?: boolean;
}

export function entityTypeToRefreshKeys(entityType?: string): RefreshKey[] {
  if (!entityType) return [];
  if (entityType === "project") return ["project.changed"];
  if (entityType === "route" || entityType === "routeNode") return ["route.changed"];
  if (entityType === "task") return ["task.changed", "reviewContext.changed", "aiContext.changed"];
  if (entityType === "review") return ["review.changed", "reviewContext.changed", "aiContext.changed"];
  if (entityType === "experiment") {
    return ["experiment.changed", "reviewContext.changed", "aiContext.changed"];
  }
  if (entityType === "experimentRun") {
    return ["experimentRun.changed", "experiment.changed", "reviewContext.changed", "aiContext.changed"];
  }
  if (entityType === "resultMetric") {
    return ["resultMetric.changed", "experiment.changed", "reviewContext.changed", "aiContext.changed"];
  }
  if (entityType === "fileRef") {
    return ["fileRef.changed", "experiment.changed", "reviewContext.changed", "aiContext.changed"];
  }
  if (entityType === "literature") {
    return ["literature.changed", "reviewContext.changed", "aiContext.changed"];
  }
  if (entityType === "literatureLink") {
    return ["literatureLink.changed", "literature.changed", "reviewContext.changed", "aiContext.changed"];
  }
  if (entityType === "entityLink") {
    return ["entityLink.changed", "reviewContext.changed", "aiContext.changed"];
  }
  if (entityType === "resultItem") {
    return ["output.resultItem.changed", "reviewContext.changed", "aiContext.changed"];
  }
  if (entityType === "finding") {
    return ["output.finding.changed", "reviewContext.changed", "aiContext.changed"];
  }
  if (entityType === "outputCandidate") {
    return ["output.candidate.changed", "reviewContext.changed", "aiContext.changed"];
  }
  if (entityType === "outputGap") {
    return ["output.gap.changed", "reviewContext.changed", "aiContext.changed"];
  }
  if (entityType === "output" || entityType === "researchOutput") {
    return ["output.researchOutput.changed", "reviewContext.changed", "aiContext.changed"];
  }
  if (entityType === "researcherProfile") {
    return ["researcherProfile.changed", "aiContext.changed", "global.changed"];
  }
  if (entityType === "aiContext") return ["aiContext.changed"];
  return ["reviewContext.changed", "aiContext.changed"];
}

export function entityTypeToAffectedScopeModule(entityType?: string): string {
  if (!entityType) return "global";
  if (entityType === "project") return "project";
  if (entityType === "route" || entityType === "routeNode") return "route";
  if (entityType === "task") return "task";
  if (entityType === "review") return "review";
  if (
    entityType === "experiment" ||
    entityType === "experimentRun" ||
    entityType === "resultMetric" ||
    entityType === "fileRef"
  ) {
    return "experiment";
  }
  if (
    entityType === "literature" ||
    entityType === "literatureLink"
  ) {
    return "literature";
  }
  if (
    entityType === "output" ||
    entityType === "researchOutput" ||
    entityType === "resultItem" ||
    entityType === "finding" ||
    entityType === "outputCandidate" ||
    entityType === "outputGap"
  ) {
    return "outputConversion";
  }
  if (entityType === "entityLink") return "link";
  if (entityType === "aiContext") return "ai";
  return "global";
}

function scopeFromEntity(entity: AffectedEntity, operation: string): AffectedScope {
  const scope: AffectedScope = {
    module: entityTypeToAffectedScopeModule(entity.type),
    reason: `${operation} affected ${entity.type}.`
  };
  if (entity.type === "project") scope.projectId = entity.id;
  if (entity.type === "route" || entity.type === "routeNode") scope.routeNodeId = entity.id;
  if (entity.type === "task") scope.taskId = entity.id;
  if (entity.type === "review") scope.reviewId = entity.id;
  if (entity.type === "experiment") scope.experimentId = entity.id;
  if (entity.type === "literature") scope.literatureId = entity.id;
  if (entity.type === "outputGap") scope.outputGapId = entity.id;
  if (entity.type === "outputCandidate") scope.outputCandidateId = entity.id;
  if (entity.type === "output" || entity.type === "researchOutput") {
    scope.researchOutputId = entity.id;
  }
  return scope;
}

function defaultStatus(input: CreateCrossModuleWriteFeedbackInput): WriteFeedbackStatus {
  if ((input.errors ?? []).length > 0) return "error";
  if ((input.skipped ?? []).length > 0 && !input.primaryEntity && (input.affectedEntities ?? []).length === 0) {
    return "skipped";
  }
  if ((input.warnings ?? []).length > 0 || (input.skipped ?? []).length > 0 || input.partial) {
    return "partial";
  }
  return "success";
}

export function createCrossModuleWriteFeedback<T = unknown>(
  input: CreateCrossModuleWriteFeedbackInput<T>
): WriteFeedbackResult<T> {
  const affectedEntities = [
    input.primaryEntity,
    ...(input.affectedEntities ?? [])
  ].filter((entity): entity is AffectedEntity => Boolean(entity));
  const warnings = [...(input.warnings ?? [])];
  const errors = [...(input.errors ?? [])];
  const skipped = [...(input.skipped ?? [])];
  return createWriteFeedbackResult({
    status: input.status ?? defaultStatus(input),
    operation: input.operation,
    data: input.data,
    affectedEntities,
    affectedScopes: [
      ...affectedEntities.map((entity) => scopeFromEntity(entity, input.operation)),
      ...(input.affectedScopes ?? [])
    ],
    refreshKeys: [
      ...affectedEntities.flatMap((entity) => entityTypeToRefreshKeys(entity.type)),
      "reviewContext.changed",
      "aiContext.changed",
      ...(input.refreshKeys ?? [])
    ],
    messages: [
      ...(input.messages ?? []),
      ...warnings.map((warning) => toWriteFeedbackMessage(warning, "warning")),
      ...errors.map((error) => toWriteFeedbackMessage(error, "error")),
      ...skipped.map((skip) => toWriteFeedbackMessage(`Skipped: ${skip}`, "warning", skip))
    ],
    warnings,
    errors,
    skipped,
    partial: input.partial ?? (warnings.length > 0 || skipped.length > 0)
  });
}

export function publishCrossModuleWriteFeedback<T = unknown>(
  feedback: WriteFeedbackResult<T> | undefined,
  reason: string
) {
  if (!feedback) return;
  publishWriteFeedbackRefresh(feedback, {
    source: "service.write",
    reason
  });
}
