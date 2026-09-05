import type {
  OutputManuscriptOwnerType,
  OutputManuscriptStaticDescriptor
} from "../types";
import type {
  FrozenSaveAsSourceEvidence,
  SaveAsFailureCode
} from "../types/manuscriptSaveAs";
import type { ManuscriptSegmentDraftSnapshot } from "../types/manuscriptSegmentProjection";
import type {
  SharedManuscriptSession,
  SharedManuscriptSessionHandle
} from "../types/sharedManuscriptSession";
import { createPathIdentityKey } from "./fileRefIdentity";
import { fileRefService } from "./fileRefService";
import { managedRootConfigService } from "./managedRootConfigService";
import {
  getManagedPathParent,
  isPathWithinDirectory,
  MANAGED_PATH_LIMITS
} from "./managedPathService";
import { manuscriptBindingService } from "./manuscriptBindingService";
import {
  manuscriptSaveAsOperationPort,
  type SaveAsOperationRecord
} from "./manuscriptSaveAsOperationPort";
import {
  acceptSaveAsPresentationPermit,
  manuscriptSaveAsPresentationProtocol
} from "./manuscriptSaveAsPresentationProtocol";
import {
  manuscriptSaveAsProductionRecoveryComposition,
  type ManuscriptSaveAsProductionRecoveryInput,
  type ManuscriptSaveAsProductionRecoveryResult,
  type WindowPContainedProductionRecoveryResult
} from "./manuscriptSaveAsProductionRecoveryComposition";
import {
  getOutputManuscriptStaticDescriptor,
  isOutputManuscriptOwnerType,
  OutputManuscriptContractError,
  OUTPUT_MANUSCRIPT_ERROR_CODES
} from "./outputManuscriptDescriptorService";
import { outputManuscriptLifecycleService } from "./outputManuscriptLifecycleService";
import { resolveMountedManuscriptLifecycleDecision } from "./fileRefOwnerValidator";
import type {
  ManuscriptCandidateCustodyReceipt,
  ManuscriptCandidateCustodyRequest
} from "./manuscriptSaveAsLifecycleRegistry";
import {
  sharedManuscriptSaveAsInvocationComposition,
  type SharedManuscriptSaveAsInvocationInput,
  type SharedManuscriptSaveAsInvocationResult
} from "./sharedManuscriptSaveAsCoreComposition";
import { sharedManuscriptSessionRuntime } from "./sharedManuscriptSessionComposition";
import type { SharedSaveAsEngineResult } from "./sharedManuscriptSaveAsEngine";
import {
  manuscriptSaveAsCandidateCleanupCoordinator,
  manuscriptSaveAsCandidateCustodyPort,
  type CandidateDisposition,
  type CandidateCustodyRecord
} from "./manuscriptSaveAsCandidateCustody";
import { manuscriptSaveAsPlacementService } from "./manuscriptSaveAsPlacementService";

type Selection =
  | { status: "selected"; path: string }
  | { status: "canceled" }
  | { status: "error"; errorCode: SaveAsFailureCode };

type Classification =
  | {
      status: "allowed";
      locationMode: "managed" | "external";
      configuredRoot?: string;
    }
  | { status: "error"; errorCode: SaveAsFailureCode };

type CandidateCleanupResult =
  | {
      status: "closed" | "already-absent";
      disposition: CandidateDisposition;
    }
  | {
      status: "cleanup-blocked";
      disposition: CandidateDisposition;
    };

