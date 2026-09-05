import type {
  FileRef,
  ManuscriptBinding,
  OutputManuscriptDocument,
  OutputManuscriptOwnerType,
  OutputManuscriptStructuredSnapshot
} from "../types";
import type { EntityId } from "../types/common";
import type {
  SharedManuscriptSession,
  SharedManuscriptSessionHandle
} from "../types/sharedManuscriptSession";
import type { ManuscriptSwitchReason } from "../types/manuscriptSwitch";
import { MANUSCRIPT_SWITCH_ERROR_CODES } from "../types/manuscriptSwitch";
import { fileRefService, getSafeManuscriptBasename } from "./fileRefService";
import { resolveMountedManuscriptLifecycleDecision } from "./fileRefOwnerValidator";
import type {
  FormalSwitchError,
  FormalSwitchRecoveryEvidence,
  FormalSwitchSnapshot
} from "./formalSwitchEngine";
import { tryAcquireCanonicalFormalSwitchOwnerOperation } from "./experimentManuscriptOwnerOperationGate";
import { manuscriptBindingService } from "./manuscriptBindingService";
import {
  buildCanonicalFormalSwitchArchiveCandidate,
  buildCanonicalFormalSwitchOldCurrentSettlement
} from "./canonicalFormalSwitchArchiveConvergence";
import { convergeCanonicalFormalSwitchRuntime } from "./canonicalFormalSwitchRuntimeConvergence";
import { getManuscriptOutlineDescriptor } from "./manuscriptOutlineDescriptorRegistry";
import { createOperationLog } from "./operationLogService";
import { outputManuscriptFileAwareService } from "./outputManuscriptFileAwareService";
import { outputManuscriptStructuredSnapshotService } from "./outputManuscriptStructuredSnapshotService";
import { outputRawManuscriptService } from "./outputRawManuscriptService";
import {
  createReferenceOwnerFormalSwitchProductionBridge,
  type ReferenceOwnerCanonicalAdapter,
  type ReferenceOwnerProductionProvider
} from "./referenceOwnerFormalSwitchProductionBridge";
import { publishRefreshEvent } from "./refreshEventService";

interface OutputFormalSwitchSnapshot extends FormalSwitchSnapshot {
  ownerType: OutputManuscriptOwnerType;
  channel: "primary";
  binding: ManuscriptBinding;
  currentFile: FileRef;
  defaultFile: FileRef;
  targetFile: FileRef;
  currentSession: SharedManuscriptSession;
  targetSession: SharedManuscriptSession;
  currentSessionHandle: SharedManuscriptSessionHandle;
  targetSessionHandle: SharedManuscriptSessionHandle;
  currentRuntimeConsumerId: string;
  targetRuntimeConsumerId: string;
  ownerSnapshot: OutputManuscriptStructuredSnapshot;
  ownerProjectionIdentity: string;
  replacements: readonly {
    stableKey: string;
    action: "set" | "clear";
    value?: string;
  }[];
}

type OutputCanonicalPreflight =
  | {
      status: "ready";
      preflightToken: string;
      operationId: string;
      expiresAt: string;
      diagnostics: readonly { code: string }[];
    }
  | { status: "error"; error: FormalSwitchError };

type OutputCanonicalConfirm =
  | {
      status: "success";
      operationId: string;
      sessionKey: string;
      warnings: string[];
    }
  | { status: "canceled"; operationId: string }
  | { status: "error"; error: FormalSwitchError };

interface OutputPreflightRuntimeInput {
  currentSessionHandle: SharedManuscriptSessionHandle;
  targetSessionHandle: SharedManuscriptSessionHandle;
  targetFileRefId: EntityId;
}

export interface OutputManuscriptFormalSwitchDependencies {
  fileAware: typeof outputManuscriptFileAwareService;
}

const defaultDependencies: OutputManuscriptFormalSwitchDependencies = {
  fileAware: outputManuscriptFileAwareService
};

function now() {
  return new Date().toISOString();
}

function createId(prefix: string) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

function hashText(text: string) {
  const bytes = new TextEncoder().encode(text);
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}

function byteLength(text: string) {
  return new TextEncoder().encode(text).byteLength;
}

