import {
  findingRepositoryConfig,
  outputCandidateRepositoryConfig,
  outputGapRepositoryConfig,
  resultItemRepositoryConfig
} from "../repositories/entityConfig";
import { createRepository } from "../repositories/repositoryFactory";
import type { EntityId } from "../types";
import type { CreateEntityInput, UpdateEntityInput } from "../types/common";
import type {
  ConvertOutputCandidateToResearchOutputInput,
  ConvertOutputCandidateToResearchOutputResult,
  Finding,
  IgnoreOutputGapInput,
  IgnoreOutputGapResult,
  ManualResolveOutputGapInput,
  ManualResolveOutputGapResult,
  OutputCandidate,
  OutputGap,
  OutputGapActionResult,
  OutputGapStatus,
  ResultAssetQuality,
  ResultItem,
  ResultSourceType,
  SetOutputGapStatusInput,
  SetOutputGapStatusResult,
  OutputUseType
} from "../types/outputConversion";
import type { OutputType, ResearchOutputProvenance } from "../types/output";
import type { EntityType, RelationType } from "../types/planning";
import type {
  AffectedEntity,
  AffectedScope,
  RefreshKey,
  WriteFeedbackResult,
  WriteFeedbackStatus
} from "../types/writeFeedback";
import { entityLinkService } from "./entityLinkService";
import { validateEntityReference } from "./entityReferenceResolverService";
import { outputConversionRelationService } from "./outputConversionRelationService";
import {
  normalizeFiveLayerEntity,
  normalizeStatus,
  normalizeStructuredSummary
} from "./outputFiveLayerContractService";
import { ensureOutputManuscript } from "./outputManuscriptProvisioningService";
import { outputService } from "./outputService";
import { publishWriteFeedbackRefresh } from "./refreshEventService";
import { createWriteFeedbackResult, toWriteFeedbackMessage } from "./writeFeedbackService";

const OUTPUT_CONVERSION_SCHEMA_VERSION = 1;

const resultItemRepository = createRepository<ResultItem>(resultItemRepositoryConfig);
const findingRepository = createRepository<Finding>(findingRepositoryConfig);
const outputCandidateRepository = createRepository<OutputCandidate>(
  outputCandidateRepositoryConfig
);
const outputGapRepository = createRepository<OutputGap>(outputGapRepositoryConfig);

type DefaultCreateKeys = "id" | "createdAt" | "updatedAt" | "deletedAt" | "schemaVersion";

export type CreateResultItemInput = Pick<
  ResultItem,
  "projectId" | "sourceType" | "sourceId" | "title" | "resultType"
> &
  Partial<
    Omit<
      ResultItem,
      | DefaultCreateKeys
      | "projectId"
      | "sourceType"
      | "sourceId"
      | "title"
      | "resultType"
      | "description"
    >
  >;

export type UpdateResultItemInput = Omit<UpdateEntityInput<ResultItem>, "description">;

export type MarkResultItemAsAssetInput = {
  assetReason?: string;
  assetQuality?: ResultAssetQuality;
  usableFor?: OutputUseType[];
};

export type CreateFindingInput = Pick<Finding, "projectId" | "title"> &
  Partial<Omit<Finding, DefaultCreateKeys | "projectId" | "title">> & {
    resultItemIds?: EntityId[];
    assetIds?: EntityId[];
  };

export type UpdateFindingInput = UpdateEntityInput<Finding>;

export type CreateOutputCandidateInput = Pick<
  OutputCandidate,
  "projectId" | "title" | "candidateType"
> &
  Partial<Omit<OutputCandidate, DefaultCreateKeys | "projectId" | "title" | "candidateType">> & {
    findingIds?: EntityId[];
    resultItemIds?: EntityId[];
    assetIds?: EntityId[];
  };

export type UpdateOutputCandidateInput = UpdateEntityInput<OutputCandidate>;

export type CreateOutputGapRecordInput = Pick<OutputGap, "projectId" | "title" | "gapType"> &
  Partial<Omit<OutputGap, DefaultCreateKeys | "projectId" | "title" | "gapType">> & {
    confirmedByUser: boolean;
  };

export type CreateOutputGapInput = CreateOutputGapRecordInput & {
  outputCandidateId: EntityId;
};

export type UpdateOutputGapInput = UpdateEntityInput<OutputGap>;

export type ConfirmedOutputConversionWriteInput = {
  confirmedByUser: boolean;
  note?: string | null;
};

export type CreateFindingFromResultItemsInput = ConfirmedOutputConversionWriteInput &
  Pick<CreateFindingInput, "projectId" | "title"> &
  Partial<Omit<CreateFindingInput, "projectId" | "title" | "resultItemIds" | "assetIds">> & {
    resultItemIds: EntityId[];
  };

export type CreateOutputCandidateFromFindingsInput = ConfirmedOutputConversionWriteInput &
  Pick<CreateOutputCandidateInput, "projectId" | "title" | "candidateType"> &
  Partial<Omit<CreateOutputCandidateInput, "projectId" | "title" | "candidateType" | "findingIds" | "resultItemIds" | "assetIds">> & {
    findingIds: EntityId[];
    resultItemIds?: EntityId[];
  };

function uniqueIds(ids: EntityId[]) {
  return [...new Set(ids.filter(Boolean))];
}

function normalizeLinkIds(ids: EntityId[], label: string) {
  const trimmed = ids.map((id) => (typeof id === "string" ? id.trim() : ""));
  const emptyIndex = trimmed.findIndex((id) => !id);
  if (emptyIndex >= 0) {
    throw new Error(`${label} contains an empty id at index ${emptyIndex}.`);
  }
  return [...new Set(trimmed)];
}

function now() {
  return new Date().toISOString();
}

function emptyConversionResult(): ConvertOutputCandidateToResearchOutputResult {
  return {
    warnings: [],
    skipped: [],
    linksCreated: [],
    linksSkipped: []
  };
}

function emptyOutputGapActionResult(): OutputGapActionResult {
  return {
    warnings: [],
    skipped: [],
    linksCreated: [],
    linksSkipped: []
  };
}

function outputConversionResultStatus(
  result: ConvertOutputCandidateToResearchOutputResult | OutputGapActionResult,
  changed: boolean
): WriteFeedbackStatus {
  if (result.skipped.length > 0 && !changed) {
    return "skipped";
  }
  if (result.warnings.length > 0 || result.skipped.length > 0 || result.linksSkipped.length > 0) {
    return changed ? "partial" : "skipped";
  }
  return "success";
}

function outputConversionMessages(
  result: ConvertOutputCandidateToResearchOutputResult | OutputGapActionResult
) {
  return [
    ...result.warnings.map((warning) => toWriteFeedbackMessage(warning, "warning")),
    ...result.skipped.map((skipped) =>
      toWriteFeedbackMessage(`Skipped: ${skipped}`, "warning", skipped)
    ),
    ...result.linksSkipped.map((skipped) =>
      toWriteFeedbackMessage(`EntityLink skipped: ${skipped}`, "warning")
    )
  ];
}

function entityLinkAffectedEntities(ids: string[]): AffectedEntity[] {
  return ids.map((id) => ({
    type: "entityLink",
    id,
    relation: "created"
  }));
}