export interface OutputManuscriptSaveAsInvocationContext {
  readonly owner: {
    ownerType: OutputManuscriptOwnerType;
    ownerId: string;
    channel: "primary";
  };
  readonly descriptor: OutputManuscriptStaticDescriptor;
  readonly source: {
    windowRole: "current" | "independent";
    runtimeHandle: SharedManuscriptSessionHandle;
    fileRefId: string;
  };
  readonly bindingIdentity: {
    bindingId: string;
    currentFileRefId: string | null;
    defaultManuscriptFileRefId: string | null;
    defaultFolderFileRefId: string | null;
  };
  readonly lifecycle: {
    ownerInstanceToken: string;
    mountToken: string;
    leaseToken: string;
    mountGeneration: number;
    replacementGeneration: number;
  };
  readonly draftDirtyOwnership: {
    dirty: boolean;
    authority: "shared-runtime";
  };
  readonly rawSnapshotAuthority: "shared-runtime-s0" | "shared-segment-sidecar-f1";
  readonly frozenDraftSnapshot?: ManuscriptSegmentDraftSnapshot;
  readonly pickerTitle: string;
  readonly candidateCustody: ManuscriptCandidateCustodyRequest;
  presentationAllowed(): Promise<boolean>;
}

export type OutputCanonicalSaveAsResult =
  | {
      status: "canceled";
      candidateDisposition: Extract<
        CandidateDisposition,
        { kind: "NOT_ACTIVATED" }
      >;
    }
  | {
      status: "presented";
      operationId: string;
      targetFileName: string;
      targetIdentityDigest: string;
      targetRevision: string;
      byteLength: number;
      fileRefId: string;
      independentSessionKey: SharedManuscriptSessionHandle;
      candidateCustody: ManuscriptCandidateCustodyReceipt;
      candidateDisposition: Extract<
        CandidateDisposition,
        { kind: "TRANSFERRED" }
      >;
      frozenSource: FrozenSaveAsSourceEvidence;
    }
  | {
      status:
        | "error"
        | "recovery-required"
        | "blocked";
      operationId?: string;
      errorCode: SaveAsFailureCode;
      cleanup?: CandidateCleanupResult;
      candidateDisposition: CandidateDisposition;
    };

export type OutputCanonicalRecoveryResult =
  | {
      status: "presented";
      operationId: string;
      targetFileName: string;
      fileRefId: string;
      independentSessionKey: SharedManuscriptSessionHandle;
      candidateCustody: ManuscriptCandidateCustodyReceipt;
      candidateDisposition: Extract<
        CandidateDisposition,
        { kind: "TRANSFERRED" }
      >;
    }
  | {
      status: "error" | "recovery-required" | "blocked";
      operationId?: string;
      errorCode: SaveAsFailureCode;
      cleanup?: CandidateCleanupResult;
      candidateDisposition: CandidateDisposition;
    }
  | WindowPContainedProductionRecoveryResult;

export interface OutputManuscriptSaveAsAdapterDependencies {
  ownerWritable(
    ownerType: OutputManuscriptOwnerType,
    ownerId: string
  ): Promise<boolean>;
  selectTarget(input: {
    frozenSource: FrozenSaveAsSourceEvidence;
    dialogRequestGeneration: number;
    ownerFallbackFilename: string;
    title: string;
  }): Promise<Selection>;
  classifyTarget(
    ownerType: OutputManuscriptOwnerType,
    ownerId: string,
    targetPath: string
  ): Promise<Classification>;
  invoke(
    input: SharedManuscriptSaveAsInvocationInput
  ): Promise<SharedManuscriptSaveAsInvocationResult>;
  present(input: {
    ownerType: OutputManuscriptOwnerType;
    ownerId: string;
    consumerId: string;
    result: SharedSaveAsEngineResult;
    presentationAllowed(): Promise<boolean>;
  }): Promise<
    | {
        status: "success";
        sessionHandle: SharedManuscriptSessionHandle;
        operation: SaveAsOperationRecord;
      }
    | { status: "recovery-required"; failure?: unknown }
  >;
  listReconcilable(): Promise<SaveAsOperationRecord[]>;
  recoverOperation(
    input: ManuscriptSaveAsProductionRecoveryInput<OutputManuscriptOwnerType>
  ): Promise<
    ManuscriptSaveAsProductionRecoveryResult<OutputManuscriptOwnerType>
  >;
  resolveConfiguredRoot(
    ownerType: OutputManuscriptOwnerType,
    ownerId: string
  ): Promise<string | undefined>;
  getSession(
    handle: SharedManuscriptSessionHandle
  ): SharedManuscriptSession | undefined;
  cleanupOwnedCandidate(
    operationId: string
  ): Promise<CandidateCleanupResult>;
  transferCustody(input: {
    operationId: string;
    expectedCustodyRevision: number;
    receiptId: string;
    nextAuthority: "outputs_adapter";
  }): Promise<CandidateCustodyRecord>;
  readCustody(
    operationId: string
  ): Promise<CandidateCustodyRecord | null>;
}

