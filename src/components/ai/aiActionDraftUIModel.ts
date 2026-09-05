import { getAIActionDraftApplyCapability } from "../../services/aiDraftApplyExecutor";
import {
  confirmAIActionDraft,
  type ConfirmAIActionDraftInput
} from "../../services/actionDraftConfirmApplicationService";
import type {
  AIActionDraftPayload,
  AIActionDraftType,
  AIActionDraftUnion
} from "../../types/aiDraft";
import type { TranslationKey } from "../../i18n/translations";

export type AIActionDraftUISupport = "enabled" | "postponed" | "forbidden";
export type AIActionDraftUIStatus =
  | "parsed"
  | "edited"
  | "accepted"
  | "previewed"
  | "applying"
  | "written"
  | "failed"
  | "rejected";

export type AIActionDraftPayloadParseResult =
  | { success: true; payload: AIActionDraftPayload }
  | { success: false; error: string };

export type AIActionDraftDisplayModel = {
  actionKey: TranslationKey;
  entityKey: TranslationKey;
  title: string;
};

const WRITE_ENABLED_TYPES = new Set<AIActionDraftType>([
  "task_create",
  "review_candidate",
  "output_gap_create",
  "finding_create",
  "output_candidate_create",
  "entity_link_create"
]);

export function getAIActionDraftUISupport(
  draft: AIActionDraftUnion
): AIActionDraftUISupport {
  if (WRITE_ENABLED_TYPES.has(draft.draftType)) return "enabled";
  if (draft.draftType === "literature_link_create") return "postponed";
  return "forbidden";
}

export function getAIActionDraftUIStatus(
  draft: AIActionDraftUnion,
  isApplying = false
): AIActionDraftUIStatus {
  if (isApplying) return "applying";
  if (draft.result.applyStatus === "written") return "written";
  if (draft.result.applyStatus === "failed") return "failed";
  if (draft.result.reviewStatus === "rejected") return "rejected";
  if (draft.result.reviewStatus === "accepted" && draft.writePreview) return "previewed";
  if (draft.result.reviewStatus === "accepted") return "accepted";
  if (draft.result.reviewStatus === "edited") return "edited";
  return "parsed";
}

export function getAIActionDraftDisplayModel(
  draft: AIActionDraftUnion,
  untitledTitle: string
): AIActionDraftDisplayModel {
  const byType: Partial<Record<AIActionDraftType, Omit<AIActionDraftDisplayModel, "title">>> = {
    task_create: { actionKey: "aiDraftActionCreate", entityKey: "aiDraftEntityTask" },
    output_gap_create: { actionKey: "aiDraftActionCreate", entityKey: "aiDraftEntityOutputGap" },
    review_candidate: { actionKey: "aiDraftActionCreate", entityKey: "aiDraftEntityReview" },
    finding_create: { actionKey: "aiDraftActionCreate", entityKey: "aiDraftEntityFinding" },
    output_candidate_create: { actionKey: "aiDraftActionCreate", entityKey: "aiDraftEntityOutputCandidate" },
    entity_link_create: { actionKey: "aiDraftActionLink", entityKey: "aiDraftEntityEntityLink" },
    literature_link_create: { actionKey: "aiDraftActionLink", entityKey: "aiDraftEntityEntityLink" },
    task_update: { actionKey: "aiDraftActionUpdate", entityKey: "aiDraftEntityTask" },
    route_update: { actionKey: "aiDraftActionUpdate", entityKey: "aiDraftEntityRoute" },
    review_overwrite: { actionKey: "aiDraftActionUpdate", entityKey: "aiDraftEntityReview" },
    output_gap_update: { actionKey: "aiDraftActionUpdate", entityKey: "aiDraftEntityOutputGap" },
    output_gap_close: { actionKey: "aiDraftActionAdjust", entityKey: "aiDraftEntityOutputGap" }
  };
  const display = byType[draft.draftType] ?? {
    actionKey: "aiDraftActionCreate",
    entityKey: "aiDraftEntitySuggestion"
  };
  return {
    ...display,
    title: draft.title.trim() || untitledTitle
  };
}

export function markAIActionDraftAcceptedLocally(
  draft: AIActionDraftUnion,
  now = new Date().toISOString()
): AIActionDraftUnion {
  return {
    ...draft,
    writePreview: undefined,
    handled: false,
    result: {
      ...draft.result,
      reviewStatus: "accepted",
      applyStatus: "none",
      message: "Accepted locally. Generate a write-back preview before confirming any write.",
      updatedAt: now
    },
    updatedAt: now
  } as AIActionDraftUnion;
}

export function resetAIActionDraftReviewState(
  draft: AIActionDraftUnion,
  now = new Date().toISOString()
): AIActionDraftUnion {
  return {
    ...draft,
    writePreview: undefined,
    handled: false,
    result: {
      ...draft.result,
      reviewStatus: "pending",
      applyStatus: "none",
      message: undefined,
      applyResult: undefined,
      updatedAt: now
    },
    updatedAt: now
  } as AIActionDraftUnion;
}

export function parseAIActionDraftPayloadJson(
  value: string
): AIActionDraftPayloadParseResult {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { success: false, error: "Payload JSON must be an object." };
    }
    return { success: true, payload: parsed as AIActionDraftPayload };
  } catch {
    return { success: false, error: "Payload JSON is invalid." };
  }
}

export function canShowAIActionDraftApply(draft: AIActionDraftUnion): boolean {
  return (
    getAIActionDraftUISupport(draft) === "enabled" &&
    getAIActionDraftApplyCapability(draft).allowed
  );
}

export async function applyAIActionDraftFromExplicitClick(
  input: Omit<ConfirmAIActionDraftInput, "userConfirmedWrite">,
  confirmDraft: typeof confirmAIActionDraft = confirmAIActionDraft
) {
  return confirmDraft({ ...input, userConfirmedWrite: true });
}
