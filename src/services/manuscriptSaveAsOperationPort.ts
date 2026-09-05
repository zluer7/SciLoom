import { invoke } from "@tauri-apps/api/core";
import type {
  SaveAsD1CommitState,
  SaveAsD2CommitState,
  SaveAsFailureCode,
  SaveAsOperationStage,
  SaveAsReconciliationState
} from "../types/manuscriptSaveAs";

export interface SaveAsOperationRecord {
  operationId: string;
  revision: number;
  commitFenceRevision: number;
  operationGeneration: number;
  producerProcessGeneration: string;
  ownerType: string;
  ownerId: string;
  channel: "primary" | "literature_outline" | "dedicated_notes";
  sourceWindowRole: "current" | "independent";
  sourceFileRefId?: string;
  sourcePathIdentityKey: string;
  sourceRevision: string;
  sourceRuntimeGeneration: number;
  snapshotSha256: string;
  snapshotByteLength: number;
  encodingContractVersion: string;
  newlineContractVersion: string;
  targetDisplayPath: string;
  targetPathIdentityKey: string;
  targetLocationMode: "managed" | "external";
  targetParentPathIdentityKey: string;
  targetParentPhysicalIdentityHash: string;
  d1PhysicalIdentityHash?: string;
  d1ReadbackSha256?: string;
  d1ReadbackRevision?: string;
  d1ByteLength?: number;
  d1ProofGeneration?: number;
  targetFileRefId?: string;
  d2ReadbackRevision?: string;
  containmentFenceToken?: string;
  reconciliationResultCode?: string;
  reconciliationResolvedAt?: string;
  stage: SaveAsOperationStage;
  d1CommitState: SaveAsD1CommitState;
  d2CommitState: SaveAsD2CommitState;
  reconciliationState: SaveAsReconciliationState;
  blockingCode?: SaveAsFailureCode;
  claimToken?: string;
  claimRevision?: number;
  claimProcessGeneration?: string;
  observationGeneration?: number;
  observationRevision?: number;
  createdAt: string;
  updatedAt: string;
  terminalAt?: string;
}

export interface SaveAsOperationIdentityExpectation {
  operationGeneration: number;
  producerProcessGeneration: string;
  ownerType: string;
  ownerId: string;
  channel: SaveAsOperationRecord["channel"];
  sourceWindowRole: SaveAsOperationRecord["sourceWindowRole"];
  sourceFileRefId?: string;
  sourcePathIdentityKey: string;
  sourceRevision: string;
  sourceRuntimeGeneration: number;
  snapshotSha256: string;
  snapshotByteLength: number;
  encodingContractVersion: string;
  newlineContractVersion: string;
  targetDisplayPath: string;
  targetPathIdentityKey: string;
  targetLocationMode: SaveAsOperationRecord["targetLocationMode"];
  targetParentPathIdentityKey: string;
  targetParentPhysicalIdentityHash: string;
}

export interface SaveAsOperationExpectation {
  revision: number;
  commitFenceRevision: number;
  stage: SaveAsOperationStage;
  d1CommitState: SaveAsD1CommitState;
  d2CommitState: SaveAsD2CommitState;
  reconciliationState: SaveAsReconciliationState;
  claimToken?: string;
  claimRevision?: number;
  claimProcessGeneration?: string;
  observationGeneration?: number;
  observationRevision?: number;
  identity: SaveAsOperationIdentityExpectation;
}

export type SaveAsOperationMutation =
  | { intent: "enter_d1_commit_unknown" }
  | {
      intent: "confirm_d1";
      d1PhysicalIdentityHash: string;
      d1ReadbackSha256: string;
      d1ReadbackRevision: string;
      d1ByteLength: number;
      d1ProofGeneration: number;
    }
  | { intent: "close_pre_d1"; blockingCode: SaveAsFailureCode }
  | { intent: "enter_d2_commit_unknown" }
  | { intent: "enter_r3_activation_pending" }
  | { intent: "enter_p4_presentation_pending" }
  | { intent: "block_reconciliation"; blockingCode: SaveAsFailureCode };

export interface SaveAsOperationTransitionInput {
  operationId: string;
  expected: SaveAsOperationExpectation;
  mutation: SaveAsOperationMutation;
}

type SerializedSaveAsOperationMutation =
  | { intent: "enter_d1_commit_unknown" }
  | {
      intent: "confirm_d1";
      d1_physical_identity_hash: string;
      d1_readback_sha256: string;
      d1_readback_revision: string;
      d1_byte_length: number;
      d1_proof_generation: number;
    }
  | { intent: "close_pre_d1"; blocking_code: SaveAsFailureCode }
  | { intent: "enter_d2_commit_unknown" }
  | { intent: "enter_r3_activation_pending" }
  | { intent: "enter_p4_presentation_pending" }
  | { intent: "block_reconciliation"; blocking_code: SaveAsFailureCode };

