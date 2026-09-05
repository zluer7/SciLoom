import { aiConversationRepository } from "../repositories/aiConversationRepository";
import type { AISelectableFileRef, AISelectableFileRefCatalog } from "../types/aiConversation";
import type { FileRef, Literature, ManuscriptBinding } from "../types";
import type { ReviewType } from "../types/planning";
import { fileRefService } from "./fileRefService";
import { getReadableFileRefOwnerContext } from "./fileRefOwnerValidator";
import {
  getManuscriptOutlineDescriptor,
  type ManuscriptOutlineDescriptor
} from "./manuscriptOutlineDescriptorRegistry";
import { manuscriptBindingService } from "./manuscriptBindingService";
import { planningService } from "./planningService";
import { buildQuickAnalysisLiteratureCandidateScaffold } from "./quickAnalysisLiteratureCandidateScaffold";
import {
  resolveQuickAnalysisCapabilityBinding,
  type QuickAnalysisCapabilityBinding,
  type QuickAnalysisStartInput
} from "./quickAnalysisCapabilityBinding";

type CanonicalOwnerEntity = {
  id: string;
  projectId?: string | null;
  primaryProjectId?: string | null;
  experimentId?: string | null;
  title?: string | null;
  name?: string | null;
  outputName?: string | null;
  doi?: string | null;
  status?: string | null;
  reviewType?: ReviewType | null;
  isArchived?: boolean;
  deletedAt?: string | null;
};

export type QuickAnalysisCanonicalPreflight = {
  bindingCapability: QuickAnalysisCapabilityBinding;
  ownerType: QuickAnalysisStartInput["ownerType"];
  ownerId: string;
  channel: QuickAnalysisStartInput["channel"];
  projectId?: string;
  ownerLabel: string;
  ownerDoi?: string;
  parentExperimentId?: string;
  sourceFileRef: FileRef;
  sourceCatalogEntry: AISelectableFileRef;
  materialCatalog: AISelectableFileRefCatalog;
  ownerFileRefs: FileRef[];
  sourceDirectory: {
    folderFileRefId: string;
    pathIdentityKey: string;
  };
  candidateDocumentScaffold: {
    metaSnapshot: string;
    outline: string;
  };
  manuscriptOutlineDescriptor: ManuscriptOutlineDescriptor;
  binding: ManuscriptBinding;
};

export class QuickAnalysisCanonicalSourceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "QuickAnalysisCanonicalSourceError";
  }
}

export interface QuickAnalysisCanonicalSourceDependencies {
  getOwner: typeof getReadableFileRefOwnerContext;
  getProject: typeof planningService.getProjectById;
  getBinding: typeof manuscriptBindingService.getBindingByOwner;
  getFileRef: typeof fileRefService.getById;
  listOwnerFileRefs: typeof fileRefService.getFileRefsByOwner;
  listAttachmentFileRefs: typeof aiConversationRepository.listAttachmentFileRefs;
}

const defaultDependencies: QuickAnalysisCanonicalSourceDependencies = {
  getOwner: getReadableFileRefOwnerContext,
  getProject: planningService.getProjectById,
  getBinding: manuscriptBindingService.getBindingByOwner,
  getFileRef: fileRefService.getById,
  listOwnerFileRefs: fileRefService.getFileRefsByOwner,
  listAttachmentFileRefs: aiConversationRepository.listAttachmentFileRefs
};

function cloneFileRef(fileRef: FileRef): FileRef {
  return { ...fileRef, customFields: fileRef.customFields.map((field) => ({ ...field })) };
}

function parentPathIdentity(pathIdentityKey: string) {
  return pathIdentityKey.replace(/[\\/][^\\/]+$/u, "");
}

function ownerLifecycleEligible(ownerType: QuickAnalysisStartInput["ownerType"], entity: CanonicalOwnerEntity) {
  if (entity.deletedAt || entity.isArchived) return false;
  if (ownerType === "experiment" || ownerType === "experimentRun" || ownerType === "researchOutput") {
    return entity.status !== "archived";
  }
  if (ownerType === "finding" || ownerType === "outputGap") {
    return entity.status !== "abandoned";
  }
  return true;
}

