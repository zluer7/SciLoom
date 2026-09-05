import type {
  AIParseDraftSourceSnapshot,
  AIStandardResult,
  AIStandardResultEffectReceipt,
  AIStandardResultTarget,
  AIStandardResultValidationIssue
} from "../types/aiStandardResult";
import type { Experiment, FileRef, ManuscriptBinding } from "../types";
import type { SharedManuscriptSession } from "../types/sharedManuscriptSession";
import {
  canonicalAIStandardResultFingerprint,
  AI_STANDARD_RESULT_MAX_PAYLOAD_CHARS
} from "./aiStandardResultService";
import { validateAIExperimentStandardResultProposal } from "./aiExperimentStandardResultAdapter";
import { experimentService } from "./experimentService";
import { planningService } from "./planningService";
import { resolveMountedManuscriptLifecycleDecision } from "./fileRefOwnerValidator";
import { manuscriptBindingService } from "./manuscriptBindingService";
import { fileRefService } from "./fileRefService";
import { manuscriptListService } from "./manuscriptListService";
import { manuscriptIoService } from "./manuscriptIoService";
import {
  parseLabPodMarkdownDocument,
  serializeLabPodMarkdownDocument
} from "./labPodMarkdownDocumentService";
import {
  experimentManuscriptSaveAsAdapter
} from "./experimentManuscriptSaveAsAdapter";
import { manuscriptSaveAsOperationPort, type SaveAsOperationRecord } from "./manuscriptSaveAsOperationPort";
import { sha256SaveAsRaw } from "./manuscriptSaveAsSourceSnapshot";
import { experimentIndependentRawManuscriptService } from "./experimentIndependentRawManuscriptService";
import { sharedManuscriptSessionRuntime } from "./sharedManuscriptSessionComposition";
import { getManagedPathParent } from "./managedPathService";

export const AI_EXPERIMENT_NEW_MANUSCRIPT_BODY_MAX_CHARS = 6_000;
export const AI_EXPERIMENT_NEW_MANUSCRIPT_ENCODING = "utf-8" as const;
export const AI_EXPERIMENT_NEW_MANUSCRIPT_LINE_ENDING = "LF" as const;
export const AI_EXPERIMENT_NEW_MANUSCRIPT_TERMINAL_NEWLINE =
  "one LF for the complete LabPod Markdown document" as const;
export const AI_EXPERIMENT_NEW_MANUSCRIPT_READBACK_STATE =
  "AUTHORITATIVE_FILE_REF_LIST_PHYSICAL_BODY_BINDING_PRESERVED" as const;

type ExperimentTarget = Extract<AIStandardResultTarget, { module: "experiment" }>;

export type AIExperimentManuscriptValidation = {
  executable: boolean;
  normalizedPayload: Record<string, unknown>;
  validationIssues: AIStandardResultValidationIssue[];
  targetSnapshotFingerprint?: string;
};

export type AIExperimentManuscriptEffectOutcome =
  | { kind: "settled"; receipt: AIStandardResultEffectReceipt }
  | { kind: "pending"; code: string; message: string }
  | { kind: "no_effect_failure"; code: string; message: string };

export type AIExperimentManuscriptTargetAcceptanceOutcome =
  | { status: "accepted"; targetFileName: string }
  | { status: "canceled" };

export class AIExperimentManuscriptTargetAcceptanceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AIExperimentManuscriptTargetAcceptanceError";
  }
}

class AIExperimentManuscriptReadbackPendingError extends Error {
  readonly effectMayExist = true;

  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AIExperimentManuscriptReadbackPendingError";
  }
}

type PreparedTarget = {
  resultId: string;
  visiblePayloadFingerprint: string;
  authorizationId: string;
  operationId: string;
  targetAcceptanceId: string;
  sourceSessionKey: string;
  serializedRawFingerprint: string;
};

type PreservationBaseline = {
  binding: ManuscriptBinding;
  currentFileRefId: string;
  currentPathIdentityKey: string;
  sourceDirectoryPathIdentityKey: string;
  currentPhysicalFingerprint: string;
};

export interface AIExperimentManuscriptDependencies {
  validateExperimentBase: typeof validateAIExperimentStandardResultProposal;
  getExperiment: typeof experimentService.getById;
  getProject: typeof planningService.getProjectById;
  resolveLifecycle: typeof resolveMountedManuscriptLifecycleDecision;
  getBinding: typeof manuscriptBindingService.getBindingByOwner;
  getFileRef: typeof fileRefService.getById;
  listManuscripts: typeof manuscriptListService.getAvailableManuscripts;
  readCurrentManuscript: typeof manuscriptIoService.readCurrentManuscript;
  readManuscriptByFileRef: typeof manuscriptIoService.readManuscriptByFileRef;
  prepareCanonicalTarget: typeof experimentManuscriptSaveAsAdapter.prepareTargetAcceptance;
  discardCanonicalTarget: typeof experimentManuscriptSaveAsAdapter.discardTargetAcceptance;
  saveAs: typeof experimentManuscriptSaveAsAdapter.saveAs;
  recoverSaveAs: typeof experimentManuscriptSaveAsAdapter.recover;
  readOperation: typeof manuscriptSaveAsOperationPort.readback;
  openIndependent: typeof experimentIndependentRawManuscriptService.openRegistered;
  updateIndependentDraft: typeof experimentIndependentRawManuscriptService.updateDraft;
  closeIndependent: typeof experimentIndependentRawManuscriptService.requestClose;
  cancelIndependent: typeof experimentIndependentRawManuscriptService.cancel;
  listRuntimeSessions(): SharedManuscriptSession[];
}

