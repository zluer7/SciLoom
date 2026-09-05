import { translations, type Language } from "../i18n/translations";
import type { SharedManuscriptSession } from "../types/sharedManuscriptSession";
import { getSafeManuscriptBasename } from "./manuscriptSafeFilename";
import { buildSharedEditorTitle, type SharedEditorTitleIdentityEvidence } from "./sharedEditorTitleBuilder";
import {
  getChannelDisplayDescriptor,
  getOwnerDisplayDescriptor
} from "./sharedEditorTitleDescriptor";

export type SharedEditorTitlePresentationErrorReason =
  | "MISSING_PRESENTATION"
  | "UNKNOWN_OWNER"
  | "UNKNOWN_CHANNEL"
  | "STALE_PRESENTATION"
  | "INVALID_SAFE_FILENAME"
  | "INVALID_TITLE_INPUT";

export type SharedEditorTitlePresentationResult =
  | (ReturnType<typeof buildSharedEditorTitle> extends infer Result
      ? Exclude<Result, undefined> & { status: "resolved" }
      : never)
  | Readonly<{
      status: "error";
      reason: SharedEditorTitlePresentationErrorReason;
      identity?: SharedEditorTitleIdentityEvidence;
    }>;

function identityEvidence(
  session: SharedManuscriptSession,
  lifecycleHandle: string,
  presentationEpoch: number
): SharedEditorTitleIdentityEvidence {
  return Object.freeze({
    ownerType: session.logicalIdentity.ownerType,
    ownerId: session.logicalIdentity.ownerId,
    channel: session.logicalIdentity.channel,
    windowRole: session.logicalIdentity.windowRole,
    fileRefId: session.logicalIdentity.fileRefId,
    sessionKey: session.sessionKey,
    lifecycleHandle,
    presentationEpoch,
    sessionGeneration: session.sessionGeneration
  });
}

function tryIdentityEvidence(
  session: SharedManuscriptSession,
  lifecycleHandle: string,
  presentationEpoch: number
) {
  if (!session.logicalIdentity || typeof session.sessionKey !== "string") return undefined;
  return identityEvidence(session, lifecycleHandle, presentationEpoch);
}

function presentationIsInternallyConsistent(session: SharedManuscriptSession) {
  const logical = session.logicalIdentity;
  if (
    !logical ||
    !session.owner ||
    !session.file ||
    !session.targetSnapshot?.file ||
    typeof session.sessionKey !== "string"
  ) return false;
  const durableFileRefId = session.file.kind === "durable" ? session.file.fileRefId : undefined;
  return (
    session.key === session.sessionKey &&
    session.owner.ownerType === logical.ownerType &&
    session.owner.ownerId === logical.ownerId &&
    session.owner.channel === logical.channel &&
    session.windowRole === logical.windowRole &&
    durableFileRefId === logical.fileRefId &&
    session.targetSnapshot.file.pathIdentity === session.file.pathIdentity &&
    session.targetSnapshot.file.absolutePath === session.file.absolutePath &&
    !session.stale
  );
}

export function resolveSharedEditorTitlePresentation(input: {
  session: SharedManuscriptSession | undefined;
  lifecycleHandle: string;
  presentationEpoch: number;
  locale: Language;
  entityTitle?: string | null;
}): SharedEditorTitlePresentationResult {
  if (!input.session) {
    return Object.freeze({ status: "error", reason: "MISSING_PRESENTATION" });
  }
  const identity = tryIdentityEvidence(
    input.session,
    input.lifecycleHandle,
    input.presentationEpoch
  );
  if (!presentationIsInternallyConsistent(input.session) || !identity) {
    return Object.freeze({
      status: "error",
      reason: "STALE_PRESENTATION",
      ...(identity ? { identity } : {})
    });
  }

  const ownerDescriptor = getOwnerDisplayDescriptor(identity.ownerType);
  if (!ownerDescriptor) {
    return Object.freeze({ status: "error", reason: "UNKNOWN_OWNER", identity });
  }
  const channelDescriptor = getChannelDisplayDescriptor(identity.ownerType, identity.channel);
  if (identity.ownerType === "literature" && !channelDescriptor) {
    return Object.freeze({ status: "error", reason: "UNKNOWN_CHANNEL", identity });
  }
  const safeFilename = getSafeManuscriptBasename(input.session.file.absolutePath);
  if (!safeFilename) {
    return Object.freeze({ status: "error", reason: "INVALID_SAFE_FILENAME", identity });
  }

  const copy = translations[input.locale];
  const title = buildSharedEditorTitle({
    businessTypeLabel: copy[ownerDescriptor.formalDisplayKey],
    entityTitle: input.entityTitle,
    channelLabel: channelDescriptor
      ? copy[channelDescriptor.formalDisplayKey]
      : undefined,
    windowRole: identity.windowRole,
    fileLabel: safeFilename,
    currentRoleLabel: copy.sharedEditorCurrentRole,
    selectedRoleLabel: copy.sharedEditorSelectedRole,
    unnamedPrefix: copy.sharedEditorUnnamedPrefix,
    footerSeparator: copy.sharedEditorFooterSeparator,
    locale: input.locale,
    identity
  });
  if (!title) {
    return Object.freeze({ status: "error", reason: "INVALID_TITLE_INPUT", identity });
  }
  return Object.freeze({ status: "resolved", ...title });
}
