import { invoke } from "@tauri-apps/api/core";
import type {
  SaveAsOperationGeneration,
  SaveAsOperationId,
  SaveAsTargetCandidate
} from "../types/manuscriptSaveAs";

export interface SaveAsGuardHolderIdentity {
  operationId: SaveAsOperationId;
  operationGeneration: SaveAsOperationGeneration;
  processGeneration: string;
  proof: string;
}

export interface SaveAsTargetGuardGrant extends SaveAsGuardHolderIdentity {
  target: SaveAsTargetCandidate;
  referenceCount: number;
}

export interface SaveAsTargetGuardRelease {
  released: boolean;
  finalRelease: boolean;
  referenceCount: number;
}

export const manuscriptSaveAsTargetGuardPort = Object.freeze({
  observeCurrentProcessGeneration() {
    return invoke<{ processGeneration: string }>(
      "observe_save_as_process_generation"
    );
  },
  acquire(input: {
    operationId: SaveAsOperationId;
    operationGeneration: SaveAsOperationGeneration;
    target: SaveAsTargetCandidate;
  }) {
    return invoke<SaveAsTargetGuardGrant>("acquire_save_as_target_guard", input);
  },
  retain(proof: string) {
    return invoke<SaveAsTargetGuardGrant>("retain_save_as_target_guard", {
      proof
    });
  },
  validate(proof: string, target: SaveAsTargetCandidate) {
    return invoke<SaveAsTargetGuardGrant>("validate_save_as_target_guard", {
      proof,
      target
    });
  },
  release(proof: string) {
    return invoke<SaveAsTargetGuardRelease>("release_save_as_target_guard", {
      proof
    });
  },
  detachWindow() {
    return invoke<{ releasedCount: number }>(
      "detach_save_as_target_guard_window"
    );
  }
});
