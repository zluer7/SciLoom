import type { AuditableEntity, EntityId } from "./common";
import type { StructuredSummary } from "./outputStructuredSummary";

export type OutputType =
  | "figure"
  | "table"
  | "dataset"
  | "result"
  | "note"
  | "report"
  | "paper_draft"
  | "presentation"
  | "code"
  | "other";

export type ResearchOutputProvenanceSourceType =
  | "manual"
  | "output_candidate"
  | "import"
  | "other";

export type ResearchOutputProvenance = {
  sourceType: ResearchOutputProvenanceSourceType;
  sourceCandidateId?: EntityId | null;
  sourceCandidateTitle?: string;
  sourceCandidateType?: string;
  linkedFindingIds?: EntityId[];
  linkedResultItemIds?: EntityId[];
  linkedAssetIds?: EntityId[];
  outputGapIds?: EntityId[];
  convertedAt?: string;
  convertedBy?: string;
  confirmedByUser?: boolean;
  evidenceSummary?: string;
  note?: string;
};

export type ResearchOutputStatus = "draft" | "organizing" | "archived";

export type ResearchOutput = AuditableEntity & {
  projectId: EntityId;
  taskId?: EntityId;
  experimentId?: EntityId;
  outputName: string;
  outputType: OutputType;
  status: ResearchOutputStatus;
  structuredSummary: StructuredSummary;
  usableForPaper: boolean;
  description: string;
  provenance?: ResearchOutputProvenance | null;
};

export type Output = ResearchOutput;
