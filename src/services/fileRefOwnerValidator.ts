import {
  experimentRepositoryConfig,
  experimentRunRepositoryConfig,
  findingRepositoryConfig,
  literatureRepositoryConfig,
  outputCandidateRepositoryConfig,
  outputGapRepositoryConfig,
  outputRepositoryConfig,
  resultItemRepositoryConfig
} from "../repositories/entityConfig";
import { createRepository } from "../repositories/repositoryFactory";
import type { AuditableEntity, EntityId } from "../types/common";
import type { FileRefOwnerType } from "../types/experiment";
import {
  assertValidManuscriptChannelForOwner,
  type ManuscriptChannel
} from "../types/manuscriptChannel";
import { getPlanningFirstLayerData } from "./planningRepository";
import { createFileRefOwnerValidator, isFileRefOwnerType } from "./fileRefIdentity";
import {
  assertExperimentRunWritable,
  getControlledExperimentRunAccess
} from "./experimentRunGuard";

export interface FileRefOwnerContext {
  ownerType: FileRefOwnerType;
  ownerId: EntityId;
  entity: { id: EntityId; deletedAt?: string | null };
}

export type MountedManuscriptLifecycleCapability =
  | "read"
  | "write"
  | "provision"
  | "registerExternal"
  | "saveAs"
  | "openIndependent"
  | "switch"
  | "restore"
  | "hardDeleteMetadata";

export interface MountedManuscriptLifecycleFacts {
  ownerType: FileRefOwnerType;
  ownerId: EntityId;
  manuscriptChannel: ManuscriptChannel;
  ownerDeleted: boolean;
  parentDeleted?: boolean;
  parentMissing?: boolean;
  projectUnavailable?: boolean;
}

export interface MountedManuscriptLifecycleDecision
  extends MountedManuscriptLifecycleFacts {
  canRead: boolean;
  canWrite: boolean;
  canProvision: boolean;
  canRegisterExternal: boolean;
  canSaveAs: boolean;
  canOpenIndependent: boolean;
  canSwitch: boolean;
  canRestore: boolean;
  canHardDeleteMetadata: boolean;
  readOnly: boolean;
  reasonCode?:
    | "OWNER_DELETED"
    | "RUN_PARENT_DELETED"
    | "RUN_PARENT_MISSING"
    | "PROJECT_UNAVAILABLE";
}

export class MountedManuscriptLifecycleDecisionError extends Error {
  readonly decision: MountedManuscriptLifecycleDecision;

  constructor(decision: MountedManuscriptLifecycleDecision) {
    super(
      `MOUNTED_MANUSCRIPT_LIFECYCLE_DENIED: ${decision.ownerType}/${decision.ownerId}/${decision.manuscriptChannel} ${decision.reasonCode ?? "UNKNOWN"}.`
    );
    this.name = "MountedManuscriptLifecycleDecisionError";
    this.decision = decision;
  }
}

/**
 * The single owner-neutral policy used by mounted manuscript callers. Owner-specific
 * services may add narrower durable guards, but must not contradict this decision.
 */
export function deriveMountedManuscriptLifecycleDecision(
  facts: MountedManuscriptLifecycleFacts
): MountedManuscriptLifecycleDecision {
  const manuscriptChannel = assertValidManuscriptChannelForOwner(
    facts.ownerType,
    facts.manuscriptChannel
  );
  const runParentMissing = facts.ownerType === "experimentRun" && Boolean(facts.parentMissing);
  const controlledReadOnly =
    facts.ownerType === "experimentRun" &&
    (Boolean(facts.parentDeleted) || Boolean(facts.projectUnavailable));
  const canRead = !facts.ownerDeleted && !runParentMissing;
  const canWrite = canRead && !controlledReadOnly;
  const reasonCode = facts.ownerDeleted
    ? "OWNER_DELETED"
    : runParentMissing
      ? "RUN_PARENT_MISSING"
      : facts.parentDeleted
        ? "RUN_PARENT_DELETED"
        : facts.projectUnavailable
          ? "PROJECT_UNAVAILABLE"
          : undefined;

  return {
    ...facts,
    manuscriptChannel,
    canRead,
    canWrite,
    canProvision: canWrite,
    canRegisterExternal: canWrite,
    canSaveAs: canWrite,
    canOpenIndependent: canRead,
    canSwitch: canWrite,
    canRestore: facts.ownerDeleted,
    canHardDeleteMetadata: facts.ownerType === "review" && facts.ownerDeleted,
    readOnly: canRead && !canWrite,
    reasonCode
  };
}

type OwnerReadRepository = {
  getById(id: EntityId): Promise<AuditableEntity | undefined>;
  getDeletedById(id: EntityId): Promise<AuditableEntity | undefined>;
};