function refreshKey(ownerType: OutputManuscriptOwnerType) {
  switch (ownerType) {
    case "resultItem": return "output.resultItem.changed" as const;
    case "finding": return "output.finding.changed" as const;
    case "outputCandidate": return "output.candidate.changed" as const;
    case "outputGap": return "output.gap.changed" as const;
    case "researchOutput": return "output.researchOutput.changed" as const;
  }
}

function message(result: unknown, fallback: string) {
  if (result && typeof result === "object" && "error" in result) {
    const error = result.error;
    if (error && typeof error === "object" && "message" in error) {
      return String(error.message);
    }
  }
  return fallback;
}

function ownerProjectionIdentity(snapshot: OutputManuscriptStructuredSnapshot) {
  return hashText(JSON.stringify(snapshot));
}

function sameFile(expected: FileRef, actual: FileRef | undefined) {
  return Boolean(
    actual &&
      !actual.deletedAt &&
      actual.id === expected.id &&
      actual.ownerType === expected.ownerType &&
      actual.ownerId === expected.ownerId &&
      actual.manuscriptChannel === expected.manuscriptChannel &&
      actual.resourceKind === expected.resourceKind &&
      actual.fileRole === expected.fileRole &&
      actual.locationMode === expected.locationMode &&
      actual.pathIdentityKey === expected.pathIdentityKey
  );
}

function failure(
  operationId: string,
  stage: FormalSwitchError["stage"],
  causeCode: string,
  recoveryRequired = false
): FormalSwitchError {
  const code = recoveryRequired
    ? "OUTPUT_MANUSCRIPT_FORMAL_SWITCH_RECOVERY_REQUIRED"
    : "OUTPUT_MANUSCRIPT_FORMAL_SWITCH_STALE";
  return {
    code,
    errorCode: code,
    message: causeCode,
    stage,
    causeCode,
    recoverability: recoveryRequired ? "recovery-required" : "retry",
    recoveryRequired,
    operationId,
    provenance: {
      frontendProvenance: "outputs_formal_switch_canonical_provider_v1",
      rustProvenance: "canonical_formal_switch_engine_v1",
      schemaProvenance: "schema-v53"
    },
    sideEffectSummary: {
      oldCurrentWritten: recoveryRequired,
      targetWritten: false,
      databaseCommitted: false,
      sessionActivated: false
    }
  };
}

function canonicalError(causeCode: string, operationId = createId("outputs-formal-switch")) {
  return { status: "error" as const, error: failure(operationId, "preflight", causeCode) };
}

function parseRuntimeInput(value: string): OutputPreflightRuntimeInput {
  const input = JSON.parse(value) as Partial<OutputPreflightRuntimeInput>;
  if (
    typeof input.currentSessionHandle !== "string" ||
    typeof input.targetSessionHandle !== "string" ||
    typeof input.targetFileRefId !== "string"
  ) {
    throw new Error("OUTPUT_MANUSCRIPT_FORMAL_SWITCH_RUNTIME_INPUT_INVALID");
  }
  return input as OutputPreflightRuntimeInput;
}

function exactSession(
  handle: SharedManuscriptSessionHandle,
  ownerType: OutputManuscriptOwnerType,
  ownerId: EntityId,
  role: "current" | "independent",
  fileRefId: EntityId
) {
  const session = outputRawManuscriptService.getSession(
    handle,
    ownerType,
    ownerId,
    role
  );
  if (
    !session ||
    session.owner.channel !== "primary" ||
    session.file.kind !== "durable" ||
    session.file.fileRefId !== fileRefId ||
    !session.baseline ||
    session.dirty ||
    session.recoveryRequired ||
    session.saveStatus === "saving"
  ) {
    throw new Error("OUTPUT_MANUSCRIPT_FORMAL_SWITCH_RUNTIME_IDENTITY_INVALID");
  }
  return session;
}

function targetCandidate(ownerType: OutputManuscriptOwnerType, rawMarkdown: string) {
  return buildCanonicalFormalSwitchArchiveCandidate({
    rawMarkdown,
    descriptorLookupIdentity: { ownerType, channel: "primary" }
  });
}

