import type { EntityId, ISODateString } from "./common";
import type { FileRefOwnerType } from "./experiment";
import type {
  ManuscriptBindingIdentityResult,
  ManuscriptOwnerLifecycleScope
} from "./manuscriptBindingIdentity";
import type { ManuscriptChannel } from "./manuscriptChannel";

export const MANUSCRIPT_PROVISIONING_FACT_AUTHORITIES = Object.freeze({
  identity: "identity-resolved",
  resource: "resource-ready",
  operation: "provisioning-operation-state",
  eligibility: "owner-lifecycle-eligibility"
} as const);

export const MANUSCRIPT_PROVISIONING_INTENTS = Object.freeze([
  "inspect-readiness",
  "create-default",
  "retry",
  "repair",
  "recover"
] as const);

export type ManuscriptProvisioningIntent =
  (typeof MANUSCRIPT_PROVISIONING_INTENTS)[number];

export type ManuscriptProvisioningMutationIntent = Exclude<
  ManuscriptProvisioningIntent,
  "inspect-readiness"
>;

export const MANUSCRIPT_PROVISIONING_PHASES = Object.freeze([
  "preflight",
  "inspection",
  "physical-create-or-reuse",
  "file-ref-register",
  "binding-write",
  "authoritative-readback",
  "final-verification",
  "completed",
  "blocked",
  "partial",
  "failed"
] as const);

export const MANUSCRIPT_PROVISIONING_OPERATION_REPOSITORY_ERROR_CODES =
  Object.freeze({
    ACTIVE_CLAIM_CONFLICT: "PROVISIONING_ACTIVE_CLAIM_CONFLICT",
    CAS_CONFLICT: "PROVISIONING_OPERATION_CAS_CONFLICT",
    INVALID_INPUT: "PROVISIONING_OPERATION_INVALID_INPUT",
    NOT_FOUND: "PROVISIONING_OPERATION_NOT_FOUND",
    DATABASE_ERROR: "PROVISIONING_OPERATION_DATABASE_ERROR",
    STALE_CLAIM_NOT_RECOVERABLE: "PROVISIONING_STALE_CLAIM_NOT_RECOVERABLE",
    RECOVERY_PRECONDITION_CHANGED: "PROVISIONING_RECOVERY_PRECONDITION_CHANGED",
    ATTEMPT_CHAIN_INVALID: "PROVISIONING_ATTEMPT_CHAIN_INVALID",
    OUTBOX_DELIVERY_CONFLICT: "PROVISIONING_OUTBOX_DELIVERY_CONFLICT",
    CLEANUP_REFERENCE_CONFLICT: "PROVISIONING_CLEANUP_REFERENCE_CONFLICT",
    CLAIM_OWNER_MISMATCH: "PROVISIONING_CLAIM_OWNER_MISMATCH",
    CHILD_STATE_CAS_CONFLICT: "PROVISIONING_CHILD_STATE_CAS_CONFLICT"
  } as const);

export const MANUSCRIPT_PROVISIONING_HEARTBEAT_CADENCE_MS = 30_000 as const;
export const MANUSCRIPT_PROVISIONING_STALE_CANDIDATE_THRESHOLD_MS = 300_000 as const;

export type ManuscriptProvisioningOperationRepositoryErrorCode =
  (typeof MANUSCRIPT_PROVISIONING_OPERATION_REPOSITORY_ERROR_CODES)[keyof typeof MANUSCRIPT_PROVISIONING_OPERATION_REPOSITORY_ERROR_CODES];

export type ManuscriptProvisioningPhase =
  (typeof MANUSCRIPT_PROVISIONING_PHASES)[number];

export interface ManuscriptProvisioningKey {
  ownerType: FileRefOwnerType;
  ownerId: EntityId;
  manuscriptChannel: ManuscriptChannel;
}

interface ManuscriptProvisioningRequestBase {
  key: ManuscriptProvisioningKey;
  requestedAt: ISODateString;
}