const defaultDependencies: AIExperimentManuscriptDependencies = {
  validateExperimentBase: validateAIExperimentStandardResultProposal,
  getExperiment: experimentService.getById,
  getProject: planningService.getProjectById,
  resolveLifecycle: resolveMountedManuscriptLifecycleDecision,
  getBinding: manuscriptBindingService.getBindingByOwner,
  getFileRef: fileRefService.getById,
  listManuscripts: manuscriptListService.getAvailableManuscripts,
  readCurrentManuscript: manuscriptIoService.readCurrentManuscript,
  readManuscriptByFileRef: manuscriptIoService.readManuscriptByFileRef,
  prepareCanonicalTarget: (input) =>
    experimentManuscriptSaveAsAdapter.prepareTargetAcceptance(input),
  discardCanonicalTarget: (targetAcceptanceId) =>
    experimentManuscriptSaveAsAdapter.discardTargetAcceptance(targetAcceptanceId),
  saveAs: (input) => experimentManuscriptSaveAsAdapter.saveAs(input),
  recoverSaveAs: (operationId, experimentId, acknowledgePresentation) =>
    experimentManuscriptSaveAsAdapter.recover(
      operationId,
      experimentId,
      acknowledgePresentation
    ),
  readOperation: (operationId) => manuscriptSaveAsOperationPort.readback(operationId),
  openIndependent: (experimentId, fileRefId, consumerId) =>
    experimentIndependentRawManuscriptService.openRegistered(
      experimentId,
      fileRefId,
      consumerId
    ),
  updateIndependentDraft: (sessionKey, raw) =>
    experimentIndependentRawManuscriptService.updateDraft(sessionKey, raw),
  closeIndependent: (sessionKey, decision) =>
    experimentIndependentRawManuscriptService.requestClose(sessionKey, decision),
  cancelIndependent: (sessionKey) =>
    experimentIndependentRawManuscriptService.cancel(sessionKey),
  listRuntimeSessions: () => sharedManuscriptSessionRuntime.listSessions()
};

