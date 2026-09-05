import {
  findingRepositoryConfig,
  outputCandidateRepositoryConfig,
  outputConversionRelationRepositoryConfig,
  outputGapFeedbackCardRepositoryConfig,
  outputGapRepositoryConfig,
  outputRepositoryConfig,
  outputSourceLinkRepositoryConfig,
  resultItemRepositoryConfig
} from "../repositories/entityConfig";
import { createRepository } from "../repositories/repositoryFactory";
import type { Repository } from "../repositories/types";
import type { AuditableEntity, EntityId } from "../types/common";
import type { ResearchOutput } from "../types/output";
import type { OutputConversionRelation, OutputGapFeedbackCard, OutputSourceLink } from "../types/outputConversion";
import type {
  ExecuteOutputDeleteInput,
  OutputDeleteAffectedItem,
  OutputDeleteConfirmation,
  OutputDeleteImpactPreview,
  OutputDeleteRefreshHints,
  OutputDeleteSafetyLayer,
  OutputDeleteSafetyMode,
  OutputDeleteSafetyResult,
  PreviewOutputDeleteInput
} from "../types/outputDeleteSafety";
import type {
  Finding,
  OutputCandidate,
  OutputGap,
  ResultItem
} from "../types/outputConversion";
import type { EntityType } from "../types/planning";
import { entityLinkService } from "./entityLinkService";
import { fileRefService } from "./fileRefService";
import { manuscriptBindingService } from "./manuscriptBindingService";
import { outputManuscriptLifecycleService } from "./outputManuscriptLifecycleService";
import { outputManuscriptLifecycleSessionRegistry } from "./outputManuscriptLifecycleSessionRegistry";
import { sharedManuscriptSessionRuntime } from "./sharedManuscriptSessionComposition";
import { resolveMountedManuscriptLifecycleDecision } from "./fileRefOwnerValidator";
import { publishRefreshEvent } from "./refreshEventService";
import {
  createOperationLog,
  createOperationLogEntry,
  summarizeImpactPreviewForOperationLog
} from "./operationLogService";
import { createOperationImpactPreview } from "./operationImpactPreviewService";
import { outputConversionRelationService } from "./outputConversionRelationService";
import { commitOutputLifecycleTransaction } from "./outputLifecycleTransactionService";
import {
  createRecycleEntry,
  getRecycleEntry,
  updateRecycleEntry
} from "./recycleBinService";

export const OUTPUT_LOCAL_FILE_SAFETY_NOTICE =
  "Deleting SciLoom metadata does not delete, read, upload, move, or modify referenced local files.";

const REFRESH_HINTS: OutputDeleteRefreshHints = {
  refreshLists: true,
  refreshDetail: true,
  refreshChains: true,
  refreshRelations: true,
  refreshFileRefs: true,
  refreshRecycleBin: true
};

type OutputDeleteEntity =
  | ResultItem
  | Finding
  | OutputCandidate
  | OutputGap
  | ResearchOutput;

interface OutputDeleteAdapter {
  layer: OutputDeleteSafetyLayer;
  recycleEntityType: string;
  entityLinkType: EntityType;
  module: "output" | "outputConversion";
  repository: Repository<OutputDeleteEntity>;
  title: (entity: OutputDeleteEntity) => string;
}

function asOutputDeleteRepository<T extends OutputDeleteEntity>(
  repository: Repository<T>
): Repository<OutputDeleteEntity> {
  return repository as unknown as Repository<OutputDeleteEntity>;
}

