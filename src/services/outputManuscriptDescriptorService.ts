import type {
  Finding,
  OutputCandidate,
  OutputGap,
  OutputManuscriptOwnerDescriptor,
  OutputManuscriptOwnerType,
  OutputManuscriptStaticDescriptor,
  ResearchOutput,
  ResultItem
} from "../types";
import type { EntityId } from "../types/common";
import type { ManuscriptChannel } from "../types/manuscriptChannel";
import { getOutputOutlineDescriptor } from "./manuscriptOutlineDescriptorRegistry";

export const OUTPUT_MANUSCRIPT_ERROR_CODES = Object.freeze({
  ownerUnsupported: "OUTPUT_MANUSCRIPT_OWNER_UNSUPPORTED",
  channelInvalid: "OUTPUT_MANUSCRIPT_CHANNEL_INVALID",
  ownerNotFound: "OUTPUT_MANUSCRIPT_OWNER_NOT_FOUND",
  ownerDeleted: "OUTPUT_MANUSCRIPT_OWNER_DELETED",
  projectMissing: "OUTPUT_MANUSCRIPT_PROJECT_MISSING",
  projectNotFound: "OUTPUT_MANUSCRIPT_PROJECT_NOT_FOUND",
  projectInactive: "OUTPUT_MANUSCRIPT_PROJECT_INACTIVE",
  createdAtInvalid: "OUTPUT_MANUSCRIPT_CREATED_AT_INVALID"
} as const);

export type OutputManuscriptErrorCode =
  (typeof OUTPUT_MANUSCRIPT_ERROR_CODES)[keyof typeof OUTPUT_MANUSCRIPT_ERROR_CODES];

export class OutputManuscriptContractError extends Error {
  readonly code: OutputManuscriptErrorCode;

  constructor(code: OutputManuscriptErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "OutputManuscriptContractError";
    this.code = code;
  }
}

export const OUTPUT_MANUSCRIPT_OWNER_TYPES = Object.freeze([
  "resultItem",
  "finding",
  "outputCandidate",
  "outputGap",
  "researchOutput"
] as const satisfies readonly OutputManuscriptOwnerType[]);

function textField(ownerType: OutputManuscriptOwnerType, key: string, displayLabel: string) {
  return Object.freeze({
    key,
    fieldKey: `${ownerType}.outline.${key}`,
    displayLabel,
    emptyValue: "" as const,
    parseFromMarkdown: (value: string) => value.trim() === "未填写" ? "" : value.trim(),
    validate: (value: unknown): value is string => typeof value === "string"
  });
}

function briefField(
  ownerType: OutputManuscriptOwnerType,
  entityField: "summary" | "description"
) {
  return Object.freeze({
    key: entityField,
    fieldKey: `${ownerType}.meta.${entityField}`,
    displayLabel: "简要说明",
    entityField,
    emptyValue: "" as const,
    parseFromMarkdown: (value: string) => value.trim() === "未填写" ? "" : value.trim(),
    validate: (value: unknown): value is string => typeof value === "string"
  });
}

function outputFields(ownerType: OutputManuscriptOwnerType) {
  return Object.freeze(getOutputOutlineDescriptor(ownerType).fields.map((item) =>
    textField(ownerType, item.stableKey, item.displayLabel)
  ));
}

const RESULT_ITEM_FIELDS = outputFields("resultItem");
const FINDING_FIELDS = outputFields("finding");
const OUTPUT_CANDIDATE_FIELDS = outputFields("outputCandidate");
const OUTPUT_GAP_FIELDS = outputFields("outputGap");
const RESEARCH_OUTPUT_FIELDS = outputFields("researchOutput");

