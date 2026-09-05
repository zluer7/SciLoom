import type { EntityId, ISODateString } from "./common";
import type { FileRefRole } from "./experiment";
import type { ManuscriptChannel } from "./manuscriptChannel";
import type { OutputConversionEntityType } from "./outputConversion";
import type { ProvisionManagedOwnerResult } from "./provisioning";

export type OutputManuscriptOwnerType = OutputConversionEntityType;
export type OutputManuscriptEntityKind =
  | "result-item"
  | "finding"
  | "output-candidate"
  | "output-gap"
  | "research-output";
export type OutputManuscriptProvisioningPolicy = "automatic" | "lazy";

export interface OutputManuscriptStructuredFieldDescriptor {
  key: string;
  fieldKey: string;
  displayLabel: string;
  emptyValue: "";
  parseFromMarkdown(value: string): string;
  validate(value: unknown): value is string;
}

export interface OutputManuscriptBriefFieldDescriptor
  extends OutputManuscriptStructuredFieldDescriptor {
  entityField: "summary" | "description";
}

export interface OutputManuscriptStaticDescriptor {
  ownerType: OutputManuscriptOwnerType;
  channel: Extract<ManuscriptChannel, "primary">;
  sourceWindowRoles: readonly ["current", "independent"];
  fileRefRole: Extract<FileRefRole, "manuscript">;
  bindingScope: Extract<ManuscriptChannel, "primary">;
  saveAsManagedFilename:
    | "result-item.md"
    | "finding.md"
    | "output-candidate.md"
    | "output-gap.md"
    | "research-output.md";
  presentationLabel: string;
  ownerValidationKey: OutputManuscriptOwnerType;
  entityKind: OutputManuscriptEntityKind;
  collectionFolder: "outputs";
  defaultFilename:
    | "result-item.md"
    | "finding.md"
    | "output-candidate.md"
    | "output-gap.md"
    | "research-output.md";
  provisioningPolicy: OutputManuscriptProvisioningPolicy;
  defaultFolderRole: Extract<FileRefRole, "defaultFolder">;
  defaultManuscriptRole: Extract<FileRefRole, "manuscript">;
  briefField: OutputManuscriptBriefFieldDescriptor;
  structuredFields: readonly OutputManuscriptStructuredFieldDescriptor[];
}

export interface OutputManuscriptOwnerDescriptor extends OutputManuscriptStaticDescriptor {
  ownerId: EntityId;
  projectId: EntityId;
  createdAt: ISODateString;
  displayTitle: string;
  active: true;
  deletedAt: null;
  workspaceIdentityInput: {
    ownerType: OutputManuscriptOwnerType;
    ownerId: EntityId;
    ownerTitle: string;
    projectId: EntityId;
    createdAt: ISODateString;
    collectionFolder: "outputs";
  };
}

export type OutputManuscriptProvisioningCompletionState = "complete" | "partial" | "failed";

export interface OutputManuscriptProvisioningResult extends ProvisionManagedOwnerResult {
  completionState: OutputManuscriptProvisioningCompletionState;
  descriptor?: OutputManuscriptOwnerDescriptor;
}