export function serializeSaveAsOperationMutation(
  mutation: SaveAsOperationMutation
): SerializedSaveAsOperationMutation {
  switch (mutation.intent) {
    case "confirm_d1":
      return {
        intent: mutation.intent,
        d1_physical_identity_hash: mutation.d1PhysicalIdentityHash,
        d1_readback_sha256: mutation.d1ReadbackSha256,
        d1_readback_revision: mutation.d1ReadbackRevision,
        d1_byte_length: mutation.d1ByteLength,
        d1_proof_generation: mutation.d1ProofGeneration
      };
    case "close_pre_d1":
    case "block_reconciliation":
      return {
        intent: mutation.intent,
        blocking_code: mutation.blockingCode
      };
    default:
      return mutation;
  }
}

export type SaveAsOperationAuthorityErrorCode =
  | "SAVE_AS_OPERATION_NOT_FOUND"
  | "SAVE_AS_OPERATION_REVISION_CONFLICT"
  | "SAVE_AS_OPERATION_STAGE_CONFLICT"
  | "SAVE_AS_OPERATION_ILLEGAL_TRANSITION"
  | "SAVE_AS_OPERATION_IMMUTABLE_IDENTITY_MISMATCH"
  | "SAVE_AS_OPERATION_OWNER_IDENTITY_MISMATCH"
  | "SAVE_AS_OPERATION_GENERATION_MISMATCH"
  | "SAVE_AS_OPERATION_CLAIM_TOKEN_MISMATCH"
  | "SAVE_AS_OPERATION_OBSERVATION_TOKEN_MISMATCH"
  | "SAVE_AS_OPERATION_TERMINAL_STATE_CONFLICT"
  | "SAVE_AS_OPERATION_READBACK_MISMATCH"
  | "SAVE_AS_J0_INPUT_INVALID"
  | "SAVE_AS_J0_CLAIM_CONFLICT"
  | "SAVE_AS_J0_RESPONSE_LOSS"
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

export interface SaveAsOperationAuthorityError {
  category: "validation" | "conflict" | "storage";
  code: SaveAsOperationAuthorityErrorCode;
  reason: string;
  fieldClass: "identity" | "state" | "token" | "fence" | "input" | "storage";
  expectedState?: string;
  actualState?: string;
  retryable: boolean;
  mustReread: boolean;
  terminalImpact: "none" | "operation_retained";
}

export class SaveAsOperationAuthorityException extends Error {
  readonly authority: SaveAsOperationAuthorityError;

  constructor(authority: SaveAsOperationAuthorityError) {
    super(authority.code);
    this.name = "SaveAsOperationAuthorityException";
    this.authority = authority;
  }
}

