import type {
  AIParseDraftSourceSnapshot,
  AIStandardResult,
  AIStandardResultEffectReceipt,
  AIStandardResultTarget,
  AIStandardResultValidationIssue
} from "../types/aiStandardResult";
import type { FileRef, Literature, ManuscriptBinding } from "../types";
import type { SharedManuscriptSession } from "../types/sharedManuscriptSession";
import {
  AI_STANDARD_RESULT_MAX_PAYLOAD_CHARS,
  canonicalAIStandardResultFingerprint
} from "./aiStandardResultService";
import { validateAILiteratureStandardResultProposal } from "./aiLiteratureStandardResultAdapter";
import { literatureService } from "./literatureService";
import { resolveMountedManuscriptLifecycleDecision } from "./fileRefOwnerValidator";
import { manuscriptBindingService } from "./manuscriptBindingService";
import { fileRefService } from "./fileRefService";
import { manuscriptListService } from "./manuscriptListService";
import { manuscriptIoService } from "./manuscriptIoService";
import {
  parseLabPodMarkdownDocument,
  serializeLabPodMarkdownDocument
} from "./labPodMarkdownDocumentService";
import { literatureManuscriptSaveAsAdapter } from "./literatureManuscriptSaveAsAdapter";
import {
  manuscriptSaveAsOperationPort,
  type SaveAsOperationRecord
} from "./manuscriptSaveAsOperationPort";
import { sha256SaveAsRaw } from "./manuscriptSaveAsSourceSnapshot";
import { literatureRawManuscriptService } from "./literatureRawManuscriptService";
import { sharedManuscriptSessionRuntime } from "./sharedManuscriptSessionComposition";
import { buildLiteratureCandidateFileName } from "./literatureCandidateFilenameService";
import { resolveLiteratureWorkspaceFolder } from "./literatureManuscriptService";
import { buildManagedManuscriptPath } from "./managedPathService";

export const AI_LITERATURE_MANUSCRIPT_NEW_MANUSCRIPT_BODY_MAX_CHARS = 6_000;
export const AI_LITERATURE_OUTLINE_NEW_MANUSCRIPT_BODY_MAX_CHARS =
  AI_LITERATURE_MANUSCRIPT_NEW_MANUSCRIPT_BODY_MAX_CHARS;
export const AI_LITERATURE_DEDICATED_NOTES_NEW_MANUSCRIPT_BODY_MAX_CHARS =
  AI_LITERATURE_MANUSCRIPT_NEW_MANUSCRIPT_BODY_MAX_CHARS;
export const AI_LITERATURE_MANUSCRIPT_NEW_MANUSCRIPT_ENCODING = "utf-8" as const;
export const AI_LITERATURE_MANUSCRIPT_NEW_MANUSCRIPT_LINE_ENDING = "LF" as const;
export const AI_LITERATURE_MANUSCRIPT_NEW_MANUSCRIPT_TERMINAL_NEWLINE =
  "one LF for the complete LabPod Markdown document" as const;
export const AI_LITERATURE_OUTLINE_NEW_MANUSCRIPT_READBACK_STATE =
  "AUTHORITATIVE_LITERATURE_OUTLINE_FILE_REF_LIST_PHYSICAL_BODY_DUAL_CHANNEL_BINDING_PRESERVED" as const;
export const AI_LITERATURE_DEDICATED_NOTES_NEW_MANUSCRIPT_READBACK_STATE =
  "AUTHORITATIVE_LITERATURE_DEDICATED_NOTES_FILE_REF_LIST_PHYSICAL_BODY_DUAL_CHANNEL_BINDING_PRESERVED" as const;
export const AI_LITERATURE_MANUSCRIPT_NEW_MANUSCRIPT_PRESERVATION_MODE =
  "CANONICAL_OPERATION_CONTRACT_NO_BINDING_WRITE_PLUS_DUAL_CHANNEL_EXACT_READBACK" as const;

type LiteratureTarget = Extract<AIStandardResultTarget, { module: "literature" }>;
type LiteratureManuscriptChannel = "literature_outline" | "dedicated_notes";

type LiteratureManuscriptChannelPolicy = Readonly<{
  channel: LiteratureManuscriptChannel;
  errorPrefix: "LITERATURE_OUTLINE_MANUSCRIPT" | "LITERATURE_DEDICATED_NOTES_MANUSCRIPT";
  operationPrefix: "a17-lit-outline-man" | "a18-lit-notes-man";
  label: "Literature outline" | "Literature dedicated notes";
  consumerLabel: "outline" | "dedicated-notes";
  readbackState:
    | typeof AI_LITERATURE_OUTLINE_NEW_MANUSCRIPT_READBACK_STATE
    | typeof AI_LITERATURE_DEDICATED_NOTES_NEW_MANUSCRIPT_READBACK_STATE;
}>;

function channelPolicy(channel: LiteratureManuscriptChannel): LiteratureManuscriptChannelPolicy {
  return channel === "literature_outline"
    ? {
        channel,
        errorPrefix: "LITERATURE_OUTLINE_MANUSCRIPT",
        operationPrefix: "a17-lit-outline-man",
        label: "Literature outline",
        consumerLabel: "outline",
        readbackState: AI_LITERATURE_OUTLINE_NEW_MANUSCRIPT_READBACK_STATE
      }
    : {
        channel,
        errorPrefix: "LITERATURE_DEDICATED_NOTES_MANUSCRIPT",
        operationPrefix: "a18-lit-notes-man",
        label: "Literature dedicated notes",
        consumerLabel: "dedicated-notes",
        readbackState: AI_LITERATURE_DEDICATED_NOTES_NEW_MANUSCRIPT_READBACK_STATE
      };
}

function channelCode(
  channel: LiteratureManuscriptChannel,
  suffix: string
) {
  return `${channelPolicy(channel).errorPrefix}_${suffix}`;
}

export type AILiteratureOutlineManuscriptValidation = {
  executable: boolean;
  normalizedPayload: Record<string, unknown>;
  validationIssues: AIStandardResultValidationIssue[];
  targetSnapshotFingerprint?: string;
  resolvedTarget?: LiteratureTarget;
};

export type AILiteratureOutlineManuscriptEffectOutcome =
  | { kind: "settled"; receipt: AIStandardResultEffectReceipt }
  | { kind: "pending"; code: string; message: string }
  | { kind: "no_effect_failure"; code: string; message: string };

export type AILiteratureOutlineManuscriptTargetAcceptanceOutcome =
  | { status: "accepted"; targetFileName: string }
  | { status: "canceled" };

export class AILiteratureOutlineManuscriptTargetAcceptanceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AILiteratureOutlineManuscriptTargetAcceptanceError";
  }
}

class AILiteratureOutlineManuscriptReadbackPendingError extends Error {
  readonly effectMayExist = true;

  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AILiteratureOutlineManuscriptReadbackPendingError";
  }
}

