import type {
  AIParseDraftSourceSnapshot,
  AIStandardResult,
  AIStandardResultEffectReceipt,
  AIStandardResultTarget,
  AIStandardResultValidationIssue
} from "../types/aiStandardResult";
import type { ExperimentRun, FileRef, ManuscriptBinding } from "../types";
import type { SharedManuscriptSession } from "../types/sharedManuscriptSession";
import {
  AI_STANDARD_RESULT_MAX_PAYLOAD_CHARS,
  canonicalAIStandardResultFingerprint
} from "./aiStandardResultService";
import { validateAIExperimentRunStandardResultProposal } from "./aiExperimentRunStandardResultAdapter";
import { experimentRunService } from "./experimentRunService";
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
import { experimentRunManuscriptSaveAsAdapter } from "./experimentRunManuscriptSaveAsAdapter";
import {
  manuscriptSaveAsOperationPort,
  type SaveAsOperationRecord
} from "./manuscriptSaveAsOperationPort";
import { sha256SaveAsRaw } from "./manuscriptSaveAsSourceSnapshot";
import { experimentRunRawManuscriptService } from "./experimentRunRawManuscriptService";
import { sharedManuscriptSessionRuntime } from "./sharedManuscriptSessionComposition";

export const AI_EXPERIMENT_RUN_NEW_MANUSCRIPT_BODY_MAX_CHARS = 6_000;
export const AI_EXPERIMENT_RUN_NEW_MANUSCRIPT_ENCODING = "utf-8" as const;
export const AI_EXPERIMENT_RUN_NEW_MANUSCRIPT_LINE_ENDING = "LF" as const;
export const AI_EXPERIMENT_RUN_NEW_MANUSCRIPT_TERMINAL_NEWLINE =
  "one LF for the complete LabPod Markdown document" as const;
export const AI_EXPERIMENT_RUN_NEW_MANUSCRIPT_READBACK_STATE =
  "AUTHORITATIVE_RUN_FILE_REF_LIST_PHYSICAL_BODY_BINDING_PRESERVED" as const;
export const AI_EXPERIMENT_RUN_NEW_MANUSCRIPT_PRESERVATION_MODE =
  "CANONICAL_OPERATION_CONTRACT_NO_BINDING_WRITE_PLUS_EXACT_OPERATION_READBACK" as const;

type RunTarget = Extract<AIStandardResultTarget, { module: "experimentRun" }>;

export type AIExperimentRunManuscriptValidation = {
  executable: boolean;
  normalizedPayload: Record<string, unknown>;
  validationIssues: AIStandardResultValidationIssue[];
  targetSnapshotFingerprint?: string;
  resolvedTarget?: RunTarget;
};

export type AIExperimentRunManuscriptEffectOutcome =
  | { kind: "settled"; receipt: AIStandardResultEffectReceipt }
  | { kind: "pending"; code: string; message: string }
  | { kind: "no_effect_failure"; code: string; message: string };

export type AIExperimentRunManuscriptTargetAcceptanceOutcome =
  | { status: "accepted"; targetFileName: string }
  | { status: "canceled" };

export class AIExperimentRunManuscriptTargetAcceptanceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AIExperimentRunManuscriptTargetAcceptanceError";
  }
}

class AIExperimentRunManuscriptReadbackPendingError extends Error {
  readonly effectMayExist = true;

  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AIExperimentRunManuscriptReadbackPendingError";
  }
}

type PreparedTarget = {
  resultId: string;
  visiblePayloadFingerprint: string;
  authorizationId: string;
  operationId: string;
  targetAcceptanceId: string;
  targetPathIdentityKey: string;
  targetIdentityDigest: string;
  authorizationFingerprint: string;
  sourceSessionKey: string;
  serializedRawFingerprint: string;
};

type PreservationBaseline = {
  binding: ManuscriptBinding;
  currentFileRefId: string;
  currentPhysicalFingerprint: string;
};

export interface AIExperimentRunManuscriptDependencies {
  validateRunBase: typeof validateAIExperimentRunStandardResultProposal;
  getRun: typeof experimentRunService.getRunById;
  getExperiment: typeof experimentService.getExperimentById;
  getProject: typeof planningService.getProjectById;
  resolveLifecycle: typeof resolveMountedManuscriptLifecycleDecision;
  getBinding: typeof manuscriptBindingService.getBindingByOwner;
  getFileRef: typeof fileRefService.getById;
  listManuscripts: typeof manuscriptListService.getAvailableManuscripts;
  readCurrentManuscript: typeof manuscriptIoService.readCurrentManuscript;
  readManuscriptByFileRef: typeof manuscriptIoService.readManuscriptByFileRef;
  prepareCanonicalTarget: typeof experimentRunManuscriptSaveAsAdapter.prepareTargetAcceptance;
  discardCanonicalTarget: typeof experimentRunManuscriptSaveAsAdapter.discardTargetAcceptance;
  saveAs: typeof experimentRunManuscriptSaveAsAdapter.saveAs;
  recoverSaveAs: typeof experimentRunManuscriptSaveAsAdapter.recover;
  readOperation: typeof manuscriptSaveAsOperationPort.readback;
  openIndependent: typeof experimentRunRawManuscriptService.openIndependent;
  updateIndependentDraft: typeof experimentRunRawManuscriptService.updateDraft;
  closeIndependent: typeof experimentRunRawManuscriptService.close;
  disposeIndependent: typeof experimentRunRawManuscriptService.dispose;
  listRuntimeSessions(): SharedManuscriptSession[];
}

