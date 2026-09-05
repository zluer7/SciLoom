import type {
  FileRef,
  Literature,
  ManuscriptBinding,
  ManuscriptChannel
} from "../types";
import type {
  ManuscriptWindowRole,
  SharedManuscriptSession,
  SharedManuscriptSessionHandle,
  SharedSessionRevalidation,
  SharedTargetSnapshot
} from "../types/sharedManuscriptSession";
import {
  assertValidManuscriptChannelForOwner
} from "../types/manuscriptChannel";
import { literatureRepository } from "../repositories/literatureRepository";
import { fileRefService, getSafeManuscriptBasename } from "./fileRefService";
import { managedRootConfigService } from "./managedRootConfigService";
import { manuscriptBindingService } from "./manuscriptBindingService";
import {
  sharedManuscriptIdentityResolver,
  sharedManuscriptSessionRuntime
} from "./sharedManuscriptSessionComposition";
import type { ManuscriptIdentityResolver } from "./manuscriptIdentityResolver";
import type { SharedManuscriptSessionRuntime } from "./sharedManuscriptSessionRuntime";
import { deriveMountedManuscriptLifecycleDecision } from "./fileRefOwnerValidator";

export type LiteratureManuscriptChannel =
  | "literature_outline"
  | "dedicated_notes";

export const LITERATURE_RAW_ERROR_CODES = {
  channelInvalid: "LITERATURE_MANUSCRIPT_CHANNEL_INVALID",
  ownerMissing: "LITERATURE_MANUSCRIPT_OWNER_MISSING",
  ownerDeleted: "LITERATURE_MANUSCRIPT_OWNER_DELETED",
  bindingMissing: "LITERATURE_MANUSCRIPT_BINDING_MISSING",
  bindingInvalid: "LITERATURE_MANUSCRIPT_BINDING_INVALID",
  currentMissing: "LITERATURE_MANUSCRIPT_CURRENT_MISSING",
  currentChanged: "LITERATURE_MANUSCRIPT_CURRENT_CHANGED",
  fileRefMissing: "LITERATURE_MANUSCRIPT_FILE_REF_MISSING",
  fileRefDeleted: "LITERATURE_MANUSCRIPT_FILE_REF_INACTIVE",
  fileRefInvalid: "LITERATURE_MANUSCRIPT_FILE_REF_INVALID",
  targetChanged: "LITERATURE_MANUSCRIPT_TARGET_MISMATCH",
  managedRootUnavailable: "LITERATURE_MANUSCRIPT_MANAGED_ROOT_UNAVAILABLE",
  sessionMissing: "LITERATURE_MANUSCRIPT_SESSION_MISSING",
  sessionChannelMismatch: "LITERATURE_MANUSCRIPT_SESSION_CHANNEL_MISMATCH",
  sessionRoleMismatch: "LITERATURE_MANUSCRIPT_SESSION_ROLE_MISMATCH",
  externalWriteConfirmationRequired:
    "LITERATURE_MANUSCRIPT_EXTERNAL_WRITE_CONFIRMATION_REQUIRED"
} as const;

type LiteratureRawErrorCode =
  (typeof LITERATURE_RAW_ERROR_CODES)[keyof typeof LITERATURE_RAW_ERROR_CODES];

export type LiteratureRawFailure = {
  status: "error";
  error: {
    code: LiteratureRawErrorCode;
    message: string;
    retryable: false;
    recoveryRequired: false;
  };
};

export interface LiteratureRawManuscriptDependencies {
  getLiterature(id: string): Promise<Literature | undefined>;
  getDeletedLiterature(id: string): Promise<Literature | undefined>;
  getBinding(
    ownerType: "literature",
    ownerId: string,
    channel: ManuscriptChannel
  ): Promise<ManuscriptBinding | undefined>;
  getFileRef(id: string): Promise<FileRef | undefined>;
  getDeletedFileRef(id: string): Promise<FileRef | undefined>;
  getManagedRoot(): ReturnType<typeof managedRootConfigService.getStatus>;
  identityResolver: ManuscriptIdentityResolver;
  runtime: SharedManuscriptSessionRuntime;
}

