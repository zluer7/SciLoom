import type { FileRefOwnerType } from "../types/experiment";
import type { OwnerIdentity } from "../types/manuscriptOperation";
import type {
  FrozenSaveAsSourceEvidence,
  SaveAsFailure,
  SaveAsFailureCode,
  SaveAsOwnerDescriptor
} from "../types/manuscriptSaveAs";
import { createManuscriptSaveAsD2Adapter } from "./manuscriptSaveAsD2Adapter";
import {
  createManuscriptSaveAsF0Preparation,
  manuscriptSaveAsF0Preparation
} from "./manuscriptSaveAsF0Preparation";
import { createManuscriptSaveAsPresentationProtocol } from "./manuscriptSaveAsPresentationProtocol";
import { createManuscriptSaveAsRecoveryCoordinator } from "./manuscriptSaveAsRecoveryCoordinator";
import { createManuscriptSaveAsRuntimeActivation } from "./manuscriptSaveAsRuntimeActivation";
import {
  createManuscriptSaveAsSourceSnapshot,
  manuscriptSaveAsSourceSnapshot
} from "./manuscriptSaveAsSourceSnapshot";
import {
  createSharedManuscriptSaveAsEngine,
  sharedManuscriptSaveAsEngine,
  type SharedSaveAsEngineResult,
  type SharedSaveAsF0
} from "./sharedManuscriptSaveAsEngine";
import type { CandidateDisposition } from "./manuscriptSaveAsCandidateCustody";
import type { ManuscriptSegmentDraftSnapshot } from "../types/manuscriptSegmentProjection";

type D2Dependencies = Parameters<
  typeof createManuscriptSaveAsD2Adapter
>[0];
type SourceSnapshotDependencies = Parameters<
  typeof createManuscriptSaveAsSourceSnapshot
>[0];
type F0Dependencies = Parameters<
  typeof createManuscriptSaveAsF0Preparation
>[0];
type ActivationDependencies = Parameters<
  typeof createManuscriptSaveAsRuntimeActivation
>[0];
type EngineDependencies = Parameters<
  typeof createSharedManuscriptSaveAsEngine
>[0];
type PresentationDependencies = Parameters<
  typeof createManuscriptSaveAsPresentationProtocol
>[0];
type RecoveryDependencies = Parameters<
  typeof createManuscriptSaveAsRecoveryCoordinator
>[0];

export type SharedSaveAsTargetSelection =
  | { status: "selected"; path: string }
  | { status: "canceled" }
  | { status: "error"; errorCode: SaveAsFailureCode };

export type SharedSaveAsTargetClassification =
  | {
      status: "allowed";
      locationMode: "managed" | "external";
      configuredRoot?: string;
    }
  | { status: "error"; errorCode: SaveAsFailureCode };

interface SourceSnapshotAuthority {
  freeze(input: {
    owner: {
      ownerType: FileRefOwnerType;
      ownerId: string;
      channel: SaveAsOwnerDescriptor["channel"];
    };
    sourceWindowRole: "current" | "independent";
    sourceRuntimeHandle: string;
    frozenDraftSnapshot?: ManuscriptSegmentDraftSnapshot;
    operationRequestKey?: string;
  }): Promise<
    | {
        ok: true;
        continuation: "close";
        value: FrozenSaveAsSourceEvidence;
      }
    | { ok: false; failure: SaveAsFailure }
  >;
  validateStableIdentity(
    evidence: FrozenSaveAsSourceEvidence
  ): boolean;
}

interface F0Authority {
  prepare(input: {
    frozenSource: FrozenSaveAsSourceEvidence;
    targetPathCandidate: {
      displayPath: string;
      locationMode: "managed" | "external";
      configuredRoot?: string;
    };
    presentationContext: { consumerId: string };
  }): Promise<
    | { ok: true; continuation: "close"; value: SharedSaveAsF0 }
    | { ok: false; failure: SaveAsFailure }
  >;
}

interface EngineAuthority {
  execute(input: SharedSaveAsF0): Promise<
    | { ok: true; value: SharedSaveAsEngineResult }
    | {
        ok: false;
        failure: SaveAsFailure;
        internalReason?: string;
        candidateDisposition?: CandidateDisposition;
      }
  >;
}