const adapters: Record<OutputDeleteSafetyLayer, OutputDeleteAdapter> = {
  resultItem: {
    layer: "resultItem",
    recycleEntityType: "resultItem",
    entityLinkType: "resultItem",
    module: "outputConversion",
    repository: asOutputDeleteRepository(createRepository(resultItemRepositoryConfig)),
    title: (entity) => (entity as ResultItem).title
  },
  finding: {
    layer: "finding",
    recycleEntityType: "finding",
    entityLinkType: "finding",
    module: "outputConversion",
    repository: asOutputDeleteRepository(createRepository(findingRepositoryConfig)),
    title: (entity) => (entity as Finding).title
  },
  outputCandidate: {
    layer: "outputCandidate",
    recycleEntityType: "outputCandidate",
    entityLinkType: "outputCandidate",
    module: "outputConversion",
    repository: asOutputDeleteRepository(createRepository(outputCandidateRepositoryConfig)),
    title: (entity) => (entity as OutputCandidate).title
  },
  outputGap: {
    layer: "outputGap",
    recycleEntityType: "outputGap",
    entityLinkType: "outputGap",
    module: "outputConversion",
    repository: asOutputDeleteRepository(createRepository(outputGapRepositoryConfig)),
    title: (entity) => (entity as OutputGap).title
  },
  researchOutput: {
    layer: "researchOutput",
    recycleEntityType: "output",
    entityLinkType: "output",
    module: "output",
    repository: asOutputDeleteRepository(createRepository(outputRepositoryConfig)),
    title: (entity) => (entity as ResearchOutput).outputName
  }
};

const relationRepository = createRepository<OutputConversionRelation>(
  outputConversionRelationRepositoryConfig
);
const sourceLinkRepository = createRepository<OutputSourceLink>(outputSourceLinkRepositoryConfig);
const gapFeedbackCardRepository = createRepository<OutputGapFeedbackCard>(outputGapFeedbackCardRepositoryConfig);

function isFileAwareDeleteLayer(layer: OutputDeleteSafetyLayer) {
  return layer === "resultItem" ||
    layer === "finding" ||
    layer === "outputCandidate" ||
    layer === "outputGap" ||
    layer === "researchOutput";
}