const defaultDependencies: AIExperimentRunManuscriptDependencies = {
  validateRunBase: validateAIExperimentRunStandardResultProposal,
  getRun: experimentRunService.getRunById,
  getExperiment: experimentService.getExperimentById,
  getProject: planningService.getProjectById,
  resolveLifecycle: resolveMountedManuscriptLifecycleDecision,
  getBinding: manuscriptBindingService.getBindingByOwner,
  getFileRef: fileRefService.getById,
  listManuscripts: manuscriptListService.getAvailableManuscripts,
  readCurrentManuscript: manuscriptIoService.readCurrentManuscript,
  readManuscriptByFileRef: manuscriptIoService.readManuscriptByFileRef,
  prepareCanonicalTarget: (input) =>
    experimentRunManuscriptSaveAsAdapter.prepareTargetAcceptance(input),
  discardCanonicalTarget: (targetAcceptanceId) =>
    experimentRunManuscriptSaveAsAdapter.discardTargetAcceptance(targetAcceptanceId),
  saveAs: (input) => experimentRunManuscriptSaveAsAdapter.saveAs(input),
  recoverSaveAs: (operationId, runId, acknowledgePresentation) =>
    experimentRunManuscriptSaveAsAdapter.recover(
      operationId,
      runId,
      acknowledgePresentation
    ),
  readOperation: (operationId) => manuscriptSaveAsOperationPort.readback(operationId),
  openIndependent: (runId, fileRefId, consumerId) =>
    experimentRunRawManuscriptService.openIndependent(runId, fileRefId, consumerId),
  updateIndependentDraft: (sessionKey, raw) =>
    experimentRunRawManuscriptService.updateDraft(sessionKey, raw),
  closeIndependent: (sessionKey, decision) =>
    experimentRunRawManuscriptService.close(sessionKey, decision),
  disposeIndependent: (sessionKey) =>
    experimentRunRawManuscriptService.dispose(sessionKey),
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
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function containsProtocolAuthority(value: string) {
  return /LABPOD_(?:META_SNAPSHOT|OUTLINE|BODY)_(?:START|END)/iu.test(value);
}

export function normalizeAIExperimentRunManuscriptBody(value: string) {
  return value.replace(/\r\n/gu, "\n");
}

function normalizeBody(
  value: unknown,
  issues: AIStandardResultValidationIssue[]
): string | undefined {
  const payload = asRecord(value);
  if (!payload || Object.keys(payload).length !== 1 || !("body" in payload)) {
    issues.push(issue(
      "EXPERIMENT_RUN_MANUSCRIPT_PAYLOAD_INVALID",
      "The visible ExperimentRun manuscript payload requires exactly one editable body field."
    ));
    return undefined;
  }
  if (typeof payload.body !== "string") {
    issues.push(issue("EXPERIMENT_RUN_MANUSCRIPT_BODY_INVALID", "body must be a Markdown string.", "body"));
    return undefined;
  }
  const body = payload.body;
  const invalid = !body.trim() || body.includes("\0") ||
    body.replace(/\r\n/gu, "").includes("\r") ||
    /[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F\uFEFF]/u.test(body) ||
    !hasWellFormedUnicode(body) || containsProtocolAuthority(body);
  if (invalid) {
    issues.push(issue(
      "EXPERIMENT_RUN_MANUSCRIPT_BODY_INVALID",
      "body must be non-empty well-formed Unicode Markdown with no NUL, hidden control, protocol marker, BOM, or bare CR.",
      "body"
    ));
    return undefined;
  }
  if (charCount(body) > AI_EXPERIMENT_RUN_NEW_MANUSCRIPT_BODY_MAX_CHARS) {
    issues.push(issue(
      "EXPERIMENT_RUN_MANUSCRIPT_BODY_OVERFLOW",
      `body exceeds the ${AI_EXPERIMENT_RUN_NEW_MANUSCRIPT_BODY_MAX_CHARS}-Unicode-character limit; truncation is forbidden.`,
      "body"
    ));
    return undefined;
  }
  const normalized = normalizeAIExperimentRunManuscriptBody(body);
  if (charCount(JSON.stringify({ body: normalized })) > AI_STANDARD_RESULT_MAX_PAYLOAD_CHARS) {
    issues.push(issue(
      "EXPERIMENT_RUN_MANUSCRIPT_SHARED_PAYLOAD_LIMIT",
      `The serialized payload exceeds the shared ${AI_STANDARD_RESULT_MAX_PAYLOAD_CHARS}-character bound.`,
      "body"
    ));
    return undefined;
  }
  return normalized;
}

function exactBindingIdentity(binding: ManuscriptBinding | undefined, runId: string) {
  return Boolean(
    binding && !binding.deletedAt && binding.ownerType === "experimentRun" &&
    binding.ownerId === runId && binding.manuscriptChannel === "primary"
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

function exactRunFileRef(fileRef: FileRef | undefined, runId: string) {
  return Boolean(
    fileRef && !fileRef.deletedAt && fileRef.ownerType === "experimentRun" &&
    fileRef.ownerId === runId && fileRef.manuscriptChannel === "primary" &&
    fileRef.resourceKind === "file" && fileRef.fileRole === "manuscript"
  );
}

function targetFingerprint(input: {
  run: ExperimentRun;
  parentUpdatedAt: string;
  projectUpdatedAt: string;
  binding: ManuscriptBinding;
}) {
  return canonicalAIStandardResultFingerprint({
    run: {
      id: input.run.id,
      experimentId: input.run.experimentId,
      projectId: input.run.projectId,
      status: input.run.status,
      updatedAt: input.run.updatedAt,
      deletedAt: input.run.deletedAt ?? null
    },
    parentUpdatedAt: input.parentUpdatedAt,
    projectUpdatedAt: input.projectUpdatedAt,
    bindingIdentity: {
      id: input.binding.id,
      ownerType: input.binding.ownerType,
      ownerId: input.binding.ownerId,
      manuscriptChannel: input.binding.manuscriptChannel
    }
  });
}

function operationRequestKey(resultId: string, authorizationId: string) {
  const key = `a14-run-man:${resultId}:${authorizationId}`;
  if (
    key !== key.trim() || !key.trim() || Array.from(key).length > 200 ||
    /[\0-\x1F\x7F]/u.test(key)
  ) {
    throw new AIExperimentRunManuscriptTargetAcceptanceError(
      "EXPERIMENT_RUN_MANUSCRIPT_OPERATION_KEY_INVALID",
      "The Result/authorization identity cannot form one bounded canonical Save As operation key."
    );
  }
  return key;
}

function targetAuthorizationFingerprint(input: {
  resultId: string;
  authorizationId: string;
  payloadFingerprint: string;
  targetSnapshotFingerprint?: string;
  targetIdentityDigest: string;
}) {
  return canonicalAIStandardResultFingerprint({
    resultId: input.resultId,
    authorizationId: input.authorizationId,
    payloadFingerprint: input.payloadFingerprint,
    targetSnapshotFingerprint: input.targetSnapshotFingerprint,
    targetIdentityDigest: input.targetIdentityDigest
  });
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

export function createAIExperimentRunManuscriptStandardResultAdapter(
  dependencies: AIExperimentRunManuscriptDependencies = defaultDependencies
) {
  const preparedByResult = new Map<string, PreparedTarget>();
  const preservationByOperation = new Map<string, PreservationBaseline>();

  async function validate(input: {
    target: AIStandardResultTarget;
    source?: AIParseDraftSourceSnapshot;
    payload: unknown;
    expectedProjectId: string;
    expectedTargetSnapshotFingerprint?: string;
  }): Promise<AIExperimentRunManuscriptValidation> {
    const issues: AIStandardResultValidationIssue[] = [];
    if (input.target.module !== "experimentRun" || input.target.entityType !== "experimentRun") {
      return {
        executable: false,
        normalizedPayload: {},
        validationIssues: [issue(
          "EXPERIMENT_RUN_MANUSCRIPT_TARGET_INVALID",
          "NEW_MANUSCRIPT requires one exact canonical ExperimentRun/primary target."
        )]
      };
    }
    const target = input.target;
    const base = await dependencies.validateRunBase({
      action: "NEW_MANUSCRIPT",
      target,
      source: input.source,
      payload: input.payload,
      expectedProjectId: input.expectedProjectId
    });
    issues.push(...base.validationIssues.filter(
      (candidate) => candidate.code !== "EXPERIMENT_RUN_NEW_MANUSCRIPT_NOT_ENABLED_IN_A13"
    ));
    if (!target.entityId) {
      issues.push(issue(
        "EXPERIMENT_RUN_MANUSCRIPT_OWNER_REQUIRED",
        "NEW_MANUSCRIPT requires an existing canonical Run identity.",
        "target.entityId"
      ));
    }
    if (target.manuscriptChannel !== "primary") {
      issues.push(issue(
        "EXPERIMENT_RUN_MANUSCRIPT_CHANNEL_INVALID",
        "ExperimentRun NEW_MANUSCRIPT requires the fixed primary channel.",
        "target.manuscriptChannel"
      ));
    }
    const body = normalizeBody(input.payload, issues);
    const run = target.entityId ? await dependencies.getRun(target.entityId) : undefined;
    const [parent, project] = await Promise.all([
      run ? dependencies.getExperiment(run.experimentId) : undefined,
      dependencies.getProject(input.expectedProjectId)
    ]);
    if (!run || run.deletedAt) {
      issues.push(issue("EXPERIMENT_RUN_MANUSCRIPT_OWNER_UNAVAILABLE", "The canonical Run owner is missing or deleted."));
    } else if (run.projectId !== input.expectedProjectId) {
      issues.push(issue("EXPERIMENT_RUN_MANUSCRIPT_SCOPE_MISMATCH", "The canonical Run no longer belongs to the reviewed Project."));
    }
    if (!parent || parent.deletedAt || parent.status === "archived") {
      issues.push(issue("EXPERIMENT_RUN_MANUSCRIPT_PARENT_UNAVAILABLE", "The canonical parent Experiment is unavailable."));
    } else if (!run || parent.id !== run.experimentId || parent.projectId !== input.expectedProjectId) {
      issues.push(issue("EXPERIMENT_RUN_MANUSCRIPT_PARENT_SCOPE_MISMATCH", "The Run-parent-Project relation changed after Parse Draft."));
    }
    if (!project || project.deletedAt || project.status === "archived") {
      issues.push(issue("EXPERIMENT_RUN_MANUSCRIPT_PROJECT_UNAVAILABLE", "The reviewed canonical Project is unavailable."));
    }
    let binding: ManuscriptBinding | undefined;
    if (run) {
      try {
        const lifecycle = await dependencies.resolveLifecycle({
          ownerType: "experimentRun",
          ownerId: run.id,
          manuscriptChannel: "primary"
        });
        if (!lifecycle.canSaveAs || !lifecycle.canOpenIndependent || lifecycle.readOnly) {
          issues.push(issue(
            "EXPERIMENT_RUN_MANUSCRIPT_LIFECYCLE_INELIGIBLE",
            "The current Run lifecycle does not allow an independent managed manuscript."
          ));
        }
      } catch (error) {
        issues.push(issue(
          "EXPERIMENT_RUN_MANUSCRIPT_LIFECYCLE_INELIGIBLE",
          error instanceof Error ? error.message : "The Run manuscript lifecycle is unavailable."
        ));
      }
      try {
        binding = await dependencies.getBinding("experimentRun", run.id, "primary");
      } catch (error) {
        issues.push(issue(
          "EXPERIMENT_RUN_MANUSCRIPT_BINDING_CONFLICT",
          error instanceof Error ? error.message : "The Run/primary Binding is ambiguous."
        ));
      }
      if (!exactBindingIdentity(binding, run.id)) {
        issues.push(issue("EXPERIMENT_RUN_MANUSCRIPT_BINDING_UNAVAILABLE", "The canonical Run/primary Binding identity is unavailable."));
      } else if (
        !binding?.defaultFolderFileRefId || !binding.defaultManuscriptFileRefId ||
        !binding.currentFileRefId
      ) {
        issues.push(issue(
          "EXPERIMENT_RUN_MANUSCRIPT_BINDING_INCOMPLETE",
          "Current Run creation requires complete primary default/current provisioning before A14."
        ));
      } else {
        const [folder, defaultManuscript, current] = await Promise.all([
          dependencies.getFileRef(binding.defaultFolderFileRefId),
          dependencies.getFileRef(binding.defaultManuscriptFileRefId),
          dependencies.getFileRef(binding.currentFileRefId)
        ]);
        if (
          !folder || folder.deletedAt || folder.ownerType !== "experimentRun" ||
          folder.ownerId !== run.id || folder.manuscriptChannel !== "primary" ||
          folder.resourceKind !== "folder" || folder.fileRole !== "defaultFolder" ||
          !exactRunFileRef(defaultManuscript, run.id) || !exactRunFileRef(current, run.id)
        ) {
          issues.push(issue(
            "EXPERIMENT_RUN_MANUSCRIPT_BINDING_IDENTITY_DRIFT",
            "The Run/primary Binding references no exact active canonical default/current resources."
          ));
        }
      }
    }
    const resolvedTarget: RunTarget | undefined = run && parent && project
      ? {
          module: "experimentRun",
          projectId: project.id,
          entityType: "experimentRun",
          entityId: run.id,
          manuscriptChannel: "primary",
          parentExperimentId: parent.id,
          parentExperimentLabel: parent.title,
          projectLabel: project.title
        }
      : undefined;
    if (
      resolvedTarget && (
        target.parentExperimentId !== undefined && target.parentExperimentId !== resolvedTarget.parentExperimentId ||
        target.parentExperimentLabel !== undefined && target.parentExperimentLabel !== resolvedTarget.parentExperimentLabel ||
        target.projectLabel !== undefined && target.projectLabel !== resolvedTarget.projectLabel
      )
    ) {
      issues.push(issue("EXPERIMENT_RUN_MANUSCRIPT_TARGET_STALE", "The disclosed Run-parent-Project target changed after Parse Draft."));
    }
    const currentFingerprint = run && parent && project && binding && exactBindingIdentity(binding, run.id)
      ? targetFingerprint({
          run,
          parentUpdatedAt: parent.updatedAt,
          projectUpdatedAt: project.updatedAt,
          binding
        })
      : undefined;
    if (
      input.expectedTargetSnapshotFingerprint &&
      currentFingerprint !== input.expectedTargetSnapshotFingerprint
    ) {
      issues.push(issue("EXPERIMENT_RUN_MANUSCRIPT_TARGET_STALE", "The Run, parent, Project, or Binding identity changed after Parse Draft; re-parse is required."));
    }
    return {
      executable: issues.length === 0,
      normalizedPayload: body === undefined ? {} : { body },
      validationIssues: issues,
      ...(currentFingerprint ? { targetSnapshotFingerprint: currentFingerprint } : {}),
      ...(resolvedTarget ? { resolvedTarget } : {})
    };
  }

  async function closeSession(sessionKey: string) {
    try {
      const closed = await dependencies.closeIndependent(sessionKey, "discard");
      if (closed.status !== "success") await dependencies.disposeIndependent(sessionKey);
    } catch {
      await dependencies.disposeIndependent(sessionKey).catch(() => false);
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
  }): Promise<AIExperimentRunManuscriptTargetAcceptanceOutcome> {
    const { result } = input;
    if (
      result.target.module !== "experimentRun" || result.action !== "NEW_MANUSCRIPT" ||
      result.category !== "MANUSCRIPT_RESULT" || !result.target.entityId ||
      result.target.manuscriptChannel !== "primary" || !input.plannedAuthorizationId.trim()
    ) {
      throw new AIExperimentRunManuscriptTargetAcceptanceError(
        "EXPERIMENT_RUN_MANUSCRIPT_TARGET_ACCEPTANCE_INVALID",
        "Only one pending exact ExperimentRun/primary NEW_MANUSCRIPT Result can select a target."
      );
    }
    await release(result.id);
    const operationId = operationRequestKey(result.id, input.plannedAuthorizationId);
    let existingOperation: SaveAsOperationRecord | null;
    try {
      existingOperation = await dependencies.readOperation(operationId);
    } catch (error) {
      throw new AIExperimentRunManuscriptTargetAcceptanceError(
        "EXPERIMENT_RUN_MANUSCRIPT_OPERATION_READBACK_UNAVAILABLE",
        error instanceof Error ? error.message : "The canonical operation authority is unavailable."
      );
    }
    if (existingOperation) {
      throw new AIExperimentRunManuscriptTargetAcceptanceError(
        "EXPERIMENT_RUN_MANUSCRIPT_OPERATION_ALREADY_EXISTS",
        "An unclaimed Result cannot select a new target for an existing operation."
      );
    }
    const binding = await dependencies.getBinding("experimentRun", result.target.entityId, "primary");
    if (!binding?.currentFileRefId || !exactBindingIdentity(binding, result.target.entityId)) {
      throw new AIExperimentRunManuscriptTargetAcceptanceError(
        "EXPERIMENT_RUN_MANUSCRIPT_BINDING_UNAVAILABLE",
        "The exact Run/primary current manuscript is unavailable for canonical Save As."
      );
    }
    const conflict = dependencies.listRuntimeSessions().some((session) =>
      session.windowRole === "independent" && session.owner.ownerType === "experimentRun" &&
      session.owner.ownerId === result.target.entityId && session.owner.channel === "primary" &&
      session.file.kind === "durable" && session.file.fileRefId === binding.currentFileRefId
    );
    if (conflict) {
      throw new AIExperimentRunManuscriptTargetAcceptanceError(
        "EXPERIMENT_RUN_MANUSCRIPT_SOURCE_SESSION_CONFLICT",
        "Close the existing independent window for the current Run manuscript before selecting an AI target."
      );
    }
    const opened = await dependencies.openIndependent(
      result.target.entityId,
      binding.currentFileRefId,
      `ai-experiment-run-manuscript:${result.id}:source`
    );
    if (opened.status !== "success") {
      throw new AIExperimentRunManuscriptTargetAcceptanceError(
        "EXPERIMENT_RUN_MANUSCRIPT_SOURCE_OPEN_FAILED",
        "The canonical independent Run source session could not be opened."
      );
    }
    const sourceSessionKey = opened.sessionKey;
    const body = input.normalizedPayload.body as string;
    const serializedRaw = serializeBody(body);
    const updated = dependencies.updateIndependentDraft(sourceSessionKey, serializedRaw);
    if (updated.status !== "success") {
      await closeSession(sourceSessionKey);
      throw new AIExperimentRunManuscriptTargetAcceptanceError(
        "EXPERIMENT_RUN_MANUSCRIPT_SOURCE_DRAFT_FAILED",
        "The canonical independent Run source draft could not be frozen."
      );
    }
    let accepted: Awaited<ReturnType<typeof dependencies.prepareCanonicalTarget>>;
    try {
      accepted = await dependencies.prepareCanonicalTarget({
        runId: result.target.entityId,
        sourceSessionKey,
        sourceMode: "independent",
        pickerTitle: "Choose a managed file for the new ExperimentRun manuscript",
        operationRequestKey: operationId,
        requireManagedTarget: true
      });
    } catch (error) {
      await closeSession(sourceSessionKey);
      throw new AIExperimentRunManuscriptTargetAcceptanceError(
        "EXPERIMENT_RUN_MANUSCRIPT_TARGET_SELECTION_FAILED",
        error instanceof Error ? error.message : "The LP12 target picker failed safely."
      );
    }
    if (accepted.status === "canceled") {
      await closeSession(sourceSessionKey);
      return { status: "canceled" };
    }
    if (accepted.status !== "accepted") {
      await closeSession(sourceSessionKey);
      throw new AIExperimentRunManuscriptTargetAcceptanceError(
        "EXPERIMENT_RUN_MANUSCRIPT_TARGET_SELECTION_FAILED",
        `The LP12 target picker rejected the target (${accepted.error.code}).`
      );
    }
    const targetIdentityDigest = canonicalAIStandardResultFingerprint(
      accepted.targetIdentityDigest
    );
    const authorizationFingerprint = targetAuthorizationFingerprint({
      resultId: result.id,
      authorizationId: input.plannedAuthorizationId,
      payloadFingerprint: result.visiblePayloadFingerprint,
      targetSnapshotFingerprint: result.targetSnapshotFingerprint,
      targetIdentityDigest
    });
    preparedByResult.set(result.id, {
      resultId: result.id,
      visiblePayloadFingerprint: result.visiblePayloadFingerprint,
      authorizationId: input.plannedAuthorizationId,
      operationId,
      targetAcceptanceId: accepted.targetAcceptanceId,
      targetPathIdentityKey: accepted.targetIdentityDigest,
      targetIdentityDigest,
      authorizationFingerprint,
      sourceSessionKey,
      serializedRawFingerprint: await sha256SaveAsRaw(serializedRaw)
    });
    return { status: "accepted", targetFileName: accepted.targetFileName };
  }

  function preparedAuthorizationId(result: AIStandardResult) {
    const prepared = preparedByResult.get(result.id);
    return prepared && result.target.module === "experimentRun" &&
      result.action === "NEW_MANUSCRIPT" &&
      prepared.visiblePayloadFingerprint === result.visiblePayloadFingerprint
      ? prepared.authorizationId
      : undefined;
  }

  async function preservationBaseline(runId: string): Promise<PreservationBaseline> {
    const binding = await dependencies.getBinding("experimentRun", runId, "primary");
    if (
      !binding || !exactBindingIdentity(binding, runId) || !binding.defaultFolderFileRefId ||
      !binding.defaultManuscriptFileRefId || !binding.currentFileRefId
    ) {
      throw new AIExperimentRunManuscriptTargetAcceptanceError(
        "EXPERIMENT_RUN_MANUSCRIPT_BINDING_STALE",
        "The exact complete Run/primary Binding is unavailable before the formal effect."
      );
    }
    const current = await dependencies.readCurrentManuscript(
      "experimentRun",
      runId,
      { manuscriptChannel: "primary" }
    );
    if (current.status !== "success" || current.fileRefId !== binding.currentFileRefId) {
      throw new AIExperimentRunManuscriptTargetAcceptanceError(
        "EXPERIMENT_RUN_MANUSCRIPT_CURRENT_READBACK_UNAVAILABLE",
        "The existing current Run manuscript preservation baseline is unavailable."
      );
    }
    return {
      binding,
      currentFileRefId: current.fileRefId,
      currentPhysicalFingerprint: canonicalAIStandardResultFingerprint(current.content)
    };
  }

  function operationIdentityMatches(
    operation: SaveAsOperationRecord,
    runId: string,
    operationId: string,
    serializedRawFingerprint: string
  ) {
    return operation.operationId === operationId && operation.ownerType === "experimentRun" &&
      operation.ownerId === runId && operation.channel === "primary" &&
      operation.sourceWindowRole === "independent" && operation.targetLocationMode === "managed" &&
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
    const target = input.result.target as RunTarget;
    const runId = target.entityId!;
    const authorizationId = input.result.authorizationId!;
    const operationId = operationRequestKey(input.result.id, authorizationId);
    if (
      !operationIdentityMatches(input.operation, runId, operationId, input.serializedRawFingerprint) ||
      input.operation.d1CommitState !== "confirmed" || input.operation.d2CommitState !== "confirmed" ||
      !input.operation.targetFileRefId || !input.operation.sourceFileRefId
    ) {
      throw new AIExperimentRunManuscriptReadbackPendingError(
        "EXPERIMENT_RUN_MANUSCRIPT_OPERATION_INCOMPLETE",
        "The bound canonical Save As operation has no complete D1/D2 readback."
      );
    }
    const [fileRef, binding] = await Promise.all([
      dependencies.getFileRef(input.operation.targetFileRefId),
      dependencies.getBinding("experimentRun", runId, "primary")
    ]);
    const operationGeneration = input.operation.operationGeneration;
    const expectedCandidateRequestId = Number.isInteger(operationGeneration) && operationGeneration > 0
      ? `${operationId}:${operationGeneration}`
      : undefined;
    if (
      !fileRef || !exactRunFileRef(fileRef, runId) ||
      fileRef.id !== input.operation.targetFileRefId || fileRef.locationMode !== "managed" ||
      !expectedCandidateRequestId || fileRef.candidateRequestId !== expectedCandidateRequestId ||
      !fileRef.candidateOccurredAt?.trim() || !binding || !exactBindingIdentity(binding, runId) ||
      !binding.currentFileRefId || !binding.defaultManuscriptFileRefId ||
      binding.currentFileRefId !== input.operation.sourceFileRefId ||
      binding.currentFileRefId === fileRef.id || binding.defaultManuscriptFileRefId === fileRef.id
    ) {
      throw new AIExperimentRunManuscriptReadbackPendingError(
        "EXPERIMENT_RUN_MANUSCRIPT_FILE_REF_BINDING_MISMATCH",
        "The operation does not resolve to one independent managed Run/primary FileRef with preserved Binding pointers."
      );
    }
    const available = await dependencies.listManuscripts("experimentRun", runId, "primary");
    if (
      available.status !== "success" ||
      available.items.filter((item) => item.fileRefId === fileRef.id).length !== 1
    ) {
      throw new AIExperimentRunManuscriptReadbackPendingError(
        "EXPERIMENT_RUN_MANUSCRIPT_NOT_DISCOVERABLE",
        "The new Run FileRef is not uniquely discoverable through the canonical manuscript list."
      );
    }
    const [physical, current] = await Promise.all([
      dependencies.readManuscriptByFileRef("experimentRun", runId, fileRef.id, { manuscriptChannel: "primary" }),
      dependencies.readCurrentManuscript("experimentRun", runId, { manuscriptChannel: "primary" })
    ]);
    if (physical.status !== "success" || current.status !== "success") {
      throw new AIExperimentRunManuscriptReadbackPendingError(
        "EXPERIMENT_RUN_MANUSCRIPT_PHYSICAL_READBACK_UNAVAILABLE",
        "The new or existing-current Run manuscript is unavailable through the canonical reader."
      );
    }
    const parsed = parseLabPodMarkdownDocument(physical.content);
    if (
      (parsed.status !== "valid" && parsed.status !== "valid-empty") ||
      parsed.body !== input.normalizedBody || parsed.hasBom || parsed.newlineStyle !== "lf" ||
      current.fileRefId !== binding.currentFileRefId
    ) {
      throw new AIExperimentRunManuscriptReadbackPendingError(
        "EXPERIMENT_RUN_MANUSCRIPT_BODY_CORRELATION_FAILED",
        "The parsed physical BODY or preserved current Run manuscript identity is mismatched."
      );
    }
    if (
      input.baseline && (
        !sameBinding(input.baseline.binding, binding) ||
        current.fileRefId !== input.baseline.currentFileRefId ||
        canonicalAIStandardResultFingerprint(current.content) !== input.baseline.currentPhysicalFingerprint
      )
    ) {
      throw new AIExperimentRunManuscriptReadbackPendingError(
        "EXPERIMENT_RUN_MANUSCRIPT_PRESERVATION_FAILED",
        "The existing-current Run manuscript or Binding changed during independent artifact creation."
      );
    }
    const confirmedBodyFingerprint = canonicalAIStandardResultFingerprint(input.normalizedBody);
    const physicalBodyFingerprint = canonicalAIStandardResultFingerprint(parsed.body);
    const targetIdentityDigest = canonicalAIStandardResultFingerprint(
      input.operation.targetPathIdentityKey
    );
    const authorizationFingerprint = targetAuthorizationFingerprint({
      resultId: input.result.id,
      authorizationId,
      payloadFingerprint: input.result.confirmedPayloadFingerprint!,
      targetSnapshotFingerprint: input.result.targetSnapshotFingerprint,
      targetIdentityDigest
    });
    return {
      module: "experimentRun",
      entityType: "fileRef",
      entityId: fileRef.id,
      operation: "NEW_MANUSCRIPT",
      service: "experimentRunManuscriptSaveAsAdapter.saveAs",
      canonicalReadback: {
        projectId: target.projectId,
        runId,
        parentExperimentId: target.parentExperimentId,
        manuscriptChannel: "primary",
        resultId: input.result.id,
        authorizationId,
        authorizationFingerprint,
        operationId,
        operationGeneration,
        fileRefId: fileRef.id,
        candidateRequestId: fileRef.candidateRequestId,
        candidateOccurredAt: fileRef.candidateOccurredAt,
        artifactAssociation: "INDEPENDENT_MANAGED_MANUSCRIPT",
        targetIdentityDigest,
        resourceKind: fileRef.resourceKind,
        fileRole: fileRef.fileRole,
        targetLocationMode: fileRef.locationMode,
        operationStage: input.operation.stage,
        d1CommitState: input.operation.d1CommitState,
        d2CommitState: input.operation.d2CommitState,
        confirmedPayloadFingerprint: input.result.confirmedPayloadFingerprint,
        latestVisibleSourceBodyFingerprint: confirmedBodyFingerprint,
        confirmedBodyFingerprint,
        physicalBodyFingerprint,
        physicalEncoding: physical.encoding,
        physicalSizeBytes: physical.sizeBytes,
        bodyNormalization: "CRLF_TO_LF",
        documentLineEnding: AI_EXPERIMENT_RUN_NEW_MANUSCRIPT_LINE_ENDING,
        documentTerminalNewline: AI_EXPERIMENT_RUN_NEW_MANUSCRIPT_TERMINAL_NEWLINE,
        preservationProofMode: AI_EXPERIMENT_RUN_NEW_MANUSCRIPT_PRESERVATION_MODE,
        preservationOperationSourceFileRefId: input.operation.sourceFileRefId,
        bindingReadback: bindingProjection(binding),
        previousCurrentFileRefId: input.baseline?.currentFileRefId ?? binding.currentFileRefId,
        previousCurrentBodyFingerprint:
          input.baseline?.currentPhysicalFingerprint ??
          canonicalAIStandardResultFingerprint(current.content),
        preEffectBaselineSource: input.baseline
          ? "CONFIRM_TIME_RUNTIME_BASELINE"
          : "CANONICAL_NO_BINDING_WRITE_OPERATION_PROOF",
        firstProvisioningDisposition: "NOT_APPLICABLE_WITH_CURRENT_RUN_CREATION_CONTRACT",
        bindingPreserved: true,
        currentChanged: false,
        defaultChanged: false,
        formalSwitchInvoked: false,
        readbackState: AI_EXPERIMENT_RUN_NEW_MANUSCRIPT_READBACK_STATE
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
  }): Promise<AIExperimentRunManuscriptEffectOutcome> {
    const baseline = input.baseline ?? preservationByOperation.get(input.operation.operationId);
    try {
      const receipt = await authoritativeReceipt({ ...input, baseline });
      preservationByOperation.delete(input.operation.operationId);
      return { kind: "settled", receipt };
    } catch (error) {
      if (!input.allowSameOperationRecovery) {
        return {
          kind: "pending",
          code: error instanceof AIExperimentRunManuscriptReadbackPendingError
            ? error.code
            : "EXPERIMENT_RUN_MANUSCRIPT_READBACK_UNKNOWN",
          message: error instanceof Error ? error.message : "The operation readback is incomplete."
        };
      }
    }
    const target = input.result.target as RunTarget;
    try {
      const recovered = await dependencies.recoverSaveAs(
        input.operation.operationId,
        target.entityId!,
        async () => true
      );
      if (recovered.status === "success") {
        await closeSession(recovered.sessionKey);
        const reread = await dependencies.readOperation(input.operation.operationId);
        if (reread) {
          const receipt = await authoritativeReceipt({
            ...input,
            operation: reread,
            baseline
          });
          preservationByOperation.delete(input.operation.operationId);
          return {
            kind: "settled",
            receipt
          };
        }
      }
      return {
        kind: "pending",
        code: "EXPERIMENT_RUN_MANUSCRIPT_SAME_OPERATION_RECOVERY_PENDING",
        message: "The existing canonical Run Save As operation still requires authoritative recovery/readback."
      };
    } catch (error) {
      return {
        kind: "pending",
        code: "EXPERIMENT_RUN_MANUSCRIPT_SAME_OPERATION_RECOVERY_PENDING",
        message: error instanceof Error ? error.message : "Same-operation recovery remains pending."
      };
    }
  }

  async function invoke(input: {
    result: AIStandardResult;
    normalizedPayload: Record<string, unknown>;
    invocationMode: "initial" | "continuation";
  }): Promise<AIExperimentRunManuscriptEffectOutcome> {
    const { result } = input;
    if (
      result.target.module !== "experimentRun" || result.action !== "NEW_MANUSCRIPT" ||
      result.category !== "MANUSCRIPT_RESULT" || !result.target.entityId ||
      result.target.manuscriptChannel !== "primary" || !result.authorizationId ||
      !result.confirmedPayloadFingerprint
    ) {
      return {
        kind: "no_effect_failure",
        code: "EXPERIMENT_RUN_MANUSCRIPT_OPERATION_BINDING_INVALID",
        message: "The claimed Result has no exact Run/primary authorization binding."
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
        code: "EXPERIMENT_RUN_MANUSCRIPT_OPERATION_READBACK_UNKNOWN",
        message: error instanceof Error ? error.message : "The canonical operation readback is unavailable."
      };
    }
    if (prior) {
      if (!operationIdentityMatches(prior, result.target.entityId, operationId, serializedRawFingerprint)) {
        return {
          kind: "pending",
          code: "EXPERIMENT_RUN_MANUSCRIPT_OPERATION_IDENTITY_CONFLICT",
          message: "The deterministic operation identity resolves to mismatched canonical evidence."
        };
      }
      if (
        prior.stage === "pre_d1_closed" && prior.d1CommitState === "not_started" &&
        prior.d2CommitState === "not_started"
      ) {
        preservationByOperation.delete(operationId);
        return {
          kind: "no_effect_failure",
          code: prior.blockingCode ?? "EXPERIMENT_RUN_MANUSCRIPT_ZERO_EFFECT",
          message: "The canonical Run operation closed before D1 with authoritative zero effect."
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
        code: "EXPERIMENT_RUN_MANUSCRIPT_OPERATION_NOT_STARTED",
        message: "The deterministic pre-effect operation record is absent, proving zero formal manuscript effect."
      };
    }
    const prepared = preparedByResult.get(result.id);
    if (
      !prepared || prepared.authorizationId !== result.authorizationId ||
      prepared.operationId !== operationId ||
      prepared.visiblePayloadFingerprint !== result.visiblePayloadFingerprint ||
      prepared.serializedRawFingerprint !== serializedRawFingerprint ||
      prepared.authorizationFingerprint !== targetAuthorizationFingerprint({
        resultId: result.id,
        authorizationId: result.authorizationId,
        payloadFingerprint: result.confirmedPayloadFingerprint,
        targetSnapshotFingerprint: result.targetSnapshotFingerprint,
        targetIdentityDigest: prepared.targetIdentityDigest
      })
    ) {
      return {
        kind: "no_effect_failure",
        code: "EXPERIMENT_RUN_MANUSCRIPT_TARGET_ACCEPTANCE_MISSING",
        message: "The exact latest BODY has no prior LP12 Run target acceptance; no formal effect was invoked."
      };
    }
    let baseline: PreservationBaseline;
    try {
      baseline = await preservationBaseline(result.target.entityId);
    } catch (error) {
      return {
        kind: "no_effect_failure",
        code: error instanceof AIExperimentRunManuscriptTargetAcceptanceError
          ? error.code
          : "EXPERIMENT_RUN_MANUSCRIPT_BASELINE_UNAVAILABLE",
        message: error instanceof Error ? error.message : "The fresh preservation baseline is unavailable."
      };
    }
    preservationByOperation.set(operationId, baseline);
    preparedByResult.delete(result.id);
    let saved: Awaited<ReturnType<typeof dependencies.saveAs>>;
    try {
      saved = await dependencies.saveAs({
        runId: result.target.entityId,
        sourceSessionKey: prepared.sourceSessionKey,
        sourceMode: "independent",
        pickerTitle: "Choose a managed file for the new ExperimentRun manuscript",
        acknowledgePresentation: async () => true,
        operationRequestKey: operationId,
        targetAcceptanceId: prepared.targetAcceptanceId,
        requireManagedTarget: true
      });
    } catch (error) {
      await closeSession(prepared.sourceSessionKey);
      dependencies.discardCanonicalTarget(prepared.targetAcceptanceId);
      const readback = await dependencies.readOperation(operationId).catch(() => null);
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
            code: "EXPERIMENT_RUN_MANUSCRIPT_EFFECT_UNKNOWN",
            message: error instanceof Error ? error.message : "The canonical Run Save As outcome is unknown."
          };
    }
    dependencies.discardCanonicalTarget(prepared.targetAcceptanceId);
    await closeSession(prepared.sourceSessionKey);
    if (saved.status === "success") {
      if (!saved.sessionKey) {
        return {
          kind: "pending",
          code: "EXPERIMENT_RUN_MANUSCRIPT_PRESENTATION_READBACK_MISSING",
          message: "The canonical Run Save As success has no independent presentation session readback."
        };
      }
      await closeSession(saved.sessionKey);
      const operation = await dependencies.readOperation(operationId);
      if (
        !operation || saved.operationId !== operationId ||
        saved.fileRefId !== operation.targetFileRefId ||
        operation.targetPathIdentityKey !== prepared.targetPathIdentityKey
      ) {
        return {
          kind: "pending",
          code: "EXPERIMENT_RUN_MANUSCRIPT_OPERATION_READBACK_MISSING",
          message: "The canonical Run Save As success has no exact operation/FileRef/accepted-target readback."
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
      preservationByOperation.delete(operationId);
      return {
        kind: "no_effect_failure",
        code: "EXPERIMENT_RUN_MANUSCRIPT_TARGET_ACCEPTANCE_CANCELED",
        message: "The pre-effect target acceptance was canceled with zero effect."
      };
    }
    const operation = await dependencies.readOperation(operationId).catch(() => null);
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
    if (saved.status === "error") preservationByOperation.delete(operationId);
    return {
      kind: saved.status === "error" ? "no_effect_failure" : "pending",
      code: "errorCode" in saved
        ? saved.errorCode ?? "EXPERIMENT_RUN_MANUSCRIPT_EFFECT_UNKNOWN"
        : "EXPERIMENT_RUN_MANUSCRIPT_EFFECT_UNKNOWN",
      message: saved.status === "error"
        ? "The canonical Run Save As service proved zero effect before D1."
        : "The canonical Run Save As effect remains unknown and cannot be redispatched."
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

export const aiExperimentRunManuscriptStandardResultAdapter =
  createAIExperimentRunManuscriptStandardResultAdapter();

export function validateAIExperimentRunManuscriptStandardResultProposal(input: {
  target: AIStandardResultTarget;
  source?: AIParseDraftSourceSnapshot;
  payload: unknown;
  expectedProjectId: string;
  expectedTargetSnapshotFingerprint?: string;
}) {
  return aiExperimentRunManuscriptStandardResultAdapter.validate(input);
}

export function prepareAIExperimentRunManuscriptTargetAcceptance(input: {
  result: AIStandardResult;
  normalizedPayload: Record<string, unknown>;
  plannedAuthorizationId: string;
}) {
  return aiExperimentRunManuscriptStandardResultAdapter.prepareTargetAcceptance(input);
}

export function getPreparedAIExperimentRunManuscriptAuthorizationId(result: AIStandardResult) {
  return aiExperimentRunManuscriptStandardResultAdapter.preparedAuthorizationId(result);
}

export function releaseAIExperimentRunManuscriptTargetAcceptance(resultId: string) {
  return aiExperimentRunManuscriptStandardResultAdapter.release(resultId);
}

export function invokeAIExperimentRunManuscriptStandardResultEffect(input: {
  result: AIStandardResult;
  normalizedPayload: Record<string, unknown>;
  invocationMode: "initial" | "continuation";
}) {
  return aiExperimentRunManuscriptStandardResultAdapter.invoke(input);
}