const OUTPUT_MANUSCRIPT_SAVE_AS_SERVICE_PORT = Object.freeze({
  assertWritable: (
    ownerType: OutputManuscriptOwnerType,
    ownerId: string
  ) => outputOwnerWritable(ownerType, ownerId),
  resolveWorkspace: (
    ownerType: OutputManuscriptOwnerType,
    ownerId: string
  ) => resolveOutputWorkspace(ownerType, ownerId)
});

export const OUTPUT_MANUSCRIPT_SAVE_AS_SERVICE_MAP = Object.freeze({
  resultItem: OUTPUT_MANUSCRIPT_SAVE_AS_SERVICE_PORT,
  finding: OUTPUT_MANUSCRIPT_SAVE_AS_SERVICE_PORT,
  outputCandidate: OUTPUT_MANUSCRIPT_SAVE_AS_SERVICE_PORT,
  outputGap: OUTPUT_MANUSCRIPT_SAVE_AS_SERVICE_PORT,
  researchOutput: OUTPUT_MANUSCRIPT_SAVE_AS_SERVICE_PORT
});

export function getOutputManuscriptSaveAsServicePort(
  ownerType: OutputManuscriptOwnerType | string
) {
  if (!isOutputManuscriptOwnerType(ownerType)) {
    throw new OutputManuscriptContractError(
      OUTPUT_MANUSCRIPT_ERROR_CODES.ownerUnsupported,
      `Unsupported Outputs Save As ownerType: ${ownerType}.`
    );
  }
  return OUTPUT_MANUSCRIPT_SAVE_AS_SERVICE_MAP[ownerType];
}

export function isOutputSaveAsCandidateIdentityValid(
  session: SharedManuscriptSession | undefined,
  expectedFileRefId: string,
  owner: OutputManuscriptSaveAsInvocationContext["owner"]
) {
  return Boolean(
    session &&
      expectedFileRefId.trim() &&
      session.owner.ownerType === owner.ownerType &&
      session.owner.ownerId === owner.ownerId &&
      session.owner.channel === "primary" &&
      session.windowRole === "independent" &&
      session.file.kind === "durable" &&
      session.file.fileRefId === expectedFileRefId &&
      session.logicalIdentity.fileRefId === expectedFileRefId
  );
}

function custodyReceipt(input: {
  context: OutputManuscriptSaveAsInvocationContext;
  handle: SharedManuscriptSessionHandle;
  operationId: string;
  consumerId: string;
  fileRefId: string;
  producer: "save-as" | "recovery";
  custody: CandidateCustodyRecord;
  }): ManuscriptCandidateCustodyReceipt {
  return Object.freeze({
    request: input.context.candidateCustody,
    handle: input.handle,
    ownerType: input.context.owner.ownerType,
    ownerId: input.context.owner.ownerId,
    channel: "primary",
    producer: input.producer,
    operationId: input.operationId,
    consumerId: input.consumerId,
    fileRefId: input.fileRefId
    ,
    receiptId: input.custody.receiptId,
    receiptVersion: 1,
    processGeneration: input.custody.processGeneration,
    runtimeGeneration: input.custody.runtimeGeneration!,
    currentCustodyAuthority: "outputs_adapter"
  });
}

