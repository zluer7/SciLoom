import type {
  AIConversationReadback,
  FileRef,
  FileRefOwnerType,
  ManuscriptBinding,
  ManuscriptChannel
} from "../types";
import type {
  AIStandardResult,
  AIStandardResultEffectReceipt,
  AIStandardResultManuscriptEffect
} from "../types/aiStandardResult";
import type {
  SaveCandidateManuscriptInput,
  StandardOperationCandidateAuthorization
} from "../types/candidateManuscript";
import { aiConversationRepository } from "../repositories/aiConversationRepository";
import { candidateManuscriptService } from "./candidateManuscriptService";
import { fileRefService } from "./fileRefService";
import { createPathIdentityKey } from "./fileRefIdentity";
import { buildLiteratureManuscriptView } from "./literatureManuscriptAdapterService";
import { parseLabPodMarkdownDocument } from "./labPodMarkdownDocumentService";
import { manuscriptBindingService } from "./manuscriptBindingService";
import { manuscriptIoService } from "./manuscriptIoService";
import {
  MANUSCRIPT_SEGMENT_PRODUCT_CHANNELS
} from "./manuscriptSegmentProductActivation";
import {
  canonicalAIStandardResultFingerprint,
  internalAIStandardResultManuscriptEffectId,
  readAIStandardResultManuscriptEffects
} from "./aiStandardResultService";

export const STANDARD_OPERATION_CANDIDATE_APPLICATION_SEAM =
  "candidateManuscriptService.saveCandidate" as const;

export type StandardOperationCandidateApplicationOutcome =
  | { kind: "settled"; receipt: AIStandardResultEffectReceipt }
  | { kind: "no_effect_failure"; code: string; message: string }
  | {
      kind: "terminal_effect_outcome_unknown";
      code: "TERMINAL_EFFECT_OUTCOME_UNKNOWN";
      message: string;
      candidateFileRefId?: string;
    };

export interface StandardOperationCandidateApplicationInput {
  parent: AIStandardResult;
  effect: AIStandardResultManuscriptEffect;
  effectResultId: string;
  ownerId: string;
  businessReceipt?: AIStandardResultEffectReceipt;
}

type ReadManuscript = typeof manuscriptIoService.readManuscriptByFileRef;

export interface StandardOperationCandidateApplicationDependencies {
  readConversation(conversationId: string): Promise<AIConversationReadback>;
  getBinding(
    ownerType: FileRefOwnerType,
    ownerId: string,
    channel: ManuscriptChannel
  ): Promise<ManuscriptBinding | undefined>;
  getFileRef(id: string): Promise<FileRef | undefined>;
  getCandidates(
    ownerType: FileRefOwnerType,
    ownerId: string,
    requestId: string
  ): Promise<FileRef[]>;
  readManuscript: ReadManuscript;
  saveCandidate(input: SaveCandidateManuscriptInput): ReturnType<typeof candidateManuscriptService.saveCandidate>;
  buildLiteratureView: typeof buildLiteratureManuscriptView;
}

const DEFAULT_DEPENDENCIES: StandardOperationCandidateApplicationDependencies = {
  readConversation: aiConversationRepository.readConversation,
  getBinding: manuscriptBindingService.getBindingByOwner,
  getFileRef: fileRefService.getById,
  getCandidates: fileRefService.getCandidateFileRefsByRequestId,
  readManuscript: manuscriptIoService.readManuscriptByFileRef,
  saveCandidate: candidateManuscriptService.saveCandidate,
  buildLiteratureView: buildLiteratureManuscriptView
};

type ProtectedFileState = {
  id: string;
  path: string;
  pathIdentityKey: string;
  content: string;
  encoding: "utf-8";
  sizeBytes: number;
};

type ProtectedBindingState = {
  binding: ManuscriptBinding;
  folder: FileRef;
  current: ProtectedFileState;
  defaultManuscript: ProtectedFileState;
};