function resolveProjectId(input: QuickAnalysisStartInput, entity: CanonicalOwnerEntity) {
  const canonicalLiteratureProjectId = entity.primaryProjectId?.trim();
  const expected = input.expectedProjectOrScopeId?.trim();
  if (input.ownerType === "literature" && input.channel === "literature_outline") {
    if (canonicalLiteratureProjectId && expected && expected !== canonicalLiteratureProjectId) {
      throw new QuickAnalysisCanonicalSourceError(
        "QUICK_ANALYSIS_SCOPE_MISMATCH",
        "The caller scope hint contradicts the canonical Literature association."
      );
    }
    return canonicalLiteratureProjectId || undefined;
  }
  const canonicalProjectId = input.ownerType === "literature"
    ? canonicalLiteratureProjectId || expected
    : entity.projectId?.trim();
  if (!canonicalProjectId) {
    throw new QuickAnalysisCanonicalSourceError(
      "QUICK_ANALYSIS_SCOPE_UNAVAILABLE",
      "The canonical owner has no eligible Project or validated Project scope."
    );
  }
  if (expected && expected !== canonicalProjectId) {
    throw new QuickAnalysisCanonicalSourceError(
      "QUICK_ANALYSIS_SCOPE_MISMATCH",
      "The caller scope hint does not match the canonical owner/scope resolver."
    );
  }
  return canonicalProjectId;
}

function candidateDocumentScaffold(
  input: QuickAnalysisStartInput,
  entity: CanonicalOwnerEntity
) {
  if (input.ownerType !== "literature") {
    return { metaSnapshot: "", outline: "" };
  }
  if (input.channel !== "literature_outline" && input.channel !== "dedicated_notes") {
    throw new QuickAnalysisCanonicalSourceError(
      "QUICK_ANALYSIS_CHANNEL_UNSUPPORTED",
      "The Literature Quick Analysis channel is unsupported."
    );
  }
  const literature = entity as Literature;
  return buildQuickAnalysisLiteratureCandidateScaffold(literature, input.channel);
}

function materialEntry(catalog: AISelectableFileRefCatalog, sourceFileRefId: string) {
  return catalog.fileRefs.find((candidate) => candidate.fileRefId === sourceFileRefId);
}

function resolveLiveManuscriptOutlineDescriptor(
  input: QuickAnalysisStartInput,
  entity: CanonicalOwnerEntity
) {
  try {
    return getManuscriptOutlineDescriptor({
      ownerType: input.ownerType,
      channel: input.channel,
      ...(input.ownerType === "review" && entity.reviewType
        ? { reviewType: entity.reviewType }
        : {})
    });
  } catch (error) {
    throw new QuickAnalysisCanonicalSourceError(
      "QUICK_ANALYSIS_MANUSCRIPT_DESCRIPTOR_UNAVAILABLE",
      error instanceof Error
        ? error.message
        : "The exact owner/channel manuscript descriptor is unavailable."
    );
  }
}