export interface SharedSaveAsPresentationSuccess {
  status: "success";
  sessionHandle: string;
  operation: SharedSaveAsEngineResult["operation"];
}

export type SharedSaveAsPresentationResult =
  | SharedSaveAsPresentationSuccess
  | { status: "recovery-required"; failure?: unknown };

export interface SharedManuscriptSaveAsInvocationInput {
  owner: {
    ownerType: FileRefOwnerType;
    ownerId: string;
    channel: SaveAsOwnerDescriptor["channel"];
  };
  sourceWindowRole: "current" | "independent";
  sourceRuntimeHandle: string;
  frozenDraftSnapshot?: ManuscriptSegmentDraftSnapshot;
  operationRequestKey?: string;
  ownerWritable(): Promise<boolean>;
  selectTarget(
    frozenSource: FrozenSaveAsSourceEvidence,
    dialogRequestGeneration: number
  ): Promise<SharedSaveAsTargetSelection>;
  classifyTarget(
    targetPath: string
  ): Promise<SharedSaveAsTargetClassification>;
  createConsumerId(snapshotId: string): string;
  present(input: {
    consumerId: string;
    result: SharedSaveAsEngineResult;
  }): Promise<SharedSaveAsPresentationResult>;
}

export type SharedManuscriptSaveAsInvocationResult =
  | { status: "canceled" }
  | {
      status: "failed";
      failure: SaveAsFailure;
      operationId?: string;
      candidateDisposition: CandidateDisposition;
    }
  | {
      status: "presentation-recovery-required";
      operationId: string;
      result: SharedSaveAsEngineResult;
    }
  | {
      status: "success";
      result: SharedSaveAsEngineResult;
      presentation: SharedSaveAsPresentationSuccess;
      frozenSource: FrozenSaveAsSourceEvidence;
    };

function preEffectFailure(
  code: SaveAsFailureCode,
  continuation: "reselect_target" | "start_new_operation"
): SharedManuscriptSaveAsInvocationResult {
  return {
    status: "failed",
    failure: {
      code,
      stage: "pre_d1_closed",
      continuation,
      writeApplied: false
    },
    candidateDisposition: { kind: "NOT_ACTIVATED" }
  };
}

