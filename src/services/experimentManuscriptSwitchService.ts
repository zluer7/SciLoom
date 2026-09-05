import type { Experiment, FileRef, ManuscriptBinding, Project } from "../types";
import {
  type ExperimentOutlineReplacement,
  type ExperimentOwnerSwitchReplacementInput
} from "../types/experimentManuscriptAdapter";
import {
  EXPERIMENT_MANUSCRIPT_SWITCH_ERROR_CODES as CODES,
  type ExperimentFormalSwitchRecoverySummary,
  type ExperimentManuscriptSwitchConfirmResult,
  type ExperimentManuscriptSwitchPreflightResult,
  type ExperimentSwitchRecoveryPrepareInput
} from "../types/experimentManuscriptSwitch";
import type {
  SharedManuscriptSession,
  SharedManuscriptSessionHandle,
  SharedManuscriptSessionKey
} from "../types/sharedManuscriptSession";
import {
  createFormalSwitchEngine,
  type FormalSwitchAdapter,
  type FormalSwitchError,
  type FormalSwitchRecoveryEvidence,
  type FormalSwitchRecoveryRepository,
  type FormalSwitchSnapshot
} from "./formalSwitchEngine";
import { experimentService } from "./experimentService";
import { fileRefService, getSafeManuscriptBasename } from "./fileRefService";
import { resolveMountedManuscriptLifecycleDecision } from "./fileRefOwnerValidator";
import { manuscriptBindingService } from "./manuscriptBindingService";
import { experimentCurrentRawManuscriptService } from "./experimentCurrentRawManuscriptService";
import { experimentIndependentRawManuscriptService } from "./experimentIndependentRawManuscriptService";
import {
  buildCanonicalFormalSwitchArchiveCandidate,
  buildCanonicalFormalSwitchOldCurrentSettlement
} from "./canonicalFormalSwitchArchiveConvergence";
import { convergeCanonicalFormalSwitchRuntime } from "./canonicalFormalSwitchRuntimeConvergence";
import type { ManuscriptOutlineOwnerApplicationMapping } from "./manuscriptOutlineOwnerProjector";
import { getProjectById } from "./planningService";
import { applyExperimentSwitchContextWriteback } from "./experimentSwitchContextWritebackBuilder";
import {
  experimentOwnerSwitchTransactionAdapter,
  buildExperimentSwitchOutlineReplacements,
  type ExperimentOwnerSwitchTransactionPort
} from "./experimentOwnerSwitchTransactionAdapter";
import {
  experimentSwitchRecoveryAdapter,
  type ExperimentSwitchRecoveryPort
} from "./experimentSwitchRecoveryAdapter";
import { tryAcquireExperimentManuscriptOwnerOperation } from "./experimentManuscriptOwnerOperationGate";
import { publishRefreshEvent } from "./refreshEventService";
import { createOperationLog } from "./operationLogService";
import {
  buildExperimentRevalidationDiagnostic,
  type ExperimentRevalidationDiagnosticEvidence
} from "./experimentRevalidationDiagnostic";
import {
  createReferenceOwnerFormalSwitchProductionBridge,
  type ReferenceOwnerProductionProvider
} from "./referenceOwnerFormalSwitchProductionBridge";

type CurrentRawService = typeof experimentCurrentRawManuscriptService;
type IndependentRawService = typeof experimentIndependentRawManuscriptService;

interface ExperimentSnapshot extends FormalSwitchSnapshot {
  ownerType: "experiment";
  experiment: Experiment;
  project: Project;
  binding: ManuscriptBinding;
  currentFile: FileRef;
  defaultFile: FileRef;
  targetFile: FileRef;
  currentSession: SharedManuscriptSession;
  targetSession: SharedManuscriptSession;
  currentLogicalSessionKey: ExperimentFormalSwitchLogicalSessionKey;
  targetLogicalSessionKey: ExperimentFormalSwitchLogicalSessionKey;
  currentActualRuntimeHandle: ExperimentFormalSwitchActualRuntimeHandle;
  targetActualRuntimeHandle: ExperimentFormalSwitchActualRuntimeHandle;
  currentRuntimeGeneration: number;
  targetRuntimeGeneration: number;
  replacements: readonly ExperimentOutlineReplacement[];
  outlineApplication: ManuscriptOutlineOwnerApplicationMapping;
  outlineDigest: string;
}

export interface ExperimentFormalSwitchDependencies {
  getExperiment(id: string): Promise<Experiment | undefined>;
  getBinding(ownerType: "experiment", ownerId: string, channel: "primary"): Promise<ManuscriptBinding | undefined>;
  getFileRef(id: string): Promise<FileRef | undefined>;
  getProject(id: string): Promise<Project | undefined>;
  currentService: CurrentRawService;
  independentService: IndependentRawService;
  commitPort: ExperimentOwnerSwitchTransactionPort;
  recoveryPort: ExperimentSwitchRecoveryPort;
  writeback(sessionKey: string, rawText: string): Promise<ReturnType<CurrentRawService["getSession"]>>;
  openRegistered?(experimentId: string, fileRef: FileRef): Promise<SharedManuscriptSession | undefined>;
  acquire(experimentId: string): (() => void) | undefined;
  now(): string;
  createId(prefix: string): string;
  publish(experimentId: string, operationId: string): void;
  recordFailure?(error: FormalSwitchError, ownerId: string): Promise<void>;
  captureRevalidationDiagnostic?(
    evidence: Readonly<ExperimentRevalidationDiagnosticEvidence>
  ): void;
}