function canonicalOldCurrentPost(snapshot: OutputFormalSwitchSnapshot) {
  const descriptor = getManuscriptOutlineDescriptor({
    ownerType: snapshot.ownerType,
    channel: "primary"
  });
  const structuredValues = new Map(
    snapshot.ownerSnapshot.structuredSummary.map((item) => [item.key, item.value])
  );
  const values = Object.fromEntries(descriptor.fields.map((field, index) => [
    field.stableKey,
    index === 0
      ? snapshot.ownerSnapshot.briefDescription
      : structuredValues.get(field.stableKey)
  ]));
  return buildCanonicalFormalSwitchOldCurrentSettlement({
    currentRawMarkdown: snapshot.currentRawText,
    descriptorLookupIdentity: {
      ownerType: snapshot.ownerType,
      channel: "primary"
    },
    currentStructuredValues: values
  }).expectedPostText;
}

async function activateCurrent(
  ownerType: OutputManuscriptOwnerType,
  ownerId: EntityId,
  targetFileRefId: EntityId
) {
  return convergeCanonicalFormalSwitchRuntime({
    ownerType,
    ownerId,
    channel: "primary",
    targetFileRefId,
    consumerId: `outputs-formal-switch:${ownerType}:${ownerId}:primary`,
    openCurrent: async (consumerId) => {
      const opened = await outputRawManuscriptService.openCurrent(
        ownerType,
        ownerId,
        consumerId
      );
      return opened.status === "success" && "sessionKey" in opened && "session" in opened
        ? { status: "success", sessionKey: opened.sessionKey, session: opened.session }
        : { status: opened.status };
    }
  });
}

function createOutputFormalSwitchAdapter(
  ownerType: OutputManuscriptOwnerType
): ReferenceOwnerCanonicalAdapter<
  OutputFormalSwitchSnapshot,
  OutputCanonicalPreflight,
  OutputCanonicalConfirm