export function mapOutputGapActionResultToWriteFeedback(
  operation: string,
  result: OutputGapActionResult,
  options: {
    gapId?: EntityId;
    refreshKeys?: RefreshKey[];
  } = {}
): WriteFeedbackResult {
  const updatedGap = result.updatedGap;
  const changed = Boolean(updatedGap || result.linksCreated.length > 0);
  return createWriteFeedbackResult({
    status: outputConversionResultStatus(result, changed),
    operation,
    affectedEntities: [
      ...(updatedGap
        ? [
            {
              type: "outputGap",
              id: updatedGap.id,
              relation: "updated",
              label: updatedGap.title
            }
          ]
        : options.gapId
          ? [{ type: "outputGap", id: options.gapId, relation: "skipped" }]
          : []),
      ...entityLinkAffectedEntities(result.linksCreated)
    ],
    affectedScopes: [
      {
        module: "outputConversion",
        projectId: updatedGap?.projectId,
        outputGapId: updatedGap?.id ?? options.gapId,
        reason: "OutputGap action result changed or inspected gap state."
      },
      {
        module: "review",
        projectId: updatedGap?.projectId,
        outputGapId: updatedGap?.id ?? options.gapId,
        reason: "Review context can include OutputGap closure state."
      }
    ],
    refreshKeys: options.refreshKeys ?? [
      "output.gap.changed",
      "reviewContext.changed",
      "aiContext.changed"
    ],
    messages: outputConversionMessages(result),
    warnings: result.warnings,
    skipped: result.skipped,
    partial: result.warnings.length > 0 || result.skipped.length > 0 || result.linksSkipped.length > 0
  });
}

export function mapConvertOutputCandidateToResearchOutputResultToWriteFeedback(
  result: ConvertOutputCandidateToResearchOutputResult,
  options: {
    candidateId?: EntityId;
  } = {}
): WriteFeedbackResult<ConvertOutputCandidateToResearchOutputResult> {
  const candidate = result.updatedCandidate;
  const output = result.createdOutput ?? result.existingOutput;
  const changed = Boolean(result.createdOutput || result.updatedCandidate || result.linksCreated.length > 0);
  const affectedEntities: AffectedEntity[] = [
    ...(candidate
      ? [
          {
            type: "outputCandidate",
            id: candidate.id,
            relation: result.updatedCandidate ? "updated" : "skipped",
            label: candidate.title
          }
        ]
      : options.candidateId
        ? [{ type: "outputCandidate", id: options.candidateId, relation: "skipped" }]
        : []),
    ...(output
      ? [
          {
            type: "researchOutput",
            id: output.id,
            relation: result.createdOutput ? "created" : "reused",
            label: output.outputName
          }
        ]
      : []),
    ...entityLinkAffectedEntities(result.linksCreated)
  ];
  const affectedScopes: AffectedScope[] = [
    {
      module: "outputConversion",
      projectId: candidate?.projectId ?? output?.projectId,
      outputCandidateId: candidate?.id ?? options.candidateId,
      researchOutputId: output?.id,
      reason: "OutputCandidate conversion state changed or was inspected."
    },
    {
      module: "output",
      projectId: output?.projectId ?? candidate?.projectId,
      outputCandidateId: candidate?.id ?? options.candidateId,
      researchOutputId: output?.id,
      reason: "ResearchOutput can be created or reused by OutputCandidate conversion."
    },
    {
      module: "review",
      projectId: candidate?.projectId ?? output?.projectId,
      outputCandidateId: candidate?.id ?? options.candidateId,
      researchOutputId: output?.id,
      reason: "Review context can include candidate conversion and formal output state."
    }
  ];
  return createWriteFeedbackResult({
    status: outputConversionResultStatus(result, changed),
    operation: "outputConversion.convertOutputCandidateToResearchOutput",
    data: result,
    affectedEntities,
    affectedScopes,
    refreshKeys: [
      "output.candidate.changed",
      "output.researchOutput.changed",
      "entityLink.changed",
      "reviewContext.changed",
      "aiContext.changed"
    ],
    messages: outputConversionMessages(result),
    warnings: result.warnings,
    skipped: result.skipped,
    partial: result.warnings.length > 0 || result.skipped.length > 0 || result.linksSkipped.length > 0
  });
}

function publishOutputConversionWriteFeedback(
  feedback: WriteFeedbackResult,
  reason: string
) {
  publishWriteFeedbackRefresh(feedback, {
    source: "service.write",
    reason
  });
}

function publishOutputConversionEntityRefresh(
  operation: string,
  refreshKey: RefreshKey,
  entityType: "resultItem" | "finding" | "outputCandidate" | "outputGap",
  entity: { id: EntityId; projectId: EntityId; title?: string },
  relation: "created" | "updated",
  scopeExtra: Partial<AffectedScope> = {}
) {
  publishOutputConversionWriteFeedback(
    createWriteFeedbackResult({
      status: "success",
      operation,
      affectedEntities: [
        {
          type: entityType,
          id: entity.id,
          relation,
          label: entity.title
        }
      ],
      affectedScopes: [
        {
          module: "outputConversion",
          projectId: entity.projectId,
          ...scopeExtra
        }
      ],
      refreshKeys: [refreshKey, "reviewContext.changed", "aiContext.changed"]
    }),
    operation
  );
}

function outputGapActionRefreshKeys(
  result: OutputGapActionResult
): RefreshKey[] {
  const gap = result.updatedGap;
  const hasTaskRelation = Boolean(gap?.relatedTaskId);
  const hasRouteRelation = Boolean(gap?.relatedRouteNodeId);
  return [
    "output.gap.changed",
    "reviewContext.changed",
    "aiContext.changed",
    ...(hasTaskRelation ? (["task.changed"] as RefreshKey[]) : []),
    ...(hasRouteRelation ? (["route.changed"] as RefreshKey[]) : []),
    ...(hasTaskRelation || hasRouteRelation ? (["project.changed"] as RefreshKey[]) : []),
    ...(result.linksCreated.length > 0 || result.linksSkipped.length > 0
      ? (["entityLink.changed"] as RefreshKey[])
      : [])
  ];
}

function publishOutputGapActionRefresh(
  operation: string,
  result: OutputGapActionResult,
  gapId?: EntityId
) {
  publishOutputConversionWriteFeedback(
    mapOutputGapActionResultToWriteFeedback(operation, result, {
      gapId,
      refreshKeys: outputGapActionRefreshKeys(result)
    }),
    operation
  );
}

function publishCandidateConversionRefresh(
  result: ConvertOutputCandidateToResearchOutputResult,
  candidateId?: EntityId
) {
  publishOutputConversionWriteFeedback(
    mapConvertOutputCandidateToResearchOutputResultToWriteFeedback(result, { candidateId }),
    "outputConversion.convertOutputCandidateToResearchOutput"
  );
}

function textOrUndefined(value?: string | null) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function confirmedByUser(input: ConfirmedOutputConversionWriteInput) {
  return input.confirmedByUser === true;
}

function upsertOutputGapActionField(
  gap: OutputGap,
  id: EntityId,
  name: string,
  value: string,
  valueType: "text" | "date" = "text"
) {
  return [
    ...(gap.customFields ?? []).filter((field) => field.id !== id),
    {
      id,
      name,
      value,
      valueType,
      group: "outputGapAction"
    }
  ];
}