export const OUTPUT_MANUSCRIPT_DESCRIPTOR_REGISTRY = Object.freeze({
  resultItem: Object.freeze({
    ownerType: "resultItem",
    channel: "primary",
    sourceWindowRoles: Object.freeze(["current", "independent"] as const),
    fileRefRole: "manuscript",
    bindingScope: "primary",
    saveAsManagedFilename: "result-item.md",
    presentationLabel: "结果资产文稿副本",
    ownerValidationKey: "resultItem",
    entityKind: "result-item",
    collectionFolder: "outputs",
    defaultFilename: "result-item.md",
    provisioningPolicy: "automatic",
    defaultFolderRole: "defaultFolder",
    defaultManuscriptRole: "manuscript",
    briefField: briefField("resultItem", "summary"),
    structuredFields: RESULT_ITEM_FIELDS
  }),
  finding: Object.freeze({
    ownerType: "finding",
    channel: "primary",
    sourceWindowRoles: Object.freeze(["current", "independent"] as const),
    fileRefRole: "manuscript",
    bindingScope: "primary",
    saveAsManagedFilename: "finding.md",
    presentationLabel: "关键发现文稿副本",
    ownerValidationKey: "finding",
    entityKind: "finding",
    collectionFolder: "outputs",
    defaultFilename: "finding.md",
    provisioningPolicy: "automatic",
    defaultFolderRole: "defaultFolder",
    defaultManuscriptRole: "manuscript",
    briefField: briefField("finding", "summary"),
    structuredFields: FINDING_FIELDS
  }),
  outputCandidate: Object.freeze({
    ownerType: "outputCandidate",
    channel: "primary",
    sourceWindowRoles: Object.freeze(["current", "independent"] as const),
    fileRefRole: "manuscript",
    bindingScope: "primary",
    saveAsManagedFilename: "output-candidate.md",
    presentationLabel: "候选成果文稿副本",
    ownerValidationKey: "outputCandidate",
    entityKind: "output-candidate",
    collectionFolder: "outputs",
    defaultFilename: "output-candidate.md",
    provisioningPolicy: "automatic",
    defaultFolderRole: "defaultFolder",
    defaultManuscriptRole: "manuscript",
    briefField: briefField("outputCandidate", "description"),
    structuredFields: OUTPUT_CANDIDATE_FIELDS
  }),
  outputGap: Object.freeze({
    ownerType: "outputGap",
    channel: "primary",
    sourceWindowRoles: Object.freeze(["current", "independent"] as const),
    fileRefRole: "manuscript",
    bindingScope: "primary",
    saveAsManagedFilename: "output-gap.md",
    presentationLabel: "成果缺口文稿副本",
    ownerValidationKey: "outputGap",
    entityKind: "output-gap",
    collectionFolder: "outputs",
    defaultFilename: "output-gap.md",
    provisioningPolicy: "automatic",
    defaultFolderRole: "defaultFolder",
    defaultManuscriptRole: "manuscript",
    briefField: briefField("outputGap", "description"),
    structuredFields: OUTPUT_GAP_FIELDS
  }),
  researchOutput: Object.freeze({
    ownerType: "researchOutput",
    channel: "primary",
    sourceWindowRoles: Object.freeze(["current", "independent"] as const),
    fileRefRole: "manuscript",
    bindingScope: "primary",
    saveAsManagedFilename: "research-output.md",
    presentationLabel: "正式成果文稿副本",
    ownerValidationKey: "researchOutput",
    entityKind: "research-output",
    collectionFolder: "outputs",
    defaultFilename: "research-output.md",
    provisioningPolicy: "automatic",
    defaultFolderRole: "defaultFolder",
    defaultManuscriptRole: "manuscript",
    briefField: briefField("researchOutput", "description"),
    structuredFields: RESEARCH_OUTPUT_FIELDS
  })
} satisfies Record<OutputManuscriptOwnerType, OutputManuscriptStaticDescriptor>);

export type OutputManuscriptOwnerEntity =
  | ResultItem
  | Finding
  | OutputCandidate
  | OutputGap
  | ResearchOutput;

export function isOutputManuscriptOwnerType(value: string): value is OutputManuscriptOwnerType {
  return OUTPUT_MANUSCRIPT_OWNER_TYPES.includes(value as OutputManuscriptOwnerType);
}