> {
  return {
    ownerType,
    async resolveLifecycleEligibility(ownerId) {
      const decision = await resolveMountedManuscriptLifecycleDecision({
        ownerType,
        ownerId,
        manuscriptChannel: "primary"
      });
      return decision.reasonCode
        ? { canSwitch: decision.canSwitch, reasonCode: decision.reasonCode }
        : { canSwitch: decision.canSwitch };
    },
    operationPrefix: `${ownerType}-primary-formal-switch`,
    codes: {
      inProgress: "OUTPUT_MANUSCRIPT_FORMAL_SWITCH_IN_PROGRESS",
      stale: "OUTPUT_MANUSCRIPT_FORMAL_SWITCH_STALE",
      recovery: "OUTPUT_MANUSCRIPT_FORMAL_SWITCH_RECOVERY_REQUIRED",
      writeback: "OUTPUT_MANUSCRIPT_FORMAL_SWITCH_SETTLEMENT_FAILED",
      transaction: "OUTPUT_MANUSCRIPT_FORMAL_SWITCH_TRANSACTION_FAILED",
      postVerify: "OUTPUT_MANUSCRIPT_FORMAL_SWITCH_POST_VERIFY_FAILED",
      activation: "OUTPUT_MANUSCRIPT_FORMAL_SWITCH_ACTIVATION_FAILED"
    },
    now,
    createId,
    acquire(ownerId) {
      return tryAcquireCanonicalFormalSwitchOwnerOperation(ownerType, ownerId);
    },
    async resolveSnapshot(ownerId, runtimeInputJson) {
      try {
        const runtimeInput = parseRuntimeInput(runtimeInputJson);
        const binding = await manuscriptBindingService.getBindingByOwner(
          ownerType,
          ownerId,
          "primary"
        );
        if (
          !binding ||
          binding.deletedAt ||
          binding.ownerType !== ownerType ||
          binding.ownerId !== ownerId ||
          binding.manuscriptChannel !== "primary" ||
          !binding.currentFileRefId ||
          !binding.defaultManuscriptFileRefId
        ) {
          return canonicalError("OUTPUT_MANUSCRIPT_FORMAL_SWITCH_BINDING_INVALID");
        }
        if (binding.currentFileRefId === runtimeInput.targetFileRefId) {
          return canonicalError("OUTPUT_MANUSCRIPT_FORMAL_SWITCH_TARGET_ALREADY_CURRENT");
        }
        const [currentFile, defaultFile, targetFile] = await Promise.all([
          fileRefService.getById(binding.currentFileRefId),
          fileRefService.getById(binding.defaultManuscriptFileRefId),
          fileRefService.getById(runtimeInput.targetFileRefId)
        ]);
        if (!currentFile || !defaultFile || !targetFile) {
          return canonicalError("OUTPUT_MANUSCRIPT_FORMAL_SWITCH_FILE_REF_MISSING");
        }
        for (const file of [currentFile, defaultFile, targetFile]) {
          if (
            file.deletedAt ||
            file.ownerType !== ownerType ||
            file.ownerId !== ownerId ||
            file.manuscriptChannel !== "primary" ||
            file.resourceKind !== "file" ||
            file.fileRole !== "manuscript" ||
            file.fileType !== "markdown"
          ) {
            return canonicalError("OUTPUT_MANUSCRIPT_FORMAL_SWITCH_FILE_REF_INVALID");
          }
        }
        const currentSession = exactSession(
          runtimeInput.currentSessionHandle,
          ownerType,
          ownerId,
          "current",
          currentFile.id
        );
        const targetSession = exactSession(
          runtimeInput.targetSessionHandle,
          ownerType,
          ownerId,
          "independent",
          targetFile.id
        );
        const candidate = targetCandidate(ownerType, targetSession.baseline!.rawText);
        if (!candidate.ok) return canonicalError(candidate.error.code);
        const ownerSnapshot = await outputManuscriptStructuredSnapshotService.get(
          ownerType,
          ownerId,
          getSafeManuscriptBasename(currentFile.path) || "current.md"
        );
        return {
          ownerType,
          ownerId,
          channel: "primary",
          bindingId: binding.id,
          currentFileRefId: currentFile.id,
          defaultFileRefId: defaultFile.id,
          targetFileRefId: targetFile.id,
          currentFileName: getSafeManuscriptBasename(currentFile.path) || "current.md",
          defaultFileName: getSafeManuscriptBasename(defaultFile.path) || "default.md",
          targetFileName: getSafeManuscriptBasename(targetFile.path) || "target.md",
          targetLocationMode: targetFile.locationMode,
          currentRevision: currentSession.baseline!.revision,
          targetRevision: targetSession.baseline!.revision,
          currentRawText: currentSession.baseline!.rawText,
          targetRawText: targetSession.baseline!.rawText,
          replacements: candidate.orderedReplacementDto.orderedReplacements,
          diagnostics: candidate.orderedReplacementDto.diagnostics,
          binding,
          currentFile,
          defaultFile,
          targetFile,
          currentSession,
          targetSession,
          currentSessionHandle: runtimeInput.currentSessionHandle,
          targetSessionHandle: runtimeInput.targetSessionHandle,
          currentRuntimeConsumerId:
            currentSession.consumerHandle ?? runtimeInput.currentSessionHandle,
          targetRuntimeConsumerId:
            targetSession.consumerHandle ?? runtimeInput.targetSessionHandle,
          ownerSnapshot,
          ownerProjectionIdentity: ownerProjectionIdentity(ownerSnapshot)
        };
      } catch (error) {
        return canonicalError(
          error instanceof Error
            ? error.message
            : "OUTPUT_MANUSCRIPT_FORMAL_SWITCH_PREFLIGHT_FAILED"
        );
      }
    },
    isSnapshot(value): value is OutputFormalSwitchSnapshot {
      return (
        (value as Partial<OutputFormalSwitchSnapshot>).ownerType === ownerType &&
        (value as Partial<OutputFormalSwitchSnapshot>).channel === "primary"
      );
    },
    ready(snapshot, preflightToken, operationId, expiresAt) {
      return {
        status: "ready",
        preflightToken,
        operationId,
        expiresAt,
        diagnostics: snapshot.diagnostics
      };
    },
    async revalidateIdentityAndRevision(snapshot) {
      const [binding, currentFile, defaultFile, targetFile, ownerSnapshot] =
        await Promise.all([
          manuscriptBindingService.getBindingByOwner(ownerType, snapshot.ownerId, "primary"),
          fileRefService.getById(snapshot.currentFileRefId),
          fileRefService.getById(snapshot.defaultFileRefId),
          fileRefService.getById(snapshot.targetFileRefId),
          outputManuscriptStructuredSnapshotService.get(
            ownerType,
            snapshot.ownerId,
            snapshot.currentFileName
          )
        ]);
      if (
        ownerProjectionIdentity(ownerSnapshot) !== snapshot.ownerProjectionIdentity
      ) {
        throw new Error("OUTPUT_MANUSCRIPT_FORMAL_SWITCH_OWNER_CHANGED");
      }
      if (
        !binding ||
        binding.deletedAt ||
        binding.id !== snapshot.bindingId ||
        binding.currentFileRefId !== snapshot.currentFileRefId ||
        binding.defaultManuscriptFileRefId !== snapshot.defaultFileRefId ||
        binding.manuscriptChannel !== "primary"
      ) {
        throw new Error("OUTPUT_MANUSCRIPT_FORMAL_SWITCH_BINDING_CHANGED");
      }
      if (
        !sameFile(snapshot.currentFile, currentFile) ||
        !sameFile(snapshot.defaultFile, defaultFile) ||
        !sameFile(snapshot.targetFile, targetFile)
      ) {
        throw new Error("OUTPUT_MANUSCRIPT_FORMAL_SWITCH_FILE_IDENTITY_CHANGED");
      }
      const [currentReload, targetReload] = await Promise.all([
        outputRawManuscriptService.reload(
          snapshot.currentSessionHandle,
          ownerType,
          snapshot.ownerId,
          "current"
        ),
        outputRawManuscriptService.reload(
          snapshot.targetSessionHandle,
          ownerType,
          snapshot.ownerId,
          "independent"
        )
      ]);
      if (
        !["success", "no-op"].includes(currentReload.status) ||
        !["success", "no-op"].includes(targetReload.status)
      ) {
        throw new Error("OUTPUT_MANUSCRIPT_FORMAL_SWITCH_RUNTIME_REFRESH_FAILED");
      }
      const currentSession = exactSession(
        snapshot.currentSessionHandle,
        ownerType,
        snapshot.ownerId,
        "current",
        snapshot.currentFileRefId
      );
      const targetSession = exactSession(
        snapshot.targetSessionHandle,
        ownerType,
        snapshot.ownerId,
        "independent",
        snapshot.targetFileRefId
      );
      if (
        currentSession.baseline!.revision !== snapshot.currentRevision ||
        targetSession.baseline!.revision !== snapshot.targetRevision
      ) {
        throw new Error("OUTPUT_MANUSCRIPT_FORMAL_SWITCH_PHYSICAL_REVISION_CHANGED");
      }
      const candidate = targetCandidate(ownerType, targetSession.baseline!.rawText);
      if (!candidate.ok) throw new Error(candidate.error.code);
      if (
        hashText(JSON.stringify(candidate.orderedReplacementDto.orderedReplacements)) !==
        hashText(JSON.stringify(snapshot.replacements))
      ) {
        throw new Error("OUTPUT_MANUSCRIPT_FORMAL_SWITCH_REPLACEMENT_CHANGED");
      }
      return {
        ...snapshot,
        binding,
        currentFile: currentFile!,
        defaultFile: defaultFile!,
        targetFile: targetFile!,
        currentSession,
        targetSession,
        currentRawText: currentSession.baseline!.rawText,
        targetRawText: targetSession.baseline!.rawText,
        ownerSnapshot
      };
    },
    isRevalidatedSnapshot(value): value is OutputFormalSwitchSnapshot {
      return (
        (value as Partial<OutputFormalSwitchSnapshot>).ownerType === ownerType &&
        (value as Partial<OutputFormalSwitchSnapshot>).channel === "primary"
      );
    },
    async buildPreparedEvidence(snapshot, operationId, occurredAt) {
      const expectedPost = canonicalOldCurrentPost(snapshot);
      const evidence: FormalSwitchRecoveryEvidence = {
        operationId,
        ownerType,
        ownerId: snapshot.ownerId,
        channel: "primary",
        phase: "prepared",
        oldCurrentFileRefId: snapshot.currentFileRefId,
        defaultFileRefId: snapshot.defaultFileRefId,
        targetFileRefId: snapshot.targetFileRefId,
        oldCurrentFileName: snapshot.currentFileName,
        defaultFileName: snapshot.defaultFileName,
        targetFileName: snapshot.targetFileName,
        oldCurrentPreRevision: snapshot.currentRevision,
        oldCurrentPreDigest: hashText(snapshot.currentRawText),
        oldCurrentExpectedPostDigest: hashText(expectedPost),
        targetRevision: snapshot.targetRevision,
        targetDigest: hashText(snapshot.targetRawText),
        prepareInput: Object.freeze({
          operationId,
          ownerType,
          ownerId: snapshot.ownerId,
          channel: "primary",
          occurredAt,
          replacementDigest: hashText(JSON.stringify(snapshot.replacements)),
          oldCurrentExpectedPostByteLength: byteLength(expectedPost),
          targetByteLength: byteLength(snapshot.targetRawText)
        })
      };
      return { evidence, expectedPost };
    },
    success(snapshot, operationId, sessionKey) {
      return {
        status: "success",
        operationId,
        sessionKey,
        warnings: (snapshot.diagnostics ?? []).map((diagnostic) => diagnostic.code)
      };
    },
    recoveryRequired(error) {
      return { status: "error", error };
    },
    error(error) {
      return { status: "error", error };
    },
    canceled(operationId) {
      return { status: "canceled", operationId };
    },
    publish(snapshot, operationId) {
      publishRefreshEvent({
        id: `output-manuscript-formal-switch-${operationId}`,
        keys: [refreshKey(ownerType), "fileRef.changed", "operationLog.changed"],
        affectedEntities: [
          { type: ownerType, id: snapshot.ownerId, relation: "updated" },
          { type: "fileRef", id: snapshot.targetFileRefId, relation: "selected" }
        ],
        affectedScopes: [{
          module: "output",
          projectId: snapshot.ownerSnapshot.projectId,
          reason: "Outputs formal manuscript switched."
        }],
        source: "service.write",
        operation: "output.manuscript.formalSwitch",
        reason: "Outputs structured state and current Binding committed canonically.",
        writeFeedbackStatus: "success",
        createdAt: now()
      });
    },
    async recordPrePreparedFailure(details) {
      await createOperationLog({
        id: details.operationId,
        operationType: "custom",
        source: "user",
        module: "output",
        status: "error",
        riskLevel: "medium",
        target: { entityType: ownerType, entityId: details.ownerId },
        summary: `Outputs ${ownerType} formal manuscript switch failed before recovery preparation`,
        relatedEntities: [],
        errors: [
          `stage=${details.stage}`,
          `cause=${details.causeCode}`,
          `frontend=${details.provenance.frontendProvenance}`,
          `rust=${details.provenance.rustProvenance}`,
          `schema=${details.provenance.schemaProvenance}`
        ],
        isRecoverable: false,
        refreshKeys: ["operationLog.changed"]
      });
    }
  };
}