const defaultDependencies: ExperimentFormalSwitchDependencies = {
  getExperiment: experimentService.getById,
  getBinding: manuscriptBindingService.getBindingByOwner,
  getFileRef: fileRefService.getById,
  getProject: getProjectById,
  currentService: experimentCurrentRawManuscriptService,
  independentService: experimentIndependentRawManuscriptService,
  commitPort: experimentOwnerSwitchTransactionAdapter,
  recoveryPort: experimentSwitchRecoveryAdapter,
  async writeback(sessionKey, rawText) {
    const updated = experimentCurrentRawManuscriptService.updateDraft(sessionKey, rawText);
    if (updated.status !== "success") return undefined;
    const saved = await experimentCurrentRawManuscriptService.save(sessionKey);
    return saved.status === "success" || saved.status === "no-op"
      ? experimentCurrentRawManuscriptService.getSession(sessionKey)
      : undefined;
  },
  acquire: (experimentId) => tryAcquireExperimentManuscriptOwnerOperation("experiment", experimentId, "formalSwitch"),
  now: () => new Date().toISOString(),
  createId: (prefix) => `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`,
  publish(experimentId, operationId) {
    publishRefreshEvent({
      id: `experiment-formal-switch-${operationId}`,
      keys: ["experiment.changed", "fileRef.changed", "operationLog.changed"],
      affectedEntities: [{ type: "experiment", id: experimentId, relation: "updated" }],
      affectedScopes: [{ module: "experiment", reason: "Experiment formal manuscript switched." }],
      source: "service.write",
      operation: "experiment.manuscript.formalSwitch",
      reason: "Outline, current binding, and operation log committed.",
      writeFeedbackStatus: "success",
      createdAt: new Date().toISOString()
    });
  },
  async recordFailure(error, ownerId) {
    await createOperationLog({
      id: error.operationId,
      operationType: "custom",
      source: "user",
      module: "experiment",
      status: "error",
      riskLevel: "medium",
      target: { entityType: "experiment", entityId: ownerId },
      summary: "Experiment formal manuscript switch failed before recovery preparation",
      relatedEntities: [],
      errors: [
        `stage=${error.stage}`,
        `cause=${error.causeCode}`,
        `frontend=${error.provenance.frontendProvenance}`,
        `rust=${error.provenance.rustProvenance}`,
        `schema=${error.provenance.schemaProvenance}`
      ],
      feedback: {
        status: "error",
        message: experimentFormalSwitchFeedback(error.causeCode),
        warnings: [],
        errors: [],
        skipped: [],
        affectedEntities: [],
        refreshKeys: ["operationLog.changed"],
        details: {
          diagnosticDetailsWriteCount: error.diagnosticDetails ? 1 : 0,
          ...(error.diagnosticDetails
            ? { experimentRevalidation: error.diagnosticDetails }
            : {})
        }
      },
      isRecoverable: false,
      refreshKeys: ["operationLog.changed"]
    });
  }
};

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

function validFileRef(file: FileRef | undefined, ownerId: string): file is FileRef {
  return Boolean(
    file && !file.deletedAt && file.ownerType === "experiment" && file.ownerId === ownerId &&
    file.manuscriptChannel === "primary" && file.resourceKind === "file" &&
    file.fileRole === "manuscript" && file.pathIdentityKey && getSafeManuscriptBasename(file.path)
  );
}

function sameFile(expected: FileRef, actual: FileRef | undefined) {
  return Boolean(
    actual && !actual.deletedAt && actual.id === expected.id &&
    actual.pathIdentityKey === expected.pathIdentityKey && actual.locationMode === expected.locationMode
  );
}

function parseOutline(rawText: string) {
  return buildCanonicalFormalSwitchArchiveCandidate({
    rawMarkdown: rawText,
    descriptorLookupIdentity: { ownerType: "experiment", channel: "primary" }
  });
}

export interface ExperimentFormalSwitchLogicalSessionKey {
  readonly identityKind: "logical-session-key";
  readonly value: SharedManuscriptSessionKey;
}

export interface ExperimentFormalSwitchActualRuntimeHandle {
  readonly identityKind: "actual-runtime-handle";
  readonly value: SharedManuscriptSessionHandle;
}

function logicalSessionKey(
  value: SharedManuscriptSessionKey
): ExperimentFormalSwitchLogicalSessionKey {
  return Object.freeze({ identityKind: "logical-session-key", value });
}

function actualRuntimeHandle(
  value: SharedManuscriptSessionHandle
): ExperimentFormalSwitchActualRuntimeHandle {
  return Object.freeze({ identityKind: "actual-runtime-handle", value });
}

function runtimeIdentityMatches(input: {
  session: SharedManuscriptSession | undefined;
  logicalSessionKey: ExperimentFormalSwitchLogicalSessionKey;
  actualRuntimeHandle: ExperimentFormalSwitchActualRuntimeHandle;
  runtimeGeneration: number;
  ownerId: string;
  windowRole: "current" | "independent";
  fileRefId: string;
  pathIdentityKey: string;
}) {
  const { session } = input;
  return Boolean(
    session &&
    session.sessionKey === input.logicalSessionKey.value &&
    session.sessionGeneration === input.runtimeGeneration &&
    session.owner.ownerType === "experiment" &&
    session.owner.ownerId === input.ownerId &&
    session.owner.channel === "primary" &&
    session.windowRole === input.windowRole &&
    session.logicalIdentity.ownerType === "experiment" &&
    session.logicalIdentity.ownerId === input.ownerId &&
    session.logicalIdentity.channel === "primary" &&
    session.logicalIdentity.windowRole === input.windowRole &&
    session.logicalIdentity.fileRefId === input.fileRefId &&
    session.file.kind === "durable" &&
    session.file.fileRefId === input.fileRefId &&
    session.file.pathIdentity === input.pathIdentityKey &&
    input.actualRuntimeHandle.value.length > 0
  );
}

function experimentFormalSwitchFeedback(causeCode: string) {
  if (/SESSION_(?:MISSING|UNAVAILABLE|REPLACED)|RUNTIME_IDENTITY/u.test(causeCode)) {
    return "文稿运行会话已不可用或已被替换，请重新打开当前稿和目标稿后再试。";
  }
  if (/DIRTY/u.test(causeCode)) {
    return "当前稿或目标稿仍有未保存修改，请先保存或放弃修改后再试。";
  }
  if (/ACTIVE_OPERATION|OPERATION_IN_PROGRESS|RESOURCE_BUSY/u.test(causeCode)) {
    return "另一项文稿操作仍在进行，请等待完成后再试。";
  }
  if (/BASELINE_MISSING/u.test(causeCode)) {
    return "无法确认当前稿或目标稿的文件基线，请重新加载后再试。";
  }
  if (/REVISION|PHYSICAL/u.test(causeCode)) {
    return "当前稿或目标稿的文件状态已变化，请重新加载并确认后再试。";
  }
  return "操作未完成。当前文稿状态已变化或无法确认，请重新加载后重试。";
}

function contextDto(experiment: Experiment, project: Project) {
  return Object.freeze({
    basicInfo: Object.freeze({
      experimentName: experiment.title || null,
      projectName: project.title || null,
      rating: experiment.rating ?? null,
      tags: Object.freeze([...(experiment.tags ?? [])])
    }),
    structuredSummary: Object.freeze({
      purposeAndQuestion: experiment.purposeAndQuestion ?? null,
      conditionSummary: experiment.conditionSummary ?? null,
      methodSummary: experiment.methodSummary ?? null,
      resultSummary: experiment.resultSummary || null,
      conclusionAndNextSteps: experiment.conclusionAndNextSteps ?? null,
      other: experiment.other ?? null
    })
  });
}

