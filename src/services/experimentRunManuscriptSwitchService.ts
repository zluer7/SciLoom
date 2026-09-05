import {
  experimentRepositoryConfig,
  experimentRunRepositoryConfig
} from "../repositories/entityConfig";
import { createRepository } from "../repositories/repositoryFactory";
import type { Experiment, ExperimentRun, FileRef, ManuscriptBinding, Project } from "../types";
import {
  EXPERIMENT_RUN_SWITCH_ERROR_CODES as CODES,
  type ExperimentRunSwitchOutlineReplacement,
  type ExperimentRunSwitchConfirmResult,
  type ExperimentRunSwitchPreflightResult,
  type ExperimentRunSwitchRecoveryRecord,
  type ExperimentRunSwitchRecoveryPrepareInput,
  type ExperimentRunSwitchTransactionInput
} from "../types/experimentRunManuscriptSwitch";
import type { SharedManuscriptSession } from "../types/sharedManuscriptSession";
import {
  createFormalSwitchEngine,
  type FormalSwitchAdapter,
  type FormalSwitchError,
  type FormalSwitchRecoveryEvidence,
  type FormalSwitchRecoveryRepository,
  type FormalSwitchSnapshot
} from "./formalSwitchEngine";
import { fileRefService, getSafeManuscriptBasename } from "./fileRefService";
import { resolveMountedManuscriptLifecycleDecision } from "./fileRefOwnerValidator";
import { manuscriptBindingService } from "./manuscriptBindingService";
import {
  experimentRunRawManuscriptService,
  type ExperimentRunRawManuscriptService
} from "./experimentRunRawManuscriptService";
import {
  buildCanonicalFormalSwitchArchiveCandidate,
  buildCanonicalFormalSwitchOldCurrentSettlement
} from "./canonicalFormalSwitchArchiveConvergence";
import { convergeCanonicalFormalSwitchRuntime } from "./canonicalFormalSwitchRuntimeConvergence";
import type { ManuscriptOutlineOwnerApplicationMapping } from "./manuscriptOutlineOwnerProjector";
import { experimentRunSwitchOutlineWritebackBuilder } from "./experimentRunSwitchOutlineWritebackBuilder";
import { createExperimentRunContextSummaryDto } from "./experimentRunContextSummaryService";
import { getProjectById } from "./planningService";
import {
  experimentRunSwitchRecoveryAdapter,
  type ExperimentRunSwitchRecoveryPort
} from "./experimentRunSwitchRecoveryAdapter";
import {
  experimentRunSwitchTransactionAdapter,
  buildExperimentRunSwitchOutlineReplacements,
  type ExperimentRunSwitchTransactionPort
} from "./experimentRunSwitchTransactionAdapter";
import { tryAcquireExperimentManuscriptOwnerOperation } from "./experimentManuscriptOwnerOperationGate";
import { publishRefreshEvent } from "./refreshEventService";
import { createOperationLog } from "./operationLogService";
import {
  createReferenceOwnerFormalSwitchProductionBridge,
  type ReferenceOwnerProductionProvider
} from "./referenceOwnerFormalSwitchProductionBridge";

const runRepository = createRepository<ExperimentRun>(experimentRunRepositoryConfig);
const parentRepository = createRepository<Experiment>(experimentRepositoryConfig);

interface RunSnapshot extends FormalSwitchSnapshot {
  ownerType: "experimentRun";
  currentSessionKey: string;
  targetSessionKey: string;
  run: ExperimentRun;
  parent: Experiment;
  project: Project;
  binding: ManuscriptBinding;
  currentFile: FileRef;
  defaultFile: FileRef;
  targetFile: FileRef;
  currentSession: SharedManuscriptSession;
  targetSession: SharedManuscriptSession;
  replacements: readonly ExperimentRunSwitchOutlineReplacement[];
  outlineApplication: ManuscriptOutlineOwnerApplicationMapping;
}

export interface ExperimentRunFormalSwitchDependencies {
  getRun(id: string): Promise<ExperimentRun | undefined | null>;
  getDeletedRun(id: string): Promise<ExperimentRun | undefined | null>;
  getParent(id: string): Promise<Experiment | undefined | null>;
  getDeletedParent(id: string): Promise<Experiment | undefined | null>;
  getProject(id: string): Promise<Project | undefined | null>;
  getBinding(ownerType: "experimentRun", ownerId: string, channel: "primary"): Promise<ManuscriptBinding | undefined | null>;
  getFileRef(id: string): Promise<FileRef | undefined | null>;
  rawService: Pick<ExperimentRunRawManuscriptService,
    | "getSession"
    | "openCurrent"
    | "reload"
    | "replaceCurrent"
    | "activateCurrentFromIndependent"
    | "activateRecoveredCurrent"
    | "markRecoveryRequired"
  >;
  commitPort: ExperimentRunSwitchTransactionPort;
  recoveryPort: ExperimentRunSwitchRecoveryPort;
  acquire(runId: string): (() => void) | undefined;
  now(): string;
  createId(prefix: string): string;
  publish(runId: string, experimentId: string, operationId: string): void;
  recordFailure?(error: FormalSwitchError, ownerId: string): Promise<void>;
}