function contextValid(
  context: OutputManuscriptSaveAsInvocationContext
) {
  const descriptor = getOutputManuscriptStaticDescriptor(
    context.owner.ownerType
  );
  return (
    context.owner.ownerId.trim() !== "" &&
    context.owner.channel === "primary" &&
    context.descriptor.ownerType === descriptor.ownerType &&
    context.descriptor.channel === descriptor.channel &&
    context.descriptor.ownerValidationKey ===
      descriptor.ownerValidationKey &&
    context.descriptor.fileRefRole === descriptor.fileRefRole &&
    context.descriptor.bindingScope === descriptor.bindingScope &&
    descriptor.ownerValidationKey === context.owner.ownerType &&
    descriptor.sourceWindowRoles.includes(context.source.windowRole) &&
    context.source.runtimeHandle.trim() !== "" &&
    context.source.fileRefId.trim() !== "" &&
    context.bindingIdentity.bindingId.trim() !== "" &&
    context.candidateCustody.ownerLease.ownerType ===
      context.owner.ownerType &&
    context.candidateCustody.ownerLease.ownerId ===
      context.owner.ownerId &&
    context.candidateCustody.sourceWindowRole ===
      context.source.windowRole &&
    context.candidateCustody.sourceRuntimeHandle ===
      context.source.runtimeHandle &&
    context.candidateCustody.replacementGeneration ===
      context.lifecycle.replacementGeneration
  );
}

