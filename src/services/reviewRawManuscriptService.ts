import type { FileRef, ManuscriptBinding, Review } from "../types";
import type {
  SharedManuscriptSession,
  SharedManuscriptSessionHandle,
  SharedSessionRevalidation,
  SharedTargetSnapshot
} from "../types/sharedManuscriptSession";
import { fileRefService, getSafeManuscriptBasename } from "./fileRefService";
import { managedRootConfigService } from "./managedRootConfigService";
import { manuscriptBindingService } from "./manuscriptBindingService";
import { planningService } from "./planningService";
import {
  sharedManuscriptIdentityResolver,
  sharedManuscriptSessionRuntime
} from "./sharedManuscriptSessionComposition";
import type { ManuscriptIdentityResolver } from "./manuscriptIdentityResolver";
import type { SharedManuscriptSessionRuntime } from "./sharedManuscriptSessionRuntime";
import { deriveMountedManuscriptLifecycleDecision } from "./fileRefOwnerValidator";

export const REVIEW_RAW_ERROR_CODES = {
  ownerMissing: "REVIEW_MANUSCRIPT_OWNER_MISSING",
  ownerDeleted: "REVIEW_MANUSCRIPT_OWNER_DELETED",
  bindingMissing: "REVIEW_MANUSCRIPT_BINDING_MISSING",
  bindingInvalid: "REVIEW_MANUSCRIPT_BINDING_INVALID",
  currentMissing: "REVIEW_MANUSCRIPT_CURRENT_MISSING",
  currentChanged: "REVIEW_MANUSCRIPT_CURRENT_CHANGED",
  fileRefMissing: "REVIEW_MANUSCRIPT_FILE_REF_MISSING",
  fileRefDeleted: "REVIEW_MANUSCRIPT_FILE_REF_INACTIVE",
  fileRefInvalid: "REVIEW_MANUSCRIPT_FILE_REF_INVALID",
  targetChanged: "REVIEW_MANUSCRIPT_TARGET_MISMATCH",
  managedRootUnavailable: "REVIEW_MANUSCRIPT_MANAGED_ROOT_UNAVAILABLE",
  sessionMissing: "REVIEW_MANUSCRIPT_SESSION_MISSING",
  externalWriteConfirmationRequired:
    "REVIEW_MANUSCRIPT_EXTERNAL_WRITE_CONFIRMATION_REQUIRED"
} as const;

type ReviewRawErrorCode =
  (typeof REVIEW_RAW_ERROR_CODES)[keyof typeof REVIEW_RAW_ERROR_CODES];

export type ReviewRawFailure = {
  status: "error";
  error: {
    code: ReviewRawErrorCode;
    message: string;
    retryable: false;
    recoveryRequired: false;
  };
};

export interface ReviewRawManuscriptDependencies {
  getReview(
    id: string
  ): Promise<Pick<Review, "id" | "updatedAt" | "deletedAt"> | undefined>;
  getBinding(
    ownerType: "review",
    ownerId: string,
    channel: "primary"
  ): Promise<ManuscriptBinding | undefined>;
  getFileRef(id: string): Promise<FileRef | undefined>;
  getDeletedFileRef(id: string): Promise<FileRef | undefined>;
  getManagedRoot(): ReturnType<typeof managedRootConfigService.getStatus>;
  identityResolver: ManuscriptIdentityResolver;
  runtime: SharedManuscriptSessionRuntime;
}

const defaultDependencies: ReviewRawManuscriptDependencies = {
  async getReview(id) {
    const reviews = await planningService.queryReviewFirstLayerIdentities({
      includeDeleted: true,
      includeArchived: true
    });
    return reviews.find((review) => review.id === id);
  },
  getBinding: manuscriptBindingService.getBindingByOwner,
  getFileRef: fileRefService.getById,
  getDeletedFileRef: fileRefService.getDeletedById,
  getManagedRoot: () => managedRootConfigService.getStatus(),
  identityResolver: sharedManuscriptIdentityResolver,
  runtime: sharedManuscriptSessionRuntime
};