const repositories: Record<Exclude<FileRefOwnerType, "review">, OwnerReadRepository> = {
  experiment: createRepository(experimentRepositoryConfig),
  experimentRun: createRepository(experimentRunRepositoryConfig),
  literature: createRepository(literatureRepositoryConfig),
  resultItem: createRepository(resultItemRepositoryConfig),
  finding: createRepository(findingRepositoryConfig),
  outputCandidate: createRepository(outputCandidateRepositoryConfig),
  outputGap: createRepository(outputGapRepositoryConfig),
  researchOutput: createRepository(outputRepositoryConfig)
};

export { isFileRefOwnerType };

async function loadOwner(ownerType: FileRefOwnerType, ownerId: EntityId) {
  if (ownerType === "review") {
    return (await getPlanningFirstLayerData()).reviews.find((review) => review.id === ownerId);
  }
  const repository = repositories[ownerType];
  return (await repository.getById(ownerId)) ?? (await repository.getDeletedById(ownerId));
}

function defaultPolicyChannel(ownerType: FileRefOwnerType): ManuscriptChannel {
  return ownerType === "literature" ? "literature_outline" : "primary";
}

const validateBaseFileRefOwner: (
  ownerType: FileRefOwnerType | string,
  ownerId: EntityId,
  options?: { requireActive?: boolean }
) => Promise<FileRefOwnerContext> = createFileRefOwnerValidator(loadOwner);

async function readMountedLifecycleFacts(
  ownerType: FileRefOwnerType | string,
  ownerId: EntityId,
  manuscriptChannel?: ManuscriptChannel
): Promise<{
  context: FileRefOwnerContext;
  decision: MountedManuscriptLifecycleDecision;
}> {
  if (!isFileRefOwnerType(ownerType)) {
    await validateBaseFileRefOwner(ownerType, ownerId, { requireActive: false });
    throw new Error(`Unsupported FileRef owner type: ${ownerType}`);
  }

  const channel = assertValidManuscriptChannelForOwner(
    ownerType,
    manuscriptChannel ?? defaultPolicyChannel(ownerType)
  );
  if (ownerType === "experimentRun") {
    const access = await getControlledExperimentRunAccess(ownerId);
    // Run lifecycle authority needs only the Project identity/lifecycle. Review
    // structured composition is unrelated and remains required by Review-owned
    // callers through loadOwner("review", ...).
    const projectUnavailable = !(await getPlanningFirstLayerData()).projects.some(
      (project) => project.id === access.run.projectId && !project.deletedAt
    );
    return {
      context: { ownerType, ownerId, entity: access.run },
      decision: deriveMountedManuscriptLifecycleDecision({
        ownerType,
        ownerId,
        manuscriptChannel: channel,
        ownerDeleted: access.ownerDeleted,
        parentDeleted: access.parentDeleted,
        projectUnavailable
      })
    };
  }

  const context = await validateBaseFileRefOwner(ownerType, ownerId, { requireActive: false });
  return {
    context,
    decision: deriveMountedManuscriptLifecycleDecision({
      ownerType,
      ownerId,
      manuscriptChannel: channel,
      ownerDeleted: Boolean(context.entity.deletedAt)
    })
  };
}

export async function resolveMountedManuscriptLifecycleDecision(input: {
  ownerType: FileRefOwnerType;
  ownerId: EntityId;
  manuscriptChannel: ManuscriptChannel;
}): Promise<MountedManuscriptLifecycleDecision & { entity: FileRefOwnerContext["entity"] }> {
  const resolved = await readMountedLifecycleFacts(
    input.ownerType,
    input.ownerId,
    input.manuscriptChannel
  );
  return { ...resolved.decision, entity: resolved.context.entity };
}

export async function validateFileRefOwner(
  ownerType: FileRefOwnerType | string,
  ownerId: EntityId
): Promise<FileRefOwnerContext> {
  const resolved = await readMountedLifecycleFacts(ownerType, ownerId);
  if (resolved.decision.canWrite) {
    return resolved.context;
  }
  // Preserve the established DB/FileRef-facing error contracts after the shared
  // policy has made the capability decision.
  if (ownerType === "experimentRun") {
    await assertExperimentRunWritable(ownerId);
  }
  if (resolved.decision.ownerDeleted) {
    return validateBaseFileRefOwner(ownerType, ownerId);
  }
  throw new MountedManuscriptLifecycleDecisionError(resolved.decision);
}

export async function getReadableFileRefOwnerContext(
  ownerType: FileRefOwnerType | string,
  ownerId: EntityId
): Promise<FileRefOwnerContext & { readOnly: boolean; parentDeleted: boolean }> {
  const resolved = await readMountedLifecycleFacts(ownerType, ownerId);
  return {
    ...resolved.context,
    readOnly: !resolved.decision.canWrite,
    parentDeleted: Boolean(resolved.decision.parentDeleted)
  };
}
