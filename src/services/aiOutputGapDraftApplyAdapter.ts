import type {
  AIActionDraft,
  AIActionDraftApplyResult,
  AIOutputGapCreateDraftPayload
} from "../types/aiDraft";
import type { OutputGapType } from "../types/outputConversion";
import type { Priority } from "../types/planning";
import { outputConversionService } from "./outputConversionService";
import { planningService } from "./planningService";

type GetProjectService = typeof planningService.getProjectById;
type GetCandidateService = typeof outputConversionService.getOutputCandidateById;
type CreateOutputGapService = typeof outputConversionService.createOutputGap;

export interface ApplyAIOutputGapDraftOptions {
  draft: AIActionDraft<"output_gap_create">;
  appliedAt?: string;
  getProjectById?: GetProjectService;
  getOutputCandidateById?: GetCandidateService;
  createOutputGap?: CreateOutputGapService;
}

const GAP_TYPES = new Set<OutputGapType>([
  "data",
  "analysis",
  "validation",
  "figure",
  "theory",
  "literature",
  "writing",
  "experiment",
  "code",
  "other"
]);
const PRIORITIES = new Set<Priority>(["high", "medium", "low"]);

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function outputGapPayload(
  draft: AIActionDraft<"output_gap_create">
): AIOutputGapCreateDraftPayload | undefined {
  const payload: unknown = draft.proposedPayload;
  return typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? (payload as AIOutputGapCreateDraftPayload)
    : undefined;
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

export async function applyAIOutputGapDraft({
  draft,
  appliedAt = new Date().toISOString(),
  getProjectById = planningService.getProjectById,
  getOutputCandidateById = outputConversionService.getOutputCandidateById,
  createOutputGap = outputConversionService.createOutputGap
}: ApplyAIOutputGapDraftOptions): Promise<AIActionDraftApplyResult> {
  const draftType: string = draft.draftType;
  if (draftType !== "output_gap_create") {
    return failedResult(
      draft.draftInstanceId,
      appliedAt,
      "unsupported_draft_type",
      `OutputGap adapter does not support draft type ${draftType}.`
    );
  }
  const payload = outputGapPayload(draft);
  const projectId = payload ? textValue(payload.projectId) : undefined;
  const outputCandidateId = payload ? textValue(payload.outputCandidateId) : undefined;
  const title = payload ? textValue(payload.title) : undefined;
  const gapType = payload?.gapType;
  if (
    !payload ||
    !projectId ||
    !outputCandidateId ||
    !title ||
    !gapType ||
    !GAP_TYPES.has(gapType) ||
    (payload.status !== undefined && payload.status !== "pending") ||
    (payload.priority !== undefined && !PRIORITIES.has(payload.priority))
  ) {
    return failedResult(
      draft.draftInstanceId,
      appliedAt,
      "invalid_output_gap_payload",
      "output_gap_create requires projectId, outputCandidateId, title, a valid gapType, optional valid priority, and status pending when provided."
    );
  }

  try {
    const project = await getProjectById(projectId);
    if (!project) {
      return failedResult(
        draft.draftInstanceId,
        appliedAt,
        "project_not_found",
        `OutputGap target Project was not found: ${projectId}.`
      );
    }
    const candidate = await getOutputCandidateById(outputCandidateId);
    if (!candidate) {
      return failedResult(
        draft.draftInstanceId,
        appliedAt,
        "output_candidate_not_found",
        `OutputCandidate was not found: ${outputCandidateId}.`
      );
    }
    if (candidate.projectId !== projectId) {
      return failedResult(
        draft.draftInstanceId,
        appliedAt,
        "output_candidate_project_mismatch",
        `OutputCandidate ${outputCandidateId} does not belong to Project ${projectId}.`
      );
    }
    const gap = await createOutputGap({
      projectId,
      outputCandidateId,
      confirmedByUser: true,
      title,
      description: textValue(payload.description),
      gapType,
      status: "pending",
      priority: payload.priority
    });
    return {
      success: true,
      result: "written",
      message: `Created pending OutputGap ${gap.id} from AI draft ${draft.draftInstanceId}.`,
      createdEntity: {
        module: "output",
        entityType: "outputGap",
        entityId: gap.id,
        label: gap.title
      },
      sourceDraftId: draft.draftInstanceId,
      appliedAt
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown OutputGap creation error.";
    return failedResult(
      draft.draftInstanceId,
      appliedAt,
      "output_gap_create_failed",
      `OutputGap creation failed: ${message}`
    );
  }
}