export function createQuickAnalysisCanonicalSourcePort(
  overrides: Partial<QuickAnalysisCanonicalSourceDependencies> = {}
) {
  const dependencies = { ...defaultDependencies, ...overrides };
  return Object.freeze({
    async resolve(input: QuickAnalysisStartInput): Promise<QuickAnalysisCanonicalPreflight> {
      const ownerId = input.ownerId.trim();
      if (!ownerId) {
        throw new QuickAnalysisCanonicalSourceError(
          "QUICK_ANALYSIS_OWNER_REQUIRED",
          "Quick Analysis requires one exact owner identity."
        );
      }
      const bindingCapability = resolveQuickAnalysisCapabilityBinding(input);
      let ownerContext: Awaited<ReturnType<typeof dependencies.getOwner>>;
      try {
        ownerContext = await dependencies.getOwner(input.ownerType, ownerId);
      } catch (error) {
        throw new QuickAnalysisCanonicalSourceError(
          "QUICK_ANALYSIS_OWNER_UNAVAILABLE",
          error instanceof Error ? error.message : "The canonical owner is unavailable."
        );
      }
      const entity = ownerContext.entity as CanonicalOwnerEntity;
      if (
        ownerContext.ownerType !== input.ownerType || ownerContext.ownerId !== ownerId ||
        ownerContext.readOnly || !ownerLifecycleEligible(input.ownerType, entity)
      ) {
        throw new QuickAnalysisCanonicalSourceError(
          "QUICK_ANALYSIS_OWNER_LIFECYCLE_INELIGIBLE",
          "The exact owner is not writable and eligible for a new candidate."
        );
      }
      const manuscriptOutlineDescriptor = resolveLiveManuscriptOutlineDescriptor(input, entity);
      const projectId = resolveProjectId(input, entity);
      if (projectId) {
        const project = await dependencies.getProject(projectId);
        if (!project || project.deletedAt || project.status === "archived") {
          throw new QuickAnalysisCanonicalSourceError(
            "QUICK_ANALYSIS_PROJECT_UNAVAILABLE",
            "The canonical Quick Analysis Project is missing or archived."
          );
        }
      }
      const binding = await dependencies.getBinding(input.ownerType, ownerId, input.channel);
      if (
        !binding || binding.deletedAt || binding.ownerType !== input.ownerType ||
        binding.ownerId !== ownerId || binding.manuscriptChannel !== input.channel ||
        !binding.currentFileRefId || !binding.defaultFolderFileRefId
      ) {
        throw new QuickAnalysisCanonicalSourceError(
          "QUICK_ANALYSIS_BINDING_UNAVAILABLE",
          "The exact owner/channel Binding is missing or incomplete."
        );
      }
      const [sourceFileRef, sourceDirectory, materialCatalog, ownerFileRefs] = await Promise.all([
        dependencies.getFileRef(binding.currentFileRefId),
        dependencies.getFileRef(binding.defaultFolderFileRefId),
        dependencies.listAttachmentFileRefs(),
        dependencies.listOwnerFileRefs(input.ownerType, ownerId)
      ]);
      if (
        !sourceFileRef || sourceFileRef.deletedAt ||
        sourceFileRef.ownerType !== input.ownerType || sourceFileRef.ownerId !== ownerId ||
        sourceFileRef.manuscriptChannel !== input.channel ||
        sourceFileRef.resourceKind !== "file" || sourceFileRef.fileRole !== "manuscript" ||
        sourceFileRef.locationMode !== "managed" || !sourceFileRef.pathIdentityKey
      ) {
        throw new QuickAnalysisCanonicalSourceError(
          "QUICK_ANALYSIS_SOURCE_UNAVAILABLE",
          "Binding.current does not resolve to one exact active managed manuscript FileRef."
        );
      }
      if (
        !sourceDirectory || sourceDirectory.deletedAt ||
        sourceDirectory.ownerType !== input.ownerType || sourceDirectory.ownerId !== ownerId ||
        sourceDirectory.resourceKind !== "folder" || sourceDirectory.fileRole !== "defaultFolder" ||
        sourceDirectory.locationMode !== "managed" || !sourceDirectory.pathIdentityKey ||
        parentPathIdentity(sourceFileRef.pathIdentityKey) !== sourceDirectory.pathIdentityKey
      ) {
        throw new QuickAnalysisCanonicalSourceError(
          "QUICK_ANALYSIS_SOURCE_DIRECTORY_MISMATCH",
          "Binding.current and the canonical managed candidate directory do not form one identity."
        );
      }
      const sourceCatalogEntry = materialEntry(materialCatalog, sourceFileRef.id);
      if (
        !sourceCatalogEntry || sourceCatalogEntry.resourceKind !== "file" ||
        sourceCatalogEntry.availabilityStatus !== "available" ||
        sourceCatalogEntry.materialReadStatus !== "supported" ||
        !sourceCatalogEntry.materialFreshnessReceipt ||
        sourceCatalogEntry.materialFreshnessReceipt.fileRefId !== sourceFileRef.id ||
        !Number.isSafeInteger(sourceCatalogEntry.materialPromptReservationCharacters) ||
        (sourceCatalogEntry.materialPromptReservationCharacters ?? 0) <= 0
      ) {
        throw new QuickAnalysisCanonicalSourceError(
          "QUICK_ANALYSIS_SOURCE_NOT_MATERIAL_READABLE",
          "The exact current manuscript is not currently eligible for canonical material reading."
        );
      }
      return {
        bindingCapability,
        ownerType: input.ownerType,
        ownerId,
        channel: input.channel,
        ...(projectId ? { projectId } : {}),
        ownerLabel: entity.title?.trim() || entity.name?.trim() || entity.outputName?.trim() || ownerId,
        ...(input.ownerType === "literature" && entity.doi?.trim()
          ? { ownerDoi: entity.doi.trim() }
          : {}),
        ...(input.ownerType === "experimentRun" && entity.experimentId
          ? { parentExperimentId: entity.experimentId }
          : {}),
        sourceFileRef: cloneFileRef(sourceFileRef),
        sourceCatalogEntry: {
          ...sourceCatalogEntry,
          materialFreshnessReceipt: { ...sourceCatalogEntry.materialFreshnessReceipt }
        },
        materialCatalog: {
          ...materialCatalog,
          fileRefs: materialCatalog.fileRefs.map((fileRef) => ({
            ...fileRef,
            ...(fileRef.materialFreshnessReceipt
              ? { materialFreshnessReceipt: { ...fileRef.materialFreshnessReceipt } }
              : {})
          })),
          supportedExtensions: [...materialCatalog.supportedExtensions]
        },
        ownerFileRefs: ownerFileRefs.map(cloneFileRef),
        sourceDirectory: {
          folderFileRefId: sourceDirectory.id,
          pathIdentityKey: sourceDirectory.pathIdentityKey
        },
        candidateDocumentScaffold: candidateDocumentScaffold(input, entity),
        manuscriptOutlineDescriptor,
        binding: { ...binding }
      };
    }
  });
}

export const quickAnalysisCanonicalSourcePort = createQuickAnalysisCanonicalSourcePort();