function publicError(code: string, causeCode = code): ExperimentManuscriptSwitchPreflightResult {
  const operationId = "formal-switch-preflight";
  return {
    status: "error",
    error: {
      code: code as never,
      errorCode: code as never,
      message: "无法准备文稿切换，请检查当前稿和目标稿后重试。",
      stage: "confirm-revalidate",
      causeCode,
      recoverability: "retry",
      recoveryRequired: false,
      operationId
    }
  };
}

function evidenceFromInput(
  input: ExperimentSwitchRecoveryPrepareInput,
  phase: FormalSwitchRecoveryEvidence["phase"],
  oldCurrentPostRevision?: string,
  writebackVerificationResult?: string
): FormalSwitchRecoveryEvidence {
  return {
    operationId: input.operationId,
    ownerType: "experiment",
    ownerId: input.experimentId,
    channel: "primary",
    phase,
    oldCurrentFileRefId: input.oldCurrentFileRefId,
    defaultFileRefId: input.defaultFileRefId,
    targetFileRefId: input.targetFileRefId,
    oldCurrentFileName: input.oldCurrentFileName,
    defaultFileName: input.defaultFileName,
    targetFileName: input.targetFileName,
    oldCurrentPreRevision: input.oldCurrentPreRevision,
    oldCurrentPreDigest: input.oldCurrentPreDigest,
    oldCurrentExpectedPostDigest: input.oldCurrentExpectedPostDigest,
    targetRevision: input.targetPhysicalRevision,
    targetDigest: input.targetDigest,
    ...(oldCurrentPostRevision ? { oldCurrentPostRevision } : {}),
    ...(writebackVerificationResult ? { writebackVerificationResult } : {}),
    prepareInput: input
  };
}

function createRecoveryRepository(port: ExperimentSwitchRecoveryPort): FormalSwitchRecoveryRepository {
  return {
    async list(ownerType, ownerId) {
      if (ownerType !== "experiment") return [];
      const records = await port.list(ownerId);
      return Promise.all(records.map(async (record) => {
        const detail = await port.getDetail(record.operationId);
        return evidenceFromInput(detail.input, detail.phase, detail.oldCurrentPostRevision, detail.writebackVerificationResult);
      }));
    },
    async get(operationId) {
      try {
        const detail = await port.getDetail(operationId);
        return evidenceFromInput(detail.input, detail.phase, detail.oldCurrentPostRevision, detail.writebackVerificationResult);
      } catch {
        return undefined;
      }
    },
    async prepare(evidence) {
      await port.prepare(evidence.prepareInput as ExperimentSwitchRecoveryPrepareInput);
    },
    async transition(input) {
      await port.updatePhase({
        operationId: input.operationId,
        expectedPhase: input.expectedPhase,
        nextPhase: input.nextPhase,
        occurredAt: input.occurredAt,
        ...(input.oldCurrentPostRevision ? { oldCurrentPostRevision: input.oldCurrentPostRevision } : {}),
        ...(["pre-write", "exact-post", "conflict"].includes(input.writebackVerificationResult ?? "")
          ? { writebackVerificationResult: input.writebackVerificationResult as "pre-write" | "exact-post" | "conflict" }
          : {}),
        ...(input.lastErrorCode ? { lastErrorCode: input.lastErrorCode } : {}),
        ...(input.lastDiagnosticSummary ? { lastDiagnosticSummary: input.lastDiagnosticSummary } : {})
      });
    },
    async postVerify(operationId) {
      const result = await port.postVerify(operationId);
      return { status: result.status, safeDiagnosticCode: result.safeDiagnosticCode };
    },
    async completeDatabase(operationId, postRevision, occurredAt) {
      const result = await port.completeDatabase(operationId, postRevision, occurredAt);
      return { status: result.status, safeDiagnosticCode: result.safeDiagnosticCode };
    },
    async safeCancel(operationId, observedRevision, occurredAt) {
      await port.safeCancel(operationId, observedRevision, occurredAt);
    }
  };
}

