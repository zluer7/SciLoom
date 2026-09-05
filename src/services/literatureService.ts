import {
  literatureLinkRepository,
  literatureRepository
} from "../repositories/literatureRepository";
import type {
  EntityId,
  Literature,
  LiteratureImportance,
  LiteratureLink,
  LiteratureLinkTargetType,
  LiteratureReadingStatus,
  LiteratureRelationType,
  LiteratureStandardResultOperationCorrelation,
  LiteratureType
} from "../types";
import type { CreateEntityInput, UpdateEntityInput } from "../types/common";
import type { LinkWriteValidationIssue } from "../types/entityReference";
import { LITERATURE_SCHEMA_VERSION } from "../types/literature";
import type { LiteratureArchiveStatus } from "../types/literature";
import type { OperationImpactSummary } from "../types/operationLog";
import {
  literatureLinkToTargetReference,
  validateEntityReference
} from "./entityReferenceResolverService";
import {
  createCrossModuleWriteFeedback,
  publishCrossModuleWriteFeedback
} from "./crossModuleWriteFeedbackService";
import type { AffectedEntity, RefreshKey, WriteFeedbackResult } from "../types/writeFeedback";
import {
  createOperationLog,
  summarizeFeedbackForOperationLog
} from "./operationLogService";
import { recordRecycleEntry } from "./recycleBinService";
import { ensureLiteratureManuscriptProvisioned } from "./literatureManuscriptProvisioningService";
import { getProjectById } from "./planningService";
import type { ProvisionManagedOwnerResult } from "../types/provisioning";
import { addWriteFeedbackWarning } from "./writeFeedbackService";
import { sharedManuscriptSessionRuntime } from "./sharedManuscriptSessionComposition";
import { resolveMountedManuscriptLifecycleDecision } from "./fileRefOwnerValidator";

type DefaultCreateKeys = "id" | "createdAt" | "updatedAt" | "deletedAt" | "schemaVersion";
type DefaultUpdateKeys = DefaultCreateKeys;

export type CreateLiteratureInput = Pick<Literature, "title"> &
  Partial<Omit<Literature, DefaultCreateKeys | "title">>;

export type UpdateLiteratureInput = Partial<Omit<Literature, DefaultUpdateKeys>>;

export type LiteratureStandardResultOperationInput = Omit<
  LiteratureStandardResultOperationCorrelation,
  "appliedUpdatedAt"
> & {
  occurredAt: string;
};

export type CreateLiteratureWithOperationInput = Omit<
  CreateLiteratureInput,
  "aiMetadata" | "primaryProjectId" | "source"
>;

export type UpdateLiteratureWithOperationInput = Omit<
  UpdateLiteratureInput,
  "aiMetadata" | "primaryProjectId" | "source"
>;

export class LiteratureOperationConflictError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "LiteratureOperationConflictError";
  }
}

export interface LiteratureCreateResult {
  status: "success" | "skipped" | "partial" | "error";
  literature?: Literature;
  literatureId?: EntityId;
  provisioning?: ProvisionManagedOwnerResult;
  completedSteps: string[];
  failedStep?: string;
  retryable: boolean;
  warnings: string[];
  errors: string[];
}

export interface LiteratureQueryOptions {
  keyword?: string;
  readingStatus?: LiteratureReadingStatus;
  importance?: LiteratureImportance;
  tag?: string;
  tags?: string[];
  primaryProjectId?: EntityId;
  archiveStatus?: LiteratureArchiveStatus;
  includeArchived?: boolean;
  yearFrom?: number;
  yearTo?: number;
  publicationType?: LiteratureType;
  source?: string;
}

export interface LiteratureBundle {
  literature: Literature;
  links: LiteratureLink[];
}

export type CreateLiteratureLinkInput = Pick<
  LiteratureLink,
  "literatureId" | "targetType" | "targetId" | "relationType"
> &
  Partial<
    Omit<LiteratureLink, DefaultCreateKeys | "literatureId" | "targetType" | "targetId" | "relationType">
  >;

export type UpdateLiteratureLinkInput = Partial<Omit<LiteratureLink, DefaultUpdateKeys>>;

export interface LiteratureLinkQueryOptions {
  literatureId?: EntityId;
  targetType?: LiteratureLinkTargetType;
  targetId?: EntityId;
  relationType?: LiteratureRelationType;
  projectId?: EntityId;
}

const LITERATURE_LINK_TARGET_TYPES = new Set<string>([
  "project",
  "route",
  "task",
  "experiment",
  "experimentRun",
  "resultMetric",
  "fileRef",
  "resultItem",
  "finding",
  "outputCandidate",
  "outputGap",
  "output",
  "review",
  "aiContext",
  "other"
]);

const LITERATURE_RELATION_TYPES = new Set<string>([
  "background_support",
  "core_related_work",
  "method_reference",
  "theory_support",
  "problem_source",
  "baseline",
  "parameter_reference",
  "data_processing_reference",
  "evaluation_metric_reference",
  "experiment_comparison",
  "result_interpretation",
  "related_work",
  "writing_support",
  "patent_background",
  "contradicts",
  "extends",
  "inspired_by",
  "other"
]);

class LiteratureLinkValidationError extends Error {
  constructor(public readonly issues: LinkWriteValidationIssue[]) {
    super(
      `LiteratureLink validation failed: ${issues
        .map((issue) => `${issue.code}: ${issue.message}`)
        .join("; ")}`
    );
    this.name = "LiteratureLinkValidationError";
  }
}

function isValidLiteratureLinkTargetType(value: unknown): value is LiteratureLinkTargetType {
  return typeof value === "string" && LITERATURE_LINK_TARGET_TYPES.has(value);
}