type PreparedTarget = {
  resultId: string;
  channel: LiteratureManuscriptChannel;
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
  outlineBinding: ManuscriptBinding;
  outlineCurrentFileRefId: string;
  outlineCurrentPhysicalFingerprint: string;
  outlineFileRefIds: string[];
  notesBinding: ManuscriptBinding;
  notesCurrentFileRefId: string;
  notesCurrentPhysicalFingerprint: string;
  notesFileRefIds: string[];
};

export interface AILiteratureOutlineManuscriptDependencies {
  validateLiteratureBase: typeof validateAILiteratureStandardResultProposal;
  getLiterature: typeof literatureService.getLiteratureById;
  resolveLifecycle: typeof resolveMountedManuscriptLifecycleDecision;
  getBinding: typeof manuscriptBindingService.getBindingByOwner;
  getFileRef: typeof fileRefService.getById;
  listManuscripts: typeof manuscriptListService.getAvailableManuscripts;
  readCurrentManuscript: typeof manuscriptIoService.readCurrentManuscript;
  readManuscriptByFileRef: typeof manuscriptIoService.readManuscriptByFileRef;
  prepareCanonicalTarget: typeof literatureManuscriptSaveAsAdapter.prepareTargetAcceptance;
  discardCanonicalTarget: typeof literatureManuscriptSaveAsAdapter.discardTargetAcceptance;
  saveAs: typeof literatureManuscriptSaveAsAdapter.saveAs;
  recoverSaveAs: typeof literatureManuscriptSaveAsAdapter.recoverAcceptedTarget;
  readOperation: typeof manuscriptSaveAsOperationPort.readback;
  openIndependent: typeof literatureRawManuscriptService.openIndependent;
  updateIndependentDraft: typeof literatureRawManuscriptService.updateDraft;
  closeIndependent: typeof literatureRawManuscriptService.closeExact;
  listRuntimeSessions(): SharedManuscriptSession[];
  resolveManagedCandidateTarget?(input: {
    literatureId: string;
    manuscriptChannel: LiteratureManuscriptChannel;
    occurredAt: string;
    operationId: string;
  }): Promise<string>;
}

const defaultDependencies: AILiteratureOutlineManuscriptDependencies = {
  validateLiteratureBase: validateAILiteratureStandardResultProposal,
  getLiterature: literatureService.getLiteratureById,
  resolveLifecycle: resolveMountedManuscriptLifecycleDecision,
  getBinding: manuscriptBindingService.getBindingByOwner,
  getFileRef: fileRefService.getById,
  listManuscripts: manuscriptListService.getAvailableManuscripts,
  readCurrentManuscript: manuscriptIoService.readCurrentManuscript,
  readManuscriptByFileRef: manuscriptIoService.readManuscriptByFileRef,
  prepareCanonicalTarget: (input) =>
    literatureManuscriptSaveAsAdapter.prepareTargetAcceptance(input),
  discardCanonicalTarget: (targetAcceptanceId) =>
    literatureManuscriptSaveAsAdapter.discardTargetAcceptance(targetAcceptanceId),
  saveAs: (input) => "targetAcceptanceId" in input
    ? literatureManuscriptSaveAsAdapter.saveAs(input)
    : literatureManuscriptSaveAsAdapter.saveAs(input),
  recoverSaveAs: (operationId, literatureId, channel) =>
    literatureManuscriptSaveAsAdapter.recoverAcceptedTarget(operationId, literatureId, channel),
  readOperation: (operationId) => manuscriptSaveAsOperationPort.readback(operationId),
  openIndependent: (literatureId, channel, fileRefId, consumerId) =>
    literatureRawManuscriptService.openIndependent(
      literatureId,
      channel,
      fileRefId,
      consumerId
    ),
  updateIndependentDraft: (sessionKey, channel, role, raw) =>
    literatureRawManuscriptService.updateDraft(sessionKey, channel, role, raw),
  closeIndependent: (sessionKey, decision) =>
    literatureRawManuscriptService.closeExact(sessionKey, decision),
  listRuntimeSessions: () => sharedManuscriptSessionRuntime.listSessions(),
  async resolveManagedCandidateTarget(input) {
    const workspace = await resolveLiteratureWorkspaceFolder(input.literatureId);
    const plan = buildLiteratureCandidateFileName({
      manuscriptChannel: input.manuscriptChannel,
      source: "ai",
      occurredAt: input.occurredAt,
      requestId: input.operationId
    });
    return buildManagedManuscriptPath(workspace.path, plan.fileName);
  }
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
  return /LABPOD_(?:META_SNAPSHOT|OUTLINE|BODY)_(?:START|END)/iu.test(value) ||
    /LABPOD:STRUCTURED_OUTLINE_ARCHIVE_(?:BEGIN|END)_V1/iu.test(value);
}

export function normalizeAILiteratureOutlineManuscriptBody(value: string) {
  return value.replace(/\r\n/gu, "\n");
}

function normalizeBody(
  value: unknown,
  issues: AIStandardResultValidationIssue[],
  channel: LiteratureManuscriptChannel
): string | undefined {
  const policy = channelPolicy(channel);
  const payload = asRecord(value);
  if (!payload || Object.keys(payload).length !== 1 || !("body" in payload)) {
    issues.push(issue(
      channelCode(channel, "PAYLOAD_INVALID"),
      `The visible ${policy.label} manuscript payload requires exactly one editable body field.`
    ));
    return undefined;
  }
  if (typeof payload.body !== "string") {
    issues.push(issue(
      channelCode(channel, "BODY_INVALID"),
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
      channelCode(channel, "BODY_INVALID"),
      "body must be non-empty well-formed Unicode Markdown with no NUL, hidden control, protocol marker, BOM, or bare CR.",
      "body"
    ));
    return undefined;
  }
  if (charCount(body) > AI_LITERATURE_MANUSCRIPT_NEW_MANUSCRIPT_BODY_MAX_CHARS) {
    issues.push(issue(
      channelCode(channel, "BODY_OVERFLOW"),
      `body exceeds the ${AI_LITERATURE_MANUSCRIPT_NEW_MANUSCRIPT_BODY_MAX_CHARS}-Unicode-character limit; truncation is forbidden.`,
      "body"
    ));
    return undefined;
  }
  const normalized = normalizeAILiteratureOutlineManuscriptBody(body);
  if (charCount(JSON.stringify({ body: normalized })) > AI_STANDARD_RESULT_MAX_PAYLOAD_CHARS) {
    issues.push(issue(
      channelCode(channel, "SHARED_PAYLOAD_LIMIT"),
      `The serialized payload exceeds the shared ${AI_STANDARD_RESULT_MAX_PAYLOAD_CHARS}-character bound.`,
      "body"
    ));
    return undefined;
  }
  return normalized;
}

