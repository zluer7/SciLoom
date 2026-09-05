import { invoke } from "@tauri-apps/api/core";
import type { FileRefOwnerType } from "../types/experiment";
import type { ManuscriptChannel } from "../types";
import type { SaveAsPresentationTerminalOutcomeCode } from "./manuscriptSaveAsPresentationProtocol";

export type SaveAsFinalizationState =
  | "presentation_completed"
  | "lifecycle_install_pending"
  | "lifecycle_prepared"
  | "lifecycle_installed"
  | "finalization_pending"
  | "finalized"
  | "lifecycle_rejected"
  | "revoke_pending"
  | "revoked"
  | "compensation_pending"
  | "compensated"
  | "finalization_blocked";

export type LifecycleDecision =
  | "prepared"
  | "installed"
  | "rejected"
  | "stale"
  | "owner_unavailable"
  | "identity_mismatch"
  | "install_failed"
  | "revoked";

export interface LifecycleDecisionReceipt {
  decisionVersion: 1;
  lifecycleDecisionId: string;
  finalizationRequestId: string;
  acknowledgementNonce: string;
  operationId: string;
  receiptId: string;
  ownerType: FileRefOwnerType;
  ownerId: string;
  channel: ManuscriptChannel;
  candidateFileRefId: string;
  ownerInstanceToken: string;
  mountToken: string;
  leaseToken: string;
  mountGeneration: number;
  replacementGeneration: number;
  provisionalInstallId: string;
  decision: LifecycleDecision;
  decisionCreatedAt: string;
}

export interface SaveAsFinalizationRecord {
  operationId: string;
  revision: number;
  finalizationState: SaveAsFinalizationState;
  receiptId: string;
  ownerType: FileRefOwnerType;
  ownerId: string;
  channel: ManuscriptChannel;
  candidateFileRefId: string;
  p4PermitId: string;
  p4OperationGeneration: number;
  p4ProcessGeneration: string;
  terminalOutcomeId: string;
  terminalOutcomeCode: SaveAsPresentationTerminalOutcomeCode;
  terminalOutcomeRevision: number;
  finalizationRequestId?: string;
  acknowledgementNonce?: string;
  ownerInstanceToken?: string;
  mountToken?: string;
  leaseToken?: string;
  mountGeneration?: number;
  replacementGeneration?: number;
  provisionalInstallId?: string;
  lifecycleDecisionId?: string;
  lifecycleDecision?: Exclude<LifecycleDecision, "revoked">;
  lifecycleDecisionCreatedAt?: string;
  revokeDecisionId?: string;
  revokeDecisionCreatedAt?: string;
  claimToken?: string;
  claimRevision?: number;
  claimProcessGeneration?: string;
  claimGeneration?: number;
  claimNamespace?: "save_as_finalization";
  custodyAtFinalization?: "outputs_lifecycle";
  createdAt: string;
  updatedAt: string;
  terminalAt?: string;
}