function isValidLiteratureRelationType(value: unknown): value is LiteratureRelationType {
  return typeof value === "string" && LITERATURE_RELATION_TYPES.has(value);
}

export function shouldIncludeLiteratureForArchiveStatus(
  literature: Pick<Literature, "isArchived">,
  options: Pick<LiteratureQueryOptions, "archiveStatus" | "includeArchived"> = {}
) {
  if (options.archiveStatus === "archived") {
    return literature.isArchived === true;
  }
  if (options.archiveStatus === "all") {
    return true;
  }
  if (options.archiveStatus === "active") {
    return literature.isArchived !== true;
  }
  return options.includeArchived ? true : literature.isArchived !== true;
}

function buildLiteratureLinkIssue(
  code: LinkWriteValidationIssue["code"],
  message: string,
  input: Partial<CreateLiteratureLinkInput>
): LinkWriteValidationIssue {
  return {
    code,
    message,
    sourceType: "literature",
    sourceId: typeof input.literatureId === "string" ? input.literatureId : undefined,
    targetType: typeof input.targetType === "string" ? input.targetType : undefined,
    targetId: typeof input.targetId === "string" ? input.targetId : undefined,
    relationType: typeof input.relationType === "string" ? input.relationType : undefined
  };
}

function publishLiteratureWriteFeedback<T = unknown>(input: {
  operation: string;
  data?: T;
  primaryEntity?: AffectedEntity;
  literatureId?: EntityId | null;
  projectId?: EntityId | null;
  affectedEntities?: AffectedEntity[];
  refreshKeys?: RefreshKey[];
  warnings?: string[];
  errors?: string[];
  skipped?: string[];
  publish?: boolean;
}) {
  const feedback = createCrossModuleWriteFeedback({
      operation: input.operation,
      data: input.data,
      primaryEntity: input.primaryEntity,
      affectedEntities: [
        ...(input.literatureId
          ? [
              {
                type: "literature",
                id: input.literatureId,
                relation: "linked"
              } satisfies AffectedEntity
            ]
          : []),
        ...(input.affectedEntities ?? [])
      ],
      affectedScopes: [
        {
          module: "literature",
          projectId: input.projectId ?? undefined,
          literatureId: input.literatureId ?? undefined,
          reason: `${input.operation} changed Literature module metadata.`
        },
        {
          module: "review",
          projectId: input.projectId ?? undefined,
          literatureId: input.literatureId ?? undefined,
          reason: "Review context can include literature metadata and literature evidence links."
        },
        {
          module: "ai",
          projectId: input.projectId ?? undefined,
          literatureId: input.literatureId ?? undefined,
          reason: "AI context can include whitelisted literature metadata and read-only literature link summaries."
        }
      ],
      refreshKeys: input.refreshKeys ?? ["literature.changed", "reviewContext.changed", "aiContext.changed"],
      warnings: input.warnings,
      errors: input.errors,
      skipped: input.skipped
    });
  if (input.publish !== false) {
    publishCrossModuleWriteFeedback(feedback, input.operation);
  }
  return feedback;
}

async function recordLiteratureDeletionClosure<T extends { id: EntityId; deletedAt?: string | null; updatedAt: string }>(
  input: {
    entityType: string;
    entityId: EntityId;
    title: string;
    summary?: string;
    deletedEntity: T;
    feedback: WriteFeedbackResult;
    refreshKeys: RefreshKey[];
    relatedEntities?: AffectedEntity[];
    warnings?: string[];
  }
) {
  const deletedAt = input.deletedEntity.deletedAt ?? new Date().toISOString();
  const relatedEntities = input.relatedEntities ?? [];
  const impactSummary: OperationImpactSummary = {
    affectedEntityCount: Math.max(1, relatedEntities.length + 1),
    affectedItems: [
      {
        entityType: input.entityType,
        entityId: input.entityId,
        title: input.title,
        severity: "warning"
      },
      ...relatedEntities.map((entity) => ({
        entityType: entity.type,
        entityId: entity.id,
        title: entity.label ?? entity.id,
        description: entity.relation,
        severity: "info" as const
      }))
    ],
    warnings: input.warnings ?? [
      "Only SciLoom literature metadata is moved to the recycle area. Local files are not read, uploaded, moved, or deleted."
    ],
    blockingReasons: [],
    deepScanPerformed: false
  };

  let operationLogId: EntityId | undefined;
  const warnings: string[] = [];
  try {
    const logFeedback = await createOperationLog({
      operationType: "delete",
      source: "user",
      module: "literature",
      status: input.feedback.status,
      riskLevel: "high",
      target: {
        entityType: input.entityType,
        entityId: input.entityId,
        title: input.title
      },
      summary: `${input.title} moved to the literature recycle area.`,
      relatedEntities,
      impactSummary,
      confirmation: {
        required: true,
        confirmedByUser: true,
        confirmedAt: deletedAt
      },
      feedback: summarizeFeedbackForOperationLog(input.feedback),
      isRecoverable: true,
      refreshKeys: [...input.refreshKeys, "operationLog.changed", "recycleBin.changed"]
    });
    operationLogId = logFeedback.data?.id;
  } catch {
    operationLogId = undefined;
    warnings.push(
      "The metadata deletion was committed, but its companion operation log could not be recorded."
    );
  }

  try {
    await recordRecycleEntry({
      entityType: input.entityType,
      entityId: input.entityId,
      title: input.title,
      summary: input.summary,
      module: "literature",
      deletedAt,
      deletedBy: "user",
      operationLogId,
      canRestore: true,
      knownImpactSummary: impactSummary,
      restoreStatus: "not_started",
      refreshKeys: [...input.refreshKeys, "recycleBin.changed"]
    });
  } catch {
    // The soft-delete remains the source of truth; listRecentlyDeleted can still
    // discover the deleted entity through recycleBinService restore adapters.
    warnings.push(
      "The metadata deletion was committed, but its companion recycle entry could not be recorded."
    );
  }
  return { operationLogId, warnings };
}