export function createOutputManuscriptSaveAsAdapter(
  dependencies: OutputManuscriptSaveAsAdapterDependencies
) {
  async function saveAs(
    context: OutputManuscriptSaveAsInvocationContext
  ): Promise<OutputCanonicalSaveAsResult> {
    if (!contextValid(context)) {
      return {
        status: "error",
        errorCode: "SAVE_AS_SOURCE_SNAPSHOT_INVALID",
        candidateDisposition: { kind: "NOT_ACTIVATED" }
      };
    }
    getOutputManuscriptSaveAsServicePort(
      context.owner.ownerType
    );
    let acceptedConsumerId: string | undefined;
    const invoked = await dependencies.invoke({
      owner: context.owner,
      sourceWindowRole: context.source.windowRole,
      sourceRuntimeHandle: context.source.runtimeHandle,
      frozenDraftSnapshot: context.frozenDraftSnapshot,
      ownerWritable: () =>
        dependencies.ownerWritable(
          context.owner.ownerType,
          context.owner.ownerId
        ),
      selectTarget: (frozenSource, dialogRequestGeneration) =>
        dependencies.selectTarget({
          frozenSource,
          dialogRequestGeneration,
          ownerFallbackFilename: context.descriptor.saveAsManagedFilename,
          title: context.pickerTitle
        }),
      classifyTarget: (targetPath) =>
        dependencies.classifyTarget(
          context.owner.ownerType,
          context.owner.ownerId,
          targetPath
        ),
      createConsumerId: (snapshotId) =>
        `${context.owner.ownerType}:${context.owner.ownerId}:primary:` +
        `${context.candidateCustody.consumerScopeId}:save-as:${snapshotId}`,
      present: async ({ consumerId, result }) => {
        acceptedConsumerId = consumerId;
        return dependencies.present({
          ownerType: context.owner.ownerType,
          ownerId: context.owner.ownerId,
          consumerId,
          result,
          presentationAllowed: async () =>
            (await context.presentationAllowed()) &&
            (await dependencies.ownerWritable(
              context.owner.ownerType,
              context.owner.ownerId
            ))
        });
      }
    });
    if (invoked.status === "canceled") {
      return {
        status: "canceled",
        candidateDisposition: { kind: "NOT_ACTIVATED" }
      };
    }
    if (invoked.status === "failed") {
      return {
        status:
          invoked.failure.writeApplied === false
            ? "error"
            : "recovery-required",
        operationId: invoked.operationId,
        errorCode: invoked.failure.code,
        candidateDisposition: invoked.candidateDisposition
      };
    }
    if (invoked.status === "presentation-recovery-required") {
      const cleanup = await dependencies.cleanupOwnedCandidate(
        invoked.operationId
      );
      return {
        status:
          cleanup.status === "cleanup-blocked"
            ? "blocked"
            : "recovery-required",
        operationId: invoked.operationId,
        errorCode: "SAVE_AS_OPERATION_STALE",
        cleanup,
        candidateDisposition: cleanup.disposition
      };
    }
    const expectedFileRefId = invoked.result.d2.fileRef.id;
    const candidate = dependencies.getSession(
      invoked.presentation.sessionHandle
    );
    if (
      !acceptedConsumerId ||
      !isOutputSaveAsCandidateIdentityValid(
        candidate,
        expectedFileRefId,
        context.owner
      )
    ) {
      const cleanup = await dependencies.cleanupOwnedCandidate(
        invoked.result.operation.operationId
      );
      return {
        status:
          cleanup.status === "cleanup-blocked"
            ? "blocked"
            : "error",
        operationId: invoked.result.operation.operationId,
        errorCode: "SAVE_AS_OPERATION_STALE",
        cleanup,
        candidateDisposition: cleanup.disposition
      };
    }
    let transferred: CandidateCustodyRecord;
    try {
      transferred = await dependencies.transferCustody({
        operationId: invoked.result.r3.custody.operationId,
        expectedCustodyRevision: invoked.result.r3.custody.revision,
        receiptId: invoked.result.r3.custody.receiptId,
        nextAuthority: "outputs_adapter"
      });
    } catch {
      const readback = await dependencies.readCustody(
        invoked.result.operation.operationId
      );
      if (
        readback?.receiptId === invoked.result.r3.custody.receiptId &&
        readback.currentCustodyAuthority === "outputs_adapter"
      ) {
        transferred = readback;
      } else {
      const cleanup = await dependencies.cleanupOwnedCandidate(
        invoked.result.operation.operationId
      );
      return {
        status:
          cleanup.status === "cleanup-blocked"
            ? "blocked"
            : "recovery-required",
        operationId: invoked.result.operation.operationId,
        errorCode: "SAVE_AS_J0_RESPONSE_LOSS",
        cleanup,
        candidateDisposition: cleanup.disposition
      };
      }
    }
    return {
      status: "presented",
      operationId: invoked.presentation.operation.operationId,
      targetFileName: invoked.result.target.file.fileName,
      targetIdentityDigest:
        invoked.result.target.file.pathIdentity,
      targetRevision:
        candidate?.currentRevision ??
        candidate?.openedRevision ??
        invoked.result.operation.d1ReadbackRevision ??
        "",
      byteLength:
        invoked.result.operation.d1ByteLength ?? 0,
      fileRefId: expectedFileRefId,
      independentSessionKey:
        invoked.presentation.sessionHandle,
      candidateCustody: custodyReceipt({
        context,
        handle: invoked.presentation.sessionHandle,
        operationId:
          invoked.presentation.operation.operationId,
        consumerId: acceptedConsumerId,
        fileRefId: expectedFileRefId,
        producer: "save-as",
        custody: transferred
      }),
      candidateDisposition: {
        kind: "TRANSFERRED",
        receiptId: transferred.receiptId
      },
      frozenSource: invoked.frozenSource
    };
  }

  return Object.freeze({
    saveAs,
    releaseCandidate(
      operationId: string
    ) {
      return dependencies.cleanupOwnedCandidate(operationId);
    },
    async listUnresolved(
      ownerType: OutputManuscriptOwnerType,
      ownerId: string
    ) {
      return (await dependencies.listReconcilable()).filter(
        (record) =>
          record.ownerType === ownerType &&
          record.ownerId === ownerId &&
          record.channel === "primary"
      );
    },
    async recover(input: {
      operationId: string;
      context: OutputManuscriptSaveAsInvocationContext;
    }): Promise<OutputCanonicalRecoveryResult> {
      const { context } = input;
      if (
        !contextValid(context) ||
        context.candidateCustody.producer !== "recovery"
      ) {
        return {
          status: "error",
          errorCode: "SAVE_AS_OPERATION_STALE",
          candidateDisposition: { kind: "NOT_ACTIVATED" }
        };
      }
      const record = (
        await dependencies.listReconcilable()
      ).find(
        (candidate) =>
          candidate.operationId === input.operationId &&
          candidate.ownerType === context.owner.ownerType &&
          candidate.ownerId === context.owner.ownerId &&
          candidate.channel === "primary"
      );
      if (!record?.targetFileRefId) {
        return {
          status: "error",
          operationId: input.operationId,
          errorCode: "SAVE_AS_OPERATION_STALE",
          candidateDisposition: { kind: "NOT_ACTIVATED" }
        };
      }
      let acceptedConsumerId: string | undefined;
      const recovered = await dependencies.recoverOperation({
        operationId: input.operationId,
        expectedOwner: context.owner,
        configuredRoot:
          record.targetLocationMode === "managed"
            ? await dependencies.resolveConfiguredRoot(
                context.owner.ownerType,
                context.owner.ownerId
              )
            : undefined,
        ownerWritable: () =>
          dependencies.ownerWritable(
            context.owner.ownerType,
            context.owner.ownerId
          ),
        windowPMissingBindingContainment: {
          policyId: "window_p_fail_closed_v1"
        },
        present: async ({ consumerId, result }) => {
          acceptedConsumerId = consumerId;
          return dependencies.present({
            ownerType: context.owner.ownerType,
            ownerId: context.owner.ownerId,
            consumerId,
            result,
            presentationAllowed: async () =>
              (await context.presentationAllowed()) &&
              (await dependencies.ownerWritable(
                context.owner.ownerType,
                context.owner.ownerId
              ))
          });
        }
      });
      if (recovered.status === "contained") return recovered;
      if (recovered.status !== "success") {
        const cleanup =
          recovered.operationId &&
          recovered.candidateDisposition.kind === "RESIDUAL"
          ? await dependencies.cleanupOwnedCandidate(
              recovered.operationId
            )
          : undefined;
        return {
          status:
            cleanup?.status === "cleanup-blocked"
              ? "blocked"
              : recovered.status,
          operationId: recovered.operationId,
          errorCode: recovered.errorCode,
          cleanup,
          candidateDisposition:
            cleanup?.disposition ?? recovered.candidateDisposition
        };
      }
      const candidate = dependencies.getSession(
        recovered.sessionHandle
      );
      if (
        !acceptedConsumerId ||
        !isOutputSaveAsCandidateIdentityValid(
          candidate,
          record.targetFileRefId,
          context.owner
        )
      ) {
        const cleanup = await dependencies.cleanupOwnedCandidate(
          recovered.operationId
        );
        return {
          status:
            cleanup.status === "cleanup-blocked"
              ? "blocked"
              : "error",
          operationId: recovered.operationId,
          errorCode: "SAVE_AS_OPERATION_STALE",
          cleanup,
          candidateDisposition: cleanup.disposition
        };
      }
      return {
        status: "presented",
        operationId: recovered.operationId,
        targetFileName: recovered.targetFileName,
        fileRefId: record.targetFileRefId,
        independentSessionKey: recovered.sessionHandle,
        candidateCustody: custodyReceipt({
          context,
          handle: recovered.sessionHandle,
          operationId: recovered.operationId,
          consumerId: acceptedConsumerId,
          fileRefId: record.targetFileRefId,
          producer: "recovery",
          custody: await dependencies.readCustody(
            recovered.operationId
          ) as CandidateCustodyRecord
        }),
        candidateDisposition: recovered.candidateDisposition
      };
    }
  });
}