export type ManuscriptProvisioningRequest =
  | (ManuscriptProvisioningRequestBase & {
      intent: "inspect-readiness";
    })
  | (ManuscriptProvisioningRequestBase & {
      intent: "create-default";
      operationId: string;
      trigger: "owner-create";
    })
  | (ManuscriptProvisioningRequestBase & {
      intent: "retry";
      operationId: string;
      trigger: "explicit-retry";
      previousOperationId?: string;
    })
  | (ManuscriptProvisioningRequestBase & {
      intent: "repair";
      operationId: string;
      trigger: "explicit-repair";
      previousOperationId?: string;
    })
  | (ManuscriptProvisioningRequestBase & {
      intent: "recover";
      operationId: string;
      trigger: "explicit-recovery";
      previousOperationId: string;
    });

export type ManuscriptIdentityResolvedFact =
  | {
      authority: "identity-resolved";
      status: "resolved";
      identityResolved: true;
      availability: "not-checked";
      checkedAt: ISODateString;
      provenance: readonly string[];
    }
  | {
      authority: "identity-resolved";
      status: "not-found" | "invalid" | "error";
      identityResolved: false;
      availability: "not-checked";
      checkedAt: ISODateString;
      provenance: readonly string[];
      causeCode?: string;
    };

export type ManuscriptProvisioningReadinessState =
  | "ready"
  | "not-ready"
  | "not-verified";

export type ManuscriptProvisioningFactKind =
  | "default-folder-identity"
  | "default-folder-exists"
  | "default-folder-actual-type"
  | "default-folder-contained"
  | "default-folder-no-escape"
  | "default-manuscript-identity"
  | "default-manuscript-exists"
  | "default-manuscript-actual-type"
  | "default-manuscript-contained"
  | "default-manuscript-no-escape"
  | "default-binding"
  | "current-manuscript-identity"
  | "current-manuscript-exists"
  | "current-manuscript-actual-type"
  | "current-manuscript-contained"
  | "current-manuscript-no-escape"
  | "current-binding"
  | "read-permission"
  | "write-permission"
  | "parent-experiment-active"
  | "parent-default-folder-identity"
  | "parent-default-folder-exists"
  | "parent-default-folder-actual-type"
  | "parent-default-folder-contained"
  | "parent-default-folder-no-escape"
  | "child-placement-unique"
  | "shared-folder-identity-match";

export type RunParentPlacementFactKind = Extract<
  ManuscriptProvisioningFactKind,
  | "parent-experiment-active"
  | "parent-default-folder-identity"
  | "parent-default-folder-exists"
  | "parent-default-folder-actual-type"
  | "parent-default-folder-contained"
  | "parent-default-folder-no-escape"
  | "child-placement-unique"
>;

export type ManuscriptProvisioningFactProvenance =
  | {
      source: string;
      mode: "authoritative-read-only" | "mutation-preflight" | "final-verification";
      contentReadScope: "metadata-only";
      markdownBytesRead: 0;
    }
  | {
      source: string;
      mode: "final-verification";
      contentReadScope: "operation-created-bounded-readback";
      operationId: string;
      createdByOperation: true;
      maximumBytes: number;
      markdownBytesRead: number;
    };

export interface ManuscriptProvisioningReadinessFact {
  kind: ManuscriptProvisioningFactKind;
  state: ManuscriptProvisioningReadinessState;
  checkedAt: ISODateString;
  provenance: ManuscriptProvisioningFactProvenance;
  blockerCode?: string;
}

export type ManuscriptProvisioningReadinessFacts = Partial<
  Record<ManuscriptProvisioningFactKind, ManuscriptProvisioningReadinessFact>
>;

export interface ManuscriptResourceReadiness {
  intent: ManuscriptProvisioningIntent;
  readReady: ManuscriptProvisioningReadinessState;
  writeReady: ManuscriptProvisioningReadinessState;
  defaultResourceReady: ManuscriptProvisioningReadinessState;
  currentResourceReady: ManuscriptProvisioningReadinessState;
}

