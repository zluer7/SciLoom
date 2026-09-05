import type { CreateFileRefInput, FileRef } from "../types";
import type { FileRefOwnerType } from "../types/experiment";
import type { ManuscriptChannel } from "../types/manuscriptChannel";
import type { OwnerIdentity } from "../types/manuscriptOperation";
import type {
  SharedManuscriptSession,
  SharedManuscriptSessionHandle
} from "../types/sharedManuscriptSession";
import { createPathIdentityKey } from "./fileRefIdentity";
import { fileRefService } from "./fileRefService";
import { manuscriptBindingService } from "./manuscriptBindingService";

export const INDEPENDENT_OPEN_FAMILIES = Object.freeze([
  ["experiment", "primary"],
  ["experimentRun", "primary"],
  ["review", "primary"],
  ["literature", "literature_outline"],
  ["literature", "dedicated_notes"],
  ["resultItem", "primary"],
  ["finding", "primary"],
  ["outputCandidate", "primary"],
  ["outputGap", "primary"],
  ["researchOutput", "primary"]
] as const);

export type IndependentOpenFamily =
  (typeof INDEPENDENT_OPEN_FAMILIES)[number];

export interface IndependentOpenPreviewDto {
  absolutePath: string;
  pathIdentityKey: string;
  physicalIdentity?: string;
  physicalRevision: string;
  fileName: string;
  locationMode: "managed" | "external";
  configuredRoot?: string;
  byteLength: number;
  encoding: "utf-8" | "utf-8-bom";
  newline: "lf" | "crlf" | "mixed" | "none";
  summary?: string;
}

export type IndependentOpenSelectionResult =
  | { status: "success"; preview: IndependentOpenPreviewDto }
  | { status: "picker-cancelled" }
  | {
      status: "invalid-target" | "owner-or-channel-invalid" | "unexpected-failure";
      errorCode: string;
    };

export interface IndependentOpenSessionConsumer {
  handle: SharedManuscriptSessionHandle;
  consumerId?: string;
  session: SharedManuscriptSession;
}

export type IndependentOpenActivationResult =
  | {
      status: "success";
      handle: SharedManuscriptSessionHandle;
      session: SharedManuscriptSession;
      fileName: string;
      fileRefId: string;
    }
  | {
      status: "conflict" | "stale" | "error";
      errorCode?: string;
    };

export type IndependentOpenConsumerCleanupResult =
  | {
      status: "success";
      consumerCleanupState: "released" | "never-retained";
      sessionCleanupState: "released" | "retained-by-other-consumer";
      admissionCleanupState: "released" | "legitimately-retained";
    }
  | {
      status: "error";
      consumerCleanupState: "unresolved";
      sessionCleanupState: "unresolved";
      admissionCleanupState: "unresolved";
      errorCode?: string;
    };

export function resolveIndependentOpenConsumerCleanup(input: {
  closeStatus: string;
  runtimeCleanup?: {
    consumerCleanupState: "released" | "unresolved";
    sessionCleanupState:
      | "released"
      | "retained-by-other-consumer"
      | "unresolved";
    admissionCleanupState:
      | "released"
      | "legitimately-retained"
      | "unresolved";
  };
  errorCode?: string;
}): IndependentOpenConsumerCleanupResult {
  const cleanup = input.runtimeCleanup;
  if (
    input.closeStatus !== "success" ||
    !cleanup ||
    cleanup.consumerCleanupState !== "released" ||
    cleanup.sessionCleanupState === "unresolved" ||
    cleanup.admissionCleanupState === "unresolved"
  ) {
    return {
      status: "error",
      consumerCleanupState: "unresolved",
      sessionCleanupState: "unresolved",
      admissionCleanupState: "unresolved",
      errorCode: input.errorCode ?? "INDEPENDENT_OPEN_CONSUMER_STILL_PRESENT"
    };
  }
  return {
    status: "success",
    consumerCleanupState: cleanup.consumerCleanupState,
    sessionCleanupState: cleanup.sessionCleanupState,
    admissionCleanupState: cleanup.admissionCleanupState
  };
}