export function createSharedManuscriptSaveAsInvocationComposition(
  dependencies: {
    sourceSnapshot: SourceSnapshotAuthority;
    f0Preparation: F0Authority;
    engine: EngineAuthority;
  }
) {
  let activeRequest:
    | {
        identity: string;
        promise: Promise<SharedManuscriptSaveAsInvocationResult>;
      }
    | undefined;
  let nextDialogRequestGeneration = 0;

  function requestIdentity(input: SharedManuscriptSaveAsInvocationInput) {
    const identityParts = [
      input.owner.ownerType,
      input.owner.ownerId,
      input.owner.channel,
      input.sourceWindowRole,
      input.sourceRuntimeHandle
    ];
    if (input.operationRequestKey) identityParts.push(input.operationRequestKey);
    return identityParts.join(":");
  }

  async function execute(
    input: SharedManuscriptSaveAsInvocationInput,
    dialogRequestGeneration: number
  ): Promise<SharedManuscriptSaveAsInvocationResult> {
    const frozen = await dependencies.sourceSnapshot.freeze({
      owner: input.owner,
      sourceWindowRole: input.sourceWindowRole,
      sourceRuntimeHandle: input.sourceRuntimeHandle,
      frozenDraftSnapshot: input.frozenDraftSnapshot,
      operationRequestKey: input.operationRequestKey
    });
    if (!frozen.ok) {
      return {
        status: "failed",
        failure: frozen.failure,
        candidateDisposition: { kind: "NOT_ACTIVATED" }
      };
    }
    if (!(await input.ownerWritable())) {
      return preEffectFailure(
        "SAVE_AS_SOURCE_SNAPSHOT_INVALID",
        "start_new_operation"
      );
    }

    const selected = await input.selectTarget(
      frozen.value,
      dialogRequestGeneration
    );
    if (selected.status === "canceled") {
      return { status: "canceled" };
    }
    if (selected.status === "error") {
      return preEffectFailure(selected.errorCode, "reselect_target");
    }
    const classified = await input.classifyTarget(selected.path);
    if (classified.status === "error") {
      return preEffectFailure(classified.errorCode, "reselect_target");
    }

    if (
      !(await input.ownerWritable()) ||
      !dependencies.sourceSnapshot.validateStableIdentity(frozen.value)
    ) {
      return preEffectFailure(
        "SAVE_AS_OPERATION_STALE",
        "start_new_operation"
      );
    }
    const consumerId = input.createConsumerId(
      frozen.value.snapshotId
    );
    if (!consumerId.trim()) {
      return preEffectFailure(
        "SAVE_AS_SOURCE_SNAPSHOT_INVALID",
        "start_new_operation"
      );
    }
    const f0 = await dependencies.f0Preparation.prepare({
      frozenSource: frozen.value,
      targetPathCandidate: {
        ...classified,
        displayPath: selected.path
      },
      presentationContext: { consumerId }
    });
    if (!f0.ok) {
      return {
        status: "failed",
        failure: f0.failure,
        candidateDisposition: { kind: "NOT_ACTIVATED" }
      };
    }

    const executed = await dependencies.engine.execute(f0.value);
    if (!executed.ok) {
      return {
        status: "failed",
        operationId: f0.value.source.operationId,
        failure: executed.failure,
        candidateDisposition:
          executed.candidateDisposition ?? { kind: "NOT_ACTIVATED" }
      };
    }
    const presented = await input.present({
      consumerId,
      result: executed.value
    });
    if (presented.status !== "success") {
      return {
        status: "presentation-recovery-required",
        operationId: executed.value.operation.operationId,
        result: executed.value
      };
    }
    return {
      status: "success",
      result: executed.value,
      presentation: presented,
      frozenSource: frozen.value
    };
  }

  function invoke(
    input: SharedManuscriptSaveAsInvocationInput
  ): Promise<SharedManuscriptSaveAsInvocationResult> {
    const identity = requestIdentity(input);
    if (activeRequest) {
      if (activeRequest.identity === identity) {
        return activeRequest.promise;
      }
      return Promise.resolve(
        preEffectFailure("SAVE_AS_GUARD_CONFLICT", "start_new_operation")
      );
    }
    const promise = execute(input, ++nextDialogRequestGeneration);
    activeRequest = { identity, promise };
    void promise.finally(() => {
      if (activeRequest?.promise === promise) activeRequest = undefined;
    });
    return promise;
  }

  return Object.freeze({ invoke });
}

export const sharedManuscriptSaveAsInvocationComposition =
  createSharedManuscriptSaveAsInvocationComposition({
    sourceSnapshot: manuscriptSaveAsSourceSnapshot,
    f0Preparation: manuscriptSaveAsF0Preparation,
    engine: sharedManuscriptSaveAsEngine
  });

/**
 * Unmounted owner-neutral composition root for isolated Shared Core tests.
 * Importing this module creates no durable/effect authority and performs no I/O.
 */
export function createSharedManuscriptSaveAsCoreComposition(input: {
  d2: D2Dependencies;
  sourceSnapshot: SourceSnapshotDependencies;
  f0: F0Dependencies;
  activation: ActivationDependencies;
  engine: Omit<EngineDependencies, "d2" | "activation">;
  presentation: PresentationDependencies;
  recovery: RecoveryDependencies;
}) {
  const d2 = createManuscriptSaveAsD2Adapter(input.d2);
  const activation = createManuscriptSaveAsRuntimeActivation(
    input.activation
  );
  const engine = createSharedManuscriptSaveAsEngine({
    ...input.engine,
    d2,
    activation
  });
  const sourceSnapshot = createManuscriptSaveAsSourceSnapshot(
    input.sourceSnapshot
  );
  const f0Preparation = createManuscriptSaveAsF0Preparation(input.f0);
  const invocation =
    createSharedManuscriptSaveAsInvocationComposition({
      sourceSnapshot,
      f0Preparation,
      engine
    });
  const presentation =
    createManuscriptSaveAsPresentationProtocol(input.presentation);
  const recovery =
    createManuscriptSaveAsRecoveryCoordinator(input.recovery);
  return Object.freeze({
    d2,
    sourceSnapshot,
    f0Preparation,
    invocation,
    activation,
    engine,
    presentation,
    recovery
  });
}