export interface ManuscriptProvisioningMandatoryFacts {
  readReady: readonly ManuscriptProvisioningFactKind[];
  writeReady: readonly ManuscriptProvisioningFactKind[];
  defaultResourceReady: readonly ManuscriptProvisioningFactKind[];
  currentResourceReady: readonly ManuscriptProvisioningFactKind[];
}

export type ManuscriptProvisioningRepairableCanonicalResource =
  | "default-folder"
  | "default-manuscript";

export interface ManuscriptProvisioningOwnerChannelContract {
  ownerType: FileRefOwnerType;
  manuscriptChannel: ManuscriptChannel;
  defaultFilename: string;
  trigger: "create-time";
  migrationOrder: 1 | 2 | 3 | 4 | 5;
  parentPlacement: "none" | "experiment-default-folder";
  sharedFolderGroup: "none" | "literature";
  repairableMissingResources: readonly ManuscriptProvisioningRepairableCanonicalResource[];
  mandatoryFacts: ManuscriptProvisioningMandatoryFacts;
}

export type ManuscriptProvisioningErrorClassification =
  | "retryable"
  | "repair-required"
  | "provisioning-recovery-required"
  | "lifecycle-decision-required"
  | "blocked";

interface ManuscriptProvisioningIssueBase {
  code: string;
  originalCauseCode: string;
}

export type ManuscriptProvisioningIssue =
  | (ManuscriptProvisioningIssueBase & {
      classification: "retryable";
      retryable: true;
      nextAction: "retry";
    })
  | (ManuscriptProvisioningIssueBase & {
      classification: "repair-required";
      retryable: false;
      nextAction: "repair";
    })
  | (ManuscriptProvisioningIssueBase & {
      classification: "provisioning-recovery-required";
      retryable: false;
      nextAction: "recover";
    })
  | (ManuscriptProvisioningIssueBase & {
      classification: "lifecycle-decision-required";
      retryable: false;
      nextAction: "lifecycle-decision";
    })
  | (ManuscriptProvisioningIssueBase & {
      classification: "blocked";
      retryable: false;
      nextAction: "stop";
    });

export type ManuscriptProvisioningIssueKind =
  | "transient"
  | "canonical-resource-missing"
  | "physical-only-partial"
  | "file-ref-registered-partial"
  | "binding-written-not-verified"
  | "multi-channel-partial"
  | "parent-ready-child-failed"
  | "deleted-file-ref-identity"
  | "owner-deleted"
  | "parent-deleted"
  | "identity-conflict"
  | "wrong-type"
  | "path-conflict"
  | "symlink-escape"
  | "unknown-existing-file"
  | "non-empty-existing-file"
  | "ownership-unconfirmed"
  | "non-canonical-artifact";

export type ManuscriptProvisioningPartialKind =
  | "physical-only"
  | "file-ref-registered"
  | "binding-written-not-verified"
  | "multi-channel"
  | "parent-ready-child-failed";

interface ManuscriptProvisioningResultBase {
  operationId: string;
  key: ManuscriptProvisioningKey;
  intent: ManuscriptProvisioningMutationIntent;
  phase: ManuscriptProvisioningPhase;
  presentationStale: boolean;
  provenance: readonly string[];
  startedAt: ISODateString;
  updatedAt: ISODateString;
}

export type ManuscriptProvisioningVerifiedCapability =
  | "read"
  | "write"
  | "default-resource"
  | "current-resource";