function issue(code: string, message: string, field?: string): AIStandardResultValidationIssue {
  return { code, message, ...(field ? { field } : {}) };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function charCount(value: string) {
  return Array.from(value).length;
}

function hasWellFormedUnicode(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function containsProtocolAuthority(value: string) {
  return /LABPOD_(?:META_SNAPSHOT|OUTLINE|BODY)_(?:START|END)/iu.test(value);
}

export function normalizeAIExperimentManuscriptBody(value: string) {
  return value.replace(/\r\n/gu, "\n");
}

function normalizeBody(
  value: unknown,
  issues: AIStandardResultValidationIssue[]
): string | undefined {
  const payload = asRecord(value);
  if (!payload || Object.keys(payload).length !== 1 || !("body" in payload)) {
    issues.push(issue(
      "EXPERIMENT_MANUSCRIPT_PAYLOAD_INVALID",
      "The visible Experiment manuscript payload requires exactly one editable body field."
    ));
    return undefined;
  }
  if (typeof payload.body !== "string") {
    issues.push(issue(
      "EXPERIMENT_MANUSCRIPT_BODY_INVALID",
      "body must be a Markdown string.",
      "body"
    ));
    return undefined;
  }
  const body = payload.body;
  const invalid = !body.trim() || body.includes("\0") ||
    body.replace(/\r\n/gu, "").includes("\r") ||
    /[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F\uFEFF]/u.test(body) ||
    !hasWellFormedUnicode(body) || containsProtocolAuthority(body);
  if (invalid) {
    issues.push(issue(
      "EXPERIMENT_MANUSCRIPT_BODY_INVALID",
      "body must be non-empty well-formed Unicode Markdown with no NUL, hidden control, protocol marker, BOM, or bare CR.",
      "body"
    ));
    return undefined;
  }
  if (charCount(body) > AI_EXPERIMENT_NEW_MANUSCRIPT_BODY_MAX_CHARS) {
    issues.push(issue(
      "EXPERIMENT_MANUSCRIPT_BODY_OVERFLOW",
      `body exceeds the ${AI_EXPERIMENT_NEW_MANUSCRIPT_BODY_MAX_CHARS}-Unicode-character limit; truncation is forbidden.`,
      "body"
    ));
    return undefined;
  }
  const normalized = normalizeAIExperimentManuscriptBody(body);
  if (charCount(JSON.stringify({ body: normalized })) > AI_STANDARD_RESULT_MAX_PAYLOAD_CHARS) {
    issues.push(issue(
      "EXPERIMENT_MANUSCRIPT_SHARED_PAYLOAD_LIMIT",
      `The serialized payload exceeds the shared ${AI_STANDARD_RESULT_MAX_PAYLOAD_CHARS}-character bound.`,
      "body"
    ));
    return undefined;
  }
  return normalized;
}

function exactBindingIdentity(binding: ManuscriptBinding | undefined, experimentId: string) {
  return Boolean(
    binding && !binding.deletedAt &&
    binding.ownerType === "experiment" &&
    binding.ownerId === experimentId &&
    binding.manuscriptChannel === "primary"
  );
}

function bindingProjection(binding: ManuscriptBinding) {
  return {
    id: binding.id,
    ownerType: binding.ownerType,
    ownerId: binding.ownerId,
    manuscriptChannel: binding.manuscriptChannel,
    defaultFolderFileRefId: binding.defaultFolderFileRefId ?? null,
    defaultManuscriptFileRefId: binding.defaultManuscriptFileRefId ?? null,
    currentFileRefId: binding.currentFileRefId ?? null,
    updatedAt: binding.updatedAt
  };
}

function sameBinding(left: ManuscriptBinding, right: ManuscriptBinding) {
  return canonicalAIStandardResultFingerprint(bindingProjection(left)) ===
    canonicalAIStandardResultFingerprint(bindingProjection(right));
}

function exactExperimentFileRef(fileRef: FileRef | undefined, experimentId: string) {
  return Boolean(
    fileRef && !fileRef.deletedAt &&
    fileRef.ownerType === "experiment" && fileRef.ownerId === experimentId &&
    fileRef.manuscriptChannel === "primary" && fileRef.resourceKind === "file" &&
    fileRef.fileRole === "manuscript"
  );
}

function managedParentPathIdentity(pathIdentityKey: string): string | undefined {
  try {
    return getManagedPathParent(pathIdentityKey);
  } catch {
    return undefined;
  }
}

function targetFingerprint(
  experiment: Experiment,
  binding: ManuscriptBinding
) {
  return canonicalAIStandardResultFingerprint({
    experiment: {
      id: experiment.id,
      projectId: experiment.projectId,
      status: experiment.status,
      updatedAt: experiment.updatedAt,
      deletedAt: experiment.deletedAt ?? null
    },
    bindingIdentity: {
      id: binding.id,
      ownerType: binding.ownerType,
      ownerId: binding.ownerId,
      manuscriptChannel: binding.manuscriptChannel
    }
  });
}

function operationRequestKey(resultId: string, authorizationId: string) {
  const key = `a11-exp-man:${resultId}:${authorizationId}`;
  if (
    key !== key.trim() || !key.trim() || Array.from(key).length > 200 ||
    /[\0-\x1F\x7F]/u.test(key)
  ) {
    throw new AIExperimentManuscriptTargetAcceptanceError(
      "EXPERIMENT_MANUSCRIPT_OPERATION_KEY_INVALID",
      "The Result/authorization identity cannot form one bounded canonical Save As operation key."
    );
  }
  return key;
}

function serializeBody(body: string) {
  return serializeLabPodMarkdownDocument({
    metaSnapshot: "",
    outline: "",
    body,
    newlineStyle: "lf",
    preserveBom: false,
    trailingNewline: true
  });
}

export function createAIExperimentManuscriptStandardResultAdapter(
  dependencies: AIExperimentManuscriptDependencies = defaultDependencies
) {
  const preparedByResult = new Map<string, PreparedTarget>();

  async function validate(input: {
    target: AIStandardResultTarget;
    source?: AIParseDraftSourceSnapshot;
    payload: unknown;
    expectedProjectId: string;
    expectedTargetSnapshotFingerprint?: string;
  }): Promise<AIExperimentManuscriptValidation> {
    const issues: AIStandardResultValidationIssue[] = [];
    if (input.target.module !== "experiment" || input.target.entityType !== "experiment") {
      return {
        executable: false,
        normalizedPayload: {},
        validationIssues: [issue(
          "EXPERIMENT_MANUSCRIPT_TARGET_INVALID",
          "NEW_MANUSCRIPT requires one exact canonical Experiment/primary target."
        )]
      };
    }
    const target = input.target;
    const base = await dependencies.validateExperimentBase({
      action: "NEW_MANUSCRIPT",
      target,
      source: input.source,
      payload: input.payload,
      expectedProjectId: input.expectedProjectId
    });
    issues.push(...base.validationIssues.filter(
      (candidate) => candidate.code !== "EXPERIMENT_NEW_MANUSCRIPT_NOT_ENABLED_IN_A10"
    ));
    if (!target.entityId) {
      issues.push(issue(
        "EXPERIMENT_MANUSCRIPT_OWNER_REQUIRED",
        "NEW_MANUSCRIPT requires an existing canonical Experiment identity.",
        "target.entityId"
      ));
    }
    if (target.manuscriptChannel !== "primary") {
      issues.push(issue(
        "EXPERIMENT_MANUSCRIPT_CHANNEL_INVALID",
        "Experiment NEW_MANUSCRIPT requires the fixed primary channel.",
        "target.manuscriptChannel"
      ));
    }
    const body = normalizeBody(input.payload, issues);
    const [experiment, project] = await Promise.all([
      target.entityId ? dependencies.getExperiment(target.entityId) : undefined,
      dependencies.getProject(input.expectedProjectId)
    ]);
    if (!experiment || experiment.deletedAt || experiment.status === "archived") {
      issues.push(issue(
        "EXPERIMENT_MANUSCRIPT_OWNER_UNAVAILABLE",
        "The canonical Experiment owner is missing, deleted, or archived."
      ));
    } else if (experiment.projectId !== input.expectedProjectId) {
      issues.push(issue(
        "EXPERIMENT_MANUSCRIPT_SCOPE_MISMATCH",
        "The canonical Experiment no longer belongs to the reviewed Project."
      ));
    }
    if (!project || project.deletedAt || project.status === "archived") {
      issues.push(issue(
        "EXPERIMENT_MANUSCRIPT_PROJECT_UNAVAILABLE",
        "The reviewed canonical Project is unavailable."
      ));
    }
    let binding: ManuscriptBinding | undefined;
    if (experiment) {
      try {
        const lifecycle = await dependencies.resolveLifecycle({
          ownerType: "experiment",
          ownerId: experiment.id,
          manuscriptChannel: "primary"
        });
        if (!lifecycle.canSaveAs || !lifecycle.canOpenIndependent || lifecycle.readOnly) {
          issues.push(issue(
            "EXPERIMENT_MANUSCRIPT_LIFECYCLE_INELIGIBLE",
            "The current Experiment lifecycle does not allow an independent managed manuscript."
          ));
        }
      } catch (error) {
        issues.push(issue(
          "EXPERIMENT_MANUSCRIPT_LIFECYCLE_INELIGIBLE",
          error instanceof Error ? error.message : "The Experiment manuscript lifecycle is unavailable."
        ));
      }
      try {
        binding = await dependencies.getBinding("experiment", experiment.id, "primary");
      } catch (error) {
        issues.push(issue(
          "EXPERIMENT_MANUSCRIPT_BINDING_CONFLICT",
          error instanceof Error ? error.message : "The Experiment/primary Binding is ambiguous."
        ));
      }
      if (!exactBindingIdentity(binding, experiment.id)) {
        issues.push(issue(
          "EXPERIMENT_MANUSCRIPT_BINDING_UNAVAILABLE",
          "The canonical Experiment/primary Binding identity is unavailable."
        ));
      } else if (
        !binding?.defaultFolderFileRefId || !binding.defaultManuscriptFileRefId ||
        !binding.currentFileRefId
      ) {
        issues.push(issue(
          "EXPERIMENT_MANUSCRIPT_BINDING_INCOMPLETE",
          "Current Experiment creation requires complete primary default/current provisioning before A11."
        ));
      } else {
        const [folder, defaultManuscript, current] = await Promise.all([
          dependencies.getFileRef(binding.defaultFolderFileRefId),
          dependencies.getFileRef(binding.defaultManuscriptFileRefId),
          dependencies.getFileRef(binding.currentFileRefId)
        ]);
        if (
          !folder || folder.deletedAt || folder.ownerType !== "experiment" ||
          folder.ownerId !== experiment.id || folder.manuscriptChannel !== "primary" ||
          folder.resourceKind !== "folder" || folder.fileRole !== "defaultFolder" ||
          !exactExperimentFileRef(defaultManuscript, experiment.id) ||
          !exactExperimentFileRef(current, experiment.id)
        ) {
          issues.push(issue(
            "EXPERIMENT_MANUSCRIPT_BINDING_IDENTITY_DRIFT",
            "The Experiment/primary Binding references no exact active canonical default/current resources."
          ));
        }
      }
    }
    const currentFingerprint = experiment && binding && exactBindingIdentity(binding, experiment.id)
      ? targetFingerprint(experiment, binding)
      : undefined;
    if (
      input.expectedTargetSnapshotFingerprint &&
      currentFingerprint !== input.expectedTargetSnapshotFingerprint
    ) {
      issues.push(issue(
        "EXPERIMENT_MANUSCRIPT_TARGET_STALE",
        "The Experiment or canonical Binding identity changed after Parse Draft; re-parse is required."
      ));
    }
    return {
      executable: issues.length === 0,
      normalizedPayload: body === undefined ? {} : { body },
      validationIssues: issues,
      ...(currentFingerprint ? { targetSnapshotFingerprint: currentFingerprint } : {})
    };
  }

  async function closeSession(sessionKey: string) {
    try {
      const closed = await dependencies.closeIndependent(sessionKey, "discard");
      if (closed.status !== "success" && closed.status !== "no-op") {
        dependencies.cancelIndependent(sessionKey);
      }
    } catch {
      dependencies.cancelIndependent(sessionKey);
    }
  }

  async function release(resultId: string) {
    const prepared = preparedByResult.get(resultId);
    if (!prepared) return;
    preparedByResult.delete(resultId);
    dependencies.discardCanonicalTarget(prepared.targetAcceptanceId);
    await closeSession(prepared.sourceSessionKey);
  }

  async function prepareTargetAcceptance(input: {
    result: AIStandardResult;
    normalizedPayload: Record<string, unknown>;
    plannedAuthorizationId: string;
  }): Promise<AIExperimentManuscriptTargetAcceptanceOutcome> {
    const { result } = input;
    if (
      result.target.module !== "experiment" || result.action !== "NEW_MANUSCRIPT" ||
      result.category !== "MANUSCRIPT_RESULT" || !result.target.entityId ||
      result.target.manuscriptChannel !== "primary" ||
      !input.plannedAuthorizationId.trim()
    ) {
      throw new AIExperimentManuscriptTargetAcceptanceError(
        "EXPERIMENT_MANUSCRIPT_TARGET_ACCEPTANCE_INVALID",
        "Only one pending exact Experiment/primary NEW_MANUSCRIPT Result can select a target."
      );
    }
    await release(result.id);
    const operationId = operationRequestKey(result.id, input.plannedAuthorizationId);
    let existingOperation: SaveAsOperationRecord | null;
    try {
      existingOperation = await dependencies.readOperation(operationId);
    } catch (error) {
      throw new AIExperimentManuscriptTargetAcceptanceError(
        "EXPERIMENT_MANUSCRIPT_OPERATION_READBACK_UNAVAILABLE",
        error instanceof Error ? error.message : "The canonical operation authority is unavailable."
      );
    }
    if (existingOperation) {
      throw new AIExperimentManuscriptTargetAcceptanceError(
        "EXPERIMENT_MANUSCRIPT_OPERATION_ALREADY_EXISTS",
        "An unclaimed Result cannot select a new target for an existing operation."
      );
    }
    const binding = await dependencies.getBinding(
      "experiment",
      result.target.entityId,
      "primary"
    );
    if (!binding?.currentFileRefId || !exactBindingIdentity(binding, result.target.entityId)) {
      throw new AIExperimentManuscriptTargetAcceptanceError(
        "EXPERIMENT_MANUSCRIPT_BINDING_UNAVAILABLE",
        "The exact Experiment/primary current manuscript is unavailable for canonical Save As."
      );
    }
    const conflict = dependencies.listRuntimeSessions().some((session) =>
      session.windowRole === "independent" &&
      session.owner.ownerType === "experiment" &&
      session.owner.ownerId === result.target.entityId &&
      session.owner.channel === "primary" &&
      session.file.kind === "durable" &&
      session.file.fileRefId === binding.currentFileRefId
    );
    if (conflict) {
      throw new AIExperimentManuscriptTargetAcceptanceError(
        "EXPERIMENT_MANUSCRIPT_SOURCE_SESSION_CONFLICT",
        "Close the existing independent window for the current manuscript before selecting an AI target."
      );
    }
    const opened = await dependencies.openIndependent(
      result.target.entityId,
      binding.currentFileRefId,
      `ai-experiment-manuscript:${result.id}:source`
    );
    if (opened.status !== "success") {
      throw new AIExperimentManuscriptTargetAcceptanceError(
        "EXPERIMENT_MANUSCRIPT_SOURCE_OPEN_FAILED",
        "The canonical independent source session could not be opened."
      );
    }
    const sourceSessionKey = opened.sessionKey;
    const body = input.normalizedPayload.body as string;
    const serializedRaw = serializeBody(body);
    const updated = dependencies.updateIndependentDraft(sourceSessionKey, serializedRaw);
    if (updated.status !== "success") {
      await closeSession(sourceSessionKey);
      throw new AIExperimentManuscriptTargetAcceptanceError(
        "EXPERIMENT_MANUSCRIPT_SOURCE_DRAFT_FAILED",
        "The canonical independent source draft could not be frozen."
      );
    }
    let accepted: Awaited<ReturnType<typeof dependencies.prepareCanonicalTarget>>;
    try {
      accepted = await dependencies.prepareCanonicalTarget({
        experimentId: result.target.entityId,
        sourceSessionKey,
        sourceWindowRole: "independent",
        pickerTitle: "Choose a managed file for the new Experiment manuscript",
        operationRequestKey: operationId,
        requireManagedTarget: true
      });
    } catch (error) {
      await closeSession(sourceSessionKey);
      throw new AIExperimentManuscriptTargetAcceptanceError(
        "EXPERIMENT_MANUSCRIPT_TARGET_SELECTION_FAILED",
        error instanceof Error ? error.message : "The LP12 target picker failed safely."
      );
    }
    if (accepted.status === "canceled") {
      await closeSession(sourceSessionKey);
      return { status: "canceled" };
    }
    if (accepted.status !== "accepted") {
      await closeSession(sourceSessionKey);
      throw new AIExperimentManuscriptTargetAcceptanceError(
        "EXPERIMENT_MANUSCRIPT_TARGET_SELECTION_FAILED",
        `The LP12 target picker rejected the target (${accepted.error.code}).`
      );
    }
    preparedByResult.set(result.id, {
      resultId: result.id,
      visiblePayloadFingerprint: result.visiblePayloadFingerprint,
      authorizationId: input.plannedAuthorizationId,
      operationId,
      targetAcceptanceId: accepted.targetAcceptanceId,
      sourceSessionKey,
      serializedRawFingerprint: await sha256SaveAsRaw(serializedRaw)
    });
    return { status: "accepted", targetFileName: accepted.targetFileName };
  }

  function preparedAuthorizationId(result: AIStandardResult) {
    const prepared = preparedByResult.get(result.id);
    return prepared &&
      result.target.module === "experiment" &&
      result.action === "NEW_MANUSCRIPT" &&
      prepared.visiblePayloadFingerprint === result.visiblePayloadFingerprint
      ? prepared.authorizationId
      : undefined;
  }

  async function preservationBaseline(experimentId: string): Promise<PreservationBaseline> {
    const binding = await dependencies.getBinding("experiment", experimentId, "primary");
    if (
      !binding || !exactBindingIdentity(binding, experimentId) ||
      !binding.defaultFolderFileRefId || !binding.defaultManuscriptFileRefId ||
      !binding.currentFileRefId
    ) {
      throw new AIExperimentManuscriptTargetAcceptanceError(
        "EXPERIMENT_MANUSCRIPT_BINDING_STALE",
        "The exact complete Experiment/primary Binding is unavailable before the formal effect."
      );
    }
    const [current, currentFileRef, defaultFolderFileRef] = await Promise.all([
      dependencies.readCurrentManuscript(
        "experiment",
        experimentId,
        { manuscriptChannel: "primary" }
      ),
      dependencies.getFileRef(binding.currentFileRefId),
      dependencies.getFileRef(binding.defaultFolderFileRefId)
    ]);
    const sourceDirectoryPathIdentityKey = currentFileRef
      ? managedParentPathIdentity(currentFileRef.pathIdentityKey)
      : undefined;
    if (
      current.status !== "success" || current.fileRefId !== binding.currentFileRefId ||
      !currentFileRef ||
      !exactExperimentFileRef(currentFileRef, experimentId) ||
      currentFileRef.locationMode !== "managed" ||
      !defaultFolderFileRef || defaultFolderFileRef.deletedAt ||
      defaultFolderFileRef.ownerType !== "experiment" ||
      defaultFolderFileRef.ownerId !== experimentId ||
      defaultFolderFileRef.manuscriptChannel !== "primary" ||
      defaultFolderFileRef.resourceKind !== "folder" ||
      defaultFolderFileRef.fileRole !== "defaultFolder" ||
      defaultFolderFileRef.locationMode !== "managed" ||
      !sourceDirectoryPathIdentityKey ||
      defaultFolderFileRef.pathIdentityKey !== sourceDirectoryPathIdentityKey
    ) {
      throw new AIExperimentManuscriptTargetAcceptanceError(
        "EXPERIMENT_MANUSCRIPT_CURRENT_READBACK_UNAVAILABLE",
        "The existing managed current manuscript and exact source-directory preservation baseline are unavailable."
      );
    }
    return {
      binding,
      currentFileRefId: current.fileRefId,
      currentPathIdentityKey: currentFileRef.pathIdentityKey,
      sourceDirectoryPathIdentityKey,
      currentPhysicalFingerprint: canonicalAIStandardResultFingerprint(current.content)
    };
  }

  function operationIdentityMatches(
    operation: SaveAsOperationRecord,
    experimentId: string,
    operationId: string,
    serializedRawFingerprint: string
  ) {
    return operation.operationId === operationId &&
      operation.ownerType === "experiment" && operation.ownerId === experimentId &&
      operation.channel === "primary" && operation.sourceWindowRole === "independent" &&
      operation.targetLocationMode === "managed" &&
      operation.snapshotSha256 === serializedRawFingerprint &&
      operation.targetPathIdentityKey !== operation.sourcePathIdentityKey;
  }

  async function authoritativeReceipt(input: {
    result: AIStandardResult;
    normalizedBody: string;
    serializedRawFingerprint: string;
    operation: SaveAsOperationRecord;
    baseline?: PreservationBaseline;
  }): Promise<AIStandardResultEffectReceipt> {
    const target = input.result.target as ExperimentTarget;
    const experimentId = target.entityId!;
    const authorizationId = input.result.authorizationId!;
    const operationId = operationRequestKey(input.result.id, authorizationId);
    if (
      !operationIdentityMatches(
        input.operation,
        experimentId,
        operationId,
        input.serializedRawFingerprint
      ) ||
      input.operation.d1CommitState !== "confirmed" ||
      input.operation.d2CommitState !== "confirmed" ||
      !input.operation.targetFileRefId
    ) {
      throw new AIExperimentManuscriptReadbackPendingError(
        "EXPERIMENT_MANUSCRIPT_OPERATION_INCOMPLETE",
        "The bound canonical Save As operation has no complete D1/D2 readback."
      );
    }
    const baseline = input.baseline ?? await preservationBaseline(experimentId);
    const fileRef = await dependencies.getFileRef(input.operation.targetFileRefId);
    const operationGeneration = input.operation.operationGeneration;
    const expectedCandidateRequestId = Number.isInteger(operationGeneration) && operationGeneration > 0
      ? `${operationId}:${operationGeneration}`
      : undefined;
    const candidateDirectoryPathIdentityKey = fileRef
      ? managedParentPathIdentity(fileRef.pathIdentityKey)
      : undefined;
    if (
      !fileRef || !exactExperimentFileRef(fileRef, experimentId) ||
      fileRef.id !== input.operation.targetFileRefId ||
      fileRef.locationMode !== "managed" ||
      !expectedCandidateRequestId ||
      fileRef.candidateRequestId !== expectedCandidateRequestId ||
      !fileRef.candidateOccurredAt?.trim() ||
      input.operation.sourceFileRefId !== baseline.currentFileRefId ||
      input.operation.sourcePathIdentityKey !== baseline.currentPathIdentityKey ||
      input.operation.targetPathIdentityKey !== fileRef.pathIdentityKey ||
      input.operation.targetParentPathIdentityKey !== baseline.sourceDirectoryPathIdentityKey ||
      candidateDirectoryPathIdentityKey !== baseline.sourceDirectoryPathIdentityKey ||
      fileRef.pathIdentityKey === baseline.currentPathIdentityKey
    ) {
      throw new AIExperimentManuscriptReadbackPendingError(
        "EXPERIMENT_MANUSCRIPT_FILE_REF_MISMATCH",
        "The operation does not resolve to the exact correlated candidate-scoped managed Experiment/primary FileRef in the frozen source directory."
      );
    }
    const available = await dependencies.listManuscripts(
      "experiment",
      experimentId,
      "primary"
    );
    if (
      available.status !== "success" ||
      available.items.filter((item) => item.fileRefId === fileRef.id).length !== 1
    ) {
      throw new AIExperimentManuscriptReadbackPendingError(
        "EXPERIMENT_MANUSCRIPT_NOT_DISCOVERABLE",
        "The new FileRef is not uniquely discoverable through the canonical manuscript list."
      );
    }
    const physical = await dependencies.readManuscriptByFileRef(
      "experiment",
      experimentId,
      fileRef.id,
      { manuscriptChannel: "primary" }
    );
    if (physical.status !== "success") {
      throw new AIExperimentManuscriptReadbackPendingError(
        "EXPERIMENT_MANUSCRIPT_PHYSICAL_READBACK_UNAVAILABLE",
        "The new managed Markdown file is unavailable through the canonical reader."
      );
    }
    const parsed = parseLabPodMarkdownDocument(physical.content);
    if (
      (parsed.status !== "valid" && parsed.status !== "valid-empty") ||
      parsed.body !== input.normalizedBody || parsed.hasBom || parsed.newlineStyle !== "lf"
    ) {
      throw new AIExperimentManuscriptReadbackPendingError(
        "EXPERIMENT_MANUSCRIPT_BODY_CORRELATION_FAILED",
        "The parsed physical BODY does not match the latest confirmed visible BODY."
      );
    }
    const afterBinding = await dependencies.getBinding("experiment", experimentId, "primary");
    if (
      !afterBinding || !sameBinding(baseline.binding, afterBinding) ||
      afterBinding.currentFileRefId === fileRef.id ||
      afterBinding.defaultManuscriptFileRefId === fileRef.id
    ) {
      throw new AIExperimentManuscriptReadbackPendingError(
        "EXPERIMENT_MANUSCRIPT_BINDING_MUTATED",
        "The new independent artifact unexpectedly changed current/default Binding state."
      );
    }
    const afterCurrent = await dependencies.readCurrentManuscript(
      "experiment",
      experimentId,
      { manuscriptChannel: "primary" }
    );
    if (
      afterCurrent.status !== "success" ||
      afterCurrent.fileRefId !== baseline.currentFileRefId ||
      canonicalAIStandardResultFingerprint(afterCurrent.content) !==
        baseline.currentPhysicalFingerprint
    ) {
      throw new AIExperimentManuscriptReadbackPendingError(
        "EXPERIMENT_MANUSCRIPT_CURRENT_BODY_MUTATED",
        "The existing current manuscript BODY changed during independent artifact creation."
      );
    }
    const confirmedBodyFingerprint = canonicalAIStandardResultFingerprint(input.normalizedBody);
    const physicalBodyFingerprint = canonicalAIStandardResultFingerprint(parsed.body);
    return {
      module: "experiment",
      entityType: "fileRef",
      entityId: fileRef.id,
      operation: "NEW_MANUSCRIPT",
      service: "experimentManuscriptSaveAsAdapter.saveAs",
      canonicalReadback: {
        projectId: target.projectId,
        experimentId,
        manuscriptChannel: "primary",
        resultId: input.result.id,
        authorizationId,
        operationId,
        operationGeneration,
        fileRefId: fileRef.id,
        candidateRequestId: fileRef.candidateRequestId,
        candidateOccurredAt: fileRef.candidateOccurredAt,
        sourceFileRefId: baseline.currentFileRefId,
        sourcePathIdentityKey: baseline.currentPathIdentityKey,
        sourceDirectoryPathIdentityKey: baseline.sourceDirectoryPathIdentityKey,
        candidatePathIdentityKey: fileRef.pathIdentityKey,
        candidateDirectoryPathIdentityKey,
        resourceKind: fileRef.resourceKind,
        fileRole: fileRef.fileRole,
        targetLocationMode: fileRef.locationMode,
        operationStage: input.operation.stage,
        d1CommitState: input.operation.d1CommitState,
        d2CommitState: input.operation.d2CommitState,
        confirmedPayloadFingerprint: input.result.confirmedPayloadFingerprint,
        confirmedBodyFingerprint,
        physicalBodyFingerprint,
        physicalEncoding: physical.encoding,
        physicalSizeBytes: physical.sizeBytes,
        bodyNormalization: "CRLF_TO_LF",
        documentLineEnding: AI_EXPERIMENT_NEW_MANUSCRIPT_LINE_ENDING,
        documentTerminalNewline: AI_EXPERIMENT_NEW_MANUSCRIPT_TERMINAL_NEWLINE,
        bindingBefore: bindingProjection(baseline.binding),
        bindingAfter: bindingProjection(afterBinding),
        previousCurrentFileRefId: baseline.currentFileRefId,
        previousCurrentBodyFingerprint: baseline.currentPhysicalFingerprint,
        firstProvisioningDisposition: "NOT_REQUIRED_WITH_CURRENT_EXPERIMENT_CREATION_CONTRACT",
        bindingPreserved: true,
        currentChanged: false,
        defaultChanged: false,
        formalSwitchInvoked: false,
        readbackState: AI_EXPERIMENT_NEW_MANUSCRIPT_READBACK_STATE
      }
    };
  }

  async function pendingOrReceipt(input: {
    result: AIStandardResult;
    normalizedBody: string;
    serializedRawFingerprint: string;
    operation: SaveAsOperationRecord;
    baseline?: PreservationBaseline;
    allowSameOperationRecovery: boolean;
  }): Promise<AIExperimentManuscriptEffectOutcome> {
    try {
      const receipt = await authoritativeReceipt(input);
      return { kind: "settled", receipt };
    } catch (error) {
      if (!input.allowSameOperationRecovery) {
        return {
          kind: "pending",
          code: error instanceof AIExperimentManuscriptReadbackPendingError
            ? error.code
            : "EXPERIMENT_MANUSCRIPT_READBACK_UNKNOWN",
          message: error instanceof Error ? error.message : "The operation readback is incomplete."
        };
      }
    }
    const target = input.result.target as ExperimentTarget;
    try {
      const recovered = await dependencies.recoverSaveAs(
        input.operation.operationId,
        target.entityId!,
        async () => true
      );
      if (recovered.status === "success") {
        await closeSession(recovered.independentSessionKey);
        const reread = await dependencies.readOperation(input.operation.operationId);
        if (reread) {
          const receipt = await authoritativeReceipt({ ...input, operation: reread });
          return { kind: "settled", receipt };
        }
      }
      return {
        kind: "pending",
        code: "EXPERIMENT_MANUSCRIPT_SAME_OPERATION_RECOVERY_PENDING",
        message: "The existing canonical operation still requires authoritative recovery/readback."
      };
    } catch (error) {
      return {
        kind: "pending",
        code: "EXPERIMENT_MANUSCRIPT_SAME_OPERATION_RECOVERY_PENDING",
        message: error instanceof Error ? error.message : "Same-operation recovery remains pending."
      };
    }
  }

  async function invoke(input: {
    result: AIStandardResult;
    normalizedPayload: Record<string, unknown>;
    invocationMode: "initial" | "continuation";
  }): Promise<AIExperimentManuscriptEffectOutcome> {
    const { result } = input;
    if (
      result.target.module !== "experiment" || result.action !== "NEW_MANUSCRIPT" ||
      result.category !== "MANUSCRIPT_RESULT" || !result.target.entityId ||
      result.target.manuscriptChannel !== "primary" || !result.authorizationId ||
      !result.confirmedPayloadFingerprint
    ) {
      return {
        kind: "no_effect_failure",
        code: "EXPERIMENT_MANUSCRIPT_OPERATION_BINDING_INVALID",
        message: "The claimed Result has no exact Experiment/primary authorization binding."
      };
    }
    const normalizedBody = input.normalizedPayload.body as string;
    const serializedRaw = serializeBody(normalizedBody);
    const serializedRawFingerprint = await sha256SaveAsRaw(serializedRaw);
    const operationId = operationRequestKey(result.id, result.authorizationId);
    let prior: SaveAsOperationRecord | null;
    try {
      prior = await dependencies.readOperation(operationId);
    } catch (error) {
      return {
        kind: "pending",
        code: "EXPERIMENT_MANUSCRIPT_OPERATION_READBACK_UNKNOWN",
        message: error instanceof Error ? error.message : "The canonical operation readback is unavailable."
      };
    }
    if (prior) {
      if (!operationIdentityMatches(prior, result.target.entityId, operationId, serializedRawFingerprint)) {
        return {
          kind: "pending",
          code: "EXPERIMENT_MANUSCRIPT_OPERATION_IDENTITY_CONFLICT",
          message: "The deterministic operation identity resolves to mismatched canonical evidence."
        };
      }
      if (
        prior.stage === "pre_d1_closed" && prior.d1CommitState === "not_started" &&
        prior.d2CommitState === "not_started"
      ) {
        return {
          kind: "no_effect_failure",
          code: prior.blockingCode ?? "EXPERIMENT_MANUSCRIPT_ZERO_EFFECT",
          message: "The canonical operation closed before D1 with authoritative zero effect."
        };
      }
      return pendingOrReceipt({
        result,
        normalizedBody,
        serializedRawFingerprint,
        operation: prior,
        allowSameOperationRecovery: input.invocationMode === "continuation"
      });
    }
    if (input.invocationMode === "continuation") {
      return {
        kind: "no_effect_failure",
        code: "EXPERIMENT_MANUSCRIPT_OPERATION_NOT_STARTED",
        message: "The deterministic pre-effect operation record is absent, proving zero formal manuscript effect."
      };
    }
    const prepared = preparedByResult.get(result.id);
    if (
      !prepared || prepared.authorizationId !== result.authorizationId ||
      prepared.operationId !== operationId ||
      prepared.visiblePayloadFingerprint !== result.visiblePayloadFingerprint ||
      prepared.serializedRawFingerprint !== serializedRawFingerprint
    ) {
      return {
        kind: "no_effect_failure",
        code: "EXPERIMENT_MANUSCRIPT_TARGET_ACCEPTANCE_MISSING",
        message: "The exact latest BODY has no prior LP12 target acceptance; no formal effect was invoked."
      };
    }
    let baseline: PreservationBaseline;
    try {
      baseline = await preservationBaseline(result.target.entityId);
    } catch (error) {
      return {
        kind: "no_effect_failure",
        code: error instanceof AIExperimentManuscriptTargetAcceptanceError
          ? error.code
          : "EXPERIMENT_MANUSCRIPT_BASELINE_UNAVAILABLE",
        message: error instanceof Error ? error.message : "The fresh preservation baseline is unavailable."
      };
    }
    preparedByResult.delete(result.id);
    let saved: Awaited<ReturnType<typeof dependencies.saveAs>>;
    try {
      saved = await dependencies.saveAs({
        experimentId: result.target.entityId,
        sourceSessionKey: prepared.sourceSessionKey,
        sourceWindowRole: "independent",
        pickerTitle: "Choose a managed file for the new Experiment manuscript",
        acknowledgePresentation: async () => true,
        operationRequestKey: operationId,
        targetAcceptanceId: prepared.targetAcceptanceId,
        requireManagedTarget: true
      });
    } catch (error) {
      await closeSession(prepared.sourceSessionKey);
      dependencies.discardCanonicalTarget(prepared.targetAcceptanceId);
      let readback: SaveAsOperationRecord | null = null;
      try {
        readback = await dependencies.readOperation(operationId);
      } catch {
        // Unknown operation readback keeps the durable Result claimed PENDING.
      }
      return readback
        ? pendingOrReceipt({
            result,
            normalizedBody,
            serializedRawFingerprint,
            operation: readback,
            baseline,
            allowSameOperationRecovery: false
          })
        : {
            kind: "pending",
            code: "EXPERIMENT_MANUSCRIPT_EFFECT_UNKNOWN",
            message: error instanceof Error ? error.message : "The canonical Save As outcome is unknown."
          };
    }
    dependencies.discardCanonicalTarget(prepared.targetAcceptanceId);
    await closeSession(prepared.sourceSessionKey);
    if (saved.status === "success") {
      await closeSession(saved.independentSessionKey);
      const operation = await dependencies.readOperation(operationId);
      if (!operation || saved.operationId !== operationId || saved.fileRefId !== operation.targetFileRefId) {
        return {
          kind: "pending",
          code: "EXPERIMENT_MANUSCRIPT_OPERATION_READBACK_MISSING",
          message: "The canonical Save As success has no exact operation/FileRef readback."
        };
      }
      return pendingOrReceipt({
        result,
        normalizedBody,
        serializedRawFingerprint,
        operation,
        baseline,
        allowSameOperationRecovery: false
      });
    }
    if (saved.status === "canceled") {
      return {
        kind: "no_effect_failure",
        code: "EXPERIMENT_MANUSCRIPT_TARGET_ACCEPTANCE_CANCELED",
        message: "The pre-effect target acceptance was canceled with zero effect."
      };
    }
    let operation: SaveAsOperationRecord | null = null;
    try {
      operation = await dependencies.readOperation(operationId);
    } catch {
      // A failed readback cannot authorize redispatch or a terminal decision.
    }
    if (operation) {
      return pendingOrReceipt({
        result,
        normalizedBody,
        serializedRawFingerprint,
        operation,
        baseline,
        allowSameOperationRecovery: false
      });
    }
    return saved.status === "error"
      ? {
          kind: "no_effect_failure",
          code: saved.error.code,
          message: "The canonical Save As service proved zero effect before D1."
        }
      : {
          kind: "pending",
          code: saved.error.code,
          message: "The canonical Save As effect remains unknown and cannot be redispatched."
        };
  }

  return Object.freeze({
    validate,
    prepareTargetAcceptance,
    preparedAuthorizationId,
    release,
    invoke
  });
}

export const aiExperimentManuscriptStandardResultAdapter =
  createAIExperimentManuscriptStandardResultAdapter();

export function validateAIExperimentManuscriptStandardResultProposal(input: {
  target: AIStandardResultTarget;
  source?: AIParseDraftSourceSnapshot;
  payload: unknown;
  expectedProjectId: string;
  expectedTargetSnapshotFingerprint?: string;
}) {
  return aiExperimentManuscriptStandardResultAdapter.validate(input);
}

export function prepareAIExperimentManuscriptTargetAcceptance(input: {
  result: AIStandardResult;
  normalizedPayload: Record<string, unknown>;
  plannedAuthorizationId: string;
}) {
  return aiExperimentManuscriptStandardResultAdapter.prepareTargetAcceptance(input);
}

export function getPreparedAIExperimentManuscriptAuthorizationId(result: AIStandardResult) {
  return aiExperimentManuscriptStandardResultAdapter.preparedAuthorizationId(result);
}

export function releaseAIExperimentManuscriptTargetAcceptance(resultId: string) {
  return aiExperimentManuscriptStandardResultAdapter.release(resultId);
}

export function invokeAIExperimentManuscriptStandardResultEffect(input: {
  result: AIStandardResult;
  normalizedPayload: Record<string, unknown>;
  invocationMode: "initial" | "continuation";
}) {
  return aiExperimentManuscriptStandardResultAdapter.invoke(input);
}