async function outputOwnerWritable(
  ownerType: OutputManuscriptOwnerType,
  ownerId: string
) {
  try {
    const lifecycle = await resolveMountedManuscriptLifecycleDecision({
      ownerType,
      ownerId,
      manuscriptChannel: "primary"
    });
    if (!lifecycle.canSaveAs) return false;
    await outputManuscriptLifecycleService.assertOwnerActive(
      ownerType,
      ownerId,
      "primary"
    );
    return true;
  } catch {
    return false;
  }
}

async function resolveOutputWorkspace(
  ownerType: OutputManuscriptOwnerType,
  ownerId: string
) {
  const [identity, root] = await Promise.all([
    manuscriptBindingService.resolveIdentity({
      ownerType,
      ownerId,
      manuscriptChannel: "primary"
    }),
    managedRootConfigService.getStatus()
  ]);
  const folderId =
    identity.identityResolved
      ? identity.slots.defaultFolderFileRefId.fileRefId
      : undefined;
  const folder = folderId
    ? await fileRefService.getById(folderId)
    : undefined;
  if (
    !identity.identityResolved ||
    !folder ||
    folder.ownerType !== ownerType ||
    folder.ownerId !== ownerId ||
    folder.resourceKind !== "folder" ||
    folder.fileRole !== "defaultFolder" ||
    folder.locationMode !== "managed" ||
    root.status !== "configured" ||
    !root.managedRoot
  ) {
    throw new Error("OUTPUT_MANUSCRIPT_SAVE_AS_WORKSPACE_INVALID");
  }
  return {
    path: folder.path,
    managedRoot: root.managedRoot
  };
}

