import type {
  ConditionItem,
  ExperimentRating,
  ExperimentStatus,
  MethodStep,
  ResearchMaterial,
  ResearchVariable
} from "./experiment";
import { EXPERIMENT_OUTLINE_FIELD_KEYS } from "../services/manuscriptOutlineDescriptorRegistry";
export { EXPERIMENT_OUTLINE_FIELD_KEYS } from "../services/manuscriptOutlineDescriptorRegistry";

export const EXPERIMENT_OUTLINE_SCHEMA_ID =
  "labpod.experiment.outline.v1" as const;

export type ExperimentOutlineFieldKey =
  (typeof EXPERIMENT_OUTLINE_FIELD_KEYS)[number];

export type ExperimentOutlineReplacement =
  | {
      key: ExperimentOutlineFieldKey;
      action: "clear";
    }
  | {
      key: ExperimentOutlineFieldKey;
      action: "set";
      value: string;
    };

export interface ExperimentOutlineDiagnostic {
  code:
    | "heading-missing"
    | "heading-duplicated"
    | "field-empty"
    | "field-invalid"
    | "field-duplicated"
    | "field-unknown";
  fieldKey?: ExperimentOutlineFieldKey;
  sourceLabel?: string;
  line?: number;
}

export interface ExperimentOutlineReplacementResult {
  schemaId: typeof EXPERIMENT_OUTLINE_SCHEMA_ID;
  replacements: readonly ExperimentOutlineReplacement[];
  diagnostics: readonly ExperimentOutlineDiagnostic[];
}

export interface ExperimentOwnerProfileRelation {
  id: string;
  title: string;
}

export interface ExperimentOwnerProfileDto {
  ownerType: "experiment";
  id: string;
  title: string;
  project: ExperimentOwnerProfileRelation;
  route: ExperimentOwnerProfileRelation | null;
  task: ExperimentOwnerProfileRelation | null;
  status: ExperimentStatus;
  rating: ExperimentRating | null;
  tags: readonly string[];
  usableForPaper: boolean;
  usableForReport: boolean;
  usableForPatent: boolean;
  conditionItems: readonly Readonly<ConditionItem>[];
  methodSteps: readonly Readonly<MethodStep>[];
  variables: readonly Readonly<ResearchVariable>[];
  materials: readonly Readonly<ResearchMaterial>[];
  provenance: Readonly<{
    source: "database-selector";
    ownerUpdatedAt: string;
    relationshipSource: "planning-selector";
  }>;
  warnings: readonly string[];
}

export type ExperimentOwnerProfileReadResult =
  | {
      status: "success";
      profile: Readonly<ExperimentOwnerProfileDto>;
    }
  | {
      status: "error";
      code:
        | "EXPERIMENT_OWNER_PROFILE_NOT_FOUND"
        | "EXPERIMENT_OWNER_PROFILE_DELETED"
        | "EXPERIMENT_OWNER_PROFILE_PROJECT_MISSING";
    };

export interface ExperimentContextSummaryInput {
  profile: Readonly<ExperimentOwnerProfileDto>;
  occurredAt: string;
  operationLabel: string;
}

export interface ExperimentOwnerSwitchReplacementInput {
  ownerType: "experiment";
  ownerId: string;
  projectId: string;
  manuscriptChannel: "primary";
  bindingId: string;
  expectedBindingUpdatedAt: string;
  expectedCurrentFileRefId: string;
  expectedDefaultManuscriptFileRefId: string;
  expectedDefaultPathIdentity: string;
  targetFileRefId: string;
  targetPathIdentity: string;
  targetLocationMode: "managed" | "external";
  outlineReplacements: readonly ExperimentOutlineReplacement[];
  outlineDigest: string;
  oldCurrentPostRevision: string;
  targetPhysicalRevision: string;
  occurredAt: string;
  operationId: string;
  correlationId: string;
  audit: Readonly<{
    actorId: string;
    actorLabel: string;
    source: "user";
  }>;
}

export interface ExperimentOwnerSwitchPostVerify {
  ownerId: string;
  bindingId: string;
  previousCurrentFileRefId: string;
  currentFileRefId: string;
  defaultManuscriptFileRefId: string;
  operationLogId: string;
  ownerUpdatedAt: string;
  bindingUpdatedAt: string;
}

export type ExperimentOutlinePostVerifyValues = {
  [Key in ExperimentOutlineFieldKey]: string | null;
};

export interface ExperimentOwnerSwitchPostVerifyReadInput {
  ownerId: string;
  bindingId: string;
  targetFileRefId: string;
  operationId: string;
}

export interface ExperimentOwnerSwitchDirectReadback {
  databaseReadSource: "sqlite-direct-post-commit";
  ownerId: string;
  ownerFound: boolean;
  bindingId: string;
  bindingFound: boolean;
  currentFileRefId: string | null;
  defaultManuscriptFileRefId: string | null;
  outline: ExperimentOutlinePostVerifyValues;
  targetFileRefValid: boolean;
  operationLogId: string;
  operationLogStatus: string | null;
  operationLogRecoverable: boolean | null;
  operationLogPhase: string | null;
  ownerUpdatedAt: string | null;
  bindingUpdatedAt: string | null;
}
