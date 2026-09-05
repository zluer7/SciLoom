import type {
  EntityId,
  FileRef,
  FileRefOwnerType,
  ManuscriptBinding,
  ManuscriptChannel
} from "../types";
import {
  CANDIDATE_MANUSCRIPT_ERROR_CODES,
  type CandidateManuscriptErrorCode,
  type NativeCreateCandidateManuscriptInput,
  type NativeCreateCandidateManuscriptResult,
  type SaveCandidateManuscriptInput,
  type SaveCandidateManuscriptResult,
  type SetCandidateAsCurrentInput,
  type SetCandidateAsCurrentResult
} from "../types/candidateManuscript";
import type { FileRefOwnerContext } from "./fileRefOwnerValidator";
import { fileRefService } from "./fileRefService";
import { createPathIdentityKey } from "./fileRefIdentity";
import { validateFileRefOwner } from "./fileRefOwnerValidator";
import { parseLabPodMarkdownDocument, serializeLabPodMarkdownDocument } from "./labPodMarkdownDocumentService";
import { assertLiteratureDocumentV2 } from "./literatureMarkdownCodecService";
import {
  buildLiteratureCandidateFileName,
  parseCandidateOccurredAt,
  validateCandidateRequestId
} from "./literatureCandidateFilenameService";
import { buildReviewCandidateFileName } from "./reviewCandidateFilenameService";
import { buildExperimentCandidateFileName } from "./experimentCandidateFilenameService";
import { buildQuickAnalysisPrimaryCandidateFileName } from "./quickAnalysisCandidateFilenameService";
import { MANUSCRIPT_SEGMENT_PRODUCT_CHANNELS } from "./manuscriptSegmentProductActivation";
import { managedFileProvisioningService } from "./managedFileProvisioningService";
import { managedRootConfigService } from "./managedRootConfigService";
import {
  buildManagedManuscriptPath,
  isPathWithinRoot,
  normalizeManagedRoot
} from "./managedPathService";
import { manuscriptBindingService } from "./manuscriptBindingService";
import { manuscriptRequestTokenController } from "./manuscriptRequestTokenController";
import { manuscriptSwitchService } from "./manuscriptSwitchService";
import { nativeManuscriptIoService } from "./nativeManuscriptIoService";
import { publishRefreshEvent } from "./refreshEventService";

type ProvisioningOwnerEntity = FileRefOwnerContext["entity"] & {
  projectId?: string | null;
  primaryProjectId?: string | null;
  title?: string | null;
  name?: string | null;
  createdAt?: string | null;
};

interface CandidatePathPlan {
  configuredRoot: string;
  workspaceDirectory: string;
  layout: NativeCreateCandidateManuscriptInput["layout"];
  manuscriptChannel: ManuscriptChannel;
  fileName: string;
  absolutePath: string;
  pathIdentityKey: string;
  requestShortId?: string;
  warnings: string[];
}

function publishCandidateCurrentRefresh(input: SetCandidateAsCurrentInput) {
  if (input.ownerType !== "literature" && input.ownerType !== "review") return;
  const isLiterature = input.ownerType === "literature";
  try {
    publishRefreshEvent({
      id: `${input.ownerType}-candidate-current-${input.candidateFileRefId}-${Date.now()}`,
      keys: isLiterature ? ["fileRef.changed", "literature.changed"] : ["fileRef.changed", "review.changed"],
      affectedEntities: [
        { type: input.ownerType, id: input.ownerId, relation: "updated" },
        { type: "fileRef", id: input.candidateFileRefId, relation: "linked" }
      ],
      affectedScopes: [{
        module: input.ownerType,
        ...(isLiterature ? { literatureId: input.ownerId } : { reviewId: input.ownerId }),
        reason: `Current ${input.ownerType} manuscript changed to a confirmed candidate.`
      }],
      source: "service.write",
      operation: "candidateManuscript.setCandidateAsCurrent",
      reason: "Refresh current filename DTO after candidate set-current.",
      writeFeedbackStatus: "success",
      createdAt: new Date().toISOString()
    });
  } catch {
    // The confirmed binding update remains authoritative if a refresh listener fails.
  }
}

function publishCandidateSavedRefresh(
  input: SaveCandidateManuscriptInput,
  fileRefId: EntityId
) {
  if (input.ownerType !== "literature" && input.ownerType !== "review" && input.ownerType !== "experiment") return;
  const isLiterature = input.ownerType === "literature";
  try {
    publishRefreshEvent({
      id: `${input.ownerType}-candidate-saved-${fileRefId}-${Date.now()}`,
      keys: isLiterature
        ? ["fileRef.changed", "literature.changed"]
        : input.ownerType === "review"
          ? ["fileRef.changed", "review.changed"]
          : ["fileRef.changed", "experiment.changed"],
      affectedEntities: [
        { type: input.ownerType, id: input.ownerId, relation: "updated" },
        { type: "fileRef", id: fileRefId, relation: "created" }
      ],
      affectedScopes: [{
        module: input.ownerType,
        ...(isLiterature
          ? { literatureId: input.ownerId }
          : input.ownerType === "review"
            ? { reviewId: input.ownerId }
            : { experimentId: input.ownerId }),
        reason: `An authorized ${input.ownerType} Candidate manuscript was saved.`
      }],
      source: "service.write",
      operation: "candidateManuscript.saveCandidate",
      reason: "Refresh the non-current Candidate selector without changing current manuscript.",
      writeFeedbackStatus: "success",
      createdAt: new Date().toISOString()
    });
  } catch {
    // Candidate metadata remains authoritative if a refresh listener fails.
  }
}

async function provisionCandidateOwner(input: SaveCandidateManuscriptInput, owner: FileRefOwnerContext) {
  const entity = owner.entity as ProvisioningOwnerEntity;
  const projectId = entity.projectId ?? entity.primaryProjectId;
  if (!projectId && input.ownerType !== "literature") {
    return { status: "error" as const, errors: [{ message: "Owner has no Project assignment." }] };
  }
  const common = {
    ownerId: input.ownerId,
    ownerTitle: (entity.title ?? entity.name ?? input.candidateTitle) || "Managed owner",
    createdAt: entity.createdAt ?? input.occurredAt,
    source: "system" as const,
    manuscriptChannel: input.manuscriptChannel ?? "primary",
    manuscriptFileName: input.manuscriptChannel === "literature_outline"
      ? "literature-outline.md"
      : input.manuscriptChannel === "dedicated_notes"
        ? "dedicated-notes.md"
        : input.ownerType === "review" ? "review.md" : "body.md"
  };
  if (!projectId) {
    return managedFileProvisioningService.provision({
      ...common,
      ownerType: "literature",
      projectId: null,
      projectTitle: null
    });
  }
  return managedFileProvisioningService.provision({
    ...common,
    ownerType: input.ownerType,
    projectId,
    projectTitle: ""
  });
}