function outputGapActionCustomFields(gap: OutputGap, action: string, note?: string | null) {
  const timestamp = now();
  let fields = upsertOutputGapActionField(
    gap,
    "output-gap-action-last-action",
    "lastAction",
    action
  );
  fields = upsertOutputGapActionField(
    { ...gap, customFields: fields },
    "output-gap-action-updated-at",
    "actionUpdatedAt",
    timestamp,
    "date"
  );
  const actionNote = textOrUndefined(note);
  if (actionNote) {
    fields = upsertOutputGapActionField(
      { ...gap, customFields: fields },
      "output-gap-action-note",
      "actionNote",
      actionNote
    );
  }
  return fields;
}

function isFinalOutputGapStatus(status: OutputGapStatus) {
  return status === "resolved" || status === "abandoned";
}

function outputTypeFromCandidateType(candidateType: OutputCandidate["candidateType"]): OutputType {
  switch (candidateType) {
    case "paper":
      return "paper_draft";
    case "report":
      return "report";
    case "dataset":
      return "dataset";
    case "software":
      return "code";
    case "model":
      return "result";
    case "presentation":
      return "presentation";
    case "method":
      return "note";
    case "patent":
    case "caseStudy":
    case "futureProject":
    case "other":
    default:
      return "other";
  }
}

function getUnresolvedGaps(gaps: OutputGap[]) {
  return gaps.filter(
    (gap) =>
      gap.status === "pending" ||
      gap.status === "task_created" ||
      gap.status === "route_feedback_created"
  );
}

type CandidateEvidenceIds = {
  findingIds: EntityId[];
  directResultItemIds: EntityId[];
  resultItemIds: EntityId[];
  assetIds: EntityId[];
};

function buildEvidenceSummary(
  candidate: OutputCandidate,
  gaps: OutputGap[],
  evidence: CandidateEvidenceIds
) {
  const findingCount = evidence.findingIds.length;
  const resultItemCount = evidence.resultItemIds.length;
  const assetCount = evidence.assetIds.length;
  const gapCount = gaps.length;
  return [
    `Converted from OutputCandidate ${candidate.id}.`,
    `Evidence refs: ${findingCount} finding(s), ${resultItemCount} result item(s), ${assetCount} asset ref(s).`,
    `OutputGap refs: ${gapCount}.`
  ].join(" ");
}

async function getFindingResultItemIds(findingId: EntityId) {
  const relations = await outputConversionRelationService.queryOutputConversionRelations({
    targetType: "finding",
    targetId: findingId,
    sourceType: "resultItem",
    relationType: "evidence_for"
  });
  return uniqueIds(relations.map((relation) => relation.sourceId));
}

async function getCandidateFindingIds(candidateId: EntityId) {
  const relations = await outputConversionRelationService.queryOutputConversionRelations({
    targetType: "outputCandidate",
    targetId: candidateId,
    sourceType: "finding",
    relationType: "supports"
  });
  return uniqueIds(relations.map((relation) => relation.sourceId));
}

async function getCandidateDirectResultItemIds(candidateId: EntityId) {
  const relations = await outputConversionRelationService.queryOutputConversionRelations({
    targetType: "outputCandidate",
    targetId: candidateId,
    sourceType: "resultItem",
    relationType: "uses"
  });
  return uniqueIds(relations.map((relation) => relation.sourceId));
}

async function getCandidateEvidenceIds(candidateId: EntityId): Promise<CandidateEvidenceIds> {
  const findingIds = await getCandidateFindingIds(candidateId);
  const findingResultItemIds = (
    await Promise.all(findingIds.map((findingId) => getFindingResultItemIds(findingId)))
  ).flat();
  const directResultItemIds = await getCandidateDirectResultItemIds(candidateId);
  const resultItemIds = uniqueIds([...directResultItemIds, ...findingResultItemIds]);
  const resultItems = await Promise.all(
    resultItemIds.map((resultItemId) => resultItemRepository.getById(resultItemId))
  );
  return {
    findingIds,
    directResultItemIds,
    resultItemIds,
    assetIds: resultItems
      .filter((item): item is ResultItem => Boolean(item?.isAsset))
      .map((item) => item.id)
  };
}

async function inferExperimentIdFromCandidate(candidateId: EntityId) {
  const evidence = await getCandidateEvidenceIds(candidateId);
  const resultItems = await Promise.all(
    evidence.resultItemIds.map((resultItemId) => resultItemRepository.getById(resultItemId))
  );
  return (
    resultItems.find((resultItem): resultItem is ResultItem =>
      Boolean(resultItem?.experimentId)
    )?.experimentId ?? undefined
  );
}

async function findOutputByCandidateRelation(candidateId: EntityId) {
  const relation = (
    await outputConversionRelationService.queryOutputConversionRelations({
      sourceType: "outputCandidate",
      sourceId: candidateId,
      targetType: "researchOutput",
      relationType: "converted_to"
    })
  )[0];
  return relation ? outputService.getById(relation.targetId) : undefined;
}

async function assertEntityReferenceValid(targetType: EntityType, targetId: EntityId, label: string) {
  const validation = await validateEntityReference({ targetType, targetId, origin: "system" });
  if (!validation.valid) {
    throw new Error(
      `${label} is invalid: ${
        validation.resolution.message ?? validation.missingReference?.reason ?? validation.resolution.status
      }`
    );
  }
}

async function getResultItemsOrThrow(resultItemIds: EntityId[], label: string) {
  const requestedIds = normalizeLinkIds(resultItemIds, label);
  const resultItems = await Promise.all(
    requestedIds.map((id) => resultItemRepository.getById(id))
  );
  const missingIds = requestedIds.filter((_id, index) => !resultItems[index]);
  if (missingIds.length > 0) {
    throw new Error(`${label} contains missing ResultItem ids: ${missingIds.join(", ")}`);
  }
  return resultItems.filter((item): item is ResultItem => Boolean(item));
}

async function getFindingsOrThrow(findingIds: EntityId[], label: string) {
  const requestedIds = normalizeLinkIds(findingIds, label);
  const findings = await Promise.all(requestedIds.map((id) => findingRepository.getById(id)));
  const missingIds = requestedIds.filter((_id, index) => !findings[index]);
  if (missingIds.length > 0) {
    throw new Error(`${label} contains missing Finding ids: ${missingIds.join(", ")}`);
  }
  return findings.filter((finding): finding is Finding => Boolean(finding));
}

async function ensureEntityLink(
  sourceType: EntityType,
  sourceId: EntityId,
  targetType: EntityType,
  targetId: EntityId,
  relationType: RelationType,
  description?: string
) {
  return entityLinkService.ensureEntityLink({
    sourceType,
    sourceId,
    targetType,
    targetId,
    relationType,
    description
  });
}

function toResultItemCreateInput(input: CreateResultItemInput): CreateEntityInput<ResultItem> {
  return {
    projectId: input.projectId,
    routeId: input.routeId ?? null,
    taskId: input.taskId ?? null,
    experimentId: input.experimentId ?? null,
    experimentRunId: input.experimentRunId ?? null,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    title: input.title,
    resultType: input.resultType,
    status: normalizeStatus("resultItem", input.status) as ResultItem["status"],
    structuredSummary: normalizeStructuredSummary("resultItem", input.structuredSummary),
    summary: input.summary ?? "",
    value: input.value,
    unit: input.unit,
    fileRefId: input.fileRefId ?? null,
    tags: input.tags ?? [],
    isAsset: input.isAsset ?? false,
    assetMarkedAt: input.assetMarkedAt ?? null,
    assetReason: input.assetReason,
    assetQuality: input.assetQuality,
    usableFor: input.usableFor ?? [],
    schemaVersion: OUTPUT_CONVERSION_SCHEMA_VERSION,
    customFields: input.customFields ?? []
  };
}

