import type { EntityId, ISODateString } from "./common";
import type { StructuredSummary } from "./outputStructuredSummary";
import type { OutputChainBoundary, OutputChainEdge, OutputChainKind } from "./outputChain";
import type {
  OutputFileRefSummary,
  OutputRelationSummary
} from "./outputSelector";

export type OutputExportLayer =
  | "resultItem"
  | "finding"
  | "outputCandidate"
  | "outputGap"
  | "researchOutput";

export type OutputExportFormat = "markdown" | "bundle";

interface OutputExportRequestBase {
  id: EntityId;
  format?: OutputExportFormat;
  includeEvidenceChain?: boolean;
  includeSourceChain?: boolean;
  includeStructuredSummary?: boolean;
  includeFileRefs?: boolean;
  includeRelations?: boolean;
  includeDeleted?: false;
}

export interface FileAwareOutputExportRequest extends OutputExportRequestBase {
  layer: OutputExportLayer;
}

export type OutputExportRequest = FileAwareOutputExportRequest;
export type OutputExportRequestWithoutFormat = Omit<FileAwareOutputExportRequest, "format">;

export interface OutputExportSafetyPolicy {
  noFullLocalPath: true;
  noFileBodyRead: true;
  pathSummaryOnly: true;
  noFileSystemWrite: true;
  noAiCall: true;
  noAutoWriteBackInstruction: true;
  activeOnlyByDefault: true;
}

export interface OutputExportFileRef {
  id: EntityId;
  ownerType: OutputFileRefSummary["ownerType"];
  ownerId: EntityId;
  fileName?: string;
  extension?: string;
  fileKind?: string;
  mimeType?: string;
  sizeBytes?: number;
  pathSummary: string;
  availabilityStatus: "not_verified";
}

export interface OutputExportEntityBasics {
  id: EntityId;
  layer: OutputExportLayer;
  title: string;
  status?: string;
  type?: string;
  category?: string;
  projectId?: EntityId;
  createdAt?: ISODateString;
  updatedAt?: ISODateString;
  isAssetView?: boolean;
  sourceSummary?: string;
}

export interface OutputExportRelationSummary {
  id: EntityId;
  relationType: string;
  direction: OutputRelationSummary["direction"];
  sourceType: OutputExportLayer;
  sourceId: EntityId;
  targetType: OutputExportLayer;
  targetId: EntityId;
  targetTitle?: string;
  targetMissing: boolean;
}

export interface OutputExportChainNodeSummary {
  id: string;
  type: string;
  entityId?: EntityId;
  title: string;
  status?: string;
  layer?: OutputExportLayer;
  shortSummary?: string;
  fileRefs?: OutputExportFileRef[];
  missing?: boolean;
  partial?: boolean;
}

export interface OutputExportChainSummary {
  kind: OutputChainKind;
  root: {
    type: string;
    id: string;
  };
  nodes: OutputExportChainNodeSummary[];
  edges: Pick<
    OutputChainEdge,
    "id" | "relationType" | "sourceNodeId" | "targetNodeId" | "direction"
  >[];
  boundary: OutputChainBoundary;
  truncated: boolean;
}

interface OutputConversionBundlePayloadBase {
  bundleKind: "output_conversion_bundle";
  root: OutputExportEntityBasics;
  structuredSummary?: StructuredSummary;
  evidenceChain?: OutputExportChainSummary;
  sourceChain?: OutputExportChainSummary;
  fileRefSummaries?: OutputExportFileRef[];
  relations?: OutputExportRelationSummary[];
  crossModuleLinks?: Array<{
    type: "task" | "routeNode" | "sourceReference";
    id: EntityId;
    label: string;
  }>;
  safetyNotice: string[];
  omittedFields: string[];
  warnings: string[];
}

export type OutputConversionBundlePayload<Layer extends OutputExportLayer = OutputExportLayer> =
  OutputConversionBundlePayloadBase;

export interface OutputExportPayload {
  schemaVersion: "lp8-7-b.v1";
  exportKind: "output_conversion_export";
  exportFormat: OutputExportFormat;
  generatedAt: ISODateString;
  layer: OutputExportLayer;
  id: EntityId;
  title: string;
  status?: string;
  markdown?: string;
  bundle?: OutputConversionBundlePayload;
  safetyPolicy: OutputExportSafetyPolicy;
  omittedFields: string[];
  warnings: string[];
}