async function classifyOutputSaveAsTarget(
  ownerType: OutputManuscriptOwnerType,
  ownerId: string,
  targetPath: string
): Promise<Classification> {
  if (
    targetPath.length >
    MANAGED_PATH_LIMITS.maximumAbsolutePath
  ) {
    return {
      status: "error",
      errorCode: "SAVE_AS_PATH_INVALID"
    };
  }
  try {
    const targetIdentity = createPathIdentityKey(targetPath);
    const [workspace, ownerFileRefs, otherOwnerConflicts] =
      await Promise.all([
        getOutputManuscriptSaveAsServicePort(
          ownerType
        ).resolveWorkspace(ownerType, ownerId),
        fileRefService.getFileRefsByOwner(ownerType, ownerId),
        fileRefService.getActiveManuscriptPathConflicts(
          ownerType,
          ownerId,
          targetIdentity
        )
      ]);
    const ownerConflict = ownerFileRefs.some(
      (fileRef) =>
        !fileRef.deletedAt &&
        fileRef.resourceKind === "file" &&
        fileRef.fileRole === "manuscript" &&
        fileRef.pathIdentityKey === targetIdentity &&
        createPathIdentityKey(fileRef.path) === targetIdentity
    );
    if (ownerConflict || otherOwnerConflicts.length > 0) {
      return {
        status: "error",
        errorCode: "SAVE_AS_TARGET_CANDIDATE_INVALID"
      };
    }
    if (isPathWithinDirectory(workspace.path, targetPath)) {
      if (
        createPathIdentityKey(getManagedPathParent(targetPath)) !==
        createPathIdentityKey(workspace.path)
      ) {
        return {
          status: "error",
          errorCode: "SAVE_AS_TARGET_CANDIDATE_INVALID"
        };
      }
      return {
        status: "allowed",
        locationMode: "managed",
        configuredRoot: workspace.managedRoot
      };
    }
    if (
      isPathWithinDirectory(workspace.managedRoot, targetPath)
    ) {
      return {
        status: "error",
        errorCode: "SAVE_AS_TARGET_CANDIDATE_INVALID"
      };
    }
    return { status: "allowed", locationMode: "external" };
  } catch {
    return {
      status: "error",
      errorCode: "SAVE_AS_TARGET_CANDIDATE_INVALID"
    };
  }
}