function assertResultItemSourceIsNotLegacyMetric(sourceType: ResultSourceType) {
  if (sourceType === "resultMetric") {
    throw new Error(
      "ResultMetric cannot be used as a ResultItem source. Use experimentOutputGenerationService so the canonical source resolves to ExperimentRun or Experiment."
    );
  }
}

function toFindingCreateInput(input: CreateFindingInput): CreateEntityInput<Finding> {
  return {
    projectId: input.projectId,
    routeId: input.routeId ?? null,
    taskId: input.taskId ?? null,
    experimentId: input.experimentId ?? null,
    title: input.title,
    summary: input.summary ?? "",
    status: normalizeStatus("finding", input.status) as Finding["status"],
    structuredSummary: normalizeStructuredSummary("finding", input.structuredSummary),
    findingType: input.findingType,
    confidence: input.confidence,
    maturity: input.maturity,
    tags: input.tags ?? [],
    schemaVersion: OUTPUT_CONVERSION_SCHEMA_VERSION,
    customFields: input.customFields ?? []
  };
}

function toOutputCandidateCreateInput(
  input: CreateOutputCandidateInput
): CreateEntityInput<OutputCandidate> {
  return {
    projectId: input.projectId,
    routeId: input.routeId ?? null,
    taskId: input.taskId ?? null,
    title: input.title,
    description: input.description,
    candidateType: input.candidateType,
    status: normalizeStatus("outputCandidate", input.status) as OutputCandidate["status"],
    structuredSummary: normalizeStructuredSummary("outputCandidate", input.structuredSummary),
    maturity: input.maturity,
    priority: input.priority,
    tags: input.tags ?? [],
    schemaVersion: OUTPUT_CONVERSION_SCHEMA_VERSION,
    customFields: input.customFields ?? []
  };
}

function toOutputGapCreateInput(input: CreateOutputGapRecordInput): CreateEntityInput<OutputGap> {
  return {
    projectId: input.projectId,
    title: input.title,
    description: input.description,
    gapType: input.gapType,
    status: normalizeStatus("outputGap", input.status) as OutputGap["status"],
    structuredSummary: normalizeStructuredSummary("outputGap", input.structuredSummary),
    priority: input.priority,
    relatedTaskId: input.relatedTaskId ?? null,
    relatedRouteNodeId: input.relatedRouteNodeId ?? null,
    resolvedAt: input.resolvedAt ?? null,
    schemaVersion: OUTPUT_CONVERSION_SCHEMA_VERSION,
    customFields: input.customFields ?? []
  };
}

async function listResultItems() {
  return (await resultItemRepository.list()).map((item) =>
    normalizeFiveLayerEntity("resultItem", item) as ResultItem
  );
}

async function listDeletedResultItems() {
  return (await resultItemRepository.listDeleted()).map((item) =>
    normalizeFiveLayerEntity("resultItem", item) as ResultItem
  );
}

async function getResultItemById(id: EntityId) {
  const item = await resultItemRepository.getById(id);
  return item ? (normalizeFiveLayerEntity("resultItem", item) as ResultItem) : undefined;
}

async function getDeletedResultItemById(id: EntityId) {
  const item = await resultItemRepository.getDeletedById(id);
  return item ? (normalizeFiveLayerEntity("resultItem", item) as ResultItem) : undefined;
}

async function getResultItemBySource(sourceType: ResultSourceType, sourceId: EntityId) {
  return (await resultItemRepository.list()).find(
    (item) => item.sourceType === sourceType && item.sourceId === sourceId
  );
}

async function getResultItemsBySourceIds(
  sourceType: ResultSourceType,
  sourceIds: EntityId[]
) {
  const sourceIdSet = new Set(sourceIds);
  return (await resultItemRepository.list()).filter(
    (item) => item.sourceType === sourceType && sourceIdSet.has(item.sourceId)
  );
}

async function createResultItem(input: CreateResultItemInput) {
  assertResultItemSourceIsNotLegacyMetric(input.sourceType);
  if (input.sourceType === "experiment") {
    await assertEntityReferenceValid(
      "experiment",
      input.sourceId,
      "ResultItem experiment source link target"
    );
  }
  const created = await resultItemRepository.create(toResultItemCreateInput(input));
  if (created.sourceType === "experiment") {
    await ensureEntityLink(
      "resultItem",
      created.id,
      "experiment",
      created.sourceId,
      "derived_from",
      "ResultItem source: experiment"
    );
  }
  publishOutputConversionEntityRefresh(
    "outputConversion.createResultItem",
    "output.resultItem.changed",
    "resultItem",
    created,
    "created"
  );
  await ensureOutputManuscript("resultItem", created.id, "primary");
  return created;
}

async function ensureResultItemForSource(input: CreateResultItemInput) {
  assertResultItemSourceIsNotLegacyMetric(input.sourceType);

  const existing = await getResultItemBySource(input.sourceType, input.sourceId);
  if (existing) {
    return { resultItem: existing, created: false };
  }

  const resultItem = await createResultItem(input);
  return { resultItem, created: true };
}

async function updateResultItem(id: EntityId, patch: UpdateResultItemInput) {
  const existing = await resultItemRepository.getById(id);
  if (!existing) {
    return undefined;
  }

  const nextSourceType = patch.sourceType ?? existing.sourceType;
  const nextSourceId = patch.sourceId ?? existing.sourceId;
  if (patch.sourceType !== undefined) {
    assertResultItemSourceIsNotLegacyMetric(nextSourceType);
  }
  if (nextSourceType === "experiment") {
    await assertEntityReferenceValid(
      "experiment",
      nextSourceId,
      "ResultItem experiment source link target"
    );
  }

  const updated = await resultItemRepository.update(id, {
    ...patch,
    status: normalizeStatus("resultItem", patch.status ?? existing.status) as ResultItem["status"],
    structuredSummary: normalizeStructuredSummary(
      "resultItem",
      patch.structuredSummary ?? existing.structuredSummary
    ),
    tags: patch.tags ?? existing.tags ?? [],
    usableFor: patch.usableFor ?? existing.usableFor ?? [],
    customFields: patch.customFields ?? existing.customFields ?? [],
    schemaVersion: OUTPUT_CONVERSION_SCHEMA_VERSION
  });
  if (updated) {
    publishOutputConversionEntityRefresh(
      "outputConversion.updateResultItem",
      "output.resultItem.changed",
      "resultItem",
      updated,
      "updated"
    );
  }
  return updated;
}

async function updateResultItemStatus(id: EntityId, status: ResultItem["status"]) {
  return updateResultItem(id, { status });
}

async function markResultItemAsAsset(
  resultItemId: EntityId,
  input: MarkResultItemAsAssetInput = {}
) {
  return updateResultItem(resultItemId, {
    isAsset: true,
    status: "marked",
    assetMarkedAt: now(),
    assetReason: input.assetReason,
    assetQuality: input.assetQuality,
    usableFor: input.usableFor
  });
}

async function unmarkResultItemAsAsset(resultItemId: EntityId) {
  return updateResultItem(resultItemId, {
    isAsset: false,
    assetMarkedAt: null,
    assetReason: undefined,
    assetQuality: undefined,
    usableFor: []
  });
}