function authorityError(value: unknown): SaveAsOperationAuthorityError | null {
  let candidate = value;
  if (typeof value === "string") {
    try {
      candidate = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (
    !candidate ||
    typeof candidate !== "object" ||
    typeof (candidate as { code?: unknown }).code !== "string" ||
    typeof (candidate as { reason?: unknown }).reason !== "string" ||
    typeof (candidate as { mustReread?: unknown }).mustReread !== "boolean"
  ) {
    return null;
  }
  return candidate as SaveAsOperationAuthorityError;
}

async function invokeAuthority<T>(
  command: string,
  args: Record<string, unknown>
) {
  try {
    return await invoke<T>(command, args);
  } catch (cause) {
    const typed = authorityError(cause);
    if (typed) throw new SaveAsOperationAuthorityException(typed);
    throw cause;
  }
}

export function compareSaveAsRecoveryOrder(
  left: Pick<SaveAsOperationRecord, "updatedAt" | "operationId">,
  right: Pick<SaveAsOperationRecord, "updatedAt" | "operationId">
) {
  if (left.updatedAt !== right.updatedAt) {
    return left.updatedAt < right.updatedAt ? -1 : 1;
  }
  if (left.operationId === right.operationId) return 0;
  return left.operationId < right.operationId ? -1 : 1;
}

export function saveAsOperationExpectation(
  record: SaveAsOperationRecord
): SaveAsOperationExpectation {
  return {
    revision: record.revision,
    commitFenceRevision: record.commitFenceRevision,
    stage: record.stage,
    d1CommitState: record.d1CommitState,
    d2CommitState: record.d2CommitState,
    reconciliationState: record.reconciliationState,
    claimToken: record.claimToken,
    claimRevision: record.claimRevision,
    claimProcessGeneration: record.claimProcessGeneration,
    observationGeneration: record.observationGeneration,
    observationRevision: record.observationRevision,
    identity: {
      operationGeneration: record.operationGeneration,
      producerProcessGeneration: record.producerProcessGeneration,
      ownerType: record.ownerType,
      ownerId: record.ownerId,
      channel: record.channel,
      sourceWindowRole: record.sourceWindowRole,
      sourceFileRefId: record.sourceFileRefId,
      sourcePathIdentityKey: record.sourcePathIdentityKey,
      sourceRevision: record.sourceRevision,
      sourceRuntimeGeneration: record.sourceRuntimeGeneration,
      snapshotSha256: record.snapshotSha256,
      snapshotByteLength: record.snapshotByteLength,
      encodingContractVersion: record.encodingContractVersion,
      newlineContractVersion: record.newlineContractVersion,
      targetDisplayPath: record.targetDisplayPath,
      targetPathIdentityKey: record.targetPathIdentityKey,
      targetLocationMode: record.targetLocationMode,
      targetParentPathIdentityKey: record.targetParentPathIdentityKey,
      targetParentPhysicalIdentityHash:
        record.targetParentPhysicalIdentityHash
    }
  };
}

export const manuscriptSaveAsOperationPort = Object.freeze({
  create(record: SaveAsOperationRecord) {
    return invokeAuthority<SaveAsOperationRecord>("create_save_as_operation", {
      record
    });
  },
  transition(input: SaveAsOperationTransitionInput) {
    return invokeAuthority<SaveAsOperationRecord>("transition_save_as_operation", {
      input: {
        ...input,
        mutation: serializeSaveAsOperationMutation(input.mutation)
      }
    });
  },
  readback(operationId: string) {
    return invoke<SaveAsOperationRecord | null>(
      "readback_save_as_operation",
      { operationId }
    );
  },
  listReconcilable(limit = 100) {
    return invoke<SaveAsOperationRecord[]>(
      "list_reconcilable_save_as_operations",
      { limit }
    );
  },
  listVisibleD2Containment(limit = 100) {
    return invoke<SaveAsOperationRecord[]>(
      "list_visible_save_as_d2_containment",
      { limit }
    );
  },
  listReconciledTerminalD2(limit = 100) {
    return invoke<SaveAsOperationRecord[]>(
      "list_reconciled_terminal_save_as_d2_operations",
      { limit }
    );
  },
  claimObservation(input: {
    operationId: string;
    expected: SaveAsOperationExpectation;
    observationGeneration: number;
  }) {
    return invokeAuthority<SaveAsOperationRecord>(
      "claim_save_as_operation_observation",
      { input }
    );
  },
  atomicCommitD2(input: {
    operationId: string;
    expected: SaveAsOperationExpectation;
  }) {
    return invokeAuthority<SaveAsD2AuthorityResult>(
      "atomic_commit_save_as_d2",
      { input }
    );
  },
  containUnknownD2(input: {
    operationId: string;
    expected: SaveAsOperationExpectation;
    actionId: string;
  }) {
    return invokeAuthority<SaveAsD2AuthorityResult>(
      "contain_unknown_save_as_d2",
      { input }
    );
  },
  confirmContainedD2(input: {
    operationId: string;
    expected: SaveAsOperationExpectation;
    containmentFenceToken: string;
    actionId: string;
  }) {
    return invokeAuthority<SaveAsD2AuthorityResult>(
      "confirm_contained_save_as_d2",
      { input }
    );
  },
  dismissContainedD2Notice(input: {
    operationId: string;
    expectedOperationRevision: number;
    expectedFenceRevision: number;
    containmentFenceToken: string;
    actionId: string;
  }) {
    return invokeAuthority<SaveAsD2AuthorityResult>(
      "dismiss_contained_save_as_d2_notice",
      { input }
    );
  },
  auditTerminalD2Integrity(input: { operationId: string }) {
    return invokeAuthority<SaveAsD2TerminalIntegrityResult>(
      "audit_terminal_save_as_d2_integrity",
      { input }
    );
  }
});

export interface SaveAsD2AuthorityResult {
  operation: SaveAsOperationRecord;
  fileRef?: import("../types/experiment").FileRef;
  state: "created" | "reused" | "reconciled" | "containment" | "conflict" | "dismissed" | "idempotent";
}

export interface SaveAsD2TerminalIntegrityResult {
  operation: SaveAsOperationRecord;
  integrityState: "verified" | "incident";
  incidentCode?: SaveAsOperationAuthorityErrorCode;
  fileUseAllowed: boolean;
}