function createOutputReferenceOwnerProvider(
  ownerType: OutputManuscriptOwnerType
): ReferenceOwnerProductionProvider<OutputFormalSwitchSnapshot> {
  return {
    buildBeginInput({ snapshot, evidence, expectedPost, operationId, occurredAt, replacements }) {
      return {
        ownerType,
        ownerId: snapshot.ownerId,
        manuscriptChannel: "primary",
        operationId,
        occurredAt,
        occurredAtEpochMs: Date.parse(occurredAt),
        oldCurrentFileRefId: snapshot.currentFileRefId,
        defaultFileRefId: snapshot.defaultFileRefId,
        targetFileRefId: snapshot.targetFileRefId,
        oldCurrentPhysicalRevision: snapshot.currentRevision,
        targetPhysicalRevision: snapshot.targetRevision,
        expectedOldCurrentPostText: expectedPost,
        replacements: replacements.map((item) => ({
          stableKey: item.stableKey,
          ...(item.action === "set" ? { value: item.value } : {})
        })),
        previewSnapshotIdentity: [
          operationId,
          ownerType,
          snapshot.ownerId,
          snapshot.currentRevision,
          snapshot.targetRevision,
          snapshot.ownerProjectionIdentity,
          evidence.oldCurrentExpectedPostDigest,
          hashText(JSON.stringify(snapshot.replacements))
        ].join(":"),
        currentRuntime: {
          actualRuntimeHandle: snapshot.currentSessionHandle,
          runtimeGeneration: snapshot.currentSession.sessionGeneration,
          runtimeConsumerId: snapshot.currentRuntimeConsumerId,
          logicalIdentity: `${ownerType}:${snapshot.ownerId}:primary:current:${snapshot.currentFileRefId}`,
          fileRefId: snapshot.currentFileRefId
        },
        targetRuntime: {
          actualRuntimeHandle: snapshot.targetSessionHandle,
          runtimeGeneration: snapshot.targetSession.sessionGeneration,
          runtimeConsumerId: snapshot.targetRuntimeConsumerId,
          logicalIdentity: `${ownerType}:${snapshot.ownerId}:primary:independent:${snapshot.targetFileRefId}`,
          fileRefId: snapshot.targetFileRefId
        }
      };
    },
    activate(snapshot) {
      return activateCurrent(ownerType, snapshot.ownerId, snapshot.targetFileRefId);
    },
    activateRecovered(ticket) {
      if (ticket.ownerType !== ownerType || ticket.manuscriptChannel !== "primary") {
        throw new Error("OUTPUT_MANUSCRIPT_FORMAL_SWITCH_RECOVERY_IDENTITY_MISMATCH");
      }
      return activateCurrent(ownerType, ticket.ownerId, ticket.targetFileRefId);
    },
    readActivatedRuntime({ sessionKey, ticket }) {
      const session = outputRawManuscriptService.getSession(
        sessionKey,
        ownerType,
        ticket.ownerId,
        "current"
      );
      if (!session?.baseline || session.file.kind !== "durable") return undefined;
      return {
        actualRuntimeHandle: sessionKey,
        runtimeGeneration: session.sessionGeneration,
        runtimeConsumerId: session.consumerHandle ?? sessionKey,
        logicalIdentity: ticket.activationLogicalIdentity,
        fileRefId: session.file.fileRefId,
        authoritativePhysicalRevision: session.baseline.revision,
        authoritativeRawByteLength: byteLength(session.baseline.rawText),
        exactActive:
          ticket.ownerType === ownerType &&
          ticket.manuscriptChannel === "primary" &&
          session.owner.ownerType === ownerType &&
          session.owner.ownerId === ticket.ownerId &&
          session.owner.channel === "primary" &&
          session.windowRole === "current" &&
          session.file.fileRefId === ticket.targetFileRefId
      };
    }
  };
}

