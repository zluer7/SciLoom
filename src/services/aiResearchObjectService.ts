import type {
  AIResearchObjectDescriptor,
  AIResearchObjectSelection
} from "../types/aiContext";
import {
  listRouteResearchObjectDescriptors,
  resolveRouteResearchObjectDescriptor
} from "./routeAIResearchObjectAdapter";
import {
  listTaskResearchObjectDescriptors,
  resolveTaskResearchObjectDescriptor
} from "./taskAIResearchObjectAdapter";
import {
  listReviewResearchObjectDescriptors,
  resolveReviewResearchObjectDescriptor
} from "./reviewAIResearchObjectAdapter";
import {
  listExperimentResearchObjectDescriptors,
  resolveExperimentResearchObjectDescriptor
} from "./experimentAIResearchObjectAdapter";
import {
  listExperimentRunResearchObjectDescriptors,
  resolveExperimentRunResearchObjectDescriptor
} from "./experimentRunAIResearchObjectAdapter";
import {
  listLiteratureResearchObjectDescriptors,
  resolveLiteratureResearchObjectDescriptor
} from "./literatureAIResearchObjectAdapter";
import {
  listFindingResearchObjectDescriptors,
  resolveFindingResearchObjectDescriptor
} from "./findingAIResearchObjectAdapter";
import {
  listOutputsResearchObjectDescriptors,
  resolveOutputsResearchObjectDescriptor,
  type OutputsAIResearchObjectType
} from "./outputsAIResearchObjectAdapter";

export const AI_RESEARCH_OBJECT_SELECTION_MAX = 5;

export class AIResearchObjectSelectionError extends Error {
  constructor(
    public readonly code:
      | "PROJECT_REQUIRED"
      | "SELECTION_LIMIT_EXCEEDED"
      | "UNSUPPORTED_OBJECT_TYPE",
    message: string
  ) {
    super(message);
    this.name = "AIResearchObjectSelectionError";
  }
}

export type ResolvedAIResearchObjects = {
  descriptors: AIResearchObjectDescriptor[];
  duplicateObjectIds: string[];
};

/**
 * Shared live resolver. It dispatches to business-local adapters but owns no
 * package finalization or persistence.
 */
export async function resolveAIResearchObjects(
  projectId: string,
  selections: readonly AIResearchObjectSelection[]
): Promise<ResolvedAIResearchObjects> {
  const normalizedProjectId = projectId.trim();
  if (!normalizedProjectId) {
    throw new AIResearchObjectSelectionError("PROJECT_REQUIRED", "Project is required.");
  }
  const unique: AIResearchObjectSelection[] = [];
  const seen = new Set<string>();
  const duplicateObjectIds: string[] = [];
  for (const selection of selections) {
    if (
      selection.objectType !== "route" &&
      selection.objectType !== "task" &&
      selection.objectType !== "review" &&
      selection.objectType !== "experiment" &&
      selection.objectType !== "experimentRun" &&
      selection.objectType !== "literature" &&
      selection.objectType !== "finding" &&
      selection.objectType !== "resultItem" &&
      selection.objectType !== "outputCandidate" &&
      selection.objectType !== "outputGap" &&
      selection.objectType !== "researchOutput"
    ) {
      throw new AIResearchObjectSelectionError(
        "UNSUPPORTED_OBJECT_TYPE",
        `Unsupported research object type: ${String(selection.objectType)}`
      );
    }
    const key = `${selection.objectType}:${selection.objectId.trim()}`;
    if (seen.has(key)) {
      duplicateObjectIds.push(selection.objectId);
      continue;
    }
    seen.add(key);
    unique.push({ objectType: selection.objectType, objectId: selection.objectId.trim() });
  }
  if (unique.length > AI_RESEARCH_OBJECT_SELECTION_MAX) {
    throw new AIResearchObjectSelectionError(
      "SELECTION_LIMIT_EXCEEDED",
      `At most ${AI_RESEARCH_OBJECT_SELECTION_MAX} research objects can be selected for one call.`
    );
  }

  const descriptors: AIResearchObjectDescriptor[] = [];
  for (const selection of unique) {
    descriptors.push(selection.objectType === "route"
      ? await resolveRouteResearchObjectDescriptor(selection.objectId, normalizedProjectId)
      : selection.objectType === "task"
        ? await resolveTaskResearchObjectDescriptor(selection.objectId, normalizedProjectId)
      : selection.objectType === "review"
        ? await resolveReviewResearchObjectDescriptor(selection.objectId, normalizedProjectId)
        : selection.objectType === "experiment"
          ? await resolveExperimentResearchObjectDescriptor(selection.objectId, normalizedProjectId)
          : selection.objectType === "experimentRun"
            ? await resolveExperimentRunResearchObjectDescriptor(selection.objectId, normalizedProjectId)
            : selection.objectType === "literature"
              ? await resolveLiteratureResearchObjectDescriptor(selection.objectId, normalizedProjectId)
              : selection.objectType === "finding"
                ? await resolveFindingResearchObjectDescriptor(selection.objectId, normalizedProjectId)
                : await resolveOutputsResearchObjectDescriptor(
                    selection.objectType as OutputsAIResearchObjectType,
                    selection.objectId,
                    normalizedProjectId
                  ));
  }
  return { descriptors, duplicateObjectIds };
}

export async function listAIResearchObjectsForProject(
  projectId: string
): Promise<AIResearchObjectDescriptor[]> {
  if (!projectId.trim()) return [];
  const normalizedProjectId = projectId.trim();
  const [
    routes, tasks, reviews, experiments, experimentRuns, literature, findings,
    resultItems, outputCandidates, outputGaps, researchOutputs
  ] = await Promise.all([
    listRouteResearchObjectDescriptors(normalizedProjectId),
    listTaskResearchObjectDescriptors(normalizedProjectId),
    listReviewResearchObjectDescriptors(normalizedProjectId),
    listExperimentResearchObjectDescriptors(normalizedProjectId),
    listExperimentRunResearchObjectDescriptors(normalizedProjectId),
    listLiteratureResearchObjectDescriptors(normalizedProjectId),
    listFindingResearchObjectDescriptors(normalizedProjectId),
    listOutputsResearchObjectDescriptors("resultItem", normalizedProjectId),
    listOutputsResearchObjectDescriptors("outputCandidate", normalizedProjectId),
    listOutputsResearchObjectDescriptors("outputGap", normalizedProjectId),
    listOutputsResearchObjectDescriptors("researchOutput", normalizedProjectId)
  ]);
  return [
    ...routes, ...tasks, ...reviews, ...experiments, ...experimentRuns, ...literature, ...findings,
    ...resultItems, ...outputCandidates, ...outputGaps, ...researchOutputs
  ];
}
