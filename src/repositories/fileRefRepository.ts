import type { EntityId, FileRef } from "../types";
import type { CreateEntityInput, UpdateEntityInput } from "../types/common";
import { FileRefContractError, FILE_REF_CONTRACT_ERROR_CODES } from "../services/fileRefIdentity";
import { fileRefRepositoryConfig } from "./entityConfig";
import { isFileRefReferencedByBinding } from "./manuscriptBindingRepository";
import { createRepository } from "./repositoryFactory";
import { runMetadataAuthorityWrite } from "../services/metadataAuthorityWriterGuard";
import type { ValidatedPlanningAuthorityHandle } from "../services/planningOwnerAuthorityPort";

const repository = createRepository<FileRef>(fileRefRepositoryConfig);

async function assertNotReferenced(id: EntityId) {
  if (await isFileRefReferencedByBinding(id)) {
    throw new FileRefContractError(
      FILE_REF_CONTRACT_ERROR_CODES.inUseByBinding,
      `FileRef ${id} is referenced by a manuscript binding.`
    );
  }
}

export const fileRefRepository = {
  list: repository.list,
  getById: repository.getById,
  listDeleted: repository.listDeleted,
  getDeletedById: repository.getDeletedById,
  isReferencedByBinding: isFileRefReferencedByBinding,
  create(
    input: CreateEntityInput<FileRef>,
    options?: Parameters<typeof repository.create>[1],
    authorityPermit?: ValidatedPlanningAuthorityHandle
  ) {
    return runMetadataAuthorityWrite({
      domain: "fileRef",
      operation: "file-ref-create",
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      scope: input.manuscriptChannel ?? "primary",
      permit: authorityPermit,
      write: () => repository.create(input, options)
    });
  },
  async update(
    id: EntityId,
    input: UpdateEntityInput<FileRef>,
    authorityPermit?: ValidatedPlanningAuthorityHandle
  ) {
    const existing = await repository.getById(id);
    if (!existing) return undefined;
    for (const field of [
      "ownerType",
      "ownerId",
      "manuscriptChannel",
      "resourceKind",
      "fileRole",
      "locationMode",
      "path",
      "pathIdentityKey"
    ] as const) {
      if (input[field] !== undefined && input[field] !== existing[field]) {
        throw new FileRefContractError(
          FILE_REF_CONTRACT_ERROR_CODES.identityFieldImmutable,
          `FileRef identity field cannot be changed by repository update: ${field}.`
        );
      }
    }
    return runMetadataAuthorityWrite({
      domain: "fileRef",
      operation: "file-ref-update",
      ownerType: existing.ownerType,
      ownerId: existing.ownerId,
      scope: existing.manuscriptChannel ?? "primary",
      permit: authorityPermit,
      write: () => repository.update(id, input)
    });
  },
  async softDelete(id: EntityId, authorityPermit?: ValidatedPlanningAuthorityHandle) {
    const existing = await repository.getById(id);
    if (!existing) return false;
    return runMetadataAuthorityWrite({
      domain: "fileRef",
      operation: "file-ref-soft-delete",
      ownerType: existing.ownerType,
      ownerId: existing.ownerId,
      scope: existing.manuscriptChannel ?? "primary",
      permit: authorityPermit,
      write: async () => {
        await assertNotReferenced(id);
        return repository.softDelete(id);
      }
    });
  },
  async restore(id: EntityId, authorityPermit?: ValidatedPlanningAuthorityHandle) {
    const existing = await repository.getDeletedById(id);
    if (!existing) return undefined;
    return runMetadataAuthorityWrite({
      domain: "fileRef",
      operation: "file-ref-restore",
      ownerType: existing.ownerType,
      ownerId: existing.ownerId,
      scope: existing.manuscriptChannel ?? "primary",
      permit: authorityPermit,
      write: () => repository.restore(id)
    });
  },
  async hardDelete(id: EntityId, authorityPermit?: ValidatedPlanningAuthorityHandle) {
    const existing = (await repository.getById(id)) ?? (await repository.getDeletedById(id));
    if (!existing) return false;
    return runMetadataAuthorityWrite({
      domain: "fileRef",
      operation: "file-ref-hard-delete",
      ownerType: existing.ownerType,
      ownerId: existing.ownerId,
      scope: existing.manuscriptChannel ?? "primary",
      permit: authorityPermit,
      write: async () => {
        await assertNotReferenced(id);
        return repository.hardDelete(id);
      }
    });
  },
  remove(id: EntityId, authorityPermit?: ValidatedPlanningAuthorityHandle) {
    return this.softDelete(id, authorityPermit);
  }
};