export interface IndependentOpenProductAdapter {
  owner: OwnerIdentity;
  presentationScope: string;
  consumerId: string;
  selectAndPreview(): Promise<IndependentOpenSelectionResult>;
  revalidatePreview(
    preview: IndependentOpenPreviewDto
  ): Promise<IndependentOpenSelectionResult>;
  listIndependentConsumers(): IndependentOpenSessionConsumer[];
  getCurrentConsumer(): IndependentOpenSessionConsumer | undefined;
  activateCurrent(consumerId: string): Promise<IndependentOpenActivationResult>;
  activateIndependent(
    fileRefId: string,
    consumerId: string
  ): Promise<IndependentOpenActivationResult>;
  closeConsumer(
    handle: SharedManuscriptSessionHandle,
    decision: "save" | "discard"
  ): Promise<IndependentOpenConsumerCleanupResult>;
  presentCurrent(
    activation: IndependentOpenActivationResult,
    permit: IndependentOpenPresentationPermit
  ): boolean | Promise<boolean>;
  presentIndependent(
    activation: IndependentOpenActivationResult,
    permit: IndependentOpenPresentationPermit
  ): boolean | Promise<boolean>;
  focusCurrent(
    consumer: IndependentOpenSessionConsumer,
    permit: IndependentOpenPresentationPermit
  ): boolean | Promise<boolean>;
  focusIndependent(
    consumer: IndependentOpenSessionConsumer,
    permit: IndependentOpenPresentationPermit
  ): boolean | Promise<boolean>;
  decideDirty(
    consumer: IndependentOpenSessionConsumer
  ): Promise<"save" | "discard" | "cancel">;
  confirmRegistration(
    preview: IndependentOpenPreviewDto
  ): Promise<"confirm" | "cancel">;
  confirmActivationRetry?(input: {
    fileRefId: string;
    fileName: string;
    errorCode?: string;
  }): Promise<boolean>;
}

export interface IndependentOpenPresentationPermit {
  isCurrent(): boolean;
}

export interface IndependentOpenRetryContext {
  fileRefId: string;
  ownerType: string;
  ownerId: string;
  channel: string;
  consumerId: string;
  presentationScope: string;
}

export interface IndependentOpenCleanupContext {
  cleanupToken: string;
  ownerType: string;
  ownerId: string;
  channel: string;
  consumerId: string;
  presentationScope: string;
}

export type IndependentOpenTerminalStatus =
  | "picker-cancelled"
  | "registration-declined"
  | "current-session-reused"
  | "current-session-activated"
  | "independent-session-reused"
  | "activation-succeeded"
  | "operation-cancelled"
  | "activation-aborted-after-commit"
  | "activation-failed-retryable"
  | "presentation-failed-retryable"
  | "cleanup-failed-blocking"
  | "admission-conflict"
  | "invalid-target"
  | "stale-target"
  | "owner-or-channel-invalid"
  | "unexpected-failure";

export interface IndependentOpenTerminalOutcome {
  kind: "terminal";
  status: IndependentOpenTerminalStatus;
  operationGeneration: number;
  operationId: string;
  fileRefId?: string;
  fileName?: string;
  sessionHandle?: SharedManuscriptSessionHandle;
  registrationState?: "created" | "reused" | "reconciled";
  registrationCommitted?: boolean;
  retryContext?: IndependentOpenRetryContext;
  cleanupContext?: IndependentOpenCleanupContext;
  consumerCleanupState?: IndependentOpenConsumerCleanupResult["consumerCleanupState"];
  sessionCleanupState?: IndependentOpenConsumerCleanupResult["sessionCleanupState"];
  admissionCleanupState?: IndependentOpenConsumerCleanupResult["admissionCleanupState"];
  errorCode?: string;
}

export interface IndependentOpenContinuation {
  kind: "continuation";
  status: "registration-confirmation-required" | "dirty-decision-required";
  operationGeneration: number;
  operationId: string;
  continuationToken: string;
  expectedIdentity: {
    ownerType: string;
    ownerId: string;
    channel: string;
    pathIdentityKey: string;
    physicalIdentity?: string;
  };
  preview: IndependentOpenPreviewDto;
}

export type IndependentOpenProtocolResult =
  | IndependentOpenTerminalOutcome
  | IndependentOpenContinuation;

interface TargetPlan {
  preview: IndependentOpenPreviewDto;
  classification:
    | "current"
    | "existing-independent"
    | "registered-non-current"
    | "unregistered";
  fileRef?: FileRef;
  consumer?: IndependentOpenSessionConsumer;
}

interface PendingOperation {
  scope: string;
  owner: OwnerIdentity;
  generation: number;
  operationId: string;
  continuationToken: string;
  phase: "dirty" | "registration";
  plan: TargetPlan;
}

interface PendingCleanup {
  scope: string;
  owner: OwnerIdentity;
  generation: number;
  operationId: string;
  cleanupToken: string;
  handle: SharedManuscriptSessionHandle;
  intendedStatus:
    | "stale-target"
    | "activation-aborted-after-commit"
    | "presentation-failed-retryable";
  terminalFields: Omit<
    IndependentOpenTerminalOutcome,
    "kind" | "status" | "operationGeneration" | "operationId"
  >;
}

