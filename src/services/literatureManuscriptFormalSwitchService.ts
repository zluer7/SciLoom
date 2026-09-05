import type {
  EntityId,
  FileRef,
  Literature,
  ManuscriptBinding,
  ManuscriptChannel,
  ManuscriptDirtyDecision
} from "../types";
import type {
  SharedManuscriptSession,
  SharedManuscriptSessionHandle
} from "../types/sharedManuscriptSession";
import { literatureRepository } from "../repositories/literatureRepository";
import { createManuscriptRequestTokenController } from "./manuscriptRequestTokenController";
import { manuscriptListService } from "./manuscriptListService";
import {
  literatureManuscriptService,
  type LiteratureTargetManuscriptDocument
} from "./literatureManuscriptService";
import {
  literatureRawManuscriptService,
  type LiteratureManuscriptChannel
} from "./literatureRawManuscriptService";
import { fileRefService, getSafeManuscriptBasename } from "./fileRefService";
import { resolveMountedManuscriptLifecycleDecision } from "./fileRefOwnerValidator";
import { manuscriptBindingService } from "./manuscriptBindingService";
import {
  buildCanonicalFormalSwitchArchiveCandidate,
  buildCanonicalFormalSwitchOldCurrentSettlement
} from "./canonicalFormalSwitchArchiveConvergence";
import { convergeCanonicalFormalSwitchRuntime } from "./canonicalFormalSwitchRuntimeConvergence";
import { getManuscriptOutlineDescriptor } from "./manuscriptOutlineDescriptorRegistry";
import type { ManuscriptOutlineOrderedReplacement } from "./manuscriptOutlineParser";
import {
  type FormalSwitchError,
  type FormalSwitchRecoveryEvidence,
  type FormalSwitchSnapshot
} from "./formalSwitchEngine";
import {
  createReferenceOwnerFormalSwitchProductionBridge,
  type ReferenceOwnerCanonicalAdapter,
  type ReferenceOwnerProductionProvider
} from "./referenceOwnerFormalSwitchProductionBridge";
import { tryAcquireCanonicalFormalSwitchOwnerOperation } from "./experimentManuscriptOwnerOperationGate";
import { createOperationLog } from "./operationLogService";
import { publishRefreshEvent } from "./refreshEventService";

interface LiteratureFormalSwitchSnapshot extends FormalSwitchSnapshot {
  ownerType: "literature";
  channel: LiteratureManuscriptChannel;
  literature: Literature;
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
  replacements: readonly ManuscriptOutlineOrderedReplacement[];
  ownerProjectionIdentity: string;
}

type LiteratureFormalSwitchPreflight =
  | {
      status: "ready";
      preflightToken: string;
      operationId: string;
      expiresAt: string;
      diagnostics: readonly { code: string }[];
    }
  | { status: "error"; error: FormalSwitchError };

type LiteratureFormalSwitchConfirm =
  | { status: "success"; operationId: string; sessionKey: string }
  | { status: "canceled"; operationId: string }
  | { status: "error"; error: FormalSwitchError };

interface LiteraturePreflightRuntimeInput {
  currentSessionHandle: SharedManuscriptSessionHandle;
  targetSessionHandle: SharedManuscriptSessionHandle;
  targetFileRefId: EntityId;
}

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