export function createOutputManuscriptFormalSwitchService(
  ownerType: OutputManuscriptOwnerType,
  ownerId: EntityId,
  dependencies: OutputManuscriptFormalSwitchDependencies = defaultDependencies
) {
  const adapter = createOutputFormalSwitchAdapter(ownerType);
  const provider = createOutputReferenceOwnerProvider(ownerType);
  const canonicalBridge = createReferenceOwnerFormalSwitchProductionBridge({
    adapter,
    provider,
    manuscriptChannel: "primary"
  });

  async function decodeTarget(
    current: OutputManuscriptDocument,
    targetFileRefId: EntityId,
    requestToken: number
  ) {
    const target = await dependencies.fileAware.readTargetForFormalSwitch({
      ownerType,
      ownerId,
      channel: "primary",
      fileRefId: targetFileRefId,
      requestToken
    });
    if (target.status !== "success") {
      return { status: "error" as const, error: message(target, "Target manuscript read failed.") };
    }
    const candidate = targetCandidate(ownerType, target.data.rawMarkdown);
    if (!candidate.ok) {
      return {
        status: "error" as const,
        error: `OUTPUT_MANUSCRIPT_OUTLINE_${candidate.error.stage.toUpperCase()}_${candidate.error.code}`
      };
    }
    return { status: "success" as const, target: target.data, candidate };
  }

  async function cleanupTarget(handle: SharedManuscriptSessionHandle) {
    if (!outputRawManuscriptService.getSession(handle, ownerType, ownerId, "independent")) {
      return;
    }
    await outputRawManuscriptService.close(
      handle,
      ownerType,
      ownerId,
      "independent",
      "discard"
    );
  }

  async function continuePending(operationId: string) {
    return canonicalBridge.continueRecovery(operationId, ownerId);
  }

  return Object.freeze({
    ownerType,
    ownerId,
    manuscriptChannel: "primary" as const,
    async preflight(
      current: OutputManuscriptDocument,
      targetFileRefId: EntityId,
      requestToken: number
    ) {
      const result = await decodeTarget(current, targetFileRefId, requestToken);
      if (result.status !== "success") {
        return {
          status: "error" as const,
          error: {
            code: MANUSCRIPT_SWITCH_ERROR_CODES.targetContentInvalid,
            message: result.error
          },
          warnings: [] as string[],
          requestToken
        };
      }
      return {
        status: "success" as const,
        requestToken,
        preview: {
          currentFileRefId: current.fileRefId,
          currentFilename: current.filename,
          targetFileRefId,
          targetFilename: result.target.filename,
          importedFieldCount: result.candidate.setFieldCount,
          missingFieldCount: result.candidate.clearFieldCount,
          missingFieldKeys: [...result.candidate.clearedStableKeys],
          warnings: result.candidate.orderedReplacementDto.diagnostics.map(
            (diagnostic) => diagnostic.code
          )
        }
      };
    },
    async commit(input: {
      current: OutputManuscriptDocument;
      currentSessionHandle: SharedManuscriptSessionHandle;
      targetFileRefId: EntityId;
      switchReason: ManuscriptSwitchReason;
      requestToken: number;
    }) {
      if (input.switchReason !== "user") {
        return canonicalError("OUTPUT_MANUSCRIPT_FORMAL_SWITCH_REASON_INVALID");
      }
      const pending = await canonicalBridge.listRecoveries(ownerId);
      if (pending.length > 0) {
        return continuePending(pending[0].operationId);
      }
      const openedTarget = await outputRawManuscriptService.openIndependent(
        ownerType,
        ownerId,
        input.targetFileRefId,
        `outputs-formal-switch-target:${ownerType}:${ownerId}:${input.requestToken}`
      );
      if (openedTarget.status !== "success" || !("sessionKey" in openedTarget)) {
        return canonicalError(message(openedTarget, "OUTPUT_MANUSCRIPT_FORMAL_SWITCH_TARGET_OPEN_FAILED"));
      }
      const targetHandle = openedTarget.sessionKey;
      const runtimeInput: OutputPreflightRuntimeInput = {
        currentSessionHandle: input.currentSessionHandle,
        targetSessionHandle: targetHandle,
        targetFileRefId: input.targetFileRefId
      };
      const preflight = await canonicalBridge.preflight(
        ownerId,
        JSON.stringify(runtimeInput)
      );
      if (preflight.status !== "ready") {
        await cleanupTarget(targetHandle);
        return preflight;
      }
      let confirmed = await canonicalBridge.confirm(preflight.preflightToken);
      if (confirmed.status === "error" && confirmed.error.recoveryRequired) {
        confirmed = await continuePending(confirmed.error.operationId);
      }
      if (confirmed.status !== "success") {
        await cleanupTarget(targetHandle);
      }
      return confirmed;
    },
    listRecoveries() {
      return canonicalBridge.listRecoveries(ownerId);
    },
    continueRecovery(operationId: string) {
      return continuePending(operationId);
    },
    safeCancelRecovery(operationId: string) {
      return canonicalBridge.safeCancel(operationId, ownerId);
    }
  });
}

export type OutputManuscriptFormalSwitchService =
  ReturnType<typeof createOutputManuscriptFormalSwitchService>;
