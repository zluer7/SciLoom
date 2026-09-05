import type { AuditableEntity, EntityId, ISODateString } from "./common";
import type { CustomField } from "./experiment";
import type { ResearchOutput, ResearchOutputProvenance } from "./output";
import type { StructuredSummary } from "./outputStructuredSummary";

export type ResultSourceType =
  | "experiment"
  | "experimentRun"
  | "resultMetric"
  | "fileRef"
  | "task"
  | "review"
  | "literature"
  | "researchRecord"
  | "manual"
  | "other";

export type ResultItemType =
  | "data"
  | "figure"
  | "table"
  | "metric"
  | "code"
  | "model"
  | "log"
  | "text"
  | "sample"
  | "case"
  | "document"
  | "other";

export type ResultAssetQuality = "high" | "medium" | "low" | "uncertain";

export type ResultItemStatus = "pending_review" | "marked" | "ignored";

export type OutputUseType =
  | "paper"
  | "patent"
  | "report"
  | "dataset"
  | "software"
  | "presentation"
  | "futureProject"
  | "other";

export type ResultItem = AuditableEntity & {
  schemaVersion: number;

  projectId: EntityId;
  routeId?: EntityId | null;
  taskId?: EntityId | null;
  experimentId?: EntityId | null;
  experimentRunId?: EntityId | null;

  sourceType: ResultSourceType;
  sourceId: EntityId;

  title: string;
  resultType: ResultItemType;
  status: ResultItemStatus;
  structuredSummary: StructuredSummary;

  summary?: string;
  value?: string | number | boolean | Record<string, unknown>;
  unit?: string;
  fileRefId?: EntityId | null;

  tags: string[];

  isAsset?: boolean;
  assetMarkedAt?: ISODateString | null;
  assetReason?: string;
  assetQuality?: ResultAssetQuality;
  usableFor?: OutputUseType[];

  customFields?: CustomField[];
};

/**
 * ResultAsset is an asset view of ResultItem.
 * It must not be persisted as a duplicated data source.
 */
export type ResultAsset = ResultItem & {
  isAsset: true;
};

export type FindingType =
  | "phenomenon"
  | "comparison"
  | "method"
  | "limitation"
  | "evidence"
  | "hypothesis"
  | "negative_result"
  | "other";

export type FindingConfidence = "high" | "medium" | "low" | "uncertain";

export type FindingStatus =
  | "pending_confirmation"
  | "confirmed"
  | "needs_evidence"
  | "abandoned";

export type FindingMaturity = "high" | "medium" | "low" | "uncertain";

export type Finding = AuditableEntity & {
  schemaVersion: number;

  projectId: EntityId;
  routeId?: EntityId | null;
  taskId?: EntityId | null;
  experimentId?: EntityId | null;

  title: string;
  summary: string;
  status: FindingStatus;
  structuredSummary: StructuredSummary;

  findingType?: FindingType;
  confidence?: FindingConfidence;
  maturity?: FindingMaturity;

  tags: string[];
  customFields?: CustomField[];
};

export type OutputCandidateType =
  | "paper"
  | "patent"
  | "report"
  | "dataset"
  | "software"
  | "method"
  | "model"
  | "caseStudy"
  | "presentation"
  | "futureProject"
  | "other";

export type OutputCandidateStatus =
  | "pending_evaluation"
  | "needs_gap_resolution"
  | "ready_for_formal"
  | "converted";

export type OutputCandidateMaturity = "low" | "medium" | "high";

export type OutputCandidate = AuditableEntity & {
  schemaVersion: number;

  projectId: EntityId;
  routeId?: EntityId | null;
  taskId?: EntityId | null;

  title: string;
  description?: string;

  candidateType: OutputCandidateType;
  status: OutputCandidateStatus;
  structuredSummary: StructuredSummary;
  maturity?: OutputCandidateMaturity;
  priority?: "high" | "medium" | "low";

  tags: string[];
  customFields?: CustomField[];
};

export type OutputGapType =
  | "data"
  | "analysis"
  | "validation"
  | "figure"
  | "theory"
  | "literature"
  | "writing"
  | "experiment"
  | "code"
  | "other";

export type OutputGapStatus =
  | "pending"
  | "task_created"
  | "route_feedback_created"
  | "resolved"
  | "abandoned";

export type OutputGap = AuditableEntity & {
  schemaVersion: number;

  projectId: EntityId;

  title: string;
  description?: string;

  gapType: OutputGapType;
  status: OutputGapStatus;
  structuredSummary: StructuredSummary;
  priority?: "high" | "medium" | "low";

  relatedTaskId?: EntityId | null;
  relatedRouteNodeId?: EntityId | null;
  resolvedAt?: ISODateString | null;

  customFields?: CustomField[];
};