export interface CandidateManuscriptDependencies {
  validateOwner(ownerType: string, ownerId: EntityId): Promise<FileRefOwnerContext>;
  getBinding(ownerType: FileRefOwnerType, ownerId: EntityId, manuscriptChannel?: ManuscriptChannel): Promise<ManuscriptBinding | undefined>;
  getFileRef(id: EntityId): Promise<FileRef | undefined>;
  getDeletedFileRef(id: EntityId): Promise<FileRef | undefined>;
  getRootStatus(): ReturnType<typeof managedRootConfigService.getStatus>;
  provisionOwner(
    input: SaveCandidateManuscriptInput,
    owner: FileRefOwnerContext
  ): Promise<{ status: string; errors?: Array<{ message: string }>; binding?: ManuscriptBinding; defaultFolderFileRef?: FileRef }>;
  createCandidateFile(input: NativeCreateCandidateManuscriptInput): Promise<NativeCreateCandidateManuscriptResult>;
  registerFileRef: typeof fileRefService.registerFileRef;
  getOwnerFileRefs: typeof fileRefService.getFileRefsByOwnerIncludingDeleted;
  switchCurrent: typeof manuscriptSwitchService.switchCurrentManuscript;
  isRequestCurrent(token: number): boolean;
}

const defaultDependencies: CandidateManuscriptDependencies = {
  validateOwner: validateFileRefOwner,
  getBinding: manuscriptBindingService.getBindingByOwner,
  getFileRef: fileRefService.getById,
  getDeletedFileRef: fileRefService.getDeletedById,
  getRootStatus: () => managedRootConfigService.getStatus(),
  provisionOwner: provisionCandidateOwner,
  createCandidateFile: nativeManuscriptIoService.createManagedCandidateManuscript,
  registerFileRef: fileRefService.registerFileRef,
  getOwnerFileRefs: fileRefService.getFileRefsByOwnerIncludingDeleted,
  switchCurrent: manuscriptSwitchService.switchCurrentManuscript,
  isRequestCurrent: manuscriptRequestTokenController.isCurrent
};

function emptyResult(input: SaveCandidateManuscriptInput): SaveCandidateManuscriptResult {
  return {
    status: "error",
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    manuscriptChannel: input.manuscriptChannel,
    requestId: input.requestId,
    occurredAt: input.occurredAt,
    source: input.source,
    authorizationSource: input.authorization?.source ??
      (input.confirmedByUser === true ? "EXPLICIT_USER_CONFIRMATION" : undefined),
    frozenWorkspace: input.frozenWorkspace
      ? { ...input.frozenWorkspace }
      : undefined,
    createdFile: false,
    reusedFile: false,
    createdFileRef: false,
    contentSizeBytes: 0,
    warnings: [],
    errors: [],
    completedSteps: [],
    retryable: false,
    requestToken: input.requestToken,
    currentChanged: false
  };
}

function saveFailure(
  input: SaveCandidateManuscriptInput,
  code: CandidateManuscriptErrorCode | string,
  message: string,
  step: string,
  options: Partial<SaveCandidateManuscriptResult> = {}
): SaveCandidateManuscriptResult {
  return {
    ...emptyResult(input),
    ...options,
    errors: [{ code, message, step }],
    failedStep: step
  };
}

function ownerError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("OWNER_DELETED")
    ? CANDIDATE_MANUSCRIPT_ERROR_CODES.ownerDeleted
    : CANDIDATE_MANUSCRIPT_ERROR_CODES.ownerNotFound;
}

function codeFromMessage(message: string): CandidateManuscriptErrorCode {
  const entry = Object.values(CANDIDATE_MANUSCRIPT_ERROR_CODES).find((code) => message.includes(code));
  return entry ?? CANDIDATE_MANUSCRIPT_ERROR_CODES.pathInvalid;
}

const CANDIDATE_CONTENT_IDENTITY_FIELD = "candidateContentIdentity";
const QUICK_AUTHORIZATION_FIELD_NAMES = Object.freeze({
  source: "candidateAuthorizationSource",
  runId: "quickAnalysisRunId",
  conversationId: "quickAnalysisConversationId",
  bodyCallAttemptId: "quickAnalysisBodyCallAttemptId",
  parseCallAttemptId: "quickAnalysisParseCallAttemptId",
  sourceFileRefId: "quickAnalysisSourceFileRefId",
  sourceDirectoryFileRefId: "quickAnalysisSourceDirectoryFileRefId"
});
const STANDARD_OPERATION_AUTHORIZATION_FIELD_NAMES = Object.freeze({
  source: "candidateAuthorizationSource",
  conversationId: "standardOperationConversationId",
  parseCallAttemptId: "standardOperationParseCallAttemptId",
  parentResultId: "standardOperationParentResultId",
  effectResultId: "standardOperationEffectResultId",
  authorizationId: "standardOperationAuthorizationId",
  confirmedPayloadFingerprint: "standardOperationConfirmedPayloadFingerprint",
  parentAction: "standardOperationParentAction",
  ownerType: "standardOperationOwnerType",
  ownerId: "standardOperationOwnerId",
  manuscriptChannel: "standardOperationManuscriptChannel",
  businessReceiptEntityId: "standardOperationBusinessReceiptEntityId",
  targetSnapshotFingerprint: "standardOperationTargetSnapshotFingerprint"
});

function customFieldValue(fileRef: FileRef, name: string) {
  return fileRef.customFields.find((field) => field.name === name)?.value;
}

function validQuickAuthorization(input: SaveCandidateManuscriptInput) {
  const authorization = input.authorization;
  const callAttemptId = authorization?.source === "DERIVED_FROM_QUICK_ANALYSIS_RUN_AUTHORIZATION"
    ? authorization.bodyCallAttemptId ?? authorization.parseCallAttemptId
    : undefined;
  return authorization?.source === "DERIVED_FROM_QUICK_ANALYSIS_RUN_AUTHORIZATION" &&
    MANUSCRIPT_SEGMENT_PRODUCT_CHANNELS.some((identity) =>
      identity.ownerType === input.ownerType && identity.channel === input.manuscriptChannel) &&
    input.source === "ai" && Boolean(input.frozenWorkspace) &&
    Boolean(authorization.runId.trim()) && Boolean(authorization.conversationId.trim()) &&
    Boolean(callAttemptId?.trim()) && Boolean(authorization.sourceFileRefId.trim()) &&
    Boolean(authorization.sourceDirectoryFileRefId.trim()) &&
    authorization.sourceDirectoryFileRefId === input.frozenWorkspace?.folderFileRefId;
}

