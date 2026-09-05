import type {
  FileRefLocationMode,
  FileRefOwnerType
} from "./experiment";
import type { ManuscriptChannel } from "./manuscriptChannel";
import type { ManuscriptWindowRole } from "./sharedManuscriptSession";

export type SaveAsOperationId = string;
export type SaveAsOperationGeneration = number;
export type SaveAsJ0Revision = number;

export interface SaveAsOwnerDescriptor {
  ownerType: FileRefOwnerType;
  ownerId: string;
  channel: ManuscriptChannel;
  sourceWindowRole: ManuscriptWindowRole;
}

export interface SaveAsSourceSnapshotProof {
  operationId: SaveAsOperationId;
  operationGeneration: SaveAsOperationGeneration;
  processGeneration: string;
  sourceFileRefId: string;
  sourcePathIdentityKey: string;
  sourceRevision: string;
  sourceRuntimeGeneration: number;
  snapshotSha256: string;
  snapshotByteLength: number;
  encodingContractVersion: string;
  newlineContractVersion: string;
}

export interface FrozenSaveAsSourceEvidence {
  readonly snapshotId: string;
  readonly operationId: SaveAsOperationId;
  readonly operationGeneration: SaveAsOperationGeneration;
  readonly owner: Readonly<SaveAsOwnerDescriptor>;
  readonly sourceRuntimeHandle: string;
  readonly sourceSessionKey: string;
  readonly stableSessionInstanceId: string;
  readonly sourceFileRefId: string;
  readonly sourcePathIdentityKey: string;
  readonly sourceRevision: string;
  readonly sourceRuntimeGeneration: number;
  readonly frozenDraftRevision: number;
  readonly frozenBaselineRevision: string;
  readonly frozenBaselinePhysicalIdentity?: string;
  readonly frozenDirty: boolean;
  readonly frozenRawText: string;
  readonly snapshotSha256: string;
  readonly snapshotByteLength: number;
  readonly encodingContractVersion: string;
  readonly newlineContractVersion: string;
}

export interface SaveAsTargetCandidate {
  displayPath: string;
  normalizedPath: string;
  pathIdentityKey: string;
  parentPathIdentityKey: string;
  parentPhysicalIdentityHash: string;
  normalizedFinalFilename: string;
  locationMode: FileRefLocationMode;
}

export interface SaveAsTargetProof extends SaveAsTargetCandidate {
  physicalTargetIdentityHash: string;
}

export interface SaveAsClaimIdentity {
  claimToken: string;
  claimRevision: number;
  claimProcessGeneration: string;
  observationGeneration: number;
  observationRevision: number;
}

export interface SaveAsD1Proof {
  normalizedTargetIdentity: string;
  physicalTargetIdentityHash: string;
  d1ReadbackSha256: string;
  d1ReadbackRevision: string;
  byteLength: number;
  encodingContractVersion: string;
  newlineContractVersion: string;
  proofGeneration: number;
}

export interface SaveAsHandoffProof {
  operationId: SaveAsOperationId;
  operationGeneration: SaveAsOperationGeneration;
  normalizedTargetIdentity: string;
  physicalTargetIdentityHash: string;
  d1ReadbackSha256: string;
  byteLength: number;
  encodingContractVersion: string;
  newlineContractVersion: string;
  sourceSnapshotSha256: string;
  sourceRevision: string;
  sourceRuntimeGeneration: number;
  j0Revision: SaveAsJ0Revision;
  claimIdentity: SaveAsClaimIdentity;
  proofIssuanceGeneration: number;
  singleUseToken: string;
}

export type SaveAsOperationStage =
  | "pre_d1_claimed"
  | "d1_commit_unknown"
  | "d1_confirmed"
  | "d2_commit_unknown"
  | "d2_confirmed"
  | "r3_activation_pending"
  | "p4_presentation_pending"
  | "completed"
  | "finalization_compensated"
  | "pre_d1_closed"
  | "reconciliation_blocked"
  | "d2_reconciliation_contained"
  | "d2_reconciliation_conflict"
  | "d2_reconciled_terminal";