function publishLiteratureLinkValidationFailure(
  operation: string,
  input: Partial<CreateLiteratureLinkInput>,
  error: unknown
) {
  const message = error instanceof Error ? error.message : "LiteratureLink validation failed.";
  publishLiteratureWriteFeedback({
    operation,
    literatureId: input.literatureId,
    projectId: input.projectId ?? undefined,
    affectedEntities:
      typeof input.targetId === "string" && input.targetId.trim()
        ? [
            {
              type: typeof input.targetType === "string" ? input.targetType : "other",
              id: input.targetId.trim(),
              relation: "skipped"
            }
          ]
        : [],
    refreshKeys: ["literatureLink.changed", "literature.changed", "reviewContext.changed", "aiContext.changed"],
    errors: [message]
  });
}

async function validateLiteratureLinkWriteInput(
  input: CreateLiteratureLinkInput
): Promise<CreateLiteratureLinkInput> {
  const normalized: CreateLiteratureLinkInput = {
    ...input,
    literatureId: typeof input.literatureId === "string" ? input.literatureId.trim() : "",
    targetType: (typeof input.targetType === "string" ? input.targetType.trim() : "") as LiteratureLinkTargetType,
    targetId: typeof input.targetId === "string" ? input.targetId.trim() : "",
    relationType: (typeof input.relationType === "string" ? input.relationType.trim() : "") as LiteratureRelationType,
    projectId:
      typeof input.projectId === "string"
        ? input.projectId.trim() || null
        : input.projectId ?? null
  };
  const issues: LinkWriteValidationIssue[] = [];

  if (!normalized.literatureId) {
    issues.push(
      buildLiteratureLinkIssue("invalid_source", "LiteratureLink literatureId is required.", normalized)
    );
  }
  if (!isValidLiteratureLinkTargetType(normalized.targetType)) {
    issues.push(
      buildLiteratureLinkIssue(
        "unsupported_target_type",
        `LiteratureLink targetType is not supported: ${normalized.targetType}`,
        normalized
      )
    );
  }
  if (!normalized.targetId) {
    issues.push(
      buildLiteratureLinkIssue("invalid_target", "LiteratureLink targetId is required.", normalized)
    );
  }
  if (!isValidLiteratureRelationType(normalized.relationType)) {
    issues.push(
      buildLiteratureLinkIssue(
        "invalid_relation_type",
        `LiteratureLink relationType is not supported: ${normalized.relationType}`,
        normalized
      )
    );
  }

  if (issues.length === 0) {
    const literature = await literatureRepository.getById(normalized.literatureId);
    if (!literature) {
      issues.push(
        buildLiteratureLinkIssue(
          "invalid_source",
          `Literature not found: ${normalized.literatureId}`,
          normalized
        )
      );
    }
  }

  if (issues.length === 0) {
    const targetValidation = await validateEntityReference(literatureLinkToTargetReference(normalized));
    if (!targetValidation.valid) {
      issues.push(
        buildLiteratureLinkIssue(
          targetValidation.resolution.status === "unsupported_type"
            ? "unsupported_target_type"
            : "invalid_target",
          targetValidation.resolution.message ??
            `LiteratureLink target is invalid: ${normalized.targetType}/${normalized.targetId}`,
          normalized
        )
      );
    }
  }

  if (issues.length > 0) {
    throw new LiteratureLinkValidationError(issues);
  }

  return normalized;
}

function sortByUpdatedAtDesc<T extends { updatedAt: string; createdAt: string }>(items: T[]) {
  return [...items].sort((left, right) => {
    const updatedDiff = right.updatedAt.localeCompare(left.updatedAt);
    return updatedDiff || right.createdAt.localeCompare(left.createdAt);
  });
}

function hasAnyTag(itemTags: string[] | undefined, queryTags: string[]) {
  if (queryTags.length === 0) {
    return true;
  }

  const tags = itemTags ?? [];
  return queryTags.some((tag) => tags.includes(tag));
}

function includesKeyword(value: string | undefined, keyword: string) {
  return value?.toLowerCase().includes(keyword) ?? false;
}

async function ensureLiteratureExists(literatureId: EntityId) {
  const literature = await literatureRepository.getById(literatureId);
  if (!literature) {
    throw new Error(`Literature not found: ${literatureId}`);
  }
  return literature;
}

export function toLiteratureCreateInput(input: CreateLiteratureInput): CreateEntityInput<Literature> {
  return {
    title: input.title,
    authors: input.authors ?? [],
    year: input.year,
    venue: input.venue,
    publicationType: input.publicationType,
    abstract: input.abstract,
    keywords: input.keywords ?? [],
    doi: input.doi,
    url: input.url,
    pdfPath: input.pdfPath,
    localFilePath: input.localFilePath,
    bibtexKey: input.bibtexKey,
    citationKey: input.citationKey,
    externalIds: input.externalIds ?? [],
    readingStatus: input.readingStatus ?? "unread",
    importance: input.importance,
    primaryProjectId: input.primaryProjectId ?? null,
    tags: input.tags ?? [],
    isArchived: input.isArchived ?? false,
    archivedAt: input.archivedAt ?? null,
    schemaVersion: LITERATURE_SCHEMA_VERSION,
    source: input.source ?? "user",
    customFields: input.customFields ?? [],
    aiMetadata: input.aiMetadata
  };
}