export type OutputGapFeedbackCardType = "route" | "task";

export type OutputGapFeedbackCardStatus = "pending" | "resolved";

export type OutputGapFeedbackCardPriority = "high" | "medium" | "low";

export type OutputGapFeedbackCard = AuditableEntity & {
  projectId: EntityId;
  outputGapId: EntityId;
  type: OutputGapFeedbackCardType;
  title: string;
  description?: string | null;
  status: OutputGapFeedbackCardStatus;
  priority: OutputGapFeedbackCardPriority;
  archivedAt?: ISODateString | null;
};

export type CreateOutputGapFeedbackCardInput = Pick<
  OutputGapFeedbackCard,
  "outputGapId" | "type" | "title"
> &
  Partial<Pick<OutputGapFeedbackCard, "description" | "status" | "priority">>;

export type UpdateOutputGapFeedbackCardInput = Partial<
  Pick<OutputGapFeedbackCard, "type" | "title" | "description" | "status" | "priority">
>;

export type QueryOutputGapFeedbackCardsOptions = Partial<{
  includeArchived: boolean;
  includeDeleted: boolean;
  type: OutputGapFeedbackCardType;
  status: OutputGapFeedbackCardStatus;
}>;

export type OutputConversionEntityType =
  | "resultItem"
  | "finding"
  | "outputCandidate"
  | "outputGap"
  | "researchOutput";

export type OutputConversionRelationType =
  | "evidence_for"
  | "supports"
  | "uses"
  | "blocks"
  | "converted_to"
  | "resolves"
  | "extends"
  | "contradicts";

export type OutputConversionRelation = AuditableEntity & {
  schemaVersion: number;
  projectId?: EntityId | null;
  sourceType: OutputConversionEntityType;
  sourceId: EntityId;
  targetType: OutputConversionEntityType;
  targetId: EntityId;
  relationType: OutputConversionRelationType;
  note?: string | null;
};

export type CreateOutputConversionRelationInput = {
  projectId?: EntityId | null;
  sourceType: OutputConversionEntityType;
  sourceId: EntityId;
  targetType: OutputConversionEntityType;
  targetId: EntityId;
  relationType: OutputConversionRelationType;
  note?: string | null;
};

export type UpdateOutputConversionRelationInput = Partial<Pick<OutputConversionRelation, "note">>;

export type QueryOutputConversionRelationsInput = Partial<{
  projectId: EntityId | null;
  sourceType: OutputConversionEntityType;
  sourceId: EntityId;
  targetType: OutputConversionEntityType;
  targetId: EntityId;
  relationType: OutputConversionRelationType;
  includeDeleted: boolean;
}>;

export type OutputSourceOwnerType = OutputConversionEntityType;

export type OutputSourceType =
  | "experiment"
  | "experimentRun"
  | "literature"
  | "review"
  | "other"
  | "resultItem"
  | "finding"
  | "outputCandidate";

export type OutputSourceRelationType = "primary" | "supporting" | "manual" | "context";

export type OutputSourceStatus = "active" | "missing";

export type OutputSourceCounts = Partial<Record<OutputSourceType, number>>;

export interface OutputSourceLink extends AuditableEntity {
  projectId: EntityId;
  ownerType: OutputSourceOwnerType;
  ownerId: EntityId;
  sourceType: OutputSourceType;
  sourceId?: EntityId | null;
  sourceTitleSnapshot: string;
  sourceSummarySnapshot?: string | null;
  sourceNote?: string | null;
  relationType: OutputSourceRelationType;
  orderIndex: number;
  schemaVersion: number;
}

export type CreateOutputSourceLinkInput = {
  projectId: EntityId;
  ownerType: OutputSourceOwnerType;
  ownerId: EntityId;
  sourceType: OutputSourceType;
  sourceId?: EntityId | null;
  sourceTitleSnapshot: string;
  sourceSummarySnapshot?: string | null;
  sourceNote?: string | null;
  relationType?: OutputSourceRelationType;
  orderIndex?: number;
};

export type UpdateOutputSourceLinkInput = Partial<
  Pick<
    OutputSourceLink,
    | "sourceType"
    | "sourceId"
    | "sourceTitleSnapshot"
    | "sourceSummarySnapshot"
    | "sourceNote"
    | "relationType"
    | "orderIndex"
  >
>;