export type SaveAsD1CommitState =
  | "not_started"
  | "unknown"
  | "confirmed"
  | "blocked";
export type SaveAsD2CommitState = SaveAsD1CommitState;
export type SaveAsReconciliationState =
  | "not_required"
  | "pending"
  | "claimed"
  | "resolved"
  | "blocked";

export type SaveAsContinuation =
  | "close"
  | "reselect_target"
  | "retry_same_operation"
  | "readback_reconcile"
  | "await_recovery"
  | "start_new_operation"
  | "decision_escalation"
  | "hard_block";

export type SaveAsFailureCode =
  | "SAVE_AS_SOURCE_SNAPSHOT_INVALID"
  | "SAVE_AS_SOURCE_REVISION_STALE"
  | "SAVE_AS_RUNTIME_GENERATION_STALE"
  | "SAVE_AS_TARGET_CANDIDATE_INVALID"
  | "SAVE_AS_SOURCE_TARGET_SAME_PATH"
  | "SAVE_AS_SOURCE_TARGET_SAME_PHYSICAL"
  | "SAVE_AS_TARGET_ALREADY_EXISTS"
  | "SAVE_AS_PARENT_MISSING"
  | "SAVE_AS_PERMISSION_DENIED"
  | "SAVE_AS_PATH_INVALID"
  | "SAVE_AS_GUARD_CONFLICT"
  | "SAVE_AS_GUARD_STALE"
  | "SAVE_AS_GUARD_RELEASE_FAILED"
  | "SAVE_AS_J0_CLAIM_CONFLICT"
  | "SAVE_AS_J0_CAS_CONFLICT"
  | "SAVE_AS_J0_RESPONSE_LOSS"
  | "SAVE_AS_D1_WRITE_FAILED"
  | "SAVE_AS_D1_FLUSH_FAILED"
  | "SAVE_AS_D1_SYNC_FAILED"
  | "SAVE_AS_D1_READBACK_FAILED"
  | "SAVE_AS_D1_READBACK_MISMATCH"
  | "SAVE_AS_ENCODING_NEWLINE_MISMATCH"
  | "SAVE_AS_HANDOFF_MISMATCH"
  | "SAVE_AS_HANDOFF_ALREADY_CONSUMED"
  | "SAVE_AS_OPERATION_STALE"
  | "SAVE_AS_CANCELLED_PRE_D1"
  | "SAVE_AS_PHYSICAL_EFFECT_UNKNOWN"
  | "SAVE_AS_FORMAL_RESOURCE_ISOLATION_VIOLATION"
  | "D2_UNKNOWN_IDENTITY_INCOMPLETE"
  | "D2_UNKNOWN_PHYSICAL_TARGET_MISSING"
  | "D2_UNKNOWN_PHYSICAL_PROOF_MISMATCH"
  | "D2_UNKNOWN_FENCE_CONFLICT"
  | "D2_UNKNOWN_STALE_PERMIT"
  | "D2_UNKNOWN_FILE_REF_CONFLICT"
  | "D2_UNKNOWN_COMPETING_OPERATION"
  | "D2_UNKNOWN_UNEXPECTED_FINALIZATION"
  | "D2_UNKNOWN_UNEXPECTED_CUSTODY"
  | "D2_UNKNOWN_LATE_WRITER_REJECTED"
  | "D2_UNKNOWN_TERMINAL_STATE_CONFLICT"
  | "D2_UNKNOWN_SOURCE_UNRESOLVED";

export interface SaveAsFailure {
  code: SaveAsFailureCode;
  stage: SaveAsOperationStage;
  continuation: SaveAsContinuation;
  writeApplied: false | true | "unknown";
}

export type SaveAsOutcome<T> =
  | { ok: true; value: T; continuation: "close" }
  | { ok: false; failure: SaveAsFailure };