async function presentOutputSaveAs(input: {
  ownerType: OutputManuscriptOwnerType;
  ownerId: string;
  consumerId: string;
  result: SharedSaveAsEngineResult;
  presentationAllowed(): Promise<boolean>;
}) {
  if (
    input.result.operation.ownerType !== input.ownerType ||
    input.result.operation.ownerId !== input.ownerId ||
    input.result.operation.channel !== "primary" ||
    !(await input.presentationAllowed())
  ) {
    return { status: "recovery-required" as const };
  }
  const generation =
    input.result.operation.operationGeneration;
  let acceptedHandle:
    | SharedManuscriptSessionHandle
    | undefined;
  const registration =
    manuscriptSaveAsPresentationProtocol.registerConsumer({
      consumerId: input.consumerId,
      consumerGeneration: generation,
      async consume(permit) {
        if (!(await input.presentationAllowed())) {
          throw new Error("SAVE_AS_OPERATION_STALE");
        }
        acceptedHandle = permit.runtime.handle;
        return acceptSaveAsPresentationPermit(permit);
      }
    });
  if (registration.status !== "registered") {
    return {
      status: "recovery-required" as const,
      failure: registration.failure
    };
  }
  try {
    const issued =
      await manuscriptSaveAsPresentationProtocol.issue({
        operationId: input.result.operation.operationId,
        operationGeneration: generation,
        processGeneration:
          input.result.operation.producerProcessGeneration,
        j0Revision: input.result.operation.revision,
        targetFileRefId: input.result.d2.fileRef.id,
        candidateReceiptId: input.result.r3.custody.receiptId,
        runtime: input.result.r3.runtime,
        consumerId: input.consumerId,
        consumerGeneration: generation,
        presentationGeneration: generation
      });
    if (!issued.ok) {
      return {
        status: "recovery-required" as const,
        failure: issued.failure
      };
    }
    const transferred =
      await manuscriptSaveAsPresentationProtocol.transfer(
        issued.value.permitId
      );
    if (!transferred.ok || !acceptedHandle) {
      return {
        status: "recovery-required" as const,
        failure: transferred.ok
          ? undefined
          : transferred.failure
      };
    }
    return {
      status: "success" as const,
      sessionHandle: acceptedHandle,
      operation: transferred.value
    };
  } finally {
    manuscriptSaveAsPresentationProtocol.detachConsumer(
      registration
    );
  }
}

async function cleanupOutputCandidate(
  operationId: string
): Promise<CandidateCleanupResult> {
  const disposition =
    await manuscriptSaveAsCandidateCleanupCoordinator.automatic(
      operationId
    );
  if (disposition.kind === "CLOSED") {
    return { status: "closed", disposition };
  }
  if (disposition.kind === "NOT_ACTIVATED") {
    return { status: "already-absent", disposition };
  }
  return { status: "cleanup-blocked", disposition };
}

export const outputManuscriptSaveAsAdapter =
  createOutputManuscriptSaveAsAdapter({
    ownerWritable: outputOwnerWritable,
    selectTarget: (input) => manuscriptSaveAsPlacementService.selectTarget({
      frozenSource: input.frozenSource,
      dialogRequestGeneration: input.dialogRequestGeneration,
      pickerTitle: input.title,
      ownerFallbackFilename: input.ownerFallbackFilename
    }),
    classifyTarget: classifyOutputSaveAsTarget,
    invoke: (input) =>
      sharedManuscriptSaveAsInvocationComposition.invoke(input),
    present: presentOutputSaveAs,
    listReconcilable: () =>
      manuscriptSaveAsOperationPort.listReconcilable(),
    recoverOperation: (input) =>
      manuscriptSaveAsProductionRecoveryComposition.recover(
        input
      ),
    async resolveConfiguredRoot(ownerType, ownerId) {
      try {
        return (
          await resolveOutputWorkspace(ownerType, ownerId)
        ).managedRoot;
      } catch {
        const root = await managedRootConfigService.getStatus();
        return root.status === "configured"
          ? root.managedRoot
          : undefined;
      }
    },
    getSession: (handle) =>
      sharedManuscriptSessionRuntime.getSession(handle),
    cleanupOwnedCandidate: cleanupOutputCandidate
    ,
    transferCustody: (input) =>
      manuscriptSaveAsCandidateCustodyPort.transfer(input),
    readCustody: (operationId) =>
      manuscriptSaveAsCandidateCustodyPort.readback(operationId)
  });

export type OutputManuscriptSaveAsAdapter =
  ReturnType<typeof createOutputManuscriptSaveAsAdapter>;
