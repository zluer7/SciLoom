import type {
  FrozenSaveAsSourceEvidence,
  SaveAsFailureCode,
  SaveAsOutcome
} from "../types/manuscriptSaveAs";
import {
  manuscriptSaveAsPhysicalObservationPort,
  type SaveAsTargetCandidateObservation
} from "./manuscriptSaveAsPhysicalObservationPort";
import { manuscriptSaveAsTargetGuardPort } from "./manuscriptSaveAsTargetGuardPort";
import type { SharedSaveAsF0 } from "./sharedManuscriptSaveAsEngine";

interface ProcessGenerationAuthority {
  observeCurrentProcessGeneration(): Promise<{
    processGeneration: string;
  }>;
}

interface PhysicalObservationAuthority {
  observeSaveAsTargetCandidate(input: {
    targetPath: string;
  }): Promise<SaveAsOutcome<SaveAsTargetCandidateObservation>>;
}

export interface ManuscriptSaveAsF0PreparationInput {
  frozenSource: FrozenSaveAsSourceEvidence;
  targetPathCandidate: {
    displayPath: string;
    locationMode: "managed" | "external";
    configuredRoot?: string;
  };
  presentationContext: {
    consumerId: string;
  };
}

export interface ManuscriptSaveAsF0PreparationDependencies {
  guard: ProcessGenerationAuthority;
  physical: PhysicalObservationAuthority;
}

function failed<T>(
  code: SaveAsFailureCode,
  continuation:
    | "reselect_target"
    | "start_new_operation"
): SaveAsOutcome<T> {
  return {
    ok: false,
    failure: {
      code,
      stage: "pre_d1_closed",
      continuation,
      writeApplied: false
    }
  };
}

function validFrozenSource(source: FrozenSaveAsSourceEvidence) {
  return (
    Boolean(source.snapshotId.trim()) &&
    source.operationId === source.snapshotId &&
    source.operationGeneration > 0 &&
    Boolean(source.owner.ownerId.trim()) &&
    Boolean(source.sourceRuntimeHandle.trim()) &&
    Boolean(source.sourceSessionKey.trim()) &&
    Boolean(source.stableSessionInstanceId.trim()) &&
    Boolean(source.sourceFileRefId.trim()) &&
    Boolean(source.sourcePathIdentityKey.trim()) &&
    Boolean(source.sourceRevision.trim()) &&
    source.sourceRuntimeGeneration >= 0 &&
    source.frozenDraftRevision >= 0 &&
    /^[0-9a-f]{64}$/u.test(source.snapshotSha256) &&
    source.snapshotByteLength ===
      new TextEncoder().encode(source.frozenRawText).byteLength &&
    source.encodingContractVersion === "utf-8-v1" &&
    Boolean(source.newlineContractVersion.trim())
  );
}

export function createManuscriptSaveAsF0Preparation(
  dependencies: ManuscriptSaveAsF0PreparationDependencies
) {
  async function prepare(
    input: ManuscriptSaveAsF0PreparationInput
  ): Promise<SaveAsOutcome<SharedSaveAsF0>> {
    if (
      !validFrozenSource(input.frozenSource) ||
      !input.presentationContext.consumerId.trim()
    ) {
      return failed(
        "SAVE_AS_SOURCE_SNAPSHOT_INVALID",
        "start_new_operation"
      );
    }

    let processGeneration: string;
    try {
      const observed =
        await dependencies.guard.observeCurrentProcessGeneration();
      processGeneration = observed.processGeneration;
    } catch {
      return failed(
        "SAVE_AS_RUNTIME_GENERATION_STALE",
        "start_new_operation"
      );
    }
    if (!processGeneration.trim()) {
      return failed(
        "SAVE_AS_RUNTIME_GENERATION_STALE",
        "start_new_operation"
      );
    }

    const physical =
      await dependencies.physical.observeSaveAsTargetCandidate({
        targetPath: input.targetPathCandidate.displayPath
      });
    if (!physical.ok) return physical;
    if (
      physical.value.proposedTargetPathIdentity ===
      input.frozenSource.sourcePathIdentityKey
    ) {
      return failed(
        "SAVE_AS_SOURCE_TARGET_SAME_PATH",
        "reselect_target"
      );
    }

    const source = {
      operationId: input.frozenSource.operationId,
      operationGeneration: input.frozenSource.operationGeneration,
      processGeneration,
      sourceFileRefId: input.frozenSource.sourceFileRefId,
      sourcePathIdentityKey:
        input.frozenSource.sourcePathIdentityKey,
      sourceRevision: input.frozenSource.sourceRevision,
      sourceRuntimeGeneration:
        input.frozenSource.sourceRuntimeGeneration,
      snapshotSha256: input.frozenSource.snapshotSha256,
      snapshotByteLength: input.frozenSource.snapshotByteLength,
      encodingContractVersion:
        input.frozenSource.encodingContractVersion,
      newlineContractVersion:
        input.frozenSource.newlineContractVersion
    };
    return {
      ok: true,
      continuation: "close",
      value: {
        source,
        frozenRawText: input.frozenSource.frozenRawText,
        owner: {
          ownerType: input.frozenSource.owner.ownerType,
          ownerId: input.frozenSource.owner.ownerId,
          channel: input.frozenSource.owner.channel
        },
        sourceWindowRole:
          input.frozenSource.owner.sourceWindowRole,
        target: {
          displayPath: input.targetPathCandidate.displayPath,
          normalizedPath: physical.value.normalizedTargetPath,
          pathIdentityKey:
            physical.value.proposedTargetPathIdentity,
          parentPathIdentityKey:
            physical.value.canonicalParentPathIdentity,
          parentPhysicalIdentityHash:
            physical.value.parentPhysicalIdentityHash,
          normalizedFinalFilename:
            physical.value.normalizedFinalFilename,
          locationMode: input.targetPathCandidate.locationMode
        },
        targetObservation: {
          generation: physical.value.observationGeneration,
          proof: physical.value.observationProof
        },
        configuredRoot: input.targetPathCandidate.configuredRoot,
        sourcePhysicalIdentityHash:
          input.frozenSource.frozenBaselinePhysicalIdentity,
        consumerId: input.presentationContext.consumerId
      }
    };
  }

  return Object.freeze({ prepare });
}

export const manuscriptSaveAsF0Preparation =
  createManuscriptSaveAsF0Preparation({
    guard: manuscriptSaveAsTargetGuardPort,
    physical: manuscriptSaveAsPhysicalObservationPort
  });
