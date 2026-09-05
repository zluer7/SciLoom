import { invoke } from "@tauri-apps/api/core";
import type {
  SaveAsFailureCode,
  SaveAsOutcome
} from "../types/manuscriptSaveAs";

export interface SaveAsTargetCandidateObservation {
  normalizedTargetPath: string;
  proposedTargetPathIdentity: string;
  canonicalParentPathIdentity: string;
  parentPhysicalIdentityHash: string;
  normalizedFinalFilename: string;
  observationGeneration: string;
  observationProof: string;
  parentExists: true;
  targetExists: boolean;
  targetPhysicalIdentityHash?: string;
}

function failure(
  code: SaveAsFailureCode
): SaveAsOutcome<SaveAsTargetCandidateObservation> {
  return {
    ok: false,
    failure: {
      code,
      stage: "pre_d1_closed",
      continuation:
        code === "SAVE_AS_TARGET_ALREADY_EXISTS" ||
        code === "SAVE_AS_PARENT_MISSING" ||
        code === "SAVE_AS_PATH_INVALID"
          ? "reselect_target"
          : "start_new_operation",
      writeApplied: false
    }
  };
}

function isFailureCode(value: unknown): value is SaveAsFailureCode {
  return typeof value === "string" && [
    "SAVE_AS_PARENT_MISSING",
    "SAVE_AS_PATH_INVALID",
    "SAVE_AS_TARGET_CANDIDATE_INVALID"
  ].includes(value);
}

export function createManuscriptSaveAsPhysicalObservationPort(
  observe: (targetPath: string) => Promise<SaveAsTargetCandidateObservation>
) {
  return Object.freeze({
    async observeExistingSaveAsTarget(input: {
      targetPath: string;
      expectedPathIdentity: string;
    }): Promise<SaveAsOutcome<SaveAsTargetCandidateObservation>> {
      try {
        const observation = await observe(input.targetPath);
        if (
          !observation.targetExists ||
          observation.proposedTargetPathIdentity !== input.expectedPathIdentity ||
          !observation.targetPhysicalIdentityHash ||
          !/^[0-9a-f]{64}$/u.test(observation.targetPhysicalIdentityHash)
        ) {
          return failure("SAVE_AS_D1_READBACK_MISMATCH");
        }
        return { ok: true, continuation: "close", value: observation };
      } catch {
        return failure("SAVE_AS_D1_READBACK_FAILED");
      }
    },
    async observeSaveAsTargetCandidate(input: {
      targetPath: string;
    }): Promise<SaveAsOutcome<SaveAsTargetCandidateObservation>> {
      try {
        const observation = await observe(input.targetPath);
        if (
          !observation.parentExists ||
          !observation.proposedTargetPathIdentity.trim() ||
          !observation.canonicalParentPathIdentity.trim() ||
          !/^[0-9a-f]{64}$/u.test(
            observation.parentPhysicalIdentityHash
          ) ||
          !observation.normalizedFinalFilename.trim() ||
          !observation.observationGeneration.trim() ||
          !/^[0-9a-f]{64}$/u.test(observation.observationProof)
        ) {
          return failure("SAVE_AS_TARGET_CANDIDATE_INVALID");
        }
        if (observation.targetExists) {
          return failure("SAVE_AS_TARGET_ALREADY_EXISTS");
        }
        return {
          ok: true,
          continuation: "close",
          value: observation
        };
      } catch (error) {
        const code =
          error instanceof Error
            ? error.message
            : typeof error === "string"
              ? error
              : undefined;
        return failure(
          isFailureCode(code)
            ? code
            : "SAVE_AS_TARGET_CANDIDATE_INVALID"
        );
      }
    }
  });
}

export const manuscriptSaveAsPhysicalObservationPort =
  createManuscriptSaveAsPhysicalObservationPort((targetPath) =>
    invoke<SaveAsTargetCandidateObservation>(
      "observe_save_as_target_candidate",
      { targetPath }
    )
  );
