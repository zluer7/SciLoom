export const FORMAL_SWITCH_OWNER_TYPES = [
  "experiment",
  "experimentRun",
  "literature",
  "review",
  "resultItem",
  "finding",
  "outputCandidate",
  "outputGap",
  "researchOutput"
] as const;

export const FORMAL_SWITCH_REVIEW_TYPES = [
  "stage",
  "periodic",
  "experiment_comparison",
  "literature_comparison",
  "custom"
] as const;

export type FormalSwitchOwnerType = (typeof FORMAL_SWITCH_OWNER_TYPES)[number];
export type FormalSwitchReviewType = (typeof FORMAL_SWITCH_REVIEW_TYPES)[number];
export type FormalSwitchChannel = "primary" | "literature_outline" | "dedicated_notes";
export type FormalSwitchEntryKind = "USER_CONFIRMED_SWITCH" | "REPAIR_CONFIRMED_SWITCH";

export type FormalSwitchTypedIdentityV1 =
  | {
      readonly ownerType: "literature";
      readonly manuscriptChannel: "literature_outline" | "dedicated_notes";
      readonly ownerSubtype?: never;
    }
  | {
      readonly ownerType: "review";
      readonly manuscriptChannel: "primary";
      readonly ownerSubtype: FormalSwitchReviewType;
    }
  | {
      readonly ownerType: Exclude<FormalSwitchOwnerType, "literature" | "review">;
      readonly manuscriptChannel: "primary";
      readonly ownerSubtype?: never;
    };

export interface FormalSwitchCandidateIdentityV1 {
  readonly fileRefIdentity: string;
  readonly physicalRevision: string;
  readonly sha256: Uint8Array;
  readonly byteLength: bigint;
  readonly encoding: string;
}

export interface FormalSwitchReplacementItemV1 {
  readonly stableKey: string;
  readonly value: string | null;
}

export interface FormalSwitchSettlementPlanV1 {
  readonly byteStart: bigint;
  readonly byteEnd: bigint;
  readonly expectedWholeFileHash: Uint8Array;
  readonly expectedControlledRegionPreimageHash: Uint8Array;
  readonly replacementBytes: Uint8Array;
  readonly expectedWholeFilePostHash: Uint8Array;
  readonly bomState: "ABSENT" | "UTF8_BOM";
  readonly lineEndingPolicy: "PRESERVE_SNAPSHOT_EXACT";
  readonly boundaryNewlineOwnership: "NONE" | "LEADING" | "TRAILING" | "BOTH";
  readonly writeOnceOperationId: string;
}

interface FormalSwitchImmutableEnvelopePayloadV1 {
  readonly operationId: string;
  readonly payloadVersion: 1n;
  readonly canonicalEncodingVersion: "CanonicalEnvelopeEncodingV1";
  readonly engineContractVersion: 1n;
  readonly descriptorIdentity: string;
  readonly descriptorVersion: bigint;
  readonly descriptorHash: Uint8Array;
  readonly candidateContractVersion: 1n;
  readonly settlementPlanVersion: 1n;
  readonly transactionPayloadVersion: 1n;
  readonly recoveryPayloadVersion: 1n;
  readonly ownerId: string;
  readonly entryKind: FormalSwitchEntryKind;
  readonly oldCurrentFileRefIdentity: string;
  readonly defaultFileRefIdentity: string;
  readonly targetFileRefIdentity: string;
  readonly oldCurrentLogicalSessionIdentity: string;
  readonly targetLogicalSessionIdentity: string;
  readonly candidate: FormalSwitchCandidateIdentityV1;
  readonly replacementDto: readonly FormalSwitchReplacementItemV1[];
  readonly ownerProtectedRowDigest: Uint8Array;
  readonly bindingDigest: Uint8Array;
  readonly lifecycleCoverageDigest: Uint8Array;
  readonly oldCurrentExpectedPhysicalRevision: string;
  readonly settlementPlan: FormalSwitchSettlementPlanV1;
  readonly transactionPayload: Uint8Array;
  readonly successOperationLogId: string;
  readonly formalSwitchOperationId: string;
  readonly activationLogicalIdentity: string;
  readonly finalizationIdentity: string;
  readonly operationCustodyIdentity: string;
  readonly createdAtEpochMs: bigint;
}

export type FormalSwitchImmutableEnvelopeV1 =
  FormalSwitchImmutableEnvelopePayloadV1 & FormalSwitchTypedIdentityV1;

export type FormalSwitchPhase =
  | "prepared"
  | "settlement_started"
  | "settlement_complete"
  | "db_pending"
  | "db_complete"
  | "activation_pending"
  | "contained"
  | "blocked"
  | "resolved"
  | "cancelled_safe";

export interface FormalSwitchOperationSummaryV1 {
  readonly operationId: string;
  readonly ownerType: FormalSwitchOwnerType;
  readonly ownerId: string;
  readonly manuscriptChannel: FormalSwitchChannel;
  readonly entryKind: FormalSwitchEntryKind;
  readonly ownerSubtype?: FormalSwitchReviewType;
  readonly phase: FormalSwitchPhase;
  readonly phaseRevision: bigint;
  readonly terminalCode?: string;
}

export type FormalSwitchFoundationAvailability =
  | "AVAILABLE"
  | "MIGRATION_CLOSED"
  | "AUTHORITY_INCOMPLETE";

export type FormalSwitchSchemaMigrationAdmission = "OPEN_VERIFIED_V53" | "CLOSED" | "INCOMPLETE";
export type FormalSwitchTargetOwnerCutoverAdmission = "CLOSED_NOT_READY";

export interface FormalSwitchMigrationFoundationStatusV1 {
  readonly schemaMigrationAdmission: FormalSwitchSchemaMigrationAdmission;
  readonly targetOwnerCutoverAdmission: FormalSwitchTargetOwnerCutoverAdmission;
  readonly availability: FormalSwitchFoundationAvailability;
  readonly schemaVersion: bigint;
  readonly oldRecoveryFamilyCount: 2;
  readonly productionOwnerCallerCount: 0;
}

export interface FormalSwitchFoundationReadPort {
  readMigrationFoundationStatus(): Promise<FormalSwitchMigrationFoundationStatusV1>;
}
