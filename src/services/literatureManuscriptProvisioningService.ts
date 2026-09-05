import { literatureRepository } from "../repositories/literatureRepository";
import type { EntityId } from "../types";
import type { ProvisionManagedOwnerResult } from "../types/provisioning";
import {
  provisionManagedEntryWithinMainline,
  resolveManagedMainlineIdentity
} from "./managedFileProvisioningService";
import { getProjectById } from "./planningService";
import { runWithProvisioningAuthority } from "./provisioningAuthorityGuard";
import {
  manuscriptProvisioningMainlineCoordinator,
  observedManagedPrimarySteps,
  type MainlineObservedStep
} from "./manuscriptProvisioningMainlineCoordinator";

export async function ensureLiteratureManuscriptProvisioned(
  literatureId: EntityId
): Promise<ProvisionManagedOwnerResult> {
  const literature = await literatureRepository.getById(literatureId);
  if (!literature) throw new Error(`Literature not found or inactive: ${literatureId}.`);
  const projectId = literature.primaryProjectId?.trim();
  const project = projectId ? await getProjectById(projectId) : undefined;
  if (projectId && (!project || project.deletedAt)) {
    throw new Error(`Project not found: ${projectId}.`);
  }
  const placement = projectId
    ? { projectId, projectTitle: project!.title }
    : { projectId: null, projectTitle: null };
  const common = {
    ownerType: "literature" as const,
    ownerId: literature.id,
    ownerTitle: literature.title,
    createdAt: literature.createdAt,
    ...placement,
    source: "system" as const
  };
  return runWithProvisioningAuthority({
    request: {
      intent: "provisioningWrite",
      requestId: `literature-provisioning-${literature.id}`,
      projectId: projectId || undefined,
      ownerType: "literature",
      ownerId: literature.id,
      scope: "literature-aggregate"
    },
    write: async (permit, authority) => {
      const canonicalCommon = projectId
        ? { ...common, projectId, projectTitle: authority.projectTitle ?? project!.title }
        : { ...common, ownerType: "literature" as const, projectId: null as null, projectTitle: null as null };
      const outlineInput = {
        ...canonicalCommon,
        manuscriptChannel: "literature_outline",
        manuscriptFileName: "literature-outline.md",
        manuscriptDisplayName: "文献纲要"
      } as const;
      const dedicatedNotesInput = {
        ...canonicalCommon,
        manuscriptChannel: "dedicated_notes",
        manuscriptFileName: "dedicated-notes.md",
        manuscriptDisplayName: "专属笔记"
      } as const;
      const [outlinePlacement, notesPlacement] = await Promise.all([
        resolveManagedMainlineIdentity(outlineInput, authority),
        resolveManagedMainlineIdentity(dedicatedNotesInput, authority)
      ]);
      if (
        outlinePlacement.identity.expectedDirectoryPath !==
        notesPlacement.identity.expectedDirectoryPath
      ) {
        throw new Error("Literature child channels resolved to different aggregate workspaces.");
      }
      const identity = {
        ownerType: "literature" as const,
        ownerId: literature.id,
        scope: "literature-aggregate" as const,
        expectedDirectoryPath: outlinePlacement.identity.expectedDirectoryPath,
        expectedManuscripts: [
          ...outlinePlacement.identity.expectedManuscripts,
          ...notesPlacement.identity.expectedManuscripts
        ]
      };
      const operation = await manuscriptProvisioningMainlineCoordinator.begin(identity, permit);
      const outline = await provisionManagedEntryWithinMainline(outlineInput, permit, authority);
      const dedicatedNotes = outline.status === "error"
        ? undefined
        : await provisionManagedEntryWithinMainline(dedicatedNotesInput, permit, authority);
      const aggregate = dedicatedNotes ?? outline;
      const changed = outline.status === "success" || dedicatedNotes?.status === "success";
      const effectReady = Boolean(dedicatedNotes) &&
        [outline.status, dedicatedNotes!.status]
          .every((status) => status === "success" || status === "skipped");
      const outlineSteps = observedManagedPrimarySteps(outline, "literature_outline")
        .filter((step) => !["ensure-directory", "register-folder-fileref", "converge-owner-metadata"].includes(step.stepKind));
      const notesSteps = dedicatedNotes
        ? observedManagedPrimarySteps(dedicatedNotes, "dedicated_notes")
          .filter((step) => !["ensure-directory", "register-folder-fileref", "converge-owner-metadata"].includes(step.stepKind))
        : [];
      const aggregateSteps: MainlineObservedStep[] = [
        ...(outline.absoluteFolderPath && outline.completedSteps.includes("directory")
          ? [{
              stepKind: "ensure-directory" as const,
              stepScope: "literature-aggregate" as const,
              effectOutcome: outline.createdFolder ? "created" as const : "reused" as const,
              observedIdentity: outline.absoluteFolderPath,
              readbackPath: outline.absoluteFolderPath
            }]
          : []),
        ...(outline.defaultFolderFileRef && outline.completedSteps.includes("default-folder-file-ref")
          ? [{
              stepKind: "register-folder-fileref" as const,
              stepScope: "literature-aggregate" as const,
              effectOutcome: outline.folderFileRefState === "created" ? "created" as const : "reused" as const,
              observedIdentity: outline.defaultFolderFileRef.pathIdentityKey,
              resourceRecordId: outline.defaultFolderFileRef.id,
              readbackPath: outline.defaultFolderFileRef.path
            }]
          : []),
        ...outlineSteps,
        ...notesSteps,
        ...(effectReady
          ? [{
              stepKind: "converge-owner-metadata" as const,
              stepScope: "literature-aggregate" as const,
              effectOutcome: "preserved" as const,
              observedIdentity: `literature|${literature.id}`
            }]
          : [])
      ];
      let terminal;
      try {
        terminal = await manuscriptProvisioningMainlineCoordinator.finish(
          identity,
          operation.operationId,
          effectReady,
          aggregate.errors[0]?.code,
          aggregateSteps,
          permit,
          outline.effectOutcomeUnknown === true || dedicatedNotes?.effectOutcomeUnknown === true
        );
      } catch (finishError) {
        const finishMessage = finishError instanceof Error
          ? finishError.message
          : String(finishError);
        return {
          ...aggregate,
          status: "partial" as const,
          retryable: false,
          durableOperationId: operation.operationId,
          durableRootOperationId: operation.rootOperationId,
          durableReady: false,
          warnings: [
            ...outline.warnings,
            ...(dedicatedNotes?.warnings ?? []),
            `Literature manuscript terminal confirmation is unavailable; automatic retry is disabled: ${finishMessage}`
          ],
          errors: [...outline.errors, ...(dedicatedNotes?.errors ?? [])],
          completedSteps: [
            ...outline.completedSteps.map((step) => `literature_outline:${step}`),
            ...(dedicatedNotes?.completedSteps ?? []).map((step) => `dedicated_notes:${step}`)
          ]
        };
      }
      return {
        ...aggregate,
        status: terminal.ready
          ? (changed ? "success" as const : "skipped" as const)
          : "partial" as const,
        retryable: terminal.ready ? false : terminal.nextAction === "retry",
        durableOperationId: terminal.operationId,
        durableRootOperationId: terminal.rootOperationId,
        durableReady: terminal.ready,
        warnings: [...outline.warnings, ...(dedicatedNotes?.warnings ?? [])],
        errors: [...outline.errors, ...(dedicatedNotes?.errors ?? [])],
        completedSteps: [
          ...outline.completedSteps.map((step) => `literature_outline:${step}`),
          ...(dedicatedNotes?.completedSteps ?? []).map((step) => `dedicated_notes:${step}`)
        ]
      };
    }
  });
}

export const literatureManuscriptProvisioningService = {
  ensureProvisioned: ensureLiteratureManuscriptProvisioned
};