export interface IndependentOpenProtocolDependencies {
  listOwnerFileRefsIncludingDeleted(
    ownerType: FileRefOwnerType,
    ownerId: string
  ): Promise<FileRef[]>;
  getFileRef(id: string): Promise<FileRef | undefined | null>;
  getBinding(
    ownerType: FileRefOwnerType,
    ownerId: string,
    channel: ManuscriptChannel
  ): Promise<{ currentFileRefId?: string | null } | undefined | null>;
  registerAndReadback(input: CreateFileRefInput): Promise<{
    fileRef: FileRef;
    state: "created" | "reused" | "reconciled";
    durableCommitConfirmed: true;
  }>;
  createId(): string;
}

const defaultDependencies: IndependentOpenProtocolDependencies = {
  listOwnerFileRefsIncludingDeleted:
    fileRefService.getFileRefsByOwnerIncludingDeleted,
  getFileRef: fileRefService.getById,
  getBinding: manuscriptBindingService.getBindingByOwner,
  registerAndReadback: fileRefService.registerAndReadbackFileRef,
  createId: () =>
    globalThis.crypto?.randomUUID?.() ??
    `independent-open-${Date.now()}-${Math.random().toString(16).slice(2)}`
};

function scopeOf(adapter: IndependentOpenProductAdapter) {
  return [
    adapter.owner.ownerType,
    adapter.owner.ownerId,
    adapter.owner.channel,
    adapter.presentationScope
  ].join(":");
}

function sameOwner(left: OwnerIdentity, right: OwnerIdentity) {
  return left.ownerType === right.ownerType &&
    left.ownerId === right.ownerId &&
    left.channel === right.channel;
}

function samePhysical(
  preview: IndependentOpenPreviewDto,
  session: SharedManuscriptSession
) {
  return Boolean(
    preview.physicalIdentity &&
    session.baseline?.physicalIdentity &&
    preview.physicalIdentity === session.baseline.physicalIdentity
  );
}

function sameTarget(
  preview: IndependentOpenPreviewDto,
  session: SharedManuscriptSession,
  fileRef?: FileRef
) {
  return (
    (fileRef?.id !== undefined &&
      session.file.kind === "durable" &&
      session.file.fileRefId === fileRef.id) ||
    session.file.pathIdentity === preview.pathIdentityKey ||
    samePhysical(preview, session)
  );
}

function isExactActive(
  owner: OwnerIdentity,
  preview: IndependentOpenPreviewDto,
  fileRef: FileRef
) {
  return !fileRef.deletedAt &&
    fileRef.ownerType === owner.ownerType &&
    fileRef.ownerId === owner.ownerId &&
    fileRef.manuscriptChannel === owner.channel &&
    fileRef.resourceKind === "file" &&
    fileRef.fileRole === "manuscript" &&
    fileRef.locationMode === preview.locationMode &&
    fileRef.pathIdentityKey === preview.pathIdentityKey &&
    createPathIdentityKey(fileRef.path) === preview.pathIdentityKey;
}

function terminal(
  operation: Pick<PendingOperation, "generation" | "operationId">,
  status: IndependentOpenTerminalStatus,
  extra: Omit<
    IndependentOpenTerminalOutcome,
    "kind" | "status" | "operationGeneration" | "operationId"
  > = {}
): IndependentOpenTerminalOutcome {
  return {
    kind: "terminal",
    status,
    operationGeneration: operation.generation,
    operationId: operation.operationId,
    ...extra
  };
}

