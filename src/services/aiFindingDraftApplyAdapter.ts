import type {
  AIActionDraft,
  AIActionDraftApplyResult,
  AIFindingCreateDraftPayload
} from "../types/aiDraft";
import type {
  FindingConfidence,
  FindingMaturity,
  FindingStatus,
  FindingType
} from "../types/outputConversion";
import { experimentService } from "./experimentService";
import { outputConversionService } from "./outputConversionService";
import { planningService } from "./planningService";

type GetProjectService = typeof planningService.getProjectById;
type GetRouteNodeService = typeof planningService.getRouteNodeById;
type GetTaskService = typeof planningService.getTaskById;
type GetExperimentService = typeof experimentService.getExperimentById;
type GetResultItemService = typeof outputConversionService.getResultItemById;
type CreateFindingService = typeof outputConversionService.createFinding;

export interface ApplyAIFindingDraftOptions {
  draft: AIActionDraft<"finding_create">;
  appliedAt?: string;
  getProjectById?: GetProjectService;
  getRouteNodeById?: GetRouteNodeService;
  getTaskById?: GetTaskService;
  getExperimentById?: GetExperimentService;
  getResultItemById?: GetResultItemService;
  createFinding?: CreateFindingService;
}

const FINDING_TYPES = new Set<FindingType>([
  "phenomenon",
  "comparison",
  "method",
  "limitation",
  "evidence",
  "hypothesis",
  "negative_result",
  "other"
]);
const CONFIDENCES = new Set<FindingConfidence>(["high", "medium", "low", "uncertain"]);
const FINDING_STATUSES = new Set<FindingStatus>(["pending_confirmation", "needs_evidence"]);
const MATURITIES = new Set<FindingMaturity>(["high", "medium", "low", "uncertain"]);

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isOptionalStringArray(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) && value.every((item) => typeof item === "string"))
  );
}

function payloadValue(
  draft: AIActionDraft<"finding_create">
): AIFindingCreateDraftPayload | undefined {
  const payload: unknown = draft.proposedPayload;
  return typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? (payload as AIFindingCreateDraftPayload)
    : undefined;
}

function uniqueIds(...values: Array<string[] | undefined>): string[] {
  return [...new Set(values.flatMap((value) => value ?? []).map((id) => id.trim()).filter(Boolean))];
}

function failedResult(
  draftId: string,
  appliedAt: string,
  errorCode: string,
  message: string
): AIActionDraftApplyResult {
  return {
    success: false,
    result: "failed",
    message,
    errorCode,
    errorMessage: message,
    sourceDraftId: draftId,
    appliedAt
  };
}

