import { invoke } from "@tauri-apps/api/core";
import type {
  SaveAsClaimIdentity,
  SaveAsD1Proof,
  SaveAsFailureCode,
  SaveAsSourceSnapshotProof,
  SaveAsTargetCandidate
} from "../types/manuscriptSaveAs";

export interface SaveAsD1Request {
  source: SaveAsSourceSnapshotProof;
  target: SaveAsTargetCandidate;
  j0Revision: number;
  claimIdentity: SaveAsClaimIdentity;
  guardProof: string;
  frozenRawText: string;
  sourcePhysicalIdentityHash?: string;
}

export interface SaveAsD1Result {
  proof: SaveAsD1Proof;
  readbackText: string;
  writeApplied: true;
}

export interface ManuscriptSaveAsD1Port {
  createNewWithReadback(input: SaveAsD1Request): Promise<SaveAsD1Result>;
}

export interface SaveAsD1Failure {
  readonly kind: "save_as_d1_failure";
  readonly code: SaveAsFailureCode;
}

interface SaveAsD1TransportFailure {
  readonly kind: "save_as_d1_transport_failure";
}

const D1_CLOSED_FAILURE_CODES = new Set<string>([
  "SAVE_AS_SOURCE_SNAPSHOT_INVALID",
  "SAVE_AS_TARGET_CANDIDATE_INVALID",
  "SAVE_AS_SOURCE_TARGET_SAME_PATH",
  "SAVE_AS_SOURCE_TARGET_SAME_PHYSICAL",
  "SAVE_AS_TARGET_ALREADY_EXISTS",
  "SAVE_AS_PARENT_MISSING",
  "SAVE_AS_PERMISSION_DENIED",
  "SAVE_AS_PATH_INVALID",
  "SAVE_AS_GUARD_STALE",
  "SAVE_AS_GUARD_RELEASE_FAILED",
  "SAVE_AS_J0_CAS_CONFLICT",
  "SAVE_AS_J0_RESPONSE_LOSS",
  "SAVE_AS_D1_WRITE_FAILED",
  "SAVE_AS_D1_FLUSH_FAILED",
  "SAVE_AS_D1_SYNC_FAILED",
  "SAVE_AS_D1_READBACK_FAILED",
  "SAVE_AS_D1_READBACK_MISMATCH",
  "SAVE_AS_ENCODING_NEWLINE_MISMATCH"
] satisfies readonly SaveAsFailureCode[]);

export function decodeSaveAsD1Failure(
  value: unknown
): SaveAsD1Failure | undefined {
  if (
    typeof value !== "string" ||
    !D1_CLOSED_FAILURE_CODES.has(value)
  ) {
    return undefined;
  }
  return Object.freeze({
    kind: "save_as_d1_failure",
    code: value as SaveAsFailureCode
  });
}

export function isSaveAsD1Failure(
  value: unknown
): value is SaveAsD1Failure {
  if (
    typeof value !== "object" ||
    value === null ||
    !("kind" in value) ||
    value.kind !== "save_as_d1_failure" ||
    !("code" in value)
  ) {
    return false;
  }
  return (
    typeof value.code === "string" &&
    D1_CLOSED_FAILURE_CODES.has(value.code)
  );
}

export const manuscriptSaveAsD1Port: ManuscriptSaveAsD1Port = Object.freeze({
  async createNewWithReadback(input: SaveAsD1Request) {
    try {
      return await invoke<SaveAsD1Result>(
        "save_as_create_new_with_readback",
        { input }
      );
    } catch (caught) {
      const failure = decodeSaveAsD1Failure(caught);
      if (failure) throw failure;
      throw Object.freeze({
        kind: "save_as_d1_transport_failure"
      } satisfies SaveAsD1TransportFailure);
    }
  }
});
