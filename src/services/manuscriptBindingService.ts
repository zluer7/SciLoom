import { createRepositoryEntityId } from "../repositories/entityId";
import {
  manuscriptBindingRepository,
  isFileRefReferencedByBinding
} from "../repositories/manuscriptBindingRepository";
import type {
  EntityId,
  ExpectedManuscriptBindingState,
  FileRefOwnerType,
  ManuscriptBinding,
  ManuscriptBindingIdentityResult,
  ManuscriptBindingWriteOperation,
  ManuscriptChannel,
  WriteFeedbackResult
} from "../types";
import { MANUSCRIPT_BINDING_IDENTITY_ERROR_CODES } from "../types";
import {
  createErrorWriteFeedback,
  createSkippedWriteFeedback,
  createSuccessWriteFeedback,
  toWriteFeedbackMessage
} from "./writeFeedbackService";
import { validateFileRefOwner } from "./fileRefOwnerValidator";
import { assertValidManuscriptChannelForOwner } from "../types/manuscriptChannel";
import {
  manuscriptBindingIdentityResolver,
  type ResolveManuscriptBindingIdentityInput
} from "./manuscriptBindingIdentityResolver";
import type { ValidatedPlanningAuthorityHandle } from "./planningOwnerAuthorityPort";

export interface WriteManuscriptBindingServiceInput {
  operation: ManuscriptBindingWriteOperation;
  ownerType: FileRefOwnerType;
  ownerId: EntityId;
  manuscriptChannel?: ManuscriptChannel;
  fileRefId?: EntityId;
  defaultFolderFileRefId?: EntityId;
  defaultManuscriptFileRefId?: EntityId;
  expected?: ExpectedManuscriptBindingState;
}

export interface ManuscriptBindingWriteFeedback extends WriteFeedbackResult<ManuscriptBinding> {
  identity?: ManuscriptBindingIdentityResult;
  changed?: boolean;
}

function stableCode(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.match(/[A-Z][A-Z0-9_]{4,}/u)?.[0] ?? "MANUSCRIPT_BINDING_WRITE_FAILED";
}

function feedbackError<T>(operation: string, error: unknown): WriteFeedbackResult<T> {
  const message = error instanceof Error ? error.message : String(error);
  const code = stableCode(error);
  return createErrorWriteFeedback<T>({
    operation,
    errors: [message],
    messages: [toWriteFeedbackMessage(message, "error", code)]
  });
}

function expectedStateFromBinding(
  binding: ManuscriptBinding | undefined
): ExpectedManuscriptBindingState {
  return binding
    ? {
        exists: true,
        updatedAt: binding.updatedAt,
        defaultFolderFileRefId: binding.defaultFolderFileRefId ?? null,
        defaultManuscriptFileRefId: binding.defaultManuscriptFileRefId ?? null,
        currentFileRefId: binding.currentFileRefId ?? null
      }
    : {
        exists: false,
        defaultFolderFileRefId: null,
        defaultManuscriptFileRefId: null,
        currentFileRefId: null
      };
}

export function resolveIdentity(input: ResolveManuscriptBindingIdentityInput) {
  return manuscriptBindingIdentityResolver.resolve(input);
}

// Narrow compatibility-free projection for business code that only needs the
// persisted row. It still goes through the single authoritative resolver and
// never performs get-or-create or fallback.
export async function getBindingByOwner(
  ownerType: FileRefOwnerType,
  ownerId: EntityId,
  manuscriptChannel?: ManuscriptChannel
) {
  const result = await resolveIdentity({ ownerType, ownerId, manuscriptChannel });
  if (result.status === "error") {
    throw new Error(result.errors.join(","));
  }
  return result.binding;
}

async function authoritativeReadback(
  input: WriteManuscriptBindingServiceInput,
  repositoryBinding: ManuscriptBinding | undefined
) {
  const identity = await resolveIdentity({
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    manuscriptChannel: input.manuscriptChannel
  });
  if (identity.status === "error") {
    throw new Error(MANUSCRIPT_BINDING_IDENTITY_ERROR_CODES.readbackFailure);
  }
  if (input.operation === "remove") {
    if (identity.status !== "not-found") {
      throw new Error(MANUSCRIPT_BINDING_IDENTITY_ERROR_CODES.readbackFailure);
    }
    return identity;
  }
  if (!identity.binding || !repositoryBinding || identity.binding.id !== repositoryBinding.id) {
    throw new Error(MANUSCRIPT_BINDING_IDENTITY_ERROR_CODES.readbackFailure);
  }
  if (identity.binding.updatedAt !== repositoryBinding.updatedAt) {
    throw new Error(MANUSCRIPT_BINDING_IDENTITY_ERROR_CODES.readbackFailure);
  }
  return identity;
}