export function createIndependentManuscriptOpenProtocol(
  dependencies: IndependentOpenProtocolDependencies = defaultDependencies
) {
  const activeGeneration = new Map<string, number>();
  const pending = new Map<string, PendingOperation>();
  const pendingCleanup = new Map<string, PendingCleanup>();

  function current(operation: PendingOperation) {
    return activeGeneration.get(operation.scope) === operation.generation;
  }

  function invalidateScope(scope: string) {
    const next = (activeGeneration.get(scope) ?? 0) + 1;
    activeGeneration.set(scope, next);
    for (const [token, operation] of pending) {
      if (operation.scope === scope) pending.delete(token);
    }
    return next;
  }

  function cleanupContext(
    adapter: IndependentOpenProductAdapter,
    cleanupToken: string
  ): IndependentOpenCleanupContext {
    return {
      cleanupToken,
      ownerType: adapter.owner.ownerType,
      ownerId: adapter.owner.ownerId,
      channel: adapter.owner.channel,
      consumerId: adapter.consumerId,
      presentationScope: adapter.presentationScope
    };
  }

  function cleanupBlockingOutcome(
    adapter: IndependentOpenProductAdapter,
    cleanup: PendingCleanup,
    result: IndependentOpenConsumerCleanupResult
  ) {
    return terminal(cleanup, "cleanup-failed-blocking", {
      ...cleanup.terminalFields,
      retryContext: undefined,
      cleanupContext: cleanupContext(adapter, cleanup.cleanupToken),
      consumerCleanupState: result.consumerCleanupState,
      sessionCleanupState: result.sessionCleanupState,
      admissionCleanupState: result.admissionCleanupState,
      errorCode: result.status === "error"
        ? result.errorCode ?? "INDEPENDENT_OPEN_CLEANUP_FAILED"
        : "INDEPENDENT_OPEN_CLEANUP_UNRESOLVED"
    });
  }

  async function performCleanup(
    adapter: IndependentOpenProductAdapter,
    cleanup: PendingCleanup
  ): Promise<IndependentOpenTerminalOutcome> {
    let result: IndependentOpenConsumerCleanupResult;
    try {
      result = await adapter.closeConsumer(cleanup.handle, "discard");
    } catch (error) {
      result = {
        status: "error",
        consumerCleanupState: "unresolved",
        sessionCleanupState: "unresolved",
        admissionCleanupState: "unresolved",
        errorCode: error instanceof Error
          ? error.message.match(/[A-Z][A-Z0-9_]+/u)?.[0] ??
            "INDEPENDENT_OPEN_CLEANUP_THROWN"
          : "INDEPENDENT_OPEN_CLEANUP_THROWN"
      };
    }
    if (result.status !== "success") {
      pendingCleanup.set(cleanup.scope, cleanup);
      return cleanupBlockingOutcome(adapter, cleanup, result);
    }
    pendingCleanup.delete(cleanup.scope);
    return terminal(cleanup, cleanup.intendedStatus, {
      ...cleanup.terminalFields,
      consumerCleanupState: result.consumerCleanupState,
      sessionCleanupState: result.sessionCleanupState,
      admissionCleanupState: result.admissionCleanupState
    });
  }

  async function cleanupActivatedConsumer(
    adapter: IndependentOpenProductAdapter,
    operation: PendingOperation,
    activation: Extract<IndependentOpenActivationResult, { status: "success" }>,
    intendedStatus: PendingCleanup["intendedStatus"],
    terminalFields: PendingCleanup["terminalFields"]
  ) {
    return performCleanup(adapter, {
      scope: operation.scope,
      owner: operation.owner,
      generation: operation.generation,
      operationId: operation.operationId,
      cleanupToken: dependencies.createId(),
      handle: activation.handle,
      intendedStatus,
      terminalFields
    });
  }

  function continuation(
    operation: PendingOperation,
    status: IndependentOpenContinuation["status"]
  ): IndependentOpenContinuation {
    operation.phase = status === "dirty-decision-required"
      ? "dirty"
      : "registration";
    pending.set(operation.continuationToken, operation);
    return {
      kind: "continuation",
      status,
      operationGeneration: operation.generation,
      operationId: operation.operationId,
      continuationToken: operation.continuationToken,
      expectedIdentity: {
        ownerType: operation.owner.ownerType,
        ownerId: operation.owner.ownerId,
        channel: operation.owner.channel,
        pathIdentityKey: operation.plan.preview.pathIdentityKey,
        physicalIdentity: operation.plan.preview.physicalIdentity
      },
      preview: operation.plan.preview
    };
  }

  async function classify(
    adapter: IndependentOpenProductAdapter,
    preview: IndependentOpenPreviewDto
  ): Promise<TargetPlan | IndependentOpenTerminalOutcome> {
    const operation = {
      generation: activeGeneration.get(scopeOf(adapter)) ?? 0,
      operationId: dependencies.createId()
    };
    let rows: FileRef[];
    let binding: { currentFileRefId?: string | null } | undefined | null;
    try {
      [rows, binding] = await Promise.all([
        dependencies.listOwnerFileRefsIncludingDeleted(
          adapter.owner.ownerType as FileRefOwnerType,
          adapter.owner.ownerId
        ),
        dependencies.getBinding(
          adapter.owner.ownerType as FileRefOwnerType,
          adapter.owner.ownerId,
          adapter.owner.channel as ManuscriptChannel
        )
      ]);
    } catch {
      return terminal(operation, "unexpected-failure", {
        errorCode: "INDEPENDENT_OPEN_LOOKUP_FAILED"
      });
    }
    const identityRows = rows.filter(
      (fileRef) =>
        fileRef.pathIdentityKey === preview.pathIdentityKey ||
        createPathIdentityKey(fileRef.path) === preview.pathIdentityKey
    );
    if (identityRows.some((fileRef) => fileRef.deletedAt)) {
      return terminal(operation, "stale-target", {
        errorCode: "INDEPENDENT_OPEN_DELETED_IDENTITY"
      });
    }
    const exact = identityRows.filter((fileRef) =>
      isExactActive(adapter.owner, preview, fileRef)
    );
    if (identityRows.length !== exact.length || exact.length > 1) {
      return terminal(operation, "invalid-target", {
        errorCode: "INDEPENDENT_OPEN_FILE_REF_IDENTITY_MISMATCH"
      });
    }
    const fileRef = exact[0];
    const currentFileRef = binding?.currentFileRefId
      ? await dependencies.getFileRef(binding.currentFileRefId)
      : undefined;
    const currentConsumer = adapter.getCurrentConsumer();
    if (
      (fileRef && currentFileRef?.id === fileRef.id) ||
      Boolean(currentConsumer && sameTarget(preview, currentConsumer.session, fileRef))
    ) {
      return {
        preview,
        classification: "current",
        fileRef: fileRef ?? currentFileRef ?? undefined,
        consumer: currentConsumer
      };
    }
    const independent = adapter.listIndependentConsumers().filter(
      ({ session }) =>
        sameOwner(session.owner, adapter.owner) &&
        session.windowRole === "independent" &&
        sameTarget(preview, session, fileRef)
    );
    if (independent.length > 1) {
      return terminal(operation, "unexpected-failure", {
        errorCode: "INDEPENDENT_OPEN_DUPLICATE_LOGICAL_SESSION"
      });
    }
    if (independent[0]) {
      return {
        preview,
        classification: "existing-independent",
        fileRef,
        consumer: independent[0]
      };
    }
    return {
      preview,
      classification: fileRef ? "registered-non-current" : "unregistered",
      fileRef
    };
  }

  async function finishPresentation(
    adapter: IndependentOpenProductAdapter,
    operation: PendingOperation,
    activation: IndependentOpenActivationResult,
    role: "current" | "independent",
    registration?: {
      state: "created" | "reused" | "reconciled";
      committed: true;
    }
  ): Promise<IndependentOpenTerminalOutcome> {
    if (activation.status !== "success") {
      const conflict = activation.status === "conflict";
      return terminal(operation, conflict ? "admission-conflict" : "activation-failed-retryable", {
        fileRefId: operation.plan.fileRef?.id,
        fileName: operation.plan.preview.fileName,
        registrationState: registration?.state,
        registrationCommitted: registration?.committed,
        retryContext: operation.plan.fileRef
          ? {
              fileRefId: operation.plan.fileRef.id,
              ownerType: adapter.owner.ownerType,
              ownerId: adapter.owner.ownerId,
              channel: adapter.owner.channel,
              consumerId: adapter.consumerId,
              presentationScope: adapter.presentationScope
            }
          : undefined,
        errorCode: activation.errorCode
      });
    }
    if (!current(operation)) {
      return cleanupActivatedConsumer(
        adapter,
        operation,
        activation,
        registration ? "activation-aborted-after-commit" : "stale-target",
        {
        fileRefId: activation.fileRefId,
        fileName: activation.fileName,
        registrationState: registration?.state,
        registrationCommitted: registration?.committed
        }
      );
    }
    const permit: IndependentOpenPresentationPermit = {
      isCurrent: () => current(operation)
    };
    const presented = role === "current"
      ? await adapter.presentCurrent(activation, permit)
      : await adapter.presentIndependent(activation, permit);
    if (!current(operation)) {
      return cleanupActivatedConsumer(
        adapter,
        operation,
        activation,
        registration ? "activation-aborted-after-commit" : "stale-target",
        {
          fileRefId: activation.fileRefId,
          fileName: activation.fileName,
          registrationState: registration?.state,
          registrationCommitted: registration?.committed
        }
      );
    }
    if (!presented) {
      return cleanupActivatedConsumer(
        adapter,
        operation,
        activation,
        "presentation-failed-retryable",
        {
        fileRefId: activation.fileRefId,
        fileName: activation.fileName,
        registrationState: registration?.state,
        registrationCommitted: registration?.committed,
        retryContext: {
          fileRefId: activation.fileRefId,
          ownerType: adapter.owner.ownerType,
          ownerId: adapter.owner.ownerId,
          channel: adapter.owner.channel,
          consumerId: adapter.consumerId,
          presentationScope: adapter.presentationScope
        }
        }
      );
    }
    return terminal(
      operation,
      role === "current" ? "current-session-activated" : "activation-succeeded",
      {
        fileRefId: activation.fileRefId,
        fileName: activation.fileName,
        sessionHandle: activation.handle,
        registrationState: registration?.state,
        registrationCommitted: registration?.committed
      }
    );
  }

  async function advance(
    adapter: IndependentOpenProductAdapter,
    operation: PendingOperation
  ): Promise<IndependentOpenProtocolResult> {
    if (!current(operation)) return terminal(operation, "stale-target");
    const plan = operation.plan;
    if (plan.classification === "current") {
      if (plan.consumer) {
        const focused = await adapter.focusCurrent(plan.consumer, {
          isCurrent: () => current(operation)
        });
        if (!current(operation)) return terminal(operation, "stale-target");
        return terminal(operation, focused
          ? "current-session-reused"
          : "presentation-failed-retryable", {
          fileRefId: plan.fileRef?.id,
          fileName: plan.preview.fileName,
          sessionHandle: plan.consumer.handle
        });
      }
      const activated = await adapter.activateCurrent(adapter.consumerId);
      return finishPresentation(adapter, operation, activated, "current");
    }
    if (plan.classification === "existing-independent" && plan.consumer) {
      const focused = await adapter.focusIndependent(plan.consumer, {
        isCurrent: () => current(operation)
      });
      if (!current(operation)) return terminal(operation, "stale-target");
      return terminal(operation, focused
        ? "independent-session-reused"
        : "presentation-failed-retryable", {
        fileRefId: plan.fileRef?.id,
        fileName: plan.preview.fileName,
        sessionHandle: plan.consumer.handle
      });
    }

    const oldConsumers = adapter.listIndependentConsumers().filter(
      ({ session }) =>
        sameOwner(session.owner, adapter.owner) &&
        session.windowRole === "independent"
    );
    if (oldConsumers.length > 1) {
      return terminal(operation, "unexpected-failure", {
        errorCode: "INDEPENDENT_OPEN_MULTIPLE_PRESENTATIONS"
      });
    }
    const old = oldConsumers[0];
    if (old?.session.dirty) {
      return continuation(operation, "dirty-decision-required");
    }
    if (old) {
      const closed = await adapter.closeConsumer(old.handle, "discard");
      if (closed.status !== "success") {
        return terminal(operation, "unexpected-failure", {
          errorCode: closed.errorCode ?? "INDEPENDENT_OPEN_OLD_SESSION_CLOSE_FAILED"
        });
      }
    }
    if (plan.classification === "unregistered") {
      return continuation(operation, "registration-confirmation-required");
    }
    const activated = await adapter.activateIndependent(
      plan.fileRef!.id,
      adapter.consumerId
    );
    return finishPresentation(adapter, operation, activated, "independent");
  }

  async function begin(
    adapter: IndependentOpenProductAdapter
  ): Promise<IndependentOpenProtocolResult> {
    const scope = scopeOf(adapter);
    const blockedCleanup = pendingCleanup.get(scope);
    if (blockedCleanup) {
      return cleanupBlockingOutcome(adapter, blockedCleanup, {
        status: "error",
        consumerCleanupState: "unresolved",
        sessionCleanupState: "unresolved",
        admissionCleanupState: "unresolved",
        errorCode: "INDEPENDENT_OPEN_CLEANUP_REQUIRED"
      });
    }
    const generation = invalidateScope(scope);
    const operation: PendingOperation = {
      scope,
      owner: adapter.owner,
      generation,
      operationId: dependencies.createId(),
      continuationToken: dependencies.createId(),
      phase: "registration",
      plan: {
        preview: {
          absolutePath: "",
          pathIdentityKey: "",
          physicalRevision: "",
          fileName: "",
          locationMode: "external",
          byteLength: 0,
          encoding: "utf-8",
          newline: "none"
        },
        classification: "unregistered"
      }
    };
    const selected = await adapter.selectAndPreview();
    if (!current(operation)) return terminal(operation, "stale-target");
    if (selected.status !== "success") {
      return terminal(operation, selected.status, {
        errorCode: "errorCode" in selected ? selected.errorCode : undefined
      });
    }
    const classified = await classify(adapter, selected.preview);
    if ("kind" in classified) {
      return {
        ...classified,
        operationGeneration: generation,
        operationId: operation.operationId
      };
    }
    operation.plan = classified;
    return advance(adapter, operation);
  }

  async function continueOperation(
    adapter: IndependentOpenProductAdapter,
    continuationInput: IndependentOpenContinuation,
    decision: "confirm" | "save" | "discard" | "cancel"
  ): Promise<IndependentOpenProtocolResult> {
    const operation = pending.get(continuationInput.continuationToken);
    if (
      !operation ||
      !current(operation) ||
      operation.generation !== continuationInput.operationGeneration ||
      !sameOwner(operation.owner, adapter.owner) ||
      operation.plan.preview.pathIdentityKey !==
        continuationInput.expectedIdentity.pathIdentityKey
    ) {
      return terminal(
        {
          generation: continuationInput.operationGeneration,
          operationId: continuationInput.operationId
        },
        "stale-target"
      );
    }
    pending.delete(operation.continuationToken);
    if (decision === "cancel") {
      return terminal(
        operation,
        operation.phase === "registration"
          ? "registration-declined"
          : "operation-cancelled"
      );
    }
    if (operation.phase === "dirty") {
      if (decision !== "save" && decision !== "discard") {
        return terminal(operation, "unexpected-failure", {
          errorCode: "INDEPENDENT_OPEN_INVALID_DIRTY_DECISION"
        });
      }
      const old = adapter.listIndependentConsumers().find(
        ({ session }) =>
          sameOwner(session.owner, adapter.owner) &&
          session.windowRole === "independent"
      );
      if (!old) return advance(adapter, operation);
      const closed = await adapter.closeConsumer(old.handle, decision);
      if (closed.status !== "success") {
        return terminal(operation, "unexpected-failure", {
          errorCode: closed.errorCode ?? "INDEPENDENT_OPEN_DIRTY_RESOLUTION_FAILED"
        });
      }
      if (!current(operation)) return terminal(operation, "stale-target");
      if (operation.plan.classification === "unregistered") {
        return continuation(operation, "registration-confirmation-required");
      }
      const activated = await adapter.activateIndependent(
        operation.plan.fileRef!.id,
        adapter.consumerId
      );
      return finishPresentation(adapter, operation, activated, "independent");
    }

    if (decision !== "confirm") {
      return terminal(operation, "registration-declined");
    }
    const fresh = await adapter.revalidatePreview(operation.plan.preview);
    if (!current(operation)) return terminal(operation, "stale-target");
    if (
      fresh.status !== "success" ||
      fresh.preview.pathIdentityKey !== operation.plan.preview.pathIdentityKey ||
      fresh.preview.physicalRevision !== operation.plan.preview.physicalRevision ||
      fresh.preview.physicalIdentity !== operation.plan.preview.physicalIdentity
    ) {
      return terminal(operation, "stale-target", {
        errorCode: fresh.status === "success"
          ? "INDEPENDENT_OPEN_PREVIEW_CHANGED"
          : "errorCode" in fresh
            ? fresh.errorCode
            : undefined
      });
    }
    const reclassified = await classify(adapter, fresh.preview);
    if ("kind" in reclassified) return reclassified;
    operation.plan = reclassified;
    if (reclassified.classification !== "unregistered") {
      return advance(adapter, operation);
    }
    if (!current(operation)) return terminal(operation, "stale-target");

    let registered: Awaited<
      ReturnType<IndependentOpenProtocolDependencies["registerAndReadback"]>
    >;
    try {
      registered = await dependencies.registerAndReadback({
        ownerType: adapter.owner.ownerType as CreateFileRefInput["ownerType"],
        ownerId: adapter.owner.ownerId,
        manuscriptChannel:
          adapter.owner.channel as CreateFileRefInput["manuscriptChannel"],
        resourceKind: "file",
        fileRole: "manuscript",
        locationMode: fresh.preview.locationMode,
        fileType: "markdown",
        path: fresh.preview.absolutePath,
        pathIdentityKey: fresh.preview.pathIdentityKey,
        title: fresh.preview.fileName,
        source: "user"
      });
    } catch (error) {
      return terminal(operation, "unexpected-failure", {
        errorCode:
          error instanceof Error
            ? error.message.match(/[A-Z][A-Z0-9_]+/u)?.[0]
            : "INDEPENDENT_OPEN_REGISTRATION_FAILED"
      });
    }
    operation.plan.fileRef = registered.fileRef;
    operation.plan.classification = "registered-non-current";
    if (!current(operation)) {
      return terminal(operation, "activation-aborted-after-commit", {
        fileRefId: registered.fileRef.id,
        fileName: fresh.preview.fileName,
        registrationState: registered.state,
        registrationCommitted: true
      });
    }
    const activated = await adapter.activateIndependent(
      registered.fileRef.id,
      adapter.consumerId
    );
    return finishPresentation(adapter, operation, activated, "independent", {
      state: registered.state,
      committed: true
    });
  }

  async function retry(
    adapter: IndependentOpenProductAdapter,
    context: IndependentOpenRetryContext
  ): Promise<IndependentOpenTerminalOutcome> {
    const scope = scopeOf(adapter);
    const blockedCleanup = pendingCleanup.get(scope);
    if (blockedCleanup) {
      return cleanupBlockingOutcome(adapter, blockedCleanup, {
        status: "error",
        consumerCleanupState: "unresolved",
        sessionCleanupState: "unresolved",
        admissionCleanupState: "unresolved",
        errorCode: "INDEPENDENT_OPEN_CLEANUP_REQUIRED"
      });
    }
    const generation = invalidateScope(scope);
    const operation: PendingOperation = {
      scope,
      owner: adapter.owner,
      generation,
      operationId: dependencies.createId(),
      continuationToken: dependencies.createId(),
      phase: "registration",
      plan: {
        preview: {
          absolutePath: "",
          pathIdentityKey: "",
          physicalRevision: "",
          fileName: "",
          locationMode: "external",
          byteLength: 0,
          encoding: "utf-8",
          newline: "none"
        },
        classification: "registered-non-current"
      }
    };
    if (
      context.ownerType !== adapter.owner.ownerType ||
      context.ownerId !== adapter.owner.ownerId ||
      context.channel !== adapter.owner.channel ||
      context.consumerId !== adapter.consumerId ||
      context.presentationScope !== adapter.presentationScope
    ) {
      return terminal(operation, "owner-or-channel-invalid");
    }
    const fileRef = await dependencies.getFileRef(context.fileRefId);
    if (
      !fileRef ||
      fileRef.deletedAt ||
      fileRef.ownerType !== adapter.owner.ownerType ||
      fileRef.ownerId !== adapter.owner.ownerId ||
      fileRef.manuscriptChannel !== adapter.owner.channel ||
      fileRef.resourceKind !== "file" ||
      fileRef.fileRole !== "manuscript"
    ) {
      return terminal(operation, "stale-target");
    }
    operation.plan.fileRef = fileRef;
    operation.plan.preview = {
      ...operation.plan.preview,
      absolutePath: fileRef.path,
      pathIdentityKey: fileRef.pathIdentityKey,
      fileName: fileRef.title,
      locationMode: fileRef.locationMode as "managed" | "external"
    };
    const activated = await adapter.activateIndependent(
      fileRef.id,
      adapter.consumerId
    );
    return finishPresentation(adapter, operation, activated, "independent");
  }

  async function retryCleanup(
    adapter: IndependentOpenProductAdapter,
    context: IndependentOpenCleanupContext
  ): Promise<IndependentOpenTerminalOutcome> {
    const scope = scopeOf(adapter);
    const cleanup = pendingCleanup.get(scope);
    if (
      !cleanup ||
      cleanup.cleanupToken !== context.cleanupToken ||
      context.ownerType !== adapter.owner.ownerType ||
      context.ownerId !== adapter.owner.ownerId ||
      context.channel !== adapter.owner.channel ||
      context.consumerId !== adapter.consumerId ||
      context.presentationScope !== adapter.presentationScope
    ) {
      return terminal(
        {
          generation: activeGeneration.get(scope) ?? 0,
          operationId: dependencies.createId()
        },
        "stale-target",
        { errorCode: "INDEPENDENT_OPEN_CLEANUP_CONTEXT_STALE" }
      );
    }
    return performCleanup(adapter, cleanup);
  }

  async function execute(
    adapter: IndependentOpenProductAdapter
  ): Promise<IndependentOpenTerminalOutcome> {
    let result = await begin(adapter);
    while (result.kind === "continuation") {
      if (result.status === "dirty-decision-required") {
        const consumer = adapter.listIndependentConsumers().find(
          ({ session }) =>
            sameOwner(session.owner, adapter.owner) &&
            session.windowRole === "independent"
        );
        const decision = consumer
          ? await adapter.decideDirty(consumer)
          : "discard";
        result = await continueOperation(adapter, result, decision);
      } else {
        const decision = await adapter.confirmRegistration(result.preview);
        result = await continueOperation(adapter, result, decision);
      }
    }
    if (
      result.status === "activation-failed-retryable" &&
      result.retryContext &&
      adapter.confirmActivationRetry &&
      await adapter.confirmActivationRetry({
        fileRefId: result.retryContext.fileRefId,
        fileName: result.fileName ?? "",
        errorCode: result.errorCode
      })
    ) {
      return retry(adapter, result.retryContext);
    }
    return result;
  }

  return Object.freeze({
    begin,
    continue: continueOperation,
    execute,
    retry,
    retryCleanup,
    cancel(adapter: IndependentOpenProductAdapter) {
      invalidateScope(scopeOf(adapter));
    },
    cancelOwner(owner: OwnerIdentity) {
      const prefix = [
        owner.ownerType,
        owner.ownerId,
        owner.channel
      ].join(":") + ":";
      for (const scope of activeGeneration.keys()) {
        if (scope.startsWith(prefix)) invalidateScope(scope);
      }
    },
    hasPendingOwner(owner: OwnerIdentity) {
      for (const operation of pending.values()) {
        if (sameOwner(operation.owner, owner)) return true;
      }
      return false;
    },
    inspect() {
      return {
        activeScopes: activeGeneration.size,
        pendingContinuations: pending.size,
        pendingCleanups: pendingCleanup.size
      };
    }
  });
}

export const independentManuscriptOpenProtocol =
  createIndependentManuscriptOpenProtocol();

export type IndependentManuscriptOpenProtocol = ReturnType<
  typeof createIndependentManuscriptOpenProtocol
>;