const defaultDependencies: LiteratureRawManuscriptDependencies = {
  getLiterature: literatureRepository.getById,
  getDeletedLiterature: literatureRepository.getDeletedById,
  getBinding: manuscriptBindingService.getBindingByOwner,
  getFileRef: fileRefService.getById,
  getDeletedFileRef: fileRefService.getDeletedById,
  getManagedRoot: () => managedRootConfigService.getStatus(),
  identityResolver: sharedManuscriptIdentityResolver,
  runtime: sharedManuscriptSessionRuntime
};

function failure(
  code: LiteratureRawErrorCode,
  message: string = code
): LiteratureRawFailure {
  return {
    status: "error",
    error: {
      code,
      message,
      retryable: false,
      recoveryRequired: false
    }
  };
}

function requireChannel(
  channel: ManuscriptChannel
): LiteratureManuscriptChannel | LiteratureRawFailure {
  try {
    return assertValidManuscriptChannelForOwner(
      "literature",
      channel
    ) as LiteratureManuscriptChannel;
  } catch {
    return failure(
      LITERATURE_RAW_ERROR_CODES.channelInvalid,
      "Literature requires the exact literature_outline or dedicated_notes channel."
    );
  }
}

function validBinding(
  binding: ManuscriptBinding | undefined,
  literatureId: string,
  channel: LiteratureManuscriptChannel
) {
  return Boolean(
    binding &&
      !binding.deletedAt &&
      binding.ownerType === "literature" &&
      binding.ownerId === literatureId &&
      binding.manuscriptChannel === channel
  );
}

function validFileRef(
  fileRef: FileRef,
  literatureId: string,
  channel: LiteratureManuscriptChannel
) {
  return (
    !fileRef.deletedAt &&
    fileRef.ownerType === "literature" &&
    fileRef.ownerId === literatureId &&
    fileRef.manuscriptChannel === channel &&
    fileRef.resourceKind === "file" &&
    fileRef.fileRole === "manuscript" &&
    (fileRef.locationMode === "managed" ||
      fileRef.locationMode === "external") &&
    Boolean(fileRef.pathIdentityKey) &&
    Boolean(getSafeManuscriptBasename(fileRef.path))
  );
}