export async function applyAIFindingDraft({
  draft,
  appliedAt = new Date().toISOString(),
  getProjectById = planningService.getProjectById,
  getRouteNodeById = planningService.getRouteNodeById,
  getTaskById = planningService.getTaskById,
  getExperimentById = experimentService.getExperimentById,
  getResultItemById = outputConversionService.getResultItemById,
  createFinding = outputConversionService.createFinding
}: ApplyAIFindingDraftOptions): Promise<AIActionDraftApplyResult> {
  const draftType: string = draft.draftType;
  if (draftType !== "finding_create") {
    return failedResult(
      draft.draftInstanceId,
      appliedAt,
      "unsupported_draft_type",
      `Finding adapter does not support draft type ${draftType}.`
    );
  }

  const payload = payloadValue(draft);
  const projectId = payload ? textValue(payload.projectId) : undefined;
  const title = payload ? textValue(payload.title) ?? textValue(payload.summary) : undefined;
  const summary = payload
    ? textValue(payload.summary) ?? textValue(payload.evidenceSummary) ?? title
    : undefined;
  if (
    !payload ||
    !projectId ||
    !title ||
    !summary ||
    !isOptionalString(payload.routeNodeId) ||
    !isOptionalString(payload.taskId) ||
    !isOptionalString(payload.experimentId) ||
    !isOptionalStringArray(payload.resultItemIds) ||
    !isOptionalStringArray(payload.linkedResultItemIds) ||
    !isOptionalStringArray(payload.linkedAssetIds) ||
    (payload.findingType !== undefined && !FINDING_TYPES.has(payload.findingType)) ||
    (payload.confidence !== undefined && !CONFIDENCES.has(payload.confidence)) ||
    (payload.status !== undefined && !FINDING_STATUSES.has(payload.status)) ||
    (payload.maturity !== undefined && !MATURITIES.has(payload.maturity))
  ) {
    return failedResult(
      draft.draftInstanceId,
      appliedAt,
      "invalid_finding_payload",
      "finding_create requires projectId, title or summary, valid optional enums, and a draft-level status."
    );
  }

  try {
    const project = await getProjectById(projectId);
    if (!project) {
      return failedResult(
        draft.draftInstanceId,
        appliedAt,
        "project_not_found",
        `Finding target Project was not found: ${projectId}.`
      );
    }

    const routeNodeId = textValue(payload.routeNodeId);
    if (routeNodeId) {
      const routeNode = await getRouteNodeById(routeNodeId);
      if (!routeNode || routeNode.projectId !== projectId) {
        return failedResult(
          draft.draftInstanceId,
          appliedAt,
          "finding_target_not_found",
          `Finding RouteNode was not found in Project ${projectId}: ${routeNodeId}.`
        );
      }
    }

    const taskId = textValue(payload.taskId);
    if (taskId) {
      const task = await getTaskById(taskId);
      if (!task || task.projectId !== projectId) {
        return failedResult(
          draft.draftInstanceId,
          appliedAt,
          "finding_target_not_found",
          `Finding Task was not found in Project ${projectId}: ${taskId}.`
        );
      }
    }

    const experimentId = textValue(payload.experimentId);
    if (experimentId) {
      const experiment = await getExperimentById(experimentId);
      if (!experiment || experiment.projectId !== projectId) {
        return failedResult(
          draft.draftInstanceId,
          appliedAt,
          "finding_target_not_found",
          `Finding Experiment was not found in Project ${projectId}: ${experimentId}.`
        );
      }
    }

    const resultItemIds = uniqueIds(
      payload.resultItemIds,
      payload.linkedResultItemIds,
      payload.linkedAssetIds
    );
    const resultItems = await Promise.all(resultItemIds.map((id) => getResultItemById(id)));
    if (resultItems.some((item) => !item || item.projectId !== projectId)) {
      return failedResult(
        draft.draftInstanceId,
        appliedAt,
        "finding_target_not_found",
        "At least one Finding ResultItem target is missing or belongs to another Project."
      );
    }

    const linkedAssetIds = uniqueIds(payload.linkedAssetIds);
    if (
      linkedAssetIds.some((id) => {
        const item = resultItems[resultItemIds.indexOf(id)];
        return !item?.isAsset;
      })
    ) {
      return failedResult(
        draft.draftInstanceId,
        appliedAt,
        "finding_target_not_found",
        "At least one linkedAssetId does not identify a ResultAsset."
      );
    }

    const finding = await createFinding({
      projectId,
      routeId: routeNodeId ?? null,
      taskId: taskId ?? null,
      experimentId: experimentId ?? null,
      title,
      summary,
      status: payload.status ?? "pending_confirmation",
      findingType: payload.findingType,
      confidence: payload.confidence,
      maturity: payload.maturity ?? "medium",
      resultItemIds,
      assetIds: linkedAssetIds,
      tags: []
    });
    return {
      success: true,
      result: "written",
      message: `Created draft-level Finding ${finding.id} from AI draft ${draft.draftInstanceId}.`,
      createdEntity: {
        module: "output",
        entityType: "finding",
        entityId: finding.id,
        label: finding.title
      },
      sourceDraftId: draft.draftInstanceId,
      appliedAt
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Finding creation error.";
    return failedResult(
      draft.draftInstanceId,
      appliedAt,
      "finding_create_failed",
      `Finding creation failed: ${message}`
    );
  }
}
