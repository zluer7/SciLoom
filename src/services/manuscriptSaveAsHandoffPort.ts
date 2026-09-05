import type {
  SaveAsClaimIdentity,
  SaveAsHandoffProof
} from "../types/manuscriptSaveAs";

interface HandoffEnvelope {
  proof: SaveAsHandoffProof;
  readbackText: string;
}

export interface SaveAsHandoffExpectation {
  operationId: string;
  operationGeneration: number;
  normalizedTargetIdentity: string;
  physicalTargetIdentityHash: string;
  d1ReadbackSha256: string;
  byteLength: number;
  encodingContractVersion: string;
  newlineContractVersion: string;
  sourceSnapshotSha256: string;
  sourceRevision: string;
  sourceRuntimeGeneration: number;
  j0Revision: number;
  claimIdentity: SaveAsClaimIdentity;
  proofIssuanceGeneration: number;
}

export class SaveAsHandoffError extends Error {
  constructor(
    readonly code:
      | "SAVE_AS_HANDOFF_MISMATCH"
      | "SAVE_AS_HANDOFF_ALREADY_CONSUMED"
  ) {
    super(code);
    this.name = "SaveAsHandoffError";
  }
}

function sameClaim(
  left: SaveAsClaimIdentity,
  right: SaveAsClaimIdentity
): boolean {
  return (
    left.claimToken === right.claimToken &&
    left.claimRevision === right.claimRevision &&
    left.claimProcessGeneration === right.claimProcessGeneration &&
    left.observationGeneration === right.observationGeneration &&
    left.observationRevision === right.observationRevision
  );
}

function matches(
  proof: SaveAsHandoffProof,
  expected: SaveAsHandoffExpectation
): boolean {
  return (
    proof.operationId === expected.operationId &&
    proof.operationGeneration === expected.operationGeneration &&
    proof.normalizedTargetIdentity === expected.normalizedTargetIdentity &&
    proof.physicalTargetIdentityHash === expected.physicalTargetIdentityHash &&
    proof.d1ReadbackSha256 === expected.d1ReadbackSha256 &&
    proof.byteLength === expected.byteLength &&
    proof.encodingContractVersion === expected.encodingContractVersion &&
    proof.newlineContractVersion === expected.newlineContractVersion &&
    proof.sourceSnapshotSha256 === expected.sourceSnapshotSha256 &&
    proof.sourceRevision === expected.sourceRevision &&
    proof.sourceRuntimeGeneration === expected.sourceRuntimeGeneration &&
    proof.j0Revision === expected.j0Revision &&
    proof.proofIssuanceGeneration === expected.proofIssuanceGeneration &&
    sameClaim(proof.claimIdentity, expected.claimIdentity)
  );
}

async function sha256Utf8(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function validSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function validProof(proof: SaveAsHandoffProof): boolean {
  return (
    Boolean(proof.operationId.trim()) &&
    proof.operationGeneration > 0 &&
    validSha256(proof.physicalTargetIdentityHash) &&
    validSha256(proof.d1ReadbackSha256) &&
    validSha256(proof.sourceSnapshotSha256) &&
    proof.byteLength >= 0 &&
    proof.sourceRuntimeGeneration >= 0 &&
    proof.j0Revision >= 0 &&
    proof.proofIssuanceGeneration > 0 &&
    Boolean(proof.singleUseToken.trim()) &&
    Boolean(proof.claimIdentity.claimToken.trim()) &&
    proof.claimIdentity.claimRevision >= 0 &&
    Boolean(proof.claimIdentity.claimProcessGeneration.trim()) &&
    proof.claimIdentity.observationGeneration >= 0 &&
    proof.claimIdentity.observationRevision >= 0
  );
}

export function createManuscriptSaveAsHandoffPort() {
  const receipts = new Map<string, HandoffEnvelope>();
  const consumed = new Set<string>();

  return Object.freeze({
    async issueSaveAsHandoff(
      proof: SaveAsHandoffProof,
      readbackText: string
    ) {
      if (
        !validProof(proof) ||
        proof.d1ReadbackSha256 !== (await sha256Utf8(readbackText)) ||
        proof.byteLength !== new TextEncoder().encode(readbackText).byteLength ||
        receipts.has(proof.singleUseToken) ||
        consumed.has(proof.singleUseToken)
      ) {
        throw new SaveAsHandoffError("SAVE_AS_HANDOFF_MISMATCH");
      }
      receipts.set(proof.singleUseToken, { proof, readbackText });
      return proof;
    },
    async consumeSaveAsHandoff(
      singleUseToken: string,
      expected: SaveAsHandoffExpectation
    ) {
      const envelope = receipts.get(singleUseToken);
      if (!envelope) {
        throw new SaveAsHandoffError(
          consumed.has(singleUseToken)
            ? "SAVE_AS_HANDOFF_ALREADY_CONSUMED"
            : "SAVE_AS_HANDOFF_MISMATCH"
        );
      }
      const calculatedSha256 = await sha256Utf8(envelope.readbackText);
      receipts.delete(singleUseToken);
      consumed.add(singleUseToken);
      if (
        !matches(envelope.proof, expected) ||
        !validProof(envelope.proof) ||
        calculatedSha256 !== envelope.proof.d1ReadbackSha256 ||
        new TextEncoder().encode(envelope.readbackText).byteLength !==
          envelope.proof.byteLength
      ) {
        throw new SaveAsHandoffError("SAVE_AS_HANDOFF_MISMATCH");
      }
      return { proof: envelope.proof, readbackText: envelope.readbackText };
    },
    invalidateSaveAsHandoff(singleUseToken: string) {
      const existed = receipts.delete(singleUseToken);
      consumed.add(singleUseToken);
      return existed;
    }
  });
}

export const manuscriptSaveAsHandoffPort =
  createManuscriptSaveAsHandoffPort();