export type ManuscriptProvisioningResult =
  | (ManuscriptProvisioningResultBase & {
      status: "completed";
      phase: "completed";
      finalVerification: "passed";
      verifiedCapability: ManuscriptProvisioningVerifiedCapability;
      verifiedCapabilityReadiness: "ready";
      readiness: ManuscriptResourceReadiness;
    })
  | (ManuscriptProvisioningResultBase & {
      status: "retryable";
      phase: "partial" | "failed";
      issue: Extract<ManuscriptProvisioningIssue, { classification: "retryable" }>;
    })
  | (ManuscriptProvisioningResultBase & {
      status: "repair-required";
      phase: "blocked" | "partial" | "failed";
      issue: Extract<ManuscriptProvisioningIssue, { classification: "repair-required" }>;
    })
  | (ManuscriptProvisioningResultBase & {
      status: "provisioning-recovery-required";
      phase: "partial" | "failed";
      partialKind: ManuscriptProvisioningPartialKind;
      issue: Extract<
        ManuscriptProvisioningIssue,
        { classification: "provisioning-recovery-required" }
      >;
    })
  | (ManuscriptProvisioningResultBase & {
      status: "lifecycle-decision-required";
      phase: "blocked" | "failed";
      issue: Extract<
        ManuscriptProvisioningIssue,
        { classification: "lifecycle-decision-required" }
      >;
    })
  | (ManuscriptProvisioningResultBase & {
      status: "blocked";
      phase: "blocked" | "failed";
      issue: Extract<ManuscriptProvisioningIssue, { classification: "blocked" }>;
    });

export type ManuscriptProvisioningOperationStatus =
  | "pending"
  | "active"
  | "partial"
  | "completed"
  | "blocked"
  | "failed"
  | "recovery-required";

export interface ManuscriptProvisioningOperationState {
  authority: "provisioning-operation-state";
  operationId: string;
  key: ManuscriptProvisioningKey;
  intent: ManuscriptProvisioningMutationIntent;
  phase: ManuscriptProvisioningPhase;
  status: ManuscriptProvisioningOperationStatus;
  completedPhases: readonly ManuscriptProvisioningPhase[];
  presentationStale: boolean;
  startedAt: ISODateString;
  updatedAt: ISODateString;
  provenance: readonly string[];
  partialKind?: ManuscriptProvisioningPartialKind;
  issue?: ManuscriptProvisioningIssue;
  finalResult?: ManuscriptProvisioningResult;
}

export interface ManuscriptProvisioningEligibilityFact {
  authority: "owner-lifecycle-eligibility";
  status: "eligible" | "ineligible" | "not-verified";
  allowedIntents: readonly ManuscriptProvisioningMutationIntent[];
  checkedAt: ISODateString;
  provenance: readonly string[];
  causeCode?: string;
}

export interface OwnerCreateError {
  code: string;
  message: string;
}

export type ManuscriptProvisioningCreateOutcome<TOwner> =
  | {
      status: "owner-create-failed";
      error: OwnerCreateError;
    }
  | {
      status: "owner-created";
      owner: TOwner;
      provisioning: ManuscriptProvisioningResult;
    };

export type LiteratureProvisioningChannel = Extract<
  ManuscriptChannel,
  "literature_outline" | "dedicated_notes"
>;

export interface LiteratureProvisioningChannelChildState {
  channel: LiteratureProvisioningChannel;
  state: "not-started" | "active" | "completed" | "failed" | "recovery-required";
  operationId?: string;
  defaultResourceReadiness: ManuscriptProvisioningReadinessState;
  finalVerification: "not-run" | "passed" | "not-passed";
  issues: readonly ManuscriptProvisioningIssue[];
}

export interface LiteratureProvisioningAggregateInput {
  aggregateOperationId: string;
  ownerId: EntityId;
  sharedFolderIdentity: ManuscriptProvisioningReadinessFact;
  children: Record<LiteratureProvisioningChannel, LiteratureProvisioningChannelChildState>;
}

export interface LiteratureProvisioningAggregateResult {
  status:
    | "completed"
    | "provisioning-recovery-required"
    | "lifecycle-decision-required"
    | "blocked";
  retryChannels: LiteratureProvisioningChannel[];
  issues: ManuscriptProvisioningIssue[];
}

export type ManuscriptProvisioningReadinessInspectionRequest = Extract<
  ManuscriptProvisioningRequest,
  { intent: "inspect-readiness" }
>;