const defaultDependencies: ExperimentRunFormalSwitchDependencies = {
  getRun: runRepository.getById,
  getDeletedRun: runRepository.getDeletedById,
  getParent: parentRepository.getById,
  getDeletedParent: parentRepository.getDeletedById,
  getProject: getProjectById,
  getBinding: manuscriptBindingService.getBindingByOwner,
  getFileRef: fileRefService.getById,
  rawService: experimentRunRawManuscriptService,
  commitPort: experimentRunSwitchTransactionAdapter,
  recoveryPort: experimentRunSwitchRecoveryAdapter,
  acquire: (runId) => tryAcquireExperimentManuscriptOwnerOperation("experimentRun", runId, "formalSwitch"),
  now: () => new Date().toISOString(),
  createId: (prefix) => `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`,
  publish(runId, experimentId, operationId) {
    publishRefreshEvent({
      id: `experiment-run-formal-switch-${operationId}`,
      keys: ["experimentRun.changed", "fileRef.changed", "operationLog.changed"],
      affectedEntities: [
        { type: "experimentRun", id: runId, relation: "updated" },
        { type: "experiment", id: experimentId, relation: "related" }
      ],
      affectedScopes: [{ module: "experiment", reason: "ExperimentRun formal manuscript switched." }],
      source: "service.write",
      operation: "experimentRun.manuscript.formalSwitch",
      reason: "Run outline, current binding, and operation log committed.",
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
      target: { entityType: "experimentRun", entityId: ownerId },
      summary: "ExperimentRun formal manuscript switch failed before recovery preparation",
      relatedEntities: [],
      errors: [
        `stage=${error.stage}`,
        `cause=${error.causeCode}`,
        `frontend=${error.provenance.frontendProvenance}`,
        `rust=${error.provenance.rustProvenance}`,
        `schema=${error.provenance.schemaProvenance}`
      ],
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

function activeRunFile(file: FileRef | undefined | null, runId: string): file is FileRef {
  return Boolean(
    file && !file.deletedAt && file.ownerType === "experimentRun" && file.ownerId === runId &&
    file.manuscriptChannel === "primary" && file.resourceKind === "file" &&
    file.fileRole === "manuscript" && file.pathIdentityKey && getSafeManuscriptBasename(file.path)
  );
}

function sameFile(expected: FileRef, actual: FileRef | undefined | null) {
  return Boolean(
    actual && !actual.deletedAt && actual.id === expected.id &&
    actual.pathIdentityKey === expected.pathIdentityKey && actual.locationMode === expected.locationMode
  );
}

function parseOutline(rawText: string) {
  return buildCanonicalFormalSwitchArchiveCandidate({
    rawMarkdown: rawText,
    descriptorLookupIdentity: { ownerType: "experimentRun", channel: "primary" }
  });
}

function runContext(run: ExperimentRun, parent: Experiment, project: Project) {
  return createExperimentRunContextSummaryDto({
    run,
    parent,
    projectName: project.title,
    currentFileName: null,
    defaultFileName: null,
    currentLocationMode: null,
    currentIsDefault: null,
    readOnly: false,
    recoveryPending: false
  });
}

function runError(code: string, causeCode = code): ExperimentRunSwitchPreflightResult {
  return {
    status: "error",
    error: {
      code: code as never,
      stage: "preflight",
      causeCode,
      recoverability: "retry",
      recoveryRequired: false
    }
  };
}

function evidenceFromInput(
  input: ExperimentRunSwitchRecoveryPrepareInput,
  phase: FormalSwitchRecoveryEvidence["phase"],
  oldCurrentPostRevision?: string,
  writebackVerificationResult?: string
): FormalSwitchRecoveryEvidence {
  return {
    operationId: input.operationId,
    ownerType: "experimentRun",
    ownerId: input.runId,
    parentOwnerId: input.experimentId,
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

function createRecoveryRepository(port: ExperimentRunSwitchRecoveryPort): FormalSwitchRecoveryRepository {
  return {
    async list(ownerType, ownerId) {
      if (ownerType !== "experimentRun") return [];
      const records = await port.list(ownerId);
      return Promise.all(records.map(async (record) => {
        const detail = await port.getDetail(record.operationId);
        return evidenceFromInput(detail.input, detail.phase, detail.oldCurrentPostRevision);
      }));
    },
    async get(operationId) {
      try {
        const detail = await port.getDetail(operationId);
        return evidenceFromInput(detail.input, detail.phase, detail.oldCurrentPostRevision);
      } catch {
        return undefined;
      }
    },
    async prepare(evidence) {
      await port.prepare(evidence.prepareInput as ExperimentRunSwitchRecoveryPrepareInput);
    },
    async transition(input) {
      await port.updatePhase({
        operationId: input.operationId,
        expectedPhase: input.expectedPhase,
        nextPhase: input.nextPhase,
        occurredAt: input.occurredAt,
        ...(input.oldCurrentPostRevision ? { oldCurrentPostRevision: input.oldCurrentPostRevision } : {}),
        ...(input.writebackVerificationResult ? { writebackVerificationResult: input.writebackVerificationResult } : {}),
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
    async safeCancel(operationId, revision, occurredAt) {
      await port.safeCancel(operationId, revision, occurredAt);
    }
  };
}

export function createExperimentRunFormalSwitchAdapter(
  dependencies: ExperimentRunFormalSwitchDependencies = defaultDependencies
): FormalSwitchAdapter<RunSnapshot, ExperimentRunSwitchPreflightResult, ExperimentRunSwitchConfirmResult> & {
  resolveLifecycleEligibility(ownerId: string): Promise<{ canSwitch: boolean; reasonCode?: string }>;
} {
  const recoveryRepository = createRecoveryRepository(dependencies.recoveryPort);
  return {
    ownerType: "experimentRun",
    async resolveLifecycleEligibility(ownerId) {
      const decision = await resolveMountedManuscriptLifecycleDecision({
        ownerType: "experimentRun",
        ownerId,
        manuscriptChannel: "primary"
      });
      return decision.reasonCode
        ? { canSwitch: decision.canSwitch, reasonCode: decision.reasonCode }
        : { canSwitch: decision.canSwitch };
    },
    operationPrefix: "run-formal-switch",
    codes: {
      inProgress: CODES.inProgress,
      stale: CODES.staleRequest,
      recovery: CODES.recoveryRequired,
      writeback: CODES.writebackFailed,
      transaction: CODES.transactionFailed,
      postVerify: CODES.recoveryRequired,
      activation: CODES.activationFailed
    },
    rustProvenance: "experiment_run_switch_transaction_v1",
    schemaProvenance: "schema-v39",
    recoveryRepository,
    now: dependencies.now,
    createId: dependencies.createId,
    acquire: dependencies.acquire,
    async resolveSnapshot(runId, targetSessionKey) {
      const run = await dependencies.getRun(runId);
      if (!run) return runError((await dependencies.getDeletedRun(runId)) ? CODES.ownerDeleted : CODES.ownerMissing);
      const parent = await dependencies.getParent(run.experimentId);
      if (!parent) return runError((await dependencies.getDeletedParent(run.experimentId)) ? CODES.parentDeleted : CODES.parentMissing);
      const project = await dependencies.getProject(run.projectId);
      if (!project || project.deletedAt || parent.projectId !== run.projectId) return runError(CODES.parentMissing, "RUN_SWITCH_PROJECT_OR_PARENT_MISMATCH");
      const binding = await dependencies.getBinding("experimentRun", runId, "primary");
      if (!binding || binding.deletedAt || !binding.currentFileRefId || !binding.defaultManuscriptFileRefId) return runError(CODES.bindingMissing);
      const targetSession = dependencies.rawService.getSession(targetSessionKey);
      const targetId = targetSession?.file.kind === "durable" ? targetSession.file.fileRefId : undefined;
      if (targetId === binding.currentFileRefId) return { status: "already-current", code: CODES.alreadyCurrent };
      if (!targetSession?.baseline || targetSession.dirty) {
        return targetSession?.dirty
          ? { status: "decision-required", scope: "target", sessionKey: targetSessionKey, code: CODES.targetDirty }
          : runError(CODES.targetInvalid);
      }
      const [currentFile, defaultFile, targetFile] = await Promise.all([
        dependencies.getFileRef(binding.currentFileRefId),
        dependencies.getFileRef(binding.defaultManuscriptFileRefId),
        targetId ? dependencies.getFileRef(targetId) : Promise.resolve(undefined)
      ]);
      if (!activeRunFile(currentFile, runId)) return runError(CODES.currentMismatch);
      if (!activeRunFile(defaultFile, runId)) return runError(CODES.defaultMismatch);
      if (targetFile && (targetFile.ownerType !== "experimentRun" || targetFile.ownerId !== runId)) {
        return runError(CODES.targetOwnerMismatch);
      }
      if (!activeRunFile(targetFile, runId)) return runError(CODES.targetInvalid);
      const opened = await dependencies.rawService.openCurrent(runId);
      if (opened.status !== "success" || !opened.session?.baseline) return runError(CODES.currentMismatch);
      if (opened.session.dirty) return { status: "decision-required", scope: "old-current", sessionKey: opened.session.sessionKey, code: CODES.oldCurrentDirty };
      const currentSession = opened.session;
      const currentBaseline = currentSession.baseline!;
      const targetBaseline = targetSession.baseline!;
      const parsed = parseOutline(targetBaseline.rawText);
      if (!parsed.ok) {
        return runError(
          CODES.targetInvalid,
          `OUTLINE_${parsed.error.stage.toUpperCase()}_${parsed.error.code}`
        );
      }
      return {
        ownerType: "experimentRun",
        ownerId: runId,
        parentOwnerId: parent.id,
        channel: "primary",
        bindingId: binding.id,
        currentFileRefId: currentFile.id,
        defaultFileRefId: defaultFile.id,
        targetFileRefId: targetFile.id,
        currentFileName: currentSession.file.fileName,
        defaultFileName: getSafeManuscriptBasename(defaultFile.path)!,
        targetFileName: targetSession.file.fileName,
        targetLocationMode: targetFile.locationMode,
        currentSessionKey: opened.sessionKey,
        targetSessionKey,
        currentRevision: currentBaseline.revision,
        targetRevision: targetBaseline.revision,
        currentRawText: currentBaseline.rawText,
        targetRawText: targetBaseline.rawText,
        replacements: buildExperimentRunSwitchOutlineReplacements(
          parsed.applicationMapping
        ),
        diagnostics: parsed.orderedReplacementDto.diagnostics,
        outlineApplication: parsed.applicationMapping,
        run,
        parent,
        project,
        binding,
        currentFile,
        defaultFile,
        targetFile,
        currentSession,
        targetSession
      };
    },
    isSnapshot(value): value is RunSnapshot {
      return (value as Partial<RunSnapshot>).ownerType === "experimentRun";
    },
    ready(snapshot, token, operationId, expiresAt) {
      return {
        status: "ready",
        preflightToken: token,
        expiresAt,
        operationId,
        targetFileName: snapshot.targetFileName,
        currentFileName: snapshot.currentFileName,
        defaultFileName: snapshot.defaultFileName,
        targetLocationMode: snapshot.targetLocationMode,
        targetIsDefault: snapshot.targetFileRefId === snapshot.defaultFileRefId,
        outlineReplacements: buildExperimentRunSwitchOutlineReplacements(
          snapshot.outlineApplication
        ),
        diagnostics: snapshot.diagnostics as never,
        warnings: snapshot.diagnostics.map((item) => item.code)
      };
    },
    async revalidateIdentityAndRevision(snapshot) {
      const [run, parent, project, binding, currentFile, defaultFile, targetFile] = await Promise.all([
        dependencies.getRun(snapshot.ownerId),
        dependencies.getParent(snapshot.parent.id),
        dependencies.getProject(snapshot.project.id),
        dependencies.getBinding("experimentRun", snapshot.ownerId, "primary"),
        dependencies.getFileRef(snapshot.currentFileRefId),
        dependencies.getFileRef(snapshot.defaultFileRefId),
        dependencies.getFileRef(snapshot.targetFileRefId)
      ]);
      if (!run || run.deletedAt || !parent || parent.deletedAt || !project || project.deletedAt) throw new Error("RUN_SWITCH_OWNER_LIFECYCLE_CHANGED");
      if (parent.id !== run.experimentId || project.id !== run.projectId || parent.projectId !== project.id) throw new Error("RUN_SWITCH_PROJECT_OR_PARENT_MISMATCH");
      if (!binding || binding.id !== snapshot.bindingId || binding.currentFileRefId !== snapshot.currentFileRefId) throw new Error("RUN_SWITCH_CURRENT_MISMATCH");
      if (binding.defaultManuscriptFileRefId !== snapshot.defaultFileRefId) throw new Error("RUN_SWITCH_DEFAULT_MISMATCH");
      if (!sameFile(snapshot.currentFile, currentFile) || !sameFile(snapshot.defaultFile, defaultFile) || !sameFile(snapshot.targetFile, targetFile)) throw new Error("RUN_SWITCH_FILE_IDENTITY_CHANGED");
      const [currentReload, targetReload] = await Promise.all([
        dependencies.rawService.reload(snapshot.currentSessionKey),
        dependencies.rawService.reload(snapshot.targetSessionKey)
      ]);
      if (currentReload.status !== "success" || !currentReload.session?.baseline || currentReload.session.dirty || currentReload.session.baseline.revision !== snapshot.currentRevision) throw new Error("RUN_SWITCH_CURRENT_REVISION_CHANGED");
      if (targetReload.status !== "success" || !targetReload.session?.baseline || targetReload.session.dirty || targetReload.session.baseline.revision !== snapshot.targetRevision) throw new Error("RUN_SWITCH_TARGET_REVISION_CHANGED");
      return { ...snapshot, run, parent, project, binding, currentSession: currentReload.session, targetSession: targetReload.session, currentRawText: currentReload.session.baseline.rawText, targetRawText: targetReload.session.baseline.rawText };
    },
    isRevalidatedSnapshot(value): value is RunSnapshot {
      return (value as Partial<RunSnapshot>).ownerType === "experimentRun";
    },
    async buildPreparedEvidence(snapshot, operationId, occurredAt) {
      const context = runContext(snapshot.run, snapshot.parent, snapshot.project);
      const expectedPost = buildCanonicalFormalSwitchOldCurrentSettlement({
        currentRawMarkdown: snapshot.currentRawText,
        descriptorLookupIdentity: { ownerType: "experimentRun", channel: "primary" },
        currentStructuredValues: {
          conditionSummary: snapshot.run.conditionSummary,
          variableParameterSummary: snapshot.run.variableParameterSummary,
          methodSummary: snapshot.run.methodSummary,
          resultSummary: snapshot.run.resultSummary,
          conclusionNotes: snapshot.run.conclusion,
          other: snapshot.run.summaryOther
        }
      }).expectedPostText;
      const input: ExperimentRunSwitchRecoveryPrepareInput = {
        recoveryId: dependencies.createId("run-switch-recovery"),
        operationId,
        runId: snapshot.ownerId,
        experimentId: snapshot.parent.id,
        projectId: snapshot.run.projectId,
        bindingId: snapshot.bindingId,
        expectedRunUpdatedAt: snapshot.run.updatedAt,
        expectedParentUpdatedAt: snapshot.parent.updatedAt,
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
        ...(snapshot.run.conditionSummary ? { beforeConditionSummary: snapshot.run.conditionSummary } : {}),
        ...(snapshot.run.variableParameterSummary ? { beforeVariableParameterSummary: snapshot.run.variableParameterSummary } : {}),
        ...(snapshot.run.methodSummary ? { beforeMethodSummary: snapshot.run.methodSummary } : {}),
        ...(snapshot.run.resultSummary ? { beforeResultSummary: snapshot.run.resultSummary } : {}),
        ...(snapshot.run.conclusion ? { beforeConclusion: snapshot.run.conclusion } : {}),
        ...(snapshot.run.summaryOther ? { beforeSummaryOther: snapshot.run.summaryOther } : {}),
        outlineReplacementsJson: JSON.stringify(snapshot.replacements),
        runTitleSnapshot: snapshot.run.title || snapshot.run.runLabel || "未命名 Run",
        parentTitleSnapshot: snapshot.parent.title || "未命名实验",
        projectTitleSnapshot: snapshot.project.title || "未命名课题",
        ...(snapshot.run.rating ? { ratingSnapshot: snapshot.run.rating } : {}),
        tagsJson: JSON.stringify(snapshot.run.tags ?? []),
        runDateSnapshot: snapshot.run.createdLocalDate || "",
        runTimeSnapshot: snapshot.run.createdLocalTime || "",
        deterministicWritebackVersion: 1,
        recordedAt: occurredAt,
        writebackDigest: hashText(expectedPost),
        writebackByteLength: byteLength(expectedPost),
        oldCurrentPreRevision: snapshot.currentRevision,
        targetPhysicalRevision: snapshot.targetRevision,
        targetDigest: hashText(snapshot.targetRawText),
        targetByteLength: byteLength(snapshot.targetRawText),
        oldCurrentPreDigest: hashText(snapshot.currentRawText),
        oldCurrentExpectedPostDigest: hashText(expectedPost),
        oldCurrentFileName: snapshot.currentFileName,
        targetFileName: snapshot.targetFileName,
        defaultFileName: snapshot.defaultFileName,
        createdAt: occurredAt
      };
      return { evidence: evidenceFromInput(input, "prepared"), expectedPost };
    },
    async writeOldCurrent(snapshot, expectedPost) {
      const written = await dependencies.rawService.replaceCurrent(snapshot.currentSessionKey, expectedPost);
      if (written.status !== "success" || !written.session?.baseline) throw new Error(written.error?.causeCode ?? "RUN_SWITCH_WRITEBACK_FAILED");
      return { revision: written.session.baseline.revision, rawText: written.session.baseline.rawText };
    },
    async commit(snapshot, evidence, oldCurrentPostRevision, occurredAt) {
      const input: ExperimentRunSwitchTransactionInput = {
        operationId: evidence.operationId,
        ownerType: "experimentRun",
        runId: snapshot.ownerId,
        experimentId: snapshot.parent.id,
        projectId: snapshot.run.projectId,
        manuscriptChannel: "primary",
        bindingId: snapshot.bindingId,
        expectedBindingUpdatedAt: snapshot.binding.updatedAt,
        expectedCurrentFileRefId: snapshot.currentFileRefId,
        expectedCurrentPathIdentity: snapshot.currentFile.pathIdentityKey,
        expectedDefaultManuscriptFileRefId: snapshot.defaultFileRefId,
        expectedDefaultPathIdentity: snapshot.defaultFile.pathIdentityKey,
        targetFileRefId: snapshot.targetFileRefId,
        targetPathIdentity: snapshot.targetFile.pathIdentityKey,
        targetLocationMode: snapshot.targetFile.locationMode,
        outlineReplacements: buildExperimentRunSwitchOutlineReplacements(
          snapshot.outlineApplication
        ),
        oldCurrentWritebackCompleted: true,
        oldCurrentPostRevision,
        targetPhysicalRevision: snapshot.targetRevision,
        occurredAt,
        logSummary: "ExperimentRun formal manuscript switch",
        audit: { actorId: "local_user", actorLabel: "Local user", source: "user" }
      };
      await dependencies.commitPort.commit(input);
    },
    async activate(snapshot) {
      const result = await dependencies.rawService.activateCurrentFromIndependent(snapshot.ownerId, snapshot.targetSessionKey);
      if (result.status !== "success" || !result.sessionKey) throw new Error("RUN_SWITCH_ACTIVATION_FAILED");
      return { sessionKey: result.sessionKey };
    },
    async activateRecovered(evidence) {
      const result = await dependencies.rawService.activateRecoveredCurrent(evidence.ownerId, evidence.targetFileRefId);
      if (result.status !== "success" || !result.sessionKey) throw new Error("RUN_SWITCH_ACTIVATION_FAILED");
      return { sessionKey: result.sessionKey };
    },
    async openRecoveryCurrent(evidence) {
      const result = await dependencies.rawService.openCurrent(evidence.ownerId);
      if (result.status !== "success" || !result.session?.baseline || result.session.file.kind !== "durable" || result.session.file.fileRefId !== evidence.oldCurrentFileRefId) throw new Error("RUN_SWITCH_RECOVERY_CURRENT_UNAVAILABLE");
      return { sessionKey: result.session.sessionKey, revision: result.session.baseline.revision, rawText: result.session.baseline.rawText, dirty: result.session.dirty };
    },
    async rebuildRecoveryPost(evidence, currentRawText) {
      const input = evidence.prepareInput as ExperimentRunSwitchRecoveryPrepareInput;
      const context = createExperimentRunContextSummaryDto({
        run: {
          id: input.runId,
          experimentId: input.experimentId,
          projectId: input.projectId,
          title: input.runTitleSnapshot,
          rating: input.ratingSnapshot as ExperimentRun["rating"],
          tags: JSON.parse(input.tagsJson),
          conditionSummary: input.beforeConditionSummary,
          variableParameterSummary: input.beforeVariableParameterSummary,
          methodSummary: input.beforeMethodSummary,
          resultSummary: input.beforeResultSummary,
          conclusion: input.beforeConclusion,
          summaryOther: input.beforeSummaryOther
        } as ExperimentRun,
        parent: { id: input.experimentId, projectId: input.projectId, title: input.parentTitleSnapshot } as Experiment,
        projectName: input.projectTitleSnapshot,
        currentFileName: null,
        defaultFileName: null,
        currentLocationMode: null,
        currentIsDefault: null,
        readOnly: false,
        recoveryPending: false
      });
      return experimentRunSwitchOutlineWritebackBuilder.apply(currentRawText, context);
    },
    success(snapshot, operationId, sessionKey) {
      return {
        status: "success",
        operationId,
        stage: "page-refresh",
        runId: snapshot.ownerId,
        sessionKey,
        currentFileRefId: snapshot.targetFileRefId,
        defaultManuscriptFileRefId: snapshot.defaultFileRefId,
        operationLogId: operationId,
        oldCurrentWrittenBack: true,
        databaseCommitted: true,
        currentChanged: true,
        defaultChanged: false,
        targetWritten: false,
        activationRequired: false,
        pageRefreshRequired: true
      };
    },
    recoveryRequired(error) {
      return {
        status: "recovery-required",
        operationId: error.operationId,
        stage: error.stage,
        error: error as never,
        oldCurrentWrittenBack: error.sideEffectSummary.oldCurrentWritten,
        databaseCommitted: error.sideEffectSummary.databaseCommitted,
        currentChanged: error.sideEffectSummary.databaseCommitted,
        defaultChanged: false,
        targetWritten: false,
        activationRequired: error.stage === "session-activation",
        pageRefreshRequired: error.sideEffectSummary.databaseCommitted
      };
    },
    error(error) {
      return { status: "error", error: error as never };
    },
    canceled() {
      return { status: "canceled", code: CODES.canceled };
    },
    publish(snapshot, operationId) {
      dependencies.publish(snapshot.ownerId, snapshot.parentOwnerId ?? snapshot.parent.id, operationId);
    },
    async recordPrePreparedFailure(details) {
      if (dependencies.recordFailure) await dependencies.recordFailure(details, details.ownerId);
      else await defaultDependencies.recordFailure?.(details, details.ownerId);
    }
  };
}

export const experimentRunFormalSwitchAdapter = createExperimentRunFormalSwitchAdapter();

const experimentRunReferenceOwnerProvider: ReferenceOwnerProductionProvider<RunSnapshot> = {
  buildBeginInput({ snapshot, evidence, expectedPost, operationId, occurredAt, replacements }) {
    return {
      ownerType: "experimentRun",
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
        snapshot.parent.id,
        snapshot.currentRevision,
        snapshot.targetRevision,
        evidence.oldCurrentExpectedPostDigest
      ].join(":"),
      currentRuntime: {
        actualRuntimeHandle: snapshot.currentSessionKey,
        runtimeGeneration: snapshot.currentSession.sessionGeneration,
        runtimeConsumerId: snapshot.currentSession.consumerHandle ?? snapshot.currentSessionKey,
        logicalIdentity: `experimentRun:${snapshot.ownerId}:primary:current:${snapshot.currentFileRefId}`,
        fileRefId: snapshot.currentFileRefId
      },
      targetRuntime: {
        actualRuntimeHandle: snapshot.targetSessionKey,
        runtimeGeneration: snapshot.targetSession.sessionGeneration,
        runtimeConsumerId: snapshot.targetSession.consumerHandle ?? snapshot.targetSessionKey,
        logicalIdentity: `experimentRun:${snapshot.ownerId}:primary:independent:${snapshot.targetFileRefId}`,
        fileRefId: snapshot.targetFileRefId
      }
    };
  },
  activate(snapshot) {
    return convergeCanonicalFormalSwitchRuntime({
      ownerType: "experimentRun",
      ownerId: snapshot.ownerId,
      channel: "primary",
      targetFileRefId: snapshot.targetFileRefId,
      consumerId: `experiment-run-formal-switch:${snapshot.ownerId}:primary`,
      openCurrent: async (consumerId) => {
        const opened = await defaultDependencies.rawService.openCurrent(
          snapshot.ownerId,
          consumerId
        );
        return opened.status === "success" && opened.sessionKey && opened.session
          ? { status: "success", sessionKey: opened.sessionKey, session: opened.session }
          : { status: opened.status };
      }
    });
  },
  activateRecovered(ticket) {
    return convergeCanonicalFormalSwitchRuntime({
      ownerType: "experimentRun",
      ownerId: ticket.ownerId,
      channel: "primary",
      targetFileRefId: ticket.targetFileRefId,
      consumerId: `experiment-run-formal-switch:${ticket.ownerId}:primary`,
      openCurrent: async (consumerId) => {
        const opened = await defaultDependencies.rawService.openCurrent(
          ticket.ownerId,
          consumerId
        );
        return opened.status === "success" && opened.sessionKey && opened.session
          ? { status: "success", sessionKey: opened.sessionKey, session: opened.session }
          : { status: opened.status };
      }
    });
  },
  readActivatedRuntime({ sessionKey, ticket }) {
    const session = defaultDependencies.rawService.getSession(sessionKey);
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
        session.owner.ownerType === "experimentRun" &&
        session.owner.ownerId === ticket.ownerId &&
        session.windowRole === "current" &&
        session.file.fileRefId === ticket.targetFileRefId
    };
  }
};

const experimentRunCanonicalProductionBridge =
  createReferenceOwnerFormalSwitchProductionBridge({
    adapter: experimentRunFormalSwitchAdapter,
    provider: experimentRunReferenceOwnerProvider,
    manuscriptChannel: "primary"
  });

function bindRunService(
  engine: ReturnType<typeof createFormalSwitchEngine>,
  adapter: ReturnType<typeof createExperimentRunFormalSwitchAdapter>,
  dependencies: ExperimentRunFormalSwitchDependencies,
  canonicalRecoveryList?: (runId: string) => Promise<import("../types/experimentRunManuscriptSwitch").ExperimentRunSwitchRecoveryRecord[]>
) {
  return Object.freeze({
    preflight(runId: string, targetSessionKey: string) {
      return engine.preflight(adapter, runId, targetSessionKey);
    },
    confirm(preflightToken: string) {
      return engine.confirm(adapter, preflightToken);
    },
    listRecoveries(runId: string) {
      if (canonicalRecoveryList) return canonicalRecoveryList(runId);
      return dependencies.recoveryPort.list(runId);
    },
    continueRecovery(operationId: string) {
      return engine.continueRecovery(adapter, operationId);
    },
    safeCancelRecovery(operationId: string) {
      return engine.safeCancel(adapter, operationId);
    }
  });
}

export function createExperimentRunManuscriptSwitchService(
  dependencies: ExperimentRunFormalSwitchDependencies = defaultDependencies
) {
  return bindRunService(createFormalSwitchEngine(), createExperimentRunFormalSwitchAdapter(dependencies), dependencies);
}

export const experimentRunManuscriptSwitchService = bindRunService(
  ({
    preflight: (_adapter: unknown, runId: string, targetSessionKey: string) =>
      experimentRunCanonicalProductionBridge.preflight(runId, targetSessionKey),
    confirm: (_adapter: unknown, token: string) => experimentRunCanonicalProductionBridge.confirm(token),
    continueRecovery: (_adapter: unknown, operationId: string) =>
      experimentRunCanonicalProductionBridge.continueRecovery(operationId),
    safeCancel: (_adapter: unknown, operationId: string) =>
      experimentRunCanonicalProductionBridge.safeCancel(operationId)
  } as unknown as ReturnType<typeof createFormalSwitchEngine>),
  experimentRunFormalSwitchAdapter,
  defaultDependencies,
  async (runId) => (await experimentRunCanonicalProductionBridge.listRecoveries(runId)).map((item) => {
    if (!item.parentOwnerId) throw new Error("RUN_SWITCH_RECOVERY_PARENT_IDENTITY_MISSING");
    return {
      recoveryId: `canonical:${item.operationId}`,
      operationId: item.operationId,
      runId,
      experimentId: item.parentOwnerId,
      projectId: item.projectId,
      phase: ({
        prepared: "prepared",
        settlement_started: "writeback_unknown",
        settlement_complete: "writeback_applied",
        db_pending: "db_commit_unknown",
        db_complete: "db_committed",
        activation_pending: "activation_pending",
        contained: "blocked",
        blocked: "blocked"
      } as Readonly<Record<string, string>>)[item.phase] ?? "blocked",
      targetFileRefId: item.targetFileRefId,
      oldCurrentFileRefId: item.oldCurrentFileRefId,
      defaultFileRefId: item.defaultFileRefId,
      oldCurrentFileName: "",
      targetFileName: "",
      defaultFileName: "",
      oldCurrentPreRevision: "canonical-v53",
      writebackDigest: "canonical-v53",
      writebackByteLength: 0,
      recordedAt: new Date(item.createdAtEpochMs).toISOString(),
      activationStatus: item.phase === "activation_pending" ? "pending" : "not-started",
      createdAt: new Date(item.createdAtEpochMs).toISOString(),
      updatedAt: new Date(item.createdAtEpochMs).toISOString()
    } as ExperimentRunSwitchRecoveryRecord;
  })
);

export type ExperimentRunManuscriptSwitchService = ReturnType<
  typeof createExperimentRunManuscriptSwitchService
>;