async function createFindingFromResultItems(input: CreateFindingFromResultItemsInput) {
  if (!confirmedByUser(input)) {
    throw new Error("createFindingFromResultItems requires explicit user confirmation.");
  }
  return createFinding({
    ...input,
    resultItemIds: input.resultItemIds,
    assetIds: input.resultItemIds
  });
}

async function listFindings() {
  return (await findingRepository.list()).map((finding) =>
    normalizeFiveLayerEntity("finding", finding) as Finding
  );
}

async function listDeletedFindings() {
  return (await findingRepository.listDeleted()).map((finding) =>
    normalizeFiveLayerEntity("finding", finding) as Finding
  );
}

async function getFindingById(id: EntityId) {
  const finding = await findingRepository.getById(id);
  return finding ? (normalizeFiveLayerEntity("finding", finding) as Finding) : undefined;
}

async function getDeletedFindingById(id: EntityId) {
  const finding = await findingRepository.getDeletedById(id);
  return finding ? (normalizeFiveLayerEntity("finding", finding) as Finding) : undefined;
}

async function createFinding(input: CreateFindingInput) {
  const resultItemIds = uniqueIds([...(input.resultItemIds ?? []), ...(input.assetIds ?? [])]);
  await getResultItemsOrThrow(resultItemIds, "Finding resultItemIds");
  const finding = await findingRepository.create(toFindingCreateInput(input));
  await linkFindingToResultItems(finding.id, resultItemIds);
  // The durable owner already exists. Publish that committed state before
  // provisioning so the authoritative READY/partial feedback remains last.
  publishOutputConversionEntityRefresh(
    "outputConversion.createFinding",
    "output.finding.changed",
    "finding",
    finding,
    "created"
  );
  await ensureOutputManuscript("finding", finding.id, "primary");
  return finding;
}

async function updateFinding(id: EntityId, patch: UpdateFindingInput) {
  const existing = await findingRepository.getById(id);
  if (!existing) {
    return undefined;
  }

  const updated = await findingRepository.update(id, {
    ...patch,
    status: normalizeStatus("finding", patch.status ?? existing.status) as Finding["status"],
    structuredSummary: normalizeStructuredSummary(
      "finding",
      patch.structuredSummary ?? existing.structuredSummary
    ),
    tags: patch.tags ?? existing.tags ?? [],
    customFields: patch.customFields ?? existing.customFields ?? [],
    schemaVersion: OUTPUT_CONVERSION_SCHEMA_VERSION
  });
  if (updated) {
    publishOutputConversionEntityRefresh(
      "outputConversion.updateFinding",
      "output.finding.changed",
      "finding",
      updated,
      "updated"
    );
  }
  return updated;
}

async function updateFindingStatus(id: EntityId, status: Finding["status"]) {
  return updateFinding(id, { status });
}

async function linkFindingToResultItems(findingId: EntityId, resultItemIds: EntityId[]) {
  const finding = await findingRepository.getById(findingId);
  if (!finding) {
    return undefined;
  }

  const validResultItems = await getResultItemsOrThrow(resultItemIds, "Finding linkedResultItemIds");
  await outputConversionRelationService.replaceOutputConversionRelationsForTarget(
    {
      sourceType: "resultItem",
      targetType: "finding",
      targetId: findingId,
      relationType: "evidence_for"
    },
    validResultItems.map((item) => ({
      projectId: finding.projectId,
      sourceType: "resultItem",
      sourceId: item.id,
      relationType: "evidence_for"
    }))
  );

  return getFindingById(findingId);
}

async function unlinkFindingFromResultItem(findingId: EntityId, resultItemId: EntityId) {
  const finding = await findingRepository.getById(findingId);
  if (!finding) {
    return undefined;
  }

  await outputConversionRelationService.deleteOutputConversionRelationsByQuery({
    sourceType: "resultItem",
    sourceId: resultItemId,
    targetType: "finding",
    targetId: findingId,
    relationType: "evidence_for"
  });
  return getFindingById(findingId);
}

async function listOutputCandidates() {
  return (await outputCandidateRepository.list()).map((candidate) =>
    normalizeFiveLayerEntity("outputCandidate", candidate) as OutputCandidate
  );
}

async function listDeletedOutputCandidates() {
  return (await outputCandidateRepository.listDeleted()).map((candidate) =>
    normalizeFiveLayerEntity("outputCandidate", candidate) as OutputCandidate
  );
}

async function getOutputCandidateById(id: EntityId) {
  const candidate = await outputCandidateRepository.getById(id);
  return candidate
    ? (normalizeFiveLayerEntity("outputCandidate", candidate) as OutputCandidate)
    : undefined;
}

async function getDeletedOutputCandidateById(id: EntityId) {
  const candidate = await outputCandidateRepository.getDeletedById(id);
  return candidate
    ? (normalizeFiveLayerEntity("outputCandidate", candidate) as OutputCandidate)
    : undefined;
}

async function createOutputCandidate(input: CreateOutputCandidateInput) {
  const findingIds = input.findingIds ?? [];
  const resultItemIds = uniqueIds([...(input.resultItemIds ?? []), ...(input.assetIds ?? [])]);
  await Promise.all([
    getFindingsOrThrow(findingIds, "OutputCandidate findingIds"),
    getResultItemsOrThrow(resultItemIds, "OutputCandidate resultItemIds")
  ]);
  const candidate = await outputCandidateRepository.create(toOutputCandidateCreateInput(input));
  await Promise.all([
    linkCandidateToFindings(candidate.id, findingIds),
    linkCandidateToResultItems(candidate.id, resultItemIds)
  ]);
  // The durable owner already exists. Publish that committed state before
  // provisioning so the authoritative READY/partial feedback remains last.
  publishOutputConversionEntityRefresh(
    "outputConversion.createOutputCandidate",
    "output.candidate.changed",
    "outputCandidate",
    candidate,
    "created",
    { outputCandidateId: candidate.id }
  );
  await ensureOutputManuscript("outputCandidate", candidate.id, "primary");
  return candidate;
}

async function updateOutputCandidate(id: EntityId, patch: UpdateOutputCandidateInput) {
  const existing = await outputCandidateRepository.getById(id);
  if (!existing) {
    return undefined;
  }

  const updated = await outputCandidateRepository.update(id, {
    ...patch,
    status: normalizeStatus(
      "outputCandidate",
      patch.status ?? existing.status
    ) as OutputCandidate["status"],
    structuredSummary: normalizeStructuredSummary(
      "outputCandidate",
      patch.structuredSummary ?? existing.structuredSummary
    ),
    tags: patch.tags ?? existing.tags ?? [],
    customFields: patch.customFields ?? existing.customFields ?? [],
    schemaVersion: OUTPUT_CONVERSION_SCHEMA_VERSION
  });
  if (updated) {
    publishOutputConversionEntityRefresh(
      "outputConversion.updateOutputCandidate",
      "output.candidate.changed",
      "outputCandidate",
      updated,
      "updated",
      { outputCandidateId: updated.id }
    );
  }
  return updated;
}

async function updateOutputCandidateStatus(id: EntityId, status: OutputCandidate["status"]) {
  return updateOutputCandidate(id, { status });
}