export function toLiteratureUpdateInput(
  existing: Literature,
  patch: UpdateLiteratureInput
): UpdateEntityInput<Literature> {
  const hasProjectPatch = Object.prototype.hasOwnProperty.call(patch, "primaryProjectId");
  const normalized = {
    ...existing,
    ...patch,
    authors: patch.authors ?? existing.authors ?? [],
    keywords: patch.keywords ?? existing.keywords ?? [],
    externalIds: patch.externalIds ?? existing.externalIds ?? [],
    primaryProjectId: hasProjectPatch
      ? patch.primaryProjectId ?? null
      : existing.primaryProjectId ?? null,
    tags: patch.tags ?? existing.tags ?? [],
    isArchived: patch.isArchived ?? existing.isArchived ?? false,
    archivedAt: patch.archivedAt ?? existing.archivedAt ?? null,
    schemaVersion: LITERATURE_SCHEMA_VERSION,
    source: patch.source ?? existing.source ?? "user",
    customFields: patch.customFields ?? existing.customFields ?? []
  };
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, deletedAt: _deletedAt, ...rest } =
    normalized;
  return rest;
}

export async function validateLiteratureProject(
  projectId: EntityId | null | undefined,
  loadProject: typeof getProjectById = getProjectById
) {
  if (projectId === null || projectId === undefined) {
    return undefined;
  }
  const normalized = projectId.trim();
  if (!normalized) throw new Error("Literature Project assignment cannot be empty.");
  const project = await loadProject(normalized);
  if (!project || project.deletedAt) throw new Error(`Project not found: ${normalized}.`);
  return project;
}

function validateStandardResultOperation(
  operation: LiteratureStandardResultOperationInput,
  expectedAction?: "CREATE" | "UPDATE"
) {
  if (
    operation.version !== 1 ||
    (operation.action !== "CREATE" && operation.action !== "UPDATE") ||
    (expectedAction !== undefined && operation.action !== expectedAction) ||
    !/^a16-lit-(?:create|update):[A-Za-z0-9:._-]+$/u.test(operation.operationKey) ||
    operation.operationKey.length > 190 ||
    !operation.resultId.trim() || operation.resultId.length > 200 ||
    !operation.authorizationId.trim() || operation.authorizationId.length > 200 ||
    !operation.confirmedPayloadFingerprint.trim() ||
    operation.confirmedPayloadFingerprint.length > 200 ||
    !Number.isFinite(Date.parse(operation.occurredAt))
  ) {
    throw new LiteratureOperationConflictError(
      "LITERATURE_OPERATION_BINDING_INVALID",
      "The Literature operation requires one exact bounded application-owned Result binding."
    );
  }
}

function operationBoundLiteratureId(
  operation: LiteratureStandardResultOperationInput
): EntityId {
  const id = `literature-${operation.resultId}`;
  if (
    id.length > 128 ||
    !/^[A-Za-z0-9._-]+$/u.test(id)
  ) {
    throw new LiteratureOperationConflictError(
      "LITERATURE_OPERATION_IDENTITY_INVALID",
      "The canonical Literature operation identity exceeds its bounded domain representation."
    );
  }
  return id;
}

function strictlyNewerOperationInstant(expectedUpdatedAt: string, occurredAt: string): string {
  const expectedTime = Date.parse(expectedUpdatedAt);
  const occurredTime = Date.parse(occurredAt);
  if (!Number.isFinite(expectedTime) || !Number.isFinite(occurredTime)) {
    throw new LiteratureOperationConflictError(
      "LITERATURE_UPDATE_TOKEN_INVALID",
      "Literature UPDATE requires exact canonical timestamp tokens."
    );
  }
  return new Date(Math.max(occurredTime, expectedTime + 1)).toISOString();
}

function persistedStandardResultOperation(
  operation: LiteratureStandardResultOperationInput,
  appliedUpdatedAt: string
): LiteratureStandardResultOperationCorrelation {
  return {
    version: 1,
    action: operation.action,
    operationKey: operation.operationKey,
    resultId: operation.resultId,
    authorizationId: operation.authorizationId,
    confirmedPayloadFingerprint: operation.confirmedPayloadFingerprint,
    appliedUpdatedAt
  };
}

function standardResultOperationMatches(
  literature: Literature,
  operation: LiteratureStandardResultOperationInput,
  requireCurrentAppliedToken: boolean
) {
  const durable = literature.aiMetadata?.standardResultOperation;
  return durable?.version === 1 &&
    durable.action === operation.action &&
    durable.operationKey === operation.operationKey &&
    durable.resultId === operation.resultId &&
    durable.authorizationId === operation.authorizationId &&
    durable.confirmedPayloadFingerprint === operation.confirmedPayloadFingerprint &&
    (!requireCurrentAppliedToken || durable.appliedUpdatedAt === literature.updatedAt);
}

export async function getLiteratureByStandardResultOperation(input: {
  operation: LiteratureStandardResultOperationInput;
  entityId?: EntityId;
}): Promise<Literature | undefined> {
  validateStandardResultOperation(input.operation);
  const entityId = input.operation.action === "CREATE"
    ? operationBoundLiteratureId(input.operation)
    : input.entityId;
  if (!entityId) return undefined;
  const literature = await literatureRepository.getById(entityId);
  if (!literature || !standardResultOperationMatches(
    literature,
    input.operation,
    input.operation.action === "UPDATE"
  )) return undefined;
  return literature;
}

