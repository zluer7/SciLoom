import type {
  FileRef,
  ManuscriptBinding,
  OutputManuscriptOwnerType
} from "../types";
import type {
  ManuscriptWindowRole,
  SharedManuscriptSession,
  SharedManuscriptSessionHandle,
  SharedSessionRevalidation,
  SharedTargetSnapshot
} from "../types/sharedManuscriptSession";
import { getReadableFileRefOwnerContext } from "./fileRefOwnerValidator";
import { fileRefService, getSafeManuscriptBasename } from "./fileRefService";
import { managedRootConfigService } from "./managedRootConfigService";
import { manuscriptBindingService } from "./manuscriptBindingService";
import {
  assertOutputManuscriptChannel,
  isOutputManuscriptOwnerType
} from "./outputManuscriptDescriptorService";
import {
  sharedManuscriptIdentityResolver,
  sharedManuscriptSessionRuntime
} from "./sharedManuscriptSessionComposition";
import type { ManuscriptIdentityResolver } from "./manuscriptIdentityResolver";
import type { SharedManuscriptSessionRuntime } from "./sharedManuscriptSessionRuntime";
import { deriveMountedManuscriptLifecycleDecision } from "./fileRefOwnerValidator";

export const OUTPUT_RAW_ERROR_CODES = {
  ownerUnsupported: "OUTPUT_MANUSCRIPT_OWNER_UNSUPPORTED",
  channelInvalid: "OUTPUT_MANUSCRIPT_CHANNEL_INVALID",
  ownerMissing: "OUTPUT_MANUSCRIPT_OWNER_MISSING",
  ownerDeleted: "OUTPUT_MANUSCRIPT_OWNER_DELETED",
  bindingMissing: "OUTPUT_MANUSCRIPT_BINDING_MISSING",
  bindingInvalid: "OUTPUT_MANUSCRIPT_BINDING_INVALID",
  currentMissing: "OUTPUT_MANUSCRIPT_CURRENT_MISSING",
  currentChanged: "OUTPUT_MANUSCRIPT_CURRENT_CHANGED",
  fileRefMissing: "OUTPUT_MANUSCRIPT_FILE_REF_MISSING",
  fileRefDeleted: "OUTPUT_MANUSCRIPT_FILE_REF_INACTIVE",
  fileRefInvalid: "OUTPUT_MANUSCRIPT_FILE_REF_INVALID",
  targetChanged: "OUTPUT_MANUSCRIPT_TARGET_MISMATCH",
  managedRootUnavailable: "OUTPUT_MANUSCRIPT_MANAGED_ROOT_UNAVAILABLE",
  sessionMissing: "OUTPUT_MANUSCRIPT_SESSION_MISSING",
  sessionOwnerMismatch: "OUTPUT_MANUSCRIPT_SESSION_OWNER_MISMATCH",
  sessionRoleMismatch: "OUTPUT_MANUSCRIPT_SESSION_ROLE_MISMATCH",
  externalWriteConfirmationRequired:
    "OUTPUT_MANUSCRIPT_EXTERNAL_WRITE_CONFIRMATION_REQUIRED"
} as const;

type OutputRawErrorCode =
  (typeof OUTPUT_RAW_ERROR_CODES)[keyof typeof OUTPUT_RAW_ERROR_CODES];

export type OutputRawFailure = {
  status: "error";
  error: {
    code: OutputRawErrorCode;
    message: string;
    retryable: false;
    recoveryRequired: false;
  };
};

type ReadableOwnerContext = Awaited<
  ReturnType<typeof getReadableFileRefOwnerContext>
>;

export interface OutputRawManuscriptDependencies {
  getOwner(
    ownerType: OutputManuscriptOwnerType,
    ownerId: string
  ): Promise<ReadableOwnerContext>;
  getBinding(
    ownerType: OutputManuscriptOwnerType,
    ownerId: string,
    channel: "primary"
  ): Promise<ManuscriptBinding | undefined>;
  getFileRef(id: string): Promise<FileRef | undefined>;
  getDeletedFileRef(id: string): Promise<FileRef | undefined>;
  getManagedRoot(): ReturnType<typeof managedRootConfigService.getStatus>;
  identityResolver: ManuscriptIdentityResolver;
  runtime: SharedManuscriptSessionRuntime;
}

const defaultDependencies: OutputRawManuscriptDependencies = {
  getOwner: getReadableFileRefOwnerContext,
  getBinding: manuscriptBindingService.getBindingByOwner,
  getFileRef: fileRefService.getById,
  getDeletedFileRef: fileRefService.getDeletedById,
  getManagedRoot: () => managedRootConfigService.getStatus(),
  identityResolver: sharedManuscriptIdentityResolver,
  runtime: sharedManuscriptSessionRuntime
};