export interface SaveAsFinalizationPort {
  recordPresentation(input: {
    operationId: string;
    expectedOperationRevision: number;
    receiptId: string;
    permitId: string;
    operationGeneration: number;
    processGeneration: string;
    terminalOutcomeId: string;
    terminalOutcomeCode: SaveAsPresentationTerminalOutcomeCode;
    terminalOutcomeRevision: number;
  }): Promise<SaveAsFinalizationRecord>;
  issueRequest(input: {
    operationId: string;
    expectedFinalizationRevision: number;
    receiptId: string;
    ownerInstanceToken: string;
    mountToken: string;
    leaseToken: string;
    mountGeneration: number;
    replacementGeneration: number;
  }): Promise<SaveAsFinalizationRecord>;
  readback(operationId: string): Promise<SaveAsFinalizationRecord | null>;
  listPending(limit?: number): Promise<SaveAsFinalizationRecord[]>;
  listInterrupted(limit?: number): Promise<SaveAsFinalizationRecord[]>;
  containInterrupted(input: {
    operationId: string;
    expectedOperationRevision: number;
    expectedFinalizationRevision: number;
    expectedCustodyRevision: number;
    receiptId: string;
  }): Promise<SaveAsFinalizationRecord | null>;
  reconcileInterruptedPreservingTarget(input: {
    operationId: string;
    expectedOperationRevision: number;
    expectedFinalizationRevision: number;
    expectedCustodyRevision: number;
    receiptId: string;
    ownerType: string;
    ownerId: string;
    channel: string;
    sourceFileRefId: string;
    targetFileRefId: string;
    targetPathIdentityKey: string;
  }): Promise<SaveAsFinalizationRecord>;
  claim(input: {
    operationId: string;
    expectedFinalizationRevision: number;
    finalizationRequestId: string;
    claimGeneration: number;
  }): Promise<SaveAsFinalizationRecord>;
  recordDecision(input: {
    expectedFinalizationRevision: number;
    claimToken: string;
    receipt: LifecycleDecisionReceipt;
  }): Promise<SaveAsFinalizationRecord>;
  finalize(input: {
    operationId: string;
    expectedFinalizationRevision: number;
    claimToken: string;
    lifecycleDecisionId: string;
    provisionalInstallId: string;
  }): Promise<SaveAsFinalizationRecord>;
  recordRevoked(input: {
    expectedFinalizationRevision: number;
    claimToken: string;
    receipt: LifecycleDecisionReceipt;
  }): Promise<SaveAsFinalizationRecord>;
  completeCompensation(input: {
    operationId: string;
    expectedFinalizationRevision: number;
    claimToken: string;
  }): Promise<SaveAsFinalizationRecord>;
  block(input: {
    operationId: string;
    expectedFinalizationRevision: number;
    claimToken: string;
  }): Promise<SaveAsFinalizationRecord>;
}

export const manuscriptSaveAsFinalizationPort =
  Object.freeze<SaveAsFinalizationPort>({
    recordPresentation: (input) =>
      invoke<SaveAsFinalizationRecord>(
        "record_save_as_presentation_completed",
        { input }
      ),
    issueRequest: (input) =>
      invoke<SaveAsFinalizationRecord>(
        "issue_save_as_finalization_request",
        { input }
      ),
    readback: (operationId) =>
      invoke<SaveAsFinalizationRecord | null>(
        "readback_save_as_finalization",
        { operationId }
      ),
    listPending: (limit = 100) =>
      invoke<SaveAsFinalizationRecord[]>(
        "list_pending_save_as_finalizations",
        { limit }
      ),
    listInterrupted: (limit = 100) =>
      invoke<SaveAsFinalizationRecord[]>(
        "list_interrupted_save_as_finalizations",
        { limit }
      ),
    containInterrupted: (input) =>
      invoke<SaveAsFinalizationRecord | null>(
        "contain_interrupted_save_as_finalization",
        { input }
      ),
    reconcileInterruptedPreservingTarget: (input) =>
      invoke<SaveAsFinalizationRecord>(
        "reconcile_interrupted_save_as_preserving_target",
        { input }
      ),
    claim: (input) =>
      invoke<SaveAsFinalizationRecord>(
        "claim_save_as_finalization",
        { input }
      ),
    recordDecision: (input) =>
      invoke<SaveAsFinalizationRecord>(
        "record_save_as_lifecycle_decision",
        { input }
      ),
    finalize: (input) =>
      invoke<SaveAsFinalizationRecord>(
        "finalize_save_as_operation",
        { input }
      ),
    recordRevoked: (input) =>
      invoke<SaveAsFinalizationRecord>(
        "record_save_as_revoked_decision",
        { input }
      ),
    completeCompensation: (input) =>
      invoke<SaveAsFinalizationRecord>(
        "complete_save_as_finalization_compensation",
        { input }
      ),
    block: (input) =>
      invoke<SaveAsFinalizationRecord>(
        "block_save_as_finalization",
        { input }
      )
  });
