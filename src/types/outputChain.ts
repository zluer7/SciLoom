import type { EntityId } from "./common";
import type { OutputConversionRelationType } from "./outputConversion";
import type {
  OutputEntityLayer,
  OutputFileRefSummary
} from "./outputSelector";

export type OutputChainKind =
  | "findingEvidence"
  | "candidateEvidence"
  | "outputGapImpact"
  | "researchOutputSource";

export type OutputChainNodeType =
  | OutputEntityLayer
  | "fileRef"
  | "task"
  | "routeNode"
  | "experiment"
  | "experimentRun"
  | "resultMetric"
  | "literature"
  | "review"
  | "provenanceSnapshot"
  | "boundary";

export type OutputChainSource =
  | "entity"
  | "detailSelector"
  | "outputConversionRelations"
  | "fileRefSummary"
  | "provenanceSnapshot"
  | "crossModuleReference"
  | "depthLimitedChain"
  | "nodeLimitedChain"
  | "cycleGuard";

export interface OutputChainBoundary {
  missing: boolean;
  partial: boolean;
  truncated: boolean;
  cycleDetected: boolean;
  depthLimitReached: boolean;
  nodeLimitReached: boolean;
  sourceBoundary: OutputChainSource[];
  warnings: string[];
}

export interface OutputChainNode {
  id: string;
  type: OutputChainNodeType;
  entityId?: EntityId;
  label: string;
  status?: string;
  layer?: OutputEntityLayer;
  summary?: string;
  fileRefs?: OutputFileRefSummary[];
  missing?: boolean;
  partial?: boolean;
}

export interface OutputChainEdge {
  id: string;
  relationType: OutputConversionRelationType | "file_ref" | "source_ref" | "planning_feedback" | "snapshot";
  sourceNodeId: string;
  targetNodeId: string;
  sourceType?: OutputChainNodeType;
  sourceId?: EntityId;
  targetType?: OutputChainNodeType;
  targetId?: EntityId;
  direction: "forward" | "backward" | "crossModule" | "snapshot";
}

export interface OutputChainDto {
  kind: OutputChainKind;
  root: {
    type: OutputChainNodeType;
    id: string;
  };
  nodes: OutputChainNode[];
  edges: OutputChainEdge[];
  depth: number;
  maxDepth: number;
  maxNodes: number;
  boundary: OutputChainBoundary;
}

export interface OutputChainOptions {
  maxDepth?: number;
  maxNodes?: number;
  includeFileRefs?: boolean;
  includeCrossModuleRefs?: boolean;
  includeProvenanceSnapshot?: boolean;
}

export interface OutputChainQuery {
  kind: OutputChainKind;
  rootId: EntityId;
  options?: OutputChainOptions;
}