export function createExperimentFormalSwitchAdapter(
  dependencies: ExperimentFormalSwitchDependencies = defaultDependencies
): FormalSwitchAdapter<ExperimentSnapshot, ExperimentManuscriptSwitchPreflightResult, ExperimentManuscriptSwitchConfirmResult> & {
  resolveLifecycleEligibility(ownerId: string): Promise<{ canSwitch: boolean; reasonCode?: string }>;
} {
  const recoveryRepository = createRecoveryRepository(dependencies.recoveryPort);
  return {
    ownerType: "experiment",
    async resolveLifecycleEligibility(ownerId) {
      const decision = await resolveMountedManuscriptLifecycleDecision({
        ownerType: "experiment",
        ownerId,
        manuscriptChannel: "primary"
      });
      return decision.reasonCode
        ? { canSwitch: decision.canSwitch, reasonCode: decision.reasonCode }
        : { canSwitch: decision.canSwitch };
    },
    operationPrefix: "experiment-formal-switch",
    codes: {
      inProgress: CODES.operationInProgress,
      stale: CODES.currentChanged,
      recovery: CODES.recoveryLogFailed,
      writeback: CODES.writebackFailed,
      transaction: CODES.transactionFailed,
      postVerify: CODES.postVerifyFailed,
      activation: CODES.sessionActivationFailed
    },
    rustProvenance: "experiment_owner_switch_transaction_v1",
    schemaProvenance: "schema-v52",
    recoveryRepository,
    now: dependencies.now,
    createId: dependencies.createId,
    acquire: dependencies.acquire,
    async resolveSnapshot(experimentId, targetRuntimeHandle) {
      const experiment = await dependencies.getExperiment(experimentId);
      if (!experiment || experiment.deletedAt) return publicError(CODES.ownerUnavailable);
      const project = await dependencies.getProject(experiment.projectId);
      if (!project || project.deletedAt) return publicError(CODES.ownerUnavailable, "PROJECT_UNAVAILABLE");
      const binding = await dependencies.getBinding("experiment", experimentId, "primary");
      if (!binding || binding.deletedAt || !binding.currentFileRefId || !binding.defaultManuscriptFileRefId) {
        return publicError(CODES.bindingInvalid);
      }
      const targetSession = dependencies.independentService.getSession(targetRuntimeHandle);
      const targetId = targetSession?.file.kind === "durable" ? targetSession.file.fileRefId : undefined;
      if (targetId === binding.currentFileRefId) {
        return { status: "no-op", experimentId, currentFileRefId: targetId };
      }
      const [currentFile, defaultFile, targetFile] = await Promise.all([
        dependencies.getFileRef(binding.currentFileRefId),
        dependencies.getFileRef(binding.defaultManuscriptFileRefId),
        targetId ? dependencies.getFileRef(targetId) : Promise.resolve(undefined)
      ]);
      if (!validFileRef(currentFile, experimentId) || !validFileRef(defaultFile, experimentId) ||
          !validFileRef(targetFile, experimentId) || !targetSession?.baseline || targetSession.dirty) {
        return publicError(targetSession?.dirty ? CODES.targetDirty : CODES.targetInvalid);
      }
      const opened = await dependencies.currentService.openCurrent(experimentId);
      if (opened.status !== "success" || !("session" in opened) || !opened.session.baseline) {
        return publicError(CODES.currentChanged);
      }
      if (opened.session.dirty) return publicError(CODES.currentDirty);
      const currentSession = opened.session;
      const currentBaseline = currentSession.baseline!;
      const targetBaseline = targetSession.baseline!;
      const parsed = parseOutline(targetBaseline.rawText);
      if (!parsed.ok) {
        return publicError(
          CODES.targetInvalid,
          `OUTLINE_${parsed.error.stage.toUpperCase()}_${parsed.error.code}`
        );
      }
      const replacements = buildExperimentSwitchOutlineReplacements(
        parsed.applicationMapping
      );
      const currentLogicalSessionKey = logicalSessionKey(currentSession.sessionKey);
      const targetLogicalSessionKey = logicalSessionKey(targetSession.sessionKey);
      const currentActualRuntimeHandle = actualRuntimeHandle(opened.sessionKey);
      const targetActualRuntimeHandle = actualRuntimeHandle(targetRuntimeHandle);
      if (!runtimeIdentityMatches({
        session: dependencies.currentService.getSession(opened.sessionKey),
        logicalSessionKey: currentLogicalSessionKey,
        actualRuntimeHandle: currentActualRuntimeHandle,
        runtimeGeneration: currentSession.sessionGeneration,
        ownerId: experimentId,
        windowRole: "current",
        fileRefId: currentFile.id,
        pathIdentityKey: currentFile.pathIdentityKey
      }) || !runtimeIdentityMatches({
        session: dependencies.independentService.getSession(targetRuntimeHandle),
        logicalSessionKey: targetLogicalSessionKey,
        actualRuntimeHandle: targetActualRuntimeHandle,
        runtimeGeneration: targetSession.sessionGeneration,
        ownerId: experimentId,
        windowRole: "independent",
        fileRefId: targetFile.id,
        pathIdentityKey: targetFile.pathIdentityKey
      })) {
        return publicError(
          CODES.targetInvalid,
          "EXPERIMENT_FORMAL_SWITCH_RUNTIME_IDENTITY_INVALID"
        );
      }
      return Object.freeze({
        ownerType: "experiment",
        ownerId: experimentId,
        channel: "primary",
        bindingId: binding.id,
        currentFileRefId: currentFile.id,
        defaultFileRefId: defaultFile.id,
        targetFileRefId: targetFile.id,
        currentFileName: currentSession.file.fileName,
        defaultFileName: getSafeManuscriptBasename(defaultFile.path) ?? "default manuscript.md",
        targetFileName: targetSession.file.fileName,
        targetLocationMode: targetFile.locationMode,
        currentRevision: currentBaseline.revision,
        targetRevision: targetBaseline.revision,
        currentRawText: currentBaseline.rawText,
        targetRawText: targetBaseline.rawText,
        replacements,
        diagnostics: parsed.orderedReplacementDto.diagnostics,
        outlineApplication: parsed.applicationMapping,
        experiment,
        project,
        binding,
        currentFile,
        defaultFile,
        targetFile,
        currentSession,
        targetSession,
        currentLogicalSessionKey,
        targetLogicalSessionKey,
        currentActualRuntimeHandle,
        targetActualRuntimeHandle,
        currentRuntimeGeneration: currentSession.sessionGeneration,
        targetRuntimeGeneration: targetSession.sessionGeneration,
        outlineDigest: hashText(JSON.stringify(parsed.applicationMapping.orderedFieldApplications))
      });
    },
    isSnapshot(value): value is ExperimentSnapshot {
      return (value as Partial<ExperimentSnapshot>).ownerType === "experiment";
    },
    ready(snapshot, token, _operationId, expiresAt) {
      return {
        status: "ready",
        preflightToken: token,
        expiresAt,
        experimentId: snapshot.ownerId,
        currentFileRefId: snapshot.currentFileRefId,
        defaultFileRefId: snapshot.defaultFileRefId,
        targetFileRefId: snapshot.targetFileRefId,
        targetSessionKey: snapshot.targetActualRuntimeHandle.value,
        targetFileName: snapshot.targetFileName,
        outlineReplacements: snapshot.replacements,
        diagnostics: snapshot.diagnostics as never,
        warnings: snapshot.diagnostics.map((item) => item.code),
        requiresConfirmation: true
      };
    },
    async revalidateIdentityAndRevision(snapshot, context) {
      const [owner, project, binding, currentFile, defaultFile, targetFile] = await Promise.all([
        dependencies.getExperiment(snapshot.ownerId),
        dependencies.getProject(snapshot.project.id),
        dependencies.getBinding("experiment", snapshot.ownerId, "primary"),
        dependencies.getFileRef(snapshot.currentFileRefId),
        dependencies.getFileRef(snapshot.defaultFileRefId),
        dependencies.getFileRef(snapshot.targetFileRefId)
      ]);
      if (!owner || owner.deletedAt) throw new Error("EXPERIMENT_FORMAL_SWITCH_OWNER_UNAVAILABLE");
      if (!project || project.deletedAt || project.id !== owner.projectId) throw new Error("EXPERIMENT_FORMAL_SWITCH_PROJECT_CHANGED");
      if (!binding || binding.id !== snapshot.bindingId || binding.currentFileRefId !== snapshot.currentFileRefId) throw new Error("EXPERIMENT_FORMAL_SWITCH_CURRENT_CHANGED");
      if (binding.defaultManuscriptFileRefId !== snapshot.defaultFileRefId) throw new Error("EXPERIMENT_FORMAL_SWITCH_DEFAULT_CHANGED");
      if (!sameFile(snapshot.currentFile, currentFile) || !sameFile(snapshot.defaultFile, defaultFile) || !sameFile(snapshot.targetFile, targetFile)) throw new Error("EXPERIMENT_FORMAL_SWITCH_FILE_IDENTITY_CHANGED");
      const logicalIdentity = (value: SharedManuscriptSession | undefined) =>
        value
          ? [
              value.logicalIdentity?.ownerType ?? value.owner.ownerType,
              value.logicalIdentity?.ownerId ?? value.owner.ownerId,
              value.logicalIdentity?.channel ?? value.owner.channel,
              value.logicalIdentity?.windowRole ?? value.windowRole,
              value.logicalIdentity?.fileRefId ??
                (value.file.kind === "durable" ? value.file.fileRefId : "ephemeral")
            ].join(":")
          : undefined;
      const buildDiagnostic = (
        currentReloadStatus: string,
        currentReloadCauseCode: string | undefined,
        currentReloadData: SharedManuscriptSession | undefined,
        reloadAttempted = true
      ) => buildExperimentRevalidationDiagnostic({
          operationId: context.operationId,
          ownerId: snapshot.ownerId,
          currentFileRefId: snapshot.currentFileRefId,
          targetFileRefId: snapshot.targetFileRefId,
          snapshotCurrentRevision: snapshot.currentRevision,
          currentReloadStatus,
          currentReloadCauseCode,
          observedCurrentRevision: currentReloadData?.baseline?.revision,
          baselinePresent: Boolean(currentReloadData?.baseline),
          currentDirty: currentReloadData?.dirty,
          activeOperation: currentReloadData?.activeOperation?.kind,
          confirmInvocationCount: context.confirmInvocationCount,
          revalidationInvocationCount: context.revalidationInvocationCount,
          confirmTimestamp: context.confirmTimestamp,
          revalidationTimestamp: context.revalidationTimestamp,
          snapshotCurrentLogicalIdentity: logicalIdentity(snapshot.currentSession),
          observedCurrentLogicalIdentity: logicalIdentity(currentReloadData),
          comparisonRevisionSource: "current-physical-baseline",
          staleDiagnosticLabelObserved: false,
          sessionKey: snapshot.currentLogicalSessionKey.value,
          runtimeHandle: snapshot.currentActualRuntimeHandle.value,
          ...(reloadAttempted
            ? {
                reloadArgument: snapshot.currentActualRuntimeHandle.value,
                reloadArgumentMatchesRuntimeHandle: true
              }
            : {}),
          runtimeGeneration: currentReloadData?.sessionGeneration,
          currentPathIdentity: snapshot.currentFile.pathIdentityKey,
          physicalFileIdentity: currentReloadData?.baseline?.physicalIdentity,
          bindingRevision: snapshot.binding.updatedAt,
          fileRefRevision: snapshot.currentFile.updatedAt
        });
      const revalidationError = (
        message: string,
        diagnostic: Readonly<ExperimentRevalidationDiagnosticEvidence>
      ) => {
        const error = new Error(message) as Error & {
          formalSwitchDiagnosticDetails: Record<string, unknown>;
        };
        error.formalSwitchDiagnosticDetails = diagnostic as unknown as Record<
          string,
          unknown
        >;
        return error;
      };
      const currentBeforeReload = dependencies.currentService.getSession(
        snapshot.currentActualRuntimeHandle.value
      );
      if (!runtimeIdentityMatches({
        session: currentBeforeReload,
        logicalSessionKey: snapshot.currentLogicalSessionKey,
        actualRuntimeHandle: snapshot.currentActualRuntimeHandle,
        runtimeGeneration: snapshot.currentRuntimeGeneration,
        ownerId: snapshot.ownerId,
        windowRole: "current",
        fileRefId: snapshot.currentFileRefId,
        pathIdentityKey: snapshot.currentFile.pathIdentityKey
      })) {
        const diagnostic = buildDiagnostic(
          "error",
          "EXPERIMENT_CURRENT_RAW_SESSION_MISSING",
          currentBeforeReload,
          false
        );
        dependencies.captureRevalidationDiagnostic?.(diagnostic);
        throw revalidationError(
          "EXPERIMENT_FORMAL_SWITCH_CURRENT_RUNTIME_SESSION_UNAVAILABLE",
          diagnostic
        );
      }
      const currentReload = await dependencies.currentService.reload(
        snapshot.currentActualRuntimeHandle.value
      );
      const currentReloadData = "data" in currentReload
        ? currentReload.data
        : undefined;
      const currentReloadError = "error" in currentReload
        ? currentReload.error
        : undefined;
      const currentReloadCauseCode = currentReloadError &&
        "causeCode" in currentReloadError
        ? currentReloadError.causeCode
        : currentReloadError?.code;
      const diagnostic = buildDiagnostic(
        currentReload.status,
        currentReloadCauseCode,
        currentReloadData
      );
      dependencies.captureRevalidationDiagnostic?.(diagnostic);
      if (
        currentReload.status !== "success" ||
        !currentReloadData?.baseline ||
        currentReloadData.dirty ||
        currentReloadData.baseline.revision !== snapshot.currentRevision
      ) {
        const cause = currentReload.status !== "success"
          ? (currentReloadCauseCode ?? "EXPERIMENT_FORMAL_SWITCH_CURRENT_RELOAD_FAILED")
          : !currentReloadData?.baseline
            ? "EXPERIMENT_FORMAL_SWITCH_CURRENT_BASELINE_MISSING"
            : currentReloadData.dirty
              ? "EXPERIMENT_FORMAL_SWITCH_CURRENT_DIRTY"
              : "EXPERIMENT_FORMAL_SWITCH_CURRENT_PHYSICAL_REVISION_CHANGED";
        throw revalidationError(cause, diagnostic);
      }
      if (!runtimeIdentityMatches({
        session: currentReloadData,
        logicalSessionKey: snapshot.currentLogicalSessionKey,
        actualRuntimeHandle: snapshot.currentActualRuntimeHandle,
        runtimeGeneration: snapshot.currentRuntimeGeneration,
        ownerId: snapshot.ownerId,
        windowRole: "current",
        fileRefId: snapshot.currentFileRefId,
        pathIdentityKey: snapshot.currentFile.pathIdentityKey
      })) {
        throw revalidationError(
          "EXPERIMENT_FORMAL_SWITCH_CURRENT_RUNTIME_IDENTITY_REPLACED",
          diagnostic
        );
      }
      const targetBeforeReload = dependencies.independentService.getSession(
        snapshot.targetActualRuntimeHandle.value
      );
      if (!runtimeIdentityMatches({
        session: targetBeforeReload,
        logicalSessionKey: snapshot.targetLogicalSessionKey,
        actualRuntimeHandle: snapshot.targetActualRuntimeHandle,
        runtimeGeneration: snapshot.targetRuntimeGeneration,
        ownerId: snapshot.ownerId,
        windowRole: "independent",
        fileRefId: snapshot.targetFileRefId,
        pathIdentityKey: snapshot.targetFile.pathIdentityKey
      })) {
        throw revalidationError(
          "EXPERIMENT_FORMAL_SWITCH_TARGET_RUNTIME_SESSION_UNAVAILABLE",
          diagnostic
        );
      }
      const targetReload = await dependencies.independentService.reload(
        snapshot.targetActualRuntimeHandle.value
      );
      const targetReloadData = "data" in targetReload
        ? targetReload.data
        : undefined;
      if (
        targetReload.status !== "success" ||
        !targetReloadData?.baseline ||
        targetReloadData.dirty ||
        targetReloadData.baseline.revision !== snapshot.targetRevision
      ) {
        const targetError = "error" in targetReload
          ? targetReload.error
          : undefined;
        const cause = targetReload.status !== "success"
          ? (targetError?.causeCode ?? targetError?.code ?? "EXPERIMENT_FORMAL_SWITCH_TARGET_RELOAD_FAILED")
          : !targetReloadData?.baseline
            ? "EXPERIMENT_FORMAL_SWITCH_TARGET_BASELINE_MISSING"
            : targetReloadData.dirty
              ? "EXPERIMENT_FORMAL_SWITCH_TARGET_DIRTY"
              : "EXPERIMENT_FORMAL_SWITCH_TARGET_PHYSICAL_REVISION_CHANGED";
        throw revalidationError(cause, diagnostic);
      }
      if (!runtimeIdentityMatches({
        session: targetReloadData,
        logicalSessionKey: snapshot.targetLogicalSessionKey,
        actualRuntimeHandle: snapshot.targetActualRuntimeHandle,
        runtimeGeneration: snapshot.targetRuntimeGeneration,
        ownerId: snapshot.ownerId,
        windowRole: "independent",
        fileRefId: snapshot.targetFileRefId,
        pathIdentityKey: snapshot.targetFile.pathIdentityKey
      })) {
        throw revalidationError(
          "EXPERIMENT_FORMAL_SWITCH_TARGET_RUNTIME_IDENTITY_REPLACED",
          diagnostic
        );
      }
      return Object.freeze({
        ...snapshot,
        experiment: owner,
        project,
        binding,
        currentSession: currentReloadData,
        targetSession: targetReloadData,
        currentRawText: currentReloadData.baseline.rawText,
        targetRawText: targetReloadData.baseline.rawText
      });
    },
    isRevalidatedSnapshot(value): value is ExperimentSnapshot {
      return (value as Partial<ExperimentSnapshot>).ownerType === "experiment";
    },
    async buildPreparedEvidence(snapshot, operationId, occurredAt) {
      const expectedPost = buildCanonicalFormalSwitchOldCurrentSettlement({
        currentRawMarkdown: snapshot.currentRawText,
        descriptorLookupIdentity: { ownerType: "experiment", channel: "primary" },
        currentStructuredValues: {
          purposeAndQuestion: snapshot.experiment.purposeAndQuestion,
          conditionSummary: snapshot.experiment.conditionSummary,
          methodSummary: snapshot.experiment.methodSummary,
          resultSummary: snapshot.experiment.resultSummary,
          conclusionAndNextSteps: snapshot.experiment.conclusionAndNextSteps,
          other: snapshot.experiment.other
        }
      }).expectedPostText;
      const input: ExperimentSwitchRecoveryPrepareInput = {
        operationId,
        experimentId: snapshot.ownerId,
        projectId: snapshot.experiment.projectId,
        bindingId: snapshot.bindingId,
        expectedOwnerUpdatedAt: snapshot.experiment.updatedAt,
        expectedBindingUpdatedAt: snapshot.binding.updatedAt,
        oldCurrentFileRefId: snapshot.currentFileRefId,
        oldCurrentFileRefUpdatedAt: snapshot.currentFile.updatedAt,
        oldCurrentPathIdentity: snapshot.currentFile.pathIdentityKey,
        oldCurrentLocationMode: snapshot.currentFile.locationMode,
        defaultFileRefId: snapshot.defaultFileRefId,
        defaultFileRefUpdatedAt: snapshot.defaultFile.updatedAt,
        defaultPathIdentity: snapshot.defaultFile.pathIdentityKey,
        defaultLocationMode: snapshot.defaultFile.locationMode,
        targetFileRefId: snapshot.targetFileRefId,
        targetFileRefUpdatedAt: snapshot.targetFile.updatedAt,
        targetPathIdentity: snapshot.targetFile.pathIdentityKey,
        targetLocationMode: snapshot.targetFile.locationMode,
        outlineReplacementsJson: JSON.stringify(snapshot.replacements),
        experimentTitleSnapshot: snapshot.experiment.title || "未命名实验",
        projectTitleSnapshot: snapshot.project.title || "未命名课题",
        ...(snapshot.experiment.rating ? { ratingSnapshot: String(snapshot.experiment.rating) } : {}),
        tagsJson: JSON.stringify(snapshot.experiment.tags ?? []),
        deterministicWritebackVersion: 1,
        recordedAt: occurredAt,
        writebackDigest: hashText(expectedPost),
        writebackByteLength: byteLength(expectedPost),
        oldCurrentPreRevision: snapshot.currentRevision,
        oldCurrentPreDigest: hashText(snapshot.currentRawText),
        oldCurrentExpectedPostDigest: hashText(expectedPost),
        targetPhysicalRevision: snapshot.targetRevision,
        targetDigest: hashText(snapshot.targetRawText),
        targetByteLength: byteLength(snapshot.targetRawText),
        oldCurrentFileName: snapshot.currentFileName,
        targetFileName: snapshot.targetFileName,
        defaultFileName: snapshot.defaultFileName,
        correlationId: dependencies.createId("correlation"),
        createdAt: occurredAt
      };
      return { evidence: evidenceFromInput(input, "prepared"), expectedPost };
    },
    async writeOldCurrent(snapshot, expectedPost) {
      const written = await dependencies.writeback(
        snapshot.currentActualRuntimeHandle.value,
        expectedPost
      );
      if (!written?.baseline) throw new Error("EXPERIMENT_FORMAL_SWITCH_OLD_CURRENT_WRITEBACK_FAILED");
      return { revision: written.baseline.revision, rawText: written.baseline.rawText };
    },
    async commit(snapshot, evidence, oldCurrentPostRevision, occurredAt) {
      const input = evidence.prepareInput as ExperimentSwitchRecoveryPrepareInput;
      const transaction: ExperimentOwnerSwitchReplacementInput = {
        ownerType: "experiment",
        ownerId: snapshot.ownerId,
        projectId: snapshot.experiment.projectId,
        manuscriptChannel: "primary",
        bindingId: snapshot.bindingId,
        expectedBindingUpdatedAt: snapshot.binding.updatedAt,
        expectedCurrentFileRefId: snapshot.currentFileRefId,
        expectedDefaultManuscriptFileRefId: snapshot.defaultFileRefId,
        expectedDefaultPathIdentity: snapshot.defaultFile.pathIdentityKey,
        targetFileRefId: snapshot.targetFileRefId,
        targetPathIdentity: snapshot.targetFile.pathIdentityKey,
        targetLocationMode: snapshot.targetFile.locationMode,
        outlineReplacements: buildExperimentSwitchOutlineReplacements(
          snapshot.outlineApplication
        ),
        outlineDigest: snapshot.outlineDigest,
        oldCurrentPostRevision,
        targetPhysicalRevision: snapshot.targetRevision,
        occurredAt,
        operationId: evidence.operationId,
        correlationId: input.correlationId,
        audit: { actorId: "local_user", actorLabel: "Local user", source: "user" }
      };
      await dependencies.commitPort.commit(transaction);
    },
    async activate(snapshot) {
      const closed = await dependencies.currentService.closeCleanOwnerFileSessions(
        snapshot.ownerId,
        [snapshot.currentFileRefId, snapshot.targetFileRefId]
      );
      if (closed.status !== "success") throw new Error("EXPERIMENT_FORMAL_SWITCH_SESSION_ACTIVATION_FAILED");
      const opened = await dependencies.currentService.openCurrent(snapshot.ownerId);
      if (opened.status !== "success" || !("session" in opened) || !opened.session || opened.session.file.kind !== "durable" || opened.session.file.fileRefId !== snapshot.targetFileRefId) throw new Error("EXPERIMENT_FORMAL_SWITCH_SESSION_ACTIVATION_FAILED");
      return { sessionKey: opened.sessionKey };
    },
    async activateRecovered(evidence) {
      const closed = await dependencies.currentService.closeCleanOwnerFileSessions(
        evidence.ownerId,
        [evidence.oldCurrentFileRefId, evidence.targetFileRefId]
      );
      if (closed.status !== "success") throw new Error("EXPERIMENT_FORMAL_SWITCH_SESSION_ACTIVATION_FAILED");
      const opened = await dependencies.currentService.openCurrent(evidence.ownerId);
      if (opened.status !== "success" || !("session" in opened) || !opened.session || opened.session.file.kind !== "durable" || opened.session.file.fileRefId !== evidence.targetFileRefId) throw new Error("EXPERIMENT_FORMAL_SWITCH_SESSION_ACTIVATION_FAILED");
      return { sessionKey: opened.sessionKey };
    },
    async openRecoveryCurrent(evidence) {
      const opened = await dependencies.currentService.openCurrent(evidence.ownerId);
      if (opened.status !== "success" || !("session" in opened) || !opened.session?.baseline || opened.session.file.kind !== "durable" || opened.session.file.fileRefId !== evidence.oldCurrentFileRefId) throw new Error("EXPERIMENT_FORMAL_SWITCH_RECOVERY_CURRENT_UNAVAILABLE");
      return { sessionKey: opened.sessionKey, revision: opened.session.baseline.revision, rawText: opened.session.baseline.rawText, dirty: opened.session.dirty };
    },
    async rebuildRecoveryPost(evidence, currentRawText) {
      const input = evidence.prepareInput as ExperimentSwitchRecoveryPrepareInput;
      const experiment = {
        title: input.experimentTitleSnapshot,
        rating: input.ratingSnapshot,
        tags: JSON.parse(input.tagsJson),
        purposeAndQuestion: input.beforePurposeAndQuestion,
        conditionSummary: input.beforeConditionSummary,
        methodSummary: input.beforeMethodSummary,
        resultSummary: input.beforeResultSummary,
        conclusionAndNextSteps: input.beforeConclusionAndNextSteps,
        other: input.beforeOther
      } as Experiment;
      return applyExperimentSwitchContextWriteback(currentRawText, contextDto(experiment, { title: input.projectTitleSnapshot } as Project));
    },
    success(snapshot, operationId, sessionKey) {
      return { status: "success", experimentId: snapshot.ownerId, currentFileRefId: snapshot.targetFileRefId, defaultManuscriptFileRefId: snapshot.defaultFileRefId, operationLogId: operationId, sessionKey };
    },
    recoveryRequired(error) {
      return { status: "recovery-required", operationId: error.operationId, error: error as never };
    },
    error(error) {
      return { status: "error", error: error as never };
    },
    canceled() {
      return { status: "canceled" };
    },
    publish(snapshot, operationId) {
      dependencies.publish(snapshot.ownerId, operationId);
    },
    async recordPrePreparedFailure(details) {
      if (dependencies.recordFailure) await dependencies.recordFailure(details, details.ownerId);
      else await defaultDependencies.recordFailure?.(details, details.ownerId);
    }
  };
}

