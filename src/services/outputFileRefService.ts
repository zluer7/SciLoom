import type { EntityId } from "../types";
import type { CreateFileRefInput, CustomField, FileRef, UpdateFileRefInput } from "../types/experiment";
import type {
  CreateOutputFileRefMetadataInput,
  OutputFileRefMetadataResult,
  OutputFileRefOwnerType,
  RemoveOutputFileRefMetadataInput,
  UpdateOutputFileRefMetadataInput
} from "../types/outputFileRef";
import { fileRefService } from "./fileRefService";
import { validateFileRefOwner } from "./fileRefOwnerValidator";
import { manuscriptBindingService } from "./manuscriptBindingService";

const OUTPUT_FILE_REF_OWNER_TYPES: OutputFileRefOwnerType[] = [
  "resultItem",
  "finding",
  "outputCandidate",
  "outputGap",
  "researchOutput"
];

const REQUIRED_METADATA_ONLY_CONFIRMATION = { confirmedMetadataOnly: true } as const;

function isOutputFileRefOwnerType(value: string): value is OutputFileRefOwnerType {
  return OUTPUT_FILE_REF_OWNER_TYPES.includes(value as OutputFileRefOwnerType);
}

function metadataField(id: string, name: string, value: string | number): CustomField {
  return {
    id,
    name,
    value,
    valueType: typeof value === "number" ? "number" : "text",
    group: "fileMetadata"
  };
}

function mergeMetadataFields(
  customFields: CustomField[] | undefined,
  metadata: Pick<CreateOutputFileRefMetadataInput, "mimeType" | "sizeBytes">
) {
  const fields = [...(customFields ?? [])].filter(
    (field) => field.name !== "mimeType" && field.name !== "sizeBytes"
  );
  if (metadata.mimeType) {
    fields.push(metadataField("file-ref-mime-type", "mimeType", metadata.mimeType));
  }
  if (typeof metadata.sizeBytes === "number") {
    fields.push(metadataField("file-ref-size-bytes", "sizeBytes", metadata.sizeBytes));
  }
  return fields;
}

function resultFromFileRef(
  fileRef: FileRef | undefined,
  warnings: string[] = [],
  skipped: string[] = []
): OutputFileRefMetadataResult {
  const pathSummary = fileRef ? fileRefService.buildFileRefPathSummary(fileRef) : undefined;
  return {
    ok: Boolean(fileRef) && skipped.length === 0,
    metadataOnly: true,
    ownerType: fileRef?.ownerType as OutputFileRefOwnerType | undefined,
    ownerId: fileRef?.ownerId,
    fileRefId: fileRef?.id,
    pathSummary,
    warnings,
    skipped
  };
}

function skippedResult(warning: string, code: string): OutputFileRefMetadataResult {
  return {
    ok: false,
    metadataOnly: true,
    warnings: [warning],
    skipped: [code]
  };
}

export async function isProtectedOutputFileRef(fileRef: FileRef) {
  if (fileRef.fileRole === "defaultFolder" || fileRef.fileRole === "manuscript") {
    return true;
  }
  const binding = await manuscriptBindingService.getBindingByOwner(
    fileRef.ownerType,
    fileRef.ownerId,
    fileRef.manuscriptChannel
  );
  return Boolean(
    binding &&
      [
        binding.defaultFolderFileRefId,
        binding.defaultManuscriptFileRefId,
        binding.currentFileRefId
      ].includes(fileRef.id)
  );
}

function protectedFileRefResult() {
  return skippedResult(
    "Workspace and managed manuscript FileRefs can only be changed through the formal manuscript workflow.",
    "protected_manuscript_file_ref"
  );
}

function createInput(input: CreateOutputFileRefMetadataInput): CreateFileRefInput {
  return {
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    path: input.path,
    fileType: input.fileType ?? "other",
    title: input.title,
    description: input.description,
    source: input.source ?? "user",
    customFields: mergeMetadataFields(input.customFields, input)
  };
}

function updateInput(
  input: UpdateOutputFileRefMetadataInput,
  existing: FileRef
): UpdateFileRefInput {
  const nextFields =
    input.customFields || input.mimeType !== undefined || input.sizeBytes !== undefined
      ? mergeMetadataFields(input.customFields ?? existing.customFields, {
          mimeType: input.mimeType ?? undefined,
          sizeBytes: input.sizeBytes ?? undefined
        })
      : existing.customFields;
  return {
    fileType: input.fileType ?? existing.fileType,
    title: input.title ?? existing.title,
    description: input.description === null ? undefined : input.description ?? existing.description,
    source: input.source ?? existing.source,
    customFields: nextFields
  };
}

export async function listOutputFileRefPathSummaries(
  ownerType: OutputFileRefOwnerType,
  ownerId: EntityId
) {
  await validateFileRefOwner(ownerType, ownerId);
  const pathSummary = await fileRefService.getFileRefPathSummariesByOwner(ownerType, ownerId);
  return pathSummary;
}