async function createOutputCandidateFromFindings(
  input: CreateOutputCandidateFromFindingsInput
) {
  if (!confirmedByUser(input)) {
    throw new Error("createOutputCandidateFromFindings requires explicit user confirmation.");
  }
  return createOutputCandidate({
    ...input,
    findingIds: input.findingIds,
    resultItemIds: input.resultItemIds ?? [],
    assetIds: input.resultItemIds ?? []
  });
}

async function linkCandidateToFindings(candidateId: EntityId, findingIds: EntityId[]) {
  const candidate = await outputCandidateRepository.getById(candidateId);
  if (!candidate) {
    return undefined;
  }

  const validFindings = await getFindingsOrThrow(findingIds, "OutputCandidate linkedFindingIds");
  await outputConversionRelationService.replaceOutputConversionRelationsForTarget(
    {
      sourceType: "finding",
      targetType: "outputCandidate",
      targetId: candidateId,
      relationType: "supports"
    },
    validFindings.map((finding) => ({
      projectId: candidate.projectId,
      sourceType: "finding",
      sourceId: finding.id,
      relationType: "supports"
    }))
  );

  return getOutputCandidateById(candidateId);
}

async function unlinkCandidateFromFinding(candidateId: EntityId, findingId: EntityId) {
  const candidate = await outputCandidateRepository.getById(candidateId);
  if (!candidate) {
    return undefined;
  }

  await outputConversionRelationService.deleteOutputConversionRelationsByQuery({
    sourceType: "finding",
    sourceId: findingId,
    targetType: "outputCandidate",
    targetId: candidateId,
    relationType: "supports"
  });
  return getOutputCandidateById(candidateId);
}

async function linkCandidateToResultItems(candidateId: EntityId, resultItemIds: EntityId[]) {
  const candidate = await outputCandidateRepository.getById(candidateId);
  if (!candidate) {
    return undefined;
  }

  const validResultItems = await getResultItemsOrThrow(
    resultItemIds,
    "OutputCandidate linkedResultItemIds"
  );
  await outputConversionRelationService.replaceOutputConversionRelationsForTarget(
    {
      sourceType: "resultItem",
      targetType: "outputCandidate",
      targetId: candidateId,
      relationType: "uses"
    },
    validResultItems.map((item) => ({
      projectId: candidate.projectId,
      sourceType: "resultItem",
      sourceId: item.id,
      relationType: "uses"
    }))
  );

  return getOutputCandidateById(candidateId);
}

async function unlinkCandidateFromResultItem(candidateId: EntityId, resultItemId: EntityId) {
  const candidate = await outputCandidateRepository.getById(candidateId);
  if (!candidate) {
    return undefined;
  }

  await outputConversionRelationService.deleteOutputConversionRelationsByQuery({
    sourceType: "resultItem",
    sourceId: resultItemId,
    targetType: "outputCandidate",
    targetId: candidateId,
    relationType: "uses"
  });
  return getOutputCandidateById(candidateId);
}

async function listOutputGaps() {
  return (await outputGapRepository.list()).map((gap) =>
    normalizeFiveLayerEntity("outputGap", gap) as OutputGap
  );
}

async function listDeletedOutputGaps() {
  return (await outputGapRepository.listDeleted()).map((gap) =>
    normalizeFiveLayerEntity("outputGap", gap) as OutputGap
  );
}

async function getOutputGapById(id: EntityId) {
  const gap = await outputGapRepository.getById(id);
  return gap ? (normalizeFiveLayerEntity("outputGap", gap) as OutputGap) : undefined;
}

async function getDeletedOutputGapById(id: EntityId) {
  const gap = await outputGapRepository.getDeletedById(id);
  return gap ? (normalizeFiveLayerEntity("outputGap", gap) as OutputGap) : undefined;
}

async function createOutputGap(input: CreateOutputGapInput) {
  if (input.confirmedByUser !== true) {
    throw new Error("createOutputGap requires explicit user confirmation.");
  }
  const candidate = await outputCandidateRepository.getById(input.outputCandidateId);
  if (!candidate) {
    throw new Error(`OutputGap target OutputCandidate not found: ${input.outputCandidateId}`);
  }
  if (candidate.projectId !== input.projectId) {
    throw new Error(
      `OutputGap target OutputCandidate belongs to another project: ${input.outputCandidateId}`
    );
  }
  const gap = await outputGapRepository.create(toOutputGapCreateInput(input));
  const persistedGap = await outputGapRepository.getById(gap.id);
  if (!persistedGap || persistedGap.projectId !== input.projectId) {
    throw new Error(
      "OutputGap was submitted but is not readable from the current persistence source."
    );
  }
  await outputConversionRelationService.ensureOutputConversionRelation({
    projectId: persistedGap.projectId,
    sourceType: "outputGap",
    sourceId: persistedGap.id,
    targetType: "outputCandidate",
    targetId: candidate.id,
    relationType: "blocks"
  });
  const normalizedGap = normalizeFiveLayerEntity("outputGap", persistedGap) as OutputGap;
  // The durable owner already exists. Publish that committed state before
  // provisioning so the authoritative READY/partial feedback remains last.
  publishOutputConversionEntityRefresh(
    "outputConversion.createOutputGap",
    "output.gap.changed",
    "outputGap",
    normalizedGap,
    "created",
    { outputGapId: normalizedGap.id, outputCandidateId: candidate.id }
  );
  await ensureOutputManuscript("outputGap", normalizedGap.id, "primary");
  return normalizedGap;
}

async function createOutputGapForDeposition(input: CreateOutputGapRecordInput) {
  if (input.confirmedByUser !== true) {
    throw new Error("createOutputGapForDeposition requires explicit user confirmation.");
  }
  const gap = await outputGapRepository.create(toOutputGapCreateInput(input));
  const persistedGap = await outputGapRepository.getById(gap.id);
  if (!persistedGap || persistedGap.projectId !== input.projectId) {
    throw new Error(
      "OutputGap deposition target is not readable from the current persistence source."
    );
  }
  const normalizedGap = normalizeFiveLayerEntity("outputGap", persistedGap) as OutputGap;
  // The durable owner already exists. Publish that committed state before
  // provisioning so the authoritative READY/partial feedback remains last.
  publishOutputConversionEntityRefresh(
    "outputConversion.createOutputGapForDeposition",
    "output.gap.changed",
    "outputGap",
    normalizedGap,
    "created",
    { outputGapId: normalizedGap.id }
  );
  await ensureOutputManuscript("outputGap", normalizedGap.id, "primary");
  return normalizedGap;
}

async function updateOutputGap(id: EntityId, patch: UpdateOutputGapInput) {
  const existing = await outputGapRepository.getById(id);
  if (!existing) {
    return undefined;
  }

  const updated = await outputGapRepository.update(id, {
    ...patch,
    status: normalizeStatus("outputGap", patch.status ?? existing.status) as OutputGap["status"],
    structuredSummary: normalizeStructuredSummary(
      "outputGap",
      patch.structuredSummary ?? existing.structuredSummary
    ),
    customFields: patch.customFields ?? existing.customFields ?? [],
    schemaVersion: OUTPUT_CONVERSION_SCHEMA_VERSION
  });
  if (updated) {
    publishOutputConversionEntityRefresh(
      "outputConversion.updateOutputGap",
      "output.gap.changed",
      "outputGap",
      updated,
      "updated",
      { outputGapId: updated.id }
    );
  }
  return updated;
}