export type QueryOutputSourceLinksInput = Partial<{
  projectId: EntityId;
  ownerType: OutputSourceOwnerType;
  ownerId: EntityId;
  sourceType: OutputSourceType;
  sourceId: EntityId | null;
  relationType: OutputSourceRelationType;
  includeDeleted: boolean;
}>;

export interface OutputSourceCard {
  id: EntityId;
  ownerType: OutputSourceOwnerType;
  ownerId: EntityId;
  sourceType: OutputSourceType;
  sourceId?: EntityId | null;
  sourceTitle: string;
  sourceTitleSnapshot: string;
  sourceSummarySnapshot?: string | null;
  sourceNote?: string | null;
  relationType: OutputSourceRelationType;
  orderIndex: number;
  sourceStatus: OutputSourceStatus;
  warning?: string;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export interface OutputSourceSummary {
  ownerType: OutputSourceOwnerType;
  ownerId: EntityId;
  countsBySourceType: OutputSourceCounts;
  total: number;
  hasMissingSources: boolean;
  cards: OutputSourceCard[];
}

export interface OutputSourceContextForAi {
  ownerType: OutputSourceOwnerType;
  ownerId: EntityId;
  total: number;
  hasMissingSources: boolean;
  sources: Array<
    Pick<
      OutputSourceCard,
      | "id"
      | "sourceType"
      | "sourceId"
      | "sourceTitle"
      | "sourceSummarySnapshot"
      | "sourceNote"
      | "relationType"
      | "sourceStatus"
      | "warning"
    >
  >;
  warnings: string[];
  safetyPolicy: {
    fileBodiesRead: false;
    fullLocalPathsExcluded: true;
    aiInvoked: false;
  };
}

export type EvidenceChainNodeType =
  | "outputCandidate"
  | "outputGap"
  | "researchOutput"
  | "finding"
  | "resultItem"
  | "resultAsset"
  | "experiment"
  | "experimentRun"
  | "resultMetric"
  | "fileRef"
  | "task"
  | "route"
  | "routeNode"
  | "literature"
  | "review"
  | "provenanceSnapshot"
  | "boundary"
  | "project";

export interface EvidenceChainNode {
  id: EntityId;
  type: EvidenceChainNodeType;
  title: string;
  description?: string;
  relationType?: string;
  children?: EvidenceChainNode[];
}

export interface OutputConversionContextWarning {
  code: string;
  message: string;
  entityType?: string;
  entityId?: EntityId;
}

export interface OutputConversionMissingReference {
  sourceType: string;
  sourceId: EntityId;
  targetType: string;
  targetId: EntityId;
  relationType?: string;
  reason: string;
}

export interface OutputConversionReferenceSummary {
  id: EntityId;
  title: string;
  summary?: string;
  type?: string;
  status?: string;
}

export interface EvidenceChainNodeDTO {
  id: EntityId;
  nodeType: EvidenceChainNodeType;
  title: string;
  summary?: string;
  relationType?: string;
  children?: EvidenceChainNodeDTO[];
}

export interface EvidenceChainDTO {
  candidateId: EntityId;
  rootNode: EvidenceChainNodeDTO;
  nodes: EvidenceChainNodeDTO[];
  warnings: OutputConversionContextWarning[];
  missingReferences: OutputConversionMissingReference[];
  partial: boolean;
}

export interface OutputGapFeedbackDTO {
  gapId: EntityId;
  candidateId: EntityId;
  status: OutputGapStatus;
  priority?: OutputGap["priority"];
  description?: string;
  relatedTaskId?: EntityId | null;
  relatedRouteNodeId?: EntityId | null;
  canCreateTask: boolean;
  canCreateRouteNode: boolean;
  canResolveFromTask: boolean;
  requiresUserConfirmation: boolean;
  warnings: OutputConversionContextWarning[];
  missingReferences: OutputConversionMissingReference[];
}

export interface OutputGapClosureDTO extends OutputGapFeedbackDTO {
  resolvedAt?: ISODateString | null;
  resolvedByResultItemId?: EntityId | null;
}

export interface FormalOutputProvenanceDTO {
  outputId?: EntityId | null;
  outputName?: string | null;
  outputType?: string | null;
  sourceCandidateId?: EntityId | null;
  sourceCandidateTitle?: string | null;
  sourceCandidateType?: string | null;
  convertedAt?: ISODateString | null;
  confirmedByUser?: boolean;
  evidenceSummary?: string | null;
  linkedFindingIds: EntityId[];
  linkedResultItemIds: EntityId[];
  linkedAssetIds: EntityId[];
  outputGapIds: EntityId[];
  warnings: OutputConversionContextWarning[];
}

export interface FindingDetailDTO {
  id: EntityId;
  title: string;
  summary: string;
  findingType?: FindingType;
  status: FindingStatus;
  structuredSummary: StructuredSummary;
  linkedResultItemSummaries: OutputConversionReferenceSummary[];
  linkedAssetSummaries: OutputConversionReferenceSummary[];
  linkedCandidateIds: EntityId[];
  warnings: OutputConversionContextWarning[];
  missingReferences: OutputConversionMissingReference[];
  partial: boolean;
}

export interface OutputCandidateDetailDTO {
  id: EntityId;
  title: string;
  candidateType: OutputCandidateType;
  status: OutputCandidateStatus;
  formalOutputId?: EntityId | null;
  projectId: EntityId;
  taskId?: EntityId | null;
  summary?: string;
  structuredSummary: StructuredSummary;
  novelty?: string;
  contribution?: string;
  linkedFindingSummaries: OutputConversionReferenceSummary[];
  linkedResultItemSummaries: OutputConversionReferenceSummary[];
  linkedAssetSummaries: OutputConversionReferenceSummary[];
  evidenceChain: EvidenceChainDTO;
  openGapSummaries: OutputGapFeedbackDTO[];
  formalOutputProvenance: FormalOutputProvenanceDTO;
  warnings: OutputConversionContextWarning[];
  missingReferences: OutputConversionMissingReference[];
  partial: boolean;
  updatedAt?: ISODateString;
}

export interface OutputConversionSummaryDTO {
  projectId?: EntityId;
  resultItemCount: number;
  assetCount: number;
  findingCount: number;
  outputCandidateCount: number;
  outputGapCount: number;
  openGapCount: number;
  readyCandidateCount: number;
  convertedCandidateCount: number;
  candidateSummaries: OutputConversionReferenceSummary[];
  assetSummaries: OutputConversionReferenceSummary[];
  warnings: OutputConversionContextWarning[];
  missingReferences: OutputConversionMissingReference[];
  partial: boolean;
}

export interface OutputCandidateAIContextDTO {
  candidate: {
    id: EntityId;
    title: string;
    candidateType: OutputCandidateType;
    status: OutputCandidateStatus;
    formalOutputId?: EntityId | null;
    summary?: string;
    structuredSummary: StructuredSummary;
  };
  findings: OutputConversionReferenceSummary[];
  resultItems: OutputConversionReferenceSummary[];
  assets: OutputConversionReferenceSummary[];
  evidenceChainSummary: EvidenceChainDTO;
  openOutputGaps: OutputGapFeedbackDTO[];
  formalOutputProvenance: FormalOutputProvenanceDTO;
  warnings: OutputConversionContextWarning[];
  missingReferences: OutputConversionMissingReference[];
  partial: boolean;
}

export interface OutputCandidateMarkdownDTO {
  candidate: OutputCandidateDetailDTO;
  markdown: string;
}

export interface ConvertOutputCandidateToResearchOutputInput {
  candidateId: EntityId;
  confirmedByUser: boolean;
  outputName?: string;
  outputType?: ResearchOutput["outputType"];
  description?: string;
  usableForPaper?: boolean;
  conversionNote?: string | null;
  allowUnresolvedGaps?: boolean;
}

export interface ConvertOutputCandidateToResearchOutputResult {
  createdOutput?: ResearchOutput;
  existingOutput?: ResearchOutput;
  updatedCandidate?: OutputCandidate;
  provenance?: ResearchOutputProvenance;
  warnings: string[];
  skipped: string[];
  linksCreated: string[];
  linksSkipped: string[];
}

export type OutputGapClosureWarning = string;

export interface OutputGapActionResult {
  updatedGap?: OutputGap;
  warnings: OutputGapClosureWarning[];
  skipped: string[];
  linksCreated: string[];
  linksSkipped: string[];
}

export interface SetOutputGapStatusInput {
  gapId: EntityId;
  status: Exclude<OutputGapStatus, "resolved" | "abandoned">;
  confirmedByUser?: boolean;
  note?: string | null;
}

export interface SetOutputGapStatusResult extends OutputGapActionResult {}

export interface ManualResolveOutputGapInput {
  gapId: EntityId;
  confirmedByUser: boolean;
  resolutionNote?: string | null;
  resolvedByResultItemId?: EntityId | null;
}

export interface ManualResolveOutputGapResult extends OutputGapActionResult {}

export interface IgnoreOutputGapInput {
  gapId: EntityId;
  confirmedByUser: boolean;
  note?: string | null;
}

export interface IgnoreOutputGapResult extends OutputGapActionResult {}