function uniqueById<T extends { id: EntityId }>(items: T[]) {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function hasStructuredSummary(entity: OutputDeleteEntity) {
  return (entity.structuredSummary ?? []).some(
    (section) => section.value.trim().length > 0
  );
}

function stableHash(value: unknown) {
  const text = JSON.stringify(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `output-delete-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function previewSeverity(
  canDelete: boolean,
  relationCount: number,
  entityLinkCount: number,
  fileRefCount: number
): OutputDeleteImpactPreview["severity"] {
  if (!canDelete) return "blocked";
  if (relationCount + entityLinkCount >= 4 || fileRefCount > 0) return "high";
  if (relationCount + entityLinkCount > 0) return "medium";
  return "low";
}

function relationAffectedItem(
  relation: OutputConversionRelation,
  layer: OutputDeleteSafetyLayer,
  id: EntityId
): OutputDeleteAffectedItem {
  const outgoing = relation.sourceType === layer && relation.sourceId === id;
  return {
    type: outgoing ? relation.targetType : relation.sourceType,
    id: outgoing ? relation.targetId : relation.sourceId,
    relation: relation.relationType,
    action: "keepMetadata",
    summary: `${outgoing ? "Downstream" : "Upstream"} ${relation.relationType} relation remains SciLoom metadata and is not cascaded.`
  };
}

function safeRecycleSummary(preview: OutputDeleteImpactPreview) {
  return JSON.stringify({
    layer: preview.layer,
    affectedCounts: preview.affectedCounts,
    relationSnapshotSummary: preview.affectedItems
      .filter((item) => item.relation)
      .map((item) => ({
        type: item.type,
        id: item.id,
        relation: item.relation,
        action: item.action
      })),
    fileRefMetadataSummary: {
      count: preview.affectedCounts.fileRefs,
      metadataOnly: true
    },
    manuscriptMetadataSummary: {
      bindings: preview.affectedCounts.manuscriptBindings,
      manuscripts: preview.affectedCounts.manuscripts,
      candidates: preview.affectedCounts.manuscriptCandidates,
      attachments: preview.affectedCounts.attachments
    },
    structuredSummaryExists: preview.affectedCounts.structuredSummaries > 0,
    localFileSafetyNotice: OUTPUT_LOCAL_FILE_SAFETY_NOTICE
  });
}

export function toOperationImpactPreview(preview: OutputDeleteImpactPreview) {
  return createOperationImpactPreview({
    operationId: `output.${preview.layer}.${preview.mode}`,
    operation:
      preview.mode === "restore"
        ? "restore"
        : preview.mode === "permanentDelete"
          ? "delete"
          : "delete",
    target: {
      type: preview.layer,
      id: preview.id,
      title: preview.title
    },
    summary: `${preview.mode} ${preview.layer} metadata.`,
    riskLevel:
      preview.severity === "blocked"
        ? "critical"
        : preview.severity === "high"
          ? "high"
          : preview.severity,
    executionKind: preview.mode === "softDelete" ? "soft-delete" : "other",
    isRecoverable: preview.mode === "softDelete",
    hasRestoreEntry: preview.mode !== "permanentDelete",
    requiresUserConfirmation: true,
    canProceed: preview.canDelete,
    affectedItems: preview.affectedItems.map((item) => ({
      entityType: item.type,
      entityId: item.id,
      title: item.title ?? item.summary,
      description: item.relation,
      severity: item.action === "blocked" ? "blocking" : "warning"
    })),
    warnings: [
      ...preview.warnings,
      ...preview.fileRefWarnings,
      preview.localFileSafetyNotice
    ],
    blockingReasons: preview.canDelete ? [] : preview.warnings,
    deepScanPerformed: true
  });
}

async function findRecycleEntry(
  adapter: OutputDeleteAdapter,
  id: EntityId,
  recycleBinId?: EntityId
) {
  if (!recycleBinId) return undefined;
  const entry = await getRecycleEntry(recycleBinId);
  if (
    !entry ||
    entry.entityType !== adapter.recycleEntityType ||
    entry.entityId !== id
  ) {
    return undefined;
  }
  return entry;
}

async function loadEntityForMode(
  adapter: OutputDeleteAdapter,
  id: EntityId,
  mode: OutputDeleteSafetyMode
) {
  return mode === "softDelete"
    ? adapter.repository.getById(id)
    : adapter.repository.getDeletedById(id);
}

export async function getOutputDeleteImpactPreview(
  input: PreviewOutputDeleteInput
): Promise<OutputDeleteImpactPreview> {
  const mode = input.mode ?? "softDelete";
  const adapter = adapters[input.layer];
  const entity = await loadEntityForMode(adapter, input.id, mode);
  const recycleEntry =
    mode === "softDelete"
      ? undefined
      : await findRecycleEntry(adapter, input.id, input.recycleBinId);
  const canDelete = Boolean(
    entity &&
      (mode === "softDelete" ||
        (recycleEntry && recycleEntry.restoreStatus === "not_started"))
  );

  const [outgoing, incoming, entityLinks, fileRefs, binding, feedbackCards] = entity
    ? await Promise.all([
        outputConversionRelationService.queryOutputConversionRelations({
          sourceType: input.layer,
          sourceId: input.id
        }),
        outputConversionRelationService.queryOutputConversionRelations({
          targetType: input.layer,
          targetId: input.id
        }),
        entityLinkService.queryLinkedEntities(adapter.entityLinkType, input.id),
        fileRefService.getFileRefsByOwnerIncludingDeleted(input.layer, input.id),
        manuscriptBindingService.getBindingByOwner(input.layer, input.id, "primary"),
        input.layer === "outputGap"
          ? gapFeedbackCardRepository.list().then((cards) =>
              cards.filter((card) => card.outputGapId === input.id)
            )
          : Promise.resolve([])
      ])
    : [[], [], [], [], undefined, []];
  const relations = uniqueById([...outgoing, ...incoming]);
  const title = entity ? adapter.title(entity) : input.id;
  const structuredSummaryExists = Boolean(entity && hasStructuredSummary(entity));
  const activeFileRefs = fileRefs.filter((fileRef) => !fileRef.deletedAt);
  const manuscriptCount = activeFileRefs.filter((fileRef) => fileRef.fileRole === "manuscript").length;
  const candidateCount = activeFileRefs.filter((fileRef) => Boolean(fileRef.candidateRequestId)).length;
  const attachmentCount = activeFileRefs.filter((fileRef) => fileRef.fileRole === "attachment").length;

  const affectedItems: OutputDeleteAffectedItem[] = [
    ...relations.map((relation) => relationAffectedItem(relation, input.layer, input.id)),
    ...entityLinks.map((link) => ({
      type:
        link.sourceType === adapter.entityLinkType && link.sourceId === input.id
          ? link.targetType
          : link.sourceType,
      id:
        link.sourceType === adapter.entityLinkType && link.sourceId === input.id
          ? link.targetId
          : link.sourceId,
      relation: link.relationType,
      action: "keepMetadata" as const,
      summary: `Cross-module ${link.relationType} EntityLink remains metadata and is not cascaded.`
    })),
    ...(binding ? [{
      type: "manuscriptBinding",
      id: binding.id,
      action: "metadataOnly" as const,
      summary: "Current manuscript Binding metadata is preserved on soft delete and invalidated before permanent delete."
    }] : []),
    ...activeFileRefs.map((fileRef) => ({
      type: "fileRef",
      id: fileRef.id,
      title: fileRef.title,
      action: "metadataOnly" as const,
      summary: `${fileRef.fileRole} FileRef metadata is in scope. The referenced local file is not accessed.`
    })),
    ...feedbackCards.map((card) => ({
      type: "outputGapFeedbackCard",
      id: card.id,
      title: card.title,
      action: "keepMetadata" as const,
      summary: "OutputGap feedback-card metadata remains linked on soft delete and restore."
    }))
  ];
  const warnings = [
    ...(!entity ? [`${input.layer} ${input.id} is not available for ${mode}.`] : []),
    ...(mode !== "softDelete" && !recycleEntry
      ? ["A matching active recycle-bin record is required."]
      : []),
    ...(recycleEntry?.restoreStatus === "restored"
      ? ["This recycle-bin record has already been restored."]
      : []),
    ...(recycleEntry?.restoreStatus === "permanently_deleted"
      ? ["This recycle-bin record has already been permanently deleted."]
      : [])
  ];
  const affectedCounts = {
    internalRelations: relations.length,
    downstreamEntities: outgoing.length,
    upstreamSources: incoming.length,
    entityLinks: entityLinks.length,
    fileRefs: activeFileRefs.length,
    manuscriptBindings: binding ? 1 : 0,
    manuscripts: manuscriptCount,
    manuscriptCandidates: candidateCount,
    attachments: attachmentCount,
    feedbackCards: feedbackCards.length,
    structuredSummaries: structuredSummaryExists ? 1 : 0
  };
  const fileRefWarnings = activeFileRefs.map(
    (fileRef) =>
      `${fileRef.title}: only the SciLoom path record is in scope; the local file is not read or deleted.`
  );
  const previewHash = stableHash({
    layer: input.layer,
    id: input.id,
    mode,
    recycleBinId: input.recycleBinId ?? null,
    entityUpdatedAt: entity?.updatedAt ?? null,
    entityDeletedAt: entity?.deletedAt ?? null,
    relationVersions: relations.map((relation) => [relation.id, relation.updatedAt]),
    entityLinkVersions: entityLinks.map((link) => [link.id, link.updatedAt]),
    bindingVersion: binding ? [binding.id, binding.updatedAt] : null,
    fileRefVersions: activeFileRefs.map((fileRef) => [fileRef.id, fileRef.updatedAt]),
    feedbackCardVersions: feedbackCards.map((card) => [card.id, card.updatedAt]),
    structuredSummaryExists
  });

  return {
    layer: input.layer,
    id: input.id,
    title,
    mode,
    recycleBinId: input.recycleBinId,
    canDelete,
    severity: previewSeverity(
      canDelete,
      relations.length,
      entityLinks.length + feedbackCards.length,
      activeFileRefs.length
    ),
    affectedCounts,
    affectedItems,
    fileRefWarnings,
    localFileSafetyNotice: OUTPUT_LOCAL_FILE_SAFETY_NOTICE,
    warnings,
    previewHash
  };
}

export function confirmOutputDeleteImpactPreview(
  preview: OutputDeleteImpactPreview
): OutputDeleteConfirmation {
  if (!preview.canDelete) {
    throw new Error("Blocked output delete preview cannot be confirmed.");
  }
  return {
    layer: preview.layer,
    id: preview.id,
    mode: preview.mode,
    confirmedByUser: true,
    confirmedAt: new Date().toISOString(),
    previewHash: preview.previewHash,
    recycleBinId: preview.recycleBinId,
    localFileSafetyAcknowledged: true
  };
}

function validateConfirmationShape(
  confirmation: OutputDeleteConfirmation,
  expectedMode: OutputDeleteSafetyMode
) {
  if (
    confirmation.confirmedByUser !== true ||
    confirmation.localFileSafetyAcknowledged !== true ||
    confirmation.mode !== expectedMode ||
    !confirmation.layer ||
    !confirmation.id ||
    !confirmation.previewHash ||
    Number.isNaN(Date.parse(confirmation.confirmedAt))
  ) {
    throw new Error("A complete user deletion confirmation object is required.");
  }
}

async function validateConfirmation(
  confirmation: OutputDeleteConfirmation,
  expectedMode: OutputDeleteSafetyMode
) {
  validateConfirmationShape(confirmation, expectedMode);
  const preview = await getOutputDeleteImpactPreview({
    layer: confirmation.layer,
    id: confirmation.id,
    mode: expectedMode,
    recycleBinId: confirmation.recycleBinId
  });
  if (!preview.canDelete) {
    throw new Error(preview.warnings.join(" ") || "Output delete operation is blocked.");
  }
  if (preview.previewHash !== confirmation.previewHash) {
    throw new Error("Output delete impact preview is stale; generate and confirm a new preview.");
  }
  return preview;
}

function resultFor(
  preview: OutputDeleteImpactPreview,
  input: Partial<OutputDeleteSafetyResult>
): OutputDeleteSafetyResult {
  return {
    ok: input.ok ?? true,
    status: input.status ?? "success",
    operation: preview.mode,
    layer: preview.layer,
    id: preview.id,
    title: preview.title,
    operationLogId: input.operationLogId,
    recycleBinId: input.recycleBinId ?? preview.recycleBinId,
    refreshHints: REFRESH_HINTS,
    warnings: input.warnings ?? [OUTPUT_LOCAL_FILE_SAFETY_NOTICE],
    skipped: input.skipped ?? [],
    retryable: input.retryable
  };
}

function publishOutputLifecycleRefresh(
  preview: OutputDeleteImpactPreview,
  status: "success" | "partial",
  warnings: string[]
) {
  const keyByLayer = {
    resultItem: "output.resultItem.changed",
    finding: "output.finding.changed",
    outputCandidate: "output.candidate.changed",
    outputGap: "output.gap.changed",
    researchOutput: "output.researchOutput.changed"
  } as const;
  try {
    publishRefreshEvent({
      id: `output-lifecycle-${preview.mode}-${preview.layer}-${preview.id}-${Date.now()}`,
      keys: [
        keyByLayer[preview.layer],
        "fileRef.changed",
        "recycleBin.changed",
        "operationLog.changed"
      ],
      affectedEntities: [{
        type: preview.layer,
        id: preview.id,
        relation: preview.mode === "restore" ? "restored" : "deleted"
      }],
      affectedScopes: [{
        module: preview.layer === "researchOutput" ? "output" : "outputConversion",
        reason: `Outputs ${preview.mode} authoritative readback completed.`
      }],
      source: "service.write",
      operation: `output.lifecycle.${preview.mode}`,
      reason: "Mounted Outputs lifecycle mutation committed and was read back authoritatively.",
      writeFeedbackStatus: status,
      warnings,
      createdAt: new Date().toISOString()
    });
    return true;
  } catch {
    return false;
  }
}

async function writeOperationLog(
  preview: OutputDeleteImpactPreview,
  operationType: "delete" | "restore" | "permanently_delete",
  recycleBinId?: EntityId
) {
  const adapter = adapters[preview.layer];
  const genericPreview = toOperationImpactPreview(preview);
  const feedback = await createOperationLog({
    operationType,
    source: "user",
    module: adapter.module,
    status: "success",
    riskLevel: preview.severity === "blocked" ? "critical" : preview.severity,
    target: {
      entityType: preview.layer,
      entityId: preview.id,
      title: preview.title
    },
    summary: `${preview.mode} completed for ${preview.layer} metadata. Local files were not accessed or deleted.`,
    relatedEntities: preview.affectedItems.map((item) => ({
      type: item.type,
      id: item.id,
      relation: item.relation ?? item.action,
      label: item.title
    })),
    impactSummary: summarizeImpactPreviewForOperationLog(genericPreview),
    confirmation: {
      required: true,
      confirmedByUser: true,
      confirmedAt: new Date().toISOString(),
      confirmationId: preview.previewHash,
      previewHash: preview.previewHash,
      localFileSafetyAcknowledged: true,
      metadataOnly: true
    },
    warnings: [OUTPUT_LOCAL_FILE_SAFETY_NOTICE],
    isRecoverable: preview.mode === "softDelete",
    recycleEntryId: recycleBinId,
    refreshKeys: ["operationLog.changed", "recycleBin.changed"]
  });
  return feedback.data;
}

function createRequiredOutputLifecycleOperationLog(
  preview: OutputDeleteImpactPreview,
  operationType: "delete" | "restore",
  occurredAt: string,
  recycleEntryId?: EntityId
) {
  const adapter = adapters[preview.layer];
  const genericPreview = toOperationImpactPreview(preview);
  return createOperationLogEntry({
    operationType,
    source: "user",
    module: adapter.module,
    status: "success",
    riskLevel: preview.severity === "blocked" ? "critical" : preview.severity,
    target: {
      entityType: preview.layer,
      entityId: preview.id,
      title: preview.title
    },
    summary: `${preview.mode} completed for ${preview.layer} metadata. Local files were not accessed or deleted.`,
    relatedEntities: preview.affectedItems.map((item) => ({
      type: item.type,
      id: item.id,
      relation: item.relation ?? item.action,
      label: item.title
    })),
    impactSummary: summarizeImpactPreviewForOperationLog(genericPreview),
    confirmation: {
      required: true,
      confirmedByUser: true,
      confirmedAt: occurredAt,
      confirmationId: preview.previewHash,
      previewHash: preview.previewHash,
      localFileSafetyAcknowledged: true,
      metadataOnly: true
    },
    warnings: [OUTPUT_LOCAL_FILE_SAFETY_NOTICE],
    errors: [],
    skipped: [],
    isRecoverable: preview.mode === "softDelete",
    recycleEntryId,
    actorId: "local_user",
    actorLabel: "Local user",
    refreshKeys: ["operationLog.changed", "recycleBin.changed"],
    schemaVersion: 1,
    createdAt: occurredAt,
    updatedAt: occurredAt
  });
}

export async function softDeleteOutputEntity({
  confirmation
}: ExecuteOutputDeleteInput): Promise<OutputDeleteSafetyResult> {
  const preview = await validateConfirmation(confirmation, "softDelete");
  const adapter = adapters[confirmation.layer];
  const lifecycle = await resolveMountedManuscriptLifecycleDecision({
    ownerType: confirmation.layer,
    ownerId: confirmation.id,
    manuscriptChannel: "primary"
  });
  if (!lifecycle.canWrite) {
    throw new Error(`OUTPUT_MANUSCRIPT_LIFECYCLE_DELETE_DENIED: ${lifecycle.reasonCode ?? "UNKNOWN"}`);
  }
  await outputManuscriptLifecycleService.assertOwnerActive(
    confirmation.layer,
    confirmation.id,
    "primary"
  );
  const sessionsClosed = await sharedManuscriptSessionRuntime.closeCleanSessions(
    (session) =>
      session.owner.ownerType === confirmation.layer &&
      session.owner.ownerId === confirmation.id &&
      session.owner.channel === "primary"
  );
  if (!sessionsClosed) {
    throw new Error("OUTPUT_MANUSCRIPT_SESSION_DIRTY");
  }
  const occurredAt = new Date().toISOString();
  const operationLog = createRequiredOutputLifecycleOperationLog(
    preview,
    "delete",
    occurredAt
  );
  const recycleEntry = createRecycleEntry({
    entityType: adapter.recycleEntityType,
    entityId: confirmation.id,
    title: preview.title,
    summary: safeRecycleSummary(preview),
    module: adapter.module,
    deletedAt: occurredAt,
    deletedBy: "user",
    operationLogId: operationLog.id,
    canRestore: true,
    knownImpactSummary: summarizeImpactPreviewForOperationLog(toOperationImpactPreview(preview)),
    restoreStatus: "not_started",
    refreshKeys: ["operationLog.changed", "recycleBin.changed"],
    createdAt: occurredAt,
    updatedAt: occurredAt
  });
  const terminal = await commitOutputLifecycleTransaction({
    mode: "softDelete",
    layer: confirmation.layer,
    ownerId: confirmation.id,
    occurredAt,
    operationLog,
    recycleEntry
  });
  if (!terminal.durableReadbackConfirmed || !terminal.ownerDeletedAt) {
    throw new Error("OUTPUT_DELETE_AUTHORITATIVE_READBACK_FAILED");
  }
  const warnings = [OUTPUT_LOCAL_FILE_SAFETY_NOTICE];
  try {
    await outputManuscriptLifecycleSessionRegistry.setOwnerDeleted(
      confirmation.layer,
      confirmation.id,
      true
    );
  } catch {
    warnings.push("Deletion was committed, but mounted session projection cleanup needs retry.");
  }

  let status: "success" | "partial" = warnings.length > 1 ? "partial" : "success";
  if (!publishOutputLifecycleRefresh(preview, status, warnings)) {
    warnings.push("Deletion was committed, but lifecycle refresh publication needs retry.");
    status = "partial";
  }
  return resultFor(preview, {
    status,
    operationLogId: terminal.operationLogId,
    recycleBinId: terminal.recycleEntryId,
    warnings
  });
}

export async function restoreOutputEntity({
  confirmation
}: ExecuteOutputDeleteInput): Promise<OutputDeleteSafetyResult> {
  const preview = await validateConfirmation(confirmation, "restore");
  const adapter = adapters[confirmation.layer];
  const lifecycle = await resolveMountedManuscriptLifecycleDecision({
    ownerType: confirmation.layer,
    ownerId: confirmation.id,
    manuscriptChannel: "primary"
  });
  if (!lifecycle.canRestore) {
    throw new Error(`OUTPUT_MANUSCRIPT_LIFECYCLE_RESTORE_DENIED: ${lifecycle.reasonCode ?? "UNKNOWN"}`);
  }
  if (!confirmation.recycleBinId) {
    throw new Error("OUTPUT_RESTORE_EXACT_RECYCLE_ENTRY_REQUIRED");
  }
  const occurredAt = new Date().toISOString();
  const operationLog = createRequiredOutputLifecycleOperationLog(
    preview,
    "restore",
    occurredAt,
    confirmation.recycleBinId
  );
  const terminal = await commitOutputLifecycleTransaction({
    mode: "restore",
    layer: confirmation.layer,
    ownerId: confirmation.id,
    occurredAt,
    operationLog,
    recycleEntryId: confirmation.recycleBinId
  });
  if (
    !terminal.durableReadbackConfirmed ||
    terminal.ownerDeletedAt ||
    terminal.recycleRestoreStatus !== "restored" ||
    terminal.recycleCanRestore
  ) {
    throw new Error("OUTPUT_RESTORE_AUTHORITATIVE_READBACK_FAILED");
  }

  const warnings = [OUTPUT_LOCAL_FILE_SAFETY_NOTICE];
  try {
    await outputManuscriptLifecycleSessionRegistry.setOwnerDeleted(
      confirmation.layer,
      confirmation.id,
      false
    );
  } catch {
    warnings.push("Restore was committed, but stale read-only session cleanup needs retry.");
  }
  let status: "success" | "partial" = warnings.length > 1 ? "partial" : "success";
  if (!publishOutputLifecycleRefresh(preview, status, warnings)) {
    warnings.push("Restore was committed, but lifecycle refresh publication needs retry.");
    status = "partial";
  }
  return resultFor(preview, {
    status,
    operationLogId: terminal.operationLogId,
    warnings
  });
}

async function permanentlyDeleteRelatedMetadata(
  layer: OutputDeleteSafetyLayer,
  id: EntityId,
  includeFileRefs: boolean
) {
  const [relations, fileRefs, entityLinks, sourceLinks, feedbackCards] = await Promise.all([
    outputConversionRelationService.queryOutputConversionRelations({
      includeDeleted: true
    }),
    fileRefService.getFileRefsByOwner(layer, id),
    entityLinkService.queryLinkedEntities(adapters[layer].entityLinkType, id),
    Promise.all([sourceLinkRepository.list(), sourceLinkRepository.listDeleted()]).then((groups) => groups.flat()),
    layer === "outputGap"
      ? Promise.all([gapFeedbackCardRepository.list(), gapFeedbackCardRepository.listDeleted()]).then((groups) => groups.flat())
      : Promise.resolve([])
  ]);
  const relatedRelations = relations.filter(
    (relation) =>
      (relation.sourceType === layer && relation.sourceId === id) ||
      (relation.targetType === layer && relation.targetId === id)
  );
  await Promise.all([
    ...relatedRelations.map((relation) => relationRepository.hardDelete(relation.id)),
    ...sourceLinks.filter((link) => link.ownerType === layer && link.ownerId === id)
      .map((link) => sourceLinkRepository.hardDelete(link.id)),
    ...feedbackCards.filter((card) => card.outputGapId === id)
      .map((card) => gapFeedbackCardRepository.hardDelete(card.id)),
    ...(includeFileRefs ? fileRefs.map(async (fileRef) => {
      const softDeleted = await fileRefService.softDeleteMetadataPrimitive(fileRef.id);
      return softDeleted ? fileRefService.hardDeleteMetadataPrimitive(fileRef.id) : false;
    }) : []),
    ...entityLinks.map((link) => entityLinkService.removeEntityLink(link.id))
  ]);
}

export async function permanentlyDeleteOutputEntity({
  confirmation
}: ExecuteOutputDeleteInput): Promise<OutputDeleteSafetyResult> {
  const preview = await validateConfirmation(confirmation, "permanentDelete");
  const adapter = adapters[confirmation.layer];
  const fileAwareLayer = isFileAwareDeleteLayer(confirmation.layer);
  if (fileAwareLayer) {
    const cleanup = await outputManuscriptLifecycleService.cleanupHardDeleteMetadata({
      ownerType: confirmation.layer,
      ownerId: confirmation.id,
      channel: "primary",
      confirmedByUser: true
    });
    if (cleanup.status !== "complete") {
      return resultFor(preview, {
        ok: false,
        status: "partial",
        retryable: cleanup.retryable,
        warnings: [...cleanup.warnings, `Manuscript metadata cleanup stopped at ${cleanup.failedStep ?? "unknown"}.`],
        skipped: ["output_entity_preserved_for_cleanup_retry"]
      });
    }
  }
  await permanentlyDeleteRelatedMetadata(confirmation.layer, confirmation.id, !fileAwareLayer);
  const deleted = await adapter.repository.hardDelete(confirmation.id);
  if (!deleted) {
    return resultFor(preview, {
      ok: false,
      status: "skipped",
      skipped: ["output_entity_not_deleted_or_already_permanently_deleted"]
    });
  }
  const operationLog = await writeOperationLog(
    preview,
    "permanently_delete",
    confirmation.recycleBinId
  );
  if (confirmation.recycleBinId) {
    await updateRecycleEntry(confirmation.recycleBinId, {
      restoreStatus: "permanently_deleted",
      canRestore: false,
      cannotRestoreReason:
        "SciLoom metadata has been permanently deleted. Referenced local files were not touched.",
      operationLogId: operationLog?.id
    });
  }

  return resultFor(preview, {
    operationLogId: operationLog?.id
  });
}

export const outputDeleteSafetyService = {
  getOutputDeleteImpactPreview,
  toOperationImpactPreview,
  confirmOutputDeleteImpactPreview,
  softDeleteOutputEntity,
  restoreOutputEntity,
  permanentlyDeleteOutputEntity
};

export type OutputDeleteSafetyService = typeof outputDeleteSafetyService;