export interface ManuscriptProvisioningReadinessBlocker {
  factKind: ManuscriptProvisioningFactKind;
  state: Exclude<ManuscriptProvisioningReadinessState, "ready">;
  code: string;
}

export interface ExperimentRunParentReadinessInspectionInput {
  ownerId: EntityId;
}

export interface ManuscriptProvisioningReadinessInspectionInput {
  request: ManuscriptProvisioningReadinessInspectionRequest;
  parentExperiment?: ExperimentRunParentReadinessInspectionInput;
}

export type ManuscriptProvisioningMetadataOnlyProvenance = Extract<
  ManuscriptProvisioningFactProvenance,
  { contentReadScope: "metadata-only" }
>;

export interface ManuscriptProvisioningReadinessInspection {
  authority: "resource-ready";
  key: ManuscriptProvisioningKey;
  descriptor: ManuscriptProvisioningOwnerChannelContract;
  identity: ManuscriptBindingIdentityResult;
  identityFact: ManuscriptIdentityResolvedFact;
  eligibility: ManuscriptProvisioningEligibilityFact;
  facts: ManuscriptProvisioningReadinessFacts;
  readiness: ManuscriptResourceReadiness & { intent: "inspect-readiness" };
  blockers: ManuscriptProvisioningReadinessBlocker[];
  parentPlacementReadiness?: ManuscriptProvisioningReadinessState;
  inspectedAt: ISODateString;
  provenance: ManuscriptProvisioningMetadataOnlyProvenance;
}

export interface LiteratureProvisioningReadinessInspectionInput {
  ownerId: EntityId;
  requestedAt: ISODateString;
}

export interface LiteratureProvisioningReadinessInspection {
  authority: "resource-ready";
  ownerId: EntityId;
  channels: Record<
    LiteratureProvisioningChannel,
    ManuscriptProvisioningReadinessInspection
  >;
  sharedFolderIdentity: ManuscriptProvisioningReadinessFact;
  readiness: ManuscriptResourceReadiness & { intent: "inspect-readiness" };
  blockers: ManuscriptProvisioningReadinessBlocker[];
  inspectedAt: ISODateString;
  provenance: ManuscriptProvisioningMetadataOnlyProvenance;
}

export type DurableManuscriptProvisioningScopeKind =
  | "channel"
  | "literature-aggregate"
  | "literature-child";

export type DurableManuscriptProvisioningOperationStatus =
  | "active"
  | "terminal-completed"
  | "terminal-failed"
  | "terminal-partial"
  | "terminal-blocked"
  | "terminal-recovery-required"
  | "terminal-lifecycle-required";

export type DurableManuscriptProvisioningResultClassification =
  | "completed"
  | ManuscriptProvisioningErrorClassification;

export type DurableManuscriptProvisioningNextAction =
  | "none"
  | "retry"
  | "repair"
  | "recover"
  | "lifecycle-decision"
  | "stop";

export type DurableManuscriptProvisioningEffect =
  | "none"
  | "created"
  | "reused";

export type DurableManuscriptProvisioningBindingEffect =
  | DurableManuscriptProvisioningEffect
  | "updated";

export type DurableManuscriptProvisioningVerificationOutcome =
  | "not-run"
  | "passed"
  | "not-passed"
  | "not-verified";