async function updateOutputGapStatus(id: EntityId, status: Exclude<OutputGapStatus, "resolved" | "abandoned">) {
  return setOutputGapStatus({
    gapId: id,
    status,
    confirmedByUser: true
  });
}

async function setOutputGapStatus(
  inputOrId: SetOutputGapStatusInput | EntityId,
  legacyStatus?: OutputGapStatus
): Promise<SetOutputGapStatusResult> {
  const input =
    typeof inputOrId === "string"
      ? {
          gapId: inputOrId,
          status: legacyStatus as SetOutputGapStatusInput["status"],
          confirmedByUser: false
        }
      : inputOrId;
  const result = emptyOutputGapActionResult();

  if (!input.gapId || !input.status) {
    result.warnings.push("OutputGap status update requires gapId and status.");
    result.skipped.push("invalid_status_input");
    return result;
  }

  if (isFinalOutputGapStatus(input.status as OutputGapStatus)) {
    result.warnings.push("Final OutputGap statuses must use manual resolve or ignore services.");
    result.skipped.push("final_status_requires_dedicated_service");
    return result;
  }

  if (input.confirmedByUser !== true) {
    result.warnings.push("OutputGap status update requires explicit user confirmation.");
    result.skipped.push("user_confirmation_required");
    return result;
  }

  const gap = await outputGapRepository.getById(input.gapId);
  if (!gap) {
    result.warnings.push(`OutputGap not found: ${input.gapId}`);
    result.skipped.push("gap_not_found");
    return result;
  }

  if (isFinalOutputGapStatus(gap.status)) {
    result.updatedGap = gap;
    result.warnings.push(`Final OutputGap status cannot be overwritten by setOutputGapStatus: ${gap.status}`);
    result.skipped.push("final_gap_status");
    return result;
  }

  result.updatedGap =
    (await updateOutputGap(gap.id, {
      status: input.status,
      customFields: outputGapActionCustomFields(gap, `status:${input.status}`, input.note)
    })) ?? gap;
  return result;
}

async function manualResolveOutputGap(
  input: ManualResolveOutputGapInput
): Promise<ManualResolveOutputGapResult> {
  const result = emptyOutputGapActionResult();

  if (input.confirmedByUser !== true) {
    result.warnings.push("Manual OutputGap resolution requires explicit user confirmation.");
    result.skipped.push("user_confirmation_required");
    return result;
  }

  const gap = await outputGapRepository.getById(input.gapId);
  if (!gap) {
    result.warnings.push(`OutputGap not found: ${input.gapId}`);
    result.skipped.push("gap_not_found");
    return result;
  }

  if (gap.status === "resolved") {
    result.updatedGap = gap;
    result.skipped.push("already_resolved");
    return result;
  }
  if (gap.status === "abandoned") {
    result.updatedGap = gap;
    result.warnings.push("Abandoned OutputGap cannot be resolved without first reopening it.");
    result.skipped.push("gap_abandoned");
    return result;
  }

  result.updatedGap =
    (await updateOutputGap(gap.id, {
      status: "resolved",
      resolvedAt: now(),
      customFields: outputGapActionCustomFields(
        gap,
        "manual_resolve",
        input.resolutionNote ?? "Manual OutputGap resolution confirmed by user."
      )
    })) ?? gap;
  if (input.resolvedByResultItemId) {
    const resultItem = await resultItemRepository.getById(input.resolvedByResultItemId);
    if (!resultItem) {
      result.warnings.push(`Resolved-by ResultItem not found: ${input.resolvedByResultItemId}`);
      result.linksSkipped.push("resolved_by_result_item_missing");
    } else {
      const relation = await outputConversionRelationService.ensureOutputConversionRelation({
        projectId: gap.projectId,
        sourceType: "resultItem",
        sourceId: resultItem.id,
        targetType: "outputGap",
        targetId: gap.id,
        relationType: "resolves"
      });
      result.linksCreated.push(relation.id);
    }
  }
  return result;
}

async function resolveOutputGap(
  inputOrId: ManualResolveOutputGapInput | EntityId,
  resolvedByResultItemId?: EntityId | null
) {
  const input =
    typeof inputOrId === "string"
      ? {
          gapId: inputOrId,
          confirmedByUser: false,
          resolvedByResultItemId
        }
      : inputOrId;
  return manualResolveOutputGap(input);
}

async function ignoreOutputGap(inputOrId: IgnoreOutputGapInput | EntityId): Promise<IgnoreOutputGapResult> {
  const input =
    typeof inputOrId === "string"
      ? {
          gapId: inputOrId,
          confirmedByUser: false
        }
      : inputOrId;
  const result = emptyOutputGapActionResult();

  if (input.confirmedByUser !== true) {
    result.warnings.push("Ignoring an OutputGap requires explicit user confirmation.");
    result.skipped.push("user_confirmation_required");
    return result;
  }

  const gap = await outputGapRepository.getById(input.gapId);
  if (!gap) {
    result.warnings.push(`OutputGap not found: ${input.gapId}`);
    result.skipped.push("gap_not_found");
    return result;
  }

  if (gap.status === "resolved") {
    result.updatedGap = gap;
    result.warnings.push("Resolved OutputGap cannot be ignored.");
    result.skipped.push("gap_resolved");
    return result;
  }
  if (gap.status === "abandoned") {
    result.updatedGap = gap;
    result.skipped.push("already_abandoned");
    return result;
  }

  result.updatedGap =
    (await updateOutputGap(gap.id, {
      status: "abandoned",
      customFields: outputGapActionCustomFields(gap, "ignore", input.note)
    })) ?? gap;
  return result;
}

async function queryGapsByCandidate(outputCandidateId: EntityId) {
  const relations = await outputConversionRelationService.queryOutputConversionRelations({
    sourceType: "outputGap",
    targetType: "outputCandidate",
    targetId: outputCandidateId,
    relationType: "blocks"
  });
  const gaps = await Promise.all(
    relations.map((relation) => outputGapRepository.getById(relation.sourceId))
  );
  return gaps.filter((gap): gap is OutputGap => Boolean(gap));
}

async function getOutputCandidateIdByGapId(outputGapId: EntityId) {
  const relation = (
    await outputConversionRelationService.queryOutputConversionRelations({
      sourceType: "outputGap",
      sourceId: outputGapId,
      targetType: "outputCandidate",
      relationType: "blocks"
    })
  )[0];
  return relation?.targetId ?? null;
}