export async function listOutputFileRefs(
  ownerType: OutputFileRefOwnerType,
  ownerId: EntityId
) {
  await validateFileRefOwner(ownerType, ownerId);
  return (await fileRefService.getFileRefsByOwner(ownerType, ownerId)).filter(
    (fileRef) => !fileRef.deletedAt
  );
}

export async function addOutputFileRefMetadata(
  input: CreateOutputFileRefMetadataInput
): Promise<OutputFileRefMetadataResult> {
  if (!input.path.trim()) {
    return skippedResult("Output FileRef metadata requires a non-empty path.", "empty_path");
  }
  await validateFileRefOwner(input.ownerType, input.ownerId);
  const { fileRef } = await fileRefService.registerFileRef(createInput(input));
  const pathSummary = fileRefService.buildFileRefPathSummary(fileRef);
  return {
    ...resultFromFileRef(fileRef),
    pathSummary,
    warnings: ["Only the SciLoom path record was created; file body was not read or uploaded."]
  };
}

export async function updateOutputFileRefMetadata(
  input: UpdateOutputFileRefMetadataInput
): Promise<OutputFileRefMetadataResult> {
  const existing = await fileRefService.getById(input.fileRefId);
  if (!existing) {
    return skippedResult(`Output FileRef metadata not found: ${input.fileRefId}.`, "file_ref_not_found");
  }
  if (!isOutputFileRefOwnerType(existing.ownerType)) {
    return skippedResult(
      `FileRef ${input.fileRefId} is not owned by an output five-layer entity.`,
      "not_output_file_ref_owner"
    );
  }
  if (await isProtectedOutputFileRef(existing)) {
    return protectedFileRefResult();
  }
  const nextOwnerType = input.ownerType ?? existing.ownerType;
  const nextOwnerId = input.ownerId ?? existing.ownerId;
  if (
    nextOwnerType !== existing.ownerType ||
    nextOwnerId !== existing.ownerId ||
    (input.path !== undefined && input.path !== existing.path)
  ) {
    return skippedResult(
      "FileRef identity fields cannot be changed by ordinary metadata update.",
      "FILE_REF_IDENTITY_FIELD_IMMUTABLE"
    );
  }
  await validateFileRefOwner(nextOwnerType, nextOwnerId);
  const updated = await fileRefService.updateFileRef(input.fileRefId, updateInput(input, existing));
  const pathSummary = updated ? fileRefService.buildFileRefPathSummary(updated) : undefined;
  return {
    ...resultFromFileRef(
      updated,
      ["Only the SciLoom path record was updated; file body was not read or uploaded."],
      updated ? [] : ["file_ref_update_failed"]
    ),
    pathSummary
  };
}

export async function removeOutputFileRefMetadata(
  input: RemoveOutputFileRefMetadataInput
): Promise<OutputFileRefMetadataResult> {
  if (input.confirmedMetadataOnly !== REQUIRED_METADATA_ONLY_CONFIRMATION.confirmedMetadataOnly) {
    return skippedResult(
      "Removing Output FileRef metadata requires explicit metadata-only confirmation.",
      "metadata_only_confirmation_required"
    );
  }
  const existing = await fileRefService.getById(input.fileRefId);
  if (!existing) {
    return skippedResult(`Output FileRef metadata not found: ${input.fileRefId}.`, "file_ref_not_found");
  }
  if (!isOutputFileRefOwnerType(existing.ownerType)) {
    return skippedResult(
      `FileRef ${input.fileRefId} is not owned by an output five-layer entity.`,
      "not_output_file_ref_owner"
    );
  }
  if (await isProtectedOutputFileRef(existing)) {
    return protectedFileRefResult();
  }
  const pathSummary = fileRefService.buildFileRefPathSummary(existing);
  const feedback = await fileRefService.deleteFileRefWithAudit({
    id: existing.id,
    title: existing.title,
    summary: `Output path metadata for ${existing.ownerType}/${existing.ownerId} was soft-deleted. The local file was not touched.`,
    relatedEntities: [
      {
        type: existing.ownerType,
        id: existing.ownerId,
        relation: "linked",
        label: existing.title
      }
    ]
  });
  const removed = feedback.status === "success" && feedback.data === true;
  return {
    ok: removed,
    metadataOnly: true,
    ownerType: existing.ownerType,
    ownerId: existing.ownerId,
    fileRefId: existing.id,
    pathSummary,
    warnings: ["Only the SciLoom path record was removed; local files were not read, moved, uploaded, or deleted."],
    skipped: removed ? [] : ["file_ref_remove_failed"]
  };
}

export const outputFileRefService = {
  listOutputFileRefs,
  listOutputFileRefPathSummaries,
  addOutputFileRefMetadata,
  updateOutputFileRefMetadata,
  removeOutputFileRefMetadata
};

export type OutputFileRefService = typeof outputFileRefService;
