import type { OwnerIdentity } from "../types/manuscriptOperation";

export interface ManuscriptSaveAsRecoveryConsumerIdentityInput {
  operationId: string;
  receiptId: string;
  expectedCustodyRevision: number;
  owner: OwnerIdentity;
  candidateFileRefId: string;
  recoveryGeneration: number;
}

function component(value: string | number) {
  return encodeURIComponent(String(value));
}

/**
 * Shared Recovery is the sole authority that constructs this identity.  The
 * durable receipt/revision and the recovery generation make one retry stable
 * while keeping distinct recovery sessions distinguishable.
 */
export function buildManuscriptSaveAsRecoveryConsumerId(
  input: ManuscriptSaveAsRecoveryConsumerIdentityInput
) {
  const { owner } = input;
  return [
    "save-as-recovery-v1",
    owner.ownerType,
    owner.ownerId,
    owner.channel,
    input.operationId,
    input.receiptId,
    input.candidateFileRefId,
    input.expectedCustodyRevision,
    input.recoveryGeneration
  ].map(component).join(":");
}