export const experimentFormalSwitchAdapter = createExperimentFormalSwitchAdapter();

const experimentReferenceOwnerProvider: ReferenceOwnerProductionProvider<ExperimentSnapshot> = {
  buildBeginInput({ snapshot, evidence, expectedPost, operationId, occurredAt, replacements }) {
    return {
      ownerType: "experiment",
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
        snapshot.ownerId,
        snapshot.currentRevision,
        snapshot.targetRevision,
        snapshot.outlineDigest,
        evidence.oldCurrentExpectedPostDigest
      ].join(":"),
      currentRuntime: {
        actualRuntimeHandle: snapshot.currentActualRuntimeHandle.value,
        runtimeGeneration: snapshot.currentRuntimeGeneration,
        runtimeConsumerId: snapshot.currentSession.consumerHandle ?? snapshot.currentActualRuntimeHandle.value,
        logicalIdentity: `experiment:${snapshot.ownerId}:primary:current:${snapshot.currentFileRefId}`,
        fileRefId: snapshot.currentFileRefId
      },
      targetRuntime: {
        actualRuntimeHandle: snapshot.targetActualRuntimeHandle.value,
        runtimeGeneration: snapshot.targetRuntimeGeneration,
        runtimeConsumerId: snapshot.targetSession.consumerHandle ?? snapshot.targetActualRuntimeHandle.value,
        logicalIdentity: `experiment:${snapshot.ownerId}:primary:independent:${snapshot.targetFileRefId}`,
        fileRefId: snapshot.targetFileRefId
      }
    };
  },
  activate(snapshot) {
    return convergeCanonicalFormalSwitchRuntime({
      ownerType: "experiment",
      ownerId: snapshot.ownerId,
      channel: "primary",
      targetFileRefId: snapshot.targetFileRefId,
      consumerId: `experiment-formal-switch:${snapshot.ownerId}:primary`,
      openCurrent: async (consumerId) => {
        const opened = await defaultDependencies.currentService.openCurrent(
          snapshot.ownerId,
          consumerId
        );
        return opened.status === "success" && "sessionKey" in opened && "session" in opened
          ? { status: "success", sessionKey: opened.sessionKey, session: opened.session }
          : { status: opened.status };
      }
    });
  },
  activateRecovered(ticket) {
    return convergeCanonicalFormalSwitchRuntime({
      ownerType: "experiment",
      ownerId: ticket.ownerId,
      channel: "primary",
      targetFileRefId: ticket.targetFileRefId,
      consumerId: `experiment-formal-switch:${ticket.ownerId}:primary`,
      openCurrent: async (consumerId) => {
        const opened = await defaultDependencies.currentService.openCurrent(
          ticket.ownerId,
          consumerId
        );
        return opened.status === "success" && "sessionKey" in opened && "session" in opened
          ? { status: "success", sessionKey: opened.sessionKey, session: opened.session }
          : { status: opened.status };
      }
    });
  },
  readActivatedRuntime({ sessionKey, ticket }) {
    const session = defaultDependencies.currentService.getSession(sessionKey);
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
        session.owner.ownerType === "experiment" &&
        session.owner.ownerId === ticket.ownerId &&
        session.windowRole === "current" &&
        session.file.fileRefId === ticket.targetFileRefId
    };
  }
};