async function createLiterature(
  input: CreateLiteratureInput,
  standardResultOperation?: LiteratureStandardResultOperationInput
): Promise<LiteratureCreateResult> {
  try {
    await validateLiteratureProject(input.primaryProjectId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    publishLiteratureWriteFeedback({
      operation: "literature.createLiterature",
      errors: [message],
      refreshKeys: []
    });
    return {
      status: "error",
      completedSteps: [],
      failedStep: "project-validation",
      retryable: false,
      warnings: [],
      errors: [message]
    };
  }
  let literature: Literature;
  try {
    if (standardResultOperation) {
      validateStandardResultOperation(standardResultOperation, "CREATE");
      if (!literatureRepository.createIfAbsent) {
        throw new LiteratureOperationConflictError(
          "LITERATURE_CREATE_ATOMIC_OWNER_UNAVAILABLE",
          "The canonical Literature repository lacks its bounded atomic create owner."
        );
      }
      const appliedUpdatedAt = new Date(standardResultOperation.occurredAt).toISOString();
      const correlation = persistedStandardResultOperation(
        standardResultOperation,
        appliedUpdatedAt
      );
      const operationBoundId = operationBoundLiteratureId(standardResultOperation);
      const persisted = await literatureRepository.createIfAbsent(
        toLiteratureCreateInput({
          ...input,
          primaryProjectId: null,
          source: "ai",
          aiMetadata: {
            generatedByAi: true,
            generatedAt: appliedUpdatedAt,
            userConfirmed: true,
            confirmedAt: appliedUpdatedAt,
            standardResultOperation: correlation
          }
        }),
        { id: operationBoundId, createdAt: appliedUpdatedAt }
      );
      if (!standardResultOperationMatches(persisted.entity, standardResultOperation, false)) {
        throw new LiteratureOperationConflictError(
          "LITERATURE_CREATE_OPERATION_CONFLICT",
          "The operation-bound Literature identity belongs to a different canonical operation."
        );
      }
      literature = persisted.entity;
    } else {
      literature = await literatureRepository.create(toLiteratureCreateInput(input));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    publishLiteratureWriteFeedback({
      operation: "literature.createLiterature",
      errors: [message],
      refreshKeys: []
    });
    return {
      status: "error",
      completedSteps: ["project-validation"],
      failedStep: "literature-create",
      retryable: false,
      warnings: [],
      errors: [message]
    };
  }
  let provisioning: ProvisionManagedOwnerResult;
  try {
    provisioning = await ensureLiteratureManuscriptProvisioned(literature.id);
  } catch (error) {
    provisioning = {
      status: "error",
      ownerType: "literature",
      ownerId: literature.id,
      createdFolder: false,
      createdBody: false,
      reusedFolder: false,
      reusedBody: false,
      warnings: [],
      errors: [
        {
          code: "PROVISIONING_UNEXPECTED",
          message: error instanceof Error ? error.message : String(error),
          step: "provisioning"
        }
      ],
      completedSteps: [],
      failedStep: "provisioning",
      retryable: true
    };
  }
  const succeeded = provisioning.status === "success" || provisioning.status === "skipped";
  const errors = provisioning.errors.map((item) => `${item.code}: ${item.message}`);
  publishLiteratureWriteFeedback({
    operation: "literature.createLiterature",
    data: literature,
    primaryEntity: {
      type: "literature",
      id: literature.id,
      relation: "created",
      label: literature.title
    },
    literatureId: literature.id,
    projectId: literature.primaryProjectId ?? undefined,
    refreshKeys: ["literature.changed", "fileRef.changed", "reviewContext.changed", "aiContext.changed"],
    warnings: provisioning.warnings,
    errors
  });
  return {
    status: succeeded ? (provisioning.status === "skipped" ? "skipped" : "success") : "partial",
    literature,
    literatureId: literature.id,
    provisioning,
    completedSteps: ["literature", ...provisioning.completedSteps],
    failedStep: provisioning.failedStep,
    retryable: !succeeded,
    warnings: provisioning.warnings,
    errors
  };
}

async function createLiteratureWithOperation(
  input: CreateLiteratureWithOperationInput,
  operation: LiteratureStandardResultOperationInput
): Promise<LiteratureCreateResult> {
  validateStandardResultOperation(operation, "CREATE");
  return createLiterature({
    ...input,
    primaryProjectId: null,
    source: "ai"
  }, operation);
}

async function updateLiterature(
  id: EntityId,
  patch: UpdateLiteratureInput,
  standardResult?: {
    expectedUpdatedAt: string;
    operation: LiteratureStandardResultOperationInput;
  }
) {
  const existing = await literatureRepository.getById(id);
  if (!existing) {
    publishLiteratureWriteFeedback({
      operation: "literature.updateLiterature",
      primaryEntity: {
        type: "literature",
        id,
        relation: "skipped"
      },
      literatureId: id,
      skipped: ["literature_not_found"]
    });
    return undefined;
  }

  if (standardResult) {
    validateStandardResultOperation(standardResult.operation, "UPDATE");
    if (
      Object.prototype.hasOwnProperty.call(patch, "primaryProjectId") ||
      Object.prototype.hasOwnProperty.call(patch, "aiMetadata") ||
      Object.prototype.hasOwnProperty.call(patch, "source")
    ) {
      throw new LiteratureOperationConflictError(
        "LITERATURE_UPDATE_DOMAIN_AUTHORITY_FORGED",
        "A Standard Result cannot control Literature Project or operation metadata authority."
      );
    }
    if (standardResultOperationMatches(existing, standardResult.operation, true)) {
      return existing;
    }
  }

  if (Object.prototype.hasOwnProperty.call(patch, "primaryProjectId")) {
    await validateLiteratureProject(patch.primaryProjectId);
  }

  if (!literatureRepository.updateWithExpectedUpdatedAt) {
    throw new Error("The canonical Literature repository lacks its bounded atomic update guard.");
  }
  const expectedUpdatedAt = standardResult?.expectedUpdatedAt ?? existing.updatedAt;
  const nextUpdatedAt = standardResult
    ? strictlyNewerOperationInstant(
        standardResult.expectedUpdatedAt,
        standardResult.operation.occurredAt
      )
    : undefined;
  const operationPatch: UpdateLiteratureInput = standardResult
    ? {
        ...patch,
        aiMetadata: {
          ...(existing.aiMetadata ?? {}),
          generatedByAi: true,
          generatedAt: existing.aiMetadata?.generatedAt ?? standardResult.operation.occurredAt,
          userConfirmed: true,
          confirmedAt: standardResult.operation.occurredAt,
          standardResultOperation: persistedStandardResultOperation(
            standardResult.operation,
            nextUpdatedAt as string
          )
        }
      }
    : patch;
  const literature = await literatureRepository.updateWithExpectedUpdatedAt(
    id,
    toLiteratureUpdateInput(existing, operationPatch),
    {
      expectedUpdatedAt,
      ...(nextUpdatedAt ? { nextUpdatedAt } : {})
    }
  );
  if (!literature && standardResult) {
    throw new LiteratureOperationConflictError(
      "LITERATURE_UPDATE_STALE_CONFLICT",
      "The canonical Literature changed after review; re-review is required."
    );
  }
  if (
    literature && standardResult &&
    !standardResultOperationMatches(literature, standardResult.operation, true)
  ) {
    throw new LiteratureOperationConflictError(
      "LITERATURE_UPDATE_OPERATION_READBACK_MISMATCH",
      "The canonical Literature update lacks its exact operation-bound readback."
    );
  }
  publishLiteratureWriteFeedback({
    operation: "literature.updateLiterature",
    data: literature,
    primaryEntity: {
      type: "literature",
      id,
      relation: literature ? "updated" : "skipped",
      label: literature?.title ?? existing.title
    },
    literatureId: id,
    projectId: (literature ?? existing).primaryProjectId ?? undefined,
    skipped: literature ? [] : ["literature_update_failed"]
  });
  return literature;
}

async function updateLiteratureWithExpectedUpdatedAtAndOperation(
  id: EntityId,
  patch: UpdateLiteratureWithOperationInput,
  expectedUpdatedAt: string,
  operation: LiteratureStandardResultOperationInput
) {
  validateStandardResultOperation(operation, "UPDATE");
  if (!expectedUpdatedAt.trim() || expectedUpdatedAt.length > 80) {
    throw new LiteratureOperationConflictError(
      "LITERATURE_UPDATE_TOKEN_INVALID",
      "Literature UPDATE requires one exact reviewed updatedAt token."
    );
  }
  return updateLiterature(id, patch, { expectedUpdatedAt, operation });
}

async function archiveLiterature(id: EntityId) {
  return updateLiterature(id, {
    isArchived: true,
    archivedAt: new Date().toISOString()
  });
}

async function restoreLiterature(id: EntityId) {
  return updateLiterature(id, {
    isArchived: false,
    archivedAt: null
  });
}

async function deleteLiterature(id: EntityId) {
  const existing = await literatureRepository.getById(id);
  if (!existing) {
    return publishLiteratureWriteFeedback({
      operation: "literature.deleteLiterature",
      primaryEntity: { type: "literature", id, relation: "skipped" },
      literatureId: id,
      skipped: ["literature_not_found"]
    });
  }
  const decisions = await Promise.all([
    resolveMountedManuscriptLifecycleDecision({
      ownerType: "literature",
      ownerId: id,
      manuscriptChannel: "literature_outline"
    }),
    resolveMountedManuscriptLifecycleDecision({
      ownerType: "literature",
      ownerId: id,
      manuscriptChannel: "dedicated_notes"
    })
  ]);
  if (decisions.some((decision) => !decision.canWrite)) {
    throw new Error("LITERATURE_MANUSCRIPT_LIFECYCLE_DELETE_DENIED");
  }
  const sessionsClosed = await sharedManuscriptSessionRuntime.closeCleanSessions(
    (session) =>
      session.owner.ownerType === "literature" &&
      session.owner.ownerId === id
  );
  if (!sessionsClosed) {
    throw new Error("LITERATURE_MANUSCRIPT_SESSION_DIRTY");
  }
  const removed = await literatureRepository.softDelete(id);
  const authoritativeDeleted = await literatureRepository.getDeletedById(id);
  if (!removed || !authoritativeDeleted?.deletedAt) {
    throw new Error("LITERATURE_DELETE_AUTHORITATIVE_READBACK_FAILED");
  }
  let feedback = publishLiteratureWriteFeedback({
    operation: "literature.deleteLiterature",
    data: authoritativeDeleted,
    primaryEntity: {
      type: "literature",
      id,
      relation: "deleted",
      label: existing.title
    },
    literatureId: id,
    projectId: existing.primaryProjectId ?? undefined,
    publish: false
  });
  const closure = await recordLiteratureDeletionClosure({
    entityType: "literature",
    entityId: id,
    title: existing.title,
    summary: existing.abstract,
    deletedEntity: authoritativeDeleted,
    feedback,
    refreshKeys: ["literature.changed", "reviewContext.changed", "aiContext.changed"],
    warnings: [
      "The literature record is moved to the recycle area.",
      "Literature links are not cascade-deleted.",
      "Local PDF or file paths are not read, uploaded, moved, or deleted."
    ]
  });
  for (const warning of closure.warnings) {
    feedback = addWriteFeedbackWarning(
      feedback,
      warning,
      "LITERATURE_DELETE_COMPANION_FAILED"
    );
  }
  publishCrossModuleWriteFeedback(feedback, "literature.deleteLiterature");
  return feedback;
}

async function queryLiteratures(options: LiteratureQueryOptions = {}) {
  const keyword = options.keyword?.trim().toLowerCase();
  const tags = [...(options.tags ?? []), ...(options.tag ? [options.tag] : [])];

  return sortByUpdatedAtDesc(
    (await literatureRepository.list()).filter((literature) => {
      if (!shouldIncludeLiteratureForArchiveStatus(literature, options)) {
        return false;
      }
      if (options.readingStatus && literature.readingStatus !== options.readingStatus) {
        return false;
      }
      if (options.importance && literature.importance !== options.importance) {
        return false;
      }
      if (options.primaryProjectId && literature.primaryProjectId !== options.primaryProjectId) {
        return false;
      }
      if (options.yearFrom !== undefined && (literature.year ?? 0) < options.yearFrom) {
        return false;
      }
      if (options.yearTo !== undefined && (literature.year ?? Number.POSITIVE_INFINITY) > options.yearTo) {
        return false;
      }
      if (options.publicationType && literature.publicationType !== options.publicationType) {
        return false;
      }
      if (
        options.source &&
        literature.source !== options.source &&
        !(literature.externalIds ?? []).some((externalId) => externalId.source === options.source)
      ) {
        return false;
      }
      if (!hasAnyTag(literature.tags, tags)) {
        return false;
      }
      if (!keyword) {
        return true;
      }

      return (
        includesKeyword(literature.title, keyword) ||
        literature.authors.some((author) => includesKeyword(author.name, keyword)) ||
        includesKeyword(literature.abstract, keyword) ||
        includesKeyword(literature.venue, keyword) ||
        includesKeyword(literature.doi, keyword) ||
        (literature.keywords ?? []).some((item) => includesKeyword(item, keyword))
      );
    })
  );
}

async function getLiteratureById(id: EntityId) {
  return literatureRepository.getById(id);
}

async function getLiteratureBundle(id: EntityId): Promise<LiteratureBundle | undefined> {
  const literature = await literatureRepository.getById(id);
  if (!literature) {
    return undefined;
  }

  const links = await getLinksByLiterature(id);

  return {
    literature,
    links
  };
}

function toLiteratureLinkCreateInput(
  input: CreateLiteratureLinkInput
): CreateEntityInput<LiteratureLink> {
  return {
    literatureId: input.literatureId,
    targetType: input.targetType,
    targetId: input.targetId,
    projectId: input.projectId ?? null,
    relationType: input.relationType,
    role: input.role,
    description: input.description,
    note: input.note,
    strength: input.strength,
    confidence: input.confidence,
    schemaVersion: LITERATURE_SCHEMA_VERSION,
    tags: input.tags ?? [],
    customFields: input.customFields ?? [],
    aiMetadata: input.aiMetadata
  };
}

function toLiteratureLinkUpdateInput(
  existing: LiteratureLink,
  patch: UpdateLiteratureLinkInput
): UpdateEntityInput<LiteratureLink> {
  const normalized = {
    ...existing,
    ...patch,
    literatureId: patch.literatureId ?? existing.literatureId,
    targetType: patch.targetType ?? existing.targetType,
    targetId: patch.targetId ?? existing.targetId,
    relationType: patch.relationType ?? existing.relationType,
    projectId: patch.projectId ?? existing.projectId ?? null,
    tags: patch.tags ?? existing.tags ?? [],
    customFields: patch.customFields ?? existing.customFields ?? [],
    schemaVersion: LITERATURE_SCHEMA_VERSION
  };
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, deletedAt: _deletedAt, ...rest } =
    normalized;
  return rest;
}

async function findDuplicateLiteratureLink(
  literatureId: EntityId,
  targetType: LiteratureLinkTargetType,
  targetId: EntityId,
  relationType: LiteratureRelationType
) {
  return (await literatureLinkRepository.list()).find(
    (link) =>
      link.literatureId === literatureId &&
      link.targetType === targetType &&
      link.targetId === targetId &&
      link.relationType === relationType
  );
}

async function createLiteratureLink(input: CreateLiteratureLinkInput) {
  let normalized: CreateLiteratureLinkInput;
  try {
    normalized = await validateLiteratureLinkWriteInput(input);
  } catch (error) {
    publishLiteratureLinkValidationFailure("literature.createLiteratureLink", input, error);
    throw error;
  }
  const existing = await findDuplicateLiteratureLink(
    normalized.literatureId,
    normalized.targetType,
    normalized.targetId,
    normalized.relationType
  );

  if (existing) {
    publishLiteratureWriteFeedback({
      operation: "literature.createLiteratureLink",
      data: existing,
      primaryEntity: {
        type: "literatureLink",
        id: existing.id,
        relation: "reused"
      },
      literatureId: existing.literatureId,
      projectId: existing.projectId ?? undefined,
      affectedEntities: [
        {
          type: existing.targetType,
          id: existing.targetId,
          relation: "linked"
        }
      ],
      refreshKeys: ["literatureLink.changed", "literature.changed", "reviewContext.changed", "aiContext.changed"],
      skipped: ["literature_link_already_exists"]
    });
    return existing;
  }

  const link = await literatureLinkRepository.create(toLiteratureLinkCreateInput(normalized));
  publishLiteratureWriteFeedback({
    operation: "literature.createLiteratureLink",
    data: link,
    primaryEntity: {
      type: "literatureLink",
      id: link.id,
      relation: "created"
    },
    literatureId: link.literatureId,
    projectId: link.projectId ?? undefined,
    affectedEntities: [
      {
        type: link.targetType,
        id: link.targetId,
        relation: "linked"
      }
    ],
    refreshKeys: ["literatureLink.changed", "literature.changed", "reviewContext.changed", "aiContext.changed"]
  });
  return link;
}

async function updateLiteratureLink(id: EntityId, patch: UpdateLiteratureLinkInput) {
  const existing = await literatureLinkRepository.getById(id);
  if (!existing) {
    publishLiteratureWriteFeedback({
      operation: "literature.updateLiteratureLink",
      primaryEntity: {
        type: "literatureLink",
        id,
        relation: "skipped"
      },
      skipped: ["literature_link_not_found"],
      refreshKeys: ["literatureLink.changed", "literature.changed", "reviewContext.changed", "aiContext.changed"]
    });
    return undefined;
  }

  let normalized: CreateLiteratureLinkInput;
  try {
    normalized = await validateLiteratureLinkWriteInput({
      ...existing,
      ...patch,
      literatureId: patch.literatureId ?? existing.literatureId,
      targetType: patch.targetType ?? existing.targetType,
      targetId: patch.targetId ?? existing.targetId,
      relationType: patch.relationType ?? existing.relationType
    });
  } catch (error) {
    publishLiteratureLinkValidationFailure("literature.updateLiteratureLink", {
      ...existing,
      ...patch
    }, error);
    throw error;
  }
  const duplicate = await findDuplicateLiteratureLink(
    normalized.literatureId,
    normalized.targetType,
    normalized.targetId,
    normalized.relationType
  );

  if (duplicate && duplicate.id !== id) {
    publishLiteratureLinkValidationFailure("literature.updateLiteratureLink", normalized, {
      message: `LiteratureLink already exists: ${duplicate.id}`
    });
    throw new Error(
      `LiteratureLink already exists for ${normalized.literatureId} -> ${normalized.targetType}:${normalized.targetId} (${normalized.relationType}).`
    );
  }

  const link = await literatureLinkRepository.update(id, toLiteratureLinkUpdateInput(existing, normalized));
  publishLiteratureWriteFeedback({
    operation: "literature.updateLiteratureLink",
    data: link,
    primaryEntity: {
      type: "literatureLink",
      id,
      relation: link ? "updated" : "skipped"
    },
    literatureId: link?.literatureId ?? existing.literatureId,
    projectId: link?.projectId ?? existing.projectId ?? undefined,
    affectedEntities: link
      ? [
          {
            type: link.targetType,
            id: link.targetId,
            relation: "linked"
          }
        ]
      : [],
    refreshKeys: ["literatureLink.changed", "literature.changed", "reviewContext.changed", "aiContext.changed"],
    skipped: link ? [] : ["literature_link_update_failed"]
  });
  return link;
}

async function deleteLiteratureLink(id: EntityId) {
  const existing = await literatureLinkRepository.getById(id);
  const removed = await literatureLinkRepository.softDelete(id);
  const relatedEntities = existing
    ? [
        {
          type: existing.targetType,
          id: existing.targetId,
          relation: "linked"
        } satisfies AffectedEntity
      ]
    : [];
  const feedback = publishLiteratureWriteFeedback({
    operation: "literature.deleteLiteratureLink",
    data: removed,
    primaryEntity: {
      type: "literatureLink",
      id,
      relation: removed ? "deleted" : "skipped"
    },
    literatureId: existing?.literatureId,
    projectId: existing?.projectId ?? undefined,
    affectedEntities: relatedEntities,
    refreshKeys: ["literatureLink.changed", "literature.changed", "reviewContext.changed", "aiContext.changed"],
    skipped: removed ? [] : ["literature_link_not_found"]
  });
  if (removed && existing) {
    await recordLiteratureDeletionClosure({
      entityType: "literatureLink",
      entityId: id,
      title: existing.description || `${existing.targetType}: ${existing.targetId}`,
      summary: existing.note,
      deletedEntity: existing,
      feedback,
      refreshKeys: ["literatureLink.changed", "literature.changed", "reviewContext.changed", "aiContext.changed"],
      relatedEntities: [
        {
          type: "literature",
          id: existing.literatureId,
          relation: "linked"
        },
        ...relatedEntities
      ],
      warnings: [
        "The literature link is moved to the recycle area.",
        "The literature record and target object are not deleted.",
        "No target object content is read or uploaded."
      ]
    });
  }
  return removed;
}

async function queryLiteratureLinks(options: LiteratureLinkQueryOptions = {}) {
  return sortByUpdatedAtDesc(
    (await literatureLinkRepository.list()).filter((link) => {
      if (options.literatureId && link.literatureId !== options.literatureId) {
        return false;
      }
      if (options.targetType && link.targetType !== options.targetType) {
        return false;
      }
      if (options.targetId && link.targetId !== options.targetId) {
        return false;
      }
      if (options.relationType && link.relationType !== options.relationType) {
        return false;
      }
      if (options.projectId && link.projectId !== options.projectId) {
        return false;
      }
      return true;
    })
  );
}

async function getLinksByLiterature(literatureId: EntityId) {
  return queryLiteratureLinks({ literatureId });
}

async function getLinksByTarget(targetType: LiteratureLinkTargetType, targetId: EntityId) {
  return queryLiteratureLinks({ targetType, targetId });
}

export const literatureService = {
  createLiterature,
  createLiteratureWithOperation,
  updateLiterature,
  updateLiteratureWithExpectedUpdatedAtAndOperation,
  archiveLiterature,
  restoreLiterature,
  deleteLiterature,
  queryLiteratures,
  getLiteratureById,
  getLiteratureByStandardResultOperation,
  getLiteratureBundle,
  createLiteratureLink,
  updateLiteratureLink,
  deleteLiteratureLink,
  queryLiteratureLinks,
  getLinksByLiterature,
  getLinksByTarget
};

export type LiteratureService = typeof literatureService;