export interface DurableManuscriptProvisioningAttempt {
  operationId: string;
  scopeKind: DurableManuscriptProvisioningScopeKind;
  ownerType: FileRefOwnerType;
  ownerId: EntityId;
  manuscriptChannel: ManuscriptChannel | null;
  aggregateOperationId: string | null;
  intent: ManuscriptProvisioningMutationIntent;
  triggerKind:
    | "owner-create"
    | "explicit-retry"
    | "explicit-repair"
    | "explicit-recovery";
  phase: ManuscriptProvisioningPhase;
  operationStatus: DurableManuscriptProvisioningOperationStatus;
  resultClassification: DurableManuscriptProvisioningResultClassification | null;
  nextAction: DurableManuscriptProvisioningNextAction | null;
  originalCauseCode: string | null;
  partialKind: ManuscriptProvisioningPartialKind | null;
  revision: number;
  previousOperationId: string | null;
  rootOperationId: string | null;
  folderEffect: DurableManuscriptProvisioningEffect;
  manuscriptEffect: DurableManuscriptProvisioningEffect;
  fileRefEffect: DurableManuscriptProvisioningEffect;
  bindingEffect: DurableManuscriptProvisioningBindingEffect;
  defaultFolderFileRefId: string | null;
  defaultManuscriptFileRefId: string | null;
  bindingId: string | null;
  finalVerificationOutcome: DurableManuscriptProvisioningVerificationOutcome;
  inspectorVersion: string | null;
  verifierVersion: string | null;
  factsSchemaVersion: 1;
  startedAt: ISODateString;
  updatedAt: ISODateString;
  terminalAt: ISODateString | null;
}

export interface DurableManuscriptProvisioningClaim {
  claimId: string;
  scopeKind: Extract<
    DurableManuscriptProvisioningScopeKind,
    "channel" | "literature-aggregate"
  >;
  ownerType: FileRefOwnerType;
  ownerId: EntityId;
  manuscriptChannel: ManuscriptChannel | null;
  operationId: string;
  claimOwnerToken: string;
  claimRevision: number;
  claimedAt: ISODateString;
  lastHeartbeatAt: ISODateString;
  lastProgressAt: ISODateString;
  staleObservedAt: ISODateString | null;
  staleObservedByToken: string | null;
}

export interface DurableManuscriptProvisioningLiteratureChildState {
  aggregateOperationId: string;
  ownerType: "literature";
  ownerId: EntityId;
  manuscriptChannel: LiteratureProvisioningChannel;
  currentChildOperationId: string | null;
  revision: number;
  phase: ManuscriptProvisioningPhase | null;
  operationStatus: DurableManuscriptProvisioningOperationStatus | null;
  resultClassification: DurableManuscriptProvisioningResultClassification | null;
  nextAction: DurableManuscriptProvisioningNextAction | null;
  defaultReadiness: ManuscriptProvisioningReadinessState;
  finalVerificationOutcome: DurableManuscriptProvisioningVerificationOutcome;
  originalCauseCode: string | null;
  updatedAt: ISODateString;
}

export interface DurableManuscriptProvisioningAuditOutbox {
  operationId: string;
  deliveryStatus: "pending" | "delivered" | "failed";
  revision: number;
  deliveryAttemptCount: number;
  operationLogId: string | null;
  errorCode: string | null;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  deliveredAt: ISODateString | null;
}

export interface ManuscriptProvisioningDurableFactsV1Patch {
  folderEffect?: DurableManuscriptProvisioningEffect;
  manuscriptEffect?: DurableManuscriptProvisioningEffect;
  fileRefEffect?: DurableManuscriptProvisioningEffect;
  bindingEffect?: DurableManuscriptProvisioningBindingEffect;
  defaultFolderFileRefId?: EntityId;
  defaultManuscriptFileRefId?: EntityId;
  bindingId?: EntityId;
  finalVerificationOutcome?: DurableManuscriptProvisioningVerificationOutcome;
  inspectorVersion?: string;
  verifierVersion?: string;
}

export interface ManuscriptProvisioningActiveAttemptTransitionInput {
  operationId: string;
  expectedRevision: number;
  expectedPhase: ManuscriptProvisioningPhase;
  expectedOperationStatus: "active";
  targetPhase: Exclude<
    ManuscriptProvisioningPhase,
    "completed" | "blocked" | "partial" | "failed"
  >;
  facts: ManuscriptProvisioningDurableFactsV1Patch;
  occurredAt: ISODateString;
}

export interface ManuscriptProvisioningClaimCasInput {
  claimId: string;
  holderOperationId: string;
  claimOwnerToken: string;
  expectedClaimRevision: number;
  scopeKind: Extract<
    DurableManuscriptProvisioningScopeKind,
    "channel" | "literature-aggregate"
  >;
  ownerType: FileRefOwnerType;
  ownerId: EntityId;
  manuscriptChannel: ManuscriptChannel | null;
}