type AuthorizedStandardOperationCandidate = {
  parent: AIStandardResult;
  effect: AIStandardResultManuscriptEffect;
  effectResultId: string;
  ownerType: FileRefOwnerType;
  ownerId: string;
  channel: ManuscriptChannel;
  authorization: StandardOperationCandidateAuthorization;
};

type StandardOperationCandidateSaveInput = SaveCandidateManuscriptInput & {
  authorization: StandardOperationCandidateAuthorization;
};

/** Runtime workflow boundary: Quick authorization cannot be re-labeled here. */
export async function saveStandardOperationCandidateThroughSharedPort(
  input: StandardOperationCandidateSaveInput,
  save: StandardOperationCandidateApplicationDependencies["saveCandidate"] =
    candidateManuscriptService.saveCandidate
) {
  if ((input.authorization as { source: string }).source !==
    "DERIVED_FROM_STANDARD_OPERATION_CONFIRMATION") {
    throw new Error("STANDARD_OPERATION_CANDIDATE_AUTHORIZATION_SOURCE_INVALID");
  }
  return save(input);
}

function exactRecord(left: unknown, right: unknown) {
  return canonicalAIStandardResultFingerprint(left) === canonicalAIStandardResultFingerprint(right);
}

function exactBindingProjection(binding: ManuscriptBinding) {
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

function fail(code: string, message: string): StandardOperationCandidateApplicationOutcome {
  return { kind: "no_effect_failure", code, message };
}

function exactOwnerChannel(
  module: string,
  entityType: string,
  channel: string
): { ownerType: FileRefOwnerType; channel: ManuscriptChannel } | undefined {
  if (module !== entityType) return undefined;
  const row = MANUSCRIPT_SEGMENT_PRODUCT_CHANNELS.find((candidate) =>
    candidate.ownerType === module && candidate.channel === channel
  );
  return row
    ? { ownerType: row.ownerType, channel: row.channel }
    : undefined;
}

function sameDurableParent(left: AIStandardResult, right: AIStandardResult) {
  return left.id === right.id &&
    left.conversationId === right.conversationId &&
    left.parseCallAttemptId === right.parseCallAttemptId &&
    left.category === right.category &&
    left.action === right.action &&
    exactRecord(left.target, right.target) &&
    left.authorizationId === right.authorizationId &&
    left.confirmationStartedAt === right.confirmationStartedAt &&
    left.confirmedPayloadFingerprint === right.confirmedPayloadFingerprint &&
    exactRecord(left.confirmedPayload, right.confirmedPayload);
}

export async function authorizeStandardOperationCandidateEffect(
  input: StandardOperationCandidateApplicationInput,
  dependencies: StandardOperationCandidateApplicationDependencies = DEFAULT_DEPENDENCIES
): Promise<
  | { status: "authorized"; value: AuthorizedStandardOperationCandidate }
  | { status: "rejected"; code: string; message: string }
> {
  let readback: AIConversationReadback;
  try {
    readback = await dependencies.readConversation(input.parent.conversationId);
  } catch (error) {
    return {
      status: "rejected",
      code: "STANDARD_OPERATION_CONFIRMATION_READBACK_UNAVAILABLE",
      message: error instanceof Error ? error.message : "Durable Standard Result readback is unavailable."
    };
  }
  const durableMatches = readback.standardResults.filter((candidate) => candidate.id === input.parent.id);
  const durable = durableMatches.length === 1 ? durableMatches[0] : undefined;
  const parseAttempt = readback.callAttempts.find((candidate) => candidate.id === input.parent.parseCallAttemptId);
  if (
    !durable || !sameDurableParent(input.parent, durable) ||
    durable.disposition !== "PENDING" || durable.category !== "DATA_OPERATION" ||
    (durable.action !== "CREATE" && durable.action !== "UPDATE") ||
    !durable.confirmationStartedAt || !durable.authorizationId ||
    !durable.confirmedPayload || !durable.confirmedPayloadFingerprint ||
    canonicalAIStandardResultFingerprint(durable.confirmedPayload) !== durable.confirmedPayloadFingerprint ||
    !parseAttempt || parseAttempt.conversationId !== durable.conversationId ||
    parseAttempt.purpose !== "parse_draft" || parseAttempt.status !== "succeeded"
  ) {
    return {
      status: "rejected",
      code: "STANDARD_OPERATION_CONFIRMATION_NOT_EXACT",
      message: "Candidate creation requires one exact current durable Standard Result confirmation and Parse provenance."
    };
  }
  const identity = exactOwnerChannel(
    durable.target.module,
    durable.target.entityType,
    input.effect.channel
  );
  if (!identity) {
    return {
      status: "rejected",
      code: "STANDARD_OPERATION_OWNER_CHANNEL_INELIGIBLE",
      message: "The confirmed parent owner/channel is not one canonical managed-manuscript row."
    };
  }
  const confirmedEffects = readAIStandardResultManuscriptEffects(durable.confirmedPayload, {
    action: durable.action,
    target: durable.target
  });
  const confirmedEffect = confirmedEffects.find((candidate) => candidate.channel === input.effect.channel);
  const expectedEffectResultId = internalAIStandardResultManuscriptEffectId(
    durable.id,
    input.effect.channel
  );
  if (
    !confirmedEffect || !exactRecord(confirmedEffect, input.effect) ||
    input.effectResultId !== expectedEffectResultId
  ) {
    return {
      status: "rejected",
      code: "STANDARD_OPERATION_PARENT_EFFECT_IDENTITY_MISMATCH",
      message: "The requested effect is not the exact confirmed nested effect of this parent."
    };
  }
  if (durable.action === "CREATE") {
    const receipt = input.businessReceipt;
    if (
      !receipt || receipt.operation !== "CREATE" || receipt.module !== identity.ownerType ||
      receipt.entityType !== identity.ownerType || receipt.entityId !== input.ownerId
    ) {
      return {
        status: "rejected",
        code: "STANDARD_OPERATION_CREATE_RECEIPT_OWNER_REQUIRED",
        message: "CREATE candidate publication requires the exact canonical business receipt owner."
      };
    }
  } else if (
    durable.target.entityId !== input.ownerId ||
    !durable.targetSnapshotFingerprint
  ) {
    return {
      status: "rejected",
      code: "STANDARD_OPERATION_UPDATE_OWNER_PROVENANCE_REQUIRED",
      message: "UPDATE candidate publication requires the exact existing target and current admitted provenance."
    };
  }
  const authorization: StandardOperationCandidateAuthorization = durable.action === "CREATE"
    ? {
        source: "DERIVED_FROM_STANDARD_OPERATION_CONFIRMATION",
        conversationId: durable.conversationId,
        parseCallAttemptId: durable.parseCallAttemptId,
        parentResultId: durable.id,
        effectResultId: expectedEffectResultId,
        authorizationId: durable.authorizationId,
        confirmedPayloadFingerprint: durable.confirmedPayloadFingerprint,
        parentAction: "CREATE",
        ownerType: identity.ownerType,
        ownerId: input.ownerId,
        manuscriptChannel: identity.channel,
        businessReceiptEntityId: input.ownerId
      }
    : {
        source: "DERIVED_FROM_STANDARD_OPERATION_CONFIRMATION",
        conversationId: durable.conversationId,
        parseCallAttemptId: durable.parseCallAttemptId,
        parentResultId: durable.id,
        effectResultId: expectedEffectResultId,
        authorizationId: durable.authorizationId,
        confirmedPayloadFingerprint: durable.confirmedPayloadFingerprint,
        parentAction: "UPDATE",
        ownerType: identity.ownerType,
        ownerId: input.ownerId,
        manuscriptChannel: identity.channel,
        targetSnapshotFingerprint: durable.targetSnapshotFingerprint!
      };
  return {
    status: "authorized",
    value: {
      parent: durable,
      effect: confirmedEffect,
      effectResultId: expectedEffectResultId,
      ownerType: identity.ownerType,
      ownerId: input.ownerId,
      channel: identity.channel,
      authorization
    }
  };
}

async function readProtectedFile(
  authorized: AuthorizedStandardOperationCandidate,
  fileRefId: string,
  dependencies: StandardOperationCandidateApplicationDependencies
): Promise<ProtectedFileState | undefined> {
  const fileRef = await dependencies.getFileRef(fileRefId);
  if (
    !fileRef || fileRef.deletedAt || fileRef.ownerType !== authorized.ownerType ||
    fileRef.ownerId !== authorized.ownerId ||
    fileRef.manuscriptChannel !== authorized.channel ||
    fileRef.resourceKind !== "file" || fileRef.fileRole !== "manuscript"
  ) return undefined;
  const physical = await dependencies.readManuscript(
    authorized.ownerType,
    authorized.ownerId,
    fileRef.id,
    { manuscriptChannel: authorized.channel }
  );
  if (
    physical.status !== "success" ||
    createPathIdentityKey(physical.path) !== fileRef.pathIdentityKey
  ) return undefined;
  return {
    id: fileRef.id,
    path: fileRef.path,
    pathIdentityKey: fileRef.pathIdentityKey,
    content: physical.content,
    encoding: physical.encoding,
    sizeBytes: physical.sizeBytes
  };
}

async function readProtectedBindingState(
  authorized: AuthorizedStandardOperationCandidate,
  dependencies: StandardOperationCandidateApplicationDependencies
): Promise<ProtectedBindingState | undefined> {
  const binding = await dependencies.getBinding(
    authorized.ownerType,
    authorized.ownerId,
    authorized.channel
  );
  if (
    !binding || binding.ownerType !== authorized.ownerType ||
    binding.ownerId !== authorized.ownerId ||
    binding.manuscriptChannel !== authorized.channel ||
    !binding.defaultFolderFileRefId || !binding.defaultManuscriptFileRefId ||
    !binding.currentFileRefId
  ) return undefined;
  const folder = await dependencies.getFileRef(binding.defaultFolderFileRefId);
  if (
    !folder || folder.deletedAt || folder.ownerType !== authorized.ownerType ||
    folder.ownerId !== authorized.ownerId || folder.resourceKind !== "folder" ||
    folder.fileRole !== "defaultFolder" || folder.locationMode !== "managed"
  ) return undefined;
  const [current, defaultManuscript] = await Promise.all([
    readProtectedFile(authorized, binding.currentFileRefId, dependencies),
    readProtectedFile(authorized, binding.defaultManuscriptFileRefId, dependencies)
  ]);
  return current && defaultManuscript
    ? { binding, folder, current, defaultManuscript }
    : undefined;
}

function protectedStatePreserved(
  before: ProtectedBindingState,
  after: ProtectedBindingState
) {
  return exactRecord(
    exactBindingProjection(before.binding),
    exactBindingProjection(after.binding)
  ) && exactRecord(before.current, after.current) &&
    exactRecord(before.defaultManuscript, after.defaultManuscript) &&
    before.folder.id === after.folder.id &&
    before.folder.path === after.folder.path &&
    before.folder.pathIdentityKey === after.folder.pathIdentityKey;
}

async function settledCandidateReceipt(
  authorized: AuthorizedStandardOperationCandidate,
  baseline: ProtectedBindingState,
  candidate: FileRef,
  dependencies: StandardOperationCandidateApplicationDependencies
): Promise<StandardOperationCandidateApplicationOutcome> {
  const [physical, after] = await Promise.all([
    dependencies.readManuscript(
      authorized.ownerType,
      authorized.ownerId,
      candidate.id,
      { manuscriptChannel: authorized.channel }
    ),
    readProtectedBindingState(authorized, dependencies)
  ]);
  const parsed = physical.status === "success"
    ? parseLabPodMarkdownDocument(physical.content)
    : undefined;
  const candidateParentPathIdentity = candidate.pathIdentityKey.replace(/[\\/][^\\/]+$/u, "");
  const candidateDistinct =
    candidate.id !== baseline.current.id &&
    candidate.id !== baseline.defaultManuscript.id &&
    candidate.pathIdentityKey !== baseline.current.pathIdentityKey &&
    candidate.pathIdentityKey !== baseline.defaultManuscript.pathIdentityKey;
  const readbackConfirmed =
    candidate.ownerType === authorized.ownerType && candidate.ownerId === authorized.ownerId &&
    candidate.manuscriptChannel === authorized.channel && candidate.resourceKind === "file" &&
    candidate.fileRole === "manuscript" && candidate.locationMode === "managed" &&
    candidate.candidateRequestId === authorized.effectResultId &&
    candidate.candidateOccurredAt === authorized.parent.confirmationStartedAt &&
    candidateParentPathIdentity === baseline.folder.pathIdentityKey &&
    createPathIdentityKey(candidate.path) === candidate.pathIdentityKey &&
    physical.status === "success" &&
    createPathIdentityKey(physical.path) === candidate.pathIdentityKey &&
    physical.encoding === "utf-8" && parsed &&
    (parsed.status === "valid" || parsed.status === "valid-empty") &&
    parsed.body === authorized.effect.body && candidateDistinct && Boolean(after) &&
    protectedStatePreserved(baseline, after!);
  if (!readbackConfirmed) {
    return {
      kind: "terminal_effect_outcome_unknown",
      code: "TERMINAL_EFFECT_OUTCOME_UNKNOWN",
      message: "Candidate FileRef, physical body, or exact current/default protection readback is incomplete.",
      candidateFileRefId: candidate.id
    };
  }
  return {
    kind: "settled",
    receipt: {
      module: authorized.ownerType,
      entityType: "fileRef",
      entityId: candidate.id,
      operation: "NEW_MANUSCRIPT",
      service: STANDARD_OPERATION_CANDIDATE_APPLICATION_SEAM,
      canonicalReadback: {
        projectId: authorized.parent.target.projectId,
        parentAction: authorized.parent.action,
        parentResultId: authorized.parent.id,
        effectResultId: authorized.effectResultId,
        parseCallAttemptId: authorized.parent.parseCallAttemptId,
        authorizationId: authorized.parent.authorizationId,
        authorizationSource: authorized.authorization.source,
        ownerType: authorized.ownerType,
        ownerId: authorized.ownerId,
        manuscriptChannel: authorized.channel,
        candidateRequestId: authorized.effectResultId,
        candidateFileRefId: candidate.id,
        candidatePath: candidate.path,
        candidatePathIdentityKey: candidate.pathIdentityKey,
        candidateDirectoryPathIdentityKey: candidateParentPathIdentity,
        defaultFolderFileRefId: baseline.folder.id,
        bindingBefore: exactBindingProjection(baseline.binding),
        bindingAfter: exactBindingProjection(after!.binding),
        currentFileRefIdBefore: baseline.current.id,
        currentFileRefIdAfter: after!.current.id,
        defaultManuscriptFileRefIdBefore: baseline.defaultManuscript.id,
        defaultManuscriptFileRefIdAfter: after!.defaultManuscript.id,
        currentPathBefore: baseline.current.path,
        currentPathAfter: after!.current.path,
        defaultPathBefore: baseline.defaultManuscript.path,
        defaultPathAfter: after!.defaultManuscript.path,
        currentExactBytesPreserved: true,
        defaultExactBytesPreserved: true,
        bindingPreserved: true,
        candidateDistinctFromCurrentAndDefault: true,
        currentChanged: false,
        defaultChanged: false,
        formalSwitchInvoked: false,
        confirmedBodyFingerprint: canonicalAIStandardResultFingerprint(authorized.effect.body),
        physicalBodyFingerprint: canonicalAIStandardResultFingerprint(parsed!.body),
        physicalEncoding: physical.encoding,
        physicalSizeBytes: physical.sizeBytes,
        bodyNormalization: "CRLF_TO_LF_AT_STANDARD_RESULT_ADMISSION",
        terminalCommitState: "POST_PUBLISH_FILE_REF_PHYSICAL_AND_PROTECTED_BYTES_CONFIRMED"
      }
    }
  };
}

/** Settlement-only continuation probe. It never invokes the shared writer. */
export async function readStandardOperationCandidateEffect(
  input: StandardOperationCandidateApplicationInput,
  dependencies: StandardOperationCandidateApplicationDependencies = DEFAULT_DEPENDENCIES
): Promise<StandardOperationCandidateApplicationOutcome> {
  const admission = await authorizeStandardOperationCandidateEffect(input, dependencies);
  if (admission.status === "rejected") return fail(admission.code, admission.message);
  const authorized = admission.value;
  const baseline = await readProtectedBindingState(authorized, dependencies);
  if (!baseline) {
    return {
      kind: "terminal_effect_outcome_unknown",
      code: "TERMINAL_EFFECT_OUTCOME_UNKNOWN",
      message: "The protected owner/channel baseline is unavailable during settlement-only readback."
    };
  }
  const candidates = await dependencies.getCandidates(
    authorized.ownerType,
    authorized.ownerId,
    authorized.effectResultId
  ).catch(() => undefined);
  const active = candidates?.filter((candidate) => !candidate.deletedAt);
  if (!active || active.length !== 1) {
    return {
      kind: "terminal_effect_outcome_unknown",
      code: "TERMINAL_EFFECT_OUTCOME_UNKNOWN",
      message: "Settlement-only readback requires exactly one authoritative active candidate."
    };
  }
  return settledCandidateReceipt(authorized, baseline, active[0], dependencies);
}

async function literatureCandidateDescriptors(
  authorized: AuthorizedStandardOperationCandidate,
  baseline: ProtectedBindingState,
  dependencies: StandardOperationCandidateApplicationDependencies
) {
  if (authorized.ownerType !== "literature") {
    return { status: "success" as const, metaSnapshot: "", outline: "" };
  }
  const channel = authorized.channel === "literature_outline" ||
    authorized.channel === "dedicated_notes"
    ? authorized.channel
    : undefined;
  if (!channel) return { status: "error" as const, message: "Literature channel is invalid." };
  const view = await dependencies.buildLiteratureView(
    authorized.ownerId,
    channel,
    baseline.current.content
  );
  return view.status === "success"
    ? {
        status: "success" as const,
        metaSnapshot: view.blocks.metaSnapshot,
        outline: view.blocks.outline
      }
    : { status: "error" as const, message: view.error.message };
}

export async function applyStandardOperationCandidateEffect(
  input: StandardOperationCandidateApplicationInput,
  dependencies: StandardOperationCandidateApplicationDependencies = DEFAULT_DEPENDENCIES
): Promise<StandardOperationCandidateApplicationOutcome> {
  const admission = await authorizeStandardOperationCandidateEffect(input, dependencies);
  if (admission.status === "rejected") {
    return fail(admission.code, admission.message);
  }
  const authorized = admission.value;
  const baseline = await readProtectedBindingState(authorized, dependencies);
  if (!baseline) {
    return fail(
      "STANDARD_OPERATION_PROVISIONING_BINDING_INCOMPLETE",
      "The exact owner/channel Provisioning, Binding, current, or default physical baseline is incomplete."
    );
  }
  const descriptors = await literatureCandidateDescriptors(authorized, baseline, dependencies);
  if (descriptors.status === "error") {
    return fail("STANDARD_OPERATION_LITERATURE_DESCRIPTOR_UNAVAILABLE", descriptors.message);
  }
  let saved: Awaited<ReturnType<typeof candidateManuscriptService.saveCandidate>>;
  try {
    saved = await saveStandardOperationCandidateThroughSharedPort({
      ownerType: authorized.ownerType,
      ownerId: authorized.ownerId,
      manuscriptChannel: authorized.channel,
      requestId: authorized.effectResultId,
      occurredAt: authorized.parent.confirmationStartedAt!,
      candidateTitle: "Standard Operation candidate",
      source: "ai",
      authorization: authorized.authorization,
      frozenWorkspace: {
        folderFileRefId: baseline.folder.id,
        directoryPathIdentityKey: baseline.folder.pathIdentityKey
      },
      metaSnapshot: descriptors.metaSnapshot,
      outline: descriptors.outline,
      body: authorized.effect.body,
      requestToken: 0
    }, dependencies.saveCandidate);
  } catch {
    const uncertain = await dependencies.getCandidates(
      authorized.ownerType,
      authorized.ownerId,
      authorized.effectResultId
    ).catch(() => undefined);
    return {
      kind: "terminal_effect_outcome_unknown",
      code: "TERMINAL_EFFECT_OUTCOME_UNKNOWN",
      message: "The shared candidate writer completion is uncertain; automatic create retry is forbidden.",
      ...(uncertain?.filter((candidate) => !candidate.deletedAt).length === 1
        ? { candidateFileRefId: uncertain.filter((candidate) => !candidate.deletedAt)[0].id }
        : {})
    };
  }
  const candidates = await dependencies.getCandidates(
    authorized.ownerType,
    authorized.ownerId,
    authorized.effectResultId
  ).catch(() => undefined);
  if (!candidates) {
    return {
      kind: "terminal_effect_outcome_unknown",
      code: "TERMINAL_EFFECT_OUTCOME_UNKNOWN",
      message: "Candidate FileRef readback is unavailable after the shared writer boundary."
    };
  }
  const activeCandidates = candidates.filter((candidate) => !candidate.deletedAt);
  const provenNoEffect = activeCandidates.length === 0 &&
    !saved.createdFile && !saved.reusedFile &&
    !saved.completedSteps.includes("candidate-file") &&
    !saved.completedSteps.includes("filesystem-outcome-unknown") &&
    (saved.status === "error" || saved.status === "conflict");
  if (provenNoEffect) {
    return fail(
      "STANDARD_OPERATION_CANDIDATE_CREATE_FAILED",
      saved.errors.map((error) => error.message).join(" ") ||
        "The shared writer proved that no Candidate was created."
    );
  }
  const candidate = activeCandidates.length === 1 ? activeCandidates[0] : undefined;
  if (!candidate || (saved.status !== "success" && saved.status !== "skipped")) {
    return {
      kind: "terminal_effect_outcome_unknown",
      code: "TERMINAL_EFFECT_OUTCOME_UNKNOWN",
      message: "Candidate publication may have crossed the shared writer boundary.",
      ...(candidate ? { candidateFileRefId: candidate.id } : {})
    };
  }
  if (saved.fileRefId !== candidate.id) {
    return {
      kind: "terminal_effect_outcome_unknown",
      code: "TERMINAL_EFFECT_OUTCOME_UNKNOWN",
      message: "The shared writer result and authoritative candidate FileRef do not agree.",
      candidateFileRefId: candidate.id
    };
  }
  return settledCandidateReceipt(authorized, baseline, candidate, dependencies);
}

export function createStandardOperationCandidateApplicationService(
  overrides: Partial<StandardOperationCandidateApplicationDependencies> = {}
) {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  return {
    authorize(input: StandardOperationCandidateApplicationInput) {
      return authorizeStandardOperationCandidateEffect(input, dependencies);
    },
    apply(input: StandardOperationCandidateApplicationInput) {
      return applyStandardOperationCandidateEffect(input, dependencies);
    },
    read(input: StandardOperationCandidateApplicationInput) {
      return readStandardOperationCandidateEffect(input, dependencies);
    }
  };
}