async function convertOutputCandidateToResearchOutput(
  input: ConvertOutputCandidateToResearchOutputInput
) {
  const result = emptyConversionResult();
  const candidateId = textOrUndefined(input.candidateId);

  if (!candidateId) {
    result.warnings.push("Conversion skipped because candidateId is empty.");
    result.skipped.push("empty_candidate_id");
    return result;
  }

  if (input.confirmedByUser !== true) {
    result.warnings.push("Conversion requires explicit user confirmation.");
    result.skipped.push("user_confirmation_required");
    return result;
  }

  const candidate = await outputCandidateRepository.getById(candidateId);
  if (!candidate) {
    result.warnings.push(`OutputCandidate not found: ${candidateId}`);
    result.skipped.push("candidate_not_found");
    return result;
  }

  const existingOutputByRelation = await findOutputByCandidateRelation(candidate.id);
  if (existingOutputByRelation) {
    result.existingOutput = existingOutputByRelation;
    const updatedCandidate = await updateOutputCandidate(candidate.id, {
      status: "converted"
    });
    result.updatedCandidate = updatedCandidate ?? candidate;
    result.warnings.push(
      "Existing ResearchOutput already has a converted_to relation from this OutputCandidate; duplicate conversion skipped."
    );
    if (!updatedCandidate) {
      result.warnings.push("OutputCandidate status repair update failed.");
    }
    result.skipped.push("existing_output_for_candidate_relation");
    return result;
  }

  if (candidate.status === "converted") {
    result.updatedCandidate = candidate;
    result.warnings.push(
      "OutputCandidate status is converted but converted_to relation is missing; manual repair is required."
    );
    result.skipped.push("converted_candidate_missing_relation");
    return result;
  }

  const gaps = await queryGapsByCandidate(candidate.id);
  const evidence = await getCandidateEvidenceIds(candidate.id);
  const unresolvedGaps = getUnresolvedGaps(gaps);
  if (unresolvedGaps.length > 0) {
    result.warnings.push(
      `OutputCandidate has ${unresolvedGaps.length} unresolved OutputGap(s); conversion does not close them.`
    );
    if (input.allowUnresolvedGaps === false) {
      result.updatedCandidate = candidate;
      result.skipped.push("unresolved_gaps");
      return result;
    }
  }

  const provenance: ResearchOutputProvenance = {
    sourceType: "output_candidate",
    sourceCandidateId: candidate.id,
    sourceCandidateTitle: candidate.title,
    sourceCandidateType: candidate.candidateType,
    linkedFindingIds: evidence.findingIds,
    linkedResultItemIds: evidence.resultItemIds,
    linkedAssetIds: evidence.assetIds,
    outputGapIds: gaps.map((gap) => gap.id),
    convertedAt: now(),
    confirmedByUser: true,
    evidenceSummary: buildEvidenceSummary(candidate, gaps, evidence),
    note: textOrUndefined(input.conversionNote)
  };
  result.provenance = provenance;

  const experimentId = await inferExperimentIdFromCandidate(candidate.id);
  const outputName = textOrUndefined(input.outputName) ?? candidate.title;
  const description =
    textOrUndefined(input.description) ??
    `Converted from OutputCandidate: ${candidate.title}`;
  const outputType = input.outputType ?? outputTypeFromCandidateType(candidate.candidateType);

  const createdOutput = await outputService.create({
    projectId: candidate.projectId,
    taskId: candidate.taskId ?? undefined,
    experimentId,
    outputName,
    outputType,
    usableForPaper: input.usableForPaper ?? outputType === "paper_draft",
    description,
    provenance
  });
  result.createdOutput = createdOutput;

  const updatedCandidate = await updateOutputCandidate(candidate.id, {
    status: "converted"
  });

  if (updatedCandidate) {
    result.updatedCandidate = updatedCandidate;
  } else {
    result.warnings.push(
      "ResearchOutput was created, but OutputCandidate update failed; manual repair is required."
    );
    result.skipped.push("candidate_update_failed");
  }

  const relation = await outputConversionRelationService.ensureOutputConversionRelation({
    projectId: candidate.projectId,
    sourceType: "outputCandidate",
    sourceId: candidate.id,
    targetType: "researchOutput",
    targetId: createdOutput.id,
    relationType: "converted_to",
    note: "OutputCandidate converted to ResearchOutput"
  });
  result.linksCreated.push(relation.id);

  return result;
}

async function setOutputGapStatusWithRefresh(
  inputOrId: SetOutputGapStatusInput | EntityId,
  legacyStatus?: OutputGapStatus
): Promise<SetOutputGapStatusResult> {
  const result = await setOutputGapStatus(inputOrId, legacyStatus);
  const gapId = typeof inputOrId === "string" ? inputOrId : inputOrId.gapId;
  publishOutputGapActionRefresh("outputConversion.setOutputGapStatus", result, gapId);
  return result;
}

async function manualResolveOutputGapWithRefresh(
  input: ManualResolveOutputGapInput
): Promise<ManualResolveOutputGapResult> {
  const result = await manualResolveOutputGap(input);
  publishOutputGapActionRefresh("outputConversion.manualResolveOutputGap", result, input.gapId);
  return result;
}

async function resolveOutputGapWithRefresh(
  inputOrId: ManualResolveOutputGapInput | EntityId,
  resolvedByResultItemId?: EntityId | null
) {
  const input =
    typeof inputOrId === "string"
      ? {
          gapId: inputOrId,
          confirmedByUser: false,
          resolvedByResultItemId
        }
      : inputOrId;
  return manualResolveOutputGapWithRefresh(input);
}

async function ignoreOutputGapWithRefresh(
  inputOrId: IgnoreOutputGapInput | EntityId
): Promise<IgnoreOutputGapResult> {
  const result = await ignoreOutputGap(inputOrId);
  const gapId = typeof inputOrId === "string" ? inputOrId : inputOrId.gapId;
  publishOutputGapActionRefresh("outputConversion.ignoreOutputGap", result, gapId);
  return result;
}

async function convertOutputCandidateToResearchOutputWithRefresh(
  input: ConvertOutputCandidateToResearchOutputInput
): Promise<ConvertOutputCandidateToResearchOutputResult> {
  const result = await convertOutputCandidateToResearchOutput(input);
  publishCandidateConversionRefresh(result, textOrUndefined(input.candidateId));
  return result;
}

export const outputConversionService = {
  listResultItems,
  listDeletedResultItems,
  getResultItemById,
  getDeletedResultItemById,
  getResultItemBySource,
  getResultItemsBySourceIds,
  createResultItem,
  ensureResultItemForSource,
  updateResultItem,
  updateResultItemStatus,
  markResultItemAsAsset,
  unmarkResultItemAsAsset,
  createFindingFromResultItems,
  listFindings,
  listDeletedFindings,
  getFindingById,
  getDeletedFindingById,
  createFinding,
  updateFinding,
  updateFindingStatus,
  linkFindingToResultItems,
  unlinkFindingFromResultItem,
  listOutputCandidates,
  listDeletedOutputCandidates,
  getOutputCandidateById,
  getDeletedOutputCandidateById,
  createOutputCandidate,
  createOutputCandidateFromFindings,
  updateOutputCandidate,
  updateOutputCandidateStatus,
  linkCandidateToFindings,
  unlinkCandidateFromFinding,
  linkCandidateToResultItems,
  unlinkCandidateFromResultItem,
  listOutputGaps,
  listDeletedOutputGaps,
  getOutputGapById,
  getDeletedOutputGapById,
  createOutputGap,
  createOutputGapForDeposition,
  updateOutputGap,
  updateOutputGapStatus,
  manualResolveOutputGap: manualResolveOutputGapWithRefresh,
  resolveOutputGap: resolveOutputGapWithRefresh,
  ignoreOutputGap: ignoreOutputGapWithRefresh,
  setOutputGapStatus: setOutputGapStatusWithRefresh,
  queryGapsByCandidate,
  getOutputCandidateIdByGapId,
  convertOutputCandidateToResearchOutput: convertOutputCandidateToResearchOutputWithRefresh,
  mapOutputGapActionResultToWriteFeedback,
  mapConvertOutputCandidateToResearchOutputResultToWriteFeedback
};

export type OutputConversionService = typeof outputConversionService;