function failure(
  code: OutputRawErrorCode,
  message: string = code
): OutputRawFailure {
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

function requireOwnerType(
  ownerType: OutputManuscriptOwnerType | string
): OutputManuscriptOwnerType | OutputRawFailure {
  return isOutputManuscriptOwnerType(ownerType)
    ? ownerType
    : failure(
        OUTPUT_RAW_ERROR_CODES.ownerUnsupported,
        `Unsupported Outputs manuscript owner: ${ownerType}.`
      );
}

function requirePrimary(
  ownerType: OutputManuscriptOwnerType,
  channel: "primary"
) {
  try {
    return assertOutputManuscriptChannel(ownerType, channel);
  } catch {
    return failure(
      OUTPUT_RAW_ERROR_CODES.channelInvalid,
      "Outputs ordinary manuscript editing requires primary."
    );
  }
}

function validBinding(
  binding: ManuscriptBinding | undefined,
  ownerType: OutputManuscriptOwnerType,
  ownerId: string
) {
  return Boolean(
    binding &&
      !binding.deletedAt &&
      binding.ownerType === ownerType &&
      binding.ownerId === ownerId &&
      binding.manuscriptChannel === "primary"
  );
}

function validFileRef(
  fileRef: FileRef,
  ownerType: OutputManuscriptOwnerType,
  ownerId: string
) {
  return (
    !fileRef.deletedAt &&
    fileRef.ownerType === ownerType &&
    fileRef.ownerId === ownerId &&
    fileRef.manuscriptChannel === "primary" &&
    fileRef.resourceKind === "file" &&
    fileRef.fileRole === "manuscript" &&
    (fileRef.locationMode === "managed" ||
      fileRef.locationMode === "external") &&
    Boolean(fileRef.pathIdentityKey) &&
    Boolean(getSafeManuscriptBasename(fileRef.path))
  );
}

export function createOutputRawManuscriptService(
  dependencies: OutputRawManuscriptDependencies = defaultDependencies
) {
  async function resolveOwner(
    ownerTypeInput: OutputManuscriptOwnerType | string,
    ownerId: string
  ) {
    const ownerType = requireOwnerType(ownerTypeInput);
    if (typeof ownerType !== "string") return ownerType;
    let context: ReadableOwnerContext;
    try {
      context = await dependencies.getOwner(ownerType, ownerId);
    } catch {
      return failure(
        OUTPUT_RAW_ERROR_CODES.ownerMissing,
        "Outputs manuscript owner does not exist."
      );
    }
    if (context.ownerType !== ownerType || context.ownerId !== ownerId) {
      return failure(
        OUTPUT_RAW_ERROR_CODES.ownerMissing,
        "Outputs manuscript owner identity does not match."
      );
    }
    const lifecycle = deriveMountedManuscriptLifecycleDecision({
      ownerType,
      ownerId,
      manuscriptChannel: "primary",
      ownerDeleted: Boolean(context.entity.deletedAt)
    });
    if (!lifecycle.canRead) {
      return failure(
        OUTPUT_RAW_ERROR_CODES.ownerDeleted,
        "Outputs manuscript owner is deleted."
      );
    }
    return { status: "success" as const, ownerType, context };
  }

  async function resolveBinding(
    ownerTypeInput: OutputManuscriptOwnerType | string,
    ownerId: string,
    channel: "primary"
  ) {
    const ownerResult = await resolveOwner(ownerTypeInput, ownerId);
    if (ownerResult.status !== "success") return ownerResult;
    const checkedChannel = requirePrimary(ownerResult.ownerType, channel);
    if (checkedChannel !== "primary") return checkedChannel;
    const binding = await dependencies.getBinding(
      ownerResult.ownerType,
      ownerId,
      "primary"
    );
    if (!binding) {
      return failure(
        OUTPUT_RAW_ERROR_CODES.bindingMissing,
        "Outputs manuscript binding does not exist."
      );
    }
    if (!validBinding(binding, ownerResult.ownerType, ownerId)) {
      return failure(
        OUTPUT_RAW_ERROR_CODES.bindingInvalid,
        "Outputs manuscript binding is invalid."
      );
    }
    return {
      status: "success" as const,
      ownerType: ownerResult.ownerType,
      context: ownerResult.context,
      binding
    };
  }

  async function resolveTarget(
    ownerTypeInput: OutputManuscriptOwnerType | string,
    ownerId: string,
    channel: "primary",
    fileRefId: string,
    expectedCurrent: boolean
  ) {
    const resolvedBinding = await resolveBinding(
      ownerTypeInput,
      ownerId,
      channel
    );
    if (resolvedBinding.status !== "success") return resolvedBinding;
    const { binding, context, ownerType } = resolvedBinding;
    if (expectedCurrent && !binding.currentFileRefId) {
      return failure(
        OUTPUT_RAW_ERROR_CODES.currentMissing,
        "Outputs current manuscript is not set."
      );
    }
    if (expectedCurrent && binding.currentFileRefId !== fileRefId) {
      return failure(
        OUTPUT_RAW_ERROR_CODES.currentChanged,
        "Outputs current manuscript changed."
      );
    }
    const fileRef = await dependencies.getFileRef(fileRefId);
    if (!fileRef) {
      return failure(
        await dependencies.getDeletedFileRef(fileRefId)
          ? OUTPUT_RAW_ERROR_CODES.fileRefDeleted
          : OUTPUT_RAW_ERROR_CODES.fileRefMissing,
        "Outputs manuscript FileRef is unavailable."
      );
    }
    if (!validFileRef(fileRef, ownerType, ownerId)) {
      return failure(
        OUTPUT_RAW_ERROR_CODES.fileRefInvalid,
        "Outputs manuscript FileRef is invalid."
      );
    }
    let configuredRoot: string | undefined;
    if (fileRef.locationMode === "managed") {
      const root = await dependencies.getManagedRoot();
      if (root.status !== "configured" || !root.managedRoot) {
        return failure(
          OUTPUT_RAW_ERROR_CODES.managedRootUnavailable,
          "Managed root is unavailable."
        );
      }
      configuredRoot = root.managedRoot;
    }
    try {
      const owner = dependencies.identityResolver.resolveOwner({
        ownerType,
        ownerId,
        channel: "primary"
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
        lifecycleRevision: `owner:${context.entity.id}:active`,
        readOnly: false
      };
      return {
        status: "success" as const,
        owner,
        file,
        target,
        binding,
        fileRef,
        context,
        ownerType
      };
    } catch {
      return failure(
        OUTPUT_RAW_ERROR_CODES.fileRefInvalid,
        "Outputs manuscript identity is invalid."
      );
    }
  }

  async function resolveCurrent(
    ownerType: OutputManuscriptOwnerType,
    ownerId: string,
    channel: "primary"
  ) {
    const bindingResult = await resolveBinding(ownerType, ownerId, channel);
    if (bindingResult.status !== "success") return bindingResult;
    if (!bindingResult.binding.currentFileRefId) {
      return failure(
        OUTPUT_RAW_ERROR_CODES.currentMissing,
        "Outputs current manuscript is not set."
      );
    }
    return resolveTarget(
      ownerType,
      ownerId,
      channel,
      bindingResult.binding.currentFileRefId,
      true
    );
  }

  async function revalidate(
    session: SharedManuscriptSession
  ): Promise<SharedSessionRevalidation> {
    if (!isOutputManuscriptOwnerType(session.owner.ownerType)) {
      return {
        status: "target-changed",
        causeCode: OUTPUT_RAW_ERROR_CODES.sessionOwnerMismatch
      };
    }
    const resolved = session.windowRole === "current"
      ? await resolveCurrent(
          session.owner.ownerType,
          session.owner.ownerId,
          "primary"
        )
      : session.file.kind === "durable"
        ? await resolveTarget(
            session.owner.ownerType,
            session.owner.ownerId,
            "primary",
            session.file.fileRefId,
            false
          )
        : failure(
            OUTPUT_RAW_ERROR_CODES.targetChanged,
            "Outputs manuscript target changed."
          );
    if (resolved.status !== "success") {
      if (resolved.error.code === OUTPUT_RAW_ERROR_CODES.ownerDeleted) {
        return { status: "read-only", causeCode: resolved.error.code };
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
          ? OUTPUT_RAW_ERROR_CODES.currentChanged
          : OUTPUT_RAW_ERROR_CODES.targetChanged
      };
    }
    return { status: "valid", target: resolved.target };
  }

  async function openResolved(
    resolved: Extract<
      Awaited<ReturnType<typeof resolveTarget>>,
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
    ownerType: OutputManuscriptOwnerType,
    ownerId: string,
    expectedRole: ManuscriptWindowRole
  ) {
    const session = dependencies.runtime.getSession(handle);
    if (!session) {
      return failure(
        OUTPUT_RAW_ERROR_CODES.sessionMissing,
        "Outputs manuscript Session is unavailable."
      );
    }
    if (
      session.owner.ownerType !== ownerType ||
      session.owner.ownerId !== ownerId ||
      session.owner.channel !== "primary"
    ) {
      return failure(
        OUTPUT_RAW_ERROR_CODES.sessionOwnerMismatch,
        "Outputs manuscript Session owner does not match."
      );
    }
    if (session.windowRole !== expectedRole) {
      return failure(
        OUTPUT_RAW_ERROR_CODES.sessionRoleMismatch,
        "Outputs manuscript Session role does not match."
      );
    }
    return { status: "success" as const, session };
  }

  return Object.freeze({
    async openCurrent(
      ownerType: OutputManuscriptOwnerType,
      ownerId: string,
      consumerId?: string
    ) {
      const resolved = await resolveCurrent(ownerType, ownerId, "primary");
      return resolved.status === "success"
        ? openResolved(resolved, "current", consumerId)
        : resolved;
    },
    async openIndependent(
      ownerType: OutputManuscriptOwnerType,
      ownerId: string,
      fileRefId: string,
      consumerId?: string
    ) {
      const resolved = await resolveTarget(
        ownerType,
        ownerId,
        "primary",
        fileRefId,
        false
      );
      return resolved.status === "success"
        ? openResolved(resolved, "independent", consumerId)
        : resolved;
    },
    updateDraft(
      handle: SharedManuscriptSessionHandle,
      ownerType: OutputManuscriptOwnerType,
      ownerId: string,
      expectedRole: ManuscriptWindowRole,
      draftRawText: string
    ) {
      const checked = checkedSession(
        handle,
        ownerType,
        ownerId,
        expectedRole
      );
      if (checked.status !== "success") return checked;
      const updated = dependencies.runtime.updateDraft(handle, draftRawText);
      return updated
        ? { status: "success" as const, session: updated }
        : failure(
            OUTPUT_RAW_ERROR_CODES.sessionMissing,
            "Outputs manuscript Session is unavailable."
          );
    },
    async save(
      handle: SharedManuscriptSessionHandle,
      ownerType: OutputManuscriptOwnerType,
      ownerId: string,
      expectedRole: ManuscriptWindowRole,
      options: { confirmedExternalWrite?: boolean } = {}
    ) {
      const checked = checkedSession(
        handle,
        ownerType,
        ownerId,
        expectedRole
      );
      if (checked.status !== "success") return checked;
      if (
        expectedRole === "independent" &&
        checked.session.file.locationMode === "external" &&
        options.confirmedExternalWrite === true
      ) {
        dependencies.runtime.confirmExternalWrite(
          handle,
          checked.session.sessionGeneration
        );
      }
      if (
        expectedRole === "independent" &&
        checked.session.file.locationMode === "external" &&
        dependencies.runtime.requiresExternalWriteConfirmation(handle)
      ) {
        return failure(
          OUTPUT_RAW_ERROR_CODES.externalWriteConfirmationRequired,
          "Writing an external independent Outputs manuscript requires confirmation."
        );
      }
      return dependencies.runtime.save(handle, async () =>
        revalidate(checked.session)
      );
    },
    async reload(
      handle: SharedManuscriptSessionHandle,
      ownerType: OutputManuscriptOwnerType,
      ownerId: string,
      expectedRole: ManuscriptWindowRole,
      decision?: "discard" | "cancel"
    ) {
      const checked = checkedSession(
        handle,
        ownerType,
        ownerId,
        expectedRole
      );
      if (checked.status !== "success") return checked;
      return dependencies.runtime.reload(
        handle,
        checked.session.dirty && decision === "discard"
          ? "discard"
          : decision,
        async () => revalidate(checked.session)
      );
    },
    async close(
      handle: SharedManuscriptSessionHandle,
      ownerType: OutputManuscriptOwnerType,
      ownerId: string,
      expectedRole: ManuscriptWindowRole,
      decision?: "save" | "discard" | "cancel"
    ) {
      const checked = checkedSession(
        handle,
        ownerType,
        ownerId,
        expectedRole
      );
      if (checked.status !== "success") return checked;
      return dependencies.runtime.close(
        handle,
        decision,
        async () => revalidate(checked.session)
      );
    },
    getSession(
      handle: SharedManuscriptSessionHandle,
      ownerType: OutputManuscriptOwnerType,
      ownerId: string,
      expectedRole: ManuscriptWindowRole
    ) {
      const checked = checkedSession(
        handle,
        ownerType,
        ownerId,
        expectedRole
      );
      return checked.status === "success" ? checked.session : undefined;
    },
    listSessions() {
      return dependencies.runtime.listSessionConsumers().filter(
        ({ session }) =>
          isOutputManuscriptOwnerType(session.owner.ownerType) &&
          session.owner.channel === "primary"
      );
    }
  });
}

export const outputRawManuscriptService =
  createOutputRawManuscriptService();

export type OutputRawManuscriptService =
  ReturnType<typeof createOutputRawManuscriptService>;