function validStandardOperationAuthorization(input: SaveCandidateManuscriptInput) {
  const authorization = input.authorization;
  if (authorization?.source !== "DERIVED_FROM_STANDARD_OPERATION_CONFIRMATION") return false;
  const exactEffectResultId = `${authorization.parentResultId}:manuscript:${authorization.manuscriptChannel}`;
  const commonValid =
    MANUSCRIPT_SEGMENT_PRODUCT_CHANNELS.some((identity) =>
      identity.ownerType === input.ownerType && identity.channel === input.manuscriptChannel) &&
    input.source === "ai" && Boolean(input.frozenWorkspace) &&
    Boolean(authorization.conversationId.trim()) &&
    Boolean(authorization.parseCallAttemptId.trim()) &&
    Boolean(authorization.parentResultId.trim()) &&
    Boolean(authorization.effectResultId.trim()) &&
    Boolean(authorization.authorizationId.trim()) &&
    Boolean(authorization.confirmedPayloadFingerprint.trim()) &&
    authorization.effectResultId === exactEffectResultId &&
    input.requestId === authorization.effectResultId &&
    authorization.ownerType === input.ownerType &&
    authorization.ownerId === input.ownerId &&
    authorization.manuscriptChannel === input.manuscriptChannel;
  if (!commonValid) return false;
  return authorization.parentAction === "CREATE"
    ? authorization.businessReceiptEntityId === input.ownerId &&
      authorization.targetSnapshotFingerprint === undefined
    : authorization.businessReceiptEntityId === undefined &&
      Boolean(authorization.targetSnapshotFingerprint.trim());
}

function requiresDerivedWorkflowAuthorization(ownerType: FileRefOwnerType) {
  return ownerType !== "literature" && ownerType !== "review" && ownerType !== "experiment";
}

function authorizationMetadataMatches(fileRef: FileRef, input: SaveCandidateManuscriptInput) {
  const authorization = input.authorization;
  if (!authorization) {
    return customFieldValue(fileRef, QUICK_AUTHORIZATION_FIELD_NAMES.source) === undefined;
  }
  if (authorization.source === "DERIVED_FROM_QUICK_ANALYSIS_RUN_AUTHORIZATION") {
    const bodyAttemptMatches = authorization.bodyCallAttemptId
      ? customFieldValue(fileRef, QUICK_AUTHORIZATION_FIELD_NAMES.bodyCallAttemptId) === authorization.bodyCallAttemptId &&
        customFieldValue(fileRef, QUICK_AUTHORIZATION_FIELD_NAMES.parseCallAttemptId) === undefined
      : customFieldValue(fileRef, QUICK_AUTHORIZATION_FIELD_NAMES.parseCallAttemptId) === authorization.parseCallAttemptId &&
        customFieldValue(fileRef, QUICK_AUTHORIZATION_FIELD_NAMES.bodyCallAttemptId) === undefined;
    return customFieldValue(fileRef, QUICK_AUTHORIZATION_FIELD_NAMES.source) === authorization.source &&
      customFieldValue(fileRef, QUICK_AUTHORIZATION_FIELD_NAMES.runId) === authorization.runId &&
      customFieldValue(fileRef, QUICK_AUTHORIZATION_FIELD_NAMES.conversationId) === authorization.conversationId &&
      bodyAttemptMatches &&
      customFieldValue(fileRef, QUICK_AUTHORIZATION_FIELD_NAMES.sourceFileRefId) === authorization.sourceFileRefId &&
      customFieldValue(fileRef, QUICK_AUTHORIZATION_FIELD_NAMES.sourceDirectoryFileRefId) === authorization.sourceDirectoryFileRefId &&
      customFieldValue(fileRef, STANDARD_OPERATION_AUTHORIZATION_FIELD_NAMES.parentResultId) === undefined;
  }
  if (authorization.source === "EXPLICIT_USER_CONFIRMATION") {
    return customFieldValue(fileRef, QUICK_AUTHORIZATION_FIELD_NAMES.source) === undefined;
  }
  return customFieldValue(fileRef, STANDARD_OPERATION_AUTHORIZATION_FIELD_NAMES.source) === authorization.source &&
    customFieldValue(fileRef, STANDARD_OPERATION_AUTHORIZATION_FIELD_NAMES.conversationId) === authorization.conversationId &&
    customFieldValue(fileRef, STANDARD_OPERATION_AUTHORIZATION_FIELD_NAMES.parseCallAttemptId) === authorization.parseCallAttemptId &&
    customFieldValue(fileRef, STANDARD_OPERATION_AUTHORIZATION_FIELD_NAMES.parentResultId) === authorization.parentResultId &&
    customFieldValue(fileRef, STANDARD_OPERATION_AUTHORIZATION_FIELD_NAMES.effectResultId) === authorization.effectResultId &&
    customFieldValue(fileRef, STANDARD_OPERATION_AUTHORIZATION_FIELD_NAMES.authorizationId) === authorization.authorizationId &&
    customFieldValue(fileRef, STANDARD_OPERATION_AUTHORIZATION_FIELD_NAMES.confirmedPayloadFingerprint) === authorization.confirmedPayloadFingerprint &&
    customFieldValue(fileRef, STANDARD_OPERATION_AUTHORIZATION_FIELD_NAMES.parentAction) === authorization.parentAction &&
    customFieldValue(fileRef, STANDARD_OPERATION_AUTHORIZATION_FIELD_NAMES.ownerType) === authorization.ownerType &&
    customFieldValue(fileRef, STANDARD_OPERATION_AUTHORIZATION_FIELD_NAMES.ownerId) === authorization.ownerId &&
    customFieldValue(fileRef, STANDARD_OPERATION_AUTHORIZATION_FIELD_NAMES.manuscriptChannel) === authorization.manuscriptChannel &&
    customFieldValue(fileRef, STANDARD_OPERATION_AUTHORIZATION_FIELD_NAMES.businessReceiptEntityId) === authorization.businessReceiptEntityId &&
    customFieldValue(fileRef, STANDARD_OPERATION_AUTHORIZATION_FIELD_NAMES.targetSnapshotFingerprint) === authorization.targetSnapshotFingerprint &&
    customFieldValue(fileRef, QUICK_AUTHORIZATION_FIELD_NAMES.runId) === undefined;
}

