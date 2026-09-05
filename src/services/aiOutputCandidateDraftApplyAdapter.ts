import type {
  AIActionDraft,
  AIActionDraftApplyResult,
  AIOutputCandidateCreateDraftPayload
} from "../types/aiDraft";
import type {
  OutputCandidateStatus,
  OutputCandidateType
} from "../types/outputConversion";
import { outputConversionService } from "./outputConversionService";
import { planningService } from "./planningService";

type GetProjectService = typeof planningService.getProjectById;
type GetRouteNodeService = typeof planningService.getRouteNodeById;
type GetTaskService = typeof planningService.getTaskById;
type GetFindingService = typeof outputConversionService.getFindingById;
type GetResultItemService = typeof outputConversionService.getResultItemById;
type CreateOutputCandidateService = typeof outputConversionService.createOutputCandidate;

export interface ApplyAIOutputCandidateDraftOptions {
  draft: AIActionDraft<"output_candidate_create">;
  appliedAt?: string;
  getProjectById?: GetProjectService;
  getRouteNodeById?: GetRouteNodeService;
  getTaskById?: GetTaskService;
  getFindingById?: GetFindingService;
  getResultItemById?: GetResultItemService;
  createOutputCandidate?: CreateOutputCandidateService;
}

const CANDIDATE_TYPES = new Set<OutputCandidateType>([
  "paper",
  "patent",
  "report",
  "dataset",
  "software",
  "method",
  "model",
  "caseStudy",
  "presentation",
  "futureProject",
  "other"
]);
const SAFE_STATUSES = new Set<OutputCandidateStatus>([
  "pending_evaluation",
  "needs_gap_resolution",
  "ready_for_formal"
]);

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
  draft: AIActionDraft<"output_candidate_create">
): AIOutputCandidateCreateDraftPayload | undefined {
  const payload: unknown = draft.proposedPayload;
  return typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? (payload as AIOutputCandidateCreateDraftPayload)
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

export async function applyAIOutputCandidateDraft({
  draft,
  appliedAt = new Date().toISOString(),
  getProjectById = planningService.getProjectById,
  getRouteNodeById = planningService.getRouteNodeById,
  getTaskById = planningService.getTaskById,
  getFindingById = outputConversionService.getFindingById,
  getResultItemById = outputConversionService.getResultItemById,
  createOutputCandidate = outputConversionService.createOutputCandidate
}: ApplyAIOutputCandidateDraftOptions): Promise<AIActionDraftApplyResult> {
  const draftType: string = draft.draftType;
  if (draftType !== "output_candidate_create") {
    return failedResult(
      draft.draftInstanceId,
      appliedAt,
      "unsupported_draft_type",
      `OutputCandidate adapter does not support draft type ${draftType}.`
    );
  }

  const payload = payloadValue(draft);
  const projectId = payload ? textValue(payload.projectId) : undefined;
  const title = payload ? textValue(payload.title) : undefined;
  const candidateType = payload?.candidateType;
  if (
    !payload ||
    !projectId ||
    !title ||
    !candidateType ||
    !CANDIDATE_TYPES.has(candidateType) ||
    !isOptionalString(payload.routeNodeId) ||
    !isOptionalString(payload.taskId) ||
    !isOptionalStringArray(payload.findingIds) ||
    !isOptionalStringArray(payload.linkedFindingIds) ||
    !isOptionalStringArray(payload.resultItemIds) ||
    !isOptionalStringArray(payload.linkedResultItemIds) ||
    !isOptionalStringArray(payload.linkedAssetIds) ||
    (payload.status !== undefined && !SAFE_STATUSES.has(payload.status))
  ) {
    return failedResult(
      draft.draftInstanceId,
      appliedAt,
      "invalid_output_candidate_payload",
      "output_candidate_create requires projectId, title, a valid candidateType, and a non-formal status."
    );
  }

  try {
    const project = await getProjectById(projectId);
    if (!project) {
      return failedResult(
        draft.draftInstanceId,
        appliedAt,
        "project_not_found",
        `OutputCandidate target Project was not found: ${projectId}.`
      );
    }

    const routeNodeId = textValue(payload.routeNodeId);
    if (routeNodeId) {
      const routeNode = await getRouteNodeById(routeNodeId);
      if (!routeNode || routeNode.projectId !== projectId) {
        return failedResult(
          draft.draftInstanceId,
          appliedAt,
          "output_candidate_target_not_found",
          `OutputCandidate RouteNode was not found in Project ${projectId}: ${routeNodeId}.`
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
          "output_candidate_target_not_found",
          `OutputCandidate Task was not found in Project ${projectId}: ${taskId}.`
        );
      }
    }

    const findingIds = uniqueIds(payload.findingIds, payload.linkedFindingIds);
    const findings = await Promise.all(findingIds.map((id) => getFindingById(id)));
    if (findings.some((finding) => !finding || finding.projectId !== projectId)) {
      return failedResult(
        draft.draftInstanceId,
        appliedAt,
        "output_candidate_target_not_found",
        "At least one OutputCandidate Finding target is missing or belongs to another Project."
      );
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
        "output_candidate_target_not_found",
        "At least one OutputCandidate ResultItem target is missing or belongs to another Project."
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
        "output_candidate_target_not_found",
        "At least one linkedAssetId does not identify a ResultAsset."
      );
    }

    const candidate = await createOutputCandidate({
      projectId,
      routeId: routeNodeId ?? null,
      taskId: taskId ?? null,
      title,
      description:
        textValue(payload.description) ??
        textValue(payload.summary) ??
        textValue(payload.noveltyNotes),
      candidateType,
      status: payload.status ?? "pending_evaluation",
      findingIds,
      resultItemIds,
      assetIds: linkedAssetIds,
      tags: []
    });
    return {
      success: true,
      result: "written",
      message: `Created draft-level OutputCandidate ${candidate.id} from AI draft ${draft.draftInstanceId}.`,
      createdEntity: {
        module: "output",
        entityType: "outputCandidate",
        entityId: candidate.id,
        label: candidate.title
      },
      sourceDraftId: draft.draftInstanceId,
      appliedAt
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown OutputCandidate creation error.";
    return failedResult(
      draft.draftInstanceId,
      appliedAt,
      "output_candidate_create_failed",
      `OutputCandidate creation failed: ${message}`
    );
  }
}