export function createLiteratureRawManuscriptService(
  dependencies: LiteratureRawManuscriptDependencies = defaultDependencies
) {
  async function resolveOwner(
    literatureId: string,
    manuscriptChannel: LiteratureManuscriptChannel
  ) {
    const literature = await dependencies.getLiterature(literatureId);
    const deleted = literature
      ? undefined
      : await dependencies.getDeletedLiterature(literatureId);
    if (!literature && !deleted) {
      return failure(
        LITERATURE_RAW_ERROR_CODES.ownerMissing,
        "Literature does not exist."
      );
    }
    const lifecycle = deriveMountedManuscriptLifecycleDecision({
      ownerType: "literature",
      ownerId: literatureId,
      manuscriptChannel,
      ownerDeleted: Boolean(deleted)
    });
    return lifecycle.canRead && literature
      ? { status: "success" as const, literature }
      : failure(
          LITERATURE_RAW_ERROR_CODES.ownerDeleted,
          "Literature is deleted."
        );
  }

  async function resolveBinding(
    literatureId: string,
    requestedChannel: ManuscriptChannel
  ) {
    const channel = requireChannel(requestedChannel);
    if (typeof channel !== "string") return channel;
    const ownerResult = await resolveOwner(literatureId, channel);
    if (ownerResult.status !== "success") return ownerResult;
    const binding = await dependencies.getBinding(
      "literature",
      literatureId,
      channel
    );
    if (!binding) {
      return failure(
        LITERATURE_RAW_ERROR_CODES.bindingMissing,
        "Literature manuscript binding does not exist."
      );
    }
    if (!validBinding(binding, literatureId, channel)) {
      return failure(
        LITERATURE_RAW_ERROR_CODES.bindingInvalid,
        "Literature manuscript binding is invalid."
      );
    }
    for (const [bindingRole, boundFileRefId] of [
      ["current", binding.currentFileRefId],
      ["default", binding.defaultManuscriptFileRefId]
    ] as const) {
      if (!boundFileRefId) continue;
      const boundFileRef = await dependencies.getFileRef(boundFileRefId);
      if (!boundFileRef) {
        if (bindingRole === "current") {
          return failure(
            await dependencies.getDeletedFileRef(boundFileRefId)
              ? LITERATURE_RAW_ERROR_CODES.fileRefDeleted
              : LITERATURE_RAW_ERROR_CODES.fileRefMissing,
            "Literature current manuscript FileRef is unavailable."
          );
        }
        return failure(
          LITERATURE_RAW_ERROR_CODES.bindingInvalid,
          "Literature default manuscript FileRef is unavailable."
        );
      }
      if (!validFileRef(boundFileRef, literatureId, channel)) {
        return failure(
          bindingRole === "current"
            ? LITERATURE_RAW_ERROR_CODES.fileRefInvalid
            : LITERATURE_RAW_ERROR_CODES.bindingInvalid,
          `Literature ${bindingRole} manuscript FileRef is invalid or cross-channel.`
        );
      }
    }
    return {
      status: "success" as const,
      literature: ownerResult.literature,
      binding,
      channel
    };
  }

  async function resolveTarget(
    literatureId: string,
    requestedChannel: ManuscriptChannel,
    fileRefId: string,
    expectedCurrent: boolean
  ) {
    const resolvedBinding = await resolveBinding(
      literatureId,
      requestedChannel
    );
    if (resolvedBinding.status !== "success") return resolvedBinding;
    const { binding, channel, literature } = resolvedBinding;
    if (expectedCurrent && !binding.currentFileRefId) {
      return failure(
        LITERATURE_RAW_ERROR_CODES.currentMissing,
        "Literature current manuscript is not set."
      );
    }
    if (expectedCurrent && binding.currentFileRefId !== fileRefId) {
      return failure(
        LITERATURE_RAW_ERROR_CODES.currentChanged,
        "Literature current manuscript changed."
      );
    }
    const fileRef = await dependencies.getFileRef(fileRefId);
    if (!fileRef) {
      return failure(
        await dependencies.getDeletedFileRef(fileRefId)
          ? LITERATURE_RAW_ERROR_CODES.fileRefDeleted
          : LITERATURE_RAW_ERROR_CODES.fileRefMissing,
        "Literature manuscript FileRef is unavailable."
      );
    }
    if (!validFileRef(fileRef, literatureId, channel)) {
      return failure(
        LITERATURE_RAW_ERROR_CODES.fileRefInvalid,
        "Literature manuscript FileRef is invalid."
      );
    }
    let configuredRoot: string | undefined;
    if (fileRef.locationMode === "managed") {
      const root = await dependencies.getManagedRoot();
      if (root.status !== "configured" || !root.managedRoot) {
        return failure(
          LITERATURE_RAW_ERROR_CODES.managedRootUnavailable,
          "Managed root is unavailable."
        );
      }
      configuredRoot = root.managedRoot;
    }
    try {
      const owner = dependencies.identityResolver.resolveOwner({
        ownerType: "literature",
        ownerId: literatureId,
        channel
      });
      const file = dependencies.identityResolver.resolveDurableFile({
        fileRefId: fileRef.id,
        absolutePath: fileRef.path,
        pathIdentity: fileRef.pathIdentityKey,
        fileName: getSafeManuscriptBasename(fileRef.path)!,
        locationMode: fileRef.locationMode,
        resourceKind: "file",
        fileRole: "manuscript",
        configuredRoot
      });
      const target: SharedTargetSnapshot = {
        file,
        ...(expectedCurrent && binding.currentFileRefId
          ? { expectedCurrentFileRefId: binding.currentFileRefId }
          : {}),
        bindingRevision: binding.updatedAt,
        lifecycleRevision: literature.updatedAt,
        readOnly: false
      };
      return {
        status: "success" as const,
        owner,
        file,
        target,
        binding,
        fileRef,
        literature,
        channel
      };
    } catch {
      return failure(
        LITERATURE_RAW_ERROR_CODES.fileRefInvalid,
        "Literature manuscript identity is invalid."
      );
    }
  }

  async function resolveCurrent(
    literatureId: string,
    channel: ManuscriptChannel
  ) {
    const bindingResult = await resolveBinding(literatureId, channel);
    if (bindingResult.status !== "success") return bindingResult;
    if (!bindingResult.binding.currentFileRefId) {
      return failure(
        LITERATURE_RAW_ERROR_CODES.currentMissing,
        "Literature current manuscript is not set."
      );
    }
    return resolveTarget(
      literatureId,
      channel,
      bindingResult.binding.currentFileRefId,
      true
    );
  }

  async function revalidate(
    session: SharedManuscriptSession
  ): Promise<SharedSessionRevalidation> {
    const channel = requireChannel(
      session.owner.channel as ManuscriptChannel
    );
    if (typeof channel !== "string") {
      return {
        status: "target-changed",
        causeCode: LITERATURE_RAW_ERROR_CODES.channelInvalid
      };
    }
    const resolved = session.windowRole === "current"
      ? await resolveCurrent(session.owner.ownerId, channel)
      : session.file.kind === "durable"
        ? await resolveTarget(
            session.owner.ownerId,
            channel,
            session.file.fileRefId,
            false
          )
        : failure(
            LITERATURE_RAW_ERROR_CODES.targetChanged,
            "Literature manuscript target changed."
          );
    if (resolved.status !== "success") {
      if (resolved.error.code === LITERATURE_RAW_ERROR_CODES.ownerDeleted) {
        return {
          status: "read-only",
          causeCode: resolved.error.code
        };
      }
      return {
        status: session.windowRole === "current"
          ? "current-changed"
          : "target-changed",
        causeCode: resolved.error.code
      };
    }
    if (
      session.file.kind !== "durable" ||
      session.file.fileRefId !== resolved.file.fileRefId ||
      session.file.pathIdentity !== resolved.file.pathIdentity ||
      session.targetSnapshot.bindingRevision !== resolved.binding.updatedAt
    ) {
      return {
        status: session.windowRole === "current"
          ? "current-changed"
          : "target-changed",
        causeCode: session.windowRole === "current"
          ? LITERATURE_RAW_ERROR_CODES.currentChanged
          : LITERATURE_RAW_ERROR_CODES.targetChanged
      };
    }
    return { status: "valid", target: resolved.target };
  }

  async function openResolved(
    resolved: Extract<
      Awaited<ReturnType<typeof resolveCurrent>>,
      { status: "success" }
    >,
    windowRole: ManuscriptWindowRole,
    consumerId?: string
  ) {
    const opened = await dependencies.runtime.open({
      owner: resolved.owner,
      target: resolved.target,
      windowRole,
      accessMode: "writable",
      consumerId
    });
    return opened.status === "success" && opened.data
      ? {
          ...opened,
          sessionKey: opened.data.handle,
          session: opened.data.session,
          fileName: resolved.file.fileName,
          fileRefId: resolved.file.fileRefId
        }
      : opened;
  }

  function checkedSession(
    handle: SharedManuscriptSessionHandle,
    requestedChannel: ManuscriptChannel,
    expectedRole?: ManuscriptWindowRole
  ) {
    const channel = requireChannel(requestedChannel);
    if (typeof channel !== "string") return channel;
    const session = dependencies.runtime.getSession(handle);
    if (!session || session.owner.ownerType !== "literature") {
      return failure(
        LITERATURE_RAW_ERROR_CODES.sessionMissing,
        "Literature manuscript Session is unavailable."
      );
    }
    if (session.owner.channel !== channel) {
      return failure(
        LITERATURE_RAW_ERROR_CODES.sessionChannelMismatch,
        "Literature manuscript Session channel does not match."
      );
    }
    if (expectedRole && session.windowRole !== expectedRole) {
      return failure(
        LITERATURE_RAW_ERROR_CODES.sessionRoleMismatch,
        "Literature manuscript Session role does not match."
      );
    }
    return { status: "success" as const, session, channel };
  }

  return Object.freeze({
    async resolveCurrentDescriptor(
      literatureId: string,
      channel: ManuscriptChannel
    ) {
      const resolved = await resolveCurrent(literatureId, channel);
      return resolved.status === "success"
        ? {
            status: "success" as const,
            currentFileRefId: resolved.file.fileRefId,
            fileName: resolved.file.fileName,
            locationMode: resolved.file.locationMode,
            displayLabel: resolved.fileRef.title || resolved.file.fileName
          }
        : resolved;
    },
    async openCurrent(
      literatureId: string,
      channel: ManuscriptChannel,
      consumerId?: string
    ) {
      const resolved = await resolveCurrent(literatureId, channel);
      return resolved.status === "success"
        ? openResolved(resolved, "current", consumerId)
        : resolved;
    },
    async openIndependent(
      literatureId: string,
      channel: ManuscriptChannel,
      fileRefId: string,
      consumerId?: string
    ) {
      const resolved = await resolveTarget(
        literatureId,
        channel,
        fileRefId,
        false
      );
      return resolved.status === "success"
        ? openResolved(resolved, "independent", consumerId)
        : resolved;
    },
    updateDraft(
      handle: SharedManuscriptSessionHandle,
      channel: ManuscriptChannel,
      expectedRole: ManuscriptWindowRole,
      draftRawText: string
    ) {
      const checked = checkedSession(handle, channel, expectedRole);
      if (checked.status !== "success") return checked;
      const updated = dependencies.runtime.updateDraft(handle, draftRawText);
      return updated
        ? { status: "success" as const, session: updated }
        : failure(
            LITERATURE_RAW_ERROR_CODES.sessionMissing,
            "Literature manuscript Session is unavailable."
          );
    },
    async save(
      handle: SharedManuscriptSessionHandle,
      channel: ManuscriptChannel,
      expectedRole: ManuscriptWindowRole,
      options: { confirmedExternalWrite?: boolean } = {}
    ) {
      const checked = checkedSession(handle, channel, expectedRole);
      if (checked.status !== "success") return checked;
      if (
        checked.session.windowRole === "independent" &&
        checked.session.file.locationMode === "external" &&
        options.confirmedExternalWrite === true
      ) {
        dependencies.runtime.confirmExternalWrite(
          handle,
          checked.session.sessionGeneration
        );
      }
      if (
        checked.session.windowRole === "independent" &&
        checked.session.file.locationMode === "external" &&
        dependencies.runtime.requiresExternalWriteConfirmation(handle)
      ) {
        return failure(
          LITERATURE_RAW_ERROR_CODES.externalWriteConfirmationRequired,
          "Writing an external Literature manuscript requires confirmation."
        );
      }
      return dependencies.runtime.save(handle, async () =>
        revalidate(checked.session)
      );
    },
    async reload(
      handle: SharedManuscriptSessionHandle,
      channel: ManuscriptChannel,
      expectedRole: ManuscriptWindowRole,
      decision?: "discard" | "cancel"
    ) {
      const checked = checkedSession(handle, channel, expectedRole);
      if (checked.status !== "success") return checked;
      if (decision === "cancel") return { status: "canceled" as const };
      return dependencies.runtime.reload(
        handle,
        checked.session.dirty && decision === "discard"
          ? "discard"
          : undefined,
        async () => revalidate(checked.session)
      );
    },
    async close(
      handle: SharedManuscriptSessionHandle,
      channel: ManuscriptChannel,
      expectedRole: ManuscriptWindowRole,
      decision?: "discard" | "cancel"
    ) {
      const checked = checkedSession(handle, channel, expectedRole);
      if (checked.status !== "success") return checked;
      const closed = await dependencies.runtime.close(handle, decision);
      return closed.status === "warning"
        ? { status: "decision-required" as const, session: closed.data }
        : closed;
    },
    async closeExact(
      handle: SharedManuscriptSessionHandle,
      decision?: "discard" | "cancel"
    ) {
      const runtimeResult =
        await dependencies.runtime.close(handle, decision);
      if (runtimeResult.status === "success") {
        return {
          status: "closed" as const,
          runtimeResult
        };
      }
      if (
        runtimeResult.status === "error" &&
        String(runtimeResult.error?.code) ===
          "MANUSCRIPT_STALE_SESSION_HANDLE"
      ) {
        return {
          status: "already_absent" as const,
          runtimeResult
        };
      }
      return {
        status:
          runtimeResult.status === "conflict" ||
          runtimeResult.error?.retryable
            ? "retryable_failure" as const
            : "blocked_failure" as const,
        runtimeResult
      };
    },
    getSession(
      handle: SharedManuscriptSessionHandle,
      channel?: ManuscriptChannel,
      expectedRole?: ManuscriptWindowRole
    ): SharedManuscriptSession | undefined {
      const session = dependencies.runtime.getSession(handle);
      if (!session || session.owner.ownerType !== "literature") {
        return undefined;
      }
      if (
        channel !== undefined &&
        session.owner.channel !== requireChannel(channel)
      ) {
        return undefined;
      }
      return expectedRole && session.windowRole !== expectedRole
        ? undefined
        : session;
    },
    listSessions() {
      return dependencies.runtime
        .listSessionConsumers()
        .filter(({ session }) => session.owner.ownerType === "literature");
    }
  });
}

export const literatureRawManuscriptService =
  createLiteratureRawManuscriptService();

export type LiteratureRawManuscriptService =
  ReturnType<typeof createLiteratureRawManuscriptService>;