function exactBindingIdentity(
  binding: ManuscriptBinding | undefined,
  literatureId: string,
  channel: "literature_outline" | "dedicated_notes"
) {
  return Boolean(
    binding && !binding.deletedAt && binding.ownerType === "literature" &&
    binding.ownerId === literatureId && binding.manuscriptChannel === channel
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

function exactLiteratureFileRef(
  fileRef: FileRef | undefined,
  literatureId: string,
  channel: "literature_outline" | "dedicated_notes"
) {
  return Boolean(
    fileRef && !fileRef.deletedAt && fileRef.ownerType === "literature" &&
    fileRef.ownerId === literatureId && fileRef.manuscriptChannel === channel &&
    fileRef.resourceKind === "file" && fileRef.fileRole === "manuscript"
  );
}

function sortedFileRefIds(items: Array<{ fileRefId: string }>) {
  return items.map((item) => item.fileRefId).sort((left, right) => left.localeCompare(right));
}

function sameIds(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function targetFingerprint(input: {
  literature: Literature;
  outlineBinding: ManuscriptBinding;
  notesBinding: ManuscriptBinding;
}) {
  return canonicalAIStandardResultFingerprint({
    literature: {
      id: input.literature.id,
      primaryProjectId: input.literature.primaryProjectId?.trim() || null,
      isArchived: input.literature.isArchived,
      deletedAt: input.literature.deletedAt ?? null,
      updatedAt: input.literature.updatedAt
    },
    outlineBinding: bindingProjection(input.outlineBinding),
    dedicatedNotesBinding: bindingProjection(input.notesBinding)
  });
}

function operationRequestKey(
  resultId: string,
  authorizationId: string,
  channel: LiteratureManuscriptChannel
) {
  const key = `${channelPolicy(channel).operationPrefix}:${resultId}:${authorizationId}`;
  if (
    key !== key.trim() || !key.trim() || Array.from(key).length > 200 ||
    /[\0-\x1F\x7F]/u.test(key)
  ) {
    throw new AILiteratureOutlineManuscriptTargetAcceptanceError(
      channelCode(channel, "OPERATION_KEY_INVALID"),
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
  return canonicalAIStandardResultFingerprint(input);
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

export function createAILiteratureOutlineManuscriptStandardResultAdapter(
  dependencies: AILiteratureOutlineManuscriptDependencies = defaultDependencies
) {
  const preparedByResult = new Map<string, PreparedTarget>();
  const preservationByOperation = new Map<string, PreservationBaseline>();

  async function validate(input: {
    target: AIStandardResultTarget;
    source?: AIParseDraftSourceSnapshot;
    payload: unknown;
    expectedProjectId: string;
    expectedTargetSnapshotFingerprint?: string;
    expectedManuscriptChannel: LiteratureManuscriptChannel;
  }): Promise<AILiteratureOutlineManuscriptValidation> {
    const expectedChannel = input.expectedManuscriptChannel;
    const policy = channelPolicy(expectedChannel);
    const issues: AIStandardResultValidationIssue[] = [];
    if (input.target.module !== "literature" || input.target.entityType !== "literature") {
      return {
        executable: false,
        normalizedPayload: {},
        validationIssues: [issue(
          channelCode(expectedChannel, "TARGET_INVALID"),
          `NEW_MANUSCRIPT requires one exact canonical Literature/${expectedChannel} target.`
        )]
      };
    }
    const target = input.target;
    const base = await dependencies.validateLiteratureBase({
      action: "NEW_MANUSCRIPT",
      target,
      source: input.source,
      payload: input.payload,
      expectedProjectId: input.expectedProjectId
    });
    issues.push(...base.validationIssues.filter(
      (candidate) => candidate.code !== "LITERATURE_NEW_MANUSCRIPT_NOT_ENABLED_IN_A16"
    ));
    if (!target.entityId) {
      issues.push(issue(
        channelCode(expectedChannel, "OWNER_REQUIRED"),
        "NEW_MANUSCRIPT requires an existing canonical Literature identity.",
        "target.entityId"
      ));
    }
    if (target.manuscriptChannel !== expectedChannel) {
      issues.push(issue(
        channelCode(expectedChannel, "CHANNEL_INVALID"),
        `This exact channel path accepts only Literature/${expectedChannel}; no fallback or channel substitution is allowed.`,
        "target.manuscriptChannel"
      ));
    }
    const body = normalizeBody(input.payload, issues, expectedChannel);
    const literature = target.entityId
      ? await dependencies.getLiterature(target.entityId)
      : undefined;
    if (!literature || literature.deletedAt || literature.isArchived) {
      issues.push(issue(
        channelCode(expectedChannel, "OWNER_UNAVAILABLE"),
        "The canonical Literature owner is missing, archived, or deleted."
      ));
    } else if (
      target.primaryProjectId !== undefined &&
      (literature.primaryProjectId?.trim() || null) !== target.primaryProjectId
    ) {
      issues.push(issue(
        channelCode(expectedChannel, "ASSOCIATION_STALE"),
        "The canonical Literature Project association changed after Parse Draft."
      ));
    }

    let outlineBinding: ManuscriptBinding | undefined;
    let notesBinding: ManuscriptBinding | undefined;
    if (literature) {
      try {
        const lifecycle = await dependencies.resolveLifecycle({
          ownerType: "literature",
          ownerId: literature.id,
          manuscriptChannel: expectedChannel
        });
        if (!lifecycle.canSaveAs || !lifecycle.canOpenIndependent || lifecycle.readOnly) {
          issues.push(issue(
            channelCode(expectedChannel, "LIFECYCLE_INELIGIBLE"),
            `The current ${policy.label} lifecycle does not allow an independent managed manuscript.`
          ));
        }
      } catch (error) {
        issues.push(issue(
          channelCode(expectedChannel, "LIFECYCLE_INELIGIBLE"),
          error instanceof Error ? error.message : `The ${policy.label} lifecycle is unavailable.`
        ));
      }
      try {
        [outlineBinding, notesBinding] = await Promise.all([
          dependencies.getBinding("literature", literature.id, "literature_outline"),
          dependencies.getBinding("literature", literature.id, "dedicated_notes")
        ]);
      } catch (error) {
        issues.push(issue(
          channelCode(expectedChannel, "BINDING_CONFLICT"),
          error instanceof Error ? error.message : "The Literature dual-channel Binding is ambiguous."
        ));
      }
      if (
        !exactBindingIdentity(outlineBinding, literature.id, "literature_outline") ||
        !exactBindingIdentity(notesBinding, literature.id, "dedicated_notes")
      ) {
        issues.push(issue(
          channelCode(expectedChannel, "BINDING_UNAVAILABLE"),
          "Both canonical Literature channel Bindings are required before an exact-channel NEW_MANUSCRIPT effect."
        ));
      } else if (
        !outlineBinding?.defaultFolderFileRefId ||
        !outlineBinding.defaultManuscriptFileRefId || !outlineBinding.currentFileRefId ||
        !notesBinding?.defaultFolderFileRefId ||
        !notesBinding.defaultManuscriptFileRefId || !notesBinding.currentFileRefId
      ) {
        issues.push(issue(
          channelCode(expectedChannel, "BINDING_INCOMPLETE"),
          "A16 create-time provisioning must provide complete outline and dedicated_notes default/current pointers before an exact-channel NEW_MANUSCRIPT effect."
        ));
      } else {
        const [outlineDefault, outlineCurrent, notesDefault, notesCurrent] = await Promise.all([
          dependencies.getFileRef(outlineBinding.defaultManuscriptFileRefId),
          dependencies.getFileRef(outlineBinding.currentFileRefId),
          dependencies.getFileRef(notesBinding.defaultManuscriptFileRefId),
          dependencies.getFileRef(notesBinding.currentFileRefId)
        ]);
        if (
          !exactLiteratureFileRef(outlineDefault, literature.id, "literature_outline") ||
          !exactLiteratureFileRef(outlineCurrent, literature.id, "literature_outline") ||
          !exactLiteratureFileRef(notesDefault, literature.id, "dedicated_notes") ||
          !exactLiteratureFileRef(notesCurrent, literature.id, "dedicated_notes")
        ) {
          issues.push(issue(
            channelCode(expectedChannel, "BINDING_IDENTITY_DRIFT"),
            "The dual-channel Bindings reference no exact active canonical default/current manuscripts."
          ));
        }
      }
    }

    const resolvedTarget: LiteratureTarget | undefined = literature
      ? {
          module: "literature",
          projectId: input.expectedProjectId,
          entityType: "literature",
          entityId: literature.id,
          primaryProjectId: literature.primaryProjectId?.trim() || null,
          manuscriptChannel: expectedChannel
        }
      : undefined;
    const currentFingerprint = literature && outlineBinding && notesBinding &&
      exactBindingIdentity(outlineBinding, literature.id, "literature_outline") &&
      exactBindingIdentity(notesBinding, literature.id, "dedicated_notes")
      ? targetFingerprint({ literature, outlineBinding, notesBinding })
      : undefined;
    if (
      input.expectedTargetSnapshotFingerprint &&
      input.expectedTargetSnapshotFingerprint !== currentFingerprint
    ) {
      issues.push(issue(
        channelCode(expectedChannel, "TARGET_STALE"),
        "The Literature owner or either manuscript Binding changed after Parse Draft; re-parse is required."
      ));
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
    await dependencies.closeIndependent(sessionKey, "discard").catch(() => undefined);
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
    expectedManuscriptChannel: LiteratureManuscriptChannel;
  }): Promise<AILiteratureOutlineManuscriptTargetAcceptanceOutcome> {
    const { result } = input;
    const expectedChannel = input.expectedManuscriptChannel;
    const policy = channelPolicy(expectedChannel);
    if (
      result.target.module !== "literature" || result.action !== "NEW_MANUSCRIPT" ||
      result.category !== "MANUSCRIPT_RESULT" || !result.target.entityId ||
      result.target.manuscriptChannel !== expectedChannel ||
      !input.plannedAuthorizationId.trim()
    ) {
      throw new AILiteratureOutlineManuscriptTargetAcceptanceError(
        channelCode(expectedChannel, "TARGET_ACCEPTANCE_INVALID"),
        `Only one pending exact Literature/${expectedChannel} NEW_MANUSCRIPT Result can select a target.`
      );
    }
    await release(result.id);
    const operationId = operationRequestKey(
      result.id,
      input.plannedAuthorizationId,
      expectedChannel
    );
    let existingOperation: SaveAsOperationRecord | null;
    try {
      existingOperation = await dependencies.readOperation(operationId);
    } catch (error) {
      throw new AILiteratureOutlineManuscriptTargetAcceptanceError(
        channelCode(expectedChannel, "OPERATION_READBACK_UNAVAILABLE"),
        error instanceof Error ? error.message : "The canonical operation authority is unavailable."
      );
    }
    if (existingOperation) {
      throw new AILiteratureOutlineManuscriptTargetAcceptanceError(
        channelCode(expectedChannel, "OPERATION_ALREADY_EXISTS"),
        "An unclaimed Result cannot select a new target for an existing operation."
      );
    }
    const binding = await dependencies.getBinding(
      "literature",
      result.target.entityId,
      expectedChannel
    );
    if (
      !binding?.currentFileRefId ||
      !exactBindingIdentity(binding, result.target.entityId, expectedChannel)
    ) {
      throw new AILiteratureOutlineManuscriptTargetAcceptanceError(
        channelCode(expectedChannel, "BINDING_UNAVAILABLE"),
        `The exact ${policy.label} current manuscript is unavailable for canonical Save As.`
      );
    }
    const conflict = dependencies.listRuntimeSessions().some((session) =>
      session.windowRole === "independent" && session.owner.ownerType === "literature" &&
      session.owner.ownerId === result.target.entityId &&
      session.owner.channel === expectedChannel &&
      session.file.kind === "durable" && session.file.fileRefId === binding.currentFileRefId
    );
    if (conflict) {
      throw new AILiteratureOutlineManuscriptTargetAcceptanceError(
        channelCode(expectedChannel, "SOURCE_SESSION_CONFLICT"),
        `Close the existing independent window for the current ${policy.label} before selecting an AI target.`
      );
    }
    const opened = await dependencies.openIndependent(
      result.target.entityId,
      expectedChannel,
      binding.currentFileRefId,
      `ai-literature-${policy.consumerLabel}-manuscript:${result.id}:source`
    );
    if (opened.status !== "success" || !("sessionKey" in opened)) {
      throw new AILiteratureOutlineManuscriptTargetAcceptanceError(
        channelCode(expectedChannel, "SOURCE_OPEN_FAILED"),
        `The canonical independent ${policy.label} source session could not be opened.`
      );
    }
    const sourceSessionKey = opened.sessionKey;
    const body = input.normalizedPayload.body as string;
    const serializedRaw = serializeBody(body);
    const updated = dependencies.updateIndependentDraft(
      sourceSessionKey,
      expectedChannel,
      "independent",
      serializedRaw
    );
    if (updated.status !== "success") {
      await closeSession(sourceSessionKey);
      throw new AILiteratureOutlineManuscriptTargetAcceptanceError(
        channelCode(expectedChannel, "SOURCE_DRAFT_FAILED"),
        `The canonical independent ${policy.label} draft could not be frozen.`
      );
    }
    let accepted: Awaited<ReturnType<typeof dependencies.prepareCanonicalTarget>>;
    try {
      const preselectedManagedTargetPath = dependencies.resolveManagedCandidateTarget
        ? await dependencies.resolveManagedCandidateTarget({
            literatureId: result.target.entityId,
            manuscriptChannel: expectedChannel,
            occurredAt: result.createdAt,
            operationId
          })
        : undefined;
      accepted = await dependencies.prepareCanonicalTarget({
        literatureId: result.target.entityId,
        manuscriptChannel: expectedChannel,
        sourceSessionKey,
        sourceWindowRole: "independent",
        pickerTitle: `Choose a managed file for the new ${policy.label} manuscript`,
        operationRequestKey: operationId,
        requireManagedTarget: true,
        ...(preselectedManagedTargetPath ? { preselectedManagedTargetPath } : {})
      });
    } catch (error) {
      await closeSession(sourceSessionKey);
      throw new AILiteratureOutlineManuscriptTargetAcceptanceError(
        channelCode(expectedChannel, "TARGET_SELECTION_FAILED"),
        error instanceof Error ? error.message : "The LP12 target picker failed safely."
      );
    }
    if (accepted.status === "canceled") {
      await closeSession(sourceSessionKey);
      return { status: "canceled" };
    }
    if (accepted.status !== "accepted") {
      await closeSession(sourceSessionKey);
      throw new AILiteratureOutlineManuscriptTargetAcceptanceError(
        channelCode(expectedChannel, "TARGET_SELECTION_FAILED"),
        `The LP12 target picker rejected the target (${accepted.error.code}).`
      );
    }
    const targetIdentityDigest = canonicalAIStandardResultFingerprint(
      accepted.targetIdentityDigest
    );
    preparedByResult.set(result.id, {
      resultId: result.id,
      channel: expectedChannel,
      visiblePayloadFingerprint: result.visiblePayloadFingerprint,
      authorizationId: input.plannedAuthorizationId,
      operationId,
      targetAcceptanceId: accepted.targetAcceptanceId,
      targetPathIdentityKey: accepted.targetIdentityDigest,
      targetIdentityDigest,
      authorizationFingerprint: targetAuthorizationFingerprint({
        resultId: result.id,
        authorizationId: input.plannedAuthorizationId,
        payloadFingerprint: result.visiblePayloadFingerprint,
        targetSnapshotFingerprint: result.targetSnapshotFingerprint,
        targetIdentityDigest
      }),
      sourceSessionKey,
      serializedRawFingerprint: await sha256SaveAsRaw(serializedRaw)
    });
    return { status: "accepted", targetFileName: accepted.targetFileName };
  }

  function preparedAuthorizationId(result: AIStandardResult) {
    const prepared = preparedByResult.get(result.id);
    return prepared && result.target.module === "literature" &&
      result.action === "NEW_MANUSCRIPT" &&
      result.target.manuscriptChannel === prepared.channel &&
      prepared.visiblePayloadFingerprint === result.visiblePayloadFingerprint
      ? prepared.authorizationId
      : undefined;
  }

  async function preservationBaseline(
    literatureId: string,
    expectedChannel: LiteratureManuscriptChannel
  ): Promise<PreservationBaseline> {
    const [outlineBinding, notesBinding, outlineList, notesList, outlineCurrent, notesCurrent] =
      await Promise.all([
        dependencies.getBinding("literature", literatureId, "literature_outline"),
        dependencies.getBinding("literature", literatureId, "dedicated_notes"),
        dependencies.listManuscripts("literature", literatureId, "literature_outline"),
        dependencies.listManuscripts("literature", literatureId, "dedicated_notes"),
        dependencies.readCurrentManuscript("literature", literatureId, {
          manuscriptChannel: "literature_outline"
        }),
        dependencies.readCurrentManuscript("literature", literatureId, {
          manuscriptChannel: "dedicated_notes"
        })
      ]);
    if (
      !outlineBinding?.currentFileRefId || !notesBinding?.currentFileRefId ||
      !exactBindingIdentity(outlineBinding, literatureId, "literature_outline") ||
      !exactBindingIdentity(notesBinding, literatureId, "dedicated_notes") ||
      outlineList.status !== "success" || notesList.status !== "success" ||
      outlineCurrent.status !== "success" || notesCurrent.status !== "success" ||
      outlineCurrent.fileRefId !== outlineBinding.currentFileRefId ||
      notesCurrent.fileRefId !== notesBinding.currentFileRefId
    ) {
      throw new AILiteratureOutlineManuscriptTargetAcceptanceError(
        channelCode(expectedChannel, "PRESERVATION_BASELINE_UNAVAILABLE"),
        "The dual-channel Literature preservation baseline is unavailable."
      );
    }
    return {
      outlineBinding,
      outlineCurrentFileRefId: outlineCurrent.fileRefId,
      outlineCurrentPhysicalFingerprint: canonicalAIStandardResultFingerprint(outlineCurrent.content),
      outlineFileRefIds: sortedFileRefIds(outlineList.items),
      notesBinding,
      notesCurrentFileRefId: notesCurrent.fileRefId,
      notesCurrentPhysicalFingerprint: canonicalAIStandardResultFingerprint(notesCurrent.content),
      notesFileRefIds: sortedFileRefIds(notesList.items)
    };
  }

  function operationIdentityMatches(
    operation: SaveAsOperationRecord,
    literatureId: string,
    operationId: string,
    serializedRawFingerprint: string,
    expectedChannel: LiteratureManuscriptChannel
  ) {
    return operation.operationId === operationId && operation.ownerType === "literature" &&
      operation.ownerId === literatureId && operation.channel === expectedChannel &&
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
    expectedManuscriptChannel: LiteratureManuscriptChannel;
  }): Promise<AIStandardResultEffectReceipt> {
    const target = input.result.target as LiteratureTarget;
    const literatureId = target.entityId!;
    const authorizationId = input.result.authorizationId!;
    const expectedChannel = input.expectedManuscriptChannel;
    const operationId = operationRequestKey(
      input.result.id,
      authorizationId,
      expectedChannel
    );
    const operationGeneration = input.operation.operationGeneration;
    const expectedCandidateRequestId =
      Number.isInteger(operationGeneration) && operationGeneration > 0
        ? `${operationId}:${operationGeneration}`
        : undefined;
    if (
      !operationIdentityMatches(
        input.operation,
        literatureId,
        operationId,
        input.serializedRawFingerprint,
        expectedChannel
      ) ||
      input.operation.d1CommitState !== "confirmed" || input.operation.d2CommitState !== "confirmed" ||
      !input.operation.targetFileRefId || !input.operation.sourceFileRefId
    ) {
      throw new AILiteratureOutlineManuscriptReadbackPendingError(
        channelCode(expectedChannel, "OPERATION_INCOMPLETE"),
        "The bound canonical Save As operation has no complete D1/D2 readback."
      );
    }
    const [fileRef, outlineBinding, notesBinding, outlineList, notesList] = await Promise.all([
      dependencies.getFileRef(input.operation.targetFileRefId),
      dependencies.getBinding("literature", literatureId, "literature_outline"),
      dependencies.getBinding("literature", literatureId, "dedicated_notes"),
      dependencies.listManuscripts("literature", literatureId, "literature_outline"),
      dependencies.listManuscripts("literature", literatureId, "dedicated_notes")
    ]);
    const targetBinding = expectedChannel === "literature_outline"
      ? outlineBinding
      : notesBinding;
    if (
      !fileRef || !exactLiteratureFileRef(fileRef, literatureId, expectedChannel) ||
      fileRef.id !== input.operation.targetFileRefId || fileRef.locationMode !== "managed" ||
      !expectedCandidateRequestId ||
      fileRef.candidateRequestId !== expectedCandidateRequestId ||
      !fileRef.candidateOccurredAt?.trim() ||
      input.operation.targetPathIdentityKey !== fileRef.pathIdentityKey ||
      !outlineBinding || !exactBindingIdentity(outlineBinding, literatureId, "literature_outline") ||
      !notesBinding || !exactBindingIdentity(notesBinding, literatureId, "dedicated_notes") ||
      !outlineBinding.currentFileRefId || !outlineBinding.defaultManuscriptFileRefId ||
      !notesBinding.currentFileRefId || !notesBinding.defaultManuscriptFileRefId ||
      !targetBinding || targetBinding.currentFileRefId !== input.operation.sourceFileRefId ||
      targetBinding.currentFileRefId === fileRef.id ||
      targetBinding.defaultManuscriptFileRefId === fileRef.id ||
      outlineList.status !== "success" || notesList.status !== "success" ||
      (expectedChannel === "literature_outline"
        ? outlineList.items
        : notesList.items
      ).filter((item) => item.fileRefId === fileRef.id).length !== 1
    ) {
      throw new AILiteratureOutlineManuscriptReadbackPendingError(
        channelCode(expectedChannel, "FILE_REF_BINDING_MISMATCH"),
        `The operation does not resolve to one independent managed ${expectedChannel} FileRef with two preserved channel Bindings.`
      );
    }
    const [physical, outlineCurrent, notesCurrent] = await Promise.all([
      dependencies.readManuscriptByFileRef("literature", literatureId, fileRef.id, {
        manuscriptChannel: expectedChannel
      }),
      dependencies.readCurrentManuscript("literature", literatureId, {
        manuscriptChannel: "literature_outline"
      }),
      dependencies.readCurrentManuscript("literature", literatureId, {
        manuscriptChannel: "dedicated_notes"
      })
    ]);
    if (
      physical.status !== "success" || outlineCurrent.status !== "success" ||
      notesCurrent.status !== "success"
    ) {
      throw new AILiteratureOutlineManuscriptReadbackPendingError(
        channelCode(expectedChannel, "PHYSICAL_READBACK_UNAVAILABLE"),
        "The new exact-channel artifact or preserved channel manuscripts are unavailable through the canonical reader."
      );
    }
    const parsed = parseLabPodMarkdownDocument(physical.content);
    if (
      (parsed.status !== "valid" && parsed.status !== "valid-empty") ||
      parsed.body !== input.normalizedBody || parsed.hasBom || parsed.newlineStyle !== "lf" ||
      outlineCurrent.fileRefId !== outlineBinding.currentFileRefId ||
      notesCurrent.fileRefId !== notesBinding.currentFileRefId
    ) {
      throw new AILiteratureOutlineManuscriptReadbackPendingError(
        channelCode(expectedChannel, "BODY_CORRELATION_FAILED"),
        "The parsed physical BODY or preserved dual-channel current identities are mismatched."
      );
    }
    const outlineIds = sortedFileRefIds(outlineList.items);
    const notesIds = sortedFileRefIds(notesList.items);
    if (input.baseline) {
      const expectedOutlineIds = (expectedChannel === "literature_outline"
        ? [...input.baseline.outlineFileRefIds, fileRef.id]
        : [...input.baseline.outlineFileRefIds])
        .sort((left, right) => left.localeCompare(right));
      const expectedNotesIds = (expectedChannel === "dedicated_notes"
        ? [...input.baseline.notesFileRefIds, fileRef.id]
        : [...input.baseline.notesFileRefIds])
        .sort((left, right) => left.localeCompare(right));
      if (
        !sameBinding(input.baseline.outlineBinding, outlineBinding) ||
        !sameBinding(input.baseline.notesBinding, notesBinding) ||
        outlineCurrent.fileRefId !== input.baseline.outlineCurrentFileRefId ||
        notesCurrent.fileRefId !== input.baseline.notesCurrentFileRefId ||
        canonicalAIStandardResultFingerprint(outlineCurrent.content) !==
          input.baseline.outlineCurrentPhysicalFingerprint ||
        canonicalAIStandardResultFingerprint(notesCurrent.content) !==
          input.baseline.notesCurrentPhysicalFingerprint ||
        !sameIds(outlineIds, expectedOutlineIds) ||
        !sameIds(notesIds, expectedNotesIds)
      ) {
        throw new AILiteratureOutlineManuscriptReadbackPendingError(
          channelCode(expectedChannel, "PRESERVATION_FAILED"),
          "The existing dual-channel current/default state or non-target channel changed during independent artifact creation."
        );
      }
    }
    const confirmedBodyFingerprint = canonicalAIStandardResultFingerprint(input.normalizedBody);
    const targetIdentityDigest = canonicalAIStandardResultFingerprint(
      input.operation.targetPathIdentityKey
    );
    return {
      module: "literature",
      entityType: "fileRef",
      entityId: fileRef.id,
      operation: "NEW_MANUSCRIPT",
      service: "literatureManuscriptSaveAsAdapter.saveAs",
      canonicalReadback: {
        projectId: target.projectId,
        literatureId,
        primaryProjectId: target.primaryProjectId ?? null,
        manuscriptChannel: expectedChannel,
        resultId: input.result.id,
        authorizationId,
        authorizationFingerprint: targetAuthorizationFingerprint({
          resultId: input.result.id,
          authorizationId,
          payloadFingerprint: input.result.confirmedPayloadFingerprint!,
          targetSnapshotFingerprint: input.result.targetSnapshotFingerprint,
          targetIdentityDigest
        }),
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
        physicalBodyFingerprint: canonicalAIStandardResultFingerprint(parsed.body),
        physicalEncoding: physical.encoding,
        physicalSizeBytes: physical.sizeBytes,
        bodyNormalization: "CRLF_TO_LF",
        documentLineEnding: AI_LITERATURE_MANUSCRIPT_NEW_MANUSCRIPT_LINE_ENDING,
        documentTerminalNewline: AI_LITERATURE_MANUSCRIPT_NEW_MANUSCRIPT_TERMINAL_NEWLINE,
        preservationProofMode: AI_LITERATURE_MANUSCRIPT_NEW_MANUSCRIPT_PRESERVATION_MODE,
        preservationOperationSourceFileRefId: input.operation.sourceFileRefId,
        outlineBindingReadback: bindingProjection(outlineBinding),
        dedicatedNotesBindingReadback: bindingProjection(notesBinding),
        previousOutlineCurrentFileRefId:
          input.baseline?.outlineCurrentFileRefId ?? outlineBinding.currentFileRefId,
        previousOutlineCurrentBodyFingerprint:
          input.baseline?.outlineCurrentPhysicalFingerprint ??
          canonicalAIStandardResultFingerprint(outlineCurrent.content),
        previousDedicatedNotesCurrentFileRefId:
          input.baseline?.notesCurrentFileRefId ?? notesBinding.currentFileRefId,
        previousDedicatedNotesCurrentBodyFingerprint:
          input.baseline?.notesCurrentPhysicalFingerprint ??
          canonicalAIStandardResultFingerprint(notesCurrent.content),
        outlineManuscriptCount: outlineIds.length,
        dedicatedNotesManuscriptCount: notesIds.length,
        preEffectBaselineSource: input.baseline
          ? "CONFIRM_TIME_DUAL_CHANNEL_BASELINE"
          : "CANONICAL_NO_BINDING_WRITE_OPERATION_PROOF",
        firstProvisioningDisposition: "NOT_APPLICABLE_WITH_CURRENT_CONTRACT",
        outlineBindingPreserved: true,
        dedicatedNotesPreserved: true,
        currentChanged: false,
        defaultChanged: false,
        formalSwitchInvoked: false,
        readbackState: channelPolicy(expectedChannel).readbackState
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
    expectedManuscriptChannel: LiteratureManuscriptChannel;
  }): Promise<AILiteratureOutlineManuscriptEffectOutcome> {
    const baseline = input.baseline ?? preservationByOperation.get(input.operation.operationId);
    try {
      const receipt = await authoritativeReceipt({ ...input, baseline });
      preservationByOperation.delete(input.operation.operationId);
      return { kind: "settled", receipt };
    } catch (error) {
      if (!input.allowSameOperationRecovery) {
        return {
          kind: "pending",
          code: error instanceof AILiteratureOutlineManuscriptReadbackPendingError
            ? error.code
            : channelCode(input.expectedManuscriptChannel, "READBACK_UNKNOWN"),
          message: error instanceof Error ? error.message : "The operation readback is incomplete."
        };
      }
    }
    const target = input.result.target as LiteratureTarget;
    try {
      const recovered = await dependencies.recoverSaveAs(
        input.operation.operationId,
        target.entityId!,
        input.expectedManuscriptChannel
      );
      if (recovered.status === "success") {
        await closeSession(recovered.independentSessionKey);
        const reread = await dependencies.readOperation(input.operation.operationId);
        if (reread) {
          const receipt = await authoritativeReceipt({ ...input, operation: reread, baseline });
          preservationByOperation.delete(input.operation.operationId);
          return { kind: "settled", receipt };
        }
      }
      return {
        kind: "pending",
        code: channelCode(input.expectedManuscriptChannel, "SAME_OPERATION_RECOVERY_PENDING"),
        message: "The existing canonical exact-channel Literature Save As operation still requires authoritative recovery/readback."
      };
    } catch (error) {
      return {
        kind: "pending",
        code: channelCode(input.expectedManuscriptChannel, "SAME_OPERATION_RECOVERY_PENDING"),
        message: error instanceof Error ? error.message : "Same-operation recovery remains pending."
      };
    }
  }

  async function invoke(input: {
    result: AIStandardResult;
    normalizedPayload: Record<string, unknown>;
    invocationMode: "initial" | "continuation";
    expectedManuscriptChannel: LiteratureManuscriptChannel;
  }): Promise<AILiteratureOutlineManuscriptEffectOutcome> {
    const { result } = input;
    const expectedChannel = input.expectedManuscriptChannel;
    const policy = channelPolicy(expectedChannel);
    if (
      result.target.module !== "literature" || result.action !== "NEW_MANUSCRIPT" ||
      result.category !== "MANUSCRIPT_RESULT" || !result.target.entityId ||
      result.target.manuscriptChannel !== expectedChannel || !result.authorizationId ||
      !result.confirmedPayloadFingerprint
    ) {
      return {
        kind: "no_effect_failure",
        code: channelCode(expectedChannel, "OPERATION_BINDING_INVALID"),
        message: `The claimed Result has no exact Literature/${expectedChannel} authorization binding.`
      };
    }
    const normalizedBody = input.normalizedPayload.body as string;
    const serializedRaw = serializeBody(normalizedBody);
    const serializedRawFingerprint = await sha256SaveAsRaw(serializedRaw);
    const operationId = operationRequestKey(result.id, result.authorizationId, expectedChannel);
    let prior: SaveAsOperationRecord | null;
    try {
      prior = await dependencies.readOperation(operationId);
    } catch (error) {
      return {
        kind: "pending",
        code: channelCode(expectedChannel, "OPERATION_READBACK_UNKNOWN"),
        message: error instanceof Error ? error.message : "The canonical operation readback is unavailable."
      };
    }
    if (prior) {
      if (!operationIdentityMatches(
        prior,
        result.target.entityId,
        operationId,
        serializedRawFingerprint,
        expectedChannel
      )) {
        return {
          kind: "pending",
          code: channelCode(expectedChannel, "OPERATION_IDENTITY_CONFLICT"),
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
          code: prior.blockingCode ?? channelCode(expectedChannel, "ZERO_EFFECT"),
          message: `The canonical ${policy.label} operation closed before D1 with authoritative zero effect.`
        };
      }
      return pendingOrReceipt({
        result,
        normalizedBody,
        serializedRawFingerprint,
        operation: prior,
        allowSameOperationRecovery: input.invocationMode === "continuation",
        expectedManuscriptChannel: expectedChannel
      });
    }
    if (input.invocationMode === "continuation") {
      return {
        kind: "no_effect_failure",
        code: channelCode(expectedChannel, "OPERATION_NOT_STARTED"),
        message: "The deterministic pre-effect operation record is absent, proving zero formal manuscript effect."
      };
    }
    const freshValidation = await validate({
      target: result.target,
      source: result.source,
      payload: input.normalizedPayload,
      expectedProjectId: result.target.projectId,
      expectedTargetSnapshotFingerprint: result.targetSnapshotFingerprint,
      expectedManuscriptChannel: expectedChannel
    });
    if (!freshValidation.executable) {
      await release(result.id);
      const blocking = freshValidation.validationIssues[0];
      return {
        kind: "no_effect_failure",
        code: blocking?.code ?? channelCode(expectedChannel, "TARGET_STALE"),
        message: blocking?.message ??
          "The Literature owner or either manuscript Binding changed after review; no effect was invoked."
      };
    }
    const prepared = preparedByResult.get(result.id);
    if (
      !prepared || prepared.channel !== expectedChannel ||
      prepared.authorizationId !== result.authorizationId ||
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
        code: channelCode(expectedChannel, "TARGET_ACCEPTANCE_MISSING"),
        message: `The exact latest BODY has no prior LP12 ${policy.label} target acceptance; no formal effect was invoked.`
      };
    }
    let baseline: PreservationBaseline;
    try {
      baseline = await preservationBaseline(result.target.entityId, expectedChannel);
    } catch (error) {
      return {
        kind: "no_effect_failure",
        code: error instanceof AILiteratureOutlineManuscriptTargetAcceptanceError
          ? error.code
          : channelCode(expectedChannel, "BASELINE_UNAVAILABLE"),
        message: error instanceof Error ? error.message : "The fresh dual-channel preservation baseline is unavailable."
      };
    }
    preservationByOperation.set(operationId, baseline);
    preparedByResult.delete(result.id);
    let saved: Awaited<ReturnType<typeof dependencies.saveAs>>;
    try {
      saved = await dependencies.saveAs({
        literatureId: result.target.entityId,
        manuscriptChannel: expectedChannel,
        sourceSessionKey: prepared.sourceSessionKey,
        sourceWindowRole: "independent",
        pickerTitle: `Choose a managed file for the new ${policy.label} manuscript`,
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
            allowSameOperationRecovery: false,
            expectedManuscriptChannel: expectedChannel
          })
        : {
            kind: "pending",
            code: channelCode(expectedChannel, "EFFECT_UNKNOWN"),
            message: error instanceof Error ? error.message : `The canonical ${policy.label} Save As outcome is unknown.`
          };
    }
    dependencies.discardCanonicalTarget(prepared.targetAcceptanceId);
    await closeSession(prepared.sourceSessionKey);
    if (saved.status === "success") {
      await closeSession(saved.independentSessionKey);
      const operation = await dependencies.readOperation(operationId);
      if (
        !operation || saved.operationId !== operationId ||
        saved.fileRefId !== operation.targetFileRefId ||
        operation.targetPathIdentityKey !== prepared.targetPathIdentityKey
      ) {
        return {
          kind: "pending",
          code: channelCode(expectedChannel, "OPERATION_READBACK_MISSING"),
          message: `The canonical ${policy.label} Save As success has no exact operation/FileRef/accepted-target readback.`
        };
      }
      return pendingOrReceipt({
        result,
        normalizedBody,
        serializedRawFingerprint,
        operation,
        baseline,
        allowSameOperationRecovery: false,
        expectedManuscriptChannel: expectedChannel
      });
    }
    if (saved.status === "canceled") {
      preservationByOperation.delete(operationId);
      return {
        kind: "no_effect_failure",
        code: channelCode(expectedChannel, "TARGET_ACCEPTANCE_CANCELED"),
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
        allowSameOperationRecovery: false,
        expectedManuscriptChannel: expectedChannel
      });
    }
    if (saved.status === "error") preservationByOperation.delete(operationId);
    return {
      kind: saved.status === "error" ? "no_effect_failure" : "pending",
      code: "error" in saved
        ? saved.error.code
        : channelCode(expectedChannel, "EFFECT_UNKNOWN"),
      message: saved.status === "error"
        ? `The canonical ${policy.label} Save As service proved zero effect before D1.`
        : `The canonical ${policy.label} Save As effect remains unknown and cannot be redispatched.`
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

export const aiLiteratureManuscriptStandardResultAdapter =
  createAILiteratureOutlineManuscriptStandardResultAdapter();

export function validateAILiteratureOutlineManuscriptStandardResultProposal(input: {
  target: AIStandardResultTarget;
  source?: AIParseDraftSourceSnapshot;
  payload: unknown;
  expectedProjectId: string;
  expectedTargetSnapshotFingerprint?: string;
}) {
  return aiLiteratureManuscriptStandardResultAdapter.validate({
    ...input,
    expectedManuscriptChannel: "literature_outline"
  });
}

export function validateAILiteratureDedicatedNotesManuscriptStandardResultProposal(input: {
  target: AIStandardResultTarget;
  source?: AIParseDraftSourceSnapshot;
  payload: unknown;
  expectedProjectId: string;
  expectedTargetSnapshotFingerprint?: string;
}) {
  return aiLiteratureManuscriptStandardResultAdapter.validate({
    ...input,
    expectedManuscriptChannel: "dedicated_notes"
  });
}

export function prepareAILiteratureOutlineManuscriptTargetAcceptance(input: {
  result: AIStandardResult;
  normalizedPayload: Record<string, unknown>;
  plannedAuthorizationId: string;
}) {
  return aiLiteratureManuscriptStandardResultAdapter.prepareTargetAcceptance({
    ...input,
    expectedManuscriptChannel: "literature_outline"
  });
}

export function prepareAILiteratureDedicatedNotesManuscriptTargetAcceptance(input: {
  result: AIStandardResult;
  normalizedPayload: Record<string, unknown>;
  plannedAuthorizationId: string;
}) {
  return aiLiteratureManuscriptStandardResultAdapter.prepareTargetAcceptance({
    ...input,
    expectedManuscriptChannel: "dedicated_notes"
  });
}

export function getPreparedAILiteratureManuscriptAuthorizationId(
  result: AIStandardResult
) {
  return aiLiteratureManuscriptStandardResultAdapter.preparedAuthorizationId(result);
}

export function releaseAILiteratureManuscriptTargetAcceptance(resultId: string) {
  return aiLiteratureManuscriptStandardResultAdapter.release(resultId);
}

const LITERATURE_MANUSCRIPT_STRUCTURAL_CODES = new Set([
  "LITERATURE_OUTLINE_MANUSCRIPT_OWNER_UNAVAILABLE",
  "LITERATURE_OUTLINE_MANUSCRIPT_ASSOCIATION_STALE",
  "LITERATURE_OUTLINE_MANUSCRIPT_LIFECYCLE_INELIGIBLE",
  "LITERATURE_OUTLINE_MANUSCRIPT_BINDING_CONFLICT",
  "LITERATURE_OUTLINE_MANUSCRIPT_BINDING_UNAVAILABLE",
  "LITERATURE_OUTLINE_MANUSCRIPT_BINDING_INCOMPLETE",
  "LITERATURE_OUTLINE_MANUSCRIPT_BINDING_IDENTITY_DRIFT",
  "LITERATURE_OUTLINE_MANUSCRIPT_TARGET_STALE",
  "LITERATURE_DEDICATED_NOTES_MANUSCRIPT_OWNER_UNAVAILABLE",
  "LITERATURE_DEDICATED_NOTES_MANUSCRIPT_ASSOCIATION_STALE",
  "LITERATURE_DEDICATED_NOTES_MANUSCRIPT_LIFECYCLE_INELIGIBLE",
  "LITERATURE_DEDICATED_NOTES_MANUSCRIPT_BINDING_CONFLICT",
  "LITERATURE_DEDICATED_NOTES_MANUSCRIPT_BINDING_UNAVAILABLE",
  "LITERATURE_DEDICATED_NOTES_MANUSCRIPT_BINDING_INCOMPLETE",
  "LITERATURE_DEDICATED_NOTES_MANUSCRIPT_BINDING_IDENTITY_DRIFT",
  "LITERATURE_DEDICATED_NOTES_MANUSCRIPT_TARGET_STALE"
]);

export function literatureManuscriptValidationHasStructuralDrift(
  validation: { validationIssues: Array<{ code: string }> }
) {
  return validation.validationIssues.some((candidate) =>
    LITERATURE_MANUSCRIPT_STRUCTURAL_CODES.has(candidate.code)
  );
}

export function invokeAILiteratureOutlineManuscriptStandardResultEffect(input: {
  result: AIStandardResult;
  normalizedPayload: Record<string, unknown>;
  invocationMode: "initial" | "continuation";
}) {
  return aiLiteratureManuscriptStandardResultAdapter.invoke({
    ...input,
    expectedManuscriptChannel: "literature_outline"
  });
}

export function invokeAILiteratureDedicatedNotesManuscriptStandardResultEffect(input: {
  result: AIStandardResult;
  normalizedPayload: Record<string, unknown>;
  invocationMode: "initial" | "continuation";
}) {
  return aiLiteratureManuscriptStandardResultAdapter.invoke({
    ...input,
    expectedManuscriptChannel: "dedicated_notes"
  });
}
