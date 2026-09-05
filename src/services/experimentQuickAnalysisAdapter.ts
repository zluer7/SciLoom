import type { AISelectableFileRef, AISelectableFileRefCatalog } from "../types/aiConversation";
import type { FileRef, ManuscriptBinding } from "../types";
import { aiConversationRepository } from "../repositories/aiConversationRepository";
import { experimentCurrentRawManuscriptService } from "./experimentCurrentRawManuscriptService";
import { experimentManuscriptSelectionService } from "./experimentManuscriptSelectionService";
import { experimentService } from "./experimentService";
import { planningService } from "./planningService";
import { fileRefService } from "./fileRefService";

export type ExperimentQuickAnalysisPreflight = {
  ownerType: "experiment";
  ownerId: string;
  channel: "primary";
  projectId: string;
  sourceFileRef: FileRef;
  sourceCatalogEntry: AISelectableFileRef;
  materialCatalog: AISelectableFileRefCatalog;
  ownerFileRefs: FileRef[];
  sourceDirectory: {
    folderFileRefId: string;
    pathIdentityKey: string;
  };
  binding: ManuscriptBinding;
};

export class ExperimentQuickAnalysisPreflightError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ExperimentQuickAnalysisPreflightError";
  }
}

export interface ExperimentQuickAnalysisAdapterDependencies {
  getExperiment: typeof experimentService.getExperimentById;
  getProject: typeof planningService.getProjectById;
  resolveSource: typeof experimentCurrentRawManuscriptService.resolveQuickAnalysisSource;
  resolveWorkspace: typeof experimentManuscriptSelectionService.resolveWorkspace;
  listAttachmentFileRefs: typeof aiConversationRepository.listAttachmentFileRefs;
  listOwnerFileRefs: typeof fileRefService.getFileRefsByOwner;
}

const defaultDependencies: ExperimentQuickAnalysisAdapterDependencies = {
  getExperiment: experimentService.getExperimentById,
  getProject: planningService.getProjectById,
  resolveSource: experimentCurrentRawManuscriptService.resolveQuickAnalysisSource,
  resolveWorkspace: experimentManuscriptSelectionService.resolveWorkspace,
  listAttachmentFileRefs: aiConversationRepository.listAttachmentFileRefs,
  listOwnerFileRefs: fileRefService.getFileRefsByOwner
};

export function createExperimentQuickAnalysisAdapter(
  overrides: Partial<ExperimentQuickAnalysisAdapterDependencies> = {}
) {
  const dependencies = { ...defaultDependencies, ...overrides };
  return Object.freeze({
    async preflight(input: {
      ownerType: "experiment";
      ownerId: string;
      channel: "primary";
      projectId: string;
    }): Promise<ExperimentQuickAnalysisPreflight> {
      if (input.ownerType !== "experiment" || input.channel !== "primary") {
        throw new ExperimentQuickAnalysisPreflightError(
          "QUICK_ANALYSIS_REPRESENTATIVE_SLICE_ONLY",
          "LP13-D1-A6 supports only Experiment/primary."
        );
      }
      const [experiment, project, source, workspace, catalog, ownerFileRefs] = await Promise.all([
        dependencies.getExperiment(input.ownerId),
        dependencies.getProject(input.projectId),
        dependencies.resolveSource(input.ownerId),
        dependencies.resolveWorkspace(input.ownerId),
        dependencies.listAttachmentFileRefs(),
        dependencies.listOwnerFileRefs("experiment", input.ownerId)
      ]);
      if (
        !experiment || experiment.deletedAt || experiment.status === "archived" ||
        experiment.projectId !== input.projectId || !project || project.deletedAt ||
        project.status === "archived"
      ) {
        throw new ExperimentQuickAnalysisPreflightError(
          "QUICK_ANALYSIS_OWNER_SCOPE_UNAVAILABLE",
          "The selected Experiment and Project are no longer eligible."
        );
      }
      if (source.status !== "success") {
        throw new ExperimentQuickAnalysisPreflightError(
          "QUICK_ANALYSIS_SOURCE_UNAVAILABLE",
          `The current Experiment manuscript is unavailable (${source.error.code}).`
        );
      }
      const sourceParentIdentity = source.sourceFileRef.pathIdentityKey.replace(/[\\/][^\\/]+$/u, "");
      if (
        source.projectId !== input.projectId || source.binding.ownerType !== "experiment" ||
        source.binding.ownerId !== input.ownerId || source.binding.manuscriptChannel !== "primary" ||
        source.binding.currentFileRefId !== source.sourceFileRef.id ||
        source.binding.defaultFolderFileRefId !== workspace.folderFileRefId ||
        workspace.pathIdentity !== sourceParentIdentity
      ) {
        throw new ExperimentQuickAnalysisPreflightError(
          "QUICK_ANALYSIS_SOURCE_DIRECTORY_MISMATCH",
          "Current source, Binding, and managed source directory do not form one canonical identity."
        );
      }
      const sourceCatalogEntry = catalog.fileRefs.find((candidate) =>
        candidate.fileRefId === source.sourceFileRef.id);
      if (
        !sourceCatalogEntry || sourceCatalogEntry.resourceKind !== "file" ||
        sourceCatalogEntry.availabilityStatus !== "available" ||
        sourceCatalogEntry.materialReadStatus !== "supported" ||
        !sourceCatalogEntry.materialFreshnessReceipt ||
        sourceCatalogEntry.materialFreshnessReceipt.fileRefId !== source.sourceFileRef.id ||
        !Number.isSafeInteger(sourceCatalogEntry.materialPromptReservationCharacters) ||
        (sourceCatalogEntry.materialPromptReservationCharacters ?? 0) <= 0
      ) {
        throw new ExperimentQuickAnalysisPreflightError(
          "QUICK_ANALYSIS_SOURCE_NOT_MATERIAL_READABLE",
          "The frozen source is not currently eligible for canonical material reading."
        );
      }
      return {
        ownerType: "experiment",
        ownerId: input.ownerId,
        channel: "primary",
        projectId: input.projectId,
        sourceFileRef: source.sourceFileRef,
        sourceCatalogEntry: { ...sourceCatalogEntry, materialFreshnessReceipt: { ...sourceCatalogEntry.materialFreshnessReceipt } },
        materialCatalog: {
          ...catalog,
          fileRefs: catalog.fileRefs.map((fileRef) => ({
            ...fileRef,
            ...(fileRef.materialFreshnessReceipt
              ? { materialFreshnessReceipt: { ...fileRef.materialFreshnessReceipt } }
              : {})
          })),
          supportedExtensions: [...catalog.supportedExtensions]
        },
        ownerFileRefs: ownerFileRefs.map((fileRef) => ({
          ...fileRef,
          customFields: fileRef.customFields.map((field) => ({ ...field }))
        })),
        sourceDirectory: {
          folderFileRefId: workspace.folderFileRefId,
          pathIdentityKey: workspace.pathIdentity
        },
        binding: { ...source.binding }
      };
    }
  });
}

export const experimentQuickAnalysisAdapter = createExperimentQuickAnalysisAdapter();