function authorizationCustomFields(input: SaveCandidateManuscriptInput) {
  const authorization = input.authorization;
  if (!authorization) return [];
  if (authorization.source === "EXPLICIT_USER_CONFIRMATION") return [];
  const entries = authorization.source === "DERIVED_FROM_QUICK_ANALYSIS_RUN_AUTHORIZATION"
    ? [
        [QUICK_AUTHORIZATION_FIELD_NAMES.source, authorization.source],
        [QUICK_AUTHORIZATION_FIELD_NAMES.runId, authorization.runId],
        [QUICK_AUTHORIZATION_FIELD_NAMES.conversationId, authorization.conversationId],
        [
          authorization.bodyCallAttemptId
            ? QUICK_AUTHORIZATION_FIELD_NAMES.bodyCallAttemptId
            : QUICK_AUTHORIZATION_FIELD_NAMES.parseCallAttemptId,
          authorization.bodyCallAttemptId ?? authorization.parseCallAttemptId
        ],
        [QUICK_AUTHORIZATION_FIELD_NAMES.sourceFileRefId, authorization.sourceFileRefId],
        [QUICK_AUTHORIZATION_FIELD_NAMES.sourceDirectoryFileRefId, authorization.sourceDirectoryFileRefId]
      ]
    : [
        [STANDARD_OPERATION_AUTHORIZATION_FIELD_NAMES.source, authorization.source],
        [STANDARD_OPERATION_AUTHORIZATION_FIELD_NAMES.conversationId, authorization.conversationId],
        [STANDARD_OPERATION_AUTHORIZATION_FIELD_NAMES.parseCallAttemptId, authorization.parseCallAttemptId],
        [STANDARD_OPERATION_AUTHORIZATION_FIELD_NAMES.parentResultId, authorization.parentResultId],
        [STANDARD_OPERATION_AUTHORIZATION_FIELD_NAMES.effectResultId, authorization.effectResultId],
        [STANDARD_OPERATION_AUTHORIZATION_FIELD_NAMES.authorizationId, authorization.authorizationId],
        [STANDARD_OPERATION_AUTHORIZATION_FIELD_NAMES.confirmedPayloadFingerprint, authorization.confirmedPayloadFingerprint],
        [STANDARD_OPERATION_AUTHORIZATION_FIELD_NAMES.parentAction, authorization.parentAction],
        [STANDARD_OPERATION_AUTHORIZATION_FIELD_NAMES.ownerType, authorization.ownerType],
        [STANDARD_OPERATION_AUTHORIZATION_FIELD_NAMES.ownerId, authorization.ownerId],
        [STANDARD_OPERATION_AUTHORIZATION_FIELD_NAMES.manuscriptChannel, authorization.manuscriptChannel],
        [STANDARD_OPERATION_AUTHORIZATION_FIELD_NAMES.businessReceiptEntityId, authorization.businessReceiptEntityId],
        [STANDARD_OPERATION_AUTHORIZATION_FIELD_NAMES.targetSnapshotFingerprint, authorization.targetSnapshotFingerprint]
      ];
  return entries
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([name, value], index) => ({
      id: `${authorization.source === "DERIVED_FROM_QUICK_ANALYSIS_RUN_AUTHORIZATION" ? "quick-analysis" : "standard-operation"}-${input.requestId}-${index}`,
      name,
      value,
      valueType: "text" as const,
      group: authorization.source === "DERIVED_FROM_QUICK_ANALYSIS_RUN_AUTHORIZATION"
        ? "quickAnalysisAuthorization"
        : "standardOperationAuthorization"
    }));
}

function persistedCandidateContentIdentity(fileRef: FileRef) {
  return fileRef.customFields.find(
    (field) => field.name === CANDIDATE_CONTENT_IDENTITY_FIELD
  )?.value;
}

function candidateContentIdentity(content: string) {
  let hashA = 0x811c9dc5;
  let hashB = 0x9e3779b1;
  for (const byte of new TextEncoder().encode(content)) {
    hashA ^= byte;
    hashA = Math.imul(hashA, 0x01000193) >>> 0;
    hashB ^= byte;
    hashB = Math.imul(hashB, 0x01000193) >>> 0;
  }
  return `${hashA.toString(16).padStart(8, "0")}${hashB.toString(16).padStart(8, "0")}`;
}

function metadataMatches(fileRef: FileRef, input: SaveCandidateManuscriptInput, plan: CandidatePathPlan, contentIdentity: string) {
  const persistedContentIdentity = persistedCandidateContentIdentity(fileRef);
  return fileRef.candidateRequestId === input.requestId
    && fileRef.candidateOccurredAt === input.occurredAt
    && fileRef.source === input.source
    && (fileRef.manuscriptChannel ?? "primary") === plan.manuscriptChannel
    && fileRef.pathIdentityKey === plan.pathIdentityKey
    && fileRef.resourceKind === "file"
    && fileRef.fileRole === "manuscript"
    && fileRef.locationMode === "managed"
    && persistedContentIdentity === contentIdentity
    && authorizationMetadataMatches(fileRef, input);
}