export function getOutputManuscriptStaticDescriptor(
  ownerType: OutputManuscriptOwnerType | string
): OutputManuscriptStaticDescriptor {
  if (!isOutputManuscriptOwnerType(ownerType)) {
    throw new OutputManuscriptContractError(
      OUTPUT_MANUSCRIPT_ERROR_CODES.ownerUnsupported,
      `Unsupported Outputs manuscript ownerType: ${ownerType}.`
    );
  }
  return OUTPUT_MANUSCRIPT_DESCRIPTOR_REGISTRY[ownerType];
}

export function assertOutputManuscriptChannel(
  ownerType: OutputManuscriptOwnerType | string,
  channel: ManuscriptChannel | undefined
): "primary" {
  getOutputManuscriptStaticDescriptor(ownerType);
  if (channel !== "primary") {
    throw new OutputManuscriptContractError(
      OUTPUT_MANUSCRIPT_ERROR_CODES.channelInvalid,
      `${ownerType} manuscript operations must explicitly use primary.`
    );
  }
  return channel;
}

function displayTitle(ownerType: OutputManuscriptOwnerType, entity: OutputManuscriptOwnerEntity) {
  const value = ownerType === "researchOutput"
    ? (entity as ResearchOutput).outputName
    : (entity as Exclude<OutputManuscriptOwnerEntity, ResearchOutput>).title;
  return String(value ?? "").trim() || `${ownerType}-${entity.id}`;
}

export function buildOutputWorkspaceLocalDate(createdAt: string) {
  const value = String(createdAt ?? "").trim();
  const dateOnly = value.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) {
    throw new OutputManuscriptContractError(
      OUTPUT_MANUSCRIPT_ERROR_CODES.createdAtInvalid,
      `Outputs manuscript owner has invalid createdAt: ${value || "<empty>"}.`
    );
  }
  if (dateOnly) {
    const canonical = `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`;
    if (new Date(`${canonical}T00:00:00.000Z`).toISOString().slice(0, 10) !== canonical) {
      throw new OutputManuscriptContractError(
        OUTPUT_MANUSCRIPT_ERROR_CODES.createdAtInvalid,
        `Outputs manuscript owner has invalid createdAt: ${value}.`
      );
    }
    return canonical;
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function buildOutputManuscriptOwnerDescriptor(
  ownerType: OutputManuscriptOwnerType | string,
  ownerId: EntityId,
  channel: ManuscriptChannel | undefined,
  entity: OutputManuscriptOwnerEntity | undefined
): OutputManuscriptOwnerDescriptor {
  const staticDescriptor = getOutputManuscriptStaticDescriptor(ownerType);
  assertOutputManuscriptChannel(ownerType, channel);
  if (!entity || entity.id !== ownerId) {
    throw new OutputManuscriptContractError(
      OUTPUT_MANUSCRIPT_ERROR_CODES.ownerNotFound,
      `Outputs manuscript owner not found: ${ownerType}/${ownerId}.`
    );
  }
  if (entity.deletedAt) {
    throw new OutputManuscriptContractError(
      OUTPUT_MANUSCRIPT_ERROR_CODES.ownerDeleted,
      `Outputs manuscript owner is deleted: ${ownerType}/${ownerId}.`
    );
  }
  const projectId = String(entity.projectId ?? "").trim();
  if (!projectId) {
    throw new OutputManuscriptContractError(
      OUTPUT_MANUSCRIPT_ERROR_CODES.projectMissing,
      `Outputs manuscript owner has no direct projectId: ${ownerType}/${ownerId}.`
    );
  }
  const title = displayTitle(staticDescriptor.ownerType, entity);
  buildOutputWorkspaceLocalDate(entity.createdAt);
  return {
    ...staticDescriptor,
    ownerId: entity.id,
    projectId,
    createdAt: entity.createdAt,
    displayTitle: title,
    active: true,
    deletedAt: null,
    workspaceIdentityInput: {
      ownerType: staticDescriptor.ownerType,
      ownerId: entity.id,
      ownerTitle: title,
      projectId,
      createdAt: entity.createdAt,
      collectionFolder: "outputs"
    }
  };
}