async function writeManuscriptBinding(
  input: WriteManuscriptBindingServiceInput,
  authorityPermit?: ValidatedPlanningAuthorityHandle
): Promise<ManuscriptBindingWriteFeedback> {
  const operation = `manuscriptBinding.${input.operation}`;
  try {
    const manuscriptChannel = assertValidManuscriptChannelForOwner(
      input.ownerType,
      input.manuscriptChannel
    );
    await validateFileRefOwner(input.ownerType, input.ownerId);
    const before = await resolveIdentity({
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      manuscriptChannel
    });
    if (before.status === "error") {
      throw new Error(before.errors.join(","));
    }
    const expected = input.expected ?? expectedStateFromBinding(before.binding);
    const repositoryResult = await manuscriptBindingRepository.writeBinding({
      operation: input.operation,
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      manuscriptChannel,
      bindingId: before.binding?.id ?? createRepositoryEntityId("manuscript-binding"),
      fileRefId: input.fileRefId,
      defaultFolderFileRefId: input.defaultFolderFileRefId,
      defaultManuscriptFileRefId: input.defaultManuscriptFileRefId,
      expected,
      occurredAt: new Date().toISOString()
    }, authorityPermit);
    const identity = await authoritativeReadback(input, repositoryResult.binding);
    if (input.operation === "remove") {
      const base = repositoryResult.changed
        ? createSuccessWriteFeedback<ManuscriptBinding>({
            operation,
            refreshKeys: ["fileRef.changed"]
          })
        : createSkippedWriteFeedback<ManuscriptBinding>({
            operation,
            skipped: ["manuscript_binding_not_found"]
          });
      return { ...base, identity, changed: repositoryResult.changed };
    }
    const binding = identity.binding!;
    const common = {
      operation,
      data: binding,
      affectedEntities: [{
        type: input.ownerType,
        id: input.ownerId,
        relation: repositoryResult.changed ? "updated" : "reused"
      }],
      refreshKeys: ["fileRef.changed" as const]
    };
    const base = repositoryResult.changed
      ? createSuccessWriteFeedback(common)
      : createSkippedWriteFeedback({
          ...common,
          skipped: ["manuscript_binding_unchanged"]
        });
    return { ...base, identity, changed: repositoryResult.changed };
  } catch (error) {
    return feedbackError<ManuscriptBinding>(operation, error);
  }
}

export async function setCurrentManuscript(
  ownerType: FileRefOwnerType,
  ownerId: EntityId,
  fileRefId: EntityId,
  manuscriptChannel?: ManuscriptChannel,
  expectedCurrentFileRefId?: EntityId | null,
  authorityPermit?: ValidatedPlanningAuthorityHandle
) {
  let expected: ExpectedManuscriptBindingState | undefined;
  if (expectedCurrentFileRefId !== undefined) {
    const before = await resolveIdentity({ ownerType, ownerId, manuscriptChannel });
    if (!before.binding || (before.binding.currentFileRefId ?? null) !== expectedCurrentFileRefId) {
      return feedbackError<ManuscriptBinding>(
        "manuscriptBinding.setCurrent",
        new Error(MANUSCRIPT_BINDING_IDENTITY_ERROR_CODES.staleExpectedState)
      );
    }
    expected = expectedStateFromBinding(before.binding);
  }
  return writeManuscriptBinding({
    operation: "setCurrent",
    ownerType,
    ownerId,
    manuscriptChannel,
    fileRefId,
    expected
  }, authorityPermit);
}

export function upsertProvisionedDefaults(
  ownerType: FileRefOwnerType,
  ownerId: EntityId,
  defaultFolderFileRefId: EntityId,
  defaultManuscriptFileRefId: EntityId,
  manuscriptChannel?: ManuscriptChannel,
  authorityPermit?: ValidatedPlanningAuthorityHandle
) {
  return writeManuscriptBinding({
    operation: "upsertDefaults",
    ownerType,
    ownerId,
    manuscriptChannel,
    defaultFolderFileRefId,
    defaultManuscriptFileRefId
  }, authorityPermit);
}

export async function validateBinding(binding: ManuscriptBinding) {
  await validateFileRefOwner(binding.ownerType, binding.ownerId);
  const identity = await resolveIdentity({
    ownerType: binding.ownerType,
    ownerId: binding.ownerId,
    manuscriptChannel: binding.manuscriptChannel
  });
  if (!identity.identityResolved || identity.binding.id !== binding.id) {
    throw new Error(identity.errors.join(",") || "MANUSCRIPT_BINDING_VALIDATION_FAILED");
  }
  return true;
}

export async function removeBindingByOwner(
  ownerType: FileRefOwnerType,
  ownerId: EntityId,
  manuscriptChannel: ManuscriptChannel,
  authorityPermit?: ValidatedPlanningAuthorityHandle
) {
  const result = await writeManuscriptBinding({
    operation: "remove",
    ownerType,
    ownerId,
    manuscriptChannel
  }, authorityPermit);
  if (result.status === "error") {
    return result as unknown as WriteFeedbackResult<boolean>;
  }
  return {
    ...result,
    data: result.changed
  } as WriteFeedbackResult<boolean>;
}

export { isFileRefReferencedByBinding };

export const manuscriptBindingService = {
  resolveIdentity,
  getBindingByOwner,
  setCurrentManuscript,
  upsertProvisionedDefaults,
  validateBinding,
  removeBindingByOwner,
  isFileRefReferencedByBinding
};