function ownerProjectionIdentity(literature: Literature) {
  const { updatedAt: _updatedAt, ...durableState } = literature;
  return hashText(JSON.stringify(durableState));
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
    ? "LITERATURE_FORMAL_SWITCH_RECOVERY_REQUIRED"
    : "LITERATURE_FORMAL_SWITCH_STALE";
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
      frontendProvenance: "literature_formal_switch_canonical_provider_v1",
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

function errorResult(causeCode: string, operationId = createId("literature-formal-switch")) {
  return {
    status: "error" as const,
    error: failure(operationId, "preflight", causeCode)
  };
}

function parseRuntimeInput(value: string): LiteraturePreflightRuntimeInput {
  const input = JSON.parse(value) as Partial<LiteraturePreflightRuntimeInput>;
  if (
    typeof input.currentSessionHandle !== "string" ||
    typeof input.targetSessionHandle !== "string" ||
    typeof input.targetFileRefId !== "string"
  ) {
    throw new Error("LITERATURE_FORMAL_SWITCH_RUNTIME_INPUT_INVALID");
  }
  return input as LiteraturePreflightRuntimeInput;
}

function exactSession(
  handle: SharedManuscriptSessionHandle,
  ownerId: EntityId,
  channel: LiteratureManuscriptChannel,
  role: "current" | "independent",
  fileRefId: EntityId
) {
  const session = literatureRawManuscriptService.getSession(handle, channel, role);
  if (
    !session ||
    session.owner.ownerId !== ownerId ||
    session.file.kind !== "durable" ||
    session.file.fileRefId !== fileRefId ||
    !session.baseline ||
    session.dirty ||
    session.recoveryRequired ||
    session.saveStatus === "saving"
  ) {
    throw new Error("LITERATURE_FORMAL_SWITCH_RUNTIME_IDENTITY_INVALID");
  }
  return session;
}

function targetStructuredCandidate(
  channel: LiteratureManuscriptChannel,
  rawMarkdown: string
) {
  return buildCanonicalFormalSwitchArchiveCandidate({
    rawMarkdown,
    descriptorLookupIdentity: { ownerType: "literature", channel }
  });
}

function canonicalOldCurrentPost(snapshot: LiteratureFormalSwitchSnapshot) {
  const descriptor = getManuscriptOutlineDescriptor({
    ownerType: "literature",
    channel: snapshot.channel
  });
  const values = Object.fromEntries(descriptor.fields.map((field) => {
    if (field.persistenceProjectorIdentity === "literature.abstract") {
      return [field.stableKey, snapshot.literature.abstract];
    }
    const persistenceParts = field.persistenceProjectorIdentity.split(".");
    const customFieldName = persistenceParts[persistenceParts.length - 1];
    return [
      field.stableKey,
      snapshot.literature.customFields?.find(
        (item) => item.name === customFieldName
      )?.value
    ];
  }));
  return buildCanonicalFormalSwitchOldCurrentSettlement({
    currentRawMarkdown: snapshot.currentRawText,
    descriptorLookupIdentity: { ownerType: "literature", channel: snapshot.channel },
    currentStructuredValues: values
  }).expectedPostText;
}

async function activateCurrent(
  literatureId: EntityId,
  channel: LiteratureManuscriptChannel,
  targetFileRefId: EntityId
) {
  return convergeCanonicalFormalSwitchRuntime({
    ownerType: "literature",
    ownerId: literatureId,
    channel,
    targetFileRefId,
    consumerId: `literature-formal-switch:${literatureId}:${channel}`,
    openCurrent: async (consumerId) => {
      const opened = await literatureRawManuscriptService.openCurrent(
        literatureId,
        channel,
        consumerId
      );
      return opened.status === "success" && "sessionKey" in opened && "session" in opened
        ? { status: "success", sessionKey: opened.sessionKey, session: opened.session }
        : { status: opened.status };
    }
  });
}

function createLiteratureFormalSwitchAdapter(
  channel: LiteratureManuscriptChannel
): ReferenceOwnerCanonicalAdapter<
  LiteratureFormalSwitchSnapshot,
  LiteratureFormalSwitchPreflight,
  LiteratureFormalSwitchConfirm
> {
  return {
    ownerType: "literature",
    async resolveLifecycleEligibility(ownerId) {
      const decision = await resolveMountedManuscriptLifecycleDecision({
        ownerType: "literature",
        ownerId,
        manuscriptChannel: channel
      });
      return decision.reasonCode
        ? { canSwitch: decision.canSwitch, reasonCode: decision.reasonCode }
        : { canSwitch: decision.canSwitch };
    },
    operationPrefix: `literature-${channel}-formal-switch`,
    codes: {
      inProgress: "LITERATURE_FORMAL_SWITCH_IN_PROGRESS",
      stale: "LITERATURE_FORMAL_SWITCH_STALE",
      recovery: "LITERATURE_FORMAL_SWITCH_RECOVERY_REQUIRED",
      writeback: "LITERATURE_FORMAL_SWITCH_SETTLEMENT_FAILED",
      transaction: "LITERATURE_FORMAL_SWITCH_TRANSACTION_FAILED",
      postVerify: "LITERATURE_FORMAL_SWITCH_POST_VERIFY_FAILED",
      activation: "LITERATURE_FORMAL_SWITCH_ACTIVATION_FAILED"
    },
    now,
    createId,
    acquire(ownerId) {
      return tryAcquireCanonicalFormalSwitchOwnerOperation("literature", ownerId);
    },
    async resolveSnapshot(ownerId, runtimeInputJson) {
      try {
        const runtimeInput = parseRuntimeInput(runtimeInputJson);
        const [literature, binding, targetFile] = await Promise.all([
          literatureRepository.getById(ownerId),
          manuscriptBindingService.getBindingByOwner(
            "literature",
            ownerId,
            channel
          ),
          fileRefService.getById(runtimeInput.targetFileRefId)
        ]);
        if (!literature || literature.deletedAt) {
          return errorResult("LITERATURE_FORMAL_SWITCH_OWNER_INACTIVE");
        }
        if (
          !binding ||
          binding.deletedAt ||
          binding.ownerType !== "literature" ||
          binding.ownerId !== ownerId ||
          binding.manuscriptChannel !== channel ||
          !binding.currentFileRefId ||
          !binding.defaultManuscriptFileRefId
        ) {
          return errorResult("LITERATURE_FORMAL_SWITCH_BINDING_INVALID");
        }
        if (binding.currentFileRefId === runtimeInput.targetFileRefId) {
          return errorResult("LITERATURE_FORMAL_SWITCH_TARGET_ALREADY_CURRENT");
        }
        const [currentFile, defaultFile] = await Promise.all([
          fileRefService.getById(binding.currentFileRefId),
          fileRefService.getById(binding.defaultManuscriptFileRefId)
        ]);
        if (!currentFile || !defaultFile || !targetFile) {
          return errorResult("LITERATURE_FORMAL_SWITCH_FILE_REF_MISSING");
        }
        for (const file of [currentFile, defaultFile, targetFile]) {
          if (
            file.deletedAt ||
            file.ownerType !== "literature" ||
            file.ownerId !== ownerId ||
            file.manuscriptChannel !== channel ||
            file.resourceKind !== "file" ||
            file.fileRole !== "manuscript" ||
            file.fileType !== "markdown"
          ) {
            return errorResult("LITERATURE_FORMAL_SWITCH_FILE_REF_INVALID");
          }
        }
        const currentSession = exactSession(
          runtimeInput.currentSessionHandle,
          ownerId,
          channel,
          "current",
          currentFile.id
        );
        const targetSession = exactSession(
          runtimeInput.targetSessionHandle,
          ownerId,
          channel,
          "independent",
          targetFile.id
        );
        const targetCandidate = targetStructuredCandidate(
          channel,
          targetSession.baseline!.rawText
        );
        if (!targetCandidate.ok) return errorResult(targetCandidate.error.code);
        const selectedCandidate = targetCandidate;
        return {
          ownerType: "literature",
          ownerId,
          channel,
          bindingId: binding.id,
          currentFileRefId: currentFile.id,
          defaultFileRefId: defaultFile.id,
          targetFileRefId: targetFile.id,
          currentFileName:
            getSafeManuscriptBasename(currentFile.path) ?? "current.md",
          defaultFileName:
            getSafeManuscriptBasename(defaultFile.path) ?? "default.md",
          targetFileName:
            getSafeManuscriptBasename(targetFile.path) ?? "target.md",
          targetLocationMode: targetFile.locationMode,
          currentRevision: currentSession.baseline!.revision,
          targetRevision: targetSession.baseline!.revision,
          currentRawText: currentSession.baseline!.rawText,
          targetRawText: targetSession.baseline!.rawText,
          replacements: selectedCandidate.orderedReplacementDto.orderedReplacements,
          diagnostics: selectedCandidate.orderedReplacementDto.diagnostics,
          literature,
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
          ownerProjectionIdentity: ownerProjectionIdentity(literature)
        };
      } catch (error) {
        return errorResult(
          error instanceof Error
            ? error.message
            : "LITERATURE_FORMAL_SWITCH_PREFLIGHT_FAILED"
        );
      }
    },
    isSnapshot(value): value is LiteratureFormalSwitchSnapshot {
      return (
        (value as Partial<LiteratureFormalSwitchSnapshot>).ownerType ===
          "literature" &&
        (value as Partial<LiteratureFormalSwitchSnapshot>).channel === channel
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
      const [literature, binding, currentFile, defaultFile, targetFile] =
        await Promise.all([
          literatureRepository.getById(snapshot.ownerId),
          manuscriptBindingService.getBindingByOwner(
            "literature",
            snapshot.ownerId,
            channel
          ),
          fileRefService.getById(snapshot.currentFileRefId),
          fileRefService.getById(snapshot.defaultFileRefId),
          fileRefService.getById(snapshot.targetFileRefId)
        ]);
      if (
        !literature ||
        literature.deletedAt ||
        ownerProjectionIdentity(literature) !== snapshot.ownerProjectionIdentity
      ) {
        throw new Error("LITERATURE_FORMAL_SWITCH_OWNER_CHANGED");
      }
      if (
        !binding ||
        binding.deletedAt ||
        binding.id !== snapshot.bindingId ||
        binding.currentFileRefId !== snapshot.currentFileRefId ||
        binding.defaultManuscriptFileRefId !== snapshot.defaultFileRefId ||
        binding.manuscriptChannel !== channel
      ) {
        throw new Error("LITERATURE_FORMAL_SWITCH_BINDING_CHANGED");
      }
      if (
        !sameFile(snapshot.currentFile, currentFile) ||
        !sameFile(snapshot.defaultFile, defaultFile) ||
        !sameFile(snapshot.targetFile, targetFile)
      ) {
        throw new Error("LITERATURE_FORMAL_SWITCH_FILE_IDENTITY_CHANGED");
      }
      const [currentReload, targetReload] = await Promise.all([
        literatureRawManuscriptService.reload(
          snapshot.currentSessionHandle,
          channel,
          "current"
        ),
        literatureRawManuscriptService.reload(
          snapshot.targetSessionHandle,
          channel,
          "independent"
        )
      ]);
      if (
        !["success", "no-op"].includes(currentReload.status) ||
        !["success", "no-op"].includes(targetReload.status)
      ) {
        throw new Error("LITERATURE_FORMAL_SWITCH_RUNTIME_REFRESH_FAILED");
      }
      const currentSession = exactSession(
        snapshot.currentSessionHandle,
        snapshot.ownerId,
        channel,
        "current",
        snapshot.currentFileRefId
      );
      const targetSession = exactSession(
        snapshot.targetSessionHandle,
        snapshot.ownerId,
        channel,
        "independent",
        snapshot.targetFileRefId
      );
      if (
        currentSession.baseline!.revision !== snapshot.currentRevision ||
        targetSession.baseline!.revision !== snapshot.targetRevision
      ) {
        throw new Error("LITERATURE_FORMAL_SWITCH_PHYSICAL_REVISION_CHANGED");
      }
      const targetCandidate = targetStructuredCandidate(
        channel,
        targetSession.baseline!.rawText
      );
      if (!targetCandidate.ok) throw new Error(targetCandidate.error.code);
      const selectedCandidate = targetCandidate;
      if (
        hashText(
          JSON.stringify(selectedCandidate.orderedReplacementDto.orderedReplacements)
        ) !== hashText(JSON.stringify(snapshot.replacements))
      ) {
        throw new Error("LITERATURE_FORMAL_SWITCH_REPLACEMENT_CHANGED");
      }
      return {
        ...snapshot,
        literature,
        binding,
        currentFile: currentFile!,
        defaultFile: defaultFile!,
        targetFile: targetFile!,
        currentSession,
        targetSession,
        currentRawText: currentSession.baseline!.rawText,
        targetRawText: targetSession.baseline!.rawText
      };
    },
    isRevalidatedSnapshot(value): value is LiteratureFormalSwitchSnapshot {
      return (
        (value as Partial<LiteratureFormalSwitchSnapshot>).ownerType ===
          "literature" &&
        (value as Partial<LiteratureFormalSwitchSnapshot>).channel === channel
      );
    },
    async buildPreparedEvidence(snapshot, operationId, occurredAt) {
      const expectedPost = canonicalOldCurrentPost(snapshot);
      const evidence: FormalSwitchRecoveryEvidence = {
        operationId,
        ownerType: "literature",
        ownerId: snapshot.ownerId,
        channel,
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
          ownerId: snapshot.ownerId,
          channel,
          occurredAt,
          replacementDigest: hashText(JSON.stringify(snapshot.replacements)),
          oldCurrentExpectedPostByteLength: byteLength(expectedPost),
          targetByteLength: byteLength(snapshot.targetRawText)
        })
      };
      return { evidence, expectedPost };
    },
    success(_snapshot, operationId, sessionKey) {
      return { status: "success", operationId, sessionKey };
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
        id: `literature-formal-switch-${operationId}`,
        keys: ["literature.changed", "fileRef.changed", "operationLog.changed"],
        affectedEntities: [
          { type: "literature", id: snapshot.ownerId, relation: "updated" },
          { type: "fileRef", id: snapshot.targetFileRefId, relation: "selected" }
        ],
        affectedScopes: [
          {
            module: "literature",
            literatureId: snapshot.ownerId,
            reason: `Literature ${channel} formal manuscript switched.`
          }
        ],
        source: "service.write",
        operation: "literature.manuscript.formalSwitch",
        writeFeedbackStatus: "success",
        reason: "Literature structured state and current binding committed atomically.",
        createdAt: now()
      });
    },
    async recordPrePreparedFailure(details) {
      await createOperationLog({
        id: details.operationId,
        operationType: "custom",
        source: "user",
        module: "literature",
        status: "error",
        riskLevel: "medium",
        target: { entityType: "literature", entityId: details.ownerId },
        summary: `Literature ${channel} formal manuscript switch failed before recovery preparation`,
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

function createLiteratureReferenceOwnerProvider(
  channel: LiteratureManuscriptChannel
): ReferenceOwnerProductionProvider<LiteratureFormalSwitchSnapshot> {
  return {
    buildBeginInput({ snapshot, evidence, expectedPost, operationId, occurredAt, replacements }) {
      return {
        ownerType: "literature",
        ownerId: snapshot.ownerId,
        manuscriptChannel: channel,
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
          snapshot.ownerId,
          channel,
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
          logicalIdentity: `literature:${snapshot.ownerId}:${channel}:current:${snapshot.currentFileRefId}`,
          fileRefId: snapshot.currentFileRefId
        },
        targetRuntime: {
          actualRuntimeHandle: snapshot.targetSessionHandle,
          runtimeGeneration: snapshot.targetSession.sessionGeneration,
          runtimeConsumerId: snapshot.targetRuntimeConsumerId,
          logicalIdentity: `literature:${snapshot.ownerId}:${channel}:independent:${snapshot.targetFileRefId}`,
          fileRefId: snapshot.targetFileRefId
        }
      };
    },
    activate(snapshot) {
      return activateCurrent(snapshot.ownerId, channel, snapshot.targetFileRefId);
    },
    activateRecovered(ticket) {
      if (ticket.manuscriptChannel !== channel) {
        throw new Error("LITERATURE_FORMAL_SWITCH_RECOVERY_CHANNEL_MISMATCH");
      }
      return activateCurrent(ticket.ownerId, channel, ticket.targetFileRefId);
    },
    readActivatedRuntime({ sessionKey, ticket }) {
      const session = literatureRawManuscriptService.getSession(
        sessionKey,
        channel,
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
          ticket.manuscriptChannel === channel &&
          session.owner.ownerType === "literature" &&
          session.owner.ownerId === ticket.ownerId &&
          session.owner.channel === channel &&
          session.windowRole === "current" &&
          session.file.fileRefId === ticket.targetFileRefId
      };
    }
  };
}

export function createLiteratureManuscriptFormalSwitchService(
  literatureId: EntityId,
  channel: ManuscriptChannel
) {
  if (channel !== "literature_outline" && channel !== "dedicated_notes") {
    throw new Error("LITERATURE_MANUSCRIPT_CHANNEL_INVALID");
  }
  const canonicalChannel: LiteratureManuscriptChannel = channel;
  const requests = createManuscriptRequestTokenController();
  const adapter = createLiteratureFormalSwitchAdapter(canonicalChannel);
  const provider = createLiteratureReferenceOwnerProvider(canonicalChannel);
  const canonicalBridge = createReferenceOwnerFormalSwitchProductionBridge({
    adapter,
    provider,
    manuscriptChannel: canonicalChannel
  });
  let disposed = false;

  return Object.freeze({
    ownerType: "literature" as const,
    ownerId: literatureId,
    manuscriptChannel: canonicalChannel,
    async getAvailable() {
      const result = await manuscriptListService.getAvailableManuscripts(
        "literature",
        literatureId,
        canonicalChannel
      );
      return result.status === "success" ? result.items : [];
    },
    selectManuscript(requestToken: number, title: string) {
      return literatureManuscriptService.selectManuscript(
        literatureId,
        canonicalChannel,
        requestToken,
        title
      );
    },
    ensureSelectedManuscript:
      literatureManuscriptService.ensureSelectedManuscript,
    createManagedCopy(
      document: LiteratureTargetManuscriptDocument,
      requestToken: number
    ) {
      return literatureManuscriptService.createManagedCopy(
        document,
        requestToken
      );
    },
    async setCurrent(input: {
      currentSession: SharedManuscriptSession;
      currentSessionHandle: SharedManuscriptSessionHandle;
      targetSessionHandle: SharedManuscriptSessionHandle;
      targetFileRefId: EntityId;
      dirtyDecision?: ManuscriptDirtyDecision;
      confirmedDiscardUnsavedChanges?: boolean;
    }) {
      if (disposed) return null;
      const requestToken = requests.begin();
      if (
        input.currentSession.file.kind === "durable" &&
        input.currentSession.file.fileRefId === input.targetFileRefId
      ) {
        return {
          status: "skipped" as const,
          reason: "already-current" as const,
          warnings: [] as string[],
          requestToken
        };
      }
      const runtimeInput: LiteraturePreflightRuntimeInput = {
        currentSessionHandle: input.currentSessionHandle,
        targetSessionHandle: input.targetSessionHandle,
        targetFileRefId: input.targetFileRefId
      };
      const preflight = await canonicalBridge.preflight(
        literatureId,
        JSON.stringify(runtimeInput)
      );
      if (disposed || !requests.shouldCommitSuccess(requestToken)) return null;
      if (preflight.status !== "ready") {
        return {
          status: "error" as const,
          error: preflight.error,
          warnings: [] as string[],
          requestToken
        };
      }
      const confirmed = await canonicalBridge.confirm(preflight.preflightToken);
      if (disposed || !requests.shouldCommitSuccess(requestToken)) return null;
      if (confirmed.status !== "success") {
        return {
          status: "error" as const,
          error:
            confirmed.status === "error"
              ? confirmed.error
              : failure(
                  confirmed.operationId,
                  "confirm-revalidate",
                  "LITERATURE_FORMAL_SWITCH_CANCELED"
                ),
          warnings: [] as string[],
          requestToken
        };
      }
      return {
        status: "success" as const,
        operationId: confirmed.operationId,
        sessionKey: confirmed.sessionKey,
        warnings: [] as string[],
        requestToken
      };
    },
    listRecoveries() {
      return canonicalBridge.listRecoveries(literatureId);
    },
    continueRecovery(operationId: string) {
      return canonicalBridge.continueRecovery(operationId, literatureId);
    },
    safeCancelRecovery(operationId: string) {
      return canonicalBridge.safeCancel(operationId, literatureId);
    },
    dispose() {
      disposed = true;
      requests.dispose();
    }
  });
}

export type LiteratureManuscriptFormalSwitchService = ReturnType<
  typeof createLiteratureManuscriptFormalSwitchService
>;