export function createCandidateManuscriptService(overrides: Partial<CandidateManuscriptDependencies> = {}) {
  const dependencies = { ...defaultDependencies, ...overrides };

  async function resolveDefaultFolder(
    input: SaveCandidateManuscriptInput,
    owner: FileRefOwnerContext
  ): Promise<
    | { status: "success"; binding: ManuscriptBinding; folder: FileRef; provisioned: boolean }
    | { status: "error"; result: SaveCandidateManuscriptResult }
  > {
    const manuscriptChannel = input.manuscriptChannel ?? "primary";
    let binding = await dependencies.getBinding(input.ownerType, input.ownerId, manuscriptChannel);
    let provisioned = false;
    if (!binding?.defaultFolderFileRefId) {
      if (input.frozenWorkspace) {
        return { status: "error", result: saveFailure(
          input,
          CANDIDATE_MANUSCRIPT_ERROR_CODES.defaultFolderMissing,
          "The frozen Candidate workspace is no longer bound; silent provisioning is forbidden.",
          "frozen-workspace"
        ) };
      }
      const provision = await dependencies.provisionOwner(input, owner);
      if ((provision.status !== "success" && provision.status !== "skipped") || !provision.binding?.defaultFolderFileRefId) {
        return { status: "error", result: saveFailure(
          input,
          CANDIDATE_MANUSCRIPT_ERROR_CODES.provisioningFailed,
          provision.errors?.map((error) => error.message).join("; ") || "Owner provisioning failed.",
          "provisioning",
          { status: provision.status === "partial" ? "partial" : "error", retryable: provision.status === "partial" }
        ) };
      }
      binding = await dependencies.getBinding(input.ownerType, input.ownerId, manuscriptChannel) ?? provision.binding;
      provisioned = true;
    }
    if (!binding?.defaultFolderFileRefId) {
      return { status: "error", result: saveFailure(input, CANDIDATE_MANUSCRIPT_ERROR_CODES.defaultFolderMissing, "Default managed folder is not set.", "default-folder") };
    }
    if (input.ownerType === "literature") {
      const otherChannel: ManuscriptChannel = manuscriptChannel === "literature_outline"
        ? "dedicated_notes"
        : "literature_outline";
      const otherBinding = await dependencies.getBinding(input.ownerType, input.ownerId, otherChannel);
      if (!otherBinding?.defaultFolderFileRefId || otherBinding.defaultFolderFileRefId !== binding.defaultFolderFileRefId) {
        return { status: "error", result: saveFailure(
          input,
          CANDIDATE_MANUSCRIPT_ERROR_CODES.incompleteState,
          "Literature Candidate channels must resolve to one shared workspace folder.",
          "workspace-invariant"
        ) };
      }
    }
    const folder = await dependencies.getFileRef(binding.defaultFolderFileRefId);
    if (!folder) {
      const deleted = await dependencies.getDeletedFileRef(binding.defaultFolderFileRefId);
      return { status: "error", result: saveFailure(
        input,
        CANDIDATE_MANUSCRIPT_ERROR_CODES.defaultFolderInvalid,
        deleted ? "Default folder FileRef is deleted." : "Default folder FileRef was not found.",
        "default-folder"
      ) };
    }
    if (folder.deletedAt || folder.ownerType !== input.ownerType || folder.ownerId !== input.ownerId
      || folder.resourceKind !== "folder" || folder.fileRole !== "defaultFolder" || folder.locationMode !== "managed") {
      return { status: "error", result: saveFailure(
        input,
        CANDIDATE_MANUSCRIPT_ERROR_CODES.defaultFolderInvalid,
        "Default folder FileRef does not satisfy the managed folder contract.",
        "default-folder"
      ) };
    }
    if (input.frozenWorkspace && (
      folder.id !== input.frozenWorkspace.folderFileRefId ||
      folder.pathIdentityKey !== input.frozenWorkspace.directoryPathIdentityKey
    )) {
      return { status: "error", result: saveFailure(
        input,
        CANDIDATE_MANUSCRIPT_ERROR_CODES.defaultFolderInvalid,
        "The canonical default folder no longer matches the frozen Quick Analysis source directory.",
        "frozen-workspace"
      ) };
    }
    return { status: "success", binding, folder, provisioned };
  }

  function buildPathPlan(input: SaveCandidateManuscriptInput, root: string, workspace: string): CandidatePathPlan {
    const configuredRoot = normalizeManagedRoot(root);
    const workspaceDirectory = createPathIdentityKey(workspace);
    if (workspaceDirectory === configuredRoot || !isPathWithinRoot(configuredRoot, workspaceDirectory)) {
      throw new Error("CANDIDATE_PATH_OUTSIDE_ROOT: Candidate workspace is outside the managed root.");
    }
    if (input.ownerType === "literature") {
      const filename = buildLiteratureCandidateFileName({
        manuscriptChannel: input.manuscriptChannel ?? "primary",
        source: input.source,
        occurredAt: input.occurredAt,
        requestId: input.requestId
      });
      const absolutePath = buildManagedManuscriptPath(workspaceDirectory, filename.fileName);
      return {
        configuredRoot,
        workspaceDirectory,
        layout: "workspaceRoot",
        manuscriptChannel: filename.manuscriptChannel,
        fileName: filename.fileName,
        absolutePath,
        pathIdentityKey: createPathIdentityKey(absolutePath),
        requestShortId: filename.requestShortId,
        warnings: []
      };
    }
    if (input.ownerType === "review") {
      const filename = buildReviewCandidateFileName({
        ownerType: input.ownerType,
        manuscriptChannel: "primary",
        source: input.source,
        occurredAt: input.occurredAt,
        requestId: input.requestId
      });
      const absolutePath = buildManagedManuscriptPath(workspaceDirectory, filename.fileName);
      return {
        configuredRoot,
        workspaceDirectory,
        layout: "workspaceRoot",
        manuscriptChannel: "primary",
        fileName: filename.fileName,
        absolutePath,
        pathIdentityKey: createPathIdentityKey(absolutePath),
        requestShortId: filename.requestShortId,
        warnings: []
      };
    }
    if (input.ownerType === "experiment") {
      const filename = buildExperimentCandidateFileName({
        ownerType: input.ownerType,
        manuscriptChannel: "primary",
        source: input.source,
        occurredAt: input.occurredAt,
        requestId: input.requestId
      });
      const absolutePath = buildManagedManuscriptPath(workspaceDirectory, filename.fileName);
      return {
        configuredRoot,
        workspaceDirectory,
        layout: "workspaceRoot",
        manuscriptChannel: "primary",
        fileName: filename.fileName,
        absolutePath,
        pathIdentityKey: createPathIdentityKey(absolutePath),
        requestShortId: filename.requestShortId,
        warnings: []
      };
    }
    if (
      input.ownerType === "experimentRun" || input.ownerType === "resultItem" ||
      input.ownerType === "finding" || input.ownerType === "outputCandidate" ||
      input.ownerType === "outputGap" || input.ownerType === "researchOutput"
    ) {
      const filename = buildQuickAnalysisPrimaryCandidateFileName({
        ownerType: input.ownerType,
        manuscriptChannel: "primary",
        source: input.source,
        occurredAt: input.occurredAt,
        requestId: input.requestId
      });
      const absolutePath = buildManagedManuscriptPath(workspaceDirectory, filename.fileName);
      return {
        configuredRoot,
        workspaceDirectory,
        layout: "workspaceRoot",
        manuscriptChannel: "primary",
        fileName: filename.fileName,
        absolutePath,
        pathIdentityKey: createPathIdentityKey(absolutePath),
        requestShortId: filename.requestShortId,
        warnings: []
      };
    }
    throw new Error("CANDIDATE_OWNER_UNSUPPORTED: Candidate manuscripts are unsupported for this owner.");
  }

  return {
    async saveCandidate(input: SaveCandidateManuscriptInput): Promise<SaveCandidateManuscriptResult> {
      if (input.ownerType === "literature" && !input.manuscriptChannel) {
        return saveFailure(input, CANDIDATE_MANUSCRIPT_ERROR_CODES.channelRequired, "Literature Candidate channel is required.", "input");
      }
      if (!MANUSCRIPT_SEGMENT_PRODUCT_CHANNELS.some((identity) =>
        identity.ownerType === input.ownerType && identity.channel === input.manuscriptChannel)) {
        return saveFailure(input, CANDIDATE_MANUSCRIPT_ERROR_CODES.channelUnsupported, "Candidate manuscripts are unsupported for this owner.", "input");
      }
      const quickAuthorizationDeclared =
        input.authorization?.source === "DERIVED_FROM_QUICK_ANALYSIS_RUN_AUTHORIZATION";
      const quickAuthorizationValid = validQuickAuthorization(input);
      const standardAuthorizationDeclared =
        input.authorization?.source === "DERIVED_FROM_STANDARD_OPERATION_CONFIRMATION";
      const standardAuthorizationValid = validStandardOperationAuthorization(input);
      const derivedAuthorizationValid = quickAuthorizationValid || standardAuthorizationValid;
      if (quickAuthorizationDeclared && !quickAuthorizationValid) {
        return saveFailure(input, CANDIDATE_MANUSCRIPT_ERROR_CODES.notConfirmed, "Quick Analysis Candidate authorization provenance is incomplete.", "authorization");
      }
      if (standardAuthorizationDeclared && !standardAuthorizationValid) {
        return saveFailure(input, CANDIDATE_MANUSCRIPT_ERROR_CODES.notConfirmed, "Standard Operation Candidate authorization provenance is incomplete.", "authorization");
      }
      if (requiresDerivedWorkflowAuthorization(input.ownerType) && !derivedAuthorizationValid) {
        return saveFailure(
          input,
          CANDIDATE_MANUSCRIPT_ERROR_CODES.notConfirmed,
          "This owner accepts Candidate creation only through a canonical derived workflow authorization.",
          "authorization"
        );
      }
      if (input.confirmedByUser !== true && !derivedAuthorizationValid) {
        return saveFailure(input, CANDIDATE_MANUSCRIPT_ERROR_CODES.notConfirmed, "Candidate save requires explicit user confirmation.", "confirmation");
      }
      try {
        validateCandidateRequestId(input.requestId);
      } catch (error) {
        return saveFailure(input, CANDIDATE_MANUSCRIPT_ERROR_CODES.requestIdInvalid, error instanceof Error ? error.message : String(error), "input");
      }
      try {
        parseCandidateOccurredAt(input.occurredAt);
      } catch (error) {
        return saveFailure(input, CANDIDATE_MANUSCRIPT_ERROR_CODES.occurredAtInvalid, error instanceof Error ? error.message : String(error), "input");
      }
      if (input.source !== "user" && input.source !== "ai") {
        return saveFailure(input, CANDIDATE_MANUSCRIPT_ERROR_CODES.sourceInvalid, "Candidate source must be user or ai.", "input");
      }
      if (input.ownerType === "literature" && input.manuscriptChannel !== "literature_outline" && input.manuscriptChannel !== "dedicated_notes") {
        return saveFailure(input, CANDIDATE_MANUSCRIPT_ERROR_CODES.channelUnsupported, "Literature Candidate channel is unsupported.", "input");
      }
      if (input.ownerType === "experiment" && input.manuscriptChannel !== "primary") {
        return saveFailure(input, CANDIDATE_MANUSCRIPT_ERROR_CODES.channelUnsupported, "Experiment Candidate channel must be primary.", "input");
      }
      if (input.ownerType === "review" && input.manuscriptChannel !== "primary") {
        return saveFailure(input, CANDIDATE_MANUSCRIPT_ERROR_CODES.channelUnsupported, "Review Candidate channel must be primary.", "input");
      }
      if (
        input.ownerType !== "literature" && input.ownerType !== "experiment" && input.ownerType !== "review" &&
        input.manuscriptChannel !== "primary"
      ) {
        return saveFailure(input, CANDIDATE_MANUSCRIPT_ERROR_CODES.channelUnsupported, "Candidate channel must be primary for this owner.", "input");
      }
      if (!derivedAuthorizationValid && !dependencies.isRequestCurrent(input.requestToken)) {
        return saveFailure(input, CANDIDATE_MANUSCRIPT_ERROR_CODES.saveStale, "Candidate save request is stale.", "request-token", { retryable: true });
      }

      let owner: FileRefOwnerContext;
      try {
        owner = await dependencies.validateOwner(input.ownerType, input.ownerId);
      } catch (error) {
        return saveFailure(input, ownerError(error), error instanceof Error ? error.message : String(error), "owner-validation");
      }
      const resolved = await resolveDefaultFolder(input, owner);
      if (resolved.status === "error") return resolved.result;
      const completedSteps = resolved.provisioned ? ["provisioning"] : [];
      if (!derivedAuthorizationValid && !dependencies.isRequestCurrent(input.requestToken)) {
        return saveFailure(input, CANDIDATE_MANUSCRIPT_ERROR_CODES.saveStale, "Candidate save became stale after provisioning.", "request-token", {
          status: resolved.provisioned ? "partial" : "error", retryable: true, completedSteps
        });
      }
      const rootStatus = await dependencies.getRootStatus();
      if (rootStatus.status !== "configured") {
        return saveFailure(input, CANDIDATE_MANUSCRIPT_ERROR_CODES.pathInvalid, "Managed root is unavailable.", "root-validation", { completedSteps });
      }
      let plan: CandidatePathPlan;
      try {
        plan = buildPathPlan(input, rootStatus.managedRoot, resolved.folder.path);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return saveFailure(input, codeFromMessage(message), message, "path-build", { completedSteps });
      }

      let markdown: string;
      let parseStatus: "valid" | "valid-empty";
      try {
        if (input.ownerType === "literature") {
          assertLiteratureDocumentV2({ metaSnapshot: input.metaSnapshot, outline: input.outline, channel: plan.manuscriptChannel });
        }
        markdown = serializeLabPodMarkdownDocument({ metaSnapshot: input.metaSnapshot, outline: input.outline, body: input.body });
        const parsed = parseLabPodMarkdownDocument(markdown);
        if (parsed.status !== "valid" && parsed.status !== "valid-empty") throw new Error(`Unexpected serialized status: ${parsed.status}.`);
        parseStatus = parsed.status;
      } catch (error) {
        return saveFailure(input, CANDIDATE_MANUSCRIPT_ERROR_CODES.serializeFailed, error instanceof Error ? error.message : String(error), "serialize", {
          fileName: plan.fileName,
          path: plan.absolutePath,
          pathSummary: plan.fileName,
          pathIdentityKey: plan.pathIdentityKey,
          requestShortId: plan.requestShortId,
          completedSteps
        });
      }
      completedSteps.push("serialize");
      const contentSizeBytes = new TextEncoder().encode(markdown).length;
      const contentIdentity = candidateContentIdentity(markdown);
      const ownerFileRefs = await dependencies.getOwnerFileRefs(input.ownerType, input.ownerId);
      const requestRefs = ownerFileRefs.filter((fileRef) => fileRef.candidateRequestId === input.requestId);
      if (requestRefs.length > 1) {
        return saveFailure(input, CANDIDATE_MANUSCRIPT_ERROR_CODES.incompleteState, "Candidate request resolves to multiple FileRefs.", "request-identity", {
          status: "conflict", fileName: plan.fileName, pathSummary: plan.fileName, path: plan.absolutePath, pathIdentityKey: plan.pathIdentityKey,
          requestShortId: plan.requestShortId, contentSizeBytes, parseStatus, completedSteps
        });
      }
      if (requestRefs[0] && persistedCandidateContentIdentity(requestRefs[0]) !== contentIdentity) {
        return saveFailure(input, CANDIDATE_MANUSCRIPT_ERROR_CODES.contentConflict, "Candidate request content identity does not match its persisted FileRef.", "request-identity", {
          status: "conflict", fileRefId: requestRefs[0].id, fileRef: requestRefs[0], fileName: plan.fileName,
          pathSummary: plan.fileName, path: plan.absolutePath, pathIdentityKey: plan.pathIdentityKey,
          requestShortId: plan.requestShortId, contentSizeBytes, parseStatus, completedSteps
        });
      }
      if (requestRefs[0] && !metadataMatches(requestRefs[0], input, plan, contentIdentity)) {
        return saveFailure(input, CANDIDATE_MANUSCRIPT_ERROR_CODES.requestMetadataConflict, "Candidate request metadata does not match its persisted FileRef.", "request-identity", {
          status: "conflict", fileRefId: requestRefs[0].id, fileRef: requestRefs[0], fileName: plan.fileName,
          pathSummary: plan.fileName, path: plan.absolutePath, pathIdentityKey: plan.pathIdentityKey,
          requestShortId: plan.requestShortId, contentSizeBytes, parseStatus, completedSteps
        });
      }
      const pathRef = ownerFileRefs.find((fileRef) => fileRef.pathIdentityKey === plan.pathIdentityKey);
      if (pathRef && pathRef.candidateRequestId !== input.requestId) {
        return saveFailure(input, CANDIDATE_MANUSCRIPT_ERROR_CODES.filenameConflict, `Candidate filename conflicts with FileRef ${pathRef.id}.`, "filename-identity", {
          status: "conflict", fileRefId: pathRef.id, fileRef: pathRef, fileName: plan.fileName, pathSummary: plan.fileName,
          path: plan.absolutePath, pathIdentityKey: plan.pathIdentityKey, requestShortId: plan.requestShortId,
          contentSizeBytes, parseStatus, completedSteps
        });
      }

      let native: NativeCreateCandidateManuscriptResult;
      try {
        native = await dependencies.createCandidateFile({
          configuredRoot: plan.configuredRoot,
          workspaceDirectory: plan.workspaceDirectory,
          layout: plan.layout,
          ownerType: input.ownerType,
          manuscriptChannel: plan.manuscriptChannel,
          source: input.source,
          occurredAt: input.occurredAt,
          requestId: input.requestId,
          expectedFileName: plan.fileName,
          content: markdown
        });
      } catch (error) {
        return saveFailure(input, CANDIDATE_MANUSCRIPT_ERROR_CODES.fileCreateFailed, error instanceof Error ? error.message : String(error), "filesystem", {
          status: "partial", fileName: plan.fileName, pathSummary: plan.fileName, path: plan.absolutePath,
          pathIdentityKey: plan.pathIdentityKey, requestShortId: plan.requestShortId, contentSizeBytes, parseStatus,
          completedSteps: [...completedSteps, "filesystem-outcome-unknown"], retryable: true
        });
      }
      if (native.status === "error" || native.status === "partial") {
        const contentConflict = native.errorCode === "CANDIDATE_IDEMPOTENCY_CONFLICT" || native.errorCode === "CANDIDATE_CONTENT_CONFLICT";
        return saveFailure(input, contentConflict ? CANDIDATE_MANUSCRIPT_ERROR_CODES.contentConflict : (native.errorCode ?? CANDIDATE_MANUSCRIPT_ERROR_CODES.fileCreateFailed), native.errorMessage ?? "Candidate filesystem operation failed.", "filesystem", {
          status: contentConflict ? "conflict" : native.status, fileName: plan.fileName, pathSummary: plan.fileName,
          path: native.path || plan.absolutePath, pathIdentityKey: plan.pathIdentityKey, requestShortId: plan.requestShortId,
          createdFile: native.createdFile, reusedFile: native.reusedFile, contentSizeBytes, parseStatus,
          completedSteps, retryable: contentConflict ? false : native.retryable
        });
      }
      let actualPathIdentity = "";
      try { actualPathIdentity = createPathIdentityKey(native.path); } catch { /* handled below */ }
      if (native.fileName !== plan.fileName || actualPathIdentity !== plan.pathIdentityKey) {
        return saveFailure(input, CANDIDATE_MANUSCRIPT_ERROR_CODES.pathInvalid, "Native candidate path does not match the planned path identity.", "filesystem-result", {
          status: "partial", fileName: plan.fileName, pathSummary: plan.fileName, path: native.path,
          pathIdentityKey: actualPathIdentity || plan.pathIdentityKey, requestShortId: plan.requestShortId,
          createdFile: native.createdFile, reusedFile: native.reusedFile, contentSizeBytes, parseStatus,
          completedSteps: [...completedSteps, "candidate-file"], retryable: true
        });
      }
      completedSteps.push("candidate-file");
      if (!derivedAuthorizationValid && !dependencies.isRequestCurrent(input.requestToken)) {
        return saveFailure(input, CANDIDATE_MANUSCRIPT_ERROR_CODES.saveStale, "Candidate file was created or reused after the request became stale.", "request-token", {
          status: "partial", fileName: plan.fileName, pathSummary: plan.fileName, path: native.path,
          pathIdentityKey: plan.pathIdentityKey, requestShortId: plan.requestShortId, createdFile: native.createdFile,
          reusedFile: native.reusedFile, contentSizeBytes, parseStatus, completedSteps, retryable: true
        });
      }

      let ensured;
      try {
        ensured = await dependencies.registerFileRef({
          ownerType: input.ownerType,
          ownerId: input.ownerId,
          manuscriptChannel: plan.manuscriptChannel,
          resourceKind: "file",
          fileRole: "manuscript",
          locationMode: "managed",
          fileType: "markdown",
          path: native.path,
          title: plan.fileName,
          source: input.source,
          candidateRequestId: input.requestId,
          candidateOccurredAt: input.occurredAt,
          customFields: [{
            id: `candidate-content-${input.requestId}`,
            name: CANDIDATE_CONTENT_IDENTITY_FIELD,
            value: contentIdentity,
            valueType: "text",
            group: "candidateIdentity"
          }, ...authorizationCustomFields(input)]
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const concurrent = (await dependencies.getOwnerFileRefs(input.ownerType, input.ownerId))
          .find((fileRef) => fileRef.candidateRequestId === input.requestId && !fileRef.deletedAt);
        if (concurrent && metadataMatches(concurrent, input, plan, contentIdentity)) {
          ensured = { fileRef: concurrent, state: "reused" as const };
        } else if (concurrent) {
          return saveFailure(input, CANDIDATE_MANUSCRIPT_ERROR_CODES.requestMetadataConflict, "A concurrent Candidate FileRef used the request ID with different metadata.", "file-ref", {
            status: "conflict", fileRefId: concurrent.id, fileRef: concurrent, fileName: plan.fileName,
            pathSummary: plan.fileName, path: native.path, pathIdentityKey: concurrent.pathIdentityKey,
            requestShortId: plan.requestShortId, createdFile: native.createdFile, reusedFile: native.reusedFile,
            contentSizeBytes, parseStatus, completedSteps, retryable: false
          });
        } else {
          return saveFailure(input, message.includes("FILE_REF_IDENTITY_CONFLICT")
            ? CANDIDATE_MANUSCRIPT_ERROR_CODES.fileRefIdentityConflict
            : CANDIDATE_MANUSCRIPT_ERROR_CODES.fileRefFailed, message, "file-ref", {
            status: "partial", fileName: plan.fileName, pathSummary: plan.fileName, path: native.path,
            pathIdentityKey: plan.pathIdentityKey, requestShortId: plan.requestShortId, createdFile: native.createdFile,
            reusedFile: native.reusedFile, contentSizeBytes, parseStatus, completedSteps, retryable: true
          });
        }
      }
      if (!metadataMatches(ensured.fileRef, input, plan, contentIdentity)) {
        return saveFailure(input, CANDIDATE_MANUSCRIPT_ERROR_CODES.requestMetadataConflict, "Candidate FileRef metadata does not match the request.", "file-ref", {
          status: "conflict", fileRefId: ensured.fileRef.id, fileRef: ensured.fileRef, fileName: plan.fileName,
          pathSummary: plan.fileName, path: native.path, pathIdentityKey: ensured.fileRef.pathIdentityKey,
          requestShortId: plan.requestShortId, createdFile: native.createdFile, reusedFile: native.reusedFile,
          contentSizeBytes, parseStatus, completedSteps, retryable: false
        });
      }
      completedSteps.push("file-ref");
      publishCandidateSavedRefresh(input, ensured.fileRef.id);
      const stale = !derivedAuthorizationValid && !dependencies.isRequestCurrent(input.requestToken);
      return {
        ...emptyResult(input),
        status: stale ? "partial" : native.status === "skipped" && ensured.state === "reused" ? "skipped" : "success",
        fileName: plan.fileName,
        pathSummary: plan.fileName,
        requestShortId: plan.requestShortId,
        fileRefId: ensured.fileRef.id,
        fileRef: ensured.fileRef,
        path: native.path,
        pathIdentityKey: ensured.fileRef.pathIdentityKey,
        createdFile: native.createdFile,
        reusedFile: native.reusedFile,
        createdFileRef: ensured.state === "created",
        contentSizeBytes,
        parseStatus,
        warnings: stale ? [CANDIDATE_MANUSCRIPT_ERROR_CODES.saveStale] : plan.warnings,
        errors: stale ? [{ code: CANDIDATE_MANUSCRIPT_ERROR_CODES.saveStale, message: "Candidate FileRef completed after the request became stale.", step: "request-token" }] : [],
        completedSteps,
        failedStep: stale ? "request-token" : undefined,
        retryable: stale,
        currentChanged: false
      };
    },

    async setCandidateAsCurrent(input: SetCandidateAsCurrentInput): Promise<SetCandidateAsCurrentResult> {
      if (input.ownerType !== "literature" && input.ownerType !== "review") {
        return { status: "error", error: { code: CANDIDATE_MANUSCRIPT_ERROR_CODES.setCurrentInvalidTarget, message: "Candidate manuscripts are supported only for Literature and Review." }, requestToken: input.requestToken };
      }
      if (input.confirmedByUser !== true) {
        return { status: "error", error: { code: CANDIDATE_MANUSCRIPT_ERROR_CODES.setCurrentNotConfirmed, message: "Setting a candidate as current requires separate user confirmation." }, requestToken: input.requestToken };
      }
      if (!dependencies.isRequestCurrent(input.requestToken)) {
        return { status: "error", error: { code: CANDIDATE_MANUSCRIPT_ERROR_CODES.setCurrentStale, message: "Candidate set-current request is stale." }, requestToken: input.requestToken };
      }
      const candidate = await dependencies.getFileRef(input.candidateFileRefId);
      if (!candidate || candidate.deletedAt || candidate.ownerType !== input.ownerType || candidate.ownerId !== input.ownerId
        || candidate.resourceKind !== "file" || candidate.fileRole !== "manuscript"
        || (candidate.manuscriptChannel ?? "primary") !== (input.manuscriptChannel ?? "primary")
        || candidate.locationMode !== "managed" || !candidate.candidateRequestId || !candidate.candidateOccurredAt
        || (candidate.source !== "user" && candidate.source !== "ai")) {
        return { status: "error", error: { code: CANDIDATE_MANUSCRIPT_ERROR_CODES.setCurrentInvalidTarget, message: "Candidate FileRef must be an active managed candidate manuscript for the same owner and channel." }, requestToken: input.requestToken };
      }
      const switched = await dependencies.switchCurrent({
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        manuscriptChannel: input.manuscriptChannel ?? "primary",
        targetFileRefId: input.candidateFileRefId,
        currentEditorState: input.currentEditorState,
        switchReason: "candidate",
        dirtyDecision: input.dirtyDecision,
        confirmedDiscardUnsavedChanges: input.confirmedDiscardUnsavedChanges,
        requestToken: input.requestToken
      });
      if (switched.status === "error") {
        return { status: "error", error: {
          code: switched.error.code === "MANUSCRIPT_SWITCH_STALE"
            ? CANDIDATE_MANUSCRIPT_ERROR_CODES.setCurrentStale
            : CANDIDATE_MANUSCRIPT_ERROR_CODES.setCurrentFailed,
          message: switched.error.message
        }, requestToken: input.requestToken };
      }
      publishCandidateCurrentRefresh(input);
      return { status: switched.status, switchResult: switched, requestToken: input.requestToken };
    }
  };
}

export const candidateManuscriptService = createCandidateManuscriptService();
