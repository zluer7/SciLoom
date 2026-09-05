import { manuscriptBindingService } from "./manuscriptBindingService";
import type { AISelectableFileRef, FileRefOwnerType, ManuscriptChannel } from "../types";
import type { AIResearchObjectDescriptor, AIResearchObjectType } from "../types/aiContext";

export type AIAssociatedCurrentManuscript = {
  fileRefId: string;
  displayName: string;
  ownerType: FileRefOwnerType;
  ownerId: string;
  manuscriptChannel: ManuscriptChannel;
};

export type AIAssociatedCurrentManuscriptIssue = {
  ownerType: FileRefOwnerType;
  ownerId: string;
  manuscriptChannel: ManuscriptChannel;
  reason: "identity_unavailable" | "current_missing" | "material_unavailable";
};

export type AIAssociatedCurrentManuscriptProjection = {
  materials: AIAssociatedCurrentManuscript[];
  issues: AIAssociatedCurrentManuscriptIssue[];
};

type ResolverDependencies = {
  resolveIdentity: typeof manuscriptBindingService.resolveIdentity;
};

function ownerTypeForResearchObject(
  objectType: AIResearchObjectType
): FileRefOwnerType | undefined {
  if (objectType === "experiment") return "experiment";
  if (objectType === "experimentRun") return "experimentRun";
  if (objectType === "literature") return "literature";
  if (objectType === "review") return "review";
  if (objectType === "resultItem") return "resultItem";
  if (objectType === "finding") return "finding";
  if (objectType === "outputCandidate") return "outputCandidate";
  if (objectType === "outputGap") return "outputGap";
  if (objectType === "researchOutput") return "researchOutput";
  return undefined;
}

function channelsForOwner(ownerType: FileRefOwnerType): ManuscriptChannel[] {
  return ownerType === "literature"
    ? ["literature_outline", "dedicated_notes"]
    : ["primary"];
}

function isReadyMaterial(candidate: AISelectableFileRef | undefined): candidate is AISelectableFileRef {
  return Boolean(
    candidate &&
    candidate.resourceKind === "file" &&
    candidate.availabilityStatus === "available" &&
    candidate.materialReadStatus === "supported" &&
    Number.isSafeInteger(candidate.materialPromptReservationCharacters) &&
    (candidate.materialPromptReservationCharacters ?? 0) > 0 &&
    candidate.materialFreshnessReceipt?.fileRefId === candidate.fileRefId &&
    candidate.materialFreshnessReceipt.receiptVersion === "material-source-v1" &&
    /^[a-f0-9]{64}$/u.test(candidate.materialFreshnessReceipt.sourceToken)
  );
}

export async function resolveAIAssociatedCurrentManuscriptsWithDependencies(
  descriptors: readonly AIResearchObjectDescriptor[],
  catalog: readonly AISelectableFileRef[],
  dependencies: ResolverDependencies
): Promise<AIAssociatedCurrentManuscriptProjection> {
  const materials: AIAssociatedCurrentManuscript[] = [];
  const issues: AIAssociatedCurrentManuscriptIssue[] = [];
  const seenFileRefIds = new Set<string>();

  for (const descriptor of descriptors) {
    const ownerType = ownerTypeForResearchObject(descriptor.objectType);
    if (!ownerType) continue;
    for (const manuscriptChannel of channelsForOwner(ownerType)) {
      const identity = await dependencies.resolveIdentity({
        ownerType,
        ownerId: descriptor.objectId,
        manuscriptChannel
      });
      if (identity.status === "error" || identity.status === "invalid") {
        issues.push({
          ownerType,
          ownerId: descriptor.objectId,
          manuscriptChannel,
          reason: "identity_unavailable"
        });
        continue;
      }
      const currentSlot = identity.slots.currentFileRefId;
      const currentFileRefId = currentSlot.status === "resolved"
        ? currentSlot.fileRefId
        : null;
      if (!currentFileRefId) {
        issues.push({
          ownerType,
          ownerId: descriptor.objectId,
          manuscriptChannel,
          reason: "current_missing"
        });
        continue;
      }
      const candidate = catalog.find((item) => item.fileRefId === currentFileRefId);
      if (!isReadyMaterial(candidate)) {
        issues.push({
          ownerType,
          ownerId: descriptor.objectId,
          manuscriptChannel,
          reason: "material_unavailable"
        });
        continue;
      }
      if (seenFileRefIds.has(candidate.fileRefId)) continue;
      seenFileRefIds.add(candidate.fileRefId);
      materials.push({
        fileRefId: candidate.fileRefId,
        displayName: candidate.displayName,
        ownerType,
        ownerId: descriptor.objectId,
        manuscriptChannel
      });
    }
  }

  return { materials, issues };
}

export function resolveAIAssociatedCurrentManuscripts(
  descriptors: readonly AIResearchObjectDescriptor[],
  catalog: readonly AISelectableFileRef[]
) {
  return resolveAIAssociatedCurrentManuscriptsWithDependencies(descriptors, catalog, {
    resolveIdentity: manuscriptBindingService.resolveIdentity
  });
}

export const aiAssociatedCurrentManuscriptService = {
  resolve: resolveAIAssociatedCurrentManuscripts
};