function failure(
  code: ReviewRawErrorCode,
  message: string = code
): ReviewRawFailure {
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

function validBinding(binding: ManuscriptBinding | undefined, reviewId: string) {
  return Boolean(
    binding &&
      !binding.deletedAt &&
      binding.ownerType === "review" &&
      binding.ownerId === reviewId &&
      binding.manuscriptChannel === "primary"
  );
}

function validFileRef(fileRef: FileRef, reviewId: string) {
  return (
    !fileRef.deletedAt &&
    fileRef.ownerType === "review" &&
    fileRef.ownerId === reviewId &&
    fileRef.manuscriptChannel === "primary" &&
    fileRef.resourceKind === "file" &&
    fileRef.fileRole === "manuscript" &&
    (fileRef.locationMode === "managed" ||
      fileRef.locationMode === "external") &&
    Boolean(fileRef.pathIdentityKey) &&
    Boolean(getSafeManuscriptBasename(fileRef.path))
  );
}

export function createReviewRawManuscriptService(
  dependencies: ReviewRawManuscriptDependencies = defaultDependencies
) {
  async function resolveOwner(reviewId: string) {
    const review = await dependencies.getReview(reviewId);
    if (!review) {
      return failure(
        REVIEW_RAW_ERROR_CODES.ownerMissing,
        "Review does not exist."
      );
    }
    const lifecycle = deriveMountedManuscriptLifecycleDecision({
      ownerType: "review",
      ownerId: reviewId,
      manuscriptChannel: "primary",
      ownerDeleted: Boolean(review.deletedAt)
    });
    if (!lifecycle.canRead) {
      return failure(
        REVIEW_RAW_ERROR_CODES.ownerDeleted,
        "Review is deleted."
      );
    }
    return { status: "success" as const, review };
  }

  async function resolveBinding(reviewId: string) {
    const ownerResult = await resolveOwner(reviewId);
    if (ownerResult.status !== "success") return ownerResult;
    const binding = await dependencies.getBinding(
      "review",
      reviewId,
      "primary"
    );
    if (!binding) {
      return failure(
        REVIEW_RAW_ERROR_CODES.bindingMissing,
        "Review manuscript binding does not exist."
      );
    }
    if (!validBinding(binding, reviewId)) {
      return failure(
        REVIEW_RAW_ERROR_CODES.bindingInvalid,
        "Review manuscript binding is invalid."
      );
    }
    return { status: "success" as const, review: ownerResult.review, binding };
  }

  async function resolveTarget(
    reviewId: string,
    fileRefId: string,
    expectedCurrent: boolean
  ) {
    const resolvedBinding = await resolveBinding(reviewId);
    if (resolvedBinding.status !== "success") return resolvedBinding;
    const { binding, review } = resolvedBinding;
    if (expectedCurrent && !binding.currentFileRefId) {
      return failure(
        REVIEW_RAW_ERROR_CODES.currentMissing,
        "Review current manuscript is not set."
      );
    }
    if (expectedCurrent && binding.currentFileRefId !== fileRefId) {
      return failure(
        REVIEW_RAW_ERROR_CODES.currentChanged,
        "Review current manuscript changed."
      );
    }
    const fileRef = await dependencies.getFileRef(fileRefId);
    if (!fileRef) {
      return failure(
        await dependencies.getDeletedFileRef(fileRefId)
          ? REVIEW_RAW_ERROR_CODES.fileRefDeleted
          : REVIEW_RAW_ERROR_CODES.fileRefMissing,
        "Review manuscript FileRef is unavailable."
      );
    }
    if (!validFileRef(fileRef, reviewId)) {
      return failure(
        REVIEW_RAW_ERROR_CODES.fileRefInvalid,
        "Review manuscript FileRef is invalid."
      );
    }
    let configuredRoot: string | undefined;
    if (fileRef.locationMode === "managed") {
      const root = await dependencies.getManagedRoot();
      if (root.status !== "configured" || !root.managedRoot) {
        return failure(
          REVIEW_RAW_ERROR_CODES.managedRootUnavailable,
          "Managed root is unavailable."
        );
      }
      configuredRoot = root.managedRoot;
    }
    try {
      const owner = dependencies.identityResolver.resolveOwner({
        ownerType: "review",
        ownerId: reviewId,
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
        lifecycleRevision: review.updatedAt,
        readOnly: false
      };
      return {
        status: "success" as const,
        owner,
        file,
        target,
        binding,
        fileRef,
        review
      };
    } catch {
      return failure(
        REVIEW_RAW_ERROR_CODES.fileRefInvalid,
        "Review manuscript identity is invalid."
      );
    }
  }

  async function resolveCurrent(reviewId: string) {
    const bindingResult = await resolveBinding(reviewId);
    if (bindingResult.status !== "success") return bindingResult;
    if (!bindingResult.binding.currentFileRefId) {
      return failure(
        REVIEW_RAW_ERROR_CODES.currentMissing,
        "Review current manuscript is not set."
      );
    }
    return resolveTarget(
      reviewId,
      bindingResult.binding.currentFileRefId,
      true
    );
  }

  async function resolveIndependent(reviewId: string, fileRefId: string) {
    return resolveTarget(reviewId, fileRefId, false);
  }

  async function revalidate(
    session: SharedManuscriptSession
  ): Promise<SharedSessionRevalidation> {
    const resolved = session.windowRole === "current"
      ? await resolveCurrent(session.owner.ownerId)
      : session.file.kind === "durable"
        ? await resolveIndependent(
            session.owner.ownerId,
            session.file.fileRefId
          )
        : failure(
            REVIEW_RAW_ERROR_CODES.targetChanged,
            "Review manuscript target changed."
          );
    if (resolved.status !== "success") {
      if (resolved.error.code === REVIEW_RAW_ERROR_CODES.ownerDeleted) {
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
          ? REVIEW_RAW_ERROR_CODES.currentChanged
          : REVIEW_RAW_ERROR_CODES.targetChanged
      };
    }
    return { status: "valid", target: resolved.target };
  }

  async function openResolved(
    resolved: Extract<
      Awaited<ReturnType<typeof resolveCurrent>>,
      { status: "success" }
    >,
    windowRole: "current" | "independent",
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

  return Object.freeze({
    async resolveCurrentDescriptor(reviewId: string) {
      const resolved = await resolveCurrent(reviewId);
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
    async openCurrent(reviewId: string, consumerId?: string) {
      const resolved = await resolveCurrent(reviewId);
      return resolved.status === "success"
        ? openResolved(resolved, "current", consumerId)
        : resolved;
    },
    async openIndependent(
      reviewId: string,
      fileRefId: string,
      consumerId?: string
    ) {
      const resolved = await resolveIndependent(reviewId, fileRefId);
      return resolved.status === "success"
        ? openResolved(resolved, "independent", consumerId)
        : resolved;
    },
    updateDraft(
      handle: SharedManuscriptSessionHandle,
      draftRawText: string
    ) {
      const session = dependencies.runtime.getSession(handle);
      if (
        !session ||
        session.owner.ownerType !== "review" ||
        session.owner.channel !== "primary"
      ) {
        return failure(
          REVIEW_RAW_ERROR_CODES.sessionMissing,
          "Review manuscript Session is unavailable."
        );
      }
      const updated = dependencies.runtime.updateDraft(handle, draftRawText);
      return updated
        ? { status: "success" as const, session: updated }
        : failure(
            REVIEW_RAW_ERROR_CODES.sessionMissing,
            "Review manuscript Session is unavailable."
          );
    },
    async save(
      handle: SharedManuscriptSessionHandle,
      options: { confirmedExternalWrite?: boolean } = {}
    ) {
      const session = dependencies.runtime.getSession(handle);
      if (
        !session ||
        session.owner.ownerType !== "review" ||
        session.owner.channel !== "primary"
      ) {
        return failure(
          REVIEW_RAW_ERROR_CODES.sessionMissing,
          "Review manuscript Session is unavailable."
        );
      }
      if (
        session.windowRole === "independent" &&
        session.file.locationMode === "external" &&
        options.confirmedExternalWrite === true
      ) {
        dependencies.runtime.confirmExternalWrite(
          handle,
          session.sessionGeneration
        );
      }
      if (
        session.windowRole === "independent" &&
        session.file.locationMode === "external" &&
        dependencies.runtime.requiresExternalWriteConfirmation(handle)
      ) {
        return failure(
          REVIEW_RAW_ERROR_CODES.externalWriteConfirmationRequired,
          "Writing an external Review manuscript requires confirmation."
        );
      }
      return dependencies.runtime.save(handle, async () =>
        revalidate(session)
      );
    },
    async reload(
      handle: SharedManuscriptSessionHandle,
      decision?: "discard" | "cancel"
    ) {
      const session = dependencies.runtime.getSession(handle);
      if (!session || session.owner.ownerType !== "review") {
        return failure(
          REVIEW_RAW_ERROR_CODES.sessionMissing,
          "Review manuscript Session is unavailable."
        );
      }
      if (decision === "cancel") return { status: "canceled" as const };
      return dependencies.runtime.reload(
        handle,
        session.dirty && decision === "discard" ? "discard" : undefined,
        async () => revalidate(session)
      );
    },
    async close(
      handle: SharedManuscriptSessionHandle,
      decision?: "discard" | "cancel"
    ) {
      const closed = await dependencies.runtime.close(handle, decision);
      return closed.status === "warning"
        ? { status: "decision-required" as const, session: closed.data }
        : closed;
    },
    getSession(
      handle: SharedManuscriptSessionHandle
    ): SharedManuscriptSession | undefined {
      const session = dependencies.runtime.getSession(handle);
      return session?.owner.ownerType === "review" ? session : undefined;
    },
    listSessions() {
      return dependencies.runtime
        .listSessionConsumers()
        .filter(({ session }) => session.owner.ownerType === "review");
    }
  });
}

export const reviewRawManuscriptService =
  createReviewRawManuscriptService();

export type ReviewRawManuscriptService =
  ReturnType<typeof createReviewRawManuscriptService>;
