import {
  findingRepositoryConfig,
  outputCandidateRepositoryConfig,
  outputGapRepositoryConfig,
  outputRepositoryConfig,
  resultItemRepositoryConfig
} from "../repositories/entityConfig";
import { createRepository } from "../repositories/repositoryFactory";
import type {
  OutputManuscriptOwnerDescriptor,
  OutputManuscriptOwnerType,
  OutputManuscriptProvisioningResult
} from "../types";
import type { EntityId } from "../types/common";
import type { ManuscriptChannel } from "../types/manuscriptChannel";
import type { ProvisionManagedOwnerResult } from "../types/provisioning";
import { managedFileProvisioningService } from "./managedFileProvisioningService";
import {
  buildOutputManuscriptOwnerDescriptor,
  buildOutputWorkspaceLocalDate,
  isOutputManuscriptOwnerType,
  OutputManuscriptContractError,
  OUTPUT_MANUSCRIPT_ERROR_CODES,
  type OutputManuscriptOwnerEntity
} from "./outputManuscriptDescriptorService";
import { publishWriteFeedbackRefresh } from "./refreshEventService";
import { createWriteFeedbackResult } from "./writeFeedbackService";

type ProjectRecord = {
  id: EntityId;
  title: string;
  deletedAt?: string | null;
};

const ownerRepositories = {
  resultItem: createRepository(resultItemRepositoryConfig),
  finding: createRepository(findingRepositoryConfig),
  outputCandidate: createRepository(outputCandidateRepositoryConfig),
  outputGap: createRepository(outputGapRepositoryConfig),
  researchOutput: createRepository(outputRepositoryConfig)
};

async function loadOutputOwner(ownerType: OutputManuscriptOwnerType, ownerId: EntityId) {
  const repository = ownerRepositories[ownerType];
  return (await repository.getById(ownerId)) ?? (await repository.getDeletedById(ownerId));
}

async function loadProject(projectId: EntityId): Promise<ProjectRecord | undefined> {
  // Project lifecycle/title authority is validated by the formal Planning port
  // inside managedFileProvisioningService. This is only a non-authoritative
  // descriptor placeholder needed by the legacy adapter shape.
  return { id: projectId, title: "" };
}

function publishProvisioningResult(result: OutputManuscriptProvisioningResult) {
  const status = result.completionState === "failed"
    ? "error"
    : result.completionState === "partial"
      ? "partial"
      : result.status;
  publishWriteFeedbackRefresh(
    createWriteFeedbackResult({
      status,
      operation: "outputManuscript.ensureProvisioning",
      data: result,
      affectedEntities: [{
        type: result.ownerType,
        id: result.ownerId,
        relation: result.completionState === "complete" ? "linked" : "skipped"
      }],
      refreshKeys: ["fileRef.changed"],
      warnings: result.warnings,
      errors: result.errors.map((error) => error.message)
    }),
    {
      source: "service.write",
      reason: `Outputs manuscript provisioning ${result.completionState}.`
    }
  );
}

export interface OutputManuscriptProvisioningDependencies {
  loadOwner(
    ownerType: OutputManuscriptOwnerType,
    ownerId: EntityId
  ): Promise<OutputManuscriptOwnerEntity | undefined>;
  loadProject(projectId: EntityId): Promise<ProjectRecord | undefined>;
  provision(input: {
    ownerType: OutputManuscriptOwnerType;
    ownerId: EntityId;
    projectId: EntityId;
    projectTitle: string;
    ownerTitle: string;
    createdAt: string;
    source: "system";
    manuscriptChannel: "primary";
    manuscriptFileName: string;
    manuscriptDisplayName: string;
    collectionFolder: "outputs";
  }): Promise<ProvisionManagedOwnerResult>;
  publishResult(result: OutputManuscriptProvisioningResult): void;
}

const defaultDependencies: OutputManuscriptProvisioningDependencies = {
  loadOwner: loadOutputOwner,
  loadProject,
  provision: (input) => managedFileProvisioningService.provision(input),
  publishResult: publishProvisioningResult
};

function completionState(result: ProvisionManagedOwnerResult) {
  if (result.status === "success" || result.status === "skipped") return "complete" as const;
  if (result.status === "partial") return "partial" as const;
  return "failed" as const;
}

function failedResult(
  ownerType: string,
  ownerId: EntityId,
  code: string,
  message: string,
  step: string,
  retryable = false
): OutputManuscriptProvisioningResult {
  return {
    status: "error",
    completionState: "failed",
    ownerType: ownerType as OutputManuscriptOwnerType,
    ownerId,
    createdFolder: false,
    createdBody: false,
    reusedFolder: false,
    reusedBody: false,
    warnings: [],
    errors: [{ code, message, step }],
    completedSteps: [],
    failedStep: step,
    retryable
  };
}