const experimentCanonicalProductionBridge =
  createReferenceOwnerFormalSwitchProductionBridge({
    adapter: experimentFormalSwitchAdapter,
    provider: experimentReferenceOwnerProvider,
    manuscriptChannel: "primary"
  });

function bindExperimentService(
  engine: ReturnType<typeof createFormalSwitchEngine>,
  adapter: ReturnType<typeof createExperimentFormalSwitchAdapter>,
  dependencies: ExperimentFormalSwitchDependencies,
  canonicalRecoveryList?: (experimentId: string) => Promise<ExperimentFormalSwitchRecoverySummary[]>
) {
  return Object.freeze({
    selectTarget(experimentId: string, requestToken: number) {
      return dependencies.independentService.selectAndOpen(experimentId, requestToken);
    },
    confirmTargetRegistration(pendingId: string) {
      return dependencies.independentService.confirmRegistration(pendingId);
    },
    cancelTargetRegistration: dependencies.independentService.cancelRegistration,
    preflight(experimentId: string, targetSessionKey: string) {
      return engine.preflight(adapter, experimentId, targetSessionKey);
    },
    confirm(preflightToken: string) {
      return engine.confirm(adapter, preflightToken);
    },
    async listRecoveries(experimentId: string): Promise<ExperimentFormalSwitchRecoverySummary[]> {
      if (canonicalRecoveryList) return canonicalRecoveryList(experimentId);
      const records = await adapter.recoveryRepository.list("experiment", experimentId);
      return records.map((item) => ({
        operationKind: "formal-switch",
        operationId: item.operationId,
        experimentId,
        oldCurrentFileRefId: item.oldCurrentFileRefId,
        targetFileRefId: item.targetFileRefId,
        phase: item.phase,
        occurredAt: (item.prepareInput as ExperimentSwitchRecoveryPrepareInput).recordedAt,
        operationIdentityVerified: true,
        writebackVerified: item.writebackVerificationResult === "exact-post" && Boolean(item.oldCurrentPostRevision)
      }));
    },
    retryRecovery(operationId: string) {
      return engine.continueRecovery(adapter, operationId);
    },
    cancelRecovery(operationId: string) {
      return engine.safeCancel(adapter, operationId);
    }
  });
}