export interface ManuscriptProvisioningRecoveryReplacementInput {
  snapshotId: string;
  inspectedAt: ISODateString;
  inspectedOwnerType: FileRefOwnerType;
  inspectedOwnerId: EntityId;
  inspectedManuscriptChannel: ManuscriptChannel | null;
  observedOldOperationId: string;
  observedOperationRevision: number;
  observedClaimId: string;
  observedClaimRevision: number;
  oldClaimOwnerToken: string;
  explicitAuthorizationId: string;
  newOperationId: string;
  newClaimId: string;
  newClaimOwnerToken: string;
  occurredAt: ISODateString;
}

export interface ManuscriptProvisioningAuditDeliveryInput {
  operationId: string;
  expectedRevision: number;
  expectedStatus: Extract<
    DurableManuscriptProvisioningAuditOutbox["deliveryStatus"],
    "pending" | "failed"
  >;
  occurredAt: ISODateString;
}

export interface ManuscriptProvisioningCleanupRetentionPolicy {
  terminalBefore: ISODateString;
}

interface ManuscriptProvisioningTerminalInputBase {
  operationId: string;
  claimId: string;
  claimOwnerToken: string;
  expectedOperationRevision: number;
  expectedClaimRevision: number;
  expectedPhase: ManuscriptProvisioningPhase;
  expectedOperationStatus: "active";
  partialKind: ManuscriptProvisioningPartialKind | null;
  originalCauseCode: string | null;
  folderEffect: DurableManuscriptProvisioningEffect;
  manuscriptEffect: DurableManuscriptProvisioningEffect;
  fileRefEffect: DurableManuscriptProvisioningEffect;
  bindingEffect: DurableManuscriptProvisioningBindingEffect;
  defaultFolderFileRefId: string | null;
  defaultManuscriptFileRefId: string | null;
  bindingId: string | null;
  finalVerificationOutcome: DurableManuscriptProvisioningVerificationOutcome;
  inspectorVersion: string | null;
  verifierVersion: string | null;
  occurredAt: ISODateString;
}

export type ManuscriptProvisioningTerminalInput =
  | (ManuscriptProvisioningTerminalInputBase & {
      phase: "completed";
      operationStatus: "terminal-completed";
      resultClassification: "completed";
      nextAction: "none";
    })
  | (ManuscriptProvisioningTerminalInputBase & {
      phase: "failed";
      operationStatus: "terminal-failed";
      resultClassification: "retryable" | "repair-required";
      nextAction: "retry" | "repair";
    })
  | (ManuscriptProvisioningTerminalInputBase & {
      phase: "partial";
      operationStatus: "terminal-partial";
      resultClassification: "retryable" | "repair-required";
      nextAction: "retry" | "repair";
      partialKind: ManuscriptProvisioningPartialKind;
    })
  | (ManuscriptProvisioningTerminalInputBase & {
      phase: "failed" | "partial";
      operationStatus: "terminal-recovery-required";
      resultClassification: "provisioning-recovery-required";
      nextAction: "recover";
      partialKind: ManuscriptProvisioningPartialKind;
    })
  | (ManuscriptProvisioningTerminalInputBase & {
      phase: "blocked" | "failed";
      operationStatus: "terminal-lifecycle-required";
      resultClassification: "lifecycle-decision-required";
      nextAction: "lifecycle-decision";
    })
  | (ManuscriptProvisioningTerminalInputBase & {
      phase: "blocked";
      operationStatus: "terminal-blocked";
      resultClassification: "repair-required";
      nextAction: "repair";
    })
  | (ManuscriptProvisioningTerminalInputBase & {
      phase: "blocked" | "failed";
      operationStatus: "terminal-blocked";
      resultClassification: "blocked";
      nextAction: "stop";
    });