function errorDetails(error: unknown) {
  if (error instanceof OutputManuscriptContractError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: OUTPUT_MANUSCRIPT_ERROR_CODES.ownerNotFound,
    message: error instanceof Error ? error.message : String(error)
  };
}

export function createOutputManuscriptProvisioningService(
  dependencies: OutputManuscriptProvisioningDependencies = defaultDependencies
) {
  const publishResult = (result: OutputManuscriptProvisioningResult) => {
    try {
      dependencies.publishResult(result);
    } catch {
      // The provisioning outcome remains authoritative if feedback publication fails.
    }
  };
  return {
    async ensureOutputManuscript(
      ownerType: OutputManuscriptOwnerType | string,
      ownerId: EntityId,
      channel?: ManuscriptChannel
    ): Promise<OutputManuscriptProvisioningResult> {
      let result: OutputManuscriptProvisioningResult;
      let descriptor: OutputManuscriptOwnerDescriptor;
      if (!isOutputManuscriptOwnerType(ownerType)) {
        result = failedResult(
          ownerType,
          ownerId,
          OUTPUT_MANUSCRIPT_ERROR_CODES.ownerUnsupported,
          `Unsupported Outputs manuscript ownerType: ${ownerType}.`,
          "descriptor"
        );
        publishResult(result);
        return result;
      }
      let owner: OutputManuscriptOwnerEntity | undefined;
      try {
        owner = await dependencies.loadOwner(ownerType, ownerId);
        descriptor = buildOutputManuscriptOwnerDescriptor(ownerType, ownerId, channel, owner);
      } catch (error) {
        const details = errorDetails(error);
        result = failedResult(ownerType, ownerId, details.code, details.message, "owner-descriptor");
        publishResult(result);
        return result;
      }

      let project: ProjectRecord | undefined;
      try {
        project = await dependencies.loadProject(descriptor.projectId);
      } catch (error) {
        result = failedResult(
          ownerType,
          ownerId,
          "OUTPUT_MANUSCRIPT_PROJECT_READ_FAILED",
          error instanceof Error ? error.message : String(error),
          "project-validation",
          true
        );
        result.descriptor = descriptor;
        publishResult(result);
        return result;
      }
      if (!project) {
        result = failedResult(
          ownerType,
          ownerId,
          OUTPUT_MANUSCRIPT_ERROR_CODES.projectNotFound,
          `Outputs manuscript Project not found: ${descriptor.projectId}.`,
          "project-validation"
        );
        publishResult(result);
        return result;
      }
      if (project.deletedAt) {
        result = failedResult(
          ownerType,
          ownerId,
          OUTPUT_MANUSCRIPT_ERROR_CODES.projectInactive,
          `Outputs manuscript Project is inactive: ${descriptor.projectId}.`,
          "project-validation"
        );
        publishResult(result);
        return result;
      }

      let provisioned: ProvisionManagedOwnerResult;
      try {
        provisioned = await dependencies.provision({
          ownerType: descriptor.ownerType,
          ownerId: descriptor.ownerId,
          projectId: descriptor.projectId,
          projectTitle: project.title,
          ownerTitle: descriptor.displayTitle,
          createdAt: buildOutputWorkspaceLocalDate(descriptor.createdAt),
          source: "system",
          manuscriptChannel: descriptor.channel,
          manuscriptFileName: descriptor.defaultFilename,
          manuscriptDisplayName: descriptor.defaultFilename,
          collectionFolder: descriptor.collectionFolder
        });
      } catch (error) {
        result = failedResult(
          ownerType,
          ownerId,
          "OUTPUT_MANUSCRIPT_PROVISIONING_FAILED",
          error instanceof Error ? error.message : String(error),
          "provisioning",
          true
        );
        result.descriptor = descriptor;
        publishResult(result);
        return result;
      }
      result = {
        ...provisioned,
        completionState: completionState(provisioned),
        descriptor
      };
      publishResult(result);
      return result;
    }
  };
}

export const outputManuscriptProvisioningService =
  createOutputManuscriptProvisioningService();

export const ensureOutputManuscript = (
  ownerType: OutputManuscriptOwnerType,
  ownerId: EntityId,
  channel: "primary"
) => outputManuscriptProvisioningService.ensureOutputManuscript(ownerType, ownerId, channel);
