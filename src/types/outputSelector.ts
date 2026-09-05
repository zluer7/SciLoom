import type { EntityId, ISODateString } from "./common";
import type { FileRefOwnerType } from "./experiment";
import type { ResearchOutput } from "./output";
import type {
  Finding,
  OutputCandidate,
  OutputConversionEntityType,
  OutputConversionRelationType,
  OutputGap,
  ResultItem
} from "./outputConversion";
import type { StructuredSummary } from "./outputStructuredSummary";

export type OutputEntityLayer = OutputConversionEntityType;
export type FileAwareOutputEntityLayer = OutputEntityLayer;

export type OutputEntity =
  | ResultItem
  | Finding
  | OutputCandidate
  | OutputGap
  | ResearchOutput;

export type OutputEntityByLayer = {
  resultItem: ResultItem;
  finding: Finding;
  outputCandidate: OutputCandidate;
  outputGap: OutputGap;
  researchOutput: ResearchOutput;
};

export type OutputSelectorSource =
  | "entity"
  | "structuredSummary"
  | "manuscriptBinding"
  | "outputConversionRelations"
  | "fileRefSummary"
  | "researchOutput"
  | "planningFeedbackReference";

export interface OutputSelectorBoundary {
  missing: boolean;
  partial: boolean;
  sourceBoundary: OutputSelectorSource[];
  warnings: string[];
}

export interface OutputFileRefSummary {
  id: EntityId;
  ownerType: FileRefOwnerType;
  ownerId: EntityId;
  fileName: string;
  extension?: string;
  fileKind?: string;
  mimeType?: string;
  sizeBytes?: number;
  pathSummary: string;
  availabilityStatus: "not_verified";
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export interface OutputRelationSummary {
  id: EntityId;
  relationType: OutputConversionRelationType;
  sourceType: OutputEntityLayer;
  sourceId: EntityId;
  targetType: OutputEntityLayer;
  targetId: EntityId;
  direction: "incoming" | "outgoing";
  targetMissing: boolean;
  targetTitle?: string;
}

export interface FileAwareOutputManuscriptSummary {
  identityResolved: boolean;
  identityStatus: "resolved" | "not-found" | "invalid" | "error";
  availabilityStatus: "not-checked";
  currentFilename?: string;
  workspaceSummary?: string;
  warnings: string[];
}

interface OutputEntityListItemBase {
  layer: OutputEntityLayer;
  id: EntityId;
  projectId: EntityId;
  title: string;
  status: string;
  structuredSummaryPreview?: string;
  relationCounts: Record<string, number>;
  fileRefCount: number;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  archivedAt?: ISODateString;
  deletedAt?: ISODateString;
  boundary: OutputSelectorBoundary;
}

export type OutputEntityListItemDto = OutputEntityListItemBase & {
  layer: FileAwareOutputEntityLayer;
  manuscript?: FileAwareOutputManuscriptSummary;
};

interface OutputEntityDetailBase<T extends OutputEntity = OutputEntity> {
  layer: OutputEntityLayer;
  id: EntityId;
  projectId?: EntityId;
  entity: T | null;
  status?: string;
  structuredSummary: StructuredSummary;
  relationSummary: OutputRelationSummary[];
  fileRefs: OutputFileRefSummary[];
  boundary: OutputSelectorBoundary;
}

export type OutputEntityDetailDto<T extends OutputEntity = OutputEntity> =
  OutputEntityDetailBase<T> & { manuscript: FileAwareOutputManuscriptSummary };

export interface OutputEntityListFilters {
  projectId: EntityId;
  status?: string | string[];
  includeArchived?: boolean;
  includeDeleted?: boolean;
  keyword?: string;
  limit?: number;
  offset?: number;
}

export interface OutputEntityDetailOptions {
  includeDeleted?: boolean;
}

export type OutputEntityListQuery = OutputEntityListFilters & {
  layer: OutputEntityLayer;
};

export type OutputEntityDetailQuery = OutputEntityDetailOptions & {
  layer: OutputEntityLayer;
  id: EntityId;
};
