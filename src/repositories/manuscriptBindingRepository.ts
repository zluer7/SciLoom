import { invoke } from "@tauri-apps/api/core";
import type {
  BindingFileRefIdentityMetadata,
  EntityId,
  FileRefOwnerType,
  ManuscriptBinding,
  ManuscriptChannel,
  WriteManuscriptBindingInput,
  WriteManuscriptBindingRepositoryResult
} from "../types";
import { runMetadataAuthorityWrite } from "../services/metadataAuthorityWriterGuard";
import type { ValidatedPlanningAuthorityHandle } from "../services/planningOwnerAuthorityPort";

export interface ManuscriptBindingIdentityRecords {
  binding?: ManuscriptBinding;
  fileRefs: BindingFileRefIdentityMetadata[];
}

// This repository is deliberately narrow. Identity reads use a SQLite read-only
// connection and never pass through generic repository seeding or browser storage.
export function readIdentityRecords(
  ownerType: FileRefOwnerType,
  ownerId: EntityId,
  manuscriptChannel: ManuscriptChannel
) {
  return invoke<ManuscriptBindingIdentityRecords>("db_read_manuscript_binding_identity", {
    ownerType,
    ownerId,
    manuscriptChannel
  });
}

// All ordinary Binding writes use one transactional CAS command. Upper-level
// business transactions may keep their own atomic command, but must share the
// same identity validation and authoritative readback contract.
export function writeBinding(
  input: WriteManuscriptBindingInput,
  authorityPermit?: ValidatedPlanningAuthorityHandle
) {
  return runMetadataAuthorityWrite({
    domain: "binding",
    operation: "manuscript-binding-write",
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    scope: input.manuscriptChannel,
    permit: authorityPermit,
    write: () => invoke<WriteManuscriptBindingRepositoryResult>("db_write_manuscript_binding", {
      input
    })
  });
}

export function isFileRefReferencedByBinding(fileRefId: EntityId) {
  return invoke<boolean>("db_is_file_ref_referenced_by_binding", { fileRefId });
}

export const manuscriptBindingRepository = {
  readIdentityRecords,
  writeBinding,
  isFileRefReferencedByBinding
};