export function createExperimentManuscriptSwitchService(
  dependencies: ExperimentFormalSwitchDependencies = defaultDependencies
) {
  const engine = createFormalSwitchEngine();
  return bindExperimentService(engine, createExperimentFormalSwitchAdapter(dependencies), dependencies);
}

export const experimentManuscriptSwitchService = bindExperimentService(
  ({
    preflight: (_adapter: unknown, experimentId: string, targetSessionKey: string) =>
      experimentCanonicalProductionBridge.preflight(experimentId, targetSessionKey),
    confirm: (_adapter: unknown, token: string) => experimentCanonicalProductionBridge.confirm(token),
    continueRecovery: (_adapter: unknown, operationId: string) =>
      experimentCanonicalProductionBridge.continueRecovery(operationId),
    safeCancel: (_adapter: unknown, operationId: string) =>
      experimentCanonicalProductionBridge.safeCancel(operationId)
  } as unknown as ReturnType<typeof createFormalSwitchEngine>),
  experimentFormalSwitchAdapter,
  defaultDependencies,
  async (experimentId) => (await experimentCanonicalProductionBridge.listRecoveries(experimentId)).map((item) => ({
    operationKind: "formal-switch",
    operationId: item.operationId,
    experimentId,
    oldCurrentFileRefId: item.oldCurrentFileRefId,
    targetFileRefId: item.targetFileRefId,
    phase: (({
      prepared: "prepared",
      settlement_started: "writeback_unknown",
      settlement_complete: "writeback_applied",
      db_pending: "db_commit_unknown",
      db_complete: "db_committed",
      activation_pending: "activation_pending",
      contained: "blocked",
      blocked: "blocked"
    } as const) as Readonly<Record<string, ExperimentFormalSwitchRecoverySummary["phase"]>>)[item.phase] ?? "blocked",
    occurredAt: new Date(item.createdAtEpochMs).toISOString(),
    operationIdentityVerified: true,
    writebackVerified: ["settlement_complete", "db_pending", "db_complete", "activation_pending"].includes(item.phase)
  }))
);
